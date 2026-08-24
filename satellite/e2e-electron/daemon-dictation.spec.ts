import { test, expect } from "@playwright/test";
import fs from "node:fs";
import path from "node:path";
import { launchApp, LaunchedApp } from "./harness";
import type { DaemonReport } from "../renderer/src/transcription/selfTest";

/**
 * Live end-to-end run of the daemon-backed dictation engines inside the real
 * built app: renderer WebSocket (reck-bearer subprotocol) → daemon
 * /dictation/stream → the real Claude / OpenAI speech endpoints, using the
 * credentials on the daemon's machine. A spoken fixture (the daemon repo's
 * "quick brown fox" WAV) is decoded here and streamed through the provider,
 * so the ASSERTED TRANSCRIPT proves the whole path, not just the plumbing.
 *
 * Needs a running daemon and consumes a few seconds of subscription quota,
 * so it is opt-in:
 *
 *   DAEMON_TOKEN=tok RECK_STATION_ROOT=/tmp/x go run ./cmd/reck-stationd \
 *     --mode=local --addr=127.0.0.1:7399 --no-install-hooks   # in daemon/
 *   RECK_DICTATION_DAEMON_URL=http://127.0.0.1:7399 \
 *     RECK_DICTATION_DAEMON_TOKEN=tok pnpm test:e2e:electron daemon-dictation
 */

const DAEMON_URL = process.env.RECK_DICTATION_DAEMON_URL;
const DAEMON_TOKEN = process.env.RECK_DICTATION_DAEMON_TOKEN;

const FIXTURE = path.resolve(
  __dirname,
  "..",
  "..",
  "daemon",
  "internal",
  "dictation",
  "testdata",
  "quick_brown_fox.wav",
);

/** Decode the 16 kHz mono PCM16 WAV fixture to Float32 samples. */
function fixtureSamples(): number[] {
  const raw = fs.readFileSync(FIXTURE);
  // The fixture is written by afconvert with a plain 44-byte header; find
  // the data chunk explicitly so a re-generated fixture can't break this.
  let off = 12;
  while (off + 8 <= raw.length) {
    const id = raw.toString("ascii", off, off + 4);
    const size = raw.readUInt32LE(off + 4);
    if (id === "data") {
      const out: number[] = [];
      for (let i = off + 8; i + 1 < Math.min(off + 8 + size, raw.length); i += 2) {
        out.push(raw.readInt16LE(i) / 32768);
      }
      return out;
    }
    off += 8 + size + (size % 2);
  }
  throw new Error(`no data chunk in ${FIXTURE}`);
}

let launched: LaunchedApp;

test.beforeAll(async () => {
  test.skip(!DAEMON_URL || !DAEMON_TOKEN, "RECK_DICTATION_DAEMON_URL / _TOKEN not set");
  launched = await launchApp();
  await launched.window.waitForFunction(
    () => Boolean((window as never as { reckDictationSelfTest?: unknown }).reckDictationSelfTest),
    undefined,
    { timeout: 15_000 },
  );
});

test.afterAll(async () => {
  await launched?.close();
});

for (const provider of ["claude", "codex"] as const) {
  test(`${provider} engine transcribes real speech end to end`, async () => {
    test.setTimeout(120_000);
    const report = await launched.window.evaluate<
      DaemonReport,
      { provider: "claude" | "codex"; baseUrl: string; token: string; samples: number[] }
    >(
      (args) => window.reckDictationSelfTest.daemon(args),
      { provider, baseUrl: DAEMON_URL!, token: DAEMON_TOKEN!, samples: fixtureSamples() },
    );
    expect(report.errors, `errors: ${report.errors.join("; ")}`).toEqual([]);
    expect(report.finalText, "no final transcript arrived").not.toBeNull();
    expect(report.finalText!.toLowerCase()).toContain("fox");
  });
}
