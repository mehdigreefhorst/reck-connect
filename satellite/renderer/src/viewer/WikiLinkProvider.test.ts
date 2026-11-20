// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { installWikiLinkProvider } from "./WikiLinkProvider";

interface FakeLink {
  text: string;
  range: { start: { x: number; y: number }; end: { x: number; y: number } };
  activate: (event: MouseEvent, text: string) => void;
  hover?: (event: MouseEvent, text: string) => void;
  leave?: () => void;
}

function makeLine(text: string, isWrapped = false) {
  return { text, isWrapped, translateToString: () => text };
}

// Minimal fake xterm terminal — just what installWikiLinkProvider +
// collectWrapRun/projectMatchOntoLines read.
function makeFakeTerminal(lines: Array<string | { text: string; isWrapped: boolean }>) {
  const buf = lines.map((l) =>
    typeof l === "string" ? makeLine(l) : makeLine(l.text, l.isWrapped),
  );
  let registered: {
    provideLinks: (line: number, cb: (links: unknown[] | undefined) => void) => void;
  } | null = null;
  const term = {
    registerLinkProvider(p: unknown) {
      registered = p as typeof registered;
      return { dispose: vi.fn() };
    },
    buffer: { active: { getLine: (i: number) => buf[i], baseY: 0, cursorY: 0 } },
  };
  return { term, getRegistered: () => registered };
}

/** Drive provideLinks for a 1-indexed buffer line and return the links. */
function linksFor(
  getRegistered: () => { provideLinks: (n: number, cb: (l: unknown[] | undefined) => void) => void } | null,
  line1: number,
): FakeLink[] {
  let out: FakeLink[] = [];
  getRegistered()!.provideLinks(line1, (links) => {
    out = (links ?? []) as FakeLink[];
  });
  return out;
}

// Issue #186: `[[note]]` printed in a pane was plain text.
describe("installWikiLinkProvider", () => {
  it("emits a link for a wikilink in the line", () => {
    const { term, getRegistered } = makeFakeTerminal(["see [[2026-11-19-offerte]] now"]);
    installWikiLinkProvider(term as never, { onActivate: vi.fn() });
    const links = linksFor(getRegistered, 1);
    expect(links.length).toBe(1);
    expect(links[0].text).toBe("[[2026-11-19-offerte]]");
    // 1-indexed, inclusive cell range covering the whole `[[…]]`.
    expect(links[0].range.start).toEqual({ x: 5, y: 1 });
    expect(links[0].range.end).toEqual({ x: 26, y: 1 });
  });

  it("a plain click hands the note's file name to onActivate", () => {
    const onActivate = vi.fn();
    const { term, getRegistered } = makeFakeTerminal(["[[my-note|My note]]"]);
    installWikiLinkProvider(term as never, { onActivate });
    const link = linksFor(getRegistered, 1)[0];
    link.activate({ metaKey: false } as MouseEvent, link.text);
    expect(onActivate).toHaveBeenCalledTimes(1);
    expect(onActivate.mock.calls[0][0]).toBe("my-note.md");
  });

  it("links each wikilink on a line to its own note", () => {
    const onActivate = vi.fn();
    const { term, getRegistered } = makeFakeTerminal(["[[a]] and [[b]]"]);
    installWikiLinkProvider(term as never, { onActivate });
    const links = linksFor(getRegistered, 1);
    expect(links.length).toBe(2);
    links[1].activate({} as MouseEvent, links[1].text);
    expect(onActivate).toHaveBeenCalledWith("b.md", expect.anything());
  });

  it("links a wikilink that soft-wraps onto the next row as one link", () => {
    const onActivate = vi.fn();
    const { term, getRegistered } = makeFakeTerminal([
      "open [[a-long-no",
      { text: "te-name]] ok", isWrapped: true },
    ]);
    installWikiLinkProvider(term as never, { onActivate });
    const first = linksFor(getRegistered, 1);
    const second = linksFor(getRegistered, 2);
    expect(first.length).toBeGreaterThan(0);
    expect(second.length).toBeGreaterThan(0);
    second[0].activate({} as MouseEvent, second[0].text);
    expect(onActivate).toHaveBeenCalledWith("a-long-note-name.md", expect.anything());
  });

  it("emits nothing for a line without wikilinks, or for an image embed", () => {
    const { term, getRegistered } = makeFakeTerminal(["plain text", "![[photo.png]]"]);
    installWikiLinkProvider(term as never, { onActivate: vi.fn() });
    expect(linksFor(getRegistered, 1)).toEqual([]);
    expect(linksFor(getRegistered, 2)).toEqual([]);
  });

  it("hover shows a tooltip; leave hides it", () => {
    document.body.innerHTML = "";
    const { term, getRegistered } = makeFakeTerminal(["[[a]]"]);
    installWikiLinkProvider(term as never, { onActivate: vi.fn() });
    const link = linksFor(getRegistered, 1)[0];
    link.hover!({ clientX: 10, clientY: 10 } as MouseEvent, link.text);
    const tip = document.querySelector(".reck-link-tooltip") as HTMLElement | null;
    expect(tip?.textContent).toBe("Click to open note");
    link.leave!();
    expect((document.querySelector(".reck-link-tooltip") as HTMLElement).style.display).toBe("none");
  });
});
