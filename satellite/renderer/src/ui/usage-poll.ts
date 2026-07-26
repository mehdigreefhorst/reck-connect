// Option logic for the quota polling dialog. Pure functions, no DOM and
// no network, so the fiddly parts — unit choice, validation, the storage
// arithmetic — are testable without standing up a dialog.

import type { UsagePollSettings } from "@client-core/api/client";

/** Which unit the interval is being entered in. */
export type IntervalUnit = "sec" | "min";

/**
 * Bytes one quota_samples row costs, index included.
 *
 * Measured, not estimated: on the station's live usage.db, quota_samples
 * plus idx_quota_ts occupied 65,536 bytes across 870 rows. That includes
 * page slack, so it slightly over-states the marginal row — which is the
 * right direction to be wrong in when the number is shown to someone
 * choosing how fast to poll.
 */
export const BYTES_PER_QUOTA_ROW = 75;

const SECONDS_PER_MONTH = 30 * 24 * 60 * 60;

/** Raw values off the form, before validation. */
export interface PollFormValues {
  enabled: boolean;
  /** As typed — a string, because an empty or half-typed field is a state
   *  the form has to survive rather than coerce. */
  amount: string;
  unit: IntervalUnit;
}

/** Bounds as reported by the daemon, so the form validates against the
 *  clamp that will actually be applied rather than a second copy. */
export interface PollBounds {
  minIntervalSec: number;
  maxIntervalSec: number;
}

export type PollBuildResult =
  | { ok: true; settings: UsagePollSettings }
  | { ok: false; error: string };

/** Seconds in one unit of `unit`. */
export function unitSeconds(unit: IntervalUnit): number {
  return unit === "min" ? 60 : 1;
}

/**
 * Split a raw second count into the amount and unit the form should show.
 *
 * Prefers minutes only when the value divides evenly, so 120s opens as
 * "2 min" but 90s stays "90 sec" rather than becoming an un-typeable 1.5.
 */
export function splitInterval(totalSec: number): { amount: number; unit: IntervalUnit } {
  if (totalSec >= 60 && totalSec % 60 === 0) {
    return { amount: totalSec / 60, unit: "min" };
  }
  return { amount: totalSec, unit: "sec" };
}

/** Approximate bytes a month of polling at this interval writes. */
export function monthlyBytes(intervalSec: number): number {
  if (intervalSec <= 0) return 0;
  return (SECONDS_PER_MONTH / intervalSec) * BYTES_PER_QUOTA_ROW;
}

/** Human size for the storage line — whole MB once past 10, one decimal
 *  below that, so "0.7 MB" and "39 MB" both read naturally. */
export function formatBytes(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb < 0.1) return "under 0.1 MB";
  if (mb < 10) return `${mb.toFixed(1)} MB`;
  return `${Math.round(mb)} MB`;
}

/** The line under the controls: what will happen, and what it costs. */
export function describePollSettings(settings: UsagePollSettings): string {
  if (!settings.enabled) {
    return "Polling is off. Quota is only recorded when Claude reports it.";
  }
  const { amount, unit } = splitInterval(settings.intervalSec);
  const noun = unit === "min" ? "minute" : "second";
  const every = amount === 1 ? `every ${noun}` : `every ${amount} ${noun}s`;
  return `Reads quota ${every} · about ${formatBytes(monthlyBytes(settings.intervalSec))} a month.`;
}

/**
 * Turn form values into settings, rejecting what the daemon would reject
 * anyway — but worded for the person who typed it.
 *
 * Out-of-range values are an error here rather than a silent clamp: the
 * daemon clamps as a backstop, but a form that quietly changes what you
 * typed is worse than one that tells you the limit.
 */
export function buildPollSettings(values: PollFormValues, bounds: PollBounds): PollBuildResult {
  const raw = values.amount.trim();
  if (raw === "") {
    return { ok: false, error: "Enter how often to poll." };
  }
  // Digits only, rather than Number(): a number input accepts "1e3" and
  // "0x10", which Number() would silently read as 1000 and 16. Saving a
  // value the user cannot see in what they typed is worse than asking
  // them to type it plainly.
  if (!/^\d+$/.test(raw)) {
    return { ok: false, error: "Use a whole number of seconds or minutes." };
  }
  const amount = Number(raw);
  if (amount <= 0) {
    return { ok: false, error: "Use a whole number of seconds or minutes." };
  }

  const intervalSec = amount * unitSeconds(values.unit);
  if (intervalSec < bounds.minIntervalSec) {
    return { ok: false, error: `The shortest interval is ${describeSeconds(bounds.minIntervalSec)}.` };
  }
  if (intervalSec > bounds.maxIntervalSec) {
    return { ok: false, error: `The longest interval is ${describeSeconds(bounds.maxIntervalSec)}.` };
  }
  return { ok: true, settings: { enabled: values.enabled, intervalSec } };
}

/** "5 seconds" / "24 hours" — for bounds messages. */
export function describeSeconds(sec: number): string {
  if (sec % 3600 === 0) {
    const h = sec / 3600;
    return h === 1 ? "1 hour" : `${h} hours`;
  }
  if (sec % 60 === 0) {
    const m = sec / 60;
    return m === 1 ? "1 minute" : `${m} minutes`;
  }
  return sec === 1 ? "1 second" : `${sec} seconds`;
}
