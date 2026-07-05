package preview

import (
	"context"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// TestWriteRunnerMaterializesAllFiles is the deterministic contract test: it
// proves WriteRunner drops every runtime file the runner needs (server.mjs and
// its relative imports) into destDir and returns server.mjs as the entry. No
// node required.
func TestWriteRunnerMaterializesAllFiles(t *testing.T) {
	dir := t.TempDir()
	entry, err := WriteRunner(dir)
	if err != nil {
		t.Fatal(err)
	}
	if entry != filepath.Join(dir, "server.mjs") {
		t.Fatalf("entry=%s", entry)
	}
	for _, name := range []string{"server.mjs", "plugin.mjs", "entry-builder.mjs", "detect.mjs", "index.html"} {
		fi, err := os.Stat(filepath.Join(dir, name))
		if err != nil {
			t.Fatalf("%s missing: %v", name, err)
		}
		if fi.Size() == 0 {
			t.Fatalf("%s empty", name)
		}
	}
}

// TestEmbeddedRunnerBootsAgainstFixture proves the EMBEDDED runner (materialized
// out of the Go binary, not read from the source tree) actually boots the
// Task-3 fixture's Vite server through the real Manager: Start blocks until the
// child prints its READY line, and the reported port is live. Guarded so CI
// hosts without node — or without the fixture's installed node_modules — skip
// cleanly rather than fail; the live path is also covered by the Task 13 e2e.
func TestEmbeddedRunnerBootsAgainstFixture(t *testing.T) {
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node not on PATH")
	}
	fixture := "runner/__fixtures__/vite-tailwind-app"
	if _, err := os.Stat(filepath.Join(fixture, "node_modules")); err != nil {
		t.Skip("fixture node_modules not installed")
	}

	entry, err := WriteRunner(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}

	m := NewManager(node, entry)
	defer m.Shutdown()

	absCwd, err := filepath.Abs(fixture)
	if err != nil {
		t.Fatalf("abs fixture: %v", err)
	}

	st, err := m.Start(context.Background(), "fix", absCwd, "127.0.0.1")
	if err != nil {
		t.Fatalf("Start: %v (%+v)", err, st)
	}
	if !st.Ready || st.Port == 0 {
		t.Fatalf("not ready: %+v", st)
	}
	m.Stop("fix")
}
