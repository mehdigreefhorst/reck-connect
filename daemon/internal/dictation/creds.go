// Package dictation streams microphone audio from the satellite to a
// speech-to-text provider and returns transcripts.
//
// The point of doing this in the daemon rather than the satellite is
// credentials. Dictation's existing cloud path (Deepgram, in the satellite
// main process) needs the user to bring a separate paid API key. The agent
// CLIs we already run — Claude Code and Codex — hold subscription
// credentials that reach speech endpoints, and those credentials live on
// whichever machine runs the CLIs, which is the same machine that runs this
// daemon in both local and station mode. The satellite has the microphone;
// the station has the tokens; this package is the join.
//
// Credential discipline, identical to internal/usage's Claude reader: we
// READ these stores and never write them. Refreshing an expired token is the
// owning CLI's job. That keeps the daemon out of the auth business — no
// refresh-token handling, no clobbering a file another process owns — at the
// cost of a dictation attempt failing until the user next runs that CLI.
package dictation

import (
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/rudie-verweij/reck-connect/daemon/internal/usage"
)

// ErrNoCredentials means no usable credential was found for a provider.
// Callers turn this into a user-facing "sign in to X first", not a fault.
var ErrNoCredentials = errors.New("dictation: no credentials available")

// ErrTokenExpired means a credential was found but its token is past expiry
// and there is no usable fallback. The remedy is to run the owning CLI once.
var ErrTokenExpired = errors.New("dictation: access token expired")

// Credential is a bearer plus the routing facts that ride with it.
//
// Token is deliberately excluded from String() so a credential can be logged
// or wrapped into an error without leaking. Refresh tokens are never parsed
// out of either store, so they cannot reach this struct at all.
type Credential struct {
	Token string
	// AccountID is Codex's ChatGPT account, sent as the chatgpt-account-id
	// header. Empty for API keys and for Claude.
	AccountID string
	// IsAPIKey distinguishes a real OpenAI API key (metered, stable) from a
	// ChatGPT subscription token (free at point of use, but minted for Codex).
	IsAPIKey bool
}

// String describes the credential without revealing any of it.
func (c Credential) String() string {
	kind := "oauth"
	if c.IsAPIKey {
		kind = "api-key"
	}
	acct := "none"
	if c.AccountID != "" {
		acct = "set"
	}
	return fmt.Sprintf("Credential{kind:%s, len:%d, account:%s}", kind, len(c.Token), acct)
}

// LoadClaude returns the Claude Code OAuth token, reusing the reader the
// usage poller already ships (macOS keychain, or ~/.claude/.credentials.json
// on Linux). An expired token is refused here even though the usage package
// tolerates it: quota polling can degrade to stale subscription facts, but a
// speech stream needs a token the server will actually accept.
func LoadClaude() (Credential, error) {
	c, err := usage.LoadCredentials()
	switch {
	case errors.Is(err, usage.ErrTokenExpired):
		return Credential{}, ErrTokenExpired
	case err != nil:
		return Credential{}, ErrNoCredentials
	case c.Token == "":
		return Credential{}, ErrNoCredentials
	}
	return Credential{Token: c.Token}, nil
}

// LoadCodex returns a credential for OpenAI from ~/.codex/auth.json.
func LoadCodex() (Credential, error) { return loadCodexFrom("") }

// loadCodexFrom reads Codex's auth store. home may be empty to resolve the
// current user's home directory (tests pass a temp dir).
//
// Preference order is deliberate: a live ChatGPT token wins over an API key,
// because riding the subscription is the entire reason this path exists. An
// API key is the fallback — including when the ChatGPT token has expired,
// so a stale Codex login degrades to metered billing rather than to nothing.
func loadCodexFrom(home string) (Credential, error) {
	if home == "" {
		h, err := os.UserHomeDir()
		if err != nil || h == "" {
			return Credential{}, ErrNoCredentials
		}
		home = h
	}
	raw, err := os.ReadFile(filepath.Join(home, ".codex", "auth.json"))
	if err != nil {
		return Credential{}, ErrNoCredentials
	}
	return parseCodexAuth(raw)
}

// codexAuthWire mirrors only the fields we consume. refresh_token and
// id_token are present in the file and left unparsed on purpose.
type codexAuthWire struct {
	OpenAIAPIKey string `json:"OPENAI_API_KEY"`
	Tokens       *struct {
		AccessToken string `json:"access_token"`
		AccountID   string `json:"account_id"`
	} `json:"tokens"`
}

// parseCodexAuth extracts a usable credential. Kept pure and separate from
// the file read so the wire handling is unit-testable.
func parseCodexAuth(raw []byte) (Credential, error) {
	var w codexAuthWire
	if err := json.Unmarshal(raw, &w); err != nil {
		return Credential{}, ErrNoCredentials
	}

	apiKey := strings.TrimSpace(w.OpenAIAPIKey)
	tokenExpired := false

	if w.Tokens != nil {
		access := strings.TrimSpace(w.Tokens.AccessToken)
		if access != "" {
			if expired, known := jwtExpired(access, time.Now()); known && expired {
				tokenExpired = true
			} else {
				return Credential{
					Token:     access,
					AccountID: strings.TrimSpace(w.Tokens.AccountID),
				}, nil
			}
		}
	}

	if apiKey != "" {
		return Credential{Token: apiKey, IsAPIKey: true}, nil
	}
	if tokenExpired {
		return Credential{}, ErrTokenExpired
	}
	return Credential{}, ErrNoCredentials
}

// jwtExpired reports whether a JWT's `exp` claim is in the past. The second
// return is false when the token has no readable exp — an opaque token is
// treated as possibly-live rather than assumed dead, because guessing wrong
// in that direction costs a request while the other costs a working setup.
//
// The signature is not verified: we are not the audience, and the only use
// here is to turn a predictable 401 into an actionable message.
func jwtExpired(token string, now time.Time) (expired bool, known bool) {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return false, false
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return false, false
	}
	var claims struct {
		Exp int64 `json:"exp"`
	}
	if err := json.Unmarshal(payload, &claims); err != nil || claims.Exp == 0 {
		return false, false
	}
	return now.After(time.Unix(claims.Exp, 0)), true
}
