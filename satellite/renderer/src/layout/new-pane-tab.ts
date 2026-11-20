// Builds the tab for a pane the user just asked for — fresh, or a resumed
// session. One place for it because four call sites in boot.ts create that
// tab (new tab, first tab, split right/down, empty layout) and they must
// not drift apart.
//
// Issue #183: a resumed pane used to open titled "Claude" and without its
// session id. The name only appeared on a later title refresh, and the tab
// had no stable identity until a reconcile captured one. The picker already
// knows both, so the tab carries them from the start.

import type { PaneKind, SessionInfo } from "@proto/proto";
import type { HostRef } from "../host";
import { tab, type Tab } from "./split-tree";

/** What the new-pane flow decided: which kind, where, and what to resume. */
export interface NewPaneChoice {
  kind: PaneKind;
  host: HostRef;
  /** Claude session to resume (`claude --resume`). */
  resumeSessionId?: string;
  /** Shell/codex slot to restore. */
  restoreSlotId?: string;
  /** Initial tab title — the resumed session's name, when it has one. */
  title?: string;
}

/**
 * The tab title a session should open with: its resolved name (manual tab
 * name, else Claude's /rename title). Undefined for an unnamed session, so
 * the tab falls back to the kind default exactly like a live pane's tab
 * does — the spawn-time seed (`project/1a2b3c4d`) is an id, not a title.
 */
export function sessionTabTitle(session: SessionInfo): string | undefined {
  const label = session.display_name?.trim();
  return label ? label : undefined;
}

/** Build the tab for the pane `paneId` that was just created for `choice`. */
export function tabForNewPane(paneId: string, choice: NewPaneChoice, tooltip?: string): Tab {
  // Kind-correct identity only, mirroring reconcile: a Claude tab is keyed
  // by session id, shell and codex tabs by slot id.
  const sessionId = choice.kind === "claude" ? choice.resumeSessionId : undefined;
  const slotId = choice.kind === "claude" ? undefined : choice.restoreSlotId;
  return tab(paneId, choice.kind, choice.host, choice.title, undefined, tooltip, sessionId, slotId);
}
