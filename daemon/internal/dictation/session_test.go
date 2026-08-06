package dictation

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"nhooyr.io/websocket"
)

// fakeEndpoint is a websocket server standing in for a speech provider. The
// test drives what it sends; it records what it received.
type fakeEndpoint struct {
	srv *httptest.Server

	mu       sync.Mutex
	gotAudio [][]byte
	gotText  []string
	reqHdr   http.Header
	reqURL   string

	send   chan string   // frames for the server to write
	opened chan struct{} // closed once a client connects
	once   sync.Once
}

func newFakeEndpoint(t *testing.T) *fakeEndpoint {
	t.Helper()
	f := &fakeEndpoint{send: make(chan string, 16), opened: make(chan struct{})}
	f.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.mu.Lock()
		f.reqHdr = r.Header.Clone()
		f.reqURL = r.URL.String()
		f.mu.Unlock()

		c, err := websocket.Accept(w, r, &websocket.AcceptOptions{InsecureSkipVerify: true})
		if err != nil {
			return
		}
		defer c.Close(websocket.StatusNormalClosure, "")
		f.once.Do(func() { close(f.opened) })

		ctx, cancel := context.WithCancel(r.Context())
		defer cancel()

		go func() {
			for {
				select {
				case <-ctx.Done():
					return
				case msg, ok := <-f.send:
					if !ok {
						return
					}
					if err := c.Write(ctx, websocket.MessageText, []byte(msg)); err != nil {
						return
					}
				}
			}
		}()

		for {
			mt, data, err := c.Read(ctx)
			if err != nil {
				return
			}
			f.mu.Lock()
			if mt == websocket.MessageBinary {
				f.gotAudio = append(f.gotAudio, append([]byte(nil), data...))
			} else {
				f.gotText = append(f.gotText, string(data))
			}
			f.mu.Unlock()
		}
	}))
	t.Cleanup(f.srv.Close)
	return f
}

func (f *fakeEndpoint) base() string { return "ws" + strings.TrimPrefix(f.srv.URL, "http") }

func (f *fakeEndpoint) audioFrames() [][]byte {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([][]byte(nil), f.gotAudio...)
}

func (f *fakeEndpoint) textFrames() []string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]string(nil), f.gotText...)
}

func (f *fakeEndpoint) header(k string) string {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.reqHdr.Get(k)
}

type record struct {
	mu       sync.Mutex
	partials []string
	finals   []string
	errs     []string
}

func (r *record) handlers() Handlers {
	return Handlers{
		OnPartial: func(s string) { r.mu.Lock(); r.partials = append(r.partials, s); r.mu.Unlock() },
		OnFinal:   func(s string) { r.mu.Lock(); r.finals = append(r.finals, s); r.mu.Unlock() },
		OnError:   func(s string) { r.mu.Lock(); r.errs = append(r.errs, s); r.mu.Unlock() },
		OnDebug:   func(string) {},
	}
}

func (r *record) snapshot() (partials, finals, errs []string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.partials...), append([]string(nil), r.finals...), append([]string(nil), r.errs...)
}

// waitFor polls until cond holds or the deadline passes.
func waitFor(t *testing.T, why string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if cond() {
			return
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatalf("timed out waiting for %s", why)
}

func TestSessionStreamsAudioAndSurfacesTranscripts(t *testing.T) {
	f := newFakeEndpoint(t)
	rec := &record{}

	s, err := Dial(context.Background(), ProviderClaude,
		Credential{Token: "tok"}, Config{SampleRate: 16000}, f.base(), rec.handlers())
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	<-f.opened

	if got := f.header("Authorization"); got != "Bearer tok" {
		t.Errorf("Authorization = %q", got)
	}

	if err := s.SendAudio(context.Background(), pcm(1, 2, 3, 4)); err != nil {
		t.Fatalf("send: %v", err)
	}
	waitFor(t, "audio frame to arrive", func() bool { return len(f.audioFrames()) == 1 })

	f.send <- `{"type":"TranscriptInterim","data":"hello"}`
	waitFor(t, "partial", func() bool { p, _, _ := rec.snapshot(); return len(p) == 1 })

	f.send <- `{"type":"TranscriptText","data":"hello world"}`
	f.send <- `{"type":"TranscriptEndpoint"}`
	waitFor(t, "final promoted at the endpoint", func() bool { _, fin, _ := rec.snapshot(); return len(fin) == 1 })

	_, finals, errs := rec.snapshot()
	if finals[0] != "hello world" {
		t.Errorf("final = %q, want %q", finals[0], "hello world")
	}
	if len(errs) != 0 {
		t.Errorf("unexpected errors: %v", errs)
	}
	s.Close()
}

// The last words of an utterance must survive a stop that arrives before the
// provider sent a final — the failure this whole flush dance exists to stop.
func TestSessionPromotesPendingPartialOnClose(t *testing.T) {
	f := newFakeEndpoint(t)
	rec := &record{}

	s, err := Dial(context.Background(), ProviderClaude,
		Credential{Token: "t"}, Config{SampleRate: 16000}, f.base(), rec.handlers())
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	<-f.opened

	_ = s.SendAudio(context.Background(), pcm(1, 2))
	f.send <- `{"type":"TranscriptInterim","data":"unfinished thought"}`
	waitFor(t, "partial", func() bool { p, _, _ := rec.snapshot(); return len(p) == 1 })

	s.Close() // provider never sent a final

	_, finals, _ := rec.snapshot()
	if len(finals) != 1 || finals[0] != "unfinished thought" {
		t.Fatalf("finals = %v, want the pending partial promoted", finals)
	}
}

func TestSessionSendsCloseStreamOnClose(t *testing.T) {
	f := newFakeEndpoint(t)
	rec := &record{}

	s, err := Dial(context.Background(), ProviderClaude,
		Credential{Token: "t"}, Config{SampleRate: 16000}, f.base(), rec.handlers())
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	<-f.opened
	_ = s.SendAudio(context.Background(), pcm(1, 2))
	f.send <- `{"type":"TranscriptText","data":"x"}`
	waitFor(t, "partial", func() bool { p, _, _ := rec.snapshot(); return len(p) == 1 })

	s.Close()

	var sawKeepAlive, sawClose bool
	for _, m := range f.textFrames() {
		if strings.Contains(m, "KeepAlive") {
			sawKeepAlive = true
		}
		if strings.Contains(m, "CloseStream") {
			sawClose = true
		}
	}
	if !sawKeepAlive {
		t.Error("no KeepAlive was sent — Deepgram drops idle streams")
	}
	if !sawClose {
		t.Error("no CloseStream was sent — trailing finals would be lost")
	}
}

// Closing twice must not panic or double-report.
func TestSessionCloseIsIdempotent(t *testing.T) {
	f := newFakeEndpoint(t)
	rec := &record{}
	s, err := Dial(context.Background(), ProviderClaude,
		Credential{Token: "t"}, Config{SampleRate: 16000}, f.base(), rec.handlers())
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	<-f.opened
	s.Close()
	s.Close()
}

// SendAudio after Close is a no-op, not an error: frames are already in
// flight from the satellite when the user releases the key.
func TestSendAudioAfterCloseIsIgnored(t *testing.T) {
	f := newFakeEndpoint(t)
	rec := &record{}
	s, err := Dial(context.Background(), ProviderClaude,
		Credential{Token: "t"}, Config{SampleRate: 16000}, f.base(), rec.handlers())
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	<-f.opened
	s.Close()
	if err := s.SendAudio(context.Background(), pcm(9, 9)); err != nil {
		t.Fatalf("SendAudio after Close should be a no-op, got %v", err)
	}
}

func TestCodexSessionSendsHelloThenBase64Audio(t *testing.T) {
	f := newFakeEndpoint(t)
	rec := &record{}

	s, err := Dial(context.Background(), ProviderCodex,
		Credential{Token: "jwt", AccountID: "acct"}, Config{SampleRate: 16000}, f.base(), rec.handlers())
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	<-f.opened

	if got := f.header("chatgpt-account-id"); got != "acct" {
		t.Errorf("chatgpt-account-id = %q", got)
	}
	waitFor(t, "session.update", func() bool {
		for _, m := range f.textFrames() {
			if strings.Contains(m, `"session.update"`) {
				return true
			}
		}
		return false
	})

	_ = s.SendAudio(context.Background(), pcm(make([]int16, 160)...))
	waitFor(t, "audio append", func() bool {
		for _, m := range f.textFrames() {
			if strings.Contains(m, "input_audio_buffer.append") {
				return true
			}
		}
		return false
	})
	// Audio rides inside JSON here, never as a binary frame.
	if n := len(f.audioFrames()); n != 0 {
		t.Errorf("got %d binary frames; codex audio must be base64 in JSON", n)
	}
	s.Close()
}

func TestDialRejectsUnknownProvider(t *testing.T) {
	_, err := Dial(context.Background(), Provider("deepgram"),
		Credential{Token: "t"}, Config{}, "ws://127.0.0.1:1", Handlers{})
	if err == nil || !strings.Contains(err.Error(), "unknown provider") {
		t.Fatalf("err = %v, want an unknown-provider error", err)
	}
}
