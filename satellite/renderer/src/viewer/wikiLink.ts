// markdown-it inline rule for Obsidian-style note links: `[[note]]`,
// `[[note|alias]]`, `[[folder/note#heading|alias]]`, and the table-escaped
// `[[note\|alias]]` Obsidian writes inside GFM tables.
//
// Like wikiImage.ts, the rule emits ordinary `link_open` / `text` /
// `link_close` tokens rather than raw HTML, so a wikilink flows through the
// same link renderer (reck-internal-link class + tooltip), the same
// DOMPurify pass and the same ⌘+click handler as `[alias](note.md)`.
//
// Resolution is deliberately NOT done here. The href is the note name with
// `.md` appended; the click handler resolves it against the open file's
// folder, and on a miss main's suffix search finds the note anywhere in the
// project by file name — which is exactly Obsidian's "shortest path" rule
// for a unique note name.

import type MarkdownIt from "markdown-it";
import type StateInline from "markdown-it/lib/rules_inline/state_inline.mjs";

export interface WikiLinkParts {
  /** Note path without any `#heading`, e.g. `robot-venture-training-data`. */
  target: string;
  /** Visible text: the alias, or the raw link body when there is none. */
  label: string;
}

/** Extensions Obsidian links to as files; anything else is a note name
 *  (`[[v1.2 release]]` is the note `v1.2 release.md`, not a `.2 release`
 *  file). */
const FILE_EXT_RE =
  /\.(md|markdown|canvas|pdf|png|jpe?g|gif|webp|svg|bmp|avif|txt|csv|json|ya?ml|html?|mp3|mp4|mov|webm|wav|m4a|xml)$/i;

export function parseWikiLinkBody(body: string): WikiLinkParts | null {
  const bar = body.indexOf("|");
  let rawTarget = bar < 0 ? body : body.slice(0, bar);
  // Obsidian escapes the alias bar inside table cells as `\|`. markdown-it's
  // table rule leaves the backslash in the cell text, so it shows up here.
  if (bar >= 0 && rawTarget.endsWith("\\")) rawTarget = rawTarget.slice(0, -1);
  rawTarget = rawTarget.trim();

  const hash = rawTarget.indexOf("#");
  const target = (hash < 0 ? rawTarget : rawTarget.slice(0, hash)).trim();
  // `[[#Heading]]` links within the same file; nothing to open.
  if (target === "") return null;

  const alias = bar < 0 ? "" : body.slice(bar + 1).trim();
  return { target, label: alias !== "" ? alias : rawTarget };
}

export function wikiLinkHref(target: string): string {
  return FILE_EXT_RE.test(target) ? target : `${target}.md`;
}

const OPEN = "[[";
const CLOSE = "]]";

export function wikiLinkPlugin(md: MarkdownIt): void {
  // Before the core `link` rule, which would otherwise try `[[…]]` as a
  // reference-link label and fall back to literal text. `![[…]]` never
  // reaches this rule: it starts with `!`, which wikiImagePlugin consumes.
  md.inline.ruler.before(
    "link",
    "reck_wiki_link",
    (state: StateInline, silent: boolean): boolean => {
      const start = state.pos;
      if (!state.src.startsWith(OPEN, start)) return false;

      const bodyStart = start + OPEN.length;
      const end = state.src.indexOf(CLOSE, bodyStart);
      if (end < 0) return false;

      const body = state.src.slice(bodyStart, end);
      // A nested bracket or line break means this isn't a simple wikilink;
      // bail and let the text render literally rather than guess.
      if (body.includes("[") || body.includes("]") || body.includes("\n")) {
        return false;
      }

      const parts = parseWikiLinkBody(body);
      if (!parts) return false;

      if (!silent) {
        const open = state.push("link_open", "a", 1);
        open.attrs = [["href", wikiLinkHref(parts.target)]];
        open.markup = "wikilink";
        open.info = "auto";
        const text = state.push("text", "", 0);
        text.content = parts.label;
        const close = state.push("link_close", "a", -1);
        close.markup = "wikilink";
        close.info = "auto";
      }

      state.pos = end + CLOSE.length;
      return true;
    },
  );
}
