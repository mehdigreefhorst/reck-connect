// Dictation keyboard shortcut. Phase 1 wires the toggle only (⌘⇧V by
// default — start/stop dictation), mirroring the TTS shortcut installer's
// window-keydown pattern. A configurable picker and a hold-to-talk keyup
// binding arrive in Phase 3.

export interface TranscriptionShortcutHandlers {
  /** Toggle dictation on/off (⌘⇧V). */
  onToggle(): void;
}

export function installTranscriptionShortcuts(
  handlers: TranscriptionShortcutHandlers,
): () => void {
  function onKey(e: KeyboardEvent): void {
    const mod = e.metaKey || e.ctrlKey;
    if (!mod || !e.shiftKey) return;
    if (e.key.toLowerCase() === "v") {
      e.preventDefault();
      handlers.onToggle();
    }
  }
  window.addEventListener("keydown", onKey);
  return () => window.removeEventListener("keydown", onKey);
}
