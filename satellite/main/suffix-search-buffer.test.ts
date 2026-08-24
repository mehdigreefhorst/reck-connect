import { describe, it, expect } from "vitest";
import {
  SuffixSearchBuffers,
  MAX_BUFFERED_MATCHES,
} from "./suffix-search-buffer";

describe("SuffixSearchBuffers", () => {
  // The bug this exists for: with the ripgrep backend a small tree
  // finishes in ~70ms, long before the popup's renderer bundle has
  // loaded and subscribed. Every match and the done event were emitted
  // into the void, leaving the picker on "Searching project tree…"
  // forever even though the search had succeeded.
  it("replays matches recorded before anyone subscribed", () => {
    const b = new SuffixSearchBuffers();
    b.start("s1");
    b.recordMatch("s1", "/a/x.ts");
    b.recordMatch("s1", "/b/x.ts");
    b.recordTerminal("s1", "done", 2, ["/root"]);

    const snap = b.snapshot("s1");
    expect(snap?.matches).toEqual(["/a/x.ts", "/b/x.ts"]);
    expect(snap?.terminal).toEqual({
      kind: "done",
      totalFound: 2,
      searchedRoots: ["/root"],
    });
  });

  it("reports an in-flight search with no terminal state yet", () => {
    const b = new SuffixSearchBuffers();
    b.start("s1");
    b.recordMatch("s1", "/a/x.ts");
    b.recordProgress("s1", 12);
    const snap = b.snapshot("s1");
    expect(snap?.terminal).toBeNull();
    expect(snap?.scannedDirs).toBe(12);
    expect(snap?.matches).toEqual(["/a/x.ts"]);
  });

  it("dedupes repeated paths, mirroring the renderer's own `seen` set", () => {
    const b = new SuffixSearchBuffers();
    b.start("s1");
    b.recordMatch("s1", "/a/x.ts");
    b.recordMatch("s1", "/a/x.ts");
    expect(b.snapshot("s1")?.matches).toEqual(["/a/x.ts"]);
  });

  it("returns null for an unknown search rather than inventing an empty one", () => {
    // An empty snapshot would read as "search ran, found nothing"; null
    // lets the caller leave the live UI alone.
    expect(new SuffixSearchBuffers().snapshot("nope")).toBeNull();
  });

  it("ignores records for a search that was never started", () => {
    const b = new SuffixSearchBuffers();
    b.recordMatch("ghost", "/a/x.ts");
    b.recordTerminal("ghost", "done", 1);
    expect(b.snapshot("ghost")).toBeNull();
  });

  it("caps buffered matches so a pathological search can't grow unbounded", () => {
    const b = new SuffixSearchBuffers();
    b.start("s1");
    for (let i = 0; i < MAX_BUFFERED_MATCHES + 50; i++) {
      b.recordMatch("s1", `/a/${i}.ts`);
    }
    const snap = b.snapshot("s1")!;
    expect(snap.matches.length).toBe(MAX_BUFFERED_MATCHES);
    // The count must stay truthful even though the list is clipped.
    expect(snap.foundCount).toBe(MAX_BUFFERED_MATCHES + 50);
    expect(snap.truncated).toBe(true);
  });

  it("release() frees the buffer so popups don't leak across searches", () => {
    const b = new SuffixSearchBuffers();
    b.start("s1");
    b.recordMatch("s1", "/a/x.ts");
    b.release("s1");
    expect(b.snapshot("s1")).toBeNull();
    expect(b.size).toBe(0);
  });

  it("keeps searches independent", () => {
    const b = new SuffixSearchBuffers();
    b.start("s1");
    b.start("s2");
    b.recordMatch("s1", "/a/x.ts");
    b.recordMatch("s2", "/b/y.ts");
    expect(b.snapshot("s1")?.matches).toEqual(["/a/x.ts"]);
    expect(b.snapshot("s2")?.matches).toEqual(["/b/y.ts"]);
  });
});
