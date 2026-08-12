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
        // `alt` is not optional: markdown-it's default image renderer does
        // `token.attrs[token.attrIndex("alt")][1] = ...` with no guard, so a
        // synthesized token without it throws at render time.
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
