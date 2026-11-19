// Keep tab titles in step with the daemon between project selections
// (issue #174).
//
// `reconcile()` syncs titles, but it only runs when a project is selected.
// A `/rename` inside a Claude session changes the pane's `auto_name` on the
// daemon at an arbitrary moment, so without a periodic sync the tab kept its
// old title until the user happened to switch projects. This module is the
// title-only slice of reconcile: it never adds, removes or rebinds tabs, so
// it is safe to run on every background poll.

import type { Pane } from "@proto/proto";
import { titleFor } from "./reconcile";
import type { HostRef } from "../host";
import type { TreeNode } from "./split-tree";

/**
 * Return `tree` with each tab on `host` retitled from its live pane.
 * Tabs on other hosts, and tabs whose pane isn't in `panes`, are left
 * untouched. Returns the SAME reference when no title changes, so callers
 * can skip a repaint with an identity check.
 */
export function syncTabTitles(tree: TreeNode, host: HostRef, panes: Pane[]): TreeNode {
  const wantedByPaneId = new Map(panes.map((p) => [p.id, titleFor(p)]));

  function recur(node: TreeNode): TreeNode {
    if (node.kind === "leaf") {
      let changed = false;
      const tabs = node.tabs.map((t) => {
        if (t.host !== host) return t;
        const wanted = wantedByPaneId.get(t.paneId);
        if (wanted === undefined || wanted === t.title) return t;
        changed = true;
        return { ...t, title: wanted };
      });
      return changed ? { ...node, tabs } : node;
    }
    const a = recur(node.a);
    const b = recur(node.b);
    return a === node.a && b === node.b ? node : { ...node, a, b };
  }

  return recur(tree);
}

export interface PaneTitleRefresherDeps {
  /** Currently selected project, or null when none is open. */
  getProjectId(): string | null;
  getTree(): TreeNode | null;
  setTree(tree: TreeNode): void;
  /** Live panes of `projectId` on `host`. Must not spawn panes. */
  fetchPanes(host: HostRef, projectId: string): Promise<Pane[]>;
  /**
   * True while a title repaint would be wrong or disruptive: a project
   * select / restore is rebuilding the layout, or the user is typing a
   * tab name inline (a repaint would destroy the input).
   */
  isBlocked(): boolean;
}

export interface PaneTitleRefresher {
  /** Re-read `host`'s pane names and retitle its tabs. Never throws. */
  refresh(host: HostRef): Promise<void>;
  /**
   * Call when the user renames a tab locally, and again when the rename
   * RPC settles. Any fetch in flight across either moment may predate the
   * rename, so its result is discarded instead of flashing the old title.
   */
  noteLocalRename(): void;
}

export function createPaneTitleRefresher(deps: PaneTitleRefresherDeps): PaneTitleRefresher {
  const inFlight = new Set<HostRef>();
  let renameEpoch = 0;

  async function refresh(host: HostRef): Promise<void> {
    if (inFlight.has(host)) return;
    const projectId = deps.getProjectId();
    if (!projectId || deps.isBlocked()) return;
    const epochAtStart = renameEpoch;
    inFlight.add(host);
    try {
      const panes = await deps.fetchPanes(host, projectId);
      const stale =
        deps.getProjectId() !== projectId || renameEpoch !== epochAtStart || deps.isBlocked();
      if (stale) return;
      const tree = deps.getTree();
      if (!tree) return;
      const next = syncTabTitles(tree, host, panes);
      if (next !== tree) deps.setTree(next);
    } catch {
      // Background nicety: a failed fetch just means titles stay as they
      // are until the next poll. The connection's own probe reports
      // reachability, so there is nothing useful to surface here.
    } finally {
      inFlight.delete(host);
    }
  }

  return {
    refresh,
    noteLocalRename: () => {
      renameEpoch += 1;
    },
  };
}
