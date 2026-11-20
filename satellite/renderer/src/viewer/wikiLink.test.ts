// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { parseWikiLinkBody, wikiLinkHref } from "./wikiLink";
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
