// Parsing + normalisation for the "clone a repo into a new project" flow.
//
// Pure and DOM-free so it unit-tests without a dialog, and so the main
// process can re-run the exact same rules on the value the renderer sends
// (`main/ipc-validation.ts` → `validateGitCloneUrl`). The renderer's copy is
// a UX affordance; the main-process copy is the security boundary. Both must
// agree, which is why the rules live here in one place.
//
// The value ends up as an operand of `git clone` inside an `ssh` command line
// on the station, so the accepted shapes are deliberately narrow.

/** A remote we are willing to hand to `git clone`. */
export interface ParsedRemote {
  /** Exactly what to pass to `git clone` (shorthand already expanded). */
  url: string;
  /** Owner/namespace, when the shape has one. `group/sub` for nested groups. */
  owner: string | null;
  /** Repository name, without any `.git` suffix — the default project name. */
  repo: string;
}

/**
 * Characters that must never reach a remote shell, even though the caller
 * single-quotes the operand. Whitespace is included: a URL has no business
 * containing any, and it is the classic way to smuggle a second argument.
 */
// (A hyphen mid-string is fine — `Hello-World` is an ordinary repo name; it
// is only a LEADING `-` that git would read as an option, checked separately.)
// eslint-disable-next-line no-control-regex
const FORBIDDEN = /[\s;&|<>()$`'"\\\u0000-\u001f\u007f*?[\]{}]/;

/** `owner/repo` shorthand — GitHub is the assumed host, as on the CLI. */
const SHORTHAND = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/;

/** scp-style `git@host:path/repo.git`, captured component by component. */
const SCP_LIKE = /^([A-Za-z0-9._-]+)@([A-Za-z0-9.-]+):([A-Za-z0-9._\-/]+)$/;

/**
 * Same cap as `main/ipc-validation.ts`'s `MAX_GIT_URL_LENGTH`. Without it the
 * dialog would happily accept a URL main then rejects, and the user would only
 * find out after the flow had committed to a project name.
 */
const MAX_URL_LENGTH = 2048;

/**
 * No component may start with `-`. See the long-form reasoning on
 * `hasOptionLikeComponent` in `main/ipc-validation.ts`: for an ssh remote the
 * host and path become separate `ssh` argv entries on the station, so
 * `ssh://-oProxyCommand=…/repo` and `git@-Fevil.conf:a/b` are option
 * injection without needing a single shell metacharacter.
 */
function hasOptionLikeComponent(components: readonly string[]): boolean {
  return components.some((c) => c.startsWith("-"));
}

function stripDotGit(s: string): string {
  return s.endsWith(".git") ? s.slice(0, -4) : s;
}

/** Split a `owner/.../repo` path into its namespace and repo name. */
function splitPath(p: string): { owner: string | null; repo: string } | null {
  const parts = p.split("/").filter((s) => s.length > 0);
  if (parts.length === 0) return null;
  const repo = stripDotGit(parts[parts.length - 1]);
  if (repo === "") return null;
  const owner = parts.length > 1 ? parts.slice(0, -1).join("/") : null;
  return { owner, repo };
}

/**
 * Normalise a user-typed remote, or return `null` if we won't clone it.
 *
 * Accepted:
 *   - `https://host/owner/repo[.git]` (any host, nested groups allowed)
 *   - `ssh://git@host/owner/repo[.git]`
 *   - `git@host:owner/repo[.git]`
 *   - `owner/repo` shorthand → `https://github.com/owner/repo`
 *
 * Rejected, deliberately: anything with whitespace or shell metacharacters,
 * a leading `-` (git would read it as an option — `--upload-pack=…` is remote
 * code execution), plain `http://` (silently insecure), `file://`, and the
 * `ext::` transport, which exists specifically to run an arbitrary command.
 */
export function parseGitRemote(input: string): ParsedRemote | null {
  if (typeof input !== "string") return null;
  const raw = input.trim();
  if (raw === "") return null;
  if (raw.length > MAX_URL_LENGTH) return null;
  if (raw.startsWith("-")) return null;
  if (FORBIDDEN.test(raw)) return null;

  if (SHORTHAND.test(raw)) {
    const split = splitPath(raw);
    if (!split || split.owner === null) return null;
    return { url: `https://github.com/${raw}`, owner: split.owner, repo: split.repo };
  }

  const scp = SCP_LIKE.exec(raw);
  if (scp) {
    const [, user, host, path] = scp;
    if (hasOptionLikeComponent([user, host, ...path.split("/")])) return null;
    const split = splitPath(path);
    if (!split) return null;
    return { url: raw, owner: split.owner, repo: split.repo };
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "ssh:") return null;
  if (parsed.hostname === "") return null;
  if (hasOptionLikeComponent([parsed.hostname, parsed.username, ...parsed.pathname.split("/")])) {
    return null;
  }
  const split = splitPath(parsed.pathname);
  if (!split) return null;
  return { url: raw, owner: split.owner, repo: split.repo };
}

/** The project name to prefill from a parsed remote. */
export function defaultNameFromRemote(r: ParsedRemote): string {
  return r.repo;
}
