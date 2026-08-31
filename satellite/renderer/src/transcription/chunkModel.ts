// The sub-sentence chunk model (Phase 2). A "chunk" is the rolling phrase
// currently living in the pill overlay — everything spoken since the last
// commit. Each word is a SEGMENT with its own identity and lifecycle:
//
//   blurred        → an onset was heard; no text yet (a ▓ placeholder)
//   crystallizing  → transcription assigned/changed its word (animate de-blur)
//   sharp          → its word is stable (assigned + unchanged) — stop animating
//
// ENDPOINTING decides when the chunk commits (see `shouldFlush`): its leading
// run of resolved words is then written into the terminal as plain text and
// dropped from the pill, and the still-blurred tail (onsets the transcriber
// hasn't caught up to) carries into the next chunk. The pill renders only a
// trailing window of the chunk (`pillWindow`), so a long one still shows the
// words being spoken right now.
//
// Pure + deterministic so it unit-tests without a DOM, audio, or timers.

export type SegmentState = "blurred" | "crystallizing" | "sharp";

export interface Segment {
  /** Stable identity: the onset id (positive), or a synthetic negative id for a
   *  transcribed word that had no detected onset. Lets the view diff by id. */
  id: number;
  state: SegmentState;
  /** The resolved word, or null while still a blurred placeholder. */
  text: string | null;
}

export interface ChunkState {
  segments: Segment[];
  /** Words already committed to the terminal this utterance (transcript slice offset). */
  committedWords: number;
}

/** A fresh, empty chunk (optionally carrying the running committed-word offset). */
export function makeChunk(committedWords = 0): ChunkState {
  return { segments: [], committedWords };
}

/** Append a blurred placeholder for a newly-heard word onset (idempotent per id). */
export function addOnset(chunk: ChunkState, id: number): ChunkState {
  if (chunk.segments.some((s) => s.id === id)) return chunk;
  return {
    ...chunk,
    segments: [...chunk.segments, { id, state: "blurred", text: null }],
  };
}

/**
 * Assign resolved words to segments IN ORDER (word i → segment i):
 * - equal counts: every segment gets its word;
 * - more words than segments (transcriber split a blob): extra words append as
 *   crystallizing segments with synthetic ids;
 * - fewer words (transcriber behind the onsets): the trailing segments stay
 *   blurred.
 * A segment whose word is unchanged becomes `sharp` (won't re-animate); a new or
 * revised word becomes `crystallizing`.
 */
export function alignWords(chunk: ChunkState, words: readonly string[]): ChunkState {
  const n = Math.max(chunk.segments.length, words.length);
  const segments: Segment[] = [];
  for (let i = 0; i < n; i++) {
    const prev = chunk.segments[i];
    const word = i < words.length ? words[i] : null;
    if (word === null) {
      // No word for this segment yet — keep it exactly as it was (blurred tail).
      if (prev) segments.push(prev);
      continue;
    }
    const id = prev ? prev.id : -(i + 1);
    if (prev && prev.text === word) {
      segments.push({ id, state: "sharp", text: word });
    } else {
      segments.push({ id, state: "crystallizing", text: word });
    }
  }
  return { ...chunk, segments };
}

/** Segments that have a resolved word (blurred ones excluded). */
export function resolvedCount(chunk: ChunkState): number {
  return chunk.segments.reduce((n, s) => n + (s.text !== null ? 1 : 0), 0);
}

/** The resolved words of a chunk, in order (blurred gaps skipped). */
export function resolvedWords(chunk: ChunkState): string[] {
  return chunk.segments.filter((s) => s.text !== null).map((s) => s.text as string);
}

/**
 * What the PILL should show: the trailing `size` segments.
 *
 * Since endpointing owns the commit, a chunk is no longer bounded by a word
 * count — under `manual` it holds the WHOLE utterance, and under a long `auto`
 * silence it can hold a long one. The pill is a fixed-width overlay with
 * `overflow: hidden`, so rendering all of it would clip the newest words (the
 * ones you are actually saying) off the right-hand edge. Showing a trailing
 * window keeps the leading edge visible however long the utterance runs — and
 * is exactly what the "Pill size (words)" control now means.
 *
 * Display only: the chunk itself keeps every segment, because the final pass
 * still has to commit all of them.
 */
export function pillWindow(segments: readonly Segment[], size: number): readonly Segment[] {
  const n = Math.max(1, Math.floor(size));
  return segments.length <= n ? segments : segments.slice(segments.length - n);
}

/**
 * The endpointing preference, as this module needs it. Structurally the same
 * as `DictationEndpointing`; restated here so the chunk model stays free of
 * the settings module (it is pure and unit-tested without one).
 */
export interface CommitPolicy {
  mode: "auto" | "manual";
  /** Silence before an utterance may be committed (ms). Unused when manual. */
  silenceMs: number;
}

export interface FlushOpts {
  msSinceVoice: number;
  /** Display-side pause cadence. Can only ever make a commit LATER, never earlier. */
  commitPauseMs: number;
  /** The authority over when anything is committed. */
  endpointing: CommitPolicy;
}

/**
 * How long the speaker must have been silent before this chunk may commit.
 *
 * `silenceMs` is the floor: the endpointing preference is the user's explicit
 * "don't finalize before this" and nothing may commit earlier. A longer
 * `commitPauseMs` still wins over it, because that direction is safe — it only
 * ever delays.
 */
function commitAfterMs(opts: FlushOpts): number {
  return Math.max(opts.endpointing.silenceMs, opts.commitPauseMs);
}

/**
 * Should the chunk commit now?
 *
 * Committed text is injected into the terminal and never revised
 * (`TranscriptionController.commitToTerminal`), so this decision is where
 * transcription accuracy is won or lost: a word committed 700 ms into a pause
 * can no longer be corrected when the provider revises the phrase with more
 * context — and providers like Codex re-transcribe the whole turn, so an early
 * cut is a permanently worse transcript.
 *
 * Therefore endpointing, not the chunking knobs, decides:
 *   - `manual` — never. Only the final pass (Enter / stop dictation) commits.
 *   - `auto`   — after `commitAfterMs` of continuous silence, and on nothing
 *                else. Speaking on without a pause keeps the phrase in the
 *                pill, however long it gets.
 */
export function shouldFlush(chunk: ChunkState, opts: FlushOpts): boolean {
  if (resolvedCount(chunk) === 0) return false;
  if (opts.endpointing.mode === "manual") return false;
  return opts.msSinceVoice >= commitAfterMs(opts);
}

export interface FlushResult {
  /** The leading resolved words, space-joined — inject this into the terminal. */
  committedText: string;
  /** How many segments (words) were committed. */
  committedCount: number;
  /** The chunk after removing the committed leading run (blurred tail preserved). */
  rest: ChunkState;
}

/**
 * Commit the LEADING contiguous run of resolved words (stopping at the first
 * still-blurred segment, so committed terminal text is always in order and
 * gap-free). The remaining segments carry into the next chunk.
 */
export function takeFlush(chunk: ChunkState): FlushResult {
  let i = 0;
  while (i < chunk.segments.length && chunk.segments[i].text !== null) i++;
  const committed = chunk.segments.slice(0, i);
  const rest = chunk.segments.slice(i);
  return {
    committedText: committed.map((s) => s.text ?? "").join(" "),
    committedCount: committed.length,
    rest: { segments: rest, committedWords: chunk.committedWords + committed.length },
  };
}

export interface StepOpts extends FlushOpts {
  /** After this much silence with only-blurred segments, drop the phantom blobs. */
  ghostResetMs: number;
}

// A clear pause (~1s) means the speaker has stopped: everything already
// crystallized is committed, even any word stranded past a blurred gap, and the
// leftover blobs (onsets that never became words) are dropped. Floor only —
// the endpointing silence still wins when it is longer (and `manual` skips the
// sweep entirely); this is the auto-mode end-of-utterance sweep.
export const SILENCE_FINALIZE_MS = 1000;

export interface StepResult {
  /** The chunk after aligning + any commits (or a fresh chunk if cleared). */
  chunk: ChunkState;
  /** Committed phrases to append to the terminal, in order. */
  commits: string[];
  /** True when the chunk was fully drained (final pass or phantom reset). */
  cleared: boolean;
}

/**
 * Advance the chunk one settle tick: align the uncommitted transcript tail, then
 * commit whatever's due. THE single place the align→flush policy lives, shared by
 * the live controller and the tuning lab so they never drift.
 *
 * @param tailWords transcript words past `chunk.committedWords` (the pill's share)
 * @param final     the transcriber's final pass — commit everything remaining
 */
export function stepChunk(
  chunk: ChunkState,
  tailWords: readonly string[],
  opts: StepOpts,
  final: boolean,
): StepResult {
  let c = alignWords(chunk, tailWords);
  const commits: string[] = [];

  if (final) {
    // A final pass that comes back EMPTY must never swallow the utterance.
    // Providers do filter/return nothing (a failed or over-filtered final, a
    // socket that died before the last frame), and under `manual` endpointing
    // this is the ONLY commit there will be — dropping it loses everything the
    // user said. Fall back to the words already crystallized in the pill, the
    // same way `computeInjection` refuses to erase on an empty pass.
    const words = tailWords.length > 0 ? tailWords : resolvedWords(c);
    const remaining = words.join(" ");
    if (remaining) commits.push(remaining);
    return { chunk: makeChunk(c.committedWords + words.length), commits, cleared: true };
  }

  while (shouldFlush(c, opts)) {
    const { committedText, committedCount, rest } = takeFlush(c);
    if (committedCount === 0) break;
    commits.push(committedText);
    c = rest;
  }

  // End-of-utterance sweep: after a clear (~1s) silence, commit every remaining
  // crystallized word — even one stranded past a blurred gap that takeFlush
  // stops at — and clear the chunk (dropping unresolved blobs). Never earlier
  // than the endpointing floor or a longer commitPauseMs, and never at all in
  // manual mode: "manual" means the user has asked for exactly one commit, at
  // the end, and a silence sweep is still a silence-triggered commit.
  const finalizeMs = Math.max(SILENCE_FINALIZE_MS, commitAfterMs(opts));
  if (
    opts.endpointing.mode === "auto" &&
    opts.msSinceVoice > finalizeMs &&
    c.segments.length > 0
  ) {
    const resolvedTail = resolvedWords(c);
    if (resolvedTail.length > 0) commits.push(resolvedTail.join(" "));
    return {
      chunk: makeChunk(c.committedWords + resolvedTail.length),
      commits,
      cleared: true,
    };
  }

  // Phantom-blob reset: onsets that never resolved after a longer silence.
  if (resolvedCount(c) === 0 && c.segments.length > 0 && opts.msSinceVoice > opts.ghostResetMs) {
    return { chunk: makeChunk(c.committedWords), commits, cleared: true };
  }
  return { chunk: c, commits, cleared: false };
}
