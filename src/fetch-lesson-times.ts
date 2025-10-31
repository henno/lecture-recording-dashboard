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
    const lessonTimes = data.content
      .filter(lesson => lesson.studentGroups && lesson.studentGroups.length > 0)
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

      for (const lesson of simplified) {
        const recordings = recordingsByDate.get(lesson.date);

        if (recordings && recordings.length > 0) {
          // Add all recordings for this date
          recordings.forEach(rec => {
            matchingRecordings.push({
              folder: rec.folder,
              date: lesson.date,
              studentGroup: lesson.studentGroup,
              videos: rec.videos
            });
          });
        } else {
          // Add placeholder for missing recording
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
