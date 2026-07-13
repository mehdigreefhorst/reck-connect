// entry-builder.mjs
// Synthesizes the "auto page.tsx": imports the target module, the app's own
// side-effect imports (global CSS, fonts, polyfills — replicated from the real
// entry so the preview matches the app's look), and a Providers wrapper, then
// mounts into #root. Emitted as plain JS (React.createElement) so no JSX
// transform is needed on this module.
//
// The target is imported as a NAMESPACE (`import * as`) and the component is
// resolved at runtime by `pickComponent`, so files that export their component
// as a NAMED export (`export function ChatThread`) work, not just default
// exports. `pickComponent` is serialized into the emitted entry (below) so the
// resolution rule has a single, unit-tested source of truth.

import { basename, extname } from "node:path";

/**
 * Resolve the React component from a target module's namespace. Preference:
 *   1. the default export, if it looks like a component;
 *   2. the export named like the file (`ChatThread.tsx` -> `ChatThread`);
 *   3. the first PascalCase component-ish export.
 * Returns null when nothing component-like is found. "Component-ish" accepts
 * functions/classes AND React object components (forwardRef/memo carry a
 * `$$typeof`). Kept dependency-free so it survives `.toString()` serialization.
 * @param {Record<string, unknown>} mod
 * @param {string} stem
 */
export function pickComponent(mod, stem) {
  const isComp = (v) =>
    typeof v === "function" ||
    (v != null && typeof v === "object" && "$$typeof" in v);
  if (isComp(mod.default)) return mod.default;
  if (isComp(mod[stem])) return mod[stem];
  const named = Object.entries(mod).find(([k, v]) => /^[A-Z]/.test(k) && isComp(v));
  return named ? named[1] : null;
}

/** @param {{targetRelPath:string, sideEffectImports?:string[], hasProviders:boolean}} o */
export function buildPreviewEntry({ targetRelPath, sideEffectImports = [], hasProviders }) {
  const abs = (p) => "/" + String(p).replace(/^\/+/, "");
  const stem = basename(targetRelPath, extname(targetRelPath));
  const lines = [
    `import React from "react";`,
    `import { createRoot } from "react-dom/client";`,
    `import * as __mod from "${abs(targetRelPath)}";`,
  ];
  // Emit each specifier verbatim (already resolved to a root-absolute or bare
  // form by detectSideEffectImports); order is preserved from the real entry.
  for (const spec of sideEffectImports) lines.push(`import "${spec}";`);
  if (hasProviders) lines.push(`import { Providers } from "/@reck/providers";`);
  // Inline the resolver (single source of truth via .toString()) and resolve.
  lines.push(pickComponent.toString());
  lines.push(`const Component = pickComponent(__mod, ${JSON.stringify(stem)});`);
  lines.push(
    `if (!Component) { throw new Error(${JSON.stringify(
      `No React component export found in ${targetRelPath}. ` +
        `Expected a default export or one named "${stem}".`,
    )}); }`,
  );
  const tree = hasProviders
    ? `React.createElement(Providers, null, React.createElement(Component))`
    : `React.createElement(Component)`;
  lines.push(`createRoot(document.getElementById("root")).render(${tree});`);
  return lines.join("\n") + "\n";
}

/** @param {{providersImportPath:string|null, providersExport:string|null}} o */
export function buildProvidersModule({ providersImportPath, providersExport }) {
  if (providersImportPath && providersExport) {
    const clause =
      providersExport === "Providers"
        ? `Providers`
        : `${providersExport} as Providers`;
    return `export { ${clause} } from "${providersImportPath}";\n`;
  }
  return `export const Providers = ({ children }) => children;\n`;
}
