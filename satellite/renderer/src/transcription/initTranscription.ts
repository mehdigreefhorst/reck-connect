// Boot entry for voice dictation (issue #67). Loads settings, wires the
// controller to the active pane, and installs the toggle hotkey. Invoked
// non-fatally from boot.ts beside initTts — a failure here must never take
// down the app.

import {
  TranscriptionController,
  type DictationSession,
} from "./TranscriptionController";
import { installTranscriptionShortcuts } from "./transcriptionShortcuts";
import { loadTranscriptionSettings } from "./transcriptionSettings";

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

  return {
    toggle,
    dispose: () => {
      uninstallShortcut();
      controller.dispose();
    },
  };
}
