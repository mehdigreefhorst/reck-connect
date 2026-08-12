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

  let image;
  try {
    image = await fetchPastedImage(pasteId, {
      fetchSlice: (offset) => deps.getTranscript(projectId, sessionId, offset),
    });
  } catch (err) {
    deps.notify(`Couldn't read the transcript for Image #${pasteId}: ${messageOf(err)}`);
    return;
  }

  if (!image) {
    // Scrollback that outlived its transcript, a resumed session, or a
    // placeholder from a session the daemon cannot serve. Say so — do NOT
    // fall back to "the nearest image", which is how this feature would
    // start showing the wrong screenshot.
    deps.notify(`Image #${pasteId} isn't in this session's transcript.`);
    return;
  }

  deps.show(pane.wrapper, {
    src: `data:${image.mime};base64,${image.base64}`,
    alt: `Pasted image #${pasteId}`,
  });
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
