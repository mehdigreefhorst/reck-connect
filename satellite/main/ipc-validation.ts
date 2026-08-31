// Pure, side-effect-free validators used by the main-process IPC handlers.
//
// These helpers exist as a separate module so they can be unit-tested without
// pulling in Electron. Keep this file free of `electron`, `fs`, `child_process`
// etc. imports — anything that needs I/O should happen in the caller and pass
// the stat result in (see `validateRsyncLocalPath` for the pattern).

import path from "node:path";

// --- shell:openPath path-traversal guard -------------------------------------

/**
 * Resolve `slug` against `mountPoint` and return the absolute path only if it
 * stays strictly inside `mountPoint`. Returns `null` for any attempt to escape
 * (`../../Applications`, absolute paths, symlink-free traversal via `.`), so
 * the caller can reject without trying to interpret why.
 *
 * This is intentionally stricter than the rsync slug regex: it accepts any
 * non-traversing string so callers can still use it for slugs that contain
 * uppercase or unusual characters that the rsync pipeline rejects. If the
 * caller wants the tighter format, they should validate the slug shape
 * separately before calling this.
 */
export function resolveInsideMountPoint(
  mountPoint: string,
  slug: string,
): string | null {
  if (typeof slug !== "string" || slug.length === 0) return null;
  // Reject absolute paths outright — `path.resolve(mount, "/etc/passwd")`
  // silently drops the mount prefix.
  if (path.isAbsolute(slug)) return null;
  const normalizedMount = path.resolve(mountPoint);
  const target = path.resolve(normalizedMount, slug);
  const rel = path.relative(normalizedMount, target);
  // `rel === ""` means slug resolved to the mount root itself (e.g. `"."` or
  // `""`); we treat that as invalid because the handler is supposed to open a
  // specific project, not the mount root.
  if (rel === "" || rel.startsWith("..") || path.isAbsolute(rel)) return null;
  return target;
}

// --- rsync:toStation option-injection guard ---------------------------------

export type RsyncPathValidationResult =
  | { ok: true; path: string }
  | { ok: false; error: string };

/**
 * Validate a renderer-supplied `localPath` before it's handed to rsync as the
 * source operand. The caller is expected to have already `fs.stat`ed the path
 * and pass the result in. We keep the stat out of this function so the
 * validator stays pure and testable.
 *
 * Rules:
 *   1. Must be a non-empty string.
 *   2. Must not start with `-` (rsync would parse it as a flag — even with
 *      `--` before the operands, defense-in-depth is cheap).
 *   3. Must be absolute (rsync is spawned without a cwd contract; relative
 *      paths would depend on the daemon process cwd).
 *   4. Must not contain NUL.
 *   5. The caller-provided stat must report an existing directory.
 */
export function validateRsyncLocalPath(
  localPath: unknown,
  stat: { exists: boolean; isDirectory: boolean } | null,
): RsyncPathValidationResult {
  if (typeof localPath !== "string" || localPath.length === 0) {
    return { ok: false, error: "localPath must be a non-empty string" };
  }
  if (localPath.startsWith("-")) {
    return { ok: false, error: "localPath must not start with '-'" };
  }
  if (localPath.includes("\0")) {
    return { ok: false, error: "localPath must not contain NUL" };
  }
  if (!path.isAbsolute(localPath)) {
    return { ok: false, error: "localPath must be absolute" };
  }
  if (!stat || !stat.exists) {
    return { ok: false, error: "localPath does not exist" };
  }
  if (!stat.isDirectory) {
    return { ok: false, error: "localPath must be a directory" };
  }
  // Canonicalize (collapse `.` / `..` / trailing slashes). The caller also
  // does realpath resolution via fs.stat, but the textual form is what we
  // pass to rsync.
  return { ok: true, path: path.resolve(localPath) };
}

// --- window.open scheme allowlist -------------------------------------------

/**
 * Schemes we allow to reach `shell.openExternal`. `https:` and `http:`
 * cover clickable web URLs in terminal/source text (the URL linkifier).
 * Everything else — `mailto:`, `file:`, `javascript:`, custom app
 * schemes — stays rejected. Keep this list minimal; widen only after a
 * real caller shows up.
 */
export const ALLOWED_EXTERNAL_SCHEMES: ReadonlySet<string> = new Set(["https:", "http:"]);

export type UrlSchemeCheck =
  | { ok: true; url: string }
  | { ok: false; reason: string };

/**
 * Parse the URL from a renderer `window.open(...)` request and allowlist its
 * scheme. Rejects malformed URLs, `javascript:`, `file:`, `mailto:`, custom
 * handlers, and anything else not explicitly in `ALLOWED_EXTERNAL_SCHEMES`.
 */
export function checkExternalUrl(raw: unknown): UrlSchemeCheck {
  if (typeof raw !== "string" || raw.length === 0) {
    return { ok: false, reason: "url must be a non-empty string" };
  }
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, reason: "url is not parseable" };
  }
  if (!ALLOWED_EXTERNAL_SCHEMES.has(parsed.protocol)) {
    return { ok: false, reason: `scheme ${parsed.protocol} not allowed` };
  }
  return { ok: true, url: parsed.toString() };
}

// --- git:clone remote guard --------------------------------------------------

export type GitCloneUrlCheck =
  | { ok: true; url: string }
  | { ok: false; error: string };

/**
 * Characters that must never reach the station's shell, even though the caller
 * single-quotes the operand. A hyphen mid-string is fine (`Hello-World` is an
 * ordinary repo name); a LEADING hyphen is checked separately, because git
 * would read it as an option and `--upload-pack=<cmd>` is remote code
 * execution.
 */
// eslint-disable-next-line no-control-regex
const GIT_URL_FORBIDDEN = /[\s\u0000-\u001f\u007f;&|<>()$`'"\\*?[\]{}]/;

/**
 * Validate a renderer-supplied clone URL before it becomes an operand of
 * `git clone` inside an `ssh` command line on the station.
 *
 * The renderer runs the same rules (`renderer/src/ui/git-remote-url.ts`) to
 * show the user an inline error, but that copy is a UX affordance: anything
 * that can reach the IPC channel bypasses it, so main re-derives the verdict
 * here. Deliberately an independent implementation — this module must not
 * import renderer code — with both test suites asserting the same rule set.
 *
 * Accepts `https://…`, `ssh://…` and scp-style `git@host:owner/repo`. Rejects
 * every other transport, notably `ext::` (which exists to run an arbitrary
 * command) and `file://`.
 */
export function validateGitCloneUrl(raw: unknown): GitCloneUrlCheck {
  if (typeof raw !== "string") return { ok: false, error: "url must be a string" };
  const url = raw.trim();
  if (url === "") return { ok: false, error: "url must not be empty" };
  if (url.length > 2048) return { ok: false, error: "url is too long" };
  if (url.startsWith("-")) return { ok: false, error: "url must not start with '-'" };
  if (GIT_URL_FORBIDDEN.test(url)) {
    return { ok: false, error: "url contains a forbidden character" };
  }
  if (/^[A-Za-z0-9._-]+@[A-Za-z0-9.-]+:[A-Za-z0-9._\-/]+$/.test(url)) {
    return { ok: true, url };
  }
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { ok: false, error: "url is not a git remote" };
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "ssh:") {
    return { ok: false, error: `transport ${parsed.protocol} is not allowed` };
  }
  if (parsed.hostname === "") return { ok: false, error: "url has no host" };
  if (parsed.pathname.replace(/\//g, "") === "") {
    return { ok: false, error: "url has no repository path" };
  }
  return { ok: true, url };
}
