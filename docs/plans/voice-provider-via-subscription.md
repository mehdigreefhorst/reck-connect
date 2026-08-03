# Plan: dictation without a separate Deepgram key

## Context

Voice dictation currently needs the user to bring a **Deepgram API key**
(`transcription.deepgramKey`, Settings → Voice dictation). That is a second paid account
on top of the Claude and ChatGPT subscriptions we already hold, and it is the main reason
dictation isn't just on by default for everyone using Reck Connect.

We already pay both vendors. Both of their CLIs do dictation. So: can we ride what we
already pay for?

The reverse-engineering that answers this is in
[../reference/agent-cli-dictation.md](../reference/agent-cli-dictation.md) — read that
first; this document only decides what to *do*.

**Status: not started.** #141 shipped the cheap half (nova-3 + endpointing tuning on the
existing Deepgram path). This plan covers replacing the key requirement entirely.

## The honest constraint, stated once

"Free because we have a subscription" is only true if we send our audio using credentials
that were issued to a *different application*:

- **Claude Code's endpoint accepts nothing but a claude.ai OAuth token.** There is no
  API-key path. Using it means lifting the token Claude Code stores and calling an
  internal, undocumented, unversioned endpoint with it.
- **Codex can authenticate to OpenAI with a ChatGPT token** rather than an API key — but
  again, that token is minted for Codex.

Both work today. Neither has a stability contract, both can be shut off or changed without
notice, and both put a personal subscription credential behind a tool that isn't the one
it was issued to. That is a real risk to weigh, not a formality — and it is why the
recommendation below is the boring one.

## Options

### A. OpenAI Realtime, transcription session — **recommended**

Codex's `SessionType::Transcription` is a transcription-only realtime session: no model
replies, no audio output, no VAD unless asked. It is a **public, documented API**, and
Codex's Rust is a working reference for session setup and event handling.

```jsonc
// session.update, immediately after connect
{ "type": "transcription",
  "audio": { "input": {
      "format":        { "type": "audio/pcm", "rate": 24000 },
      "transcription": { "model": "gpt-4o-mini-transcribe" },
      "turn_detection": { "type": "server_vad", "silence_duration_ms": 500 }
  } } }
```

- **Auth**: user's own OpenAI API key — same shape as today's Deepgram key, so the
  existing encrypted-config + Settings plumbing is reused wholesale.
- **Wire**: `{"type":"input_audio_buffer.append","audio":"<base64 PCM16>"}` up;
  `conversation.item.input_audio_transcription.delta` / `.completed` down.
- **Work for us**: resample 16 kHz → 24 kHz (the only genuinely new piece), and base64
  each chunk. Both small.
- **Cost**: metered per minute, not free. Compare current OpenAI vs Deepgram streaming
  rates before committing — do not assume, both vendors reprice.

This does not remove the need for *a* key. It removes the need for a *second vendor*, for
anyone already holding an OpenAI key. That is the realistic win.

### B. ChatGPT-token auth against the same endpoint

Identical to A, but authenticating with the ChatGPT OAuth token from `~/.codex/auth.json`
instead of an API key — which is what makes it "free". Same wire protocol, so it is a
one-line auth swap on top of A, not separate work.

Ship A first, keep B behind an explicit opt-in the user turns on knowingly. Sequencing it
this way means if B breaks or becomes untenable, dictation keeps working.

### C. Claude Code's `/api/ws/speech_to_text/voice_stream`

Fully mapped in the reference doc. Attractive on paper: it is Deepgram Nova-3, already
tuned for exactly this use case, and our capture path (16 kHz linear16 mono, bare binary
frames, `KeepAlive`/`CloseStream`) is *already wire-compatible* — the client work is close
to zero.

Against it: OAuth-only, undocumented, unversioned, Anthropic-specific response envelope,
and the Deepgram knobs are fixed server-side so we would have **less** control than we do
today. Since #141 we get the same engine (nova-3) on our own key with more control.

**Not recommended.** Documented because knowing how it works is what let us tune our own
client; it is reference material, not a roadmap item.

### D. Status quo — user-supplied Deepgram key

Still the default, and after #141 it is well-tuned. Whatever else ships, this stays as the
fallback.

## Proposed shape

Introduce a **provider interface** in the main process, with `deepgram.ts` as the first
implementation, then add OpenAI Realtime alongside it.

- `satellite/main/transcription/router.ts` already owns session lifecycle and IPC
  (`transcription:deepgram:start` / `:frame` / `:stop`) — generalize the channel names to
  `transcription:start` / `:frame` / `:stop` with a `provider` argument, keeping the old
  names as aliases for one release.
- `satellite/main/transcription/deepgram.ts` and a new `openai-realtime.ts` implement a
  shared `TranscriptionProvider` interface: `open(config, handlers)`, `sendAudio(bytes)`,
  `close()`, with the existing `onPartial` / `onFinal` / `onError` / `onClosed` / `onDebug`
  handler shape unchanged.
- The renderer is **untouched**. `AudioCapture.ts`, `pcm.ts`, `chunkModel.ts`,
  `TranscriptionEngine.ts` all keep working against the same events; provider choice is a
  setting in `transcriptionSettings.ts` next to the existing engine/language settings.
- Resampling 16 kHz → 24 kHz lives in the OpenAI provider, not in capture, so the Deepgram
  path keeps its native rate.

## Also worth doing regardless of provider

Two robustness behaviors observed in Claude Code that we don't have, both provider-agnostic:

1. **Promote-before-resolve** — on stop, wait briefly for a final; if none arrives, promote
   the last interim to a final rather than dropping it. Bounded (~1.5 s no-data / 5 s hard).
2. **Silent-drop replay** — if a session produced no transcript at all, re-send the buffered
   audio on a fresh connection before surfacing an error.

Neither depends on this plan and both could land first.

## Open questions

- Current per-minute cost, OpenAI Realtime transcription vs Deepgram nova-3 streaming.
- Accuracy in Dutch: `gpt-4o-mini-transcribe` vs nova-3 `multi`. Needs a real side-by-side
  on our own audio, not vendor benchmarks.
- Does option B's token survive Codex's own refresh cycle, or would we fight it for the
  lock on `auth.json`?
- Is the station-vs-Mac microphone constraint (#67) affected? Probably not — it is
  orthogonal to provider choice — but confirm before scoping.

## Verification

- Unit tests per provider, mirroring `deepgram.test.ts`'s fake-socket harness (connect
  args, queueing/flush, keepalive, close/flush ordering, error surfacing).
- Round-trip on real audio: dictate the same paragraph through each provider and compare
  transcripts, latency to first partial, and behavior at mid-sentence pauses.
- Confirm the Deepgram path is byte-for-byte unchanged when the provider setting is left
  at its default.
