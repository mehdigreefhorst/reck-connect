import { describe, expect, it } from "vitest";
import {
  buildAdvancedParams,
  datasetDescription,
  isRawDataset,
  localMidnight,
  paramsForCurrentView,
  supportsProjectFilter,
  toDateInputValue,
} from "./usage-export";

const CET = 120; // UTC+2
const EST = -300; // UTC-5

describe("localMidnight", () => {
  it("resolves a date to that day's LOCAL midnight, not UTC midnight", () => {
    // The whole reason this exists instead of new Date(str): a bare date
    // parses as UTC, which would shift every export by the user's offset.
    const utcMidnight = Date.UTC(2026, 6, 23) / 1000;
    expect(localMidnight("2026-07-23", 0)).toBe(utcMidnight);
    expect(localMidnight("2026-07-23", CET)).toBe(utcMidnight - 2 * 3600);
    expect(localMidnight("2026-07-23", EST)).toBe(utcMidnight + 5 * 3600);
  });

  it("rejects anything a date input wouldn't produce", () => {
    for (const bad of ["", "23-07-2026", "2026/07/23", "2026-7-3", "nonsense"]) {
      expect(localMidnight(bad, 0)).toBeNull();
    }
  });
});

describe("toDateInputValue", () => {
  it("round-trips with localMidnight", () => {
    for (const tz of [0, CET, EST, 330]) {
      const unix = localMidnight("2026-07-23", tz)!;
      expect(toDateInputValue(unix, tz)).toBe("2026-07-23");
    }
  });

  it("uses the caller's local day, not UTC's", () => {
    // 22:30 UTC on the 22nd is already the 23rd at UTC+2.
    const unix = Date.UTC(2026, 6, 22, 22, 30) / 1000;
    expect(toDateInputValue(unix, 0)).toBe("2026-07-22");
    expect(toDateInputValue(unix, CET)).toBe("2026-07-23");
  });
});

describe("dataset predicates", () => {
  it("marks raw datasets, which have no interval", () => {
    expect(isRawDataset("binned")).toBe(false);
    expect(isRawDataset("turns")).toBe(true);
    expect(isRawDataset("quota")).toBe(true);
  });

  it("excludes quota from project filtering, since quota is account-level", () => {
    expect(supportsProjectFilter("binned")).toBe(true);
    expect(supportsProjectFilter("turns")).toBe(true);
    expect(supportsProjectFilter("quota")).toBe(false);
  });

  it("describes every dataset", () => {
    for (const d of ["binned", "turns", "quota"] as const) {
      expect(datasetDescription(d).length).toBeGreaterThan(20);
    }
  });
});

describe("paramsForCurrentView", () => {
  it("mirrors the chart exactly", () => {
    const params = paramsForCurrentView({
      since: 1000,
      until: 2000,
      bucket: "1h",
      projectId: "proj-1",
      tzOffsetMin: CET,
    });
    expect(params).toEqual({
      dataset: "binned",
      since: 1000,
      until: 2000,
      bucket: "1h",
      projectId: "proj-1",
      tzOffsetMin: CET,
    });
  });

  it("omits an empty project filter rather than sending a blank one", () => {
    const params = paramsForCurrentView({
      since: 1000,
      until: 2000,
      bucket: "1h",
      projectId: "",
      tzOffsetMin: 0,
    });
    expect(params.projectId).toBeUndefined();
  });
});

describe("buildAdvancedParams", () => {
  const base = {
    dataset: "binned",
    fromDate: "2026-07-01",
    toDate: "2026-07-07",
    bucket: "1d",
    projectId: "",
  } as const;

  it("treats the end date as inclusive", () => {
    // A user picking 1st–7th means through the end of the 7th, so `until`
    // lands on the 8th's midnight. The daemon's range is half-open.
    const res = buildAdvancedParams({ ...base }, 0);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.params.since).toBe(localMidnight("2026-07-01", 0));
    expect(res.params.until).toBe(localMidnight("2026-07-08", 0));
  });

  it("allows a single-day range", () => {
    // Same start and end must export that one day, not nothing.
    const res = buildAdvancedParams({ ...base, toDate: "2026-07-01" }, 0);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.params.until - res.params.since).toBe(86400);
  });

  it("rejects a backwards range with a human message", () => {
    const res = buildAdvancedParams({ ...base, fromDate: "2026-07-09" }, 0);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/on or before/i);
  });

  it("rejects missing dates", () => {
    const res = buildAdvancedParams({ ...base, fromDate: "" }, 0);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/start and an end date/i);
  });

  it("requires an interval for binned exports", () => {
    const res = buildAdvancedParams({ ...base, bucket: "" }, 0);
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error).toMatch(/interval/i);
  });

  it("omits the interval entirely for raw datasets", () => {
    const res = buildAdvancedParams({ ...base, dataset: "turns", bucket: "1d" }, 0);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.params.bucket).toBeUndefined();
  });

  it("drops the project filter on quota, which is account-level", () => {
    const res = buildAdvancedParams({ ...base, dataset: "quota", projectId: "proj-1" }, 0);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.params.projectId).toBeUndefined();
  });

  it("keeps the project filter on turns", () => {
    const res = buildAdvancedParams({ ...base, dataset: "turns", projectId: "proj-1" }, 0);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.params.projectId).toBe("proj-1");
  });

  it("anchors the range to the caller's zone", () => {
    const res = buildAdvancedParams({ ...base }, CET);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.params.since).toBe(localMidnight("2026-07-01", CET));
    expect(res.params.tzOffsetMin).toBe(CET);
  });
});
