// satellite/renderer/src/viewer/ImageRenderer.ts
// The file viewer's image surface: the whole popup body IS the picture.
//
// SVG SAFETY — the one rule that must never be relaxed. The image is always
// rendered through `<img src>`, never inlined, never via innerHTML, never
// through <object>/<embed>/<iframe>. In an <img>, Chromium loads SVG in
// SECURE STATIC MODE: scripts don't execute, external references (<use
// href>, @import, webfonts) don't load, and SMIL animation is disabled.
// That is a stronger guarantee than any sanitizer, and it's free — which is
// why DOMPurify is deliberately not involved here. Inlining a hostile .svg
// would hand it a live DOM.
//
// NOT THE LIGHTBOX. `Lightbox.ts` is a modal overlay for images *embedded in*
// rendered markdown, registered from renderedDom.ts's mount(). This surface
// never calls createRenderedDom, so the lightbox is simply not wired in —
// and must not be, or two click handlers would fight over the same <img>.
//
// SIZING — all lengths here are %, vh or auto, NEVER em. `.file-viewer-body`
// is `font-size: calc(1rem * var(--content-zoom))`, so any em-based length
// would let content-zoom silently rescale what is supposed to be 1:1.

const BASE_CLASS = "file-viewer-image";

/** Past this, an onerror is far more likely to be a decode-capacity failure
 *  than a corrupt file — a small compressed image can decode to gigabytes,
 *  which no byte cap can predict. Only changes the error copy. */
const LIKELY_TOO_BIG_TO_DECODE_BYTES = 20 * 1024 * 1024;

/** A click that moved more than this is a pan, not a zoom gesture. */
const DRAG_SLOP_PX = 4;

export type ImageFitMode = "fit" | "actual";

export type ImageFailureReason =
  | "not-found"
  | "out-of-roots"
  | "too-large"
  | "unsupported"
  | "decode-failed"
  | "too-large-to-decode"
  | "is-directory"
  | "io-error";

export interface ImageRendererOptions {
  /** Absolute path — supplies the alt text and the external-open target. */
  filePath: string;
  /** `reck-img://` URL, always minted in main. */
  src: string;
  byteSize: number;
  onOpenExternally?(): void;
}

export type ImageSettled =
  | { ok: true; width: number; height: number }
  | { ok: false; reason: ImageFailureReason };

export interface ImageRendererHandle {
  readonly el: HTMLElement;
  /** Resolves once the image loads or fails. The seam that makes this
   *  testable in jsdom, which has no decoder. */
  whenSettled(): Promise<ImageSettled>;
  getFitMode(): ImageFitMode;
  setFitMode(mode: ImageFitMode): void;
  dispose(): void;
}

export function formatByteSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kb = bytes / 1024;
  if (kb < 1024) return kb < 10 ? `${kb.toFixed(1)} KB` : `${Math.round(kb)} KB`;
  const mb = kb / 1024;
  return mb < 10 ? `${mb.toFixed(1)} MB` : `${Math.round(mb)} MB`;
}

/** `1920 × 1080 · 412 KB`, or just the size when dimensions are unknown
 *  (an SVG with only a viewBox reports naturalWidth 0). */
export function formatImageMeta(
  width: number,
  height: number,
  bytes: number,
): string {
  const size = formatByteSize(bytes);
  if (!width || !height) return size;
  return `${width} × ${height} · ${size}`;
}

export interface AnchorScrollOpts {
  /** Where in the displayed image the user clicked, 0..1 on each axis. */
  clickFrac: { x: number; y: number };
  natural: { width: number; height: number };
  stage: { width: number; height: number };
}

/**
 * Scroll offsets that keep the clicked point under the cursor when zooming
 * from fit to 1:1. Pure so the arithmetic is testable without layout.
 */
export function anchorScrollFor(opts: AnchorScrollOpts): {
  left: number;
  top: number;
} {
  const axis = (frac: number, natural: number, stage: number): number => {
    const overflow = natural - stage;
    if (overflow <= 0) return 0;
    return Math.round(Math.min(overflow, Math.max(0, frac * natural - stage / 2)));
  };
  return {
    left: axis(opts.clickFrac.x, opts.natural.width, opts.stage.width),
    top: axis(opts.clickFrac.y, opts.natural.height, opts.stage.height),
  };
}

const basenameOf = (p: string): string => p.split("/").filter(Boolean).pop() ?? p;

const ERROR_COPY: Record<ImageFailureReason, (filePath: string) => string> = {
  "not-found": (p) => `Image not found: ${p}`,
  "out-of-roots": () =>
    "This image is outside the folders the viewer is allowed to open. Add its folder in Settings → File viewer.",
  "too-large": () => "This image is larger than the viewer's 100 MB limit.",
  unsupported: (p) =>
    `${(p.match(/\.[^.]+$/)?.[0] ?? "This format").toLowerCase()} images can't be displayed yet.`,
  "decode-failed": () =>
    "This file couldn't be decoded as an image. It may be corrupt, or named with the wrong extension.",
  "too-large-to-decode": () =>
    "This image is too large for the viewer to decode. Open it in your system viewer instead.",
  "is-directory": (p) => `${p} is a folder, not an image.`,
  "io-error": (p) => `Couldn't read ${p}.`,
};

/** Reasons where there is nothing to open, or opening isn't permitted. */
const NO_EXTERNAL_OPEN: ReadonlySet<ImageFailureReason> = new Set([
  "not-found",
  "out-of-roots",
  "is-directory",
]);

export interface RenderImageErrorOptions {
  reason: ImageFailureReason;
  filePath: string;
  onOpenExternally?(): void;
}

export function renderImageError(
  container: HTMLElement,
  opts: RenderImageErrorOptions,
): void {
  container.innerHTML = "";
  container.appendChild(buildErrorEl(opts));
}

function buildErrorEl(opts: RenderImageErrorOptions): HTMLElement {
  const box = document.createElement("div");
  box.className = "file-viewer-error file-viewer-image-error";

  const msg = document.createElement("p");
  msg.className = "file-viewer-image-error-text";
  msg.textContent = ERROR_COPY[opts.reason](opts.filePath);
  box.appendChild(msg);

  if (opts.onOpenExternally && !NO_EXTERNAL_OPEN.has(opts.reason)) {
    box.appendChild(buildOpenButton(opts.onOpenExternally));
  }
  return box;
}

function buildOpenButton(onClick: () => void): HTMLButtonElement {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.className = "file-viewer-image-open";
  btn.textContent = "Open in system viewer";
  btn.addEventListener("click", onClick);
  return btn;
}

export function mountImage(
  container: HTMLElement,
  opts: ImageRendererOptions,
): ImageRendererHandle {
  container.innerHTML = "";

  const root = document.createElement("div");
  root.className = BASE_CLASS;
  root.setAttribute("data-fit", "fit");
  root.setAttribute("data-zoomable", "false");

  const stage = document.createElement("div");
  stage.className = "file-viewer-image-stage";

  const img = document.createElement("img");
  img.className = "file-viewer-image-img";
  img.alt = basenameOf(opts.filePath);
  // decoding=async keeps a large decode off the main thread; the popup's
  // header and meta bar paint while the image is still being decoded.
  img.decoding = "async";

  const meta = document.createElement("div");
  meta.className = "file-viewer-image-meta";
  const metaText = document.createElement("span");
  metaText.className = "file-viewer-image-meta-text";
  // Byte size is known from the IPC immediately; dimensions only after decode.
  metaText.textContent = formatImageMeta(0, 0, opts.byteSize);
  meta.appendChild(metaText);
  if (opts.onOpenExternally) meta.appendChild(buildOpenButton(opts.onOpenExternally));

  stage.appendChild(img);
  root.append(stage, meta);
  container.appendChild(root);

  let fit: ImageFitMode = "fit";
  let natural = { width: 0, height: 0 };
  let zoomable = false;
  let disposed = false;

  let resolveSettled: (v: ImageSettled) => void;
  const settled = new Promise<ImageSettled>((r) => {
    resolveSettled = r;
  });

  const recomputeZoomable = (): void => {
    zoomable =
      natural.width > 0 &&
      (natural.width > stage.clientWidth || natural.height > stage.clientHeight);
    root.setAttribute("data-zoomable", String(zoomable));
    if (!zoomable && fit === "actual") setFitMode("fit");
  };

  function setFitMode(mode: ImageFitMode): void {
    fit = mode;
    root.setAttribute("data-fit", mode);
  }

  const onLoad = (): void => {
    natural = { width: img.naturalWidth, height: img.naturalHeight };
    metaText.textContent = formatImageMeta(natural.width, natural.height, opts.byteSize);
    recomputeZoomable();
    resolveSettled({ ok: true, width: natural.width, height: natural.height });
  };

  const onError = (): void => {
    const reason: ImageFailureReason =
      opts.byteSize > LIKELY_TOO_BIG_TO_DECODE_BYTES
        ? "too-large-to-decode"
        : "decode-failed";
    stage.replaceChildren(
      buildErrorEl({ reason, filePath: opts.filePath, onOpenExternally: opts.onOpenExternally }),
    );
    meta.remove();
    resolveSettled({ ok: false, reason });
  };

  // Drag detection: panning a zoomed image ends in a click, which would
  // otherwise snap it back to fit mid-gesture.
  let downAt: { x: number; y: number } | null = null;
  const onMouseDown = (ev: MouseEvent): void => {
    downAt = { x: ev.clientX, y: ev.clientY };
  };

  const onClick = (ev: MouseEvent): void => {
    // Cmd/Ctrl+click means "open this" throughout the viewer — don't overload it.
    if (ev.metaKey || ev.ctrlKey) return;
    if (downAt) {
      const moved =
        Math.abs(ev.clientX - downAt.x) > DRAG_SLOP_PX ||
        Math.abs(ev.clientY - downAt.y) > DRAG_SLOP_PX;
      downAt = null;
      if (moved) return;
    }
    if (!zoomable) return;

    if (fit === "fit") {
      const rect = img.getBoundingClientRect();
      const clickFrac = {
        x: rect.width ? (ev.clientX - rect.left) / rect.width : 0.5,
        y: rect.height ? (ev.clientY - rect.top) / rect.height : 0.5,
      };
      setFitMode("actual");
      const { left, top } = anchorScrollFor({
        clickFrac,
        natural,
        stage: { width: stage.clientWidth, height: stage.clientHeight },
      });
      stage.scrollLeft = left;
      stage.scrollTop = top;
    } else {
      setFitMode("fit");
    }
  };

  const onKeyDown = (ev: KeyboardEvent): void => {
    if (ev.key === "Escape" && fit === "actual") setFitMode("fit");
  };

  img.addEventListener("load", onLoad);
  img.addEventListener("error", onError);
  img.addEventListener("mousedown", onMouseDown);
  img.addEventListener("click", onClick);
  document.addEventListener("keydown", onKeyDown);

  // The popup is resizable, so an image can cross the fits/doesn't-fit line
  // without ever reloading.
  const resizeObs =
    typeof ResizeObserver === "function"
      ? new ResizeObserver(() => recomputeZoomable())
      : null;
  resizeObs?.observe(stage);

  // Assigning src last means the load handler is already attached even for a
  // cached response, which can complete synchronously.
  img.src = opts.src;

  return {
    el: root,
    whenSettled: () => settled,
    getFitMode: () => fit,
    setFitMode,
    dispose(): void {
      if (disposed) return;
      disposed = true;
      resizeObs?.disconnect();
      img.removeEventListener("load", onLoad);
      img.removeEventListener("error", onError);
      img.removeEventListener("mousedown", onMouseDown);
      img.removeEventListener("click", onClick);
      document.removeEventListener("keydown", onKeyDown);
      container.innerHTML = "";
      // A never-settled promise would leak a pending await in the host.
      resolveSettled({ ok: false, reason: "io-error" });
    },
  };
}
