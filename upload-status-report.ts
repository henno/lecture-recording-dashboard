#!/usr/bin/env bun

const recordings = await Bun.file("lecture_recordings.json").json();

console.log("📊 LECTURE RECORDINGS UPLOAD STATUS\n");
console.log("=" .repeat(60));

// Summary by status
const uploaded = recordings.filter((r: any) => r.uploaded);
const notUploaded = recordings.filter((r: any) => !r.uploaded && r.folder !== "MISSING!");
const missing = recordings.filter((r: any) => r.folder === "MISSING!");

console.log(`\n✅ Uploaded: ${uploaded.length}`);
console.log(`⏳ Ready to upload: ${notUploaded.length}`);
console.log(`❌ Missing recordings: ${missing.length}`);
console.log(`📦 Total lessons: ${recordings.length}`);

// Summary by group
console.log("\n" + "=".repeat(60));
console.log("\nBY STUDENT GROUP:\n");

const groups = ["IS24", "TAK24", "TAK25"];
groups.forEach((group: string) => {
  const groupRecordings = recordings.filter((r: any) => r.studentGroup === group);
  const groupUploaded = groupRecordings.filter((r: any) => r.uploaded).length;
  const groupNotUploaded = groupRecordings.filter((r: any) => !r.uploaded && r.folder !== "MISSING!").length;
  const groupMissing = groupRecordings.filter((r: any) => r.folder === "MISSING!").length;

  console.log(`${group}:`);
  console.log(`  ✅ Uploaded: ${groupUploaded}`);
  console.log(`  ⏳ Ready: ${groupNotUploaded}`);
  console.log(`  ❌ Missing: ${groupMissing}`);
  console.log();
});

// Detailed list of what needs to be uploaded
console.log("=".repeat(60));
console.log("\n⏳ RECORDINGS READY TO UPLOAD:\n");

notUploaded.forEach((r: any) => {
  console.log(`${r.date} - ${r.studentGroup}`);
  if (r.videos && r.videos.length > 0) {
    r.videos.forEach((v: string) => {
      const filename = v.split("/").pop();
      console.log(`  📹 ${filename}`);
    });
  }
  console.log();
});

// Missing recordings
if (missing.length > 0) {
  console.log("=".repeat(60));
  console.log("\n❌ MISSING RECORDINGS (No local file):\n");

  missing.forEach((r: any) => {
    console.log(`${r.date} - ${r.studentGroup}`);
  });
}

console.log("\n" + "=".repeat(60));
