import { describe, expect, it } from "vitest";
import {
  BYTES_PER_QUOTA_ROW,
  buildPollSettings,
  describePollSettings,
  describeSeconds,
  formatBytes,
  monthlyBytes,
  splitInterval,
  unitSeconds,
} from "./usage-poll";

const BOUNDS = { minIntervalSec: 5, maxIntervalSec: 86_400 };

describe("splitInterval", () => {
  it("prefers minutes only when the value divides evenly", () => {
    // 90s as "1.5 min" would be untypeable in a whole-number field.
    expect(splitInterval(120)).toEqual({ amount: 2, unit: "min" });
    expect(splitInterval(60)).toEqual({ amount: 1, unit: "min" });
    expect(splitInterval(90)).toEqual({ amount: 90, unit: "sec" });
    expect(splitInterval(30)).toEqual({ amount: 30, unit: "sec" });
    expect(splitInterval(5)).toEqual({ amount: 5, unit: "sec" });
  });

  it("round-trips through unitSeconds", () => {
    for (const sec of [5, 30, 45, 60, 90, 120, 300, 3600, 86_400]) {
      const { amount, unit } = splitInterval(sec);
      expect(amount * unitSeconds(unit)).toBe(sec);
    }
  });
});

describe("buildPollSettings", () => {
  it("accepts a whole number in either unit", () => {
    expect(buildPollSettings({ enabled: true, amount: "30", unit: "sec" }, BOUNDS)).toEqual({
      ok: true,
      settings: { enabled: true, intervalSec: 30 },
    });
    expect(buildPollSettings({ enabled: true, amount: "2", unit: "min" }, BOUNDS)).toEqual({
      ok: true,
      settings: { enabled: true, intervalSec: 120 },
    });
  });

  it("keeps the interval when polling is off", () => {
    // So turning polling back on restores the period rather than a default.
    const got = buildPollSettings({ enabled: false, amount: "45", unit: "sec" }, BOUNDS);
    expect(got).toEqual({ ok: true, settings: { enabled: false, intervalSec: 45 } });
  });

  it("rejects an empty or non-integer amount", () => {
    // "1e3" and "0x10" are here deliberately: a number input accepts both
    // and Number() would read them as 1000 and 16, saving a value the
    // user never typed.
    for (const amount of ["", "   ", "abc", "1.5", "-30", "0", "1e3", "0x10", "Infinity", "30s"]) {
      const got = buildPollSettings({ enabled: true, amount, unit: "sec" }, BOUNDS);
      expect(got.ok, `amount ${JSON.stringify(amount)}`).toBe(false);
    }
  });

  it("reports the bound rather than silently clamping", () => {
    // The daemon clamps as a backstop; a form that quietly changes what
    // you typed is worse than one that tells you the limit.
    const low = buildPollSettings({ enabled: true, amount: "1", unit: "sec" }, BOUNDS);
    expect(low).toEqual({ ok: false, error: "The shortest interval is 5 seconds." });

    const high = buildPollSettings({ enabled: true, amount: "48", unit: "min" }, { minIntervalSec: 5, maxIntervalSec: 60 });
    expect(high).toEqual({ ok: false, error: "The longest interval is 1 minute." });
  });

  it("validates against the daemon's reported bounds, not its own copy", () => {
    const strict = { minIntervalSec: 60, maxIntervalSec: 300 };
    expect(buildPollSettings({ enabled: true, amount: "30", unit: "sec" }, strict).ok).toBe(false);
    expect(buildPollSettings({ enabled: true, amount: "60", unit: "sec" }, strict).ok).toBe(true);
  });

  it("accepts exactly the bounds", () => {
    expect(buildPollSettings({ enabled: true, amount: "5", unit: "sec" }, BOUNDS).ok).toBe(true);
    expect(buildPollSettings({ enabled: true, amount: "1440", unit: "min" }, BOUNDS).ok).toBe(true);
  });
});

describe("storage estimates", () => {
  it("scales inversely with the interval", () => {
    // A month of 60s polling is 43,200 rows.
    expect(monthlyBytes(60)).toBeCloseTo(43_200 * BYTES_PER_QUOTA_ROW, 0);
    // Halving the interval doubles the cost.
    expect(monthlyBytes(30)).toBeCloseTo(monthlyBytes(60) * 2, 0);
  });

  it("is zero when polling is off", () => {
    expect(monthlyBytes(0)).toBe(0);
    expect(monthlyBytes(-1)).toBe(0);
  });

  it("formats at a readable precision", () => {
    expect(formatBytes(monthlyBytes(60))).toBe("3.1 MB");
    expect(formatBytes(monthlyBytes(5))).toBe("37 MB");
    expect(formatBytes(0)).toBe("under 0.1 MB");
  });
});

describe("describeSeconds", () => {
  it("uses the largest whole unit", () => {
    expect(describeSeconds(5)).toBe("5 seconds");
    expect(describeSeconds(1)).toBe("1 second");
    expect(describeSeconds(60)).toBe("1 minute");
    expect(describeSeconds(300)).toBe("5 minutes");
    expect(describeSeconds(3600)).toBe("1 hour");
    expect(describeSeconds(86_400)).toBe("24 hours");
    expect(describeSeconds(90)).toBe("90 seconds");
  });
});

describe("describePollSettings", () => {
  it("says what happens and what it costs", () => {
    expect(describePollSettings({ enabled: true, intervalSec: 60 })).toBe(
      "Reads quota every minute · about 3.1 MB a month.",
    );
    expect(describePollSettings({ enabled: true, intervalSec: 30 })).toBe(
      "Reads quota every 30 seconds · about 6.2 MB a month.",
    );
    expect(describePollSettings({ enabled: true, intervalSec: 120 })).toBe(
      "Reads quota every 2 minutes · about 1.5 MB a month.",
    );
  });

  it("explains what off means rather than just saying off", () => {
    expect(describePollSettings({ enabled: false, intervalSec: 60 })).toBe(
      "Polling is off. Quota is only recorded when Claude reports it.",
    );
  });
});
