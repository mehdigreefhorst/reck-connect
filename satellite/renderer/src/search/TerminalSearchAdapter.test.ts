// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from "vitest";
import { TerminalSearchAdapter, type SearchableTerminal } from "./TerminalSearchAdapter";

interface DecoOpts {
  x?: number;
  width?: number;
  backgroundColor?: string;
}

function fakeTerm(rowStrings: string[], opts: { rows: number; baseY: number; cursorY: number }) {
  const markers: Array<{ disposed: boolean; offset: number }> = [];
  const decorations: Array<{ disposed: boolean; opts: DecoOpts }> = [];
  let lastScrollLine = -1;
  const term: SearchableTerminal = {
    rows: opts.rows,
    cols: 80,
    buffer: {
      active: {
        baseY: opts.baseY,
        cursorY: opts.cursorY,
        length: rowStrings.length,
        getLine: (y: number) =>
          y >= 0 && y < rowStrings.length
            ? { translateToString: () => rowStrings[y] }
            : undefined,
      },
    },
    registerMarker: (offset?: number) => {
      const m = { disposed: false, offset: offset ?? 0 };
      markers.push(m);
      return { dispose: () => (m.disposed = true) };
    },
    registerDecoration: (o) => {
      const d = { disposed: false, opts: { x: o.x, width: o.width, backgroundColor: o.backgroundColor } };
      decorations.push(d);
      return { dispose: () => (d.disposed = true), onRender: () => {} };
    },
    scrollToLine: (line: number) => {
      lastScrollLine = line;
    },
  };
  return {
    term,
    markers,
    decorations,
    getScrollLine: () => lastScrollLine,
  };
}

let container: HTMLElement;

beforeEach(() => {
  container = document.createElement("div");
});

const ROWS = ["foo bar", "baz foo", "qux", "foo end", "tail"];

describe("TerminalSearchAdapter", () => {
  it("reports its kind and container", () => {
    const f = fakeTerm(ROWS, { rows: 3, baseY: 2, cursorY: 2 });
    const a = new TerminalSearchAdapter({ container, term: f.term });
    expect(a.kind).toBe("terminal");
    expect(a.getContainerEl()).toBe(container);
  });

  it("getText joins physical rows with newlines (scrollback included)", () => {
    const f = fakeTerm(ROWS, { rows: 3, baseY: 2, cursorY: 2 });
    const a = new TerminalSearchAdapter({ container, term: f.term });
    expect(a.getText()).toBe("foo bar\nbaz foo\nqux\nfoo end\ntail");
  });

  it("decorates each match at the right cell, mapping flat offsets to (row,col)", () => {
    const f = fakeTerm(ROWS, { rows: 3, baseY: 2, cursorY: 2 });
    const a = new TerminalSearchAdapter({ container, term: f.term });
    a.getText();
    // 'foo' occurs at flat offsets 0, 12, 20
    a.highlightMatches(
      [
        { start: 0, end: 3 },
        { start: 12, end: 15 },
        { start: 20, end: 23 },
      ],
      1,
    );
    expect(f.decorations.length).toBe(3);
    expect(f.decorations.map((d) => d.opts.x)).toEqual([0, 4, 0]);
    expect(f.decorations.map((d) => d.opts.width)).toEqual([3, 3, 3]);
    // the active (index 1) gets a different colour than the others
    expect(f.decorations[1].opts.backgroundColor).not.toBe(f.decorations[0].opts.backgroundColor);
  });

  it("re-highlighting disposes the previous decorations and markers", () => {
    const f = fakeTerm(ROWS, { rows: 3, baseY: 2, cursorY: 2 });
    const a = new TerminalSearchAdapter({ container, term: f.term });
    a.getText();
    a.highlightMatches([{ start: 0, end: 3 }], 0);
    a.highlightMatches([{ start: 12, end: 15 }], 0);
    // first decoration + marker disposed
    expect(f.decorations[0].disposed).toBe(true);
    expect(f.markers[0].disposed).toBe(true);
    expect(f.decorations[1].disposed).toBe(false);
  });

  it("clearHighlights disposes everything", () => {
    const f = fakeTerm(ROWS, { rows: 3, baseY: 2, cursorY: 2 });
    const a = new TerminalSearchAdapter({ container, term: f.term });
    a.getText();
    a.highlightMatches([{ start: 0, end: 3 }, { start: 12, end: 15 }], 0);
    a.clearHighlights();
    expect(f.decorations.every((d) => d.disposed)).toBe(true);
    expect(f.markers.every((m) => m.disposed)).toBe(true);
  });

  it("scrollToMatch centres the matched row in the viewport", () => {
    const f = fakeTerm(ROWS, { rows: 3, baseY: 2, cursorY: 2 });
    const a = new TerminalSearchAdapter({ container, term: f.term });
    a.getText();
    a.scrollToMatch({ start: 20, end: 23 }); // row 3
    // row 3 - floor(3/2)=1 -> 2, clamped to [0, baseY=2]
    expect(f.getScrollLine()).toBe(2);
  });

  it("fractionForOffset maps a match to its row fraction", () => {
    const f = fakeTerm(ROWS, { rows: 3, baseY: 2, cursorY: 2 });
    const a = new TerminalSearchAdapter({ container, term: f.term });
    a.getText();
    // offset 20 -> row 3; length 5 -> 0.6
    expect(a.fractionForOffset(20)).toBeCloseTo(0.6, 5);
    // offset 0 -> row 0 -> 0
    expect(a.fractionForOffset(0)).toBe(0);
  });

  it("is a no-op after dispose", () => {
    const f = fakeTerm(ROWS, { rows: 3, baseY: 2, cursorY: 2 });
    const a = new TerminalSearchAdapter({ container, term: f.term });
    a.getText();
    a.dispose();
    a.highlightMatches([{ start: 0, end: 3 }], 0);
    expect(f.decorations.length).toBe(0);
    expect(() => a.dispose()).not.toThrow();
  });
});
