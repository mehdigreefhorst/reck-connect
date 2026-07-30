import { describe, it, expect } from "vitest";
import { DEFAULT_USAGE_PREFS, noSeriesVisible, sanitizeUsagePrefs } from "./usage-prefs";

describe("sanitizeUsagePrefs", () => {
  it("round-trips a valid blob", () => {
    const prefs = {
      granularity: "day" as const,
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

  it("ignores a bin width left over from an older release", () => {
    // `bucket` used to be persisted, back when it was a user control. The
    // sanitize is field-by-field and never copies unknown keys through, so an
    // old blob neither resurrects the field nor costs the rest of the prefs.
    const out = sanitizeUsagePrefs({ granularity: "day", bucket: "1m", projectId: "p" });
    expect(out).toEqual({
      granularity: "day",
      projectId: "p",
      shown: DEFAULT_USAGE_PREFS.shown,
    });
    expect("bucket" in out).toBe(false);
  });

  it("still resolves a bad granularity to the default", () => {
    expect(sanitizeUsagePrefs({ granularity: "decade" }).granularity).toBe("week");
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
