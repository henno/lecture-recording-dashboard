# Lecture Recording Dashboard

A web-based dashboard for managing Zoom lecture recordings and syncing them to Google Drive. Automatically detects timebolted videos, extracts recording timestamps via OCR, and provides an intuitive interface for uploading to Google Drive.

## Features

- Scans local Zoom recordings and matches with lecture schedules
- Detects timebolted videos using silence analysis
- Extracts start and end timestamps from videos using OCR
- Displays time ranges (e.g., "10:07-14:05 (3h)") for easy identification
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
   - Rename it to `credentials.json` and place it in the `config/` directory

4. **Configure Study Groups**
   - Create folders in Google Drive for each student group
   - Get folder IDs from URL (e.g., `https://drive.google.com/drive/folders/FOLDER_ID_HERE`)
   - Copy the example configuration:
     ```bash
     cp config/study-groups.json.example config/study-groups.json
     ```
   - Edit `config/study-groups.json` with your folder IDs:
     ```json
     {
       "TAK24": "1IaLQwslFddy8KhxPUtg67o34pEPETrai",
       "TAK25": "1njVYojvTuVVkNIpsZP0k3Cz_YHUhdHwg",
       "IS24": "1xDunwzOWa1B6xbMQYZRlSuS2Yai_uyAp"
     }
     ```

## Project Setup

1. **Fetch lesson times and scan recordings**
   ```bash
   bun run fetch
   ```
   This fetches lesson schedules from the API and scans for local recordings.

2. **Start the development server**
   ```bash
   bun run dev
   ```
   Or for production:
   ```bash
   bun run start
   ```

3. **Open dashboard**
   - Navigate to `http://localhost:3000`
   - Click "Authorize Google Drive" (first time only)
   - Complete OAuth authorization in popup window

## Available Scripts

- `bun run dev` - Start development server with auto-reload
- `bun run start` - Start production server
- `bun run fetch` - Fetch lesson times and scan for recordings
- `bun run sync` - Sync with Google Drive to update upload status

## Usage

### Initial Sync
Click "Sync with Google Drive" to fetch existing uploads from Google Drive.

### Refresh Data
Click "Refresh" to scan filesystem for new recordings and update the dashboard.

### Upload to Google Drive
1. Find the recording you want to upload
2. Click the green cloud icon (☁️) next to the video
3. Confirm the upload
4. Monitor progress with the orange spinner button
5. Upload continues in background even if you close the browser
6. Can pause uploads with the orange button and resume later with blue play button

### Rename Video
1. Click the pencil icon (✏️) next to the video
2. Enter new filename (default format: `GROUP - DATE.mp4`)
3. Confirm

### Delete Video/Folder
Click the trash icon (🗑️) to delete a video or empty folder.

## File Structure

```
.
├── config/                    # Configuration files (not in repo)
│   ├── credentials.json       # Google OAuth credentials
│   ├── study-groups.json      # Study group → Drive folder ID mapping
│   ├── study-groups.json.example  # Example configuration (in repo)
│   └── token.json             # OAuth token (auto-generated)
├── data/                      # Generated data files (not in repo)
│   ├── lecture_recordings.json    # Local recordings data
│   ├── drive-files.json           # Google Drive files cache
│   ├── times_simplified.json      # Lesson schedules
│   ├── active-uploads.json        # Resume state for interrupted uploads
│   ├── video-metadata-cache.json  # Video metadata and timestamps cache
│   ├── timestamp-cache.json       # OCR timestamp extraction cache
│   └── *-cache.json               # Other performance caches
├── public/                    # Frontend assets
│   ├── index.html
│   ├── app.js
│   └── style.css
├── src/                       # Source code
│   ├── index.ts               # Main server and API routes
│   ├── fetch-lesson-times.ts # Fetches schedules and scans recordings
│   └── sync-google-drive.ts  # Syncs with Google Drive
├── package.json
└── README.md
```

## Troubleshooting

**"Google Drive not configured" error**
- Ensure `credentials.json` exists in `config/` directory
- Run authorization flow via dashboard

**Lost or deleted credentials.json file**
- Google doesn't allow re-downloading OAuth credentials for security reasons
- To regenerate:
  1. Go to [Google Cloud Console](https://console.cloud.google.com/) > "APIs & Services" > "Credentials"
  2. Click on your existing OAuth 2.0 Client ID
  3. Click "Add Secret" to generate a new client secret
  4. Download the new JSON file
  5. Save it as `credentials.json` in the `config/` directory
  6. In Google Console, disable the old secret, then delete it
  7. Re-authorize the app at `http://localhost:3000` (this will create a new `token.json` in `config/`)

**Upload shows 100% immediately**
- This is expected - the spinner shows upload is in progress
- Actual upload happens server-side and may take several minutes

**Timestamp extraction fails**
- Ensure Tesseract OCR is installed (`brew install tesseract`)
- Check `debug_frames/` folder for OCR debug images
- Timebolted videos are fully supported and should extract timestamps correctly
- If extraction fails, delete `data/video-metadata-cache.json` and `data/timestamp-cache.json` to force re-extraction

**Videos not detected**
- Run `bun run fetch` to rescan filesystem
- Check that videos are in `/Users/henno/Documents/Zoom/` subdirectories

## Port Configuration

Server runs on port 3000 by default. To change:
```typescript
// src/index.ts, line 11
const PORT = 3000; // Change to your preferred port
```

## License

Private project - not for redistribution.
