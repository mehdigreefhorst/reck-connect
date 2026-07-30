// Remembered state for the usage overlay.
//
// Reopening the overlay used to drop the user back on Week / default bins /
// all-projects / everything-visible, no matter what they were looking at. This
// module is the pure half of fixing that: what gets remembered, and how a
// persisted blob is sanitized back into usable state.
//
// WHAT IS REMEMBERED — the shape of the view:
//   granularity, bin width, project filter, and which series are toggled on.
//
// WHAT IS NOT — where in time you were:
//   The anchor date is deliberately dropped. Reopening a "Day" view should show
//   TODAY, not whichever day you happened to be paging through last week; the
//   remembered thing is "I look at usage a day at a time, one minute per bin",
//   not "I was looking at 3 March". Drag-zoom ranges are dropped for the same
//   reason — a zoom is a gesture, not a preference.
//
// Everything here is defensive: the blob comes back from disk and may be from
// an older release, hand-edited, or truncated. Any unusable field falls back to
// its default rather than propagating (a bad bin width would otherwise reach the
// daemon as a query parameter).

import type { UsageHistogramBucket } from "@client-core/api/client";
import { BIN_OPTIONS, defaultBinFor, type Granularity } from "./usage-range";

/** Series visibility, keyed as the overlay keys it. */
export interface UsageSeriesShown {
  tokens: boolean;
  fiveHour: boolean;
  sevenDay: boolean;
}

export interface UsagePrefs {
  granularity: Granularity;
  bucket: UsageHistogramBucket;
  /** Project filter; "" means all projects. */
  projectId: string;
  shown: UsageSeriesShown;
}

const GRANULARITIES: Granularity[] = ["day", "week", "month", "year"];

/** Matches the overlay's own first-run state.
 *
 *  Frozen because callers mutate the prefs they receive: an unfrozen default
 *  handed out by reference would let one caller's edit redefine "default" for
 *  the rest of the session. `sanitizeUsagePrefs` always builds fresh objects. */
export const DEFAULT_USAGE_PREFS: Readonly<UsagePrefs> = Object.freeze({
  granularity: "week" as Granularity,
  bucket: defaultBinFor("week"),
  projectId: "",
  shown: Object.freeze({ tokens: true, fiveHour: true, sevenDay: true }),
}) as Readonly<UsagePrefs>;

function isGranularity(raw: unknown): raw is Granularity {
  return typeof raw === "string" && (GRANULARITIES as string[]).includes(raw);
}

/**
 * True when `bucket` is offered for `granularity`.
 *
 * Bin widths are per-granularity (`BIN_OPTIONS`), so a remembered "1m" is valid
 * for Day but not for Month. Cross-granularity carryover is the likely case
 * here — the user picks 1m on Day, switches to Month, and the persisted pair
 * has to stay coherent.
 */
export function isBucketValidFor(
  granularity: Granularity,
  bucket: unknown,
): bucket is UsageHistogramBucket {
  return (
    typeof bucket === "string" &&
    (BIN_OPTIONS[granularity] as string[]).includes(bucket)
  );
}

function sanitizeShown(raw: unknown): UsageSeriesShown {
  const src = (raw ?? {}) as Partial<Record<keyof UsageSeriesShown, unknown>>;
  const pick = (key: keyof UsageSeriesShown): boolean =>
    typeof src[key] === "boolean"
      ? (src[key] as boolean)
      : DEFAULT_USAGE_PREFS.shown[key];
  return {
    tokens: pick("tokens"),
    fiveHour: pick("fiveHour"),
    sevenDay: pick("sevenDay"),
  };
}

/**
 * Turn an arbitrary persisted value into usable prefs.
 *
 * Field-by-field rather than all-or-nothing: a blob with a good granularity and
 * a nonsense bin width should keep the granularity. The bin width is validated
 * against the RESOLVED granularity, so the returned pair is always coherent
 * even if the stored one wasn't.
 */
export function sanitizeUsagePrefs(raw: unknown): UsagePrefs {
  // No special case for a missing/garbage blob: an empty source runs the same
  // field-by-field path and every field falls back on its own. That also keeps
  // the result a freshly-built object, never a copy sharing `shown` with the
  // frozen defaults.
  const src: Record<string, unknown> =
    typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};

  const granularity = isGranularity(src.granularity)
    ? src.granularity
    : DEFAULT_USAGE_PREFS.granularity;

  const bucket = isBucketValidFor(granularity, src.bucket)
    ? src.bucket
    : defaultBinFor(granularity);

  return {
    granularity,
    bucket,
    projectId: typeof src.projectId === "string" ? src.projectId : "",
    shown: sanitizeShown(src.shown),
  };
}

/**
 * True when no series is visible — the chart has nothing to draw, and the
 * overlay says so rather than showing an empty plot that looks like "no data".
 */
export function noSeriesVisible(shown: UsageSeriesShown): boolean {
  return !shown.tokens && !shown.fiveHour && !shown.sevenDay;
}
