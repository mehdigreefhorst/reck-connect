// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from "vitest";
import { showImageOverlay, IMAGE_OVERLAY_CLASS } from "./ImageOverlay";
import { LIGHTBOX_CLASS } from "./Lightbox";

const SRC = "data:image/png;base64,iVBORw0KGgo";

describe("showImageOverlay", () => {
  let host: HTMLElement;

  beforeEach(() => {
    document.body.innerHTML = "";
    host = document.createElement("div");
    document.body.appendChild(host);
  });

  it("shows the image in the shared lightbox markup", () => {
    showImageOverlay({ host, src: SRC, alt: "Pasted image #3" });
    const box = host.querySelector(`.${IMAGE_OVERLAY_CLASS} .${LIGHTBOX_CLASS}`);
    expect(box?.getAttribute("role")).toBe("dialog");
    expect(box?.getAttribute("aria-label")).toBe("Pasted image #3");
    expect(box?.querySelector("img")?.getAttribute("src")).toBe(SRC);
  });

  it("replaces rather than stacks when opened twice", () => {
    showImageOverlay({ host, src: SRC, alt: "one" });
    showImageOverlay({ host, src: SRC, alt: "two" });
    const overlays = host.querySelectorAll(`.${IMAGE_OVERLAY_CLASS}`);
    expect(overlays).toHaveLength(1);
    expect(overlays[0].querySelector(`.${LIGHTBOX_CLASS}`)?.getAttribute("aria-label")).toBe("two");
  });

  it("closes on the backdrop but not on the image itself", () => {
    showImageOverlay({ host, src: SRC, alt: "x" });
    const box = host.querySelector(`.${LIGHTBOX_CLASS}`) as HTMLElement;
    box.querySelector("img")!.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(host.querySelector(`.${IMAGE_OVERLAY_CLASS}`)).not.toBeNull();
    box.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    expect(host.querySelector(`.${IMAGE_OVERLAY_CLASS}`)).toBeNull();
  });

  it("swallows the Escape that closes it, so the History overlay survives", () => {
    // Both listen for Escape on the document. Without stopPropagation a
    // single press would dismiss the image AND the conversation behind it.
    const behind = vi.fn();
    document.addEventListener("keydown", behind);
    showImageOverlay({ host, src: SRC, alt: "x" });
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(host.querySelector(`.${IMAGE_OVERLAY_CLASS}`)).toBeNull();
    expect(behind).not.toHaveBeenCalled();
    document.removeEventListener("keydown", behind);
  });

  it("stops listening once closed", () => {
    const handle = showImageOverlay({ host, src: SRC, alt: "x" });
    handle.close();
    handle.close(); // idempotent
    const after = vi.fn();
    document.addEventListener("keydown", after);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    // The overlay's captured handler is gone, so the press reaches everyone.
    expect(after).toHaveBeenCalledTimes(1);
    document.removeEventListener("keydown", after);
  });
});
