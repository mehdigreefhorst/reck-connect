import { describe, it, expect } from "vitest";
import {
  addOnset,
  alignWords,
  makeChunk,
  resolvedCount,
  pillWindow,
  shouldFlush,
  stepChunk,
  takeFlush,
  type ChunkState,
  type StepOpts,
} from "./chunkModel";

const AUTO: StepOpts["endpointing"] = { mode: "auto", silenceMs: 500 };
const MANUAL: StepOpts["endpointing"] = { mode: "manual", silenceMs: 3900 };
const OPTS: Omit<StepOpts, "msSinceVoice"> = {
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

  // The phantom-blob reset is the one thing in the step that still fires on a
  // timer under manual. It must only ever drop UNRESOLVED blobs.
  it("never lets the phantom reset take resolved words with it", () => {
    let chunk = makeChunk();
    chunk = addOnset(addOnset(addOnset(chunk, 1), 2), 3);
    const r = stepChunk(chunk, ["keep", "these"], { ...MANUAL_OPTS, msSinceVoice: 60_000 }, false);
    expect(r.cleared).toBe(false);
    expect(r.commits).toEqual([]);
    expect(r.chunk.segments.map((s) => s.text)).toEqual(["keep", "these", null]);
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

// Restored alongside the endpointing change: takeFlush is still the thing that
// decides WHAT a commit contains (the endpointing work only changed WHEN one
// happens), so its ordering guarantees need to stay covered.
describe("chunkModel.takeFlush", () => {
  it("commits the leading resolved run and preserves the blurred tail", () => {
    let c = makeChunk();
    c = addOnset(c, 1);
    c = addOnset(c, 2);
    c = addOnset(c, 3);
    c = alignWords(c, ["open", "the"]); // seg 3 still blurred
    const r = takeFlush(c);
    expect(r.committedText).toBe("open the");
    expect(r.committedCount).toBe(2);
    expect(r.rest.committedWords).toBe(2);
    expect(r.rest.segments).toEqual([{ id: 3, state: "blurred", text: null }]);
  });

  it("stops at the first blurred gap so committed text stays in order", () => {
    // seg1 resolved, seg2 blurred, seg3 resolved (out-of-order resolution).
    const c: ChunkState = {
      segments: [
        { id: 1, state: "sharp", text: "one" },
        { id: 2, state: "blurred", text: null },
        { id: 3, state: "crystallizing", text: "three" },
      ],
      committedWords: 0,
    };
    const r = takeFlush(c);
    expect(r.committedText).toBe("one");
    expect(r.rest.segments.map((s) => s.id)).toEqual([2, 3]);
  });

  it("resolvedCount ignores blurred segments", () => {
    let c = addOnset(addOnset(makeChunk(), 1), 2);
    c = alignWords(c, ["hi"]);
    expect(resolvedCount(c)).toBe(1);
  });
});

// A final pass is the ONLY commit under manual endpointing. If the provider
// hands back an empty final (filtered result, socket died on the last frame),
// committing "" would silently swallow the entire utterance.
describe("chunkModel.stepChunk final fallback", () => {
  const MANUAL_OPTS = { ...OPTS, endpointing: MANUAL, msSinceVoice: 0 };

  it("commits the pill's words when the final transcript comes back empty", () => {
    let chunk = makeChunk();
    chunk = addOnset(addOnset(chunk, 1), 2);
    chunk = alignWords(chunk, ["fix", "everything"]);
    const r = stepChunk(chunk, [], MANUAL_OPTS, true);
    expect(r.commits).toEqual(["fix everything"]);
    expect(r.cleared).toBe(true);
  });

  it("skips a blurred gap rather than emitting a hole", () => {
    const chunk: ChunkState = {
      segments: [
        { id: 1, state: "sharp", text: "one" },
        { id: 2, state: "blurred", text: null },
        { id: 3, state: "sharp", text: "three" },
      ],
      committedWords: 0,
    };
    const r = stepChunk(chunk, [], MANUAL_OPTS, true);
    expect(r.commits).toEqual(["one three"]);
  });

  it("still prefers the transcript when the final does have words", () => {
    let chunk = makeChunk();
    chunk = addOnset(addOnset(chunk, 1), 2);
    chunk = alignWords(chunk, ["fix", "evrything"]);
    const r = stepChunk(chunk, ["fix", "everything", "please"], MANUAL_OPTS, true);
    expect(r.commits).toEqual(["fix everything please"]);
  });

  it("commits nothing when there is genuinely nothing (only blobs)", () => {
    const chunk = addOnset(addOnset(makeChunk(), 1), 2);
    const r = stepChunk(chunk, [], MANUAL_OPTS, true);
    expect(r.commits).toEqual([]);
    expect(r.cleared).toBe(true);
  });
});

// The pill is a clipped, fixed-width overlay. Once endpointing owns the commit
// a chunk is unbounded (manual holds the whole utterance), so the view has to
// window it or the words being spoken RIGHT NOW fall off the right edge.
describe("chunkModel.pillWindow", () => {
  const segs = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: i + 1,
      state: "sharp" as const,
      text: `w${i + 1}`,
    }));

  it("passes a short chunk through untouched", () => {
    const s = segs(3);
    expect(pillWindow(s, 7)).toBe(s);
  });

  it("keeps the NEWEST words when the chunk outgrows the pill", () => {
    expect(pillWindow(segs(300), 7).map((s) => s.id)).toEqual([294, 295, 296, 297, 298, 299, 300]);
  });

  it("never renders nothing, whatever the slider says", () => {
    expect(pillWindow(segs(5), 0)).toHaveLength(1);
    expect(pillWindow(segs(5), -3)).toHaveLength(1);
  });
});
