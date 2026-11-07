import { describe, it, expect, vi } from "vitest";
import { planSuffixSearch, toMountPath } from "./station-first-search";
import type { StreamingWorkerLike } from "./suffix-search-orchestrator";

const local = vi.fn(() => ({}) as StreamingWorkerLike);
const ssh = vi.fn(() => ({}) as StreamingWorkerLike);
const onStart = vi.fn();

const MIRROR = ["/Users/me/reck/projects/obsidian-brain"];
const STATION = ["/home/pi/projects/obsidian-brain"];

describe("planSuffixSearch", () => {
  it("searches the station first when every root lives on it", () => {
    const plan = planSuffixSearch(
      {
        workerFactory: local,
        progressCapable: false,
        fallback: { factory: ssh, when: () => true, onStart },
      },
      MIRROR,
      STATION,
    );
    expect(plan.stationFirst).toBe(true);
    expect(plan.roots).toEqual(STATION);
    expect(plan.workerFactory).toBe(ssh);
    expect(plan.progressCapable).toBe(false);
    expect(plan.fallback?.factory).toBe(local);
    expect(plan.fallback?.roots).toEqual(MIRROR);
    expect(plan.fallback?.when()).toBe(true);
    expect(plan.fallback?.onStart).toBe(onStart);
  });

  it("keeps the local-first order when the station has no rg", () => {
    const plan = planSuffixSearch(
      { workerFactory: local, progressCapable: true },
      MIRROR,
      STATION,
    );
    expect(plan.stationFirst).toBe(false);
    expect(plan.roots).toEqual(MIRROR);
    expect(plan.workerFactory).toBe(local);
    expect(plan.progressCapable).toBe(true);
    expect(plan.fallback).toBeUndefined();
  });

  it("keeps local-first when a root exists only on this Mac", () => {
    const when = () => true;
    const plan = planSuffixSearch(
      { workerFactory: local, progressCapable: false, fallback: { factory: ssh, when } },
      [...MIRROR, "/Users/me/code/local-only"],
      STATION,
    );
    expect(plan.stationFirst).toBe(false);
    expect(plan.workerFactory).toBe(local);
    expect(plan.fallback?.factory).toBe(ssh);
    expect(plan.fallback?.roots).toEqual(STATION);
  });

  it("disarms the ssh fallback when no root maps to the station", () => {
    const plan = planSuffixSearch(
      { workerFactory: local, progressCapable: false, fallback: { factory: ssh, when: () => true } },
      ["/Users/me/code/app"],
      [],
    );
    expect(plan.stationFirst).toBe(false);
    expect(plan.fallback).toBeUndefined();
  });
});

describe("toMountPath", () => {
  it("maps a station path onto the mount mirror", () => {
    expect(
      toMountPath(
        "/home/pi/projects/obsidian-brain/wiki/concepts/a.md",
        "/Users/me/reck/projects/",
        "/home/pi/projects",
      ),
    ).toBe("/Users/me/reck/projects/obsidian-brain/wiki/concepts/a.md");
  });

  it("leaves mirror and unrelated paths alone", () => {
    const m = "/Users/me/reck/projects/x/a.md";
    expect(toMountPath(m, "/Users/me/reck/projects", "/home/pi/projects")).toBe(m);
    expect(toMountPath("/home/pi/projectsX/a.md", "/m", "/home/pi/projects")).toBe(
      "/home/pi/projectsX/a.md",
    );
    expect(toMountPath("/home/pi/projects/a.md", "/m", null)).toBe(
      "/home/pi/projects/a.md",
    );
  });
});
