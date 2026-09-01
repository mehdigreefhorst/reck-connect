// #164 follow-up: `auto` endpointing behaved exactly like `manual` — nothing
// was ever committed on a pause, only at the very end.
//
// The cause was two thresholds that disagreed. The onset detector ends a word
// below `onsetClose` (0.012 by default, user-tunable), but the controller
// re-marked "voice heard" from a hardcoded `level > 0.01`. Room noise in the
// 0.010–0.012 band is *not speech* to the detector, yet it kept resetting the
// silence clock, so `msSinceVoice` never grew past a settle tick and the
// silence-based commit could not fire. Before endpointing owned the commit
// this was invisible: the old six-word trigger fired regardless of silence.
//
// These tests drive the controller with a level in exactly that band.

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { DictationState } from "./TranscriptionEngine";

const { engines, FakeEngine } = vi.hoisted(() => {
  type Handlers = Record<string, ((...args: never[]) => void) | undefined>;
  class FakeEngine {
    state: DictationState = "idle";
    constructor(
      public provider: unknown,
      public handlers: Handlers,
    ) {
      engines.push(this);
    }
    setOnsetConfig(): void {}
    setProvider(p: unknown): void {
      this.provider = p;
    }
    getState(): DictationState {
      return this.state;
    }
    isActive(): boolean {
      return this.state !== "idle";
    }
    setState(s: DictationState): void {
      if (this.state === s) return;
      this.state = s;
      (this.handlers.onStateChange as ((s: DictationState) => void) | undefined)?.(s);
    }
    async start(): Promise<void> {
      this.setState("preparing");
      this.setState("listening");
    }
    async stop(): Promise<void> {
      this.setState("transcribing");
    }
    async cancel(): Promise<void> {
      this.setState("idle");
    }
    dispose(): void {}
  }
  const engines: FakeEngine[] = [];
  return { engines, FakeEngine };
});

type FakeEngine = InstanceType<typeof FakeEngine>;

vi.mock("./TranscriptionEngine", () => ({ TranscriptionEngine: FakeEngine }));

vi.mock("./DictationBar", () => ({
  DictationBar: class {
    setState(): void {}
    setStatus(): void {}
    setProgress(): void {}
    setLevel(): void {}
    setTail(): void {}
    setPendingWords(): void {}
    setChunk(): void {}
    clearChunk(): void {}
    setError(): void {}
    applyAppearance(): void {}
    dispose(): void {}
  },
}));

vi.mock("./providers/LocalWhisperProvider", () => ({
  LocalWhisperProvider: class {
    prepare(): void {}
    begin(): void {}
    feed(): void {}
    end(): void {}
    cancel(): void {}
    dispose(): void {}
  },
}));

import { TranscriptionController } from "./TranscriptionController";
import {
  DEFAULT_TRANSCRIPTION_SETTINGS,
  type TranscriptionSettings,
} from "./transcriptionSettings";

/** silenceMs 500 vs commitPauseMs 700 → commits after 700 ms of real silence. */
const AUTO_SETTINGS: TranscriptionSettings = {
  ...DEFAULT_TRANSCRIPTION_SETTINGS,
  provider: "local",
  endpointing: { mode: "auto", silenceMs: 500 },
  appearance: { ...DEFAULT_TRANSCRIPTION_SETTINGS.appearance, settleMs: 100 },
};

vi.mock("./transcriptionSettings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./transcriptionSettings")>()),
  loadTranscriptionSettings: async () => AUTO_SETTINGS,
}));

/** Just under the default onsetClose (0.012), just over the old hardcoded 0.01. */
const ROOM_NOISE = 0.011;

interface Harness {
  engine: FakeEngine;
  inserted: string[];
  /** Speak `words`: an onset each, the transcript, then the word ends. */
  say(words: string[]): void;
  /** Hold the mic open at `level` for `ms`, ticking the settle loop. */
  silence(ms: number, level?: number): void;
}

async function startAutoDictation(): Promise<Harness> {
  const inserted: string[] = [];
  const controller = new TranscriptionController({
    settings: AUTO_SETTINGS,
    resolveSession: () => ({
      target: { insert: (t: string) => inserted.push(t), submit: () => {} },
      surface: document.createElement("div"),
    }),
  });
  await controller.startDictation();
  const engine = engines[engines.length - 1];
  const h = engine.handlers as Record<string, (...a: never[]) => void>;

  let onsetId = 0;
  // The provider reports the RUNNING transcript, not just the new words.
  const spoken: string[] = [];
  return {
    engine,
    inserted,
    say(words: string[]) {
      for (const _w of words) h.onWordOnset?.(++onsetId as never);
      spoken.push(...words);
      h.onPartial?.(spoken.join(" ") as never);
      h.onWordEnd?.(onsetId as never, 200 as never);
    },
    silence(ms: number, level = ROOM_NOISE) {
      // 20 ms audio frames, the settle loop ticking alongside them, exactly
      // as the real capture + interval do.
      for (let elapsed = 0; elapsed < ms; elapsed += 20) {
        h.onLevel?.(level as never);
        vi.advanceTimersByTime(20);
      }
    },
  };
}

describe("auto endpointing commits on silence", () => {
  beforeEach(() => {
    engines.length = 0;
    // `msSinceVoice` reads performance.now(), which vitest does NOT fake by
    // default — without it in toFake the clock never advances and every
    // silence assertion here would be vacuous.
    // `now` must be non-zero: msSinceVoice() treats lastVoiceAt === 0 as
    // "no voice ever heard" and returns Infinity, so a clock starting at 0
    // would make every commit fire instantly and the tests pass vacuously.
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date", "performance"],
    });
    // The fake performance clock starts at 0, and msSinceVoice() reads
    // lastVoiceAt === 0 as "no voice ever heard" → Infinity, which would fire
    // every commit instantly and make these tests pass vacuously. Roll the
    // clock forward so timestamps are honest.
    vi.advanceTimersByTime(10_000);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("commits after the configured silence even with a live noise floor", async () => {
    const h = await startAutoDictation();
    h.say(["hello", "world"]);
    h.silence(1500);
    // Without the fix the 0.011 samples re-mark voice on every frame,
    // msSinceVoice never passes 700 ms, and this array stays empty.
    expect(h.inserted.join("").trim()).toBe("hello world");
  });

  it("does NOT commit before the silence has elapsed", async () => {
    const h = await startAutoDictation();
    h.say(["hello", "world"]);
    h.silence(300);
    expect(h.inserted).toEqual([]);
  });

  it("real speech (level at/above onsetClose) keeps holding the commit back", async () => {
    const h = await startAutoDictation();
    h.say(["hello", "world"]);
    // 1.5 s of genuine voice-level audio: the clock must keep re-arming.
    h.silence(1500, 0.05);
    expect(h.inserted).toEqual([]);
  });

  it("a word onset re-arms the silence clock", async () => {
    const h = await startAutoDictation();
    h.say(["hello"]);
    h.silence(400);
    h.say(["there"]); // onset lands before the 700 ms is up
    h.silence(400);
    expect(h.inserted).toEqual([]);
    h.silence(500);
    expect(h.inserted.join("").trim()).toBe("hello there");
  });
});
