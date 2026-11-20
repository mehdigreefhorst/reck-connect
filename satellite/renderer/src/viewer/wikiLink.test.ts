// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import {
  detectWikiLinksInLine,
  parseWikiLinkBody,
  WIKI_LINK_CLASS,
  wikiLinkHref,
} from "./wikiLink";
import { createMarkdownRenderer } from "./MarkdownRenderer";

describe("parseWikiLinkBody", () => {
  it("parses a bare note name", () => {
    expect(parseWikiLinkBody("robot-venture-training-data")).toEqual({
      target: "robot-venture-training-data",
      label: "robot-venture-training-data",
    });
  });

  it("uses the alias after the bar as the label", () => {
    expect(parseWikiLinkBody("robot-venture-training-data|Task data for robots")).toEqual({
      target: "robot-venture-training-data",
      label: "Task data for robots",
    });
  });

  it("accepts Obsidian's table-escaped bar `\\|`", () => {
    expect(parseWikiLinkBody("robot-venture-training-data\\|Task data")).toEqual({
      target: "robot-venture-training-data",
      label: "Task data",
    });
  });

  it("drops a #heading from the target but keeps it in the default label", () => {
    expect(parseWikiLinkBody("notes/plan#Phase 2")).toEqual({
      target: "notes/plan",
      label: "notes/plan#Phase 2",
    });
  });

  it("rejects empty and same-file heading-only links", () => {
    expect(parseWikiLinkBody("")).toBeNull();
    expect(parseWikiLinkBody("  |alias")).toBeNull();
    expect(parseWikiLinkBody("#Heading")).toBeNull();
  });
});

describe("wikiLinkHref", () => {
  it("appends .md to an extensionless note name", () => {
    expect(wikiLinkHref("robot-venture-training-data")).toBe("robot-venture-training-data.md");
  });

  it("keeps an explicit known extension", () => {
    expect(wikiLinkHref("deck.pdf")).toBe("deck.pdf");
    expect(wikiLinkHref("notes/plan.md")).toBe("notes/plan.md");
  });

  it("treats a dotted note name without a known extension as a note", () => {
    expect(wikiLinkHref("v1.2 release")).toBe("v1.2 release.md");
  });
});

describe("wikilinks in the markdown renderer", () => {
  const render = (src: string): HTMLElement => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const r = createMarkdownRenderer();
    r.mount(el, r.render(src));
    return el;
  };

  it("renders [[target|alias]] as an internal link showing the alias", () => {
    const el = render("See [[robot-venture-training-data|Task data for robots]].");
    const a = el.querySelector("a");
    expect(a?.textContent).toBe("Task data for robots");
    expect(a?.getAttribute("href")).toBe("robot-venture-training-data.md");
    expect(a?.classList.contains("reck-internal-link")).toBe(true);
    expect(el.textContent).not.toContain("[[");
  });

  it("renders a table-escaped wikilink inside a table cell", () => {
    const el = render(
      [
        "| # | Venture |",
        "|---|---|",
        "| 1 | [[robot-venture-training-data\\|Task data for robots]] |",
      ].join("\n"),
    );
    const cells = el.querySelectorAll("tbody td");
    expect(cells).toHaveLength(2);
    const a = cells[1]?.querySelector("a");
    expect(a?.textContent).toBe("Task data for robots");
    expect(a?.getAttribute("href")).toBe("robot-venture-training-data.md");
  });

  it("leaves ![[image]] embeds to the image rule", () => {
    const el = render("![[rack.png]]");
    expect(el.querySelector("a")).toBeNull();
    expect(el.querySelector("img")).not.toBeNull();
  });

  it("does not linkify wikilink syntax inside code spans", () => {
    const el = render("`[[not-a-link]]`");
    expect(el.querySelector("a")).toBeNull();
    expect(el.querySelector("code")?.textContent).toBe("[[not-a-link]]");
  });

  it("escapes HTML in the alias", () => {
    const el = render("[[note|<img src=x onerror=alert(1)>]]");
    expect(el.querySelector("img")).toBeNull();
    expect(el.querySelector("a")?.textContent).toBe("<img src=x onerror=alert(1)>");
  });

  it("hands the note href to onLinkActivate on ⌘+click", () => {
    const onLinkActivate = vi.fn();
    const el = document.createElement("div");
    document.body.appendChild(el);
    const r = createMarkdownRenderer({ onLinkActivate });
    r.mount(el, r.render("[[robot-venture-training-data|Task data]]"));
    el.querySelector("a")!.dispatchEvent(
      new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true }),
    );
    expect(onLinkActivate).toHaveBeenCalledWith(
      "robot-venture-training-data.md",
      expect.anything(),
    );
  });
});

// Issue #186: wikilinks outside rendered markdown — terminal scrollback and
// plain prose — need a line scanner, not a markdown-it rule.
describe("detectWikiLinksInLine", () => {
  it("finds a bare wikilink with its span and href", () => {
    const line = "see [[2026-11-19-stephan-offerte-bespreking]] for notes";
    const [m] = detectWikiLinksInLine(line);
    expect(m.text).toBe("[[2026-11-19-stephan-offerte-bespreking]]");
    expect(line.slice(m.start, m.end)).toBe(m.text);
    expect(m.href).toBe("2026-11-19-stephan-offerte-bespreking.md");
    expect(m.label).toBe("2026-11-19-stephan-offerte-bespreking");
  });

  it("handles alias, heading and folder forms", () => {
    expect(detectWikiLinksInLine("[[note|Shown text]]")[0]).toMatchObject({
      href: "note.md",
      label: "Shown text",
    });
    expect(detectWikiLinksInLine("[[folder/note#Phase 2]]")[0].href).toBe("folder/note.md");
    expect(detectWikiLinksInLine("[[diagram.png]]")[0].href).toBe("diagram.png");
  });

  it("finds several links on one line, in order", () => {
    const ms = detectWikiLinksInLine("[[a]] and [[b|B]] then [[c]]");
    expect(ms.map((m) => m.href)).toEqual(["a.md", "b.md", "c.md"]);
    expect(ms[0].end).toBeLessThanOrEqual(ms[1].start);
  });

  it("ignores image embeds, heading-only links and malformed brackets", () => {
    expect(detectWikiLinksInLine("![[photo.png]]")).toEqual([]);
    expect(detectWikiLinksInLine("[[#Heading]]")).toEqual([]);
    expect(detectWikiLinksInLine("[[]]")).toEqual([]);
    expect(detectWikiLinksInLine("[[unterminated")).toEqual([]);
    expect(detectWikiLinksInLine("arr[[0]][1]")[0]?.href).toBe("0.md");
  });

  it("returns nothing for empty or non-string input", () => {
    expect(detectWikiLinksInLine("")).toEqual([]);
    expect(detectWikiLinksInLine(undefined as unknown as string)).toEqual([]);
  });
});

describe("wikilinks in rendered markdown (issue #186)", () => {
  it("marks the anchor so click handlers can tell it from a detected path", () => {
    const r = createMarkdownRenderer({});
    const el = document.createElement("div");
    r.mount(el, r.render("see [[my-note|My note]]"));
    const a = el.querySelector("a")!;
    expect(a.classList.contains(WIKI_LINK_CLASS)).toBe(true);
    expect(a.getAttribute("href")).toBe("my-note.md");
    expect(a.textContent).toBe("My note");
  });

  it("opens on a plain click, without Cmd", () => {
    const onLinkActivate = vi.fn();
    const r = createMarkdownRenderer({ onLinkActivate });
    const el = document.createElement("div");
    r.mount(el, r.render("see [[my-note]]"));
    const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
    el.querySelector("a")!.dispatchEvent(ev);
    expect(onLinkActivate).toHaveBeenCalledWith("my-note.md", expect.any(MouseEvent));
    expect(ev.defaultPrevented).toBe(true);
  });

  it("an ordinary relative link still needs Cmd", () => {
    const onLinkActivate = vi.fn();
    const r = createMarkdownRenderer({ onLinkActivate });
    const el = document.createElement("div");
    r.mount(el, r.render("[x](./x.md)"));
    el.querySelector("a")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    expect(onLinkActivate).not.toHaveBeenCalled();
  });

  it("leaves a wikilink inside inline code literal, but still links a path there", () => {
    const r = createMarkdownRenderer({});
    const el = document.createElement("div");
    r.mount(el, r.render("syntax is `[[my-note]]`, file is `src/app/main.ts`"));
    const anchors = [...el.querySelectorAll("code a")];
    expect(anchors.map((x) => x.getAttribute("href"))).toEqual(["src/app/main.ts"]);
  });

  it("leaves wikilinks in fenced code blocks alone", () => {
    const r = createMarkdownRenderer({});
    const el = document.createElement("div");
    r.mount(el, r.render("```\n[[my-note]]\n```"));
    expect(el.querySelector("a")).toBeNull();
  });
});
