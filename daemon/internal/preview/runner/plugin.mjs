// plugin.mjs
// A Vite plugin that serves the reck component-preview harness entirely from
// virtual modules, so the TARGET project's own Vite config/plugins/aliases
// apply verbatim. The target component is threaded through the module graph
// via the `?target=` query on the virtual ids — the providers module derives
// its target from the IMPORTER id (the synthesized entry), so there is no
// shared mutable state and concurrent `?target=` requests stay independent.
import { buildPreviewEntry, buildProvidersModule } from "./entry-builder.mjs";
import { detectSideEffectImports, detectProviders } from "./detect.mjs";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const INDEX_HTML = readFileSync(join(HERE, "index.html"), "utf8");

// Browser bootstrap: read ?target= from the page URL and dynamically import
// the synthesized entry. Rendered errors surface in the page for debugging.
const BOOTSTRAP = `
const target = new URLSearchParams(location.search).get("target") || "";
import(/* @vite-ignore */ "/@reck/entry?target=" + encodeURIComponent(target))
  .catch((e) => { document.body.innerHTML = '<pre style="padding:16px;color:#b00">'+String(e && e.stack || e)+'</pre>'; });
`;

const targetOf = (id) => {
  const m = /[?&]target=([^&]*)/.exec(id || "");
  return m ? decodeURIComponent(m[1]) : "";
};

/** @param {{cwd:string}} o */
export function reckPreviewPlugin({ cwd }) {
  return {
    name: "reck-preview",
    enforce: "pre",
    configureServer(server) {
      server.middlewares.use(async (req, res, next) => {
        try {
          const path = (req.url || "").split("?")[0];
          if (path === "/" || path === "/index.html") {
            const html = await server.transformIndexHtml(req.url || "/", INDEX_HTML);
            res.setHeader("content-type", "text/html");
            res.end(html);
            return;
          }
          next();
        } catch (e) {
          next(e);
        }
      });
    },
    resolveId(id, importer) {
      if (id === "/@reck/bootstrap") return "\0/@reck/bootstrap";
      if (id.startsWith("/@reck/entry")) return "\0" + id; // keep ?target= on the id
      if (id.startsWith("/@reck/providers")) {
        // derive the target from the entry module that is importing us
        return "\0/@reck/providers?target=" + encodeURIComponent(targetOf(importer));
      }
    },
    async load(id) {
      if (id === "\0/@reck/bootstrap") return BOOTSTRAP;
      if (id.startsWith("\0/@reck/entry")) {
        const target = targetOf(id);
        const [sideEffectImports, prov] = await Promise.all([
          detectSideEffectImports(cwd),
          detectProviders(cwd, target),
        ]);
        return buildPreviewEntry({ targetRelPath: target, sideEffectImports, hasProviders: !!prov });
      }
      if (id.startsWith("\0/@reck/providers")) {
        const prov = await detectProviders(cwd, targetOf(id));
        return buildProvidersModule({
          providersImportPath: prov?.importPath ?? null,
          providersExport: prov?.exportName ?? null,
        });
      }
    },
  };
}
