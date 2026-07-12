// Deepgram live-streaming transcription session (main process). The API key
// lives here (read from encrypted config); the renderer streams linear16
// audio frames in and receives interim/final transcripts back — the key
// never reaches the renderer.
//
// Uses @deepgram/sdk v5's `listen.v1.connect()` websocket. Transcript
// results arrive as `{ type: "Results", is_final, channel.alternatives[0]
// .transcript }`.
//
// The SDK (and its `ws` dependency) is imported LAZILY inside open() — a
// type-only static import for the types, a dynamic import() for the value —
// so a missing/broken SDK never crashes app startup; it just makes the
// cloud engine fail gracefully (the router turns the throw into an error
// the renderer surfaces). The on-device engine is unaffected.

import type { DeepgramClient } from "@deepgram/sdk";

export interface DeepgramSessionHandlers {
  onPartial: (text: string) => void;
  onFinal: (text: string) => void;
  onError: (message: string) => void;
  onClosed: () => void;
}

type DeepgramSocket = Awaited<ReturnType<DeepgramClient["listen"]["v1"]["connect"]>>;

export class DeepgramSession {
  private socket: DeepgramSocket | null = null;
  private closed = false;

  async open(
    apiKey: string,
    sampleRate: number,
    handlers: DeepgramSessionHandlers,
  ): Promise<void> {
    const { DeepgramClient } = await import("@deepgram/sdk");
    const client = new DeepgramClient({ apiKey });
    const socket = await client.listen.v1.connect({
      model: "nova-2",
      encoding: "linear16",
      sample_rate: sampleRate,
      channels: 1,
      interim_results: "true",
      punctuate: "true",
      smart_format: "true",
      Authorization: `Token ${apiKey}`,
    });

    socket.on("message", (msg) => {
      if (msg.type !== "Results") return;
      const text = msg.channel?.alternatives?.[0]?.transcript ?? "";
      if (!text) return;
      if (msg.is_final) handlers.onFinal(text);
      else handlers.onPartial(text);
    });
    socket.on("error", (err: Error) => handlers.onError(err?.message ?? String(err)));
    socket.on("close", () => {
      this.closed = true;
      handlers.onClosed();
    });

    this.socket = socket;
  }

  /** Feed a linear16 audio frame (little-endian Int16 bytes). */
  sendAudio(bytes: Uint8Array): void {
    if (!this.socket || this.closed) return;
    try {
      // Copy into a standalone ArrayBuffer so we never hand the socket a view
      // over a larger/pooled buffer.
      const copy = bytes.slice();
      this.socket.sendMedia(copy.buffer);
    } catch {
      // The socket can close between frames (server-side timeout, network
      // drop). sendMedia throws "Socket is not open" — swallow it rather than
      // letting it crash the main process; the frame is simply dropped.
      this.closed = true;
    }
  }

  /** Signal end-of-stream and close. Deepgram flushes any final results. */
  close(): void {
    this.closed = true;
    const socket = this.socket;
    this.socket = null;
    if (!socket) return;
    try {
      socket.sendCloseStream({ type: "CloseStream" });
    } catch {
      // Socket may already be closing.
    }
    try {
      socket.close();
    } catch {
      // Already closed.
    }
  }
}
