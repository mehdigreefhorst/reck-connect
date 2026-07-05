// detect.mjs
import { readFile, access } from "node:fs/promises";
import { join, dirname, basename, extname } from "node:path";

const CSS_CANDIDATES = ["src/index.css", "src/globals.css", "src/global.css", "src/styles/globals.css", "app/globals.css", "styles/globals.css"];
const TAILWIND_RE = /@tailwind\b|@import\s+["']tailwindcss["']/;
const PROVIDER_CANDIDATES = [ // [relPath, exportName]
  ["src/Providers.tsx", "Providers"], ["src/Providers.jsx", "Providers"],
  ["src/providers.tsx", "Providers"], ["app/providers.tsx", "Providers"],
  ["src/AppProviders.tsx", "AppProviders"],
];

const exists = async (p) => { try { await access(p); return true; } catch { return false; } };

/** @returns {Promise<string|null>} project-root-relative css path */
export async function detectGlobalCss(cwd) {
  const present = [];
  for (const rel of CSS_CANDIDATES) if (await exists(join(cwd, rel))) present.push(rel);
  if (present.length === 0) return null;
  for (const rel of present) {
    try { if (TAILWIND_RE.test(await readFile(join(cwd, rel), "utf8"))) return rel; } catch { /* ignore */ }
  }
  return present[0];
}

/** @returns {Promise<{importPath:string, exportName:string}|null>} */
export async function detectProviders(cwd, targetRelPath) {
  // 1. manual override sibling: <name>.reck-preview.tsx exporting wrap
  const dir = dirname(targetRelPath);
  const stem = basename(targetRelPath, extname(targetRelPath));
  for (const ext of [".tsx", ".jsx"]) {
    const rel = join(dir, `${stem}.reck-preview${ext}`).replace(/\\/g, "/");
    if (await exists(join(cwd, rel))) return { importPath: "/" + rel, exportName: "wrap" };
  }
  // 2. inferred root providers
  for (const [rel, name] of PROVIDER_CANDIDATES) {
    if (await exists(join(cwd, rel))) return { importPath: "/" + rel, exportName: name };
  }
  return null;
}
