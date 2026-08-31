// Orchestrates dictation: builds the provider from settings, owns the
// engine, and types the transcript LIVE into the pane that was active when
// dictation started. Each transcription pass (interim or final) is the full
// text-so-far; we diff it against what's already typed and send just the
// delta (backspaces + new characters) straight into the PTY, so the words
// appear in the terminal input as you speak. No trailing newline (the user
// presses Enter) unless auto-submit is on.

import { TranscriptionEngine, type DictationState } from "./TranscriptionEngine";
import { DEFAULT_ONSET_CONFIG } from "./onsetDetector";
import {
  addOnset,
  makeChunk,
  pillWindow,
  stepChunk,
  type ChunkState,
  type Segment,
} from "./chunkModel";
import { DictationBar } from "./DictationBar";
import {
  DaemonDictationProvider,
  type DaemonDictationApi,
} from "./providers/DaemonDictationProvider";
import { DeepgramProvider } from "./providers/DeepgramProvider";
import { LocalWhisperProvider } from "./providers/LocalWhisperProvider";
import type { Transcriber, TranscriberStatus } from "./providers/types";
import {
  EMBEDDED_MODELS,
  embeddedModelRepo,
  isDaemonSpeechProvider,
  loadTranscriptionSettings,
  type DictationAppearance,
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
  /** Phase-2 onset mode: the rolling sub-sentence chunk (blurred + crystallizing). */
  setChunk(segments: readonly Segment[]): void;
  /** Drop the whole chunk row. */
  clearChunk(): void;
  setError(message: string): void;
}

// DEL (0x7f) — the Backspace key. Terminal input lines erase the previous
// character on this, letting us "correct" earlier words when a later
// transcription pass revises them.
const DEL = "\x7f";

// Words per VOICED second (pauses already excluded, so ~4 during actual
// phonation). Drives the backlog estimate that sizes the ghost blobs.
const WORDS_PER_VOICED_SECOND = 4;
// Never render a wall of blobs (long lag / noisy room).
const MAX_PENDING_BLOBS = 8;
// Voice counts as "active right now" within this window of the last voiced
// chunk — while active, a floor of blobs shows regardless of transcription
// speed, so the leading-edge effect stays visible even on instant engines.
const VOICE_ACTIVE_MS = 300;
// After voice stops, the floor decays to 0 over this long — crystallizing,
// not a hard cut.
const FLOOR_DECAY_MS = 500;
// How many blobs the "you're being heard" floor shows while voicing.
const ACTIVE_FLOOR_BLOBS = 2;
// Backlog is reconciled to the transcript after this much silence, so stale
// blobs drain at the end of an utterance instead of squatting (kept short so
// the ghosts don't linger after you stop talking).
const SILENCE_RECONCILE_MS = 800;
// Enter finalizes and WAITS for the tail before submitting (the alternative
// drops whatever the engine hadn't returned yet, which is fatal once
// endpointing can be set to manual — nothing would have been transcribed).
// Bounded so Enter can never appear to do nothing: past this, we submit what
// we have. Comfortably under the providers' own flush windows (4 s Deepgram,
// 8 s daemon) so a slow-but-alive engine still usually wins.
const SEND_FLUSH_TIMEOUT_MS = 3000;

function wordCount(text: string): number {
  return text.trim() === "" ? 0 : text.trim().split(/\s+/).length;
}

/**
 * How many ghost blobs to show. A live LEADING EDGE, not a cumulative lag
 * credit: while you're voicing, a small floor is always shown (so the effect
 * doesn't vanish the instant a fast engine catches up); on top of that, the
 * estimated un-transcribed backlog adds more (so a laggy engine like Whisper
 * shows a longer trail). The floor decays smoothly once you stop speaking.
 */
export function computeGhostBlobs(input: {
  heardWords: number;
  transcribedWords: number;
  msSinceVoice: number;
  max: number;
}): number {
  const lag = Math.max(0, input.heardWords - input.transcribedWords);
  let floor = 0;
  if (input.msSinceVoice < VOICE_ACTIVE_MS) {
    floor = ACTIVE_FLOOR_BLOBS;
  } else if (input.msSinceVoice < VOICE_ACTIVE_MS + FLOOR_DECAY_MS) {
    const t = (input.msSinceVoice - VOICE_ACTIVE_MS) / FLOOR_DECAY_MS; // 0→1
    floor = Math.round(ACTIVE_FLOOR_BLOBS * (1 - t));
  }
  return Math.min(input.max, Math.max(0, Math.max(floor, lag)));
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
  /**
   * The primary host's daemon API, for the daemon-backed engines
   * ("claude" / "codex"). Absent in harnesses that only exercise the
   * in-satellite engines; picking a daemon engine then fails loudly.
   */
  daemonSpeechApi?: () => DaemonDictationApi;
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
  // Phase-2 onset mode: the rolling chunk (blurred + crystallizing segments)
  // and the latest stable/tail transcript we align onto it. Terminal text is
  // committed phrase-by-phrase; `committedWords` (inside the chunk) is the
  // transcript-word offset already sent to the prompt.
  private chunk: ChunkState = makeChunk();
  private stableText = "";
  private tailText = "";
  private finalPending = false;
  // Settle/batch buffers. The transcript and ghost updates arrive far too
  // fast to render each one (Deepgram interims many×/s, level ticks ~8×/s) —
  // that made the pill and prompt flicker "super messy". We coalesce the
  // latest values here and flush them on a calm ~half-second cadence, so
  // words settle in readable batches instead of churning. The meter stays on
  // the raw tick (it's meant to be lively); the final flushes immediately.
  private pendingStable: string | null = null;
  private pendingTail = "";
  private tailDirty = false;
  private settleTimer: number | null = null;
  // Set while an Enter-triggered finalize is in flight: the prompt must be
  // submitted once the tail lands, whatever the autoSubmit preference says —
  // the user pressed Enter, and that IS the instruction.
  private submitAfterFinal = false;
  // Resolves the in-flight send early (a second Enter, or the timeout).
  private forceSend: (() => void) | null = null;
  // Set by `cancel({ discard: true })` — this session's words are to be thrown
  // away rather than salvaged into the prompt on the way to idle.
  private discardUtterance = false;

  constructor(private readonly deps: TranscriptionControllerDeps) {
    this.settings = deps.settings;
    this.engine = new TranscriptionEngine(this.makeProvider(), {
      // Stable text (safe to type) — buffered, flushed on the settle tick.
      onPartial: (t) => {
        this.pendingStable = t;
        this.stableText = t;
      },
      // Unstable ghost tail — buffered; only the latest survives to the flush.
      onTail: (t) => {
        this.pendingTail = t;
        this.tailDirty = true;
        this.tailText = t;
      },
      // The complete utterance — apply immediately (no reason to wait).
      onFinal: (t) => {
        this.pendingStable = t;
        this.stableText = t;
        this.finalPending = true;
        this.flushSettle();
      },
      onStatus: (s) => this.bar?.setStatus(s),
      onProgress: (p) => this.bar?.setProgress(p),
      // Meter stays on the raw tick (lively); only note voice activity here.
      //
      // The threshold MUST be the onset detector's own `onsetClose` — the RMS
      // below which it considers a word to have ended — and not a constant of
      // its own. It used to be a hardcoded 0.01, which sits BELOW the default
      // onsetClose of 0.012: room noise in that band is "not speech" to the
      // detector but re-marked voice here, so `msSinceVoice` never grew and
      // the silence-based commit could never fire. Auto endpointing behaved
      // exactly like manual. One threshold, one meaning.
      onLevel: (l) => {
        this.bar?.setLevel(l);
        if (l >= this.settings.appearance.onsetClose) this.lastVoiceAt = performance.now();
      },
      onSpeechMs: (ms) => {
        // Fallback estimate mode only — "onset" mode uses onWordCount below.
        if (this.settings.appearance.ghostMode === "estimate") {
          this.heardWords = Math.round((ms / 1000) * WORDS_PER_VOICED_SECOND);
        }
      },
      onWordOnset: (id) => {
        // A confirmed word is the strongest voice signal there is — stronger
        // than any RMS sample — so it re-arms the silence clock regardless of
        // ghost mode.
        this.lastVoiceAt = performance.now();
        // Onset mode: append a blurred placeholder the INSTANT a word starts,
        // and show it immediately (don't wait for the settle tick) — this is
        // the "text always starts blurred" moment.
        if (this.settings.appearance.ghostMode !== "onset") return;
        this.chunk = addOnset(this.chunk, id);
        this.renderChunk();
      },
      // The word ended: this instant is where the silence the user configured
      // starts being counted from.
      onWordEnd: () => {
        this.lastVoiceAt = performance.now();
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
    if (isDaemonSpeechProvider(this.settings.provider)) {
      const api = this.deps.daemonSpeechApi?.();
      if (!api) {
        throw new Error(
          "Daemon dictation engines need the daemon API wired up (daemonSpeechApi dep).",
        );
      }
      return new DaemonDictationProvider({
        provider: this.settings.provider,
        language: this.settings.language,
        endpointing: this.settings.endpointing,
        api,
      });
    }
    if (this.settings.provider === "deepgram") {
      return new DeepgramProvider({
        language: this.settings.language,
        endpointing: this.settings.endpointing,
      });
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
    const msSinceVoice =
      this.lastVoiceAt > 0 ? performance.now() - this.lastVoiceAt : Number.POSITIVE_INFINITY;
    // Once the mic has been quiet a beat, whatever the engine was going to
    // transcribe has arrived — reconcile the backlog so it drains at the end
    // of an utterance instead of squatting.
    if (msSinceVoice > SILENCE_RECONCILE_MS) {
      this.heardWords = Math.min(this.heardWords, transcribed);
    }
    const pending = computeGhostBlobs({
      heardWords: this.heardWords,
      transcribedWords: transcribed,
      msSinceVoice,
      max: MAX_PENDING_BLOBS,
    });
    this.bar?.setPendingWords(pending);
  }

  /** Batch the buffered updates on the settle tick. Onset mode drives the
   *  crystallizing chunk; estimate mode is the legacy blob path. */
  private flushSettle(): void {
    if (this.settings.appearance.ghostMode === "onset") this.flushOnset();
    else this.flushEstimate();
  }

  /** Milliseconds since the last voiced chunk (∞ if we haven't heard any). */
  private msSinceVoice(): number {
    return this.lastVoiceAt > 0 ? performance.now() - this.lastVoiceAt : Number.POSITIVE_INFINITY;
  }

  private words(text: string): string[] {
    const t = normalizeTranscript(text);
    return t === "" ? [] : t.split(/\s+/);
  }

  /** Append committed phrase text to the terminal (never revised once sent). */
  private commitToTerminal(text: string): void {
    if (!this.target || text === "") return;
    const sep = this.injectedText === "" ? "" : " ";
    this.injectedText = this.injectedText + sep + text;
    console.log(`[dictation] commit: +${JSON.stringify(sep + text)}`);
    this.target.insert(sep + text);
  }

  /**
   * Show the chunk in the pill — only its trailing window, so an utterance
   * that never commits (manual endpointing) can't push the words being spoken
   * right now off the pill's clipped edge.
   */
  private renderChunk(): void {
    this.bar?.setChunk(pillWindow(this.chunk.segments, this.settings.appearance.commitWordCount));
  }

  /**
   * Onset mode (Phase 2). Align the uncommitted transcript tail onto the chunk
   * (words crystallize left→right in the pill), then commit the leading
   * resolved run into the terminal when ENDPOINTING says the utterance may be
   * cut — never on word count. On final, everything remaining lands.
   */
  private flushOnset(): void {
    this.pendingStable = null;
    this.tailDirty = false;
    const a = this.settings.appearance;
    const allWords = this.words(`${this.stableText} ${this.tailText}`);
    const tailWords = allWords.slice(this.chunk.committedWords);

    const { chunk, commits, cleared } = stepChunk(
      this.chunk,
      tailWords,
      {
        msSinceVoice: this.msSinceVoice(),
        commitPauseMs: a.commitPauseMs,
        ghostResetMs: a.ghostResetMs,
        // Endpointing governs the commit, not just the provider session: a
        // commit here is injected into the terminal and never revised, so
        // "manual" must mean nothing lands until Enter / stop.
        endpointing: this.settings.endpointing,
      },
      this.finalPending,
    );
    for (const text of commits) this.commitToTerminal(text);
    this.chunk = chunk;
    this.finalPending = false;
    if (cleared) this.bar?.clearChunk();
    else this.renderChunk();
  }

  /**
   * Commit whatever the pill still holds, then forget it. Runs on the way to
   * idle from EVERY end path — the normal stop (a no-op: the final pass already
   * drained the chunk), but also a provider error, a dropped socket, clicking
   * the mic during the final pass, and the Enter-send flush timeout.
   *
   * Without this, `manual` endpointing turns any of those into a silently lost
   * utterance: nothing has been injected yet, so there is nothing in the prompt
   * to fall back on. Losing a minute of dictation is far worse than committing
   * a slightly-early transcript, so the salvage always wins over the discard.
   * (Estimate mode needs none of it — it types every pass into the prompt as it
   * goes, so there is never anything held back.)
   */
  private salvagePendingChunk(): void {
    if (this.settings.appearance.ghostMode !== "onset") return;
    if (this.chunk.segments.length === 0) return;
    this.finalPending = true;
    this.flushOnset();
  }

  /**
   * Estimate mode (legacy). Apply the latest stable text into the prompt, the
   * latest ghost tail into the pill, and a single blob recompute.
   *
   * Endpointing deliberately does NOT gate this path. Every pass here is
   * re-diffed against what's already typed (`computeInjection` backspaces the
   * diverged tail), so the prompt always holds the provider's LATEST transcript
   * and a later revision still corrects it — nothing is frozen mid-utterance,
   * which is the accuracy loss #164 is about. Onset mode is different, and is
   * gated, because its commits are append-only and never revised.
   */
  private flushEstimate(): void {
    if (this.pendingStable !== null) {
      this.applyTranscript(this.pendingStable);
      this.pendingStable = null;
    }
    if (this.tailDirty) {
      this.lastTail = this.pendingTail;
      this.bar?.setTail(this.pendingTail);
      this.tailDirty = false;
    } else if (this.lastTail !== "" && this.engine.getState() === "listening") {
      // Stale-ghost reset: still recording but quiet with nothing pending →
      // the last interim never resolved (a mismatch left words squatting).
      // Clear it so the pill doesn't hold phantom words.
      if (this.msSinceVoice() > this.settings.appearance.ghostResetMs) {
        this.lastTail = "";
        this.bar?.setTail("");
      }
    }
    this.syncGhosts();
  }

  private startSettleTimer(): void {
    this.stopSettleTimer();
    this.settleTimer = window.setInterval(
      () => this.flushSettle(),
      this.settings.appearance.settleMs,
    );
  }

  private stopSettleTimer(): void {
    if (this.settleTimer !== null) {
      window.clearInterval(this.settleTimer);
      this.settleTimer = null;
    }
  }

  private resetSettleBuffers(): void {
    this.pendingStable = null;
    this.pendingTail = "";
    this.tailDirty = false;
  }

  /** Clear all per-utterance transcript/chunk state (start, cancel, idle). */
  private resetUtteranceState(): void {
    this.injectedText = "";
    this.lastTail = "";
    this.heardWords = 0;
    this.chunk = makeChunk();
    this.stableText = "";
    this.tailText = "";
    this.finalPending = false;
    this.discardUtterance = false;
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
      // Last chance to keep what was said: commit the pill before the state is
      // torn down. Skipped only for an explicit discard (the Advanced panel's
      // preview session, which the user never meant to dictate).
      if (!this.discardUtterance) this.salvagePendingChunk();
      // Stop batching and DROP any unflushed buffer. The normal stop path
      // already applied the full utterance via onFinal's immediate flush;
      // the send/cancel path deliberately discards the buffered tail (the
      // user pressed Enter — a late injection would land in the next prompt).
      this.stopSettleTimer();
      this.resetSettleBuffers();
      const wanted = this.submitAfterFinal || this.settings.autoSubmit;
      this.submitAfterFinal = false;
      if (this.injectedText.length > 0 && wanted) this.target?.submit();
      this.bar?.dispose();
      this.bar = null;
      this.target = null;
      this.resetUtteranceState();
    }
  }

  /** Push-to-talk / button: start when idle, stop when listening. */
  async toggle(): Promise<void> {
    const state = this.engine.getState();
    if (state === "idle") await this.startDictation();
    else if (state === "listening") await this.engine.stop();
    else if (state === "preparing") await this.cancel(); // abort a slow model load
    // A slow final pass (big model, long utterance) shouldn't hold the mic
    // hostage: clicking again abandons the improvement pass. What was already
    // transcribed stays — the words in the prompt, plus whatever the pill still
    // holds, which cancel() salvages on the way to idle.
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
    this.bar = new DictationBar(
      session.surface,
      this.modelLabel(),
      this.settings.fluidMotion,
      this.settings.appearance,
    );
    this.resetUtteranceState();
    this.resetSettleBuffers();
    this.applyOnsetConfig();
    this.startSettleTimer();
    await this.engine.start();
  }

  async stopDictation(): Promise<void> {
    if (this.engine.getState() === "listening") await this.engine.stop();
  }

  /**
   * The user pressed Enter to SEND the message — they're done talking.
   *
   * The Enter itself is swallowed by the shortcut layer while dictation is
   * active, because we finalize FIRST and submit afterwards: the words still
   * in flight belong to this message, not the next one, and under manual
   * endpointing they are the *only* words. Bounded by SEND_FLUSH_TIMEOUT_MS
   * so a wedged provider still sends what's already in the prompt; a second
   * Enter while we're waiting sends immediately.
   */
  async stopForSend(): Promise<void> {
    if (!this.engine.isActive()) return;
    // Already finalizing: this is the impatient second Enter — cut the wait.
    if (this.forceSend) {
      this.forceSend();
      return;
    }
    this.submitAfterFinal = true;

    let timer: number | null = null;
    const raced = new Promise<"forced">((resolve) => {
      this.forceSend = () => resolve("forced");
      timer = window.setTimeout(() => resolve("forced"), SEND_FLUSH_TIMEOUT_MS);
    });
    const finalized = this.engine.stop().then(() => "final" as const);

    const winner = await Promise.race([finalized, raced]);
    if (timer !== null) window.clearTimeout(timer);
    this.forceSend = null;
    // The engine flushed on its own: onStateChange("idle") already submitted.
    if (winner === "final") return;
    // We gave up waiting (or the user did). Abandon the provider's improved
    // tail and send what we have — cancel() salvages the pill into the prompt
    // and goes through "idle", which submits. (Under manual endpointing the
    // pill IS the utterance, so without the salvage this would send nothing.)
    if (this.engine.isActive()) await this.cancel();
    else this.submitAfterFinal = false;
  }

  /**
   * Abort the session. By default the words already in the pill are still
   * salvaged into the prompt on the way to idle — a cancel usually means "stop
   * waiting", not "throw away what I said". Pass `discard` for the one case
   * where it really is a throwaway: the Advanced panel's preview session.
   */
  async cancel(opts: { discard?: boolean } = {}): Promise<void> {
    this.discardUtterance = opts.discard === true;
    this.stopSettleTimer();
    this.resetSettleBuffers();
    await this.engine.cancel();
    this.bar?.dispose();
    this.bar = null;
    this.target = null;
    this.resetUtteranceState();
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
      next.language !== this.settings.language ||
      // Endpointing is baked into the provider at construction (query params
      // / session.update), so a change to it needs a fresh provider.
      next.endpointing.mode !== this.settings.endpointing.mode ||
      next.endpointing.silenceMs !== this.settings.endpointing.silenceMs;
    this.settings = next;
    if (providerChanged && this.engine.getState() === "idle") {
      this.engine.setProvider(this.makeProvider());
    }
  }

  /** Current settings snapshot (the language menu reads + rewrites these). */
  getSettings(): TranscriptionSettings {
    return this.settings;
  }

  /**
   * Live-apply the appearance knobs (from the Advanced panel): update the
   * running pill immediately and re-time the settle loop to the new cadence.
   * Caller persists.
   */
  updateAppearance(next: DictationAppearance): void {
    this.settings = { ...this.settings, appearance: next };
    this.bar?.applyAppearance(next);
    this.applyOnsetConfig();
    if (this.settleTimer !== null) this.startSettleTimer();
  }

  /** Push the onset-detection thresholds from settings into the engine. */
  private applyOnsetConfig(): void {
    const a = this.settings.appearance;
    this.engine.setOnsetConfig({
      ...DEFAULT_ONSET_CONFIG,
      openThreshold: a.onsetOpen,
      closeThreshold: a.onsetClose,
    });
  }

  dispose(): void {
    this.stopSettleTimer();
    this.engine.dispose();
  }
}
