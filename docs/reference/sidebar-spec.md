# Reck Connect — Sidebar ("the rail") build spec

A complete, self-contained description of the Reck Connect Satellite sidebar,
written so another agent can rebuild it exactly. Every constant, every easing
curve, every alignment invariant is given, with the real code.

Source of truth in this repo:

| Concern | File |
|---|---|
| DOM, rows, drag/drop, rename, archive, context menu | `satellite/renderer/src/ui/rail.ts` |
| Rail constants, initials, width animator | `satellite/renderer/src/ui/rail-collapse.ts` |
| Generic collapse arithmetic (shared with the viewer TOC) | `satellite/renderer/src/ui/collapse-model.ts` |
| Shell markup, grid width, divider drag, wiggle | `satellite/renderer/src/boot.ts` (≈ lines 311–590) |
| All styling | `satellite/renderer/src/styles.css` (`/* === Rail (cream) === */` onwards) |
| Persistence | `satellite/renderer/src/config.ts` |
| Keyboard | `satellite/renderer/src/ui/shortcuts.ts` |
| Tests (the behavioural contract) | `ui/rail-collapse.test.ts`, `ui/collapse-model.test.ts`, `ui/rail.test.ts` |

History worth reading: `45b4adf` (rail collapse redesign — mini rail, squeeze-drag,
wiggle, refit fix), `e996361` (elastic drag-to-collapse zone instead of a frozen
sticky pin), `29de1f9` (blink-free crossfade, mini header parity), PR #105
(wiggle on tab switch + empty-area click collapse), PR #165 (mini-mode Archive
made inert), `d64d071` (overlay scrollbar on the rail), `2155e97` (Archive section).

---

## 1. The one-sentence model

The rail is a **variable-width grid column** with exactly **two modes**:
`expanded` (a list of named project rows) and `mini` (a 48 px strip of initials
avatars). It is **never hidden**. The width lives in one number in JS
(`railWidth`), is written to the grid every frame, and every visual mode change
is a pure CSS crossfade keyed off a single class (`.rail-mini`) — **layout boxes
never change between modes**, only opacity/visibility. That invariant is what
makes the logo, the divider and every avatar stay at the same y.

---

## 2. Shell geometry

```html
<!-- boot.ts -->
<div class="app-shell">
  <div id="nav-root"></div>            <!-- 50px top nav -->
  <div class="app-main" id="app-main">
    <div class="rail" id="rail"></div>         <!-- column 1: the sidebar -->
    <div class="rail-resize" id="rail-resize"></div> <!-- column 2: 6px divider -->
    <div class="right-pane" id="right-pane">
      <div class="pane-layout" id="pane-layout"></div>
    </div>
  </div>
  <div class="status-bar" id="status-bar"></div>
</div>
```

```css
:root {
  --nav-height: 50px;
  --status-height: 28px;
  --rail-width: 240px;             /* CSS default; JS overrides inline */
  --ease-smooth: cubic-bezier(0.25, 0.1, 0.25, 1);
}

.app-shell {
  display: grid;
  grid-template-rows: var(--nav-height) 1fr var(--status-height);
  height: 100%;
  background: var(--app-bg);
}

.app-main {
  display: grid;
  grid-template-columns: var(--rail-width) 6px 1fr;
  min-height: 0;
  background: var(--app-bg);
}
```

**The width is owned by JS, not CSS.** There is no `width` transition on the
rail — a CSS transition would be sampled late by the terminal `ResizeObserver`s
and panes would fit to stale geometry. Instead a rAF animator writes the grid
template directly:

```ts
// boot.ts
function applyGrid() {
  appMain.style.gridTemplateColumns = `${railWidth}px 6px 1fr`;
}
```

Every path that changes the width — mouse drag, keyboard toggle, mode
animation, wiggle — goes through `railWidth = n; applyGrid()`. Nothing else may
set the column width.

---

## 3. Geometry constants — the minimum span distances

```ts
// ui/rail-collapse.ts
export const RAIL_MAX = 240;   // expanded default AND maximum
export const RAIL_MINI = 48;   // the only collapsed width; never 0
export const RAIL_COLLAPSE_AT = 171; // the "row minimum" (old 180px less 5%)

/** Hysteresis: dragging inward past RAIL_COLLAPSE_AT, the collapse only
 *  commits after this many extra pixels of pointer travel. */
export const RAIL_STICKY_PX = 32;

/** Elastic damping inside the sticky zone: the rail trails the pointer at
 *  this fraction of its travel (rubber-band resistance). */
export const RAIL_STRETCH_FACTOR = 0.35;

/** Dragging outward from mini, releasing beyond this small pull means
 *  "expand" rather than settling back. */
export const RAIL_EXPAND_COMMIT_PX = 24;
```

Derived thresholds (memorise these — they are the whole feel):

| Boundary | Value | Meaning |
|---|---|---|
| Max width | **240 px** | Drag clamps here; also the default and the expanded restore target |
| Row minimum ("min span") | **171 px** | At or above: plain live resize. Below: the collapse gesture begins |
| Sticky floor | **171 − 32 = 139 px** | Raw pointer width at or above this still stretches elastically; **one pixel below (138) commits the collapse** |
| Mini width | **48 px** | The collapsed rail. Never fully hidden |
| Expand commit | **48 + 24 = 72 px** | Releasing a mini drag at ≥ 72 px springs the rail open; below settles back to 48 |

Inside the sticky zone the *rendered* width is damped, not 1:1:

```
rendered = round(171 − (171 − rawPointerWidth) × 0.35)
```

so at the sticky floor (raw 139) the rail has only visibly moved to
`round(171 − 32×0.35) = 160` px — it has given ~11 px for 32 px of pull. That
is the "keep pulling to collapse" signal: it reads as progress, not as a frozen
divider.

---

## 4. The collapse model (shared, parameterised)

The arithmetic is generic so the file-viewer's TOC sidebar is the *same* model
with different numbers, not a second near-identical implementation
(`viewer/tocCollapse.ts`: max 220, mini 0, collapseAt 120, sticky 24, stretch
0.35, commit 20). Rebuild it this way.

```ts
// ui/collapse-model.ts
export interface CollapseConfig {
  max: number;            // expanded default and maximum
  mini: number;           // collapsed width (panels collapse to this, never 0 for the rail)
  collapseAt: number;     // dragging inward past this begins the collapse gesture
  stickyPx: number;       // extra travel required before the collapse commits
  stretchFactor: number;  // elastic damping inside the sticky zone
  expandCommitPx: number; // outward pull from mini that means "expand"
}

export type CollapseDragDecision =
  | { kind: "resize"; width: number }
  | { kind: "stretch"; width: number }
  | { kind: "collapse" }
  | { kind: "expand"; width: number }
  | { kind: "track"; width: number };

export type CollapseDragRelease =
  | { kind: "spring-expand" }
  | { kind: "settle-mini" }
  | { kind: "bounce-back" }
  | { kind: "stay" };

export function createCollapseModel(cfg: CollapseConfig): CollapseModel {
  return {
    dragDecision(rawWidth: number, mini: boolean): CollapseDragDecision {
      if (mini) {
        if (rawWidth > cfg.collapseAt) {
          return { kind: "expand", width: Math.min(cfg.max, rawWidth) };
        }
        return { kind: "track", width: Math.max(cfg.mini, rawWidth) };
      }
      if (rawWidth < cfg.collapseAt - cfg.stickyPx) return { kind: "collapse" };
      if (rawWidth < cfg.collapseAt) {
        const overshoot = cfg.collapseAt - rawWidth;
        return {
          kind: "stretch",
          width: Math.round(cfg.collapseAt - overshoot * cfg.stretchFactor),
        };
      }
      return { kind: "resize", width: Math.min(cfg.max, rawWidth) };
    },

    dragRelease(width: number, mini: boolean): CollapseDragRelease {
      if (!mini) {
        if (width < cfg.collapseAt) return { kind: "bounce-back" };
        return { kind: "stay" };
      }
      if (width >= cfg.mini + cfg.expandCommitPx) return { kind: "spring-expand" };
      return { kind: "settle-mini" };
    },
  };
}
```

The rail's instance:

```ts
// ui/rail-collapse.ts
const railModel = createCollapseModel({
  max: RAIL_MAX,
  mini: RAIL_MINI,
  collapseAt: RAIL_COLLAPSE_AT,
  stickyPx: RAIL_STICKY_PX,
  stretchFactor: RAIL_STRETCH_FACTOR,
  expandCommitPx: RAIL_EXPAND_COMMIT_PX,
});

export const railDragDecision = (rawWidth: number, mini: boolean) =>
  railModel.dragDecision(rawWidth, mini);
export const railDragRelease = (width: number, mini: boolean) =>
  railModel.dragRelease(width, mini);
```

### 4.1 Truth table (copy these into tests verbatim)

`railDragDecision(raw, mini)`:

| raw | mini | result |
|---|---|---|
| 240 | false | `{resize, 240}` |
| 999 | false | `{resize, 240}` (clamp) |
| 200 | false | `{resize, 200}` |
| 171 | false | `{resize, 171}` — exactly at the minimum is still a resize |
| 170 | false | `{stretch, round(171 − 1×0.35)}` = `{stretch, 171}` |
| 151 | false | `{stretch, 171 − round(20×0.35)}` = `{stretch, 164}` |
| 139 | false | `{stretch, round(171 − 32×0.35)}` = `{stretch, 160}` |
| 138 | false | `{collapse}` |
| 10 | false | `{collapse}` |
| 10 | true | `{track, 48}` (clamp to mini) |
| 100 | true | `{track, 100}` |
| 171 | true | `{track, 171}` |
| 172 | true | `{expand, 172}` |
| 500 | true | `{expand, 240}` (clamp) |

`railDragRelease(width, mini)`:

| width | mini | result |
|---|---|---|
| 200 | false | `{stay}` |
| 171 | false | `{stay}` |
| 170 | false | `{bounce-back}` |
| 48 | true | `{settle-mini}` |
| 71 | true | `{settle-mini}` |
| 72 | true | `{spring-expand}` |
| 150 | true | `{spring-expand}` |

---

## 5. The width animator

One shared rAF animator drives collapse, expand **and** the wiggle. Two easings:
`easeOut` (cubic) for the wiggle's neutral nudge, `spring` (easeOutBack, a real
overshoot past the target) for every mode snap.

```ts
// ui/rail-collapse.ts
export type RailEasing = "easeOut" | "spring";

function easeOutCubic(t: number): number {
  return 1 - Math.pow(1 - t, 3);
}

// easeOutBack — slight overshoot past the target, matching the design mock's
// spring cubic-bezier(0.34, 1.2, 0.64, 1) feel on the drag-snap.
function easeOutSpring(t: number): number {
  const c1 = 1.70158;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

export function createWidthAnimator(deps: WidthAnimatorDeps): WidthAnimator {
  const now = deps.now ?? (() => performance.now());
  const schedule = deps.schedule ?? ((cb: () => void) => requestAnimationFrame(cb));
  const cancelSchedule = deps.cancelSchedule ?? ((h: number) => cancelAnimationFrame(h));
  let handle: number | null = null;
  let animating = false;

  function cancel(): void {
    if (handle !== null) cancelSchedule(handle);
    handle = null;
    animating = false;
  }

  function animateTo(target: number, opts: AnimateOptions): void {
    cancel();
    const from = deps.getWidth();                       // sample NOW, so a
    if (deps.reducedMotion?.() || opts.durationMs <= 0 || from === target) {
      deps.onFrame(target);                             // mid-flight retarget
      opts.onDone?.();                                  // starts from where the
      return;                                           // rail visually is
    }
    const ease = opts.easing === "spring" ? easeOutSpring : easeOutCubic;
    const start = now();
    animating = true;
    const tick = () => {
      const t = Math.min(1, (now() - start) / opts.durationMs);
      deps.onFrame(Math.round(from + (target - from) * ease(t)));
      if (t < 1) {
        handle = schedule(tick);
      } else {
        handle = null;
        animating = false;
        opts.onDone?.();
      }
    };
    handle = schedule(tick);
  }

  return { animateTo, cancel, isAnimating: () => animating };
}
```

Wiring:

```ts
// boot.ts
const reducedMotionQuery = window.matchMedia?.("(prefers-reduced-motion: reduce)");
const railAnimator = createWidthAnimator({
  getWidth: () => railWidth,
  onFrame: (w) => { railWidth = w; applyGrid(); },   // SAME path as a mouse drag
  reducedMotion: () => reducedMotionQuery?.matches === true,
});

const RAIL_SNAP_MS = 200;   // every mode snap, both directions
```

Contract points that matter:
- **Reduced motion jumps to the target and still fires `onDone`.** Never skip
  the callback — the trailing terminal refit depends on it.
- **`animateTo` always samples `getWidth()` at call time**, so retargeting
  mid-flight is seamless.
- Frames are `Math.round`ed — grid templates in fractional pixels cause blurry
  1 px seams on the divider.

---

## 6. Mode switching

```ts
// boot.ts
function setRailMode(mode: RailMode) {
  if (railMode === mode) return;
  // The pointer owns the width while a divider drag is live.
  if (railDragActive) return;
  // A newer mode change is authoritative — a wiggle's delayed restore must
  // never stomp the width we're about to animate to.
  cancelWiggle(false);
  railMode = mode;
  void saveRailMode(mode);
  appBar.setRailExpanded(mode === "expanded");   // nav button .active state
  rail.setMode(mode);                            // toggles .rail-mini (CSS crossfade)
  railAnimator.animateTo(mode === "mini" ? RAIL_MINI : railExpandedWidth, {
    durationMs: RAIL_SNAP_MS,
    easing: "spring",
    onDone: () => { refitActiveTerminals(); },
  });
}

function toggleRail() {
  setRailMode(railMode === "mini" ? "expanded" : "mini");
}
```

Note `railExpandedWidth` is tracked **separately** from `railWidth`: collapsing
to mini must not destroy the user's chosen expanded width.

```ts
const savedWidthSafe =
  typeof savedRailWidth === "number" && Number.isFinite(savedRailWidth)
    ? savedRailWidth
    : RAIL_MAX;
let railExpandedWidth = Math.max(RAIL_MINI, Math.min(RAIL_MAX, savedWidthSafe));
let railMode: RailMode = savedRailMode;
let railWidth = railMode === "mini" ? RAIL_MINI : railExpandedWidth;
```

Clamping on load is mandatory: older configs could persist widths up to a
removed 420 px clamp, and a corrupted value must never feed `NaN` into the grid.

---

## 7. The divider and its drag

```css
.rail-resize {          /* the 6px grid column */
  cursor: col-resize;
  background: transparent;
  position: relative;
}

.rail-resize::after {   /* the visible 1px hairline, inset 2px */
  content: "";
  position: absolute;
  left: 2px; top: 0; bottom: 0;
  width: 1px;
  background: var(--app-border);
  transition: background 0.15s var(--ease-smooth), width 0.15s var(--ease-smooth);
}

.rail-resize:hover::after,
.rail-resize.dragging::after {
  background: var(--claude-orange);
  width: 2px;
  left: 2px;
}
```

A 6 px hit target with a 1 px hairline: easy to grab, invisible until hovered.
`.dragging` is also applied during a wiggle, so the divider lights up orange
while it nudges — the wiggle reads as "the divider moved", not as a glitch.

```ts
// boot.ts — the whole drag
railResizeEl.addEventListener("mousedown", (e) => {
  e.preventDefault();
  cancelWiggle(true);        // settle any in-flight wiggle back to its base
  railAnimator.cancel();     // stop mode animations before sampling startW
  railDragActive = true;
  railResizeEl.classList.add("dragging");
  const startX = e.clientX;
  const startW = railWidth;

  const endDrag = () => {
    railDragActive = false;
    railResizeEl.classList.remove("dragging");
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
  };

  const onMove = (ev: MouseEvent) => {
    const decision = railDragDecision(startW + (ev.clientX - startX), railMode === "mini");
    switch (decision.kind) {
      case "collapse":
        // Past the sticky zone — collapse into mini mid-drag, ending the drag.
        endDrag();
        setRailMode("mini");
        break;
      case "stretch":
        // Elastic guard: the rail trails the pointer with damped resistance.
        railExpandedWidth = RAIL_COLLAPSE_AT;
        railWidth = decision.width;
        applyGrid();
        break;
      case "expand":
        // Dragging out of mini re-expands AT THE POINTER (no animation —
        // the pointer is authoritative).
        railMode = "expanded";
        rail.setMode("expanded");
        appBar.setRailExpanded(true);
        void saveRailMode("expanded");
        railExpandedWidth = decision.width;
        railWidth = decision.width;
        applyGrid();
        break;
      case "resize":
        railExpandedWidth = decision.width;
        railWidth = decision.width;
        applyGrid();
        break;
      case "track":
        // Mini follows the pointer live; the release decides the commit.
        railWidth = decision.width;
        applyGrid();
        break;
    }
  };

  const onUp = () => {
    endDrag();
    const release = railDragRelease(railWidth, railMode === "mini");
    switch (release.kind) {
      case "spring-expand": setRailMode("expanded"); break;
      case "settle-mini":
        railAnimator.animateTo(RAIL_MINI, { durationMs: RAIL_SNAP_MS, easing: "spring" });
        break;
      case "bounce-back":
        railAnimator.animateTo(RAIL_COLLAPSE_AT, { durationMs: RAIL_SNAP_MS, easing: "spring" });
        void saveRailWidth(railExpandedWidth);
        break;
      case "stay":
        void saveRailWidth(railExpandedWidth);
        break;
    }
  };

  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
});

// Double-clicking the divider toggles the mode.
railResizeEl.addEventListener("dblclick", () => {
  setRailMode(railMode === "mini" ? "expanded" : "mini");
});
```

Two subtleties that are easy to lose:
- `railExpandedWidth = RAIL_COLLAPSE_AT` during a `stretch` — the elastic
  rendered width is a *display* value, never the persisted one.
- Releases persist `railExpandedWidth`, not `railWidth`.

---

## 8. The wiggle

**What:** after a project switch, and after any in-project tab switch, the
divider auto-nudges **out by `pixels` and back**, then forces a terminal refit.

**Why:** the revealed terminal may have geometry identical to the one it
replaced, so nothing fires its `ResizeObserver` and it renders at a stale size.
The wiggle's trailing refit is the fix; it replaced a manual divider jiggle
users were doing by hand. That is why a tab switch wiggles even when the
preference is off — it is a *correctness* refit there, decorative only on a
project switch.

### 8.1 Settings

```ts
// config.ts
export interface RailWiggleSettings {
  enabled: boolean;
  pixels: number;
  legMs: number;
}

export const DEFAULT_RAIL_WIGGLE: RailWiggleSettings = {
  enabled: true,
  pixels: 12,
  legMs: 240,
};

function positiveOr(fallback: number, raw: unknown): number {
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : fallback;
}

export async function loadRailWiggle(): Promise<RailWiggleSettings> {
  const enabled = await window.reckAPI.config.get<boolean>("railWiggleEnabled");
  const pixels  = await window.reckAPI.config.get<number>("railWigglePixels");
  const legMs   = await window.reckAPI.config.get<number>("railWiggleLegMs");
  return {
    enabled: enabled !== false,     // absent ⇒ on
    pixels: positiveOr(DEFAULT_RAIL_WIGGLE.pixels, pixels),
    legMs:  positiveOr(DEFAULT_RAIL_WIGGLE.legMs,  legMs),
  };
}
```

Preferences UI bounds (`ui/settings-view.ts`): distance **1–64 px**, leg
duration **16–1000 ms**, both integers, with an inline validation message.
Total wiggle duration is `2 × legMs` (out, then back) — 480 ms at the defaults.

### 8.2 The gate

```ts
// ui/rail-collapse.ts
export interface WiggleGateState {
  enabled: boolean;        // the railWiggleEnabled preference
  force: boolean;          // true for triggers that ignore the preference (tab switch)
  wiggleActive: boolean;   // a wiggle is already in flight
  railDragActive: boolean; // the user is dragging the divider
}

export function shouldStartWiggle(s: WiggleGateState): boolean {
  if (s.wiggleActive || s.railDragActive) return false;  // both outrank force
  return s.force || s.enabled;
}
```

| enabled | force | wiggleActive | dragActive | start? |
|---|---|---|---|---|
| ✓ | ✗ | ✗ | ✗ | **yes** |
| ✗ | ✗ | ✗ | ✗ | no |
| ✗ | ✓ | ✗ | ✗ | **yes** |
| any | ✓ | ✓ | ✗ | no |
| any | ✓ | ✗ | ✓ | no |

### 8.3 The implementation

```ts
// boot.ts
let wiggleActive = false;
let wiggleBase = 0;
let wiggleRetryTimer: number | null = null;

function cancelWiggle(restoreBase: boolean) {
  if (wiggleRetryTimer !== null) {
    window.clearTimeout(wiggleRetryTimer);
    wiggleRetryTimer = null;
  }
  if (!wiggleActive) return;
  wiggleActive = false;
  railAnimator.cancel();
  railResizeEl.classList.remove("dragging");
  if (restoreBase) {
    railWidth = wiggleBase;
    applyGrid();
  }
}

function wiggleSeparator(opts: { force?: boolean; attempt?: number } = {}) {
  const force = opts.force === true;
  const attempt = opts.attempt ?? 0;
  if (!shouldStartWiggle({ enabled: railWiggle.enabled, force, wiggleActive, railDragActive })) {
    return;
  }
  if (railAnimator.isAnimating()) {
    // A collapse/expand is mid-flight (e.g. a mini-avatar click just expanded
    // the rail) — retry ONCE after it settles. `force` rides along so a queued
    // tab-switch wiggle can't silently downgrade to a preference-gated one.
    if (attempt === 0 && wiggleRetryTimer === null) {
      wiggleRetryTimer = window.setTimeout(() => {
        wiggleRetryTimer = null;
        wiggleSeparator({ force, attempt: 1 });
      }, RAIL_SNAP_MS + 40);
    }
    return;
  }
  wiggleActive = true;
  wiggleBase = railWidth;
  railResizeEl.classList.add("dragging");
  railAnimator.animateTo(wiggleBase + railWiggle.pixels, {
    durationMs: railWiggle.legMs,           // easeOut (default), NOT spring
    onDone: () => {
      if (!wiggleActive) return;
      railAnimator.animateTo(wiggleBase, {
        durationMs: railWiggle.legMs,
        onDone: () => {
          if (!wiggleActive) return;
          wiggleActive = false;
          railResizeEl.classList.remove("dragging");
          refitActiveTerminals();           // the whole point
        },
      });
    },
  });
}
```

Call sites:

```ts
// project switch — decorative, honours the preference
wiggleSeparator();

// tab click — correctness refit, forced, and ONLY on a real switch
const switched = findLeaf(tree, leafId)?.activeTabId !== tabId;
layout.setTree(switchTab(tree, leafId, tabId));
if (switched) wiggleSeparator({ force: true });

// ⌘⇧] / ⌘⇧[ tab cycling — same contract; the tabs.length < 2 guard upstream
// means this only runs when a switch really happened
wiggleSeparator({ force: true });
```

Invariants to preserve:
1. The wiggle **must** land back exactly on `wiggleBase` (two chained legs; test
   this).
2. `cancelWiggle(true)` on `mousedown`, `cancelWiggle(false)` on a mode change —
   a drag restores the base, a mode change lets the new animation own the width.
3. The `if (!wiggleActive) return;` guard in each `onDone` is what makes
   cancellation safe; without it a cancelled wiggle's second leg still fires.
4. Under `prefers-reduced-motion` the animator jumps, so the wiggle is visually a
   no-op — but `refitActiveTerminals()` still runs. Never gate the refit on
   motion.
5. `refitActiveTerminals` is **late-bound** (`let refitActiveTerminals = () => {}`
   at declaration, reassigned once `PaneLayout` exists) because the nav toggle is
   clickable during boot's awaits and would otherwise hit a TDZ error.

---

## 9. Rail DOM

```ts
// ui/rail.ts — constructor
this.props.root.classList.add("rail");
this.props.root.innerHTML = `
  <div class="rail-header">
    <span class="rail-header-text">Projects</span>
    <span class="rail-header-mark" aria-hidden="true"></span>
  </div>
  <div class="rail-divider"></div>
  <div class="rail-list-scroll">
    <div class="rail-list"></div>
  </div>
  <div class="rail-archive collapsed" id="rail-archive">
    <button class="rail-archive-header" id="rail-archive-header" type="button"
            aria-expanded="false"
            title="Archived projects — asleep, using no memory. Click a project to restore it.">
      <span class="rail-archive-caret" aria-hidden="true">▸</span>
      <span class="rail-archive-title">Archive</span>
      <span class="rail-archive-count" id="rail-archive-count">0</span>
    </button>
    <div class="rail-archive-scroll">
      <div class="rail-archive-list" id="rail-archive-list" hidden></div>
    </div>
  </div>
  <div class="rail-footer">
    <span id="rail-count">0 projects</span>
    <button class="rail-add" id="rail-add" title="Add project">${iconPlus}<span>Add</span></button>
    <button class="reck-collapse-chip rail-collapse-chip" id="rail-collapse-chip"
            type="button" title="Expand rail (⇧→)" aria-label="Expand rail">»</button>
  </div>
`;
```

A single row:

```html
<div class="rail-item" data-project-id="…">
  <span class="rail-avatar">            <!-- absolutely pinned; mini only -->
    <span class="rail-avatar-label">rc</span>
    <span class="rail-avatar-badge green"></span>
  </span>
  <span class="name">reck-connect</span>
  <span class="pane-indicator" data-stoplight="orange">
    <span class="pane-indicator-dot green"></span>
    <span class="pane-indicator-dot orange"></span>
  </span>
</div>
```

**Both** the expanded content (name + dots) and the mini content (avatar) exist in
every row, in both modes, at all times. CSS decides which is visible. This is the
mechanism behind every alignment guarantee below.

---

## 10. Base styling

```css
.rail {
  display: flex;
  flex-direction: column;
  background: var(--app-bg);
  overflow-y: auto;
  /* Never a horizontal scroller: in mini the hidden-but-laid-out content
     (footer count/Add, archive) is wider than 48px and must CLIP, not scroll.
     overflow-y:auto alone would compute overflow-x as auto too. */
  overflow-x: hidden;
  padding: 1.25rem 0 0.75rem;
  min-width: 0;
  transition: background 0.25s var(--ease-smooth);
}

.rail-header {
  position: relative;          /* positioning context for .rail-header-mark */
  font-family: var(--font-mono);
  font-size: 0.7rem;
  font-weight: 500;
  letter-spacing: 0.2em;
  text-transform: uppercase;
  color: var(--claude-mid);
  padding: 0 1.25rem;
  margin-bottom: 0.6rem;
}

.rail-divider {
  height: 1px;
  width: 60px;
  background: var(--claude-orange);
  opacity: 0.45;
  margin: 0 1.25rem 1rem;
  /* Morphs to a short centred tick in mini — only width/margins change,
     NEVER the vertical metrics, so the rows below don't shift. */
  transition: width 200ms var(--ease-smooth), margin 200ms var(--ease-smooth);
}

/* Non-scrolling positioned wrapper — the host the OverlayScrollbar mounts
   into. The inner .rail-list is the actual scroller (a bar mounted into the
   scroller itself would scroll away with the content). */
.rail-list-scroll { flex: 1; min-height: 0; position: relative; display: flex; flex-direction: column; }

.rail-list {
  padding: 0 0.5rem;          /* 8px inset — this number feeds the avatar maths */
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  scrollbar-width: none;      /* the overlay bar is the single affordance */
}
.rail-list::-webkit-scrollbar { display: none; }

.rail-item {
  position: relative;          /* positioning context for .rail-avatar */
  display: flex;
  align-items: center;
  gap: 0.6rem;
  padding: 0.85rem 0.9rem;
  border-radius: var(--radius);
  cursor: pointer;
  font-family: var(--font-body);
  font-size: 0.95rem;
  color: var(--app-text);
  transition: background 0.2s var(--ease-smooth), color 0.2s var(--ease-smooth);
  line-height: 1.3;
}

.rail-item:hover { background: var(--app-hover); }

.rail-item.selected {
  background: var(--app-active-bg);
  color: var(--app-text);
  font-weight: 500;
  box-shadow: inset 2px 0 0 var(--claude-orange);   /* orange spine */
}

.rail-item.dragging   { opacity: 0.45; }
.rail-item.drop-before { box-shadow: inset 0  2px 0 0 var(--claude-orange); }
.rail-item.drop-after  { box-shadow: inset 0 -2px 0 0 var(--claude-orange); }

.rail-item .name { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

.rail-footer {
  position: relative;          /* context for the pinned expand chevron */
  transition: margin 200ms var(--ease-smooth), padding 200ms var(--ease-smooth);
  margin-top: 0.5rem;
  padding: 0.75rem 1.25rem 0.75rem;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  font-family: var(--font-mono);
  font-size: 0.65rem;
  font-weight: 500;
  letter-spacing: 0.18em;
  text-transform: uppercase;
  color: var(--app-text-muted);
  border-top: 1px solid var(--app-border);
  margin-left: 0.75rem;
  margin-right: 0.75rem;
  padding-top: 0.75rem;
}
```

Row height, for reference downstream: `0.85rem × 2` padding plus a
`0.95rem / 1.3` line ≈ **2.95 rem**.

---

## 11. The mini rail, and the y-level invariants

### 11.1 The crossfade contract

```css
/* Mode-switch crossfade: every element that changes form between the expanded
   and mini rail carries its own opacity/visibility transition keyed off
   .rail-mini, fading IN PLACE while the boot layer's rAF animator drives the
   grid width. The transition on the DESTINATION ruleset governs each
   direction: outgoing content fades fast (100ms, so the stoplight dots never
   linger mid-flight at a wrong offset from the rail edge); incoming content
   fades in once the width is most of the way there (140ms + a short delay).
   `visibility` must ALWAYS ride the same transition list as `opacity` — its
   discrete interpolation keeps the element visible for the whole fade, then
   drops it from hit-testing at the end; splitting them causes a pop.
   Everything keeps its layout box in both modes (visibility, not display) so
   the switch has ZERO vertical motion. */

/* Hidden in mini */
.rail-item .name,
.rail-item .pane-indicator,
.rail-header-text,
.rail-archive,
.rail-footer #rail-count,
.rail-add {
  transition: opacity 140ms var(--ease-smooth) 60ms, visibility 140ms 60ms;
}
.rail.rail-mini .rail-item .name,
.rail.rail-mini .rail-item .pane-indicator,
.rail.rail-mini .rail-header-text,
.rail.rail-mini .rail-archive,
.rail.rail-mini .rail-footer #rail-count,
.rail.rail-mini .rail-add {
  opacity: 0;
  visibility: hidden;
  transition: opacity 100ms var(--ease-smooth), visibility 100ms;
}
```

Timings, stated plainly:

| Direction | opacity | delay |
|---|---|---|
| Fading **out** (expanded → mini content, mini → expanded content) | 100 ms | 0 |
| Fading **in** | 140 ms | 40 ms (avatar, mark, chip) / 60 ms (names, dots, header text, archive, footer) |

Out is faster than in, and in is delayed, so the two never overlap muddily and
the outgoing dots never linger at a wrong offset while the column narrows.

### 11.2 x = 24: one centre line for all three mini glyphs

The mini rail is 48 px, so its centre is **x = 24**. Three different elements
land there by three different routes; all three must agree:

```css
/* 1. The brand mark — the reck diamond, orange with a punched dot, same
      language as build/icon.svg and the nav-brand dot. Pinned to the centre
      of the 48px column so it crossfades IN PLACE with the "Projects" text
      instead of sliding while the width animates. */
.rail-header-mark {
  position: absolute;
  left: 24px;
  top: 50%;
  width: 11px;
  height: 11px;
  background: var(--claude-orange);
  border-radius: 2px;
  transform: translate(-50%, -50%) rotate(45deg);
  display: grid;
  place-items: center;
  opacity: 0;
  visibility: hidden;
  transition: opacity 100ms var(--ease-smooth), visibility 100ms;
}
.rail-header-mark::after {          /* the punched dot */
  content: "";
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: var(--app-bg);
}
.rail.rail-mini .rail-header-mark {
  opacity: 1;
  visibility: visible;
  transition: opacity 140ms var(--ease-smooth) 40ms, visibility 140ms 40ms;
}

/* 2. The expand chevron, pinned to the same centre line. */
.rail-collapse-chip {
  position: absolute;
  left: 24px;
  top: 50%;
  transform: translate(-50%, -50%);
  opacity: 0;
  visibility: hidden;
  transition: opacity 100ms var(--ease-smooth), visibility 100ms;
}
.rail.rail-mini .rail-collapse-chip {
  opacity: 1; visibility: visible;
  transition: opacity 140ms var(--ease-smooth) 40ms, visibility 140ms 40ms;
}

/* 3. The initials avatar — absolutely pinned so it takes NO flex space in
      either mode. Rows are inset 8px by .rail-list, so left: 1px centres the
      30px square in the 48px rail:  8 + 1 + 15 = 24. */
.rail-avatar {
  position: absolute;
  left: 1px;
  top: 50%;
  transform: translateY(-50%);
  width: 30px;
  height: 30px;
  display: grid;
  place-items: center;
  border: 1px solid var(--app-border);
  border-radius: var(--radius);
  background: var(--app-bg-raised);
  font-family: var(--font-mono);
  font-size: 0.62rem;
  letter-spacing: 0.03em;
  color: var(--app-text-dim);
  opacity: 0;
  visibility: hidden;
  transition: opacity 100ms var(--ease-smooth), visibility 100ms,
              border-color 0.15s var(--ease-smooth), box-shadow 0.2s var(--ease-smooth);
}
/* Scoped to the ACTIVE list on purpose: an unscoped `.rail-item` also matches
   archived rows and would resurrect their hit boxes inside the hidden
   Archive section. */
.rail.rail-mini .rail-list .rail-item .rail-avatar {
  opacity: 1; visibility: visible;
  transition: opacity 140ms var(--ease-smooth) 40ms, visibility 140ms 40ms,
              border-color 0.15s var(--ease-smooth), box-shadow 0.2s var(--ease-smooth);
}

/* 4. And the divider tick: width 16 with margin-left 16 puts its centre at
      16 + 8 = 24 as well. Only width/side-margins change — the vertical
      metrics are untouched, so the first row sits at an IDENTICAL y in both
      modes. */
.rail.rail-mini .rail-divider {
  width: 16px;
  margin-left: 16px;
  margin-right: 16px;
}
```

**If you change `.rail-list`'s 8 px padding or the 30 px avatar, you must
re-derive `left` so the avatar centre stays at 24, or the avatars will drift
off the mark/chevron centre line during the collapse.**

### 11.3 y-level invariants — the rules that must not be broken

1. **Never `display: none` anything that differs between modes.** Use
   `visibility` + `opacity` so the layout box survives and nothing reflows.
2. **The header keeps its `padding: 0 1.25rem` and `margin-bottom: 0.6rem` in
   both modes.** The brand mark is `position: absolute` inside it at
   `top: 50%`, so it occupies the exact vertical centre of the box the
   "Projects" text occupied. The logo does not move a pixel as the text fades
   out beneath it.
3. **The divider changes only `width` and side margins.** Its `height: 1px` and
   `margin-bottom: 1rem` are mode-invariant, so everything below it — the whole
   project list — keeps its y.
4. **Mini rows keep the exact expanded box** (padding, height): every avatar
   sits at the same y as its expanded row. Selection and hover just move from
   the row to the avatar.

```css
.rail.rail-mini .rail-item {
  box-shadow: none;    /* the orange spine belongs to the expanded row only */
  background: none;    /* hover/selected move onto the avatar */
}
```

5. **The footer goes full-bleed in mini** so its `border-top` spans all 48 px.
   The chevron is absolutely pinned, so no flex re-centring is needed, and the
   invisible count/Add boxes stay near the column (the `.rail` `overflow-x:
   hidden` clips the remainder).

```css
.rail.rail-mini .rail-footer {
  margin-left: 0; margin-right: 0; padding-left: 0; padding-right: 0;
}
```

6. **Reduced motion snaps the fades too**, because the width animator already
   jumps:

```css
@media (prefers-reduced-motion: reduce) {
  /* !important so this beats the higher-specificity .rail.rail-mini rules. */
  .rail-item .name, .rail-item .pane-indicator, .rail-header-text,
  .rail-header-mark, .rail-divider, .rail-archive, .rail-footer,
  .rail-footer #rail-count, .rail-add, .rail-avatar, .rail-collapse-chip {
    transition: none !important;
  }
}
```

### 11.4 Mini avatar states

```css
/* Selected avatar: orange ink + the same resting ring the History button's
   aria-pressed state uses — the state IS the hue. */
.rail.rail-mini .rail-item.selected .rail-avatar {
  border-color: var(--claude-orange);
  color: var(--claude-orange);
  box-shadow: 0 0 0 1px rgba(212, 104, 58, 0.7), 0 0 10px 2px rgba(232, 135, 92, 0.35);
}

/* Non-selected hover: subtle border lift only. :not(.selected) so it can never
   stomp the selected treatment. */
.rail.rail-mini .rail-item:not(.selected):hover .rail-avatar {
  border-color: var(--app-border-strong);
}

/* Hovering the SELECTED avatar strengthens the orange (ring holds, halo grows). */
.rail.rail-mini .rail-item.selected:hover .rail-avatar {
  box-shadow: 0 0 0 1px rgba(212, 104, 58, 0.7), 0 0 14px 3px rgba(232, 135, 92, 0.5);
}
```

### 11.5 Initials

```ts
/**
 * Two-character initials for the mini rail's project avatars. Two words
 * (split on whitespace, hyphens, underscores, dots, slashes) → first character
 * of each; a single word → its first two characters. Unicode-aware (spread,
 * not charAt) so astral/CJK names don't split surrogate pairs.
 */
export function projectInitials(name: string): string {
  const words = name.trim().split(/[\s\-_./]+/u).filter((w) => w.length > 0);
  if (words.length === 0) return "?";
  if (words.length === 1) return [...words[0]].slice(0, 2).join("").toLowerCase();
  return ([...words[0]][0] + [...words[1]][0]).toLowerCase();
}
```

| input | output | | input | output |
|---|---|---|---|---|
| `reck-connect` | `rc` | | `docs` | `do` |
| `capero web` | `cw` | | `a` | `a` |
| `snake_case_name` | `sc` | | `Mixed Case` | `mc` |
| `dotted.name` | `dn` | | `  padded   words  ` | `pw` |
| `path/like` | `pl` | | `émile-zola` | `éz` |
| `three word name` | `tw` | | `日本語` | `日本` |
| `--weird--` | `we` | | `""` / `"   "` | `?` |

The avatar's `title` is always the **full** project name — the initials are an
abbreviation and the tooltip is what de-abbreviates them.

---

## 12. Row content: stoplight dots

Each row shows one small dot per pane, colour-coded, capped at 6.

```ts
const MAX_INDICATOR_DOTS = 6;
const DOT_EXIT_MS = 220;
```

### 12.1 Resolving the per-pane list

```ts
/**
 * Fallback chain:
 *   1. Legacy daemon (no `pane_stoplights`): broadcast the project aggregate
 *      across `pane_count` dots, with a one-dot baseline for zero-pane projects.
 *   2. No `pane_ids`, or no layout order supplied: emit `pane_stoplights` as-is
 *      (daemon creation order).
 *   3. Both present: rebuild the list in LAYOUT order (left-to-right,
 *      top-to-bottom) — drop layout entries the daemon doesn't know about
 *      (closed panes still in the saved tree), append daemon panes the layout
 *      doesn't mention (just created) at the end so none is ever lost.
 */
function resolvePaneStoplights(p: Project, layoutOrder: string[] | null): Stoplight[] {
  if (p.pane_stoplights === undefined) {
    const n = Math.max(1, p.pane_count);
    return new Array(n).fill(p.stoplight);
  }
  const stoplights = p.pane_stoplights;
  if (!layoutOrder || !p.pane_ids || p.pane_ids.length !== stoplights.length) {
    return stoplights;
  }
  const byId = new Map<string, Stoplight>();
  for (let i = 0; i < p.pane_ids.length; i++) byId.set(p.pane_ids[i], stoplights[i]);
  const out: Stoplight[] = [];
  const seen = new Set<string>();
  for (const id of layoutOrder) {
    if (seen.has(id)) continue;
    const s = byId.get(id);
    if (s === undefined) continue;
    out.push(s);
    seen.add(id);
  }
  for (let i = 0; i < p.pane_ids.length; i++) {
    if (!seen.has(p.pane_ids[i])) out.push(stoplights[i]);
  }
  return out;
}

// Higher = more severe: red 3 > orange 2 > green 1 > gray 0.
function aggregateStoplight(stoplights: Stoplight[]): Stoplight {
  let best: Stoplight = "gray";
  for (const s of stoplights) if (stoplightSeverity(s) > stoplightSeverity(best)) best = s;
  return best;
}
```

### 12.2 Reconciling the dot elements

Recolour in place; only add/remove when the count changes. Colour flips must not
churn the DOM or replay the enter animation.

```ts
function syncIndicatorDots(container: HTMLElement, stoplights: Stoplight[],
                           opts: { skipAnimation?: boolean } = {}) {
  // A zero-pane project still renders ONE gray dot so the indicator has a
  // fixed shape.
  const target: Stoplight[] =
    stoplights.length === 0 ? (["gray"] as Stoplight[])
                            : stoplights.slice(0, MAX_INDICATOR_DOTS);

  container.dataset.stoplight = aggregateStoplight(target);

  const liveDots = Array.from(container.children)
    .filter((c) => !(c as HTMLElement).classList.contains("leaving")) as HTMLElement[];

  for (let i = 0; i < liveDots.length && i < target.length; i++) {
    const dot = liveDots[i];
    const entering = dot.classList.contains("entering");
    const desired = `pane-indicator-dot ${target[i]}${entering ? " entering" : ""}`;
    if (dot.className !== desired) dot.className = desired;
  }

  if (target.length > liveDots.length) {
    for (let i = liveDots.length; i < target.length; i++) {
      const dot = document.createElement("span");
      dot.className = `pane-indicator-dot ${target[i]}`;
      if (!opts.skipAnimation) dot.classList.add("entering");
      container.appendChild(dot);
      if (!opts.skipAnimation) requestAnimationFrame(() => dot.classList.remove("entering"));
    }
  } else if (target.length < liveDots.length) {
    for (const dot of liveDots.slice(target.length)) {
      if (opts.skipAnimation) dot.remove();
      else {
        dot.classList.add("leaving");
        setTimeout(() => dot.remove(), DOT_EXIT_MS);
      }
    }
  }
}
```

`setProjects` skips all of this when `stoplights.join(",")` is unchanged
(`row.lastStoplightsKey`).

### 12.3 Dot and badge styling — shape escalates with severity

```css
.pane-indicator { display: inline-flex; align-items: center; gap: 4px; flex-shrink: 0; }

.pane-indicator-dot {
  --dot-rotate: 0deg;
  --dot-scale: 1;
  width: 6px; height: 6px;
  border-radius: 50%;
  background: var(--sl-gray);
  transform: rotate(var(--dot-rotate)) scale(var(--dot-scale));
  transition: background 0.35s var(--ease-smooth),
              border-radius 0.45s var(--ease-smooth),
              opacity 0.22s var(--ease-smooth),
              transform 0.22s var(--ease-smooth);
}
/* round → rounded square → diamond → sharp square */
.pane-indicator-dot.gray   { background: var(--sl-gray);   border-radius: 50%; }
.pane-indicator-dot.green  { background: var(--sl-green);  border-radius: 35%; }
.pane-indicator-dot.orange { background: var(--sl-orange); border-radius: 15%; --dot-rotate: 45deg; --dot-scale: 0.9; }
.pane-indicator-dot.red    { background: var(--sl-red);    border-radius: 1px; }

.pane-indicator-dot.entering,
.pane-indicator-dot.leaving { opacity: 0; --dot-scale: 0.4; }
```

The mini avatar carries the **aggregate** as a corner badge. It mirrors the dot
scale but is deliberately **not** `.pane-indicator-dot` — dot-count selectors and
tests must not match it.

```css
.rail-avatar-badge {
  position: absolute;
  right: -2px; bottom: -2px;
  width: 6px; height: 6px;
  border-radius: 50%;
  background: var(--sl-gray);
  transition: background 0.35s var(--ease-smooth), border-radius 0.45s var(--ease-smooth);
}
.rail-avatar-badge.gray   { background: var(--sl-gray);   border-radius: 50%; }
.rail-avatar-badge.green  { background: var(--sl-green);  border-radius: 35%; }
.rail-avatar-badge.orange { background: var(--sl-orange); border-radius: 15%; transform: rotate(45deg) scale(0.9); }
.rail-avatar-badge.red    { background: var(--sl-red);    border-radius: 1px; }
```

```ts
function syncAvatarBadge(row: RailRow) {
  const agg = row.indicatorEl.dataset.stoplight ?? "gray";
  row.avatarBadgeEl.className = `rail-avatar-badge ${agg}`;
}
```

Palette tokens:

```css
--sl-gray:   var(--claude-mid);     /* #8a877d */
--sl-green:  var(--wes-sage);       /* #7a9c6d */
--sl-orange: var(--wes-mustard);    /* #c9982e */
--sl-red:    var(--wes-rose);       /* #c8726e */
```

---

## 13. Interactions

### 13.1 The whole rail is a mode toggle

```ts
// Clicking any EMPTY area (non-row, non-button, non-scrollbar) springs mini
// open and retracts expanded back to mini.
this.props.root.addEventListener("click", (e) => {
  // `.reck-scrollbar` matters only in expanded mode: releasing a scrollbar
  // drag lands a click on the thumb, inside the rail but outside any row.
  if ((e.target as HTMLElement).closest(".rail-item, button, .reck-scrollbar")) return;
  // A click that ends a text drag-selection (the "Projects" header, the footer
  // count) is a selection gesture, not a toggle. Scoped to a selection
  // anchored INSIDE the rail.
  const sel = window.getSelection();
  if (sel && !sel.isCollapsed && sel.anchorNode && this.props.root.contains(sel.anchorNode)) return;
  if (this.props.root.classList.contains("rail-mini")) this.props.onExpand?.();
  else this.props.onCollapse?.();
});
```

### 13.2 Select

```ts
onSelect: (projectId) => {
  const proj = currentProjects.find((p) => p.id === projectId);
  if (proj?.archived) { void requestUnarchive(projectId); return; }  // confirm-then-restore
  if (railMode === "mini") setRailMode("expanded");  // avatar click also expands
  void selectProject(projectId);
}
```

Rows never toggle the mode by themselves when expanded — clicking a row only
selects.

### 13.3 Rename (double-click the name)

Replace the `<span class="name">` with an `<input class="name-edit">`, focus and
select. Enter commits, Escape reverts, blur commits. Disable `draggable` on the
row for the duration and restore it afterwards. Rebuild a fresh `<span>` on
finish (and re-attach its `dblclick`), update `row.nameEl` / `row.lastName`, and
re-derive the avatar initials via `setAvatarName`. The caller paints the new name
optimistically and rolls back if the daemon rejects it.

```css
.rail-item .name-edit {
  flex: 1;
  min-width: 40px;
  outline: none;
  background: var(--app-input-bg);
  border: 1px solid var(--claude-orange);
  border-radius: 3px;
  padding: 2px 6px;
  color: var(--app-text);
  font: inherit;
  font-size: 0.95rem;
  font-family: var(--font-body);
}
```

### 13.4 Reorder (drag within the active list)

- `dragstart`: record `draggedId` + `draggedArchived`, `effectAllowed = "move"`,
  `setData("text/plain", id)`, add `.dragging`.
- `dragover` on a row: ignore self and any cross-zone drag; the midpoint of the
  row's `getBoundingClientRect()` decides `.drop-before` vs `.drop-after`.
- `drop`: `computeReorder(orderedIds, draggedId, targetId, "before"|"after")`.
- `dragend`: clear every marker class on every row and both zones.

`orderedIds` is always **active first, then archived**, so an active↔active move
never drops archived projects from the persisted order.

### 13.5 Archive

The Archive section is **always rendered** so it is a permanent drop target. When
empty it shows a `.rail-archive-empty` placeholder inside the (collapsible)
folder. Drag an active row onto the section → archive; drag an archived row onto
`.rail-list` → unarchive (behind a confirm).

```css
.rail-archive { flex-shrink: 0; margin: 0.25rem 0.75rem 0; border-top: 1px solid var(--app-border); }
.rail-archive.drop-target,
.rail-list.drop-target {
  box-shadow: inset 0 0 0 1px var(--claude-orange);
  border-radius: var(--radius);
}
.rail-archive.drop-target { background: var(--app-hover); }

.rail-archive-caret { display: inline-block; font-size: 0.7rem; transition: transform 0.15s var(--ease-smooth); }
.rail-archive:not(.collapsed) .rail-archive-caret { transform: rotate(90deg); }

.rail-archive-list {
  padding: 0 0.5rem 0.35rem;
  /* Cap at ~3.5 rail rows then scroll — the half row makes it obvious there is
     more below. A rail row is ~2.95rem (0.85rem padding × 2 + 0.95rem/1.3 line). */
  max-height: calc(2.95rem * 3.5);
  overflow-y: auto;
  scrollbar-width: none;
}

.rail-item.archived { opacity: 0.55; font-style: italic; }
.rail-item.archived:hover { opacity: 0.85; }
.rail-item.archived .pane-indicator { display: none; }   /* asleep: no live dots */
```

### 13.6 Context menu (right-click a row)

A fixed-position menu at the click point, dismissed by any outside click or
Escape (listeners attached in a `setTimeout(…, 0)` so the opening click doesn't
immediately close it). Items: **Open in Finder**, **Archive/Unarchive** (label
flips on state), **Delete Project…** (`.danger`, red).

```css
.rail-context-menu {
  position: fixed; z-index: 1000; min-width: 180px;
  background: var(--app-bg-raised);
  border: 1px solid var(--app-border);
  border-radius: 8px; padding: 4px;
  box-shadow: 0 8px 24px rgba(0, 0, 0, 0.35);
  font-size: 13px; color: var(--app-text);
}
.rail-context-menu button {
  display: block; width: 100%;
  background: transparent; border: 0;
  padding: 6px 10px; text-align: left;
  color: inherit; border-radius: 4px; cursor: pointer;
}
.rail-context-menu button:hover { background: var(--app-hover); }
.rail-context-menu button.danger { color: var(--wes-rose); }
```

---

## 14. Accessibility & the mini-mode inert rule

This is the one place where the pure crossfade is **not enough**, and it caused
a real bug (#163, PR #165). Archived rows are `.rail-item`s *inside*
`#rail-archive`, so a broad mini-avatar rule re-asserts `visibility: visible` on
them and hands their hit box back — while the ancestor's `opacity: 0` (a group
opacity no descendant can undo) keeps them invisible. Invisible-but-clickable.

Four layers, all required:

```ts
setMode(mode: RailMode) {
  const mini = mode === "mini";
  this.props.root.classList.toggle("rail-mini", mini);
  this.archiveSectionEl.inert = mini;                    // (1) focus order + a11y tree
  if (mini) this.archiveSectionEl.setAttribute("aria-hidden", "true");
  else this.archiveSectionEl.removeAttribute("aria-hidden");
}

/** (2) The guard every handler consults — jsdom has no layout, so the CSS
 *  barrier alone would let the regression back in unnoticed. */
private isArchiveInert(): boolean {
  return this.props.root.classList.contains("rail-mini");
}
private isInertArchiveRow(el: HTMLElement): boolean {
  return this.isArchiveInert() && this.archiveSectionEl.contains(el);
}
```

```css
/* (3) */
.rail.rail-mini .rail-archive { pointer-events: none; }
/* (4) …and `pointer-events` is overridable by a descendant exactly the way
   `visibility` is. The archive's OverlayScrollbar mounts INSIDE #rail-archive
   and `.reck-scrollbar.visible` sets `pointer-events: auto`, which would hand
   back an invisible 10px draggable strip. Kill it here too. */
.rail.rail-mini .rail-archive .reck-scrollbar { pointer-events: none; }
```

`isInertArchiveRow` must be checked in **every** row handler — `click`,
`contextmenu` (it offers "Delete Project…"), `dragstart` (dropping on the active
list would unarchive an unseen project) and the name `dblclick`. Guarding only
the click reproduces the bug through another door.

The mini-mode avatar reveal rule is scoped `.rail.rail-mini .rail-list
.rail-item .rail-avatar` — **`.rail-list`, not just `.rail-item`** — for the
same reason.

---

## 15. Scrollbars

The rail's list and the Archive folder use the app's shared auto-hiding overlay
scrollbar (the same orange fade-bar as terminals, markdown and transcripts), not
the OS gutter. Mount the bar on the **non-scrolling wrapper** and drive it from
the **inner scroller** — a bar mounted into the scroller would scroll away with
the content.

```ts
this.listScrollbar = createOverlayScrollbar({
  host: this.props.root.querySelector(".rail-list-scroll") as HTMLElement,
  surface: domScrollSurface(this.listEl),
});
this.archiveScrollbar = createOverlayScrollbar({
  host: this.props.root.querySelector(".rail-archive-scroll") as HTMLElement,
  surface: domScrollSurface(this.archiveListEl),
});
```

Call `.update()` manually after anything that changes the scroll extent — adding
or removing rows, and expanding/collapsing the Archive — because a pure content
change fires neither `scroll` nor `resize`.

```css
.reck-scrollbar {
  position: absolute; top: 2px; right: 2px; bottom: 2px;
  width: 10px; z-index: 25;
  opacity: 0; pointer-events: none;
  transition: opacity 0.45s var(--ease-smooth, ease);
}
.reck-scrollbar.visible { opacity: 1; pointer-events: auto; }
.reck-scrollbar-thumb {
  position: absolute; right: 0; width: 8px; min-height: 24px;
  border-radius: 6px;
  background: var(--claude-orange-glow, #e8875c);
  opacity: 0.6; cursor: grab;
  transition: opacity 0.15s ease;
}
```

Defaults: 1400 ms idle before fade-out, minimum thumb 8 % of the track.

---

## 16. Keyboard

| Action | Shortcut |
|---|---|
| Toggle rail (expanded ⟷ mini) | ⌘B (nav button, same handler) |
| Collapse rail to mini | ⌘⇧← — also bare ⇧← |
| Expand rail | ⌘⇧→ — also bare ⇧→ |
| Jump to project 1–8 | ⌘1 – ⌘8 |
| Toggle via divider | double-click the divider |

```ts
// The bare ⇧←/⇧→ variant is checked BEFORE the mod gate, and only fires when
// focus is outside a text-entry surface — xterm owns a hidden <textarea>, and
// stealing shift+arrow from the PTY would break selection keys mid-session.
function isTextEntryTarget(el: Element | null): boolean {
  if (!el) return false;
  const tag = el.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  return (el as HTMLElement).isContentEditable === true;
}

if (!mod && !e.altKey && e.shiftKey && (key === "ArrowLeft" || key === "ArrowRight")) {
  if (!isTextEntryTarget(document.activeElement)) {
    e.preventDefault();
    if (key === "ArrowLeft") handlers.onCollapseRail();
    else handlers.onExpandRail();
  }
  return;   // fall through untouched (no preventDefault) when typing
}
```

Both map to `setRailMode("mini" | "expanded")` — idempotent, so holding the key
does nothing extra.

---

## 17. Persistence

Mode and expanded width persist **independently**, so the rail restores exactly
as the user left it.

```ts
// config.ts
export async function loadRailWidth(): Promise<number | null> {
  return (await window.reckAPI.config.get<number>("railWidth")) ?? null;
}
export async function saveRailWidth(w: number) {
  await window.reckAPI.config.set("railWidth", w);
}

// Any value that isn't exactly "mini" resolves to "expanded" — the safe default
// for malformed or pre-feature configs.
export async function loadRailMode(): Promise<RailMode> {
  const raw = await window.reckAPI.config.get<string>("railMode");
  return raw === "mini" ? "mini" : "expanded";
}
export async function saveRailMode(mode: RailMode) {
  await window.reckAPI.config.set("railMode", mode);
}
```

| Key | Type | Default | Written when |
|---|---|---|---|
| `railWidth` | number | `RAIL_MAX` (240) | drag release (`stay` / `bounce-back`) |
| `railMode` | `"expanded" \| "mini"` | `"expanded"` | every `setRailMode`, and the live mid-drag re-expand |
| `railWiggleEnabled` | boolean | `true` | Preferences save |
| `railWigglePixels` | number | `12` | Preferences save |
| `railWiggleLegMs` | number | `240` | Preferences save |
| project order | string[] | daemon order | reorder drop |

---

## 18. Public API of the `Rail` class

```ts
export interface RailProps {
  root: HTMLElement;
  onSelect: (projectId: string) => void;
  onAddProject: () => void;
  onRename?: (projectId: string, newName: string) => void;
  onReorder?: (newIds: string[]) => void;
  onRequestDelete?: (projectId: string, projectName: string) => void;
  onOpenInFinder?: (projectId: string) => void;
  /** `archived` is the DESIRED new state. The confirm-before-restore prompt
   *  lives in the handler, not here — the rail only reports intent. */
  onToggleArchive?: (projectId: string, archived: boolean) => void;
  /** Fired by the footer "»" chevron (mini only) and by an empty-area click
   *  while mini. */
  onExpand?: () => void;
  /** Mirror of onExpand: an empty-area click while expanded retracts the rail.
   *  Project rows are NOT part of this — clicking a row only selects. */
  onCollapse?: () => void;
  /** Return paneIds in the project's saved layout order (left-to-right,
   *  top-to-bottom). `null` falls back to the daemon's creation order. */
  getLayoutPaneOrder?: (projectId: string) => string[] | null;
}

class Rail {
  constructor(props: RailProps);
  setProjects(projects: Project[]): void;   // full reconcile, keyed by id
  select(projectId: string | null): void;
  setMode(mode: "expanded" | "mini"): void; // pure class toggle; boot owns the width
}
```

`setProjects` must be a **reconcile**, not a re-render: rows are cached in a
`Map<string, RailRow>` and reused. Each row caches `lastStoplightsKey`,
`lastName`, `lastArchived` and only touches the DOM on a real change. Rows are
moved between the active and Archive containers with
`insertBefore(row.el, container.children[i] ?? null)`. This is what keeps the
pane-dot enter/exit animations and an in-progress rename from being destroyed by
the poll loop.

Footer count:

```ts
this.footerCountEl.textContent = count === 1 ? "1 project" : `${count} projects`;
```

— **active projects only**; archived ones are counted in the Archive header badge.

---

## 19. Acceptance checklist

Geometry & collapse
- [ ] Grid is `${railWidth}px 6px 1fr`, written from JS every frame; no CSS width transition anywhere.
- [ ] Drag from 240 down: live resize to 171, then elastic damping at 0.35, then collapse at 138 (139 still stretches).
- [ ] Release at 170 bounces back to 171; release at 171 stays.
- [ ] Drag out of mini: tracks the pointer from 48; crosses to `expand` above 171; release at ≥ 72 springs open, below settles to 48.
- [ ] Every mode snap is 200 ms `easeOutBack` (visible overshoot), both directions.
- [ ] Persisted width is clamped to [48, 240] on load; `NaN`/garbage falls back to 240.

Alignment (the y-level rules)
- [ ] Collapsing produces **zero** vertical motion anywhere in the rail.
- [ ] The brand mark appears at the exact vertical centre of the box "Projects" occupied, and does not slide horizontally during the width animation.
- [ ] Brand mark, expand chevron, divider tick and every avatar all centre on **x = 24** in mini.
- [ ] The divider changes only width and side margins; the first row's y is identical in both modes.
- [ ] Every mini avatar sits at the same y as its expanded row.

Crossfade
- [ ] Outgoing content fades in 100 ms with no delay; incoming in 140 ms after 40 ms (glyphs) / 60 ms (text).
- [ ] `visibility` is always in the same transition list as `opacity`.
- [ ] Nothing uses `display: none` to switch modes.
- [ ] `prefers-reduced-motion` snaps both the width and every fade.

Wiggle
- [ ] Project switch wiggles only when the preference is on; tab switch wiggles regardless.
- [ ] Re-clicking the already-active tab does **not** wiggle.
- [ ] Two chained legs land exactly back on the base width.
- [ ] A wiggle requested mid-animation retries exactly once, 240 ms later, carrying `force`.
- [ ] `mousedown` on the divider cancels a wiggle and restores the base; a mode change cancels without restoring.
- [ ] `refitActiveTerminals()` runs after the wiggle even under reduced motion.

Mini-mode safety
- [ ] The Archive is `inert` + `aria-hidden` + `pointer-events: none`, including its overlay scrollbar.
- [ ] An archived row in mini cannot be clicked, right-clicked, dragged or rename-double-clicked.
- [ ] The avatar reveal rule is scoped to `.rail-list`.

Rows
- [ ] Dot colours recolour in place; only count changes add/remove nodes (220 ms exit).
- [ ] Max 6 dots; a zero-pane project shows exactly one gray dot.
- [ ] The avatar badge is the aggregate (red > orange > green > gray) and is never `.pane-indicator-dot`.
- [ ] Initials match the table in §11.5, including CJK and the `?` fallback.
- [ ] A rename in progress survives a projects poll.
