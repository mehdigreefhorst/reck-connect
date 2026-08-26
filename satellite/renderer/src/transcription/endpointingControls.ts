// The ENDPOINTING knobs — when a streaming engine decides an utterance is
// over, which is the thing that makes short phrases survive (or not). Drawn
// by the same renderer as the appearance rows (controlRows.ts) and shown in
// the same Advanced panel / tuning lab.
//
// Unlike the appearance knobs these reach the PROVIDER: they are mapped onto
// Deepgram's `endpointing`, the Claude proxy's `endpointing_ms` /
// `utterance_end_ms`, and OpenAI's `turn_detection.silence_duration_ms`.
// See docs/plans/dictation-endpointing.md and endpointing.ts.

import {
  type ControlDesc,
  type ControlsHandle,
  renderControlRows,
} from "./controlRows";
import {
  coerceEndpointing,
  DEFAULT_ENDPOINTING,
  type DictationEndpointing,
} from "./transcriptionSettings";

export type EndpointingControlsHandle = ControlsHandle<DictationEndpointing>;

export const ENDPOINTING_CONTROLS: readonly ControlDesc<DictationEndpointing>[] = [
  { kind: "subhead", label: "Endpointing" },
  {
    kind: "select",
    key: "mode",
    label: "Finalize",
    help:
      "'auto' = the engine closes an utterance after a pause. 'manual' = it never does; " +
      "the transcript arrives only when you stop recording or press Enter. Manual is the " +
      "cure for an engine that cuts short phrases (Codex), but on Codex it also means no " +
      "live text until you stop — its partials come from the same voice detector.",
    options: ["auto", "manual"],
  },
  {
    kind: "slider",
    key: "silenceMs",
    label: "Silence before finalize (ms)",
    help:
      "How long a pause has to be before the engine closes the utterance and transcribes it. " +
      "Higher = fewer, longer, better-context chunks; lower = snappier but choppier. " +
      "Ignored in manual mode. 100–5000 ms.",
    min: 100,
    max: 5000,
    step: 50,
    unit: "ms",
  },
];

export interface RenderEndpointingControlsOpts {
  current: DictationEndpointing;
  /** Called on EVERY change with the full next (coerced) endpointing. */
  onChange: (next: DictationEndpointing) => void;
}

/** Render the endpointing rows into `host` (same rows as the lab's). */
export function renderEndpointingControls(
  host: HTMLElement,
  opts: RenderEndpointingControlsOpts,
): EndpointingControlsHandle {
  return renderControlRows<DictationEndpointing>(host, {
    descs: ENDPOINTING_CONTROLS,
    current: opts.current,
    coerce: coerceEndpointing,
    defaults: DEFAULT_ENDPOINTING,
    onChange: opts.onChange,
  });
}
