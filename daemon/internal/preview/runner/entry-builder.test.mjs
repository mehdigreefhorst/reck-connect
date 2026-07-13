// entry-builder.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildPreviewEntry, buildProvidersModule, pickComponent } from "./entry-builder.mjs";

test("entry imports target, every side-effect import, providers, and mounts #root", () => {
  const src = buildPreviewEntry({
    targetRelPath: "src/components/Button.tsx",
    sideEffectImports: ["/src/theme/fonts", "/src/theme/tokens.css", "/src/theme/global.css"],
    hasProviders: true,
  });
  // namespace import + runtime resolution (supports default OR named exports)
  assert.match(src, /import \* as __mod from "\/src\/components\/Button\.tsx"/);
  assert.match(src, /const Component = pickComponent\(__mod, "Button"\)/);
  assert.match(src, /No React component export found/); // clear failure branch present
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

test("pickComponent prefers default, then the file-stem export, then the first PascalCase component", () => {
  const Fn = () => null;
  // default export wins over a same-named export
  assert.equal(pickComponent({ default: Fn, ChatThread: () => null }, "ChatThread"), Fn);
  // no default -> the export named like the file (ChatThread.tsx -> ChatThread)
  const Named = () => null;
  assert.equal(pickComponent({ ChatThread: Named, useThing: () => null }, "ChatThread"), Named);
  // no default and no stem match -> first PascalCase component, skipping the lowercase helper
  const Widget = () => null;
  assert.equal(pickComponent({ helper: () => null, Widget }, "Nope"), Widget);
  // forwardRef/memo components are objects, not functions — still recognized
  const memoish = { $$typeof: Symbol.for("react.memo"), type: () => null };
  assert.equal(pickComponent({ ChatThread: memoish }, "ChatThread"), memoish);
  // nothing component-like -> null (drives the thrown "needs a component export" error)
  assert.equal(pickComponent({ count: 1, label: "x" }, "ChatThread"), null);
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
