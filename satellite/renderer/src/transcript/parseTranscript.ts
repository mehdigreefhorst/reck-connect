// Incremental parser for Claude Code session transcripts (JSONL).
//
// The daemon serves the transcript file in offset-addressed slices; this
// parser accepts those raw slices, carries any partial trailing line
// between pushes, and folds the lines into an ordered list of chat
// turns for the TranscriptView.
//
// The JSONL schema is NOT a public API, so the parser is tolerant by
// construction: only lines carrying a `message` with role user/assistant
// become turns; every other shape (custom-title, mode, system,
// attachment, file-history-snapshot, unknown future types, unparseable
// garbage) is skipped. Sidechain lines (subagent traffic) are skipped
// too.
//
// Turn grouping mirrors the conversation, not the wire: a REAL user
// message opens a "user" turn; everything after it until the next real
// user message — the assistant's text and tool_use lines, PLUS the
// tool_result lines (which Claude Code writes as role:"user"!) — folds
// into a single "assistant" turn. Without this, every tool result would
// render as a phantom "you" turn between Claude's actions.

export interface TranscriptQuestionOption {
  label: string;
  description?: string;
}

export interface TranscriptQuestion {
  question: string;
  header?: string;
  options: TranscriptQuestionOption[];
}

export type TranscriptBlock =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool_use"; name: string; input: string }
  | { kind: "tool_result"; text: string }
  | { kind: "command"; name: string }
  // A plan Claude presented via ExitPlanMode. `path` is the plan file
  // (⌘-clickable); `text` is the full markdown (shown collapsed).
  | { kind: "plan"; text: string; path?: string }
  // A question Claude asked via AskUserQuestion.
  | { kind: "question"; questions: TranscriptQuestion[] }
  // The user's approval of a plan (folded from the ExitPlanMode tool_result).
  | { kind: "plan_approved" }
  // An image carried in the transcript as bytes: a screenshot the user
  // pasted, or one a tool returned. `base64`/`mime` are validated at parse
  // time because the view builds a `data:` URI out of them. `pasteId` is the
  // N in the `[Image #N]` marker Claude Code writes into the message text.
  | {
      kind: "image";
      mime: string;
      base64: string;
      width?: number;
      height?: number;
      pasteId?: number;
    };

/** Prefix Claude Code writes into the ExitPlanMode tool_result on approval. */
const PLAN_APPROVED_PREFIX = "User has approved your plan";

export interface TranscriptTurn {
  role: "user" | "assistant";
  blocks: TranscriptBlock[];
  timestamp?: string;
}

export interface ParseUpdate {
  /** Index of the first turn that changed — re-render from here. */
  firstChanged: number;
}

export class TranscriptParser {
  readonly turns: TranscriptTurn[] = [];
  private remainder = "";
  /** The assistant turn currently accumulating (text + tool calls +
   *  tool results) until the next real user message. When set it is
   *  always the last element of `turns`. */
  private openAssistant: TranscriptTurn | null = null;

  /** Feed the next raw slice; returns which turns changed, if any. */
  push(chunk: string): ParseUpdate | null {
    const data = this.remainder + chunk;
    const lines = data.split("\n");
    // The final element is either "" (chunk ended on a newline) or a
    // partial line the next slice will complete.
    this.remainder = lines.pop() ?? "";
    let firstChanged: number | null = null;
    for (const line of lines) {
      const idx = this.consumeLine(line);
      if (idx !== null && (firstChanged === null || idx < firstChanged)) {
        firstChanged = idx;
      }
    }
    return firstChanged === null ? null : { firstChanged };
  }

  /** Returns the index of the turn this line created/changed, or null. */
  private consumeLine(line: string): number | null {
    const trimmed = line.trim();
    if (trimmed === "") return null;
    let obj: unknown;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      return null; // torn write or non-JSON noise — skip
    }
    if (typeof obj !== "object" || obj === null) return null;
    const rec = obj as Record<string, unknown>;
    if (rec.isSidechain === true) return null;
    const msg = rec.message;
    if (typeof msg !== "object" || msg === null) return null;
    const m = msg as Record<string, unknown>;
    const role = m.role;
    if (role !== "user" && role !== "assistant") return null;

    const blocks = blocksFromContent(m.content, rec.imagePasteIds);
    if (blocks.length === 0) return null;
    const timestamp = typeof rec.timestamp === "string" ? rec.timestamp : undefined;

    // A role:"user" line whose content is only tool output — tool_result(s),
    // or a plan approval derived from one — is NOT the user speaking. Fold it
    // into the open assistant turn instead of starting a user turn.
    //
    // Decided from the RAW content types, not from the derived blocks: a
    // tool_result carrying a screenshot derives an `image` block alongside its
    // text, and a paste with no caption derives nothing but `image` blocks —
    // so no predicate over the derived kinds can tell the two apart.
    const isToolResult = role === "user" && isToolResultContent(m.content);

    if (role === "user" && !isToolResult) {
      // A user message's string content is often not the human speaking: the
      // harness injects a caveat preamble, background task notifications,
      // system reminders, and slash-command wrappers. Sanitize string content
      // down to the real prose + a command chip; array content passes through.
      const userBlocks =
        typeof m.content === "string" ? sanitizeUserString(m.content) : blocks;
      // Pure harness noise (only wrappers, no prose/command) contributes no
      // turn AND is not a real user boundary, so leave the open assistant turn
      // intact — otherwise a mid-turn task-notification would split it.
      if (userBlocks.length === 0) return null;
      this.turns.push({ role: "user", blocks: userBlocks, ...(timestamp ? { timestamp } : {}) });
      this.openAssistant = null; // the next assistant activity starts fresh
      return this.turns.length - 1;
    }

    // Assistant text/tool_use, or a tool_result carrier → accumulate into
    // the current assistant turn (opening one if needed).
    if (this.openAssistant === null) {
      this.openAssistant = { role: "assistant", blocks: [], ...(timestamp ? { timestamp } : {}) };
      this.turns.push(this.openAssistant);
    }
    const turn = this.openAssistant; // always the last turn while open
    const before = turn.blocks.length;
    for (const b of blocks) {
      // Light dedup: skip a block identical to the one just appended
      // (guards against a re-written partial line) without needing ids.
      const last = turn.blocks[turn.blocks.length - 1];
      if (last && JSON.stringify(last) === JSON.stringify(b)) continue;
      turn.blocks.push(b);
    }
    if (turn.blocks.length === before) return null; // nothing new added
    return this.turns.length - 1;
  }
}

/** True when every item of an array content is a `tool_result` — i.e. the
 *  role:"user" line is a tool-output carrier, not the human speaking. */
function isToolResultContent(content: unknown): boolean {
  if (!Array.isArray(content) || content.length === 0) return false;
  return content.every(
    (item) =>
      typeof item === "object" &&
      item !== null &&
      (item as Record<string, unknown>).type === "tool_result",
  );
}

function blocksFromContent(content: unknown, pasteIds?: unknown): TranscriptBlock[] {
  if (typeof content === "string") {
    return content === "" ? [] : [{ kind: "text", text: content }];
  }
  if (!Array.isArray(content)) return [];
  const out: TranscriptBlock[] = [];
  for (const item of content) {
    if (typeof item !== "object" || item === null) continue;
    const b = item as Record<string, unknown>;
    switch (b.type) {
      case "text":
        if (typeof b.text === "string" && b.text !== "") {
          out.push({ kind: "text", text: b.text });
        }
        break;
      case "thinking":
        if (typeof b.thinking === "string" && b.thinking !== "") {
          out.push({ kind: "thinking", text: b.thinking });
        }
        break;
      case "tool_use": {
        const name = typeof b.name === "string" ? b.name : "tool";
        // Two tools get first-class rendering instead of the collapsed tool
        // group: plans (ExitPlanMode) and questions (AskUserQuestion).
        if (name === "ExitPlanMode") {
          out.push(planBlock(b.input));
          break;
        }
        if (name === "AskUserQuestion") {
          const q = questionBlock(b.input);
          if (q) {
            out.push(q);
            break;
          }
        }
        out.push({ kind: "tool_use", name, input: stringifyInput(b.input) });
        break;
      }
      case "image": {
        const img = imageBlock(b);
        if (img) out.push(img);
        break;
      }
      case "tool_result": {
        const text = toolResultText(b.content);
        // The plan-approval result is a slim "✓ Plan approved" marker, not a
        // block of boilerplate ("You can now start coding…").
        if (text.startsWith(PLAN_APPROVED_PREFIX)) {
          out.push({ kind: "plan_approved" });
          break;
        }
        if (text !== "") out.push({ kind: "tool_result", text });
        // A screenshot a tool returned (Playwright, computer-use, …) rides in
        // the result's content array. It renders inline rather than inside the
        // collapsed <pre> tool group — a picture in a <pre> is unreadable.
        for (const img of toolResultImages(b.content)) out.push(img);
        break;
      }
      default:
        break; // unknown block type — skip, stay tolerant
    }
  }
  return inlinePasteMarkers(withPasteIds(out, pasteIds));
}

/** `media_type` / `file.type` values we will build a `data:` URI from. The
 *  value comes from a file we do not control and lands inside a URL, so the
 *  shape is checked rather than trusted. */
const IMAGE_MIME_RE = /^image\/[a-z0-9][a-z0-9.+-]*$/i;
/** The base64 alphabet, and nothing else — no scheme breaks, no quotes. */
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : undefined;
}

function asString(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined;
}

/** A positive, finite integer, or undefined. Dimensions are layout hints; a
 *  garbage value must not become a `width` attribute. */
function asPositiveInt(v: unknown): number | undefined {
  return typeof v === "number" && Number.isInteger(v) && v > 0 ? v : undefined;
}

/**
 * An `{"type":"image"}` content block → an image block, or null when the
 * payload is missing or malformed. Two envelopes occur in real transcripts
 * and both are handled: `source: {media_type, data}` (what the API sees) and
 * `file: {type, base64, dimensions}` (what the tool-result writer emits).
 */
function imageBlock(item: Record<string, unknown>): TranscriptBlock | null {
  const source = asRecord(item.source);
  const file = asRecord(item.file);
  const mime = asString(source?.media_type) ?? asString(file?.type) ?? "";
  if (!IMAGE_MIME_RE.test(mime)) return null;
  // JSONL writers wrap long payloads; strip whitespace before validating so a
  // legitimately wrapped image is not discarded as malformed.
  const base64 = (asString(source?.data) ?? asString(file?.base64) ?? "").replace(/\s+/g, "");
  if (base64 === "" || !BASE64_RE.test(base64)) return null;
  const dims = asRecord(file?.dimensions);
  const width = asPositiveInt(dims?.displayWidth ?? dims?.originalWidth);
  const height = asPositiveInt(dims?.displayHeight ?? dims?.originalHeight);
  return {
    kind: "image",
    mime: mime.toLowerCase(),
    base64,
    ...(width !== undefined ? { width } : {}),
    ...(height !== undefined ? { height } : {}),
  };
}

/** Image blocks nested inside a tool_result's content array. */
function toolResultImages(content: unknown): TranscriptBlock[] {
  if (!Array.isArray(content)) return [];
  const out: TranscriptBlock[] = [];
  for (const part of content) {
    const p = asRecord(part);
    if (!p || p.type !== "image") continue;
    const img = imageBlock(p);
    if (img) out.push(img);
  }
  return out;
}

/**
 * Stamp the message's `imagePasteIds` onto its image blocks. Claude Code
 * writes one id per pasted image, in content order — so the i-th image block
 * is the i-th id. Ids are session-global, which is what makes an `[Image #N]`
 * marker resolvable to exactly one image.
 */
function withPasteIds(blocks: TranscriptBlock[], pasteIds: unknown): TranscriptBlock[] {
  if (!Array.isArray(pasteIds) || pasteIds.length === 0) return blocks;
  let seen = 0;
  return blocks.map((b) => {
    if (b.kind !== "image") return b;
    const id = asPositiveInt(pasteIds[seen]);
    seen += 1;
    return id === undefined ? b : { ...b, pasteId: id };
  });
}

/** The `[Image #N]` marker Claude Code writes into the message text. */
const PASTE_MARKER_RE = /\[Image #(\d+)\]/g;

/**
 * Substitute each `[Image #N]` marker with the image it names, splitting the
 * text around it. The bytes and the marker are both in the transcript, so
 * rendering the text verbatim next to the images shows the marker as noise —
 * and puts the images in content order rather than the order the sentence
 * mentions them. Images no marker claims keep their original position.
 */
function inlinePasteMarkers(blocks: TranscriptBlock[]): TranscriptBlock[] {
  const byId = new Map<number, TranscriptBlock>();
  for (const b of blocks) {
    if (b.kind === "image" && b.pasteId !== undefined && !byId.has(b.pasteId)) {
      byId.set(b.pasteId, b);
    }
  }
  if (byId.size === 0) return blocks;

  // Which ids the text actually claims — computed first, so an image block
  // that precedes its marker in the content array is still hoisted, not
  // emitted twice.
  const claimed = new Set<number>();
  for (const b of blocks) {
    if (b.kind !== "text") continue;
    for (const m of b.text.matchAll(PASTE_MARKER_RE)) {
      const id = Number(m[1]);
      if (byId.has(id)) claimed.add(id);
    }
  }
  if (claimed.size === 0) return blocks;

  const placed = new Set<number>();
  const out: TranscriptBlock[] = [];
  for (const b of blocks) {
    if (b.kind === "image") {
      if (b.pasteId === undefined || !claimed.has(b.pasteId)) out.push(b);
      continue; // a claimed image is emitted at its marker instead
    }
    if (b.kind !== "text") {
      out.push(b);
      continue;
    }
    let cursor = 0;
    const parts: TranscriptBlock[] = [];
    for (const m of b.text.matchAll(PASTE_MARKER_RE)) {
      const id = Number(m[1]);
      const img = byId.get(id);
      if (!img || placed.has(id)) continue; // repeated marker: leave it as text
      placed.add(id);
      const before = b.text.slice(cursor, m.index).trim();
      if (before !== "") parts.push({ kind: "text", text: before });
      parts.push(img);
      cursor = (m.index ?? 0) + m[0].length;
    }
    if (parts.length === 0) {
      out.push(b);
      continue;
    }
    const rest = b.text.slice(cursor).trim();
    if (rest !== "") parts.push({ kind: "text", text: rest });
    out.push(...parts);
  }
  return out;
}

// Harness-wrapper tags that Claude Code injects into "user" message strings.
// None of these are the human speaking; a slash command is user-initiated but
// belongs in a slim chip, not a prose bubble. Order matters only in that the
// command name is captured before the wrappers are stripped.
const NOISE_WRAPPERS = [
  "local-command-caveat",
  "system-reminder",
  "task-notification",
  "local-command-stdout",
  "command-stdout",
  "command-message",
  "command-args",
] as const;

/** Reduce a user string to its real content: an optional slash command (as a
 *  `command` block) plus whatever prose survives after the harness wrappers
 *  are removed. Returns [] when the line was pure noise. */
function sanitizeUserString(raw: string): TranscriptBlock[] {
  const nameMatch = raw.match(/<command-name>([\s\S]*?)<\/command-name>/);
  const command = nameMatch ? nameMatch[1].trim() : "";

  let text = stripWrapper(raw, "command-name");
  for (const tag of NOISE_WRAPPERS) text = stripWrapper(text, tag);
  text = text.trim();

  const out: TranscriptBlock[] = [];
  if (command) out.push({ kind: "command", name: command });
  if (text) out.push({ kind: "text", text });
  return out;
}

/** Remove every `<tag …>…</tag>` block; if a tag is left open (these preambles
 *  often run to end-of-message with no closing tag), remove from it to the end. */
function stripWrapper(s: string, tag: string): string {
  const closed = new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*?<\\/${tag}>`, "g");
  const openToEnd = new RegExp(`<${tag}(?:\\s[^>]*)?>[\\s\\S]*$`);
  return s.replace(closed, "").replace(openToEnd, "");
}

/** ExitPlanMode input → plan block: the markdown plan + its file path. */
function planBlock(input: unknown): TranscriptBlock {
  const rec = typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  const text = typeof rec.plan === "string" ? rec.plan : stringifyInput(input);
  const path =
    typeof rec.planFilePath === "string" && rec.planFilePath !== "" ? rec.planFilePath : undefined;
  return path ? { kind: "plan", text, path } : { kind: "plan", text };
}

/** AskUserQuestion input → question block, or null if it has no questions
 *  (fall back to a generic tool_use so nothing is silently dropped). */
function questionBlock(input: unknown): TranscriptBlock | null {
  if (typeof input !== "object" || input === null) return null;
  const rec = input as Record<string, unknown>;
  if (!Array.isArray(rec.questions)) return null;
  const questions: TranscriptQuestion[] = [];
  for (const q of rec.questions) {
    if (typeof q !== "object" || q === null) continue;
    const qr = q as Record<string, unknown>;
    const question = typeof qr.question === "string" ? qr.question : "";
    if (question === "") continue;
    const header = typeof qr.header === "string" ? qr.header : undefined;
    const options: TranscriptQuestionOption[] = [];
    if (Array.isArray(qr.options)) {
      for (const o of qr.options) {
        if (typeof o !== "object" || o === null) continue;
        const or = o as Record<string, unknown>;
        if (typeof or.label !== "string") continue;
        options.push(
          typeof or.description === "string"
            ? { label: or.label, description: or.description }
            : { label: or.label },
        );
      }
    }
    questions.push(header ? { question, header, options } : { question, options });
  }
  return questions.length > 0 ? { kind: "question", questions } : null;
}

function stringifyInput(input: unknown): string {
  try {
    return JSON.stringify(input, null, 2) ?? "";
  } catch {
    return String(input);
  }
}

function toolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (typeof part === "string") return part;
      if (typeof part === "object" && part !== null) {
        const p = part as Record<string, unknown>;
        if (p.type === "text" && typeof p.text === "string") return p.text;
      }
      return "";
    })
    .filter((s) => s !== "")
    .join("\n");
}
