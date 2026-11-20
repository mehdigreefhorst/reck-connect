import { describe, it, expect } from "vitest";
import { createSkeleton } from "./skeleton";

describe("createSkeleton", () => {
  it("renders the requested number of placeholder rows", () => {
    const el = createSkeleton({ rows: 4, label: "Loading sessions" });
    expect(el.querySelectorAll(".skeleton-row")).toHaveLength(4);
  });

  it("is announced as a busy status with the given label, and hides the bars", () => {
    const el = createSkeleton({ rows: 2, label: "Loading sessions" });
    expect(el.getAttribute("role")).toBe("status");
    expect(el.getAttribute("aria-busy")).toBe("true");
    expect(el.getAttribute("aria-label")).toBe("Loading sessions");
    for (const row of el.querySelectorAll(".skeleton-row")) {
      expect(row.getAttribute("aria-hidden")).toBe("true");
    }
  });

  it("varies bar widths so the block doesn't read as a solid slab", () => {
    const el = createSkeleton({ rows: 6, label: "x" });
    const widths = new Set(
      [...el.querySelectorAll<HTMLElement>(".skeleton-bar")].map((b) => b.style.width),
    );
    expect(widths.size).toBeGreaterThan(1);
  });

  it("is deterministic — the same input renders the same widths", () => {
    const widths = (el: HTMLElement) =>
      [...el.querySelectorAll<HTMLElement>(".skeleton-bar")].map((b) => b.style.width);
    expect(widths(createSkeleton({ rows: 5, label: "x" }))).toEqual(
      widths(createSkeleton({ rows: 5, label: "x" })),
    );
  });

  it("applies the variant as a class for per-surface layout", () => {
    expect(createSkeleton({ rows: 1, label: "x", variant: "turns" }).classList.contains("skeleton--turns")).toBe(true);
    expect(createSkeleton({ rows: 1, label: "x" }).classList.contains("skeleton--list")).toBe(true);
  });

  it("clamps a nonsensical row count", () => {
    expect(createSkeleton({ rows: 0, label: "x" }).querySelectorAll(".skeleton-row")).toHaveLength(1);
    expect(createSkeleton({ rows: 500, label: "x" }).querySelectorAll(".skeleton-row").length).toBeLessThanOrEqual(20);
  });
});
