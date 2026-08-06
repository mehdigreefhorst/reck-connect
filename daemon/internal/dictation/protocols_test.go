package dictation

import (
	"encoding/base64"
	"encoding/json"
	"net/url"
	"strings"
	"testing"
)

func parseQuery(t *testing.T, raw string) url.Values {
	t.Helper()
	u, err := url.Parse(raw)
	if err != nil {
		t.Fatalf("parse url: %v", err)
	}
	return u.Query()
}

func TestClaudeURL(t *testing.T) {
	got := claudeProtocol{}.url("wss://api.anthropic.com", Config{SampleRate: 16000})
	if !strings.HasPrefix(got, "wss://api.anthropic.com"+claudePath+"?") {
		t.Fatalf("unexpected path: %s", got)
	}
	q := parseQuery(t, got)

	want := map[string]string{
		"encoding":                "linear16",
		"sample_rate":             "16000",
		"channels":                "1",
		"endpointing_ms":          "300",
		"utterance_end_ms":        "1000",
		"use_conversation_engine": "true",
		"stt_provider":            "deepgram-nova3",
		"language":                "en",
	}
	for k, v := range want {
		if got := q.Get(k); got != v {
			t.Errorf("query %s = %q, want %q", k, got, v)
		}
	}
}

func TestClaudeURLHonoursConfig(t *testing.T) {
	q := parseQuery(t, claudeProtocol{}.url("wss://h", Config{SampleRate: 24000, Language: "nl"}))
	if q.Get("sample_rate") != "24000" {
		t.Errorf("sample_rate = %q, want 24000", q.Get("sample_rate"))
	}
	if q.Get("language") != "nl" {
		t.Errorf("language = %q, want nl", q.Get("language"))
	}
}

// We authenticate as ourselves. Copying Claude Code's `x-app: cli` would be
// impersonation, and would hide the signal we actually want if the endpoint
// ever starts gating on client identity.
func TestClaudeHeadersDoNotImpersonateTheCLI(t *testing.T) {
	h := claudeProtocol{}.headers(Credential{Token: "tok-abc"})
	if got := h.Get("Authorization"); got != "Bearer tok-abc" {
		t.Errorf("Authorization = %q", got)
	}
	if got := h.Get("User-Agent"); got != userAgent {
		t.Errorf("User-Agent = %q, want %q", got, userAgent)
	}
	if h.Get("x-app") != "" {
		t.Error("must not send Claude Code's x-app header")
	}
}

func TestClaudeDecode(t *testing.T) {
	tests := []struct {
		name    string
		raw     string
		wantOK  bool
		wantEv  event
		wantErr bool
	}{
		{name: "interim", raw: `{"type":"TranscriptInterim","data":"hello"}`,
			wantOK: true, wantEv: event{Text: "hello"}},
		{name: "text is also a partial", raw: `{"type":"TranscriptText","data":"hi there"}`,
			wantOK: true, wantEv: event{Text: "hi there"}},
		{name: "empty interim is uninteresting", raw: `{"type":"TranscriptInterim","data":""}`,
			wantOK: false},
		{name: "endpoint", raw: `{"type":"TranscriptEndpoint"}`,
			wantOK: true, wantEv: event{Endpoint: true}},
		{name: "transcript error prefers description",
			raw: `{"type":"TranscriptError","description":"bad audio","error_code":"E1"}`,
			wantOK: true, wantErr: true},
		{name: "bare error frame", raw: `{"type":"error","message":"nope"}`,
			wantOK: true, wantErr: true},
		{name: "unknown type is ignored, not an error", raw: `{"type":"SomethingNew","data":"x"}`,
			wantOK: false},
		{name: "malformed json is ignored", raw: `{`, wantOK: false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			ev, ok := claudeProtocol{}.decode([]byte(tc.raw))
			if ok != tc.wantOK {
				t.Fatalf("ok = %v, want %v", ok, tc.wantOK)
			}
			if !ok {
				return
			}
			if tc.wantErr {
				if ev.Err == "" {
					t.Fatal("expected an error event")
				}
				return
			}
			if ev.Text != tc.wantEv.Text || ev.Endpoint != tc.wantEv.Endpoint {
				t.Fatalf("event = %+v, want %+v", ev, tc.wantEv)
			}
		})
	}
}

func TestClaudeControlFrames(t *testing.T) {
	_, ka, every := claudeProtocol{}.keepAlive()
	if string(ka) != `{"type":"KeepAlive"}` {
		t.Errorf("keepalive = %s", ka)
	}
	if every == 0 {
		t.Error("keepalive interval must be non-zero — Deepgram drops idle streams")
	}
	_, bye, ok := claudeProtocol{}.goodbye()
	if !ok || string(bye) != `{"type":"CloseStream"}` {
		t.Errorf("goodbye = %s (ok=%v)", bye, ok)
	}
}

func TestCodexHeaders(t *testing.T) {
	t.Run("chatgpt token carries the account id", func(t *testing.T) {
		h := (&codexProtocol{}).headers(Credential{Token: "jwt", AccountID: "acct-1"})
		if h.Get("Authorization") != "Bearer jwt" {
			t.Errorf("Authorization = %q", h.Get("Authorization"))
		}
		if h.Get("chatgpt-account-id") != "acct-1" {
			t.Errorf("chatgpt-account-id = %q", h.Get("chatgpt-account-id"))
		}
	})
	t.Run("api key sends no account id", func(t *testing.T) {
		h := (&codexProtocol{}).headers(Credential{Token: "sk-x", IsAPIKey: true})
		if h.Get("chatgpt-account-id") != "" {
			t.Error("api-key credential must not send chatgpt-account-id")
		}
	})
}

func TestCodexHelloIsATranscriptionSession(t *testing.T) {
	_, payload, ok := (&codexProtocol{}).hello(Config{SampleRate: 16000})
	if !ok {
		t.Fatal("hello must be sent")
	}
	var m struct {
		Type    string `json:"type"`
		Session struct {
			Type  string `json:"type"`
			Audio struct {
				Input struct {
					Format        map[string]any `json:"format"`
					Transcription map[string]any `json:"transcription"`
					TurnDetection map[string]any `json:"turn_detection"`
				} `json:"input"`
			} `json:"audio"`
		} `json:"session"`
	}
	if err := json.Unmarshal(payload, &m); err != nil {
		t.Fatalf("hello is not valid json: %v", err)
	}
	if m.Type != "session.update" {
		t.Errorf("type = %q", m.Type)
	}
	// Transcription-only: no model replies, no audio output.
	if m.Session.Type != "transcription" {
		t.Errorf("session.type = %q, want transcription", m.Session.Type)
	}
	if got := m.Session.Audio.Input.Format["rate"]; got != float64(codexRate) {
		t.Errorf("rate = %v, want %d", got, codexRate)
	}
	if got := m.Session.Audio.Input.Transcription["model"]; got != codexTranscribeModel {
		t.Errorf("model = %v, want %s", got, codexTranscribeModel)
	}
	// server_vad is what produces live partials mid-utterance.
	if got := m.Session.Audio.Input.TurnDetection["type"]; got != "server_vad" {
		t.Errorf("turn_detection = %v, want server_vad", got)
	}
}

func TestCodexEncodeAudioResamplesAndBase64s(t *testing.T) {
	in := make([]int16, 160) // 10 ms @ 16 kHz
	for i := range in {
		in[i] = int16(i * 10)
	}
	_, payload := (&codexProtocol{}).encodeAudio(pcm(in...), Config{SampleRate: 16000})

	var m struct {
		Type  string `json:"type"`
		Audio string `json:"audio"`
	}
	if err := json.Unmarshal(payload, &m); err != nil {
		t.Fatalf("not valid json: %v", err)
	}
	if m.Type != "input_audio_buffer.append" {
		t.Errorf("type = %q", m.Type)
	}
	decoded, err := base64.StdEncoding.DecodeString(m.Audio)
	if err != nil {
		t.Fatalf("audio is not base64: %v", err)
	}
	// 16k -> 24k is 1.5×, so 160 samples in should be ~240 out.
	if got := len(decoded) / 2; got < 238 || got > 242 {
		t.Errorf("resampled to %d samples, want ~240", got)
	}
}

// The API reports transcripts as incremental deltas; our session contract is
// "the running text so far", so deltas must accumulate rather than replace.
func TestCodexDecodeAccumulatesDeltas(t *testing.T) {
	p := &codexProtocol{}
	const d = "conversation.item.input_audio_transcription.delta"

	ev, ok := p.decode([]byte(`{"type":"` + d + `","delta":"Hello"}`))
	if !ok || ev.Text != "Hello" {
		t.Fatalf("first delta = %+v (ok=%v)", ev, ok)
	}
	ev, ok = p.decode([]byte(`{"type":"` + d + `","delta":" world"}`))
	if !ok || ev.Text != "Hello world" {
		t.Fatalf("second delta = %+v (ok=%v), want accumulation", ev, ok)
	}
	if ev.Final {
		t.Error("a delta is not final")
	}

	ev, ok = p.decode([]byte(`{"type":"conversation.item.input_audio_transcription.completed",` +
		`"transcript":"Hello world."}`))
	if !ok || !ev.Final || ev.Text != "Hello world." {
		t.Fatalf("completed = %+v (ok=%v)", ev, ok)
	}

	// The running buffer must reset, or the next utterance inherits this one.
	ev, ok = p.decode([]byte(`{"type":"` + d + `","delta":"Next"}`))
	if !ok || ev.Text != "Next" {
		t.Fatalf("after completed, delta = %+v, want a fresh buffer", ev)
	}
}

func TestCodexDecodeErrors(t *testing.T) {
	tests := []struct {
		name   string
		raw    string
		wantOK bool
	}{
		{"real error surfaces", `{"type":"error","error":{"message":"invalid api key"}}`, true},
		{"empty-buffer commit is expected, not shown",
			`{"type":"error","error":{"message":"Error committing input audio buffer: buffer is empty."}}`, false},
		{"too-small buffer is also benign",
			`{"type":"error","error":{"code":"input_audio_buffer_commit_empty","message":"buffer too small"}}`, false},
		{"unknown event ignored", `{"type":"response.created"}`, false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			ev, ok := (&codexProtocol{}).decode([]byte(tc.raw))
			if ok != tc.wantOK {
				t.Fatalf("ok = %v, want %v (ev=%+v)", ok, tc.wantOK, ev)
			}
			if ok && ev.Err == "" {
				t.Error("expected an error message")
			}
		})
	}
}

func TestValidProvider(t *testing.T) {
	for _, p := range []Provider{ProviderClaude, ProviderCodex} {
		if !ValidProvider(p) {
			t.Errorf("%q should be valid", p)
		}
	}
	for _, p := range []Provider{"", "deepgram", "openai", "CLAUDE"} {
		if ValidProvider(p) {
			t.Errorf("%q should not be valid", p)
		}
	}
}
