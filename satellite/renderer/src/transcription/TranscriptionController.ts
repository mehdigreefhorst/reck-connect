// Orchestrates dictation: builds the provider from settings, owns the
// engine, and types the transcript LIVE into the pane that was active when
// dictation started. Each transcription pass (interim or final) is the full
// text-so-far; we diff it against what's already typed and send just the
// delta (backspaces + new characters) straight into the PTY, so the words
// appear in the terminal input as you speak. No trailing newline (the user
// presses Enter) unless auto-submit is on.

import { TranscriptionEngine, type DictationState } from "./TranscriptionEngine";
import { DictationBar } from "./DictationBar";
import { DeepgramProvider } from "./providers/DeepgramProvider";
import { LocalWhisperProvider } from "./providers/LocalWhisperProvider";
import type { Transcriber, TranscriberStatus } from "./providers/types";
import {
  EMBEDDED_MODELS,
  embeddedModelRepo,
  loadTranscriptionSettings,
  type TranscriptionSettings,
} from "./transcriptionSettings";

/** Where dictated text lands — typically the active terminal pane. */
export interface DictationTarget {
  /** Type text into the pane's PTY (no trailing newline). */
  insert(text: string): void;
  /** Send Enter (used only when auto-submit is on). */
  submit(): void;
}

/** The per-pane loading/status/level UI, implemented by DictationBar. */
export interface DictationUI {
  setState(state: DictationState): void;
  setStatus(status: TranscriberStatus | null): void;
  setLevel(level: number): void;
  /** Unstable ghost-tail text (never injected into the prompt). */
  setTail(text: string): void;
  /** Words HEARD (by voice energy) but not yet transcribed — ghost blobs. */
  setPendingWords(count: number): void;
  setError(message: string): void;
}

// DEL (0x7f) — the Backspace key. Terminal input lines erase the previous
// character on this, letting us "correct" earlier words when a later
// transcription pass revises them.
const DEL = "\x7f";

// Speech-to-word estimate for the ghost placeholders: ~150 wpm = 2.5 words
// per VOICED second. The blobs only bridge transcription lag, so a rough
// rate is fine — real words replace them within a pass or two.
const WORDS_PER_VOICED_SECOND = 2.5;
// Never render a wall of blobs (long lag / noisy room).
const MAX_PENDING_BLOBS = 8;

function wordCount(text: string): number {
  return text.trim() === "" ? 0 : text.trim().split(/\s+/).length;
}

/** Collapse newlines (would submit the prompt) and trim so passes diff cleanly. */
function normalizeTranscript(text: string): string {
  return text.replace(/[\r\n]+/g, " ").trim();
}

export interface Injection {
  /** DEL keystrokes to undo the diverged tail of the previous pass. */
  backspaces: number;
  /** New characters to append after the backspaces. */
  suffix: string;
  /** The full text now considered injected (diff base for the next pass). */
  injected: string;
}

/**
 * Diff the next full-text pass against what's already typed and return just
 * the delta. An EMPTY next pass over existing text is a no-op (never erases
 * what's typed) — a filtered/failed final must not swallow the utterance.
 */
export function computeInjection(prev: string, rawNext: string): Injection {
  const next = normalizeTranscript(rawNext);
  if (next === "" && prev !== "") {
    return { backspaces: 0, suffix: "", injected: prev };
  }
  let common = 0;
  const max = Math.min(prev.length, next.length);
  while (common < max && prev[common] === next[common]) common++;
  return { backspaces: prev.length - common, suffix: next.slice(common), injected: next };
}

/** Resolved when dictation starts: where text goes and where UI mounts. */
export interface DictationSession {
  target: DictationTarget;
  /** The pane wrapper — anchor for the mic button state + status pill. */
  surface: HTMLElement;
}

export interface TranscriptionControllerDeps {
  settings: TranscriptionSettings;
  /** Resolve the target + UI surface at the moment dictation starts. */
  resolveSession: () => DictationSession | null;
  /** Surface an error to the user (e.g. a toast) when no UI bar exists. */
  onError?: (message: string) => void;
}

export class TranscriptionController {
  private engine: TranscriptionEngine;
  private settings: TranscriptionSettings;
  private target: DictationTarget | null = null;
  private bar: DictationBar | null = null;
  // What we've typed into the target this utterance (to diff the next pass).
  private injectedText = "";
  // Ghost-placeholder inputs: voiced-time word estimate vs words transcribed.
  private lastTail = "";
  private heardWords = 0;
  private lastVoiceAt = 0;

  constructor(private readonly deps: TranscriptionControllerDeps) {
    this.settings = deps.settings;
    this.engine = new TranscriptionEngine(this.makeProvider(), {
      onPartial: (t) => {
        this.applyTranscript(t);
        this.syncGhosts();
      },
      onTail: (t) => {
        this.lastTail = t;
        this.bar?.setTail(t);
        this.syncGhosts();
      },
      onFinal: (t) => {
        this.applyTranscript(t);
        this.syncGhosts();
      },
      onStatus: (s) => this.bar?.setStatus(s),
      onProgress: (p) => this.bar?.setProgress(p),
      onLevel: (l) => {
        this.bar?.setLevel(l);
        if (l > 0.01) this.lastVoiceAt = performance.now();
        // Levels tick ~8×/s, so this also drives the silence decay below.
        this.syncGhosts();
      },
      onSpeechMs: (ms) => {
        this.heardWords = Math.round((ms / 1000) * WORDS_PER_VOICED_SECOND);
        this.syncGhosts();
      },
      onError: (m) => {
        console.error("[dictation] error:", m);
        if (this.bar) this.bar.setError(m);
        else this.deps.onError?.(m);
        // A provider error mid-session (Deepgram socket drop, worker crash)
        // used to leave the engine stuck in listening/transcribing — the mic
        // frozen amber, the next click trying to stop a dead session. Force
        // back to idle so the button is always usable again.
        if (this.engine.isActive() && this.engine.getState() !== "preparing") {
          void this.engine.cancel();
        }
      },
      onStateChange: (s) => this.onStateChange(s),
    });
  }

  private makeProvider(): Transcriber {
    if (this.settings.provider === "deepgram") {
      return new DeepgramProvider({ language: this.settings.language });
    }
    // Live partials run on tiny (fast enough to keep up with speech); the
    // final pass uses the selected model for quality.
    return new LocalWhisperProvider(embeddedModelRepo(this.settings.localModel), {
      partialRepo: embeddedModelRepo("whisper-tiny"),
      language: this.settings.language,
    });
  }

  /** Short model name for the loading UI (local engine only). */
  private modelLabel(): string | null {
    if (this.settings.provider !== "local") return null;
    const m = EMBEDDED_MODELS.find((x) => x.id === this.settings.localModel);
    const short = m ? m.label.split("—")[0].trim() : this.settings.localModel;
    return `Whisper ${short}`;
  }

  /**
   * Type the full text-so-far into the pane live: diff against what we've
   * already injected and send just the delta — backspaces to undo any revised
   * tail, then the new suffix. Never backspaces past our own injected text, so
   * anything the user typed before dictating is safe.
   */
  private applyTranscript(text: string): void {
    if (!this.target) return;
    const { backspaces, suffix, injected } = computeInjection(this.injectedText, text);
    this.injectedText = injected;
    if (backspaces === 0 && suffix.length === 0) return;
    console.log(`[dictation] type: -${backspaces} +${JSON.stringify(suffix)}`);
    this.target.insert(DEL.repeat(backspaces) + suffix);
  }

  /**
   * Ghost placeholders: words we've HEARD (voice energy) minus words already
   * visible as text (typed stable words + the ghost tail). What remains is
   * rendered as blurred blobs — instant "I heard that" feedback that
   * crystallizes into words as the engine catches up.
   */
  private syncGhosts(): void {
    const transcribed = wordCount(this.injectedText) + wordCount(this.lastTail);
    // The voiced-time estimate overcounts in noisy rooms; once the mic has
    // been quiet a beat, whatever the engine was going to transcribe has
    // arrived — reconcile the estimate so stale blobs drain instead of
    // squatting in the pill.
    if (this.lastVoiceAt > 0 && performance.now() - this.lastVoiceAt > 1500) {
      this.heardWords = Math.min(this.heardWords, transcribed);
    }
    const pending = Math.min(MAX_PENDING_BLOBS, Math.max(0, this.heardWords - transcribed));
    this.bar?.setPendingWords(pending);
  }

  private onStateChange(state: DictationState): void {
    // The lifecycle, narrated — when a state looks stuck, the console says
    // which transition never happened.
    console.log(
      `[dictation] state → ${state} (${this.settings.provider}${
        this.settings.provider === "local" ? `/${this.settings.localModel}` : ""
      })`,
    );
    this.bar?.setState(state);
    if (state === "idle") {
      if (this.injectedText.length > 0 && this.settings.autoSubmit) this.target?.submit();
      this.bar?.dispose();
      this.bar = null;
      this.target = null;
      this.injectedText = "";
      this.lastTail = "";
      this.heardWords = 0;
    }
  }

  /** Push-to-talk / button: start when idle, stop when listening. */
  async toggle(): Promise<void> {
    const state = this.engine.getState();
    if (state === "idle") await this.startDictation();
    else if (state === "listening") await this.engine.stop();
    else if (state === "preparing") await this.cancel(); // abort a slow model load
    // A slow final pass (big model, long utterance) shouldn't hold the mic
    // hostage: clicking again abandons the improvement pass. The stable
    // words already typed into the prompt stay.
    else if (state === "transcribing") await this.cancel();
  }

  async startDictation(): Promise<void> {
    if (this.engine.getState() !== "idle") return;
    // Honor the CURRENT settings page state: engine/model/language edits
    // apply to the next dictation, not the next app launch.
    try {
      this.updateSettings(await loadTranscriptionSettings());
    } catch {
      // Config unreadable — dictate with the settings we already have.
    }
    const session = this.deps.resolveSession();
    if (!session) {
      this.deps.onError?.("No active terminal to dictate into.");
      return;
    }
    this.target = session.target;
    this.bar = new DictationBar(session.surface, this.modelLabel());
    this.injectedText = "";
    this.lastTail = "";
    this.heardWords = 0;
    await this.engine.start();
  }

  async stopDictation(): Promise<void> {
    if (this.engine.getState() === "listening") await this.engine.stop();
  }

  async cancel(): Promise<void> {
    await this.engine.cancel();
    this.bar?.dispose();
    this.bar = null;
    this.target = null;
    this.injectedText = "";
    this.lastTail = "";
    this.heardWords = 0;
  }

  isActive(): boolean {
    return this.engine.isActive();
  }

  getState(): DictationState {
    return this.engine.getState();
  }

  /** Apply new settings; swaps the provider if the engine is idle. */
  updateSettings(next: TranscriptionSettings): void {
    const providerChanged =
      next.provider !== this.settings.provider ||
      next.localModel !== this.settings.localModel ||
      next.language !== this.settings.language;
    this.settings = next;
    if (providerChanged && this.engine.getState() === "idle") {
      this.engine.setProvider(this.makeProvider());
    }
  }

  /** Current settings snapshot (the language menu reads + rewrites these). */
  getSettings(): TranscriptionSettings {
    return this.settings;
  }

  dispose(): void {
    this.engine.dispose();
  }
}
