// Replay buffer for the streaming suffix search.
//
// WHY THIS EXISTS
//
// `file:openInViewer` creates the picker popup and then immediately starts
// the search, forwarding `onMatch` / `onProgress` / `onDone` to that
// window's webContents. Those sends are fire-and-forget: nothing queues
// them, and a renderer that has not yet executed its bundle simply never
// receives them.
//
// With the ripgrep backend a small or medium project finishes in tens of
// milliseconds — far sooner than the popup can load its bundle and call
// `suffixSearch.onMatch(...)`. Every event was therefore emitted into the
// void, and the picker sat on "Searching project tree…" forever for a
// search that had already succeeded. The slower readdir walker used to
// hide this by finishing late enough that the subscription won the race.
//
// So main records everything it emits, and the popup asks for the
// backlog once its listeners are installed. The race stops mattering
// rather than being made narrower.

/** Terminal state of a search, once it has one. */
export interface SuffixSearchTerminal {
  kind: "done" | "cancelled";
  totalFound: number;
  searchedRoots?: string[];
}

export interface SuffixSearchSnapshot {
  matches: string[];
  scannedDirs: number;
  /** True number of matches seen, even when `matches` was clipped. */
  foundCount: number;
  /** True when `matches` is shorter than `foundCount`. */
  truncated: boolean;
  terminal: SuffixSearchTerminal | null;
}

/**
 * Upper bound on replayed paths. The picker is a human-scale list — nobody
 * scrolls 5000 candidates — and an unbounded array here would let one
 * pathological suffix (`.ts` against a monorepo) pin main's heap until the
 * popup closes. The count stays truthful when the list is clipped.
 */
export const MAX_BUFFERED_MATCHES = 500;

interface Entry {
  matches: string[];
  seen: Set<string>;
  scannedDirs: number;
  foundCount: number;
  terminal: SuffixSearchTerminal | null;
}

export class SuffixSearchBuffers {
  private readonly entries = new Map<string, Entry>();

  get size(): number {
    return this.entries.size;
  }

  /** Begin buffering for `searchId`. Records before this are ignored. */
  start(searchId: string): void {
    this.entries.set(searchId, {
      matches: [],
      seen: new Set(),
      scannedDirs: 0,
      foundCount: 0,
      terminal: null,
    });
  }

  recordMatch(searchId: string, matchedPath: string): void {
    const e = this.entries.get(searchId);
    if (!e || e.seen.has(matchedPath)) return;
    e.seen.add(matchedPath);
    e.foundCount += 1;
    if (e.matches.length < MAX_BUFFERED_MATCHES) e.matches.push(matchedPath);
  }

  recordProgress(searchId: string, scannedDirs: number): void {
    const e = this.entries.get(searchId);
    if (!e) return;
    e.scannedDirs = scannedDirs;
  }

  recordTerminal(
    searchId: string,
    kind: SuffixSearchTerminal["kind"],
    totalFound: number,
    searchedRoots?: string[],
  ): void {
    const e = this.entries.get(searchId);
    if (!e) return;
    e.terminal = { kind, totalFound, ...(searchedRoots ? { searchedRoots } : {}) };
  }

  /**
   * The backlog for `searchId`, or null when nothing is buffered.
   *
   * Null rather than an empty snapshot on purpose: an empty one is
   * indistinguishable from "the search ran and found nothing", which would
   * make a late replay wipe a picker that is streaming correctly.
   */
  snapshot(searchId: string): SuffixSearchSnapshot | null {
    const e = this.entries.get(searchId);
    if (!e) return null;
    return {
      matches: [...e.matches],
      scannedDirs: e.scannedDirs,
      foundCount: e.foundCount,
      truncated: e.foundCount > e.matches.length,
      terminal: e.terminal ? { ...e.terminal } : null,
    };
  }

  release(searchId: string): void {
    this.entries.delete(searchId);
  }
}
