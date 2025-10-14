let recordings = [];
let driveFiles = {};
let filters = {
    missing: true,
    notUploaded: true,
    uploaded: true,
    group: ''
};

// Load data from API
async function loadData(forceRefresh = false) {
    const startTime = performance.now();
    console.log('🔄 Starting data load...');

    document.getElementById('loading').classList.remove('hidden');

    try {
        const fetchStart = performance.now();
        const url = forceRefresh ? '/api/status?refresh=true' : '/api/status';
        const response = await fetch(url);
        const fetchEnd = performance.now();
        console.log(`⏱️  API fetch time: ${(fetchEnd - fetchStart).toFixed(0)}ms`);

        const parseStart = performance.now();
        const data = await response.json();
        const parseEnd = performance.now();
        console.log(`⏱️  JSON parse time: ${(parseEnd - parseStart).toFixed(0)}ms`);

        recordings = data.recordings;
        driveFiles = data.driveFiles || {};

        const renderStart = performance.now();
        renderRecordings();
        const renderEnd = performance.now();
        console.log(`⏱️  Render time: ${(renderEnd - renderStart).toFixed(0)}ms`);

        updateSummary();

        const totalTime = performance.now() - startTime;
        console.log(`✅ Total page load time: ${(totalTime / 1000).toFixed(2)}s\n`);
    } catch (error) {
        console.error('Error loading data:', error);
        alert('Failed to load data');
    } finally {
        document.getElementById('loading').classList.add('hidden');
    }
}

// Render recordings
function renderRecordings() {
    const tbody = document.getElementById('recordingsBody');
    tbody.innerHTML = '';

    // Filter recordings
    const filteredRecordings = recordings.filter(rec => {
        const isMissing = rec.folder === 'MISSING!';
        const isUploaded = rec.uploaded === true;
        const isNotUploaded = !isMissing && !isUploaded;

        if (isMissing && !filters.missing) return false;
        if (isNotUploaded && !filters.notUploaded) return false;
        if (isUploaded && !filters.uploaded) return false;
        if (filters.group && rec.studentGroup !== filters.group) return false;

        return true;
    });

    // Sort: purely chronological by date
    filteredRecordings.sort((a, b) => {
        return a.date.localeCompare(b.date); // Chronological (oldest first)
    });

    // Group by date, then by group
    const groupedByDate = {};
    filteredRecordings.forEach(rec => {
        if (!groupedByDate[rec.date]) {
            groupedByDate[rec.date] = {};
        }
        if (!groupedByDate[rec.date][rec.studentGroup]) {
            groupedByDate[rec.date][rec.studentGroup] = [];
        }
        groupedByDate[rec.date][rec.studentGroup].push(rec);
    });

    // Render each date with group rows
    Object.keys(groupedByDate).sort().forEach(date => {
        const groupsOnDate = groupedByDate[date];
        const groupNames = Object.keys(groupsOnDate).sort();
        const rowspan = groupNames.length;

        groupNames.forEach((groupName, groupIndex) => {
            const groupRecordings = groupsOnDate[groupName];
            const row = createGroupRecordingRow(groupRecordings, date, groupIndex === 0, rowspan);
            tbody.appendChild(row);
        });
    });
}

// Create group recording row (one row per group, date cell spans multiple rows if needed)
function createGroupRecordingRow(groupRecordings, date, isFirstGroup, rowspan) {
    const tr = document.createElement('tr');

    // Use first recording for common fields
    const firstRec = groupRecordings[0];
    const studentGroup = firstRec.studentGroup;

    // Determine overall status for this group
    const hasUploadedVideo = groupRecordings.some(r => r.uploaded === true);
    const hasLocalFolder = groupRecordings.some(r => r.folder !== 'MISSING!');
    const allUploaded = groupRecordings.every(r => r.uploaded === true);
    const isMissing = !hasUploadedVideo && !hasLocalFolder;
    const isUploaded = allUploaded;

    let statusClass = isMissing ? 'missing' : (isUploaded ? 'uploaded' : 'not-uploaded');
    tr.className = statusClass;

    // Time range - find a recording with valid times (some recordings might not have times)
    let timeRange = '-';
    const recWithTimes = groupRecordings.find(r => r.lessonStart && r.lessonEnd);
    if (recWithTimes) {
        // Use lessonTimeRange if available (handles multiple time ranges with commas)
        timeRange = recWithTimes.lessonTimeRange || `${recWithTimes.lessonStart} - ${recWithTimes.lessonEnd}`;
    }

    // Status badge
    let statusBadge = '';
    if (isMissing) {
        statusBadge = '<span class="badge missing">⚠️ MISSING</span>';
    } else if (isUploaded) {
        statusBadge = '<span class="badge uploaded">☁️ UPLOADED</span>';
    } else {
        statusBadge = '<span class="badge" style="background:#ff9500;color:white;">📁 Local</span>';
    }

    // Collect all GDrive videos (deduplicated by file ID)
    let gdriveVideosHTML = '';
    const gdriveVideos = [];
    const addedDriveFiles = new Set(); // Track added files by ID to avoid duplicates

    groupRecordings.forEach(rec => {
        if (rec.uploaded) {
            const driveKey = `${rec.studentGroup}:${rec.date}`;
            const driveFile = driveFiles[driveKey];

            if (driveFile?.name && driveFile?.url && driveFile?.id) {
                // Skip if already added
                if (addedDriveFiles.has(driveFile.id)) {
                    return;
                }
                addedDriveFiles.add(driveFile.id);

                // Check if any local video file size matches the Drive file size
                let hasMatchingLocalSize = false;
                groupRecordings.forEach(r => {
                    if (r.videosWithStatus && r.videosWithStatus.length > 0) {
                        hasMatchingLocalSize = hasMatchingLocalSize || r.videosWithStatus.some(video => {
                            if (!video.fileSizeBytes) return false;
                            const diff = Math.abs(driveFile.size - video.fileSizeBytes);
                            const tolerance = driveFile.size * 0.01; // 1% tolerance
                            return diff <= tolerance;
                        });
                    }
                });

                let fileSizeText = '';
                if (driveFile?.size) {
                    const sizeInGB = driveFile.size / (1024 * 1024 * 1024);
                    fileSizeText = sizeInGB >= 1
                        ? `${Math.round(sizeInGB)} GB`
                        : `${Math.round(driveFile.size / (1024 * 1024))} MB`;
                }

                const highlightStyle = hasMatchingLocalSize ? 'background:yellow;color:black;font-weight:bold;' : '';

                gdriveVideos.push({
                    name: driveFile.name,
                    url: driveFile.url,
                    size: fileSizeText,
                    highlight: highlightStyle
                });
            }
        }
    });

    if (gdriveVideos.length > 0) {
        gdriveVideosHTML = '<div class="video-list">';
        gdriveVideos.forEach(video => {
            gdriveVideosHTML += `
                <div class="video-item">
                    <div class="input-group">
                        <span class="input-group-text">📁 ${studentGroup}</span>
                        <input type="text" readonly class="form-control" value="☁️ ${video.name}" onclick="window.open('${video.url.replace(/'/g, "\\'")}', '_blank')" title="Click to open in Google Drive">
                        <span class="input-group-text" style="${video.highlight}">${video.size}</span>
                    </div>
                </div>
            `;
        });
        gdriveVideosHTML += '</div>';
    } else if (isMissing) {
        gdriveVideosHTML = '-';
    } else {
        gdriveVideosHTML = '-';
    }

    // Collect all local videos
    let localVideosHTML = '';
    const localVideos = [];
    let hasAnyVideos = false;
    const emptyFolders = [];

    groupRecordings.forEach(rec => {
        if (rec.folder === 'MISSING!') {
            // Don't show anything for missing folders in merged view
            return;
        }

        if (rec.videosWithStatus && rec.videosWithStatus.length > 0) {
            hasAnyVideos = true;
            rec.videosWithStatus.forEach(video => {
                // Get drive file size for comparison
                const driveKey = `${rec.studentGroup}:${rec.date}`;
                const driveFile = driveFiles[driveKey];
                let isMatchingSize = false;

                if (driveFile?.size && video.fileSizeBytes) {
                    const diff = Math.abs(driveFile.size - video.fileSizeBytes);
                    const tolerance = driveFile.size * 0.01;
                    isMatchingSize = diff <= tolerance;
                }

                localVideos.push({
                    path: video.path,
                    filename: video.filename,
                    recordingTime: video.recordingTime,
                    duration: video.duration,
                    fileSize: video.fileSize,
                    fileSizeBytes: video.fileSizeBytes,
                    isTimebolted: video.isTimebolted,
                    detectionMethod: video.detectionMethod,
                    isMatchingSize: isMatchingSize,
                    studentGroup: rec.studentGroup,
                    date: rec.date,
                    folder: rec.folder
                });
            });
        } else {
            emptyFolders.push(rec.folder);
        }
    });

    if (isMissing) {
        localVideosHTML = '<em style="color:#999;">No recording found</em>';
    } else if (localVideos.length > 0) {
        localVideosHTML = '<div class="video-list">';
        localVideos.forEach(video => {
            const timeboltBadge = video.isTimebolted ?
                '<span class="badge timebolted">🎬 Timebolted</span>' : '';

            let leftAddon = '';
            if (video.recordingTime) {
                leftAddon = video.recordingTime;
                if (video.duration) {
                    leftAddon += ` (${video.duration})`;
                }
            }

            const highlightStyle = video.isMatchingSize ? 'background:yellow;color:black;font-weight:bold;' : '';

            const pathParts = video.path.split('/');
            const folderName = pathParts[pathParts.length - 2] || '';
            const tooltip = `${folderName}\n${video.filename}\nRecording Time: ${video.recordingTime || 'Unknown'}\nFile Size: ${video.fileSize || 'Unknown'}\nTimebolted: ${video.isTimebolted ? 'Yes' : 'No'}\nMethod: ${video.detectionMethod || 'unknown'}`;

            const filenameWithBadge = video.isTimebolted ? `🎬 ${video.filename}` : `📁 ${video.filename}`;

            localVideosHTML += `
                <div class="video-item">
                    <div class="input-group">
                        ${leftAddon ? `<span class="input-group-text">🕐 ${leftAddon}</span>` : ''}
                        <input type="text" readonly class="form-control" value="${filenameWithBadge}" onclick="openInFinder('${video.path.replace(/'/g, "\\'")}')" title="${tooltip}">
                        <span class="input-group-text" style="${highlightStyle}">${video.fileSize}</span>
                    </div>
                    <div class="action-buttons">
                        <button class="btn-action btn-rename" onclick="renameVideo('${video.path.replace(/'/g, "\\'")}', '${video.studentGroup}', '${video.date}')">✏️</button>
                        <button class="btn-action btn-upload ${activeUploads.has(video.path) ? 'btn-uploading' : ''}" onclick="uploadVideo('${video.path.replace(/'/g, "\\'")}', '${video.studentGroup}', '${video.date}')">${activeUploads.has(video.path) ? '' : '☁️'}</button>
                        <button class="btn-action btn-delete" onclick="deleteVideo('${video.path.replace(/'/g, "\\'")}')">🗑️</button>
                    </div>
                </div>
            `;
        });

        // Add empty folders at the end
        emptyFolders.forEach(folder => {
            const folderPath = `/Users/henno/Documents/Zoom/${folder}`;
            localVideosHTML += `
                <div style="display:flex;align-items:center;gap:0.3rem;margin-top:0.5rem;">
                    <em style="color:#0071e3;cursor:pointer;flex:1;" title="${folder}" onclick="openInFinder('${folderPath.replace(/'/g, "\\'")}')">📁 No videos (${folder})</em>
                    <button class="btn-action btn-delete" onclick="deleteFolder('${folderPath.replace(/'/g, "\\'")}')">🗑️</button>
                </div>
            `;
        });

        localVideosHTML += '</div>';
    } else if (emptyFolders.length > 0) {
        // Only empty folders
        localVideosHTML = '<div class="video-list">';
        emptyFolders.forEach(folder => {
            const folderPath = `/Users/henno/Documents/Zoom/${folder}`;
            localVideosHTML += `
                <div style="display:flex;align-items:center;gap:0.3rem;">
                    <em style="color:#0071e3;cursor:pointer;flex:1;" title="${folder}" onclick="openInFinder('${folderPath.replace(/'/g, "\\'")}')">📁 No videos (${folder})</em>
                    <button class="btn-action btn-delete" onclick="deleteFolder('${folderPath.replace(/'/g, "\\'")}')">🗑️</button>
                </div>
            `;
        });
        localVideosHTML += '</div>';
    } else {
        localVideosHTML = '-';
    }

    // Build row HTML - only include date and local videos cells for first group
    let rowHTML = '';

    if (isFirstGroup) {
        rowHTML += `<td style="white-space:nowrap;" rowspan="${rowspan}">${date}</td>`;
        rowHTML += `<td style="max-width:600px;" rowspan="${rowspan}">${localVideosHTML}</td>`;
    }

    rowHTML += `
        <td><span class="badge group">${studentGroup}</span></td>
        <td style="white-space:nowrap;font-size:0.75rem;">${timeRange}</td>
        <td style="display:none;">${statusBadge}</td>
        <td style="max-width:300px;">${gdriveVideosHTML}</td>
    `;

    tr.innerHTML = rowHTML;

    return tr;
}

// Create recording row
function createRecordingRow(rec, isEvenDate) {
    const tr = document.createElement('tr');
    const isMissing = rec.folder === 'MISSING!';
    const isUploaded = rec.uploaded === true;

    let statusClass = isMissing ? 'missing' : (isUploaded ? 'uploaded' : 'not-uploaded');
    tr.className = statusClass;

    // Status badge
    let statusBadge = '';
    if (isMissing) {
        statusBadge = '<span class="badge missing">⚠️ MISSING</span>';
    } else if (isUploaded) {
        // Look up Drive URL and filename using "group:date" key
        const driveKey = `${rec.studentGroup}:${rec.date}`;
        const driveFile = driveFiles[driveKey];

        // Check if any local video file size matches the Drive file size (within 1% tolerance)
        let hasMatchingLocalSize = false;
        if (driveFile?.size && rec.videosWithStatus && rec.videosWithStatus.length > 0) {
            hasMatchingLocalSize = rec.videosWithStatus.some(video => {
                if (!video.fileSizeBytes) return false;
                const diff = Math.abs(driveFile.size - video.fileSizeBytes);
                const tolerance = driveFile.size * 0.01; // 1% tolerance
                return diff <= tolerance;
            });
        }

        // Simple status badge - just "UPLOADED"
        statusBadge = '<span class="badge uploaded">☁️ UPLOADED</span>';

        // Store matching info for later use in video rendering
        rec._hasMatchingLocalSize = hasMatchingLocalSize;
        rec._driveFileSize = driveFile?.size;
    } else {
        statusBadge = '<span class="badge" style="background:#ff9500;color:white;">📁 Local</span>';
    }

    // GDrive Videos section
    let gdriveVideosHTML = '';
    if (isMissing) {
        gdriveVideosHTML = '-';
    } else if (isUploaded) {
        const driveKey = `${rec.studentGroup}:${rec.date}`;
        const driveFile = driveFiles[driveKey];
        const driveUrl = driveFile?.url || '';
        const uploadedFilename = driveFile?.name || '';

        // Format file size for Drive file with yellow highlight if matching
        let uploadedFileSize = '';
        if (driveFile?.size) {
            const sizeInGB = driveFile.size / (1024 * 1024 * 1024);
            const sizeText = sizeInGB >= 1
                ? `${Math.round(sizeInGB)} GB`
                : `${Math.round(driveFile.size / (1024 * 1024))} MB`;
            uploadedFileSize = rec._hasMatchingLocalSize ?
                `<span class="badge" style="background:yellow;color:black;font-size:0.7rem;font-weight:bold;">💾 ${sizeText}</span>` :
                `<span class="badge" style="background:#999;color:white;font-size:0.7rem;">💾 ${sizeText}</span>`;
        }

        if (uploadedFilename && driveUrl) {
            // Format file size text without badge
            let fileSizeText = '';
            if (driveFile?.size) {
                const sizeInGB = driveFile.size / (1024 * 1024 * 1024);
                fileSizeText = sizeInGB >= 1
                    ? `${Math.round(sizeInGB)} GB`
                    : `${Math.round(driveFile.size / (1024 * 1024))} MB`;
            }

            const highlightStyle = rec._hasMatchingLocalSize ? 'background:yellow;color:black;font-weight:bold;' : '';

            gdriveVideosHTML = `
                <div class="video-item">
                    <div class="input-group">
                        <input type="text" readonly class="form-control" value="☁️ ${uploadedFilename}" onclick="window.open('${driveUrl.replace(/'/g, "\\'")}', '_blank')" title="Click to open in Google Drive">
                        <span class="input-group-text" style="${highlightStyle}">${fileSizeText}</span>
                    </div>
                </div>
            `;
        } else {
            gdriveVideosHTML = '<em style="color:#999;">Uploaded (no details)</em>';
        }
    } else {
        gdriveVideosHTML = '-';
    }

    // Local Videos section
    let localVideosHTML = '';
    if (isMissing) {
        localVideosHTML = '<em style="color:#999;">No recording found</em>';
    } else if (rec.videosWithStatus && rec.videosWithStatus.length > 0) {
        localVideosHTML = '<div class="video-list">';
        rec.videosWithStatus.forEach(video => {
            // Debug logging
            if (video.isTimebolted) {
                console.log('Timebolted video detected:', video.filename, video);
            }

            const timeboltBadge = video.isTimebolted ?
                '<span class="badge timebolted">🎬 Timebolted</span>' : '';

            // Recording time with duration for left addon
            let leftAddon = '';
            if (video.recordingTime) {
                leftAddon = video.recordingTime;
                if (video.duration) {
                    leftAddon += ` (${video.duration})`;
                }
            }

            // File size for right addon - highlight in yellow if matches Drive
            let fileSizeText = video.fileSize || '';
            let isMatchingSize = false;
            if (rec._hasMatchingLocalSize && rec._driveFileSize && video.fileSizeBytes) {
                const diff = Math.abs(rec._driveFileSize - video.fileSizeBytes);
                const tolerance = rec._driveFileSize * 0.01; // 1% tolerance
                isMatchingSize = diff <= tolerance;
            }
            const highlightStyle = isMatchingSize ? 'background:yellow;color:black;font-weight:bold;' : '';

            // Extract folder name from path
            const pathParts = video.path.split('/');
            const folderName = pathParts[pathParts.length - 2] || '';
            const tooltip = `${folderName}\n${video.filename}\nRecording Time: ${video.recordingTime || 'Unknown'}\nFile Size: ${video.fileSize || 'Unknown'}\nTimebolted: ${video.isTimebolted ? 'Yes' : 'No'}\nMethod: ${video.detectionMethod || 'unknown'}`;

            // Build filename with timebolt badge
            const filenameWithBadge = video.isTimebolted ? `🎬 ${video.filename}` : `📁 ${video.filename}`;

            localVideosHTML += `
                <div class="video-item">
                    <div class="input-group">
                        ${leftAddon ? `<span class="input-group-text">🕐 ${leftAddon}</span>` : ''}
                        <input type="text" readonly class="form-control" value="${filenameWithBadge}" onclick="openInFinder('${video.path.replace(/'/g, "\\'")}')" title="${tooltip}">
                        <span class="input-group-text" style="${highlightStyle}">${fileSizeText}</span>
                    </div>
                    <div class="action-buttons">
                        <button class="btn-action btn-rename" onclick="renameVideo('${video.path.replace(/'/g, "\\'")}', '${rec.studentGroup}', '${rec.date}')">✏️</button>
                        <button class="btn-action btn-upload ${activeUploads.has(video.path) ? 'btn-uploading' : ''}" onclick="uploadVideo('${video.path.replace(/'/g, "\\'")}', '${rec.studentGroup}', '${rec.date}')">${activeUploads.has(video.path) ? '' : '☁️'}</button>
                        <button class="btn-action btn-delete" onclick="deleteVideo('${video.path.replace(/'/g, "\\'")}')">🗑️</button>
                    </div>
                </div>
            `;
        });
        localVideosHTML += '</div>';
    } else {
        const folderPath = `/Users/henno/Documents/Zoom/${rec.folder}`;
        localVideosHTML = `
            <div style="display:flex;align-items:center;gap:0.3rem;">
                <em style="color:#0071e3;cursor:pointer;flex:1;" title="${rec.folder}" onclick="openInFinder('${folderPath.replace(/'/g, "\\'")}')">📁 No videos (${rec.folder})</em>
                <button class="btn-action btn-delete" onclick="deleteFolder('${folderPath.replace(/'/g, "\\'")}')">🗑️</button>
            </div>
        `;
    }

    // Time range
    const timeRange = rec.lessonStart && rec.lessonEnd
        ? (rec.lessonTimeRange || `${rec.lessonStart} - ${rec.lessonEnd}`)
        : '-';

    tr.innerHTML = `
        <td style="white-space:nowrap;">${rec.date}</td>
        <td style="white-space:nowrap;font-size:0.75rem;">${timeRange}</td>
        <td><span class="badge group">${rec.studentGroup}</span></td>
        <td>${statusBadge}</td>
        <td style="max-width:300px;">${gdriveVideosHTML}</td>
        <td style="max-width:600px;">${localVideosHTML}</td>
    `;

    return tr;
}

// Update summary counts
function updateSummary() {
    // Group by date (same as display logic)
    const groupedByDate = {};
    recordings.forEach(rec => {
        if (!groupedByDate[rec.date]) {
            groupedByDate[rec.date] = [];
        }
        groupedByDate[rec.date].push(rec);
    });

    // Count statuses for each date group
    let missing = 0;
    let notUploaded = 0;
    let uploaded = 0;

    Object.values(groupedByDate).forEach(dateRecordings => {
        // Use same logic as createMergedRecordingRow
        const hasUploadedVideo = dateRecordings.some(r => r.uploaded === true);
        const hasLocalFolder = dateRecordings.some(r => r.folder !== 'MISSING!');
        const allUploaded = dateRecordings.every(r => r.uploaded === true);
        const isMissing = !hasUploadedVideo && !hasLocalFolder;
        const isUploaded = allUploaded;

        if (isMissing) {
            missing++;
        } else if (isUploaded) {
            uploaded++;
        } else {
            notUploaded++;
        }
    });

    document.getElementById('count-missing').textContent = missing;
    document.getElementById('count-not-uploaded').textContent = notUploaded;
    document.getElementById('count-uploaded').textContent = uploaded;
}

// Open in Finder
async function openInFinder(videoPath) {
    try {
        const response = await fetch('/api/open-folder', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ folderPath: videoPath })
        });

        const result = await response.json();

        if (!result.success) {
            alert('Failed to open Finder: ' + result.error);
        }
    } catch (error) {
        console.error('Error opening Finder:', error);
        alert('Failed to open Finder');
    }
}

// Track active uploads
const activeUploads = new Map();

// Upload video to Google Drive
async function uploadVideo(videoPath, studentGroup, date) {
    // Check if already uploading
    if (activeUploads.has(videoPath)) {
        // Cancel upload
        if (!confirm('Cancel upload?')) {
            return;
        }
        const xhr = activeUploads.get(videoPath);
        xhr.abort();
        activeUploads.delete(videoPath);
        uploadProgress.delete(videoPath);
        renderRecordings();
        return;
    }

    const filename = videoPath.split('/').pop();

    if (!confirm(`Upload ${filename} to Google Drive?`)) {
        return;
    }

    // Use XMLHttpRequest for upload progress tracking
    const xhr = new XMLHttpRequest();
    activeUploads.set(videoPath, xhr);
    uploadProgress.set(videoPath, 0);

    // Re-render to show progress indicator
    renderRecordings();

    // Note: Progress events only track browser→server upload (the JSON request),
    // not the actual file upload to Google Drive which happens server-side

    // Handle completion
    xhr.addEventListener('load', () => {
        if (xhr.status === 200) {
            const result = JSON.parse(xhr.responseText);
            if (result.success) {
                activeUploads.delete(videoPath);
                uploadProgress.delete(videoPath);
                loadData();
            } else {
                alert('Failed to upload video: ' + result.error);
                activeUploads.delete(videoPath);
                uploadProgress.delete(videoPath);
                renderRecordings();
            }
        } else {
            alert('Upload failed');
            activeUploads.delete(videoPath);
            uploadProgress.delete(videoPath);
            renderRecordings();
        }
    });

    // Handle errors
    xhr.addEventListener('error', () => {
        alert('Failed to upload video');
        activeUploads.delete(videoPath);
        uploadProgress.delete(videoPath);
        renderRecordings();
    });

    // Handle abort
    xhr.addEventListener('abort', () => {
        console.log('Upload cancelled');
        activeUploads.delete(videoPath);
        uploadProgress.delete(videoPath);
        renderRecordings();
    });

    // Send request
    xhr.open('POST', '/api/upload');
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.send(JSON.stringify({
        videoPath: videoPath,
        studentGroup: studentGroup,
        date: date
    }));
}

// Rename video
async function renameVideo(videoPath, studentGroup, date) {
    const oldFilename = videoPath.split('/').pop();
    const folderPath = videoPath.substring(0, videoPath.lastIndexOf('/'));
    const extension = oldFilename.substring(oldFilename.lastIndexOf('.'));

    // Default new name: "TAK24 - 2025-10-14.mp4"
    const defaultNewName = `${studentGroup} - ${date}${extension}`;

    const newFilename = prompt(`Rename video to:`, defaultNewName);

    if (!newFilename || newFilename === oldFilename) {
        return; // User cancelled or didn't change the name
    }

    const newPath = `${folderPath}/${newFilename}`;

    // Optimistic update: rename video in UI immediately
    recordings.forEach(rec => {
        if (rec.videosWithStatus) {
            rec.videosWithStatus.forEach(v => {
                if (v.path === videoPath) {
                    v.path = newPath;
                    v.filename = newFilename;
                }
            });
        }
        if (rec.videos) {
            const index = rec.videos.indexOf(videoPath);
            if (index !== -1) {
                rec.videos[index] = newPath;
            }
        }
    });
    renderRecordings();

    // Call API in background
    try {
        const response = await fetch('/api/rename', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                oldPath: videoPath,
                newFilename: newFilename
            })
        });

        const result = await response.json();

        if (!result.success) {
            alert('Failed to rename video: ' + result.error);
            // Restore data on error
            loadData();
        }
        // If success, do nothing - the optimistic update already renamed it
    } catch (error) {
        console.error('Error renaming video:', error);
        alert('Failed to rename video');
        // Restore data on error
        loadData();
    }
}

// Delete video
async function deleteVideo(videoPath) {
    const filename = videoPath.split('/').pop();

    if (!confirm(`Are you sure you want to delete:\n${filename}?`)) {
        return;
    }

    // Optimistic update: remove video from UI immediately
    recordings.forEach(rec => {
        if (rec.videosWithStatus) {
            rec.videosWithStatus = rec.videosWithStatus.filter(v => v.path !== videoPath);
        }
        if (rec.videos) {
            rec.videos = rec.videos.filter(v => v !== videoPath);
        }
    });
    renderRecordings();

    // Call API in background
    try {
        const response = await fetch(`/api/video/${encodeURIComponent(videoPath)}`, {
            method: 'DELETE'
        });

        const result = await response.json();

        if (!result.success) {
            alert('Failed to delete video: ' + result.error);
            // Restore data on error
            loadData();
        }
        // If success, do nothing - the optimistic update already removed it
    } catch (error) {
        console.error('Error deleting video:', error);
        alert('Failed to delete video');
        // Restore data on error
        loadData();
    }
}

// Delete folder
async function deleteFolder(folderPath) {
    const folderName = folderPath.split('/').pop();

    if (!confirm(`Are you sure you want to delete the entire folder:\n${folderName}?`)) {
        return;
    }

    // Optimistic update: remove folder from UI immediately
    recordings.forEach(rec => {
        if (rec.folder === folderName) {
            rec.folder = 'DELETED';
            rec.videos = [];
            rec.videosWithStatus = [];
        }
    });
    renderRecordings();

    // Call API in background
    try {
        const response = await fetch(`/api/folder/${encodeURIComponent(folderPath)}`, {
            method: 'DELETE'
        });

        const result = await response.json();

        if (!result.success) {
            alert('Failed to delete folder: ' + result.error);
            // Restore data on error
            loadData();
        } else {
            // Reload to update the data properly
            loadData();
        }
    } catch (error) {
        console.error('Error deleting folder:', error);
        alert('Failed to delete folder');
        // Restore data on error
        loadData();
    }
}

// Sync with Google Drive
async function syncWithDrive() {
    const btn = document.getElementById('syncBtn');
    btn.disabled = true;
    btn.textContent = '⏳ Syncing...';

    try {
        const response = await fetch('/api/sync', { method: 'POST' });
        const result = await response.json();

        if (result.success) {
            loadData(); // Reload data
        } else {
            alert('Sync failed: ' + result.error);
        }
    } catch (error) {
        console.error('Error syncing:', error);
        alert('Sync failed');
    } finally {
        btn.disabled = false;
        btn.textContent = '🔄 Sync with Google Drive';
    }
}

// Refresh button: scan filesystem then reload data
async function refreshData() {
    const btn = document.getElementById('refreshBtn');
    btn.disabled = true;
    btn.textContent = '⏳ Scanning...';

    try {
        // First, scan filesystem for new files
        const response = await fetch('/api/scan', { method: 'POST' });
        const result = await response.json();

        if (!result.success) {
            alert('Failed to scan filesystem: ' + result.error);
            return;
        }

        // Then reload data with force refresh
        await loadData(true);
    } catch (error) {
        console.error('Error refreshing:', error);
        alert('Failed to refresh');
    } finally {
        btn.disabled = false;
        btn.textContent = '↻ Refresh';
    }
}

// Check Google Drive authentication status
async function checkAuthStatus() {
    try {
        const response = await fetch('/api/auth/status');
        const result = await response.json();

        const authBtn = document.getElementById('authBtn');
        const syncBtn = document.getElementById('syncBtn');

        if (!result.authenticated) {
            authBtn.style.display = 'inline-block';
            syncBtn.disabled = true;
            syncBtn.title = 'Please authorize Google Drive first';
        } else {
            authBtn.style.display = 'none';
            syncBtn.disabled = false;
            syncBtn.title = '';
        }
    } catch (error) {
        console.error('Error checking auth status:', error);
    }
}

// Authorize Google Drive
async function authorizeGoogleDrive() {
    try {
        const response = await fetch('/api/auth/google');
        const result = await response.json();

        if (result.authUrl) {
            // Open auth URL in a popup window
            const width = 600;
            const height = 700;
            const left = (screen.width - width) / 2;
            const top = (screen.height - height) / 2;

            const popup = window.open(
                result.authUrl,
                'Google Authorization',
                `width=${width},height=${height},left=${left},top=${top}`
            );

            // Poll to check if authorization is complete
            const pollInterval = setInterval(async () => {
                try {
                    if (popup.closed) {
                        clearInterval(pollInterval);
                        // Check auth status again
                        await checkAuthStatus();
                    }
                } catch (e) {
                    // Ignore cross-origin errors
                }
            }, 500);
        }
    } catch (error) {
        console.error('Error authorizing:', error);
        alert('Failed to start authorization');
    }
}

// Event listeners
document.getElementById('authBtn').addEventListener('click', authorizeGoogleDrive);
document.getElementById('syncBtn').addEventListener('click', syncWithDrive);
document.getElementById('refreshBtn').addEventListener('click', refreshData);

document.getElementById('filter-missing').addEventListener('change', (e) => {
    filters.missing = e.target.checked;
    renderRecordings();
});

document.getElementById('filter-not-uploaded').addEventListener('change', (e) => {
    filters.notUploaded = e.target.checked;
    renderRecordings();
});

document.getElementById('filter-uploaded').addEventListener('change', (e) => {
    filters.uploaded = e.target.checked;
    renderRecordings();
});

document.getElementById('filter-group').addEventListener('change', (e) => {
    filters.group = e.target.value;
    renderRecordings();
});

// Initial load
checkAuthStatus();
loadData();
