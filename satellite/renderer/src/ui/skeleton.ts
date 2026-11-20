// Skeleton placeholder: shimmering bars that stand in for content that is
// still loading (issue #182). One component for every surface, so a list
// that is loading looks the same wherever it appears.
//
// Use it when the wait is long enough to notice and the shape of what is
// coming is known (a list of rows, a run of chat turns). It replaces the
// "nothing, then everything pops in" jump with a layout that is already
// roughly the right size. Styles live in styles.css under `.skeleton`;
// the shimmer is disabled under `prefers-reduced-motion`.

export type SkeletonVariant = "list" | "turns";

export interface SkeletonOptions {
  /** How many placeholder rows to draw. Clamped to 1..20. */
  rows: number;
  /** What is loading, for assistive tech — e.g. "Loading sessions". */
  label: string;
  /**
   * Layout flavour. "list": one row = a wide bar plus a short trailing one
   * (a name and its metadata). "turns": one row = a short heading bar over
   * a few text lines (a chat turn). Default "list".
   */
  variant?: SkeletonVariant;
}

const MIN_ROWS = 1;
const MAX_ROWS = 20;

// Fixed width cycles rather than Math.random(): a skeleton that re-rolls its
// widths on every repaint shimmers in a second, unintended way, and tests
// can't pin it. The values are coprime-ish in length so list and text
// patterns don't line up into visible columns.
const LIST_MAIN_WIDTHS = ["62%", "48%", "71%", "39%", "56%"];
const LIST_META_WIDTHS = ["3.5rem", "4.5rem", "3rem"];
const TURN_LINE_WIDTHS = ["94%", "88%", "61%", "97%", "83%", "42%", "90%"];
const TURN_LINES_PER_ROW = 3;

function bar(width: string, extraClass = ""): HTMLElement {
  const el = document.createElement("span");
  el.className = extraClass ? `skeleton-bar ${extraClass}` : "skeleton-bar";
  el.style.width = width;
  return el;
}

function listRow(index: number): HTMLElement[] {
  return [
    bar(LIST_MAIN_WIDTHS[index % LIST_MAIN_WIDTHS.length]),
    bar(LIST_META_WIDTHS[index % LIST_META_WIDTHS.length], "skeleton-bar--meta"),
  ];
}

function turnRow(index: number): HTMLElement[] {
  const lines = Array.from({ length: TURN_LINES_PER_ROW }, (_, line) =>
    bar(TURN_LINE_WIDTHS[(index * TURN_LINES_PER_ROW + line) % TURN_LINE_WIDTHS.length]),
  );
  return [bar("4.5rem", "skeleton-bar--heading"), ...lines];
}

/**
 * Build a skeleton block. The caller inserts it where the content will go
 * and removes it (`el.remove()`) when the content arrives.
 */
export function createSkeleton(opts: SkeletonOptions): HTMLElement {
  const variant = opts.variant ?? "list";
  const rows = Math.min(MAX_ROWS, Math.max(MIN_ROWS, Math.floor(opts.rows) || MIN_ROWS));

  const root = document.createElement("div");
  root.className = `skeleton skeleton--${variant}`;
  // A polite live region: screen readers announce the label once, and the
  // decorative bars themselves are hidden from them.
  root.setAttribute("role", "status");
  root.setAttribute("aria-busy", "true");
  root.setAttribute("aria-label", opts.label);

  for (let i = 0; i < rows; i++) {
    const row = document.createElement("div");
    row.className = "skeleton-row";
    row.setAttribute("aria-hidden", "true");
    row.append(...(variant === "turns" ? turnRow(i) : listRow(i)));
    root.appendChild(row);
  }
  return root;
}
