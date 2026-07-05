package http

// Tests for the component-preview lifecycle routes:
//
//	POST   /projects/{id}/preview  → start (or reuse) the dev server
//	GET    /projects/{id}/preview  → current status
//	DELETE /projects/{id}/preview  → stop the dev server
//
// The handlers are exercised against a hermetic stubPreview so no real
// Node runner is ever spawned — the real *preview.Manager is covered by
// the preview package's own tests (Task 5) and its wiring by Task 7.

import (
	"context"
	"encoding/json"
	"io"
	nethttp "net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"

	"github.com/rudie-verweij/reck-connect/proto"
)

// stubPreview implements previewController without touching the filesystem
// or spawning a child. It returns a canned status from Start/Status and
// records every call so tests can assert the handler wired arguments
// through faithfully.
type stubPreview struct {
	mu sync.Mutex

	canned proto.PreviewStatus

	startCalled  bool
	startProject string
	startCwd     string
	startHmrHost string
	startErr     error

	statusCalled  bool
	statusProject string

	stopCalled  bool
	stopProject string
	stopErr     error
}

func (s *stubPreview) Start(_ context.Context, projectID, cwd, hmrHost string) (proto.PreviewStatus, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.startCalled = true
	s.startProject = projectID
	s.startCwd = cwd
	s.startHmrHost = hmrHost
	return s.canned, s.startErr
}

func (s *stubPreview) Status(projectID string) proto.PreviewStatus {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.statusCalled = true
	s.statusProject = projectID
	return s.canned
}

func (s *stubPreview) Stop(projectID string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.stopCalled = true
	s.stopProject = projectID
	return s.stopErr
}

// cannedPreviewStatus is the "running, ready, port 43000" state every
// stub reports by default — matches the brief's fixture.
func cannedPreviewStatus() proto.PreviewStatus {
	return proto.PreviewStatus{Running: true, Ready: true, Port: 43000}
}

// newServerWithPreview builds the standard fixture server, attaches a
// stubPreview, and returns the project "p1"'s resolved cwd so tests can
// assert the handler forwarded it into Start.
func newServerWithPreview(t *testing.T) (*Server, *stubPreview, string) {
	t.Helper()
	s := newServer(t)
	stub := &stubPreview{canned: cannedPreviewStatus()}
	s.Preview = stub
	detail, ok := s.Manager.ProjectDetail("p1")
	if !ok {
		t.Fatal("fixture project p1 missing")
	}
	return s, stub, detail.Cwd
}

// doPreview issues an authed request against /projects/{project}/preview.
// An empty body sends no request body at all (ContentLength 0) so the
// empty-body → hmr_host:"" path is exercised.
func doPreview(t *testing.T, base, method, project, body string) (*nethttp.Response, string) {
	t.Helper()
	var rdr io.Reader
	if body != "" {
		rdr = strings.NewReader(body)
	}
	req, err := nethttp.NewRequest(method, base+"/projects/"+project+"/preview", rdr)
	if err != nil {
		t.Fatal(err)
	}
	resp, err := nethttp.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	b, err := io.ReadAll(resp.Body)
	resp.Body.Close()
	if err != nil {
		t.Fatal(err)
	}
	return resp, string(b)
}

func TestPreview_startReturnsStatusAndWiresArgs(t *testing.T) {
	s, stub, cwd := newServerWithPreview(t)
	srv := httptest.NewServer(newTestHandler(t, s))
	defer srv.Close()

	resp, body := doPreview(t, srv.URL, nethttp.MethodPost, "p1", `{"hmr_host":"station.tailnet"}`)
	if resp.StatusCode != nethttp.StatusOK {
		t.Fatalf("status = %d, want 200 (body %q)", resp.StatusCode, body)
	}
	var got proto.PreviewStatus
	if err := json.Unmarshal([]byte(body), &got); err != nil {
		t.Fatalf("decode body %q: %v", body, err)
	}
	if want := cannedPreviewStatus(); got != want {
		t.Fatalf("status = %+v, want %+v", got, want)
	}
	if !stub.startCalled {
		t.Fatal("Start was not called")
	}
	if stub.startProject != "p1" {
		t.Fatalf("Start projectID = %q, want p1", stub.startProject)
	}
	if stub.startCwd != cwd {
		t.Fatalf("Start cwd = %q, want %q", stub.startCwd, cwd)
	}
	if stub.startHmrHost != "station.tailnet" {
		t.Fatalf("Start hmrHost = %q, want station.tailnet", stub.startHmrHost)
	}
}

func TestPreview_startEmptyBodyIsTolerated(t *testing.T) {
	s, stub, _ := newServerWithPreview(t)
	srv := httptest.NewServer(newTestHandler(t, s))
	defer srv.Close()

	resp, body := doPreview(t, srv.URL, nethttp.MethodPost, "p1", "")
	if resp.StatusCode != nethttp.StatusOK {
		t.Fatalf("status = %d, want 200 (body %q)", resp.StatusCode, body)
	}
	if !stub.startCalled {
		t.Fatal("Start was not called")
	}
	if stub.startHmrHost != "" {
		t.Fatalf("Start hmrHost = %q, want empty on empty body", stub.startHmrHost)
	}
}

func TestPreview_startUnknownProjectIs404(t *testing.T) {
	s, stub, _ := newServerWithPreview(t)
	srv := httptest.NewServer(newTestHandler(t, s))
	defer srv.Close()

	resp, _ := doPreview(t, srv.URL, nethttp.MethodPost, "nope", `{"hmr_host":"x"}`)
	if resp.StatusCode != nethttp.StatusNotFound {
		t.Fatalf("status = %d, want 404", resp.StatusCode)
	}
	if stub.startCalled {
		t.Fatal("Start must not be called for an unknown project")
	}
}

func TestPreview_getReturnsStatus(t *testing.T) {
	s, stub, _ := newServerWithPreview(t)
	srv := httptest.NewServer(newTestHandler(t, s))
	defer srv.Close()

	resp, body := doPreview(t, srv.URL, nethttp.MethodGet, "p1", "")
	if resp.StatusCode != nethttp.StatusOK {
		t.Fatalf("status = %d, want 200 (body %q)", resp.StatusCode, body)
	}
	var got proto.PreviewStatus
	if err := json.Unmarshal([]byte(body), &got); err != nil {
		t.Fatalf("decode body %q: %v", body, err)
	}
	if want := cannedPreviewStatus(); got != want {
		t.Fatalf("status = %+v, want %+v", got, want)
	}
	if !stub.statusCalled || stub.statusProject != "p1" {
		t.Fatalf("Status called=%v project=%q, want true/p1", stub.statusCalled, stub.statusProject)
	}
}

func TestPreview_getUnknownProjectIs404(t *testing.T) {
	s, _, _ := newServerWithPreview(t)
	srv := httptest.NewServer(newTestHandler(t, s))
	defer srv.Close()

	resp, _ := doPreview(t, srv.URL, nethttp.MethodGet, "nope", "")
	if resp.StatusCode != nethttp.StatusNotFound {
		t.Fatalf("status = %d, want 404", resp.StatusCode)
	}
}

func TestPreview_deleteStopsAndReturns204(t *testing.T) {
	s, stub, _ := newServerWithPreview(t)
	srv := httptest.NewServer(newTestHandler(t, s))
	defer srv.Close()

	resp, body := doPreview(t, srv.URL, nethttp.MethodDelete, "p1", "")
	if resp.StatusCode != nethttp.StatusNoContent {
		t.Fatalf("status = %d, want 204 (body %q)", resp.StatusCode, body)
	}
	if body != "" {
		t.Fatalf("204 body = %q, want empty", body)
	}
	if !stub.stopCalled || stub.stopProject != "p1" {
		t.Fatalf("Stop called=%v project=%q, want true/p1", stub.stopCalled, stub.stopProject)
	}
}

func TestPreview_deleteUnknownProjectIs404(t *testing.T) {
	s, stub, _ := newServerWithPreview(t)
	srv := httptest.NewServer(newTestHandler(t, s))
	defer srv.Close()

	resp, _ := doPreview(t, srv.URL, nethttp.MethodDelete, "nope", "")
	if resp.StatusCode != nethttp.StatusNotFound {
		t.Fatalf("status = %d, want 404", resp.StatusCode)
	}
	if stub.stopCalled {
		t.Fatal("Stop must not be called for an unknown project")
	}
}

// The three routes must live inside the same bearer-authed group as
// /projects/{id}/panes: a request without a bearer is rejected before any
// handler runs. Bypass newTestHandler (which would inject a bearer) and
// hit s.Router() directly, exactly like TestAuth_tokenRequired.
func TestPreview_requiresBearer(t *testing.T) {
	t.Setenv("DAEMON_TOKEN", "secret")
	s, _, _ := newServerWithPreview(t)
	srv := httptest.NewServer(s.Router())
	defer srv.Close()

	for _, method := range []string{nethttp.MethodPost, nethttp.MethodGet, nethttp.MethodDelete} {
		req, err := nethttp.NewRequest(method, srv.URL+"/projects/p1/preview", nil)
		if err != nil {
			t.Fatal(err)
		}
		resp, err := nethttp.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		resp.Body.Close()
		if resp.StatusCode != nethttp.StatusUnauthorized {
			t.Fatalf("%s without bearer: status = %d, want 401", method, resp.StatusCode)
		}
	}
}

// When previews are disabled (s.Preview == nil) every route answers 503
// with a PreviewStatus carrying the reason, so the satellite can toast it.
func TestPreview_nilControllerIs503(t *testing.T) {
	s := newServer(t) // no Preview attached
	srv := httptest.NewServer(newTestHandler(t, s))
	defer srv.Close()

	for _, method := range []string{nethttp.MethodPost, nethttp.MethodGet, nethttp.MethodDelete} {
		resp, body := doPreview(t, srv.URL, method, "p1", "")
		if resp.StatusCode != nethttp.StatusServiceUnavailable {
			t.Fatalf("%s with nil Preview: status = %d, want 503 (body %q)", method, resp.StatusCode, body)
		}
		var got proto.PreviewStatus
		if err := json.Unmarshal([]byte(body), &got); err != nil {
			t.Fatalf("%s decode body %q: %v", method, body, err)
		}
		if got.Error != "preview unavailable" {
			t.Fatalf("%s error = %q, want \"preview unavailable\"", method, got.Error)
		}
	}
}
