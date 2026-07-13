// Station-remote previewability detection. The Mac-side detector
// (`satellite/main/project-detect.ts`) reads the project's package.json off
// the sshfs mount — but a station-remote file (opened with
// `host=station-remote`) has no mount presence at all, so this variant
// mirrors the same semantics over an injected reader (the viewer wires it
// to `files.readStation`).
//
// Previewable ⇔ (a) the project uses Vite AND (b) React is a dependency —
// identical rules and reason strings to `detectProjectPreview`, so the two
// paths degrade with the same UI hints.
//
// Kept reader-injected (no `window.reckAPI` import) so the vitest unit test
// needs no IPC mock.

import type { PreviewReasonKey } from "./previewReason";

/** Reads a station-side file; resolves `null` when unreadable/missing. */
export type StationFileReader = (stationPath: string) => Promise<string | null>;

export interface StationPreviewInfo {
  previewable: boolean;
  /** Human-readable; "" when previewable, else why not (for a UI hint). */
  reason: string;
}

/**
 * File-aware result — the station mirror of Task 1's `FilePreviewInfo`
 * (main/project-detect.ts). `appRelPath` is the nearest Vite+React app dir
 * relative to the project root ("" = the root itself is the app);
 * `targetRelPath` is the file relative to that app dir. The `reason` union
 * is shared with the "why" card copy so the two never drift.
 */
export interface FilePreviewInfo {
  previewable: boolean;
  appRelPath: string;
  targetRelPath: string;
  reason: PreviewReasonKey;
}

/**
 * vite config filenames Vite recognises at a project root — same list as
 * the Mac-side detector. Probed (one SSH read each) only when the `vite`
 * dep is absent from package.json, so the common case costs one read.
 */
const VITE_CONFIGS = [
  "vite.config.ts",
  "vite.config.js",
  "vite.config.mjs",
  "vite.config.mts",
  "vite.config.cts",
];

/**
 * Decide whether the station project at `projectCwd` supports the live
 * component preview. Never throws — reader failures and malformed
 * package.json degrade to `{ previewable: false, reason: … }`.
 */
export async function detectStationProjectPreview(
  readFile: StationFileReader,
  projectCwd: string,
): Promise<StationPreviewInfo> {
  const cwd = projectCwd.replace(/\/+$/, "");

  let raw: string | null;
  try {
    raw = await readFile(`${cwd}/package.json`);
  } catch {
    raw = null;
  }
  if (raw === null) {
    return { previewable: false, reason: "no package.json" };
  }

  let pkg: { dependencies?: unknown; devDependencies?: unknown };
  try {
    pkg = JSON.parse(raw) as typeof pkg;
  } catch {
    return { previewable: false, reason: "unreadable package.json" };
  }

  const deps = {
    ...asRecord(pkg.dependencies),
    ...asRecord(pkg.devDependencies),
  };
  let hasVite = "vite" in deps;
  if (!hasVite) {
    for (const cfg of VITE_CONFIGS) {
      let content: string | null;
      try {
        content = await readFile(`${cwd}/${cfg}`);
      } catch {
        content = null;
      }
      if (content !== null) {
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

/** POSIX dirname over a station (Linux) absolute path — no `node:path` so
 *  the module stays reader-injected and unit-testable without fs. */
function posixDirname(p: string): string {
  const idx = p.lastIndexOf("/");
  if (idx < 0) return "";
  if (idx === 0) return "/";
  return p.slice(0, idx);
}

/**
 * Classify a single directory over the injected reader — the station mirror
 * of Task 1's `classifyDir`. A `null` package.json read means "no file here"
 * (walk keeps going); a *thrown* reader error is a genuine read failure
 * (`readError`). Malformed JSON is NOT a read error — it degrades to empty
 * deps, matching the main-process detector.
 */
async function classifyStationDir(
  readFile: StationFileReader,
  dir: string,
): Promise<{ vite: boolean; react: boolean; readError: boolean }> {
  let deps: Record<string, unknown> = {};
  let readError = false;
  let raw: string | null;
  try {
    raw = await readFile(`${dir}/package.json`);
  } catch {
    raw = null;
    readError = true; // reader threw → real failure, not just an absent file
  }
  if (raw !== null) {
    try {
      const pkg = JSON.parse(raw) as {
        dependencies?: unknown;
        devDependencies?: unknown;
      };
      deps = {
        ...asRecord(pkg.dependencies),
        ...asRecord(pkg.devDependencies),
      };
    } catch {
      // Malformed package.json — leave deps empty (no readError), same as
      // the main-process walk-up.
    }
  }
  let vite = "vite" in deps;
  if (!vite) {
    for (const cfg of VITE_CONFIGS) {
      let content: string | null;
      try {
        content = await readFile(`${dir}/${cfg}`);
      } catch {
        content = null;
      }
      if (content !== null) {
        vite = true;
        break;
      }
    }
  }
  return { vite, react: "react" in deps, readError };
}

/**
 * Walk up from `filePath` to `projectCwd` (inclusive) over the injected
 * `readFile`, reporting the nearest Vite+React app root. Station mirror of
 * Task 1's `detectPreviewForFile`: `appRelPath` is that dir relative to the
 * project root ("" when it IS the root), `targetRelPath` is the file relative
 * to the app root. Never walks above the project root and never throws.
 */
export async function detectStationPreviewForFile(
  readFile: StationFileReader,
  projectCwd: string,
  filePath: string,
): Promise<FilePreviewInfo> {
  const notPreviewable = (reason: PreviewReasonKey): FilePreviewInfo => ({
    previewable: false,
    appRelPath: "",
    targetRelPath: "",
    reason,
  });
  const root = projectCwd.replace(/\/+$/, "");
  const fileDir = posixDirname(filePath);
  let dir = fileDir;
  let sawViteNoReact = false;
  // Guard: filePath must live under projectCwd.
  if (dir !== root && !dir.startsWith(root + "/")) {
    return notPreviewable("no-vite-app");
  }
  while (true) {
    const { vite, react, readError } = await classifyStationDir(readFile, dir);
    if (readError && dir === fileDir) return notPreviewable("read-error");
    if (vite && react) {
      const appRelPath = dir === root ? "" : dir.slice(root.length + 1);
      const targetRelPath = filePath.slice(dir.length + 1);
      return { previewable: true, appRelPath, targetRelPath, reason: "ok" };
    }
    if (vite && !react) sawViteNoReact = true;
    if (dir === root) break;
    dir = posixDirname(dir);
  }
  return notPreviewable(sawViteNoReact ? "vite-no-react" : "no-vite-app");
}

/** Coerce an unknown package.json field into a plain string-keyed record. */
function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object") {
    return value as Record<string, unknown>;
  }
  return {};
}
