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
