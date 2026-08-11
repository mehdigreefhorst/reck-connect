// Markdown rendering surface for the file viewer.
//
// Pipeline:
//   markdown source
//     → markdown-it (html: false, GFM-ish features via plugins)
//     → fenced-code blocks highlighted by highlight.js
//     → DOMPurify sanitizes the HTML before innerHTML
//     → DOM-level Cmd+click interception rewrites internal-link clicks
//       into recursive openInViewer calls
//
// `html: false` is the real safety bar against raw `<script>` in markdown
// source; DOMPurify is belt-and-braces in case a future plugin re-enables
// HTML passthrough. Both are deliberate.

import MarkdownIt from "markdown-it";
import markdownItAnchor from "markdown-it-anchor";
import taskLists from "markdown-it-task-lists";
import hljs from "highlight.js/lib/common";
import DOMPurify, { type Config as DOMPurifyConfig } from "dompurify";
import { createRenderedDom, isInternalLinkHref } from "./renderedDom";
import {
  classifyMarkdownImageSrc,
  RECK_IMAGE_SRC_ATTR,
  RECK_IMAGE_UNSUPPORTED_ATTR,
} from "./markdownImageSrc";
import {
  enhanceMath,
  enhanceMermaid,
  type MermaidTheme,
} from "./markdownEnhancers";
import { enhanceLocalImages } from "./localImages";
import { wikiImagePlugin } from "./wikiImage";

export interface MarkdownRendererOptions {
  /**
   * Called when the user activates an `<a>` inside a mounted document with
   * the Cmd (meta) modifier held. The handler receives the raw href and the
   * underlying MouseEvent so the caller can decide whether to resolve it
   * relative to the opener, route external schemes elsewhere, etc.
   *
   * If omitted, Cmd+clicks do nothing special — useful in tests that only
   * exercise rendering.
   */
  onLinkActivate?: (href: string, ev: MouseEvent) => void;
  /**
   * Round 8.4 Bug C — Cmd+click handler for external `<a>` whose href is
   * NOT a relative path (http, https, mailto, etc.). The host can route
   * to `shell.openExternal` so external URLs open in the user's default
   * browser. Plain clicks still preventDefault unconditionally; only
   * Cmd+click invokes this callback. Omit to make external Cmd+clicks a
   * no-op (still no in-popup navigation).
   */
  onExternalActivate?: (href: string, ev: MouseEvent) => void;
  /**
   * Directory that relative image paths in the markdown resolve against.
   *
   * The renderer is handed only the markdown *text*, so it cannot know where
   * that text came from — the host must say. The file viewer passes the open
   * file's own directory; the transcript passes the session's project cwd.
   * Omit it and local images render as an explanatory placeholder instead of
   * silently vanishing.
   *
   * A function is re-read at every enhancement pass, for surfaces whose anchor
   * is not known when the renderer is built: the popout resolves its project
   * cwd asynchronously, and a snapshot taken before that lands would leave the
   * overlay placeholdering images whose paths ⌘+click resolves happily.
   */
  imageBaseDir?: string | null | (() => string | null);
  /**
   * Set when the markdown came from a host this process cannot serve files
   * for (today: station/SSH). Local images become placeholders and no
   * `imageMeta` IPC is attempted.
   */
  imagesUnsupportedHost?: boolean;
}

export interface MarkdownRenderer {
  /** Render markdown source to sanitized HTML. */
  render(markdown: string): string;
  /**
   * Replace `container`'s contents with `html` and wire up the Cmd+click
   * interception against the (sole) handler attached to `container`.
   */
  mount(container: HTMLElement, html: string): void;
  /**
   * Resolves once the post-mount enhancement passes (mermaid diagrams, KaTeX
   * math, local images) still in flight have settled — every container this
   * renderer has mounted into, not only the most recent one.
   *
   * `mount()` stays synchronous — callers that only need the prose on screen
   * are unaffected — but anything that depends on the *final* layout must
   * await this: the passes change document height, which moves scroll-spy
   * thresholds and scroll offsets. Tests await it for determinism.
   *
   * Never rejects: an enhancement failure degrades to the un-enhanced source
   * block rather than breaking the whole render.
   */
  whenEnhanced(): Promise<void>;
  /** Detach the click handler and clear internal references. */
  dispose(): void;
}

const INTERNAL_LINK_CLASS = "reck-internal-link";

/**
 * Round 7 Phase FF — native `title` tooltip shown on hover for every
 * Cmd-clickable path link (free-text wraps, markdown native links, and
 * the CodeMirror linkifier decoration). The OS surfaces it after ~1s.
 */
const PATH_LINK_TOOLTIP = "⌘+click to open";

function createMarkdownIt(): MarkdownIt {
  const md = new MarkdownIt({
    html: false,
    linkify: false,
    typographer: false,
    breaks: false,
    highlight: (code, lang) => {
      if (lang && hljs.getLanguage(lang)) {
        try {
          const result = hljs.highlight(code, {
            language: lang,
            ignoreIllegals: true,
          });
          return (
            `<pre class="hljs"><code class="hljs language-${lang}">` +
            result.value +
            "</code></pre>"
          );
        } catch {
          // fall through to plain rendering
        }
      }
      // Plain fenced block: defer to markdown-it's default escape so the
      // content is not HTML-interpreted.
      return "";
    },
  });

  md.use(markdownItAnchor, {
    slugify: (s) =>
      s
        .toLowerCase()
        .trim()
        .replace(/[^\w\s-]/g, "")
        .replace(/\s+/g, "-"),
  });
  md.use(taskLists, { enabled: false, label: true, labelAfter: true });
  // Obsidian-style `![[a.png]]` embeds. Emits a plain `image` token, so it
  // inherits the image renderer rule below, DOMPurify, and the local-image
  // enhancer without a second code path.
  md.use(wikiImagePlugin);

  // Override the default link renderer to add `class="reck-internal-link"`
  // for hrefs we treat as file references. We don't strip dangerous schemes
  // here — `validateLink` below handles that — we only annotate.
  const defaultLinkOpen =
    md.renderer.rules.link_open ??
    ((tokens, idx, options, _env, self) =>
      self.renderToken(tokens, idx, options));
  md.renderer.rules.link_open = (tokens, idx, options, env, self) => {
    const token = tokens[idx];
    const hrefAttr = token.attrGet("href") ?? "";
    if (isInternalLinkHref(hrefAttr)) {
      const existingClass = token.attrGet("class");
      token.attrSet(
        "class",
        existingClass ? `${existingClass} ${INTERNAL_LINK_CLASS}` : INTERNAL_LINK_CLASS,
      );
      // Round 7 Phase FF — native hover tooltip surfacing the keybind.
      if (!token.attrGet("title")) {
        token.attrSet("title", PATH_LINK_TOOLTIP);
      }
    }
    return defaultLinkOpen(tokens, idx, options, env, self);
  };

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
    if (classified.kind === "remote") {
      // Write the classifier's src back, don't just leave the authored one:
      // a protocol-relative `//host/a.png` is normalized to `https:` there,
      // and skipping this would silently discard that.
      token.attrSet("src", classified.src);
    } else {
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

  // Tighten markdown-it's link validator: it permits `javascript:` only under
  // explicit opt-in, but the default also allows `vbscript:` and `data:`
  // image/SVG. We restrict to schemes we will actually click through.
  md.validateLink = (url) => {
    if (!url) return false;
    const trimmed = url.trim().toLowerCase();
    if (trimmed.startsWith("javascript:")) return false;
    if (trimmed.startsWith("vbscript:")) return false;
    if (trimmed.startsWith("data:") && !trimmed.startsWith("data:image/")) {
      return false;
    }
    return true;
  };

  return md;
}

const PURIFY_CONFIG: DOMPurifyConfig = {
  // Allow the classes our renderer adds (especially reck-internal-link) and
  // the highlight.js classnames. Defaults preserve `class` for benign tags.
  // `loading`/`decoding` carry the lazy-image hints set in createMarkdownIt();
  // without them here DOMPurify strips the attributes straight back off.
  ALLOWED_ATTR: [
    "href",
    "title",
    "alt",
    "src",
    "class",
    "id",
    "type",
    "checked",
    "disabled",
    "loading",
    "decoding",
    // Parked local-image path + the unsupported-scheme marker, both set by
    // the image rule above. What actually keeps them is DOMPurify's
    // `ALLOW_DATA_ATTR` default (true), which short-circuits on the `data-*`
    // branch before any URI test runs; these two entries are belt-and-braces.
    //
    // Do NOT set `ALLOW_DATA_ATTR: false` to make them "load-bearing". With
    // it off, `data-reck-src` falls through to `IS_ALLOWED_URI`, which
    // rejects any value carrying an early colon — so a Windows path like
    // `data-reck-src="C:/tmp/a.png"` would be silently stripped and the
    // parked path would vanish.
    RECK_IMAGE_SRC_ATTR,
    RECK_IMAGE_UNSUPPORTED_ATTR,
    // Wikilink size hints (`![[a.png|300]]`). Attributes, never `style`:
    // a style attribute here would be a CSS-injection surface.
    "width",
    "height",
  ],
  ALLOWED_TAGS: [
    "a",
    "p",
    "br",
    "hr",
    "blockquote",
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "ul",
    "ol",
    "li",
    "strong",
    "em",
    "code",
    "pre",
    "span",
    "input",
    "img",
    "table",
    "thead",
    "tbody",
    "tr",
    "th",
    "td",
    "del",
    // §5 of docs/markdown-viewer-integration.md. NOTE: these are currently
    // unreachable through this pipeline — `html: false` escapes raw HTML in
    // markdown source long before DOMPurify sees it, so `<details>` renders as
    // the literal text `&lt;details&gt;` (pinned by a test). They are listed
    // as defense-in-depth for a future markdown-it plugin that emits them
    // through the render pipeline.
    //
    // Do NOT flip `html: true` to "make them work". That is the primary XSS
    // bar here — see the file header. Collapsible sections, if wanted, want a
    // narrow container plugin, not raw HTML passthrough.
    "details",
    "summary",
    "kbd",
  ],
  // Disallow form/iframe-style tags by omitting them from ALLOWED_TAGS.
  KEEP_CONTENT: true,
};

/** Mermaid's theme name for the app's current palette. Reads the same
 *  `data-theme` attribute the viewer already uses to theme CodeMirror. */
function currentMermaidTheme(): MermaidTheme {
  return document.documentElement.getAttribute("data-theme") === "dark"
    ? "dark"
    : "default";
}

export function createMarkdownRenderer(
  opts: MarkdownRendererOptions = {},
): MarkdownRenderer {
  const md = createMarkdownIt();
  const dom = createRenderedDom({
    onLinkActivate: opts.onLinkActivate,
    onExternalActivate: opts.onExternalActivate,
  });

  // Every mount() bumps the generation OF ITS CONTAINER, and dispose() bumps
  // a renderer-wide epoch. The enhancement passes capture both at kick-off
  // and re-check them after their lazy import resolves, so a container that
  // re-rendered — or a renderer that closed — while a several-hundred-KB
  // chunk was in flight never gets written into.
  //
  // Per container rather than one counter for the whole renderer: the
  // transcript overlay mounts a single renderer into many containers (one
  // markdown block per assistant turn), and a shared counter would let each
  // mount cancel the pass of every block mounted before it — only the last
  // block's images would ever paint.
  let epoch = 0;
  const generations = new WeakMap<HTMLElement, number>();
  // Passes still in flight. whenEnhanced() awaits all of them, not just the
  // newest mount's, and each drops out as it settles so the set cannot grow
  // with a long-lived renderer.
  const pending = new Set<Promise<void>>();

  async function enhance(
    container: HTMLElement,
    mine: number,
    myEpoch: number,
  ): Promise<void> {
    const stillCurrent = (): boolean =>
      epoch === myEpoch &&
      generations.get(container) === mine &&
      container.isConnected;
    if (!stillCurrent()) return;
    // Sequential, not concurrent: every pass mutates the same subtree, and
    // running them one after the other keeps the post-enhancement layout
    // deterministic for whoever awaits whenEnhanced().
    await enhanceMermaid(container, {
      theme: currentMermaidTheme(),
      stillCurrent,
    });
    await enhanceMath(container, { stillCurrent });
    // Last: the other two passes can inject or unwrap nodes, and this one
    // should see the final tree. It is also the only pass that does IPC,
    // so leaving it last keeps the cheap synchronous work off its latency.
    await enhanceLocalImages(container, {
      baseDir:
        typeof opts.imageBaseDir === "function"
          ? opts.imageBaseDir()
          : opts.imageBaseDir ?? null,
      unsupportedHost: opts.imagesUnsupportedHost === true,
      stillCurrent,
    });
  }

  return {
    render(markdown: string): string {
      const rawHtml = md.render(markdown);
      const cleaned = DOMPurify.sanitize(rawHtml, PURIFY_CONFIG);
      // DOMPurify.sanitize() returns either string or TrustedHTML depending
      // on the runtime; we always want the string form.
      return typeof cleaned === "string" ? cleaned : String(cleaned);
    },
    mount(container: HTMLElement, html: string): void {
      dom.mount(container, html);
      const mine = (generations.get(container) ?? 0) + 1;
      generations.set(container, mine);
      // The tracked promise is deliberately made un-rejectable. `enhance`
      // catches everything today, but a pass sitting in `pending` is
      // unawaited until someone calls whenEnhanced() — and the transcript
      // never does — so a future rejecting enhancer would surface as an
      // unhandled rejection rather than a degraded render.
      const pass: Promise<void> = enhance(container, mine, epoch)
        .catch((err: unknown) => {
          console.warn("[markdown] enhancement pass failed", err);
        })
        .finally(() => {
          pending.delete(pass);
        });
      pending.add(pass);
    },
    whenEnhanced(): Promise<void> {
      // allSettled, not all: `all` is fail-fast, so one rejecting pass would
      // reject the aggregate and break this method's documented "never
      // rejects" contract. `enhance` catches everything today, but that is a
      // property of three other modules — this makes it structural.
      return Promise.allSettled([...pending]).then(() => undefined);
    },
    dispose(): void {
      epoch++;
      dom.dispose();
    },
  };
}
