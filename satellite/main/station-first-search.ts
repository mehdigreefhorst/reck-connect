// Station-first file search for files that live under the sshfs mount.
//
// Why: a project under `~/reck/projects` is an sshfs/fuse-t (NFS) mirror of
// the station. Listing it locally costs a network round-trip per directory —
// measured 1.5–4 s per rg pass for one project, and minutes for the whole
// mount — and the local rg worker runs up to two passes (default, then
// --no-ignore) before the old ssh fallback even started. The same listing run
// ON the station is a native-disk walk: ~0.4 s for a project, ~5 s for every
// project, round-trip included.
//
// So when every search root maps onto the station and the station has rg,
// the ssh worker becomes the PRIMARY and the local mirror search the
// fallback (still useful when the ssh search can't run or finds nothing).
// Matches come back as station paths; `toMountPath` maps them onto the
// mirror so the popup keeps opening local mount paths, exactly as before.

import type {
  StreamingWorkerLike,
  StartSuffixSearchArgs,
} from "./suffix-search-orchestrator";

type Factory = () => StreamingWorkerLike;

export interface SearchBackendLike {
  workerFactory: Factory;
  progressCapable: boolean;
  /** The ssh-rg worker, armed only when the station has rg. */
  fallback?: { factory: Factory; when: () => boolean; onStart?: () => void };
}

export interface SuffixSearchPlan {
  roots: string[];
  workerFactory: Factory;
  progressCapable: boolean;
  fallback?: StartSuffixSearchArgs["fallback"];
  /** True when the station (ssh) search runs first. */
  stationFirst: boolean;
}

/**
 * @param mirrorRoots search roots on this Mac (mount-mirror or local).
 * @param stationRoots the station-side translation of `mirrorRoots`; roots
 *   outside the mount are dropped by the translation, so a length mismatch
 *   means some root exists only on this Mac.
 */
export function planSuffixSearch(
  backend: SearchBackendLike,
  mirrorRoots: string[],
  stationRoots: string[],
): SuffixSearchPlan {
  const ssh = backend.fallback;
  const allOnStation =
    stationRoots.length > 0 && stationRoots.length === mirrorRoots.length;

  if (ssh && allOnStation) {
    return {
      roots: stationRoots,
      workerFactory: ssh.factory,
      // rg backends never emit per-directory progress.
      progressCapable: false,
      fallback: {
        factory: backend.workerFactory,
        when: () => true,
        onStart: ssh.onStart,
        roots: mirrorRoots,
      },
      stationFirst: true,
    };
  }

  return {
    roots: mirrorRoots,
    workerFactory: backend.workerFactory,
    progressCapable: backend.progressCapable,
    fallback:
      ssh && stationRoots.length > 0 ? { ...ssh, roots: stationRoots } : undefined,
    stationFirst: false,
  };
}

/** Station path → mount-mirror path; anything else is returned unchanged. */
export function toMountPath(
  p: string,
  mountPoint: string,
  stationRoot: string | null,
): string {
  if (!stationRoot) return p;
  const root = stationRoot.replace(/\/+$/, "");
  if (!p.startsWith(root + "/")) return p;
  return mountPoint.replace(/\/+$/, "") + p.slice(root.length);
}
