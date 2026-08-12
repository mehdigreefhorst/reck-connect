// @vitest-environment jsdom
import { describe, it, expect, vi } from "vitest";
import { openPastedImage, type OpenPastedImageDeps } from "./openPastedImage";

const PNG = "iVBORw0KGgoAAAANSUhEUg";
const pasteLine = (id: number) =>
  `{"type":"user","message":{"role":"user","content":[{"type":"text","text":"see"},{"type":"image","source":{"type":"base64","media_type":"image/png","data":"${PNG}${id}"}}]},"imagePasteIds":[${id}]}\n`;

function deps(over: Partial<OpenPastedImageDeps> = {}) {
  const wrapper = document.createElement("div");
  const show = vi.fn();
  const notify = vi.fn();
  const base: OpenPastedImageDeps = {
    resolvePane: () => ({ wrapper, sessionId: "s-1" }),
    projectId: () => "p-1",
    listSessions: async () => ({ sessions: [] }) as never,
    getTranscript: async () => ({ chunk: pasteLine(2), nextOffset: 10, hasMore: false }),
    show,
    notify,
    ...over,
  };
  return { base, show, notify, wrapper };
}

describe("openPastedImage", () => {
  it("shows the named image over the pane as a data: URI", async () => {
    const { base, show, notify, wrapper } = deps();
    await openPastedImage("pane-1", 2, base);
    expect(notify).not.toHaveBeenCalled();
    expect(show).toHaveBeenCalledWith(wrapper, {
      src: `data:image/png;base64,${PNG}2`,
      alt: "Pasted image #2",
    });
  });

  it("says so rather than showing a different image when the id is absent", async () => {
    // The whole point of the feature: a placeholder whose bytes we cannot
    // find opens NOTHING. Silently showing a neighbouring screenshot would
    // be worse than doing nothing at all.
    const { base, show, notify } = deps();
    await openPastedImage("pane-1", 99, base);
    expect(show).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("#99"));
  });

  it("reports a transcript that cannot be read instead of rejecting", async () => {
    const { base, show, notify } = deps({
      getTranscript: async () => {
        throw new Error("daemon unreachable");
      },
    });
    // Runs inside xterm's event dispatch — a rejection here would surface
    // only as an unhandled promise rejection.
    await expect(openPastedImage("pane-1", 2, base)).resolves.toBeUndefined();
    expect(show).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("daemon unreachable"));
  });

  it("reports a pane with no resolvable session", async () => {
    const { base, show, notify } = deps({
      resolvePane: () => ({ wrapper: document.createElement("div") }),
      listSessions: async () => ({ sessions: [] }) as never,
    });
    await openPastedImage("pane-1", 2, base);
    expect(show).not.toHaveBeenCalled();
    expect(notify).toHaveBeenCalledWith(expect.stringContaining("no Claude session"));
  });

  it("stays silent when the pane closed under the click", async () => {
    const { base, show, notify } = deps({ resolvePane: () => null });
    await openPastedImage("pane-1", 2, base);
    expect(show).not.toHaveBeenCalled();
    expect(notify).not.toHaveBeenCalled(); // nothing left to report to
  });
});
