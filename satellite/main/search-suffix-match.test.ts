import { describe, it, expect } from "vitest";
import { basenameGlob, matchesPathSuffix } from "./search-suffix-match";

describe("basenameGlob", () => {
  it("returns the file name of a bare or nested suffix", () => {
    expect(basenameGlob("robot-venture-training-data.md")).toBe(
      "robot-venture-training-data.md",
    );
    expect(basenameGlob("wiki/concepts/plan.md")).toBe("plan.md");
  });

  it("keeps spaces and dots, which are literal in a glob", () => {
    expect(basenameGlob("v1.2 release.md")).toBe("v1.2 release.md");
  });

  it("refuses names carrying glob metacharacters", () => {
    for (const s of ["a*.md", "a?.md", "a[1].md", "{a,b}.md", "a\\b.md", "!a.md"]) {
      expect(basenameGlob(s)).toBeNull();
    }
  });

  it("refuses an empty or directory-only suffix", () => {
    expect(basenameGlob("")).toBeNull();
    expect(basenameGlob("dir/")).toBeNull();
    expect(basenameGlob("..")).toBeNull();
  });
});

describe("matchesPathSuffix", () => {
  it("requires a segment boundary", () => {
    expect(matchesPathSuffix("/p/wiki/foo.md", "foo.md")).toBe(true);
    expect(matchesPathSuffix("/p/wiki/super_foo.md", "foo.md")).toBe(false);
  });
});
