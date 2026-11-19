package pty

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/rudie-verweij/reck-connect/daemon/internal/config"
	"github.com/rudie-verweij/reck-connect/daemon/internal/sessions"
	"github.com/rudie-verweij/reck-connect/proto"
)

// Issue #176 (review): resuming a session that is already running in a
// live pane must be refused. A second `claude --resume` on the same
// transcript would have two processes appending to one JSONL — reachable
// when a stale "session ended" placeholder is clicked after the session
// came back by another route.
func TestCreatePaneWith_resume_refusedWhenSessionAlreadyLive(t *testing.T) {
	dir := t.TempDir()
	configPath := filepath.Join(dir, "projects.toml")
	if err := os.WriteFile(configPath, []byte(""), 0o600); err != nil {
		t.Fatal(err)
	}
	store, err := sessions.NewStore(filepath.Join(dir, "sessions"))
	if err != nil {
		t.Fatal(err)
	}
	// A "claude" that stays alive regardless of the flags appended to it.
	mgr := NewManager(
		[]config.Project{{ID: "p1", Name: "P1", Cwd: dir, Shell: []string{"/bin/sh"}}},
		[]string{"/bin/sh", "-c", "sleep 30", "--"},
		configPath,
		store,
	)
	live, err := mgr.CreatePane("p1", proto.PaneKindClaude, 80, 24)
	if err != nil {
		t.Fatal(err)
	}
	defer func() {
		_ = mgr.DeletePane("p1", live.ID)
		time.Sleep(50 * time.Millisecond)
	}()
	if live.SessionID == "" {
		t.Fatal("expected a SessionID on the live claude pane")
	}

	dup, err := mgr.CreatePaneWith("p1", proto.PaneKindClaude, 80, 24, CreatePaneOptions{ResumeSessionID: live.SessionID})
	if err == nil {
		_ = mgr.DeletePane("p1", dup.ID)
		t.Fatal("resume of an already-live session succeeded; want ErrSessionAlreadyLive")
	}
	if !errors.Is(err, ErrSessionAlreadyLive) {
		t.Fatalf("err = %v, want ErrSessionAlreadyLive", err)
	}
	if n := len(mgr.PanesInProject("p1")); n != 1 {
		t.Errorf("live panes = %d, want 1 (no duplicate spawned)", n)
	}
}
