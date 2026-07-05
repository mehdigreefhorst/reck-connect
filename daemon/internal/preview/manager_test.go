package preview

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func must(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatalf("test setup failed: %v", err)
	}
}

// writeReadyRunner writes a tiny shell "runner" that prints the machine-readable
// READY line (so the manager can parse host/port) and then blocks, imitating a
// long-lived dev server.
func writeReadyRunner(t *testing.T, port string) string {
	t.Helper()
	dir := t.TempDir()
	p := filepath.Join(dir, "r.sh")
	must(t, os.WriteFile(p, []byte("#!/bin/sh\necho \"RECK_PREVIEW_READY host=127.0.0.1 port="+port+"\"\nsleep 30\n"), 0o755))
	return p
}

// writeSilentRunner never prints READY; it just blocks. Used to exercise the
// readiness timeout path.
func writeSilentRunner(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	p := filepath.Join(dir, "s.sh")
	must(t, os.WriteFile(p, []byte("#!/bin/sh\nsleep 30\n"), 0o755))
	return p
}

func TestStartParsesPortAndReuses(t *testing.T) {
	m := newManagerForTest("/bin/sh", writeReadyRunner(t, "43111"))
	defer m.Shutdown()
	ctx := context.Background()

	st, err := m.Start(ctx, "p1", t.TempDir(), "")
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if !st.Ready {
		t.Fatalf("expected ready status, got %+v", st)
	}
	if st.Port != 43111 {
		t.Fatalf("expected port 43111, got %d", st.Port)
	}

	// Second Start for the same project must reuse the child (no new spawn).
	st2, err := m.Start(ctx, "p1", t.TempDir(), "")
	if err != nil {
		t.Fatalf("Start (reuse): %v", err)
	}
	if st2.Port != 43111 {
		t.Fatalf("expected reused port 43111, got %d", st2.Port)
	}
	if n := m.spawns(); n != 1 {
		t.Fatalf("expected exactly 1 spawn (proves reuse), got %d", n)
	}
	if !m.Status("p1").Running {
		t.Fatalf("expected p1 to be running")
	}

	m.Shutdown()
	time.Sleep(100 * time.Millisecond)
	if m.Status("p1").Running {
		t.Fatalf("expected p1 to be stopped after Shutdown")
	}
}

func TestStartTimeoutOnSilentRunner(t *testing.T) {
	m := newManagerForTest("/bin/sh", writeSilentRunner(t))
	m.readyTimeout = 300 * time.Millisecond
	defer m.Shutdown()

	_, err := m.Start(context.Background(), "p1", t.TempDir(), "")
	if err == nil {
		t.Fatalf("expected a timeout error from a silent runner, got nil")
	}
}

func TestIdleReaperStopsAfterTimeout(t *testing.T) {
	m := newManagerForTest("/bin/sh", writeReadyRunner(t, "43222"))
	m.idleTimeout = 300 * time.Millisecond
	m.reapInterval = 50 * time.Millisecond
	defer m.Shutdown()

	st, err := m.Start(context.Background(), "p", t.TempDir(), "")
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if !st.Ready {
		t.Fatalf("expected ready status, got %+v", st)
	}

	// Never touch Status: the entry should go idle and be reaped.
	time.Sleep(600 * time.Millisecond)
	if m.Status("p").Running {
		t.Fatalf("expected p to be reaped after the idle timeout")
	}
}
