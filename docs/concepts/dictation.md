# Dictation on the daemon

Voice dictation has two possible homes, and they are decided by where the
credentials are.

The **satellite** has the microphone. The **daemon** shares a machine with Claude Code
and Codex, and therefore with their subscription credentials. The existing cloud path
(Deepgram, in the satellite main process) needs the user to bring a *third* paid
account. The daemon path does not: it reuses tokens the user already has.

```
mic (satellite)  ──PCM16──▶  /dictation/stream (daemon)  ──▶  Claude or OpenAI
                 ◀──JSON────                              ◀──  transcripts
```

This holds in both modes. In local mode the daemon is on the same Mac as the
satellite; in station mode it is on the station — which is also where the agent CLIs
run, so it is where their tokens are. The split is not a compromise; it is the reason
the design works.

## Providers

| | `claude` | `codex` |
|---|---|---|
| Endpoint | `wss://api.anthropic.com/api/ws/speech_to_text/voice_stream` | `wss://api.openai.com/v1/realtime?intent=transcription` |
| Engine | Deepgram Nova-3 (Anthropic proxies it) | `gpt-4o-mini-transcribe` |
| Audio | PCM16 16 kHz, bare binary frames | PCM16 24 kHz, base64 in JSON |
| Credential | Claude Code OAuth token | Codex ChatGPT token, else `OPENAI_API_KEY` |
| Public API? | **no** — internal and undocumented | **yes** — documented |

How each protocol was derived is in
[../reference/agent-cli-dictation.md](../reference/agent-cli-dictation.md).

## Credential handling

`internal/dictation` **reads** these stores and never writes them, exactly as
`internal/usage` already does for Claude's quota poller:

- **Claude** — macOS keychain item `Claude Code-credentials`, or
  `~/.claude/.credentials.json` on Linux. Reuses `usage.LoadCredentials`.
- **Codex** — `~/.codex/auth.json`. A live ChatGPT token wins over `OPENAI_API_KEY`,
  because riding the subscription is the point; the API key is the fallback, including
  when the ChatGPT token has expired, so a stale Codex login degrades to metered
  billing rather than to nothing.

Refreshing an expired token is the owning CLI's job. That keeps the daemon out of the
auth business — no refresh-token handling, no clobbering a file another process owns —
at the cost of dictation failing until the user next runs that CLI. Refresh tokens are
never parsed, so they cannot reach the `Credential` struct at all, and `Token` is
excluded from `String()`.

Codex expiry is read from the access token's JWT `exp` **without verifying the
signature**. We are not the audience; the only use is turning a predictable 401 into
"run `codex` once". A token with no readable `exp` is treated as possibly-live —
guessing wrong that way costs one request, the opposite costs a working setup.

## Routes

Both are bearer-authed by the existing middleware.

### `GET /dictation/providers`

```jsonc
{"providers": [
  {"provider": "claude", "available": true,  "uses_subscription": true},
  {"provider": "codex",  "available": false, "uses_subscription": false,
   "reason": "The Codex token has expired. Run `codex` once to refresh it."}
]}
```

Availability only — **never a token**. `uses_subscription` distinguishes riding a
subscription from metered API-key billing so the UI can say which is in play.

### `GET /dictation/stream?provider=&sample_rate=&language=&endpoint_mode=&silence_ms=`

WebSocket. `sample_rate` defaults to 16000 and must be 8000–48000; `language=auto`
means "no preference" and is passed as empty so each provider picks its own default.

`endpoint_mode` (`auto`|`manual`) and `silence_ms` (100–5000) are the caller's
endpointing preference — how long a pause has to be before the provider closes an
utterance. Both are optional, and omitting them keeps each provider's own defaults,
so an older satellite behaves exactly as it did before the knob existed. Manual mode
means "never finalize on silence": Codex is sent `turn_detection: null` (no live
partials — its partials come from the same VAD) and the Deepgram-backed providers get
an effectively-infinite window, with the transcript arriving on the stop frame either
way. The per-provider mapping lives in `internal/dictation/protocols.go`; the rationale
is in `docs/plans/dictation-endpointing.md`.

- **Up**: binary frames are PCM16 audio. Text `{"type":"stop"}` finalizes.
- **Down**: `{"kind":"ready"|"partial"|"final"|"error"|"debug","text":"…"}`.

Credentials are checked **before** the upgrade, so a missing or expired token is a
`412` with actionable text rather than a socket that opens and dies — the latter is
indistinguishable from a network fault at the satellite end. The same origin allowlist
as `/ws/{id}/{pane_id}` applies, so a browser cannot be induced into opening a
dictation stream cross-site.

## Finalize discipline

Both providers share one rule, taken from what Claude Code does with the same endpoint:
on stop, send the provider's end-of-stream frame, wait for quiet (1.5 s idle, 5 s hard
bound), then **promote any partial that never received a final**. Without that last
step the tail of an utterance is silently dropped whenever the user stops talking and
releases the key in the same breath.

Unknown message types are ignored rather than treated as errors. Neither response
schema is a public API and both gain members without notice.

## We do not impersonate the CLIs

Claude Code sends `x-app: cli` and its own user-agent to its speech endpoint. We send
`User-Agent: reck-connect-dictation` and nothing else identifying.

Copying those headers to get past a check would be dishonest, and it would hide the one
signal worth having: if that endpoint starts gating on client identity, being refused
*is* the answer to whether it is meant for third parties. A test pins that we never
send `x-app`.

More generally — the Claude route works today but has no stability contract. It is
undocumented, unversioned, and reached with a credential minted for a different
application. The Codex route is a public documented API and is the safer of the two to
depend on. Deepgram remains the default and the fallback.
