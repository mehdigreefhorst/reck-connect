// Page zoom, pinned off.
//
// ./content-zoom.ts replaced Electron's built-in View-menu zoom with a
// content-only factor, because page zoom scales the ENTIRE page — including our
// title bars, which must stay put: every window is `titleBarStyle:
// "hiddenInset"`, so the macOS traffic lights are drawn by the OS at a fixed
// size over our own markup, and a title bar that grows slides out from under
// them.
//
// Rebinding the menu was only half the job. Chromium still owns two other
// routes to the page zoom level — ctrl/⌘+wheel and trackpad pinch — and Electron
// PERSISTS whatever they produce, per host, in the session's Preferences file
// (`partition.per_host_zoom_levels`). So a single stray pinch scaled a window
// permanently, survived restarts, and could not be undone from inside the app:
// ⌘0 / ⌘- drive the content ladder and never touch the page level.
//
// That is not hypothetical — it is how this module came to exist. A dev profile
// was found holding `localhost: +2.0`, i.e. every dev window rendering at
// 1.2^2 = 144%: title bar visibly oversized, and no key combination that would
// bring it back.
//
// So: page zoom is not a feature here, and this pins it to the identity level.
// Zoom in this app means content zoom, one factor, one ladder, one place.

/** Chromium's unzoomed level. Factor is 1.2^level, so 0 means 100%. */
const PINNED_LEVEL = 0;

/**
 * The slice of `Electron.WebContents` this module needs.
 *
 * Declared structurally rather than importing the Electron type so the unit
 * test can drive it with a plain object — this file stays free of the Electron
 * runtime, which is not loadable under vitest.
 */
export interface ZoomableContents {
  getZoomLevel(): number;
  setZoomLevel(level: number): void;
  on(event: string, listener: (...args: never[]) => void): unknown;
}

/**
 * Hold `contents` at 100% page zoom for its lifetime.
 *
 * Two triggers, because there are two ways the level moves:
 *
 *   - `did-finish-load` covers the level the session restores for this host
 *     before the page renders. It re-fires on reload, which is what we want:
 *     the persisted value is re-applied on every navigation, so pinning once at
 *     creation would not hold.
 *   - `zoom-changed` covers live input (ctrl/⌘+wheel, pinch). Chromium applies
 *     the change and then emits, so this reads as a snap-back rather than a
 *     prevention — visually it is a no-op at the frame rate involved.
 *
 * Writes only when the level is actually off, so the common case costs nothing
 * and we don't churn the session's on-disk preferences on every load.
 */
export function pinPageZoom(contents: ZoomableContents): void {
  const repin = (): void => {
    if (contents.getZoomLevel() !== PINNED_LEVEL) contents.setZoomLevel(PINNED_LEVEL);
  };
  contents.on("did-finish-load", repin);
  contents.on("zoom-changed", repin);
}
