// ⌘+click on an `[Image #N]` placeholder → show that screenshot over the pane.
//
// Wires three pieces together: the pane's session (so we know which
// transcript to read), the id→bytes lookup in findPastedImage, and an
// overlay. Kept out of boot.ts so the failure paths are testable — every one
// of them must SAY something, because the alternative to "no image" here is
// "the wrong image", and a click that silently shows you somebody else's
// screenshot is worse than a placeholder that does nothing.

import { fetchPastedImage, type TranscriptSlice } from "./findPastedImage";
import { resolveTranscriptSession } from "./resolveSession";
import type { SessionsListResponse } from "@proto/proto";

export interface PastedImagePane {
  /** The pane's positioned wrapper — what the overlay covers. */
  wrapper: HTMLElement;
  /** The tab's session id when the poll has stamped one. */
  sessionId?: string;
}

export interface OpenPastedImageDeps {
  /** The pane, or null when it has gone away between click and handler. */
  resolvePane(paneId: string): PastedImagePane | null;
  projectId(): string | null;
  listSessions(projectId: string): Promise<SessionsListResponse>;
  getTranscript(projectId: string, sessionId: string, offset: number): Promise<TranscriptSlice>;
  /** Show the image. Returns a handle the caller may ignore. */
  show(host: HTMLElement, opts: { src: string; alt: string }): unknown;
  /** User-facing message for every path that ends without an image. */
  notify(message: string): void;
}

/**
 * Resolve `[Image #N]` for `paneId` and show it.
 *
 * Never throws: a link activation runs inside xterm's event dispatch, where
 * a rejection would surface as an unhandled promise rejection and nothing
 * else. Every failure reports through `notify`.
 */
export async function openPastedImage(
  paneId: string,
  pasteId: number,
  deps: OpenPastedImageDeps,
): Promise<void> {
  const pane = deps.resolvePane(paneId);
  if (!pane) return; // pane closed under the click — nothing to report to
  const projectId = deps.projectId();
  if (projectId === null) {
    deps.notify(`Can't open Image #${pasteId}: no active project.`);
    return;
  }

  let sessionId: string | null;
  try {
    sessionId = await resolveTranscriptSession({
      tabSessionId: pane.sessionId,
      paneId,
      listSessions: () => deps.listSessions(projectId),
    });
  } catch {
    sessionId = null;
  }
  if (sessionId === null) {
    deps.notify(`Can't open Image #${pasteId}: this pane has no Claude session yet.`);
    return;
  }

  let lookup;
  try {
    lookup = await fetchPastedImage(pasteId, {
      fetchSlice: (offset) => deps.getTranscript(projectId, sessionId, offset),
    });
  } catch (err) {
    deps.notify(`Couldn't read the transcript for Image #${pasteId}: ${messageOf(err)}`);
    return;
  }

  if (!lookup.image) {
    // Do NOT fall back to "the nearest image" — ids restart per session,
    // so a neighbouring hit is routinely a different screenshot entirely.
    // Say why instead.
    deps.notify(missingImageMessage(pasteId, lookup.highestPasteId));
    return;
  }

  deps.show(pane.wrapper, {
    src: `data:${lookup.image.mime};base64,${lookup.image.base64}`,
    alt: `Pasted image #${pasteId}`,
  });
}

/**
 * Explain a miss in terms the user can act on.
 *
 * Claude Code assigns the paste id the moment you paste, but only writes
 * the bytes into the session JSONL when the message is SENT — so a
 * just-pasted screenshot is in the terminal and nowhere else. That is the
 * overwhelmingly common miss, and "isn't in this session's transcript"
 * described it as if the image had been lost.
 *
 * The two cases are separated by the high-water mark, because ids only
 * ever increase within a session: an id ABOVE everything stored has not
 * been written yet, while one at or below it was skipped and therefore
 * belongs to a transcript this pane no longer tails.
 *
 * The split is a heuristic, not a proof — a pane whose session was
 * cleared can show old markers with ids above the new session's — so both
 * messages name the file rather than asserting a cause the code cannot
 * verify.
 */
export function missingImageMessage(pasteId: number, highestPasteId: number): string {
  if (pasteId > highestPasteId) {
    return `Image #${pasteId} hasn't been saved yet — send the message and the screenshot becomes viewable.`;
  }
  return `Image #${pasteId} isn't in this session's transcript — it was pasted before the session was cleared or resumed.`;
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
