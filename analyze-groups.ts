#!/usr/bin/env bun

const data = await Bun.file("times.json").json();

// Group by date and collect unique student groups per date
const dateGroupMap = new Map<string, Set<string>>();

data.forEach((lesson: any) => {
  if (!dateGroupMap.has(lesson.date)) {
    dateGroupMap.set(lesson.date, new Set());
  }
  dateGroupMap.get(lesson.date)!.add(lesson.studentGroup);
});

// Find dates with multiple groups
const multipleDates: Array<{ date: string; groups: string[] }> = [];

dateGroupMap.forEach((groups, date) => {
  if (groups.size > 1) {
    multipleDates.push({
      date,
      groups: Array.from(groups).sort()
    });
  }
});

if (multipleDates.length > 0) {
  console.log(`Found ${multipleDates.length} date(s) with multiple student groups:\n`);
  multipleDates.forEach(({ date, groups }) => {
    console.log(`${date}: ${groups.join(", ")}`);
  });
} else {
  console.log("No dates found with multiple student groups.");
  console.log("\nEach day has only one student group:");

  // Show summary
  const summary = new Map<string, string[]>();
  dateGroupMap.forEach((groups, date) => {
    const group = Array.from(groups)[0];
    if (!summary.has(group)) {
      summary.set(group, []);
    }
    summary.get(group)!.push(date);
  });

  summary.forEach((dates, group) => {
    console.log(`\n${group} (${dates.length} days):`);
    dates.forEach(date => console.log(`  - ${date}`));
  });
}
