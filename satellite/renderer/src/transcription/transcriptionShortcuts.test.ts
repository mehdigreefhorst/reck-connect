// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { installTranscriptionShortcuts } from "./transcriptionShortcuts";

function handlers() {
  return {
    onPressStart: vi.fn(),
    onPressEnd: vi.fn(),
    // Unclaimed by default: dictation is idle, so Enter belongs to the terminal.
    onSubmit: vi.fn(() => false),
  };
}

let uninstall: (() => void) | null = null;
afterEach(() => {
  uninstall?.();
  uninstall = null;
});

function press(init: KeyboardEventInit): void {
  window.dispatchEvent(new KeyboardEvent("keydown", init));
}

describe("installTranscriptionShortcuts — Enter to send", () => {
  it("fires onSubmit for a bare Enter", () => {
    const h = handlers();
    uninstall = installTranscriptionShortcuts(h);
    press({ key: "Enter" });
    expect(h.onSubmit).toHaveBeenCalledTimes(1);
  });

  it("ignores Enter with any modifier (that's a newline, not a send)", () => {
    const h = handlers();
    uninstall = installTranscriptionShortcuts(h);
    press({ key: "Enter", shiftKey: true });
    press({ key: "Enter", metaKey: true });
    press({ key: "Enter", ctrlKey: true });
    press({ key: "Enter", altKey: true });
    expect(h.onSubmit).not.toHaveBeenCalled();
  });

  it("does not preventDefault an unclaimed Enter (the terminal must submit)", () => {
    const h = handlers();
    uninstall = installTranscriptionShortcuts(h);
    const ev = new KeyboardEvent("keydown", { key: "Enter", cancelable: true });
    window.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(false);
  });

  // While dictating, the handler takes the Enter so the terminal can't submit
  // a prompt that's still missing the words in flight — it submits itself once
  // the tail has landed.
  it("swallows Enter when the handler claims it", () => {
    const h = handlers();
    h.onSubmit.mockReturnValue(true);
    uninstall = installTranscriptionShortcuts(h);
    const ev = new KeyboardEvent("keydown", { key: "Enter", cancelable: true });
    window.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
  });

  it("starts a press on the ⌘⇧V chord", () => {
    const h = handlers();
    uninstall = installTranscriptionShortcuts(h);
    press({ key: "v", metaKey: true, shiftKey: true });
    expect(h.onPressStart).toHaveBeenCalledTimes(1);
  });
});
