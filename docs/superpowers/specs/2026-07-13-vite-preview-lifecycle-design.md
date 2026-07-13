# Design: Vite live-preview — monorepo support, legible failures, and the rail flare

- **Date:** 2026-07-13
- **Status:** DRAFT — direction + visual design confirmed by user. Builds on the shipped Phase B (faithful Vite component preview). Visual mockup: the "Reck · Live preview" artifact (rail flare + viewer states).
- **Scope:** the satellite file-viewer preview surface, `project-detect`, the daemon preview manager + Node runner, and (Phase 3) the project rail.
- **Supersedes:** the Phase-B assumption that *"a project's root **is** its Vite app."*

---

## 1. Where we are

Phase B (faithful component preview) is merged and live: command-clicking a `.tsx` opens a popup that renders the real component through the project's own Vite on the station. Verified working end-to-end for **root-level** Vite+React projects. Two gaps block real use:

1. **Monorepos don't preview.** `detectProjectPreview(projectCwd)` inspects only the project *root*. When the Vite app lives in `apps/dashboard-v2/` (e.g. Nexa Service Desk), the root has no `vite.config`/`react`, so detection returns `previewable:false` and the viewer silently shows source. Proven with a live `[preview]` trace: `detect(local) … previewable=false reason="not a Vite project"` → `mode=source`.
2. **Failures are silent.** Every non-render — not a Vite project, deps missing, Vite crashed — falls back to the source editor with no explanation. The user can't tell "this file type isn't previewable" from "your dev server failed."

## 2. Goal

- **Monorepo support:** resolve the nearest Vite *app root* by walking up from the clicked file (bounded by the project root), and run the preview against that subdirectory.
- **Legible failures:** every time a `.tsx`/`.jsx` can't render, the popup says *why* and offers the next step; source is an explicit offer, never a silent fallback.
- **A discoverable, low-friction control surface:** a per-project Vite "flare" in the rail that shows state at a glance and hosts the lifecycle controls — with **one active preview per project** and **no per-file app picker**.

## 3. The model (decided with the user)

- **One active Vite preview per project, at a time.** One dev server, one port. This matches the daemon manager's existing per-project keying.
- **The active app is chosen in the sidebar**, once — from the project's flare panel — not re-asked per file.
- **Opening a file** previews it against the project's *active* app. No picker on every open (that would be maddening).
- **The only prompts:**
  - *Nothing started yet* (and ≥1 previewable app) → the flare panel offers to start (and, if >1 app, to pick which).
  - *File belongs to a different app than the one running* → the viewer shows "A different app is live" with a one-tap **Switch preview here** (which just flips the sidebar selection).

## 4. Detection — walk-up (the core change)

Today: `detectProjectPreview(projectCwd) → { previewable, reason }` checks a single dir.

New: detect **for a file**, walking up to the nearest Vite app root within the project.

```
detectPreviewForFile(projectRoot, filePath) → {
  previewable: boolean,
  appRoot: string | null,   // nearest ancestor dir (≥ projectRoot) that is a Vite+React app
  reason: string,           // "" when previewable; else a user-facing reason key/message
}
```

- Walk from `dirname(filePath)` upward to `projectRoot` (inclusive). The first dir that is a Vite+React app (per the existing `vite.config.*` / `vite`+`react` in `package.json` test) is the `appRoot`.
- If none found: `previewable:false` with a specific reason:
  - not a `.tsx/.jsx/.js` → (viewer never calls detect for these; belt-and-suspenders reason `"not a component file"`)
  - Vite app found but **no React** → `"vite app, but no React dependency"`
  - a `package.json` with React but **no Vite** → `"React, but not a Vite app — preview supports Vite"`
  - nothing → `"no Vite app found for this file"`
- Keep the pure-`node:fs` posture (no Electron import) so the vitest unit test needs no mock.
- Existing `detectProjectPreview(projectCwd)` stays (used where only the root matters — e.g. the rail scan in Phase 3, which walks *down* into `apps/*`, `packages/*`). The two are complementary: file→up for the viewer, project→down for the rail badge.

The resolved `appRoot` is threaded through **both** ends:
- **Target computation** (`deriveComponentTarget`) becomes relative to `appRoot`, not the project root — `targetRelPath = relative(appRoot, filePath)`.
- **The daemon runner** serves Vite with its root at `appRoot` (not the project cwd). One app per project ⇒ if the active `appRoot` changes, the manager restarts the runner at the new root.

## 5. UI design (confirmed via mockup)

### 5.1 The rail flare (Phase 3)
A small Vite **bolt chip** pinned to the **bottom-right** of each project row — **only** on projects a background scan has confirmed have a Vite app. State by colour, using Reck's existing Wes stoplight semantics:

| State | Colour | Meaning |
|---|---|---|
| off | grey | previewable, not started |
| starting/installing | mustard (pulsing) | spinning up / installing deps |
| running | sage/green | live, on a port |
| failed | rose/red | start failed |

- It reads as a **pressable chip** (persistent border + ground + shadow).
- **Hover** → grows **rightward** into the space beside the rail to show the status (`:5174 · dashboard-v2`), ending in a **▾** caret; a tooltip reads **"Click to view details."**
- **Click** → opens the **flare panel**: the running status, the **App-to-preview picker** (radio list of the project's Vite apps; the home of app selection), and lifecycle actions (Stop / Install & start / Reinstall / Preview settings / Retry / View log by state).
- Pane stoplight dots move to the **top**-right so the flare owns the bottom-right cleanly.
- Projects with no Vite app carry **no bolt**.

### 5.2 The viewer (Phases 1 + 2)
Every command-click resolves to an answer — never a silent source fallback:

- **Rendered** — the real component, with a live footer (`◉ live · vite :5174 · apps/dashboard-v2`).
- **Not previewable** — "No live preview here — preview runs Vite + React apps; `utils.tsx` isn't inside one." → **Show source**.
- **Deps not installed** — "Dependencies aren't installed." → **Install & start preview** (Phase 2) + **Show source**.
- **A different app is live** — "Nexa is running `apps/admin`; this file is in `apps/dashboard-v2`." → **Switch preview here** + **Show source**.
- **Starting** — spinner + the Vite ready line.
- **Failed** — the cause (e.g. "port in use") + **Retry** / **View log**.

Semantic colour (the stoplight trio) carries *state*; terracotta stays reserved for selection/primary actions.

## 6. Phasing

Each phase is independently shippable and testable.

### Phase 1 — Find & explain *(this plan)*
Walk-up detection + reason-specific viewer messages, threaded so a monorepo subdir app actually renders.
- `detectPreviewForFile` (walk-up) + unit tests.
- Thread `appRoot` through the detect IPC, `deriveComponentTarget` (rel to appRoot), the `startPreview` call (cwd = appRoot), and the runner root.
- Manager: restart the per-project runner when the requested `appRoot` differs from the running one.
- Viewer: surface the `reason` — replace the silent `mode=source` for `.tsx/.jsx` with the reason states (not-previewable, different-app-live, starting, failed). Source stays reachable via the existing rendered/source toggle + an explicit "Show source".
- **Out of scope for P1:** the rail flare; installing deps; start/stop controls (deps-missing shows the *message*, the Install *action* is Phase 2).

**Acceptance:** opening `Nexa-service-desk/apps/dashboard-v2/src/App.tsx` renders the component (deps present on station); opening a non-Vite `.tsx` shows "No live preview here"; opening a file under a non-running app shows "A different app is live"; nothing regresses for root-level Vite projects or `.html`/`.md`.

### Phase 2 — Lifecycle
Package-manager detection (bun/pnpm/npm/yarn from lockfile), an **Install & start** action (runs install on the station with streamed progress), explicit **Start/Stop**, and **auto-stop preview on project archive**.

### Phase 3 — Rail flare + app picker
The bolt chip, hover-expand, click panel, the sidebar **App-to-preview** picker, the background per-project previewability scan (walk *down* into `apps/*`/`packages/*`), and persistence of the chosen app per project.

## 7. Open decisions (confirm during build)
- **Reason as key vs. message:** return a stable reason *key* from `detectPreviewForFile` and map to copy in the renderer (i18n-friendly, testable), vs. returning the sentence directly. Leaning **key**.
- **Walk-up ceiling:** stop at `projectRoot`; do we also stop at a `.git` boundary if the mount ever exposes one above the project? Default: `projectRoot` only.
- **appRoot change = restart:** confirm the manager restarts (not rejects) when `appRoot` differs from the running root for the same project id.
