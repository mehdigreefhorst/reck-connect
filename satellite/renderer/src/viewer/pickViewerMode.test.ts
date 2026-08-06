import { describe, it, expect } from "vitest";
import {
  isMarkdownPath,
  isRenderablePath,
  pickViewerMode,
  isHtmlPath,
  isImagePath,
} from "./pickViewerMode";

describe("isMarkdownPath", () => {
  it("matches .md and .markdown case-insensitively", () => {
    expect(isMarkdownPath("/a/b.md")).toBe(true);
    expect(isMarkdownPath("/a/b.MARKDOWN")).toBe(true);
    expect(isMarkdownPath("/a/b.ts")).toBe(false);
  });
});

describe("isRenderablePath", () => {
  it("is true for markdown (Phase 0 scope)", () => {
    expect(isRenderablePath("/a/b.md")).toBe(true);
    expect(isRenderablePath("/a/b.ts")).toBe(false);
  });
});

describe("pickViewerMode", () => {
  it("renders markdown by default", () => {
    expect(pickViewerMode("/a/b.md", undefined)).toBe("markdown-rendered");
  });
  it("honours a persisted 'source' choice for markdown", () => {
    expect(pickViewerMode("/a/b.md", "source")).toBe("source");
  });
  it("uses source for non-renderable files regardless of persisted value", () => {
    expect(pickViewerMode("/a/b.ts", "rendered")).toBe("source");
    expect(pickViewerMode("/a/b.ts", undefined)).toBe("source");
    expect(pickViewerMode("/a/b.ts", "source")).toBe("source");
  });
  it("classifies extensions case-insensitively", () => {
    expect(pickViewerMode("/a/b.HTML", undefined)).toBe("html-static");
    expect(pickViewerMode("/a/README.MD", undefined)).toBe("markdown-rendered");
  });
});

describe("isImagePath", () => {
  it("matches every image extension, case-insensitively", () => {
    for (const ext of [
      "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "avif", "svg",
      // Transcoded to PNG in main; still image paths as far as the
      // viewer's dispatch is concerned.
      "tiff", "tif", "heic", "heif",
    ]) {
      expect(isImagePath(`/a/b.${ext}`)).toBe(true);
      expect(isImagePath(`/a/b.${ext.toUpperCase()}`)).toBe(true);
    }
  });
  it("does not match non-images", () => {
    for (const p of ["/a/b.md", "/a/b.ts", "/a/b.pdf", "/a/b.raw", "/a/b.psd"]) {
      expect(isImagePath(p)).toBe(false);
    }
  });
  it("requires a real extension, not a substring", () => {
    expect(isImagePath("/a/pngfile")).toBe(false);
    expect(isImagePath("/a/b.png.txt")).toBe(false);
  });
});

describe("pickViewerMode (image)", () => {
  it("returns 'image' for image paths", () => {
    expect(pickViewerMode("/a/b.png", undefined)).toBe("image");
  });
  // An image has no source view -- the bytes are binary and files.read
  // refuses them. A stale per-path "source" preference (easy to acquire on
  // .svg, which IS text) must not strand the file in CodeMirror.
  it("ignores a persisted 'source' choice -- images have no source view", () => {
    expect(pickViewerMode("/a/b.png", "source")).toBe("image");
    expect(pickViewerMode("/a/b.svg", "source")).toBe("image");
  });
  // isRenderablePath drives the rendered/source TOGGLE BUTTON, not "has a
  // non-source renderer". Adding images to it ships a broken "Edit source"
  // button on every PNG.
  it("keeps images out of isRenderablePath so no mode toggle is mounted", () => {
    expect(isRenderablePath("/a/b.png")).toBe(false);
    expect(isRenderablePath("/a/b.svg")).toBe(false);
  });
});

describe("isHtmlPath", () => {
  it("matches .html and .htm case-insensitively", () => {
    expect(isHtmlPath("/a/b.html")).toBe(true);
    expect(isHtmlPath("/a/b.HTM")).toBe(true);
    expect(isHtmlPath("/a/b.md")).toBe(false);
  });
});

describe("pickViewerMode (html)", () => {
  it("renders .html statically by default", () => {
    expect(pickViewerMode("/a/b.html", undefined)).toBe("html-static");
  });
  it("honours a persisted 'source' choice for .html", () => {
    expect(pickViewerMode("/a/b.html", "source")).toBe("source");
  });
  it("treats .html as renderable", () => {
    expect(isRenderablePath("/a/b.html")).toBe(true);
  });
});
