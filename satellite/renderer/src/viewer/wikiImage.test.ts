// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { parseWikiImageBody } from "./wikiImage";
import { createMarkdownRenderer } from "./MarkdownRenderer";

describe("parseWikiImageBody", () => {
  it("parses a bare target", () => {
    expect(parseWikiImageBody("rack.png")).toEqual({ target: "rack.png" });
  });

  it("parses a target with a subdirectory", () => {
    expect(parseWikiImageBody("assets/rack.png")).toEqual({ target: "assets/rack.png" });
  });

  it("parses a width-only size hint", () => {
    expect(parseWikiImageBody("rack.png|300")).toEqual({ target: "rack.png", width: "300" });
  });

  it("parses a width x height size hint", () => {
    expect(parseWikiImageBody("rack.png|300x200")).toEqual({
      target: "rack.png",
      width: "300",
      height: "200",
    });
  });

  it("trims whitespace around target and size", () => {
    expect(parseWikiImageBody("  rack.png | 300 ")).toEqual({
      target: "rack.png",
      width: "300",
    });
  });

  it("ignores a non-numeric size hint rather than emitting a bad attribute", () => {
    expect(parseWikiImageBody("rack.png|large")).toEqual({ target: "rack.png" });
  });

  it("rejects an empty target", () => {
    expect(parseWikiImageBody("")).toBeNull();
    expect(parseWikiImageBody("|300")).toBeNull();
  });
});

describe("wikilink image rendering", () => {
  function imgFrom(html: string): HTMLImageElement | null {
    const host = document.createElement("div");
    host.innerHTML = html;
    return host.querySelector("img");
  }

  it("renders ![[a.png]] as a local image", () => {
    const img = imgFrom(createMarkdownRenderer().render("![[a.png]]"));
    expect(img).not.toBeNull();
    expect(img!.getAttribute("data-reck-src")).toBe("a.png");
    expect(img!.hasAttribute("src")).toBe(false);
  });

  it("uses the target as alt text so a missing image still reads", () => {
    const img = imgFrom(createMarkdownRenderer().render("![[assets/a.png]]"));
    expect(img!.getAttribute("alt")).toBe("assets/a.png");
  });

  // Regression guard for the crash hazard specific to synthesized tokens:
  // markdown-it's default image renderer does
  // `token.attrs[token.attrIndex("alt")][1] = ...` with no guard, so a token
  // pushed without an `alt` attribute throws a TypeError at render time
  // rather than merely losing its alt text. Rendering at all is the assertion.
  it("does not throw when rendering a wikilink (alt attribute must be present)", () => {
    expect(() => createMarkdownRenderer().render("![[a.png]]")).not.toThrow();
    expect(() => createMarkdownRenderer().render("![[a.png|300x200]]")).not.toThrow();
  });

  it("applies a size hint as width/height attributes", () => {
    const img = imgFrom(createMarkdownRenderer().render("![[a.png|300x200]]"));
    expect(img!.getAttribute("width")).toBe("300");
    expect(img!.getAttribute("height")).toBe("200");
  });

  it("never expresses a size hint as a style attribute", () => {
    const img = imgFrom(createMarkdownRenderer().render("![[a.png|300x200]]"));
    expect(img!.hasAttribute("style")).toBe(false);
  });

  it("renders inline among surrounding prose", () => {
    const html = createMarkdownRenderer().render("before ![[a.png]] after");
    expect(html).toContain("before");
    expect(html).toContain("after");
    expect(imgFrom(html)).not.toBeNull();
  });

  it("leaves a non-image wikilink [[a]] as literal text", () => {
    const html = createMarkdownRenderer().render("[[a]]");
    expect(html).toContain("[[a]]");
    expect(imgFrom(html)).toBeNull();
  });

  it("leaves an unterminated ![[ as literal text", () => {
    const html = createMarkdownRenderer().render("![[a.png");
    expect(html).toContain("![[a.png");
    expect(imgFrom(html)).toBeNull();
  });

  it("does not fire inside inline code", () => {
    const html = createMarkdownRenderer().render("`![[a.png]]`");
    expect(imgFrom(html)).toBeNull();
    expect(html).toContain("![[a.png]]");
  });

  it("does not fire inside a fenced code block", () => {
    const html = createMarkdownRenderer().render("```\n![[a.png]]\n```");
    expect(imgFrom(html)).toBeNull();
  });

  it("still renders standard markdown images", () => {
    const img = imgFrom(createMarkdownRenderer().render("![x](./b.png)"));
    expect(img!.getAttribute("data-reck-src")).toBe("./b.png");
  });

  it("does not let a wikilink target smuggle in a scheme", () => {
    const img = imgFrom(createMarkdownRenderer().render("![[javascript:alert(1)]]"));
    expect(img!.hasAttribute("src")).toBe(false);
    expect(img!.hasAttribute("data-reck-src")).toBe(false);
  });
});
