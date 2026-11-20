import { describe, it, expect } from "vitest";
import type { SessionInfo } from "@proto/proto";
import { sessionTabTitle, tabForNewPane } from "./new-pane-tab";
import { defaultTabTitle } from "./split-tree";

function session(overrides: Partial<SessionInfo> = {}): SessionInfo {
  return {
    session_id: "0123456789abcdef",
    name: "proj/01234567",
    cwd: "/x",
    created_at: "2026-04-20T10:00:00Z",
    last_active_at: "2026-04-20T11:00:00Z",
    ...overrides,
  };
}

describe("sessionTabTitle", () => {
  it("uses the session's resolved display_name", () => {
    expect(sessionTabTitle(session({ display_name: "helpspot-wholesale" }))).toBe("helpspot-wholesale");
  });

  it("trims it", () => {
    expect(sessionTabTitle(session({ display_name: "  spaced  " }))).toBe("spaced");
  });

  it("is undefined for an unnamed session — the seed id is not a tab title", () => {
    // Matches a live pane's tab, which falls back to "Claude", not the seed.
    expect(sessionTabTitle(session())).toBeUndefined();
    expect(sessionTabTitle(session({ display_name: "   " }))).toBeUndefined();
  });
});

// Issue #183: a resumed pane opened as "Claude" and only got its name on a
// later title refresh.
describe("tabForNewPane", () => {
  it("titles a resumed Claude tab with the session's name from the start", () => {
    const t = tabForNewPane("p_1", {
      kind: "claude",
      host: "station",
      resumeSessionId: "sess-a",
      title: "helpspot-wholesale",
    });
    expect(t.title).toBe("helpspot-wholesale");
    expect(t.paneId).toBe("p_1");
    expect(t.host).toBe("station");
  });

  it("stamps the session id on a resumed Claude tab so it has a stable identity", () => {
    const t = tabForNewPane("p_1", { kind: "claude", host: "station", resumeSessionId: "sess-a" });
    expect(t.sessionId).toBe("sess-a");
    expect(t.slotId).toBeUndefined();
  });

  it("stamps the slot id, not a session id, on a restored codex tab", () => {
    const t = tabForNewPane("p_2", { kind: "codex", host: "local", restoreSlotId: "slot-1", title: "codex-run" });
    expect(t.slotId).toBe("slot-1");
    expect(t.sessionId).toBeUndefined();
    expect(t.title).toBe("codex-run");
  });

  it("falls back to the kind's default title for a fresh pane", () => {
    expect(tabForNewPane("p_3", { kind: "claude", host: "station" }).title).toBe(defaultTabTitle("claude"));
    expect(tabForNewPane("p_4", { kind: "shell", host: "station" }).title).toBe(defaultTabTitle("shell"));
  });

  it("carries the tooltip through", () => {
    expect(tabForNewPane("p_5", { kind: "claude", host: "station" }, "claude --foo").tooltip).toBe("claude --foo");
  });

  it("gives every tab its own id", () => {
    const a = tabForNewPane("p_6", { kind: "claude", host: "station" });
    const b = tabForNewPane("p_6", { kind: "claude", host: "station" });
    expect(a.id).not.toBe(b.id);
  });
});
