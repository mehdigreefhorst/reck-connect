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

/** Reads a station-side file; resolves `null` when unreadable/missing. */
export type StationFileReader = (stationPath: string) => Promise<string | null>;

export interface StationPreviewInfo {
  previewable: boolean;
  /** Human-readable; "" when previewable, else why not (for a UI hint). */
  reason: string;
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

/** Coerce an unknown package.json field into a plain string-keyed record. */
function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object") {
    return value as Record<string, unknown>;
  }
  return {};
}
