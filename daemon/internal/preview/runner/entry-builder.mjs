// entry-builder.mjs
// Synthesizes the "auto page.tsx": imports the target component, the app's
// own side-effect imports (global CSS, fonts, polyfills — replicated from the
// real entry so the preview matches the app's look), and a Providers wrapper,
// then mounts into #root. Emitted as plain JS (React.createElement) so no JSX
// transform is needed on this module.

/** @param {{targetRelPath:string, sideEffectImports?:string[], hasProviders:boolean}} o */
export function buildPreviewEntry({ targetRelPath, sideEffectImports = [], hasProviders }) {
  const abs = (p) => "/" + String(p).replace(/^\/+/, "");
  const lines = [
    `import React from "react";`,
    `import { createRoot } from "react-dom/client";`,
    `import Component from "${abs(targetRelPath)}";`,
  ];
  // Emit each specifier verbatim (already resolved to a root-absolute or bare
  // form by detectSideEffectImports); order is preserved from the real entry.
  for (const spec of sideEffectImports) lines.push(`import "${spec}";`);
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
    const clause =
      providersExport === "Providers"
        ? `Providers`
        : `${providersExport} as Providers`;
    return `export { ${clause} } from "${providersImportPath}";\n`;
  }
  return `export const Providers = ({ children }) => children;\n`;
}
