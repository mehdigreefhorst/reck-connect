// Per-pane model-loading UI: a circular progress ring (filled by download %,
// with a pulsing glow) next to the model name, morphing into a checkmark once
// loaded. Shown only while the model loads — during recording the transcript
// is typed straight into the pane and the mic button carries the state, so
// there's no floating box in the way. Also drives the mic-button state and
// surfaces errors as a toast. Created for one dictation session, disposed
// when it ends.

import { setMicButtonState } from "../ui/paneControls";
import { showToast } from "../viewer/Toast";
import type { DictationState } from "./TranscriptionEngine";
import type { DictationUI } from "./TranscriptionController";
import type { TranscriberStatus } from "./providers/types";

// Ring geometry (viewBox 28×28, r=10 → circumference ≈ 62.83).
const RING_R = 10;
const RING_CIRC = 2 * Math.PI * RING_R;

export class DictationBar implements DictationUI {
  private readonly el: HTMLElement;
  private readonly loaderEl: HTMLElement;
  private readonly ringProgress: SVGCircleElement;
  private readonly label: HTMLElement;
  private state: DictationState = "idle";
  private status: TranscriberStatus | null = null;
  private pct = 0;
  private sawProgress = false;
  private ready = false;

  constructor(
    private readonly surface: HTMLElement,
    private readonly modelLabel: string | null = null,
  ) {
    this.el = document.createElement("div");
    this.el.className = "dictation-bar";
    this.el.setAttribute("role", "status");
    this.el.setAttribute("aria-live", "polite");

    const svgNs = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(svgNs, "svg");
    svg.setAttribute("class", "dictation-ring");
    svg.setAttribute("viewBox", "0 0 28 28");
    const track = document.createElementNS(svgNs, "circle");
    track.setAttribute("class", "dictation-ring-track");
    track.setAttribute("cx", "14");
    track.setAttribute("cy", "14");
    track.setAttribute("r", String(RING_R));
    this.ringProgress = document.createElementNS(svgNs, "circle");
    this.ringProgress.setAttribute("class", "dictation-ring-progress");
    this.ringProgress.setAttribute("cx", "14");
    this.ringProgress.setAttribute("cy", "14");
    this.ringProgress.setAttribute("r", String(RING_R));
    this.ringProgress.style.strokeDasharray = String(RING_CIRC);
    this.ringProgress.style.strokeDashoffset = String(RING_CIRC);
    const check = document.createElementNS(svgNs, "path");
    check.setAttribute("class", "dictation-ring-check");
    check.setAttribute("d", "M8.5 14.5 l3 3 l6 -7");
    svg.append(track, this.ringProgress, check);

    this.label = document.createElement("span");
    this.label.className = "dictation-loader-label";

    this.loaderEl = document.createElement("div");
    this.loaderEl.className = "dictation-loader";
    this.loaderEl.append(svg, this.label);
    this.el.append(this.loaderEl);
    this.surface.appendChild(this.el);
    this.render();
  }

  setState(state: DictationState): void {
    // Leaving "preparing" for real recording means the model is ready.
    if (state !== "preparing" && this.state === "preparing") this.ready = true;
    this.state = state;
    setMicButtonState(this.surface, state);
    this.render();
  }

  setStatus(status: TranscriberStatus | null): void {
    this.status = status;
    this.render();
  }

  setProgress(pct: number): void {
    this.sawProgress = true;
    this.pct = Math.max(0, Math.min(100, pct));
    this.ringProgress.style.strokeDashoffset = String(RING_CIRC * (1 - this.pct / 100));
    this.render();
  }

  setError(message: string): void {
    showToast(this.surface, message, { kind: "error", durationMs: 6000 });
  }

  private isLoading(): boolean {
    return this.state === "preparing" || this.status === "loading";
  }

  private render(): void {
    const loading = this.isLoading();
    // The floating box only appears while the model loads.
    this.el.hidden = !loading;
    if (!loading) return;
    const complete = this.ready || this.pct >= 100;
    this.loaderEl.dataset.mode = !this.sawProgress && !complete
      ? "indeterminate"
      : complete
        ? "complete"
        : "determinate";
    const name = this.modelLabel ?? "speech model";
    this.label.textContent = complete
      ? `${name} ready`
      : this.sawProgress
        ? `Loading ${name}… ${this.pct}%`
        : `Loading ${name}…`;
  }

  dispose(): void {
    setMicButtonState(this.surface, "idle");
    this.el.remove();
  }
}
