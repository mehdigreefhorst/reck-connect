// Pure range math for the usage view (issue #88): granularity ↔ server
// bucket mapping, period snapping, prev/next stepping, drill-down /
// drill-up, and range labels. No DOM, no uPlot, no fetch — everything
// here is unit-testable with plain Dates.
//
// All periods are anchored in the *local* timezone via native Date
// component math (new Date(y, m, d) is local by construction). The
// server aligns its fixed-width hour/day bins to the same local
// midnight because the caller sends tz_offset_min. Caveat: the offset
// is a constant snapshot, so day bins spanning a DST switch drift by
// an hour — acceptable for a usage plot.

import type { UsageHistogramBucket } from "@client-core/api/client";

/** The four user-facing views. Each renders one period of bins. */
export type Granularity = "day" | "week" | "month" | "year";

/** Server bin width backing each view: Day = 24 hour-bins, Week = 7
 * day-bins, Month = 28–31 day-bins, Year = 12 month-bins. */
export function bucketFor(g: Granularity): UsageHistogramBucket {
  switch (g) {
    case "day":
      return "hour";
    case "week":
    case "month":
      return "day";
    case "year":
      return "month";
  }
}

/** Half-open local period [start, until) containing `anchor`. Weeks
 * start on Monday (ISO). */
export function periodFor(g: Granularity, anchor: Date): { start: Date; until: Date } {
  const y = anchor.getFullYear();
  const m = anchor.getMonth();
  const d = anchor.getDate();
  switch (g) {
    case "day":
      return { start: new Date(y, m, d), until: new Date(y, m, d + 1) };
    case "week": {
      // getDay(): 0 = Sunday … 6 = Saturday; shift so Monday is day 0.
      const dow = (anchor.getDay() + 6) % 7;
      return { start: new Date(y, m, d - dow), until: new Date(y, m, d - dow + 7) };
    }
    case "month":
      return { start: new Date(y, m, 1), until: new Date(y, m + 1, 1) };
    case "year":
      return { start: new Date(y, 0, 1), until: new Date(y + 1, 0, 1) };
  }
}

/** Start of the adjacent period (dir = +1 next, -1 previous). `start`
 * must already be a period start (as produced by periodFor). */
export function stepPeriod(g: Granularity, start: Date, dir: 1 | -1): Date {
  const y = start.getFullYear();
  const m = start.getMonth();
  const d = start.getDate();
  switch (g) {
    case "day":
      return new Date(y, m, d + dir);
    case "week":
      return new Date(y, m, d + 7 * dir);
    case "month":
      return new Date(y, m + dir, 1);
    case "year":
      return new Date(y + dir, 0, 1);
  }
}

/** Finer view a clicked bin drills into, or null when already at hour
 * bins (Day view). Year → that month; Month/Week → that day. */
export function drillDown(g: Granularity): Granularity | null {
  switch (g) {
    case "year":
      return "month";
    case "month":
    case "week":
      return "day";
    case "day":
      return null;
  }
}

/** Coarser view for the ↑ button: a fixed, predictable ladder (the
 * granularity chips allow direct jumps anywhere anyway). */
export function drillUp(g: Granularity): Granularity | null {
  switch (g) {
    case "day":
      return "week";
    case "week":
      return "month";
    case "month":
      return "year";
    case "year":
      return null;
  }
}

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

/** Human label for the current period, e.g. "Tue 14 Jul 2026",
 * "Week of 13 Jul 2026", "July 2026", "2026". */
export function labelFor(g: Granularity, start: Date): string {
  const y = start.getFullYear();
  const mon = MONTHS[start.getMonth()];
  switch (g) {
    case "day":
      return `${DAYS[start.getDay()]} ${start.getDate()} ${mon.slice(0, 3)} ${y}`;
    case "week":
      return `Week of ${start.getDate()} ${mon.slice(0, 3)} ${y}`;
    case "month":
      return `${mon} ${y}`;
    case "year":
      return `${y}`;
  }
}

/** Axis tick label for one bin start within a view. */
export function binLabelFor(g: Granularity, binStart: Date): string {
  switch (g) {
    case "day":
      return `${String(binStart.getHours()).padStart(2, "0")}:00`;
    case "week":
      return `${DAYS[binStart.getDay()]} ${binStart.getDate()}`;
    case "month":
      return `${binStart.getDate()}`;
    case "year":
      return MONTHS[binStart.getMonth()].slice(0, 3);
  }
}

/** True when the period after `start` begins in the future — the "›"
 * button disables there (no point paging past now). */
export function nextDisabled(g: Granularity, start: Date, now: Date): boolean {
  return stepPeriod(g, start, 1).getTime() > now.getTime();
}

/** Minutes east of UTC for the histogram request — what the daemon
 * needs to align bins to this machine's local midnight. */
export function tzOffsetMin(anchor: Date): number {
  return -anchor.getTimezoneOffset();
}
