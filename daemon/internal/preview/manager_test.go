package preview

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/rudie-verweij/reck-connect/proto"
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

// writeCwdRecordingRunner writes a runner that appends the --cwd value it was
// launched with (arg $2) to recordPath, then prints READY and blocks. It lets a
// test prove which Vite root each spawned child actually booted against.
func writeCwdRecordingRunner(t *testing.T, port, recordPath string) string {
	t.Helper()
	dir := t.TempDir()
	p := filepath.Join(dir, "c.sh")
	script := "#!/bin/sh\n" +
		"echo \"$2\" >> " + recordPath + "\n" +
		"echo \"RECK_PREVIEW_READY host=127.0.0.1 port=" + port + "\"\n" +
		"sleep 30\n"
	must(t, os.WriteFile(p, []byte(script), 0o755))
	return p
}

// writeGatedCwdRunner writes a runner that appends its --cwd value (arg $2) to
// recordPath, then BLOCKS until gatePath exists before printing READY. The gate
// lets a test hold a child in the in-flight (spawning, not-yet-ready) state
// deterministically, so a concurrent Start can be raced against it.
func writeGatedCwdRunner(t *testing.T, port, recordPath, gatePath string) string {
	t.Helper()
	dir := t.TempDir()
	p := filepath.Join(dir, "g.sh")
	script := "#!/bin/sh\n" +
		"echo \"$2\" >> " + recordPath + "\n" +
		"while [ ! -f " + gatePath + " ]; do sleep 0.02; done\n" +
		"echo \"RECK_PREVIEW_READY host=127.0.0.1 port=" + port + "\"\n" +
		"sleep 30\n"
	must(t, os.WriteFile(p, []byte(script), 0o755))
	return p
}

// TestStartRestartsOnCwdChange proves the one-preview-per-project contract:
// starting the same project id at a different cwd tears the running child down
// and spawns a fresh one rooted at the new cwd — never two children at once.
func TestStartRestartsOnCwdChange(t *testing.T) {
	record := filepath.Join(t.TempDir(), "cwds.log")
	m := newManagerForTest("/bin/sh", writeCwdRecordingRunner(t, "47001", record))
	defer m.Shutdown()
	ctx := context.Background()

	cwdA := t.TempDir()
	cwdB := t.TempDir()

	st, err := m.Start(ctx, "p", cwdA, "")
	if err != nil {
		t.Fatalf("Start A: %v", err)
	}
	if !st.Ready || st.Port != 47001 {
		t.Fatalf("Start A: expected ready on port 47001, got %+v", st)
	}
	if s := m.spawns(); s != 1 {
		t.Fatalf("expected 1 spawn after first Start, got %d", s)
	}
	pidA := m.spawnedPID()
	if pidA <= 0 {
		t.Fatalf("expected a recorded PID for child A, got %d", pidA)
	}

	// Same project id, different cwd → must restart, not reuse.
	st2, err := m.Start(ctx, "p", cwdB, "")
	if err != nil {
		t.Fatalf("Start B: %v", err)
	}
	if !st2.Ready || st2.Port != 47001 {
		t.Fatalf("Start B: expected ready on port 47001, got %+v", st2)
	}
	if s := m.spawns(); s != 2 {
		t.Fatalf("expected 2 spawns after a cwd change (restart), got %d", s)
	}
	pidB := m.spawnedPID()
	if pidB == pidA {
		t.Fatalf("expected a new child PID after restart, still %d", pidB)
	}

	// The original child (cwd A) must be torn down — one preview per project.
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if err := syscall.Kill(pidA, 0); err == syscall.ESRCH {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if err := syscall.Kill(pidA, 0); err != syscall.ESRCH {
		t.Fatalf("child A pid=%d still alive after restart (two previews for one project)", pidA)
	}
	if !m.Status("p").Running {
		t.Fatalf("expected the restarted child to be running")
	}

	// Each child recorded the cwd it booted against: A then B.
	data, err := os.ReadFile(record)
	if err != nil {
		t.Fatalf("read cwd record: %v", err)
	}
	lines := strings.Fields(strings.TrimSpace(string(data)))
	if len(lines) != 2 || lines[0] != cwdA || lines[1] != cwdB {
		t.Fatalf("cwd record = %v, want [%q %q] (A booted at cwdA, restarted child at cwdB)", lines, cwdA, cwdB)
	}
}

// TestStartInFlightRestartsOnCwdChange is the I-1 regression test. While one
// Start is still spawning a child for cwdA (in-flight, not yet ready), a
// concurrent Start for the SAME project id at cwdB must NOT observe-and-reuse
// the cwdA spawn (which would hand it a Vite server rooted at the wrong app
// root). It must supersede the in-flight child and end up rooted at cwdB, with
// only one child alive at the end (the superseded cwdA child reaped).
func TestStartInFlightRestartsOnCwdChange(t *testing.T) {
	record := filepath.Join(t.TempDir(), "cwds.log")
	gate := filepath.Join(t.TempDir(), "gate")
	m := newManagerForTest("/bin/sh", writeGatedCwdRunner(t, "47002", record, gate))
	// Give the superseded/gated children ample room to be torn down.
	m.readyTimeout = 5 * time.Second
	defer m.Shutdown()

	cwdA := t.TempDir()
	cwdB := t.TempDir()

	recordLines := func() []string {
		data, _ := os.ReadFile(record)
		return strings.Fields(strings.TrimSpace(string(data)))
	}
	waitFor := func(what string, cond func() bool) {
		t.Helper()
		deadline := time.Now().Add(4 * time.Second)
		for time.Now().Before(deadline) {
			if cond() {
				return
			}
			time.Sleep(10 * time.Millisecond)
		}
		t.Fatalf("timed out waiting for %s", what)
	}

	// Start A: reserves the slot and spawns child A, which records cwdA then
	// blocks on the gate (stays in-flight / not ready).
	var stA proto.PreviewStatus
	var errA error
	doneA := make(chan struct{})
	go func() {
		stA, errA = m.Start(context.Background(), "p", cwdA, "")
		close(doneA)
	}()

	// Child A is in-flight once it has recorded its cwd (past cmd.Start) but has
	// not yet gone ready.
	waitFor("child A in-flight at cwdA", func() bool {
		lines := recordLines()
		return m.spawns() == 1 && len(lines) == 1 && lines[0] == cwdA
	})
	if st := m.Status("p"); !st.Running || st.Ready {
		t.Fatalf("expected child A running-but-not-ready (in-flight), got %+v", st)
	}
	pidA := m.spawnedPID()
	if pidA <= 0 {
		t.Fatalf("expected a recorded PID for in-flight child A, got %d", pidA)
	}

	// Start B: same project id, DIFFERENT cwd, while A is still in-flight. It must
	// supersede A's spawn (not observe it) and spawn a fresh child B at cwdB.
	var stB proto.PreviewStatus
	var errB error
	doneB := make(chan struct{})
	go func() {
		stB, errB = m.Start(context.Background(), "p", cwdB, "")
		close(doneB)
	}()

	// Wait until child B has been spawned (supersede happened) and recorded cwdB.
	waitFor("child B spawned at cwdB after supersede", func() bool {
		lines := recordLines()
		return m.spawns() == 2 && len(lines) == 2 && lines[1] == cwdB
	})
	pidB := m.spawnedPID()
	if pidB == pidA {
		t.Fatalf("expected a distinct child B PID after supersede, still %d", pidB)
	}

	// Open the gate: child B (the surviving reservation) now prints READY. Child A
	// was superseded/terminated and never reaches this line.
	must(t, os.WriteFile(gate, []byte("go\n"), 0o644))

	<-doneB
	<-doneA

	// The requesting caller (B) must get a ready child rooted at cwdB.
	if errB != nil {
		t.Fatalf("Start B (requesting cwdB) returned error: %v", errB)
	}
	if !stB.Ready || stB.Port != 47002 {
		t.Fatalf("Start B: expected ready on port 47002 (rooted at cwdB), got %+v", stB)
	}
	// The superseded caller (A) is the losing racer: its in-flight child was torn
	// down, so it must be signaled with an error rather than handed A's server.
	if errA == nil {
		t.Fatalf("expected superseded Start A to return an error, got ready=%v", stA.Ready)
	}

	// Only ONE child alive at the end: the superseded child A must be reaped.
	waitFor("superseded child A reaped", func() bool {
		return syscall.Kill(pidA, 0) == syscall.ESRCH
	})
	if err := syscall.Kill(pidB, 0); err == syscall.ESRCH {
		t.Fatalf("child B pid=%d (the requested cwdB preview) must still be alive", pidB)
	}
	if !m.Status("p").Running {
		t.Fatalf("expected the superseding child B to be the live registered preview")
	}

	// Exactly two spawns (A, then the superseding B) and cwds recorded in order.
	if s := m.spawns(); s != 2 {
		t.Fatalf("expected 2 spawns (A then superseding B), got %d", s)
	}
	if lines := recordLines(); len(lines) != 2 || lines[0] != cwdA || lines[1] != cwdB {
		t.Fatalf("cwd record = %v, want [%q %q]", lines, cwdA, cwdB)
	}
}

func TestStartParsesPortAndReuses(t *testing.T) {
	m := newManagerForTest("/bin/sh", writeReadyRunner(t, "43111"))
	defer m.Shutdown()
	ctx := context.Background()

	// Same cwd across both Starts so the reuse fast path applies (a differing
	// cwd would deliberately restart — see TestStartRestartsOnCwdChange).
	cwd := t.TempDir()

	st, err := m.Start(ctx, "p1", cwd, "")
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
	st2, err := m.Start(ctx, "p1", cwd, "")
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

// TestSpawnWindowStopDoesNotOrphan is the FIX-2 regression test. There is a
// narrow window in spawn between the child's cmd.Start() and the manager
// publishing proc.cmd. If a Stop/Shutdown/reap lands in that window it deletes
// the in-flight registry entry, but its terminate no-ops because proc.cmd is
// still nil — so the just-started child is removed from the registry yet left
// running (an orphan). The onSpawnStarted seam fires a Stop in exactly that
// window. After Start returns, the registry must have no entry for the project
// AND the spawned child must be torn down (its PID gone), never leaked.
func TestSpawnWindowStopDoesNotOrphan(t *testing.T) {
	m := newManagerForTest("/bin/sh", writeReadyRunner(t, "46777"))
	defer m.Shutdown()

	// Fire a Stop inside the spawn window (after cmd.Start(), before proc.cmd is
	// published) so terminate races a nil cmd — the exact orphan trigger.
	m.onSpawnStarted = func(id string) { _ = m.Stop(id) }

	// The windowed Stop removes the in-flight entry, so Start is expected to
	// return an error; what matters is that the child is not left running.
	_, _ = m.Start(context.Background(), "p", t.TempDir(), "")

	pid := m.spawnedPID()
	if pid <= 0 {
		t.Fatalf("expected a spawned child PID to have been recorded, got %d", pid)
	}

	// The registry must not report the project as running (Stop removed it).
	if m.Status("p").Running {
		t.Fatalf("expected no registry entry for p after a windowed Stop")
	}

	// Critical assertion: the spawned child must be torn down, not orphaned.
	// Poll until Kill(pid, 0) reports ESRCH (process gone and reaped). Pre-fix
	// this never happens within the window: terminate no-op'd on the nil cmd, so
	// the child runs its `sleep 30` untouched and stays alive.
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		if err := syscall.Kill(pid, 0); err == syscall.ESRCH {
			return // child is gone — no orphan
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("spawned child pid=%d is still alive after a windowed Stop (orphaned)", pid)
}
