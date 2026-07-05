// Satellite-side host that frames a project's live Vite component preview
// (Phase B) in a cross-origin `<iframe>`. It drives the per-project dev
// server through the ApiClient preview methods (Task 9), heartbeats to keep
// the daemon-managed server warm while the surface is mounted, and degrades
// to an in-surface panel (plus `onError`) when the preview is unavailable.
//
// Cross-origin isolation is *structural* here: the iframe points at the
// station host (a different origin than the satellite renderer), so the
// component runs in its own realm without us adding a `sandbox` attribute.
// Do NOT add `sandbox` (and certainly not `allow-same-origin`) — that would
// weaken, not strengthen, the boundary.
//
// RAM discipline: the dev server is shared across every open preview of the
// same project and is idle-reaped by the daemon. `dispose()` therefore tears
// down our DOM + timers but never calls `stopPreview` — doing so would kill a
// server other panes may still be framing.

import type { PreviewStatus } from "@proto/proto";

/** 30s keep-warm poll cadence while the preview is mounted. */
const HEARTBEAT_MS = 30_000;
/** ~15s grace for the iframe to emit `load` before we treat it as failed. */
const LOAD_WATCHDOG_MS = 15_000;
/** Shown when the daemon reports no specific error string. */
const DEFAULT_ERROR = "Live preview unavailable";

/**
 * Structural shape of a preview status. Kept as an alias of the real
 * `PreviewStatus` so callers can pass either name interchangeably.
 */
export type PreviewStatusLike = PreviewStatus;

/**
 * The subset of the ApiClient preview surface this host depends on. An actual
 * `ApiClient` is structurally assignable to this.
 */
export interface PreviewApi {
  startPreview(
    projectId: string,
    opts?: { hmrHost?: string },
  ): Promise<PreviewStatus>;
  getPreview(projectId: string): Promise<PreviewStatus>;
  stopPreview(projectId: string): Promise<void>;
}

export interface ComponentPreviewOptions {
  api: PreviewApi;
  projectId: string;
  /** Bare host from `stationHostFromUrl(settings.station.url)`. */
  stationHost: string;
  /** Project-root-relative path of the component file to preview. */
  targetRelPath: string;
  /** Invoked with a human-readable message when the preview degrades. */
  onError?(message: string): void;
  /** Usually === `stationHost`; forwarded to `startPreview` for Vite HMR. */
  hmrHost?: string;
}

export interface ComponentPreviewHandle {
  el: HTMLElement;
  dispose(): void;
}

/**
 * Build a live-preview surface. Returns synchronously with a mounted spinner;
 * the iframe (or degrade panel) is swapped in once `startPreview` settles.
 */
export function createComponentPreview(
  opts: ComponentPreviewOptions,
): ComponentPreviewHandle {
  const { api, projectId, stationHost, targetRelPath, onError } = opts;

  const el = document.createElement("div");
  el.className = "file-viewer-component";

  const spinner = document.createElement("div");
  spinner.className = "file-viewer-component-spinner";
  spinner.setAttribute("role", "status");
  spinner.setAttribute("aria-label", "Loading live preview");
  el.appendChild(spinner);

  let disposed = false;
  let heartbeat: ReturnType<typeof setInterval> | null = null;
  let watchdog: ReturnType<typeof setTimeout> | null = null;
  let iframe: HTMLIFrameElement | null = null;
  let degraded = false;

  const clearWatchdog = (): void => {
    if (watchdog !== null) {
      clearTimeout(watchdog);
      watchdog = null;
    }
  };

  // Degrade path: drop the iframe/spinner, render a panel, notify once.
  // Deliberately leaves the heartbeat alone — its lifetime is owned solely by
  // `dispose()` so a spurious watchdog trip can't stop keep-warm polling.
  const fail = (message: string): void => {
    if (disposed || degraded) return;
    console.warn(`[preview] degraded project=${projectId}: ${message}`);
    degraded = true;
    clearWatchdog();
    spinner.remove();
    if (iframe !== null) {
      iframe.remove();
      iframe = null;
    }
    const panel = document.createElement("div");
    panel.className = "file-viewer-component-error";
    panel.setAttribute("role", "alert");
    panel.textContent = message;
    el.appendChild(panel);
    onError?.(message);
  };

  // Ready path: frame the station dev server and start keep-warm polling.
  const showFrame = (status: PreviewStatus): void => {
    if (disposed) return;
    spinner.remove();

    const frame = document.createElement("iframe");
    // Exact cross-origin URL — no `sandbox` attribute (see file header).
    const src = `http://${stationHost}:${status.port}/?target=${encodeURIComponent(
      targetRelPath,
    )}`;
    console.info(`[preview] iframe project=${projectId} src=${src}`);
    frame.setAttribute("src", src);
    frame.className = "file-viewer-component-frame";
    frame.setAttribute("title", "Live component preview");
    frame.addEventListener("load", clearWatchdog);
    frame.addEventListener("error", () =>
      fail(status.error || DEFAULT_ERROR),
    );
    el.appendChild(frame);
    iframe = frame;

    // If `load` never arrives, the server is wedged/unreachable — degrade.
    watchdog = setTimeout(() => {
      watchdog = null;
      fail(status.error || DEFAULT_ERROR);
    }, LOAD_WATCHDOG_MS);

    // Keep the shared, idle-reaped server warm while we're mounted.
    heartbeat = setInterval(() => {
      void api.getPreview(projectId).catch(() => {});
    }, HEARTBEAT_MS);
  };

  const hmrHost = opts.hmrHost ?? stationHost;
  console.info(
    `[preview] startPreview project=${projectId} hmrHost=${hmrHost} target=${targetRelPath}`,
  );
  void api.startPreview(projectId, { hmrHost }).then(
    (status) => {
      if (disposed) return;
      console.info(
        `[preview] startPreview project=${projectId} -> ` +
          `running=${status.running} ready=${status.ready} port=${status.port}` +
          (status.error ? ` error=${status.error}` : ""),
      );
      if (status.ready) showFrame(status);
      else fail(status.error || DEFAULT_ERROR);
    },
    (err: unknown) => {
      if (disposed) return;
      const message =
        err instanceof Error && err.message ? err.message : DEFAULT_ERROR;
      console.warn(
        `[preview] startPreview project=${projectId} threw: ${message}`,
      );
      fail(message);
    },
  );

  return {
    el,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      if (heartbeat !== null) {
        clearInterval(heartbeat);
        heartbeat = null;
      }
      clearWatchdog();
      el.replaceChildren();
      el.remove();
    },
  };
}
