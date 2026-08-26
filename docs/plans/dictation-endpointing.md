# Dictation endpointing: user-tunable silence, and Enter that waits for the tail

Status: spec + implementation (this branch)
Related: docs/plans/voice-dictation-satellite.md, voice-dictation-phase2.md, daemon docs/concepts/dictation.md

## Problem

Two complaints, one root cause.

1. **"Codex is super sensitive & bad for short texts."** Every streaming engine
   closes an utterance after a fixed amount of silence, and every one of those
   values is hardcoded:

   | Engine | Parameter | Value | Where (before this change) |
   |---|---|---|---|
   | Claude (daemon proxy) | `endpointing_ms` / `utterance_end_ms` | 300 / 1000 | `daemon/internal/dictation/protocols.go` |
   | Codex (OpenAI realtime) | `turn_detection.silence_duration_ms` | 500 | `daemon/internal/dictation/protocols.go` |
   | Deepgram (direct) | `endpointing` | 300 | `satellite/main/transcription/deepgram.ts` |

   Codex additionally re-runs `gpt-4o-mini-transcribe` per turn with no
   cross-turn context, so an early cut is not just an early flush — it is a
   worse transcript.

   The `Settle (ms)` knob in the Advanced panel is **not** this. `settleMs` is
   a render cadence: how often buffered interims are flushed to the pill and
   the prompt. It never reaches the provider.

2. **Enter throws away the tail.** `onSubmit` → `stopForSend()` → `cancel()`.
   Bare Enter is deliberately not `preventDefault`'d, so the terminal submits
   immediately and any audio still in flight is discarded. Acceptable when
   endpointing is aggressive; fatal once the user can turn endpointing off,
   because then *nothing* has been transcribed yet.

## Design

### 1. One shared knob, mapped per provider

New, persisted settings block (`TranscriptionSettings.endpointing`):

```ts
interface DictationEndpointing {
  mode: "auto" | "manual";   // "manual" = never finalize on silence
  silenceMs: number;         // 100–5000, used when mode === "auto"
}
```

Default: `{ mode: "auto", silenceMs: 500 }`. Note this unifies the three
previous defaults on 500 ms — Codex keeps its old value; Claude and Deepgram
become 200 ms calmer, which is the direction the complaint points.

Mapping, applied at the edge that talks to each provider:

| Engine | `auto` | `manual` |
|---|---|---|
| Deepgram | `endpointing = silenceMs` | `endpointing = 60000` (no true off switch; finals still arrive on `CloseStream`) |
| Claude | `endpointing_ms = silenceMs`, `utterance_end_ms = silenceMs + 700` | both `60000` |
| Codex | `turn_detection = {server_vad, silence_duration_ms: silenceMs}` | `turn_detection: null` — nothing is transcribed until `input_audio_buffer.commit`, which `goodbye()` already sends |
| Local Whisper | unaffected — it chunks on its own cadence | unaffected |

**Manual mode has a real cost on Codex**: with `turn_detection: null` the API
emits no live partials, so there is no crystallizing text until you stop. The
control's help text says so.

### 2. Enter waits for the tail (always)

`onSubmit` becomes an interception rather than an observation:

- While dictation is inactive, Enter is untouched (no `preventDefault`).
- While dictation is active, Enter is `preventDefault`'d. The controller
  finalizes (`engine.stop()` — which already awaits the provider flush), lets
  the final land in the prompt, and then submits itself.
- Bounded by `SEND_FLUSH_TIMEOUT_MS = 3000`. On timeout we cancel and submit
  what we have, so Enter can never appear to do nothing.
- A second Enter while a send is pending forces the submit immediately.
- The submit fires regardless of the `autoSubmit` preference — the user
  pressed Enter; that *is* the instruction.

### 3. Where the knobs live

The right-click **Advanced** panel (and therefore the dictation lab, which
shares the same component) gains an **Endpointing** section: a `mode` select
and a `silenceMs` slider. `appearanceControls.ts` grows a generic row renderer
so the engine knobs reuse the exact same slider/select/checkbox rows instead of
a parallel implementation; `DictationAppearance` stays view-only.

## Wire changes

- `GET /dictation/stream` accepts `endpoint_mode` (`auto`|`manual`) and
  `silence_ms` (100–5000). Both optional; omitted = today's defaults.
- `dictation.Config` gains `ManualEndpoint bool` and `SilenceMs int`
  (0 = provider default).
- `transcription:deepgram:start` IPC gains an `endpointingMs` argument.

All three are additive and backward-compatible: an older satellite talking to a
newer daemon (or vice versa) keeps the previous behavior.

## Test plan

- `transcriptionSettings.test.ts` — coercion, clamping, defaults, unknown mode.
- `endpointing.test.ts` — the per-provider mapping table above.
- `protocols_test.go` — Claude query params and Codex `session.update` payload
  in both modes.
- `dictation_test.go` (router) — query parsing + rejection of out-of-range.
- `TranscriptionController` send path — Enter finalizes, submits once, and
  still submits on flush timeout.
