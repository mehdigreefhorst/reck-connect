package preview

import (
	"embed"
	"os"
	"path/filepath"
)

// runnerFS carries the Node runner INSIDE the daemon binary so the daemon ships
// self-contained — nothing extra to install alongside it. Only the five runtime
// files are embedded BY NAME: the runner's `.test.mjs` siblings and the whole
// `__fixtures__/` project (with its package-lock.json + node_modules) live under
// runner/ too and would bloat the binary if pulled in via a `runner/*` glob.
//
//go:embed runner/server.mjs runner/plugin.mjs runner/entry-builder.mjs runner/detect.mjs runner/index.html
var runnerFS embed.FS

// runnerFiles is the exact set of files to materialize onto disk. server.mjs is
// the CLI entry the Manager execs; the rest are its relative imports
// (./plugin.mjs → ./entry-builder.mjs, ./detect.mjs) and the injected
// index.html, so they must all land in the same directory.
var runnerFiles = []string{"server.mjs", "plugin.mjs", "entry-builder.mjs", "detect.mjs", "index.html"}

// WriteRunner materializes the embedded Node runner into destDir and returns the
// absolute path to server.mjs — the entry the Manager passes to `node`. destDir
// is created if missing. Any I/O error aborts and is returned as-is.
func WriteRunner(destDir string) (string, error) {
	if err := os.MkdirAll(destDir, 0o755); err != nil {
		return "", err
	}
	for _, name := range runnerFiles {
		data, err := runnerFS.ReadFile("runner/" + name)
		if err != nil {
			return "", err
		}
		if err := os.WriteFile(filepath.Join(destDir, name), data, 0o644); err != nil {
			return "", err
		}
	}
	return filepath.Join(destDir, "server.mjs"), nil
}
