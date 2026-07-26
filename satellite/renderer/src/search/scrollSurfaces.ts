// `ScrollSurface` — the minimal scroll abstraction the OverlayScrollbar
// drives. It deliberately does NOT assume a DOM scroll element: the
// markdown body and CodeMirror scroller are real DOM scrollers, but the
// xterm terminal scrolls through its buffer API (line-based, no scrollable
// DOM node). Both are expressed as the same three operations.

export interface ScrollMetrics {
  /** Current scroll offset from the top (px for DOM, lines for xterm). */
  scrollTop: number;
  /** Total scrollable extent. */
  scrollHeight: number;
  /** Visible extent. */
  clientHeight: number;
}

export interface ScrollSurface {
  getMetrics(): ScrollMetrics;
  /** Scroll so the top sits at `fraction` (0..1) of the scrollable range. */
  scrollToFraction(fraction: number): void;
  /** Subscribe to scroll changes; returns an unsubscribe thunk. */
  onScroll(cb: () => void): () => void;
  /** Optional: true when the SURFACE owns scrolling and xterm's viewportY
   *  won't track it — i.e. a mouse-tracking TUI (Claude Code, less, vim) that
   *  grabs the wheel and redraws in place. The scrollbar then can't read a
   *  real position from metrics, so it hides the thumb and routes the wheel
   *  to `lineScroll`. Absent/false → the metrics are truthful. */
  ownsScroll?(): boolean;
  /** Optional: scroll the surface by ONE line in `dir` (-1 = up, +1 = down)
   *  and return true if handled. Used for mouse-tracking TUIs (Claude Code,
   *  less, vim) whose transcript can't be scrolled from xterm at all — we
   *  inject a mouse-wheel report into the PTY instead and let the TUI move
   *  its own view. DOM / plain-shell surfaces leave this unset and scroll
   *  natively. */
  lineScroll?(dir: -1 | 1): boolean;
  /** Optional: fires when the surface re-renders without a scroll (new
   *  output, in-place TUI redraw, font/size change). The scrollbar uses this
   *  to recompute geometry — e.g. clear its disabled state once scrollback
   *  grows — WITHOUT flashing into view. Returns an unsubscribe thunk. */
  onRender?(cb: () => void): () => void;
}

/** A DOM scroll container (markdown `.file-viewer-body`, CodeMirror
 *  `.cm-scroller`). */
export function domScrollSurface(el: HTMLElement): ScrollSurface {
  return {
    getMetrics: () => ({
      scrollTop: el.scrollTop,
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    }),
    scrollToFraction: (fraction: number) => {
      const range = el.scrollHeight - el.clientHeight;
      el.scrollTop = clamp01(fraction) * Math.max(0, range);
    },
    onScroll: (cb) => {
      el.addEventListener("scroll", cb, { passive: true });
      return () => el.removeEventListener("scroll", cb);
    },
  };
}

interface ScrollableTerminal {
  readonly rows: number;
  buffer: { active: { length: number; baseY: number; viewportY: number } };
  /** xterm's DEC mode set. `mouseTrackingMode !== 'none'` means a full-screen
   *  TUI (Claude Code, less, vim) has grabbed the mouse — see `ownsScroll`.
   *  Optional so fakes/older shims that don't model it default to truthful. */
  modes?: { mouseTrackingMode: string };
  scrollToLine(line: number): void;
  onScroll(cb: () => void): { dispose(): void };
  onRender?(cb: () => void): { dispose(): void };
}

// SGR mouse-wheel reports (DECSET 1006 encoding) — what a terminal sends a
// mouse-tracking app when the wheel turns. Button 64 = wheel up, 65 = wheel
// down; the `1;1` cell coordinates are inert here (the TUIs we target read
// only the button code). We emit these rather than PgUp/PgDn because a page
// key is far too coarse: Claude Code binds pageup/pagedown to
// `scroll:pageUp`/`scroll:pageDown`, which move HALF A VIEWPORT per press,
// while the wheel maps to `scroll:lineUp`/`scroll:lineDown` — exactly one
// line, which is what a scroll gesture should do.
const WHEEL_UP = "\x1b[<64;1;1M";
const WHEEL_DOWN = "\x1b[<65;1;1M";

/** An xterm terminal. Scroll position is line-based: `viewportY` is the
 *  top visible absolute line, `baseY` the max scroll-top (scrollback
 *  size), `length` the total buffer height, `rows` the viewport height.
 *  `sendInput`, when provided, writes raw bytes to the PTY — used by
 *  `lineScroll` to drive a mouse-tracking TUI via wheel reports. */
export function terminalScrollSurface(
  term: ScrollableTerminal,
  sendInput?: (bytes: Uint8Array) => void,
): ScrollSurface {
  return {
    getMetrics: () => ({
      scrollTop: term.buffer.active.viewportY,
      scrollHeight: term.buffer.active.length,
      clientHeight: term.rows,
    }),
    scrollToFraction: (fraction: number) => {
      const line = Math.round(clamp01(fraction) * term.buffer.active.baseY);
      term.scrollToLine(line);
    },
    // A mouse-tracking TUI (Claude Code, less, vim) grabs the mouse and runs on
    // the alternate screen — no xterm scrollback, so a truthful thumb is
    // impossible. Report that so the scrollbar hides its thumb and routes the
    // wheel to `lineScroll` instead. Default "none" (truthful) when unmodelled.
    //
    // This is also exactly the right gate for `lineScroll`: a non-"none" mouse
    // tracking mode means the app asked the terminal for mouse reports, so it
    // has a parser ready for the wheel sequences we synthesize.
    ownsScroll: () => (term.modes?.mouseTrackingMode ?? "none") !== "none",
    // Wheel over such a pane → a wheel report into the PTY so the TUI scrolls
    // its own transcript by a line. No-op (false) when no PTY sink is wired.
    lineScroll: (dir) => {
      if (!sendInput) return false;
      sendInput(new TextEncoder().encode(dir < 0 ? WHEEL_UP : WHEEL_DOWN));
      return true;
    },
    onScroll: (cb) => {
      const sub = term.onScroll(cb);
      return () => sub.dispose();
    },
    onRender: term.onRender
      ? (cb) => {
          const sub = term.onRender!(cb);
          return () => sub.dispose();
        }
      : undefined,
  };
}

function clamp01(n: number): number {
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}
