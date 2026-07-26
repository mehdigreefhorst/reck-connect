// A two-position switch: two labels side by side with a thumb that slides
// between them. ONE component, used for every such control — currently the
// polling on/off and the seconds/minutes unit in the quota polling dialog
// (usage-poll-dialog.ts). See reuse-shared-components.
//
// Not a checkbox: both states are named. "Off / On" and "sec / min" are
// both choices between two labelled options, and a bare checkbox only
// names one of them, leaving the other to be inferred from the absence of
// a tick. Radio semantics say what this actually is.

export interface SlidingSwitchOption<T extends string> {
  value: T;
  label: string;
}

export interface SlidingSwitchOpts<T extends string> {
  /** Caption above the track. Rendered in the dialog's field voice. */
  label: string;
  /** Exactly two, left then right. */
  options: [SlidingSwitchOption<T>, SlidingSwitchOption<T>];
  value: T;
  /** Fired only on an actual change, never on re-selecting the current. */
  onChange: (value: T) => void;
  /** Accessible name for the group, when the visible label isn't enough. */
  ariaLabel?: string;
}

export interface SlidingSwitchHandle<T extends string> {
  /** Root element — append this. */
  el: HTMLElement;
  value(): T;
  /** Sets the position without firing onChange. */
  set(value: T): void;
  setDisabled(disabled: boolean): void;
}

export function createSlidingSwitch<T extends string>(
  opts: SlidingSwitchOpts<T>,
): SlidingSwitchHandle<T> {
  const [left, right] = opts.options;
  let current: T = opts.value;
  let disabled = false;

  const el = document.createElement("div");
  el.className = "slide-switch-field";

  // An empty label means the switch sits inline under someone else's
  // caption; don't reserve a line for nothing.
  if (opts.label !== "") {
    const caption = document.createElement("span");
    caption.className = "slide-switch-label";
    caption.textContent = opts.label;
    el.appendChild(caption);
  }

  const track = document.createElement("div");
  track.className = "slide-switch";
  track.setAttribute("role", "radiogroup");
  track.setAttribute("aria-label", opts.ariaLabel ?? opts.label);

  // The thumb is first in the DOM and sits behind the labels, so the
  // selected label keeps its own colour instead of being covered.
  const thumb = document.createElement("span");
  thumb.className = "slide-switch-thumb";
  thumb.setAttribute("aria-hidden", "true");
  track.appendChild(thumb);

  const buttons = opts.options.map((opt) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "slide-switch-opt";
    b.dataset.value = opt.value;
    b.textContent = opt.label;
    b.setAttribute("role", "radio");
    track.appendChild(b);
    return b;
  });

  function paint(): void {
    track.dataset.value = current;
    // The thumb covers half the track, so the right option is one full
    // thumb-width across.
    thumb.style.transform = current === right.value ? "translateX(100%)" : "translateX(0)";
    for (const b of buttons) {
      const on = b.dataset.value === current;
      b.classList.toggle("on", on);
      b.setAttribute("aria-checked", String(on));
      // Roving tabindex: the group is one tab stop, arrows move within it.
      b.tabIndex = disabled ? -1 : on ? 0 : -1;
      b.disabled = disabled;
    }
  }

  function select(next: T, notify: boolean): void {
    if (disabled || next === current) return;
    current = next;
    paint();
    if (notify) opts.onChange(current);
  }

  for (const b of buttons) {
    b.addEventListener("click", () => select(b.dataset.value as T, true));
  }

  track.addEventListener("keydown", (e: KeyboardEvent) => {
    if (disabled) return;
    let next: T | null = null;
    if (e.key === "ArrowLeft" || e.key === "ArrowUp") next = left.value;
    else if (e.key === "ArrowRight" || e.key === "ArrowDown") next = right.value;
    else if (e.key === " " || e.key === "Enter") {
      // Toggle, which is what both keys mean on a two-position control.
      next = current === left.value ? right.value : left.value;
    }
    if (next === null) return;
    e.preventDefault();
    select(next, true);
    buttons.find((b) => b.dataset.value === next)?.focus();
  });

  el.appendChild(track);
  paint();

  return {
    el,
    value: () => current,
    set: (value: T) => select(value, false),
    setDisabled: (next: boolean) => {
      disabled = next;
      el.classList.toggle("is-disabled", next);
      paint();
    },
  };
}
