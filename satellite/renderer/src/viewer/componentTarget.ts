// Pure mount-relative derivation for the component-preview arm. Given the
// canonical Mac-mount path of an open file and the sshfs mount root
// (`$HOME/reck/projects`), split off the project slug and the
// project-root-relative path the station Vite server expects.
//
// Kept pure (no DOM, no IPC) so the arm's path arithmetic is unit-tested in
// isolation; the viewer feeds it `result.resolvedPath` +
// `reckAPI.paths.localMountPoint()`.

export interface ComponentTarget {
  /** Absolute Mac-mount path of the project root (`<mount>/<slug>`). */
  projectRootMac: string;
  /** Path of the component file relative to the project root. */
  targetRelPath: string;
  /** The project slug (first path segment under the mount). */
  slug: string;
}

/**
 * Split `resolvedPath` (a canonical Mac-mount file path) against `mountPoint`
 * (the sshfs mount root). Returns `null` when the path is not under the mount
 * or has no sub-path beyond the project slug.
 */
export function deriveComponentTarget(
  resolvedPath: string,
  mountPoint: string,
): ComponentTarget | null {
  // Normalise a single trailing slash off the mount root.
  const mount = mountPoint.replace(/\/+$/, "");
  const prefix = mount + "/";
  if (!resolvedPath.startsWith(prefix)) return null;

  const rel = resolvedPath.slice(prefix.length);
  const slug = rel.split("/")[0];
  // No slug (e.g. leading slash) or no sub-path after the slug → not a
  // previewable component target.
  if (!slug) return null;
  if (rel.length <= slug.length + 1) return null;

  const targetRelPath = rel.slice(slug.length + 1);
  if (!targetRelPath) return null;

  return {
    projectRootMac: `${mount}/${slug}`,
    targetRelPath,
    slug,
  };
}

/** Station-remote counterpart of {@link ComponentTarget}: the project root
 * is already known (the pane's station-side cwd), so only the relative
 * target survives. */
export interface StationComponentTarget {
  /** Path of the component file relative to the project cwd. */
  targetRelPath: string;
}

/**
 * Derive the project-root-relative path of a station-side file from the
 * pane's station cwd. Unlike {@link deriveComponentTarget} there is no
 * mount/slug arithmetic — the daemon resolves the project root itself from
 * the project id; the viewer only needs the Vite `?target=` path.
 *
 * Returns `null` when the file is not strictly inside `projectCwd` (a
 * sibling directory sharing the prefix does not count) or when `projectCwd`
 * is empty/root — an empty cwd would make every absolute path "match".
 */
export function deriveStationComponentTarget(
  filePath: string,
  projectCwd: string,
): StationComponentTarget | null {
  const cwd = projectCwd.replace(/\/+$/, "");
  if (!cwd) return null;

  const prefix = cwd + "/";
  if (!filePath.startsWith(prefix)) return null;

  const targetRelPath = filePath.slice(prefix.length);
  if (!targetRelPath) return null;

  return { targetRelPath };
}
