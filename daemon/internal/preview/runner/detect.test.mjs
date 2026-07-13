// detect.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectGlobalCss, detectProviders, detectEntrySideEffects, detectSideEffectImports } from "./detect.mjs";

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
