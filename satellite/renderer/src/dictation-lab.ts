// Dictation Tuning Lab — a standalone dev page (dictation-lab.html) that
// REPLAYS a scripted dictation timeline through the REAL DictationBar overlay
// while every appearance knob is live-tunable on the right. It has no mic, no
// Electron, and no window.reckAPI dependency: the whole session is simulated
// by driving the same DictationBar methods the real TranscriptionController
// calls (setState / setLevel / setTail / setPendingWords).
//
// Served at /dictation-lab.html (dev + packaged). Pick a script, hit Replay,
// then tune crystallizeMs/blur/etc. until the ghost-text look feels right and
// "Copy settings JSON" the result into DEFAULT_APPEARANCE.

import "./styles.css";
import { DictationBar } from "./transcription/DictationBar";
import type { DictationState } from "./transcription/TranscriptionEngine";
import {
  DEFAULT_APPEARANCE,
  coerceAppearance,
  type DictationAppearance,
} from "./transcription/transcriptionSettings";

// ---------------------------------------------------------------------------
// Timeline model
// ---------------------------------------------------------------------------

/** One scheduled instruction fed to the DictationBar at time `atMs`. */
type Step =
  | { atMs: number; kind: "state"; state: DictationState }
  | { atMs: number; kind: "level"; level: number }
  | { atMs: number; kind: "pending"; count: number }
  | { atMs: number; kind: "tail"; text: string }
  | { atMs: number; kind: "commit"; text: string };

interface Timeline {
  steps: Step[];
  durationMs: number;
}

/** A single spoken word's lifecycle in the simulation. */
interface WordSpec {
  /** Final, correct spelling (what lands in the prompt). */
  final: string;
  /** When its onset is "heard" — a ghost blob appears. */
  onset: number;
  /** When it enters the crystallizing ghost tail. */
  enter: number;
  /** When it leaves the tail and commits into the prompt line. */
  commit: number;
  /** Optional wrong interim spelling, shown until `correctAt`. */
  interim?: string;
  /** When the interim spelling is revised to `final` (crystallize-on-revision). */
  correctAt?: number;
}

interface ScriptSpec {
  id: string;
  name: string;
  /** "preparing" (model-load) duration before listening starts. */
  prepMs: number;
  /** Final "transcribing" tail duration before returning to idle. */
  transcribeMs: number;
  words: WordSpec[];
}

/** Steady-cadence word layout — models even speech. */
function layout(
  phrase: string,
  opts: { start: number; gap: number; tailLead: number; commitLag: number },
): WordSpec[] {
  return phrase.split(" ").map((final, i) => {
    const onset = opts.start + i * opts.gap;
    const enter = onset + opts.tailLead;
    return { final, onset, enter, commit: enter + opts.commitLag };
  });
}

// --- The hand-authored scripts --------------------------------------------

function shortPhraseScript(): ScriptSpec {
  return {
    id: "short",
    name: "Short phrase",
    prepMs: 250,
    transcribeMs: 380,
    words: layout("list the open files", {
      start: 300,
      gap: 240,
      tailLead: 200,
      commitLag: 460,
    }),
  };
}

function longSentenceScript(): ScriptSpec {
  return {
    id: "long",
    name: "Long sentence",
    prepMs: 320,
    transcribeMs: 520,
    words: layout(
      "please refactor the authentication module and add unit tests for the token refresh path",
      { start: 360, gap: 250, tailLead: 190, commitLag: 560 },
    ),
  };
}

function noisyRevisingScript(): ScriptSpec {
  // Slower, laggier speech with two spots where the interim guess is wrong
  // and later revised — exercising the crystallize-on-revision path (the tail
  // rebuilds the changed suffix, re-animating only the corrected words).
  const words = layout("fix the auth bug in the login flow", {
    start: 340,
    gap: 300,
    tailLead: 230,
    commitLag: 720,
  });
  // "auth" is first heard as "aurth", then corrected while still in the tail.
  const auth = words[2];
  auth.interim = "aurth";
  auth.correctAt = auth.enter + 360;
  auth.commit = auth.correctAt + 520;
  // "login" first mis-heard as "log", corrected shortly after.
  const login = words[6];
  login.interim = "log";
  login.correctAt = login.enter + 300;
  login.commit = login.correctAt + 480;
  return { id: "noisy", name: "Noisy / revising", prepMs: 300, transcribeMs: 560, words };
}

const SCRIPTS: ScriptSpec[] = [
  shortPhraseScript(),
  longSentenceScript(),
  noisyRevisingScript(),
];

// --- Timeline compiler -----------------------------------------------------

function tailAt(words: WordSpec[], t: number): string {
  const parts: string[] = [];
  for (const w of words) {
    if (w.enter <= t && t < w.commit) {
      const spell = w.interim !== undefined && (w.correctAt === undefined || t < w.correctAt)
        ? w.interim
        : w.final;
      parts.push(spell);
    }
  }
  return parts.join(" ");
}

function committedAt(words: WordSpec[], t: number): string {
  return words.filter((w) => w.commit <= t).map((w) => w.final).join(" ");
}

/** Words heard (onset passed) but not yet showing in the tail — the blobs. */
function pendingAt(words: WordSpec[], t: number): number {
  return words.filter((w) => w.onset <= t && w.enter > t).length;
}

/** Simulated mic level (0..0.5): bumps while each word is being voiced. */
function levelAt(words: WordSpec[], t: number): number {
  let level = 0.03;
  for (const w of words) {
    const center = (w.onset + w.enter) / 2;
    const half = Math.max(90, (w.enter - w.onset) / 2 + 80);
    const d = Math.abs(t - center);
    if (d < half) {
      const bump = (1 - d / half) * 0.42;
      level = Math.max(level, 0.06 + bump);
    }
  }
  // A little jitter so the meter reads as live speech, not a smooth ramp.
  const jitter = (Math.sin(t / 47) + Math.sin(t / 91)) * 0.02;
  return Math.max(0, Math.min(0.5, level + jitter));
}

function compile(script: ScriptSpec): Timeline {
  const steps: Step[] = [];
  const listenStart = script.prepMs;
  const lastCommit = Math.max(...script.words.map((w) => w.commit));
  const listenEnd = lastCommit;
  const transcribeStart = listenEnd;
  const idleAt = transcribeStart + script.transcribeMs;

  steps.push({ atMs: 0, kind: "state", state: "preparing" });
  steps.push({ atMs: listenStart, kind: "state", state: "listening" });

  // Sample tail / committed / pending on a 40ms grid, emitting only on change.
  let lastTail = "";
  let lastCommitted = "";
  let lastPending = 0;
  for (let t = listenStart; t <= listenEnd; t += 40) {
    const tail = tailAt(script.words, t);
    if (tail !== lastTail) {
      steps.push({ atMs: t, kind: "tail", text: tail });
      lastTail = tail;
    }
    const committed = committedAt(script.words, t);
    if (committed !== lastCommitted) {
      steps.push({ atMs: t, kind: "commit", text: committed });
      lastCommitted = committed;
    }
    const pending = pendingAt(script.words, t);
    if (pending !== lastPending) {
      steps.push({ atMs: t, kind: "pending", count: pending });
      lastPending = pending;
    }
  }

  // Meter ticks (80ms) across the whole listening window.
  for (let t = listenStart; t <= listenEnd; t += 80) {
    steps.push({ atMs: t, kind: "level", level: levelAt(script.words, t) });
  }

  // Wrap-up: clear the tail/blobs, run the final "transcribing" pass, idle.
  steps.push({ atMs: transcribeStart, kind: "state", state: "transcribing" });
  steps.push({ atMs: transcribeStart, kind: "tail", text: "" });
  steps.push({ atMs: transcribeStart, kind: "pending", count: 0 });
  steps.push({ atMs: idleAt, kind: "state", state: "idle" });

  steps.sort((a, b) => a.atMs - b.atMs);
  return { steps, durationMs: idleAt + 200 };
}

// ---------------------------------------------------------------------------
// Replay engine
// ---------------------------------------------------------------------------

class ReplayEngine {
  private bar: DictationBar | null = null;
  private timeline: Timeline;
  private nextIdx = 0;
  private position = 0; // ms playhead
  private playing = false;
  private wallStart = 0;
  private raf = 0;
  private committed = "";

  constructor(
    private readonly stage: HTMLElement,
    private appearance: DictationAppearance,
    private readonly onTick: (position: number, duration: number, playing: boolean) => void,
    private readonly onCommitted: (text: string) => void,
    script: ScriptSpec,
  ) {
    this.timeline = compile(script);
    this.rebuildBar();
  }

  get durationMs(): number {
    return this.timeline.durationMs;
  }

  setScript(script: ScriptSpec): void {
    this.timeline = compile(script);
    this.seek(0);
  }

  setAppearance(a: DictationAppearance): void {
    this.appearance = a;
    this.bar?.applyAppearance(a);
  }

  private rebuildBar(): void {
    this.bar?.dispose();
    this.bar = new DictationBar(this.stage, "Whisper Base", true, this.appearance);
    this.committed = "";
    this.onCommitted("");
  }

  private applyStep(step: Step): void {
    if (!this.bar) return;
    switch (step.kind) {
      case "state":
        this.bar.setState(step.state);
        break;
      case "level":
        this.bar.setLevel(step.level);
        break;
      case "pending":
        this.bar.setPendingWords(step.count);
        break;
      case "tail":
        this.bar.setTail(step.text);
        break;
      case "commit":
        this.committed = step.text;
        this.onCommitted(step.text);
        break;
    }
  }

  /** Dispatch every step whose time has arrived, advancing the cursor. */
  private dispatchUpTo(t: number): void {
    const { steps } = this.timeline;
    while (this.nextIdx < steps.length && steps[this.nextIdx].atMs <= t) {
      this.applyStep(steps[this.nextIdx]);
      this.nextIdx++;
    }
  }

  private loop = (): void => {
    if (!this.playing) return;
    this.position = performance.now() - this.wallStart;
    if (this.position >= this.timeline.durationMs) {
      this.position = this.timeline.durationMs;
      this.dispatchUpTo(this.position);
      this.playing = false;
      this.onTick(this.position, this.timeline.durationMs, false);
      return;
    }
    this.dispatchUpTo(this.position);
    this.onTick(this.position, this.timeline.durationMs, true);
    this.raf = requestAnimationFrame(this.loop);
  };

  play(): void {
    if (this.playing) return;
    // Reaching the end then hitting Play restarts from 0.
    if (this.position >= this.timeline.durationMs) this.seek(0);
    this.playing = true;
    this.wallStart = performance.now() - this.position;
    this.raf = requestAnimationFrame(this.loop);
  }

  pause(): void {
    this.playing = false;
    cancelAnimationFrame(this.raf);
    this.onTick(this.position, this.timeline.durationMs, false);
  }

  replay(): void {
    this.seek(0);
    this.play();
  }

  /** Seek to `t` — rebuild the bar from scratch and fast-forward instantly. */
  seek(t: number): void {
    const wasPlaying = this.playing;
    this.playing = false;
    cancelAnimationFrame(this.raf);
    const clamped = Math.max(0, Math.min(t, this.timeline.durationMs));
    this.rebuildBar();
    this.nextIdx = 0;
    this.position = clamped;
    this.dispatchUpTo(clamped);
    this.onTick(this.position, this.timeline.durationMs, wasPlaying);
    if (wasPlaying) this.play();
  }

  dispose(): void {
    cancelAnimationFrame(this.raf);
    this.bar?.dispose();
    this.bar = null;
  }
}

// ---------------------------------------------------------------------------
// Appearance-control descriptors
// ---------------------------------------------------------------------------

interface SliderDesc {
  kind: "slider";
  key: keyof DictationAppearance;
  label: string;
  help: string;
  min: number;
  max: number;
  step: number;
  unit: string;
}
interface CheckDesc {
  kind: "check";
  key: keyof DictationAppearance;
  label: string;
  help: string;
}
interface SelectDesc {
  kind: "select";
  key: keyof DictationAppearance;
  label: string;
  help: string;
  options: string[];
}
type ControlDesc = SliderDesc | CheckDesc | SelectDesc;

const CONTROLS: ControlDesc[] = [
  {
    kind: "slider",
    key: "crystallizeMs",
    label: "crystallizeMs",
    help: "Per-character de-blur duration. Lower = each letter snaps sharp faster.",
    min: 0,
    max: 2000,
    step: 10,
    unit: "ms",
  },
  {
    kind: "slider",
    key: "charStaggerMs",
    label: "charStaggerMs",
    help: "Delay between successive letters de-blurring — the left→right sweep speed.",
    min: 0,
    max: 200,
    step: 1,
    unit: "ms",
  },
  {
    kind: "slider",
    key: "blurStartPx",
    label: "blurStartPx",
    help: "Starting blur of a fresh crystallizing char — how illegible it begins.",
    min: 0,
    max: 20,
    step: 0.5,
    unit: "px",
  },
  {
    kind: "slider",
    key: "blurRestPx",
    label: "blurRestPx",
    help: "Resting blur once crystallized — the lingering 'still a ghost' softness.",
    min: 0,
    max: 8,
    step: 0.1,
    unit: "px",
  },
  {
    kind: "slider",
    key: "placeholderBlurPx",
    label: "placeholderBlurPx",
    help: "Heavy blur of an unknown-word blob (▓ run) before it crystallizes into a word.",
    min: 0,
    max: 20,
    step: 0.5,
    unit: "px",
  },
  {
    kind: "slider",
    key: "tailFontPx",
    label: "tailFontPx",
    help: "Font size of the ghost-tail text.",
    min: 9,
    max: 28,
    step: 1,
    unit: "px",
  },
  {
    kind: "slider",
    key: "settleMs",
    label: "settleMs",
    help: "Live controller: how often buffered updates flush to the pill. (Replay is pre-baked, so this is captured in JSON but not re-timed here.)",
    min: 80,
    max: 2000,
    step: 10,
    unit: "ms",
  },
  {
    kind: "slider",
    key: "ghostResetMs",
    label: "ghostResetMs",
    help: "Live controller: clear stale ghost text after this much silence with nothing pending. (Captured in JSON; not exercised by the pre-baked replay.)",
    min: 300,
    max: 10000,
    step: 100,
    unit: "ms",
  },
  {
    kind: "slider",
    key: "onsetOpen",
    label: "onsetOpen",
    help: "Live mic: RMS energy to START a word (higher = needs louder speech). Not used in simulation.",
    min: 0.001,
    max: 0.2,
    step: 0.001,
    unit: "",
  },
  {
    kind: "slider",
    key: "onsetClose",
    label: "onsetClose",
    help: "Live mic: RMS energy to END a word (hysteresis, below onsetOpen). Not used in simulation.",
    min: 0.001,
    max: 0.2,
    step: 0.001,
    unit: "",
  },
  {
    kind: "check",
    key: "showBlobs",
    label: "showBlobs",
    help: "Show the leading 'words heard' blobs — the blurred cluster ahead of the text.",
  },
  {
    kind: "check",
    key: "textOutline",
    label: "textOutline",
    help: "Draw a contrast outline behind ghost text for legibility over any pane content.",
  },
  {
    kind: "select",
    key: "pillTheme",
    label: "pillTheme",
    help: "Pill background theme. 'auto' follows the app theme (toggle it on the left).",
    options: ["auto", "dark", "light"],
  },
  {
    kind: "select",
    key: "ghostMode",
    label: "ghostMode",
    help: "How blobs are counted live: 'onset' = one per detected word onset; 'estimate' = voiced-time guess. (Simulation always models onsets.)",
    options: ["onset", "estimate"],
  },
];

// ---------------------------------------------------------------------------
// DOM helpers
// ---------------------------------------------------------------------------

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function fmtTime(ms: number, total: number): string {
  return `${(ms / 1000).toFixed(1)}s / ${(total / 1000).toFixed(1)}s`;
}

function asNumber(v: DictationAppearance[keyof DictationAppearance]): number {
  return typeof v === "number" ? v : 0;
}

// ---------------------------------------------------------------------------
// Page bootstrap
// ---------------------------------------------------------------------------

function boot(): void {
  const root = document.getElementById("lab");
  if (!root) return;

  // Working copy of the appearance settings (coerced defaults).
  let appearance: DictationAppearance = coerceAppearance(DEFAULT_APPEARANCE);
  let currentScript = SCRIPTS[0];

  // --- Header --------------------------------------------------------------
  const head = el("div", "lab-head");
  const headLeft = el("div");
  headLeft.append(
    el("h1", undefined, "Dictation Tuning Lab"),
    el(
      "p",
      undefined,
      "Replay a scripted dictation through the real DictationBar overlay and live-tune the crystallizing ghost-text look. No mic, no Electron — pure simulation. Copy the JSON into DEFAULT_APPEARANCE when it feels right.",
    ),
  );
  head.append(headLeft);
  root.append(head);

  const grid = el("div", "lab-grid");
  const leftCol = el("div", "lab-col");
  const rightCol = el("div", "lab-col");
  grid.append(leftCol, rightCol);
  root.append(grid);

  // --- LEFT: stage + playback ---------------------------------------------
  const stageCard = el("div", "lab-card");
  stageCard.append(el("h2", undefined, "Stage"));

  const stage = el("div", "lab-stage");
  const stageHint = el("div", "lab-stage-hint", "terminal pane");
  stage.append(stageHint);
  stageCard.append(stage);

  // Fake prompt line beneath the pill showing the committed transcript.
  const promptLine = el("div", "lab-prompt");
  const promptText = el("span", undefined, "");
  const caret = el("span", "caret");
  promptLine.append(el("span", undefined, "› "), promptText, caret);

  // Playback controls.
  const controls = el("div", "lab-controls");
  const replayBtn = el("button", "primary", "⟳ Replay");
  const playBtn = el("button", undefined, "▶ Play");
  const scriptPicker = el("select");
  for (const s of SCRIPTS) {
    const opt = el("option");
    opt.value = s.id;
    opt.textContent = s.name;
    scriptPicker.append(opt);
  }
  const themeBtn = el("button", undefined, "◑ Theme: dark");
  const picker = el("div", "lab-picker");
  picker.append(el("span", undefined, "Script:"), scriptPicker);
  controls.append(replayBtn, playBtn, picker, themeBtn);

  const scrubRow = el("div", "lab-scrub-row");
  const scrubber = el("input");
  scrubber.type = "range";
  scrubber.min = "0";
  scrubber.step = "10";
  const timeLabel = el("span", "lab-time", "0.0s / 0.0s");
  scrubRow.append(scrubber, timeLabel);

  stageCard.append(promptLine, controls, scrubRow);
  leftCol.append(stageCard);

  // --- Replay engine -------------------------------------------------------
  let isPlaying = false;
  const engine = new ReplayEngine(
    stage,
    appearance,
    (position, duration, playing) => {
      scrubber.max = String(Math.round(duration));
      scrubber.value = String(Math.round(position));
      timeLabel.textContent = fmtTime(position, duration);
      playBtn.textContent = playing ? "⏸ Pause" : "▶ Play";
      isPlaying = playing;
    },
    (text) => {
      promptText.textContent = text;
    },
    currentScript,
  );
  scrubber.max = String(Math.round(engine.durationMs));

  playBtn.addEventListener("click", () => {
    if (isPlaying) {
      engine.pause();
      isPlaying = false;
    } else {
      engine.play();
      isPlaying = true;
    }
  });
  replayBtn.addEventListener("click", () => {
    engine.replay();
    isPlaying = true;
  });
  scriptPicker.addEventListener("change", () => {
    const next = SCRIPTS.find((s) => s.id === scriptPicker.value);
    if (!next) return;
    currentScript = next;
    engine.setScript(next);
    isPlaying = false;
  });
  scrubber.addEventListener("input", () => {
    engine.seek(Number(scrubber.value));
  });

  // Theme toggle (drives pillTheme:auto via documentElement dataset).
  let theme: "dark" | "light" = "dark";
  document.documentElement.dataset.theme = theme;
  themeBtn.addEventListener("click", () => {
    theme = theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = theme;
    stage.classList.toggle("light-pane", theme === "light");
    themeBtn.textContent = `◑ Theme: ${theme}`;
  });

  // --- RIGHT: appearance controls -----------------------------------------
  const ctrlCard = el("div", "lab-card");
  ctrlCard.append(el("h2", undefined, "Appearance"));

  const toolbar = el("div", "lab-toolbar");
  const copyBtn = el("button", "lab-btn", "⧉ Copy settings JSON");
  const resetBtn = el("button", "lab-btn", "↺ Reset to defaults");
  toolbar.append(copyBtn, resetBtn);
  ctrlCard.append(toolbar);

  // Re-rendered whenever a full reset happens.
  const fieldsHost = el("div");
  ctrlCard.append(fieldsHost);
  rightCol.append(ctrlCard);

  function applyLive(): void {
    engine.setAppearance(appearance);
  }

  function update<K extends keyof DictationAppearance>(
    key: K,
    value: DictationAppearance[K],
  ): void {
    // Immutable update, then coerce so out-of-range values are clamped exactly
    // as the real settings loader would clamp them.
    appearance = coerceAppearance({ ...appearance, [key]: value });
    applyLive();
  }

  function renderFields(): void {
    fieldsHost.textContent = "";
    for (const c of CONTROLS) {
      if (c.kind === "slider") {
        const field = el("div", "lab-field");
        const top = el("div", "lab-field-top");
        const label = el("label", undefined, c.label);
        const val = el("span", "val");
        top.append(label, val);
        const input = el("input");
        input.type = "range";
        input.min = String(c.min);
        input.max = String(c.max);
        input.step = String(c.step);
        const setVal = (n: number): void => {
          val.textContent = `${n}${c.unit}`;
        };
        const cur = asNumber(appearance[c.key]);
        input.value = String(cur);
        setVal(cur);
        input.addEventListener("input", () => {
          const n = Number(input.value);
          update(c.key, n as DictationAppearance[typeof c.key]);
          setVal(asNumber(appearance[c.key]));
        });
        field.append(top, input, el("div", "help", c.help));
        fieldsHost.append(field);
      } else if (c.kind === "check") {
        const field = el("div", "lab-field inline");
        const left = el("div");
        const input = el("input");
        input.type = "checkbox";
        input.checked = Boolean(appearance[c.key]);
        const label = el("label", undefined, ` ${c.label}`);
        const row = el("div", "lab-row");
        row.append(input, label);
        left.append(row, el("div", "help", c.help));
        input.addEventListener("change", () => {
          update(c.key, input.checked as DictationAppearance[typeof c.key]);
        });
        field.append(left);
        fieldsHost.append(field);
      } else {
        const field = el("div", "lab-field");
        const top = el("div", "lab-field-top");
        top.append(el("label", undefined, c.label));
        const select = el("select");
        for (const o of c.options) {
          const opt = el("option");
          opt.value = o;
          opt.textContent = o;
          select.append(opt);
        }
        select.value = String(appearance[c.key]);
        top.append(select);
        select.addEventListener("change", () => {
          update(c.key, select.value as DictationAppearance[typeof c.key]);
        });
        field.append(top, el("div", "help", c.help));
        fieldsHost.append(field);
      }
    }
  }
  renderFields();

  // --- Toolbar actions -----------------------------------------------------
  const toast = el("div", "lab-toast");
  document.body.append(toast);
  function showToast(msg: string): void {
    toast.textContent = msg;
    toast.classList.add("show");
    window.setTimeout(() => toast.classList.remove("show"), 1400);
  }

  copyBtn.addEventListener("click", () => {
    const json = JSON.stringify(appearance, null, 2);
    const done = (): void => showToast("Settings JSON copied");
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(json).then(done, () => fallbackCopy(json, done));
    } else {
      fallbackCopy(json, done);
    }
  });

  resetBtn.addEventListener("click", () => {
    appearance = coerceAppearance(DEFAULT_APPEARANCE);
    applyLive();
    renderFields();
    showToast("Reset to defaults");
  });
}

/** Clipboard fallback for non-secure contexts (execCommand). */
function fallbackCopy(text: string, done: () => void): void {
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.opacity = "0";
  document.body.append(ta);
  ta.select();
  try {
    document.execCommand("copy");
    done();
  } finally {
    ta.remove();
  }
}

boot();
