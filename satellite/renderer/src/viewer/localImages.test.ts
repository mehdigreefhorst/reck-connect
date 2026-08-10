// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
// IMPORT ORDER IS LOAD-BEARING — do not reorder or let a formatter sort it.
// MarkdownRenderer must be imported BEFORE localImages, because that is the
// order production uses (the app entry reaches MarkdownRenderer, never
// localImages directly) and it is the order under which an import cycle
// between the two breaks. localImages builds its querySelector strings at
// module scope from RECK_IMAGE_SRC_ATTR, so if that constant is ever moved
// back into MarkdownRenderer — which imports localImages — this import
// initialises localImages while MarkdownRenderer is still half-evaluated.
// The selector pin below is what catches that.
import "./MarkdownRenderer";
import {
  enhanceLocalImages,
  IMAGE_PLACEHOLDER_CLASS,
  LOCAL_IMAGE_SELECTOR,
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
  it("builds its selector from a fully-initialised RECK_IMAGE_SRC_ATTR", () => {
    // Guards the constants' home (markdownImageSrc, a leaf module) against a
    // well-meaning move back into MarkdownRenderer. Under the import order
    // above, that move makes this read `undefined` and the selector becomes
    // the literal string `img[undefined]` — valid CSS that matches nothing,
    // so every local image would silently fail to render. Pinned explicitly
    // rather than left to emerge from the behavioural tests, because a
    // failure that throws nothing and logs nothing deserves a named guard.
    expect(LOCAL_IMAGE_SELECTOR).toBe("img[data-reck-src]");
  });

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

  // The three tests below cover the two post-await guards in `resolveOne`,
  // which the entry guard alone never reaches. Each was verified to go red
  // when its guard is deleted — see the task-3 fix report.

  it("writes nothing when stillCurrent goes false DURING the imageMeta round-trip", async () => {
    const el = mount('<img data-reck-src="./a.png">');
    // True at the entry guard, false by the time the IPC resolves — the
    // mid-flight re-render this branch exists for.
    let live = true;
    const imageMeta = vi.fn(async () => {
      live = false;
      return okMeta("reck-img://local/?p=/base/a.png&v=1-1");
    });

    await enhanceLocalImages(el, {
      baseDir: "/base",
      imageMeta,
      stillCurrent: () => live,
    });

    expect(imageMeta).toHaveBeenCalledTimes(1);
    const img = el.querySelector("img")!;
    expect(img.hasAttribute("src")).toBe(false);
    expect(img.getAttribute("data-reck-src")).toBe("./a.png");
    expect(el.querySelector(`.${IMAGE_PLACEHOLDER_CLASS}`)).toBeNull();
  });

  it("leaves unsupported-scheme images untouched when stillCurrent is false on entry", async () => {
    const el = mount('<img data-reck-image-unsupported="1" alt="x">');
    const imageMeta = vi.fn();

    await enhanceLocalImages(el, {
      baseDir: "/base",
      imageMeta,
      stillCurrent: () => false,
    });

    // The synchronous placeholder loop is a DOM write too, so the entry guard
    // must precede it.
    expect(el.querySelector("img")).not.toBeNull();
    expect(el.querySelector(`.${IMAGE_PLACEHOLDER_CLASS}`)).toBeNull();
  });

  it("writes nothing to an image detached from the DOM during the round-trip", async () => {
    const el = mount('<p><img data-reck-src="./a.png"></p>');
    const img = el.querySelector("img")!;
    // stillCurrent stays true: this exercises the isConnected guard alone,
    // i.e. the container survived but this element did not.
    const imageMeta = vi.fn(async () => {
      img.remove();
      return okMeta("reck-img://local/?p=/base/a.png&v=1-1");
    });

    await enhanceLocalImages(el, {
      baseDir: "/base",
      imageMeta,
      stillCurrent: () => true,
    });

    expect(imageMeta).toHaveBeenCalledTimes(1);
    expect(img.isConnected).toBe(false);
    expect(img.hasAttribute("src")).toBe(false);
    expect(img.getAttribute("data-reck-src")).toBe("./a.png");
  });
});
