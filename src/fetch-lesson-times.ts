#!/usr/bin/env bun

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { stat } from "node:fs/promises";
import { homedir } from "node:os";

// Generate date (today + 2 days) in the required format
const futureDate = new Date();
futureDate.setDate(futureDate.getDate() + 2);
const year = futureDate.getFullYear();
const month = String(futureDate.getMonth() + 1).padStart(2, '0');
const day = String(futureDate.getDate()).padStart(2, '0');
const futureDateFormatted = `${year}-${month}-${day}`;

const API_URL = `https://tahveltp.edu.ee/hois_back/timetableevents/timetableSearch?from=2024-09-26T00:00:00.000Z&lang=ET&page=0&schoolId=9&size=2000&teachers=95f992e3-01b9-4f5e-a5b6-d9ed2a159f6e&thru=${futureDateFormatted}T23:59:59.999Z`;

interface LessonEvent {
  date: string;
  timeStart: string;
  timeEnd: string;
  studentGroups: any[];
}

interface ApiResponse {
  content: LessonEvent[];
}

async function fetchLessonTimes() {
  try {
    const response = await fetch(API_URL);

    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }

    const data = await response.json() as ApiResponse;

    // Filter out entries with empty studentGroups array (not actual lessons)
    // Also filter out events with many groups (school-wide events like meetings)
    const lessonTimes = data.content
      .filter(lesson => lesson.studentGroups && lesson.studentGroups.length > 0)
      .filter(lesson => lesson.studentGroups.length <= 3) // Exclude school-wide events
      .map(lesson => ({
        date: lesson.date.split("T")[0],
        start: lesson.timeStart,
        end: lesson.timeEnd,
        studentGroup: lesson.studentGroups[0].code
      }));

    await Bun.write("data/times.json", JSON.stringify(lessonTimes));

    console.log(`Successfully saved ${lessonTimes.length} lesson times to times.json`);

    // Create simplified version - group by date AND student group
    const lessonsByDateAndGroup = new Map<string, { date: string; start: string; end: string; studentGroup: string }>();

    lessonTimes.forEach(lesson => {
      const key = `${lesson.date}:${lesson.studentGroup}`;
      if (!lessonsByDateAndGroup.has(key)) {
        lessonsByDateAndGroup.set(key, {
          date: lesson.date,
          start: lesson.start,
          end: lesson.end,
          studentGroup: lesson.studentGroup
        });
      } else {
        const existing = lessonsByDateAndGroup.get(key)!;
        // Update if this lesson starts earlier or ends later
        if (lesson.start < existing.start) {
          existing.start = lesson.start;
        }
        if (lesson.end > existing.end) {
          existing.end = lesson.end;
        }
      }
    });

    const simplified = Array.from(lessonsByDateAndGroup.values());

    await Bun.write("data/times_simplified.json", JSON.stringify(simplified));

    console.log(`Successfully saved ${simplified.length} simplified lesson times to times_simplified.json`);

    // Scan Zoom folders and match with lesson dates
    const zoomDir = join(homedir(), "Documents", "Zoom");
    const lessonDates = new Set(simplified.map(s => s.date));
    const dateToGroupMap = new Map(simplified.map(s => [s.date, s.studentGroup]));
    const recordingsByDate = new Map<string, Array<{ folder: string; videos: string[] }>>();

    try {
      const entries = await readdir(zoomDir);

      for (const entry of entries) {
        // Check if entry starts with "2025-"
        if (entry.startsWith("2025-")) {
          const fullPath = join(zoomDir, entry);
          const stats = await stat(fullPath);

          if (stats.isDirectory()) {
            // Extract date from folder name (first 10 characters: YYYY-MM-DD)
            const folderDate = entry.substring(0, 10);

            if (lessonDates.has(folderDate)) {
              // Scan for video files in this folder
              const files = await readdir(fullPath);
              const videoFiles = files
                .filter(f =>
                  f.endsWith(".mp4") ||
                  f.endsWith(".mkv") ||
                  f.endsWith(".avi") ||
                  f.endsWith(".mov")
                )
                .map(f => join(fullPath, f));

              if (!recordingsByDate.has(folderDate)) {
                recordingsByDate.set(folderDate, []);
              }
              recordingsByDate.get(folderDate)!.push({
                folder: entry,
                videos: videoFiles
              });
            }
          }
        }
      }

      // Create final recordings list with placeholders for missing recordings
      const matchingRecordings: Array<{ folder: string; date: string; studentGroup: string; videos?: string[]; uploaded?: boolean }> = [];
      const processedFolders = new Set<string>();  // Track which folders we've already added

      for (const lesson of simplified) {
        const recordings = recordingsByDate.get(lesson.date);

        if (recordings && recordings.length > 0) {
          // For each recording folder, match videos to student group based on filename
          recordings.forEach(rec => {
            // Extract student group from video filenames
            const groupVideos = rec.videos.filter(videoPath => {
              const filename = videoPath.split('/').pop() || '';
              // Check if filename starts with this student group (e.g., "TAK24 -" or "TAK25 -")
              return filename.startsWith(`${lesson.studentGroup} -`);
            });

            // Get all lessons for this date
            const lessonsForThisDate = simplified.filter(l => l.date === lesson.date);

            // Determine if we should add this entry
            let shouldAddEntry = false;
            let videosToUse = groupVideos;

            if (groupVideos.length > 0) {
              // Found videos matching this group
              shouldAddEntry = true;
            } else if (lessonsForThisDate.length === 1) {
              // Only one lesson this date, assign all videos to it
              shouldAddEntry = true;
              videosToUse = rec.videos;
            } else {
              // Multiple lessons this date, no group-matched videos
              // Try to match by recording time from folder name
              // Folder format: "YYYY-MM-DD HH.MM.SS ..."
              const timeMatch = rec.folder.match(/\d{4}-\d{2}-\d{2}\s+(\d{2})\.(\d{2})\./);
              if (timeMatch) {
                const recordingHour = parseInt(timeMatch[1]);
                const recordingMinute = parseInt(timeMatch[2]);
                const recordingTime = recordingHour * 60 + recordingMinute;

                // Find the lesson with the closest start time to the recording time
                // Allow matching up to 30 minutes before the lesson starts
                const lessonsWithTimes = lessonsForThisDate.map(l => {
                  const [h, m] = l.start.split(':').map(Number);
                  const startTime = h * 60 + m;
                  const timeDiff = Math.abs(startTime - recordingTime);
                  return { lesson: l, startTime, timeDiff };
                });

                // Find the closest lesson
                const closestLesson = lessonsWithTimes
                  .filter(l => recordingTime >= l.startTime - 30) // Allow 30 min before lesson
                  .sort((a, b) => a.timeDiff - b.timeDiff)[0]; // Sort by absolute time difference

                if (closestLesson && closestLesson.lesson.studentGroup === lesson.studentGroup) {
                  shouldAddEntry = true;
                  videosToUse = rec.videos;
                }
              }
            }

            if (shouldAddEntry && !processedFolders.has(`${rec.folder}:${lesson.studentGroup}`)) {
              processedFolders.add(`${rec.folder}:${lesson.studentGroup}`);
              matchingRecordings.push({
                folder: rec.folder,
                date: lesson.date,
                studentGroup: lesson.studentGroup,
                videos: videosToUse
              });
            }
          });
        }

        // Add placeholder for missing recording only if we didn't find any videos for this group/date
        const hasRecordingForThisLesson = matchingRecordings.some(
          r => r.date === lesson.date && r.studentGroup === lesson.studentGroup && r.videos && r.videos.length > 0
        );
        if (!hasRecordingForThisLesson) {
          matchingRecordings.push({
            folder: "MISSING!",
            date: lesson.date,
            studentGroup: lesson.studentGroup
          });
        }
      }

      // Load uploaded dates
      let uploadedDates: { [key: string]: string[] } = {};
      try {
        const uploadedFile = await Bun.file("data/uploaded-dates.json");
        uploadedDates = await uploadedFile.json();
      } catch (error) {
        console.log("No uploaded-dates.json found, all recordings marked as not uploaded");
      }

      // Add upload status to recordings
      matchingRecordings.forEach(recording => {
        const groupUploads = uploadedDates[recording.studentGroup] || [];
        recording.uploaded = groupUploads.includes(recording.date);
      });

      // Sort recordings by date chronologically
      matchingRecordings.sort((a, b) => a.date.localeCompare(b.date));

      await Bun.write("data/lecture_recordings.json", JSON.stringify(matchingRecordings, null, 2));
      console.log(`Successfully saved ${matchingRecordings.length} matching lecture recordings to lecture_recordings.json`);
    } catch (error) {
      console.error("Error scanning Zoom folders:", error);
    }
  } catch (error) {
    console.error("Error fetching lesson times:", error);
    process.exit(1);
  }
}

fetchLessonTimes();
