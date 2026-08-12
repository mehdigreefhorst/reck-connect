// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { classifyMarkdownImageSrc } from "./markdownImageSrc";

describe("classifyMarkdownImageSrc", () => {
  it("treats http(s) URLs as remote and passes them through unchanged", () => {
    expect(classifyMarkdownImageSrc("https://example.com/a.png")).toEqual({
      kind: "remote",
      src: "https://example.com/a.png",
    });
    // http is NOT upgraded to https — only protocol-relative is rewritten.
    expect(classifyMarkdownImageSrc("http://example.com/a.png")).toEqual({
      kind: "remote",
      src: "http://example.com/a.png",
    });
  });

  it("normalizes protocol-relative URLs to https", () => {
    // The page origin differs between dev (http://localhost:5173) and prod
    // (loadFile, i.e. file:), so an inherited scheme would diverge.
    expect(classifyMarkdownImageSrc("//example.com/a.png")).toEqual({
      kind: "remote",
      src: "https://example.com/a.png",
    });
  });

  it("treats data:image URIs as remote (already self-contained)", () => {
    expect(classifyMarkdownImageSrc("data:image/png;base64,iVBOR")).toEqual({
      kind: "remote",
      src: "data:image/png;base64,iVBOR",
    });
  });

  it("treats relative paths as local and preserves the raw path", () => {
    expect(classifyMarkdownImageSrc("./assets/rack.png")).toEqual({
      kind: "local",
      rawPath: "./assets/rack.png",
    });
    expect(classifyMarkdownImageSrc("assets/rack.png")).toEqual({
      kind: "local",
      rawPath: "assets/rack.png",
    });
    expect(classifyMarkdownImageSrc("../up/one.png")).toEqual({
      kind: "local",
      rawPath: "../up/one.png",
    });
  });

  it("treats absolute filesystem paths as local", () => {
    expect(classifyMarkdownImageSrc("/Users/me/shot.png")).toEqual({
      kind: "local",
      rawPath: "/Users/me/shot.png",
    });
  });

  it("treats home-anchored paths as local", () => {
    expect(classifyMarkdownImageSrc("~/shot.png")).toEqual({
      kind: "local",
      rawPath: "~/shot.png",
    });
  });

  it("trims surrounding whitespace from a local path", () => {
    expect(classifyMarkdownImageSrc("  ./a.png  ")).toEqual({
      kind: "local",
      rawPath: "./a.png",
    });
  });

  it("rejects an empty or whitespace-only src", () => {
    expect(classifyMarkdownImageSrc("").kind).toBe("unsupported");
    expect(classifyMarkdownImageSrc("   ").kind).toBe("unsupported");
  });

  it("rejects fragment-only and query-only srcs", () => {
    expect(classifyMarkdownImageSrc("#anchor").kind).toBe("unsupported");
    expect(classifyMarkdownImageSrc("?x=1").kind).toBe("unsupported");
  });

  it("rejects non-image data URIs", () => {
    expect(classifyMarkdownImageSrc("data:text/html,<b>x</b>").kind).toBe("unsupported");
  });

  it("rejects script-ish and unknown schemes", () => {
    expect(classifyMarkdownImageSrc("javascript:alert(1)").kind).toBe("unsupported");
    expect(classifyMarkdownImageSrc("JaVaScRiPt:alert(1)").kind).toBe("unsupported");
    expect(classifyMarkdownImageSrc("vbscript:x").kind).toBe("unsupported");
    expect(classifyMarkdownImageSrc("file:///etc/passwd").kind).toBe("unsupported");
    expect(classifyMarkdownImageSrc("reck-img://local/?p=/etc/passwd").kind).toBe("unsupported");
  });

  it("rejects a scheme smuggled past the regex with control characters", () => {
    // A browser strips tab/LF/CR anywhere in a URL before detecting the
    // scheme, so these are live javascript: URLs to it even though
    // SCHEME_RE sees no scheme.
    expect(classifyMarkdownImageSrc("jav\tascript:alert(1)").kind).toBe("unsupported");
    expect(classifyMarkdownImageSrc("java\nscript:alert(1)").kind).toBe("unsupported");
    expect(classifyMarkdownImageSrc("java\rscript:alert(1)").kind).toBe("unsupported");
  });

  it("rejects a control character embedded in an otherwise-local path", () => {
    expect(classifyMarkdownImageSrc("./a\u0007.png").kind).toBe("unsupported");
  });

  it("does not mistake a Windows-style drive letter for a scheme", () => {
    // Single-char 'scheme' is not a valid URI scheme; treat as a path.
    expect(classifyMarkdownImageSrc("C:/tmp/a.png").kind).toBe("local");
  });
});
