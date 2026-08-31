// The dictation APPEARANCE knobs, shared by the right-click "Advanced" panel
// (dictationAdvancedPanel.ts) AND the tuning lab (dictation-lab.ts). Both
// render the exact same rows from the same descriptor list, so whatever you
// dial in the lab is literally the control the app ships — no divergence.
//
// This file is the catalogue; controlRows.ts is the renderer that draws it
// (and the endpointing group in endpointingControls.ts).

import {
  type ControlDesc,
  type ControlsHandle,
  renderControlRows,
} from "./controlRows";
import {
  coerceAppearance,
  DEFAULT_APPEARANCE,
  type DictationAppearance,
} from "./transcriptionSettings";

export type AppearanceControlsHandle = ControlsHandle<DictationAppearance>;

export interface RenderAppearanceControlsOpts {
  current: DictationAppearance;
  /** Called on EVERY change with the full next (coerced) appearance. */
  onChange: (next: DictationAppearance) => void;
}

export const APPEARANCE_CONTROLS: readonly ControlDesc<DictationAppearance>[] = [
  { kind: "subhead", label: "Crystallize" },
  {
    kind: "slider",
    key: "crystallizeMs",
    label: "Crystallize (ms)",
    help: "Per-character de-blur duration. Lower = each letter snaps sharp faster. 0–2000 ms.",
    min: 0,
    max: 2000,
    step: 10,
    unit: "ms",
  },
  {
    kind: "slider",
    key: "charStaggerMs",
    label: "Char stagger (ms)",
    help: "Delay between successive letters de-blurring — the left→right sweep speed. 0–200 ms.",
    min: 0,
    max: 200,
    step: 1,
    unit: "ms",
  },
  {
    kind: "slider",
    key: "blurStartPx",
    label: "Blur start (px)",
    help: "Starting blur of a fresh crystallizing char — how illegible it begins. 0–20 px.",
    min: 0,
    max: 20,
    step: 0.5,
    unit: "px",
  },
  {
    kind: "slider",
    key: "blurRestPx",
    label: "Blur rest (px)",
    help: "Resting blur once crystallized — the lingering 'still a ghost' softness. 0–8 px.",
    min: 0,
    max: 8,
    step: 0.1,
    unit: "px",
  },
  {
    kind: "slider",
    key: "placeholderBlurPx",
    label: "Placeholder blur (px)",
    help: "Heavy blur of a heard-but-unknown word blob (▓ run) before it crystallizes into a word. 0–20 px.",
    min: 0,
    max: 20,
    step: 0.5,
    unit: "px",
  },

  { kind: "subhead", label: "Word detection" },
  {
    kind: "select",
    key: "ghostMode",
    label: "Ghost mode",
    help: "How placeholders are counted: 'onset' = one per detected word onset (instant, accurate); 'estimate' = older voiced-time guess.",
    options: ["onset", "estimate"],
  },
  {
    kind: "slider",
    key: "onsetOpen",
    label: "Onset open (RMS)",
    help: "Mic energy to START a word (higher = needs louder speech). Room/mic dependent. 0.001–0.2.",
    min: 0.001,
    max: 0.2,
    step: 0.001,
    unit: "",
  },
  {
    kind: "slider",
    key: "onsetClose",
    label: "Onset close (RMS)",
    help: "Mic energy to END a word (hysteresis; below onset open). 0.001–0.2.",
    min: 0.001,
    max: 0.2,
    step: 0.001,
    unit: "",
  },

  { kind: "subhead", label: "Chunking" },
  {
    kind: "slider",
    key: "commitWordCount",
    label: "Pill size (words)",
    help: "How many crystallized words the pill holds before it is considered a full phrase. Display only — Endpointing below decides when anything reaches the terminal. 1–20.",
    min: 1,
    max: 20,
    step: 1,
    unit: "w",
  },
  {
    kind: "slider",
    key: "commitPauseMs",
    label: "Pill pause (ms)",
    help: "Extra pause before the phrase leaves the pill. Can only ever DELAY a commit past the Endpointing silence below, never bring one forward. 150–3000 ms.",
    min: 150,
    max: 3000,
    step: 50,
    unit: "ms",
  },

  { kind: "subhead", label: "Timing" },
  {
    kind: "slider",
    key: "settleMs",
    label: "Settle (ms)",
    help: "How often buffered updates flush to the pill — batches churn into calm steps. 80–2000 ms.",
    min: 80,
    max: 2000,
    step: 10,
    unit: "ms",
  },
  {
    kind: "slider",
    key: "ghostResetMs",
    label: "Ghost reset (ms)",
    help: "Clear stale ghost text after this much silence with nothing pending. 300–10000 ms.",
    min: 300,
    max: 10000,
    step: 100,
    unit: "ms",
  },

  { kind: "subhead", label: "Look" },
  {
    kind: "slider",
    key: "tailFontPx",
    label: "Tail font (px)",
    help: "Font size of the ghost-tail / crystallizing text. 9–28 px.",
    min: 9,
    max: 28,
    step: 1,
    unit: "px",
  },
  {
    kind: "check",
    key: "showBlobs",
    label: "Show word placeholders",
    help: "Show the leading heavily-blurred blobs for words heard but not yet transcribed.",
  },
  {
    kind: "select",
    key: "pillTheme",
    label: "Pill theme",
    help: "Pill background theme. 'auto' follows the app/lab theme.",
    options: ["auto", "dark", "light"],
  },
  {
    kind: "check",
    key: "textOutline",
    label: "Text outline",
    help: "Draw a contrast outline behind ghost text for legibility over any pane content.",
  },
];

/**
 * Render the shared appearance controls into `host`. Returns a handle to read
 * the value and to re-sync the DOM after an external change (Reset).
 */
export function renderAppearanceControls(
  host: HTMLElement,
  opts: RenderAppearanceControlsOpts,
): AppearanceControlsHandle {
  return renderControlRows<DictationAppearance>(host, {
    descs: APPEARANCE_CONTROLS,
    current: opts.current,
    coerce: coerceAppearance,
    defaults: DEFAULT_APPEARANCE,
    onChange: opts.onChange,
  });
}
