// server.mjs
// Runnable CLI that boots the TARGET project's own Vite dev server with the
// reck-preview plugin appended, then prints exactly one machine-readable
// READY line so a parent process can discover host/port:
//
//   node server.mjs --cwd <projectPath> --host 127.0.0.1 --port 0
//   -> RECK_PREVIEW_READY host=<h> port=<n>
//
// The project's OWN vite is resolved from <cwd>/node_modules so its
// vite.config.*, plugins and aliases apply verbatim.
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { reckPreviewPlugin } from "./plugin.mjs";

function arg(name, def) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

const cwd = arg("cwd", process.cwd());
const host = arg("host", "0.0.0.0");
const hmrHost = arg("hmr-host", host);
const port = Number(arg("port", "0"));

// Resolve the PROJECT's own vite so its config/plugins/aliases apply verbatim.
// `require.resolve('vite')` picks the deprecated CJS build; prefer the ESM
// entry from the package's `exports["."].import` so dynamic import() yields
// proper named exports (createServer et al.).
function pickImportEntry(exp) {
  if (typeof exp === "string") return exp;
  if (exp && typeof exp === "object") {
    return pickImportEntry(exp.import ?? exp.default ?? exp.node);
  }
  return undefined;
}

const projectRequire = createRequire(pathToFileURL(cwd + "/package.json"));
let viteUrl;
try {
  const pkgJsonPath = projectRequire.resolve("vite/package.json");
  const pkgDir = dirname(pkgJsonPath);
  const pkg = JSON.parse(readFileSync(pkgJsonPath, "utf8"));
  const entry =
    pickImportEntry(pkg.exports?.["."]) ?? pkg.module ?? pkg.main ?? "index.js";
  viteUrl = pathToFileURL(join(pkgDir, entry)).href;
} catch (e) {
  process.stderr.write(
    `RECK_PREVIEW_ERROR could not resolve 'vite' from ${cwd}: ${String((e && e.message) || e)}\n`,
  );
  process.exit(1);
}

const viteMod = await import(viteUrl);
const createServer = viteMod.createServer ?? viteMod.default?.createServer;
if (typeof createServer !== "function") {
  process.stderr.write(`RECK_PREVIEW_ERROR vite.createServer not found at ${viteUrl}\n`);
  process.exit(1);
}

const server = await createServer({
  root: cwd,
  configFile: undefined, // auto-load the project's vite.config.*
  server: { host, port, strictPort: false, hmr: { host: hmrHost } },
  plugins: [reckPreviewPlugin({ cwd })],
  clearScreen: false,
  logLevel: "warn",
});

await server.listen();
const addr = server.httpServer?.address();
const resolvedPort = addr && typeof addr === "object" ? addr.port : port;
process.stdout.write(`RECK_PREVIEW_READY host=${host} port=${resolvedPort}\n`);

for (const sig of ["SIGTERM", "SIGINT"]) {
  process.on(sig, async () => {
    try {
      await server.close();
    } finally {
      process.exit(0);
    }
  });
}
