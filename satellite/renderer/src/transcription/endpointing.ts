// The one place the provider-agnostic endpointing preference is translated
// into each engine's own parameter. Every streaming engine spells "how long
// a pause has to be before the utterance is over" differently, and two of
// them have no true off switch — so "manual" is expressed as a silence window
// long enough that only an explicit stop ever closes the utterance.
//
// See docs/plans/dictation-endpointing.md for the mapping table.

import type { DictationEndpointing } from "./transcriptionSettings";

/**
 * The "effectively never" silence window (ms) handed to providers that cannot
 * be told to skip silence-based endpointing outright (Deepgram and the Claude
 * proxy in front of it). Finals still arrive on CloseStream, so nothing is
 * lost — the utterance simply stays open until we say we're done.
 */
export const MANUAL_SILENCE_MS = 60_000;

/**
 * Extra headroom (ms) between "this phrase ended" (`endpointing_ms`) and
 * "this turn ended" (`utterance_end_ms`) on the Claude proxy. Preserves the
 * shape of the endpoint's own 300/1000 defaults at any silence setting.
 */
export const UTTERANCE_END_HEADROOM_MS = 700;

/** Deepgram's `endpointing`, in ms. */
export function deepgramEndpointingMs(e: DictationEndpointing): number {
  return e.mode === "manual" ? MANUAL_SILENCE_MS : e.silenceMs;
}

/**
 * What the daemon stream URL carries. The daemon does the per-provider
 * mapping for Claude/Codex, because that is where those protocols live.
 */
export interface DaemonEndpointingParams {
  mode: DictationEndpointing["mode"];
  silenceMs: number;
}

export function daemonEndpointingParams(e: DictationEndpointing): DaemonEndpointingParams {
  return { mode: e.mode, silenceMs: e.silenceMs };
}
