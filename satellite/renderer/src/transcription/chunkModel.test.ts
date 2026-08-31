import { describe, it, expect } from "vitest";
import {
  addOnset,
  alignWords,
  makeChunk,
  resolvedCount,
  shouldFlush,
  stepChunk,
  takeFlush,
  type ChunkState,
  type StepOpts,
} from "./chunkModel";

const AUTO: StepOpts["endpointing"] = { mode: "auto", silenceMs: 500 };
const MANUAL: StepOpts["endpointing"] = { mode: "manual", silenceMs: 3900 };
const OPTS: Omit<StepOpts, "msSinceVoice"> = {
  commitWordCount: 6,
  commitPauseMs: 700,
  ghostResetMs: 1200,
  endpointing: AUTO,
};

describe("chunkModel.addOnset", () => {
  it("appends one blurred, textless segment per onset id", () => {
    let c = makeChunk();
    c = addOnset(c, 1);
    c = addOnset(c, 2);
    expect(c.segments).toEqual([
      { id: 1, state: "blurred", text: null },
      { id: 2, state: "blurred", text: null },
    ]);
  });

  it("is idempotent for a repeated id", () => {
    let c = addOnset(makeChunk(), 1);
    c = addOnset(c, 1);
    expect(c.segments).toHaveLength(1);
  });
});

describe("chunkModel.alignWords", () => {
  it("assigns words to blurred segments in order and crystallizes them", () => {
    let c = makeChunk();
    c = addOnset(c, 1);
    c = addOnset(c, 2);
    c = alignWords(c, ["open", "the"]);
    expect(c.segments).toEqual([
      { id: 1, state: "crystallizing", text: "open" },
      { id: 2, state: "crystallizing", text: "the" },
    ]);
  });

  it("marks an unchanged word sharp (so it stops re-animating)", () => {
    let c = alignWords(addOnset(makeChunk(), 1), ["open"]);
    c = alignWords(c, ["open"]);
    expect(c.segments[0].state).toBe("sharp");
  });

  it("re-crystallizes a revised word (aurth → auth)", () => {
    let c = alignWords(addOnset(makeChunk(), 1), ["aurth"]);
    c = alignWords(c, ["auth"]);
    expect(c.segments[0]).toEqual({ id: 1, state: "crystallizing", text: "auth" });
  });

  it("leaves trailing segments blurred when the transcriber is behind", () => {
    let c = makeChunk();
    c = addOnset(c, 1);
    c = addOnset(c, 2);
    c = addOnset(c, 3);
    c = alignWords(c, ["open"]);
    expect(c.segments.map((s) => s.state)).toEqual(["crystallizing", "blurred", "blurred"]);
  });

  it("appends extra words (transcriber split a blob) as synthetic segments", () => {
    let c = alignWords(addOnset(makeChunk(), 1), ["open", "the", "file"]);
    expect(c.segments).toHaveLength(3);
    expect(c.segments[0].id).toBe(1);
    expect(c.segments[1].id).toBeLessThan(0);
    expect(c.segments[2].id).toBeLessThan(0);
    expect(c.segments.every((s) => s.text !== null)).toBe(true);
  });
});

describe("chunkModel.shouldFlush", () => {
  const base = (words: string[]): ChunkState =>
    alignWords(
      words.reduce((c, _w, i) => addOnset(c, i + 1), makeChunk()),
      words,
    );
  const opts = (over: Partial<StepOpts> = {}): StepOpts => ({ ...OPTS, msSinceVoice: 0, ...over });

  it("never flushes an empty or all-blurred chunk", () => {
    expect(shouldFlush(makeChunk(), opts({ msSinceVoice: 9999 }))).toBe(false);
    const blurred = addOnset(addOnset(makeChunk(), 1), 2);
    expect(shouldFlush(blurred, opts({ msSinceVoice: 9999 }))).toBe(false);
  });

  it("flushes after the endpointing silence, and not before", () => {
    const c = base(["hello"]);
    expect(shouldFlush(c, opts({ msSinceVoice: 800 }))).toBe(true);
    expect(shouldFlush(c, opts({ msSinceVoice: 300 }))).toBe(false);
  });

  // The regression this whole change is about (#164): a long endpointing
  // setting was defeated by "six words have arrived", so half-transcribed
  // phrases were frozen into the terminal mid-sentence.
  it("does NOT flush on word count while the speaker is still talking", () => {
    const c = base(["a", "b", "c", "d", "e", "f"]);
    expect(shouldFlush(c, opts({ msSinceVoice: 0 }))).toBe(false);
    expect(shouldFlush(c, opts({ msSinceVoice: 60_000 }))).toBe(true);
  });

  it("honours a silence setting longer than the display pause", () => {
    const c = base(["hello"]);
    const long = opts({ endpointing: { mode: "auto", silenceMs: 3900 } });
    expect(shouldFlush(c, { ...long, msSinceVoice: 800 })).toBe(false);
    expect(shouldFlush(c, { ...long, msSinceVoice: 3900 })).toBe(true);
  });

  it("honours a display pause longer than the silence setting (delay is safe)", () => {
    const c = base(["hello"]);
    const slowPill = opts({ commitPauseMs: 2000 });
    expect(shouldFlush(c, { ...slowPill, msSinceVoice: 1500 })).toBe(false);
    expect(shouldFlush(c, { ...slowPill, msSinceVoice: 2000 })).toBe(true);
  });

  it("never flushes in manual mode, whatever the pause or word count", () => {
    const c = base(["a", "b", "c", "d", "e", "f", "g"]);
    for (const ms of [0, 700, 3900, 60_000, Number.POSITIVE_INFINITY]) {
      expect(shouldFlush(c, opts({ msSinceVoice: ms, endpointing: MANUAL }))).toBe(false);
    }
  });
});

describe("chunkModel.stepChunk", () => {
  it("commits nothing while the phrase is short and speech is ongoing", () => {
    const chunk = addOnset(addOnset(makeChunk(), 1), 2);
    const r = stepChunk(chunk, ["open", "the"], { ...OPTS, msSinceVoice: 100 }, false);
    expect(r.commits).toEqual([]);
    expect(r.cleared).toBe(false);
    expect(r.chunk.segments.map((s) => s.text)).toEqual(["open", "the"]);
  });

  it("commits the phrase on a pause and advances the committed offset", () => {
    let chunk = makeChunk();
    chunk = addOnset(addOnset(addOnset(chunk, 1), 2), 3);
    const r = stepChunk(chunk, ["fix", "the", "bug"], { ...OPTS, msSinceVoice: 900 }, false);
    expect(r.commits).toEqual(["fix the bug"]);
    expect(r.chunk.committedWords).toBe(3);
    expect(r.chunk.segments).toEqual([]);
  });

  it("commits everything remaining on final", () => {
    const chunk = addOnset(makeChunk(), 1);
    const r = stepChunk(chunk, ["done"], { ...OPTS, msSinceVoice: 0 }, true);
    expect(r.commits).toEqual(["done"]);
    expect(r.cleared).toBe(true);
    expect(r.chunk.committedWords).toBe(1);
  });

  it("clears phantom blobs after a long silence with nothing resolved", () => {
    const chunk = addOnset(addOnset(makeChunk(), 1), 2);
    const r = stepChunk(chunk, [], { ...OPTS, msSinceVoice: 2000 }, false);
    expect(r.commits).toEqual([]);
    expect(r.cleared).toBe(true);
    expect(r.chunk.segments).toEqual([]);
  });

  it("commits ALL crystallized text after >1s silence and drops leftover blobs", () => {
    // 2 resolved words + 1 trailing blurred onset that never transcribed.
    let chunk = makeChunk();
    chunk = addOnset(addOnset(addOnset(chunk, 1), 2), 3);
    const r = stepChunk(chunk, ["hello", "world"], { ...OPTS, msSinceVoice: 1100 }, false);
    expect(r.commits.join(" ")).toBe("hello world");
    expect(r.cleared).toBe(true);
    expect(r.chunk.segments).toEqual([]);
    // Only the two real (transcript) words advance the committed offset.
    expect(r.chunk.committedWords).toBe(2);
  });

  it("keeps trailing blobs during a short (<1s) mid-phrase pause", () => {
    // A brief pause commits the resolved phrase but must NOT drop the pending
    // blurred onset (its word may still arrive from a laggy transcriber).
    let chunk = makeChunk();
    chunk = addOnset(addOnset(chunk, 1), 2);
    const r = stepChunk(chunk, ["open"], { ...OPTS, msSinceVoice: 750 }, false);
    expect(r.commits).toEqual(["open"]);
    expect(r.cleared).toBe(false);
    expect(r.chunk.segments.map((s) => s.state)).toEqual(["blurred"]);
  });
});

// #164: with Finalize = manual the ONLY commit is the final pass — Enter or
// stopping dictation. Nothing the speaker does mid-utterance may inject text,
// because injected text is never revised and the provider re-transcribes the
// whole turn with more context.
describe("chunkModel.stepChunk under manual endpointing", () => {
  const MANUAL_OPTS = { ...OPTS, endpointing: MANUAL };

  it("commits nothing across word count, pause and the silence sweep", () => {
    let chunk = makeChunk();
    chunk = addOnset(addOnset(addOnset(chunk, 1), 2), 3);
    for (const msSinceVoice of [0, 700, 1100, 5000, 60_000]) {
      const r = stepChunk(chunk, ["fix", "the", "bug"], { ...MANUAL_OPTS, msSinceVoice }, false);
      expect(r.commits, `msSinceVoice=${msSinceVoice}`).toEqual([]);
      expect(r.cleared).toBe(false);
    }
  });

  it("keeps accumulating the phrase in the pill instead of draining it", () => {
    let chunk = makeChunk();
    chunk = addOnset(addOnset(chunk, 1), 2);
    const r = stepChunk(chunk, ["hello", "world"], { ...MANUAL_OPTS, msSinceVoice: 9000 }, false);
    expect(r.chunk.segments.map((s) => s.text)).toEqual(["hello", "world"]);
    expect(r.chunk.committedWords).toBe(0);
  });

  it("commits everything on the final pass (Enter / stop)", () => {
    let chunk = makeChunk();
    chunk = addOnset(addOnset(chunk, 1), 2);
    const r = stepChunk(chunk, ["hello", "world"], { ...MANUAL_OPTS, msSinceVoice: 0 }, true);
    expect(r.commits).toEqual(["hello world"]);
    expect(r.cleared).toBe(true);
    expect(r.chunk.committedWords).toBe(2);
  });

  it("still drops phantom blobs that never resolved (display only, no commit)", () => {
    const chunk = addOnset(addOnset(makeChunk(), 1), 2);
    const r = stepChunk(chunk, [], { ...MANUAL_OPTS, msSinceVoice: 2000 }, false);
    expect(r.commits).toEqual([]);
    expect(r.cleared).toBe(true);
    expect(r.chunk.segments).toEqual([]);
  });
});

describe("chunkModel.stepChunk under a long auto silence", () => {
  const SLOW: Omit<StepOpts, "msSinceVoice"> = {
    ...OPTS,
    endpointing: { mode: "auto", silenceMs: 3900 },
  };

  it("holds the phrase until the configured silence, then commits it", () => {
    let chunk = makeChunk();
    chunk = addOnset(addOnset(chunk, 1), 2);
    const early = stepChunk(chunk, ["hello", "world"], { ...SLOW, msSinceVoice: 1500 }, false);
    expect(early.commits).toEqual([]);
    const late = stepChunk(chunk, ["hello", "world"], { ...SLOW, msSinceVoice: 4000 }, false);
    expect(late.commits.join(" ")).toBe("hello world");
  });
});
