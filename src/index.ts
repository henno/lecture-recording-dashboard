#!/usr/bin/env bun

import { serve } from 'bun';
import { readFileSync, existsSync, unlinkSync, statSync, readdirSync, renameSync, appendFileSync } from 'fs';
import { join } from 'path';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

/**
 * Logger class - logs to both console and server.log file with timestamps
 */
class Logger {
  private logFile = 'server.log';

  private formatTimestamp(): string {
    const now = new Date();
    return now.toISOString();
  }

  log(...args: any[]) {
    const timestamp = this.formatTimestamp();
    let message = args.map(arg =>
      typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
    ).join(' ');

    // Log to console (original format with newlines)
    console.log(...args);

    // For file logging, strip ALL leading and trailing newlines
    const cleanMessage = message.replace(/^\n+/, '').replace(/\n+$/, '');

    // Skip empty messages to avoid empty lines
    if (!cleanMessage) {
      return;
    }

    // Log to file - clean message with timestamp, always single newline at end
    try {
      appendFileSync(
        this.logFile,
        `[${timestamp}] ${cleanMessage}\n`
      );
    } catch (e) {
      console.error('Failed to write to log file:', e);
    }
  }

  error(...args: any[]) {
    const timestamp = this.formatTimestamp();
    let message = args.map(arg =>
      typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
    ).join(' ');

    // Log to console (original format with newlines)
    console.error(...args);

    // For file logging, strip ALL leading and trailing newlines
    const cleanMessage = message.replace(/^\n+/, '').replace(/\n+$/, '');

    // Skip empty messages to avoid empty lines
    if (!cleanMessage) {
      return;
    }

    // Log to file with ERROR prefix - clean message, always single newline at end
    try {
      appendFileSync(
        this.logFile,
        `[${timestamp}] ERROR: ${cleanMessage}\n`
      );
    } catch (e) {
      console.error('Failed to write to log file:', e);
    }
  }
}

const logger = new Logger();

const PORT = 3000;
const STUDY_GROUPS_PATH = 'config/study-groups.json';
const MAX_CONCURRENT_VIDEOS = 4; // Limit concurrent video processing to avoid CPU overload
const MAX_CONCURRENT_FFMPEG = 5; // Global limit for concurrent ffmpeg processes

/**
 * Semaphore for limiting concurrent ffmpeg processes
 */
class FfmpegSemaphore {
  private queue: (() => void)[] = [];
  private running = 0;
  private activeOperations: Map<number, string> = new Map();
  private operationIdCounter = 0;

  constructor(private limit: number) {}

  async acquire(): Promise<void> {
    if (this.running < this.limit) {
      this.running++;
      return;
    }

    return new Promise<void>(resolve => {
      this.queue.push(resolve);
    });
  }

  release(): void {
    this.running--;
    const next = this.queue.shift();
    if (next) {
      this.running++;
      next();
    }
  }

  async run<T>(fn: () => Promise<T>, description: string): Promise<T> {
    const operationId = this.operationIdCounter++;
    await this.acquire();

    try {
      this.activeOperations.set(operationId, description);
      return await fn();
    } finally {
      this.activeOperations.delete(operationId);
      this.release();
    }
  }

  getStatus(): { running: number; operations: string[] } {
    return {
      running: this.running,
      operations: Array.from(this.activeOperations.values())
    };
  }
}

const ffmpegSemaphore = new FfmpegSemaphore(MAX_CONCURRENT_FFMPEG);

/**
 * Run ffmpeg command with global concurrency control
 */
async function runFfmpeg(command: string, description: string): Promise<{ stdout: string; stderr: string }> {
  return ffmpegSemaphore.run(() => execAsync(command), description);
}

/**
 * Status logger - logs ffmpeg manager status every 10 seconds
 */
setInterval(() => {
  const status = ffmpegSemaphore.getStatus();
  if (status.running > 0) {
    logger.log(`\n🎬 FFMPEG Status: ${status.running}/${MAX_CONCURRENT_FFMPEG} processes running`);
    status.operations.forEach((op, index) => {
      logger.log(`   ${index + 1}. ${op}`);
    });
  }
}, 10000);

/**
 * In-memory lock to prevent duplicate video processing
 * Maps video path -> Promise<metadata>
 */
const processingVideos = new Map<string, Promise<any>>();


/**
 * Process items with concurrency limit
 */
async function processConcurrent<T, R>(
  items: T[],
  concurrency: number,
  processor: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = [];
  const executing: Promise<void>[] = [];

  for (const item of items) {
    const promise = processor(item).then(result => {
      results.push(result);
      executing.splice(executing.indexOf(promise), 1);
    });
    executing.push(promise);

    if (executing.length >= concurrency) {
      await Promise.race(executing);
    }
  }

  await Promise.all(executing);
  return results;
}

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
  status: 'uploading' | 'complete' | 'error' | 'paused';
}

// Request body interfaces
interface ResumeUploadBody {
  videoPath: string;
  uploadId?: string;
}

interface RenameVideoBody {
  oldPath: string;
  newFilename: string;
}

interface UploadVideoBody {
  videoPath: string;
  date: string;
  uploadId?: string;
}

interface PauseUploadBody {
  videoPath: string;
}

interface MarkTimeboltedBody {
  videoPath: string;
  isTimebolted: boolean;
}

interface OpenFolderBody {
  folderPath: string;
}

// Google Drive API response
interface GoogleDriveFile {
  id: string;
  name?: string;
  mimeType?: string;
  [key: string]: any; // Allow other properties
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
    const CHUNK_SIZE = 5 * 1024 * 1024; // 5MB chunks (Google Drive recommended size)
    const fileHandle = Bun.file(videoPath);

    let bytesUploaded = startFromByte;
    let lastEmittedPercent = -1;
    let lastEmitTime = 0;
    const EMIT_INTERVAL_MS = 1000;

    logger.log(`🔄 Background upload loop starting for ${filename}...`);

    // Upload in chunks
    while (bytesUploaded < totalBytes) {
      // Check if upload was paused by user
      if (cancelledUploads.has(uploadId)) {
        logger.log(`⏸️  Upload paused by user: ${filename}`);
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

      // Stream chunk from file instead of loading entire file into memory
      const chunk = await fileHandle.slice(start, end).arrayBuffer();

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
          logger.log(`💾 Progress ${percent}%: Updating state on disk (${Math.round(bytesUploaded / (1024 * 1024))} MB / ${Math.round(totalBytes / (1024 * 1024))} MB)`);
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
          const file = await chunkResponse.json() as GoogleDriveFile;
          logger.log(`✅ Upload complete! File ID: ${file.id}`);

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
          logger.log(`🗑️  Removing from active-uploads.json (upload complete)`);
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
          logger.log(`⏸️  Chunk upload aborted (timeout or cancel)`);
        } else {
          // Re-throw other errors
          throw chunkError;
        }
      }
    }

    throw new Error('Upload completed but no success response received');
  } catch (error: any) {
    logger.error(`❌ Background upload error for ${filename}:`, error);
    logger.error(`   Error type: ${error.code || error.name}`);
    logger.error(`   Error message: ${error.message}`);
    logger.log(`💾 State preserved in active-uploads.json for resume`);

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
  } catch (error: any) {
    // Only log non-ENOENT errors (missing files are expected and handled)
    if (error.code !== 'ENOENT') {
      logger.error('Hash error:', error);
    }
    return null;
  }
}

// Detect timebolt using silence analysis
async function detectTimeboltBySilence(videoPath: string): Promise<boolean> {
  try {
    // Analyze first 5 seconds for silences >1 second at -30dB threshold
    const { stdout } = await runFfmpeg(
      `ffmpeg -i "${videoPath}" -t 5 -af "silencedetect=noise=-30dB:d=1" -f null - 2>&1 | grep "silence_duration" | wc -l`,
      `Silence detection: ${videoPath.split('/').pop()}`
    );

    const silenceCount = parseInt(stdout.trim());
    // 0 silences = likely timebolted, ≥1 silence = likely original
    return silenceCount === 0;
  } catch (error) {
    logger.error('Silence detection error:', error);
    return false;
  }
}

// Get video duration in seconds
async function getVideoDuration(videoPath: string): Promise<number | null> {
  try {
    const { stdout } = await runFfmpeg(
      `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${videoPath}"`,
      `Get duration: ${videoPath.split('/').pop()}`
    );
    const duration = parseFloat(stdout.trim());
    return isNaN(duration) ? null : duration;
  } catch (error) {
    logger.error('Duration extraction error:', error);
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
async function extractTimestampFromVideo(videoPath: string): Promise<{ timestamp: string, duration: string, endTimestamp: string } | null> {
  const cache = loadTimestampCache();

  // Compute xxHash3 of first 300 bytes for cache validation
  const fileHash = await getFileHash(videoPath);

  // Check cache first using hash (not mtime - files can be copied/moved)
  const cachedResult = cache.results[videoPath];
  if (cachedResult && fileHash && cachedResult.hash === fileHash) {
    // Hash matches - file content unchanged, use cached result
    return cachedResult.timestamp ? {
      timestamp: cachedResult.timestamp,
      duration: cachedResult.duration || '',
      endTimestamp: cachedResult.endTimestamp || ''
    } : null;
  }

  try {
    const filename = videoPath.split('/').pop() || '';
    logger.log(`Extracting timestamp from: ${filename}`);

    // Get video dimensions first
    const { stdout: probeOutput } = await runFfmpeg(
      `ffprobe -v error -select_streams v:0 -show_entries stream=width,height -of csv=p=0 "${videoPath}"`,
      `Get dimensions: ${filename}`
    );

    const [widthStr, heightStr] = probeOutput.trim().split(',');
    const width = parseInt(widthStr);
    const height = parseInt(heightStr);

    if (!width || !height) {
      logger.error(`Could not detect video dimensions for ${filename}`);
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

    // Calculate crop area for bottom-right timestamp
    // Zoom timestamps are positioned at fixed pixel offsets from edges, not percentages
    // Crop a fixed-size region from bottom-right corner to capture just the timestamp box
    const timestampBoxWidth = 300;   // Width of timestamp box in pixels
    const timestampBoxHeight = 45;   // Height of timestamp box in pixels
    const marginRight = 21;          // Pixels from right edge
    const marginBottom = 15;         // Pixels from bottom edge

    const cropWidth = Math.min(timestampBoxWidth, width - marginRight);
    const cropHeight = Math.min(timestampBoxHeight, height - marginBottom);
    const cropX = Math.max(0, width - timestampBoxWidth - marginRight);
    const cropY = Math.max(0, height - timestampBoxHeight - marginBottom);

    // Process frames 0, 3, 7, 10, 14 SEQUENTIALLY (to avoid CPU overload)
    const framesToTry = [0, 3, 7, 10, 14];
    const results: any[] = [];

    for (const frameNum of framesToTry) {
      const tempImagePath = join(tempDir, `frame_${Date.now()}_${frameNum}.png`);
      const debugFullPath = join(debugDir, `${videoFilename}_frame${frameNum}_full.png`);
      const debugCropPath = join(debugDir, `${videoFilename}_frame${frameNum}.png`);

      try {
        // Extract full frame for debugging
        await runFfmpeg(
          `ffmpeg -i "${videoPath}" -vf "select=eq(n\\,${frameNum})" -vframes 1 "${debugFullPath}" -y 2>&1`,
          `Extract start frame ${frameNum} (debug): ${videoFilename}`
        );

        // Extract frame, crop to bottom-right timestamp, and scale up 4x
        // Use minimal preprocessing - aggressive filters can corrupt text
        await runFfmpeg(
          `ffmpeg -i "${videoPath}" -vf "select=eq(n\\,${frameNum}),crop=${cropWidth}:${cropHeight}:${cropX}:${cropY},scale=iw*4:ih*4" -vframes 1 "${tempImagePath}" -y 2>&1`,
          `Extract start frame ${frameNum}: ${videoFilename}`
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

        logger.log(`  Frame ${frameNum} OCR raw: "${stdout.trim()}"`);
        logger.log(`  Frame ${frameNum} OCR cleaned: "${cleanedText}"`);

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
              logger.log(`  Frame ${frameNum} ✓ Valid timestamp: ${extractedTimestamp}`);
              results.push({ frameNum, timestamp: extractedTimestamp });
              break; // Stop after first valid timestamp
            } else {
              logger.log(`  Frame ${frameNum} ✗ Invalid values`);
              results.push({ frameNum, timestamp: null });
            }
          } else {
            results.push({ frameNum, timestamp: null });
          }
        } else {
          logger.log(`  Frame ${frameNum} ✗ No pattern found`);
          results.push({ frameNum, timestamp: null });
        }
      } catch (error) {
        logger.error(`  Frame ${frameNum} error:`, error);
        results.push({ frameNum, timestamp: null });
      }
    }

    // Find first valid timestamp
    const validResult = results.find(r => r.timestamp !== null);
    const timestamp = validResult?.timestamp || null;
    const successfulFrame = validResult?.frameNum ?? -1;

    logger.log(`Final start timestamp: ${timestamp} (from frame ${successfulFrame})`);

    // Get video duration and extract end timestamp from last frame
    let durationStr = '';
    let endTimestamp = '';
    if (timestamp) {
      const durationSeconds = await getVideoDuration(videoPath);
      if (durationSeconds) {
        durationStr = formatFuzzyDuration(durationSeconds);
        logger.log(`  Duration: ${durationStr} (${durationSeconds.toFixed(0)}s)`);

        // Extract timestamp from last frame (since video might be edited/timebolted)
        try {
          // Get total frame count and FPS for time-based seeking
          const { stdout: frameCountOutput } = await runFfmpeg(
            `ffprobe -v error -select_streams v:0 -count_packets -show_entries stream=nb_read_packets -of csv=p=0 "${videoPath}"`,
            `Get frame count: ${filename}`
          );
          const totalFrames = parseInt(frameCountOutput.trim());
          const fps = totalFrames / durationSeconds;
          logger.log(`  Total frames: ${totalFrames}, FPS: ${fps.toFixed(2)}`);

          if (totalFrames > 15) {
            logger.log(`  Extracting end timestamp from last frames...`);
            // Extract timestamp from last frames (going backwards from end, similar to start strategy)
            const lastFramesToTry = [
              totalFrames - 1,   // Last frame
              totalFrames - 4,   // -3 frames
              totalFrames - 8,   // -7 frames
              totalFrames - 11,  // -10 frames
              totalFrames - 15   // -14 frames
            ].filter(f => f > 0);

            // Process frames SEQUENTIALLY (to avoid CPU overload)
            const endResults: any[] = [];

            for (const frameNum of lastFramesToTry) {
              const tempImagePath = join(tempDir, `frame_end_${Date.now()}_${frameNum}.png`);

              try {
                // Calculate time position for this frame (time-based seeking is MUCH faster than frame-based)
                const seekTime = frameNum / fps;
                logger.log(`  Extracting end frame ${frameNum} (seek to ${seekTime.toFixed(2)}s)...`);

                // Use -ss BEFORE -i for fast seeking, then extract 1 frame
                // Use MINIMAL preprocessing for end frames - unsharp/eq filters corrupt colons
                await runFfmpeg(
                  `ffmpeg -ss ${seekTime.toFixed(3)} -i "${videoPath}" -vf "crop=${cropWidth}:${cropHeight}:${cropX}:${cropY},scale=iw*4:ih*4" -vframes 1 "${tempImagePath}" -y 2>&1`,
                  `Extract end frame ${frameNum}: ${filename}`
                );

                // Verify frame was actually extracted
                if (!existsSync(tempImagePath)) {
                  logger.log(`  End frame ${frameNum} ✗ FFmpeg failed to extract frame (seek beyond video end?)`);
                  endResults.push({ frameNum, endTime: null });
                  continue;
                }

                logger.log(`  Running OCR on end frame ${frameNum}...`);
                const { stdout } = await execAsync(`tesseract "${tempImagePath}" stdout --psm 7`);

                // Clean OCR output
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

                logger.log(`  End frame ${frameNum} OCR raw: "${stdout.trim()}"`);
                logger.log(`  End frame ${frameNum} OCR cleaned: "${cleanedText}"`);

                const timestampMatch = cleanedText.match(/(\d{4}[-]\d{1,2}[-]\d{1,2}\s+\d{1,2}:\d{1,2}:\d{1,2})/);
                if (timestampMatch) {
                  const parts = timestampMatch[1].split(/[-\s:]/);
                  if (parts.length === 6) {
                    const [year, month, day, hour, minute, second] = parts;

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
                      const endTime = `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`;
                      logger.log(`  End frame ${frameNum} ✓ Valid timestamp: ${endTime}`);
                      endResults.push({ frameNum, endTime });
                      break; // Stop after first valid timestamp
                    } else {
                      logger.log(`  End frame ${frameNum} ✗ Invalid values`);
                      endResults.push({ frameNum, endTime: null });
                    }
                  } else {
                    endResults.push({ frameNum, endTime: null });
                  }
                } else {
                  logger.log(`  End frame ${frameNum} ✗ No pattern found`);
                  endResults.push({ frameNum, endTime: null });
                }

                // Cleanup temp file
                await execAsync(`rm -f "${tempImagePath}"`);
              } catch (e) {
                logger.error(`  End frame ${frameNum} error:`, e);
                endResults.push({ frameNum, endTime: null });
              }
            }

            // Find first valid end timestamp
            const validEndResult = endResults.find(r => r.endTime !== null);
            if (validEndResult) {
              endTimestamp = validEndResult.endTime!;
              logger.log(`  Final end timestamp: ${endTimestamp} (from frame ${validEndResult.frameNum})`);
            }
          }
        } catch (error) {
          logger.log(`  ⚠️ Could not extract end timestamp:`, error);
        }
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
        logger.log(`  ✓ Cleaned up debug images (extraction successful)`);
      } catch (e) {
        // Ignore cleanup errors
      }
    } else {
      logger.log(`  ⚠️ Keeping debug images (extraction failed)`);
    }

    // Cache the result (even if null, to avoid reprocessing)
    if (fileHash) {
      cache.results[videoPath] = {
        timestamp,
        duration: durationStr,
        endTimestamp,
        extractedAt: new Date().toISOString(),
        hash: fileHash
      };
      saveTimestampCache(cache);
    }

    return timestamp ? { timestamp, duration: durationStr, endTimestamp } : null;
  } catch (error) {
    logger.error('Timestamp extraction error:', error);
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

  // Compute xxHash3 of first 300 bytes for cache validation
  const fileHash = await getFileHash(videoPath);

  // Check cache first using hash (not mtime - files can be copied/moved)
  const cachedResult = cache.results[videoPath];
  if (cachedResult && fileHash && cachedResult.hash === fileHash) {
    // Hash matches - file content unchanged, use cached result
    return {
      isTimebolted: cachedResult.isTimebolted,
      detectionMethod: cachedResult.method + '-cached'
    };
  }

  // Perform silence analysis
  logger.log(`Analyzing video for timebolt: ${filename}`);
  const isTimeboltedBySilence = await detectTimeboltBySilence(videoPath);

  // Update cache with hash only
  if (fileHash) {
    cache.results[videoPath] = {
      isTimebolted: isTimeboltedBySilence,
      analyzedAt: new Date().toISOString(),
      method: 'silence-analysis',
      hash: fileHash
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

  // API: Get study groups configuration
  if (path === '/api/study-groups' && req.method === 'GET') {
    try {
      const studyGroups = loadStudyGroups();
      return new Response(JSON.stringify(studyGroups), { headers });
    } catch (error: any) {
      return new Response(JSON.stringify({
        success: false,
        error: error.message
      }), { headers, status: 500 });
    }
  }

  // API: Get status
  if (path === '/api/status') {
    const apiStartTime = Date.now();
    logger.log('\n🔍 API /api/status called');

    // Check status cache first
    const statusCache = loadJSON('data/status-cache.json');
    if (statusCache) {
      const recordingsMtime = getFileMtime('data/lecture_recordings.json');
      const timesMtime = getFileMtime('data/times_simplified.json');
      const driveMtime = getFileMtime('data/drive-files.json');

      if (statusCache.recordingsMtime === recordingsMtime &&
          statusCache.timesMtime === timesMtime &&
          statusCache.driveMtime === driveMtime) {
        logger.log('✅ Using cached status (no file changes detected)');
        const cacheTime = Date.now() - apiStartTime;
        logger.log(`⚡ Cache response time: ${cacheTime}ms\n`);
        return new Response(JSON.stringify({
          recordings: statusCache.recordings,
          timesSimplified: statusCache.timesSimplified,
          driveFiles: statusCache.driveFiles
        }), { headers });
      } else {
        logger.log('🔄 Source files changed - rebuilding cache');
      }
    }

    const loadStartTime = Date.now();
    logger.log('📂 Loading JSON files...');
    const recordings = loadJSON('data/lecture_recordings.json') || [];
    const timesSimplified = loadJSON('data/times_simplified.json') || [];
    const driveFiles = loadJSON('data/drive-files.json') || {};
    logger.log(`⏱️  Total JSON load time: ${Date.now() - loadStartTime}ms`);

    // Create times map
    const mapStartTime = Date.now();
    logger.log('🗺️  Building times map...');
    const timesMap = new Map();
    timesSimplified.forEach((time: any) => {
      const key = `${time.date}:${time.studentGroup}`;
      if (!timesMap.has(key)) {
        timesMap.set(key, []);
      }
      timesMap.get(key).push({ start: time.start, end: time.end });
    });
    logger.log(`⏱️  Times map built: ${Date.now() - mapStartTime}ms`);

    // Add lesson time ranges to recordings (no video metadata processing)
    const processingStartTime = Date.now();
    recordings.forEach((recording: any) => {
      const timeInfoArray = timesMap.get(`${recording.date}:${recording.studentGroup}`);
      if (timeInfoArray && timeInfoArray.length > 0) {
        const timeRanges = timeInfoArray.map((t: any) => `${t.start} - ${t.end}`);
        const combinedRange = timeRanges.join(', ');
        recording.lessonStart = timeInfoArray[0].start;
        recording.lessonEnd = timeInfoArray[timeInfoArray.length - 1].end;
        recording.lessonTimeRange = combinedRange;
      }

      // Keep video paths but don't process metadata yet
      if (recording.videos && recording.videos.length > 0) {
        recording.videoPaths = recording.videos;
      }
    });
    logger.log(`⏱️  Recordings processed: ${Date.now() - processingStartTime}ms`);

    // Save cache
    const cacheStartTime = Date.now();
    const recordingsMtime = getFileMtime('data/lecture_recordings.json');
    const timesMtime = getFileMtime('data/times_simplified.json');
    const driveMtime = getFileMtime('data/drive-files.json');

    const statusCacheData = {
      recordings,
      timesSimplified,
      driveFiles,
      recordingsMtime,
      timesMtime,
      driveMtime,
      cachedAt: new Date().toISOString()
    };

    await Bun.write('data/status-cache.json', JSON.stringify(statusCacheData, null, 2));
    logger.log(`⏱️  Cache saved: ${Date.now() - cacheStartTime}ms`);

    const totalTime = Date.now() - apiStartTime;
    logger.log(`✅ Total API response time: ${totalTime}ms\n`);

    return new Response(JSON.stringify({
      recordings,
      timesSimplified,
      driveFiles
    }), { headers });
  }

  // API: Get video metadata (single video)
  if (path === '/api/video-metadata' && req.method === 'GET') {
    const url = new URL(req.url);
    const videoPath = url.searchParams.get('path');

    if (!videoPath) {
      return new Response(JSON.stringify({ error: 'Missing path parameter' }), {
        headers,
        status: 400
      });
    }

    try {
      // Check if this video is already being processed
      if (processingVideos.has(videoPath)) {
        logger.log(`⏳ Video already processing, waiting: ${videoPath.split('/').pop()}`);
        const result = await processingVideos.get(videoPath);
        return new Response(JSON.stringify(result), { headers });
      }

      // Create processing promise
      const processingPromise = (async () => {
        try {
          const startTime = Date.now();

          // Load video metadata cache
          const videoMetadataCache = loadJSON('data/video-metadata-cache.json') || {};

          // Compute hash for cache validation
          const fileHash = await getFileHash(videoPath);

          // Check cache first
          const cachedMetadata = videoMetadataCache[videoPath];
          if (cachedMetadata && fileHash && cachedMetadata.hash === fileHash) {
            const responseTime = Date.now() - startTime;
            logger.log(`✅ Video metadata from cache (${responseTime}ms): ${videoPath.split('/').pop()}`);
            return cachedMetadata.data;
          }

          // Not in cache or hash changed - extract metadata
          logger.log(`🔄 Extracting video metadata: ${videoPath.split('/').pop()}`);

          const analysis = await analyzeVideo(videoPath);
          const timestampData = await extractTimestampFromVideo(videoPath);
          const fileSizeBytes = getFileSize(videoPath);
          const fileSize = fileSizeBytes ? formatFileSize(fileSizeBytes) : '';

          const videoData = {
            path: videoPath,
            filename: videoPath.split('/').pop(),
            isTimebolted: analysis.isTimebolted,
            detectionMethod: analysis.detectionMethod,
            recordingTime: timestampData?.timestamp || null,
            endTimestamp: timestampData?.endTimestamp || '',
            duration: timestampData?.duration || '',
            fileSize,
            fileSizeBytes
          };

          // Save to cache
          if (fileHash) {
            videoMetadataCache[videoPath] = {
              hash: fileHash,
              cachedAt: new Date().toISOString(),
              data: videoData
            };
            await Bun.write('data/video-metadata-cache.json', JSON.stringify(videoMetadataCache, null, 2));
          }

          const responseTime = Date.now() - startTime;
          logger.log(`✅ Video metadata extracted (${responseTime}ms): ${videoPath.split('/').pop()}`);

          return videoData;
        } finally {
          // Remove from processing map when done
          processingVideos.delete(videoPath);
        }
      })();

      // Store promise in map
      processingVideos.set(videoPath, processingPromise);

      // Wait for result
      const result = await processingPromise;
      return new Response(JSON.stringify(result), { headers });

    } catch (error: any) {
      logger.error(`❌ Error extracting video metadata for ${videoPath}:`, error);
      processingVideos.delete(videoPath); // Clean up on error
      return new Response(JSON.stringify({
        error: 'Failed to extract video metadata',
        message: error.message
      }), { headers, status: 500 });
    }
  }

  // API: Get interrupted uploads
  if (path === '/api/interrupted-uploads' && req.method === 'GET') {
    const interrupted = loadInterruptedUploads();
    const count = Object.keys(interrupted).length;
    if (count > 0) {
      logger.log(`📋 Client requested interrupted uploads: ${count} found`);
      Object.entries(interrupted).forEach(([path, state]: [string, any]) => {
        const filename = path.split('/').pop();
        const percent = Math.round((state.bytesUploaded / state.bytesTotal) * 100);
        logger.log(`   - ${filename}: ${percent}% (${Math.round(state.bytesUploaded / (1024 * 1024))} MB / ${Math.round(state.bytesTotal / (1024 * 1024))} MB)`);
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
      logger.log(`🚀 Client requested active uploads: ${count} in progress`);
      Object.entries(active).forEach(([path, state]: [string, any]) => {
        const filename = path.split('/').pop();
        logger.log(`   - ${filename}: ${state.percent}% (${Math.round(state.bytesUploaded / (1024 * 1024))} MB / ${Math.round(state.bytesTotal / (1024 * 1024))} MB)`);
      });
    }

    return new Response(JSON.stringify(active), { headers });
  }

  // API: Resume interrupted upload
  if (path === '/api/resume-upload' && req.method === 'POST') {
    try {
      const body = await req.json() as ResumeUploadBody;
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
      logger.log(`▶️  RESUME REQUEST: ${filename}`);
      logger.log(`   📁 Video: ${videoPath}`);
      logger.log(`   📊 Saved state: ${Math.round(uploadState.bytesUploaded / (1024 * 1024))} MB / ${Math.round(uploadState.bytesTotal / (1024 * 1024))} MB (${Math.round((uploadState.bytesUploaded / uploadState.bytesTotal) * 100)}%)`);
      logger.log(`   🔗 Session URL: ${uploadState.uploadSessionUrl.substring(0, 80)}...`);
      logger.log(`   ⏰ Interrupted at: ${uploadState.interruptedAt}`);

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

      logger.log(`🔍 Querying Google Drive for actual upload status...`);
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
        logger.log(`   ❌ Status: ${statusResponse.status} - Upload session expired`);

        // Try to get Google Drive's error message
        let driveErrorMessage = '';
        try {
          const errorBody = await statusResponse.text();
          logger.log(`   📋 Google Drive response: ${errorBody}`);
          const errorJson = JSON.parse(errorBody);
          driveErrorMessage = errorJson.error?.message || errorBody;
        } catch (e) {
          driveErrorMessage = statusResponse.statusText || 'No error details available';
        }

        logger.log(`   🗑️  Removing expired session from active-uploads.json`);
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
        logger.log(`   Status: 308 Resume Incomplete`);
        const rangeHeader = statusResponse.headers.get('Range');
        logger.log(`   Range header: ${rangeHeader || 'none'}`);
        if (rangeHeader) {
          const match = rangeHeader.match(/bytes=0-(\d+)/);
          if (match) {
            actualBytesUploaded = parseInt(match[1]) + 1;
            logger.log(`   ✅ Google Drive confirmed: ${Math.round(actualBytesUploaded / (1024 * 1024))} MB received`);
            logger.log(`   📤 Resuming upload from byte ${actualBytesUploaded}`);
          }
        } else {
          logger.log(`   ⚠️  No Range header, starting from saved position: ${Math.round(startBytes / (1024 * 1024))} MB`);
        }
      } else if (statusResponse.status === 200 || statusResponse.status === 201) {
        // Upload already complete!
        const file = await statusResponse.json() as GoogleDriveFile;
        logger.log(`   Status: ${statusResponse.status} - Upload already complete!`);
        logger.log(`   ✅ File ID: ${file.id}`);
        logger.log(`   🗑️  Removing from active-uploads.json`);
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
      logger.log(`📤 Starting background resume from byte ${actualBytesUploaded}...`);
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
        logger.error(`❌ Background resume error for ${filename}:`, err);
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
        logger.log(`❌ Resume cancelled`);
      } else {
        logger.error('Resume error:', resumeError);
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
      logger.log('🔄 Starting Google Drive sync...');

      // Create a promise that rejects after 2 minutes
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('Sync timeout after 2 minutes')), 120000);
      });

      // Race between sync and timeout
      const syncPromise = execAsync('bun run sync');
      const { stdout, stderr } = await Promise.race([syncPromise, timeoutPromise]) as any;

      logger.log('✅ Sync completed');
      if (stderr) {
        logger.log('Sync stderr:', stderr);
      }
      return new Response(JSON.stringify({ success: true, output: stdout }), { headers });
    } catch (error: any) {
      logger.error('❌ Sync failed:', error);
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
        const folderPath = videoPath.substring(0, videoPath.lastIndexOf('/'));

        unlinkSync(videoPath);

        // Check if folder is now empty (no more videos)
        let shouldDeleteFolder = false;
        let folderError = null;
        try {
          const remainingFiles = readdirSync(folderPath);
          const videoFiles = remainingFiles.filter(f =>
            f.endsWith('.mp4') ||
            f.endsWith('.mkv') ||
            f.endsWith('.avi') ||
            f.endsWith('.mov') ||
            f.endsWith('.m4v')
          );

          if (videoFiles.length === 0) {
            shouldDeleteFolder = true;
            logger.log(`📁 No more videos in ${folderPath}, deleting folder...`);
            await execAsync(`rm -rf "${folderPath}"`);
            logger.log(`✅ Folder deleted: ${folderPath}`);
          }
        } catch (error: any) {
          logger.error(`❌ Error deleting folder: ${error.message}`);
          folderError = error.message;
        }

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

        return new Response(JSON.stringify({
          success: true,
          folderDeleted: shouldDeleteFolder,
          folderError
        }), { headers });
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
      const body = await req.json() as RenameVideoBody;
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
      renameSync(oldPath, newPath);

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
      const body = await req.json() as UploadVideoBody;
      const { videoPath, date, uploadId } = body;

      // Generate upload ID if not provided
      const finalUploadId = uploadId || `upload_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

      if (!videoPath || !date) {
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

      // Extract filename and determine student group from filename
      const filename = videoPath.split('/').pop() || '';

      // Extract student group from filename (first word before " -")
      const studyGroupNames = getStudyGroupNames();
      const groupPattern = studyGroupNames.join('|');
      const filenameStudentGroupMatch = filename.match(new RegExp(`^(${groupPattern})\\s*-`));

      if (!filenameStudentGroupMatch) {
        return new Response(JSON.stringify({
          success: false,
          error: `Unable to determine student group from filename "${filename}". Filename must start with a known student group (${studyGroupNames.join(', ')}) followed by " - ".`
        }), { headers, status: 400 });
      }

      const studentGroup = filenameStudentGroupMatch[1];

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

      // Determine target folder based on student group extracted from filename
      const FOLDERS = loadStudyGroups();

      const folderId = FOLDERS[studentGroup];
      if (!folderId) {
        return new Response(JSON.stringify({
          success: false,
          error: `Unknown student group: ${studentGroup}`
        }), { headers, status: 400 });
      }

      // Prepare upload - use original filename to preserve suffixes like _01, _02, etc.
      const uploadFilename = filename;

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

      logger.log(`📤 Uploading ${filename} as ${uploadFilename} to ${studentGroup} folder (${formatFileSize(totalBytes)})...`);

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

      logger.log(`📍 Got upload session URL, starting background upload...`);
      logger.log(`💾 Saving initial upload state to active-uploads.json (0 bytes uploaded)`);

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
      logger.log(`✅ Initial state saved to disk`);

      // Start upload in background (don't await - return immediately)
      performBackgroundUpload(videoPath, uploadUrl, totalBytes, finalUploadId, studentGroup, date, uploadFilename).catch((err) => {
        logger.error(`❌ Background upload error for ${filename}:`, err);
      });

      // Return immediately - upload continues in background
      return new Response(JSON.stringify({
        success: true,
        uploadId: finalUploadId,
        message: 'Upload started in background'
      }), { headers });

    } catch (error: any) {
      logger.error('❌ Upload initialization error:', error);
      return new Response(JSON.stringify({
        success: false,
        error: error.message
      }), { headers, status: 500 });
    }
  }

  // API: Cancel upload
  if (path === '/api/pause-upload' && req.method === 'POST') {
    try {
      const body = await req.json() as PauseUploadBody;
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
      logger.log(`⏸️  Upload pause requested for: ${videoPath.split('/').pop()}`);

      // Keep in interrupted uploads (can be resumed)
      // Note: The background upload will save state to active-uploads.json

      return new Response(JSON.stringify({
        success: true,
        message: 'Upload paused'
      }), { headers });

    } catch (error: any) {
      logger.error('❌ Cancel upload error:', error);
      return new Response(JSON.stringify({
        success: false,
        error: error.message
      }), { headers, status: 500 });
    }
  }

  // API: Mark as timebolted
  if (path === '/api/mark-timebolted' && req.method === 'POST') {
    try {
      const body = await req.json() as MarkTimeboltedBody;
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
      const body = await req.json() as OpenFolderBody;
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

// Server startup banner
logger.log(`\n⭐⭐⭐ SERVER STARTED - ${new Date().toLocaleString('et-EE', { timeZone: 'Europe/Tallinn' })} - Port ${PORT} - PID ${process.pid} ⭐⭐⭐\n`);

// Kill zombie child processes from previous server run
const pidFile = 'server.pid';
try {
  if (existsSync(pidFile)) {
    const oldPid = readFileSync(pidFile, 'utf-8').trim();
    logger.log(`📋 Found previous server PID: ${oldPid}`);

    // Check if old process still exists
    try {
      await execAsync(`ps -p ${oldPid}`);
      logger.log(`⚠️  Previous server process ${oldPid} is still running!`);
    } catch {
      // Old process is dead, but might have zombie children
      try {
        const { stdout } = await execAsync(`pgrep -P ${oldPid} | wc -l`);
        const count = parseInt(stdout.trim());
        if (count > 0) {
          logger.log(`🧹 Killing ${count} zombie child processes from previous run (parent PID ${oldPid})...`);
          await execAsync(`pkill -9 -P ${oldPid}`);
          logger.log(`✅ Cleaned up zombie processes`);
        }
      } catch (error) {
        // No child processes found
      }
    }
  }
} catch (error) {
  logger.error('Error cleaning up old processes:', error);
}

// Write current PID to file
try {
  await Bun.write(pidFile, String(process.pid));
  logger.log(`💾 Saved current PID ${process.pid} to ${pidFile}`);
} catch (error) {
  logger.error('Error writing PID file:', error);
}

// Clean up debug frames on server start
const debugDir = join(__dirname, 'debug_frames');
try {
  await execAsync(`rm -rf "${debugDir}"`);
  logger.log('🗑️  Cleared debug frames directory');
} catch (error) {
  // Ignore if directory doesn't exist
}

// Start server
serve({
  port: PORT,
  fetch: handleRequest,
  idleTimeout: 255 // Maximum allowed by Bun (client has 10-minute timeout)
});

logger.log(`🚀 Lecture Recording Dashboard running at http://localhost:${PORT}`);
logger.log(`📊 Open your browser to view the dashboard`);

// Handle server shutdown gracefully
process.on('SIGINT', async () => {
  logger.log('\n⏹️  Server stopped by user (Ctrl+C)');

  // Kill all child processes (including ffmpeg/ffprobe spawned by this server)
  try {
    const { stdout } = await execAsync(`pgrep -P ${process.pid} | wc -l`);
    const count = parseInt(stdout.trim());
    if (count > 0) {
      logger.log(`🧹 Killing ${count} child processes...`);
      await execAsync(`pkill -9 -P ${process.pid}`);
      logger.log(`✅ Cleaned up child processes`);
    }
  } catch (error) {
    // Ignore if no child processes
  }

  // Remove PID file (clean shutdown)
  try {
    if (existsSync(pidFile)) {
      unlinkSync(pidFile);
      logger.log(`🗑️  Removed PID file`);
    }
  } catch (error) {
    // Ignore
  }

  process.exit(0);
});

process.on('SIGTERM', async () => {
  logger.log('\n⏹️  Server stopped (SIGTERM)');

  // Kill all child processes
  try {
    const { stdout } = await execAsync(`pgrep -P ${process.pid} | wc -l`);
    const count = parseInt(stdout.trim());
    if (count > 0) {
      logger.log(`🧹 Killing ${count} child processes...`);
      await execAsync(`pkill -9 -P ${process.pid}`);
      logger.log(`✅ Cleaned up child processes`);
    }
  } catch (error) {
    // Ignore
  }

  // Remove PID file (clean shutdown)
  try {
    if (existsSync(pidFile)) {
      unlinkSync(pidFile);
      logger.log(`🗑️  Removed PID file`);
    }
  } catch (error) {
    // Ignore
  }

  process.exit(0);
});

// Background video scanning on server startup
(async () => {
  try {
    logger.log('\n🎬 Starting background video scanning...');

    // Load all recordings
    const recordings = loadJSON('data/lecture_recordings.json') || [];

    // Collect all video paths
    const allVideoPaths: string[] = [];
    recordings.forEach((rec: any) => {
      if (rec.videos && rec.videos.length > 0) {
        allVideoPaths.push(...rec.videos);
      }
    });

    if (allVideoPaths.length === 0) {
      logger.log('📹 No videos found to scan');
      return;
    }

    logger.log(`📹 Found ${allVideoPaths.length} videos total`);

    // Load existing cache
    const videoMetadataCache = loadJSON('data/video-metadata-cache.json') || {};

    // Check which videos need processing
    const videosToProcess: string[] = [];
    const cachedVideos: string[] = [];

    for (const videoPath of allVideoPaths) {
      const fileHash = await getFileHash(videoPath);

      // Skip files that don't exist (fileHash will be null)
      if (!fileHash) {
        logger.log(`⚠️  Skipping missing file: ${videoPath.split('/').pop()}`);
        continue;
      }

      const cachedMetadata = videoMetadataCache[videoPath];

      if (cachedMetadata && cachedMetadata.hash === fileHash) {
        cachedVideos.push(videoPath);
      } else {
        videosToProcess.push(videoPath);
      }
    }

    logger.log(`✅ ${cachedVideos.length} videos already cached`);
    logger.log(`🔄 ${videosToProcess.length} videos need processing`);

    if (videosToProcess.length === 0) {
      logger.log('✨ All videos are up to date!\n');
      return;
    }

    // Process videos sequentially
    let processed = 0;
    for (const videoPath of videosToProcess) {
      try {
        processed++;
        const filename = videoPath.split('/').pop() || '';
        logger.log(`\n📹 [${processed}/${videosToProcess.length}] Processing: ${filename}`);

        // Use the same logic as /api/video-metadata
        const analysis = await analyzeVideo(videoPath);
        const timestampData = await extractTimestampFromVideo(videoPath);
        const fileSizeBytes = getFileSize(videoPath);
        const fileSize = fileSizeBytes ? formatFileSize(fileSizeBytes) : '';

        const videoData = {
          path: videoPath,
          filename,
          isTimebolted: analysis.isTimebolted,
          detectionMethod: analysis.detectionMethod,
          recordingTime: timestampData?.timestamp || null,
          endTimestamp: timestampData?.endTimestamp || '',
          duration: timestampData?.duration || '',
          fileSize,
          fileSizeBytes
        };

        // Save to cache
        const fileHash = await getFileHash(videoPath);
        if (fileHash) {
          videoMetadataCache[videoPath] = {
            hash: fileHash,
            cachedAt: new Date().toISOString(),
            data: videoData
          };
          await Bun.write('data/video-metadata-cache.json', JSON.stringify(videoMetadataCache, null, 2));
        }

        logger.log(`✅ Processed: ${filename}`);
      } catch (error) {
        logger.error(`❌ Failed to process ${videoPath}:`, error);
      }
    }

    logger.log(`\n✨ Background scanning complete! Processed ${processed}/${videosToProcess.length} videos`);

    // Clean up stale cache entries (files that no longer exist)
    const validPaths = new Set(allVideoPaths);
    const cachedPaths = Object.keys(videoMetadataCache);
    const stalePaths = cachedPaths.filter(path => !validPaths.has(path));

    if (stalePaths.length > 0) {
      logger.log(`🧹 Removing ${stalePaths.length} stale cache entries...`);
      for (const stalePath of stalePaths) {
        delete videoMetadataCache[stalePath];
      }
      await Bun.write('data/video-metadata-cache.json', JSON.stringify(videoMetadataCache, null, 2));
      logger.log('✅ Cache cleanup complete');
    }
    logger.log(''); // Empty line for formatting
  } catch (error) {
    logger.error('❌ Background video scanning error:', error);
  }
})();
