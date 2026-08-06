# How Codex and Claude Code turn audio into text

Reverse-engineered 2026-08-03 from the shipped artifacts, so that our own dictation
(`satellite/renderer/src/transcription/`, `satellite/main/transcription/`) can be tuned
against what two production agent CLIs actually do.

**Neither CLI runs its own speech recognition.** Both are thin clients over a hosted STT
service. That is the headline: the interesting engineering is in the parameters and the
finalize discipline, not in any model they ship.

Sources, and how to re-derive them:

| | Artifact | How it was read |
|---|---|---|
| Claude Code | `~/.local/share/claude/versions/<v>` (~245 MB) | Bun-compiled binary with the JS bundle embedded **in the clear** — `strings` it and grep for `speech_to_text`. No source repo exists; `anthropics/claude-code` is docs + issues. |
| Codex | `github.com/openai/codex` | Fully open source (Rust). The local binary's panic strings name the same files, so the clone can be trusted. |

---

## Side by side

| | Claude Code | Codex |
|---|---|---|
| Endpoint | `wss://api.anthropic.com/api/ws/speech_to_text/voice_stream` | `wss://api.openai.com/v1/realtime` |
| Public API? | no — internal, undocumented | **yes** — documented OpenAI Realtime |
| Engine | Deepgram **Nova-3** (`stt_provider=deepgram-nova3`) | **`gpt-4o-mini-transcribe`** |
| Audio | linear16 PCM, **16 kHz**, mono | PCM16, **24 kHz** |
| Framing | **bare binary WS frames** | **base64 in JSON** (`input_audio_buffer.append`) |
| Segmentation | server-side: `endpointing_ms=300`, `utterance_end_ms=1000` | `server_vad`, or client-controlled in transcription mode |
| Keep-alive | `{"type":"KeepAlive"}` every 8 s | — |
| Finalize | `{"type":"CloseStream"}`, 1.5 s no-data / 5 s safety | close buffer |
| Results | Anthropic-specific: `TranscriptInterim` / `TranscriptText` / `TranscriptEndpoint` | standard `…input_audio_transcription.delta` / `.completed` |
| Auth | claude.ai **OAuth token only** — no API-key path | your OpenAI key **or** ChatGPT token |
| Mic capture | **in the CLI** — native CoreAudio NAPI module, SoX `rec` fallback | **not in the CLI** — the Desktop/IDE client captures |

---

## Claude Code

### Endpoint and parameters

Built as `BASE_API_URL.replace("https://","wss://")` + path; `VOICE_STREAM_BASE_URL`
overrides. Verbatim query string from `connectVoiceStream`:

| Param | Value |
|---|---|
| `encoding` | `linear16` |
| `sample_rate` | `16000` |
| `channels` | `1` |
| `endpointing_ms` | `300` |
| `utterance_end_ms` | `1000` |
| `language` | caller-supplied, default `en` |
| `use_conversation_engine` | `true` |
| `stt_provider` | **`deepgram-nova3`** |
| `forward_interims` | `typed` (only when interims enabled) |

Headers: `Authorization: Bearer <OAuth accessToken>`, `x-app: cli`,
`anthropic-client-platform`, and optionally `x-config-keyterms` — Deepgram keyterm
prompting, sanitized to ASCII, deduped, comma-joined, truncated to **1024 chars**.

> **Watch the parameter names.** `endpointing_ms` is *Anthropic's proxy* name. Deepgram's
> own parameter is `endpointing`. Copying the proxy's name into a direct Deepgram client
> is silently ignored — it does not error, it just leaves the 10 ms default in place.

### Wire protocol

- **Audio up**: bare binary WS frames of raw PCM — no JSON wrapper.
- **KeepAlive**: `{"type":"KeepAlive"}` on open, then every 8 s.
- **Finalize**: `{"type":"CloseStream"}`; later chunks are dropped.

Both control frames are Deepgram's own and pass straight through. The **responses do
not**: instead of Deepgram's `Results` / `channel.alternatives[]` / `is_final`, the client
parses `TranscriptInterim`, `TranscriptText`, `TranscriptEndpoint`, `TranscriptError`.
Normalization happens server-side, and the Deepgram knobs are fixed in the query string —
you get Deepgram's behavior without Deepgram's API, and without the ability to tune it.

### Two robustness ideas worth stealing

1. **Promote-before-resolve.** On `CloseStream`, wait for `TranscriptEndpoint`; give up
   after 1.5 s of no data or 5 s hard. Any unreported interim is promoted to a final
   before resolving, so a trailing partial is never silently lost.
2. **Silent-drop replay.** If a stream returns nothing at all, buffered chunks are
   re-sent on a fresh connection rather than losing the utterance.

### Capture

Native NAPI module (`vendor/audio-capture/arm64-darwin/audio-capture.node`, CoreAudio),
falling back to SoX:

```
rec -q --buffer 1024 -t raw -r 16000 -e signed -b 16 -c 1 -   [silence 1 0.1 3% 1 2.0 3%]
```

The trailing `silence` effect is client-side auto-stop. A ready-made recipe if we ever
need capture outside a browser context — e.g. on the station rather than the Mac.

### Gating

`voice.enabled` config (set by `/voice`) **and** managed setting `allow_voice_mode` **and**
an OAuth `accessToken` **and** not remote/SSH.

---

## Codex

### Codex CLI never opens a microphone

There is no `cpal`/`rodio`/CoreAudio binding in the workspace — the only audio crate is
`symphonia`, a *decoder* used by `core/src/audio_preparation.rs` for audio **file
attachments**. Capture lives in the Desktop app / IDE extension, which pushes frames to
the app-server:

```
thread/realtime/appendAudio { threadId, audio: { data, sampleRate, numChannels, … } }
```

`data` is base64 PCM16. The Rust side re-emits it to OpenAI as
`input_audio_buffer.append`. So the path is two hops:

```
mic → [client: Desktop/IDE] → thread/realtime/appendAudio → [codex app-server]
    → input_audio_buffer.append → [OpenAI Realtime] → transcript events → client
```

This is why the Codex TUI has no dictation, and it means **Codex's code gives us nothing
for the capture half** — we would own that.

### Session configuration

`session.update` is sent immediately after connect. Two modes:

**`Transcription`** — pure speech-to-text, no model replies. The dictation-shaped one:

```jsonc
{ "type": "transcription",
  "audio": { "input": {
      "format":        { "type": "audio/pcm", "rate": 24000 },
      "transcription": { "model": "gpt-4o-mini-transcribe" },
      "turn_detection": null          // client controls segmentation
  } } }
```

**`Conversational`** — adds `noise_reduction: near_field`, `server_vad`
(`silence_duration_ms: 500`, `interrupt_response`, `create_response`), PCM audio output
with a voice, and two tools: `background_agent` (delegates the spoken request to the
coding agent, explicitly instructed *not* to rephrase the user's words) and
`remain_silent`.

### Events

Up: `{"type":"input_audio_buffer.append","audio":"<base64 PCM16>"}`.
Down: `conversation.item.input_audio_transcription.delta` / `.completed`,
`input_audio_buffer.speech_started` — surfaced to clients as
`thread/realtime/transcript/delta` / `…/done`.

Transport is WebSocket or WebRTC (the client generates the SDP offer; Codex relays it via
`/backend-api/codex-realtime-call-boundary`). Auth is not special-cased — the WS request
inherits the same provider headers as every other Codex API call.

### Bonus: audio as prompt input

`audio_preparation.rs` decodes wav/mp3/m4a/webm/ogg via symphonia and attaches them to a
normal Responses API turn — max 50 MB decoded, ~10 tokens/second. File attachment, not
dictation, but a second audio→model route worth knowing about.

---

## What this means for us

Our stack already mirrors Claude Code's architecture: `AudioCapture.ts` captures 16 kHz
mono, `pcm.ts` converts Float32→PCM16, and `deepgram.ts` streams it with `KeepAlive` /
`CloseStream`. The gap was never architectural — it was parameters, closed by #141:

| Param | Before | Now | Claude Code |
|---|---|---|---|
| `model` | `nova-2` | `nova-3` | nova-3 (via proxy) |
| `endpointing` | unset (10 ms default) | `300` | `300` (as `endpointing_ms`) |
| `language` when "Detect" | unset → English | `multi` | `en` default |

Still open, both needing a consumer that does not exist yet:

- **`utterance_end_ms`** — only makes Deepgram emit `UtteranceEnd` frames, which
  `deepgram.ts`'s message handler ignores (it reads `Results` only). Inert until the
  renderer uses it as a pause signal.
- **Keyterm prompting** — `keyterm`, nova-3 only, repeatable, ≤500 tokens. Needs a source
  of project/file/symbol terms. Deepgram's own parameter is `keyterm`; Claude Code passes
  its list through the `x-config-keyterms` proxy header instead.

For using an agent subscription's own endpoint rather than a Deepgram key, see
[../plans/voice-provider-via-subscription.md](../plans/voice-provider-via-subscription.md).

## Confidence

Everything above is quoted from shipped code — Claude's query string, headers, control
frames, timeouts and SoX argv verbatim from the bundle; Codex's constants, session JSON
and event names from the clone. Nothing is inferred from documentation or memory.

**Not verified on the wire.** No live traffic capture was run, so server responses are
read from the client's parser rather than observed. The Deepgram-proxy conclusion rests on
`stt_provider=deepgram-nova3` plus Deepgram-native control frames and query params — strong,
but how faithfully the proxy passes Deepgram through downstream is unconfirmed.
