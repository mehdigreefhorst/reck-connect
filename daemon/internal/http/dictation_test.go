package http

import (
	"encoding/json"
	nethttp "net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/rudie-verweij/reck-connect/daemon/internal/dictation"
	"github.com/rudie-verweij/reck-connect/proto"
)

// stubCreds builds a credential loader that never touches a real keychain
// or a user's ~/.codex.
func stubCreds(byProvider map[dictation.Provider]struct {
	cred dictation.Credential
	err  error
}) func(dictation.Provider) (dictation.Credential, error) {
	return func(p dictation.Provider) (dictation.Credential, error) {
		got, ok := byProvider[p]
		if !ok {
			return dictation.Credential{}, dictation.ErrNoCredentials
		}
		return got.cred, got.err
	}
}

type credCase = struct {
	cred dictation.Credential
	err  error
}

func TestDictationProviders(t *testing.T) {
	s := newServer(t)
	s.DictationCreds = stubCreds(map[dictation.Provider]credCase{
		dictation.ProviderClaude: {cred: dictation.Credential{Token: "tok"}},
		dictation.ProviderCodex:  {err: dictation.ErrTokenExpired},
	})
	h := newTestHandler(t, s)

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(nethttp.MethodGet, "/dictation/providers", nil))

	if rec.Code != nethttp.StatusOK {
		t.Fatalf("status = %d, want 200 (body %q)", rec.Code, rec.Body.String())
	}
	var out proto.DictationProvidersResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if len(out.Providers) != 2 {
		t.Fatalf("got %d providers, want 2", len(out.Providers))
	}

	byName := map[string]proto.DictationProviderStatus{}
	for _, p := range out.Providers {
		byName[p.Provider] = p
	}

	claude := byName["claude"]
	if !claude.Available {
		t.Error("claude should be available")
	}
	if !claude.UsesSubscription {
		t.Error("an OAuth credential should report uses_subscription")
	}

	codex := byName["codex"]
	if codex.Available {
		t.Error("an expired codex token must not report available")
	}
	if !strings.Contains(codex.Reason, "codex") {
		t.Errorf("reason should tell the user what to run, got %q", codex.Reason)
	}
}

// The response describes availability only. A token reaching the satellite
// would defeat the entire reason dictation runs on the daemon.
func TestDictationProvidersNeverLeakTokens(t *testing.T) {
	const secret = "super-secret-token-value"
	s := newServer(t)
	s.DictationCreds = stubCreds(map[dictation.Provider]credCase{
		dictation.ProviderClaude: {cred: dictation.Credential{Token: secret}},
		dictation.ProviderCodex:  {cred: dictation.Credential{Token: secret, IsAPIKey: true}},
	})
	h := newTestHandler(t, s)

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(nethttp.MethodGet, "/dictation/providers", nil))

	if strings.Contains(rec.Body.String(), secret) {
		t.Fatalf("token leaked into the response: %s", rec.Body.String())
	}
}

func TestDictationProvidersMarksApiKeyAsNotSubscription(t *testing.T) {
	s := newServer(t)
	s.DictationCreds = stubCreds(map[dictation.Provider]credCase{
		dictation.ProviderCodex: {cred: dictation.Credential{Token: "sk-x", IsAPIKey: true}},
	})
	h := newTestHandler(t, s)

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(nethttp.MethodGet, "/dictation/providers", nil))

	var out proto.DictationProvidersResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("decode: %v", err)
	}
	for _, p := range out.Providers {
		if p.Provider != "codex" {
			continue
		}
		if !p.Available {
			t.Fatal("api key should be usable")
		}
		if p.UsesSubscription {
			t.Error("an API key is metered, not subscription-backed")
		}
	}
}

func TestDictationProvidersRequiresAuth(t *testing.T) {
	s := newServer(t)
	rec := httptest.NewRecorder()
	// s.Router() directly: no bearer injected.
	s.Router().ServeHTTP(rec, httptest.NewRequest(nethttp.MethodGet, "/dictation/providers", nil))
	if rec.Code != nethttp.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}

func TestDictationStreamValidation(t *testing.T) {
	tests := []struct {
		name  string
		query string
		want  int
	}{
		{"unknown provider", "?provider=deepgram", nethttp.StatusBadRequest},
		{"missing provider", "", nethttp.StatusBadRequest},
		{"sample rate too low", "?provider=claude&sample_rate=100", nethttp.StatusBadRequest},
		{"sample rate too high", "?provider=claude&sample_rate=96000", nethttp.StatusBadRequest},
		{"sample rate not a number", "?provider=claude&sample_rate=abc", nethttp.StatusBadRequest},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			s := newServer(t)
			s.DictationCreds = stubCreds(map[dictation.Provider]credCase{
				dictation.ProviderClaude: {cred: dictation.Credential{Token: "t"}},
			})
			h := newTestHandler(t, s)

			rec := httptest.NewRecorder()
			h.ServeHTTP(rec, httptest.NewRequest(nethttp.MethodGet, "/dictation/stream"+tc.query, nil))
			if rec.Code != tc.want {
				t.Fatalf("status = %d, want %d (body %q)", rec.Code, tc.want, rec.Body.String())
			}
		})
	}
}

// A missing credential must fail the HTTP request, not open a socket that
// immediately dies — the satellite can show the former, and the latter is
// indistinguishable from a network fault.
func TestDictationStreamRefusesBeforeUpgradeWhenCredentialsMissing(t *testing.T) {
	s := newServer(t)
	s.DictationCreds = stubCreds(map[dictation.Provider]credCase{
		dictation.ProviderClaude: {err: dictation.ErrNoCredentials},
	})
	h := newTestHandler(t, s)

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(nethttp.MethodGet, "/dictation/stream?provider=claude", nil))

	if rec.Code != nethttp.StatusPreconditionFailed {
		t.Fatalf("status = %d, want 412", rec.Code)
	}
	if !strings.Contains(rec.Body.String(), "claude") {
		t.Errorf("body should name the command to run, got %q", rec.Body.String())
	}
}

func TestDictationStreamExpiredTokenSaysSo(t *testing.T) {
	s := newServer(t)
	s.DictationCreds = stubCreds(map[dictation.Provider]credCase{
		dictation.ProviderCodex: {err: dictation.ErrTokenExpired},
	})
	h := newTestHandler(t, s)

	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, httptest.NewRequest(nethttp.MethodGet, "/dictation/stream?provider=codex", nil))

	if rec.Code != nethttp.StatusPreconditionFailed {
		t.Fatalf("status = %d, want 412", rec.Code)
	}
	if !strings.Contains(strings.ToLower(rec.Body.String()), "expired") {
		t.Errorf("body should mention expiry, got %q", rec.Body.String())
	}
}

func TestDictationStreamRejectsForeignOrigin(t *testing.T) {
	s := newServer(t)
	s.DictationCreds = stubCreds(map[dictation.Provider]credCase{
		dictation.ProviderClaude: {cred: dictation.Credential{Token: "t"}},
	})
	h := newTestHandler(t, s)

	req := httptest.NewRequest(nethttp.MethodGet, "/dictation/stream?provider=claude", nil)
	req.Header.Set("Origin", "https://evil.example")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)

	if rec.Code != nethttp.StatusForbidden {
		t.Fatalf("status = %d, want 403", rec.Code)
	}
}

func TestDictationStreamRequiresAuth(t *testing.T) {
	s := newServer(t)
	rec := httptest.NewRecorder()
	s.Router().ServeHTTP(rec, httptest.NewRequest(nethttp.MethodGet, "/dictation/stream?provider=claude", nil))
	if rec.Code != nethttp.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", rec.Code)
	}
}
