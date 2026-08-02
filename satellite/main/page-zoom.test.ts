/**
 * Page zoom must stay pinned at 1.
 *
 * This app deliberately replaced Electron's built-in View-menu zoom with a
 * content-only factor (./content-zoom.ts) because page zoom scales the title
 * bar — and the macOS traffic lights, drawn by the OS at a fixed size, then
 * drift out of alignment with it.
 *
 * What that change did NOT do is stop page zoom from being reachable by other
 * means. Chromium still changes the page zoom level on ctrl/⌘+wheel and pinch,
 * and Electron persists the resulting level PER HOST in the session's
 * Preferences file. So one stray pinch permanently scaled a window — title bar
 * and all — across restarts, with no way back: ⌘0/⌘- are bound to the content
 * ladder and never touch the page level.
 *
 * (Observed for real: `partition.per_host_zoom_levels` in the dev userData held
 * `localhost: +2.0`, i.e. every dev window rendering at 1.2^2 = 144%.)
 */
import { describe, expect, it, vi } from "vitest";

import { pinPageZoom } from "./page-zoom";

/** Minimal stand-in for the slice of `WebContents` that `pinPageZoom` uses. */
function fakeContents() {
  const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
  return {
    level: 0,
    setZoomLevel(next: number) {
      this.level = next;
    },
    getZoomLevel() {
      return this.level;
    },
    on(event: string, cb: (...args: unknown[]) => void) {
      const list = handlers.get(event) ?? [];
      list.push(cb);
      handlers.set(event, list);
      return this;
    },
    emit(event: string, ...args: unknown[]) {
      for (const cb of handlers.get(event) ?? []) cb(...args);
    },
    listenerCount(event: string) {
      return (handlers.get(event) ?? []).length;
    },
  };
}

describe("pinPageZoom", () => {
  it("resets a level inherited from the session's persisted per-host zoom", () => {
    const wc = fakeContents();
    // What the session restores for this host before anything renders.
    wc.level = 2;
    pinPageZoom(wc);
    wc.emit("did-finish-load");
    expect(wc.getZoomLevel()).toBe(0);
  });

  it("re-pins on every load, so a reload can't reintroduce the stale level", () => {
    const wc = fakeContents();
    pinPageZoom(wc);
    wc.emit("did-finish-load");
    wc.level = 2;
    wc.emit("did-finish-load");
    expect(wc.getZoomLevel()).toBe(0);
  });

  it("undoes a ctrl+wheel / pinch zoom change", () => {
    const wc = fakeContents();
    pinPageZoom(wc);
    // Chromium applies the change first, then tells us about it.
    wc.level = 0.5;
    wc.emit("zoom-changed", {}, "in");
    expect(wc.getZoomLevel()).toBe(0);
  });

  it("does not write when the level is already pinned", () => {
    const wc = fakeContents();
    const spy = vi.spyOn(wc, "setZoomLevel");
    pinPageZoom(wc);
    wc.emit("did-finish-load");
    expect(spy).not.toHaveBeenCalled();
  });

  it("subscribes once per contents", () => {
    const wc = fakeContents();
    pinPageZoom(wc);
    expect(wc.listenerCount("did-finish-load")).toBe(1);
    expect(wc.listenerCount("zoom-changed")).toBe(1);
  });
});
