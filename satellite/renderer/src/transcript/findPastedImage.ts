// Resolves an `[Image #N]` terminal placeholder to the bytes behind it.
//
// The CLI prints `[Image #N]` into the terminal when you paste a screenshot;
// the pixels never reach the terminal and never touch disk (`~/.claude/
// paste-cache/` holds text pastes only). The session JSONL is the only copy,
// and Claude Code writes an `imagePasteIds` array on the user message that
// maps each id to one of its image content blocks.
//
// Ids are session-global and monotonic, so N alone identifies exactly one
// image. Resolution therefore never counts placeholder occurrences in
// scrollback — which is what would have desynchronised on truncation,
// `/clear`, a resumed session, or compaction, and silently opened the WRONG
// screenshot.
//
// The scan is incremental because a transcript arrives in offset-addressed
// slices and can run to hundreds of megabytes: lines are matched as they
// arrive and the walk stops at the first hit, so nothing accumulates.

import { imagesFromLine, type TranscriptImageBlock } from "./parseTranscript";

export interface PastedImageScanner {
  /** Feed the next raw slice; returns the image as soon as it is seen. */
  push(chunk: string): TranscriptImageBlock | null;
  /** Match the trailing partial line once the file ends. */
  end(): TranscriptImageBlock | null;
}

export function createPastedImageScanner(pasteId: number): PastedImageScanner {
  let remainder = "";
  let found: TranscriptImageBlock | null = null;

  const scan = (line: string): TranscriptImageBlock | null => {
    for (const img of imagesFromLine(line)) {
      if (img.pasteId === pasteId) return img;
    }
    return null;
  };

  return {
    push(chunk: string): TranscriptImageBlock | null {
      if (found) return found;
      const data = remainder + chunk;
      const lines = data.split("\n");
      // The last element is either "" (the slice ended on a newline) or a
      // partial line the next slice completes.
      remainder = lines.pop() ?? "";
      for (const line of lines) {
        const hit = scan(line);
        if (hit) {
          found = hit;
          return found;
        }
      }
      return null;
    },
    end(): TranscriptImageBlock | null {
      if (found) return found;
      const tail = remainder;
      remainder = "";
      found = scan(tail);
      return found;
    },
  };
}

/** One-shot convenience over {@link createPastedImageScanner}. */
export function findPastedImage(jsonl: string, pasteId: number): TranscriptImageBlock | null {
  const scanner = createPastedImageScanner(pasteId);
  return scanner.push(jsonl) ?? scanner.end();
}

export interface TranscriptSlice {
  chunk: string;
  nextOffset: number;
  hasMore: boolean;
}

export interface FetchPastedImageDeps {
  /** One transcript slice from `offset`. Mirrors `api.getTranscript`. */
  fetchSlice(offset: number): Promise<TranscriptSlice>;
  /**
   * Upper bound on bytes walked before giving up, so a click on a very long
   * transcript cannot pin the renderer indefinitely. Exceeding it reports
   * "not found" — the caller must say so rather than show another image.
   */
  maxBytes?: number;
}

/** How far we will walk a transcript looking for one id. Well past any
 *  session observed locally, and bounded so a click always terminates. */
export const DEFAULT_MAX_SCAN_BYTES = 256 * 1024 * 1024;

/**
 * Walk a transcript from byte 0 until the image is found or the file ends.
 *
 * Returns null when the id is not in this session — a placeholder from a
 * session whose JSONL the daemon cannot serve, or scrollback that outlived
 * its transcript. The caller must degrade visibly on null; opening a
 * different image would be worse than opening none.
 */
export async function fetchPastedImage(
  pasteId: number,
  deps: FetchPastedImageDeps,
): Promise<TranscriptImageBlock | null> {
  const limit = deps.maxBytes ?? DEFAULT_MAX_SCAN_BYTES;
  const scanner = createPastedImageScanner(pasteId);
  let offset = 0;
  for (;;) {
    const slice = await deps.fetchSlice(offset);
    const hit = scanner.push(slice.chunk);
    if (hit) return hit;
    // Advance by the server's byte offset, never by chunk.length: the chunk
    // is decoded text and multi-byte characters would drift the cursor.
    if (!slice.hasMore || slice.nextOffset <= offset) break;
    offset = slice.nextOffset;
    if (offset >= limit) return null;
  }
  return scanner.end();
}
