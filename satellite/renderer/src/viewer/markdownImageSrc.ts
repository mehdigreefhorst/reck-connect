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
