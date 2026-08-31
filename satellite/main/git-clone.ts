// `git:clone` — create a project by cloning a repository ON THE STATION.
//
// This is the rsync flow's sibling (`main/rsync-copy.ts`) and deliberately
// reuses its machinery rather than re-implementing it: the atomic slug
// reservation (`ssh … mkdir '<root>/<slug>'`, EEXIST ⇒ slug-in-use), the
// `rm -rf` rollback, and the same SSH identity. Only the middle step differs —
// `git clone` fills the reserved directory instead of `rsync`.
//
// Why the station and not the laptop: cloning locally and rsync'ing the result
// would push the whole working tree (and .git) over the wire and lose the
// remote configuration the excludes list would mangle. `git clone` on the
// station is one round trip and leaves `origin` intact.
//
// Why here and not in the Go daemon: `POST /projects` is synchronous and
// returns the registered project, with no channel for progress or cancel. A
// multi-minute clone behind that call would freeze the dialog.

import { BrowserWindow, ipcMain } from "electron";
import { spawn, ChildProcess } from "node:child_process";
import { validateGitCloneUrl } from "./ipc-validation";
import {
  assertValidSlug,
  remotePath,
  reserveRemoteSlug,
  rollbackRemote,
  REMOTE_ROOT,
  SSH_HOST,
  SSH_KEY,
} from "./rsync-copy";

export type CloneResult =
  | { ok: true }
  | { ok: false; error: string; code?: string };

export interface CloneProgress {
  percent: number;
  /** "Receiving objects", "Resolving deltas", … — shown next to the bar. */
  phase: string;
}

let active: { proc: ChildProcess; slug: string } | null = null;

/**
 * git writes progress to stderr as `Receiving objects:  42% (420/1000), …`,
 * carriage-return separated. Only the two phases that dominate wall-clock are
 * worth reporting; the counting/compressing preamble is server-side and jumps
 * around too fast to be useful.
 */
const PROGRESS_RE = /(Receiving objects|Resolving deltas):\s+(\d+)%/;

export function parseCloneProgressLine(line: string): CloneProgress | null {
  const m = line.match(PROGRESS_RE);
  if (!m) return null;
  return { phase: m[1], percent: Number(m[2]) };
}

/**
 * Classify a failed clone from git's stderr into a stable `code` the renderer
 * can branch on without re-parsing English. Anything unrecognised stays
 * `ssh-error` and the raw message is surfaced verbatim.
 */
export function classifyCloneFailure(stderr: string): { code: string; error: string } {
  const msg = stderr.trim().split(/\n/).slice(-3).join(" ") || "git clone failed";
  const lower = msg.toLowerCase();
  if (
    lower.includes("authentication failed") ||
    lower.includes("permission denied") ||
    lower.includes("could not read username") ||
    lower.includes("terminal prompts disabled")
  ) {
    return {
      code: "auth-required",
      error:
        "The station could not authenticate to this repository. " +
        "Add a deploy key or SSH key on the station, or use a public URL.",
    };
  }
  if (lower.includes("not found") || lower.includes("does not exist")) {
    return {
      code: "not-found",
      error: "Repository not found — check the URL, and that the station can reach the host.",
    };
  }
  if (lower.includes("could not resolve host") || lower.includes("unable to access")) {
    return {
      code: "unreachable",
      error: `The station could not reach the repository host. Detail: ${msg}`,
    };
  }
  return { code: "ssh-error", error: msg };
}

/**
 * The remote command. `git clone` accepts an existing directory as long as it
 * is empty, which the `mkdir` reservation guarantees — so the reservation and
 * the clone target are the same path, and rollback stays a single `rm -rf`.
 *
 * `GIT_TERMINAL_PROMPT=0` and `GIT_ASKPASS=true` turn a private repository
 * into an immediate failure instead of a clone that hangs forever on a
 * credential prompt no one can see. Both operands are single-quoted on top of
 * the validator, as `reserveRemoteSlug` does — defence in depth if the rules
 * are ever loosened by accident.
 */
export function buildCloneCommand(url: string, target: string): string {
  return (
    `GIT_TERMINAL_PROMPT=0 GIT_ASKPASS=true ` +
    `git clone --progress -- '${url}' '${target}'`
  );
}

function sshArgs(remoteCmd: string): string[] {
  return [
    "-i",
    SSH_KEY,
    "-o",
    "IdentitiesOnly=yes",
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=5",
    SSH_HOST,
    remoteCmd,
  ];
}

export function registerGitCloneIpc(getWindow: () => BrowserWindow | null): void {
  ipcMain.handle(
    "git:clone",
    async (_e, url: string, slug: string): Promise<CloneResult> => {
      try {
        assertValidSlug(slug);
      } catch (err) {
        return { ok: false, error: (err as Error).message };
      }
      if (active) {
        return { ok: false, error: "another clone is already running" };
      }

      // Re-validate in main: the renderer's parser is a UX affordance, this is
      // the boundary. Nothing reaches `spawn` until it passes.
      const check = validateGitCloneUrl(url);
      if (!check.ok) {
        console.warn(
          `[satellite] rejected git:clone url: ${check.error}; value=${JSON.stringify(url)}`,
        );
        return { ok: false, code: "bad-url", error: check.error };
      }

      // ---- Atomic slug reservation (same lock the rsync flow takes) --------
      const reservation = await reserveRemoteSlug(slug);
      if (!reservation.ok) {
        if (reservation.reason === "slug-in-use") {
          return {
            ok: false,
            code: "slug-in-use",
            error:
              `A folder already exists on the station at ${remotePath(slug)}. ` +
              `Choose a different name.`,
          };
        }
        if (reservation.reason === "parent-missing") {
          return {
            ok: false,
            code: "parent-missing",
            error:
              `Station projects root missing (${REMOTE_ROOT}). ` +
              `Re-run install-station.sh on the station. ` +
              `Detail: ${reservation.detail}`,
          };
        }
        return {
          ok: false,
          code: "ssh-error",
          error: `Could not reserve project slug on station: ${reservation.detail}`,
        };
      }

      // From here the slug is reserved: every failure path MUST roll back, or
      // the name stays locked from the user's point of view.
      try {
        const result: CloneResult = await new Promise((resolve) => {
          const win = getWindow();
          const proc = spawn("ssh", sshArgs(buildCloneCommand(check.url, remotePath(slug))), {
            stdio: ["ignore", "ignore", "pipe"],
          });
          active = { proc, slug };

          let stderrBuf = "";
          let carry = "";
          let finalized = false;
          // Detach explicitly on every termination path: between `exit` and
          // GC, late-buffered stderr can still emit progress for a clone the
          // UI has already moved on from (same hazard rsync-copy guards).
          const finalize = () => {
            if (finalized) return;
            finalized = true;
            proc.stderr?.removeListener("data", onStderr);
            proc.removeListener("exit", onExit);
            proc.removeListener("error", onError);
            if (active && active.proc === proc) active = null;
          };
          const onStderr = (chunk: Buffer) => {
            const text = carry + chunk.toString("utf8");
            const parts = text.split(/[\r\n]+/);
            carry = parts.pop() ?? "";
            for (const line of parts) {
              stderrBuf += `${line}\n`;
              const prog = parseCloneProgressLine(line);
              if (prog) win?.webContents.send("git:clone-progress", prog);
            }
          };
          const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
            finalize();
            if (code === 0) {
              resolve({ ok: true });
            } else if (signal === "SIGTERM") {
              resolve({ ok: false, code: "canceled", error: "canceled" });
            } else {
              resolve({ ok: false, ...classifyCloneFailure(stderrBuf + carry) });
            }
          };
          const onError = (err: Error) => {
            finalize();
            resolve({ ok: false, code: "ssh-error", error: err.message });
          };

          proc.stderr!.on("data", onStderr);
          proc.on("exit", onExit);
          proc.on("error", onError);
        });

        if (!result.ok) await rollbackRemote(slug);
        return result;
      } catch (err) {
        // Defensive: an unexpected throw before/around the spawn block must
        // still release the reservation.
        await rollbackRemote(slug);
        return { ok: false, error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  ipcMain.handle("git:cancel", () => {
    if (active) {
      // The SIGTERM exit path rolls the reservation back.
      active.proc.kill("SIGTERM");
      return { ok: true };
    }
    return { ok: false, error: "no active clone" };
  });
}
