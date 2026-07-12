// Boot entry for voice dictation (issue #67). Loads settings, wires the
// controller to the active pane, installs the toggle hotkey, and attaches
// the right-click language menu to every mic button. Invoked non-fatally
// from boot.ts beside initTts — a failure here must never take down the app.

import {
  TranscriptionController,
  type DictationSession,
} from "./TranscriptionController";
import { showDictationContextMenu } from "./languageMenu";
import { installTranscriptionShortcuts } from "./transcriptionShortcuts";
import {
  loadTranscriptionSettings,
  saveTranscriptionSettings,
} from "./transcriptionSettings";

export interface InitTranscriptionDeps {
  /** Resolve the target pane + UI surface when dictation starts. */
  resolveSession: () => DictationSession | null;
  /** Surface an error with no active dictation bar (e.g. a toast). */
  onError: (message: string) => void;
}

export interface TranscriptionHandle {
  /** Start/stop dictation (mic button and hotkey both route here). */
  toggle(): void;
  dispose(): void;
}

export async function initTranscription(
  deps: InitTranscriptionDeps,
): Promise<TranscriptionHandle> {
  const settings = await loadTranscriptionSettings();
  const controller = new TranscriptionController({
    settings,
    resolveSession: deps.resolveSession,
    onError: deps.onError,
  });

  const toggle = (): void => {
    if (!settings.enabled) {
      deps.onError("Voice dictation is off — enable it in Settings → Voice dictation.");
      return;
    }
    void controller.toggle();
  };

  const uninstallShortcut = settings.enabled
    ? installTranscriptionShortcuts({ onToggle: toggle })
    : () => {};

  // Right-click on any pane's mic button → Language ▸ submenu. Delegated so
  // mic buttons created later (new panes/splits) are covered automatically.
  const onMicContextMenu = (e: MouseEvent): void => {
    const mic = (e.target as HTMLElement | null)?.closest?.(".pane-controls-mic");
    if (!mic) return;
    e.preventDefault();
    e.stopPropagation();
    showDictationContextMenu(e.clientX, e.clientY, {
      currentCode: controller.getSettings().language,
      onPick: (code) => {
        const next = { ...controller.getSettings(), language: code };
        controller.updateSettings(next);
        void saveTranscriptionSettings(next);
      },
    });
  };
  document.addEventListener("contextmenu", onMicContextMenu, true);

  return {
    toggle,
    dispose: () => {
      uninstallShortcut();
      document.removeEventListener("contextmenu", onMicContextMenu, true);
      controller.dispose();
    },
  };
}
