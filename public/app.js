let recordings = [];
let driveFiles = {};
let interruptedUploads = {}; // Map of videoPath -> InterruptedUpload state
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

        // Fetch interrupted uploads
        try {
            const interruptedResponse = await fetch('/api/interrupted-uploads');
            interruptedUploads = await interruptedResponse.json();
        } catch (e) {
            console.warn('Failed to load interrupted uploads:', e);
            interruptedUploads = {};
        }

        // Fetch active uploads (currently in progress on server)
        try {
            const activeResponse = await fetch('/api/active-uploads');
            const activeUploadsFromServer = await activeResponse.json();

            // Restore active uploads to frontend state
            for (const [videoPath, state] of Object.entries(activeUploadsFromServer)) {
                console.log(`🔄 Restoring active upload: ${videoPath.split('/').pop()} at ${state.percent}%`);

                // Create EventSource to receive progress updates
                const eventSource = new EventSource(`/api/upload-progress/${state.uploadId}`);

                // Store in activeUploads Map
                activeUploads.set(videoPath, {
                    xhr: null, // No XHR handle since we're reconnecting
                    eventSource: eventSource,
                    progress: {
                        percent: state.percent,
                        bytesUploaded: state.bytesUploaded,
                        bytesTotal: state.bytesTotal,
                        status: state.status
                    }
                });

                // Set up progress listener
                eventSource.onmessage = (event) => {
                    try {
                        const progress = JSON.parse(event.data);
                        const uploadState = activeUploads.get(videoPath);
                        if (uploadState) {
                            uploadState.progress = progress;
                            updateUploadButton(videoPath, progress);
                            console.log(`📊 Progress update: ${videoPath.split('/').pop()} - ${progress.percent}%`);

                            // If complete, reload page
                            if (progress.status === 'complete') {
                                eventSource.close();
                                activeUploads.delete(videoPath);
                                setTimeout(() => loadData(), 1000);
                            }

                            // If paused by user or error (network disconnect), clean up and show as interrupted
                            if (progress.status === 'paused' || progress.status === 'error') {
                                const statusMsg = progress.status === 'paused' ? '⏸️  Upload paused' : '❌ Upload error detected';
                                console.log(`${statusMsg} for ${videoPath.split('/').pop()} - will show as interrupted`);
                                eventSource.close();
                                activeUploads.delete(videoPath);
                                // Re-render to show blue play button (interrupted/paused state)
                                renderRecordings();
                            }
                        }
                    } catch (e) {
                        console.error('Error parsing progress data:', e);
                    }
                };

                eventSource.onerror = (error) => {
                    console.error('SSE connection error:', error);
                };
            }
        } catch (e) {
            console.warn('Failed to load active uploads:', e);
        }

        const renderStart = performance.now();
        populateGroupFilter();
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
        return !(filters.group && rec.studentGroup !== filters.group);


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

    tr.className = isMissing ? 'missing' : (isUploaded ? 'uploaded' : 'not-uploaded');

    // Time range - find a recording with valid times (some recordings might not have times)
    let timeRange = '-';
    const recWithTimes = groupRecordings.find(r => r.lessonStart && r.lessonEnd);
    if (recWithTimes) {
        // Use lessonTimeRange if available (handles multiple time ranges with commas)
        timeRange = recWithTimes.lessonTimeRange || `${recWithTimes.lessonStart} - ${recWithTimes.lessonEnd}`;
    }

    // Status badge
    let statusBadge
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
                        ${getUploadButtonHTML(video.path, video.studentGroup, video.date)}
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

// Populate group filter dropdown from actual data
function populateGroupFilter() {
    const filterSelect = document.getElementById('filter-group');
    const currentValue = filterSelect.value; // Preserve current selection

    // Extract unique student groups from recordings
    const uniqueGroups = [...new Set(recordings.map(rec => rec.studentGroup))].sort();

    // Keep "All" option and rebuild the rest
    filterSelect.innerHTML = '<option value="">All</option>';

    uniqueGroups.forEach(group => {
        const option = document.createElement('option');
        option.value = group;
        option.textContent = group;
        filterSelect.appendChild(option);
    });

    // Restore previous selection if it still exists
    if (currentValue && uniqueGroups.includes(currentValue)) {
        filterSelect.value = currentValue;
    }
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

        if (isMissing) {
            missing++;
        } else if (allUploaded) {
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

// Track active uploads - Map of videoPath -> { xhr, eventSource, progress: { percent, bytesUploaded, bytesTotal, status } }
const activeUploads = new Map();

// Generate upload button HTML based on upload state
function getUploadButtonHTML(videoPath, studentGroup, date) {
    const uploadState = activeUploads.get(videoPath);

    // Check for interrupted upload first (before checking active uploads)
    if (!uploadState && interruptedUploads[videoPath]) {
        const interrupted = interruptedUploads[videoPath];
        const percent = Math.round((interrupted.bytesUploaded / interrupted.bytesTotal) * 100);
        return `<button class="btn-action btn-upload" data-video-path="${videoPath.replace(/'/g, '&apos;')}" onclick="resumeUpload('${videoPath.replace(/'/g, "\\'")}', '${studentGroup}', '${date}')" style="background: linear-gradient(180deg, #007AFF 0%, #0051D5 100%); color: white; font-size: 0.7rem; font-weight: 600;">▶️ ${percent}%</button>`;
    }

    if (!uploadState) {
        // Not uploading - show cloud icon
        return `<button class="btn-action btn-upload" data-video-path="${videoPath.replace(/'/g, '&apos;')}" onclick="uploadVideo('${videoPath.replace(/'/g, "\\'")}', '${studentGroup}', '${date}')">☁️</button>`;
    }

    // Uploading - show progress percentage
    const percent = uploadState.progress.percent || 0;
    const isComplete = uploadState.progress.status === 'complete';

    if (isComplete) {
        return `<button class="btn-action btn-upload" data-video-path="${videoPath.replace(/'/g, '&apos;')}" style="background: linear-gradient(180deg, #34c759 0%, #28a745 100%); color: white;">✓</button>`;
    }

    // Show percentage with orange background
    return `<button class="btn-action btn-upload btn-uploading" data-video-path="${videoPath.replace(/'/g, '&apos;')}" onclick="uploadVideo('${videoPath.replace(/'/g, "\\'")}', '${studentGroup}', '${date}')" style="background: linear-gradient(180deg, #ff9500 0%, #ff8000 100%); font-size: 0.7rem; font-weight: 600; color: white; text-shadow: 0 0 3px rgba(0,0,0,0.5);">${percent}%</button>`;
}

// Directly update upload button without re-rendering entire table
function updateUploadButton(videoPath, progress) {
    // Find all upload buttons for this video path (there might be duplicates in the table)
    const buttons = document.querySelectorAll(`.btn-upload[data-video-path="${videoPath.replace(/"/g, '&quot;')}"]`);

    buttons.forEach(button => {
        const percent = progress.percent || 0;
        const isComplete = progress.status === 'complete';

        if (isComplete) {
            button.textContent = '✓';
            button.className = 'btn-action btn-upload';
            button.style.background = 'linear-gradient(180deg, #34c759 0%, #28a745 100%)';
            button.style.color = 'white';
        } else {
            button.textContent = `${percent}%`;
            button.className = 'btn-action btn-upload btn-uploading';
            button.style.background = 'linear-gradient(180deg, #ff9500 0%, #ff8000 100%)';
            button.style.fontSize = '0.7rem';
            button.style.fontWeight = '600';
            button.style.color = 'white';
            button.style.textShadow = '0 0 3px rgba(0,0,0,0.5)';
        }
    });
}

// Upload video to Google Drive
async function uploadVideo(videoPath, studentGroup, date) {
    // Check if already uploading
    if (activeUploads.has(videoPath)) {
        // Pause upload
        if (!confirm('Pause upload? You can resume it later.')) {
            return;
        }

        console.log('⏸️  Pausing upload...');

        // Call backend to pause the upload
        try {
            const response = await fetch('/api/pause-upload', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ videoPath })
            });

            const result = await response.json();
            if (!result.success) {
                console.error('Failed to pause upload:', result.error);
                alert('Failed to pause upload: ' + result.error);
                return;
            }

            console.log('✅ Upload paused successfully');
        } catch (error) {
            console.error('Error pausing upload:', error);
            alert('Error pausing upload: ' + error.message);
            return;
        }

        // Clean up frontend state
        const uploadState = activeUploads.get(videoPath);
        if (uploadState && uploadState.eventSource) {
            uploadState.eventSource.close();
        }
        activeUploads.delete(videoPath);
        renderRecordings();
        return;
    }

    const filename = videoPath.split('/').pop();

    if (!confirm(`Upload ${filename} to Google Drive?\n\nNote: Large files may take up to 30 minutes to upload depending on connection speed.\nYou'll see real-time progress percentage.`)) {
        return;
    }

    console.log(`🚀 Starting upload: ${filename}`);

    // Generate unique upload ID for progress tracking
    const uploadId = `upload_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Use XMLHttpRequest for upload
    const xhr = new XMLHttpRequest();
    xhr.timeout = 3600000; // 1 hour timeout for large uploads (no timeout in practice)

    // Create upload state object
    const uploadState = {
        xhr: xhr,
        eventSource: null,
        progress: {
            percent: 0,
            bytesUploaded: 0,
            bytesTotal: 0,
            status: 'uploading'
        }
    };
    activeUploads.set(videoPath, uploadState);

    // Connect to SSE endpoint for real-time progress
    const eventSource = new EventSource(`/api/upload-progress/${uploadId}`);
    uploadState.eventSource = eventSource;

    eventSource.onmessage = (event) => {
        try {
            const progress = JSON.parse(event.data);
            uploadState.progress = progress;

            // Directly update the button without re-rendering the entire table
            updateUploadButton(videoPath, progress);

            console.log(`📊 Upload progress: ${progress.percent}% (${Math.round(progress.bytesUploaded / (1024 * 1024))} MB / ${Math.round(progress.bytesTotal / (1024 * 1024))} MB)`);

            // If paused by user or error (network disconnect), clean up and show as interrupted
            if (progress.status === 'paused' || progress.status === 'error') {
                const statusMsg = progress.status === 'paused' ? '⏸️  Upload paused' : '❌ Upload error detected';
                console.log(`${statusMsg} for ${videoPath.split('/').pop()} - will show as interrupted`);
                eventSource.close();
                activeUploads.delete(videoPath);
                // Re-render to show blue play button (interrupted/paused state)
                renderRecordings();
            }
        } catch (e) {
            console.error('Error parsing progress data:', e);
        }
    };

    eventSource.onerror = (error) => {
        console.error('SSE connection error:', error);
        // Don't close or delete - upload might still be in progress
    };

    // Re-render to show progress indicator
    renderRecordings();

    // Handle completion
    xhr.addEventListener('load', () => {
        if (xhr.status === 200) {
            const result = JSON.parse(xhr.responseText);
            if (result.success) {
                console.log(`✅ Upload complete: ${filename}`);
                if (uploadState.eventSource) {
                    uploadState.eventSource.close();
                }
                activeUploads.delete(videoPath);
                loadData();
            } else {
                // Check for specific error types and provide helpful guidance
                if (result.error && result.error.includes('Google Drive not configured')) {
                    alert('Google Drive Authorization Required\n\nPlease authorize Google Drive first by clicking the "🔑 Authorize Google Drive" button at the top of the page.\n\nAfter authorization, you can upload videos.');
                    // Highlight the auth button if it exists
                    const authBtn = document.getElementById('authBtn');
                    if (authBtn && authBtn.style.display !== 'none') {
                        authBtn.style.animation = 'pulse 1s ease-in-out 3';
                    }
                } else {
                    alert('Failed to upload video: ' + result.error);
                }
                if (uploadState.eventSource) {
                    uploadState.eventSource.close();
                }
                activeUploads.delete(videoPath);
                renderRecordings();
            }
        } else if (xhr.status === 400) {
            // Parse error for 400 responses
            try {
                const result = JSON.parse(xhr.responseText);
                if (result.error && result.error.includes('Google Drive not configured')) {
                    alert('Google Drive Authorization Required\n\nPlease authorize Google Drive first by clicking the "🔑 Authorize Google Drive" button at the top of the page.\n\nAfter authorization, you can upload videos.');
                    // Highlight the auth button if it exists
                    const authBtn = document.getElementById('authBtn');
                    if (authBtn && authBtn.style.display !== 'none') {
                        authBtn.style.animation = 'pulse 1s ease-in-out 3';
                    }
                } else {
                    alert('Upload failed: ' + result.error);
                }
            } catch (e) {
                alert('Upload failed (Error 400)');
            }
            if (uploadState.eventSource) {
                uploadState.eventSource.close();
            }
            activeUploads.delete(videoPath);
            renderRecordings();
        } else {
            alert('Upload failed (Error ' + xhr.status + ')');
            if (uploadState.eventSource) {
                uploadState.eventSource.close();
            }
            activeUploads.delete(videoPath);
            renderRecordings();
        }
    });

    // Handle errors
    xhr.addEventListener('error', () => {
        alert('Failed to upload video');
        if (uploadState.eventSource) {
            uploadState.eventSource.close();
        }
        activeUploads.delete(videoPath);
        renderRecordings();
    });

    // Handle abort
    xhr.addEventListener('abort', () => {
        console.log('❌ Upload cancelled');
        if (uploadState.eventSource) {
            uploadState.eventSource.close();
        }
        activeUploads.delete(videoPath);
        renderRecordings();
    });

    // Handle timeout
    xhr.addEventListener('timeout', () => {
        console.error('⏱️ Upload timeout after 1 hour');
        alert('Upload timeout after 1 hour - connection may be too slow or unstable.\n\nTry uploading manually to Google Drive.');
        if (uploadState.eventSource) {
            uploadState.eventSource.close();
        }
        activeUploads.delete(videoPath);
        renderRecordings();
    });

    // Send request with uploadId
    xhr.open('POST', '/api/upload');
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.send(JSON.stringify({
        videoPath: videoPath,
        studentGroup: studentGroup,
        date: date,
        uploadId: uploadId
    }));
}

// Resume interrupted upload
async function resumeUpload(videoPath, studentGroup, date) {
    const filename = videoPath.split('/').pop();
    const interrupted = interruptedUploads[videoPath];

    if (!interrupted) {
        alert('No interrupted upload found for this video');
        return;
    }

    const percent = Math.round((interrupted.bytesUploaded / interrupted.bytesTotal) * 100);

    if (!confirm(`Resume upload of ${filename} from ${percent}%?`)) {
        return;
    }

    console.log(`▶️ Resuming upload: ${filename} from ${percent}%`);

    // Generate unique upload ID for progress tracking
    const uploadId = `resume_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

    // Use XMLHttpRequest for upload
    const xhr = new XMLHttpRequest();
    xhr.timeout = 3600000; // 1 hour timeout for large uploads

    // Create upload state object
    const uploadState = {
        xhr: xhr,
        eventSource: null,
        progress: {
            percent: percent,
            bytesUploaded: interrupted.bytesUploaded,
            bytesTotal: interrupted.bytesTotal,
            status: 'uploading'
        }
    };
    activeUploads.set(videoPath, uploadState);

    // Remove from interrupted uploads list
    delete interruptedUploads[videoPath];

    // Connect to SSE endpoint for real-time progress
    const eventSource = new EventSource(`/api/upload-progress/${uploadId}`);
    uploadState.eventSource = eventSource;

    eventSource.onmessage = (event) => {
        try {
            const progress = JSON.parse(event.data);
            uploadState.progress = progress;

            // Directly update the button without re-rendering the entire table
            updateUploadButton(videoPath, progress);

            console.log(`📊 Resume progress: ${progress.percent}% (${Math.round(progress.bytesUploaded / (1024 * 1024))} MB / ${Math.round(progress.bytesTotal / (1024 * 1024))} MB)`);

            // If paused by user or error (network disconnect), clean up and show as interrupted
            if (progress.status === 'paused' || progress.status === 'error') {
                const statusMsg = progress.status === 'paused' ? '⏸️  Resume paused' : '❌ Resume error detected';
                console.log(`${statusMsg} for ${videoPath.split('/').pop()} - will show as interrupted`);
                eventSource.close();
                activeUploads.delete(videoPath);
                // Re-render to show blue play button (interrupted/paused state)
                renderRecordings();
            }
        } catch (e) {
            console.error('Error parsing progress data:', e);
        }
    };

    eventSource.onerror = (error) => {
        console.error('SSE connection error:', error);
        // Don't close or delete - upload might still be in progress
    };

    // Re-render to show progress indicator
    renderRecordings();

    // Handle completion
    xhr.addEventListener('load', () => {
        if (xhr.status === 200) {
            const result = JSON.parse(xhr.responseText);
            if (result.success) {
                console.log(`✅ Resume upload complete: ${filename}`);
                if (uploadState.eventSource) {
                    uploadState.eventSource.close();
                }
                activeUploads.delete(videoPath);
                loadData();
            } else {
                // Check if session expired - don't restore interrupted upload
                if (result.sessionExpired) {
                    const driveMsg = result.driveError ? `\n\nGoogle Drive says: ${result.driveError}` : '';
                    alert(`Upload session expired. Google Drive resumable sessions expire after ~7 days.\n\nPlease start a new upload.${driveMsg}`);
                    console.log(`❌ Session expired for ${filename} - removing from interrupted uploads`);
                    console.log(`   Google Drive error: ${result.driveError}`);
                    if (uploadState.eventSource) {
                        uploadState.eventSource.close();
                    }
                    activeUploads.delete(videoPath);
                    // Don't restore - session is gone, show green button
                    renderRecordings();
                } else {
                    alert('Failed to resume upload: ' + result.error);
                    if (uploadState.eventSource) {
                        uploadState.eventSource.close();
                    }
                    activeUploads.delete(videoPath);
                    // Restore to interrupted uploads
                    interruptedUploads[videoPath] = interrupted;
                    renderRecordings();
                }
            }
        } else if (xhr.status === 410) {
            // 410 Gone = session expired
            const result = JSON.parse(xhr.responseText);
            const driveMsg = result.driveError ? `\n\nGoogle Drive says: ${result.driveError}` : '';
            alert(`Upload session expired. Google Drive resumable sessions expire after ~7 days.\n\nPlease start a new upload.${driveMsg}`);
            console.log(`❌ Session expired (410) for ${filename} - removing from interrupted uploads`);
            console.log(`   Google Drive error: ${result.driveError}`);
            if (uploadState.eventSource) {
                uploadState.eventSource.close();
            }
            activeUploads.delete(videoPath);
            // Don't restore - session is gone, show green button
            renderRecordings();
        } else {
            alert('Resume upload failed (Error ' + xhr.status + ')');
            if (uploadState.eventSource) {
                uploadState.eventSource.close();
            }
            activeUploads.delete(videoPath);
            // Restore to interrupted uploads
            interruptedUploads[videoPath] = interrupted;
            renderRecordings();
        }
    });

    // Handle errors
    xhr.addEventListener('error', () => {
        alert('Failed to resume upload');
        if (uploadState.eventSource) {
            uploadState.eventSource.close();
        }
        activeUploads.delete(videoPath);
        // Restore to interrupted uploads
        interruptedUploads[videoPath] = interrupted;
        renderRecordings();
    });

    // Handle abort
    xhr.addEventListener('abort', () => {
        console.log('❌ Resume upload cancelled');
        if (uploadState.eventSource) {
            uploadState.eventSource.close();
        }
        activeUploads.delete(videoPath);
        // Restore to interrupted uploads
        interruptedUploads[videoPath] = interrupted;
        renderRecordings();
    });

    // Handle timeout
    xhr.addEventListener('timeout', () => {
        console.error('⏱️ Resume upload timeout after 1 hour');
        alert('Upload timeout after 1 hour - connection may be too slow or unstable.\n\nTry uploading manually to Google Drive.');
        if (uploadState.eventSource) {
            uploadState.eventSource.close();
        }
        activeUploads.delete(videoPath);
        // Restore to interrupted uploads
        interruptedUploads[videoPath] = interrupted;
        renderRecordings();
    });

    // Send request with uploadId
    xhr.open('POST', '/api/resume-upload');
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.send(JSON.stringify({
        videoPath: videoPath,
        uploadId: uploadId
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
            // Check for specific error types and provide helpful guidance
            if (result.error && result.error.includes('Missing credentials.json')) {
                alert('Google Cloud Setup Required\n\n' +
                      'Please complete the Google Cloud Console setup:\n\n' +
                      '1. Create a Google Cloud project\n' +
                      '2. Enable Google Drive API\n' +
                      '3. Create OAuth 2.0 credentials\n' +
                      '4. Download credentials.json to project root\n\n' +
                      'See README.md for detailed instructions.');
            } else {
                alert('Sync failed: ' + result.error);
            }
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
