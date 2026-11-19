import { describe, it, expect, vi } from "vitest";
import { createOscLinkHandler, isWebUrl } from "./web-link";

describe("isWebUrl", () => {
  it("accepts http and https URLs", () => {
    expect(isWebUrl("https://example.com/x?y=1#z")).toBe(true);
    expect(isWebUrl("http://localhost:5173/")).toBe(true);
    expect(isWebUrl("HTTPS://EXAMPLE.COM")).toBe(true);
  });

  it("rejects every other scheme", () => {
    for (const href of [
      "mailto:a@b.c",
      "file:///etc/passwd",
      "javascript:alert(1)",
      "x-apple-reminderkit://x",
      "about:blank",
      "data:text/html,<b>x</b>",
    ]) {
      expect(isWebUrl(href), href).toBe(false);
    }
  });

  it("rejects paths, fragments, empty and non-string input", () => {
    for (const href of ["./x.md", "/abs/path", "~/notes.md", "#top", "", "https://", "example.com"]) {
      expect(isWebUrl(href), href).toBe(false);
    }
    expect(isWebUrl(undefined)).toBe(false);
    expect(isWebUrl(null)).toBe(false);
  });
});

// xterm's built-in OSC 8 handler calls window.open() with NO url and then
// assigns location. In the satellite that blank open is denied by the main
// process's scheme allowlist, so explicit terminal hyperlinks did nothing
// (issue #180). This handler opens the real URL in one step instead.
describe("createOscLinkHandler", () => {
  it("opens an http/https hyperlink with the URL itself", () => {
    const open = vi.fn();
    createOscLinkHandler(open).activate(new MouseEvent("click"), "https://example.com/docs");
    expect(open).toHaveBeenCalledTimes(1);
    expect(open).toHaveBeenCalledWith("https://example.com/docs");
  });

  it("ignores hyperlinks with any other scheme", () => {
    const open = vi.fn();
    const handler = createOscLinkHandler(open);
    handler.activate(new MouseEvent("click"), "file:///etc/passwd");
    handler.activate(new MouseEvent("click"), "javascript:alert(1)");
    handler.activate(new MouseEvent("click"), "about:blank");
    expect(open).not.toHaveBeenCalled();
  });

  it("does not opt in to non-http protocols", () => {
    expect(createOscLinkHandler(vi.fn()).allowNonHttpProtocols).toBeFalsy();
  });
});
