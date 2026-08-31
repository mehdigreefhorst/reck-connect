// #164 follow-up: under `manual` endpointing NOTHING is injected into the
// prompt until the utterance ends, so every path that ends an utterance must
// actually deliver it. These tests drive the controller through the non-happy
// endings — a provider error, the mic clicked during the final pass, the
// Enter-send flush timeout — and assert the words still land.

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { DictationState } from "./TranscriptionEngine";

// A stand-in engine: no mic, no provider, no timers. The test plays the role
// of the transcription provider by calling the handlers directly. Defined
// inside vi.hoisted so the (hoisted) vi.mock factory below can reach it.
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
    /** Set to simulate a wedged provider whose final never arrives. */
    hangOnStop = false;
    // Deliberately does NOT deliver a final — the tests that need one call the
    // handler themselves, and the ones that don't are exactly the lossy paths.
    async stop(): Promise<void> {
      this.setState("transcribing");
      if (this.hangOnStop) await new Promise<void>(() => {});
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

// The pill's DOM is not under test; the words that reach the PTY are.
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

// Its constructor spawns a Web Worker, which jsdom has none of.
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

// startDictation() re-reads the persisted settings so a settings-page edit
// applies to the next utterance; there is no config bridge under jsdom.
const MANUAL_SETTINGS: TranscriptionSettings = {
  ...DEFAULT_TRANSCRIPTION_SETTINGS,
  provider: "local",
  // The setting under test: nothing may be committed until the very end.
  endpointing: { mode: "manual", silenceMs: 3900 },
};
vi.mock("./transcriptionSettings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./transcriptionSettings")>()),
  loadTranscriptionSettings: async () => MANUAL_SETTINGS,
}));

interface Harness {
  controller: TranscriptionController;
  engine: FakeEngine;
  inserted: string[];
  submits: number;
  /** Play a word: an onset, then the transcript that resolves it. */
  say(words: string[]): void;
}

async function startManualDictation(): Promise<Harness> {
  const inserted: string[] = [];
  let submits = 0;
  const controller = new TranscriptionController({
    settings: MANUAL_SETTINGS,
    resolveSession: () => ({
      target: {
        insert: (t: string) => inserted.push(t),
        submit: () => {
          submits += 1;
        },
      },
      surface: document.createElement("div"),
    }),
  });
  await controller.startDictation();
  const engine = engines[engines.length - 1];
  const h: Harness = {
    controller,
    engine,
    inserted,
    get submits() {
      return submits;
    },
    say(words) {
      const onset = engine.handlers.onWordOnset as (id: number) => void;
      for (let i = 1; i <= words.length; i++) onset(i);
      (engine.handlers.onPartial as (t: string) => void)(words.join(" "));
    },
  };
  return h;
}

beforeEach(() => {
  engines.length = 0;
});

describe("TranscriptionController salvage (manual endpointing)", () => {
  it("holds everything back while the utterance is running", async () => {
    const h = await startManualDictation();
    h.say(["never", "commit", "this", "mid", "sentence", "please", "really"]);
    expect(h.inserted).toEqual([]);
  });

  it("commits the held utterance when the provider errors out", async () => {
    const h = await startManualDictation();
    h.say(["socket", "died", "mid", "sentence"]);
    (h.engine.handlers.onError as (m: string) => void)("websocket closed");
    await Promise.resolve();
    expect(h.inserted.join("")).toBe("socket died mid sentence");
  });

  it("commits the held utterance when the mic is clicked during the final pass", async () => {
    const h = await startManualDictation();
    h.say(["abandon", "the", "improvement", "pass"]);
    await h.engine.stop(); // → "transcribing"
    // Abandoning is only honoured once the grace window has passed; inside it
    // the click is an accidental double-click (see the double-click tests).
    vi.useFakeTimers({ toFake: ["performance"] });
    try {
      vi.advanceTimersByTime(10_000);
      await h.controller.toggle(); // user clicks again, deliberately
    } finally {
      vi.useRealTimers();
    }
    expect(h.inserted.join("")).toBe("abandon the improvement pass");
  });

  it("submits the held utterance when the Enter-send flush times out", async () => {
    vi.useFakeTimers();
    try {
      const h = await startManualDictation();
      h.say(["send", "this", "message"]);
      h.engine.hangOnStop = true; // the provider never returns its final
      const sent = h.controller.stopForSend();
      await vi.advanceTimersByTimeAsync(5000);
      await sent;
      expect(h.inserted.join("")).toBe("send this message");
      expect(h.submits).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("throws the utterance away on an explicit discard (panel preview)", async () => {
    const h = await startManualDictation();
    h.say(["just", "previewing", "the", "sliders"]);
    await h.controller.cancel({ discard: true });
    expect(h.inserted).toEqual([]);
  });
});

// A double-click on the mic used to destroy the whole recording. Stopping puts
// the engine in `transcribing` with the words IN FLIGHT at the provider —
// under `manual` endpointing that is the only place they exist, because the
// pill is still all blurred placeholders until the final arrives (Codex sends
// no partials at all in manual). The second click cancelled, the socket closed
// before the final landed, and the salvage had nothing to recover.
describe("double-clicking the mic must not discard an in-flight utterance", () => {
  it("ignores the second click and still delivers the final", async () => {
    const h = await startManualDictation();
    h.say(["do", "not", "lose", "this"]);
    await h.engine.stop(); // → "transcribing"
    await h.controller.toggle(); // the accidental second click
    expect(h.engine.getState()).toBe("transcribing"); // NOT torn down
    expect(h.inserted).toEqual([]); // nothing salvaged early either
    // The provider's final arrives as it always would have.
    (h.engine.handlers.onFinal as (t: string) => void)("do not lose this");
    (h.engine as { setState(s: string): void }).setState("idle");
    expect(h.inserted.join("")).toBe("do not lose this");
  });

  it("survives a rapid burst of clicks", async () => {
    const h = await startManualDictation();
    h.say(["still", "here"]);
    await h.engine.stop();
    for (let i = 0; i < 5; i++) await h.controller.toggle();
    expect(h.engine.getState()).toBe("transcribing");
    (h.engine.handlers.onFinal as (t: string) => void)("still here");
    (h.engine as { setState(s: string): void }).setState("idle");
    expect(h.inserted.join("")).toBe("still here");
  });

  // The worst case, and the one the user hit: Codex under manual sends no
  // partials, so every pill segment is blurred and the salvage can recover
  // NOTHING. Cancelling here loses the entire recording with no trace.
  it("protects an utterance the pill cannot salvage (no partials arrived)", async () => {
    const h = await startManualDictation();
    const eng = h.engine.handlers as Record<string, (...a: never[]) => void>;
    // Onsets only — no transcript text has ever been delivered.
    for (let id = 1; id <= 4; id++) eng.onWordOnset?.(id as never);
    await h.engine.stop();
    await h.controller.toggle();
    expect(h.engine.getState()).toBe("transcribing");
    (h.engine.handlers.onFinal as (t: string) => void)("four words at last");
    (h.engine as { setState(s: string): void }).setState("idle");
    expect(h.inserted.join("")).toBe("four words at last");
  });

  it("still abandons a wedged final pass after the grace window", async () => {
    const h = await startManualDictation();
    h.say(["wedged", "provider"]);
    await h.engine.stop();
    vi.useFakeTimers({ toFake: ["performance"] });
    try {
      vi.advanceTimersByTime(10_000);
      await h.controller.toggle();
    } finally {
      vi.useRealTimers();
    }
    expect(h.engine.getState()).toBe("idle");
    expect(h.inserted.join("")).toBe("wedged provider"); // salvaged, not lost
  });
});
