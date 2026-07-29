import { describe, expect, it } from "vitest";
import {
  axisLabelFor,
  axisTicksFor,
  indexForTime,
  maxTicksFor,
  subsampleTicks,
  tickTimes,
  tickUnitFor,
} from "./usage-axis";
import { BIN_OPTIONS, bucketSeconds, defaultBinFor, periodFor } from "./usage-range";
import type { Granularity } from "./usage-range";

// 2026-07-14 is a Tuesday; July 2026 has 31 days.
const TUE = new Date(2026, 6, 14, 15, 30);
const sec = (d: Date) => Math.floor(d.getTime() / 1000);

/** The bin starts the daemon would return for a view at a given width —
 * fixed-width bins aligned to the local period start. */
function binsFor(g: Granularity, bucket: string, anchor = TUE): number[] {
  const { start, until } = periodFor(g, anchor);
  const width = bucketSeconds(bucket as never);
  const out: number[] = [];
  if (width === null) {
    // Calendar month bins: one per month in the range.
    for (let d = new Date(start); d < until; d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) {
      out.push(sec(d));
    }
    return out;
  }
  for (let t = sec(start); t < sec(until); t += width) out.push(t);
  return out;
}

describe("tick unit and labels", () => {
  it("measures each view in its own calendar unit", () => {
    expect(tickUnitFor("day")).toBe("hour");
    expect(tickUnitFor("week")).toBe("day");
    expect(tickUnitFor("month")).toBe("day");
    expect(tickUnitFor("year")).toBe("month");
  });

  it("labels an instant for the view", () => {
    expect(axisLabelFor("day", new Date(2026, 6, 14, 9))).toBe("09:00");
    expect(axisLabelFor("week", new Date(2026, 6, 14))).toBe("Tue 14");
    expect(axisLabelFor("month", new Date(2026, 6, 14))).toBe("14");
    expect(axisLabelFor("year", new Date(2026, 6, 1))).toBe("Jul");
  });

  it("keeps the weekday in Week view and drops it in Month view", () => {
    expect(axisLabelFor("week", new Date(2026, 6, 1))).toBe("Wed 1");
    expect(axisLabelFor("month", new Date(2026, 6, 1))).toBe("1");
  });
});

describe("tickTimes", () => {
  it("walks hour boundaries across a day", () => {
    const { start, until } = periodFor("day", TUE);
    const ts = tickTimes("hour", start, until);
    expect(ts).toHaveLength(24);
    expect(ts[0].getHours()).toBe(0);
    expect(ts[23].getHours()).toBe(23);
  });

  it("walks day boundaries across a week, Monday first", () => {
    const { start, until } = periodFor("week", TUE);
    const ts = tickTimes("day", start, until);
    expect(ts).toHaveLength(7);
    expect(ts[0].getDay()).toBe(1); // Monday
    expect(ts.every((t) => t.getHours() === 0)).toBe(true);
  });

  it("walks every day of a 31-day month", () => {
    const { start, until } = periodFor("month", TUE);
    const ts = tickTimes("day", start, until);
    expect(ts).toHaveLength(31);
    expect(ts.map((t) => t.getDate())).toEqual(Array.from({ length: 31 }, (_, i) => i + 1));
  });

  it("walks 12 month boundaries across a year", () => {
    const { start, until } = periodFor("year", TUE);
    expect(tickTimes("month", start, until)).toHaveLength(12);
  });

  it("skips a leading boundary that falls before the range", () => {
    // 09:30 → the 09:00 boundary is behind us, so start at 10:00.
    const start = new Date(2026, 6, 14, 9, 30);
    const until = new Date(2026, 6, 14, 12, 0);
    const ts = tickTimes("hour", start, until);
    expect(ts.map((t) => t.getHours())).toEqual([10, 11]);
  });

  it("excludes the exclusive end", () => {
    const ts = tickTimes("day", new Date(2026, 6, 14), new Date(2026, 6, 16));
    expect(ts.map((t) => t.getDate())).toEqual([14, 15]);
  });
});

describe("subsampleTicks", () => {
  it("keeps everything when it already fits", () => {
    expect(subsampleTicks([1, 2, 3], 5)).toEqual([1, 2, 3]);
  });

  it("thins evenly and always keeps the first", () => {
    const out = subsampleTicks([0, 1, 2, 3, 4, 5, 6, 7, 8, 9], 4);
    expect(out[0]).toBe(0);
    expect(out.length).toBeLessThanOrEqual(4);
    expect(out).toEqual([0, 3, 6, 9]);
  });

  it("degrades to a single tick rather than none", () => {
    expect(subsampleTicks([7, 8, 9], 0)).toEqual([7]);
    expect(subsampleTicks([], 0)).toEqual([]);
  });

  it("derives the budget from the plot width", () => {
    expect(maxTicksFor(700)).toBe(10);
    expect(maxTicksFor(0)).toBe(1); // never zero
  });
});

describe("indexForTime", () => {
  const starts = [0, 3600, 7200, 10800]; // four 1h bins

  it("maps a bin start to its integer index", () => {
    expect(indexForTime(starts, 7200, 3600)).toBe(2);
  });

  it("maps a mid-bin instant to a fractional index", () => {
    expect(indexForTime(starts, 1800, 3600)).toBe(0.5);
    // 03:00 with 4h bins sits three quarters through the first bin —
    // the case that lets a tick land on the hour at any bin width.
    expect(indexForTime([0, 14400], 10800, 4 * 3600)).toBeCloseTo(0.75, 10);
  });

  it("returns null outside the plotted bins", () => {
    expect(indexForTime(starts, -1, 3600)).toBeNull();
    expect(indexForTime(starts, 14400, 3600)).toBeNull(); // past the last bin's end
    expect(indexForTime([], 0, 3600)).toBeNull();
  });

  it("measures calendar month bins from their neighbour", () => {
    const jan = sec(new Date(2026, 0, 1));
    const feb = sec(new Date(2026, 1, 1));
    const mar = sec(new Date(2026, 2, 1));
    expect(indexForTime([jan, feb, mar], feb, null)).toBe(1);
    // Trailing bin has no neighbour; its own month length is used.
    expect(indexForTime([jan, feb, mar], mar, null)).toBe(2);
  });
});

describe("axisTicksFor", () => {
  it("puts a Week tick exactly at each local midnight", () => {
    const { start, until } = periodFor("week", TUE);
    const ticks = axisTicksFor({
      granularity: "week",
      start,
      until,
      binStartsSec: binsFor("week", "30m"),
      binWidthSec: bucketSeconds("30m"),
      plotWidthPx: 700,
    });
    expect(ticks.map((t) => t.label)).toEqual([
      "Mon 13",
      "Tue 14",
      "Wed 15",
      "Thu 16",
      "Fri 17",
      "Sat 18",
      "Sun 19",
    ]);
    // 30-minute bins → 48 per day, so every tick is a whole day apart.
    expect(ticks.map((t) => t.idx)).toEqual([0, 48, 96, 144, 192, 240, 288]);
  });

  // The regression this module exists for: bin width is a density
  // control, so it must not touch the axis vocabulary.
  it.each(["day", "week", "month", "year"] as const)(
    "gives %s view the same labels at every bin width it offers",
    (g) => {
      const { start, until } = periodFor(g, TUE);
      const labelSets = BIN_OPTIONS[g].map((bucket) =>
        axisTicksFor({
          granularity: g,
          start,
          until,
          binStartsSec: binsFor(g, bucket),
          binWidthSec: bucketSeconds(bucket),
          plotWidthPx: 700,
        }).map((t) => t.label),
      );
      for (const set of labelSets) expect(set).toEqual(labelSets[0]);
      expect(labelSets[0].length).toBeGreaterThan(0);
    },
  );

  it("labels Month view in bare dates and Day view on the hour", () => {
    const month = periodFor("month", TUE);
    const monthTicks = axisTicksFor({
      granularity: "month",
      start: month.start,
      until: month.until,
      binStartsSec: binsFor("month", "4h"),
      binWidthSec: bucketSeconds("4h"),
      plotWidthPx: 700,
    });
    expect(monthTicks.map((t) => t.label)).toEqual(["1", "5", "9", "13", "17", "21", "25", "29"]);
    // 4h bins → 6 per day, so day N starts at index (N-1) * 6.
    expect(monthTicks.map((t) => t.idx)).toEqual([0, 24, 48, 72, 96, 120, 144, 168]);

    const day = periodFor("day", TUE);
    const dayTicks = axisTicksFor({
      granularity: "day",
      start: day.start,
      until: day.until,
      binStartsSec: binsFor("day", "5m"),
      binWidthSec: bucketSeconds("5m"),
      plotWidthPx: 700,
    });
    expect(dayTicks.map((t) => t.label)).toEqual([
      "00:00",
      "03:00",
      "06:00",
      "09:00",
      "12:00",
      "15:00",
      "18:00",
      "21:00",
    ]);
  });

  it("asks for fewer labels on a narrow plot", () => {
    const { start, until } = periodFor("month", TUE);
    const call = (plotWidthPx: number) =>
      axisTicksFor({
        granularity: "month",
        start,
        until,
        binStartsSec: binsFor("month", "4h"),
        binWidthSec: bucketSeconds("4h"),
        plotWidthPx,
      });
    expect(call(240).length).toBeLessThan(call(700).length);
    expect(call(240).length).toBeGreaterThan(0);
  });

  it("holds up at each view's default bin width", () => {
    for (const g of ["day", "week", "month", "year"] as const) {
      const { start, until } = periodFor(g, TUE);
      const bucket = defaultBinFor(g);
      const ticks = axisTicksFor({
        granularity: g,
        start,
        until,
        binStartsSec: binsFor(g, bucket),
        binWidthSec: bucketSeconds(bucket),
        plotWidthPx: 700,
      });
      expect(ticks.length).toBeGreaterThan(0);
      // Ticks ascend and stay on the scale, which runs [-0.5, n - 0.5].
      const n = binsFor(g, bucket).length;
      for (let i = 0; i < ticks.length; i++) {
        expect(ticks[i].idx).toBeGreaterThanOrEqual(0);
        expect(ticks[i].idx).toBeLessThanOrEqual(n - 0.5);
        if (i > 0) expect(ticks[i].idx).toBeGreaterThan(ticks[i - 1].idx);
      }
      // Labels are distinct — a repeated label means the unit is too
      // coarse for the view.
      expect(new Set(ticks.map((t) => t.label)).size).toBe(ticks.length);
    }
  });
});
