# Lecture Recording Dashboard

A web-based dashboard for managing Zoom lecture recordings and syncing them to Google Drive. Automatically detects timebolted videos, extracts recording timestamps via OCR, and provides an intuitive interface for uploading to Google Drive.

## Features

- Scans local Zoom recordings and matches with lecture schedules
- Detects timebolted videos using silence analysis
- Extracts recording timestamps from video using OCR
- Upload recordings to Google Drive with proper naming
- Track upload status and manage recordings
- Rename and delete local recordings

## Requirements

- [Bun](https://bun.sh/) runtime (v1.0+)
- [FFmpeg](https://ffmpeg.org/) (for video processing)
- [Tesseract OCR](https://github.com/tesseract-ocr/tesseract) (for timestamp extraction)
- Google Cloud project with Drive API enabled

### Install Dependencies

```bash
# Install Bun (if not installed)
curl -fsSL https://bun.sh/install | bash

# Install FFmpeg (macOS)
brew install ffmpeg

# Install Tesseract OCR (macOS)
brew install tesseract

# Install Node dependencies
bun install
```

## Google Cloud Console Setup

1. **Create a Google Cloud Project**
   - Go to [Google Cloud Console](https://console.cloud.google.com/)
   - Click "Select a project" > "New Project"
   - Enter project name and click "Create"

2. **Enable Google Drive API**
   - In your project, go to "APIs & Services" > "Library"
   - Search for "Google Drive API"
   - Click on it and press "Enable"

3. **Create OAuth 2.0 Credentials**
   - Go to "APIs & Services" > "Credentials"
   - Click "Create Credentials" > "OAuth client ID"
   - If prompted, configure the OAuth consent screen:
     - Choose "External" user type
     - Fill in app name (e.g., "Lecture Recording Dashboard")
     - Add your email as developer contact
     - Save and continue through the remaining steps
   - Back in "Create OAuth client ID":
     - Application type: "Desktop app"
     - Name: "Lecture Recording Dashboard"
     - Click "Create"
   - Download the JSON file
   - Rename it to `credentials.json` and place it in the project root

4. **Set Up Google Drive Folders**
   - Create folders in Google Drive for each student group
   - Get folder IDs from URL (e.g., `https://drive.google.com/drive/folders/FOLDER_ID_HERE`)
   - Update folder IDs in `index.ts` (lines 919-923):
     ```typescript
     const FOLDERS: { [key: string]: string } = {
       TAK24: 'YOUR_FOLDER_ID_HERE',
       IS24: 'YOUR_FOLDER_ID_HERE',
       TAK25: 'YOUR_FOLDER_ID_HERE'
     };
     ```

## Project Setup

1. **Configure lesson times**
   - Create `times_simplified.json` with lecture schedules:
     ```json
     [
       {
         "date": "2025-10-15",
         "studentGroup": "TAK24",
         "start": "09:00",
         "end": "12:00"
       }
     ]
     ```

2. **Scan for recordings**
   ```bash
   bun run fetch-lesson-times.ts
   ```

3. **Start the server**
   ```bash
   bun run index.ts
   ```

4. **Open dashboard**
   - Navigate to `http://localhost:3000`
   - Click "Authorize Google Drive" (first time only)
   - Complete OAuth authorization in popup window

## Usage

### Initial Sync
Click "Sync with Google Drive" to fetch existing uploads from Google Drive.

### Refresh Data
Click "Refresh" to scan filesystem for new recordings and update the dashboard.

### Upload to Google Drive
1. Find the recording you want to upload
2. Click the cloud icon (☁️) next to the video
3. Confirm the upload
4. Wait for the spinner to complete

### Rename Video
1. Click the pencil icon (✏️) next to the video
2. Enter new filename (default format: `GROUP - DATE.mp4`)
3. Confirm

### Delete Video/Folder
Click the trash icon (🗑️) to delete a video or empty folder.

## File Structure

- `index.ts` - Main server and API routes
- `fetch-lesson-times.ts` - Scans filesystem for recordings
- `sync-google-drive.ts` - Syncs with Google Drive
- `public/` - Frontend files (HTML, CSS, JS)
- `credentials.json` - Google OAuth credentials (not in repo)
- `token.json` - OAuth token (auto-generated)
- `lecture_recordings.json` - Local recordings data
- `drive-files.json` - Google Drive files cache
- `times_simplified.json` - Lecture schedules

## Troubleshooting

**"Google Drive not configured" error**
- Ensure `credentials.json` exists in project root
- Run authorization flow via dashboard

**Upload shows 100% immediately**
- This is expected - the spinner shows upload is in progress
- Actual upload happens server-side and may take several minutes

**Timestamp extraction fails**
- Ensure Tesseract OCR is installed (`brew install tesseract`)
- Check `debug_frames/` folder for OCR debug images

**Videos not detected**
- Run `bun run fetch-lesson-times.ts` to rescan filesystem
- Check that videos are in `/Users/henno/Documents/Zoom/` subdirectories

## Port Configuration

Server runs on port 3000 by default. To change:
```typescript
// index.ts, line 11
const PORT = 3000; // Change to your preferred port
```

## License

Private project - not for redistribution.
