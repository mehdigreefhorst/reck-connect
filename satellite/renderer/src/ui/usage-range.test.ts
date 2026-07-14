import { describe, expect, it } from "vitest";
import {
  bucketFor,
  binLabelFor,
  drillDown,
  drillUp,
  labelFor,
  nextDisabled,
  periodFor,
  stepPeriod,
} from "./usage-range";

// 2026-07-14 is a Tuesday.
const TUE = new Date(2026, 6, 14, 15, 30);

describe("bucketFor", () => {
  it("maps each granularity to its server bucket", () => {
    expect(bucketFor("day")).toBe("hour");
    expect(bucketFor("week")).toBe("day");
    expect(bucketFor("month")).toBe("day");
    expect(bucketFor("year")).toBe("month");
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

  it("labels bins per view", () => {
    expect(binLabelFor("day", new Date(2026, 6, 14, 9))).toBe("09:00");
    expect(binLabelFor("week", new Date(2026, 6, 14))).toBe("Tue 14");
    expect(binLabelFor("month", new Date(2026, 6, 14))).toBe("14");
    expect(binLabelFor("year", new Date(2026, 6, 1))).toBe("Jul");
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
