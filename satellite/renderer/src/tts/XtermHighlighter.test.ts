import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  XtermHighlighter,
  type HighlighterTerminal,
  type HighlightTheme,
} from "./XtermHighlighter";

// A fireable event emitter standing in for xterm's onRender/onScroll/onResize.
function makeEmitter() {
  const listeners = new Set<() => void>();
  return {
    on(cb: () => void) {
      listeners.add(cb);
      return { dispose: () => listeners.delete(cb) };
    },
    fire() {
      for (const cb of [...listeners]) cb();
    },
    size() {
      return listeners.size;
    },
  };
}

interface FakeMarker {
  id: number;
  _line: number;
  isDisposed: boolean;
  readonly line: number;
  dispose(): void;
}

function fakeTerm(
  init: Partial<{
    baseY: number;
    cursorY: number;
    viewportY: number;
    cols: number;
    rows: number;
  }> = {},
) {
  const state = {
    baseY: init.baseY ?? 100,
    cursorY: init.cursorY ?? 5,
    viewportY: init.viewportY ?? 100,
    cols: init.cols ?? 80,
    rows: init.rows ?? 24,
  };
  const render = makeEmitter();
  const scroll = makeEmitter();
  const resize = makeEmitter();
  const markers: FakeMarker[] = [];
  let markerSeq = 0;
  const cursorAbs = () => state.baseY + state.cursorY;

  const term: HighlighterTerminal = {
    get cols() {
      return state.cols;
    },
    get rows() {
      return state.rows;
    },
    buffer: {
      active: {
        get baseY() {
          return state.baseY;
        },
        get cursorY() {
          return state.cursorY;
        },
        get viewportY() {
          return state.viewportY;
        },
      },
    },
    registerMarker(offset = 0) {
      const m: FakeMarker = {
        id: ++markerSeq,
        _line: cursorAbs() + offset,
        isDisposed: false,
        get line() {
          return this.isDisposed ? -1 : this._line;
        },
        dispose() {
          this.isDisposed = true;
        },
      };
      markers.push(m);
      return m;
    },
    onRender: render.on,
    onScroll: scroll.on,
    onResize: resize.on,
  };

  return {
    term,
    state,
    markers,
    fireRender: () => render.fire(),
    fireScroll: () => scroll.fire(),
    fireResize: () => resize.fire(),
    renderListeners: () => render.size(),
    scrollListeners: () => scroll.size(),
  };
}

function setup(
  init?: Parameters<typeof fakeTerm>[0],
  theme: HighlightTheme = { backgroundColor: "rgb(1, 2, 3)" },
) {
  const env = fakeTerm(init);
  const parent = document.createElement("div");
  document.body.appendChild(parent);
  // Fixed cell metrics, mutable so resize can be simulated.
  const cell = { width: 8, height: 16 };
  let currentTheme = theme;
  const h = new XtermHighlighter(env.term, () => currentTheme, {
    overlayParent: parent,
    measureCell: () => cell,
  });
  const overlay = () =>
    parent.querySelector<HTMLDivElement>(".reck-tts-highlight");
  return {
    ...env,
    h,
    parent,
    cell,
    overlay,
    setTheme: (t: HighlightTheme) => {
      currentTheme = t;
    },
  };
}

const B = (line: number, col: number, len: number) => ({
  line,
  col,
  len,
  word: "x".repeat(len),
  charIndex: 0,
});

describe("XtermHighlighter.highlight — overlay placement", () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => {
    s = setup({ baseY: 100, cursorY: 5, viewportY: 100 }); // cursorAbs 105
  });
  afterEach(() => {
    s.h.dispose();
    s.parent.remove();
  });

  it("creates a visible overlay positioned at the word", () => {
    s.h.highlight(B(102, 6, 4)); // line 102 → screen row 2 (viewportY 100)
    const el = s.overlay();
    expect(el).not.toBeNull();
    expect(el!.style.display).toBe("block");
    expect(el!.style.top).toBe("32px"); // row 2 * 16
    expect(el!.style.left).toBe("48px"); // col 6 * 8
    expect(el!.style.width).toBe("32px"); // 4 cells * 8
    expect(el!.style.height).toBe("16px");
    expect(el!.style.backgroundColor).toBe("rgb(1, 2, 3)");
  });

  it("anchors the marker at the word's absolute buffer line", () => {
    s.h.highlight(B(102, 6, 4));
    expect(s.markers).toHaveLength(1);
    expect(s.markers[0].line).toBe(102); // cursorAbs 105 + offset(-3)
  });
});

describe("XtermHighlighter — scroll / render / resize tracking", () => {
  let s: ReturnType<typeof setup>;
  beforeEach(() => {
    s = setup({ baseY: 100, cursorY: 5, viewportY: 100 });
  });
  afterEach(() => {
    s.h.dispose();
    s.parent.remove();
  });

  it("moves the overlay DOWN when the viewport scrolls up", () => {
    s.h.highlight(B(102, 6, 4));
    expect(s.overlay()!.style.top).toBe("32px"); // row 2
    s.state.viewportY = 98; // scrolled up two lines
    s.fireScroll();
    expect(s.overlay()!.style.top).toBe("64px"); // row 4 — followed the text
  });

  it("repositions on a render event (e.g. new output) as well", () => {
    s.h.highlight(B(102, 6, 4));
    s.state.viewportY = 99;
    s.fireRender();
    expect(s.overlay()!.style.top).toBe("48px"); // row 3
  });

  it("realigns to new cell metrics on resize", () => {
    s.h.highlight(B(102, 6, 4));
    s.cell.width = 10;
    s.cell.height = 20;
    s.fireResize();
    const el = s.overlay()!;
    expect(el.style.left).toBe("60px"); // col 6 * 10
    expect(el.style.top).toBe("40px"); // row 2 * 20
    expect(el.style.width).toBe("40px"); // 4 cells * 10
  });

  it("hides the overlay when the word scrolls off the bottom", () => {
    s.h.highlight(B(102, 6, 4));
    expect(s.overlay()!.style.display).toBe("block");
    s.state.viewportY = 70; // row would be 32 ≥ rows(24)
    s.fireScroll();
    expect(s.overlay()!.style.display).toBe("none");
  });

  it("hides the overlay when the word scrolls off the top", () => {
    s.h.highlight(B(102, 6, 4));
    s.state.viewportY = 110; // row would be -8
    s.fireScroll();
    expect(s.overlay()!.style.display).toBe("none");
  });

  it("re-shows the overlay when the word scrolls back into view", () => {
    s.h.highlight(B(102, 6, 4));
    s.state.viewportY = 110; // off-screen
    s.fireScroll();
    expect(s.overlay()!.style.display).toBe("none");
    s.state.viewportY = 100; // back in view
    s.fireScroll();
    expect(s.overlay()!.style.display).toBe("block");
    expect(s.overlay()!.style.top).toBe("32px");
  });

  it("hides when the underlying marker is disposed by the buffer", () => {
    s.h.highlight(B(102, 6, 4));
    s.markers[0].dispose(); // simulate scrollback eviction
    s.fireRender();
    expect(s.overlay()!.style.display).toBe("none");
  });

  it("uses the latest theme colour on each reposition", () => {
    s.h.highlight(B(102, 6, 4));
    expect(s.overlay()!.style.backgroundColor).toBe("rgb(1, 2, 3)");
    s.setTheme({ backgroundColor: "rgb(4, 5, 6)" });
    s.fireScroll();
    expect(s.overlay()!.style.backgroundColor).toBe("rgb(4, 5, 6)");
  });
});

describe("XtermHighlighter — lifecycle", () => {
  it("disposes the previous marker and re-points to the new word", () => {
    const s = setup({ baseY: 100, cursorY: 5, viewportY: 100 });
    s.h.highlight(B(102, 0, 5));
    s.h.highlight(B(103, 2, 3));
    expect(s.markers[0].isDisposed).toBe(true);
    expect(s.markers[1].isDisposed).toBe(false);
    // Re-pointed: line 103 → row 3 → top 48; col 2 → left 16; 3 cells → 24.
    const el = s.overlay()!;
    expect(el.style.top).toBe("48px");
    expect(el.style.left).toBe("16px");
    expect(el.style.width).toBe("24px");
    s.h.dispose();
    s.parent.remove();
  });

  it("clear() releases the overlay + marker + listeners, then stays usable", () => {
    const s = setup();
    s.h.highlight(B(102, 6, 4));
    expect(s.scrollListeners()).toBe(1); // subscribed while live
    s.h.clear();
    expect(s.overlay()).toBeNull(); // overlay removed, not just hidden
    expect(s.markers[0].isDisposed).toBe(true);
    expect(s.scrollListeners()).toBe(0); // listeners released
    // Re-highlighting after clear works (re-subscribes + repaints).
    s.h.highlight(B(102, 0, 2));
    expect(s.markers).toHaveLength(2);
    expect(s.scrollListeners()).toBe(1);
    expect(s.overlay()!.style.display).toBe("block");
    s.h.dispose();
    s.parent.remove();
  });

  it("dispose() removes the overlay, unsubscribes, and ignores later calls", () => {
    const s = setup();
    s.h.highlight(B(102, 6, 4));
    expect(s.overlay()).not.toBeNull();
    s.h.dispose();
    expect(s.overlay()).toBeNull(); // removed from the parent
    expect(s.renderListeners()).toBe(0);
    expect(s.scrollListeners()).toBe(0);
    s.h.highlight(B(102, 6, 4)); // no-op after dispose
    expect(s.overlay()).toBeNull();
    s.parent.remove();
  });

  it("no-ops without throwing when marker registration fails (off-screen)", () => {
    const s = setup();
    s.term.registerMarker = () => undefined;
    expect(() => s.h.highlight(B(999, 0, 4))).not.toThrow();
    const el = s.overlay();
    // Either no overlay yet, or one left hidden — never shown.
    expect(el === null || el.style.display === "none").toBe(true);
    s.h.dispose();
    s.parent.remove();
  });

  it("releases listeners when a re-highlight fails to anchor (degenerate path)", () => {
    const s = setup({ baseY: 100, cursorY: 5, viewportY: 100 });
    s.h.highlight(B(102, 6, 4)); // succeeds → subscribed
    expect(s.scrollListeners()).toBe(1);
    s.term.registerMarker = () => undefined; // next anchor fails
    s.h.highlight(B(103, 0, 3));
    // Listeners from the prior word are released — not left firing no-op
    // reposition() on every frame for the rest of the read.
    expect(s.scrollListeners()).toBe(0);
    expect(s.overlay()!.style.display).toBe("none");
    s.h.dispose();
    s.parent.remove();
  });
});
