// The generic tuning-row renderer behind BOTH dictation control groups —
// appearance (blur/timing/look) and endpointing (when an utterance is over).
// One implementation of a slider / checkbox / select row, parameterized by the
// settings object it edits, so a new group of knobs is a descriptor list and
// nothing else. All styling lives in styles.css under `.dict-ctrl-*`, themed
// by the host's `--app-*` CSS variables (the lab aliases them to its palette).
//
// Every knob carries a `help` string; each row exposes an ℹ️ info affordance
// whose hover/focus reveals it (plus a native `title` fallback), so no
// parameter is a mystery.

/** Keys of T whose value is assignable to V — e.g. every numeric knob. */
type KeysOfType<T, V> = { [K in keyof T]-?: T[K] extends V ? K : never }[keyof T];

export interface SubheadDesc {
  kind: "subhead";
  label: string;
}
export interface SliderDesc<T> {
  kind: "slider";
  key: KeysOfType<T, number>;
  label: string;
  help: string;
  min: number;
  max: number;
  step: number;
  unit: string;
}
export interface CheckDesc<T> {
  kind: "check";
  key: KeysOfType<T, boolean>;
  label: string;
  help: string;
}
export interface SelectDesc<T> {
  kind: "select";
  key: KeysOfType<T, string>;
  label: string;
  help: string;
  options: readonly string[];
}
export type ControlDesc<T> = SubheadDesc | SliderDesc<T> | CheckDesc<T> | SelectDesc<T>;

export interface ControlsHandle<T> {
  /** The current (coerced) value. */
  getValue(): T;
  /** Replace the value and re-sync every control's DOM (used by Reset). */
  setAll(next: T): void;
}

export interface RenderControlRowsOpts<T> {
  descs: readonly ControlDesc<T>[];
  current: T;
  /**
   * Normalizes a raw value — the same coercer that guards the persisted
   * config. Every emit runs through it, which is what lets the select rows
   * assign a raw string without knowing the key's literal union.
   */
  coerce: (raw: unknown) => T;
  /** Fallback for a slider whose input somehow isn't a finite number. */
  defaults: T;
  /** Called on EVERY change with the full next (coerced) value. */
  onChange: (next: T) => void;
}

/** Decimals to display for a slider, derived from its step (0.001→3, 0.1→1, 1→0). */
function decimalsFor(step: number): number {
  return step < 1 ? Math.max(1, Math.ceil(-Math.log10(step))) : 0;
}

/** Build the ℹ️ info affordance whose hover/focus shows `help`. */
function makeInfo(help: string): HTMLElement {
  const info = document.createElement("span");
  info.className = "dict-ctrl-info";
  info.tabIndex = 0;
  info.setAttribute("role", "img");
  info.setAttribute("aria-label", help);
  info.title = help; // native fallback
  info.textContent = "ⓘ";
  const tip = document.createElement("span");
  tip.className = "dict-ctrl-tip";
  tip.textContent = help;
  info.appendChild(tip);
  return info;
}

/**
 * Render `descs` into `host`. Returns a handle to read the value and to
 * re-sync the DOM after an external change (Reset).
 */
export function renderControlRows<T extends object>(
  host: HTMLElement,
  opts: RenderControlRowsOpts<T>,
): ControlsHandle<T> {
  let state: T = opts.coerce(opts.current);
  const syncers: (() => void)[] = [];

  const emit = (): void => {
    state = opts.coerce(state);
    opts.onChange(state);
  };

  // One assignment helper for all three row kinds. The cast is the price of
  // being generic over the settings object; `coerce` in emit() is what makes
  // it safe — an out-of-range or misspelled value never survives the round
  // trip into the persisted config.
  const set = (key: keyof T, value: unknown): void => {
    state = { ...state, [key]: value } as T;
  };

  const labelWithInfo = (text: string, help: string): HTMLElement => {
    const label = document.createElement("span");
    label.className = "dict-ctrl-label";
    label.append(document.createTextNode(text), makeInfo(help));
    return label;
  };

  const addSlider = (spec: SliderDesc<T>): void => {
    const row = document.createElement("div");
    row.className = "dict-ctrl-row dict-ctrl-slider";

    const labelRow = document.createElement("div");
    labelRow.className = "dict-ctrl-labelrow";
    const readout = document.createElement("span");
    readout.className = "dict-ctrl-readout";
    labelRow.append(labelWithInfo(spec.label, spec.help), readout);

    const range = document.createElement("input");
    range.type = "range";
    range.className = "dict-ctrl-range";
    range.min = String(spec.min);
    range.max = String(spec.max);
    range.step = String(spec.step);

    const decimals = decimalsFor(spec.step);
    const fmt = (n: number): string =>
      `${decimals > 0 ? n.toFixed(decimals) : String(Math.round(n))}${spec.unit}`;

    const sync = (): void => {
      const v = state[spec.key] as number;
      range.value = String(v);
      readout.textContent = fmt(v);
    };
    sync();
    syncers.push(sync);

    range.addEventListener("input", () => {
      const raw = Number(range.value);
      const v = Number.isFinite(raw) ? raw : (opts.defaults[spec.key] as number);
      set(spec.key, v);
      readout.textContent = fmt(v);
      emit();
    });

    row.append(labelRow, range);
    host.appendChild(row);
  };

  const addCheck = (spec: CheckDesc<T>): void => {
    const row = document.createElement("label");
    row.className = "dict-ctrl-row dict-ctrl-check";

    const check = document.createElement("input");
    check.type = "checkbox";
    check.className = "dict-ctrl-checkbox";

    const sync = (): void => {
      check.checked = state[spec.key] as boolean;
    };
    sync();
    syncers.push(sync);

    check.addEventListener("change", () => {
      set(spec.key, check.checked);
      emit();
    });

    row.append(labelWithInfo(spec.label, spec.help), check);
    host.appendChild(row);
  };

  const addSelect = (spec: SelectDesc<T>): void => {
    const row = document.createElement("label");
    row.className = "dict-ctrl-row dict-ctrl-select";

    const select = document.createElement("select");
    select.className = "dict-ctrl-selectbox";
    for (const opt of spec.options) {
      const o = document.createElement("option");
      o.value = opt;
      o.textContent = opt;
      select.appendChild(o);
    }

    const sync = (): void => {
      select.value = String(state[spec.key]);
    };
    sync();
    syncers.push(sync);

    select.addEventListener("change", () => {
      set(spec.key, select.value);
      emit();
      sync(); // a value the coercer rejected snaps back to what was stored
    });

    row.append(labelWithInfo(spec.label, spec.help), select);
    host.appendChild(row);
  };

  const addSubhead = (spec: SubheadDesc): void => {
    const h = document.createElement("div");
    h.className = "dict-ctrl-subhead";
    h.textContent = spec.label;
    host.appendChild(h);
  };

  for (const desc of opts.descs) {
    switch (desc.kind) {
      case "subhead":
        addSubhead(desc);
        break;
      case "slider":
        addSlider(desc);
        break;
      case "check":
        addCheck(desc);
        break;
      case "select":
        addSelect(desc);
        break;
    }
  }

  return {
    getValue: () => state,
    setAll: (next) => {
      state = opts.coerce(next);
      for (const sync of syncers) sync();
    },
  };
}
