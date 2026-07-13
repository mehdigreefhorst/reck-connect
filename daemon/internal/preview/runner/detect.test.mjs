// detect.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  detectGlobalCss,
  detectProviders,
  detectEntrySideEffects,
  detectSideEffectImports,
  detectEntryProvidersModule,
} from "./detect.mjs";

function scaffold() {
  const d = mkdtempSync(join(tmpdir(), "reck-detect-"));
  mkdirSync(join(d, "src", "components"), { recursive: true });
  return d;
}

const INDEX_HTML = (src) =>
  `<!doctype html><html><body><div id="root"></div>` +
  `<script type="module" src="${src}"></script></body></html>\n`;

test("detectGlobalCss prefers a Tailwind css file", async () => {
  const d = scaffold();
  writeFileSync(join(d, "src", "index.css"), "@tailwind base;\n@tailwind utilities;\n");
  assert.equal(await detectGlobalCss(d), "src/index.css");
});

test("detectGlobalCss returns null when no candidate exists", async () => {
  assert.equal(await detectGlobalCss(scaffold()), null);
});

test("detectGlobalCss falls back to the first existing file when none is Tailwind", async () => {
  const d = scaffold();
  // a candidate that exists but has NO @tailwind directive, and no other tailwind candidate
  writeFileSync(join(d, "src", "globals.css"), "body { margin: 0; }\n");
  // exercises the present[0] fallback branch (first existing, non-Tailwind)
  assert.equal(await detectGlobalCss(d), "src/globals.css");
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

test("manual override beats an inferred root Providers", async () => {
  const d = scaffold();
  // BOTH a root candidate AND an override sibling exist — override must win
  writeFileSync(join(d, "src", "Providers.tsx"), "export function Providers({children}){return children}\n");
  writeFileSync(join(d, "src", "components", "Button.reck-preview.tsx"), "export const wrap = (c) => c;\n");
  const p = await detectProviders(d, "src/components/Button.tsx");
  assert.equal(p.importPath, "/src/components/Button.reck-preview.tsx");
  assert.equal(p.exportName, "wrap");
});

test("detectProviders returns null when neither an override nor a root candidate exists", async () => {
  const p = await detectProviders(scaffold(), "src/components/Button.tsx");
  assert.equal(p, null);
});

test("detectEntrySideEffects follows index.html to the real entry and lists its side-effect imports", async () => {
  const d = scaffold();
  writeFileSync(join(d, "index.html"), INDEX_HTML("/src/main.tsx"));
  writeFileSync(
    join(d, "src", "main.tsx"),
    [
      `import { StrictMode } from "react";`,
      `import App from "./App";`, // has a binding -> NOT a side effect
      `import "./theme/fonts";`,
      `import "./theme/tokens.css";`,
      `import "./theme/global.css";`,
      `createRoot(document.getElementById("root")).render(<App />);`,
    ].join("\n"),
  );
  // relative specifiers resolve to root-absolute, in source order; the app
  // component import (has a binding) is excluded so we never double-mount.
  assert.deepEqual(await detectEntrySideEffects(d), [
    "/src/theme/fonts",
    "/src/theme/tokens.css",
    "/src/theme/global.css",
  ]);
});

test("detectEntrySideEffects keeps bare/absolute specifiers verbatim", async () => {
  const d = scaffold();
  writeFileSync(join(d, "index.html"), INDEX_HTML("/src/main.tsx"));
  writeFileSync(
    join(d, "src", "main.tsx"),
    [`import "modern-normalize";`, `import "/src/index.css";`, `import "../shared/base.css";`].join("\n"),
  );
  assert.deepEqual(await detectEntrySideEffects(d), [
    "modern-normalize",
    "/src/index.css",
    "/shared/base.css",
  ]);
});

test("detectEntrySideEffects returns [] when there is no index.html", async () => {
  assert.deepEqual(await detectEntrySideEffects(scaffold()), []);
});

test("detectEntrySideEffects returns [] when the referenced entry file is missing", async () => {
  const d = scaffold();
  writeFileSync(join(d, "index.html"), INDEX_HTML("/src/main.tsx")); // no main.tsx on disk
  assert.deepEqual(await detectEntrySideEffects(d), []);
});

// ---------------------------------------------------------------------------
// detectEntryProvidersModule: transform the app's REAL entry into a Providers
// module — the render tree's wrappers are kept verbatim, the app leaf becomes
// {children}. This is how context-dependent components (useToast etc.) get the
// same providers the real app mounts, with zero per-file setup.
// ---------------------------------------------------------------------------

const MAIN_WITH_PROVIDERS = [
  `import { StrictMode } from "react";`,
  `import { createRoot } from "react-dom/client";`,
  `import App from "./App";`,
  `import { ToastProvider } from "./providers/ToastProvider";`,
  `import "./theme/global.css";`,
  ``,
  `createRoot(document.getElementById("root")!).render(`,
  `  <StrictMode>`,
  `    <ToastProvider>`,
  `      <App />`,
  `    </ToastProvider>`,
  `  </StrictMode>,`,
  `);`,
].join("\n");

function scaffoldEntry(main) {
  const d = scaffold();
  writeFileSync(join(d, "index.html"), INDEX_HTML("/src/main.tsx"));
  writeFileSync(join(d, "src", "main.tsx"), main);
  return d;
}

test("entry providers module replays the render tree's wrappers around {children}", async () => {
  const mod = await detectEntryProvidersModule(scaffoldEntry(MAIN_WITH_PROVIDERS));
  assert.ok(mod, "expected a module for a wrapped render tree");
  const src = mod.source;
  assert.match(src, /export const Providers = \(\{ children \}\)/);
  // wrappers preserved, in order, around {children}
  const iStrict = src.indexOf("<StrictMode>");
  const iToast = src.indexOf("<ToastProvider>");
  const iChildren = src.indexOf("{children}");
  assert.ok(iStrict !== -1 && iToast !== -1 && iChildren !== -1, "wrapper tree with {children} present");
  assert.ok(iStrict < iToast && iToast < iChildren, "wrapper order preserved down to the leaf");
  // the app leaf is gone (never double-mount the real app) and so is its import
  assert.doesNotMatch(src, /<App/);
  assert.doesNotMatch(src, /import App from/);
  // the original render call is gone — this module only exports Providers
  assert.doesNotMatch(src, /\.render\(/);
  // relative imports rewritten root-absolute so the virtual module resolves
  assert.match(src, /from "\/src\/providers\/ToastProvider"/);
  assert.match(src, /import "\/src\/theme\/global\.css"/);
});

test("entry providers module keeps top-level setup code (query clients etc.)", async () => {
  const mod = await detectEntryProvidersModule(
    scaffoldEntry(
      [
        `import App from "./App";`,
        `import { QueryClient, QueryClientProvider } from "@tanstack/react-query";`,
        `const queryClient = new QueryClient();`,
        `createRoot(document.getElementById("root")).render(`,
        `  <QueryClientProvider client={queryClient}>`,
        `    <App />`,
        `  </QueryClientProvider>,`,
        `);`,
      ].join("\n"),
    ),
  );
  assert.ok(mod);
  // the const the provider's prop references must survive the transform
  assert.match(mod.source, /const queryClient = new QueryClient\(\);/);
  assert.match(mod.source, /<QueryClientProvider client=\{queryClient\}>/);
  assert.match(mod.source, /\{children\}/);
});

test("entry providers module falls back to the only self-closing leaf when no relative default import matches", async () => {
  const mod = await detectEntryProvidersModule(
    scaffoldEntry(
      [
        `import { ThemeProvider } from "styled-components";`,
        `import { RouterProvider } from "react-router-dom";`,
        `import { router } from "./router";`,
        `createRoot(document.getElementById("root")).render(`,
        `  <ThemeProvider theme={{}}>`,
        `    <RouterProvider router={router} />`,
        `  </ThemeProvider>,`,
        `);`,
      ].join("\n"),
    ),
  );
  assert.ok(mod, "single self-closing element is the app leaf");
  assert.match(mod.source, /<ThemeProvider theme=\{\{\}\}>/);
  assert.match(mod.source, /\{children\}/);
  assert.doesNotMatch(mod.source, /<RouterProvider/);
});

test("entry providers module is null when the render tree has no wrappers", async () => {
  const mod = await detectEntryProvidersModule(
    scaffoldEntry(
      [`import App from "./App";`, `createRoot(document.getElementById("root")).render(<App />);`].join("\n"),
    ),
  );
  assert.equal(mod, null);
});

test("entry providers module is null without index.html or without a render call", async () => {
  assert.equal(await detectEntryProvidersModule(scaffold()), null);
  assert.equal(
    await detectEntryProvidersModule(scaffoldEntry(`import "./theme/global.css";\n`)),
    null,
  );
});

test("entry providers module is null when the leaf is ambiguous (sibling self-closing elements)", async () => {
  // <Toaster/> beside <App/> at the same level with no matching default import —
  // guessing wrong would silently drop UI, so we bail to the legacy behavior.
  const mod = await detectEntryProvidersModule(
    scaffoldEntry(
      [
        `import { Shell } from "./shell";`,
        `import { Toaster } from "sonner";`,
        `import { Widget } from "./widget";`,
        `createRoot(document.getElementById("root")).render(`,
        `  <Shell>`,
        `    <Widget />`,
        `    <Toaster />`,
        `  </Shell>,`,
        `);`,
      ].join("\n"),
    ),
  );
  assert.equal(mod, null);
});

test("detectProviders prefers entry-derived providers over a conventional Providers.tsx", async () => {
  const d = scaffoldEntry(MAIN_WITH_PROVIDERS);
  writeFileSync(join(d, "src", "Providers.tsx"), "export function Providers({children}){return children}\n");
  const p = await detectProviders(d, "src/components/Button.tsx");
  assert.ok(p.source, "entry-derived module wins over the conventional file");
  assert.equal(p.importPath, undefined);
});

test("detectProviders: manual override sibling still beats entry-derived providers", async () => {
  const d = scaffoldEntry(MAIN_WITH_PROVIDERS);
  writeFileSync(join(d, "src", "components", "Button.reck-preview.tsx"), "export const wrap = (c) => c;\n");
  const p = await detectProviders(d, "src/components/Button.tsx");
  assert.equal(p.importPath, "/src/components/Button.reck-preview.tsx");
  assert.equal(p.exportName, "wrap");
});

test("detectSideEffectImports prefers the entry, falling back to the CSS candidate scan", async () => {
  // entry present -> uses entry side effects
  const withEntry = scaffold();
  writeFileSync(join(withEntry, "index.html"), INDEX_HTML("/src/main.tsx"));
  writeFileSync(join(withEntry, "src", "main.tsx"), `import "./theme/global.css";\n`);
  assert.deepEqual(await detectSideEffectImports(withEntry), ["/src/theme/global.css"]);

  // no entry -> falls back to detectGlobalCss, normalized to a root-absolute import
  const fallback = scaffold();
  writeFileSync(join(fallback, "src", "index.css"), "body { margin: 0; }\n");
  assert.deepEqual(await detectSideEffectImports(fallback), ["/src/index.css"]);

  // nothing at all -> empty
  assert.deepEqual(await detectSideEffectImports(scaffold()), []);
});
