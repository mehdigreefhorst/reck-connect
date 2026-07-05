# Phase B — Faithful Vite Component Preview Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Open a `.tsx`/`.jsx` component in the file-viewer and see it rendered *as if a `page.tsx` rendered only that component* — through the project's own Vite toolchain on the station (real imports, `node_modules`, path aliases, `global.css`/Tailwind, best-effort providers, HMR), framed live in the satellite.

**Architecture:** A new Node **preview runner** (embedded in the Go daemon via `go:embed`) boots the project's real Vite `createServer` with a virtual-entry plugin that synthesizes the "auto `page.tsx`" per target. A minimal **daemon preview manager** spawns that runner as a child, parses its readiness/port from stdout, and exposes `POST/GET/DELETE /projects/{id}/preview`. The satellite's viewer gains a `component` render mode that calls those endpoints and frames `http://<station-host>:<port>/?target=<rel path>` in a cross-origin `<iframe>` (structurally cannot reach `window.reckAPI`).

**Tech Stack:** Go 1.26 daemon (chi router, `os/exec`, `go:embed`); Node ESM runner (`node --test` for unit tests; the *project's* Vite ^5, `@vitejs/plugin-react` loaded at runtime); satellite TypeScript (Electron main + Vite/vanilla-TS renderer; Vitest + jsdom; Playwright-electron e2e); pnpm.

---

## ⚠️ Spec deviation & decision record (read before Task 1)

The design spec (`docs/superpowers/specs/2026-07-02-html-react-viewer-design.md` §3, §6, §9) asserts **"v1 needs no daemon changes: run the preview server as a shell pane."** Codebase recon (2026-07-05) **disproves this**:

- `CreatePaneRequest` has **no free-form command field**; the shell adapter execs only the project's pre-set `Project.Shell`, and `extra_args` is ignored for shell panes → **no API path to spawn `npm run dev`.**
- The daemon does **no** child-output URL/port parsing (only the Claude OSC-777 approval regex), has **no** port allocation, readiness, or reverse proxy.
- The station is **Go with no JS workspace**, but Vite is Node → a Node runner is unavoidable and must run station-side (native `node_modules`).

**DECISION D1 (launch mechanism): minimal daemon preview endpoint + embedded Node runner.** Chosen over (b) satellite SSH-exec [keeps daemon untouched but adds a second control plane, thrown away by Phase C] and (c) full Phase-C service now [over-builds v1]. Rationale: one control plane behind the existing `:7315` bearer auth; the runner ships *inside* the daemon binary (`go:embed`) so there is nothing extra to distribute; the manager code is **extended** by Phase C (service abstraction + reverse proxy), not discarded. **To flip to (b), replace Stage 2 (Tasks 5–8) with a satellite SSH-exec path; Stages 1, 3, 4, 5 are unchanged.**

**DECISION D2 (providers): auto-infer + manual override** (spec §8 default). Auto-detect a root `Providers`/layout; honor a `<Component>.reck-preview.tsx` override; degrade to a bare render with a visible hint.

**DECISION D3 (transport): direct tailnet dev-server port** (spec §14 default). The runner binds `0.0.0.0:<port>`; the satellite frames `http://<station-host>:<port>/`. **Depends on Tailscale ACLs permitting non-`7315` ports between the user's own devices** (spec §14 open item — confirm with user before Task 13 e2e). Task 12b adds an SSH-`-L` fallback that is only needed if that check fails; a daemon reverse-proxy is the Phase C hardening.

**Post-plan follow-ups (do at Task 15, after code):** correct spec §3/§6/§9 and GitHub issue #44 to match D1.

---

## Global Constraints

Copied verbatim from the spec / verified codebase facts. Every task's requirements implicitly include these.

- **Bundler runs station-side only.** Never run Vite in the satellite/browser or over the sshfs mount (`node_modules` too slow). The runner executes on the station host where `Project.Cwd` and native `node_modules` live.
- **Use the project's own Vite.** The runner must load the *target project's* `vite` and `vite.config.*` (resolved relative to `Project.Cwd`), not a reck-bundled Vite — this is what makes `global.css`/Tailwind/aliases/imported children apply automatically. Runner harness code carries **zero runtime deps of its own** (loads everything from the project).
- **Cross-origin iframe, no `allow-same-origin`.** The preview is framed from its own `http://<host>:<port>` origin with **no preload** → it cannot reach `window.reckAPI`. This isolation is a hard requirement (issue #44 acceptance).
- **Component files for v1 = `.tsx` and `.jsx` only.** `.js`/`.ts` are ambiguous (plain modules) — excluded from `component` mode in v1.
- **Bearer auth reuse.** Preview endpoints live under the existing daemon router and require the same bearer as every other `/projects/*` route. No new auth surface.
- **Reuse the Phase 0 classifier.** `pickViewerMode` remains the single source of truth for render mode; `renderForPath` and `renderStationRemote` both route through it. No third dispatch site.
- **Immutability, small files (200–400 lines typical, 800 max), explicit types on exported APIs, no `console.log` in shipped code, no hardcoded secrets** (repo rules).
- **Kind string is `"component"`** everywhere it appears (ViewerMode, both SurfaceKind unions).
- **Target is passed project-root-relative** (`?target=<rel>`); the runner resolves it against `Project.Cwd`. Never pass satellite mount paths to the station.

## Interfaces produced by this plan (shared vocabulary)

Later tasks depend on these exact names/signatures. Defined once here; each task restates the slice it produces.

```ts
// proto/proto.ts  (+ Go mirror proto/proto.go)
export interface PreviewStatus {
  running: boolean;   // a runner child exists for this project
  ready: boolean;     // the dev server answered readiness
  port: number;       // 0 until ready
  error: string;      // "" unless the runner failed to start
}
```
```ts
// client-core/src/api/client.ts  (ApiClient methods)
startPreview(projectId: string): Promise<PreviewStatus>;  // POST /projects/{id}/preview  (blocks until ready or timeout)
getPreview(projectId: string): Promise<PreviewStatus>;    // GET  /projects/{id}/preview
stopPreview(projectId: string): Promise<void>;            // DELETE /projects/{id}/preview
```
```ts
// satellite/main/project-detect.ts
export interface ProjectPreviewInfo { previewable: boolean; reason: string; }
export async function detectProjectPreview(projectCwd: string): Promise<ProjectPreviewInfo>;
// IPC: "preview:detect" (cwd: string) => ProjectPreviewInfo ; preload: reckAPI.preview.detect(cwd)
```
```ts
// satellite/renderer/src/viewer/pickViewerMode.ts  (extended)
export type ViewerMode = "markdown-rendered" | "html-static" | "component" | "source";
export function isComponentPath(p: string): boolean;                       // /\.(t|j)sx$/i
export function pickViewerMode(
  path: string, persisted: PersistedRenderMode | undefined,
  opts?: { componentPreviewAvailable?: boolean },
): ViewerMode;
```
```ts
// satellite/renderer/src/viewer/ComponentPreview.ts
export interface ComponentPreviewOptions {
  api: PreviewApi;            // { startPreview; getPreview; stopPreview } — an ApiClient slice
  projectId: string;
  stationHost: string;       // from stationHostFromUrl(settings.station.url)
  targetRelPath: string;     // project-root-relative path of the component file
  onError?(message: string): void;
}
export interface ComponentPreviewHandle { el: HTMLElement; dispose(): void; }
export function createComponentPreview(opts: ComponentPreviewOptions): ComponentPreviewHandle;
```
```js
// daemon/internal/preview/runner/entry-builder.mjs
export function buildPreviewEntry({ targetRelPath, globalCssRelPath, hasProviders }): string;
export function buildProvidersModule({ providersImportPath, providersExport }): string;
// daemon/internal/preview/runner/detect.mjs
export async function detectGlobalCss(cwd): Promise<string | null>;   // returns project-root-relative path or null
export async function detectProviders(cwd, targetRelPath): Promise<{ importPath: string, exportName: string } | null>;
```
```go
// daemon/internal/preview/manager.go
type Manager struct { /* ... */ }
func NewManager(nodePath string) *Manager
func (m *Manager) Start(ctx context.Context, projectID, cwd string) (proto.PreviewStatus, error) // spawn/reuse, block until ready
func (m *Manager) Status(projectID string) proto.PreviewStatus
func (m *Manager) Stop(projectID string) error
func (m *Manager) Shutdown() // kill all children (called on daemon shutdown)
```

---

## File Structure

**New — station (Go):**
- `daemon/internal/preview/manager.go` (+`manager_test.go`) — child spawn, stdout READY/port parse, per-project registry, stop/shutdown.
- `daemon/internal/preview/embed.go` — `//go:embed runner/*` FS + a `writeRunner(dir)` helper.
- `daemon/internal/preview/runner/server.mjs` — CLI entry: parse args, `createServer` w/ project Vite + plugin, listen, print `RECK_PREVIEW_READY port=<n>`, SIGTERM handler.
- `daemon/internal/preview/runner/plugin.mjs` — Vite plugin: virtual entry (`/@reck/entry?target=…`) + `/@reck/providers` + served `index.html`.
- `daemon/internal/preview/runner/entry-builder.mjs` (+`entry-builder.test.mjs`) — pure entry/providers source synthesis.
- `daemon/internal/preview/runner/detect.mjs` (+`detect.test.mjs`) — `global.css`/providers detection over native fs.
- `daemon/internal/preview/runner/index.html` — `<div id=root>` + bootstrap module tag.

**New — proto:**
- `proto/proto.go` / `proto/proto.ts` — add `PreviewStatus`.

**New — satellite (TS):**
- `satellite/main/project-detect.ts` (+`project-detect.test.ts`) — over-mount previewability check + IPC.
- `satellite/renderer/src/viewer/ComponentPreview.ts` (+`ComponentPreview.test.ts`) — iframe host + lifecycle + readiness/degrade UI.

**New — fixtures:**
- `daemon/internal/preview/runner/__fixtures__/vite-tailwind-app/` — minimal Vite+React+Tailwind project (real `vite` dep) with an aliased import + a themed provider, used by runner integration + satellite e2e.

**Touched:**
- `daemon/internal/http/router.go` — 3 routes + `PreviewManager` on `Server`.
- `daemon/cmd/reck-stationd/main.go` — construct `preview.NewManager`, wire onto server, `Shutdown()` on exit, resolve `node` path.
- `client-core/src/api/client.ts` — `startPreview`/`getPreview`/`stopPreview`.
- `satellite/preload/preload.ts` — `reckAPI.preview.detect`.
- `satellite/renderer/src/viewer/pickViewerMode.ts` (+ test) — `component` mode + `isComponentPath` + `componentPreviewAvailable`.
- `satellite/renderer/src/viewer/FileViewerHost.ts` — `component` arm in `renderForPath` **and** `renderStationRemote`; thread `componentPreviewAvailable` into `pickViewerMode`.
- `satellite/renderer/src/tts/SpeakSurfaceAdapter.ts` + `search/SearchSurfaceAdapter.ts` — add `"component"` to both `SurfaceKind` unions.
- `satellite/renderer/src/styles.css` — `.file-viewer-component-*` iframe/spinner styles.
- `satellite/e2e-electron/` — new spec for the live preview.
- `docs/superpowers/specs/2026-07-02-html-react-viewer-design.md` + issue #44 — D1 correction (Task 15).

---

## Stage 1 — Station Node preview runner (embedded, standalone-testable)

The runner is pure Node ESM under `daemon/internal/preview/runner/`. Unit-tested with `node --test` (no new deps); integration-tested against the fixture (real Vite). Build this first — it's the fidelity core and has zero dependency on the daemon or satellite.

### Task 1: Virtual-entry synthesizer (`entry-builder.mjs`)

**Files:**
- Create: `daemon/internal/preview/runner/entry-builder.mjs`
- Test: `daemon/internal/preview/runner/entry-builder.test.mjs`

**Interfaces — Produces:** `buildPreviewEntry({targetRelPath, globalCssRelPath, hasProviders}): string`, `buildProvidersModule({providersImportPath, providersExport}): string`. Consumes: nothing.

The entry is emitted as **plain JS using `React.createElement`** (no JSX) so it needs no JSX transform. Imports resolve through Vite against the project (aliases/node_modules) because the runner serves them from the project root.

- [ ] **Step 1: Write the failing test**

```js
// entry-builder.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPreviewEntry, buildProvidersModule } from "./entry-builder.mjs";

test("entry imports target, global.css, providers, and mounts #root", () => {
  const src = buildPreviewEntry({
    targetRelPath: "src/components/Button.tsx",
    globalCssRelPath: "src/index.css",
    hasProviders: true,
  });
  assert.match(src, /import Component from "\/src\/components\/Button\.tsx"/);
  assert.match(src, /import "\/src\/index\.css"/);
  assert.match(src, /from "\/@reck\/providers"/);
  assert.match(src, /createRoot\(document\.getElementById\("root"\)\)/);
  assert.match(src, /React\.createElement\(Providers, null, React\.createElement\(Component\)\)/);
});

test("entry omits global.css import when none detected", () => {
  const src = buildPreviewEntry({ targetRelPath: "a.tsx", globalCssRelPath: null, hasProviders: false });
  assert.doesNotMatch(src, /index\.css/);
  assert.match(src, /React\.createElement\(Component\)/); // no Providers wrapper
});

test("providers module re-exports detected wrap or passes through", () => {
  const wrapped = buildProvidersModule({ providersImportPath: "/src/Providers.tsx", providersExport: "Providers" });
  assert.match(wrapped, /export \{ Providers \}/);
  const bare = buildProvidersModule({ providersImportPath: null, providersExport: null });
  assert.match(bare, /export const Providers = \(\{ children \}\) => children/);
});
```

- [ ] **Step 2: Run it — expect FAIL** (`node --test daemon/internal/preview/runner/entry-builder.test.mjs` → "Cannot find module ./entry-builder.mjs").

- [ ] **Step 3: Implement**

```js
// entry-builder.mjs
// Synthesizes the "auto page.tsx": imports the target component, the app's
// global.css, and a Providers wrapper, then mounts into #root. Emitted as
// plain JS (React.createElement) so no JSX transform is needed on this module.

/** @param {{targetRelPath:string, globalCssRelPath:string|null, hasProviders:boolean}} o */
export function buildPreviewEntry({ targetRelPath, globalCssRelPath, hasProviders }) {
  const abs = (p) => "/" + String(p).replace(/^\/+/, "");
  const lines = [
    `import React from "react";`,
    `import { createRoot } from "react-dom/client";`,
    `import Component from "${abs(targetRelPath)}";`,
  ];
  if (globalCssRelPath) lines.push(`import "${abs(globalCssRelPath)}";`);
  if (hasProviders) lines.push(`import { Providers } from "/@reck/providers";`);
  const tree = hasProviders
    ? `React.createElement(Providers, null, React.createElement(Component))`
    : `React.createElement(Component)`;
  lines.push(`createRoot(document.getElementById("root")).render(${tree});`);
  return lines.join("\n") + "\n";
}

/** @param {{providersImportPath:string|null, providersExport:string|null}} o */
export function buildProvidersModule({ providersImportPath, providersExport }) {
  if (providersImportPath && providersExport) {
    return `export { ${providersExport} as Providers } from "${providersImportPath}";\n`;
  }
  return `export const Providers = ({ children }) => children;\n`;
}
```

- [ ] **Step 4: Run test — expect PASS.**
- [ ] **Step 5: Commit** — `git add daemon/internal/preview/runner/entry-builder.* && git commit -m "feat(preview): virtual-entry synthesizer for the Vite runner"`

### Task 2: `global.css` + providers detection (`detect.mjs`)

**Files:**
- Create: `daemon/internal/preview/runner/detect.mjs`
- Test: `daemon/internal/preview/runner/detect.test.mjs`

**Interfaces — Produces:** `detectGlobalCss(cwd): Promise<string|null>`, `detectProviders(cwd, targetRelPath): Promise<{importPath,exportName}|null>`. Consumes: native `node:fs/promises`.

Heuristics (v1, honest degrade): global css = first existing of a candidate list whose contents include a Tailwind directive, else first existing candidate. Providers = a `<Component>.reck-preview.tsx` sibling exporting `wrap`/`Providers` (manual override, wins), else a root `Providers`/`AppProviders` export in `src/Providers.*`/`app/providers.*`, else null.

- [ ] **Step 1: Write the failing test** (uses a temp dir)

```js
// detect.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectGlobalCss, detectProviders } from "./detect.mjs";

function scaffold() {
  const d = mkdtempSync(join(tmpdir(), "reck-detect-"));
  mkdirSync(join(d, "src", "components"), { recursive: true });
  return d;
}

test("detectGlobalCss prefers a Tailwind css file", async () => {
  const d = scaffold();
  writeFileSync(join(d, "src", "index.css"), "@tailwind base;\n@tailwind utilities;\n");
  assert.equal(await detectGlobalCss(d), "src/index.css");
});

test("detectGlobalCss returns null when no candidate exists", async () => {
  assert.equal(await detectGlobalCss(scaffold()), null);
});

test("manual override sibling wins", async () => {
  const d = scaffold();
  writeFileSync(join(d, "src", "components", "Button.reck-preview.tsx"), "export const wrap = (c) => c;\n");
  const p = await detectProviders(d, "src/components/Button.tsx");
  assert.equal(p.importPath, "/src/components/Button.reck-preview.tsx");
  assert.equal(p.exportName, "wrap");
});

test("root Providers export is inferred when no override", async () => {
  const d = scaffold();
  writeFileSync(join(d, "src", "Providers.tsx"), "export function Providers({children}){return children}\n");
  const p = await detectProviders(d, "src/components/Button.tsx");
  assert.equal(p.importPath, "/src/Providers.tsx");
  assert.equal(p.exportName, "Providers");
});
```

- [ ] **Step 2: Run — expect FAIL.**
- [ ] **Step 3: Implement**

```js
// detect.mjs
import { readFile, access } from "node:fs/promises";
import { join, dirname, basename, extname } from "node:path";

const CSS_CANDIDATES = ["src/index.css", "src/globals.css", "src/global.css", "src/styles/globals.css", "app/globals.css", "styles/globals.css"];
const TAILWIND_RE = /@tailwind\b|@import\s+["']tailwindcss["']/;
const PROVIDER_CANDIDATES = [ // [relPath, exportName]
  ["src/Providers.tsx", "Providers"], ["src/Providers.jsx", "Providers"],
  ["src/providers.tsx", "Providers"], ["app/providers.tsx", "Providers"],
  ["src/AppProviders.tsx", "AppProviders"],
];

const exists = async (p) => { try { await access(p); return true; } catch { return false; } };

/** @returns {Promise<string|null>} project-root-relative css path */
export async function detectGlobalCss(cwd) {
  const present = [];
  for (const rel of CSS_CANDIDATES) if (await exists(join(cwd, rel))) present.push(rel);
  if (present.length === 0) return null;
  for (const rel of present) {
    try { if (TAILWIND_RE.test(await readFile(join(cwd, rel), "utf8"))) return rel; } catch { /* ignore */ }
  }
  return present[0];
}

/** @returns {Promise<{importPath:string, exportName:string}|null>} */
export async function detectProviders(cwd, targetRelPath) {
  // 1. manual override sibling: <name>.reck-preview.tsx exporting wrap
  const dir = dirname(targetRelPath);
  const stem = basename(targetRelPath, extname(targetRelPath));
  for (const ext of [".tsx", ".jsx"]) {
    const rel = join(dir, `${stem}.reck-preview${ext}`).replace(/\\/g, "/");
    if (await exists(join(cwd, rel))) return { importPath: "/" + rel, exportName: "wrap" };
  }
  // 2. inferred root providers
  for (const [rel, name] of PROVIDER_CANDIDATES) {
    if (await exists(join(cwd, rel))) return { importPath: "/" + rel, exportName: name };
  }
  return null;
}
```

- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat(preview): global.css + providers detection for the runner"`

### Task 3: Vite plugin + server bootstrap (`plugin.mjs`, `server.mjs`, `index.html`) + integration test

**Files:**
- Create: `daemon/internal/preview/runner/plugin.mjs`, `server.mjs`, `index.html`
- Create fixture: `daemon/internal/preview/runner/__fixtures__/vite-tailwind-app/` (see Step 1)
- Test: `daemon/internal/preview/runner/server.integration.test.mjs`

**Interfaces — Produces:** a runnable CLI `node server.mjs --cwd <path> --host 0.0.0.0 --port 0` that prints `RECK_PREVIEW_READY host=<h> port=<n>` on stdout when listening. Consumes: `entry-builder.mjs`, `detect.mjs`, and the **project's** `vite`.

The plugin serves three virtual things: `GET /` → `index.html`; `/@reck/entry?target=<rel>` → `buildPreviewEntry(...)` synthesized from the query + `detect*`; `/@reck/providers` → `buildProvidersModule(...)`. Vite preserves query strings on module ids and passes them to `load`, which is how one Vite server renders any target.

- [ ] **Step 1: Create the fixture project** (real, minimal, with its own `vite` so the integration test exercises the true pipeline)

```
daemon/internal/preview/runner/__fixtures__/vite-tailwind-app/
  package.json         # deps: react, react-dom, vite ^5, @vitejs/plugin-react, tailwindcss, @tailwindcss/vite (or postcss)
  vite.config.ts       # plugins:[react(), tailwind()]; resolve.alias { "@": "/src" }
  index.css            # @tailwind base; @tailwind utilities;  (referenced as src/index.css? -> put at src/index.css)
  src/index.css        # @tailwind base; @tailwind components; @tailwind utilities;
  src/theme.ts         # export const LABEL = "themed"      (aliased import target)
  src/Providers.tsx    # export function Providers({children}){ return <div data-provider>{children}</div> }
  src/components/Button.tsx  # import { LABEL } from "@/theme"; export default () => <button className="text-red-500">{LABEL}</button>
```
Add a `.gitignore`d note: the fixture's `node_modules` is installed on demand by the test (`pnpm i` / `npm i`) — see Step 3 test guard.

- [ ] **Step 2: Write the failing integration test**

```js
// server.integration.test.mjs
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "__fixtures__", "vite-tailwind-app");
let child, base;

before(async () => {
  if (!existsSync(join(FIXTURE, "node_modules"))) execSync("npm install --no-audit --no-fund", { cwd: FIXTURE, stdio: "inherit" });
  base = await new Promise((resolve, reject) => {
    child = spawn(process.execPath, [join(HERE, "server.mjs"), "--cwd", FIXTURE, "--host", "127.0.0.1", "--port", "0"], { stdio: ["ignore", "pipe", "inherit"] });
    const t = setTimeout(() => reject(new Error("runner did not become ready")), 60_000);
    child.stdout.on("data", (b) => {
      const m = /RECK_PREVIEW_READY host=(\S+) port=(\d+)/.exec(String(b));
      if (m) { clearTimeout(t); resolve(`http://${m[1]}:${m[2]}`); }
    });
  });
});
after(() => child?.kill("SIGTERM"));

test("entry module imports global.css + target and providers", async () => {
  const src = await (await fetch(`${base}/@reck/entry?target=src/components/Button.tsx`)).text();
  assert.match(src, /src\/index\.css/);
  assert.match(src, /src\/components\/Button\.tsx/);
});

test("target module resolves the '@/theme' alias (no 500)", async () => {
  const res = await fetch(`${base}/src/components/Button.tsx`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /LABEL/); // transformed module still references the imported binding
});

test("index served at /", async () => {
  const html = await (await fetch(`${base}/`)).text();
  assert.match(html, /id="root"/);
});
```

- [ ] **Step 3: Implement `index.html`, `plugin.mjs`, `server.mjs`**

```html
<!-- index.html -->
<!doctype html><html><head><meta charset="utf-8"><title>reck preview</title></head>
<body><div id="root"></div><script type="module" src="/@reck/bootstrap"></script></body></html>
```

```js
// plugin.mjs
import { buildPreviewEntry, buildProvidersModule } from "./entry-builder.mjs";
import { detectGlobalCss, detectProviders } from "./detect.mjs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = readFileSync(join(HERE, "index.html"), "utf8");

// Bootstrap reads ?target= from the page URL and dynamically imports the entry.
const BOOTSTRAP = `
const target = new URLSearchParams(location.search).get("target") || "";
import("/@reck/entry?target=" + encodeURIComponent(target))
  .catch((e) => { document.body.innerHTML = '<pre style="padding:16px;color:#b00">'+String(e && e.stack || e)+'</pre>'; });
`;

/** @param {{cwd:string}} o */
export function reckPreviewPlugin({ cwd }) {
  return {
    name: "reck-preview",
    // serve our index.html for every navigation (SPA-ish: the real app html is bypassed)
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        const url = (req.url || "").split("?")[0];
        if (url === "/" || url === "/index.html") {
          const html = await server.transformIndexHtml(req.url || "/", INDEX_HTML);
          res.setHeader("content-type", "text/html"); res.end(html); return;
        }
        next();
      });
    },
    resolveId(id) {
      if (id === "/@reck/bootstrap" || id === "/@reck/providers") return "\0" + id;
      if (id.startsWith("/@reck/entry")) return "\0" + id; // keep the ?target= query on the id
    },
    async load(id) {
      if (id === "\0/@reck/bootstrap") return BOOTSTRAP;
      if (id === "\0/@reck/providers") {
        const p = load.providers ?? null; // resolved lazily below via a per-target cache is overkill; recompute:
        const prov = await detectProviders(cwd, load.lastTarget || "");
        return buildProvidersModule({ providersImportPath: prov?.importPath ?? null, providersExport: prov?.exportName ?? null });
      }
      if (id.startsWith("\0/@reck/entry")) {
        const q = new URLSearchParams(id.slice(id.indexOf("?")));
        const targetRelPath = q.get("target") || "";
        load.lastTarget = targetRelPath;
        const [globalCssRelPath, prov] = await Promise.all([detectGlobalCss(cwd), detectProviders(cwd, targetRelPath)]);
        return buildPreviewEntry({ targetRelPath, globalCssRelPath, hasProviders: !!prov });
      }
    },
  };
}
```
> Implementation note (verify against the project's Vite version during coding): `load.lastTarget` couples providers to the last-loaded entry — acceptable for v1's single-target-at-a-time preview. If a cleaner coupling is wanted, fold `/@reck/providers` into the entry module directly (emit the providers source inline) and drop the separate virtual id. Pick whichever the reviewer prefers; both satisfy the tests.

```js
// server.mjs
import { createServer } from "vite";                 // the PROJECT's vite (cwd resolution below)
import { reckPreviewPlugin } from "./plugin.mjs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

function arg(name, def) { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : def; }

const cwd = arg("cwd", process.cwd());
const host = arg("host", "0.0.0.0");
const port = Number(arg("port", "0"));

// Load the PROJECT's own vite so its config/plugins/aliases apply verbatim.
const projectRequire = createRequire(pathToFileURL(cwd + "/package.json"));
const projectViteUrl = pathToFileURL(projectRequire.resolve("vite")).href;
const { createServer: createProjectServer } = await import(projectViteUrl).catch(() => ({ createServer }));

const server = await createProjectServer({
  root: cwd,
  configFile: undefined,               // let Vite auto-load the project's vite.config.*
  server: { host, port, strictPort: false, hmr: { host } },
  plugins: [reckPreviewPlugin({ cwd })], // appended AFTER project plugins
  clearScreen: false,
  logLevel: "warn",
});
await server.listen();
const resolved = server.httpServer.address();
process.stdout.write(`RECK_PREVIEW_READY host=${host} port=${resolved.port}\n`);

for (const sig of ["SIGTERM", "SIGINT"]) process.on(sig, async () => { try { await server.close(); } finally { process.exit(0); } });
```

- [ ] **Step 4: Run — expect PASS** (`node --test daemon/internal/preview/runner/*.test.mjs`; the integration test installs the fixture's deps on first run). If `node`/network is unavailable in CI, the integration test is guarded by the `before` install — mark it skippable there but it MUST pass locally before merge.
- [ ] **Step 5: Commit** — `git commit -am "feat(preview): Vite runner server + virtual-entry plugin + fixture"`

---

## Stage 2 — Daemon preview manager + endpoints (Go)

Implements DECISION D1. Spawns the Stage-1 runner (embedded), parses its READY line, exposes 3 routes.

### Task 4: `PreviewStatus` proto (Go + TS mirror)

**Files:** Modify `proto/proto.go`, `proto/proto.ts`. Test: `proto/proto.test.ts` (if the dir has tests; else assert via the client test in Task 9).

**Interfaces — Produces:** `PreviewStatus` in both languages (fields per the shared vocabulary block).

- [ ] **Step 1–2:** Add the Go struct with JSON tags and the TS interface; run `make typecheck` (TS) + `go build ./proto` — expect green (pure type add).

```go
// proto/proto.go  (near Project)
type PreviewStatus struct {
    Running bool   `json:"running"`
    Ready   bool   `json:"ready"`
    Port    int    `json:"port"`
    Error   string `json:"error"`
}
```
```ts
// proto/proto.ts
export interface PreviewStatus { running: boolean; ready: boolean; port: number; error: string; }
```
- [ ] **Step 3: Commit** — `git commit -am "feat(proto): PreviewStatus for component preview"`

### Task 5: Preview `Manager` (spawn, port parse, registry, stop)

**Files:** Create `daemon/internal/preview/manager.go`, `daemon/internal/preview/manager_test.go`.

**Interfaces — Produces:** `Manager` per the shared vocabulary block. Consumes: `proto.PreviewStatus`, the embedded runner (Task 7 provides `writeRunner`; for this task inject the runner script path so the manager is testable with a fake runner).

Design: `Start` writes the embedded runner to a per-daemon temp dir once (Task 7), then `exec.Command(node, runnerPath, "--cwd", cwd, "--host", "0.0.0.0", "--port", "0")`. A goroutine scans stdout for `RECK_PREVIEW_READY port=(\d+)`; `Start` blocks on a channel until ready or a 60s timeout, draining stdout after. Registry keyed by projectID; re-`Start` returns the existing ready status. `Stop`/`Shutdown` send SIGTERM then SIGKILL after a grace period.

- [ ] **Step 1: Write the failing test** (fake runner = a tiny node/sh script that prints the READY line, injected via an unexported `runnerCmd` seam)

```go
// manager_test.go
package preview

import (
    "context"
    "os"
    "path/filepath"
    "testing"
    "time"
)

// writeFakeRunner returns a script that prints a READY line with a fixed port then sleeps.
func writeFakeRunner(t *testing.T, port string) string {
    t.Helper()
    dir := t.TempDir()
    p := filepath.Join(dir, "fake.sh")
    script := "#!/bin/sh\necho \"RECK_PREVIEW_READY host=127.0.0.1 port=" + port + "\"\nsleep 30\n"
    if err := os.WriteFile(p, []byte(script), 0o755); err != nil { t.Fatal(err) }
    return p
}

func TestStartParsesPortAndReuses(t *testing.T) {
    m := newManagerForTest("/bin/sh", writeFakeRunner(t, "43111"))
    st, err := m.Start(context.Background(), "proj1", t.TempDir())
    if err != nil { t.Fatal(err) }
    if !st.Ready || st.Port != 43111 { t.Fatalf("bad status %+v", st) }
    st2, _ := m.Start(context.Background(), "proj1", t.TempDir()) // reuse, no new child
    if st2.Port != 43111 { t.Fatalf("expected reuse, got %+v", st2) }
    if got := m.Status("proj1"); !got.Running { t.Fatal("should be running") }
    m.Shutdown()
    time.Sleep(50 * time.Millisecond)
    if m.Status("proj1").Running { t.Fatal("should be stopped after shutdown") }
}

func TestStartTimeoutOnSilentRunner(t *testing.T) {
    silent := writeSilentRunner(t) // #!/bin/sh; sleep 30  (never prints READY)
    m := newManagerForTest("/bin/sh", silent)
    m.readyTimeout = 300 * time.Millisecond
    if _, err := m.Start(context.Background(), "p", t.TempDir()); err == nil {
        t.Fatal("expected timeout error")
    }
}
```

- [ ] **Step 2: Run — expect FAIL** (`go test ./daemon/internal/preview/` → undefined `newManagerForTest`).
- [ ] **Step 3: Implement `manager.go`** (registry, spawn via injected `nodePath`+`runnerPath`, stdout scanner, timeout, SIGTERM/SIGKILL, mutex-guarded map). Provide the `newManagerForTest(nodePath, runnerPath)` test seam and a `readyTimeout` field (default 60s). Keep <300 lines.
- [ ] **Step 4: Run — expect PASS.**
- [ ] **Step 5: Commit** — `git commit -am "feat(preview): daemon child manager with port/readiness parsing"`

### Task 6: HTTP routes `POST/GET/DELETE /projects/{id}/preview`

**Files:** Modify `daemon/internal/http/router.go` (routes + handlers + a `Preview *preview.Manager` field on `Server`). Test: `daemon/internal/http/preview_handler_test.go` (mirror existing handler tests; inject a `Manager` backed by a fake runner or an interface).

**Interfaces — Consumes:** `preview.Manager`, `proto.PreviewStatus`. Produces: the 3 routes, bearer-guarded like siblings.

To keep handlers testable without a real child, extract the manager surface the handlers use into a small interface:
```go
type previewController interface {
    Start(ctx context.Context, projectID, cwd string) (proto.PreviewStatus, error)
    Status(projectID string) proto.PreviewStatus
    Stop(projectID string) error
}
```

- [ ] **Step 1:** Failing handler test: POST returns 200 + JSON `PreviewStatus{ready:true,port:…}` from a stub controller; unknown project → 404 (reuse the existing project-lookup guard); GET/DELETE wired. Assert the same auth middleware chain as `/projects/{id}/panes`.
- [ ] **Step 2:** Run — expect FAIL.
- [ ] **Step 3:** Add routes near `router.go:186` (`r.Post/Get/Delete("/projects/{id}/preview", …)`), handlers resolve the project (for `cwd`) then call the controller; encode `PreviewStatus`. DELETE → 204.
- [ ] **Step 4:** Run — expect PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat(preview): daemon HTTP routes for preview lifecycle"`

### Task 7: Embed the runner + wire the manager into the daemon

**Files:** Create `daemon/internal/preview/embed.go`; modify `daemon/cmd/reck-stationd/main.go`.

**Interfaces — Produces:** `embed.go` exposes `//go:embed runner/*` + `WriteRunner(destDir string) (entryPath string, err error)` (writes `server.mjs`+siblings, returns the `server.mjs` path). Wires `NewManager(nodePath)` with `WriteRunner` in the real constructor; `main.go` resolves `node` (`exec.LookPath("node")`, tolerate absence → previews disabled with a clear status), constructs the manager, sets `srv.Preview`, and calls `m.Shutdown()` in the existing shutdown path.

- [ ] **Step 1:** Failing test `embed_test.go`: `WriteRunner(t.TempDir())` writes `server.mjs`, `plugin.mjs`, `entry-builder.mjs`, `detect.mjs`, `index.html` and returns an existing path.
- [ ] **Step 2:** Run — expect FAIL.
- [ ] **Step 3:** Implement `go:embed` (note: embed pattern is relative to `embed.go`, so `runner/*` — the runner dir is a subdir of the package, satisfying embed's no-`..` rule) + wire `main.go` (LookPath node; construct; shutdown). Guard: if `node` absent, `Start` returns `PreviewStatus{error:"node not found on station"}` (Task 5 already surfaces `error`).
- [ ] **Step 4:** Run — expect PASS; `make build` (Go) green; `make vet` clean.
- [ ] **Step 5: Commit** — `git commit -am "feat(preview): embed runner in daemon binary + lifecycle wiring"`

---

## Stage 3 — Satellite detection + client

### Task 8: `project-detect.ts` (over-mount previewability) + IPC + preload

**Files:** Create `satellite/main/project-detect.ts`, `satellite/main/project-detect.test.ts`; modify `satellite/main/file-viewer.ts` (register `preview:detect` IPC alongside the `file:*` handlers) and `satellite/preload/preload.ts` (`reckAPI.preview.detect`).

**Interfaces — Produces:** `detectProjectPreview(cwd): Promise<ProjectPreviewInfo>` + IPC `preview:detect` + `reckAPI.preview.detect(cwd)`. Consumes: `node:fs/promises` (reads over the sshfs mount).

Previewable ⇔ a `package.json` with a `vite` dependency (dep or devDep) **or** a `vite.config.*` present, AND `react` present. `reason` explains a `false` for the UI hint.

- [ ] **Step 1:** Failing test with temp dirs: vite+react → `{previewable:true}`; plain node (no vite) → `{previewable:false, reason:/vite/i}`; vite but no react → false.
- [ ] **Step 2:** Run — expect FAIL (`pnpm --dir satellite test` filtered to `project-detect`).
- [ ] **Step 3:** Implement (read+parse `package.json`, glob for `vite.config.{ts,js,mjs,mts}`; small, pure-ish). Register IPC `ipcMain.handle("preview:detect", (_e, cwd) => detectProjectPreview(cwd))` near file-viewer.ts:1491; add preload `preview: { detect: (cwd) => ipcRenderer.invoke("preview:detect", cwd) }`.
- [ ] **Step 4:** Run — expect PASS; `pnpm --dir satellite typecheck` green.
- [ ] **Step 5: Commit** — `git commit -am "feat(preview): project previewability detection + IPC"`

### Task 9: ApiClient `startPreview`/`getPreview`/`stopPreview`

**Files:** Modify `client-core/src/api/client.ts`; test `client-core/src/api/client.preview.test.ts`.

**Interfaces — Produces:** the 3 methods (shared vocabulary block). Consumes: `PreviewStatus`, the existing `fetch(this.config.baseUrl + path, …)` + bearer pattern (client.ts:95).

- [ ] **Step 1:** Failing test with a mocked `fetch`: `startPreview("p")` POSTs `/projects/p/preview` with the bearer header and returns the parsed `PreviewStatus`; `getPreview` GETs; `stopPreview` DELETEs and resolves void; non-2xx → throws (mirror existing error handling in the client).
- [ ] **Step 2:** Run — expect FAIL.
- [ ] **Step 3:** Implement the 3 methods mirroring an existing method's shape (headers/error handling).
- [ ] **Step 4:** Run — expect PASS; typecheck green.
- [ ] **Step 5: Commit** — `git commit -am "feat(client): preview lifecycle methods on ApiClient"`

---

## Stage 4 — Satellite viewer wiring

### Task 10: Extend `pickViewerMode` with `component`

**Files:** Modify `satellite/renderer/src/viewer/pickViewerMode.ts`, `pickViewerMode.test.ts`.

**Interfaces — Produces:** `isComponentPath`, `ViewerMode "component"`, `pickViewerMode(path, persisted, opts?)` per shared vocabulary. Consumes: nothing (pure).

Precedence: `persisted === "source"` → `source`. Else md → markdown-rendered; html → html-static; component-path **and** `opts.componentPreviewAvailable` → `component`; else source. (A `.tsx` in a non-Vite project → `source`, so nothing regresses.)

- [ ] **Step 1:** Add failing matrix cases: `Button.tsx` + `{componentPreviewAvailable:true}` → `"component"`; same without the flag → `"source"`; `persisted:"source"` overrides to `"source"`; existing md/html/source cases unchanged.
- [ ] **Step 2:** Run — expect FAIL.
- [ ] **Step 3:** Implement: add `isComponentPath = (p) => /\.(t|j)sx$/i.test(p)`; extend the union; add the guarded branch; keep `isRenderablePath` as-is (component-availability is not a pure path fact, so it is NOT folded into `isRenderablePath`).
- [ ] **Step 4:** Run — expect PASS.
- [ ] **Step 5: Commit** — `git commit -am "feat(viewer): component render mode in pickViewerMode"`

### Task 11: `ComponentPreview.ts` iframe host

**Files:** Create `satellite/renderer/src/viewer/ComponentPreview.ts`, `ComponentPreview.test.ts`; add `.file-viewer-component-*` styles to `satellite/renderer/src/styles.css`.

**Interfaces — Produces:** `createComponentPreview(opts): ComponentPreviewHandle` (shared vocabulary). Consumes: a `PreviewApi` slice (`startPreview`/`getPreview`/`stopPreview`), `stationHost`.

Behavior: mount a container with a readiness spinner → call `api.startPreview(projectId)` → on ready, set `iframe.src = http://<stationHost>:<port>/?target=<encodeURIComponent(targetRelPath)>`; the iframe has **no** `sandbox="allow-same-origin"` and no `allow` grants beyond default. On error/timeout, render a degrade panel with `status.error` (or "not a previewable project") and call `opts.onError`. `dispose()` removes the iframe and calls `api.stopPreview(projectId)` (best-effort; ignore rejection).

- [ ] **Step 1: Failing test** (jsdom; a fake `PreviewApi`)

```ts
// ComponentPreview.test.ts
import { describe, it, expect, vi } from "vitest";
import { createComponentPreview } from "./ComponentPreview";

const ready = { running: true, ready: true, port: 43000, error: "" };

describe("createComponentPreview", () => {
  it("frames the station dev server with the encoded target when ready", async () => {
    const api = { startPreview: vi.fn().mockResolvedValue(ready), getPreview: vi.fn(), stopPreview: vi.fn().mockResolvedValue(undefined) };
    const h = createComponentPreview({ api, projectId: "p", stationHost: "100.1.2.3", targetRelPath: "src/components/Button.tsx" });
    document.body.appendChild(h.el);
    await Promise.resolve(); await Promise.resolve();
    const iframe = h.el.querySelector("iframe")!;
    expect(iframe.getAttribute("src")).toBe("http://100.1.2.3:43000/?target=src%2Fcomponents%2FButton.tsx");
    expect(iframe.getAttribute("sandbox")).toBeNull(); // cross-origin isolation; no allow-same-origin
  });

  it("shows a degrade panel and calls onError when start fails", async () => {
    const api = { startPreview: vi.fn().mockResolvedValue({ running:false, ready:false, port:0, error:"node not found on station" }), getPreview: vi.fn(), stopPreview: vi.fn().mockResolvedValue(undefined) };
    const onError = vi.fn();
    const h = createComponentPreview({ api, projectId: "p", stationHost: "h", targetRelPath: "a.tsx", onError });
    document.body.appendChild(h.el);
    await Promise.resolve(); await Promise.resolve();
    expect(h.el.textContent).toMatch(/node not found/);
    expect(onError).toHaveBeenCalled();
    expect(h.el.querySelector("iframe")).toBeNull();
  });

  it("stops the preview on dispose", async () => {
    const api = { startPreview: vi.fn().mockResolvedValue(ready), getPreview: vi.fn(), stopPreview: vi.fn().mockResolvedValue(undefined) };
    const h = createComponentPreview({ api, projectId: "p", stationHost: "h", targetRelPath: "a.tsx" });
    document.body.appendChild(h.el);
    await Promise.resolve();
    h.dispose();
    expect(api.stopPreview).toHaveBeenCalledWith("p");
  });
});
```

- [ ] **Step 2:** Run — expect FAIL.
- [ ] **Step 3:** Implement (container div + spinner; async start; build src with `new URL`-safe encoding — use the exact `http://${host}:${port}/?target=${encodeURIComponent(rel)}` string the test asserts; degrade panel; dispose). Add styles.
- [ ] **Step 4:** Run — expect PASS; typecheck green.
- [ ] **Step 5: Commit** — `git commit -am "feat(viewer): ComponentPreview iframe host + lifecycle"`

### Task 12: Wire `component` arm into `FileViewerHost` + SurfaceKind

**Files:** Modify `satellite/renderer/src/viewer/FileViewerHost.ts`, `tts/SpeakSurfaceAdapter.ts`, `search/SearchSurfaceAdapter.ts`. Test: extend `FileViewerHost` tests if present; otherwise a focused test that the classifier→arm selection produces a `ComponentPreview` (mock `createComponentPreview`).

**Interfaces — Consumes:** `pickViewerMode` (with `componentPreviewAvailable`), `createComponentPreview`, `reckAPI.preview.detect`, the station `ApiClient`, `stationHostFromUrl`.

Threading: before calling `pickViewerMode`, resolve `componentPreviewAvailable` = (path is component) && `(await reckAPI.preview.detect(projectCwd)).previewable`, cached per project. Add `else if (mode === "component")` arms in **both** `renderForPath` (~1475/1511) and `renderStationRemote` (~1082), mounting `createComponentPreview({ api, projectId, stationHost, targetRelPath })` into `shell.body`. `targetRelPath` = the opened file made relative to `projectCwd`. TTS/search read **source** in Phase B (spec §9) — so the `component` arm does **not** call `attachSpeakAndSearch` over the iframe; add `"component"` to both `SurfaceKind` unions now (cheap, forward-looking for Phase D) but do not wire an adapter yet.

- [ ] **Step 1:** Failing test: with `preview.detect` stubbed `previewable:true` and `pickViewerMode` returning `component`, the render path calls the (mocked) `createComponentPreview` with the encoded rel path + station host; with `previewable:false`, it falls back to the source arm.
- [ ] **Step 2:** Run — expect FAIL.
- [ ] **Step 3:** Implement both arms + the `componentPreviewAvailable` resolution + `SurfaceKind` additions.
- [ ] **Step 4:** Run — expect PASS; `pnpm --dir satellite typecheck` + full `pnpm --dir satellite test` green.
- [ ] **Step 5: Commit** — `git commit -am "feat(viewer): component-live arm in both render paths"`

- [ ] **Task 12b (optional — only if D3 tailnet check fails): SSH `-L` fallback.** If the user's Tailscale ACLs block non-`7315` ports, add a satellite-main helper that opens `ssh -L <localPort>:127.0.0.1:<devPort> <reck-station>` (reusing the existing sshfs identity) and have `ComponentPreview` frame `http://127.0.0.1:<localPort>/`. Gate behind a setting; skip entirely if the direct port works.

---

## Stage 5 — E2E + spec/issue reconciliation

### Task 13: Playwright-electron e2e (live component; cannot call reckAPI)

**Files:** Create `satellite/e2e-electron/component-preview.spec.ts`.

**Requires a live station** (daemon + the fixture project reachable on the tailnet) — coordinate with the user; this is the human-run acceptance for issue #44.

- [ ] **Step 1:** Spec: open the fixture's `src/components/Button.tsx` in the viewer → assert the iframe loads and the button shows the aliased `LABEL` text **with the Tailwind class computed** (`getComputedStyle(button).color` is the Tailwind red, proving `global.css` reached it — the visual proof deferred from Task 3).
- [ ] **Step 2:** Assert isolation: evaluate inside the iframe that `window.reckAPI === undefined`.
- [ ] **Step 3:** Assert HMR: edit `LABEL` in `src/theme.ts` on the station → the framed text updates without a reload.
- [ ] **Step 4:** Run `pnpm --dir satellite test:e2e:electron` — expect PASS (or documented-skip when no station is attached, with a clear log line — never silently skip).
- [ ] **Step 5: Commit** — `git commit -am "test(preview): e2e live component render + isolation + HMR"`

### Task 14: Provider fixtures & acceptance (auto-wrap + manual override)

**Files:** extend the fixture; add `daemon/internal/preview/runner/detect.test.mjs` cases (done in Task 2) + a runner integration assertion that the themed provider's `data-provider` wrapper appears in the entry graph.

- [ ] **Step 1:** Add an integration assertion (Task 3 harness): `GET /@reck/entry?target=…` includes the `/@reck/providers` import when `src/Providers.tsx` exists; add a `Button.reck-preview.tsx` override fixture and assert `detectProviders` returns it (override wins).
- [ ] **Step 2–4:** Run — expect PASS.
- [ ] **Step 5: Commit** — `git commit -am "test(preview): provider auto-wrap + manual override acceptance"`

### Task 15: Reconcile spec + issue #44 with DECISION D1

**Files:** Modify `docs/superpowers/specs/2026-07-02-html-react-viewer-design.md` (§3 "Daemon — the gap", §6(C), §9 Phase B). Update GitHub issue #44 body.

- [ ] **Step 1:** Edit spec §3/§6/§9: replace "v1 needs no daemon changes / pane" with the D1 mechanism (minimal daemon preview endpoint + embedded Node runner + stdout port parse); note SSH-exec was the rejected alternative and full service/proxy remains Phase C.
- [ ] **Step 2:** `gh issue edit 44 --repo mehdigreefhorst/reck-connect` — update the "Station runner" bullet to reflect Go daemon manager + embedded Node runner (not a pnpm package) and the 3 endpoints.
- [ ] **Step 3: Commit** — `git commit -am "docs(preview): reconcile spec + issue #44 with daemon-endpoint decision (D1)"`

---

## Final whole-branch review & finish

After Task 15: dispatch the whole-branch code review (superpowers:requesting-code-review) over `merge-base(feat/html-static-viewer, HEAD)..HEAD`, then use superpowers:finishing-a-development-branch. PR body must include `Closes #44` (per CLAUDE.md — one closing keyword) and reference the spec correction. Stack note: this branch is on `feat/html-static-viewer`; rebase onto `main` once PR #55 merges.

## Acceptance criteria (issue #44) → coverage map

- project-detect classifies Vite/plain + finds global.css → **Task 8** (classify) + **Task 2** (global.css).
- integration test: fixture component renders with a Tailwind class applied + aliased import resolves → **Task 3** (alias + entry graph, non-browser) + **Task 13** (computed Tailwind color, browser).
- e2e: live component renders in iframe, updates on edit (HMR), cannot call reckAPI → **Task 13**.
- provider auto-wrap for a themed fixture; manual override respected → **Task 2 + 14**.

## Risks (delta from spec §12)

| Risk | Mitigation |
|---|---|
| **`node` absent on station** | Manager surfaces `PreviewStatus.error`; ComponentPreview degrades with the message (Task 5/7/11). |
| Per-target virtual entry coupling (`load.lastTarget`) | Acceptable for single-target v1; reviewer may fold providers inline (Task 3 note). |
| Tailnet ACL blocks non-7315 port (D3) | Confirm with user before Task 13; Task 12b SSH `-L` fallback; Phase C proxy is the end state. |
| Dev server sends `X-Frame-Options` | Vite dev does not by default; if a project config adds it, add `session.defaultSession.webRequest.onHeadersReceived` (greenfield — flag to user, likely unnecessary). |
| Fixture `node_modules` install in tests | Integration/e2e install on first run + are guarded/skippable in CI with a logged reason; must pass locally before merge. |
