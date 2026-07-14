import { describe, expect, it } from "vitest";
import {
  BIN_OPTIONS,
  binLabelFor,
  binOptionLabel,
  bucketSeconds,
  defaultBinFor,
  drillDown,
  drillUp,
  labelFor,
  nextDisabled,
  periodFor,
  stepPeriod,
} from "./usage-range";

// 2026-07-14 is a Tuesday.
const TUE = new Date(2026, 6, 14, 15, 30);

describe("bin widths", () => {
  it("defaults per view", () => {
    expect(defaultBinFor("day")).toBe("1h");
    expect(defaultBinFor("week")).toBe("1d");
    expect(defaultBinFor("month")).toBe("1d");
    expect(defaultBinFor("year")).toBe("month");
  });

  it("every option list contains its default", () => {
    for (const g of ["day", "week", "month", "year"] as const) {
      expect(BIN_OPTIONS[g]).toContain(defaultBinFor(g));
    }
  });

  it("parses bucket widths to seconds", () => {
    expect(bucketSeconds("1m")).toBe(60);
    expect(bucketSeconds("30m")).toBe(1800);
    expect(bucketSeconds("4h")).toBe(4 * 3600);
    expect(bucketSeconds("1d")).toBe(86400);
    expect(bucketSeconds("hour")).toBe(3600); // legacy
    expect(bucketSeconds("day")).toBe(86400); // legacy
    expect(bucketSeconds("month")).toBeNull();
  });

  it("keeps every offered choice at a sane bin count for its view", () => {
    const periodSec = { day: 86400, week: 7 * 86400, month: 31 * 86400, year: 366 * 86400 };
    for (const g of ["day", "week", "month", "year"] as const) {
      for (const b of BIN_OPTIONS[g]) {
        const sec = bucketSeconds(b);
        if (sec === null) continue; // calendar month bins
        expect(periodSec[g] / sec).toBeLessThanOrEqual(2016);
      }
    }
  });

  it("labels bin options", () => {
    expect(binOptionLabel("1m")).toBe("1 min");
    expect(binOptionLabel("30m")).toBe("30 min");
    expect(binOptionLabel("1h")).toBe("1 hour");
    expect(binOptionLabel("4h")).toBe("4 hours");
    expect(binOptionLabel("1d")).toBe("1 day");
    expect(binOptionLabel("month")).toBe("Month");
  });
});

describe("periodFor", () => {
  it("day snaps to local midnight", () => {
    const { start, until } = periodFor("day", TUE);
    expect(start).toEqual(new Date(2026, 6, 14));
    expect(until).toEqual(new Date(2026, 6, 15));
  });

  it("week snaps to Monday", () => {
    const { start, until } = periodFor("week", TUE);
    expect(start).toEqual(new Date(2026, 6, 13)); // Mon 13 Jul
    expect(until).toEqual(new Date(2026, 6, 20));
  });

  it("week containing a Sunday snaps back to the preceding Monday", () => {
    const sun = new Date(2026, 6, 19, 9, 0); // Sun 19 Jul
    const { start } = periodFor("week", sun);
    expect(start).toEqual(new Date(2026, 6, 13));
  });

  it("month snaps to the 1st", () => {
    const { start, until } = periodFor("month", TUE);
    expect(start).toEqual(new Date(2026, 6, 1));
    expect(until).toEqual(new Date(2026, 7, 1));
  });

  it("year snaps to Jan 1", () => {
    const { start, until } = periodFor("year", TUE);
    expect(start).toEqual(new Date(2026, 0, 1));
    expect(until).toEqual(new Date(2027, 0, 1));
  });
});

describe("stepPeriod", () => {
  it("steps days across a month boundary", () => {
    expect(stepPeriod("day", new Date(2026, 6, 31), 1)).toEqual(new Date(2026, 7, 1));
    expect(stepPeriod("day", new Date(2026, 7, 1), -1)).toEqual(new Date(2026, 6, 31));
  });

  it("steps weeks by 7 days", () => {
    expect(stepPeriod("week", new Date(2026, 6, 13), 1)).toEqual(new Date(2026, 6, 20));
  });

  it("steps months across a year boundary", () => {
    expect(stepPeriod("month", new Date(2026, 11, 1), 1)).toEqual(new Date(2027, 0, 1));
    expect(stepPeriod("month", new Date(2026, 0, 1), -1)).toEqual(new Date(2025, 11, 1));
  });

  it("steps years", () => {
    expect(stepPeriod("year", new Date(2026, 0, 1), 1)).toEqual(new Date(2027, 0, 1));
  });
});

describe("drill ladder", () => {
  it("drills down year→month→day and week→day; day is the floor", () => {
    expect(drillDown("year")).toBe("month");
    expect(drillDown("month")).toBe("day");
    expect(drillDown("week")).toBe("day");
    expect(drillDown("day")).toBeNull();
  });

  it("drills up day→week→month→year; year is the ceiling", () => {
    expect(drillUp("day")).toBe("week");
    expect(drillUp("week")).toBe("month");
    expect(drillUp("month")).toBe("year");
    expect(drillUp("year")).toBeNull();
  });
});

describe("labels", () => {
  it("labels each period", () => {
    expect(labelFor("day", new Date(2026, 6, 14))).toBe("Tue 14 Jul 2026");
    expect(labelFor("week", new Date(2026, 6, 13))).toBe("Week of 13 Jul 2026");
    expect(labelFor("month", new Date(2026, 6, 1))).toBe("July 2026");
    expect(labelFor("year", new Date(2026, 0, 1))).toBe("2026");
  });

  it("labels bins by view and width", () => {
    // Default widths.
    expect(binLabelFor("day", "1h", new Date(2026, 6, 14, 9))).toBe("09:00");
    expect(binLabelFor("week", "1d", new Date(2026, 6, 14))).toBe("Tue 14");
    expect(binLabelFor("month", "1d", new Date(2026, 6, 14))).toBe("14");
    expect(binLabelFor("year", "month", new Date(2026, 6, 1))).toBe("Jul");
    // Fine widths keep the clock time; multi-day views prefix the day.
    expect(binLabelFor("day", "5m", new Date(2026, 6, 14, 9, 35))).toBe("09:35");
    expect(binLabelFor("week", "1h", new Date(2026, 6, 14, 6))).toBe("Tue 06:00");
    expect(binLabelFor("month", "4h", new Date(2026, 6, 14, 12))).toBe("14 · 12:00");
    // Year with day bins shows the date.
    expect(binLabelFor("year", "1d", new Date(2026, 6, 14))).toBe("14 Jul");
  });
});

describe("nextDisabled", () => {
  it("disables paging into the future, allows the past", () => {
    const now = new Date(2026, 6, 14, 12, 0);
    expect(nextDisabled("day", new Date(2026, 6, 14), now)).toBe(true);
    expect(nextDisabled("day", new Date(2026, 6, 12), now)).toBe(false);
    expect(nextDisabled("month", new Date(2026, 6, 1), now)).toBe(true);
    expect(nextDisabled("month", new Date(2026, 5, 1), now)).toBe(false);
  });
});
