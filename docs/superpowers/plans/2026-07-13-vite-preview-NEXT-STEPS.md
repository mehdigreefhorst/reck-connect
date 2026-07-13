# Vite Preview — status & next steps (resume after compaction)

**Date:** 2026-07-13. Read with the spec `docs/superpowers/specs/2026-07-13-vite-preview-lifecycle-design.md` and the Phase 1 plan `docs/superpowers/plans/2026-07-13-vite-preview-phase-1-find-and-explain.md`.

## Where we are — Phase 1 DONE and LIVE-RENDER CONFIRMED ✅
- Branch `integrate/component-preview` on the worktree `/Users/mehdigreefhorst/Desktop/reck-connect-preview`. Phase 1 commits `6d53bee..a36f559` (6 tasks via subagent-driven-development + I-1 concurrency fix), all reviewed clean; final whole-branch review = ready to merge. **Pushed to origin.**
- Verified end-to-end on 2026-07-13: command-clicking `Nexa-service-desk/apps/dashboard-v2/src/App.tsx` renders the real component (a NeXI ticket screen) in the popup. Trace: `detect previewable=true app=apps/dashboard-v2` → `mode=component` → daemon `startPreview running=true port=5173` (Vite rooted at the subdir) → iframe framed. The monorepo walk-up + `app_rel_path` threading + daemon subdir Vite all work.
- Station daemon (`cyborgstudio`, `~/.local/bin/reck-stationd`, user service `reck-stationd.service`) rebuilt from `a36f559` and running. Earlier confusion: the user's first station update was to `0d5be28` (the merge commit, pre-Phase-1), which ignored `app_rel_path` and rooted Vite at the project root → `/src/App.tsx` 404. Rebuilding from `a36f559` fixed it. Lesson for resume: **the station daemon must be built from a commit that has Task 3** (`grep -c AppRelPath daemon/internal/http/router.go` == 2).

## Resume pointers
- Packaged app built at `satellite/release/mac-arm64/Reck Connect Satellite.app`. Launched from terminal so logs land in `/tmp/reck-app.log` (renderer popup logs forwarded as `[file-viewer.N.renderer] [preview] …`). Re-arm the click watcher by writing `$(( $(wc -l < /tmp/reck-app.log) + 1 ))` to `/tmp/reck-app-start-line`.
- User's verification model: **user cmd-clicks, I watch the log**. Nexa has `node_modules` on the station (root-hoisted vite 8); commitify does NOT (its deps were never installed — scope-blocked; that's the Phase 2 install case).
- SDD progress ledger: `.superpowers/sdd/progress.md` (gitignored). Task briefs/reports/diffs under `.superpowers/sdd/`.

## Two fidelity issues found during e2e (these are NEXT, before Phases 2/3) — call this **Phase 1.5 (runner fidelity)**
Both are in the pre-existing Vite runner (`daemon/internal/preview/runner/*.mjs`), now exercised on a Vite 8 / React 19 / non-standard-CSS-path app. NOT Phase 1 (find & explain) defects.

1. **Wrong coloring — project global CSS not injected.**
   - Root cause: dashboard-v2 imports its styles in `src/main.tsx` as `import "./theme/tokens.css"; import "./theme/global.css";`. The runner's `detect.mjs` `CSS_CANDIDATES` (`src/index.css`, `src/globals.css`, `src/global.css`, `src/styles/globals.css`, `app/globals.css`, `styles/globals.css`) does NOT include `src/theme/*`, so `detectGlobalCss` finds nothing and the synthesized entry never loads the app's tokens/global CSS. The component's own CSS imports (if any) apply, but app-level globals don't.
   - Fix direction: instead of a hardcoded candidate list, **parse the project's real entry (`src/main.tsx`/`main.jsx`/`index.tsx` — discover via the project's `index.html` `<script type=module src>` or Vite config) and replicate its top-level side-effect CSS imports** into the synthesized entry. Keep the candidate list as a fallback. Verify tokens.css + global.css load and the ticket screen shows correct colors.

2. **Only `App.tsx` (a standalone app root) renders; prop/context-dependent components render blank.**
   - Root cause: the synthesized entry is `render(createElement(Component))` on the default export with no props and best-effort providers. Components needing props/context (e.g. `apps/dashboard-v2/src/components/**`) mount empty or throw.
   - Fix direction: (a) improve provider auto-wrap (`detectProviders`), and (b) for components that need props, there's no general answer — detect a missing-default-export or a render error and show a clear message ("This component needs props/context — preview works best on page/screen-level components"), rather than a blank frame. Decide scope: this may be partly deferred/documented rather than fully solved.
   - Note: also verify `?target=` for non-App files actually reaches component mode (the user reported "other files don't work" — confirm whether they hit this render-blank case vs. an earlier gate/entry failure; check `[preview]` trace per file).

## Then the originally-specced phases
- **Phase 2 — lifecycle:** package-manager detect (bun/pnpm/npm/yarn from lockfile); **Install & start** action (runs install on the station with streamed progress — fixes commitify); explicit Start/Stop; **auto-stop preview on project archive**. Turns the raw "could not resolve 'vite'" degrade into the mockup's "Dependencies aren't installed → Install & start" card.
- **Phase 3 — rail flare UI:** the per-project Vite bolt in the sidebar (green/grey/red/mustard by state), hover-expand-right with "Click to view details" tip, click-panel with the **app-to-preview picker** (one app per project) + Stop/Reinstall/Settings; the background per-project previewability scan (walk *down* into `apps/*`/`packages/*`); persistence of the chosen app. Mockup already approved.

## Housekeeping (do before final merge)
- Restore the station `~/src/reck-connect` checkout to the user's own branch when done (currently `integrate/component-preview` @ a36f559; the user had it on `feat/chat-file-drag-drop`).
- Deferred Phase 1 cleanups (final-review Minors): remove now-dead `detectProjectPreview` + `detectStationProjectPreview` (only referenced by tests); make station `readStation` distinguish failure vs absence so `read-error` is reachable; `read-error` card copy ("Showing source" while editor hidden).
- Open the PR for Phase 1 when the user wants (fork `mehdigreefhorst`, closing-keyword per CLAUDE.md).
