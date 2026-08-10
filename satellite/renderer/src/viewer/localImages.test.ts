// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import {
  enhanceLocalImages,
  IMAGE_PLACEHOLDER_CLASS,
  type ImageMetaResult,
} from "./localImages";

function mount(html: string): HTMLElement {
  const el = document.createElement("div");
  el.innerHTML = html;
  document.body.appendChild(el);
  return el;
}

const okMeta = (url: string): ImageMetaResult => ({
  ok: true,
  resolvedPath: "/base/a.png",
  url,
  mime: "image/png",
  byteSize: 10,
  mtimeMs: 1,
});

describe("enhanceLocalImages", () => {
  it("resolves a relative path against baseDir and sets the minted url", async () => {
    const el = mount('<p><img data-reck-src="./a.png" alt="a"></p>');
    const imageMeta = vi.fn(async () => okMeta("reck-img://local/?p=/base/a.png&v=1-10"));

    await enhanceLocalImages(el, { baseDir: "/base", imageMeta });

    expect(imageMeta).toHaveBeenCalledWith("/base/a.png");
    const img = el.querySelector("img")!;
    expect(img.getAttribute("src")).toBe("reck-img://local/?p=/base/a.png&v=1-10");
    expect(img.hasAttribute("data-reck-src")).toBe(false);
  });

  it("passes an absolute path through without prepending baseDir", async () => {
    const el = mount('<p><img data-reck-src="/abs/b.png" alt="b"></p>');
    const imageMeta = vi.fn(async () => okMeta("reck-img://local/?p=/abs/b.png&v=1-10"));

    await enhanceLocalImages(el, { baseDir: "/base", imageMeta });

    expect(imageMeta).toHaveBeenCalledWith("/abs/b.png");
  });

  it("handles several images in one pass", async () => {
    const el = mount(
      '<img data-reck-src="./a.png"><img data-reck-src="./b.png">',
    );
    const imageMeta = vi.fn(async (p: string) => okMeta(`reck-img://local/?p=${p}&v=1-1`));

    await enhanceLocalImages(el, { baseDir: "/base", imageMeta });

    expect(imageMeta).toHaveBeenCalledTimes(2);
    const srcs = Array.from(el.querySelectorAll("img")).map((i) => i.getAttribute("src"));
    expect(srcs).toEqual([
      "reck-img://local/?p=/base/a.png&v=1-1",
      "reck-img://local/?p=/base/b.png&v=1-1",
    ]);
  });

  it("replaces an out-of-roots image with a placeholder naming the path", async () => {
    const el = mount('<p><img data-reck-src="../../etc/passwd.png" alt="x"></p>');
    const imageMeta = vi.fn(
      async (): Promise<ImageMetaResult> => ({
        ok: false,
        code: "out-of-roots",
        error: "Path is outside the allowed roots: /etc/passwd.png",
      }),
    );

    await enhanceLocalImages(el, { baseDir: "/base", imageMeta });

    expect(el.querySelector("img")).toBeNull();
    const ph = el.querySelector(`.${IMAGE_PLACEHOLDER_CLASS}`)!;
    expect(ph).not.toBeNull();
    expect(ph.textContent).toContain("outside the allowed folders");
    expect(ph.textContent).toContain("../../etc/passwd.png");
  });

  it("gives each imageMeta failure code its own message", async () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["not-found", "not found"],
      ["too-large", "too large"],
      ["unsupported", "unsupported image format"],
      ["is-directory", "a folder"],
      ["io-error", "could not be read"],
      ["invalid-input", "not a usable path"],
      ["some-future-code", "could not be displayed"],
    ];
    for (const [code, expected] of cases) {
      const el = mount('<img data-reck-src="./a.png">');
      await enhanceLocalImages(el, {
        baseDir: "/base",
        imageMeta: async () => ({ ok: false, code, error: "boom" }),
      });
      expect(el.querySelector(`.${IMAGE_PLACEHOLDER_CLASS}`)!.textContent).toContain(expected);
    }
  });

  it("placeholders a relative path when there is no baseDir", async () => {
    const el = mount('<img data-reck-src="./a.png">');
    const imageMeta = vi.fn();

    await enhanceLocalImages(el, { baseDir: null, imageMeta });

    expect(imageMeta).not.toHaveBeenCalled();
    expect(el.querySelector(`.${IMAGE_PLACEHOLDER_CLASS}`)!.textContent).toContain(
      "no folder to resolve it against",
    );
  });

  it("still resolves an absolute path when there is no baseDir", async () => {
    const el = mount('<img data-reck-src="/abs/a.png">');
    const imageMeta = vi.fn(async () => okMeta("reck-img://local/?p=/abs/a.png&v=1-1"));

    await enhanceLocalImages(el, { baseDir: null, imageMeta });

    expect(imageMeta).toHaveBeenCalledWith("/abs/a.png");
  });

  it("placeholders unsupported-scheme images without any IPC", async () => {
    const el = mount('<img data-reck-image-unsupported="1" alt="x">');
    const imageMeta = vi.fn();

    await enhanceLocalImages(el, { baseDir: "/base", imageMeta });

    expect(imageMeta).not.toHaveBeenCalled();
    expect(el.querySelector(`.${IMAGE_PLACEHOLDER_CLASS}`)!.textContent).toContain(
      "cannot be displayed",
    );
  });

  it("leaves remote images completely alone", async () => {
    const el = mount('<img src="https://example.com/a.png" alt="a">');
    const imageMeta = vi.fn();

    await enhanceLocalImages(el, { baseDir: "/base", imageMeta });

    expect(imageMeta).not.toHaveBeenCalled();
    expect(el.querySelector("img")!.getAttribute("src")).toBe("https://example.com/a.png");
  });

  it("does nothing and makes no IPC call when there are no local images", async () => {
    const el = mount("<p>just prose</p>");
    const imageMeta = vi.fn();

    await enhanceLocalImages(el, { baseDir: "/base", imageMeta });

    expect(imageMeta).not.toHaveBeenCalled();
  });

  it("abandons the pass without touching the DOM when stillCurrent goes false", async () => {
    const el = mount('<img data-reck-src="./a.png">');
    const imageMeta = vi.fn(async () => okMeta("reck-img://local/?p=/base/a.png&v=1-1"));

    await enhanceLocalImages(el, {
      baseDir: "/base",
      imageMeta,
      stillCurrent: () => false,
    });

    const img = el.querySelector("img")!;
    expect(img.hasAttribute("src")).toBe(false);
    expect(img.getAttribute("data-reck-src")).toBe("./a.png");
  });

  it("placeholders every image when the station host cannot serve them", async () => {
    const el = mount('<img data-reck-src="./a.png">');
    const imageMeta = vi.fn();

    await enhanceLocalImages(el, { baseDir: "/base", imageMeta, unsupportedHost: true });

    expect(imageMeta).not.toHaveBeenCalled();
    expect(el.querySelector(`.${IMAGE_PLACEHOLDER_CLASS}`)!.textContent).toContain(
      "on the station",
    );
  });

  it("never rejects when imageMeta throws", async () => {
    const el = mount('<img data-reck-src="./a.png">');
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    await expect(
      enhanceLocalImages(el, {
        baseDir: "/base",
        imageMeta: async () => {
          throw new Error("ipc down");
        },
      }),
    ).resolves.toBeUndefined();

    expect(el.querySelector(`.${IMAGE_PLACEHOLDER_CLASS}`)).not.toBeNull();
    warn.mockRestore();
  });
});
