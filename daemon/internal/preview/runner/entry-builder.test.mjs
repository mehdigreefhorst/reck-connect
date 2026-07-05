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
  // truly pins wrapper-absence: /React\.createElement\(Component\)/ also matches the
  // wrapped form, so assert the Providers import itself is absent.
  assert.doesNotMatch(src, /@reck\/providers/);
});

test("providers module re-exports detected wrap or passes through", () => {
  const wrapped = buildProvidersModule({ providersImportPath: "/src/Providers.tsx", providersExport: "Providers" });
  assert.match(wrapped, /export \{ Providers \}/);
  // pins the aliased branch — the exact branch detect hits for a *.reck-preview.tsx
  // override (exportName "wrap"); only "Providers"-named exports were tested before.
  const aliased = buildProvidersModule({ providersImportPath: "/src/Providers.tsx", providersExport: "wrap" });
  assert.match(aliased, /export \{ wrap as Providers \}/);
  const bare = buildProvidersModule({ providersImportPath: null, providersExport: null });
  assert.match(bare, /export const Providers = \(\{ children \}\) => children/);
});
