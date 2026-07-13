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

/**
 * Follow the project's real entry (via index.html's module `<script src>`) and
 * return its top-level *side-effect* imports (global CSS, font setup, polyfills)
 * as specifiers ready to emit into the synthesized entry: relative specifiers
 * resolved to root-absolute (`/src/theme/tokens.css`), bare and already-absolute
 * specifiers kept verbatim. Imports that bind a name (`import App from "./App"`)
 * are excluded, so we replicate the app's styling setup without re-mounting it.
 * @returns {Promise<string[]>}
 */
export async function detectEntrySideEffects(cwd) {
  let html;
  try { html = await readFile(join(cwd, "index.html"), "utf8"); } catch { return []; }
  const entrySrc = findModuleScriptSrc(html);
  if (!entrySrc) return [];
  const entryRel = entrySrc.replace(/^\/+/, ""); // "src/main.tsx"
  let source;
  try { source = await readFile(join(cwd, entryRel), "utf8"); } catch { return []; }
  const entryDir = dirname(entryRel); // "src"
  const specs = [];
  const re = /^\s*import\s+["']([^"']+)["']\s*;?\s*$/gm; // bare side-effect imports only
  let m;
  while ((m = re.exec(source)) !== null) specs.push(resolveSpecifier(m[1], entryDir));
  return specs;
}

/** First `<script type="module" src="...">` src in the html, or null. */
function findModuleScriptSrc(html) {
  const tagRe = /<script\b([^>]*)>/gi;
  let t;
  while ((t = tagRe.exec(html)) !== null) {
    const attrs = t[1];
    if (!/\btype=["']module["']/i.test(attrs)) continue;
    const s = /\bsrc=["']([^"']+)["']/i.exec(attrs);
    if (s) return s[1];
  }
  return null;
}

/** Resolve an import specifier for emission from the synthesized entry. */
function resolveSpecifier(spec, entryDir) {
  if (spec.startsWith("/")) return spec; // already root-absolute
  if (spec.startsWith("./") || spec.startsWith("../")) {
    const joined = join(entryDir, spec).replace(/\\/g, "/");
    return "/" + joined.replace(/^\/+/, "");
  }
  return spec; // bare npm specifier — Vite resolves from node_modules
}

/**
 * The styling/setup side-effect imports to replay into the synthesized entry:
 * the real entry's imports when discoverable, else the legacy single-file CSS
 * candidate scan (normalized to a root-absolute import).
 * @returns {Promise<string[]>}
 */
export async function detectSideEffectImports(cwd) {
  const fromEntry = await detectEntrySideEffects(cwd);
  if (fromEntry.length > 0) return fromEntry;
  const css = await detectGlobalCss(cwd);
  return css ? ["/" + css.replace(/^\/+/, "")] : [];
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
