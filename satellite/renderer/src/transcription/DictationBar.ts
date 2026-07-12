// Per-pane dictation UI: a small floating pill that shows the current
// status ("Loading model…", "Listening…", "Transcribing…") and the live
// interim text, plus driving the pane's mic-button state. Created for the
// duration of one dictation session and disposed when it ends.

import { setMicButtonState } from "../ui/paneControls";
import { showToast } from "../viewer/Toast";
import type { DictationState } from "./TranscriptionEngine";
import type { DictationUI } from "./TranscriptionController";
import type { TranscriberStatus } from "./providers/types";

export class DictationBar implements DictationUI {
  private readonly el: HTMLElement;
  private readonly label: HTMLElement;
  private readonly interimEl: HTMLElement;
  private state: DictationState = "idle";
  private status: TranscriberStatus | null = null;

  constructor(private readonly surface: HTMLElement) {
    this.el = document.createElement("div");
    this.el.className = "dictation-bar";
    this.el.setAttribute("role", "status");
    this.el.setAttribute("aria-live", "polite");

    this.label = document.createElement("span");
    this.label.className = "dictation-bar-label";
    this.interimEl = document.createElement("span");
    this.interimEl.className = "dictation-bar-interim";

    this.el.append(this.label, this.interimEl);
    this.surface.appendChild(this.el);
    this.render();
  }

  setState(state: DictationState): void {
    this.state = state;
    setMicButtonState(this.surface, state);
    this.render();
  }

  setStatus(status: TranscriberStatus | null): void {
    this.status = status;
    this.render();
  }

  setInterim(text: string): void {
    this.interimEl.textContent = text;
  }

  setError(message: string): void {
    showToast(this.surface, message, { kind: "error", durationMs: 6000 });
  }

  private render(): void {
    this.el.dataset.state = this.state;
    this.label.textContent = this.labelText();
  }

  private labelText(): string {
    if (this.status === "loading") return "Loading speech model…";
    if (this.state === "listening") return "Listening…";
    if (this.state === "transcribing" || this.status === "transcribing") return "Transcribing…";
    return "";
  }

  dispose(): void {
    setMicButtonState(this.surface, "idle");
    this.el.remove();
  }
}
