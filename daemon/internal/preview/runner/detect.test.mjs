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
