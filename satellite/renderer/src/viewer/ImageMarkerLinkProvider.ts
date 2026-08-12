// Registers an xterm link provider that underlines the `[Image #N]`
// placeholder Claude Code prints when you paste a screenshot, and routes
// ⌘-click to a host-provided handler.
//
// The sibling of PathLinkProvider and UrlLinkProvider, and the simplest of
// the three: the match carries everything the handler needs (the id), so
// like the URL provider there is no resolve step inside provideLinks —
// which must call back synchronously or xterm drops the link.

import {
  collectWrapRun,
  projectMatchOntoLines,
  type XtermLinkProvider,
  type XtermLinkProviderTerminal,
} from "./PathLinkProvider";
import { detectImageMarkersInLine } from "./LinkDetector";
import { showLinkTooltip, hideLinkTooltip } from "./linkTooltip";

export interface ImageMarkerLinkProviderDeps {
  /** Fires on ⌘-click of a placeholder. `pasteId` is the N in `[Image #N]`. */
  onActivateImage(pasteId: number, event: MouseEvent): void;
}

export function installImageMarkerLinkProvider(
  term: XtermLinkProviderTerminal,
  deps: ImageMarkerLinkProviderDeps,
): { dispose: () => void } {
  const provider: XtermLinkProvider = {
    provideLinks(bufferLineNumber, callback) {
      // bufferLineNumber is 1-indexed per xterm; collectWrapRun is 0-indexed.
      const hovered0 = bufferLineNumber - 1;
      const wrapRun = collectWrapRun(term, hovered0);
      if (!wrapRun || wrapRun.lines.length === 0) {
        callback(undefined);
        return;
      }
      const candidates = detectImageMarkersInLine(wrapRun.joinedText);
      if (candidates.length === 0) {
        callback(undefined);
        return;
      }
      const startLine1 = wrapRun.startLine0 + 1;
      const links: Array<{
        text: string;
        range: ReturnType<typeof projectMatchOntoLines>[number];
        activate: (event: MouseEvent, text: string) => void;
        hover: (event: MouseEvent, text: string) => void;
        leave: () => void;
      }> = [];
      for (const cand of candidates) {
        // Project the logical-line match back onto the physical rows it
        // spans, so a placeholder that wraps still behaves as one link.
        const segments = projectMatchOntoLines(cand, wrapRun.lines, startLine1);
        for (const range of segments) {
          links.push({
            text: cand.text,
            range,
            activate(ev) {
              // ⌘-gated, matching the path and URL linkifiers — a plain
              // click must not hijack selection or normal terminal clicks.
              if (!ev.metaKey) return;
              deps.onActivateImage(cand.pasteId, ev);
            },
            hover(ev) {
              showLinkTooltip("⌘+click to view image", ev);
            },
            leave() {
              hideLinkTooltip();
            },
          });
        }
      }
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
