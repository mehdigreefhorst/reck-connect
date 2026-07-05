package preview

import (
	"context"
	"os"
	"path/filepath"
	"sync"
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

// writeReadyThenExitRunner prints the READY line, stays alive just long enough
// for the manager's scanner to parse it, then exits. Used to prove the manager
// clears a dead child's registry entry (I2). The brief short delay avoids the
// inherent race between the scanner reading buffered READY and the supervising
// goroutine closing the read end of the pipe when the child exits.
func writeReadyThenExitRunner(t *testing.T, port string) string {
	t.Helper()
	dir := t.TempDir()
	p := filepath.Join(dir, "e.sh")
	must(t, os.WriteFile(p, []byte("#!/bin/sh\necho \"RECK_PREVIEW_READY host=127.0.0.1 port="+port+"\"\nsleep 0.2\nexit 0\n"), 0o755))
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

// TestConcurrentStartSpawnsOnce is the I1 regression test: N goroutines all
// calling Start on a FRESH project must result in exactly ONE spawned child
// (the rest observe the reserved in-flight slot and wait), and every caller
// must receive the same live port.
func TestConcurrentStartSpawnsOnce(t *testing.T) {
	m := newManagerForTest("/bin/sh", writeReadyRunner(t, "45123"))
	defer m.Shutdown()

	const n = 8
	cwd := t.TempDir()

	var wg sync.WaitGroup
	var mu sync.Mutex
	ports := make([]int, 0, n)
	errs := make([]error, 0, n)

	for i := 0; i < n; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			st, err := m.Start(context.Background(), "p", cwd, "")
			mu.Lock()
			ports = append(ports, st.Port)
			errs = append(errs, err)
			mu.Unlock()
		}()
	}
	wg.Wait()

	for i, err := range errs {
		if err != nil {
			t.Fatalf("Start #%d returned error: %v", i, err)
		}
	}
	for i, p := range ports {
		if p != 45123 {
			t.Fatalf("Start #%d returned port %d, want the single shared port 45123", i, p)
		}
	}
	if s := m.spawns(); s != 1 {
		t.Fatalf("expected exactly 1 spawn for %d concurrent first-Starts, got %d", n, s)
	}
}

// TestChildExitClearsEntry is the I2 regression test: once the runner child
// exits, its registry entry must be cleared so Status no longer reports it
// Running, and a subsequent Start respawns a fresh child instead of handing
// back the dead one.
func TestChildExitClearsEntry(t *testing.T) {
	m := newManagerForTest("/bin/sh", writeReadyThenExitRunner(t, "45999"))
	defer m.Shutdown()

	st, err := m.Start(context.Background(), "p", t.TempDir(), "")
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	if !st.Ready || st.Port != 45999 {
		t.Fatalf("expected ready on port 45999, got %+v", st)
	}
	if s := m.spawns(); s != 1 {
		t.Fatalf("expected 1 spawn, got %d", s)
	}

	// Give the child a moment to exit and the supervising goroutine to clear
	// the entry; poll Status briefly rather than sleeping a fixed amount.
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) && m.Status("p").Running {
		time.Sleep(20 * time.Millisecond)
	}
	if m.Status("p").Running {
		t.Fatalf("expected entry cleared after the child exited, but Status still reports Running")
	}

	// A subsequent Start must respawn (spawn count increments) rather than
	// return the dead child.
	st2, err := m.Start(context.Background(), "p", t.TempDir(), "")
	if err != nil {
		t.Fatalf("Start (respawn): %v", err)
	}
	if !st2.Ready || st2.Port != 45999 {
		t.Fatalf("expected respawn ready on port 45999, got %+v", st2)
	}
	if s := m.spawns(); s != 2 {
		t.Fatalf("expected 2 spawns after respawn of a dead child, got %d", s)
	}
}
