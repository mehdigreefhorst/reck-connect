package http

import (
	"encoding/json"
	"errors"
	nethttp "net/http"
	"strconv"
	"strings"
	"sync"

	"nhooyr.io/websocket"

	"github.com/rudie-verweij/reck-connect/daemon/internal/dictation"
)

// Dictation lives on the daemon rather than the satellite because of where
// credentials are. The satellite has the microphone; the machine running this
// daemon is the machine running Claude Code and Codex, and therefore the one
// holding their subscription tokens. This pair of routes is the join:
//
//	GET /dictation/providers  — which providers have usable credentials
//	GET /dictation/stream     — WebSocket: PCM16 up, transcript events down
//
// Both are bearer-authed by the existing middleware. Neither ever returns a
// token, only whether one exists.

// dictationProviderStatus reports whether a provider can be used right now,
// and if not, what the user should do about it.
type dictationProviderStatus struct {
	Provider  string `json:"provider"`
	Available bool   `json:"available"`
	// Reason is empty when Available. Otherwise it is user-facing text.
	Reason string `json:"reason,omitempty"`
	// UsesSubscription distinguishes riding an existing subscription from
	// metered API-key billing, so the UI can say which one is in play.
	UsesSubscription bool `json:"uses_subscription"`
}

type dictationProvidersResponse struct {
	Providers []dictationProviderStatus `json:"providers"`
}

// credLoader is the seam tests use to avoid touching a real keychain.
type credLoader func(dictation.Provider) (dictation.Credential, error)

func (s *Server) dictationCreds() credLoader {
	if s.DictationCreds != nil {
		return s.DictationCreds
	}
	return func(p dictation.Provider) (dictation.Credential, error) {
		if p == dictation.ProviderClaude {
			return dictation.LoadClaude()
		}
		return dictation.LoadCodex()
	}
}

func (s *Server) handleDictationProviders(w nethttp.ResponseWriter, r *nethttp.Request) {
	load := s.dictationCreds()
	out := dictationProvidersResponse{Providers: make([]dictationProviderStatus, 0, 2)}

	for _, p := range []dictation.Provider{dictation.ProviderClaude, dictation.ProviderCodex} {
		cred, err := load(p)
		st := dictationProviderStatus{Provider: string(p)}
		switch {
		case err == nil:
			st.Available = true
			st.UsesSubscription = !cred.IsAPIKey
		case errors.Is(err, dictation.ErrTokenExpired):
			st.Reason = expiredReason(p)
		default:
			st.Reason = missingReason(p)
		}
		out.Providers = append(out.Providers, st)
	}
	writeJSON(w, out)
}

func expiredReason(p dictation.Provider) string {
	if p == dictation.ProviderClaude {
		return "The Claude Code token has expired. Run `claude` once to refresh it."
	}
	return "The Codex token has expired. Run `codex` once to refresh it."
}

func missingReason(p dictation.Provider) string {
	if p == dictation.ProviderClaude {
		return "No Claude Code credentials on this machine. Run `claude` and sign in."
	}
	return "No Codex credentials on this machine. Run `codex` and sign in, or set OPENAI_API_KEY in ~/.codex/auth.json."
}

// transcriptEvent is what the satellite receives on the stream socket.
type transcriptEvent struct {
	Kind string `json:"kind"` // "partial" | "final" | "error" | "debug" | "ready"
	Text string `json:"text,omitempty"`
}

// handleDictationStream bridges a satellite WebSocket to a provider session.
//
// Satellite → daemon: binary frames are PCM16 audio; a text frame
// {"type":"stop"} requests a graceful finalize. Closing the socket also
// finalizes, so a dropped satellite never leaves a provider stream open.
//
// Daemon → satellite: newline-free JSON transcriptEvent frames.
func (s *Server) handleDictationStream(w nethttp.ResponseWriter, r *nethttp.Request) {
	if !originAllowed(r) {
		nethttp.Error(w, "forbidden origin", nethttp.StatusForbidden)
		return
	}

	provider := dictation.Provider(strings.TrimSpace(r.URL.Query().Get("provider")))
	if !dictation.ValidProvider(provider) {
		nethttp.Error(w, "unknown dictation provider", nethttp.StatusBadRequest)
		return
	}

	cfg := dictation.Config{
		SampleRate: 16000,
		Language:   strings.TrimSpace(r.URL.Query().Get("language")),
	}
	if raw := r.URL.Query().Get("sample_rate"); raw != "" {
		n, err := strconv.Atoi(raw)
		if err != nil || n < 8000 || n > 48000 {
			nethttp.Error(w, "sample_rate must be between 8000 and 48000", nethttp.StatusBadRequest)
			return
		}
		cfg.SampleRate = n
	}
	// "auto" means the caller has no preference; providers pick their own
	// default rather than being handed a bogus language code.
	if cfg.Language == "auto" {
		cfg.Language = ""
	}

	// Load credentials BEFORE upgrading, so a missing token is a plain HTTP
	// error the satellite can show, not a WebSocket that opens then dies.
	cred, err := s.dictationCreds()(provider)
	if err != nil {
		msg := missingReason(provider)
		if errors.Is(err, dictation.ErrTokenExpired) {
			msg = expiredReason(provider)
		}
		nethttp.Error(w, msg, nethttp.StatusPreconditionFailed)
		return
	}

	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		InsecureSkipVerify: true, // origin already checked above
	})
	if err != nil {
		return
	}
	defer conn.Close(websocket.StatusNormalClosure, "")
	conn.SetReadLimit(1 << 20)

	ctx := r.Context()

	// Serialise writes: transcript callbacks fire from the provider's read
	// goroutine while this handler's loop may also be writing.
	var writeMu sync.Mutex
	emit := func(kind, text string) {
		writeMu.Lock()
		defer writeMu.Unlock()
		payload, err := json.Marshal(transcriptEvent{Kind: kind, Text: text})
		if err != nil {
			return
		}
		_ = conn.Write(ctx, websocket.MessageText, payload)
	}

	session, err := dictation.Dial(ctx, provider, cred, cfg, "", dictation.Handlers{
		OnPartial: func(t string) { emit("partial", t) },
		OnFinal:   func(t string) { emit("final", t) },
		OnError:   func(m string) { emit("error", m) },
		OnDebug:   func(m string) { emit("debug", m) },
	})
	if err != nil {
		emit("error", err.Error())
		return
	}
	defer session.Close()

	emit("ready", "")

	for {
		mt, data, err := conn.Read(ctx)
		if err != nil {
			return // satellite went away; the deferred Close finalizes
		}
		switch mt {
		case websocket.MessageBinary:
			if err := session.SendAudio(ctx, data); err != nil {
				emit("error", err.Error())
				return
			}
		case websocket.MessageText:
			var ctl struct {
				Type string `json:"type"`
			}
			if err := json.Unmarshal(data, &ctl); err == nil && ctl.Type == "stop" {
				return // deferred Close flushes and promotes any pending partial
			}
		}
	}
}
