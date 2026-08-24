package dictation

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"nhooyr.io/websocket"
)

// userAgent identifies us honestly.
//
// Claude Code sends `x-app: cli` and its own user-agent to this endpoint. We
// deliberately do NOT copy those: we are not Claude Code, and impersonating
// it to get past a check would be both dishonest and a bad signal to build
// on. If the endpoint ever starts gating on client identity we want to find
// out by being refused, because that refusal is the answer to whether this
// path is meant for third parties at all.
const userAgent = "reck-connect-dictation"

// ---------------------------------------------------------------------------
// Claude — Anthropic's speech endpoint (a Deepgram Nova-3 proxy)
// ---------------------------------------------------------------------------

// claudeProtocol speaks the WebSocket behind
// /api/ws/speech_to_text/voice_stream. Audio goes up as bare binary frames of
// PCM16; control frames and the response envelope are documented in
// docs/reference/agent-cli-dictation.md.
//
// The query parameters mirror what Claude Code asks for, because they are
// tuned for exactly this use case (short CLI dictation, not meetings). Note
// `endpointing_ms` is this endpoint's own spelling — Deepgram's direct API
// calls the same knob `endpointing`.
type claudeProtocol struct{}

const claudePath = "/api/ws/speech_to_text/voice_stream"

func (claudeProtocol) url(base string, cfg Config) string {
	q := url.Values{}
	q.Set("encoding", "linear16")
	q.Set("sample_rate", strconv.Itoa(cfg.SampleRate))
	q.Set("channels", "1")
	q.Set("endpointing_ms", "300")
	q.Set("utterance_end_ms", "1000")
	q.Set("use_conversation_engine", "true")
	q.Set("stt_provider", "deepgram-nova3")
	lang := strings.TrimSpace(cfg.Language)
	if lang == "" {
		lang = "en"
	}
	q.Set("language", lang)
	return strings.TrimRight(base, "/") + claudePath + "?" + q.Encode()
}

func (claudeProtocol) headers(cred Credential) http.Header {
	h := http.Header{}
	h.Set("Authorization", "Bearer "+cred.Token)
	h.Set("User-Agent", userAgent)
	return h
}

func (claudeProtocol) hello(Config) (websocket.MessageType, []byte, bool) {
	return 0, nil, false
}

func (claudeProtocol) encodeAudio(pcm []byte, _ Config) (websocket.MessageType, []byte) {
	return websocket.MessageBinary, evenLen(pcm)
}

func (claudeProtocol) keepAlive() (websocket.MessageType, []byte, time.Duration) {
	return websocket.MessageText, []byte(`{"type":"KeepAlive"}`), 8 * time.Second
}

func (claudeProtocol) goodbye() (websocket.MessageType, []byte, bool) {
	return websocket.MessageText, []byte(`{"type":"CloseStream"}`), true
}

func (claudeProtocol) decode(raw []byte) (event, bool) {
	var m struct {
		Type        string `json:"type"`
		Data        string `json:"data"`
		Description string `json:"description"`
		ErrorCode   string `json:"error_code"`
		Message     string `json:"message"`
	}
	if err := json.Unmarshal(raw, &m); err != nil {
		return event{}, false
	}
	switch m.Type {
	case "TranscriptInterim", "TranscriptText":
		return event{Text: m.Data}, m.Data != ""
	case "TranscriptEndpoint":
		return event{Endpoint: true}, true
	case "TranscriptError":
		msg := firstNonEmpty(m.Description, m.ErrorCode, "unknown transcription error")
		return event{Err: msg}, true
	case "error":
		return event{Err: firstNonEmpty(m.Message, "speech service error")}, true
	}
	// Unknown types are not errors — this schema is not a public API and
	// gains members without notice.
	return event{}, false
}

// ---------------------------------------------------------------------------
// Codex — the public OpenAI realtime API
// ---------------------------------------------------------------------------

// codexRate is what OpenAI's realtime API expects. The satellite captures at
// 16 kHz, so this protocol resamples on the way out.
const codexRate = 24000

// codexTranscribeModel is what Codex itself uses for input transcription.
const codexTranscribeModel = "gpt-4o-mini-transcribe"

// codexProtocol speaks OpenAI's realtime API in transcription-only mode: no
// model replies, no audio output, just transcripts of the input buffer.
//
// Unlike Claude's endpoint this one is public and documented, so it is the
// safer of the two to depend on. It is stateful because the API reports
// transcripts as incremental deltas while our session contract is
// "the running text so far".
type codexProtocol struct {
	mu      sync.Mutex
	running strings.Builder
}

func (*codexProtocol) url(base string, _ Config) string {
	return strings.TrimRight(base, "/") + "/v1/realtime?intent=transcription"
}

func (*codexProtocol) headers(cred Credential) http.Header {
	h := http.Header{}
	h.Set("Authorization", "Bearer "+cred.Token)
	h.Set("User-Agent", userAgent)
	// No OpenAI-Beta header: that header selects the retired beta realtime
	// API, which the server now refuses (close 4000, beta_api_shape_disabled).
	// The GA API is the bare /v1/realtime endpoint.
	// Subscription tokens are scoped to a ChatGPT account; API keys are not.
	if cred.AccountID != "" {
		h.Set("chatgpt-account-id", cred.AccountID)
	}
	return h
}

// hello configures a transcription session. server_vad is what produces live
// partials mid-utterance; without it nothing is transcribed until commit.
func (*codexProtocol) hello(cfg Config) (websocket.MessageType, []byte, bool) {
	input := map[string]any{
		"format":         map[string]any{"type": "audio/pcm", "rate": codexRate},
		"transcription":  map[string]any{"model": codexTranscribeModel},
		"turn_detection": map[string]any{"type": "server_vad", "silence_duration_ms": 500},
	}
	if lang := strings.TrimSpace(cfg.Language); lang != "" {
		input["transcription"] = map[string]any{
			"model":    codexTranscribeModel,
			"language": lang,
		}
	}
	payload, err := json.Marshal(map[string]any{
		"type": "session.update",
		"session": map[string]any{
			"type":  "transcription",
			"audio": map[string]any{"input": input},
		},
	})
	if err != nil {
		return 0, nil, false
	}
	return websocket.MessageText, payload, true
}

func (*codexProtocol) encodeAudio(pcm []byte, cfg Config) (websocket.MessageType, []byte) {
	out := resamplePCM16(pcm, cfg.SampleRate, codexRate)
	if len(out) == 0 {
		return websocket.MessageText, nil
	}
	payload, err := json.Marshal(map[string]any{
		"type":  "input_audio_buffer.append",
		"audio": base64.StdEncoding.EncodeToString(out),
	})
	if err != nil {
		return websocket.MessageText, nil
	}
	return websocket.MessageText, payload
}

// keepAlive is unnecessary: the realtime API does not close an idle socket
// the way Deepgram does.
func (*codexProtocol) keepAlive() (websocket.MessageType, []byte, time.Duration) {
	return 0, nil, 0
}

// goodbye commits whatever audio server_vad has not yet closed out, so the
// tail of an utterance is transcribed instead of discarded. Committing an
// empty buffer is answered with an error event, which decode downgrades.
func (*codexProtocol) goodbye() (websocket.MessageType, []byte, bool) {
	return websocket.MessageText, []byte(`{"type":"input_audio_buffer.commit"}`), true
}

func (p *codexProtocol) decode(raw []byte) (event, bool) {
	var m struct {
		Type       string `json:"type"`
		Delta      string `json:"delta"`
		Transcript string `json:"transcript"`
		Error      struct {
			Message string `json:"message"`
			Code    string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(raw, &m); err != nil {
		return event{}, false
	}

	switch m.Type {
	case "conversation.item.input_audio_transcription.delta":
		if m.Delta == "" {
			return event{}, false
		}
		p.mu.Lock()
		p.running.WriteString(m.Delta)
		text := p.running.String()
		p.mu.Unlock()
		return event{Text: text}, true

	case "conversation.item.input_audio_transcription.completed":
		p.mu.Lock()
		text := firstNonEmpty(m.Transcript, p.running.String())
		p.running.Reset()
		p.mu.Unlock()
		return event{Text: text, Final: true}, text != ""

	case "error":
		msg := firstNonEmpty(m.Error.Message, m.Error.Code, "realtime API error")
		// Committing an empty or too-short buffer is an expected outcome of
		// stopping right after a VAD boundary, not something to show a user.
		if isBenignCommitError(msg) {
			return event{}, false
		}
		return event{Err: msg}, true
	}
	return event{}, false
}

func isBenignCommitError(msg string) bool {
	l := strings.ToLower(msg)
	return strings.Contains(l, "buffer") &&
		(strings.Contains(l, "empty") || strings.Contains(l, "small") || strings.Contains(l, "commit"))
}

func firstNonEmpty(vals ...string) string {
	for _, v := range vals {
		if v != "" {
			return v
		}
	}
	return ""
}

// describeProvider is used in user-facing errors.
func describeProvider(p Provider) string {
	switch p {
	case ProviderClaude:
		return "Claude"
	case ProviderCodex:
		return "Codex"
	}
	return fmt.Sprintf("%v", p)
}
