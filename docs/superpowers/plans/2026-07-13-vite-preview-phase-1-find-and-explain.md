# Vite Preview — Phase 1: Find & Explain — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make a Vite app that lives in a **subdirectory** of a project (monorepo) render its `.tsx`, and make every non-render state show the user *why* instead of silently falling back to the source editor.

**Architecture:** Add a walk-up detector that finds the nearest Vite+React app root at or above a clicked file (bounded by the project root) and returns the app's path relative to the project plus the target's path relative to the app. Thread that app-relative path to the daemon so its Vite runner roots at the subdirectory; the daemon restarts its per-project runner when the app root changes (one preview per project). Surface the detector's `reason` in the viewer as a "why" card instead of discarding it.

**Tech Stack:** TypeScript (satellite main + renderer, Electron, vitest), Go (daemon, `go test`), a `go:embed`-ed Node/Vite runner.

## Global Constraints

- **Spec:** `docs/superpowers/specs/2026-07-13-vite-preview-lifecycle-design.md`. This plan is **Phase 1** only.
- **One active Vite preview per project.** If the requested app root differs from the running one, the daemon **restarts** (never runs two).
- **`appRelPath` convention:** the app dir relative to the project root. `""` means "the project root *is* the app" (existing root-level case). Must never contain `..` or a leading `/` — validated daemon-side.
- **Detection stays pure `node:fs`** in `project-detect.ts` (no Electron import) so unit tests need no mock.
- **Reason is a stable key**, not a sentence — the renderer maps keys → copy. Keys: `"ok" | "no-vite-app" | "vite-no-react" | "read-error"`.
- **No behaviour change for existing cases:** root-level Vite projects (`appRelPath=""`), `.html`, `.md`, and non-component files must render exactly as today.
- Commit after every task with the shown message.

---

## File Structure

**Create:**
- none (all changes extend existing files).

**Modify:**
- `satellite/main/project-detect.ts` — add `detectPreviewForFile` (walk-up) + `FilePreviewInfo`.
- `satellite/main/project-detect.test.ts` — walk-up unit tests.
- `satellite/main/file-viewer.ts` — change the `preview:detect` IPC to take `(projectRootMac, filePathMac)` and return `FilePreviewInfo`.
- `satellite/preload/preload.ts` — update `preview.detect` signature.
- `satellite/renderer/src/viewer/stationPreviewDetect.ts` — add `detectStationPreviewForFile` (walk-up over the readFile fn).
- `proto/proto.go`, `proto/proto.ts` — add `AppRelPath` to `PreviewStartRequest`.
- `daemon/internal/http/router.go` — `handleStartPreview` joins/validates the app subdir.
- `daemon/internal/preview/manager.go` — `Start` restarts when `cwd` changes for a project.
- `satellite/renderer/src/viewer/ComponentPreview.ts` — `PreviewApi.startPreview` + options carry `appRelPath`.
- `satellite/renderer/src/viewer/FileViewerHost.ts` — both gates: use the walk-up result, thread `appRelPath`, surface `reason`.
- `satellite/renderer/src/viewer/previewReason.ts` *(new small module)* — map reason key → user copy; single source for the "why" card.

---

## Task 1: Walk-up detector `detectPreviewForFile`

**Files:**
- Modify: `satellite/main/project-detect.ts` (add alongside `detectProjectPreview` at L52-82; reuse `VITE_CONFIGS` L24-30, `exists` L32-39, `asRecord` L85-90)
- Test: `satellite/main/project-detect.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface FilePreviewInfo {
    previewable: boolean;
    appRelPath: string;    // app dir relative to projectRoot; "" = project root is the app; "" when not previewable
    targetRelPath: string; // target file relative to the app root; "" when not previewable
    reason: "ok" | "no-vite-app" | "vite-no-react" | "read-error";
  }
  export function detectPreviewForFile(projectRoot: string, filePath: string): Promise<FilePreviewInfo>
  ```
- Consumes: existing `VITE_CONFIGS`, `exists`, `asRecord` in the same file.

- [ ] **Step 1: Write the failing tests**

Add to `satellite/main/project-detect.test.ts`:
```ts
import { detectPreviewForFile } from "./project-detect";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

function scaffold(): string {
  const root = mkdtempSync(join(tmpdir(), "reck-detect-"));
  return root;
}

describe("detectPreviewForFile (walk-up)", () => {
  it("finds a Vite+React app in a monorepo subdir", async () => {
    const root = scaffold();
    const app = join(root, "apps", "dashboard-v2");
    mkdirSync(join(app, "src"), { recursive: true });
    writeFileSync(join(app, "package.json"), JSON.stringify({ dependencies: { vite: "5", react: "18" } }));
    const info = await detectPreviewForFile(root, join(app, "src", "App.tsx"));
    expect(info).toEqual({ previewable: true, appRelPath: "apps/dashboard-v2", targetRelPath: "src/App.tsx", reason: "ok" });
    rmSync(root, { recursive: true, force: true });
  });

  it("treats a root-level Vite app as appRelPath=''", async () => {
    const root = scaffold();
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "vite.config.ts"), "export default {}");
    writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { react: "18" } }));
    const info = await detectPreviewForFile(root, join(root, "src", "App.tsx"));
    expect(info).toEqual({ previewable: true, appRelPath: "", targetRelPath: "src/App.tsx", reason: "ok" });
    rmSync(root, { recursive: true, force: true });
  });

  it("reports no-vite-app when nothing up the tree is Vite", async () => {
    const root = scaffold();
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { react: "18" } }));
    const info = await detectPreviewForFile(root, join(root, "src", "App.tsx"));
    expect(info.previewable).toBe(false);
    expect(info.reason).toBe("no-vite-app");
    rmSync(root, { recursive: true, force: true });
  });

  it("reports vite-no-react when the nearest Vite app lacks React", async () => {
    const root = scaffold();
    const app = join(root, "apps", "cli");
    mkdirSync(join(app, "src"), { recursive: true });
    writeFileSync(join(app, "vite.config.ts"), "export default {}");
    writeFileSync(join(app, "package.json"), JSON.stringify({ dependencies: { vite: "5" } }));
    const info = await detectPreviewForFile(root, join(app, "src", "main.tsx"));
    expect(info.previewable).toBe(false);
    expect(info.reason).toBe("vite-no-react");
    rmSync(root, { recursive: true, force: true });
  });

  it("does not walk above the project root", async () => {
    const root = scaffold();
    // a Vite app ABOVE the project root must be ignored
    writeFileSync(join(root, "vite.config.ts"), "export default {}");
    writeFileSync(join(root, "package.json"), JSON.stringify({ dependencies: { vite: "5", react: "18" } }));
    const proj = join(root, "packages", "inner");
    mkdirSync(join(proj, "src"), { recursive: true });
    writeFileSync(join(proj, "package.json"), JSON.stringify({ dependencies: { react: "18" } }));
    const info = await detectPreviewForFile(proj, join(proj, "src", "App.tsx"));
    expect(info.previewable).toBe(false);
    expect(info.reason).toBe("no-vite-app");
    rmSync(root, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `cd satellite && pnpm vitest run main/project-detect.test.ts`
Expected: FAIL — `detectPreviewForFile is not a function`.

- [ ] **Step 3: Implement `detectPreviewForFile`**

Add to `satellite/main/project-detect.ts` (after `detectProjectPreview`):
```ts
export interface FilePreviewInfo {
  previewable: boolean;
  appRelPath: string;
  targetRelPath: string;
  reason: "ok" | "no-vite-app" | "vite-no-react" | "read-error";
}

/** Is `dir` a Vite app root? (vite dep OR a vite.config.*). Returns
 *  "vite" | "no-vite", plus whether React is present. */
async function classifyDir(dir: string): Promise<{ vite: boolean; react: boolean; readError: boolean }> {
  let deps: Record<string, unknown> = {};
  let readError = false;
  try {
    const pkg = JSON.parse(await readFile(join(dir, "package.json"), "utf8"));
    deps = { ...asRecord(pkg.dependencies), ...asRecord(pkg.devDependencies) };
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    if (code && code !== "ENOENT") readError = true; // ENOENT = just no package.json here
  }
  let vite = "vite" in deps;
  if (!vite) {
    for (const cfg of VITE_CONFIGS) {
      if (await exists(join(dir, cfg))) { vite = true; break; }
    }
  }
  return { vite, react: "react" in deps, readError };
}

/**
 * Walk up from `filePath` to `projectRoot` (inclusive) and report the
 * nearest Vite+React app root. `appRelPath` is that dir relative to
 * `projectRoot` ("" when it IS the root); `targetRelPath` is the file
 * relative to the app root. Never walks above `projectRoot`.
 */
export async function detectPreviewForFile(
  projectRoot: string,
  filePath: string,
): Promise<FilePreviewInfo> {
  const notPreviewable = (reason: FilePreviewInfo["reason"]): FilePreviewInfo => ({
    previewable: false, appRelPath: "", targetRelPath: "", reason,
  });
  const root = projectRoot.replace(/\/+$/, "");
  let dir = dirname(filePath);
  let sawViteNoReact = false;
  // guard: filePath must be under projectRoot
  if (dir !== root && !dir.startsWith(root + "/")) return notPreviewable("no-vite-app");
  while (true) {
    const { vite, react, readError } = await classifyDir(dir);
    if (readError && dir === dirname(filePath)) return notPreviewable("read-error");
    if (vite && react) {
      const appRelPath = dir === root ? "" : dir.slice(root.length + 1);
      const targetRelPath = filePath.slice(dir.length + 1);
      return { previewable: true, appRelPath, targetRelPath, reason: "ok" };
    }
    if (vite && !react) sawViteNoReact = true;
    if (dir === root) break;
    dir = dirname(dir);
  }
  return notPreviewable(sawViteNoReact ? "vite-no-react" : "no-vite-app");
}
```
Add `dirname` to the `node:path` import at L11: `import { readFile, access } from "node:fs/promises";` stays; change L11 to `import { join, dirname } from "node:path";`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cd satellite && pnpm vitest run main/project-detect.test.ts`
Expected: PASS (all 5 new tests + existing ones).

- [ ] **Step 5: Commit**
```bash
git add satellite/main/project-detect.ts satellite/main/project-detect.test.ts
git commit -m "feat(preview): walk-up detector for monorepo Vite app roots"
```

---

## Task 2: `preview:detect` IPC → file-aware

**Files:**
- Modify: `satellite/main/file-viewer.ts` (handler L1544-1555; remove-handler L1501; import L26-27)
- Modify: `satellite/preload/preload.ts` (L386-392)

**Interfaces:**
- Consumes: `detectPreviewForFile` (Task 1).
- Produces: renderer-visible `window.reckAPI.preview.detect(projectRootMac: string, filePathMac: string): Promise<FilePreviewInfo>`.

- [ ] **Step 1: Update the IPC handler**

In `satellite/main/file-viewer.ts`, replace the `preview:detect` handler (L1544-1555) with:
```ts
ipcMain.handle("preview:detect", (_e, projectRoot: unknown, filePath: unknown): Promise<FilePreviewInfo> => {
  if (typeof projectRoot !== "string" || typeof filePath !== "string") {
    return Promise.resolve({ previewable: false, appRelPath: "", targetRelPath: "", reason: "read-error" });
  }
  return detectPreviewForFile(projectRoot, filePath);
});
```
Update the import at L26-27 to bring in `detectPreviewForFile` and the `FilePreviewInfo` type from `./project-detect`.

- [ ] **Step 2: Update the preload signature**

In `satellite/preload/preload.ts` (L386-392):
```ts
preview: {
  detect: (projectRoot: string, filePath: string) =>
    ipcRenderer.invoke("preview:detect", projectRoot, filePath) as Promise<{
      previewable: boolean; appRelPath: string; targetRelPath: string;
      reason: "ok" | "no-vite-app" | "vite-no-react" | "read-error";
    }>,
},
```

- [ ] **Step 3: Typecheck**

Run: `cd satellite && pnpm typecheck`
Expected: FAIL only at the renderer call site in `FileViewerHost.ts` (old 1-arg `preview.detect`) — that's fixed in Task 5. If any OTHER error appears, fix it here.

- [ ] **Step 4: Commit**
```bash
git add satellite/main/file-viewer.ts satellite/preload/preload.ts
git commit -m "feat(preview): preview:detect takes (projectRoot, filePath), returns FilePreviewInfo"
```

---

## Task 3: Daemon — run Vite at the app subdirectory

**Files:**
- Modify: `proto/proto.go`, `proto/proto.ts` — add `AppRelPath` to `PreviewStartRequest`.
- Modify: `daemon/internal/http/router.go` — `handleStartPreview` (L491-513).
- Modify: `daemon/internal/preview/manager.go` — `Start` (L125); reuse fast-path (L129-136); spawn (L265-267).
- Test: `daemon/internal/http/router_test.go`, `daemon/internal/preview/manager_test.go`.

**Interfaces:**
- Consumes: `PreviewStartRequest{ HmrHost string; AppRelPath string }`.
- Produces: daemon spawns the runner with `--cwd = filepath.Join(project.Cwd, AppRelPath)`; restarts when that path changes for a project id.

- [ ] **Step 1: Add the proto field**

`proto/proto.go` — in `PreviewStartRequest`, add:
```go
// AppRelPath is the Vite app directory relative to the project root
// ("" = the project root is the app). Must not escape the project.
AppRelPath string `json:"app_rel_path,omitempty"`
```
`proto/proto.ts` — mirror on the `PreviewStartRequest` type: `appRelPath?: string;` (with the same doc comment).

- [ ] **Step 2: Write the failing router test**

In `daemon/internal/http/router_test.go`, add a test asserting the joined cwd is passed and path-escape is rejected. Use the existing preview stub pattern in this file (search `Preview` / `previewStub`); assert:
```go
// AppRelPath "apps/dashboard-v2" → Start receives filepath.Join(cwd, "apps/dashboard-v2")
// AppRelPath "../etc" → 400, Start NOT called
```
Model it on the nearest existing `handleStartPreview` test; capture the `cwd` the stub's `Start` received.

- [ ] **Step 3: Run it to verify it fails**

Run: `cd daemon && go test ./internal/http/ -run StartPreview -v`
Expected: FAIL (escape not rejected / cwd not joined).

- [ ] **Step 4: Implement the join + validation**

In `handleStartPreview` (router.go L491-513), between decoding `req` and the `s.Preview.Start(...)` call:
```go
appCwd := detail.Cwd
if req.AppRelPath != "" {
    clean := filepath.Clean(req.AppRelPath)
    if clean == ".." || strings.HasPrefix(clean, "../") || filepath.IsAbs(clean) {
        writeJSONStatus(w, nethttp.StatusBadRequest, proto.PreviewStatus{Error: "invalid app path"})
        return
    }
    appCwd = filepath.Join(detail.Cwd, clean)
}
st, _ := s.Preview.Start(r.Context(), id, appCwd, req.HmrHost)
```
Add `"path/filepath"` and `"strings"` to imports if missing.

- [ ] **Step 5: Write the failing manager restart test**

In `daemon/internal/preview/manager_test.go`, add a test: Start a project at cwd A (fake node script that prints the ready line), then Start the same project id at cwd B; assert the first child is stopped and a new child runs with cwd B (one child per project, restarted on cwd change). Follow the existing manager test harness in this file for the fake runner.

- [ ] **Step 6: Run it to verify it fails**

Run: `cd daemon && go test ./internal/preview/ -run Restart -v`
Expected: FAIL — the reuse fast-path returns the A child for a B request.

- [ ] **Step 7: Implement restart-on-cwd-change**

In `manager.go` `Start` reuse fast-path (L129-136), before returning a reused ready child, compare its stored cwd to the requested `cwd`; if different, tear it down (same path as `Stop`) and fall through to spawn. Store `cwd` on `previewProc` (the struct near L63) when spawning (L265-267) so it can be compared.

- [ ] **Step 8: Run daemon tests + vet**

Run: `cd daemon && go test ./internal/http/ ./internal/preview/ && go vet ./...`
Expected: PASS, vet clean.

- [ ] **Step 9: Commit**
```bash
git add proto/proto.go proto/proto.ts daemon/internal/http/router.go daemon/internal/http/router_test.go daemon/internal/preview/manager.go daemon/internal/preview/manager_test.go
git commit -m "feat(preview): daemon runs Vite at app subdir; restart per project on app change"
```

---

## Task 4: ComponentPreview + PreviewApi carry `appRelPath`

**Files:**
- Modify: `satellite/renderer/src/viewer/ComponentPreview.ts` (`PreviewApi` L37-44, `ComponentPreviewOptions` L46-57, startPreview call L153)
- Test: `satellite/renderer/src/viewer/ComponentPreview.test.ts` (extend existing)

**Interfaces:**
- Consumes: `ComponentPreviewOptions` gains `appRelPath: string`.
- Produces: `PreviewApi.startPreview(projectId: string, opts?: { hmrHost?: string; appRelPath?: string })`; the option is forwarded to the daemon start call.

- [ ] **Step 1: Write the failing test**

In `ComponentPreview.test.ts`, extend the start test so the injected `api.startPreview` spy asserts it received `{ hmrHost, appRelPath: "apps/dashboard-v2" }`. (Follow the existing test's stub `api`.)

- [ ] **Step 2: Run it to verify it fails**

Run: `cd satellite && pnpm vitest run src/viewer/ComponentPreview.test.ts`
Expected: FAIL — `appRelPath` undefined in the forwarded opts.

- [ ] **Step 3: Implement**

- `PreviewApi.startPreview` (L37-44): `startPreview(projectId: string, opts?: { hmrHost?: string; appRelPath?: string }): Promise<PreviewStatus>`.
- `ComponentPreviewOptions` (L46-57): add `appRelPath: string;`.
- The start call (L149-153): `void api.startPreview(projectId, { hmrHost, appRelPath: opts.appRelPath }).then(...)`.
- Update the concrete `ApiClient.startPreview` (the class that satisfies `PreviewApi` — search `startPreview` in `client-core`/renderer) to send `app_rel_path` in the POST body.

- [ ] **Step 4: Run it to verify it passes**

Run: `cd satellite && pnpm vitest run src/viewer/ComponentPreview.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**
```bash
git add satellite/renderer/src/viewer/ComponentPreview.ts satellite/renderer/src/viewer/ComponentPreview.test.ts
git commit -m "feat(preview): thread appRelPath from ComponentPreview to startPreview"
```

---

## Task 5: Reason copy module + wire the local gate

**Files:**
- Create: `satellite/renderer/src/viewer/previewReason.ts`
- Test: `satellite/renderer/src/viewer/previewReason.test.ts`
- Modify: `satellite/renderer/src/viewer/FileViewerHost.ts` — `renderForPath` gate (L1578-1623) + mount (L1743-1766)

**Interfaces:**
- Consumes: `FilePreviewInfo` (Task 1), `preview.detect(projectRoot, filePath)` (Task 2), `ComponentPreviewOptions.appRelPath` (Task 4).
- Produces: `previewReasonCopy(reason): { title: string; body: string }` for the "why" card.

- [ ] **Step 1: Write the failing reason-copy test**

`previewReason.test.ts`:
```ts
import { previewReasonCopy } from "./previewReason";
describe("previewReasonCopy", () => {
  it("maps no-vite-app", () => {
    expect(previewReasonCopy("no-vite-app").title).toMatch(/no live preview/i);
  });
  it("maps vite-no-react", () => {
    expect(previewReasonCopy("vite-no-react").body).toMatch(/react/i);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd satellite && pnpm vitest run src/viewer/previewReason.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `previewReason.ts`**
```ts
export type PreviewReasonKey = "ok" | "no-vite-app" | "vite-no-react" | "read-error";

/** User-facing copy for a non-previewable file. Keep messages concrete:
 *  what happened, in the interface's voice. */
export function previewReasonCopy(reason: PreviewReasonKey): { title: string; body: string } {
  switch (reason) {
    case "vite-no-react":
      return { title: "No live preview here", body: "This file's app uses Vite but not React. Live preview renders Vite + React components." };
    case "read-error":
      return { title: "Couldn't read the project", body: "The project's package.json couldn't be read over the mount. Showing source." };
    case "no-vite-app":
    default:
      return { title: "No live preview here", body: "Live preview renders Vite + React apps. This file isn't inside one." };
  }
}
```

- [ ] **Step 4: Run it to verify it passes**

Run: `cd satellite && pnpm vitest run src/viewer/previewReason.test.ts`
Expected: PASS.

- [ ] **Step 5: Rewire the `renderForPath` gate**

In `FileViewerHost.ts` `renderForPath` (L1578-1619):
- After `componentTarget = deriveComponentTarget(result.resolvedPath, mount)` (L1591), replace the detect call (L1600-1607) with:
```ts
const det = await window.reckAPI.preview.detect(componentTarget.projectRootMac, result.resolvedPath);
componentPreviewAvailable = det.previewable;
previewReason = det.previewable ? null : det.reason;   // NEW: keep the reason
componentAppRelPath = det.appRelPath;                   // NEW
componentTargetRel = det.targetRelPath;                 // NEW: app-relative target
```
- Declare near L1578-1580: `let previewReason: string | null = null; let componentAppRelPath = ""; let componentTargetRel = "";`.
- At the mount site (L1743-1766), pass the app-relative values:
```ts
} else if (mode === "component" && componentTarget) {
  // ...existing ApiClient + stationHost setup...
  const preview = createComponentPreview({
    api, projectId: renderOpts.projectId!, stationHost,
    targetRelPath: componentTargetRel || componentTarget.targetRelPath,
    appRelPath: componentAppRelPath,
    onError,
  });
  // ...
}
```

- [ ] **Step 6: Surface the reason instead of silent source**

Still in `renderForPath`: when `isComponentPath(filePath)` and `mode === "source"` **because** `previewReason` is set (i.e. we tried and it isn't previewable), render the "why" card above/instead of the bare editor. Reuse the existing `.file-viewer-component-error` panel styling; build a small element from `previewReasonCopy(previewReason)` with a "Show source" affordance that reveals the editor. Wire it where the `source` branch mounts the editor (search the `mountCodeEditor` call in `renderForPath`). Keep the rendered/source toggle working.

- [ ] **Step 7: Typecheck + run viewer tests**

Run: `cd satellite && pnpm typecheck && pnpm vitest run src/viewer/`
Expected: PASS.

- [ ] **Step 8: Commit**
```bash
git add satellite/renderer/src/viewer/previewReason.ts satellite/renderer/src/viewer/previewReason.test.ts satellite/renderer/src/viewer/FileViewerHost.ts
git commit -m "feat(preview): render app-subdir components + show why when a file can't preview (local)"
```

---

## Task 6: Mirror the station-remote gate

**Files:**
- Modify: `satellite/renderer/src/viewer/stationPreviewDetect.ts` — add `detectStationPreviewForFile`.
- Modify: `satellite/renderer/src/viewer/FileViewerHost.ts` — `renderStationRemote` gate (L1007-1063) + mount (L1231-1256).
- Test: `stationPreviewDetect.test.ts` (extend).

**Interfaces:**
- Consumes: the readFile fn already used by `detectStationProjectPreview`.
- Produces: `detectStationPreviewForFile(readFile, projectCwd, filePath): Promise<FilePreviewInfo>` (same shape as Task 1, computed over the injected readFile).

- [ ] **Step 1: Write the failing test**

In `stationPreviewDetect.test.ts`, mirror Task 1's monorepo + root-level + no-vite cases, driving a fake `readFile(path) => string | null` map.

- [ ] **Step 2: Run it to verify it fails**

Run: `cd satellite && pnpm vitest run src/viewer/stationPreviewDetect.test.ts`
Expected: FAIL — function not defined.

- [ ] **Step 3: Implement `detectStationPreviewForFile`**

Same walk-up logic as Task 1 but using the injected `readFile` (return `null` = no file) instead of `node:fs`, and checking `vite.config.*` presence via `readFile` returning non-null. Return the identical `FilePreviewInfo` shape.

- [ ] **Step 4: Rewire `renderStationRemote`**

In `renderStationRemote` (L1007-1063): call `detectStationPreviewForFile(readFn, renderOpts.projectCwd, filePath)`; set `componentPreviewAvailable`, `previewReason`, `componentAppRelPath`, `componentTargetRel` as in Task 5. At the mount (L1231-1256), pass `appRelPath: componentAppRelPath` and `targetRelPath: componentTargetRel` to `createComponentPreview`. Surface the reason card in the station `source` branch too.

- [ ] **Step 5: Typecheck + viewer tests**

Run: `cd satellite && pnpm typecheck && pnpm vitest run src/viewer/`
Expected: PASS.

- [ ] **Step 6: Commit**
```bash
git add satellite/renderer/src/viewer/stationPreviewDetect.ts satellite/renderer/src/viewer/stationPreviewDetect.test.ts satellite/renderer/src/viewer/FileViewerHost.ts
git commit -m "feat(preview): station-remote walk-up detection + reason surfacing"
```

---

## Task 7: End-to-end verification (manual, on the station)

**Not a code task** — the acceptance gate. Requires a rebuilt station daemon (Task 3) and the running satellite dev build.

- [ ] **Step 1:** Rebuild + restart the station daemon from this branch (`ops/install-station-linux.sh` or `go build -o ~/.local/bin/reck-stationd ./daemon/cmd/reck-stationd` then `systemctl --user restart reck-stationd`). Requires `node_modules` present in the target app on the station.
- [ ] **Step 2:** In the satellite dev build, command-click `Nexa-service-desk/apps/dashboard-v2/src/App.tsx`. **Expected:** renders the component (not source). Confirm the `[preview]` trace shows `detect … previewable=true` and `mode=component`, and the daemon spawns Vite with `--cwd …/apps/dashboard-v2`.
- [ ] **Step 3:** Command-click a non-Vite `.tsx` (e.g. a file under a project with no Vite app). **Expected:** the "No live preview here" card, with "Show source".
- [ ] **Step 4:** Confirm root-level Vite projects, `.html`, and `.md` are unchanged (regression check).

---

## Self-Review notes

- **Spec coverage:** monorepo walk-up (Tasks 1,3,5,6), legible failures (Tasks 5,6), one-app-per-project restart (Task 3). Rail flare, install/start/stop, and archive-auto-stop are **Phase 2/3** — intentionally out of this plan.
- **Type consistency:** `FilePreviewInfo` (`previewable`/`appRelPath`/`targetRelPath`/`reason`) is defined in Task 1 and used verbatim in Tasks 2, 5, 6; `appRelPath` flows Task 1 → 2 → 5/6 → 4 → 3; reason keys `"ok"|"no-vite-app"|"vite-no-react"|"read-error"` are identical in Tasks 1, 2, 5.
- **Open item for the implementer:** the "different app is live" viewer state (spec §5.2) depends on knowing the *running* app root; that needs `getPreview` to report the running cwd. If that field isn't already returned, defer that specific card to Phase 2 (where Start/Stop/status get richer) and keep Phase 1's cards to detection outcomes.
