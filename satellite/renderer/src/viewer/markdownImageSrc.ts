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
  /** http(s), protocol-relative, or a self-contained data:image URI. `src` is
   *  what the browser should actually load: the trimmed input, except for
   *  protocol-relative URLs, which are normalized (see below). */
  | { kind: "remote"; src: string }
  /** A filesystem path. Must be resolved against a base dir and handed to
   *  `files.imageMeta` before it can be displayed. */
  | { kind: "local"; rawPath: string }
  /** Anything we will not render: empty, a fragment, or a scheme we do not
   *  serve. Rendered as a placeholder. */
  | { kind: "unsupported" };

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
 *
 * Lives in this leaf module rather than next to the markdown-it rule that
 * writes it: the rule (MarkdownRenderer) and the enhancer (localImages) both
 * need it, and MarkdownRenderer imports localImages. Defining it there made
 * the two modules mutually dependent, and localImages — which builds its
 * querySelector strings at module scope — read the constant as `undefined`
 * whenever MarkdownRenderer happened to load first, i.e. in production.
 */
export const RECK_IMAGE_SRC_ATTR = "data-reck-src";

/** Marks an image whose scheme we refuse to serve, so the enhancer can render
 *  a placeholder rather than leaving a 0×0 invisible element. Same
 *  no-cycles reasoning as RECK_IMAGE_SRC_ATTR above. */
export const RECK_IMAGE_UNSUPPORTED_ATTR = "data-reck-image-unsupported";

/** A URI scheme per RFC 3986: ALPHA *( ALPHA / DIGIT / "+" / "-" / "." ).
 *  Requires 2+ chars so a Windows drive letter (`C:/…`) reads as a path. */
const SCHEME_RE = /^[a-z][a-z0-9+.-]+:/i;

/** C0 controls and DEL. A browser strips tab/LF/CR from *anywhere* in a URL
 *  before it detects the scheme, so `jav\tascript:` is a live `javascript:`
 *  URL to it while `SCHEME_RE` sees no scheme at all and would fall through
 *  to `local`. Nothing legitimate in this pipeline carries a control char, so
 *  we refuse the whole class rather than try to mirror the browser's
 *  normalization. */
const CONTROL_CHAR_RE = /[\u0000-\u001f\u007f]/;

export function classifyMarkdownImageSrc(src: string): MarkdownImageSrc {
  const trimmed = src.trim();
  if (trimmed === "") return { kind: "unsupported" };
  if (trimmed.startsWith("#") || trimmed.startsWith("?")) {
    return { kind: "unsupported" };
  }
  // Must precede the scheme test — see CONTROL_CHAR_RE.
  if (CONTROL_CHAR_RE.test(trimmed)) return { kind: "unsupported" };

  // Protocol-relative. Normalized to https: rather than passed through,
  // because it inherits the *page* scheme and our two environments do not
  // share one: dev loads `http://localhost:5173` (main.ts:207) while prod
  // uses `loadFile`, i.e. a `file:` origin (main.ts:209). Left alone,
  // `//host/a.png` would load in dev and silently fail in prod as
  // `file://host/a.png` — exactly the divergence that makes us refuse `file:`
  // below. https is the correct modern resolution of a mixed-HTTP-era idiom.
  // Do not "simplify" this back to a pass-through.
  if (trimmed.startsWith("//")) {
    return { kind: "remote", src: `https:${trimmed}` };
  }

  const scheme = SCHEME_RE.exec(trimmed)?.[0]?.toLowerCase();
  if (scheme) {
    // http is left as authored — only protocol-relative is rewritten; we do
    // not silently upgrade an explicit http: URL to https:.
    if (scheme === "http:" || scheme === "https:") {
      return { kind: "remote", src: trimmed };
    }
    if (trimmed.slice(0, 11).toLowerCase() === "data:image/") {
      return { kind: "remote", src: trimmed };
    }
    // file:, reck-img:, javascript:, mailto:, anything else — not ours to
    // serve. Notably `file:` is refused on purpose: it works from a
    // loadFile origin in production but is blocked under the Vite dev
    // server, and the two must not diverge (see PR #146).
    return { kind: "unsupported" };
  }

  return { kind: "local", rawPath: trimmed };
}
