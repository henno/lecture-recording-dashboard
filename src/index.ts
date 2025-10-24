#!/usr/bin/env bun

import { serve } from 'bun';
import { readFileSync, existsSync, unlinkSync, statSync } from 'fs';
import { join } from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const PORT = 3000;
const STUDY_GROUPS_PATH = 'config/study-groups.json';

/**
 * Load study groups configuration
 * Returns object mapping study group names to Google Drive folder IDs
 */
function loadStudyGroups(): { [key: string]: string } {
  if (!existsSync(STUDY_GROUPS_PATH)) {
    throw new Error(
      `Missing study-groups.json file.\n\n` +
      `Please create ${STUDY_GROUPS_PATH} with your study group configurations.\n` +
      `See config/study-groups.json.example for the required format.`
    );
  }
  return JSON.parse(readFileSync(STUDY_GROUPS_PATH, 'utf-8'));
}

/**
 * Get list of study group names dynamically
 */
function getStudyGroupNames(): string[] {
  const studyGroups = loadStudyGroups();
  return Object.keys(studyGroups);
}

// Upload progress tracking
interface UploadProgress {
  uploadId: string;
  filename: string;
  videoPath: string;
  bytesUploaded: number;
  bytesTotal: number;
  percent: number;
  status: 'uploading' | 'complete' | 'error';
}

const uploadProgress = new Map<string, UploadProgress>();
const progressListeners = new Map<string, Set<(data: string) => void>>();
const cancelledUploads = new Set<string>(); // Track cancelled upload IDs
const uploadAbortControllers = new Map<string, AbortController>(); // Track AbortControllers for cancellation

// Interrupted upload state (persistent)
interface InterruptedUpload {
  videoPath: string;
  uploadSessionUrl: string;
  bytesUploaded: number;
  bytesTotal: number;
  studentGroup: string;
  date: string;
  interruptedAt: string;
}

// Load interrupted uploads from disk
function loadInterruptedUploads(): Record<string, InterruptedUpload> {
  try {
    const data = loadJSON('data/active-uploads.json');
    return data || {};
  } catch (error) {
    return {};
  }
}

// Save interrupted upload state
function saveInterruptedUpload(videoPath: string, state: InterruptedUpload) {
  const uploads = loadInterruptedUploads();
  uploads[videoPath] = state;
  Bun.write('data/active-uploads.json', JSON.stringify(uploads, null, 2));
}

// Remove interrupted upload (completed or cancelled)
function removeInterruptedUpload(videoPath: string) {
  const uploads = loadInterruptedUploads();
  delete uploads[videoPath];
  Bun.write('data/active-uploads.json', JSON.stringify(uploads, null, 2));
}

// Background upload function that continues independently of HTTP request
async function performBackgroundUpload(
  videoPath: string,
  uploadUrl: string,
  totalBytes: number,
  uploadId: string,
  studentGroup: string,
  date: string,
  uploadFilename: string,
  startFromByte: number = 0  // Add optional parameter for resume
) {
  const filename = videoPath.split('/').pop() || '';

  // Create AbortController for this upload
  const abortController = new AbortController();
  uploadAbortControllers.set(uploadId, abortController);

  try {
    // Step 2: Upload file in chunks with progress tracking
    const CHUNK_SIZE = 256 * 1024; // 256KB chunks
    const fileHandle = await Bun.file(videoPath);
    const fileBuffer = await fileHandle.arrayBuffer();

    let bytesUploaded = startFromByte;
    let lastEmittedPercent = -1;
    let lastEmitTime = 0;
    const EMIT_INTERVAL_MS = 1000;

    console.log(`🔄 Background upload loop starting for ${filename}...`);

    // Upload in chunks
    while (bytesUploaded < totalBytes) {
      // Check if upload was paused by user
      if (cancelledUploads.has(uploadId)) {
        console.log(`⏸️  Upload paused by user: ${filename}`);
        cancelledUploads.delete(uploadId);
        uploadAbortControllers.delete(uploadId);

        // Mark as paused (keeps resume data, different from network error)
        const progress = uploadProgress.get(uploadId);
        if (progress) {
          progress.status = 'paused';
          uploadProgress.set(uploadId, progress);
          emitProgress(uploadId);
        }

        // Clean up
        setTimeout(() => {
          uploadProgress.delete(uploadId);
          progressListeners.delete(uploadId);
        }, 2000);

        return;
      }

      const start = bytesUploaded;
      const end = Math.min(start + CHUNK_SIZE, totalBytes);
      const chunk = fileBuffer.slice(start, end);

      // Add 10-second timeout for network detection
      const timeoutId = setTimeout(() => abortController.abort(), 10000);

      try {
        const chunkResponse = await fetch(uploadUrl, {
          method: 'PUT',
          headers: {
            'Content-Length': String(chunk.byteLength),
            'Content-Range': `bytes ${start}-${end - 1}/${totalBytes}`
          },
          body: chunk,
          signal: abortController.signal
        });

        clearTimeout(timeoutId);

        bytesUploaded = end;
        const percent = Math.round((bytesUploaded / totalBytes) * 100);

        const now = Date.now();
        const timeSinceLastEmit = now - lastEmitTime;

        // Emit progress updates (throttled)
        if (percent !== lastEmittedPercent && timeSinceLastEmit >= EMIT_INTERVAL_MS) {
          const progress = uploadProgress.get(uploadId);
          if (progress) {
            progress.bytesUploaded = bytesUploaded;
            progress.percent = percent;
            uploadProgress.set(uploadId, progress);
            emitProgress(uploadId);
            lastEmittedPercent = percent;
            lastEmitTime = now;
          }

          // Update interrupted upload state on disk (for resume capability)
          console.log(`💾 Progress ${percent}%: Updating state on disk (${Math.round(bytesUploaded / (1024 * 1024))} MB / ${Math.round(totalBytes / (1024 * 1024))} MB)`);
          saveInterruptedUpload(videoPath, {
            videoPath,
            uploadSessionUrl: uploadUrl,
            bytesUploaded,
            bytesTotal: totalBytes,
            studentGroup,
            date,
            interruptedAt: new Date().toISOString()
          });
        }

        // Check if upload is complete
        if (chunkResponse.status === 200 || chunkResponse.status === 201) {
          const file = await chunkResponse.json();
          console.log(`✅ Upload complete! File ID: ${file.id}`);

          // Ensure final 100% is emitted
          const progress = uploadProgress.get(uploadId);
          if (progress) {
            progress.status = 'complete';
            progress.bytesUploaded = totalBytes;
            progress.percent = 100;
            uploadProgress.set(uploadId, progress);
            emitProgress(uploadId);

            // Clean up after a delay
            setTimeout(() => {
              uploadProgress.delete(uploadId);
              progressListeners.delete(uploadId);
              uploadAbortControllers.delete(uploadId);
            }, 5000);
          }

          // Remove from interrupted uploads (no longer needs resume)
          console.log(`🗑️  Removing from active-uploads.json (upload complete)`);
          removeInterruptedUpload(videoPath);
          uploadAbortControllers.delete(uploadId);

          // Update lecture_recordings.json to mark as uploaded
          const recordings = loadJSON('data/lecture_recordings.json') || [];
          const recording = recordings.find((r: any) => r.date === date && r.studentGroup === studentGroup);
          if (recording) {
            recording.uploaded = true;
          }
          Bun.write('data/lecture_recordings.json', JSON.stringify(recordings, null, 2));

          // Sync with Drive to update drive-files.json
          await execAsync('bun run sync');

          return;
        }
      } catch (chunkError: any) {
        clearTimeout(timeoutId);

        // Check if this was an abort (either timeout or user cancel)
        if (chunkError.name === 'AbortError' || abortController.signal.aborted) {
          // Don't throw - let the outer loop check cancellation status
          console.log(`⏸️  Chunk upload aborted (timeout or cancel)`);
        } else {
          // Re-throw other errors
          throw chunkError;
        }
      }
    }

    throw new Error('Upload completed but no success response received');
  } catch (error: any) {
    console.error(`❌ Background upload error for ${filename}:`, error);
    console.error(`   Error type: ${error.code || error.name}`);
    console.error(`   Error message: ${error.message}`);
    console.log(`💾 State preserved in active-uploads.json for resume`);

    // Mark as error
    const progress = uploadProgress.get(uploadId);
    if (progress) {
      progress.status = 'error';
      uploadProgress.set(uploadId, progress);
      emitProgress(uploadId);

      // Clean up after a delay
      setTimeout(() => {
        uploadProgress.delete(uploadId);
        progressListeners.delete(uploadId);
        uploadAbortControllers.delete(uploadId);
      }, 2000);
    }

    // Clean up abort controller
    uploadAbortControllers.delete(uploadId);
  }
}

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
    const cache = loadJSON('data/timebolted-cache.json');
    return cache || { lastRun: null, results: {} };
  } catch (error) {
    return { lastRun: null, results: {} };
  }
}

// Save timebolt cache
function saveTimeboltCache(cache: any) {
  Bun.write('data/timebolted-cache.json', JSON.stringify(cache, null, 2));
}

// Load timestamp cache
function loadTimestampCache() {
  try {
    const cache = loadJSON('data/timestamp-cache.json');
    return cache || { results: {} };
  } catch (error) {
    return { results: {} };
  }
}

// Save timestamp cache
function saveTimestampCache(cache: any) {
  Bun.write('data/timestamp-cache.json', JSON.stringify(cache, null, 2));
}

// Get partial hash of file (first 300 bytes only for speed)
async function getFileHash(filePath: string): Promise<string | null> {
  try {
    // Read first 300 bytes and compute xxHash3 (extremely fast)
    // Analysis showed max common prefix between different files is 163 bytes, so 300 bytes provides 84% safety margin
    const file = Bun.file(filePath);
    const slice = file.slice(0, 300);
    const buffer = await slice.arrayBuffer();
    const hash = Bun.hash.xxHash3(buffer);
    return hash.toString();
  } catch (error) {
    console.error('Hash error:', error);
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

  // If cache miss or file changed, compute hash for validation
  const fileHash = await getFileHash(videoPath);

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
    if (fileHash && fileMtime) {
      cache.results[videoPath] = {
        timestamp,
        duration: durationStr,
        extractedAt: new Date().toISOString(),
        hash: fileHash,
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
  const manualTracking = loadJSON('data/timebolted-videos.json') || {};
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

  // If cache miss or file changed, compute hash for validation
  const fileHash = await getFileHash(videoPath);

  // Perform silence analysis
  console.log(`Analyzing video for timebolt: ${filename}`);
  const isTimeboltedBySilence = await detectTimeboltBySilence(videoPath);

  // Update cache with hash and mtime
  if (fileHash && fileMtime) {
    cache.results[videoPath] = {
      isTimebolted: isTimeboltedBySilence,
      analyzedAt: new Date().toISOString(),
      method: 'silence-analysis',
      hash: fileHash,
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

// Emit progress update to all listeners
function emitProgress(uploadId: string) {
  const progress = uploadProgress.get(uploadId);
  if (!progress) return;

  const listeners = progressListeners.get(uploadId);
  if (!listeners || listeners.size === 0) return;

  const data = JSON.stringify(progress);
  listeners.forEach(send => send(data));
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

  // SSE: Upload progress stream
  if (path.startsWith('/api/upload-progress/')) {
    const uploadId = path.replace('/api/upload-progress/', '');

    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();

        // Function to send SSE message
        const send = (data: string) => {
          controller.enqueue(encoder.encode(`data: ${data}\n\n`));
        };

        // Register listener
        if (!progressListeners.has(uploadId)) {
          progressListeners.set(uploadId, new Set());
        }
        progressListeners.get(uploadId)!.add(send);

        // Send initial state if exists
        const progress = uploadProgress.get(uploadId);
        if (progress) {
          send(JSON.stringify(progress));
        }

        // Cleanup on close
        req.signal?.addEventListener('abort', () => {
          const listeners = progressListeners.get(uploadId);
          if (listeners) {
            listeners.delete(send);
            if (listeners.size === 0) {
              progressListeners.delete(uploadId);
            }
          }
        });
      }
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive',
      }
    });
  }

  // Serve static files
  if (path === '/' || path === '/index.html') {
    const html = readFileSync(join(__dirname, '..', 'public', 'index.html'), 'utf-8');
    return new Response(html, {
      headers: { 'Content-Type': 'text/html' }
    });
  }

  if (path.startsWith('/public/')) {
    const filePath = join(__dirname, '..', path);
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
      const statusCache = loadJSON('data/status-cache.json');
      if (statusCache) {
        // Validate cache: check if source files have changed
        const recordingsMtime = getFileMtime('data/lecture_recordings.json');
        const timesMtime = getFileMtime('data/times_simplified.json');
        const driveMtime = getFileMtime('data/drive-files.json');

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
    console.log('📂 Loading JSON files...');
    const recordings = loadJSON('data/lecture_recordings.json') || [];
    console.log(`   - lecture_recordings.json: ${Date.now() - loadStartTime}ms`);
    const timesLoadStart = Date.now();
    const timesSimplified = loadJSON('data/times_simplified.json') || [];
    console.log(`   - times_simplified.json: ${Date.now() - timesLoadStart}ms`);
    const driveLoadStart = Date.now();
    const driveFiles = loadJSON('data/drive-files.json') || {};
    console.log(`   - drive-files.json: ${Date.now() - driveLoadStart}ms`);
    console.log(`⏱️  Total JSON load time: ${Date.now() - loadStartTime}ms`);

    // Create a map of date:group -> array of times for quick lookup
    const mapStartTime = Date.now();
    console.log('🗺️  Building times map...');
    const timesMap = new Map();
    timesSimplified.forEach((time: any) => {
      const key = `${time.date}:${time.studentGroup}`;
      if (!timesMap.has(key)) {
        timesMap.set(key, []);
      }
      timesMap.get(key).push({ start: time.start, end: time.end });
    });
    console.log(`⏱️  Times map built: ${Date.now() - mapStartTime}ms`);

    // Count total videos to process
    const totalVideos = recordings.reduce((sum: number, rec: any) =>
      sum + (rec.videos ? rec.videos.length : 0), 0);
    console.log(`📹 Processing ${totalVideos} videos across ${recordings.length} recordings`);

    // Load previous video metadata cache for MD5 comparison
    const previousStatusCache = loadJSON('data/status-cache.json');
    const videoMetadataCache = previousStatusCache?.videoMetadataCache || {};

    // Process ALL videos across ALL recordings in parallel
    const processingStartTime = Date.now();
    const newVideoMetadataCache: any = {};

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

              // Compute xxHash3 of first 300 bytes for cache validation
              const hashStart = Date.now();
              const fileHash = await getFileHash(videoPath);
              const hashTime = Date.now() - hashStart;

              // Check if we have cached metadata for this video with matching hash
              const cachedMetadata = videoMetadataCache[videoPath];
              if (cachedMetadata && fileHash && cachedMetadata.hash === fileHash) {
                // Hash matches - use cached metadata (skip expensive operations)
                newVideoMetadataCache[videoPath] = cachedMetadata;

                const videoTime = Date.now() - videoStartTime;
                if (videoTime > 10) {
                  console.log(`✅ Using cached metadata (${videoTime}ms): ${videoPath.split('/').pop()}`);
                }

                return cachedMetadata.data;
              }

              // Hash doesn't match or no cache - need to reprocess
              console.log(`🔄 Processing video (hash changed): ${videoPath.split('/').pop()}`);

              const analysisStart = Date.now();
              const analysis = await analyzeVideo(videoPath);
              const analysisTime = Date.now() - analysisStart;

              const timestampStart = Date.now();
              const timestampData = await extractTimestampFromVideo(videoPath);
              const timestampTime = Date.now() - timestampStart;

              const fileSizeStart = Date.now();
              const fileSizeBytes = getFileSize(videoPath);
              const fileSize = fileSizeBytes ? formatFileSize(fileSizeBytes) : '';
              const fileSizeTime = Date.now() - fileSizeStart;

              const videoTime = Date.now() - videoStartTime;

              if (videoTime > 1000) {
                console.log(`⚠️  Slow video (${videoTime}ms): ${videoPath.split('/').pop()}`);
                console.log(`      - xxHash3: ${hashTime}ms`);
                console.log(`      - analyzeVideo: ${analysisTime}ms`);
                console.log(`      - extractTimestamp: ${timestampTime}ms`);
                console.log(`      - getFileSize: ${fileSizeTime}ms`);
              }

              const videoData = {
                path: videoPath,
                filename: videoPath.split('/').pop(),
                isTimebolted: analysis.isTimebolted,
                detectionMethod: analysis.detectionMethod,
                recordingTime: timestampData?.timestamp || null,
                duration: timestampData?.duration || '',
                fileSize,
                fileSizeBytes
              };

              // Store in new cache with hash
              if (fileHash) {
                newVideoMetadataCache[videoPath] = {
                  hash: fileHash,
                  cachedAt: new Date().toISOString(),
                  data: videoData
                };
              }

              return videoData;
            })
          );
        }
      })
    );
    console.log(`⏱️  Video processing complete: ${Date.now() - processingStartTime}ms`);

    // Save status cache with file mtimes for validation
    const cacheStartTime = Date.now();
    console.log('💾 Preparing cache data...');
    const recordingsMtime = getFileMtime('data/lecture_recordings.json');
    const timesMtime = getFileMtime('data/times_simplified.json');
    const driveMtime = getFileMtime('data/drive-files.json');

    const statusCacheData = {
      recordings,
      timesSimplified,
      driveFiles,
      videoMetadataCache: newVideoMetadataCache,
      recordingsMtime,
      timesMtime,
      driveMtime,
      cachedAt: new Date().toISOString()
    };

    const stringifyStart = Date.now();
    const cacheJson = JSON.stringify(statusCacheData, null, 2);
    console.log(`   - JSON.stringify: ${Date.now() - stringifyStart}ms`);

    const writeStart = Date.now();
    await Bun.write('data/status-cache.json', cacheJson);
    console.log(`   - File write: ${Date.now() - writeStart}ms`);
    console.log(`⏱️  Total cache save time: ${Date.now() - cacheStartTime}ms`);

    const responseStartTime = Date.now();
    console.log('📤 Building response...');
    const responseData = JSON.stringify({
      recordings,
      timesSimplified,
      driveFiles
    });
    console.log(`   - Response JSON.stringify: ${Date.now() - responseStartTime}ms`);
    console.log(`   - Response size: ${(responseData.length / 1024).toFixed(2)} KB`);

    const totalTime = Date.now() - apiStartTime;
    console.log(`✅ Total API response time: ${totalTime}ms (${(totalTime / 1000).toFixed(2)}s)\n`);

    return new Response(responseData, { headers });
  }

  // API: Get interrupted uploads
  if (path === '/api/interrupted-uploads' && req.method === 'GET') {
    const interrupted = loadInterruptedUploads();
    const count = Object.keys(interrupted).length;
    if (count > 0) {
      console.log(`📋 Client requested interrupted uploads: ${count} found`);
      Object.entries(interrupted).forEach(([path, state]: [string, any]) => {
        const filename = path.split('/').pop();
        const percent = Math.round((state.bytesUploaded / state.bytesTotal) * 100);
        console.log(`   - ${filename}: ${percent}% (${Math.round(state.bytesUploaded / (1024 * 1024))} MB / ${Math.round(state.bytesTotal / (1024 * 1024))} MB)`);
      });
    }
    return new Response(JSON.stringify(interrupted), { headers });
  }

  // API: Get active uploads (currently in progress)
  if (path === '/api/active-uploads' && req.method === 'GET') {
    const active: Record<string, any> = {};

    // Convert Map to object for JSON serialization
    // We need to map uploadId back to videoPath - we'll scan through active uploads
    for (const [uploadId, progress] of uploadProgress.entries()) {
      // The uploadId contains the timestamp and random string, but we need the videoPath
      // We'll have to store videoPath in the progress object
      if (progress.videoPath) {
        active[progress.videoPath] = {
          percent: progress.percent,
          bytesUploaded: progress.bytesUploaded,
          bytesTotal: progress.bytesTotal,
          status: progress.status,
          uploadId: uploadId
        };
      }
    }

    const count = Object.keys(active).length;
    if (count > 0) {
      console.log(`🚀 Client requested active uploads: ${count} in progress`);
      Object.entries(active).forEach(([path, state]: [string, any]) => {
        const filename = path.split('/').pop();
        console.log(`   - ${filename}: ${state.percent}% (${Math.round(state.bytesUploaded / (1024 * 1024))} MB / ${Math.round(state.bytesTotal / (1024 * 1024))} MB)`);
      });
    }

    return new Response(JSON.stringify(active), { headers });
  }

  // API: Resume interrupted upload
  if (path === '/api/resume-upload' && req.method === 'POST') {
    try {
      const body = await req.json();
      const { videoPath, uploadId } = body;

      const finalUploadId = uploadId || `upload_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

      if (!videoPath) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Missing videoPath'
        }), { headers, status: 400 });
      }

      // Load interrupted upload state
      const interrupted = loadInterruptedUploads();
      const uploadState = interrupted[videoPath];

      if (!uploadState) {
        return new Response(JSON.stringify({
          success: false,
          error: 'No interrupted upload found for this video'
        }), { headers, status: 404 });
      }

      const filename = videoPath.split('/').pop() || '';
      console.log(`▶️  RESUME REQUEST: ${filename}`);
      console.log(`   📁 Video: ${videoPath}`);
      console.log(`   📊 Saved state: ${Math.round(uploadState.bytesUploaded / (1024 * 1024))} MB / ${Math.round(uploadState.bytesTotal / (1024 * 1024))} MB (${Math.round((uploadState.bytesUploaded / uploadState.bytesTotal) * 100)}%)`);
      console.log(`   🔗 Session URL: ${uploadState.uploadSessionUrl.substring(0, 80)}...`);
      console.log(`   ⏰ Interrupted at: ${uploadState.interruptedAt}`);

      // Import Google Drive auth functionality
      const { google } = await import('googleapis');

      // Load credentials and token
      if (!existsSync('config/credentials.json') || !existsSync('config/token.json')) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Google Drive not configured. Please run sync first.'
        }), { headers, status: 400 });
      }

      const credentials = JSON.parse(readFileSync('config/credentials.json', 'utf-8'));
      const token = JSON.parse(readFileSync('config/token.json', 'utf-8'));

      const { client_secret, client_id, redirect_uris } = credentials.installed;
      const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
      oAuth2Client.setCredentials(token);

      // Get access token
      const accessToken = await oAuth2Client.getAccessToken();
      if (!accessToken.token) {
        throw new Error('Failed to get access token');
      }

      const { uploadSessionUrl, bytesUploaded: startBytes, bytesTotal, studentGroup, date } = uploadState;
      const uploadFilename = `${studentGroup} - ${date}.mp4`;

      // Initialize progress tracking
      uploadProgress.set(finalUploadId, {
        uploadId: finalUploadId,
        filename,
        videoPath,
        bytesUploaded: startBytes,
        bytesTotal,
        percent: Math.round((startBytes / bytesTotal) * 100),
        status: 'uploading'
      });
      emitProgress(finalUploadId);

      console.log(`🔍 Querying Google Drive for actual upload status...`);
      // Query Google Drive for actual upload status
      const statusResponse = await fetch(uploadSessionUrl, {
        method: 'PUT',
        headers: {
          'Authorization': `Bearer ${accessToken.token}`,
          'Content-Length': '0',
          'Content-Range': `bytes */${bytesTotal}`
        }
      });

      // Check if session expired (404 Not Found or 410 Gone)
      if (statusResponse.status === 404 || statusResponse.status === 410) {
        console.log(`   ❌ Status: ${statusResponse.status} - Upload session expired`);

        // Try to get Google Drive's error message
        let driveErrorMessage = '';
        try {
          const errorBody = await statusResponse.text();
          console.log(`   📋 Google Drive response: ${errorBody}`);
          const errorJson = JSON.parse(errorBody);
          driveErrorMessage = errorJson.error?.message || errorBody;
        } catch (e) {
          driveErrorMessage = statusResponse.statusText || 'No error details available';
        }

        console.log(`   🗑️  Removing expired session from active-uploads.json`);
        removeInterruptedUpload(videoPath);

        return new Response(JSON.stringify({
          success: false,
          error: 'Upload session expired. Google Drive resumable upload sessions expire after ~7 days. Please start a new upload.',
          driveError: driveErrorMessage,
          sessionExpired: true
        }), { headers, status: 410 });
      }

      let actualBytesUploaded = startBytes;

      // Check Range header to see how much Google received
      if (statusResponse.status === 308) {
        console.log(`   Status: 308 Resume Incomplete`);
        const rangeHeader = statusResponse.headers.get('Range');
        console.log(`   Range header: ${rangeHeader || 'none'}`);
        if (rangeHeader) {
          const match = rangeHeader.match(/bytes=0-(\d+)/);
          if (match) {
            actualBytesUploaded = parseInt(match[1]) + 1;
            console.log(`   ✅ Google Drive confirmed: ${Math.round(actualBytesUploaded / (1024 * 1024))} MB received`);
            console.log(`   📤 Resuming upload from byte ${actualBytesUploaded}`);
          }
        } else {
          console.log(`   ⚠️  No Range header, starting from saved position: ${Math.round(startBytes / (1024 * 1024))} MB`);
        }
      } else if (statusResponse.status === 200 || statusResponse.status === 201) {
        // Upload already complete!
        const file = await statusResponse.json();
        console.log(`   Status: ${statusResponse.status} - Upload already complete!`);
        console.log(`   ✅ File ID: ${file.id}`);
        console.log(`   🗑️  Removing from active-uploads.json`);
        removeInterruptedUpload(videoPath);

        const progress = uploadProgress.get(finalUploadId);
        if (progress) {
          progress.status = 'complete';
          progress.percent = 100;
          uploadProgress.set(finalUploadId, progress);
          emitProgress(finalUploadId);
        }

        return new Response(JSON.stringify({
          success: true,
          fileId: file.id,
          fileName: uploadFilename,
          alreadyComplete: true
        }), { headers });
      }

      // Start background upload from where we left off
      console.log(`📤 Starting background resume from byte ${actualBytesUploaded}...`);
      performBackgroundUpload(
        videoPath,
        uploadSessionUrl,
        bytesTotal,
        finalUploadId,
        studentGroup,
        date,
        uploadFilename,
        actualBytesUploaded  // Resume from this position
      ).catch((err) => {
        console.error(`❌ Background resume error for ${filename}:`, err);
      });

      // Return immediately - upload continues in background
      return new Response(JSON.stringify({
        success: true,
        uploadId: finalUploadId,
        message: 'Resume started in background',
        resumedFrom: actualBytesUploaded
      }), { headers });
    } catch (resumeError: any) {
      const isCancelled = resumeError.message === 'Upload cancelled by client';

      if (isCancelled) {
        console.log(`❌ Resume cancelled`);
      } else {
        console.error('Resume error:', resumeError);
      }

      return new Response(JSON.stringify({
        success: false,
        error: resumeError.message,
        cancelled: isCancelled
      }), { headers, status: isCancelled ? 499 : 500 });
    }
  }

  // API: Sync with Google Drive
  if (path === '/api/sync' && req.method === 'POST') {
    try {
      const { stdout, stderr } = await execAsync('bun run sync');
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
      const { stdout, stderr } = await execAsync('bun run fetch');
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
    const hasToken = existsSync('config/token.json');
    return new Response(JSON.stringify({ authenticated: hasToken }), { headers });
  }

  // API: Start Google Drive OAuth flow
  if (path === '/api/auth/google' && req.method === 'GET') {
    try {
      const { google } = await import('googleapis');
      const credentials = JSON.parse(readFileSync('config/credentials.json', 'utf-8'));
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
      const credentials = JSON.parse(readFileSync('config/credentials.json', 'utf-8'));
      const { client_secret, client_id } = credentials.installed;
      const oAuth2Client = new google.auth.OAuth2(
        client_id,
        client_secret,
        'http://localhost:3000/auth/google/callback'
      );

      const { tokens } = await oAuth2Client.getToken(code);
      oAuth2Client.setCredentials(tokens);

      // Save token
      await Bun.write('config/token.json', JSON.stringify(tokens, null, 2));

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
        await execAsync('bun run fetch');

        // Update cache incrementally (remove the video without full rebuild)
        if (existsSync('data/status-cache.json')) {
          const statusCache = loadJSON('data/status-cache.json');
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
            statusCache.recordingsMtime = getFileMtime('data/lecture_recordings.json');
            statusCache.cachedAt = new Date().toISOString();

            Bun.write('data/status-cache.json', JSON.stringify(statusCache, null, 2));
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
        await execAsync('bun run fetch');

        // Clear status cache to force rebuild
        if (existsSync('data/status-cache.json')) {
          unlinkSync('data/status-cache.json');
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
      await execAsync('bun run fetch');

      // Update cache incrementally (rename the video without full rebuild)
      if (existsSync('data/status-cache.json')) {
        const statusCache = loadJSON('data/status-cache.json');
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
          statusCache.recordingsMtime = getFileMtime('data/lecture_recordings.json');
          statusCache.cachedAt = new Date().toISOString();

          Bun.write('data/status-cache.json', JSON.stringify(statusCache, null, 2));
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
      const { videoPath, studentGroup, date, uploadId } = body;

      // Generate upload ID if not provided
      const finalUploadId = uploadId || `upload_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

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

      // Import Google Drive auth functionality
      const { google } = await import('googleapis');

      // Load credentials and token
      if (!existsSync('config/credentials.json') || !existsSync('config/token.json')) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Google Drive not configured. Please run sync first.'
        }), { headers, status: 400 });
      }

      const credentials = JSON.parse(readFileSync('config/credentials.json', 'utf-8'));
      const token = JSON.parse(readFileSync('config/token.json', 'utf-8'));

      const { client_secret, client_id, redirect_uris } = credentials.installed;
      const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
      oAuth2Client.setCredentials(token);

      // Determine target folder based on student group
      const FOLDERS = loadStudyGroups();

      const folderId = FOLDERS[studentGroup];
      if (!folderId) {
        return new Response(JSON.stringify({
          success: false,
          error: `Unknown student group: ${studentGroup}`
        }), { headers, status: 400 });
      }

      // Prepare upload
      const filename = videoPath.split('/').pop() || '';
      const uploadFilename = `${studentGroup} - ${date}.mp4`;

      // Validate that the filename matches the student group
      // Expected formats: "TAK24 - 2025-10-16.mp4" or "TAK24 - 2025-10-16_02.mp4"
      const studyGroupNames = getStudyGroupNames();
      const groupPattern = studyGroupNames.join('|');
      const filenameStudentGroupMatch = filename.match(new RegExp(`^(${groupPattern})\\s*-`));
      if (filenameStudentGroupMatch) {
        const filenameStudentGroup = filenameStudentGroupMatch[1];
        if (filenameStudentGroup !== studentGroup) {
          return new Response(JSON.stringify({
            success: false,
            error: `Student group mismatch: filename contains "${filenameStudentGroup}" but you're trying to upload to "${studentGroup}" folder. Please check the schedule assignment.`
          }), { headers, status: 400 });
        }
      }

      // Get file size for progress tracking
      const fileStats = statSync(videoPath);
      const totalBytes = fileStats.size;

      // Initialize progress
      uploadProgress.set(finalUploadId, {
        uploadId: finalUploadId,
        filename,
        videoPath,
        bytesUploaded: 0,
        bytesTotal: totalBytes,
        percent: 0,
        status: 'uploading'
      });
      emitProgress(finalUploadId);

      console.log(`📤 Uploading ${filename} as ${uploadFilename} to ${studentGroup} folder (${formatFileSize(totalBytes)})...`);

      // Get access token for direct API calls
      const accessToken = await oAuth2Client.getAccessToken();
      if (!accessToken.token) {
        throw new Error('Failed to get access token');
      }

      // Step 1: Initiate resumable upload session
      const metadata = {
        name: uploadFilename,
        parents: [folderId],
        mimeType: 'video/mp4'
      };

      const initResponse = await fetch('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken.token}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(metadata)
      });

      const uploadUrl = initResponse.headers.get('Location');
      if (!uploadUrl) {
        throw new Error('Failed to get upload URL');
      }

      console.log(`📍 Got upload session URL, starting background upload...`);
      console.log(`💾 Saving initial upload state to active-uploads.json (0 bytes uploaded)`);

      // Save interrupted upload state (persistent across restarts)
      saveInterruptedUpload(videoPath, {
        videoPath,
        uploadSessionUrl: uploadUrl,
        bytesUploaded: 0,
        bytesTotal: totalBytes,
        studentGroup,
        date,
        interruptedAt: new Date().toISOString()
      });
      console.log(`✅ Initial state saved to disk`);

      // Start upload in background (don't await - return immediately)
      performBackgroundUpload(videoPath, uploadUrl, totalBytes, finalUploadId, studentGroup, date, uploadFilename).catch((err) => {
        console.error(`❌ Background upload error for ${filename}:`, err);
      });

      // Return immediately - upload continues in background
      return new Response(JSON.stringify({
        success: true,
        uploadId: finalUploadId,
        message: 'Upload started in background'
      }), { headers });

    } catch (error: any) {
      console.error('❌ Upload initialization error:', error);
      return new Response(JSON.stringify({
        success: false,
        error: error.message
      }), { headers, status: 500 });
    }
  }

  // API: Cancel upload
  if (path === '/api/pause-upload' && req.method === 'POST') {
    try {
      const body = await req.json();
      const { videoPath } = body;

      if (!videoPath) {
        return new Response(JSON.stringify({
          success: false,
          error: 'Missing videoPath parameter'
        }), { headers, status: 400 });
      }

      // Find the upload ID for this video path
      let uploadId: string | null = null;
      for (const [id, progress] of uploadProgress.entries()) {
        if (progress.videoPath === videoPath) {
          uploadId = id;
          break;
        }
      }

      if (!uploadId) {
        return new Response(JSON.stringify({
          success: false,
          error: 'No active upload found for this video'
        }), { headers, status: 404 });
      }

      // Mark upload as paused and abort the in-flight request
      cancelledUploads.add(uploadId);
      const abortController = uploadAbortControllers.get(uploadId);
      if (abortController) {
        abortController.abort();
      }
      console.log(`⏸️  Upload pause requested for: ${videoPath.split('/').pop()}`);

      // Keep in interrupted uploads (can be resumed)
      // Note: The background upload will save state to active-uploads.json

      return new Response(JSON.stringify({
        success: true,
        message: 'Upload paused'
      }), { headers });

    } catch (error: any) {
      console.error('❌ Cancel upload error:', error);
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

      const tracking = loadJSON('data/timebolted-videos.json') || {};
      tracking[videoPath] = isTimebolted;

      Bun.write('data/timebolted-videos.json', JSON.stringify(tracking, null, 2));

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
  idleTimeout: 255 // Maximum allowed by Bun (client has 10-minute timeout)
});

console.log(`🚀 Lecture Recording Dashboard running at http://localhost:${PORT}`);
console.log(`📊 Open your browser to view the dashboard`);
