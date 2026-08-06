import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  mountImage,
  renderImageError,
  formatByteSize,
  formatImageMeta,
  anchorScrollFor,
} from "./ImageRenderer";

let container: HTMLElement;
beforeEach(() => {
  document.body.innerHTML = "";
  container = document.createElement("div");
  document.body.appendChild(container);
});

/** jsdom never loads images, so drive the lifecycle by hand. */
function settle(
  img: HTMLImageElement,
  dims: { w: number; h: number } | "error",
): void {
  if (dims === "error") {
    img.dispatchEvent(new Event("error"));
    return;
  }
  Object.defineProperty(img, "naturalWidth", { value: dims.w, configurable: true });
  Object.defineProperty(img, "naturalHeight", { value: dims.h, configurable: true });
  img.dispatchEvent(new Event("load"));
}

const imgOf = (root: HTMLElement) =>
  root.querySelector("img.file-viewer-image-img") as HTMLImageElement;

const mount = (opts: Partial<Parameters<typeof mountImage>[1]> = {}) =>
  mountImage(container, {
    filePath: "/Users/me/shot.png",
    src: "reck-img://local/?p=%2FUsers%2Fme%2Fshot.png&v=1-2",
    byteSize: 421_888,
    ...opts,
  });

describe("formatByteSize", () => {
  it("scales through the units", () => {
    expect(formatByteSize(512)).toBe("512 B");
    expect(formatByteSize(1024)).toBe("1.0 KB");
    expect(formatByteSize(421_888)).toBe("412 KB");
    expect(formatByteSize(5 * 1024 * 1024)).toBe("5.0 MB");
  });
});

describe("formatImageMeta", () => {
  it("uses a real multiplication sign", () => {
    expect(formatImageMeta(1920, 1080, 421_888)).toBe("1920 × 1080 · 412 KB");
  });
  it("omits dimensions when they are unknown (unsized SVG)", () => {
    expect(formatImageMeta(0, 0, 421_888)).toBe("412 KB");
  });
});

describe("mountImage", () => {
  it("mounts an <img> pointing at the given URL, with the basename as alt", () => {
    const h = mount();
    const img = imgOf(h.el);
    expect(img).toBeTruthy();
    expect(img.getAttribute("src")).toContain("reck-img://");
    expect(img.getAttribute("alt")).toBe("shot.png");
  });

  // SVG must render THROUGH <img>, which puts Chromium in secure static
  // mode: no script execution, no external refs, no SMIL. Inlining it
  // would hand a hostile .svg a live DOM.
  it("never inlines SVG into the document", () => {
    const h = mount({ filePath: "/Users/me/d.svg" });
    expect(h.el.querySelector("svg")).toBeNull();
    expect(imgOf(h.el)).toBeInstanceOf(HTMLImageElement);
  });

  it("shows the byte size immediately and adds dimensions after load", async () => {
    const h = mount();
    const meta = h.el.querySelector(".file-viewer-image-meta-text")!;
    expect(meta.textContent).toBe("412 KB");
    settle(imgOf(h.el), { w: 1920, h: 1080 });
    await h.whenSettled();
    expect(meta.textContent).toBe("1920 × 1080 · 412 KB");
  });

  it("resolves whenSettled with the decoded dimensions", async () => {
    const h = mount();
    settle(imgOf(h.el), { w: 800, h: 600 });
    await expect(h.whenSettled()).resolves.toEqual({ ok: true, width: 800, height: 600 });
  });

  it("reports a decode failure and shows the error surface", async () => {
    const h = mount();
    settle(imgOf(h.el), "error");
    const settled = await h.whenSettled();
    expect(settled).toEqual({ ok: false, reason: "decode-failed" });
    expect(h.el.querySelector(".file-viewer-image-error")).toBeTruthy();
  });

  // A byte cap can't prevent this: a small compressed file can decode to
  // gigabytes, and Chromium just fires onerror. "May be corrupt" would be
  // actively misleading there.
  it("blames size, not corruption, when a large file fails to decode", async () => {
    const h = mount({ byteSize: 40 * 1024 * 1024 });
    settle(imgOf(h.el), "error");
    await h.whenSettled();
    expect(h.el.querySelector(".file-viewer-image-error")!.textContent).toMatch(
      /too large .* decode/i,
    );
  });

  describe("fit / actual toggle", () => {
    const zoomable = async () => {
      const h = mount();
      const img = imgOf(h.el);
      // Stage is 0x0 in jsdom, so any real image counts as oversized.
      settle(img, { w: 1920, h: 1080 });
      await h.whenSettled();
      return { h, img };
    };

    it("starts fitted and toggles to actual on click, and back", async () => {
      const { h, img } = await zoomable();
      expect(h.getFitMode()).toBe("fit");
      img.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(h.getFitMode()).toBe("actual");
      expect(h.el.getAttribute("data-fit")).toBe("actual");
      img.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(h.getFitMode()).toBe("fit");
    });

    // Cmd+click means "open this" everywhere else in the viewer; Lightbox
    // makes the same exclusion.
    it("ignores Cmd/Ctrl+click", async () => {
      const { h, img } = await zoomable();
      img.dispatchEvent(new MouseEvent("click", { bubbles: true, metaKey: true }));
      img.dispatchEvent(new MouseEvent("click", { bubbles: true, ctrlKey: true }));
      expect(h.getFitMode()).toBe("fit");
    });

    it("does not toggle when the gesture was a drag (panning in actual mode)", async () => {
      const { h, img } = await zoomable();
      img.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, clientX: 10, clientY: 10 }));
      img.dispatchEvent(new MouseEvent("mouseup", { bubbles: true, clientX: 90, clientY: 40 }));
      img.dispatchEvent(new MouseEvent("click", { bubbles: true, clientX: 90, clientY: 40 }));
      expect(h.getFitMode()).toBe("fit");
    });

    // Clicking an image that already fits and having "nothing happen"
    // reads as a bug, so the affordance is withheld instead.
    it("marks an image that already fits as non-zoomable and makes the click inert", async () => {
      const h = mount();
      const img = imgOf(h.el);
      Object.defineProperty(img, "naturalWidth", { value: 8, configurable: true });
      Object.defineProperty(img, "naturalHeight", { value: 8, configurable: true });
      const stage = h.el.querySelector(".file-viewer-image-stage") as HTMLElement;
      Object.defineProperty(stage, "clientWidth", { value: 400, configurable: true });
      Object.defineProperty(stage, "clientHeight", { value: 400, configurable: true });
      img.dispatchEvent(new Event("load"));
      await h.whenSettled();
      expect(h.el.getAttribute("data-zoomable")).toBe("false");
      img.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      expect(h.getFitMode()).toBe("fit");
    });

    it("treats an unsized SVG as non-zoomable and hides its dimensions", async () => {
      const h = mount({ filePath: "/a/icon.svg" });
      settle(imgOf(h.el), { w: 0, h: 0 });
      await h.whenSettled();
      expect(h.el.getAttribute("data-zoomable")).toBe("false");
      expect(h.el.querySelector(".file-viewer-image-meta-text")!.textContent).toBe("412 KB");
    });
  });

  it("invokes onOpenExternally from the meta-bar button", () => {
    const onOpenExternally = vi.fn();
    const h = mount({ onOpenExternally });
    (h.el.querySelector(".file-viewer-image-open") as HTMLButtonElement).click();
    expect(onOpenExternally).toHaveBeenCalledOnce();
  });

  it("dispose() empties the container and is idempotent", () => {
    const h = mount();
    h.dispose();
    expect(container.innerHTML).toBe("");
    expect(() => h.dispose()).not.toThrow();
  });
});

describe("renderImageError", () => {
  it("names the missing file and offers no system-viewer button", () => {
    renderImageError(container, { reason: "not-found", filePath: "/a/gone.png" });
    expect(container.textContent).toContain("/a/gone.png");
    expect(container.querySelector(".file-viewer-image-open")).toBeNull();
  });

  it("points at Settings for an out-of-roots path", () => {
    renderImageError(container, { reason: "out-of-roots", filePath: "/etc/x.png" });
    expect(container.textContent).toMatch(/Settings/);
    expect(container.querySelector(".file-viewer-image-open")).toBeNull();
  });

  it("offers the system viewer for formats it cannot decode", () => {
    const onOpenExternally = vi.fn();
    renderImageError(container, {
      reason: "unsupported",
      filePath: "/a/scan.tiff",
      onOpenExternally,
    });
    const btn = container.querySelector(".file-viewer-image-open") as HTMLButtonElement;
    expect(btn).toBeTruthy();
    btn.click();
    expect(onOpenExternally).toHaveBeenCalledOnce();
  });
});

describe("anchorScrollFor", () => {
  const natural = { width: 2000, height: 1000 };
  const stage = { width: 500, height: 250 };

  it("centres on the clicked point", () => {
    expect(anchorScrollFor({ clickFrac: { x: 0.5, y: 0.5 }, natural, stage })).toEqual({
      left: 750,
      top: 375,
    });
  });
  it("clamps at the edges rather than producing negative scroll", () => {
    expect(anchorScrollFor({ clickFrac: { x: 0, y: 0 }, natural, stage })).toEqual({
      left: 0,
      top: 0,
    });
    expect(anchorScrollFor({ clickFrac: { x: 1, y: 1 }, natural, stage })).toEqual({
      left: 1500,
      top: 750,
    });
  });
  it("does not scroll an axis that already fits", () => {
    expect(
      anchorScrollFor({
        clickFrac: { x: 0.5, y: 0.5 },
        natural: { width: 100, height: 100 },
        stage,
      }),
    ).toEqual({ left: 0, top: 0 });
  });
});
