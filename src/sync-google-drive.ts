#!/usr/bin/env bun

import { google } from 'googleapis';
import { readFileSync, writeFileSync, existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const SCOPES = ['https://www.googleapis.com/auth/drive'];
const TOKEN_PATH = 'config/token.json';
const CREDENTIALS_PATH = 'config/credentials.json';
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
 * Load or request authorization to call APIs.
 */
async function authorize() {
  if (!existsSync(CREDENTIALS_PATH)) {
    throw new Error(
      `Missing credentials.json file.\n\n` +
      `Please follow the setup instructions in README.md:\n` +
      `1. Create a Google Cloud project\n` +
      `2. Enable Google Drive API\n` +
      `3. Create OAuth 2.0 credentials\n` +
      `4. Download credentials.json to project root`
    );
  }

  const credentials = JSON.parse(readFileSync(CREDENTIALS_PATH, 'utf-8'));
  const { client_secret, client_id, redirect_uris } = credentials.installed;
  const oAuth2Client = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

  // Check if we have previously stored a token.
  if (existsSync(TOKEN_PATH)) {
    const token = JSON.parse(readFileSync(TOKEN_PATH, 'utf-8'));
    oAuth2Client.setCredentials(token);
    return oAuth2Client;
  }

  // Generate auth URL and get token
  const authUrl = oAuth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
  });

  console.log('🔐 Authorize this app by visiting this url:\n');
  console.log(authUrl);
  console.log('\n📋 After authorization, paste the code here:');

  // Read code from stdin
  const code = await new Promise<string>((resolve) => {
    process.stdin.once('data', (data) => {
      resolve(data.toString().trim());
    });
  });

  const { tokens } = await oAuth2Client.getToken(code);
  oAuth2Client.setCredentials(tokens);

  // Store the token to disk for later program executions
  writeFileSync(TOKEN_PATH, JSON.stringify(tokens));
  console.log('✅ Token stored to', TOKEN_PATH);

  return oAuth2Client;
}

/**
 * List files in a Google Drive folder
 */
async function listFilesInFolder(auth: any, folderId: string) {
  const drive = google.drive({ version: 'v3', auth });

  const res = await drive.files.list({
    q: `'${folderId}' in parents and trashed=false`,
    fields: 'files(id, name, mimeType, size)',
    pageSize: 1000,
  });

  return res.data.files || [];
}

/**
 * Extract date from filename (format: YYYY-MM-DD)
 */
function extractDateFromFilename(filename: string): string | null {
  const match = filename.match(/(\d{4}-\d{2}-\d{2})/);
  return match ? match[1] : null;
}

/**
 * Main function
 */
async function main() {
  try {
    console.log('🚀 Syncing with Google Drive...\n');

    const auth = await authorize();
    const FOLDERS = loadStudyGroups();
    const uploadedDates: { [key: string]: string[] } = {};
    const driveFiles: { [key: string]: Array<{ id: string, name: string, url: string, size: number }> } = {};

    for (const [group, folderId] of Object.entries(FOLDERS)) {
      console.log(`\n📂 Checking ${group} folder...`);

      const files = await listFilesInFolder(auth, folderId);
      const dates = new Set<string>();

      files.forEach((file) => {
        const date = extractDateFromFilename(file.name || '');
        if (date && file.id) {
          dates.add(date);
          // Store file info with Drive URL (key: "group:date", value: array of files)
          const key = `${group}:${date}`;
          if (!driveFiles[key]) {
            driveFiles[key] = [];
          }
          driveFiles[key].push({
            id: file.id,
            name: file.name || '',
            url: `https://drive.google.com/file/d/${file.id}/view`,
            size: file.size ? parseInt(file.size) : 0
          });
          console.log(`  ✓ Found: ${file.name} (${date})`);
        }
      });

      uploadedDates[group] = Array.from(dates).sort();
      console.log(`  📊 Total uploaded dates for ${group}: ${dates.size}`);
    }

    // Write to uploaded-dates.json
    writeFileSync('data/uploaded-dates.json', JSON.stringify(uploadedDates, null, 2));
    console.log('\n✅ Updated uploaded-dates.json');

    // Write drive file URLs to drive-files.json
    writeFileSync('data/drive-files.json', JSON.stringify(driveFiles, null, 2));
    console.log('✅ Updated drive-files.json');

    // Run the main fetch script to update lecture_recordings.json
    console.log('\n🔄 Updating lecture recordings status...');
    const { spawn } = await import('child_process');
    const child = spawn('bun', ['run', 'fetch'], {
      stdio: 'inherit'
    });

    await new Promise((resolve, reject) => {
      child.on('close', (code) => {
        if (code === 0) resolve(null);
        else reject(new Error(`Process exited with code ${code}`));
      });
    });

    console.log('\n✅ Sync complete!');

  } catch (error) {
    console.error('❌ Error:', error);
    process.exit(1);
  }
}

main();
