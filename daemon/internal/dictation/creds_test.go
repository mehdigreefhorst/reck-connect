package dictation

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// jwtWithExp builds a JWT-shaped string whose payload carries `exp`. Only the
// payload segment is ever read, so the header and signature are filler.
func jwtWithExp(t *testing.T, exp time.Time) string {
	t.Helper()
	payload, err := json.Marshal(map[string]any{"exp": exp.Unix()})
	if err != nil {
		t.Fatalf("marshal payload: %v", err)
	}
	enc := base64.RawURLEncoding.EncodeToString
	return enc([]byte(`{"alg":"none"}`)) + "." + enc(payload) + "." + "sig"
}

func writeCodexAuth(t *testing.T, home string, body string) {
	t.Helper()
	dir := filepath.Join(home, ".codex")
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(dir, "auth.json"), []byte(body), 0o600); err != nil {
		t.Fatalf("write auth.json: %v", err)
	}
}

func TestLoadCodexCredentials(t *testing.T) {
	future := time.Now().Add(24 * time.Hour)
	past := time.Now().Add(-24 * time.Hour)

	tests := []struct {
		name      string
		body      func(t *testing.T) string
		wantToken string
		wantAcct  string
		wantKey   bool
		wantErr   error
	}{
		{
			name: "chatgpt tokens preferred over an api key",
			body: func(t *testing.T) string {
				return `{"OPENAI_API_KEY":"sk-should-not-win","tokens":{` +
					`"access_token":"` + jwtWithExp(t, future) + `",` +
					`"refresh_token":"rt-never-read","account_id":"acct-123"}}`
			},
			wantAcct: "acct-123",
		},
		{
			name: "falls back to the api key when no tokens are present",
			body: func(*testing.T) string {
				return `{"OPENAI_API_KEY":"sk-live-key"}`
			},
			wantToken: "sk-live-key",
			wantKey:   true,
		},
		{
			name: "an expired chatgpt token is reported as expired, not used",
			body: func(t *testing.T) string {
				return `{"tokens":{"access_token":"` + jwtWithExp(t, past) + `","refresh_token":"rt"}}`
			},
			wantErr: ErrTokenExpired,
		},
		{
			name: "an expired token still yields the api key when one exists",
			body: func(t *testing.T) string {
				return `{"OPENAI_API_KEY":"sk-fallback","tokens":{` +
					`"access_token":"` + jwtWithExp(t, past) + `","refresh_token":"rt"}}`
			},
			wantToken: "sk-fallback",
			wantKey:   true,
		},
		{
			name:    "empty object has nothing usable",
			body:    func(*testing.T) string { return `{}` },
			wantErr: ErrNoCredentials,
		},
		{
			name:    "malformed json is not a crash",
			body:    func(*testing.T) string { return `{"tokens":` },
			wantErr: ErrNoCredentials,
		},
		{
			name: "a token without a parseable exp is accepted rather than assumed dead",
			body: func(*testing.T) string {
				return `{"tokens":{"access_token":"not-a-jwt","refresh_token":"rt"}}`
			},
			wantToken: "not-a-jwt",
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			home := t.TempDir()
			writeCodexAuth(t, home, tc.body(t))

			got, err := loadCodexFrom(home)

			if tc.wantErr != nil {
				if !errors.Is(err, tc.wantErr) {
					t.Fatalf("err = %v, want %v", err, tc.wantErr)
				}
				return
			}
			if err != nil {
				t.Fatalf("unexpected error: %v", err)
			}
			if tc.wantToken != "" && got.Token != tc.wantToken {
				t.Errorf("Token = %q, want %q", got.Token, tc.wantToken)
			}
			if got.Token == "" {
				t.Error("Token is empty")
			}
			if got.AccountID != tc.wantAcct {
				t.Errorf("AccountID = %q, want %q", got.AccountID, tc.wantAcct)
			}
			if got.IsAPIKey != tc.wantKey {
				t.Errorf("IsAPIKey = %v, want %v", got.IsAPIKey, tc.wantKey)
			}
		})
	}
}

func TestLoadCodexCredentialsMissingFile(t *testing.T) {
	if _, err := loadCodexFrom(t.TempDir()); !errors.Is(err, ErrNoCredentials) {
		t.Fatalf("err = %v, want ErrNoCredentials", err)
	}
}

// The refresh token is the one field we must never surface: we read this
// store and let Codex own rotation, exactly as the usage package does for
// Claude. A credential that carried it could leak it into a log or an error.
func TestCodexRefreshTokenIsNeverCarried(t *testing.T) {
	home := t.TempDir()
	writeCodexAuth(t, home, `{"tokens":{"access_token":"`+jwtWithExp(t, time.Now().Add(time.Hour))+
		`","refresh_token":"rt-super-secret","account_id":"a"}}`)

	got, err := loadCodexFrom(home)
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if got.Token == "rt-super-secret" || got.AccountID == "rt-super-secret" {
		t.Fatal("refresh token leaked into the credential")
	}
	if s := got.String(); s == "" {
		t.Fatal("String() should describe the credential")
	} else if containsAny(s, "rt-super-secret", got.Token) {
		t.Errorf("String() leaks token material: %q", s)
	}
}

func containsAny(haystack string, needles ...string) bool {
	for _, n := range needles {
		if n == "" {
			continue
		}
		if len(n) > 0 && len(haystack) >= len(n) {
			for i := 0; i+len(n) <= len(haystack); i++ {
				if haystack[i:i+len(n)] == n {
					return true
				}
			}
		}
	}
	return false
}
