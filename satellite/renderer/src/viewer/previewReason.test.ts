import { describe, it, expect } from "vitest";
import { previewReasonCopy } from "./previewReason";

describe("previewReasonCopy", () => {
  it("maps no-vite-app", () => {
    expect(previewReasonCopy("no-vite-app").title).toMatch(/no live preview/i);
  });
  it("maps vite-no-react", () => {
    expect(previewReasonCopy("vite-no-react").body).toMatch(/react/i);
  });
  it("maps read-error to a distinct title", () => {
    expect(previewReasonCopy("read-error").title).toMatch(/couldn't read/i);
  });
  it("falls back to the no-vite-app copy for an unknown reason", () => {
    // `ok` is not a real not-previewable reason; treat it like the default.
    expect(previewReasonCopy("ok").title).toMatch(/no live preview/i);
  });
});
