// @vitest-environment jsdom
// Unit spec for the daemon-backed dictation provider. The daemon WebSocket
// and the availability endpoint are faked: the socket factory returns a
// scriptable FakeSocket so the test can play the daemon's side of the
// stream protocol by hand.

import { describe, expect, it, vi } from "vitest";
import { DaemonDictationProvider } from "./DaemonDictationProvider";
import type { TranscriptionHandlers } from "./types";

class FakeSocket {
  url: string;
  protocols: string[];
  binaryType = "blob";
  readyState = 0; // CONNECTING
  bufferedAmount = 0;
  sent: (string | Uint8Array)[] = [];
  closed = false;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  onclose: ((ev: { code: number }) => void) | null = null;

  constructor(url: string, protocols: string[]) {
    this.url = url;
    this.protocols = protocols;
  }

  send(data: string | Uint8Array): void {
    this.sent.push(data);
  }

  close(): void {
    this.closed = true;
    this.emitClose();
  }

  // --- test controls ---
  emitOpen(): void {
    this.readyState = 1; // OPEN
    this.onopen?.();
  }
  emitEvent(ev: { kind: string; text?: unknown }): void {
    this.onmessage?.({ data: JSON.stringify(ev) });
  }
  emitClose(code = 1000): void {
    this.readyState = 3; // CLOSED
    this.onclose?.({ code });
  }
}

function makeHarness(opts: { available?: boolean; reason?: string } = {}) {
  const sockets: FakeSocket[] = [];
  const api = {
    dictationStreamUrl: (provider: string, rate: number, language: string) =>
      `ws://x:7315/dictation/stream?provider=${provider}&sample_rate=${rate}&language=${language}`,
    wsSubprotocols: () => ["reck-bearer.tok"],
    dictationProviders: vi.fn(async () => ({
      providers: [
        {
          provider: "claude",
          available: opts.available ?? true,
          reason: opts.reason,
          uses_subscription: true,
        },
      ],
    })),
  };
  const provider = new DaemonDictationProvider({
    provider: "claude",
    language: "auto",
    api,
    socketFactory: (url, protocols) => {
      const s = new FakeSocket(url, protocols);
      sockets.push(s);
      return s as unknown as WebSocket;
    },
  });
  const events: Record<string, string[]> = { partial: [], tail: [], final: [], error: [] };
  const handlers: TranscriptionHandlers = {
    onPartial: (t) => events.partial.push(t),
    onTail: (t) => events.tail.push(t),
    onFinal: (t) => events.final.push(t),
    onError: (m) => events.error.push(m),
  };
  return { provider, sockets, events, handlers, api };
}

async function beginReady(h: ReturnType<typeof makeHarness>): Promise<FakeSocket> {
  const begun = h.provider.begin(h.handlers, 16000);
  const s = h.sockets[0];
  s.emitOpen();
  s.emitEvent({ kind: "ready" });
  await begun;
  return s;
}

describe("DaemonDictationProvider", () => {
  it("opens the stream with the bearer subprotocol and resolves begin on ready", async () => {
    const h = makeHarness();
    const s = await beginReady(h);
    expect(s.url).toBe(
      "ws://x:7315/dictation/stream?provider=claude&sample_rate=16000&language=auto",
    );
    expect(s.protocols).toEqual(["reck-bearer.tok"]);
    expect(s.binaryType).toBe("arraybuffer");
  });

  it("routes partials to the ghost tail and accumulates finals as stable text", async () => {
    const h = makeHarness();
    const s = await beginReady(h);
    s.emitEvent({ kind: "partial", text: "the quick" });
    expect(h.events.tail).toEqual(["the quick"]);
    expect(h.events.partial).toEqual([]);

    s.emitEvent({ kind: "final", text: "The quick brown fox." });
    expect(h.events.partial).toEqual(["The quick brown fox."]);
    expect(h.events.tail).toEqual(["the quick", ""]);

    s.emitEvent({ kind: "final", text: "Jumps over." });
    expect(h.events.partial).toEqual([
      "The quick brown fox.",
      "The quick brown fox. Jumps over.",
    ]);
  });

  it("feeds Float32 audio as PCM16 binary frames", async () => {
    const h = makeHarness();
    const s = await beginReady(h);
    h.provider.feed(new Float32Array([0, 0.5, -0.5]), 16000);
    expect(s.sent).toHaveLength(1);
    const bytes = s.sent[0] as Uint8Array;
    expect(bytes.byteLength).toBe(6); // 3 samples × 2 bytes
  });

  it("end() sends stop, then reports the accumulated transcript when the daemon closes", async () => {
    const h = makeHarness();
    const s = await beginReady(h);
    s.emitEvent({ kind: "final", text: "Hello world." });

    const ended = h.provider.end(new Float32Array(0), 16000);
    expect(s.sent).toContainEqual(JSON.stringify({ type: "stop" }));
    // Daemon flushes trailing finals, then closes.
    s.emitEvent({ kind: "final", text: "And goodbye." });
    s.emitClose();
    await ended;
    expect(h.events.final).toEqual(["Hello world. And goodbye."]);
  });

  it("rejects begin with the daemon's reason when the socket dies before ready", async () => {
    const h = makeHarness({
      available: false,
      reason: "The Codex token has expired. Run `codex` once to refresh it.",
    });
    const begun = h.provider.begin(h.handlers, 16000);
    h.sockets[0].emitClose();
    await expect(begun).rejects.toThrow(/token has expired/);
  });

  it("surfaces stream errors and stops feeding a dead session", async () => {
    const h = makeHarness();
    const s = await beginReady(h);
    s.emitEvent({ kind: "error", text: "speech stream fell over" });
    expect(h.events.error).toEqual(["speech stream fell over"]);
    h.provider.feed(new Float32Array([0.1]), 16000);
    expect(s.sent).toHaveLength(0);
  });

  it("end() commits the transcript even when the daemon never closes (flush timeout)", async () => {
    vi.useFakeTimers();
    try {
      const h = makeHarness();
      const begun = h.provider.begin(h.handlers, 16000);
      const s = h.sockets[0];
      s.emitOpen();
      s.emitEvent({ kind: "ready" });
      await begun;
      s.emitEvent({ kind: "final", text: "Hello world." });

      const ended = h.provider.end(new Float32Array(0), 16000);
      await vi.advanceTimersByTimeAsync(9000); // daemon silent past the flush bound
      await ended;
      expect(h.events.final).toEqual(["Hello world."]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("an unexpected mid-utterance close reports an error and commits what arrived", async () => {
    const h = makeHarness();
    const s = await beginReady(h);
    s.emitEvent({ kind: "final", text: "Hello." });
    s.emitClose(1006); // daemon died — nobody called end()
    expect(h.events.final).toEqual(["Hello."]);
    expect(h.events.error).toHaveLength(1);
    expect(h.events.error[0]).toMatch(/unexpectedly/);
  });

  it("a requested close (end) does not report an error", async () => {
    const h = makeHarness();
    const s = await beginReady(h);
    const ended = h.provider.end(new Float32Array(0), 16000);
    s.emitClose(1000);
    await ended;
    expect(h.events.error).toEqual([]);
  });

  it("cancel() during begin() rejects begin promptly", async () => {
    const h = makeHarness();
    const begun = h.provider.begin(h.handlers, 16000);
    h.provider.cancel(); // user aborted before the daemon answered
    await expect(begun).rejects.toThrow(/cancel/i);
  });

  it("an error frame before ready rejects begin without double-reporting", async () => {
    const h = makeHarness();
    const begun = h.provider.begin(h.handlers, 16000);
    const s = h.sockets[0];
    s.emitOpen();
    s.emitEvent({ kind: "error", text: "credential rejected upstream" });
    await expect(begun).rejects.toThrow(/credential rejected/);
    // begin()'s rejection is the report; a second onError would double-toast.
    expect(h.events.error).toEqual([]);
  });

  it("ignores frames whose text is not a string", async () => {
    const h = makeHarness();
    const s = await beginReady(h);
    s.emitEvent({ kind: "final", text: 123 });
    expect(h.events.partial).toEqual([]);
    expect(h.events.error).toEqual([]);
  });
});
