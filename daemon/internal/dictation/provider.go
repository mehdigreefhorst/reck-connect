package dictation

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"nhooyr.io/websocket"
)

// Provider names a speech backend. These strings cross the wire to the
// satellite, so they are part of the protocol.
type Provider string

const (
	// ProviderClaude is Anthropic's speech endpoint, authenticated with the
	// Claude Code OAuth token.
	ProviderClaude Provider = "claude"
	// ProviderCodex is the OpenAI realtime API, authenticated with Codex's
	// ChatGPT token or its OPENAI_API_KEY.
	ProviderCodex Provider = "codex"
)

// ValidProvider reports whether p is one this daemon can serve.
func ValidProvider(p Provider) bool {
	return p == ProviderClaude || p == ProviderCodex
}

// Config is the per-session audio contract agreed with the satellite.
type Config struct {
	// SampleRate of the PCM16 frames the satellite will send. The satellite
	// captures at 16 kHz; providers that want another rate resample.
	SampleRate int
	// Language is an ISO code, or empty for the provider's default.
	Language string
}

// Handlers receive transcript activity. Every callback may be nil, and all
// are invoked from the session's read goroutine — never concurrently with
// each other, so implementations need no locking of their own.
type Handlers struct {
	OnPartial func(text string)
	OnFinal   func(text string)
	OnError   func(message string)
	OnDebug   func(message string)
}

func (h Handlers) partial(s string) {
	if h.OnPartial != nil && s != "" {
		h.OnPartial(s)
	}
}
func (h Handlers) final(s string) {
	if h.OnFinal != nil && s != "" {
		h.OnFinal(s)
	}
}
func (h Handlers) fail(s string) {
	if h.OnError != nil && s != "" {
		h.OnError(s)
	}
}
func (h Handlers) debug(format string, args ...any) {
	if h.OnDebug != nil {
		h.OnDebug(fmt.Sprintf(format, args...))
	}
}

// event is one decoded message from a provider.
type event struct {
	Text  string
	Final bool
	Err   string
	// Endpoint marks a provider-signalled utterance boundary carrying no
	// text of its own; the session promotes any pending partial on it.
	Endpoint bool
}

// protocol is the per-provider half of a session: how to address it, how to
// frame audio, and how to read its replies. Everything else — the send/read
// loops, keepalive, and the flush-on-close discipline — is shared.
type protocol interface {
	// url returns the full websocket URL for base (scheme wss/ws).
	url(base string, cfg Config) string
	// headers returns the request headers, including authorization.
	headers(cred Credential) http.Header
	// hello is sent once the socket opens, or nil when nothing is needed.
	hello(cfg Config) (websocket.MessageType, []byte, bool)
	// encodeAudio frames one PCM16 chunk for the wire.
	encodeAudio(pcm []byte, cfg Config) (websocket.MessageType, []byte)
	// decode turns one inbound message into an event. ok=false means
	// "recognised but uninteresting" — an unknown type is never an error,
	// because these schemas grow without notice.
	decode(raw []byte) (ev event, ok bool)
	// keepAlive returns a periodic frame and its interval; interval 0
	// disables keepalive.
	keepAlive() (websocket.MessageType, []byte, time.Duration)
	// goodbye is the end-of-stream frame, if the provider has one.
	goodbye() (websocket.MessageType, []byte, bool)
}

// flushTimeouts bound how long Close waits for trailing finals after the
// end-of-stream frame. Mirrors what Claude Code does with the same endpoint:
// give up quickly when nothing is arriving, but never hang.
var flushTimeouts = struct{ noData, safety time.Duration }{
	noData: 1500 * time.Millisecond,
	safety: 5 * time.Second,
}

// Session is a live speech stream. Safe for concurrent SendAudio and Close.
type Session struct {
	conn  *websocket.Conn
	proto protocol
	cfg   Config
	h     Handlers

	mu       sync.Mutex
	closed   bool
	closing  bool
	lastText string // pending partial, promoted if the stream ends without a final

	sawResult bool
	frames    int

	cancel  context.CancelFunc
	done    chan struct{}
	dataSig chan struct{} // pinged on every inbound message
}

// Dial opens a session against a provider. baseURL overrides the provider's
// default host (tests point it at a local server); empty uses the default.
func Dial(ctx context.Context, p Provider, cred Credential, cfg Config, base string, h Handlers) (*Session, error) {
	var proto protocol
	switch p {
	case ProviderClaude:
		proto = claudeProtocol{}
	case ProviderCodex:
		// Pointer: this protocol accumulates transcript deltas per session.
		proto = &codexProtocol{}
	default:
		return nil, fmt.Errorf("dictation: unknown provider %q", p)
	}
	if cfg.SampleRate <= 0 {
		cfg.SampleRate = 16000
	}
	if base == "" {
		base = defaultBase(p)
	} else if err := validateBase(base); err != nil {
		return nil, err
	}

	dialCtx, cancelDial := context.WithTimeout(ctx, 15*time.Second)
	defer cancelDial()

	conn, resp, err := websocket.Dial(dialCtx, proto.url(base, cfg), &websocket.DialOptions{
		HTTPHeader: proto.headers(cred),
	})
	if err != nil {
		return nil, dialError(p, resp, err)
	}
	// Transcripts of a long utterance can exceed the 32 KiB default.
	conn.SetReadLimit(1 << 20)

	runCtx, cancel := context.WithCancel(context.WithoutCancel(ctx))
	s := &Session{
		conn: conn, proto: proto, cfg: cfg, h: h,
		cancel: cancel, done: make(chan struct{}), dataSig: make(chan struct{}, 1),
	}

	if mt, payload, ok := proto.hello(cfg); ok {
		if err := conn.Write(runCtx, mt, payload); err != nil {
			cancel()
			_ = conn.Close(websocket.StatusInternalError, "hello failed")
			return nil, fmt.Errorf("dictation: session setup failed: %w", err)
		}
	}

	go s.readLoop(runCtx)
	if mt, payload, every := proto.keepAlive(); every > 0 {
		go s.keepAliveLoop(runCtx, mt, payload, every)
	}
	h.debug("dictation: %s session open @ %d Hz", p, cfg.SampleRate)
	return s, nil
}

func defaultBase(p Provider) string {
	if p == ProviderClaude {
		return "wss://api.anthropic.com"
	}
	return "wss://api.openai.com"
}

// validateBase refuses a base override that would send the user's real
// subscription bearer anywhere except an encrypted endpoint or a loopback
// test server. The override is a test seam today; this keeps a future
// config/env wiring from becoming a one-line credential-exfil primitive
// (or a cleartext ws:// token leak).
func validateBase(base string) error {
	u, err := url.Parse(base)
	if err != nil {
		return fmt.Errorf("dictation: invalid provider base %q: %w", base, err)
	}
	if u.Scheme == "wss" {
		return nil
	}
	if u.Scheme == "ws" {
		host := u.Hostname()
		if host == "localhost" {
			return nil
		}
		if ip := net.ParseIP(host); ip != nil && ip.IsLoopback() {
			return nil
		}
	}
	return fmt.Errorf("dictation: refusing to send credentials to %q (want wss://, or ws:// to loopback)", base)
}

// dialError turns a failed upgrade into something a user can act on. The
// two interesting cases are an expired/absent credential (401/403) and the
// endpoint refusing us outright, which for Claude would mean the internal
// endpoint has started gating on client identity.
func dialError(p Provider, resp *http.Response, err error) error {
	if resp == nil {
		return fmt.Errorf("dictation: could not reach the %s speech endpoint: %w", p, err)
	}
	switch resp.StatusCode {
	case http.StatusUnauthorized, http.StatusForbidden:
		who := "Claude Code"
		if p == ProviderCodex {
			who = "Codex"
		}
		return fmt.Errorf("dictation: %s rejected the %s credential (HTTP %d) — "+
			"run %s once to refresh it", p, who, resp.StatusCode, strings.ToLower(who))
	case http.StatusTooManyRequests:
		return fmt.Errorf("dictation: %s rate-limited the speech stream (HTTP 429)", p)
	}
	return fmt.Errorf("dictation: %s refused the speech stream (HTTP %d): %w", p, resp.StatusCode, err)
}

// SendAudio streams one mono PCM16 little-endian frame.
func (s *Session) SendAudio(ctx context.Context, pcm []byte) error {
	s.mu.Lock()
	if s.closed || s.closing {
		s.mu.Unlock()
		return nil // stopping: drop rather than error
	}
	s.frames++
	s.mu.Unlock()

	mt, payload := s.proto.encodeAudio(pcm, s.cfg)
	if len(payload) == 0 {
		return nil
	}
	writeCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if err := s.conn.Write(writeCtx, mt, payload); err != nil {
		return fmt.Errorf("dictation: sending audio: %w", err)
	}
	return nil
}

// Close signals end-of-stream, waits briefly for trailing finals, then tears
// the socket down. Any partial that never got a final is promoted first, so
// the last words of an utterance are never silently dropped — the failure
// mode Claude Code guards against with the same two timeouts.
func (s *Session) Close() {
	s.mu.Lock()
	if s.closing || s.closed {
		s.mu.Unlock()
		return
	}
	s.closing = true
	frames := s.frames
	s.mu.Unlock()

	if mt, payload, ok := s.proto.goodbye(); ok {
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		_ = s.conn.Write(ctx, mt, payload)
		cancel()
		s.waitForFlush()
	}

	s.promotePending()

	s.mu.Lock()
	s.closed = true
	sawResult := s.sawResult
	s.mu.Unlock()

	s.cancel()
	_ = s.conn.Close(websocket.StatusNormalClosure, "")
	<-s.done

	s.h.debug("dictation: session closed after %d frames (transcript=%v)", frames, sawResult)
	if !sawResult && frames > 0 {
		s.h.fail("The speech stream ended without producing any transcript.")
	}
}

// waitForFlush blocks until the provider stops sending, or the safety bound
// elapses. "Stops sending" means noData quiet after the last message.
func (s *Session) waitForFlush() {
	safety := time.NewTimer(flushTimeouts.safety)
	defer safety.Stop()
	idle := time.NewTimer(flushTimeouts.noData)
	defer idle.Stop()

	for {
		select {
		case <-safety.C:
			return
		case <-idle.C:
			return
		case <-s.done:
			return
		case <-s.dataSig:
			if !idle.Stop() {
				select {
				case <-idle.C:
				default:
				}
			}
			idle.Reset(flushTimeouts.noData)
		}
	}
}

// promotePending turns an unreported partial into a final.
func (s *Session) promotePending() {
	s.mu.Lock()
	text := s.lastText
	s.lastText = ""
	s.mu.Unlock()
	if text != "" {
		s.h.debug("dictation: promoting unreported partial to final")
		s.h.final(text)
	}
}

func (s *Session) keepAliveLoop(ctx context.Context, mt websocket.MessageType, payload []byte, every time.Duration) {
	// Send one immediately: some endpoints start their idle clock at open.
	writeCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	_ = s.conn.Write(writeCtx, mt, payload)
	cancel()

	t := time.NewTicker(every)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-t.C:
			s.mu.Lock()
			stop := s.closed || s.closing
			s.mu.Unlock()
			if stop {
				return
			}
			c, cancel := context.WithTimeout(ctx, 5*time.Second)
			_ = s.conn.Write(c, mt, payload)
			cancel()
		}
	}
}

func (s *Session) readLoop(ctx context.Context) {
	defer close(s.done)
	for {
		_, raw, err := s.conn.Read(ctx)
		if err != nil {
			s.onReadError(err)
			return
		}
		s.signalData()

		ev, ok := s.proto.decode(raw)
		if !ok {
			continue
		}
		switch {
		case ev.Err != "":
			s.h.fail(ev.Err)
		case ev.Endpoint:
			s.promotePending()
		case ev.Final:
			s.mu.Lock()
			s.lastText = ""
			s.sawResult = true
			s.mu.Unlock()
			s.h.final(ev.Text)
		default:
			s.mu.Lock()
			s.lastText = ev.Text
			s.sawResult = true
			s.mu.Unlock()
			s.h.partial(ev.Text)
		}
	}
}

// onReadError reports only unexpected terminations. A close during our own
// teardown, or a normal close frame, is the expected end of a session.
func (s *Session) onReadError(err error) {
	s.mu.Lock()
	quiet := s.closing || s.closed
	s.mu.Unlock()
	if quiet || errors.Is(err, context.Canceled) {
		return
	}
	status := websocket.CloseStatus(err)
	if status == websocket.StatusNormalClosure || status == websocket.StatusGoingAway {
		return
	}
	s.h.fail(fmt.Sprintf("Speech stream closed unexpectedly: %v", err))
}

func (s *Session) signalData() {
	select {
	case s.dataSig <- struct{}{}:
	default:
	}
}
