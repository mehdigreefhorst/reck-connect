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

/**
 * Transform the app's REAL entry into a Providers module: keep everything the
 * entry does at module level (imports, query clients, i18n setup), but replace
 * the `createRoot(...).render(TREE)` statement with
 * `export const Providers = ({ children }) => (TREE')` where TREE' is TREE
 * with the app leaf swapped for `{children}`. The module is served as a .tsx
 * virtual id so the project's own JSX/TS transform applies; relative imports
 * are rewritten root-absolute so they resolve from the virtual module.
 * Returns null whenever the entry can't be parsed confidently — the preview
 * then degrades to the legacy (file-convention) provider detection.
 * @returns {Promise<{source:string}|null>}
 */
export async function detectEntryProvidersModule(cwd) {
  let html;
  try { html = await readFile(join(cwd, "index.html"), "utf8"); } catch { return null; }
  const entrySrc = findModuleScriptSrc(html);
  if (!entrySrc) return null;
  const entryRel = entrySrc.replace(/^\/+/, "");
  let source;
  try { source = await readFile(join(cwd, entryRel), "utf8"); } catch { return null; }

  const call = findRenderCall(source);
  if (!call) return null;
  let tree = source.slice(call.argStart, call.argEnd).trim().replace(/,$/, "").trim();
  // legacy two-arg ReactDOM.render(tree, container): keep only the element arg
  const comma = topLevelCommaIndex(tree);
  if (comma !== -1) tree = tree.slice(0, comma).trim();

  const leaf = findAppLeaf(tree, source);
  if (!leaf) return null;
  const wrapped = (tree.slice(0, leaf.start) + "{children}" + tree.slice(leaf.end)).trim();
  if (wrapped === "{children}") return null; // no wrappers worth replaying

  let body = source.slice(0, call.stmtStart) + source.slice(call.stmtEnd);
  if (leaf.importName) {
    // strip the leaf's default-import line so the preview never pulls the
    // whole app graph in just to ignore it
    body = body.replace(
      new RegExp(`^[ \\t]*import\\s+${leaf.importName}\\s+from\\s+["'][^"']+["'];?[ \\t]*\\n?`, "m"),
      "",
    );
  }
  body = rewriteRelativeImports(body, dirname(entryRel));
  return { source: `${body.trimEnd()}\n\nexport const Providers = ({ children }) => (\n${wrapped}\n);\n` };
}

/** Locate the `.render(...)` call: argument span + full statement span. */
function findRenderCall(source) {
  const re = /\.render\s*\(/g;
  let m;
  while ((m = re.exec(source)) !== null) {
    const open = m.index + m[0].length - 1;
    const close = matchParen(source, open);
    if (close === -1) continue;
    // walk back over the receiver chain: createRoot(...)!, ReactDOM.createRoot(...), root
    let i = m.index - 1;
    for (;;) {
      while (i >= 0 && /\s/.test(source[i])) i--;
      if (i >= 0 && source[i] === "!") { i--; continue; }
      if (i >= 0 && source[i] === ")") {
        const openIdx = matchParenBack(source, i);
        if (openIdx === -1) return null;
        i = openIdx - 1;
        continue;
      }
      if (i >= 0 && /[\w$]/.test(source[i])) {
        while (i >= 0 && /[\w$]/.test(source[i])) i--;
        let k = i;
        while (k >= 0 && /\s/.test(source[k])) k--;
        if (k >= 0 && source[k] === ".") { i = k - 1; continue; }
      }
      break;
    }
    let stmtEnd = close + 1;
    while (stmtEnd < source.length && /[ \t]/.test(source[stmtEnd])) stmtEnd++;
    if (source[stmtEnd] === ";") stmtEnd++;
    return { stmtStart: i + 1, stmtEnd, argStart: open + 1, argEnd: close };
  }
  return null;
}

/** Index of the matching `)` for the `(` at `open`, quote-aware. -1 if none. */
function matchParen(s, open) {
  let depth = 0, quote = null;
  for (let i = open; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "(") depth++;
    else if (c === ")" && --depth === 0) return i;
  }
  return -1;
}

/** Index of the matching `(` for the `)` at `close`, scanning backwards. */
function matchParenBack(s, close) {
  let depth = 0, quote = null;
  for (let i = close; i >= 0; i--) {
    const c = s[i];
    if (quote) {
      if (c === quote && s[i - 1] !== "\\") quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === ")") depth++;
    else if (c === "(" && --depth === 0) return i;
  }
  return -1;
}

/** First comma at zero (){}[] depth outside quotes, or -1. */
function topLevelCommaIndex(s) {
  let depth = 0, quote = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote) {
      if (c === "\\") i++;
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") quote = c;
    else if (c === "(" || c === "{" || c === "[") depth++;
    else if (c === ")" || c === "}" || c === "]") depth--;
    else if (c === "," && depth === 0) return i;
  }
  return -1;
}

/** All opening JSX tags in `tree`: {name, start, end, selfClosing}. */
function scanJsxTags(tree) {
  const tags = [];
  for (let i = 0; i < tree.length; i++) {
    if (tree[i] !== "<" || !/[A-Za-z_$]/.test(tree[i + 1] || "")) continue;
    const name = /^[\w$.]+/.exec(tree.slice(i + 1))[0];
    let j = i + 1 + name.length, brace = 0, quote = null;
    for (; j < tree.length; j++) {
      const c = tree[j];
      if (quote) {
        if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'") quote = c;
      else if (c === "{") brace++;
      else if (c === "}") brace--;
      else if (c === ">" && brace === 0) break;
    }
    if (j >= tree.length) break;
    tags.push({ name, start: i, end: j + 1, selfClosing: tree[j - 1] === "/" });
    i = j;
  }
  return tags;
}

/**
 * The app leaf inside the render tree: prefer the element whose tag matches a
 * default import from a RELATIVE path (`import App from "./App"` -> `<App/>`),
 * else the only self-closing PascalCase element. Null when ambiguous —
 * guessing wrong would silently drop UI.
 * @returns {{start:number, end:number, importName:string|null}|null}
 */
function findAppLeaf(tree, entrySource) {
  const tags = scanJsxTags(tree);
  const candRe = /import\s+([A-Za-z_$][\w$]*)\s+from\s+["']\.{1,2}\/[^"']+["']/g;
  let m;
  while ((m = candRe.exec(entrySource)) !== null) {
    const name = m[1];
    const matches = tags.filter((t) => t.name === name);
    if (matches.length !== 1) continue;
    const t = matches[0];
    if (t.selfClosing) return { start: t.start, end: t.end, importName: name };
    const closeAt = tree.indexOf(`</${name}`, t.end);
    if (closeAt === -1) continue;
    const gt = tree.indexOf(">", closeAt);
    if (gt === -1) continue;
    return { start: t.start, end: gt + 1, importName: name };
  }
  const selfClosing = tags.filter((t) => t.selfClosing && /^[A-Z]/.test(t.name));
  if (selfClosing.length === 1) {
    const t = selfClosing[0];
    return { start: t.start, end: t.end, importName: null };
  }
  return null;
}

/** Rewrite relative import/export specifiers to root-absolute for a virtual id. */
function rewriteRelativeImports(code, entryDir) {
  return code.replace(
    /((?:^|\n)[ \t]*(?:import|export)[^"'\n]*?)(["'])(\.{1,2}\/[^"']+)\2/g,
    (_, pre, q, spec) => pre + q + resolveSpecifier(spec, entryDir) + q,
  );
}

/**
 * Provider resolution, best evidence first:
 *   1. manual `<name>.reck-preview.tsx` sibling ({importPath, exportName});
 *   2. the app's own entry render tree ({source} — see detectEntryProvidersModule);
 *   3. conventional root providers file ({importPath, exportName}).
 * @returns {Promise<{importPath:string, exportName:string}|{source:string}|null>}
 */
export async function detectProviders(cwd, targetRelPath) {
  // 1. manual override sibling: <name>.reck-preview.tsx exporting wrap
  const dir = dirname(targetRelPath);
  const stem = basename(targetRelPath, extname(targetRelPath));
  for (const ext of [".tsx", ".jsx"]) {
    const rel = join(dir, `${stem}.reck-preview${ext}`).replace(/\\/g, "/");
    if (await exists(join(cwd, rel))) return { importPath: "/" + rel, exportName: "wrap" };
  }
  // 2. what the app actually mounts — highest fidelity
  const entryMod = await detectEntryProvidersModule(cwd);
  if (entryMod) return entryMod;
  // 3. inferred root providers
  for (const [rel, name] of PROVIDER_CANDIDATES) {
    if (await exists(join(cwd, rel))) return { importPath: "/" + rel, exportName: name };
  }
  return null;
}
