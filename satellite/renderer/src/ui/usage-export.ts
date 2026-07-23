// Export-options logic for the usage view's download button. Pure
// functions, no DOM and no network, so the fiddly parts — date parsing,
// which fields a dataset actually uses, what the daemon will reject —
// are testable without standing up a dialog.

import type {
  UsageExportDataset,
  UsageExportParams,
  UsageHistogramBucket,
} from "@client-core/api/client";

/** The two ways into an export. "current" is a one-click dump of what's
 * on screen; "advanced" lets the user pick dataset, range, and interval. */
export type ExportMode = "current" | "advanced";

/** What the chart is currently showing — the basis for a "current view"
 * export, and the defaults the advanced form opens with. */
export interface CurrentView {
  since: number; // unix seconds
  until: number; // unix seconds
  bucket: UsageHistogramBucket;
  projectId: string; // "" = all projects
  tzOffsetMin: number;
}

/** Raw values straight off the advanced form, before validation. Dates
 * are `YYYY-MM-DD` as produced by `<input type="date">`. */
export interface AdvancedFormValues {
  dataset: UsageExportDataset;
  fromDate: string;
  toDate: string;
  bucket: UsageHistogramBucket;
  projectId: string;
}

/** Datasets that are raw rows rather than a binned series. For these the
 * bin-width control is meaningless and is hidden. */
export function isRawDataset(dataset: UsageExportDataset): boolean {
  return dataset === "turns" || dataset === "quota";
}

/** Quota is account-level, so a project filter would silently do nothing.
 * The dialog disables the control rather than letting someone believe a
 * filter applied. */
export function supportsProjectFilter(dataset: UsageExportDataset): boolean {
  return dataset !== "quota";
}

/** One-line description of what a dataset contains, shown under the
 * picker so the choice doesn't rely on guessing from the name. */
export function datasetDescription(dataset: UsageExportDataset): string {
  switch (dataset) {
    case "binned":
      return "One row per interval, exactly as plotted: token sums, quota peaks, and the plan.";
    case "turns":
      return "One row per turn — the authoritative per-message token counts, with session and model.";
    default:
      return "Every 5h/7d quota reading, polled and statusline alike, with its source.";
  }
}

/** Params for a one-click "current view" export: the binned series over
 * exactly the range and bin width on screen. */
export function paramsForCurrentView(view: CurrentView): UsageExportParams {
  return {
    dataset: "binned",
    since: view.since,
    until: view.until,
    bucket: view.bucket,
    projectId: view.projectId || undefined,
    tzOffsetMin: view.tzOffsetMin,
  };
}

/**
 * Convert a `YYYY-MM-DD` field to the unix second of that day's LOCAL
 * midnight, given the caller's offset. Returns null for anything the
 * date input didn't produce.
 *
 * Deliberately not `new Date(str)`: that parses a bare date as UTC, which
 * would silently shift every export by the user's offset.
 */
export function localMidnight(dateStr: string, tzOffsetMin: number): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(dateStr);
  if (!m) return null;
  const [, y, mo, d] = m;
  const utcMidnight = Date.UTC(Number(y), Number(mo) - 1, Number(d)) / 1000;
  if (!Number.isFinite(utcMidnight)) return null;
  return utcMidnight - tzOffsetMin * 60;
}

/** A validated export request, or the reason it can't be built. */
export type BuildResult =
  | { ok: true; params: UsageExportParams }
  | { ok: false; error: string };

/**
 * Turn advanced-form values into export params, rejecting the mistakes
 * the daemon would reject anyway — but with wording aimed at the person
 * who typed them rather than at an API caller.
 *
 * The end date is treated as INCLUSIVE: a user picking 1st–1st means
 * "that day", so `until` is pushed to the following midnight. The daemon's
 * range is half-open, and a naive same-day range would export nothing.
 */
export function buildAdvancedParams(
  values: AdvancedFormValues,
  tzOffsetMin: number,
): BuildResult {
  const since = localMidnight(values.fromDate, tzOffsetMin);
  const until = localMidnight(values.toDate, tzOffsetMin);
  if (since === null || until === null) {
    return { ok: false, error: "Pick both a start and an end date." };
  }
  const untilExclusive = until + 86400;
  if (since >= untilExclusive) {
    return { ok: false, error: "The start date must be on or before the end date." };
  }
  const params: UsageExportParams = {
    dataset: values.dataset,
    since,
    until: untilExclusive,
    tzOffsetMin,
  };
  if (!isRawDataset(values.dataset)) {
    if (!values.bucket) {
      return { ok: false, error: "Pick an interval for the binned export." };
    }
    params.bucket = values.bucket;
  }
  if (values.projectId && supportsProjectFilter(values.dataset)) {
    params.projectId = values.projectId;
  }
  return { ok: true, params };
}

/** `YYYY-MM-DD` for a unix second in the caller's zone — the format
 * `<input type="date">` expects when seeding the form from the chart. */
export function toDateInputValue(unixSeconds: number, tzOffsetMin: number): string {
  const shifted = new Date((unixSeconds + tzOffsetMin * 60) * 1000);
  return shifted.toISOString().slice(0, 10);
}
