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
// 5 s hard bound) and then closes. Wait comfortably longer (the daemon may
// be a station host away), so the daemon always wins or loses before we
// stop listening — and if it still hasn't closed, commit what we have
// rather than dropping the tail of the utterance.
const CLOSE_FLUSH_TIMEOUT_MS = 8_000;

// Stalled link guard: when the socket's unsent backlog exceeds this, drop
// frames instead of buffering unbounded PCM in the renderer (~32 KB/s at
// 16 kHz, so this is a minute of backlog — the stream is dead by then).
const MAX_BUFFERED_BYTES = 2 * 1024 * 1024;

const EVENT_KINDS: ReadonlySet<string> = new Set([
  "ready",
  "partial",
  "final",
  "error",
  "debug",
]);

export class DaemonDictationProvider implements Transcriber {
  private readonly provider: DaemonSpeechProvider;
  private readonly language: string;
  private readonly api: DaemonDictationApi;
  private readonly socketFactory: (url: string, protocols: string[]) => WebSocket;

  private socket: WebSocket | null = null;
  private handlers: TranscriptionHandlers | null = null;
  private onClosed: (() => void) | null = null;
  // Settles a begin() still waiting for "ready" when the session is torn
  // down under it — without this, cancel() during begin() leaves the caller
  // hanging until the ready timeout and then toasts a stale error.
  private abortBegin: ((err: Error) => void) | null = null;
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

    try {
      await new Promise<void>((resolve, reject) => {
        let settled = false;
        const settle = (err?: Error): void => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          this.abortBegin = null;
          if (err) reject(err);
          else resolve();
        };
        this.abortBegin = (err) => settle(err);
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
          // Before ready, begin()'s rejection IS the report — dispatching
          // the error too would surface the same message twice.
          if (parsed.kind === "error" && !settled) {
            this.dead = true;
            settle(new Error(parsed.text ?? "The daemon dictation stream failed."));
            return;
          }
          this.dispatch(parsed);
        };
        socket.onerror = () => {
          // The close handler carries the actionable diagnosis; nothing here.
        };
        socket.onclose = (ev) => {
          this.dead = true;
          if (!settled) {
            // Likely the daemon's pre-upgrade refusal (412) — invisible to a
            // browser WebSocket. Ask the availability route for the reason so
            // the user sees "run codex once", not "socket closed".
            void this.explainRefusal().then((msg) => settle(new Error(msg)));
            return;
          }
          // onClosed is non-null only while end() is waiting — any other
          // close is the daemon dying under us. Commit what arrived, then
          // report it so the controller can put the mic back to idle
          // instead of listening into a dead socket.
          const expected = this.onClosed !== null;
          this.handlers?.onFinal?.(this.finalized);
          if (!expected) {
            this.handlers?.onError?.(
              `The ${this.provider} dictation stream closed unexpectedly (code ${ev.code}).`,
            );
          }
          this.onClosed?.();
        };
      });
    } catch (err) {
      // begin() cleans up after itself — the Transcriber contract does not
      // promise the caller will cancel() a provider whose begin() rejected.
      this.teardown();
      throw err;
    }
  }

  private decode(raw: unknown): DictationStreamEvent | null {
    if (typeof raw !== "string") return null;
    try {
      const ev: unknown = JSON.parse(raw);
      if (typeof ev !== "object" || ev === null) return null;
      const { kind, text } = ev as { kind?: unknown; text?: unknown };
      if (typeof kind !== "string" || !EVENT_KINDS.has(kind)) return null;
      if (text !== undefined && typeof text !== "string") return null;
      return { kind, text } as DictationStreamEvent;
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
    // Stalled link: drop frames rather than buffering unbounded audio.
    if (s.bufferedAmount > MAX_BUFFERED_BYTES) return;
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
      let timer: ReturnType<typeof setTimeout> | null = null;
      const finish = (): void => {
        if (done) return;
        done = true;
        if (timer !== null) clearTimeout(timer);
        resolve();
      };
      // Exit without a close event (timeout, or the socket died between the
      // dead-check and the send): the close handler never ran, so commit the
      // accumulated transcript here — otherwise the utterance's tail is lost.
      const bail = (): void => {
        if (done) return;
        this.handlers?.onFinal?.(this.finalized);
        finish();
      };
      this.onClosed = finish;
      let sendFailed = false;
      try {
        s.send(JSON.stringify({ type: "stop" }));
      } catch {
        sendFailed = true;
      }
      if (sendFailed) bail();
      else timer = setTimeout(bail, CLOSE_FLUSH_TIMEOUT_MS);
    });
    this.teardown();
  }

  cancel(): void {
    this.teardown();
  }

  dispose(): void {
    this.teardown();
  }

  private teardown(): void {
    // Release a begin() still waiting for ready BEFORE detaching handlers,
    // so the caller gets a prompt "cancelled" instead of a 10s-late timeout.
    this.abortBegin?.(new Error("Dictation cancelled."));
    this.abortBegin = null;
    if (this.socket) {
      // Detach handlers first: the close event this close() triggers must
      // not fire a spurious onFinal/onError for a teardown we asked for.
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
