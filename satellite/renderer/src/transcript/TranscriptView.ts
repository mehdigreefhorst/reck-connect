// `TranscriptView` — the "History" overlay for a Claude pane. Renders
// the parsed session transcript in a DOM scroll container mounted over
// the pane's terminal (the xterm keeps running underneath), which is
// what makes the scrollbar *exact*: the browser lays the turns out at
// the pane's real width, so scrollHeight/clientHeight are true at any
// size and the truthful OverlayScrollbar mode (thumb, drag-to-seek,
// resize) works unchanged — no estimation anywhere. Shell mirrors the
// file viewer's buildShell: positioned root → header + scrollable body.
//
// Rendering is incremental: one container element per turn, and
// `render(turns, firstChanged)` only (re)paints from `firstChanged`,
// so a live tail appends without re-rendering the whole chat. Assistant
// text goes through the shared MarkdownRenderer (sanitized); user text
// is rendered as plain text (people type text, not markup). Thinking /
// tool_use / tool_result blocks fold into collapsed <details>.

import {
  createMarkdownRenderer,
  wrapFreeTextPaths,
  type MarkdownRenderer,
} from "../viewer/MarkdownRenderer";
import { createOverlayScrollbar, type OverlayScrollbar } from "../search/OverlayScrollbar";
import { domScrollSurface } from "../search/scrollSurfaces";
import type { TranscriptTurn, TranscriptBlock } from "./parseTranscript";

export interface TranscriptViewOptions {
  /** Positioned pane wrapper the overlay covers. */
  host: HTMLElement;
  /** Header label — typically the pane title. */
  title: string;
  /** Session UUID — shown (shortened) in the start-of-session divider. */
  sessionId?: string;
  /** Invoked on the close button or Escape. Owner unmounts via dispose(). */
  onClose(): void;
}

/** Visible overlay state. The overlay must never look silently dead:
 *  loading/empty/error render a banner under the header; `live` hides it. */
export type TranscriptStatus =
  | { kind: "loading" | "empty" | "error"; message: string }
  | { kind: "live" };

export interface TranscriptViewHandle {
  /** `.transcript-view` — the positioned overlay root. */
  root: HTMLElement;
  /** `.transcript-body` — the scroll container (search adapters target this). */
  body: HTMLElement;
  /** (Re)render turns from `firstChanged` onward. */
  render(turns: readonly TranscriptTurn[], firstChanged: number): void;
  /** Show/replace/hide the status banner. */
  setStatus(status: TranscriptStatus): void;
  /** Route search-match fractions to the overlay scrollbar's ticks. */
  setMatches(fractions: readonly number[]): void;
  dispose(): void;
}

/** How close to the bottom (px) still counts as "following the tail". */
const FOLLOW_THRESHOLD_PX = 40;

export function createTranscriptView(opts: TranscriptViewOptions): TranscriptViewHandle {
  // `reck-native-scroll` opts the overlay out of the pane wrapper's
  // TUI wheel→PgUp/PgDn remap (OverlayScrollbar capture listener) so
  // the transcript body scrolls natively.
  const root = document.createElement("div");
  root.className = "transcript-view reck-native-scroll";

  const header = document.createElement("div");
  header.className = "transcript-header";
  const title = document.createElement("div");
  title.className = "transcript-title";
  title.textContent = opts.title;
  const close = document.createElement("button");
  close.type = "button";
  close.className = "transcript-close";
  close.title = "Back to live terminal (Esc)";
  close.textContent = "✕";
  close.addEventListener("click", () => opts.onClose());
  header.appendChild(title);
  header.appendChild(close);

  const status = document.createElement("div");
  status.className = "transcript-status transcript-status--hidden";

  const body = document.createElement("div");
  body.className = "transcript-body";

  // The start-of-session divider marks where the conversation opens (Claude
  // Code transcripts have no visible "chat begins here" boundary of their
  // own). It's the first body child; hidden until the first turn renders so a
  // loading/empty overlay doesn't claim a session started.
  const sessionStart = document.createElement("div");
  sessionStart.className = "transcript-session-start transcript-session-start--hidden";
  {
    const label = document.createElement("span");
    label.className = "transcript-session-start-label";
    label.textContent = "Start of session";
    sessionStart.appendChild(label);
    if (opts.sessionId) {
      const idEl = document.createElement("span");
      idEl.className = "transcript-session-start-id";
      idEl.textContent = opts.sessionId.slice(0, 8);
      sessionStart.appendChild(idEl);
    }
  }
  body.appendChild(sessionStart);

  root.appendChild(header);
  root.appendChild(status);
  root.appendChild(body);
  opts.host.appendChild(root);

  const md: MarkdownRenderer = createMarkdownRenderer();
  const scrollbar: OverlayScrollbar = createOverlayScrollbar({
    host: root,
    surface: domScrollSurface(body),
  });

  // One element per turn, index-aligned with the parser's turn list.
  const turnEls: HTMLElement[] = [];
  let disposed = false;

  function onKeyDown(e: KeyboardEvent): void {
    if (e.key !== "Escape") return;
    e.preventDefault();
    opts.onClose();
  }
  document.addEventListener("keydown", onKeyDown);

  function textBlockEl(role: TranscriptTurn["role"], text: string): HTMLElement {
    if (role === "assistant") {
      const el = document.createElement("div");
      el.className = "transcript-md";
      md.mount(el, md.render(text));
      return el;
    }
    const el = document.createElement("div");
    el.className = "transcript-text";
    el.textContent = text;
    // People type file paths in prose ("look at services/x.py"). Wrap them in
    // the same `a.reck-internal-link` anchors the markdown renderer emits, so
    // the transcript's single delegated Cmd-click handler opens them too.
    wrapFreeTextPaths(el);
    return el;
  }

  // A slash command (/clear, /model, …) the user ran — a slim chip, not a
  // prose bubble. Distinct from tool activity, so it renders inline.
  function commandPillEl(name: string): HTMLElement {
    const el = document.createElement("div");
    el.className = "transcript-command";
    el.textContent = `⌘ ${name}`;
    return el;
  }

  // One row inside the collapsed tool group: a labelled <pre> for a
  // thinking / tool_use / tool_result block.
  function toolRow(className: string, label: string, text: string): HTMLElement {
    const row = document.createElement("div");
    row.className = className;
    const head = document.createElement("div");
    head.className = "transcript-tool-label";
    head.textContent = label;
    const pre = document.createElement("pre");
    pre.textContent = text;
    row.appendChild(head);
    row.appendChild(pre);
    return row;
  }

  function toolGroup(blocks: TranscriptBlock[]): HTMLElement {
    const toolCount = blocks.filter((b) => b.kind === "tool_use").length;
    const summaryText =
      toolCount > 0
        ? `🔧 ${toolCount} tool ${toolCount === 1 ? "call" : "calls"}`
        : "Thinking";
    const details = document.createElement("details");
    details.className = "transcript-tools";
    const summary = document.createElement("summary");
    summary.textContent = summaryText;
    details.appendChild(summary);
    for (const b of blocks) {
      if (b.kind === "thinking") details.appendChild(toolRow("transcript-thinking", "Thinking", b.text));
      else if (b.kind === "tool_use") details.appendChild(toolRow("transcript-tool", `Tool: ${b.name}`, b.input));
      else if (b.kind === "tool_result") details.appendChild(toolRow("transcript-tool-result", "Result", b.text));
    }
    return details;
  }

  function renderTurn(el: HTMLElement, turn: TranscriptTurn): void {
    el.className = `transcript-turn transcript-turn--${turn.role}`;
    el.replaceChildren();
    const label = document.createElement("div");
    label.className = "transcript-role";
    label.textContent = turn.role === "user" ? "You" : "Claude";
    el.appendChild(label);

    // Text Claude/you actually said renders inline, in order. All the
    // under-the-hood blocks (thinking / tool_use / tool_result) collapse
    // into a single expandable group after the text, so a turn reads as
    // prose with its tool calls tucked away.
    const toolBlocks: TranscriptBlock[] = [];
    for (const block of turn.blocks) {
      if (block.kind === "text") {
        el.appendChild(textBlockEl(turn.role, block.text));
      } else if (block.kind === "command") {
        el.appendChild(commandPillEl(block.name));
      } else {
        toolBlocks.push(block);
      }
    }
    if (toolBlocks.length > 0) {
      el.appendChild(toolGroup(toolBlocks));
    }
  }

  function render(turns: readonly TranscriptTurn[], firstChanged: number): void {
    if (disposed) return;
    // Capture follow intent BEFORE mutating: were we reading the tail?
    const wasNearBottom =
      body.scrollTop + body.clientHeight >= body.scrollHeight - FOLLOW_THRESHOLD_PX;
    for (let i = firstChanged; i < turns.length; i++) {
      let el = turnEls[i];
      if (!el) {
        el = document.createElement("div");
        turnEls[i] = el;
        body.appendChild(el);
      }
      renderTurn(el, turns[i]);
    }
    while (turnEls.length > turns.length) {
      turnEls.pop()?.remove();
    }
    // Reveal the "Start of session" divider once the conversation has content.
    sessionStart.classList.toggle("transcript-session-start--hidden", turns.length === 0);
    scrollbar.update();
    if (wasNearBottom) {
      body.scrollTop = body.scrollHeight;
    }
  }

  function setStatus(s: TranscriptStatus): void {
    if (s.kind === "live") {
      status.classList.add("transcript-status--hidden");
      status.classList.remove("transcript-status--error");
      status.textContent = "";
      return;
    }
    status.textContent = s.message;
    status.classList.remove("transcript-status--hidden");
    status.classList.toggle("transcript-status--error", s.kind === "error");
  }

  return {
    root,
    body,
    render,
    setStatus,
    setMatches: (fractions) => scrollbar.setMatches(fractions),
    dispose() {
      if (disposed) return;
      disposed = true;
      document.removeEventListener("keydown", onKeyDown);
      scrollbar.dispose();
      md.dispose();
      root.remove();
    },
  };
}
