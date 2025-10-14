#!/usr/bin/env bun

import { serve } from 'bun';
import { readFileSync, existsSync, unlinkSync, statSync } from 'fs';
import { join } from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const PORT = 3000;

// Load data files
function loadJSON(filename: string) {
  try {
    return JSON.parse(readFileSync(filename, 'utf-8'));
  } catch (error) {
    return null;
  }
}

// Load timebolt cache
function loadTimeboltCache() {
  try {
    const cache = loadJSON('timebolted-cache.json');
    return cache || { lastRun: null, results: {} };
  } catch (error) {
    return { lastRun: null, results: {} };
  }
}

// Save timebolt cache
function saveTimeboltCache(cache: any) {
  Bun.write('timebolted-cache.json', JSON.stringify(cache, null, 2));
}

// Load timestamp cache
function loadTimestampCache() {
  try {
    const cache = loadJSON('timestamp-cache.json');
    return cache || { results: {} };
  } catch (error) {
    return { results: {} };
  }
}

// Save timestamp cache
function saveTimestampCache(cache: any) {
  Bun.write('timestamp-cache.json', JSON.stringify(cache, null, 2));
}

// Get partial MD5 hash of file (first 300 bytes only for speed)
async function getFileMD5(filePath: string): Promise<string | null> {
  try {
    // Read first 300 bytes and compute MD5 (extremely fast)
    // Analysis showed max common prefix between different files is 163 bytes, so 300 bytes provides 84% safety margin
    const { stdout } = await execAsync(`head -c 300 "${filePath}" | md5`);
    return stdout.trim();
  } catch (error) {
    console.error('MD5 hash error:', error);
    return null;
  }
}

// Detect timebolt using silence analysis
async function detectTimeboltBySilence(videoPath: string): Promise<boolean> {
  try {
    // Analyze first 5 seconds for silences >1 second at -30dB threshold
    const { stdout } = await execAsync(
      `ffmpeg -i "${videoPath}" -t 5 -af "silencedetect=noise=-30dB:d=1" -f null - 2>&1 | grep "silence_duration" | wc -l`
    );

    const silenceCount = parseInt(stdout.trim());
    // 0 silences = likely timebolted, ≥1 silence = likely original
    return silenceCount === 0;
  } catch (error) {
    console.error('Silence detection error:', error);
    return false;
  }
}

// Get video duration in seconds
async function getVideoDuration(videoPath: string): Promise<number | null> {
  try {
    const { stdout } = await execAsync(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${videoPath}"`
    );
    const duration = parseFloat(stdout.trim());
    return isNaN(duration) ? null : duration;
  } catch (error) {
    console.error('Duration extraction error:', error);
    return null;
  }
}

// Format duration as fuzzy time (e.g., "13m" or "5h")
function formatFuzzyDuration(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.round((seconds % 3600) / 60);

  if (hours > 0) {
    return `${hours}h`;
  } else {
    return `${minutes}m`;
  }
}

// Get file modification time
function getFileMtime(filePath: string): number | null {
  try {
    const stats = statSync(filePath);
    return stats.mtimeMs;
  } catch (error) {
    return null;
  }
}

// Get file size in bytes
function getFileSize(filePath: string): number | null {
  try {
    const stats = statSync(filePath);
    return stats.size;
  } catch (error) {
    return null;
  }
}

// Format file size in human-readable format (e.g., "1 GB", "345 MB")
function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';

  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));

  return `${(bytes / Math.pow(k, i)).toFixed(0)} ${sizes[i]}`;
}

// Extract timestamp and duration from video
async function extractTimestampFromVideo(videoPath: string): Promise<{ timestamp: string, duration: string } | null> {
  const cache = loadTimestampCache();

  // Check cache first using modification time (much faster than MD5)
  const cachedResult = cache.results[videoPath];
  const fileMtime = getFileMtime(videoPath);

  if (cachedResult && fileMtime && cachedResult.mtime === fileMtime) {
    // File hasn't changed since cache was created - use cached result
    return cachedResult.timestamp ? { timestamp: cachedResult.timestamp, duration: cachedResult.duration || '' } : null;
  }

  // If cache miss or file changed, compute MD5 for validation
  const fileMD5 = await getFileMD5(videoPath);

  try {
    const filename = videoPath.split('/').pop() || '';
    console.log(`Extracting timestamp from: ${filename}`);

    // Get video dimensions first
    const { stdout: probeOutput } = await execAsync(
      `ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "${videoPath}"`
    );

    const [widthStr, heightStr] = probeOutput.trim().split(',');
    const width = parseInt(widthStr);
    const height = parseInt(heightStr);

    if (!width || !height) {
      console.error(`Could not detect video dimensions for ${filename}`);
      return null;
    }

    // Create temp directory if it doesn't exist
    const tempDir = join(__dirname, 'temp');
    await execAsync(`mkdir -p "${tempDir}"`);

    // Create debug directory
    const debugDir = join(__dirname, 'debug_frames');
    await execAsync(`mkdir -p "${debugDir}"`);

    // Debug filenames based on video filename
    const videoFilename = videoPath.split('/').pop()?.replace(/\.mp4$/, '') || 'unknown';

    // Calculate crop area for bottom-right timestamp using systematic quartering:
    // 1. Take bottom-right quarter (width/2, height/2)
    // 2. Take bottom-right quarter of that (width/4, height/4) starting at (3*width/4, 3*height/4)
    // 3. Keep full horizontal but halve vertical (bottom half) = final area at bottom 12.5% height, rightmost 25% width
    const cropWidth = Math.floor(width * 0.25);
    const cropHeight = Math.floor(height * 0.125);
    const cropX = Math.floor(width * 0.75);
    const cropY = Math.floor(height * 0.875);

    // Process frames 0, 3, 7, 10, 14 in parallel (non-consecutive to catch more cases)
    const framesToTry = [0, 3, 7, 10, 14];
    const framePromises = framesToTry.map((frameNum) => {
      return (async () => {
        const tempImagePath = join(tempDir, `frame_${Date.now()}_${frameNum}.png`);
        const debugFullPath = join(debugDir, `${videoFilename}_frame${frameNum}_full.png`);
        const debugCropPath = join(debugDir, `${videoFilename}_frame${frameNum}.png`);

        try {
          // Extract full frame for debugging
          await execAsync(
            `ffmpeg -i "${videoPath}" -vf "select=eq(n\\,${frameNum})" -vframes 1 "${debugFullPath}" -y 2>&1`
          );

          // Extract frame, crop to precise bottom-right corner (systematic quartering approach),
          // scale up 4x and apply enhancement filters for better OCR
          await execAsync(
            `ffmpeg -i "${videoPath}" -vf "select=eq(n\\,${frameNum}),crop=${cropWidth}:${cropHeight}:${cropX}:${cropY},scale=iw*4:ih*4,unsharp=7:7:2.5,eq=contrast=2:brightness=0.1" -vframes 1 "${tempImagePath}" -y 2>&1`
          );

          // Copy the cropped/processed image to debug directory
          await execAsync(`cp "${tempImagePath}" "${debugCropPath}"`);

          // Use Tesseract to extract text from the cropped image
          const { stdout } = await execAsync(
            `tesseract "${tempImagePath}" stdout --psm 7`
          );

          // Clean up temp image
          try {
            await execAsync(`rm "${tempImagePath}"`);
          } catch (e) {
            // Ignore cleanup errors
          }

          // Clean up OCR output - replace common OCR mistakes
          let cleanedText = stdout.trim()
            .replace(/[;,()]/g, '-')
            .replace(/[°*]/g, ':')
            .replace(/[oOQ]/g, '0')
            .replace(/[lI|]/g, '1')
            .replace(/[Uu]/g, '0')
            .replace(/[Zz]/g, '2')
            .replace(/\s+/g, ' ')
            .replace(/--+/g, '-')
            .replace(/[Ff]/g, '7');

          console.log(`  Frame ${frameNum} OCR raw: "${stdout.trim()}"`);
          console.log(`  Frame ${frameNum} OCR cleaned: "${cleanedText}"`);

          // Parse and validate timestamp
          const timestampMatch = cleanedText.match(/(\d{4}[-]\d{1,2}[-]\d{1,2}\s+\d{1,2}:\d{1,2}:\d{1,2})/);
          let extractedTimestamp = timestampMatch ? timestampMatch[1] : null;

          if (extractedTimestamp) {
            const parts = extractedTimestamp.split(/[-\s:]/);
            if (parts.length === 6) {
              const [year, month, day, hour, minute, second] = parts;
              // Format without seconds
              extractedTimestamp = `${year}-${month.padStart(2, '0')}-${day.padStart(2, '0')} ${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;

              // Validate timestamp values
              const yearNum = parseInt(year);
              const monthNum = parseInt(month);
              const dayNum = parseInt(day);
              const hourNum = parseInt(hour);
              const minuteNum = parseInt(minute);
              const secondNum = parseInt(second);

              if (yearNum >= 2024 && yearNum <= 2026 &&
                  monthNum >= 1 && monthNum <= 12 &&
                  dayNum >= 1 && dayNum <= 31 &&
                  hourNum >= 0 && hourNum <= 23 &&
                  minuteNum >= 0 && minuteNum <= 59 &&
                  secondNum >= 0 && secondNum <= 59) {
                console.log(`  Frame ${frameNum} ✓ Valid timestamp: ${extractedTimestamp}`);
                return { frameNum, timestamp: extractedTimestamp };
              } else {
                console.log(`  Frame ${frameNum} ✗ Invalid values`);
              }
            }
          } else {
            console.log(`  Frame ${frameNum} ✗ No pattern found`);
          }

          return { frameNum, timestamp: null };
        } catch (error) {
          console.error(`  Frame ${frameNum} error:`, error);
          return { frameNum, timestamp: null };
        }
      })();
    });

    // Wait for all frames to be processed
    const results = await Promise.all(framePromises);

    // Find first valid timestamp
    const validResult = results.find(r => r.timestamp !== null);
    const timestamp = validResult?.timestamp || null;
    const successfulFrame = validResult?.frameNum ?? -1;

    console.log(`Final timestamp: ${timestamp} (from frame ${successfulFrame})`);

    // Get video duration
    let durationStr = '';
    if (timestamp) {
      const durationSeconds = await getVideoDuration(videoPath);
      if (durationSeconds) {
        durationStr = formatFuzzyDuration(durationSeconds);
        console.log(`  Duration: ${durationStr} (${durationSeconds.toFixed(0)}s)`);
      }
    }

    // If timestamp extraction was successful, delete debug images (we only keep failed ones)
    if (timestamp) {
      try {
        for (const frameNum of framesToTry) {
          const debugFullPath = join(debugDir, `${videoFilename}_frame${frameNum}_full.png`);
          const debugCropPath = join(debugDir, `${videoFilename}_frame${frameNum}.png`);
          await execAsync(`rm -f "${debugFullPath}" "${debugCropPath}"`);
        }
        console.log(`  ✓ Cleaned up debug images (extraction successful)`);
      } catch (e) {
        // Ignore cleanup errors
      }
    } else {
      console.log(`  ⚠️ Keeping debug images (extraction failed)`);
    }

    // Cache the result (even if null, to avoid reprocessing)
    if (fileMD5 && fileMtime) {
      cache.results[videoPath] = {
        timestamp,
        duration: durationStr,
        extractedAt: new Date().toISOString(),
        md5: fileMD5,
        mtime: fileMtime
      };
      saveTimestampCache(cache);
    }

    return timestamp ? { timestamp, duration: durationStr } : null;
  } catch (error) {
    console.error('Timestamp extraction error:', error);
    return null;
  }
}

// Analyze if video is timebolted (with caching)
async function analyzeVideo(videoPath: string) {
  // Check filename patterns (fast check first)
  const filename = videoPath.split('/').pop() || '';
  const hasTimeboltedInName = /timebolted|turbo|FINAL|BEST/i.test(filename);

  // Load manual tracking
  const manualTracking = loadJSON('timebolted-videos.json') || {};
  const isManuallyMarked = manualTracking[videoPath] === true;

  // If manually marked or obvious from filename, skip analysis
  if (isManuallyMarked || hasTimeboltedInName) {
    return {
      isTimebolted: true,
      detectionMethod: isManuallyMarked ? 'manual' : 'filename'
    };
  }

  // Load cache
  const cache = loadTimeboltCache();

  // Check cache first using modification time (much faster than MD5)
  const cachedResult = cache.results[videoPath];
  const fileMtime = getFileMtime(videoPath);

  if (cachedResult && fileMtime && cachedResult.mtime === fileMtime) {
    // File hasn't changed since cache was created - use cached result
    return {
      isTimebolted: cachedResult.isTimebolted,
      detectionMethod: cachedResult.method + '-cached'
    };
  }

  // If cache miss or file changed, compute MD5 for validation
  const fileMD5 = await getFileMD5(videoPath);

  // Perform silence analysis
  console.log(`Analyzing video for timebolt: ${filename}`);
  const isTimeboltedBySilence = await detectTimeboltBySilence(videoPath);

  // Update cache with MD5 hash and mtime
  if (fileMD5 && fileMtime) {
    cache.results[videoPath] = {
      isTimebolted: isTimeboltedBySilence,
      analyzedAt: new Date().toISOString(),
      method: 'silence-analysis',
      md5: fileMD5,
      mtime: fileMtime
    };
    cache.lastRun = new Date().toISOString();
    saveTimeboltCache(cache);
  }

  return {
    isTimebolted: isTimeboltedBySilence,
    detectionMethod: 'silence-analysis'
  };
}

// API Routes
async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const path = url.pathname;

  // CORS headers
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  if (req.method === 'OPTIONS') {
    return new Response(null, { headers });
  }

  // Serve static files
  if (path === '/' || path === '/index.html') {
    const html = readFileSync(join(__dirname, 'public', 'index.html'), 'utf-8');
    return new Response(html, {
      headers: { 'Content-Type': 'text/html' }
    });
  }

  if (path.startsWith('/public/')) {
    const filePath = join(__dirname, path);
    if (existsSync(filePath)) {
      const content = readFileSync(filePath, 'utf-8');
      const contentType = path.endsWith('.css') ? 'text/css' :
                         path.endsWith('.js') ? 'application/javascript' : 'text/plain';
      return new Response(content, {
        headers: { 'Content-Type': contentType }
      });
    }
  }

  // API: Get status
  if (path === '/api/status') {
    const apiStartTime = Date.now();
    console.log('\n🔍 API /api/status called');

    // Check if force refresh is requested
    const urlObj = new URL(req.url);
    const forceRefresh = urlObj.searchParams.get('refresh') === 'true';

    // Check status cache first (unless force refresh)
    if (!forceRefresh) {
      const statusCache = loadJSON('status-cache.json');
      if (statusCache) {
        // Validate cache: check if source files have changed
        const recordingsMtime = getFileMtime('lecture_recordings.json');
        const timesMtime = getFileMtime('times_simplified.json');
        const driveMtime = getFileMtime('drive-files.json');

        if (statusCache.recordingsMtime === recordingsMtime &&
            statusCache.timesMtime === timesMtime &&
            statusCache.driveMtime === driveMtime) {
          console.log('✅ Using cached status (no file changes detected)');
          const cacheTime = Date.now() - apiStartTime;
          console.log(`⚡ Cache response time: ${cacheTime}ms\n`);
          return new Response(JSON.stringify({
            recordings: statusCache.recordings,
            timesSimplified: statusCache.timesSimplified,
            driveFiles: statusCache.driveFiles
          }), { headers });
        } else {
          console.log('🔄 Cache invalidated (files changed)');
        }
      }
    } else {
      console.log('🔄 Force refresh requested');
    }

    const loadStartTime = Date.now();
    const recordings = loadJSON('lecture_recordings.json') || [];
    const timesSimplified = loadJSON('times_simplified.json') || [];
    const driveFiles = loadJSON('drive-files.json') || {};
    console.log(`⏱️  Loaded JSON files: ${Date.now() - loadStartTime}ms`);

    // Create a map of date:group -> array of times for quick lookup
    const timesMap = new Map();
    timesSimplified.forEach((time: any) => {
      const key = `${time.date}:${time.studentGroup}`;
      if (!timesMap.has(key)) {
        timesMap.set(key, []);
      }
      timesMap.get(key).push({ start: time.start, end: time.end });
    });

    // Count total videos to process
    const totalVideos = recordings.reduce((sum: number, rec: any) =>
      sum + (rec.videos ? rec.videos.length : 0), 0);
    console.log(`📹 Processing ${totalVideos} videos across ${recordings.length} recordings`);

    // Process ALL videos across ALL recordings in parallel
    const processingStartTime = Date.now();
    await Promise.all(
      recordings.map(async (recording: any) => {
        // Add lesson time range(s) - may be multiple for same group on same day
        const timeInfoArray = timesMap.get(`${recording.date}:${recording.studentGroup}`);
        if (timeInfoArray && timeInfoArray.length > 0) {
          // Format as "09:10 - 12:25, 14:00 - 16:30" for multiple ranges
          const timeRanges = timeInfoArray.map((t: any) => `${t.start} - ${t.end}`);
          const combinedRange = timeRanges.join(', ');
          // Split back into start and end for compatibility with frontend
          recording.lessonStart = timeInfoArray[0].start;
          recording.lessonEnd = timeInfoArray[timeInfoArray.length - 1].end;
          // Store the full formatted range for display
          recording.lessonTimeRange = combinedRange;
        }

        if (recording.videos && recording.videos.length > 0) {
          recording.videosWithStatus = await Promise.all(
            recording.videos.map(async (videoPath: string) => {
              const videoStartTime = Date.now();
              const analysis = await analyzeVideo(videoPath);
              const timestampData = await extractTimestampFromVideo(videoPath);
              const videoTime = Date.now() - videoStartTime;

              if (videoTime > 1000) {
                console.log(`⚠️  Slow video (${videoTime}ms): ${videoPath.split('/').pop()}`);
              }

              // Get file size
              const fileSizeBytes = getFileSize(videoPath);
              const fileSize = fileSizeBytes ? formatFileSize(fileSizeBytes) : '';

              return {
                path: videoPath,
                filename: videoPath.split('/').pop(),
                isTimebolted: analysis.isTimebolted,
                detectionMethod: analysis.detectionMethod,
                recordingTime: timestampData?.timestamp || null,
                duration: timestampData?.duration || '',
                fileSize,
                fileSizeBytes
              };
            })
          );
        }
      })
    );
    console.log(`⏱️  Video processing complete: ${Date.now() - processingStartTime}ms`);

    // Save status cache with file mtimes for validation
    const recordingsMtime = getFileMtime('lecture_recordings.json');
    const timesMtime = getFileMtime('times_simplified.json');
    const driveMtime = getFileMtime('drive-files.json');

    const statusCacheData = {
      recordings,
      timesSimplified,
      driveFiles,
      recordingsMtime,
      timesMtime,
      driveMtime,
      cachedAt: new Date().toISOString()
    };

    Bun.write('status-cache.json', JSON.stringify(statusCacheData, null, 2));
    console.log('💾 Saved status cache');

    const totalTime = Date.now() - apiStartTime;
    console.log(`✅ Total API response time: ${totalTime}ms (${(totalTime / 1000).toFixed(2)}s)\n`);

    return new Response(JSON.stringify({
      recordings,
      timesSimplified,
      driveFiles
    }), { headers });
  }

  // API: Sync with Google Drive
  if (path === '/api/sync' && req.method === 'POST') {
    try {
      const { stdout, stderr } = await execAsync('bun run sync-google-drive.ts');
      return new Response(JSON.stringify({ success: true, output: stdout }), { headers });
    } catch (error: any) {
      return new Response(JSON.stringify({
        success: false,
        error: error.message
      }), { headers, status: 500 });
    }
  }

  // API: Scan filesystem for new files
  if (path === '/api/scan' && req.method === 'POST') {
    try {
      const { stdout, stderr } = await execAsync('bun run fetch-lesson-times.ts');
      return new Response(JSON.stringify({ success: true, output: stdout }), { headers });
    } catch (error: any) {
      return new Response(JSON.stringify({
        success: false,
        error: error.message
      }), { headers, status: 500 });
    }
  }

  // API: Check Google Drive auth status
  if (path === '/api/auth/status' && req.method === 'GET') {
    const hasToken = existsSync('token.json');
    return new Response(JSON.stringify({ authenticated: hasToken }), { headers });
  }

  // API: Start Google Drive OAuth flow
  if (path === '/api/auth/google' && req.method === 'GET') {
    try {
      const { google } = await import('googleapis');
      const credentials = JSON.parse(readFileSync('credentials.json', 'utf-8'));
      const { client_secret, client_id, redirect_uris } = credentials.installed;
      const oAuth2Client = new google.auth.OAuth2(
        client_id,
        client_secret,
        'http://localhost:3000/auth/google/callback'
      );

      const authUrl = oAuth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: ['https://www.googleapis.com/auth/drive'],
      });

      return new Response(JSON.stringify({ authUrl }), { headers });
    } catch (error: any) {
      return new Response(JSON.stringify({
        success: false,
        error: error.message
      }), { headers, status: 500 });
    }
  }

  // OAuth callback handler
  if (path.startsWith('/auth/google/callback')) {
    try {
      const urlObj = new URL(req.url);
      const code = urlObj.searchParams.get('code');

      if (!code) {
        return new Response(`
          <html>
            <body>
              <h1>❌ Authorization failed</h1>
              <p>No authorization code received.</p>
              <button onclick="window.close()">Close</button>
            </body>
          </html>
        `, { headers: { 'Content-Type': 'text/html' } });
      }

      const { google } = await import('googleapis');
      const credentials = JSON.parse(readFileSync('credentials.json', 'utf-8'));
      const { client_secret, client_id } = credentials.installed;
      const oAuth2Client = new google.auth.OAuth2(
        client_id,
        client_secret,
        'http://localhost:3000/auth/google/callback'
      );

      const { tokens } = await oAuth2Client.getToken(code);
      oAuth2Client.setCredentials(tokens);

      // Save token
      await Bun.write('token.json', JSON.stringify(tokens, null, 2));

      return new Response(`
        <html>
          <head>
            <style>
              body {
                font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
                display: flex;
                justify-content: center;
                align-items: center;
                height: 100vh;
                margin: 0;
                background: #f9f9f9;
              }
              .container {
                text-align: center;
                padding: 2rem;
                background: white;
                border-radius: 8px;
                box-shadow: 0 2px 8px rgba(0,0,0,0.1);
              }
              h1 { color: #34c759; margin: 0 0 1rem 0; }
              button {
                padding: 0.5rem 1rem;
                background: #0071e3;
                color: white;
                border: none;
                border-radius: 4px;
                cursor: pointer;
                font-size: 1rem;
              }
              button:hover { background: #0077ed; }
            </style>
          </head>
          <body>
            <div class="container">
              <h1>✅ Authorization successful!</h1>
              <p>You can now upload files to Google Drive.</p>
              <button onclick="window.close()">Close this window</button>
            </div>
          </body>
        </html>
      `, { headers: { 'Content-Type': 'text/html' } });
    } catch (error: any) {
      return new Response(`
        <html>
          <body>
            <h1>❌ Authorization failed</h1>
            <p>${error.message}</p>
            <button onclick="window.close()">Close</button>
          </body>
        </html>
      `, { headers: { 'Content-Type': 'text/html' } });
    }
  }

  // API: Delete video
  if (path.startsWith('/api/video/') && req.method === 'DELETE') {
    const videoPath = decodeURIComponent(path.replace('/api/video/', ''));

    try {
      if (existsSync(videoPath)) {
        unlinkSync(videoPath);

        // Refresh lecture_recordings.json
        await execAsync('bun run fetch-lesson-times.ts');

        // Update cache incrementally (remove the video without full rebuild)
        if (existsSync('status-cache.json')) {
          const statusCache = loadJSON('status-cache.json');
          if (statusCache && statusCache.recordings) {
            // Remove the deleted video from all recordings in cache
            statusCache.recordings.forEach((rec: any) => {
              if (rec.videos) {
                rec.videos = rec.videos.filter((v: string) => v !== videoPath);
              }
              if (rec.videosWithStatus) {
                rec.videosWithStatus = rec.videosWithStatus.filter((v: any) => v.path !== videoPath);
              }
            });

            // Update cache mtimes to reflect new state
            statusCache.recordingsMtime = getFileMtime('lecture_recordings.json');
            statusCache.cachedAt = new Date().toISOString();

            Bun.write('status-cache.json', JSON.stringify(statusCache, null, 2));
          }
        }

        return new Response(JSON.stringify({ success: true }), { headers });
      } else {
        return new Response(JSON.stringify({
          success: false,
          error: 'File not found'
        }), { headers, status: 404 });
      }
    } catch (error: any) {
      return new Response(JSON.stringify({
        success: false,
        error: error.message
      }), { headers, status: 500 });
    }
  }

  // API: Delete folder
  if (path.startsWith('/api/folder/') && req.method === 'DELETE') {
    const folderPath = decodeURIComponent(path.replace('/api/folder/', ''));

    try {
      if (existsSync(folderPath)) {
        // Delete folder recursively
        await execAsync(`rm -rf "${folderPath}"`);

        // Refresh lecture_recordings.json
        await execAsync('bun run fetch-lesson-times.ts');

        // Clear status cache to force rebuild
        if (existsSync('status-cache.json')) {
          unlinkSync('status-cache.json');
        }

        return new Response(JSON.stringify({ success: true }), { headers });
      } else {
        return new Response(JSON.stringify({
          success: false,
          error: 'Folder not found'
        }), { headers, status: 404 });
      }
    } catch (error: any) {
      return new Response(JSON.stringify({
        success: false,
        error: error.message
      }), { headers, status: 500 });
    }
  }

  // API: Rename video
  if (path === '/api/rename' && req.method === 'POST') {
    try {
      const body = await req.json();
      const { oldPath, newFilename } = body;

      if (!oldPath || !newFilename) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Missing required parameters'
        }), { headers, status: 400 });
      }

      // Validate that old file exists
      if (!existsSync(oldPath)) {
        return new Response(JSON.stringify({
          success: false,
          error: 'File not found'
        }), { headers, status: 404 });
      }

      // Construct new path
      const folderPath = oldPath.substring(0, oldPath.lastIndexOf('/'));
      const newPath = `${folderPath}/${newFilename}`;

      // Check if new file already exists
      if (existsSync(newPath)) {
        return new Response(JSON.stringify({
          success: false,
          error: 'A file with that name already exists'
        }), { headers, status: 409 });
      }

      // Rename the file
      const { rename } = await import('fs/promises');
      await rename(oldPath, newPath);

      // Refresh lecture_recordings.json
      await execAsync('bun run fetch-lesson-times.ts');

      // Update cache incrementally (rename the video without full rebuild)
      if (existsSync('status-cache.json')) {
        const statusCache = loadJSON('status-cache.json');
        if (statusCache && statusCache.recordings) {
          // Update the renamed video in all recordings in cache
          statusCache.recordings.forEach((rec: any) => {
            if (rec.videos) {
              const index = rec.videos.indexOf(oldPath);
              if (index !== -1) {
                rec.videos[index] = newPath;
              }
            }
            if (rec.videosWithStatus) {
              rec.videosWithStatus.forEach((v: any) => {
                if (v.path === oldPath) {
                  v.path = newPath;
                  v.filename = newFilename;
                }
              });
            }
          });

          // Update cache mtimes to reflect new state
          statusCache.recordingsMtime = getFileMtime('lecture_recordings.json');
          statusCache.cachedAt = new Date().toISOString();

          Bun.write('status-cache.json', JSON.stringify(statusCache, null, 2));
        }
      }

      return new Response(JSON.stringify({ success: true }), { headers });
    } catch (error: any) {
      return new Response(JSON.stringify({
        success: false,
        error: error.message
      }), { headers, status: 500 });
    }
  }

  // API: Upload to Google Drive
  if (path === '/api/upload' && req.method === 'POST') {
    try {
      const body = await req.json();
      const { videoPath, studentGroup, date } = body;

      if (!videoPath || !studentGroup || !date) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Missing required parameters'
        }), { headers, status: 400 });
      }

      // Validate file exists
      if (!existsSync(videoPath)) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Video file not found'
        }), { headers, status: 404 });
      }

      // Import Google Drive upload functionality
      const { google } = await import('googleapis');
      const { createReadStream } = await import('fs');

      // Load credentials and token
      if (!existsSync('credentials.json') || !existsSync('token.json')) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Google Drive not configured. Please run sync first.'
        }), { headers, status: 400 });
      }

      const credentials = JSON.parse(readFileSync('credentials.json', 'utf-8'));
      const token = JSON.parse(readFileSync('token.json', 'utf-8'));

      const { client_secret, client_id, redirect_uris } = credentials.installed;
      const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
      oAuth2Client.setCredentials(token);

      // Determine target folder based on student group
      const FOLDERS: { [key: string]: string } = {
        TAK24: '1IaLQwslFddy8KhxPUtg67o34pEPETrai',
        IS24: '1xDunwzOWa1B6xbMQYZRlSuS2Yai_uyAp',
        TAK25: '1IaLQwslFddy8KhxPUtg67o34pEPETrai' // Using TAK24 folder for TAK25
      };

      const folderId = FOLDERS[studentGroup];
      if (!folderId) {
        return new Response(JSON.stringify({
          success: false,
          error: `Unknown student group: ${studentGroup}`
        }), { headers, status: 400 });
      }

      // Upload file
      const drive = google.drive({ version: 'v3', auth: oAuth2Client });
      const filename = videoPath.split('/').pop() || '';
      const uploadFilename = `${studentGroup} - ${date}.mp4`;

      const fileMetadata = {
        name: uploadFilename,
        parents: [folderId]
      };

      const media = {
        mimeType: 'video/mp4',
        body: createReadStream(videoPath)
      };

      console.log(`Uploading ${filename} as ${uploadFilename} to ${studentGroup} folder...`);

      const file = await drive.files.create({
        requestBody: fileMetadata,
        media: media,
        fields: 'id, name, size'
      });

      console.log(`Upload complete! File ID: ${file.data.id}`);

      // Update lecture_recordings.json to mark as uploaded
      const recordings = loadJSON('lecture_recordings.json') || [];
      const recording = recordings.find((r: any) => r.date === date && r.studentGroup === studentGroup);
      if (recording) {
        recording.uploaded = true;
      }
      Bun.write('lecture_recordings.json', JSON.stringify(recordings, null, 2));

      // Sync with Drive to update drive-files.json
      await execAsync('bun run sync-google-drive.ts');

      return new Response(JSON.stringify({
        success: true,
        fileId: file.data.id,
        fileName: uploadFilename
      }), { headers });
    } catch (error: any) {
      console.error('Upload error:', error);
      return new Response(JSON.stringify({
        success: false,
        error: error.message
      }), { headers, status: 500 });
    }
  }

  // API: Mark as timebolted
  if (path === '/api/mark-timebolted' && req.method === 'POST') {
    try {
      const body = await req.json();
      const { videoPath, isTimebolted } = body;

      const tracking = loadJSON('timebolted-videos.json') || {};
      tracking[videoPath] = isTimebolted;

      Bun.write('timebolted-videos.json', JSON.stringify(tracking, null, 2));

      return new Response(JSON.stringify({ success: true }), { headers });
    } catch (error: any) {
      return new Response(JSON.stringify({
        success: false,
        error: error.message
      }), { headers, status: 500 });
    }
  }

  // API: Open in Finder
  if (path === '/api/open-folder' && req.method === 'POST') {
    try {
      const body = await req.json();
      const { folderPath } = body;

      // Open Finder at the folder location
      await execAsync(`open -R "${folderPath}"`);

      return new Response(JSON.stringify({ success: true }), { headers });
    } catch (error: any) {
      return new Response(JSON.stringify({
        success: false,
        error: error.message
      }), { headers, status: 500 });
    }
  }

  return new Response('Not Found', { status: 404 });
}

// Clean up debug frames on server start
const debugDir = join(__dirname, 'debug_frames');
try {
  await execAsync(`rm -rf "${debugDir}"`);
  console.log('🗑️  Cleared debug frames directory');
} catch (error) {
  // Ignore if directory doesn't exist
}

// Start server
serve({
  port: PORT,
  fetch: handleRequest,
  idleTimeout: 255 // Maximum timeout (4.25 minutes) for processing videos
});

console.log(`🚀 Lecture Recording Dashboard running at http://localhost:${PORT}`);
console.log(`📊 Open your browser to view the dashboard`);
