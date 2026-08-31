# Plan: clone-from-GitHub projects (#162), mini-rail archive hit-testing (#163), endpointing-authoritative commits (#164)

Status: plan; Tracks A and B implemented on their branches, Track C not started
Issues: [#162](https://github.com/mehdigreefhorst/reck-connect/issues/162),
[#163](https://github.com/mehdigreefhorst/reck-connect/issues/163),
[#164](https://github.com/mehdigreefhorst/reck-connect/issues/164)

Ships as **three independent PRs**, one per issue. They touch disjoint files and
share no state, so they can be developed in parallel worktrees and merged in any
order.

| Track | Issue | Branch | Closes |
|---|---|---|---|
| A | #162 create a project by cloning a git URL | `feat/add-project-clone-url` | `Closes #162` |
| B | #163 archive stays clickable in the mini rail | `fix/mini-rail-archive-inert` | `Closes #163` |
| C | #164 endpointing must govern when audio/text is committed | `fix/endpointing-governs-commit` | `Closes #164` |

Per CLAUDE.md: feature branches only, never `main`; a dedicated worktree per
track when sessions run concurrently; the closing keyword goes in the PR
**body**, one keyword per issue.

---

# Track A — #162: create a project by cloning a git/GitHub repo

## Current state

`satellite/renderer/src/ui/add-project-dialog.ts` is the whole flow, with two
outcomes:

```ts
type DialogResult =
  | { kind: "new"; name: string; preamble: string }        // daemon mkdir's an empty dir
  | { kind: "existing"; cwd: string; name: string; preamble: string }  // rsync a laptop folder
  | null;
```

- `new` → `client.createProject({ name, preamble })`; the daemon
  (`daemon/internal/pty/manager.go:411` `AddProject`) slugifies the name,
  `os.Mkdir`s `config.ManagedProjectsRoot/<slug>` and registers it.
- `existing` → `copyAndRegisterExisting()`: slugify → `rsync.toStation()` →
  `createProject({ name, cwd, id })` → rollback on any failure.

`satellite/main/rsync-copy.ts` already owns the hard part: an **atomic slug
reservation** (`ssh reck-station mkdir '<root>/<slug>'`, EEXIST ⇒
`code: "slug-in-use"`), progress events to the renderer, `rm -rf` rollback on
every failure path. **A clone is that same pipeline with `git clone` in place of
`rsync`.**

## Design decision: clone on the station over the existing SSH transport

Rejected: adding `clone_url` to `AddProjectRequest` and cloning in the Go
daemon. `AddProject` is synchronous and returns a `config.Project`; there is no
progress channel, so a multi-minute clone would block the HTTP request behind a
frozen dialog, and streaming + cancel would have to be invented.

Chosen: clone from the Satellite main process over the SSH connection that
rsync already uses. It reuses `reserveRemoteSlug` / `rollbackRemote` verbatim,
`git clone --progress` emits parseable percentages, and the daemon keeps its
existing `cwd`-provided registration path unchanged. The clone runs **on the
station**, so nothing round-trips through rsync and `origin` stays intact.

## Steps

### A1. URL parsing/normalisation (pure, TDD first)

New `satellite/renderer/src/ui/git-remote-url.ts`:

```ts
export type ParsedRemote = { url: string; owner: string | null; repo: string };
export function parseGitRemote(input: string): ParsedRemote | null;
export function defaultNameFromRemote(r: ParsedRemote): string;
```

| Input | Normalised |
|---|---|
| `https://github.com/owner/repo[.git]` | unchanged |
| `owner/repo` | `https://github.com/owner/repo` |
| `git@github.com:owner/repo.git` | unchanged |
| `https://gitlab.com/group/sub/repo` | unchanged (non-GitHub hosts allowed) |

Rejects: empty/whitespace, shell metacharacters, leading `-`
(`--upload-pack=…`), `file://`, and **`ext::`** — a git transport that executes
an arbitrary command, so it must be refused outright, not merely discouraged.

### A2. Renderer dialog: a third `kind`

- extend the union with `{ kind: "clone"; url: string; name: string; preamble: string }`;
- add a **Git URL (optional)** field to `promptAddProject()` with helper text
  ("Leave empty to create an empty project");
- prefill Name from the repo name until the user edits Name themselves;
- `submitNew()`: URL empty ⇒ `kind: "new"` (unchanged); URL valid ⇒
  `kind: "clone"`; URL invalid ⇒ inline error, dialog stays open;
- **From existing folder…** is untouched;
- `addProjectFlow()` gains `case "clone"` → `cloneAndRegister()`, sharing the
  register-and-rollback tail with `copyAndRegisterExisting()` rather than
  duplicating it.

### A3. Main process: `git:clone` IPC

New `satellite/main/git-clone.ts`, registered from `main.ts` beside
`registerRsyncIpc`. Reuse (do not copy) `reserveRemoteSlug`, `rollbackRemote`,
`remotePath`, `assertValidSlug` and the SSH flag list from `rsync-copy.ts` so
the two flows can never drift on slug validation.

`git:clone(url, slug)`:
1. `assertValidSlug`; refuse if a copy/clone is already `active`;
2. re-validate the URL **in main** with the same parser — new
   `validateGitCloneUrl()` in `ipc-validation.ts`, mirroring
   `validateRsyncLocalPath`. Never trust the renderer;
3. `reserveRemoteSlug(slug)`, mapping `slug-in-use` / `parent-missing` /
   `ssh-error` to the codes the rsync path already returns;
4. `ssh … reck-station git clone --progress -- '<url>' '<target>'` with
   `GIT_TERMINAL_PROMPT=0` / `GIT_ASKPASS=/bin/true` so a private repo fails
   fast instead of hanging on a credential prompt. `git clone` accepts the
   already-reserved directory because `mkdir` left it empty;
5. parse `Receiving objects: NN%` / `Resolving deltas: NN%` → emit
   `git:clone-progress`, reusing the `finalize()` listener-detach discipline
   from `rsync-copy.ts` so late stderr can't report progress for a dead clone;
6. any failure ⇒ `rollbackRemote(slug)`, with `code: "auth-required"` on
   `Authentication failed` / `Permission denied (publickey)` /
   `could not read Username`, `code: "not-found"` on `Repository not found`.

`git:cancel` mirrors `rsync:cancel` (SIGTERM; rollback happens on the exit path).

### A4. Preload + typings

`git: { clone, cancel, onProgress }` in `satellite/preload/preload.ts` modelled
on the `rsync` block, and the matching shape in the `window.reckAPI`
declaration in `satellite/renderer/src/config.ts`.

### A5. Error surfaces

| Failure | Message |
|---|---|
| URL doesn't parse | inline: "Not a git repository URL." |
| slug in use / parent missing | existing rsync wording |
| auth required | "The station could not authenticate to this repository. Add a deploy key or SSH key on the station, or use a public URL." |
| repo not found | "Repository not found — check the URL (and that the station can reach the host)." |
| clone ok, register fails | "Cloned files, but registration failed: …" + rollback |
| cancel | silent, reservation rolled back |

**Private repos are out of scope for this PR**: the station's own git
credentials are used if present; otherwise the user gets `auth-required`. No
token is prompted for or stored in the Satellite.

### A6. Tests

`git-remote-url.test.ts` (parse/normalise/reject table), `ipc-validation.test.ts`
(+`validateGitCloneUrl`, incl. `ext::` and leading `-`), `git-clone.test.ts`
(spawn mocked, mirroring `rsync-copy.test.ts`: reservation classification,
progress parsing, rollback on every failure path, cancel, and that a rejected
URL never reaches `spawn`), and `add-project-dialog.test.ts` extensions.
⚠️ `rsync-copy` + `project-push` tests already fail on clean `main` locally
(station-root env) — check `main` before blaming a new failure.

### A7. Manual verification (station required)

Public clone registers with `origin` intact; same name twice ⇒ "choose a
different name" and no orphan dir; cancel mid-clone leaves nothing behind; a
private repo the station can't read ⇒ `auth-required`, no orphan; empty URL
still creates an empty project.

---

# Track B — #163: the Archive stays hit-testable in the mini rail

## Root cause (confirmed in the CSS)

`styles.css` hides the Archive in mini mode:

```css
.rail.rail-mini .rail-archive { opacity: 0; visibility: hidden; }
```

`visibility: hidden` would end hit-testing — except a descendant overrides it:

```css
.rail.rail-mini .rail-item .rail-avatar { opacity: 1; visibility: visible; }
```

Archived rows are `.rail-item`s living **inside** `#rail-archive`
(`renderZone(archived, this.archiveListEl)`), so every archived row's avatar is
explicitly set back to `visibility: visible` and becomes clickable again. It
stays invisible because `opacity: 0` on the ancestor is a group opacity a
descendant cannot undo — **invisible but clickable**, exactly the report. The
click lands on the row's own listener → `onSelect` → boot's restore dialog.

Only reproduces when the Archive folder was left expanded before collapsing the
rail, because the list is `hidden` (`display: none`) while collapsed — matching
the screenshots.

## Fix — belt and braces, because CSS alone is what failed

1. **CSS**: add `pointer-events: none` to `.rail.rail-mini .rail-archive`, and
   scope the avatar re-show to `.rail.rail-mini .rail-list .rail-item
   .rail-avatar` so it can never resurrect archive rows.
2. **DOM state**: in `Rail.setMode()`, set `inert` + `aria-hidden` on
   `#rail-archive` in mini — this also removes it from the focus order, which
   the fade never did.
3. **JS guard** (the testable layer — jsdom has no layout, so neither
   `pointer-events` nor `inert` can be asserted): bail out of the row click,
   the archive-header click, and the drop-zone `dragover`/`drop` while
   `.rail-mini` is set.

The rail-root click handler still runs, so a click in that dead strip does the
mini rail's normal thing: it expands. That is the desired outcome.

## Tests (`rail.test.ts`, jsdom)

Mini + expanded archive: archived row click does **not** fire `onSelect`;
expanded rail: it still does; mini: archive header doesn't toggle the folder;
mini: `drop` doesn't archive; `setMode` sets/clears `inert` + `aria-hidden`;
mini: a blank-space click still calls `onExpand`.

---

# Track C — #164: endpointing must govern when text is committed

## Root cause (verified in code — the provider plumbing is fine)

The endpointing preference **does** reach the provider:
`endpointing.ts` → `daemonEndpointingParams()` → `dictationStreamUrl()`
(`endpoint_mode`, `silence_ms`) → `daemon/internal/http/dictation.go:131` →
`protocols.go:174`, where Codex `manual` omits `turn_detection` entirely
(server VAD off) and `goodbye()` sends the one `input_audio_buffer.commit`.

What ignores the setting is the **renderer's chunk model**, which is the actual
terminal-injection policy:

```ts
// chunkModel.ts
export function shouldFlush(chunk, opts) {
  if (resolvedCount(chunk) === 0) return false;
  if (resolved >= opts.commitWordCount) return true;   // 6 words → commit
  return opts.msSinceVoice >= opts.commitPauseMs;      // 700 ms  → commit
}
export const SILENCE_FINALIZE_MS = 1000;               // hardcoded end sweep
```

`FlushOpts` carries only `commitWordCount` / `commitPauseMs` / `ghostResetMs`,
all from `settings.appearance`. `settings.endpointing` is never passed in
(`TranscriptionController.flushOnset()`). So with **Finalize = manual** and
**Silence before finalize = 3900 ms**, the renderer still commits after six
resolved words or a 700 ms pause — and those commits are irreversible:

```ts
/** Append committed phrase text to the terminal (never revised once sent). */
private commitToTerminal(text: string): void { … this.target.insert(sep + text); }
```

A word frozen at 700 ms can never be corrected when the provider revises the
phrase with more context. That is the accuracy loss.

## The rule to enforce everywhere

**Rendering interims early is fine. Committing — to the provider *or* to the
terminal — early is not.** The endpointing control is the single authority over
both; the CHUNKING knobs may only affect what is *displayed*.

## Fix

1. Thread `settings.endpointing` into `FlushOpts` / `stepChunk`.
2. `mode === "manual"` ⇒ `shouldFlush` is always false and the
   `SILENCE_FINALIZE_MS` sweep is skipped. Nothing reaches the terminal until
   the final pass, which `stepChunk`'s `final` branch already commits in full.
   Enter and stop are the only flushes.
3. `mode === "auto"` ⇒ the pause commit uses `silenceMs`, not `commitPauseMs`,
   and the word-count commit is subordinate to it (6 words must not defeat a
   3900 ms setting).
4. Relabel the CHUNKING controls as a display cadence, or mark them explicitly
   subordinate to endpointing in the panel.
5. Manual mode holds a long uncommitted tail: check the pill degrades
   gracefully, and surface the Realtime input-buffer cap as an error rather
   than a silent stall.
6. Secondary check: endpointing is baked into the provider at construction and
   `updateSettings()` only swaps the provider while `engine.getState() ===
   "idle"` — a change mid-utterance applies to the *next* one. Make that
   visible in the panel if it surprises users.

## Tests

`chunkModel.test.ts`: for each endpointing mode, assert the exact set of
triggers that may commit — a manual case asserting **zero** commits across
word-count, pause and silence-sweep, then everything committed on `final`; an
auto case asserting commits track `silenceMs` and not `commitPauseMs`.
Controller-level test that `flushOnset` passes endpointing through.

---

## Cross-cutting checks (all three PRs)

- `pnpm test` + `pnpm typecheck` green in `satellite/`.
- The two E2E suites (`test:e2e`, `test:e2e:electron`) are separate and not in
  CI — run both locally when a PR touches what they cover (B does, via the
  rail; C via the dictation specs). Set `RECK_E2E_PORT`; 5173 is taken by
  another project on this machine.
- Known-flaky / pre-existing, do not chase: `rsync-copy` + `project-push` on
  clean `main`; usage-view quota-forecast tests between ~22:30 and ~08:00.
- `code-reviewer` on all three; `security-reviewer` additionally on Track A,
  which builds a remote command line from user input.
- The global gitleaks pre-commit hook can stall `git commit` — ask before
  `--no-verify`.
