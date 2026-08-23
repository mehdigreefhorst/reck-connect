// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { installImageMarkerLinkProvider } from "./ImageMarkerLinkProvider";
import { detectImageMarkersInLine } from "./LinkDetector";

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

function linksFor(
  getRegistered: () => {
    provideLinks: (n: number, cb: (l: unknown[] | undefined) => void) => void;
  } | null,
  line1: number,
): FakeLink[] {
  let out: FakeLink[] = [];
  getRegistered()!.provideLinks(line1, (links) => {
    out = (links ?? []) as FakeLink[];
  });
  return out;
}

describe("detectImageMarkersInLine", () => {
  it("captures the id from each placeholder", () => {
    expect(detectImageMarkersInLine("see [Image #2] & [Image #11] ok")).toEqual([
      { text: "[Image #2]", start: 4, end: 14, pasteId: 2 },
      { text: "[Image #11]", start: 17, end: 28, pasteId: 11 },
    ]);
  });

  it("ignores near-misses and ids that are never assigned", () => {
    expect(detectImageMarkersInLine("[Image #0] [Image] [Image #] [image #1] Image #1")).toEqual([]);
  });

  it("returns nothing for an empty or non-string line", () => {
    expect(detectImageMarkersInLine("")).toEqual([]);
    expect(detectImageMarkersInLine(undefined as never)).toEqual([]);
  });
});

describe("installImageMarkerLinkProvider", () => {
  it("emits a link for a placeholder in the line", () => {
    const { term, getRegistered } = makeFakeTerminal(["pasted [Image #4] there"]);
    installImageMarkerLinkProvider(term as never, { onActivateImage: vi.fn() });
    const links = linksFor(getRegistered, 1);
    expect(links).toHaveLength(1);
    expect(links[0].text).toBe("[Image #4]");
  });

  it("⌘-click activates with the id; a plain click does not", () => {
    const onActivateImage = vi.fn();
    const { term, getRegistered } = makeFakeTerminal(["x [Image #7]"]);
    installImageMarkerLinkProvider(term as never, { onActivateImage });
    const link = linksFor(getRegistered, 1)[0];

    link.activate({ metaKey: false } as MouseEvent, link.text);
    expect(onActivateImage).not.toHaveBeenCalled();

    link.activate({ metaKey: true } as MouseEvent, link.text);
    expect(onActivateImage).toHaveBeenCalledTimes(1);
    expect(onActivateImage.mock.calls[0][0]).toBe(7);
  });

  it("carries the id from the match, not the position of the link in the line", () => {
    // Two placeholders on one row: the SECOND must activate #9, not #1.
    // Getting this from ordinal position is exactly the bug that would make
    // a click open somebody else's screenshot.
    const onActivateImage = vi.fn();
    const { term, getRegistered } = makeFakeTerminal(["[Image #1] and [Image #9]"]);
    installImageMarkerLinkProvider(term as never, { onActivateImage });
    const links = linksFor(getRegistered, 1);
    expect(links).toHaveLength(2);
    links[1].activate({ metaKey: true } as MouseEvent, links[1].text);
    expect(onActivateImage.mock.calls[0][0]).toBe(9);
  });

  it("emits nothing for a line with no placeholder", () => {
    const { term, getRegistered } = makeFakeTerminal(["just some output"]);
    installImageMarkerLinkProvider(term as never, { onActivateImage: vi.fn() });
    expect(linksFor(getRegistered, 1)).toHaveLength(0);
  });

  it("calls back synchronously — xterm drops a link resolved later", () => {
    const { term, getRegistered } = makeFakeTerminal(["[Image #2]"]);
    installImageMarkerLinkProvider(term as never, { onActivateImage: vi.fn() });
    let called = false;
    getRegistered()!.provideLinks(1, () => {
      called = true;
    });
    expect(called).toBe(true);
  });
});
