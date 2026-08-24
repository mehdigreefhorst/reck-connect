package http

// The satellite renderer reaches /dictation/stream with a browser WebSocket,
// which cannot set an Authorization header. These tests pin the two halves of
// that path: the auth middleware must accept the reck-bearer subprotocol on
// this route (not only on /ws/), and the 101 response must echo the offered
// subprotocol back — a browser fails the whole upgrade otherwise.

import (
	"context"
	"encoding/json"
	nethttp "net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"nhooyr.io/websocket"

	"github.com/rudie-verweij/reck-connect/daemon/internal/dictation"
	"github.com/rudie-verweij/reck-connect/proto"
)

func TestAuth_WSSubprotocolBearerOnDictationStream(t *testing.T) {
	t.Setenv("DAEMON_TOKEN", "main-secret")
	s := newServer(t)
	s.DictationCreds = stubCreds(map[dictation.Provider]credCase{
		dictation.ProviderClaude: {cred: dictation.Credential{Token: "tok"}},
	})
	// Bypass newTestHandler: this test asserts on subprotocol-only auth, so
	// the wrapper's Authorization-header injection would mask the 401 paths.
	srv := httptest.NewServer(s.Router())
	defer srv.Close()

	// Valid subprotocol → past the middleware. The plain GET then fails the
	// upgrade (no Upgrade header), but the status must NOT be 401.
	req, _ := nethttp.NewRequest("GET", srv.URL+"/dictation/stream?provider=claude", nil)
	req.Header.Set("Sec-WebSocket-Protocol", "reck-bearer.main-secret")
	resp, err := nethttp.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode == nethttp.StatusUnauthorized {
		t.Errorf("valid subprotocol bearer on /dictation/stream: got 401, should pass auth")
	}

	// Wrong token in subprotocol → 401.
	req, _ = nethttp.NewRequest("GET", srv.URL+"/dictation/stream?provider=claude", nil)
	req.Header.Set("Sec-WebSocket-Protocol", "reck-bearer.WRONG")
	resp, err = nethttp.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != nethttp.StatusUnauthorized {
		t.Errorf("wrong subprotocol bearer: got %d, want 401", resp.StatusCode)
	}
}

// fakeProviderServer accepts any WebSocket upgrade and swallows whatever
// arrives, standing in for a speech endpoint so no test touches the network.
func fakeProviderServer(t *testing.T) *httptest.Server {
	t.Helper()
	srv := httptest.NewServer(nethttp.HandlerFunc(func(w nethttp.ResponseWriter, r *nethttp.Request) {
		conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
		if err != nil {
			return
		}
		defer conn.Close(websocket.StatusNormalClosure, "")
		for {
			if _, _, err := conn.Read(r.Context()); err != nil {
				return
			}
		}
	}))
	t.Cleanup(srv.Close)
	return srv
}

func TestDictationStreamEchoesSubprotocol(t *testing.T) {
	t.Setenv("DAEMON_TOKEN", "main-secret")
	s := newServer(t)
	s.DictationCreds = stubCreds(map[dictation.Provider]credCase{
		dictation.ProviderClaude: {cred: dictation.Credential{Token: "tok"}},
	})
	provider := fakeProviderServer(t)
	s.DictationBase = strings.Replace(provider.URL, "http", "ws", 1)
	srv := httptest.NewServer(s.Router())
	defer srv.Close()

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	url := strings.Replace(srv.URL, "http", "ws", 1) + "/dictation/stream?provider=claude"
	conn, _, err := websocket.Dial(ctx, url, &websocket.DialOptions{
		Subprotocols: []string{"reck-bearer.main-secret"},
	})
	if err != nil {
		t.Fatalf("upgrade with subprotocol bearer failed: %v", err)
	}
	defer conn.Close(websocket.StatusNormalClosure, "")

	if got := conn.Subprotocol(); got != "reck-bearer.main-secret" {
		t.Errorf("negotiated subprotocol = %q, want the offered bearer subprotocol echoed", got)
	}

	// The handler reports readiness once the provider session is up. Debug
	// events may precede it; anything else before ready is a fault.
	for {
		_, raw, err := conn.Read(ctx)
		if err != nil {
			t.Fatalf("reading events before ready: %v", err)
		}
		var ev proto.DictationStreamEvent
		if err := json.Unmarshal(raw, &ev); err != nil {
			t.Fatalf("decoding event %q: %v", raw, err)
		}
		if ev.Kind == "debug" {
			continue
		}
		if ev.Kind != "ready" {
			t.Errorf("event before ready = %q (%q)", ev.Kind, ev.Text)
		}
		break
	}
}
