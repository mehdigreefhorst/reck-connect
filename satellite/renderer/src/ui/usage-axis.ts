// X-axis ticks for the usage plot (issue #106). Pure math — no DOM, no
// uPlot — so every case here is unit-testable with plain Dates.
//
// The rule this module exists to enforce: **the axis is a property of
// the view, not of the bin width.** Week view is labelled in days
// whether it is drawn at 5-minute or 1-day bins; Month view in dates;
// Day view in hours; Year view in months. Bin width is a density
// control — it changes how finely the data is drawn, not what the axis
// is measuring. (Before this, labels were derived from the bin width,
// so the same week relabelled itself from "Tue 14" to "Tue 06:00" when
// you picked finer bins.)
//
// Ticks land on real local calendar boundaries rather than on round bin
// indices. uPlot's default splits are round numbers in *index* space,
// which for 30-minute bins puts the "Wed 15" tick at Wed 02:00 — close
// enough to look right and wrong enough that you can't read a day
// boundary off the chart. We convert each boundary instant back to a
// (possibly fractional) bin index instead, which keeps a tick exactly
// where the day starts at any bin width.

import { DAYS, MONTHS, type Granularity } from "./usage-range";

/** Calendar unit the ticks step by. */
export type TickUnit = "hour" | "day" | "month";

/** Minimum horizontal room per tick label, in CSS pixels. Mirrors the
 * `space` uPlot would have used, so tick density is unchanged from
 * before even though we now choose the positions ourselves. */
export const MIN_TICK_PX = 70;

/** The unit a view is measured in. This — not the bin width — is what
 * decides the axis. */
export function tickUnitFor(g: Granularity): TickUnit {
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

/** Tick label for an instant, formatted for the view. Week keeps the
 * weekday (you read a week by its days); Month drops it (30 weekday
 * names is noise, and the space buys more dates). */
export function axisLabelFor(g: Granularity, t: Date): string {
  switch (g) {
    case "day":
      return `${String(t.getHours()).padStart(2, "0")}:${String(t.getMinutes()).padStart(2, "0")}`;
    case "week":
      return `${DAYS[t.getDay()]} ${t.getDate()}`;
    case "month":
      return `${t.getDate()}`;
    case "year":
      return MONTHS[t.getMonth()].slice(0, 3);
  }
}

/** Every local `unit` boundary in [start, until), ascending. Built from
 * Date component math so DST transitions land where the calendar says
 * they do rather than a fixed number of seconds later. */
export function tickTimes(unit: TickUnit, start: Date, until: Date): Date[] {
  const out: Date[] = [];
  const y = start.getFullYear();
  const mo = start.getMonth();
  const d = start.getDate();
  // First boundary at or after `start`. Views start on one by
  // construction (midnight / the 1st); a range that doesn't gets the
  // next one up.
  let cur =
    unit === "hour"
      ? new Date(y, mo, d, start.getHours())
      : unit === "day"
        ? new Date(y, mo, d)
        : new Date(y, mo, 1);
  if (cur.getTime() < start.getTime()) cur = stepTick(unit, cur, 1);
  // Guard against a pathological range silently spinning: no view we
  // offer needs more boundaries than a year of hours.
  for (let i = 0; cur.getTime() < until.getTime() && i < 9000; i++) {
    out.push(cur);
    cur = stepTick(unit, cur, 1);
  }
  return out;
}

function stepTick(unit: TickUnit, t: Date, n: number): Date {
  const y = t.getFullYear();
  const mo = t.getMonth();
  const d = t.getDate();
  switch (unit) {
    case "hour":
      return new Date(y, mo, d, t.getHours() + n);
    case "day":
      return new Date(y, mo, d + n);
    case "month":
      return new Date(y, mo + n, 1);
  }
}

/** Thin `ticks` to at most `maxTicks` by keeping every k-th, starting
 * at the first — so the leading boundary (midnight, the 1st of the
 * month) always survives and the spacing stays even. */
export function subsampleTicks<T>(ticks: readonly T[], maxTicks: number): T[] {
  if (maxTicks < 1) return ticks.length > 0 ? [ticks[0]] : [];
  if (ticks.length <= maxTicks) return [...ticks];
  const k = Math.ceil(ticks.length / maxTicks);
  return ticks.filter((_, i) => i % k === 0);
}

/** How many ticks fit across `plotWidthPx`. At least one. */
export function maxTicksFor(plotWidthPx: number): number {
  return Math.max(1, Math.floor(plotWidthPx / MIN_TICK_PX));
}

/** Fractional bin index for an instant, or null when it falls outside
 * the plotted bins.
 *
 * Fractional because a calendar boundary rarely coincides with a bin
 * edge — 03:00 sits three quarters of the way through the 00:00 bin at
 * 4-hour bins — and uPlot is happy to draw a tick at 0.75. That is what
 * makes the label set independent of bin width: the tick goes where the
 * hour is, whether or not a bin happens to start there.
 *
 * `binStartsSec` are ascending bin start times (unix seconds).
 * `widthSec` is the fixed bin width, or null for calendar "month" bins,
 * whose width is measured from the neighbouring bin instead. */
export function indexForTime(
  binStartsSec: readonly number[],
  tSec: number,
  widthSec: number | null,
): number | null {
  const n = binStartsSec.length;
  if (n === 0) return null;
  if (tSec < binStartsSec[0]) return null;

  // Last bin starting at or before t.
  let lo = 0;
  let hi = n - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (binStartsSec[mid] <= tSec) lo = mid;
    else hi = mid - 1;
  }

  const span =
    widthSec ??
    (lo + 1 < n
      ? binStartsSec[lo + 1] - binStartsSec[lo]
      : // Trailing calendar bin: measure it as the month it starts.
        Math.floor(
          new Date(
            new Date(binStartsSec[lo] * 1000).getFullYear(),
            new Date(binStartsSec[lo] * 1000).getMonth() + 1,
            1,
          ).getTime() / 1000,
        ) - binStartsSec[lo]);
  if (span <= 0) return null;

  // Bin i's *start* maps to index i, not i - 0.5. That is exact for the
  // area curve — uPlot plots bin i's value at x = i — and for bars it
  // centres the label under the bar the way the old integer splits did.
  // The two readings differ by half a bin, which is ~1px at the fine
  // defaults and only visible at Year/1-day widths, where centred is
  // the nicer of the two anyway.
  const idx = lo + (tSec - binStartsSec[lo]) / span;
  // The scale runs [-0.5, n - 0.5]. Boundaries past that have no place
  // on it — which is also what trims ticks for the rest of today when
  // the daemon returns a partial current period.
  return idx > n - 0.5 ? null : idx;
}

/** One x-axis tick: where to draw it (bin index) and what to write. */
export interface AxisTick {
  idx: number;
  label: string;
}

/** The full tick set for a calendar view: boundaries of the view's own
 * unit, thinned to fit `plotWidthPx`, mapped onto the plotted bins.
 * Identical for every bin width the view offers — that is the point. */
export function axisTicksFor(args: {
  granularity: Granularity;
  start: Date;
  until: Date;
  binStartsSec: readonly number[];
  binWidthSec: number | null;
  plotWidthPx: number;
}): AxisTick[] {
  const { granularity, start, until, binStartsSec, binWidthSec, plotWidthPx } = args;
  const all = tickTimes(tickUnitFor(granularity), start, until);
  const chosen = subsampleTicks(all, maxTicksFor(plotWidthPx));
  const out: AxisTick[] = [];
  for (const t of chosen) {
    const idx = indexForTime(binStartsSec, Math.floor(t.getTime() / 1000), binWidthSec);
    if (idx === null) continue;
    out.push({ idx, label: axisLabelFor(granularity, t) });
  }
  return out;
}
