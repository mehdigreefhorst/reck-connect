// Package preview manages per-project component-preview dev servers. Each
// project gets at most ONE Node "runner" child (see runner/server.mjs) which
// boots the project's own Vite server. The Manager spawns that child, parses
// its machine-readable readiness/port line from stdout, reuses a live child on
// subsequent requests, idle-reaps children that stop being polled, and stops
// everything on shutdown.
package preview

import (
	"bufio"
	"context"
	"fmt"
	"os"
	"os/exec"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/rudie-verweij/reck-connect/proto"
)

// Machine-readable lines the runner prints (server.mjs). READY goes to stdout,
// ERROR to stderr; the Manager merges both streams into one pipe and scans it.
var (
	readyRe = regexp.MustCompile(`^RECK_PREVIEW_READY .*\bport=(\d+)`)
	errRe   = regexp.MustCompile(`^RECK_PREVIEW_ERROR`)
)

// Default timeouts for a production Manager.
const (
	defaultReadyTimeout = 60 * time.Second
	defaultIdleTimeout  = 120 * time.Second
	defaultReapInterval = 30 * time.Second
	defaultStopGrace    = 3 * time.Second
)

// previewProc is the bookkeeping for one runner child (or one in-flight spawn).
// All fields are guarded by Manager.mu, except: cmd is assigned exactly once in
// spawn (under mu, before the supervising goroutine starts, so the go statement
// publishes it); exited is a channel closed once by the supervising goroutine;
// readyCh is a broadcast channel closed exactly once (guarded by closed) to wake
// every waiter — on READY, on failure/timeout, or on child exit.
type previewProc struct {
	cmd      *exec.Cmd
	cwd      string // Vite root the child was spawned with; a change forces a restart.
	port     int
	ready    bool
	errMsg   string
	lastSeen time.Time
	exited   chan struct{}
	readyCh  chan struct{}
	closed   bool
}

// Manager keeps one runner child per project and reaps idle ones.
type Manager struct {
	nodePath   string
	runnerPath string

	mu           sync.Mutex
	procs        map[string]*previewProc
	spawnCount   int
	lastSpawnPID int // PID of the most recently started child (mu-guarded; test aid).

	// Timeouts. Written once at construction (and, for tests, before the first
	// Start launches any goroutine that reads them — so the go statement in
	// startReaper establishes a happens-before edge).
	readyTimeout time.Duration
	idleTimeout  time.Duration
	reapInterval time.Duration
	stopGrace    time.Duration

	// onSpawnStarted, when non-nil, is invoked inside spawn in the narrow window
	// after the child has started but before proc.cmd is published. Always nil in
	// production; set by a test (before the first Start) to deterministically race
	// a Stop/Shutdown against the spawn window.
	onSpawnStarted func(projectID string)

	reaperOnce sync.Once
	stopOnce   sync.Once
	done       chan struct{}
}

// NewManager builds a Manager with production defaults and starts the
// background idle-reaper. nodePath is the resolved `node` binary; runnerPath is
// the on-disk server.mjs.
func NewManager(nodePath, runnerPath string) *Manager {
	m := newManager(nodePath, runnerPath)
	m.readyTimeout = defaultReadyTimeout
	m.idleTimeout = defaultIdleTimeout
	m.reapInterval = defaultReapInterval
	m.stopGrace = defaultStopGrace
	m.startReaper()
	return m
}

func newManager(nodePath, runnerPath string) *Manager {
	return &Manager{
		nodePath:   nodePath,
		runnerPath: runnerPath,
		procs:      make(map[string]*previewProc),
		done:       make(chan struct{}),
	}
}

// newManagerForTest builds a Manager with short timeouts and, crucially, does
// NOT start the reaper. Tests may shrink the timeout fields before the first
// Start (which lazily starts the reaper) so those writes happen-before any
// goroutine reads them.
func newManagerForTest(nodePath, runnerPath string) *Manager {
	m := newManager(nodePath, runnerPath)
	m.readyTimeout = 2 * time.Second
	m.idleTimeout = 120 * time.Second
	m.reapInterval = 50 * time.Millisecond
	m.stopGrace = 100 * time.Millisecond
	return m
}

// Start returns the (reused-or-newly-spawned) preview status for a project,
// blocking until the runner is ready or readyTimeout elapses. A live child is
// reused without spawning a second one. cwd is the project's absolute path;
// hmrHost is forwarded to the runner as --hmr-host (empty ok).
func (m *Manager) Start(ctx context.Context, projectID, cwd, hmrHost string) (proto.PreviewStatus, error) {
	m.startReaper()

	// stale holds a ready child that must be torn down because the requested
	// cwd (app subdir) changed — one preview per project, restarted on change.
	// It is terminated after the lock is released and the new slot is reserved.
	var stale *previewProc
	var staleGrace time.Duration

	m.mu.Lock()
	if p, ok := m.procs[projectID]; ok {
		if p.ready {
			if p.cwd == cwd {
				// Fast path: a live, ready child at the same cwd is reused
				// without spawning.
				p.lastSeen = time.Now()
				st := statusOf(p)
				m.mu.Unlock()
				return st, nil
			}
			// The app subdir changed. Drop this entry now (so concurrent
			// callers see the fresh reservation below, never two children) and
			// remember the old child to terminate once the lock is released.
			delete(m.procs, projectID)
			stale = p
			staleGrace = m.stopGrace
		} else if p.cwd == cwd {
			// A concurrent caller has already reserved this slot and is spawning
			// (I1) for the SAME cwd. Do NOT spawn a second child: coalesce by
			// waiting on its broadcast readyCh.
			readyCh := p.readyCh
			readyTimeout := m.readyTimeout
			m.mu.Unlock()
			return m.waitReadyAsObserver(ctx, projectID, readyCh, readyTimeout)
		} else {
			// A concurrent caller is mid-spawn for a DIFFERENT cwd (app subdir
			// changed, I-1). Observing it would hand this caller a child rooted at
			// the wrong app root. Supersede it exactly like the ready-branch
			// restart above: drop the reservation now (so further concurrent
			// callers coalesce on the fresh cwd slot reserved below, never on the
			// superseded one) and remember the in-flight child to terminate once
			// the lock is released. Its cmd may still be nil (mid-spawn); terminate
			// no-ops then and spawn's identity-guarded orphan check
			// (m.procs[projectID] != proc) reaps the child once cmd is published.
			delete(m.procs, projectID)
			stale = p
			staleGrace = m.stopGrace
		}
	}

	// Reserve the map slot with an in-flight proc BEFORE unlocking and spawning
	// (I1). Concurrent callers now observe this entry instead of double-spawning.
	proc := &previewProc{
		cwd:      cwd,
		lastSeen: time.Now(),
		exited:   make(chan struct{}),
		readyCh:  make(chan struct{}),
	}
	m.procs[projectID] = proc
	readyTimeout := m.readyTimeout
	grace := m.stopGrace
	m.mu.Unlock()

	// Tear the superseded child down (same path as Stop) now that the new slot
	// is reserved and the lock is released.
	if stale != nil {
		m.terminate(stale, staleGrace)
	}

	if err := m.spawn(projectID, cwd, hmrHost, proc); err != nil {
		// Spawn failed: drop the poisoned in-flight entry (if still ours) and
		// broadcast so any observers wake and see the failure.
		m.abandonInFlight(projectID, proc, err.Error())
		return proto.PreviewStatus{Error: err.Error()}, err
	}

	return m.waitReadyAsOwner(ctx, projectID, proc, readyTimeout, grace)
}

// waitReadyAsOwner blocks until the child this goroutine spawned becomes ready,
// its context is cancelled, or readyTimeout elapses. It owns the child, so on
// cancellation (M1) or timeout it tears the child down and clears the in-flight
// entry before returning.
func (m *Manager) waitReadyAsOwner(ctx context.Context, projectID string, proc *previewProc, readyTimeout, grace time.Duration) (proto.PreviewStatus, error) {
	select {
	case <-proc.readyCh:
		m.mu.Lock()
		ready := proc.ready
		st := statusOf(proc)
		m.mu.Unlock()
		if !ready {
			// readyCh closed without READY: the child exited or failed first.
			return proto.PreviewStatus{Ready: false, Error: st.Error},
				fmt.Errorf("preview: runner for %q exited before ready", projectID)
		}
		return st, nil
	case <-ctx.Done():
		m.abandonInFlight(projectID, proc, ctx.Err().Error())
		m.terminate(proc, grace)
		return proto.PreviewStatus{Ready: false, Error: ctx.Err().Error()}, ctx.Err()
	case <-time.After(readyTimeout):
		m.abandonInFlight(projectID, proc, "timeout")
		m.terminate(proc, grace)
		return proto.PreviewStatus{Running: true, Ready: false, Error: "timeout"},
			fmt.Errorf("preview: runner for %q not ready within %s", projectID, readyTimeout)
	}
}

// waitReadyAsObserver blocks a concurrent caller that found an in-flight entry.
// It never spawns or tears down the shared child: it waits for the owner's
// broadcast readyCh (or its own ctx/deadline), then re-reads the current status.
func (m *Manager) waitReadyAsObserver(ctx context.Context, projectID string, readyCh <-chan struct{}, readyTimeout time.Duration) (proto.PreviewStatus, error) {
	select {
	case <-readyCh:
		m.mu.Lock()
		p, ok := m.procs[projectID]
		var st proto.PreviewStatus
		ready := false
		if ok {
			p.lastSeen = time.Now()
			st = statusOf(p)
			ready = p.ready
		}
		m.mu.Unlock()
		if !ok {
			return proto.PreviewStatus{}, fmt.Errorf("preview: runner for %q did not become ready", projectID)
		}
		if !ready {
			return st, fmt.Errorf("preview: runner for %q not ready", projectID)
		}
		return st, nil
	case <-ctx.Done():
		m.mu.Lock()
		var st proto.PreviewStatus
		if p, ok := m.procs[projectID]; ok {
			st = statusOf(p)
		}
		m.mu.Unlock()
		return st, ctx.Err()
	case <-time.After(readyTimeout):
		m.mu.Lock()
		var st proto.PreviewStatus
		if p, ok := m.procs[projectID]; ok {
			st = statusOf(p)
		}
		m.mu.Unlock()
		return st, fmt.Errorf("preview: waiting for runner %q timed out", projectID)
	}
}

// abandonInFlight drops the in-flight entry for projectID (only if it is still
// proc, so a newer child is never clobbered), records errMsg, and broadcasts
// readyCh so any observers wake and re-read the status.
func (m *Manager) abandonInFlight(projectID string, proc *previewProc, errMsg string) {
	m.mu.Lock()
	if m.procs[projectID] == proc {
		delete(m.procs, projectID)
	}
	if errMsg != "" {
		proc.errMsg = errMsg
	}
	m.closeReadyLocked(proc)
	m.mu.Unlock()
}

// closeReadyLocked closes proc.readyCh at most once (broadcasting to every
// waiter). Must be called with m.mu held.
func (m *Manager) closeReadyLocked(proc *previewProc) {
	if !proc.closed {
		proc.closed = true
		close(proc.readyCh)
	}
}

// spawn launches the runner child for the already-reserved proc and wires up
// output scanning. The proc is registered in m.procs by the caller (Start)
// before spawn runs, so a failed spawn leaves no orphaned child in the map.
func (m *Manager) spawn(projectID, cwd, hmrHost string, proc *previewProc) error {
	cmd := exec.CommandContext(context.Background(), m.nodePath, m.runnerPath,
		"--cwd", cwd, "--host", "0.0.0.0", "--hmr-host", hmrHost, "--port", "0")

	pr, pw, err := os.Pipe()
	if err != nil {
		return err
	}
	cmd.Stdout = pw
	cmd.Stderr = pw

	if err := cmd.Start(); err != nil {
		_ = pw.Close()
		_ = pr.Close()
		return err
	}
	_ = pw.Close() // the child holds its own dup of the write end

	// Test-only seam: fire in the exact spawn window — after the child has
	// started but before proc.cmd is published — so a test can deterministically
	// race a Stop/Shutdown here. Always nil in production.
	if m.onSpawnStarted != nil {
		m.onSpawnStarted(projectID)
	}

	m.mu.Lock()
	m.spawnCount++
	proc.cmd = cmd
	m.lastSpawnPID = cmd.Process.Pid
	// Close the spawn window: a Stop/Shutdown/reap that landed while proc.cmd was
	// still nil deleted our registry entry AND no-op'd its own terminate (nil
	// cmd), leaving this child started-but-unreferenced. proc.cmd is published
	// now, so the child is finally killable — tear it down and wake any waiter.
	// Do NOT re-insert into the map (respect the Stop).
	orphaned := m.procs[projectID] != proc
	if orphaned {
		proc.errMsg = "stopped"
		m.closeReadyLocked(proc)
	}
	grace := m.stopGrace
	m.mu.Unlock()

	// Start the supervisor in every case so the child is Wait()ed/reaped and
	// proc.exited closes (which lets terminate's grace path finish cleanly).
	go m.supervise(projectID, proc, pr)

	if orphaned {
		m.terminate(proc, grace)
	}
	return nil
}

// supervise reaps the child and scans its merged stdout/stderr. A dedicated
// goroutine waits on the process so proc.exited closes promptly even if a
// grandchild keeps the pipe open; closing pr there unblocks the scanner. When
// the child exits it also clears the registry entry (I2) so a dead child is
// never reported Running/Ready nor reused, and broadcasts readyCh so any waiter
// stops blocking.
func (m *Manager) supervise(projectID string, proc *previewProc, pr *os.File) {
	go func() {
		_ = proc.cmd.Wait()
		_ = pr.Close()
		close(proc.exited)

		m.mu.Lock()
		// Only clear if this proc is still the registered one — a Stop/replace
		// may already have swapped in a newer child, which must not be clobbered.
		if m.procs[projectID] == proc {
			delete(m.procs, projectID)
		}
		m.closeReadyLocked(proc)
		m.mu.Unlock()
	}()

	scanner := bufio.NewScanner(pr)
	for scanner.Scan() {
		line := scanner.Text()
		switch {
		case readyRe.MatchString(line):
			m.markReady(proc, line)
		case errRe.MatchString(line):
			msg := strings.TrimSpace(strings.TrimPrefix(line, "RECK_PREVIEW_ERROR"))
			m.mu.Lock()
			proc.errMsg = msg
			m.mu.Unlock()
		}
		// Keep scanning after READY to drain the pipe, so the child never
		// blocks on a full stdout buffer.
	}
}

func (m *Manager) markReady(proc *previewProc, line string) {
	sub := readyRe.FindStringSubmatch(line)
	port := 0
	if len(sub) > 1 {
		port, _ = strconv.Atoi(sub[1])
	}
	m.mu.Lock()
	proc.port = port
	proc.ready = true
	// Broadcast to the owner and every observer waiting on this spawn.
	m.closeReadyLocked(proc)
	m.mu.Unlock()
}

// Status returns the current status for a project and bumps lastSeen so an
// actively-polled preview is not reaped. Zero value (running:false) if absent.
func (m *Manager) Status(projectID string) proto.PreviewStatus {
	m.mu.Lock()
	defer m.mu.Unlock()
	p, ok := m.procs[projectID]
	if !ok {
		return proto.PreviewStatus{}
	}
	p.lastSeen = time.Now()
	return statusOf(p)
}

// statusOf must be called with m.mu held.
func statusOf(p *previewProc) proto.PreviewStatus {
	return proto.PreviewStatus{Running: true, Ready: p.ready, Port: p.port, Error: p.errMsg}
}

// Stop terminates a project's runner (SIGTERM, then SIGKILL after stopGrace)
// and removes it from the registry. Idempotent.
func (m *Manager) Stop(projectID string) error {
	m.mu.Lock()
	p, ok := m.procs[projectID]
	if ok {
		delete(m.procs, projectID)
	}
	grace := m.stopGrace
	m.mu.Unlock()
	if !ok {
		return nil
	}
	m.terminate(p, grace)
	return nil
}

// terminate signals SIGTERM then, in a goroutine, SIGKILLs the child if it has
// not exited within grace. cmd is read under mu because spawn assigns it after
// the proc is already registered (an in-flight proc may have a nil cmd).
func (m *Manager) terminate(p *previewProc, grace time.Duration) {
	if p == nil {
		return
	}
	m.mu.Lock()
	cmd := p.cmd
	m.mu.Unlock()
	if cmd == nil || cmd.Process == nil {
		return
	}
	_ = cmd.Process.Signal(syscall.SIGTERM)
	go func() {
		timer := time.NewTimer(grace)
		defer timer.Stop()
		select {
		case <-p.exited:
		case <-timer.C:
			_ = cmd.Process.Kill()
		}
	}()
}

// startReaper launches the idle-reaper goroutine exactly once.
func (m *Manager) startReaper() {
	m.reaperOnce.Do(func() {
		go m.reapLoop()
	})
}

// reapLoop periodically stops runners that have not been polled within
// idleTimeout. It re-reads reapInterval each iteration so tests can shrink it.
func (m *Manager) reapLoop() {
	for {
		m.mu.Lock()
		interval := m.reapInterval
		m.mu.Unlock()

		timer := time.NewTimer(interval)
		select {
		case <-m.done:
			timer.Stop()
			return
		case <-timer.C:
			m.reapIdle()
		}
	}
}

func (m *Manager) reapIdle() {
	now := time.Now()
	m.mu.Lock()
	var stale []string
	for id, p := range m.procs {
		if now.Sub(p.lastSeen) > m.idleTimeout {
			stale = append(stale, id)
		}
	}
	m.mu.Unlock()
	for _, id := range stale {
		_ = m.Stop(id)
	}
}

// Shutdown stops the reaper and every registered runner. Idempotent.
func (m *Manager) Shutdown() {
	m.stopOnce.Do(func() { close(m.done) })

	m.mu.Lock()
	ids := make([]string, 0, len(m.procs))
	for id := range m.procs {
		ids = append(ids, id)
	}
	m.mu.Unlock()

	for _, id := range ids {
		_ = m.Stop(id)
	}
}

// spawns reports how many runner children have actually been started. Used by
// tests to prove that a live child is reused rather than re-spawned.
func (m *Manager) spawns() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.spawnCount
}

// spawnedPID reports the OS PID of the most recently started child (0 if none).
// Used by tests to assert a spawned child is actually torn down.
func (m *Manager) spawnedPID() int {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.lastSpawnPID
}
