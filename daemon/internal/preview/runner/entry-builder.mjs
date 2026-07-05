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
    const clause =
      providersExport === "Providers"
        ? `Providers`
        : `${providersExport} as Providers`;
    return `export { ${clause} } from "${providersImportPath}";\n`;
  }
  return `export const Providers = ({ children }) => children;\n`;
}
