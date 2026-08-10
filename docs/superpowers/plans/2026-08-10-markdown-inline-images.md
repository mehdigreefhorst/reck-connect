# Inline Images in Rendered Markdown — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `![alt](./assets/rack.png)` and `![[rack.png]]` paint real pixels in the file-viewer popup and the transcript overlay, by routing local image paths through the existing `reck-img://` privileged scheme.

**Architecture:** Nothing is currently stripping images — `<img>`/`src`/`alt` already survive DOMPurify (`MarkdownRenderer.ts:177-240`) and there is already a custom `image` renderer rule (`:149-158`). Local images fail because `src` is emitted verbatim and resolves against the *popup page's* origin (`file-viewer.html` in prod, `localhost:5173` in dev), so it 404s. The fix mirrors what PR #146 did for standalone images: bytes travel over `reck-img://`, whose URL is minted **in main only** via `file:imageMeta`. Because minting is async IPC, the rewrite cannot happen during the synchronous `render()`; it happens in a **post-mount enhancer** on the live DOM, exactly like `enhanceMermaid`/`enhanceMath`. A pleasant consequence: `reck-img://` is attached *after* `DOMPurify.sanitize()`, so the URI allowlist needs no loosening at all.

**Tech Stack:** TypeScript, markdown-it 14, DOMPurify 3, Electron 30, Vitest (jsdom), Playwright (`playwright-electron.config.ts`).

## Global Constraints

- **Never mint a `reck-img://` URL in the renderer or preload.** `image-protocol.ts:262-271` states this invariant; URLs come only from `window.reckAPI.files.imageMeta()`. Violating it bypasses main's roots + extension + size gates.
- **Do not add `reck-img:` to DOMPurify's `ALLOWED_URI_REGEXP`, `ADD_URI_SAFE_ATTR`, or add a `addHook`.** The design deliberately avoids needing this. If you find yourself reaching for it, you have put the rewrite in the wrong place.
- **Do not flip markdown-it's `html: false`** (`MarkdownRenderer.ts:85`). It is the primary XSS bar — see the file header.
- **Do not lower mermaid's `securityLevel: "strict"`** (`markdownEnhancers.ts:128`).
- Remote images (`http(s)`, `data:image/`) **load freely and unchanged** — that is today's behaviour and the product decision. Do not add `neutralizeExternalRefs()` to the markdown path; that helper is wired only into `HtmlRenderer.ts:53` and must stay there.
- Every enhancement pass must **never reject** and must re-check `stillCurrent()` after every `await`, per the contract in `MarkdownRenderer.ts:259-278`.
- Station-hosted (`sourceHost: "station"`) markdown gets a **placeholder, not a fetch**. `reck-img://` parses a `station` host (`image-protocol.ts:289`) but only `local` is implemented.
- `HostRef = "station" | "local"` (`renderer/src/host.ts:12`).
- Run unit tests with `pnpm test` from `satellite/`; typecheck with `pnpm typecheck`. Vitest owns `renderer/**/*.test.ts`; Playwright owns `e2e*/**`.
- Test files start with the `// @vitest-environment jsdom` pragma and import from `vitest` explicitly (`globals: false`).

## File Structure

| File | Responsibility |
|---|---|
| `renderer/src/viewer/markdownImageSrc.ts` **(new)** | Pure classifier: given a raw `src` string, is it remote / local / unsupported. No DOM, no IPC. |
| `renderer/src/viewer/localImages.ts` **(new)** | The post-mount enhancer. The only pass that does IPC and the only one that needs a `baseDir` — kept out of `markdownEnhancers.ts` so that file stays "libraries that transform the DOM in place". |
| `renderer/src/viewer/wikiImage.ts` **(new)** | markdown-it inline rule for `![[target|size]]`. Emits a normal `image` token so it inherits the whole pipeline below it. |
| `renderer/src/viewer/MarkdownRenderer.ts` | Modified: image rule classifies + stamps `data-reck-src`, `PURIFY_CONFIG` gains three attrs, options gain `imageBaseDir`, `enhance()` gains a third pass. |
| `renderer/src/viewer/FileViewerHost.ts` | Modified: two `createMarkdownRenderer` call sites pass `imageBaseDir`. |
| `renderer/src/transcript/TranscriptView.ts` | Modified: options gain `imageBaseDir`, passed to `createMarkdownRenderer`. |
| `renderer/src/transcript/TranscriptController.ts` | Modified: deps gain `imageBaseDir(host)`, threaded to the view. |
| `renderer/src/boot.ts`, `renderer/src/popout.ts` | Modified: supply the project cwd as `imageBaseDir`, `null` for station. |
| `renderer/src/styles.css` | Modified: `.reck-image-missing` placeholder styling. |
| `e2e-electron/markdown-image.spec.ts` **(new)** | Proves the real protocol handler paints a real PNG inside rendered markdown. |

Task 1–4 deliver a working feature on their own (standard `![](…)` in the file viewer). Tasks 5, 6, 7 are independently shippable increments on top.

---

### Task 1: Image-source classifier

**Files:**
- Create: `satellite/renderer/src/viewer/markdownImageSrc.ts`
- Test: `satellite/renderer/src/viewer/markdownImageSrc.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `classifyMarkdownImageSrc(src: string): MarkdownImageSrc`, and the discriminated union `MarkdownImageSrc = { kind: "remote" } | { kind: "local"; rawPath: string } | { kind: "unsupported" }`. Task 2 and Task 3 both depend on these exact names.

- [ ] **Step 1: Write the failing test**

Create `satellite/renderer/src/viewer/markdownImageSrc.test.ts`:

```ts
// @vitest-environment jsdom
import { describe, it, expect } from "vitest";
import { classifyMarkdownImageSrc } from "./markdownImageSrc";

describe("classifyMarkdownImageSrc", () => {
  it("treats http(s) URLs as remote", () => {
    expect(classifyMarkdownImageSrc("https://example.com/a.png").kind).toBe("remote");
    expect(classifyMarkdownImageSrc("http://example.com/a.png").kind).toBe("remote");
  });

  it("treats protocol-relative URLs as remote", () => {
    expect(classifyMarkdownImageSrc("//example.com/a.png").kind).toBe("remote");
  });

  it("treats data:image URIs as remote (already self-contained)", () => {
    expect(classifyMarkdownImageSrc("data:image/png;base64,iVBOR").kind).toBe("remote");
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

  it("does not mistake a Windows-style drive letter for a scheme", () => {
    // Single-char 'scheme' is not a valid URI scheme; treat as a path.
    expect(classifyMarkdownImageSrc("C:/tmp/a.png").kind).toBe("local");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd satellite && pnpm vitest run renderer/src/viewer/markdownImageSrc.test.ts`
Expected: FAIL — `Failed to resolve import "./markdownImageSrc"`.

- [ ] **Step 3: Write minimal implementation**

Create `satellite/renderer/src/viewer/markdownImageSrc.ts`:

```ts
// Classifies the `src` of a markdown image token into the three cases the
// render pipeline treats differently.
//
// Why this exists as its own module: the decision is pure string logic, it is
// consumed from two very different places (the synchronous markdown-it
// renderer rule and the async post-mount enhancer), and getting it wrong is a
// security question rather than a cosmetic one. Keeping it pure means it is
// exhaustively testable without a DOM or an IPC stub.
//
// NOTE: markdown-it's `validateLink` (MarkdownRenderer.ts:163) has already
// blanked `javascript:`/`vbscript:`/non-image `data:` before a token reaches
// us. We re-check anyway — this module must be safe for any caller, and the
// wikilink rule (wikiImage.ts) builds tokens that never pass through
// validateLink at all.

export type MarkdownImageSrc =
  /** http(s), protocol-relative, or a self-contained data:image URI. Left
   *  exactly as authored — the browser loads it directly. */
  | { kind: "remote" }
  /** A filesystem path. Must be resolved against a base dir and handed to
   *  `files.imageMeta` before it can be displayed. */
  | { kind: "local"; rawPath: string }
  /** Anything we will not render: empty, a fragment, or a scheme we do not
   *  serve. Rendered as a placeholder. */
  | { kind: "unsupported" };

/** A URI scheme per RFC 3986: ALPHA *( ALPHA / DIGIT / "+" / "-" / "." ).
 *  Requires 2+ chars so a Windows drive letter (`C:/…`) reads as a path. */
const SCHEME_RE = /^[a-z][a-z0-9+.-]+:/i;

export function classifyMarkdownImageSrc(src: string): MarkdownImageSrc {
  const trimmed = src.trim();
  if (trimmed === "") return { kind: "unsupported" };
  if (trimmed.startsWith("#") || trimmed.startsWith("?")) {
    return { kind: "unsupported" };
  }
  // Protocol-relative — the page origin supplies http(s).
  if (trimmed.startsWith("//")) return { kind: "remote" };

  const scheme = SCHEME_RE.exec(trimmed)?.[0]?.toLowerCase();
  if (scheme) {
    if (scheme === "http:" || scheme === "https:") return { kind: "remote" };
    if (trimmed.slice(0, 11).toLowerCase() === "data:image/") {
      return { kind: "remote" };
    }
    // file:, reck-img:, javascript:, mailto:, anything else — not ours to
    // serve. Notably `file:` is refused on purpose: it works from a
    // loadFile origin in production but is blocked under the Vite dev
    // server, and the two must not diverge (see PR #146).
    return { kind: "unsupported" };
  }

  return { kind: "local", rawPath: trimmed };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd satellite && pnpm vitest run renderer/src/viewer/markdownImageSrc.test.ts`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add satellite/renderer/src/viewer/markdownImageSrc.ts satellite/renderer/src/viewer/markdownImageSrc.test.ts
git commit -m "feat(markdown): classify image srcs as remote, local, or unsupported"
```

---

### Task 2: Stamp local image paths onto `data-reck-src`

**Files:**
- Modify: `satellite/renderer/src/viewer/MarkdownRenderer.ts:149-158` (image rule) and `:182-194` (`ALLOWED_ATTR`)
- Test: `satellite/renderer/src/viewer/MarkdownRenderer.test.ts` (append a new `describe`)

**Interfaces:**
- Consumes: `classifyMarkdownImageSrc` from Task 1.
- Produces: the exported constant `RECK_IMAGE_SRC_ATTR = "data-reck-src"` and `RECK_IMAGE_UNSUPPORTED_ATTR = "data-reck-image-unsupported"` from `MarkdownRenderer.ts`. Task 3 imports `RECK_IMAGE_SRC_ATTR`.

**Why remove `src` rather than leave it:** an `<img>` whose `src` points at a path the page origin cannot serve fires a real network request and paints a broken-image glyph before the enhancer runs. Worse, setting `src=""` makes the browser re-request the *document itself*. Removing the attribute entirely gives a clean, silent element for the enhancer to fill.

- [ ] **Step 1: Write the failing test**

Append to `satellite/renderer/src/viewer/MarkdownRenderer.test.ts`, inside the top-level `describe("createMarkdownRenderer", …)`:

```ts
  describe("image sources", () => {
    /** Parse rendered HTML into a detached container so assertions are
     *  attribute-order-independent. */
    function imgFrom(html: string): HTMLImageElement | null {
      const host = document.createElement("div");
      host.innerHTML = html;
      return host.querySelector("img");
    }

    it("moves a relative image path to data-reck-src and drops src", () => {
      const r = createMarkdownRenderer();
      const img = imgFrom(r.render("![rack](./assets/rack.png)"));
      expect(img).not.toBeNull();
      expect(img!.getAttribute("data-reck-src")).toBe("./assets/rack.png");
      expect(img!.hasAttribute("src")).toBe(false);
      expect(img!.getAttribute("alt")).toBe("rack");
    });

    it("moves an absolute image path to data-reck-src", () => {
      const r = createMarkdownRenderer();
      const img = imgFrom(r.render("![s](/Users/me/shot.png)"));
      expect(img!.getAttribute("data-reck-src")).toBe("/Users/me/shot.png");
      expect(img!.hasAttribute("src")).toBe(false);
    });

    it("leaves a remote https image src untouched", () => {
      const r = createMarkdownRenderer();
      const img = imgFrom(r.render("![a](https://example.com/a.png)"));
      expect(img!.getAttribute("src")).toBe("https://example.com/a.png");
      expect(img!.hasAttribute("data-reck-src")).toBe(false);
    });

    it("leaves a data:image src untouched", () => {
      const r = createMarkdownRenderer();
      const img = imgFrom(r.render("![a](data:image/gif;base64,R0lGOD)"));
      expect(img!.getAttribute("src")).toBe("data:image/gif;base64,R0lGOD");
      expect(img!.hasAttribute("data-reck-src")).toBe(false);
    });

    it("marks an unsupported scheme instead of emitting a src", () => {
      const r = createMarkdownRenderer();
      const img = imgFrom(r.render("![a](file:///etc/passwd)"));
      expect(img!.hasAttribute("src")).toBe(false);
      expect(img!.hasAttribute("data-reck-src")).toBe(false);
      expect(img!.getAttribute("data-reck-image-unsupported")).toBe("1");
    });

    it("keeps the lazy-loading hints on a local image", () => {
      const r = createMarkdownRenderer();
      const img = imgFrom(r.render("![a](./a.png)"));
      expect(img!.getAttribute("loading")).toBe("lazy");
      expect(img!.getAttribute("decoding")).toBe("async");
    });

    it("survives DOMPurify — data-reck-src is not sanitized away", () => {
      const r = createMarkdownRenderer();
      // render() already runs DOMPurify; this test exists to pin that the
      // attribute is on the ALLOWED_ATTR list rather than surviving by
      // accident of DOMPurify's data-* default.
      expect(r.render("![a](./a.png)")).toContain("data-reck-src");
    });

    it("does not touch image syntax inside a fenced code block", () => {
      const r = createMarkdownRenderer();
      const html = r.render("```\n![a](./a.png)\n```");
      expect(html).not.toContain("data-reck-src");
      expect(html).toContain("![a](./a.png)");
    });
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd satellite && pnpm vitest run renderer/src/viewer/MarkdownRenderer.test.ts -t "image sources"`
Expected: FAIL — first failure is `expected null to be './assets/rack.png'` because `data-reck-src` is never set.

- [ ] **Step 3: Write minimal implementation**

In `MarkdownRenderer.ts`, add the import next to the existing ones (after the `renderedDom` import on line 20):

```ts
import { classifyMarkdownImageSrc } from "./markdownImageSrc";
```

Add these exported constants just below `const PATH_LINK_TOOLTIP = "⌘+click to open";` (line 81):

```ts
/**
 * Where a local image's authored path is parked between render and the
 * post-mount enhancer.
 *
 * The `src` attribute cannot hold it: a filesystem path resolves against the
 * popup page's origin (`file-viewer.html`, or `localhost:5173` in dev), so the
 * browser would fire a doomed request and paint a broken-image glyph in the
 * gap before `enhanceLocalImages` runs. Parking the path here and leaving the
 * element `src`-less makes that gap silent.
 *
 * The real URL is minted in main (`file:imageMeta`) and written onto the live
 * DOM *after* DOMPurify — which is why `reck-img:` never has to be added to
 * any sanitizer allowlist.
 */
export const RECK_IMAGE_SRC_ATTR = "data-reck-src";

/** Marks an image whose scheme we refuse to serve, so the enhancer can render
 *  a placeholder rather than leaving a 0×0 invisible element. */
export const RECK_IMAGE_UNSUPPORTED_ATTR = "data-reck-image-unsupported";
```

Replace the image renderer rule (lines 149-158) with:

```ts
  // Lazy-load images. Native attributes rather than an IntersectionObserver:
  // MarkView reaches for the observer because it wants custom fade-in
  // transitions, which we don't — and native works everywhere Electron does.
  // Same wrapper idiom as `link_open` above.
  //
  // Also routes local paths out of `src` and into RECK_IMAGE_SRC_ATTR — see
  // that constant's docstring for why.
  const defaultImage =
    md.renderer.rules.image ??
    ((tokens, idx, options, _env, self) =>
      self.renderToken(tokens, idx, options));
  md.renderer.rules.image = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    token.attrSet("loading", "lazy");
    token.attrSet("decoding", "async");

    const classified = classifyMarkdownImageSrc(token.attrGet("src") ?? "");
    if (classified.kind !== "remote") {
      // New array rather than an in-place splice: markdown-it has no
      // attrDelete, and tokens are shared with the anchor plugin's walk.
      token.attrs = (token.attrs ?? []).filter(([name]) => name !== "src");
      if (classified.kind === "local") {
        token.attrSet(RECK_IMAGE_SRC_ATTR, classified.rawPath);
      } else {
        token.attrSet(RECK_IMAGE_UNSUPPORTED_ATTR, "1");
      }
    }
    return defaultImage(tokens, idx, options, env, self);
  };
```

In `PURIFY_CONFIG.ALLOWED_ATTR` (line 182), add three entries after `"decoding",`:

```ts
    // Parked local-image path + the unsupported-scheme marker, both set by
    // the image rule above. DOMPurify's ALLOW_DATA_ATTR default would
    // probably keep them, but an explicit allowlist entry is the only
    // version that cannot change under a dependency bump.
    "data-reck-src",
    "data-reck-image-unsupported",
    // Wikilink size hints (`![[a.png|300]]`). Attributes, never `style`:
    // a style attribute here would be a CSS-injection surface.
    "width",
    "height",
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd satellite && pnpm vitest run renderer/src/viewer/MarkdownRenderer.test.ts`
Expected: PASS — the new 8 plus every pre-existing test in the file. If a pre-existing test asserted on `<img src=` for a relative path, that test encoded the bug; update it to assert `data-reck-src` and note why in the commit body.

Run: `cd satellite && pnpm typecheck`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add satellite/renderer/src/viewer/MarkdownRenderer.ts satellite/renderer/src/viewer/MarkdownRenderer.test.ts
git commit -m "feat(markdown): park local image paths on data-reck-src

A filesystem path in src resolves against the popup's own origin and
404s. Move it aside at render time so the element stays silent until the
post-mount enhancer can swap in a main-minted reck-img:// URL."
```

---

### Task 3: The `enhanceLocalImages` post-mount pass

**Files:**
- Create: `satellite/renderer/src/viewer/localImages.ts`
- Test: `satellite/renderer/src/viewer/localImages.test.ts`

**Interfaces:**
- Consumes: `RECK_IMAGE_SRC_ATTR`, `RECK_IMAGE_UNSUPPORTED_ATTR` (Task 2); `resolveActivatePath(filePath: string, projectCwd: string | null): string` from `./resolveActivatePath`.
- Produces: `enhanceLocalImages(container: HTMLElement, opts: EnhanceLocalImagesOptions): Promise<void>`, `LOCAL_IMAGE_SELECTOR`, `IMAGE_PLACEHOLDER_CLASS`, and the types `ImageMetaResult` / `EnhanceLocalImagesOptions`. Task 4 calls `enhanceLocalImages`; Task 4 also styles `IMAGE_PLACEHOLDER_CLASS`.

`resolveActivatePath` is reused rather than `window.reckAPI.paths.resolveAgainst` for two reasons: it is a pure renderer function (so this pass is testable in jsdom with no preload stub), and it already takes a *directory* base with the `~`/absolute passthrough semantics we want.

- [ ] **Step 1: Write the failing test**

Create `satellite/renderer/src/viewer/localImages.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd satellite && pnpm vitest run renderer/src/viewer/localImages.test.ts`
Expected: FAIL — `Failed to resolve import "./localImages"`.

- [ ] **Step 3: Write minimal implementation**

Create `satellite/renderer/src/viewer/localImages.ts`:

```ts
// Post-mount pass that turns parked local image paths into paintable
// `reck-img://` URLs.
//
// Runs after `MarkdownRenderer.mount()`, alongside enhanceMermaid/enhanceMath,
// and for the same structural reason as those two: the work cannot happen
// inside the synchronous `render()`. Here the blocker is specifically that
// minting a `reck-img://` URL is an IPC round-trip into main — main is the
// only place allowed to mint one, because that is where the allowed-roots,
// extension and size gates live (see main/image-protocol.ts:262-271).
//
// SECURITY — this writes `src` onto the live DOM *past* DOMPurify, which is
// deliberate and is what keeps `reck-img:` off the sanitizer's URI allowlist.
// The URL written here never originates in this file: it is whatever
// `files.imageMeta` returned, and that value already survived
// `resolveInsideAllowedRoots` + an extension allowlist in main. Do NOT
// construct a reck-img URL here, and do NOT copy an author-supplied string
// into `src`.

import {
  RECK_IMAGE_SRC_ATTR,
  RECK_IMAGE_UNSUPPORTED_ATTR,
} from "./MarkdownRenderer";
import { resolveActivatePath } from "./resolveActivatePath";

/** Mirrors the `file:imageMeta` IPC contract (preload/preload.ts:161-171). */
export type ImageMetaResult =
  | {
      ok: true;
      resolvedPath: string;
      url: string;
      mime: string;
      byteSize: number;
      mtimeMs: number;
    }
  | { ok: false; code: string; error: string };

export interface EnhanceLocalImagesOptions {
  /**
   * Directory that relative image paths resolve against — the open file's
   * own directory in the viewer, the session's project cwd in the
   * transcript. `null` means the surface has no anchor: absolute paths
   * still resolve, relative ones become a placeholder.
   */
  baseDir: string | null;
  /**
   * True when the markdown came from a host whose files this process cannot
   * serve (today: `sourceHost: "station"`). Every local image becomes a
   * placeholder and no IPC is attempted. `reck-img://` reserves a `station`
   * host but does not implement it yet.
   */
  unsupportedHost?: boolean;
  /** Same staleness contract as EnhanceMermaidOptions.stillCurrent. */
  stillCurrent?: () => boolean;
  /** Injectable for tests; defaults to `window.reckAPI.files.imageMeta`. */
  imageMeta?: (absPath: string) => Promise<ImageMetaResult>;
}

/** Images the markdown-it rule parked a filesystem path on. */
export const LOCAL_IMAGE_SELECTOR = `img[${RECK_IMAGE_SRC_ATTR}]`;

/** Images whose scheme we refuse to serve at all. */
const UNSUPPORTED_IMAGE_SELECTOR = `img[${RECK_IMAGE_UNSUPPORTED_ATTR}]`;

/** Class on the inline node that replaces an image we could not display. */
export const IMAGE_PLACEHOLDER_CLASS = "reck-image-missing";

/**
 * Human-readable reason per `handleImageMeta` failure code
 * (main/file-viewer.ts:381-447). Kept exhaustive on purpose: collapsing
 * these into one generic string is exactly the regression PR #146 called
 * out — seven distinguishable states must not become one silent onerror.
 */
function reasonFor(code: string): string {
  switch (code) {
    case "out-of-roots":
      return "it is outside the allowed folders";
    case "not-found":
      return "it was not found";
    case "too-large":
      return "it is too large to display";
    case "unsupported":
      return "it is an unsupported image format";
    case "is-directory":
      return "it is a folder, not an image";
    case "io-error":
      return "it could not be read";
    case "invalid-input":
      return "it is not a usable path";
    default:
      return "it could not be displayed";
  }
}

function placeholder(img: HTMLImageElement, message: string): void {
  const span = img.ownerDocument.createElement("span");
  span.className = IMAGE_PLACEHOLDER_CLASS;
  // textContent, never innerHTML: this node is built past DOMPurify, and
  // `message` embeds an author-supplied path.
  span.textContent = message;
  span.title = message;
  img.replaceWith(span);
}

async function resolveOne(
  img: HTMLImageElement,
  opts: EnhanceLocalImagesOptions,
  imageMeta: (absPath: string) => Promise<ImageMetaResult>,
): Promise<void> {
  const raw = img.getAttribute(RECK_IMAGE_SRC_ATTR) ?? "";

  if (opts.unsupportedHost) {
    placeholder(img, `Image “${raw}” lives on the station and cannot be shown here yet.`);
    return;
  }

  const isAnchored =
    raw.startsWith("/") || raw.startsWith("~/") || raw === "~";
  if (!isAnchored && !opts.baseDir) {
    placeholder(img, `Image “${raw}” has no folder to resolve it against.`);
    return;
  }

  const abs = resolveActivatePath(raw, opts.baseDir);

  let meta: ImageMetaResult;
  try {
    meta = await imageMeta(abs);
  } catch (err) {
    console.warn("[markdown] imageMeta threw", { raw, abs, err });
    meta = { ok: false, code: "io-error", error: String(err) };
  }

  // The container may have been re-rendered or disposed during the IPC.
  if (opts.stillCurrent && !opts.stillCurrent()) return;
  if (!img.isConnected) return;

  if (!meta.ok) {
    placeholder(img, `Image “${raw}” could not be shown — ${reasonFor(meta.code)}.`);
    return;
  }

  img.setAttribute("src", meta.url);
  img.removeAttribute(RECK_IMAGE_SRC_ATTR);
}

export async function enhanceLocalImages(
  container: HTMLElement,
  opts: EnhanceLocalImagesOptions,
): Promise<void> {
  // Checked before ANY DOM write, including the synchronous placeholder loop
  // below: an abandoned pass must leave the container exactly as it found it.
  if (opts.stillCurrent && !opts.stillCurrent()) return;

  for (const img of Array.from(
    container.querySelectorAll<HTMLImageElement>(UNSUPPORTED_IMAGE_SELECTOR),
  )) {
    placeholder(img, "This image cannot be displayed.");
  }

  const locals = Array.from(
    container.querySelectorAll<HTMLImageElement>(LOCAL_IMAGE_SELECTOR),
  );
  if (locals.length === 0) return;

  const imageMeta =
    opts.imageMeta ?? ((p: string) => window.reckAPI.files.imageMeta(p));

  // Concurrent: each image is an independent IPC round-trip, and a doc with
  // a dozen figures should not pay a dozen serial latencies. resolveOne
  // never throws, so allSettled would add nothing over all().
  await Promise.all(locals.map((img) => resolveOne(img, opts, imageMeta)));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd satellite && pnpm vitest run renderer/src/viewer/localImages.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 5: Commit**

```bash
git add satellite/renderer/src/viewer/localImages.ts satellite/renderer/src/viewer/localImages.test.ts
git commit -m "feat(markdown): add enhanceLocalImages post-mount pass

Mints each local image's reck-img:// URL through file:imageMeta and
writes it onto the live DOM past DOMPurify, so the sanitizer's URI
allowlist stays untouched. Each of the seven imageMeta failure codes
gets its own inline placeholder."
```

---

### Task 4: Wire the pass into the renderer and the file viewer

**Files:**
- Modify: `satellite/renderer/src/viewer/MarkdownRenderer.ts:27-47` (options), `:266-278` (`enhance`)
- Modify: `satellite/renderer/src/viewer/FileViewerHost.ts:1119` (station branch) and `:1619` (local branch)
- Modify: `satellite/renderer/src/styles.css`
- Test: `satellite/renderer/src/viewer/MarkdownRenderer.test.ts` (append), `satellite/renderer/src/viewer/FileViewerHost.test.ts` (append)

**Interfaces:**
- Consumes: `enhanceLocalImages`, `IMAGE_PLACEHOLDER_CLASS` (Task 3).
- Produces: two new fields on `MarkdownRendererOptions` — `imageBaseDir?: string | null` and `imagesUnsupportedHost?: boolean`. Task 6 sets `imageBaseDir` from the transcript.

- [ ] **Step 1: Write the failing test**

Append to `MarkdownRenderer.test.ts` inside the top-level describe:

```ts
  describe("local image enhancement", () => {
    it("swaps a local image's src for the minted url after mount", async () => {
      const imageMeta = vi.fn(async () => ({
        ok: true as const,
        resolvedPath: "/base/a.png",
        url: "reck-img://local/?p=/base/a.png&v=1-1",
        mime: "image/png",
        byteSize: 1,
        mtimeMs: 1,
      }));
      (window as unknown as { reckAPI: unknown }).reckAPI = { files: { imageMeta } };

      const r = createMarkdownRenderer({ imageBaseDir: "/base" });
      const host = document.createElement("div");
      document.body.appendChild(host);
      r.mount(host, r.render("![a](./a.png)"));
      await r.whenEnhanced();

      expect(imageMeta).toHaveBeenCalledWith("/base/a.png");
      expect(host.querySelector("img")!.getAttribute("src")).toBe(
        "reck-img://local/?p=/base/a.png&v=1-1",
      );
    });

    it("placeholders local images when no imageBaseDir was supplied", async () => {
      const imageMeta = vi.fn();
      (window as unknown as { reckAPI: unknown }).reckAPI = { files: { imageMeta } };

      const r = createMarkdownRenderer();
      const host = document.createElement("div");
      document.body.appendChild(host);
      r.mount(host, r.render("![a](./a.png)"));
      await r.whenEnhanced();

      expect(imageMeta).not.toHaveBeenCalled();
      expect(host.querySelector(".reck-image-missing")).not.toBeNull();
    });

    it("does not write into a container that was re-mounted mid-flight", async () => {
      let release!: () => void;
      const gate = new Promise<void>((res) => {
        release = res;
      });
      const imageMeta = vi.fn(async () => {
        await gate;
        return {
          ok: true as const,
          resolvedPath: "/base/a.png",
          url: "reck-img://local/?p=/base/a.png&v=1-1",
          mime: "image/png",
          byteSize: 1,
          mtimeMs: 1,
        };
      });
      (window as unknown as { reckAPI: unknown }).reckAPI = { files: { imageMeta } };

      const r = createMarkdownRenderer({ imageBaseDir: "/base" });
      const host = document.createElement("div");
      document.body.appendChild(host);
      r.mount(host, r.render("![a](./a.png)"));
      r.mount(host, r.render("# replaced"));
      release();
      await r.whenEnhanced();

      expect(host.querySelector("img")).toBeNull();
      expect(host.textContent).toContain("replaced");
    });
  });
```

Append to `FileViewerHost.test.ts`, adding `imageBaseDirOf` to its import from `./FileViewerHost`:

```ts
  describe("imageBaseDirOf", () => {
    it("returns the containing directory of a nested file", () => {
      expect(imageBaseDirOf("/Users/me/docs/guide.md")).toBe("/Users/me/docs");
    });

    it("returns root for a file at the filesystem root", () => {
      expect(imageBaseDirOf("/guide.md")).toBe("/");
    });

    it("returns empty for a bare filename with no directory", () => {
      expect(imageBaseDirOf("guide.md")).toBe("");
    });

    it("does not strip a trailing directory name", () => {
      expect(imageBaseDirOf("/a/b")).toBe("/a");
    });
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd satellite && pnpm vitest run renderer/src/viewer/MarkdownRenderer.test.ts -t "local image enhancement"`
Expected: FAIL — `imageMeta` is never called; `imageBaseDir` is not a recognised option.

Run: `cd satellite && pnpm vitest run renderer/src/viewer/FileViewerHost.test.ts -t "anchors markdown images"`
Expected: FAIL — `imageBaseDirOf is not defined`.

- [ ] **Step 3: Write minimal implementation**

**3a.** In `MarkdownRenderer.ts`, add to the imports:

```ts
import { enhanceLocalImages } from "./localImages";
```

**3b.** Add to `MarkdownRendererOptions` (after `onExternalActivate`, line 46):

```ts
  /**
   * Directory that relative image paths in the markdown resolve against.
   *
   * The renderer is handed only the markdown *text*, so it cannot know where
   * that text came from — the host must say. The file viewer passes the open
   * file's own directory; the transcript passes the session's project cwd.
   * Omit it and local images render as an explanatory placeholder instead of
   * silently vanishing.
   */
  imageBaseDir?: string | null;
  /**
   * Set when the markdown came from a host this process cannot serve files
   * for (today: station/SSH). Local images become placeholders and no
   * `imageMeta` IPC is attempted.
   */
  imagesUnsupportedHost?: boolean;
```

**3c.** Extend `enhance()` (line 266) with a third pass, after `enhanceMath`:

```ts
    await enhanceMath(container, { stillCurrent });
    // Last: the other two passes can inject or unwrap nodes, and this one
    // should see the final tree. It is also the only pass that does IPC,
    // so leaving it last keeps the cheap synchronous work off its latency.
    await enhanceLocalImages(container, {
      baseDir: opts.imageBaseDir ?? null,
      unsupportedHost: opts.imagesUnsupportedHost === true,
      stillCurrent,
    });
```

**3d.** In `FileViewerHost.ts`, add a small exported helper near the other pure helpers at the top of the file:

```ts
/**
 * Directory portion of a POSIX file path — the anchor for relative image
 * paths inside that file's markdown. `"/a/b/c.md"` → `"/a/b"`, `"/c.md"` →
 * `"/"`. Exported for test; deliberately not `paths.resolveAgainst`, which
 * needs a `rel` to resolve.
 */
export function imageBaseDirOf(filePath: string): string {
  const cut = filePath.lastIndexOf("/");
  if (cut < 0) return "";
  return cut === 0 ? "/" : filePath.slice(0, cut);
}
```

**3e.** In the **local** markdown branch (`FileViewerHost.ts:1619`), add to the `createMarkdownRenderer({…})` object literal:

```ts
      // Relative image paths anchor to the open file's own directory —
      // the same anchor onLinkActivate uses for relative hrefs below.
      imageBaseDir: imageBaseDirOf(result.resolvedPath),
```

**3f.** In the **station** markdown branch (`FileViewerHost.ts:1119`), add:

```ts
      // Station files are served over SSH; reck-img:// reserves a `station`
      // host but only implements `local`, so images placeholder for now.
      imageBaseDir: imageBaseDirOf(filePath),
      imagesUnsupportedHost: true,
```

**3g.** In `styles.css`, next to the existing `.file-viewer-body > p > img` block (~line 3148):

```css
/* Stand-in for a markdown image we could not display. Inline-block so it
   sits in the flow where the image would have been, and visually distinct
   from prose without shouting — a missing figure is information, not an
   error state the user caused. */
.reck-image-missing {
  display: inline-block;
  padding: 0.35em 0.6em;
  border: 1px dashed var(--border, #999);
  border-radius: 4px;
  color: var(--text-muted, #777);
  font-size: 0.9em;
  font-style: italic;
  max-width: 100%;
  overflow-wrap: anywhere;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd satellite && pnpm test`
Expected: PASS across the suite.

Run: `cd satellite && pnpm typecheck`
Expected: clean.

- [ ] **Step 5: Manual check, then commit**

Create `/tmp/imgtest/doc.md` containing `![rack](./rack.png)` with a real PNG beside it, inside a path covered by the viewer's allowed roots. Launch with `pnpm dev`, ⌘+click the path to open the popup, confirm the image paints and that clicking it opens the existing lightbox.

```bash
git add satellite/renderer/src/viewer/MarkdownRenderer.ts satellite/renderer/src/viewer/MarkdownRenderer.test.ts satellite/renderer/src/viewer/FileViewerHost.ts satellite/renderer/src/viewer/FileViewerHost.test.ts satellite/renderer/src/styles.css
git commit -m "feat(viewer): render local images inline in markdown

Relative image paths now anchor to the open file's directory and paint
over reck-img://. Station-hosted markdown placeholders its images: the
scheme reserves a station host but only serves local."
```

---

### Task 5: Wikilink embeds — `![[rack.png]]` and `![[rack.png|300]]`

**Files:**
- Create: `satellite/renderer/src/viewer/wikiImage.ts`
- Test: `satellite/renderer/src/viewer/wikiImage.test.ts`
- Modify: `satellite/renderer/src/viewer/MarkdownRenderer.ts:111-119` (plugin registration)

**Interfaces:**
- Consumes: nothing from earlier tasks at build time. At runtime its tokens flow through the Task 2 image rule and the Task 3 enhancer unchanged — that is the whole design: emit a bog-standard `image` token and inherit everything below it.
- Produces: `wikiImagePlugin(md: MarkdownIt): void` and `parseWikiImageBody(body: string): { target: string; width?: string; height?: string } | null`.

- [ ] **Step 1: Write the failing test**

Create `satellite/renderer/src/viewer/wikiImage.test.ts`:

```ts
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

  it("applies a size hint as width/height attributes", () => {
    const img = imgFrom(createMarkdownRenderer().render("![[a.png|300x200]]"));
    expect(img!.getAttribute("width")).toBe("300");
    expect(img!.getAttribute("height")).toBe("200");
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd satellite && pnpm vitest run renderer/src/viewer/wikiImage.test.ts`
Expected: FAIL — `Failed to resolve import "./wikiImage"`.

- [ ] **Step 3: Write minimal implementation**

Create `satellite/renderer/src/viewer/wikiImage.ts`:

```ts
// markdown-it inline rule for Obsidian-style image embeds: `![[target]]`
// and `![[target|300]]` / `![[target|300x200]]`.
//
// The rule emits an ordinary markdown-it `image` token rather than raw HTML,
// which is the entire point of doing it here: the token then flows through
// the same renderer rule, the same DOMPurify pass, and the same
// enhanceLocalImages IPC that `![alt](path)` does. No parallel code path, no
// second place to get the security gates right.
//
// Targets are always treated as paths relative to the surface's imageBaseDir.
// There is deliberately no vault-wide filename search: that needs an index,
// a watcher, and a rule for ambiguous matches, and nothing here needs it yet.

import type MarkdownIt from "markdown-it";
import type StateInline from "markdown-it/lib/rules_inline/state_inline.mjs";

export interface WikiImageParts {
  target: string;
  width?: string;
  height?: string;
}

/** `300` or `300x200`. Bare integers only — anything else is dropped rather
 *  than passed through, so a malformed hint can't reach the DOM. */
const SIZE_RE = /^(\d{1,5})(?:x(\d{1,5}))?$/;

export function parseWikiImageBody(body: string): WikiImageParts | null {
  const bar = body.indexOf("|");
  const rawTarget = (bar < 0 ? body : body.slice(0, bar)).trim();
  if (rawTarget === "") return null;
  if (bar < 0) return { target: rawTarget };

  const size = SIZE_RE.exec(body.slice(bar + 1).trim());
  if (!size) return { target: rawTarget };
  return size[2] !== undefined
    ? { target: rawTarget, width: size[1], height: size[2] }
    : { target: rawTarget, width: size[1] };
}

const OPEN = "![[";
const CLOSE = "]]";

export function wikiImagePlugin(md: MarkdownIt): void {
  // Registered BEFORE the core `image` rule: markdown-it's image rule also
  // triggers on `!` and would consume `![[a.png]]`'s brackets as a label
  // before failing to find the `(`, leaving the text mangled.
  md.inline.ruler.before(
    "image",
    "reck_wiki_image",
    (state: StateInline, silent: boolean): boolean => {
      const start = state.pos;
      if (!state.src.startsWith(OPEN, start)) return false;

      const bodyStart = start + OPEN.length;
      const end = state.src.indexOf(CLOSE, bodyStart);
      if (end < 0) return false;

      const body = state.src.slice(bodyStart, end);
      // A nested bracket means this isn't a simple embed; bail rather than
      // guess, and let the text render literally.
      if (body.includes("[") || body.includes("]") || body.includes("\n")) {
        return false;
      }

      const parts = parseWikiImageBody(body);
      if (!parts) return false;

      if (!silent) {
        const token = state.push("image", "img", 0);
        token.attrs = [
          ["src", parts.target],
          ["alt", ""],
        ];
        if (parts.width) token.attrPush(["width", parts.width]);
        if (parts.height) token.attrPush(["height", parts.height]);
        // markdown-it's default image renderer overwrites `alt` from the
        // token's children, so the filename has to live there to survive.
        const alt = new state.Token("text", "", 0);
        alt.content = parts.target;
        token.children = [alt];
        token.content = parts.target;
      }

      state.pos = end + CLOSE.length;
      return true;
    },
  );
}
```

In `MarkdownRenderer.ts`, add the import and register the plugin after the `taskLists` line (`:119`):

```ts
import { wikiImagePlugin } from "./wikiImage";
```

```ts
  md.use(taskLists, { enabled: false, label: true, labelAfter: true });
  md.use(wikiImagePlugin);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd satellite && pnpm vitest run renderer/src/viewer/wikiImage.test.ts renderer/src/viewer/MarkdownRenderer.test.ts`
Expected: PASS.

Note on the last test (`![[javascript:alert(1)]]`): the target reaches the Task 2 image rule as a `src`, `classifyMarkdownImageSrc` returns `unsupported`, and the rule strips `src` and marks it. This is why the classifier re-checks schemes even though `validateLink` normally would — wikilink tokens never pass through `validateLink`.

Run: `cd satellite && pnpm typecheck`
Expected: clean. If `markdown-it/lib/rules_inline/state_inline.mjs` does not resolve under this TS `moduleResolution`, import the type as `import type { StateInline } from "markdown-it/index.mjs"` — check `node_modules/@types/markdown-it/index.d.ts` for the exported name before guessing.

- [ ] **Step 5: Commit**

```bash
git add satellite/renderer/src/viewer/wikiImage.ts satellite/renderer/src/viewer/wikiImage.test.ts satellite/renderer/src/viewer/MarkdownRenderer.ts
git commit -m "feat(markdown): support ![[image.png]] wikilink embeds

Emits an ordinary image token so the embed inherits the same
sanitization and reck-img:// resolution as ![alt](path), with an
optional |300 or |300x200 size hint."
```

---

### Task 6: Images in the transcript overlay

**Files:**
- Modify: `satellite/renderer/src/transcript/TranscriptView.ts:30-43` (options), `:122` (renderer construction)
- Modify: `satellite/renderer/src/transcript/TranscriptController.ts:45-56` (deps), `:131` (view construction)
- Modify: `satellite/renderer/src/boot.ts:1210`, `satellite/renderer/src/popout.ts:310`
- Test: `satellite/renderer/src/transcript/TranscriptView.test.ts`, `satellite/renderer/src/transcript/TranscriptController.test.ts`

**Interfaces:**
- Consumes: `MarkdownRendererOptions.imageBaseDir` / `.imagesUnsupportedHost` (Task 4).
- Produces: `TranscriptViewOptions.imageBaseDir?: string | null`, `TranscriptViewOptions.imagesUnsupportedHost?: boolean`, and `TranscriptControllerDeps.imageBaseDir?(host: HostRef): string | null`.

The controller is deliberately "free of reckAPI + cwd knowledge" (`TranscriptController.ts:39`), so the cwd arrives through a dep the owner supplies — the same shape as the existing `linkHandlers(host)` seam. `HostRef` is `"station" | "local"`, so station panes pass `null` and get placeholders.

- [ ] **Step 1: Write the failing test**

The coverage lives entirely in `TranscriptController.test.ts`: it drives the *real* `createTranscriptView` against a real DOM, so testing the option plumbing again at the view level would assert the same thing twice.

Append to `satellite/renderer/src/transcript/TranscriptController.test.ts`. These are integration tests through the real view, matching the file's existing style — note `makeController` hardcodes `host: "station"`, so the local-host case builds its own controller:

```ts
  /** One assistant line, the mirror of this file's existing `userLine`. */
  const assistantLine = (text: string) =>
    JSON.stringify({
      isSidechain: false,
      type: "assistant",
      message: { role: "assistant", content: [{ type: "text", text }] },
      uuid: "a1",
    }) + "\n";

  it("resolves transcript images against the host's image base dir", async () => {
    const imageMeta = vi.fn(async () => ({
      ok: true as const,
      resolvedPath: "/proj/shot.png",
      url: "reck-img://local/?p=/proj/shot.png&v=1-1",
      mime: "image/png",
      byteSize: 1,
      mtimeMs: 1,
    }));
    (window as unknown as { reckAPI: unknown }).reckAPI = { files: { imageMeta } };

    const d = makeDeps({
      sessionId: SID,
      getTranscript: vi.fn(async () => chunk(assistantLine("![s](./shot.png)"), 7)),
    });
    const c = createTranscriptController({
      resolvePane: (paneId) =>
        paneId === "p_1"
          ? { wrapper: d.wrapper, kind: d.kind, host: "local", title: "p", sessionId: d.sessionId }
          : null,
      projectId: () => "proj",
      api: () => ({ listSessions: d.listSessions, getTranscript: d.getTranscript }),
      imageBaseDir: (host) => (host === "station" ? null : "/proj"),
      intervalMs: 1000,
      log: d.log,
    });

    await c.toggle("p_1");
    await vi.advanceTimersByTimeAsync(0);

    expect(imageMeta).toHaveBeenCalledWith("/proj/shot.png");
    expect(
      d.wrapper.querySelector("img")?.getAttribute("src"),
    ).toBe("reck-img://local/?p=/proj/shot.png&v=1-1");
  });

  it("placeholders transcript images on a station pane instead of fetching", async () => {
    const imageMeta = vi.fn();
    (window as unknown as { reckAPI: unknown }).reckAPI = { files: { imageMeta } };

    // makeController pins host: "station".
    const d = makeDeps({
      sessionId: SID,
      getTranscript: vi.fn(async () => chunk(assistantLine("![s](./shot.png)"), 7)),
    });
    const c = makeController(d);

    await c.toggle("p_1");
    await vi.advanceTimersByTimeAsync(0);

    expect(imageMeta).not.toHaveBeenCalled();
    expect(d.wrapper.querySelector(".reck-image-missing")).not.toBeNull();
  });
```

If `assistantLine`'s JSONL shape does not produce an assistant text turn, read `parseTranscript.ts` and match the shape it actually accepts — `userLine` in this file is the template for the envelope.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd satellite && pnpm vitest run renderer/src/transcript/`
Expected: FAIL — `imageBaseDir` is not an accepted option; `imageMeta` never called.

- [ ] **Step 3: Write minimal implementation**

**3a.** `TranscriptView.ts` — add to `TranscriptViewOptions`:

```ts
  /**
   * Directory relative image paths in assistant markdown resolve against —
   * the session's project cwd. Supplied by the owner (boot/popout), which is
   * the layer that knows about projects; `null` renders local images as
   * placeholders rather than guessing an anchor.
   */
  imageBaseDir?: string | null;
  /** True for a station-hosted pane: those files are served over SSH and
   *  `reck-img://` only implements the `local` host today. */
  imagesUnsupportedHost?: boolean;
```

Change line 122:

```ts
  const md: MarkdownRenderer = createMarkdownRenderer({
    imageBaseDir: opts.imageBaseDir ?? null,
    imagesUnsupportedHost: opts.imagesUnsupportedHost === true,
  });
```

**3b.** `TranscriptController.ts` — add to `TranscriptControllerDeps`:

```ts
  /**
   * Directory that relative image paths in this host's transcripts resolve
   * against (the active project's cwd). Same ownership split as
   * `linkHandlers`: the controller stays free of project/cwd knowledge.
   */
  imageBaseDir?(host: HostRef): string | null;
```

Add the `HostRef` import if the file does not already have one, then extend the `createTranscriptView` call at `:131`:

```ts
    const view = createTranscriptView({
      host: pane.wrapper,
      sessionId: pane.sessionId,
      onClose: () => close(paneId, "user"),
      imageBaseDir: deps.imageBaseDir ? deps.imageBaseDir(pane.host) : null,
      imagesUnsupportedHost: pane.host === "station",
      ...(deps.linkHandlers ? deps.linkHandlers(pane.host) : {}),
    });
```

**3c.** In `boot.ts:1210`, add to the `createTranscriptController({…})` literal, beside `linkHandlers`:

```ts
    // Relative image paths in a transcript anchor to the active project's
    // cwd — the same anchor `resolveActivatePath` uses for ⌘+clicked paths
    // in `linkHandlers` below. Station panes get null: their files are
    // served over SSH and reck-img:// only implements the local host.
    imageBaseDir: (host) =>
      host === "station"
        ? null
        : currentProjects.find((p) => p.id === currentProjectId)?.cwd ?? null,
```

**3d.** Apply the same addition at `popout.ts:310`, using whatever that file's equivalent of `currentProjects`/`currentProjectId` is. Read the surrounding `createTranscriptController` call and mirror its existing `linkHandlers` implementation — popout resolves the project the same way there.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd satellite && pnpm test`
Expected: PASS.

Run: `cd satellite && pnpm typecheck`
Expected: clean.

- [ ] **Step 5: Manual check, then commit**

With `pnpm dev`, open a Claude pane's History overlay on a session whose transcript contains a `![…](./something.png)` reference to a file in the project. Confirm it paints, and that a station pane's transcript shows the placeholder instead.

```bash
git add satellite/renderer/src/transcript satellite/renderer/src/boot.ts satellite/renderer/src/popout.ts
git commit -m "feat(transcript): render local images in assistant markdown

Relative paths anchor to the active project's cwd, matching how
⌘+clicked paths already resolve. Station panes placeholder instead."
```

---

### Task 7: End-to-end proof through the real protocol handler

**Files:**
- Create: `satellite/e2e-electron/imageFixtures.ts`
- Create: `satellite/e2e-electron/markdown-image.spec.ts`
- Modify: `satellite/e2e-electron/image-popup.spec.ts:22-79` (move `makePng` + `openPopup` into the shared module)

**Interfaces:**
- Consumes: the shipped app, plus `launchApp` from `./harness`.
- Produces: `makePng(width, height): Buffer` and `openPopup(ctx, filePath): Promise<Page>` in `imageFixtures.ts`.

Every unit test so far stubs `imageMeta`, so nothing yet proves bytes actually arrive. jsdom has no image decoder and no Electron `protocol`; `naturalWidth` inside the real app is the only assertion that can distinguish "wired up" from "paints".

- [ ] **Step 1: Extract the shared fixtures**

Create `satellite/e2e-electron/imageFixtures.ts` and move `makePng` (currently `image-popup.spec.ts:22-63`) and `openPopup` (`:65-79`) into it verbatim, adding `export` to each and this header:

```ts
// Shared fixtures for the image-related Electron acceptance specs.
//
// `makePng` generates a real PNG at test time rather than committing opaque
// binary, so the expected dimensions are visible in the call site. `openPopup`
// drives the real `file:openInViewer` IPC and waits for the spawned
// BrowserWindow.

import type { Page } from "@playwright/test";
import type { launchApp } from "./harness";
```

`openPopup`'s signature becomes:

```ts
export const openPopup = async (
  ctx: Awaited<ReturnType<typeof launchApp>>,
  filePath: string,
): Promise<Page> => { /* body unchanged */ };
```

Then replace both definitions in `image-popup.spec.ts` with:

```ts
import { makePng, openPopup } from "./imageFixtures";
```

Run: `cd satellite && pnpm build && pnpm test:e2e:electron image-popup.spec.ts`
Expected: PASS — an unchanged spec, proving the extraction was behaviour-neutral before anything new leans on it.

Commit this refactor on its own:

```bash
git add satellite/e2e-electron/imageFixtures.ts satellite/e2e-electron/image-popup.spec.ts
git commit -m "refactor(e2e): share makePng and openPopup between image specs"
```

- [ ] **Step 2: Write the failing test**

Create `satellite/e2e-electron/markdown-image.spec.ts`:

```ts
import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { launchApp } from "./harness";
import { makePng, openPopup } from "./imageFixtures";

// Acceptance tests for images INSIDE rendered markdown. The unit tests stub
// `files.imageMeta`, so they can only prove the wiring; whether a markdown
// figure actually decodes is answerable only here, against the real protocol
// handler and a real Chromium decoder.
//
// Fixtures live under the harness's temp HOME because $HOME is a built-in
// allowed root (main/file-roots.ts).

/** Writes `<home>/mddoc/doc.md` plus a sibling PNG, returns the .md path. */
function writeDoc(homeDir: string, markdown: string): string {
  const dir = path.join(homeDir, "mddoc");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "rack.png"), makePng(240, 120));
  const docPath = path.join(dir, "doc.md");
  fs.writeFileSync(docPath, markdown, "utf8");
  return docPath;
}

test("a relative markdown image decodes through reck-img://", async () => {
  const ctx = await launchApp();
  try {
    await expect(ctx.window.locator(".settings-card, .app-shell")).toBeVisible({
      timeout: 15_000,
    });
    const docPath = writeDoc(ctx.homeDir, "# Doc\n\n![rack](./rack.png)\n");
    const popup = await openPopup(ctx, docPath);

    const img = popup.locator(".file-viewer-body img").first();
    await expect(img).toBeVisible({ timeout: 10_000 });
    expect(await img.getAttribute("src")).toContain("reck-img://");

    // THE assertion: non-zero only if the handler served bytes and Chromium
    // decoded them.
    await expect
      .poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth), {
        timeout: 10_000,
      })
      .toBe(240);
    await expect(popup.locator(".reck-image-missing")).toHaveCount(0);

    await popup.screenshot({ path: "e2e/artifacts/markdown-image-electron.png" });
  } finally {
    await ctx.close();
  }
});

test("a wikilink embed decodes the same way", async () => {
  const ctx = await launchApp();
  try {
    await expect(ctx.window.locator(".settings-card, .app-shell")).toBeVisible({
      timeout: 15_000,
    });
    const docPath = writeDoc(ctx.homeDir, "# Doc\n\n![[rack.png]]\n");
    const popup = await openPopup(ctx, docPath);

    const img = popup.locator(".file-viewer-body img").first();
    await expect(img).toBeVisible({ timeout: 10_000 });
    await expect
      .poll(() => img.evaluate((el: HTMLImageElement) => el.naturalWidth), {
        timeout: 10_000,
      })
      .toBe(240);
  } finally {
    await ctx.close();
  }
});

test("a markdown image outside the allowed roots becomes a placeholder", async () => {
  const ctx = await launchApp();
  try {
    await expect(ctx.window.locator(".settings-card, .app-shell")).toBeVisible({
      timeout: 15_000,
    });
    // Enough `../` to climb out of the temp HOME entirely.
    const docPath = writeDoc(
      ctx.homeDir,
      "# Doc\n\n![x](../../../../../../etc/passwd.png)\n",
    );
    const popup = await openPopup(ctx, docPath);

    const placeholder = popup.locator(".reck-image-missing");
    await expect(placeholder).toHaveCount(1, { timeout: 10_000 });
    await expect(placeholder).toContainText("outside the allowed folders");
    // No <img> was left behind to fire a request.
    await expect(popup.locator(".file-viewer-body img")).toHaveCount(0);
  } finally {
    await ctx.close();
  }
});
```

- [ ] **Step 3: Run tests to verify they fail**

Stash the feature to prove the tests have teeth:

```bash
cd satellite && git stash push -- renderer/src && pnpm build && pnpm test:e2e:electron markdown-image.spec.ts
```
Expected: FAIL — `naturalWidth` is 0 and no `.reck-image-missing` exists, because `src` is never rewritten.

```bash
git stash pop
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd satellite && pnpm build && pnpm test:e2e:electron markdown-image.spec.ts`
Expected: PASS, 3 tests.

If it fails against the built app, check in this order: `data-reck-src` stripped (`ALLOWED_ATTR`, Task 2), `imageBaseDir` not threaded (`FileViewerHost.ts:1619`, Task 4), fixture outside the allowed roots (`main/file-roots.ts`).

- [ ] **Step 5: Commit**

```bash
git add satellite/e2e-electron/markdown-image.spec.ts
git commit -m "test(e2e): assert markdown images decode through reck-img://

Covers a relative ![](path), a ![[wikilink]] embed, and an out-of-roots
path that must degrade to a placeholder with no img element left behind."
```

---

## Deferred — explicitly out of scope

- **Station-hosted images.** Needs a `reck-img://station/` handler that streams over the existing SSH read path, plus a size policy distinct from the local 100 MB cap (`STATION_READ_MAX_BYTES` is 2 MB). Its own issue.
- **Vault-wide wikilink resolution.** `![[rack.png]]` resolves relative to `imageBaseDir` only — no filename index, no watcher, no ambiguity rules.
- **Quarto-style `{width=50%}` attribute blocks.** Would need `markdown-it-attrs` and a `<figure>/<figcaption>` renderer. The wikilink `|300` hint covers the sizing need for now.
- **Images in the CodeMirror source-editing mode.** Source mode shows text by design.
- **A CSP `img-src` directive.** No renderer HTML has a CSP meta tag today (`main.ts:60-85` notes that a future CSP must name `img-src reck-img:`). Adding one is a separate, app-wide change.
