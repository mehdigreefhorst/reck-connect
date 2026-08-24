// Daemon-backed provider — streams mic audio to the daemon's
// /dictation/stream WebSocket, which fronts the Claude / Codex speech
// endpoints using the subscription credentials that live next to the daemon
// (see daemon docs/concepts/dictation.md). The renderer never sees a token:
// the bearer rides the reck-bearer subprotocol and stays inside ApiClient.

import type { DictationProvidersResponse, DictationStreamEvent } from "@proto/proto";
import type { DaemonSpeechProvider } from "../transcriptionSettings";
import { floatToInt16 } from "../pcm";
import { sanitizeTranscript } from "../transcriptClean";
import type { Transcriber, TranscriptionHandlers } from "./types";

/** The slice of ApiClient this provider needs (kept narrow for tests). */
export interface DaemonDictationApi {
  dictationStreamUrl(provider: string, sampleRate: number, language: string): string;
  wsSubprotocols(): string[];
  dictationProviders(): Promise<DictationProvidersResponse>;
}

export interface DaemonDictationOptions {
  provider: DaemonSpeechProvider;
  /** "auto" = provider default; otherwise an ISO code (e.g. "nl"). */
  language?: string;
  api: DaemonDictationApi;
  /** Test seam; production uses `new WebSocket(url, protocols)`. */
  socketFactory?: (url: string, protocols: string[]) => WebSocket;
}

// The daemon refuses a credential-less stream with a 412 BEFORE the upgrade,
// but a browser WebSocket cannot read that body — all it sees is a close.
// Bound how long we wait for "ready" so a refused/hung upgrade turns into an
// actionable error instead of a mic that never starts.
const READY_TIMEOUT_MS = 10_000;

// After {"type":"stop"} the daemon flushes trailing finals (1.5 s idle,
// 5 s hard bound) and then closes. Wait slightly longer, so the daemon
// always wins or loses before we stop listening.
const CLOSE_FLUSH_TIMEOUT_MS = 6_000;

export class DaemonDictationProvider implements Transcriber {
  private readonly provider: DaemonSpeechProvider;
  private readonly language: string;
  private readonly api: DaemonDictationApi;
  private readonly socketFactory: (url: string, protocols: string[]) => WebSocket;

  private socket: WebSocket | null = null;
  private handlers: TranscriptionHandlers | null = null;
  private onClosed: (() => void) | null = null;
  // Set once the socket errors or closes — stop feeding a dead session.
  private dead = false;
  // The daemon streams finalized SEGMENTS plus a rolling partial; the
  // consumer wants the full running transcript, so accumulate finals and
  // ghost the current partial (same contract as DeepgramProvider).
  private finalized = "";

  constructor(opts: DaemonDictationOptions) {
    this.provider = opts.provider;
    this.language = opts.language ?? "auto";
    this.api = opts.api;
    this.socketFactory =
      opts.socketFactory ?? ((url, protocols) => new WebSocket(url, protocols));
  }

  async prepare(_handlers: TranscriptionHandlers): Promise<void> {
    // Streaming provider: the socket opens per-utterance in begin() (it
    // needs the capture sample rate), so there's nothing to warm up.
  }

  private join(a: string, b: string): string {
    const t = sanitizeTranscript(b);
    if (!t) return a;
    return a ? `${a} ${t}` : t;
  }

  async begin(handlers: TranscriptionHandlers, sampleRate: number): Promise<void> {
    this.handlers = handlers;
    this.finalized = "";
    this.dead = false;

    const url = this.api.dictationStreamUrl(
      this.provider,
      sampleRate || 16000,
      this.language,
    );
    const socket = this.socketFactory(url, this.api.wsSubprotocols());
    socket.binaryType = "arraybuffer";
    this.socket = socket;

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const settle = (err?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) reject(err);
        else resolve();
      };
      const timer = setTimeout(() => {
        settle(new Error(`The daemon dictation stream did not become ready within ${READY_TIMEOUT_MS / 1000}s.`));
      }, READY_TIMEOUT_MS);

      socket.onmessage = (ev) => {
        const parsed = this.decode(ev.data);
        if (!parsed) return;
        if (parsed.kind === "ready") {
          settle();
          return;
        }
        this.dispatch(parsed);
        if (parsed.kind === "error") {
          settle(new Error(parsed.text ?? "The daemon dictation stream failed."));
        }
      };
      socket.onerror = () => {
        // The close handler carries the actionable diagnosis; nothing here.
      };
      socket.onclose = () => {
        this.dead = true;
        if (!settled) {
          // Likely the daemon's pre-upgrade refusal (412) — invisible to a
          // browser WebSocket. Ask the availability route for the reason so
          // the user sees "run codex once", not "socket closed".
          void this.explainRefusal().then((msg) => settle(new Error(msg)));
          return;
        }
        this.handlers?.onFinal?.(this.finalized);
        this.onClosed?.();
      };
    });
  }

  private decode(raw: unknown): DictationStreamEvent | null {
    if (typeof raw !== "string") return null;
    try {
      const ev = JSON.parse(raw) as DictationStreamEvent;
      return typeof ev === "object" && ev !== null && typeof ev.kind === "string" ? ev : null;
    } catch {
      return null;
    }
  }

  private dispatch(ev: DictationStreamEvent): void {
    if (ev.kind === "partial") {
      // Partial text is unstable — it goes to the ghost tail, never into
      // the prompt (so the prompt never flickers through corrections).
      this.handlers?.onTail?.(ev.text ?? "");
    } else if (ev.kind === "final") {
      this.finalized = this.join(this.finalized, ev.text ?? "");
      this.handlers?.onPartial?.(this.finalized);
      this.handlers?.onTail?.("");
    } else if (ev.kind === "debug") {
      // Daemon-side lifecycle facts — surfaced because the daemon's log is
      // not visible from a packaged satellite.
      console.log(`[daemon-stt:${this.provider}]`, ev.text);
    } else if (ev.kind === "error") {
      console.error(`[daemon-stt:${this.provider}] error event:`, ev.text);
      this.dead = true;
      this.handlers?.onError?.(ev.text ?? "The speech stream failed.");
    }
  }

  /** Best-effort translation of a refused upgrade into the daemon's reason. */
  private async explainRefusal(): Promise<string> {
    const generic = `Could not open the ${this.provider} dictation stream on the daemon.`;
    try {
      const res = await this.api.dictationProviders();
      const st = res.providers.find((p) => p.provider === this.provider);
      if (st && !st.available && st.reason) return st.reason;
    } catch {
      // The availability route failing too means the daemon is unreachable;
      // the generic message is the honest diagnosis.
    }
    return generic;
  }

  feed(chunk: Float32Array, _sampleRate: number): void {
    const s = this.socket;
    if (this.dead || !s || s.readyState !== WebSocket.OPEN || chunk.length === 0) return;
    const pcm = floatToInt16(chunk);
    s.send(new Uint8Array(pcm.buffer));
  }

  async end(_full: Float32Array, _sampleRate: number): Promise<void> {
    const s = this.socket;
    if (!s || this.dead) {
      // Already closed (error path) — the transcript was reported on close.
      this.teardown();
      return;
    }
    // Keep listening until the daemon closes (trailing finals) or we time out.
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        resolve();
      };
      this.onClosed = finish;
      try {
        s.send(JSON.stringify({ type: "stop" }));
      } catch {
        finish();
      }
      setTimeout(finish, CLOSE_FLUSH_TIMEOUT_MS);
    });
    this.teardown();
  }

  cancel(): void {
    try {
      this.socket?.close();
    } catch {
      // A socket that's already closing throws in some states; the teardown
      // below is what matters.
    }
    this.teardown();
  }

  dispose(): void {
    this.cancel();
  }

  private teardown(): void {
    if (this.socket) {
      this.socket.onmessage = null;
      this.socket.onclose = null;
      this.socket.onerror = null;
      try {
        this.socket.close();
      } catch {
        /* already closed */
      }
    }
    this.socket = null;
    this.onClosed = null;
    this.handlers = null;
    this.dead = true;
  }
}
