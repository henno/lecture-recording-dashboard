#!/usr/bin/env bun

import { readdirSync, statSync, readFileSync } from 'fs';
import { join } from 'path';

const ZOOM_DIR = '/Users/henno/Documents/Zoom';
const CHUNK_SIZE = 10485760; // 10MB - current MD5 cache size

// Recursively find all MP4 files
function findMP4Files(dir: string): string[] {
  const files: string[] = [];
  const entries = readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...findMP4Files(fullPath));
    } else if (entry.isFile() && entry.name.endsWith('.mp4')) {
      files.push(fullPath);
    }
  }

  return files;
}

// Compare two files byte-by-byte and return common prefix length
async function findCommonPrefixLength(file1: string, file2: string): Promise<number> {
  const stat1 = statSync(file1);
  const stat2 = statSync(file2);

  // Read up to CHUNK_SIZE or file size (whichever is smaller)
  const readSize1 = Math.min(stat1.size, CHUNK_SIZE);
  const readSize2 = Math.min(stat2.size, CHUNK_SIZE);
  const compareSize = Math.min(readSize1, readSize2);

  if (compareSize === 0) return 0;

  // Read only the chunks we need using Bun.file and slice
  const file1Handle = Bun.file(file1);
  const file2Handle = Bun.file(file2);

  // Read chunks using slice (memory efficient)
  const data1 = new Uint8Array(await file1Handle.slice(0, compareSize).arrayBuffer());
  const data2 = new Uint8Array(await file2Handle.slice(0, compareSize).arrayBuffer());

  // Compare byte by byte
  let commonLength = 0;
  for (let i = 0; i < compareSize; i++) {
    if (data1[i] === data2[i]) {
      commonLength++;
    } else {
      break;
    }
  }

  return commonLength;
}

console.log('Finding all MP4 files...');
const files = findMP4Files(ZOOM_DIR);
console.log(`Found ${files.length} MP4 files`);
console.log(`Will perform ${(files.length * (files.length - 1)) / 2} pairwise comparisons`);
console.log('');

let maxCommonBytes = 0;
let maxPair: [string, string] = ['', ''];
let comparisonsComplete = 0;
const totalComparisons = (files.length * (files.length - 1)) / 2;

console.log('Starting analysis...');
const startTime = Date.now();

for (let i = 0; i < files.length; i++) {
  for (let j = i + 1; j < files.length; j++) {
    comparisonsComplete++;

    if (comparisonsComplete % 1000 === 0) {
      const progress = (comparisonsComplete / totalComparisons * 100).toFixed(1);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      console.log(`Progress: ${comparisonsComplete}/${totalComparisons} (${progress}%) - Elapsed: ${elapsed}s - Max so far: ${maxCommonBytes} bytes`);
    }

    const commonBytes = await findCommonPrefixLength(files[i], files[j]);

    if (commonBytes > maxCommonBytes) {
      maxCommonBytes = commonBytes;
      maxPair = [files[i], files[j]];
      console.log(`\n🔍 New maximum found: ${maxCommonBytes} bytes`);
      console.log(`   File 1: ${files[i].replace(ZOOM_DIR, '')}`);
      console.log(`   File 2: ${files[j].replace(ZOOM_DIR, '')}`);
      console.log('');
    }
  }
}

const totalTime = ((Date.now() - startTime) / 1000).toFixed(1);

console.log('\n' + '='.repeat(80));
console.log('ANALYSIS COMPLETE');
console.log('='.repeat(80));
console.log(`Total files analyzed: ${files.length}`);
console.log(`Total comparisons: ${comparisonsComplete}`);
console.log(`Time taken: ${totalTime}s`);
console.log('');
console.log(`Maximum common prefix between any two different files: ${maxCommonBytes} bytes`);
console.log(`That's ${(maxCommonBytes / 1024).toFixed(2)} KB or ${(maxCommonBytes / 1024 / 1024).toFixed(2)} MB`);
console.log('');
console.log('Files with maximum common prefix:');
console.log(`  1. ${maxPair[0].replace(ZOOM_DIR, '')}`);
console.log(`  2. ${maxPair[1].replace(ZOOM_DIR, '')}`);
console.log('');
console.log(`Current MD5 cache uses first ${CHUNK_SIZE} bytes (${CHUNK_SIZE / 1024 / 1024} MB)`);

if (maxCommonBytes < CHUNK_SIZE) {
  const safety = ((CHUNK_SIZE / maxCommonBytes) * 100).toFixed(0);
  console.log(`✅ SAFE: Cache size is ${safety}% of maximum common prefix`);
  console.log(`   All files are uniquely identifiable by their first ${CHUNK_SIZE / 1024 / 1024} MB`);
} else {
  console.log(`⚠️  WARNING: Some files share more than ${CHUNK_SIZE / 1024 / 1024} MB of common prefix`);
  console.log(`   Consider increasing MD5 cache size to at least ${(maxCommonBytes * 1.5 / 1024 / 1024).toFixed(1)} MB`);
}
