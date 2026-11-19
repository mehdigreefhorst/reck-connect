import { describe, it, expect, vi } from "vitest";
import type { Pane, Stoplight } from "@proto/proto";
import { addTab, allTabs, leafWithTab, tab, type TreeNode } from "./split-tree";
import { createPaneTitleRefresher, syncTabTitles } from "./title-sync";

function mkPane(overrides: Partial<Pane> & Pick<Pane, "id" | "kind">): Pane {
  const base: Pane = {
    id: overrides.id,
    kind: overrides.kind,
    state: "running",
    stoplight: "gray" as Stoplight,
  };
  return { ...base, ...overrides };
}

function twoTabTree(): TreeNode {
  const leaf = leafWithTab(tab("p_1", "claude", "station", "Claude", "t1"), "leaf");
  return addTab(leaf, "leaf", tab("p_2", "claude", "local", "Claude", "t2"));
}

function titles(tree: TreeNode | null): Record<string, string> {
  return Object.fromEntries(allTabs(tree).map((t) => [t.id, t.title]));
}

describe("syncTabTitles", () => {
  it("applies a pane's auto_name to its tab", () => {
    const tree = twoTabTree();
    const out = syncTabTitles(tree, "station", [
      mkPane({ id: "p_1", kind: "claude", auto_name: "renamed-in-claude" }),
    ]);
    expect(titles(out)).toEqual({ t1: "renamed-in-claude", t2: "Claude" });
  });

  it("prefers display_name over auto_name", () => {
    const out = syncTabTitles(twoTabTree(), "station", [
      mkPane({ id: "p_1", kind: "claude", display_name: "manual", auto_name: "auto" }),
    ]);
    expect(titles(out).t1).toBe("manual");
  });

  it("returns the same tree reference when nothing changes", () => {
    const tree = twoTabTree();
    const out = syncTabTitles(tree, "station", [mkPane({ id: "p_1", kind: "claude" })]);
    expect(out).toBe(tree);
  });

  it("does not mutate the input tree", () => {
    const tree = twoTabTree();
    const before = JSON.stringify(tree);
    syncTabTitles(tree, "station", [mkPane({ id: "p_1", kind: "claude", auto_name: "x" })]);
    expect(JSON.stringify(tree)).toBe(before);
  });

  it("only touches tabs on the given host", () => {
    // p_2 lives on "local"; a station pane that happens to share the id
    // must not rename it.
    const out = syncTabTitles(twoTabTree(), "station", [
      mkPane({ id: "p_2", kind: "claude", auto_name: "wrong-host" }),
    ]);
    expect(titles(out).t2).toBe("Claude");
  });

  it("leaves tabs whose pane is not in the list alone", () => {
    const tree = twoTabTree();
    expect(syncTabTitles(tree, "station", [])).toBe(tree);
  });
});

describe("createPaneTitleRefresher", () => {
  function setup(opts: { panes?: Pane[]; blocked?: () => boolean } = {}) {
    let tree: TreeNode | null = twoTabTree();
    let projectId: string | null = "proj";
    const state = {
      panes: opts.panes ?? [mkPane({ id: "p_1", kind: "claude", auto_name: "fresh" })],
    };
    const fetchPanes = vi.fn(async () => state.panes);
    const setTree = vi.fn((t: TreeNode) => {
      tree = t;
    });
    const refresher = createPaneTitleRefresher({
      getProjectId: () => projectId,
      getTree: () => tree,
      setTree,
      fetchPanes,
      isBlocked: opts.blocked ?? (() => false),
    });
    return {
      refresher,
      fetchPanes,
      setTree,
      state,
      getTree: () => tree,
      setProject: (id: string | null) => {
        projectId = id;
      },
    };
  }

  it("fetches the current project's panes and applies new titles", async () => {
    const s = setup();
    await s.refresher.refresh("station");
    expect(s.fetchPanes).toHaveBeenCalledWith("station", "proj");
    expect(titles(s.getTree()).t1).toBe("fresh");
  });

  it("does not call setTree when titles are unchanged", async () => {
    const s = setup({ panes: [mkPane({ id: "p_1", kind: "claude" })] });
    await s.refresher.refresh("station");
    expect(s.setTree).not.toHaveBeenCalled();
  });

  it("skips the fetch when no project is selected", async () => {
    const s = setup();
    s.setProject(null);
    await s.refresher.refresh("station");
    expect(s.fetchPanes).not.toHaveBeenCalled();
  });

  it("skips entirely while blocked (restore in progress, inline edit)", async () => {
    const s = setup({ blocked: () => true });
    await s.refresher.refresh("station");
    expect(s.fetchPanes).not.toHaveBeenCalled();
    expect(s.setTree).not.toHaveBeenCalled();
  });

  it("drops the result when the project changed during the fetch", async () => {
    const s = setup();
    s.fetchPanes.mockImplementationOnce(async () => {
      s.setProject("other");
      return s.state.panes;
    });
    await s.refresher.refresh("station");
    expect(s.setTree).not.toHaveBeenCalled();
  });

  it("drops the result when a local rename happened during the fetch", async () => {
    // The response may predate the rename RPC; applying it would flash the
    // old title back over the user's optimistic one.
    const s = setup();
    s.fetchPanes.mockImplementationOnce(async () => {
      s.refresher.noteLocalRename();
      return s.state.panes;
    });
    await s.refresher.refresh("station");
    expect(s.setTree).not.toHaveBeenCalled();
  });

  it("drops the result when it became blocked during the fetch", async () => {
    let blocked = false;
    const s = setup({ blocked: () => blocked });
    s.fetchPanes.mockImplementationOnce(async () => {
      blocked = true;
      return s.state.panes;
    });
    await s.refresher.refresh("station");
    expect(s.setTree).not.toHaveBeenCalled();
  });

  it("is single-flight per host", async () => {
    const s = setup();
    let release!: () => void;
    s.fetchPanes.mockImplementationOnce(
      () => new Promise<Pane[]>((res) => (release = () => res(s.state.panes))),
    );
    const first = s.refresher.refresh("station");
    await s.refresher.refresh("station");
    expect(s.fetchPanes).toHaveBeenCalledTimes(1);
    release();
    await first;
    expect(titles(s.getTree()).t1).toBe("fresh");
  });

  it("never throws when the fetch fails", async () => {
    const s = setup();
    s.fetchPanes.mockRejectedValueOnce(new Error("offline"));
    await expect(s.refresher.refresh("station")).resolves.toBeUndefined();
    expect(s.setTree).not.toHaveBeenCalled();
  });
});
