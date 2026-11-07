// Round 8.6 Phase 3 — shared suffix-match helper for both the readdir
// walker (search-walk.ts) and the rg-based workers (search-worker-rg-*).
//
// Centralising the rule prevents drift: a path matches if EITHER
//   - its full path ends with `/<cleanSuffix>` (segment-aligned), OR
//   - its basename equals cleanSuffix.
//
// `super_foo.py` MUST NOT match `foo.py` (segment boundary required).

import path from "node:path";

/** Strip leading `./` from a printed path so the suffix is comparable. */
export function cleanSuffix(suffix: string): string {
  return suffix.replace(/^\.\/+/, "");
}

/**
 * True if `fullPath` ends with `suffix` on a path-segment boundary.
 * `suffix` is expected to already be cleanSuffix()-normalised.
 *
 * Uses POSIX `/` for the segment boundary check because:
 *   - the readdir walker on macOS/Linux uses `path.sep === "/"`,
 *   - the rg workers emit POSIX paths regardless of host OS.
 *
 * The second branch covers files at the root of the scanned tree where
 * there is no separator before the basename.
 */
export function matchesPathSuffix(
  fullPath: string,
  cleanedSuffix: string,
): boolean {
  if (cleanedSuffix.length === 0) return false;
  return (
    fullPath.endsWith("/" + cleanedSuffix) ||
    fullPath.endsWith(path.sep + cleanedSuffix) ||
    path.basename(fullPath) === cleanedSuffix
  );
}

/** Characters ripgrep's glob syntax gives meaning to. A basename holding
 *  any of them can't be passed as a literal glob. */
const GLOB_META_RE = /[*?[\]{}\\!,]/;

/**
 * The suffix's basename, when it is safe to hand ripgrep as a
 * `--glob <name>` whitelist; null otherwise.
 *
 * A slash-free glob matches the file name at any depth, so ripgrep itself
 * drops every non-candidate and only candidates cross the pipe (or the ssh
 * connection) — `matchesPathSuffix` still does the exact, segment-aligned
 * check on what comes back. Names with glob metacharacters return null and
 * the caller lists everything, as before.
 */
export function basenameGlob(cleanedSuffix: string): string | null {
  const base = cleanedSuffix.split("/").pop() ?? "";
  if (base.length === 0 || base === "." || base === "..") return null;
  if (GLOB_META_RE.test(base)) return null;
  return base;
}
