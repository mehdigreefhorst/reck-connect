// Main-process detection of whether a project supports the live
// component preview (is it a Vite + React project?), read over the sshfs
// mount. The file-viewer viewer uses this to decide whether to offer the
// `component` preview mode.
//
// Pure `node:fs/promises` only — NO Electron import — so the vitest unit
// test needs no Electron mock. The IPC wiring lives in file-viewer.ts,
// which imports `detectProjectPreview` from here.

import { readFile, access } from "node:fs/promises";
import { join } from "node:path";

export interface ProjectPreviewInfo {
  previewable: boolean;
  /** Human-readable; "" when previewable, else why not (for a UI hint). */
  reason: string;
}

/**
 * vite config filenames Vite recognises at a project root. Presence of
 * any of these counts as "uses Vite" even when the dep isn't listed in
 * package.json (monorepo hoisting, workspace tooling, etc.).
 */
const VITE_CONFIGS = [
  "vite.config.ts",
  "vite.config.js",
  "vite.config.mjs",
  "vite.config.mts",
  "vite.config.cts",
];

const exists = async (p: string): Promise<boolean> => {
  try {
    await access(p);
    return true;
  } catch {
    return false;
  }
};

/**
 * Decide whether `projectCwd` supports the live component preview.
 *
 * Previewable ⇔ (a) the project uses Vite AND (b) React is a dependency.
 *   (a) Vite: `vite` in dependencies/devDependencies OR a
 *       `vite.config.{ts,js,mjs,mts,cts}` file exists in `projectCwd`.
 *   (b) React: `react` in dependencies/devDependencies.
 *
 * Never throws — a missing / malformed package.json yields
 * `{ previewable: false, reason: … }`.
 */
export async function detectProjectPreview(
  projectCwd: string,
): Promise<ProjectPreviewInfo> {
  let pkg: { dependencies?: unknown; devDependencies?: unknown };
  try {
    pkg = JSON.parse(await readFile(join(projectCwd, "package.json"), "utf8"));
  } catch (err: unknown) {
    const code = (err as NodeJS.ErrnoException)?.code;
    return {
      previewable: false,
      reason: code === "ENOENT" ? "no package.json" : "unreadable package.json",
    };
  }
  const deps = {
    ...(asRecord(pkg.dependencies)),
    ...(asRecord(pkg.devDependencies)),
  };
  let hasVite = "vite" in deps;
  if (!hasVite) {
    for (const cfg of VITE_CONFIGS) {
      if (await exists(join(projectCwd, cfg))) {
        hasVite = true;
        break;
      }
    }
  }
  const hasReact = "react" in deps;
  if (!hasVite) return { previewable: false, reason: "not a Vite project" };
  if (!hasReact) return { previewable: false, reason: "no React dependency" };
  return { previewable: true, reason: "" };
}

/** Coerce an unknown package.json field into a plain string-keyed record. */
function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object") {
    return value as Record<string, unknown>;
  }
  return {};
}
