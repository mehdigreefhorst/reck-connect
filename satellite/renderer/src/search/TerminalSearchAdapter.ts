// `TerminalSearchAdapter` — search over an xterm.js terminal, including
// the full scrollback. Mirrors the TTS `XtermHighlighter`: matches are
// painted with xterm's native marker + decoration primitives (which scroll
// with the buffer), and scroll-to-match drives the viewport via
// `scrollToLine`.
//
// Text model: each PHYSICAL buffer row is one line in the flat search text,
// joined with "\n". A flat match offset maps to (row, col) via a cached
// per-row offset index. Single-line queries never cross a row boundary, so
// every match resolves to one (row, col, len) — exactly what a decoration
// needs. (Wrapped logical lines are searched per visual row; that matches
// what the user sees.)

import type { OffsetRange } from "./matcher";
import type { SearchSurfaceAdapter, SurfaceKind } from "./SearchSurfaceAdapter";

export interface SearchableBufferLine {
  translateToString(trimRight?: boolean): string;
}

export interface SearchableTerminal {
  readonly rows: number;
  readonly cols: number;
  buffer: {
    active: {
      baseY: number;
      cursorY: number;
      length: number;
      getLine(y: number): SearchableBufferLine | undefined;
    };
  };
  registerMarker(cursorYOffset?: number): { dispose(): void } | undefined;
  registerDecoration(opts: {
    marker: { dispose(): void };
    x?: number;
    width?: number;
    backgroundColor?: string;
    foregroundColor?: string;
    layer?: "bottom" | "top";
  }): { dispose(): void; onRender?(cb: (el: HTMLElement) => void): void } | undefined;
  scrollToLine(line: number): void;
}

export interface TerminalSearchAdapterOptions {
  container: HTMLElement;
  term: SearchableTerminal;
  /** Background colour for non-active matches. */
  matchColor?: string;
  /** Background colour for the active match. */
  activeColor?: string;
}

interface RowSpan {
  row: number;
  start: number;
  end: number; // exclusive of the trailing "\n"
}

// Cap the number of painted decorations so a query that matches thousands
// of cells across a 5000-line scrollback can't stall the renderer. The
// active match is always painted; navigation (next/prev) + the scrollbar
// ticks cover the rest.
const MAX_DECORATIONS = 1000;

const DEFAULT_MATCH_COLOR = "rgba(212, 104, 58, 0.35)";
const DEFAULT_ACTIVE_COLOR = "rgba(212, 104, 58, 0.75)";

export class TerminalSearchAdapter implements SearchSurfaceAdapter {
  readonly kind: SurfaceKind = "terminal";

  private readonly container: HTMLElement;
  private readonly term: SearchableTerminal;
  private readonly matchColor: string;
  private readonly activeColor: string;
  private disposed = false;

  private rowSpans: RowSpan[] = [];
  private markers: Array<{ dispose(): void }> = [];
  private decorations: Array<{ dispose(): void }> = [];

  constructor(opts: TerminalSearchAdapterOptions) {
    this.container = opts.container;
    this.term = opts.term;
    this.matchColor = opts.matchColor ?? DEFAULT_MATCH_COLOR;
    this.activeColor = opts.activeColor ?? DEFAULT_ACTIVE_COLOR;
  }

  getContainerEl(): HTMLElement {
    return this.container;
  }

  getText(): string {
    if (this.disposed) return "";
    const parts: string[] = [];
    this.rowSpans = [];
    let cursor = 0;
    const len = this.term.buffer.active.length;
    for (let y = 0; y < len; y++) {
      const line = this.term.buffer.active.getLine(y);
      const text = line ? line.translateToString(true) : "";
      const start = cursor;
      parts.push(text);
      this.rowSpans.push({ row: y, start, end: start + text.length });
      cursor += text.length;
      if (y < len - 1) {
        parts.push("\n");
        cursor += 1;
      }
    }
    return parts.join("");
  }

  highlightMatches(ranges: readonly OffsetRange[], activeIndex: number): void {
    if (this.disposed) return;
    if (this.rowSpans.length === 0) this.getText();
    this.disposeDecorations();

    const limit = Math.min(ranges.length, MAX_DECORATIONS);
    const cursorAbs = this.term.buffer.active.baseY + this.term.buffer.active.cursorY;
    for (let i = 0; i < ranges.length; i++) {
      // Respect the cap, but never drop the active match.
      if (i >= limit && i !== activeIndex) continue;
      this.paint(ranges[i], i === activeIndex, cursorAbs);
    }
  }

  scrollToMatch(range: OffsetRange): void {
    if (this.disposed) return;
    if (this.rowSpans.length === 0) this.getText();
    const loc = this.locate(range.start);
    if (!loc) return;
    const top = loc.row - Math.floor(this.term.rows / 2);
    const maxTop = this.term.buffer.active.baseY;
    this.term.scrollToLine(Math.max(0, Math.min(top, maxTop)));
  }

  clearHighlights(): void {
    if (this.disposed) return;
    this.disposeDecorations();
  }

  fractionForOffset(offset: number): number | null {
    if (this.disposed) return null;
    if (this.rowSpans.length === 0) this.getText();
    const loc = this.locate(offset);
    if (!loc) return null;
    const len = this.term.buffer.active.length;
    return len > 0 ? loc.row / len : 0;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposeDecorations();
    this.disposed = true;
    this.rowSpans = [];
  }

  // ── Internals ─────────────────────────────────────────────────────

  private paint(range: OffsetRange, active: boolean, cursorAbs: number): void {
    const loc = this.locate(range.start);
    if (!loc) return;
    const width = Math.min(range.end - range.start, this.term.cols - loc.col);
    if (width <= 0) return;
    const marker = this.term.registerMarker(loc.row - cursorAbs);
    if (!marker) return;
    const decoration = this.term.registerDecoration({
      marker,
      x: loc.col,
      width,
      backgroundColor: active ? this.activeColor : this.matchColor,
      layer: "bottom",
    });
    if (!decoration) {
      marker.dispose();
      return;
    }
    this.markers.push(marker);
    this.decorations.push(decoration);
  }

  private locate(offset: number): { row: number; col: number } | null {
    // Binary search for the row span whose start is the greatest <= offset.
    let lo = 0;
    let hi = this.rowSpans.length - 1;
    let ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.rowSpans[mid].start <= offset) {
        ans = mid;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (ans < 0) return null;
    const span = this.rowSpans[ans];
    if (offset > span.end) return null; // fell into the synthetic "\n" gap
    return { row: span.row, col: offset - span.start };
  }

  private disposeDecorations(): void {
    for (const d of this.decorations) d.dispose();
    for (const m of this.markers) m.dispose();
    this.decorations = [];
    this.markers = [];
  }
}
