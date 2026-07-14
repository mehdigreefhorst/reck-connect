# Usage view — header-button overlay with binned token/quota plot

*2026-07-14 · issue #88 · follow-up to #82 / PR #83 (local token-usage telemetry)*

## Problem

The station records token/quota telemetry in `~/.config/reck/usage/usage.db`,
but there is no way to *see* it. The interim per-tab badge was rejected as
clutter (it repeated the account-level 5h % on every tab) and is removed in
this branch. This spec is the deferred "proper usage UI" pass.

## Decisions (locked with the user)

- **Entry point:** a chart icon button in the Satellite header (global), next
  to Settings. Not the per-project right-click menu.
- **Surface:** dismissable overlay modal on top of the panes (Esc / backdrop /
  ✕), not a full-screen destination.
- **Plot:** bars = tokens consumed per bin (from authoritative `turn_usage`
  per-turn counts, cache included — that is what burns quota), breakdown in
  the hover readout; toggleable 5h/7d quota-peak lines on a 0–100 % axis.
- **Approach C:** server-side binning + the uPlot chart library (~45 KB, the
  only new dependency). Rejected: client-side binning (needs a raw turn_usage
  endpoint anyway, ships thousands of rows from the Pi, 5000-row clamp breaks
  year views) and hand-rolled SVG (user chose the library).

## Architecture

```
Satellite (renderer)                      Station daemon (Pi)
  AppBar chart button                       GET /usage/histogram
    └─ openUsageOverlay (usage-view.ts) ──▶   └─ SQLite GROUP BY over
         ├─ chips Day|Week|Month|Year          turn_usage (token sums,
         ├─ ‹ › paging · ↑ drill-up            turn count) + quota_samples
         ├─ click-a-bar drill-down             (per-bin MAX 5h/7d %),
         ├─ project filter                     zero-filled, ≤1000 bins
         └─ uPlot bars + quota lines
```

### Daemon: `GET /usage/histogram`

Params: `bucket=hour|day|month` · `since`,`until` (unix, half-open) ·
`project_id` (optional; quota is account-level and ignores it) ·
`tz_offset_min` (minutes east of UTC so day/month bins start at the
*caller's* midnight — the renderer sends `-new Date().getTimezoneOffset()`).

Response: `{enabled, bucket, since, until, bins:[{t, input, output,
cache_creation, cache_read, total, turns, five_hour_peak?, seven_day_peak?}]}`.
Bins are dense (zero-filled) so the client needs no gap logic; the bin count
is capped at 1000 (`maxHistogramBins`), so the result never truncates data the
way the raw `/usage/series` row clamp would. Validation lives on
`usage.HistogramParams.Validate` → 400; store failures → 500.

### Renderer

- `ui/usage-range.ts` — pure math, no DOM: granularity↔bucket mapping (Day
  view = hour bins, Week/Month = day bins, Year = month bins), local-midnight
  period snapping (ISO Monday weeks), stepping, drill ladder
  (down: year→month→day, week→day; up: day→week→month→year), labels,
  future-paging guard. 15 vitest cases.
- `ui/usage-view.ts` — the overlay. Singleton; fetches its own project list;
  aborts in-flight fetches on rapid control clicks; uPlot colors read from the
  app's CSS custom properties (orange bars, sage 5h line, mustard 7d line) and
  the chart rebuilds when `data-theme` flips; ResizeObserver keeps it sized.
  States: loading (dimmed), empty period, `enabled:false` store, unreachable
  station. The period label is the design signature — Playfair italic, the
  wordmark's voice.
- `client-core/api/client.ts` — typed `getUsageHistogram(params)`.
- Data source: the **primary host's** daemon. Multi-host merge is out of scope
  for v1.

## Testing

- Go: table-driven histogram tests — bin boundaries, tz shift, month edges,
  project filter, quota-peak merge (account-level despite filter), empty DB,
  validation, bin cap.
- Renderer: vitest on usage-range; full typecheck.
- E2E: open against the live Pi daemon, drill Year→Month→Day, toggle theme.

## Known environment caveats (not regressions)

- `rsync-copy` / `project-push` / one `TtsEngine` vitest case fail on clean
  `main` locally (station-root/env dependent).
- `internal/launcher` integration tests fail at pristine `main` when the
  worktree lives under `~/Desktop` (macOS TCC blocks the disclaimed helper's
  socket bind); they pass from `/private/tmp`.
