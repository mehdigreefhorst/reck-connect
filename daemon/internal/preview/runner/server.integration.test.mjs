// server.integration.test.mjs
// Boots the runner against a REAL minimal Vite + React + Tailwind fixture and
// asserts the three acceptance outcomes: the index is served, the target
// module transforms through the project's own Vite (alias + node_modules
// resolution), and the synthesized entry imports global.css + target
// (+ providers, because the fixture has src/Providers.tsx).
//
// First run installs the fixture deps (`npm install`) — needs network once.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, "__fixtures__", "vite-tailwind-app");
let child, base;

before(async () => {
  if (!existsSync(join(FIXTURE, "node_modules"))) {
    execSync("npm install --no-audit --no-fund", { cwd: FIXTURE, stdio: "inherit" });
  }
  base = await new Promise((resolve, reject) => {
    child = spawn(
      process.execPath,
      [join(HERE, "server.mjs"), "--cwd", FIXTURE, "--host", "127.0.0.1", "--port", "0"],
      { stdio: ["ignore", "pipe", "inherit"] },
    );
    let buf = "";
    const t = setTimeout(
      () => reject(new Error("runner did not become ready; stdout so far:\n" + buf)),
      60_000,
    );
    child.on("error", (e) => {
      clearTimeout(t);
      reject(e);
    });
    child.stdout.on("data", (b) => {
      buf += String(b);
      const m = /RECK_PREVIEW_READY host=(\S+) port=(\d+)/.exec(buf);
      if (m) {
        clearTimeout(t);
        resolve(`http://${m[1]}:${m[2]}`);
      }
    });
  });
});

after(() => child?.kill("SIGTERM"));

test("index served at /", async () => {
  const html = await (await fetch(`${base}/`)).text();
  assert.match(html, /id="root"/);
});

test("target module transforms and resolves the '@/theme' alias (no 500)", async () => {
  const res = await fetch(`${base}/src/components/Button.tsx`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /LABEL/);
});

test("entry module imports global.css + target + providers", async () => {
  const res = await fetch(`${base}/@reck/entry?target=src/components/Button.tsx`);
  assert.equal(res.status, 200);
  const src = await res.text();
  assert.match(src, /src\/index\.css/);
  assert.match(src, /src\/components\/Button\.tsx/);
  // providers wrapper is threaded in (entry-derived, from the fixture's main.tsx)
  assert.match(src, /@reck\/providers/);
  // issue #44 acceptance: auto-wrap reached the entry graph for a themed fixture —
  // pin the exact import path (leading slash), not just a substring.
  assert.match(src, /\/@reck\/providers/);
});

test("named-export target resolves through pickComponent in the entry", async () => {
  const res = await fetch(`${base}/@reck/entry?target=src/features/ThreadView.tsx`);
  assert.equal(res.status, 200);
  const src = await res.text();
  assert.match(src, /src\/features\/ThreadView\.tsx/);
  assert.match(src, /pickComponent\(__mod, "ThreadView"\)/);
});

test("providers module replays main.tsx's ToastProvider, transformed by the project's Vite", async () => {
  // resolve the providers module exactly the way the browser would: follow the
  // rewritten import URL out of the transformed entry.
  const entry = await (await fetch(`${base}/@reck/entry?target=src/features/ThreadView.tsx`)).text();
  const m = /["']([^"']*@reck\/providers[^"']*)["']/.exec(entry);
  assert.ok(m, "entry references the providers module");
  const res = await fetch(base + m[1]);
  assert.equal(res.status, 200, "providers virtual module serves");
  const src = await res.text();
  // entry-derived: the app's real ToastProvider wraps {children}…
  assert.match(src, /ToastProvider/);
  assert.match(src, /children/);
  // …and the JSX was actually transformed (raw JSX would 500 or leak '<' tags)
  assert.doesNotMatch(src, /<ToastProvider/);
  assert.doesNotMatch(src, /<StrictMode/);
  // the app leaf import was stripped — previewing must not load the whole app
  assert.doesNotMatch(src, /src\/App/);
});
