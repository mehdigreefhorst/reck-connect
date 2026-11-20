// Registers an xterm link provider that underlines Obsidian-style
// `[[note]]` wikilinks in terminal scrollback and routes a click to a
// host-provided handler (issue #186). The host opens the note the same way
// it opens a clicked file path, so name-based resolution — find the note
// anywhere in the project — comes for free.
//
// Sibling of UrlLinkProvider and built the same way: it reuses
// PathLinkProvider's wrap-run machinery so a wikilink that soft-wraps onto
// a continuation row is still one link, and it needs no filesystem
// round-trip to decide what is a link — the `[[…]]` syntax is explicit.
// That is also why a plain click opens it, where a heuristically detected
// path needs ⌘.

import {
  collectWrapRun,
  projectMatchOntoLines,
  type XtermLinkProvider,
  type XtermLinkProviderTerminal,
} from "./PathLinkProvider";
import { showLinkTooltip, hideLinkTooltip } from "./linkTooltip";
import { detectWikiLinksInLine, WIKI_LINK_TOOLTIP } from "./wikiLink";

export interface WikiLinkProviderDeps {
  /**
   * Fires when the user clicks a wikilink. `href` is the note's file name
   * (`note.md`, or the link target as written when it names a file with a
   * known extension) — relative, for the host to resolve.
   */
  onActivate(href: string, event: MouseEvent): void;
}

export function installWikiLinkProvider(
  term: XtermLinkProviderTerminal,
  deps: WikiLinkProviderDeps,
): { dispose: () => void } {
  const provider: XtermLinkProvider = {
    provideLinks(bufferLineNumber, callback) {
      // bufferLineNumber is 1-indexed per xterm; collectWrapRun is
      // 0-indexed.
      const wrapRun = collectWrapRun(term, bufferLineNumber - 1);
      if (!wrapRun || wrapRun.lines.length === 0) {
        callback(undefined);
        return;
      }
      const matches = detectWikiLinksInLine(wrapRun.joinedText);
      const startLine1 = wrapRun.startLine0 + 1;
      const links = matches.flatMap((match) =>
        // One ILink per physical row the match spans, all opening the
        // same note.
        projectMatchOntoLines(match, wrapRun.lines, startLine1).map((range) => ({
          text: match.text,
          range,
          activate(ev: MouseEvent) {
            deps.onActivate(match.href, ev);
          },
          hover(ev: MouseEvent) {
            showLinkTooltip(WIKI_LINK_TOOLTIP, ev);
          },
          leave() {
            hideLinkTooltip();
          },
        })),
      );
      callback(links.length > 0 ? links : undefined);
    },
  };

  const disposable = term.registerLinkProvider(provider);
  return {
    dispose() {
      disposable.dispose();
    },
  };
}
