import type { TtsBoundary } from "./TtsEngine";
import { computeHighlightRect } from "./highlightGeometry";

// XtermHighlighter — paints the TTS reading highlight as a DOM overlay
// anchored to an xterm marker, repositioned on every render/scroll/resize.
//
// Why a DOM overlay rather than an xterm decoration: a decoration with
// `backgroundColor` + `layer:"bottom"` is painted by the WebGL renderer as
// a cell background keyed by ON-SCREEN cell, refreshed only for dirty rows.
// It therefore stays at a fixed screen position on scroll and is cleared on
// resize. A self-positioned overlay, recomputed from the marker's live
// buffer line minus the viewport scroll, tracks the text instead — and is
// renderer-agnostic. See highlightGeometry.ts for the (pure) placement math.

export interface HighlighterDisposable {
  dispose(): void;
}

export interface HighlighterMarker {
  /** Live absolute buffer line; xterm reports a disposed/evicted marker as
   *  a negative line. */
  readonly line: number;
  readonly isDisposed: boolean;
  dispose(): void;
}

export interface HighlighterTerminal {
  readonly cols: number;
  readonly rows: number;
  /** xterm root element (`.xterm`); used to derive the overlay parent when
   *  one isn't supplied explicitly. */
  readonly element?: HTMLElement;
  buffer: {
    active: { baseY: number; cursorY: number; viewportY: number };
  };
  registerMarker(cursorYOffset?: number): HighlighterMarker | undefined;
  onRender(listener: () => void): HighlighterDisposable;
  onScroll(listener: () => void): HighlighterDisposable;
  onResize?(listener: () => void): HighlighterDisposable;
}

export interface HighlightTheme {
  backgroundColor: string;
  foregroundColor?: string;
}

export interface CellMetrics {
  width: number;
  height: number;
}

export interface XtermHighlighterOptions {
  /** Element the overlay is appended to — should be the `.xterm-screen` so
   *  (0,0) maps to the top-left of the cell grid. Falls back to deriving it
   *  from `term.element`. */
  overlayParent?: HTMLElement | null;
  /** Live cell metrics in px, re-read on every reposition so resize stays
   *  aligned. Falls back to measuring the overlay parent against cols/rows. */
  measureCell?: () => CellMetrics;
  /** Document used to create the overlay (injectable for tests). */
  doc?: Document;
}

const OVERLAY_CLASS = "reck-tts-highlight";

// The overlay sits ON TOP of the text (a DOM layer above the WebGL canvas),
// so it must be translucent for the word to read through it. A plain alpha
// composite is mode-safe — it tints rather than washes in both light and
// dark themes — unlike mix-blend-mode:multiply, which darkens light
// (dark-mode) text into low contrast. Tunable; verified visually.
const OVERLAY_OPACITY = "0.5";

export class XtermHighlighter {
  private readonly term: HighlighterTerminal;
  private readonly themeFn: () => HighlightTheme;
  private readonly overlayParent: HTMLElement | null;
  private readonly measureCell: () => CellMetrics;
  private readonly doc: Document | null;
  private overlay: HTMLDivElement | null = null;
  private activeMarker: HighlighterMarker | null = null;
  private activeBoundary: TtsBoundary | null = null;
  private subs: HighlighterDisposable[] = [];
  private disposed = false;

  constructor(
    term: HighlighterTerminal,
    themeFn: () => HighlightTheme,
    opts: XtermHighlighterOptions = {},
  ) {
    this.term = term;
    this.themeFn = themeFn;
    this.overlayParent = opts.overlayParent ?? deriveOverlayParent(term);
    this.doc =
      opts.doc ??
      this.overlayParent?.ownerDocument ??
      (typeof document !== "undefined" ? document : null);
    this.measureCell =
      opts.measureCell ?? (() => measureFromParent(this.overlayParent, term));
  }

  highlight(boundary: TtsBoundary): void {
    if (this.disposed) return;
    this.disposeMarker();

    const cursorAbs =
      this.term.buffer.active.baseY + this.term.buffer.active.cursorY;
    const cursorYOffset = boundary.line - cursorAbs;
    const marker = this.term.registerMarker(cursorYOffset);
    if (!marker) {
      // Couldn't anchor (line outside the buffer) — withdraw rather than
      // paint a stale highlight, and release any listeners from the prior
      // anchored word so tracking stays strictly episode-scoped (the next
      // successful highlight() re-subscribes).
      this.unsubscribe();
      this.activeBoundary = null;
      this.hide();
      return;
    }
    this.activeMarker = marker;
    this.activeBoundary = boundary;
    // Subscribe lazily, only while a highlight is live. The adapter that
    // owns this highlighter is created fresh per playback and released via
    // clear()/dispose() — keeping the listeners episode-scoped means a
    // finished read leaves no listeners on the shared terminal and no
    // orphaned overlay in the DOM.
    this.subscribe();
    this.reposition();
  }

  clear(): void {
    if (this.disposed) return;
    this.unsubscribe();
    this.disposeMarker();
    this.activeBoundary = null;
    this.removeOverlay();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.unsubscribe();
    this.disposeMarker();
    this.activeBoundary = null;
    this.removeOverlay();
  }

  // ── Internals ─────────────────────────────────────────────────────

  private reposition(): void {
    if (this.disposed) return;
    const boundary = this.activeBoundary;
    const marker = this.activeMarker;
    if (!boundary || !marker || marker.isDisposed) {
      this.hide();
      return;
    }

    const cell = this.measureCell();
    const rect = computeHighlightRect({
      markerLine: marker.line,
      viewportY: this.term.buffer.active.viewportY,
      rows: this.term.rows,
      cols: this.term.cols,
      col: boundary.col,
      len: boundary.len,
      cellWidth: cell.width,
      cellHeight: cell.height,
    });
    if (!rect) {
      this.hide();
      return;
    }

    const el = this.ensureOverlay();
    if (!el) return;
    const theme = this.themeFn();
    el.style.left = `${rect.left}px`;
    el.style.top = `${rect.top}px`;
    el.style.width = `${rect.width}px`;
    el.style.height = `${rect.height}px`;
    el.style.backgroundColor = theme.backgroundColor;
    if (theme.foregroundColor) el.style.color = theme.foregroundColor;
    el.style.display = "block";
  }

  private ensureOverlay(): HTMLDivElement | null {
    if (this.overlay) return this.overlay;
    if (!this.overlayParent || !this.doc) return null;
    const el = this.doc.createElement("div");
    el.className = OVERLAY_CLASS;
    el.style.position = "absolute";
    el.style.pointerEvents = "none";
    el.style.zIndex = "5";
    el.style.borderRadius = "2px";
    el.style.opacity = OVERLAY_OPACITY;
    el.style.display = "none";
    this.overlayParent.appendChild(el);
    this.overlay = el;
    return el;
  }

  private hide(): void {
    if (this.overlay) this.overlay.style.display = "none";
  }

  private subscribe(): void {
    if (this.subs.length > 0) return; // already tracking
    // Reposition whenever the viewport changes: scroll, new output
    // (render), and resize are the three cases where a fixed-screen
    // highlight would drift off the word.
    this.subs.push(this.term.onRender(() => this.reposition()));
    this.subs.push(this.term.onScroll(() => this.reposition()));
    if (this.term.onResize) {
      this.subs.push(this.term.onResize(() => this.reposition()));
    }
  }

  private unsubscribe(): void {
    for (const s of this.subs) s.dispose();
    this.subs = [];
  }

  private removeOverlay(): void {
    if (this.overlay) {
      this.overlay.remove();
      this.overlay = null;
    }
  }

  private disposeMarker(): void {
    if (this.activeMarker) {
      this.activeMarker.dispose();
      this.activeMarker = null;
    }
  }
}

function deriveOverlayParent(term: HighlighterTerminal): HTMLElement | null {
  const root = term.element;
  if (!root) return null;
  const screen = root.querySelector?.(".xterm-screen") as HTMLElement | null;
  return screen ?? root;
}

function measureFromParent(
  parent: HTMLElement | null,
  term: HighlighterTerminal,
): CellMetrics {
  if (!parent || term.cols <= 0 || term.rows <= 0) {
    return { width: 0, height: 0 };
  }
  return {
    width: parent.clientWidth / term.cols,
    height: parent.clientHeight / term.rows,
  };
}
