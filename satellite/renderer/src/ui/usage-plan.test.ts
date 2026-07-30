import { describe, expect, it } from "vitest";
import {
  currentTierLabel,
  planLabel,
  planRangeLabel,
  planShares,
  tierLabel,
} from "./usage-plan";

describe("planLabel", () => {
  it("maps known tiers to display text", () => {
    expect(planLabel("max")).toBe("Max");
    expect(planLabel("pro")).toBe("Pro");
    expect(planLabel("team")).toBe("Team");
    expect(planLabel("enterprise")).toBe("Enterprise");
  });

  it("calls an API-key/3P session 'API', not 'none'", () => {
    expect(planLabel("none")).toBe("API");
  });

  it("title-cases a tier it has never seen rather than dropping it", () => {
    expect(planLabel("ultra")).toBe("Ultra");
  });

  it("returns empty for unknown and missing", () => {
    expect(planLabel("unknown")).toBe("");
    expect(planLabel(undefined)).toBe("");
    expect(planLabel("")).toBe("");
  });
});

describe("planShares", () => {
  it("orders by day count, largest first", () => {
    const got = planShares({ pro: 5, max: 40, free: 10 });
    expect(got.map((s) => s.subscription)).toEqual(["max", "free", "pro"]);
    expect(got.map((s) => s.days)).toEqual([40, 10, 5]);
  });

  it("breaks ties alphabetically so render order is stable", () => {
    const got = planShares({ pro: 7, max: 7, free: 7 });
    expect(got.map((s) => s.subscription)).toEqual(["free", "max", "pro"]);
  });

  it("drops unknown days and zero counts", () => {
    const got = planShares({ max: 3, unknown: 99, pro: 0 });
    expect(got.map((s) => s.subscription)).toEqual(["max"]);
  });

  it("handles missing input", () => {
    expect(planShares(undefined)).toEqual([]);
    expect(planShares({})).toEqual([]);
  });
});

describe("planRangeLabel", () => {
  it("shows just the tier when the range is on one plan", () => {
    expect(planRangeLabel({ max: 30 })).toBe("Max");
  });

  it("ignores unknown days when deciding the range is single-tier", () => {
    // Days before tracking started must not make a single-plan range
    // look mixed.
    expect(planRangeLabel({ max: 30, unknown: 12 })).toBe("Max");
  });

  it("shows the day composition when the range spans tiers", () => {
    expect(planRangeLabel({ max: 40, free: 10, pro: 5 })).toBe(
      "40d Max · 10d Free · 5d Pro",
    );
  });

  it("returns empty when there is nothing to say", () => {
    expect(planRangeLabel(undefined)).toBe("");
    expect(planRangeLabel({})).toBe("");
    expect(planRangeLabel({ unknown: 30 })).toBe("");
  });
});

describe("tierLabel", () => {
  it("distinguishes the Max multipliers, which `subscription` cannot", () => {
    expect(tierLabel("default_claude_max_5x")).toBe("Max 5x");
    expect(tierLabel("default_claude_max_20x")).toBe("Max 20x");
  });

  it("reads a plain pro entitlement", () => {
    expect(tierLabel("default_claude_pro")).toBe("Pro");
  });

  it("parses a tier it has never seen rather than dropping it", () => {
    // A tier Anthropic adds later must stay readable — the alternative is
    // the label silently disappearing on an account we can't name.
    expect(tierLabel("default_claude_max_50x")).toBe("Max 50x");
    expect(tierLabel("default_claude_team_premium")).toBe("Team Premium");
  });

  it("returns empty for missing, so callers can hide the element", () => {
    expect(tierLabel(undefined)).toBe("");
    expect(tierLabel("")).toBe("");
  });
});

describe("currentTierLabel", () => {
  const d = (day: number, subscription: string, rate_limit_tier?: string) => ({
    day,
    subscription,
    rate_limit_tier,
  });

  it("prefers the entitlement over a stale subscriptionType", () => {
    // The bug this whole change exists for: the credential blob still says
    // "pro" long after the account moved to Max 5x.
    expect(currentTierLabel([d(1, "pro", "default_claude_max_5x")])).toBe("Max 5x");
  });

  it("falls back to the subscription when no tier was recorded", () => {
    expect(currentTierLabel([d(1, "max")])).toBe("Max");
    expect(currentTierLabel([d(1, "none")])).toBe("API");
  });

  it("reports the LAST day, not the composition", () => {
    // The footer's "peak 5h 87%" is a percentage OF a tier, so the one that
    // makes it meaningful is whatever was in force at the range end.
    expect(
      currentTierLabel([
        d(1, "pro", "default_claude_pro"),
        d(2, "max", "default_claude_max_5x"),
      ]),
    ).toBe("Max 5x");
  });

  it("returns empty for no data and for days that predate tracking", () => {
    expect(currentTierLabel([])).toBe("");
    expect(currentTierLabel(undefined)).toBe("");
    expect(currentTierLabel([d(1, "unknown")])).toBe("");
  });
});

describe("planRangeLabel with plan days", () => {
  const d = (day: number, subscription: string, rate_limit_tier?: string) => ({
    day,
    subscription,
    rate_limit_tier,
  });

  it("uses entitlements when days carry them", () => {
    expect(
      planRangeLabel({ max: 2 }, [
        d(1, "max", "default_claude_max_5x"),
        d(2, "max", "default_claude_max_5x"),
      ]),
    ).toBe("Max 5x");
  });

  it("composes a range that spans two Max multipliers", () => {
    // `subscription` reads "max" for every one of these days, so without the
    // entitlement this range would flatten to a single misleading "Max".
    expect(
      planRangeLabel({ max: 3 }, [
        d(1, "max", "default_claude_max_20x"),
        d(2, "max", "default_claude_max_5x"),
        d(3, "max", "default_claude_max_5x"),
      ]),
    ).toBe("2d Max 5x · 1d Max 20x");
  });

  it("falls back to the subscription summary when no days are given", () => {
    expect(planRangeLabel({ max: 40, pro: 5 })).toBe("40d Max · 5d Pro");
  });

  it("falls back when the days carry no entitlements at all", () => {
    expect(planRangeLabel({ pro: 2 }, [d(1, "pro"), d(2, "pro")])).toBe("Pro");
  });
});
