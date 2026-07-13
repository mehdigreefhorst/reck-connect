// entry-builder.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPreviewEntry, buildProvidersModule } from "./entry-builder.mjs";

test("entry imports target, every side-effect import, providers, and mounts #root", () => {
  const src = buildPreviewEntry({
    targetRelPath: "src/components/Button.tsx",
    sideEffectImports: ["/src/theme/fonts", "/src/theme/tokens.css", "/src/theme/global.css"],
    hasProviders: true,
  });
  assert.match(src, /import Component from "\/src\/components\/Button\.tsx"/);
  // all side-effect imports emitted verbatim, in order
  assert.match(src, /import "\/src\/theme\/fonts";/);
  assert.match(src, /import "\/src\/theme\/tokens\.css";/);
  assert.match(src, /import "\/src\/theme\/global\.css";/);
  const order = ["/src/theme/fonts", "/src/theme/tokens.css", "/src/theme/global.css"].map((s) =>
    src.indexOf(`import "${s}";`),
  );
  assert.ok(order[0] < order[1] && order[1] < order[2], "side-effect imports preserve source order");
  assert.match(src, /from "\/@reck\/providers"/);
  assert.match(src, /createRoot\(document\.getElementById\("root"\)\)/);
  assert.match(src, /React\.createElement\(Providers, null, React\.createElement\(Component\)\)/);
});

test("entry emits no side-effect imports when the list is empty", () => {
  const src = buildPreviewEntry({ targetRelPath: "a.tsx", sideEffectImports: [], hasProviders: false });
  // only the two harness imports (react, react-dom) plus the Component import
  assert.doesNotMatch(src, /import "[^"]*\.css"/);
  assert.match(src, /React\.createElement\(Component\)/); // no Providers wrapper
  // truly pins wrapper-absence: /React\.createElement\(Component\)/ also matches the
  // wrapped form, so assert the Providers import itself is absent.
  assert.doesNotMatch(src, /@reck\/providers/);
});

test("entry tolerates an omitted sideEffectImports (defaults to none)", () => {
  const src = buildPreviewEntry({ targetRelPath: "a.tsx", hasProviders: false });
  assert.doesNotMatch(src, /import "[^"]*\.css"/);
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
