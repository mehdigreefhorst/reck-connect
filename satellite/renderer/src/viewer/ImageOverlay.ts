// A full-pane image overlay, for showing bytes we hold in memory.
//
// The file viewer's image popup (#146) needs a PATH — it hands one to main,
// which validates it against the allowed roots and mints a `reck-img://` URL.
// A pasted screenshot has no path: the bytes live only inside the session
// JSONL. Rather than materialise a temp file just to have something to point
// at — a new IPC channel writing renderer-supplied bytes to disk, for one
// click — this shows the image directly from a `data:` URI.
//
// It reuses the markdown lightbox's markup and CSS so zoomed images look the
// same everywhere; `.reck-image-overlay` is added to that shared selector
// list rather than getting a second copy of the block.

import { LIGHTBOX_CLASS } from "./Lightbox";

export const IMAGE_OVERLAY_CLASS = "reck-image-overlay";

export interface ImageOverlayHandle {
  /** Remove the overlay and its listeners. Idempotent. */
  close(): void;
}

export interface ImageOverlayOptions {
  /** Positioned element the overlay covers — the pane wrapper. */
  host: HTMLElement;
  /** Anything an `<img>` accepts; in practice a `data:` URI. */
  src: string;
  alt: string;
}

/**
 * Show `src` over `host` until dismissed by Escape, a backdrop click, or
 * `close()`. Only one overlay exists per host: a second call replaces the
 * first rather than stacking, so a rapid double-⌘-click cannot orphan one.
 */
export function showImageOverlay(opts: ImageOverlayOptions): ImageOverlayHandle {
  const doc = opts.host.ownerDocument;
  opts.host.querySelector(`:scope > .${IMAGE_OVERLAY_CLASS}`)?.remove();

  const wrap = doc.createElement("div");
  wrap.className = IMAGE_OVERLAY_CLASS;

  const box = doc.createElement("div");
  box.className = LIGHTBOX_CLASS;
  box.setAttribute("role", "dialog");
  box.setAttribute("aria-modal", "true");
  box.setAttribute("aria-label", opts.alt);

  const img = doc.createElement("img");
  img.setAttribute("src", opts.src);
  img.setAttribute("alt", opts.alt);
  box.appendChild(img);
  wrap.appendChild(box);
  opts.host.appendChild(wrap);

  let closed = false;
  function close(): void {
    if (closed) return;
    closed = true;
    doc.removeEventListener("keydown", onKeyDown, true);
    wrap.remove();
  }

  function onKeyDown(ev: KeyboardEvent): void {
    if (ev.key !== "Escape") return;
    // Captured and stopped: the History overlay also closes on Escape, and
    // without this a single press would dismiss both — the image AND the
    // conversation the user was reading.
    ev.stopPropagation();
    ev.preventDefault();
    close();
  }

  // The enlarged image itself does not close; the backdrop around it does.
  box.addEventListener("click", (ev) => {
    if (ev.target === box) close();
  });
  doc.addEventListener("keydown", onKeyDown, true);

  return { close };
}
