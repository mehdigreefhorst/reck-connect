import { describe, it, expect } from "vitest";
import {
  DEFAULT_USAGE_PREFS,
  isBucketValidFor,
  noSeriesVisible,
  sanitizeUsagePrefs,
} from "./usage-prefs";
import { BIN_OPTIONS, defaultBinFor } from "./usage-range";

describe("isBucketValidFor", () => {
  it("accepts every width the granularity offers", () => {
    for (const [g, widths] of Object.entries(BIN_OPTIONS)) {
      for (const w of widths) {
        expect(isBucketValidFor(g as never, w)).toBe(true);
      }
    }
  });

  it("rejects a width from a different granularity", () => {
    // The realistic case: 1m is a Day width, and the user switches to Month.
    expect(isBucketValidFor("day", "1m")).toBe(true);
    expect(isBucketValidFor("month", "1m")).toBe(false);
    expect(isBucketValidFor("day", "month")).toBe(false);
  });

  it("rejects non-strings", () => {
    expect(isBucketValidFor("day", 5)).toBe(false);
    expect(isBucketValidFor("day", null)).toBe(false);
    expect(isBucketValidFor("day", undefined)).toBe(false);
  });
});

describe("sanitizeUsagePrefs", () => {
  it("round-trips a valid blob", () => {
    const prefs = {
      granularity: "day" as const,
      bucket: "1m" as const,
      projectId: "proj-x",
      shown: { tokens: false, fiveHour: true, sevenDay: false },
    };
    expect(sanitizeUsagePrefs(prefs)).toEqual(prefs);
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a string", "week"],
    ["a number", 7],
    ["an array", []],
  ])("falls back to defaults for %s", (_label, raw) => {
    expect(sanitizeUsagePrefs(raw)).toEqual(DEFAULT_USAGE_PREFS);
  });

  it("keeps a good granularity when the bin width is nonsense", () => {
    // Field-by-field, not all-or-nothing: losing the granularity because the
    // width was bad would throw away the more important half.
    const out = sanitizeUsagePrefs({ granularity: "day", bucket: "42q" });
    expect(out.granularity).toBe("day");
    expect(out.bucket).toBe(defaultBinFor("day"));
  });

  it("repairs an incoherent granularity/width pair", () => {
    // "1m" is a Day width; on Month it would reach the daemon as a bad query.
    const out = sanitizeUsagePrefs({ granularity: "month", bucket: "1m" });
    expect(out.granularity).toBe("month");
    expect(out.bucket).toBe(defaultBinFor("month"));
  });

  it("validates the width against the RESOLVED granularity", () => {
    // Bad granularity resolves to the default (week); "4h" is valid there, so
    // it must survive rather than being judged against the bogus input.
    const out = sanitizeUsagePrefs({ granularity: "decade", bucket: "4h" });
    expect(out.granularity).toBe("week");
    expect(out.bucket).toBe("4h");
  });

  it("drops a non-string projectId", () => {
    expect(sanitizeUsagePrefs({ projectId: 42 }).projectId).toBe("");
    expect(sanitizeUsagePrefs({ projectId: null }).projectId).toBe("");
  });

  it("keeps the empty projectId meaning 'all projects'", () => {
    expect(sanitizeUsagePrefs({ projectId: "" }).projectId).toBe("");
  });

  it("fills only the missing series flags", () => {
    const out = sanitizeUsagePrefs({ shown: { tokens: false } });
    expect(out.shown).toEqual({ tokens: false, fiveHour: true, sevenDay: true });
  });

  it("ignores non-boolean series flags", () => {
    const out = sanitizeUsagePrefs({
      shown: { tokens: "no", fiveHour: 0, sevenDay: false },
    });
    expect(out.shown).toEqual({ tokens: true, fiveHour: true, sevenDay: false });
  });

  it("survives a shown field that isn't an object", () => {
    expect(sanitizeUsagePrefs({ shown: "all" }).shown).toEqual(
      DEFAULT_USAGE_PREFS.shown,
    );
  });

  it("allows all three series to be off", () => {
    // The state the red overlay exists for — it must persist, not be repaired.
    const out = sanitizeUsagePrefs({
      shown: { tokens: false, fiveHour: false, sevenDay: false },
    });
    expect(noSeriesVisible(out.shown)).toBe(true);
  });

  it("never carries an anchor date through", () => {
    // Reopening "Day" shows today, not the day you were paging through.
    const out = sanitizeUsagePrefs({
      granularity: "day",
      periodStart: "2026-03-03T00:00:00Z",
      custom: { since: 1, until: 2 },
    }) as unknown as Record<string, unknown>;
    expect(out.periodStart).toBeUndefined();
    expect(out.custom).toBeUndefined();
  });

  it("returns a fresh object each time", () => {
    // The overlay mutates its copy; leaking the shared default would make the
    // "defaults" drift for the rest of the session.
    const a = sanitizeUsagePrefs(null);
    a.shown.tokens = false;
    expect(sanitizeUsagePrefs(null).shown.tokens).toBe(true);
    expect(DEFAULT_USAGE_PREFS.shown.tokens).toBe(true);
  });
});

describe("noSeriesVisible", () => {
  it("is true only when every series is off", () => {
    expect(noSeriesVisible({ tokens: false, fiveHour: false, sevenDay: false })).toBe(true);
  });

  it.each([
    ["tokens", { tokens: true, fiveHour: false, sevenDay: false }],
    ["5h", { tokens: false, fiveHour: true, sevenDay: false }],
    ["7d", { tokens: false, fiveHour: false, sevenDay: true }],
  ])("is false when %s is on", (_label, shown) => {
    expect(noSeriesVisible(shown)).toBe(false);
  });
});
