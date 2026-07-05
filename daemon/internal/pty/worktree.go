package pty

import (
	"context"
	"os/exec"
	"strings"
	"time"
)

// gitWorktreePaths returns the absolute paths of every git worktree registered
// under projectRoot (including the main working tree), as reported by
// `git worktree list --porcelain`. It is the enumeration half of the #56
// worktree-restore fix: the caller feeds these to sessions.ResolveTranscriptCwd
// to recover the directory a Claude session actually ran in.
//
// Any failure — git not installed, projectRoot not a repo, timeout — yields nil
// rather than an error. Recovery degrades gracefully to "canonical cwd only",
// which is strictly safer than resuming in a guessed directory.
func gitWorktreePaths(projectRoot string) []string {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, "git", "-C", projectRoot, "worktree", "list", "--porcelain")
	out, err := cmd.Output()
	if err != nil {
		return nil
	}

	var paths []string
	for _, line := range strings.Split(string(out), "\n") {
		// Porcelain blocks start with `worktree <abs-path>`; other keys
		// (HEAD, branch, bare, detached, locked, prunable) we ignore.
		if p, ok := strings.CutPrefix(line, "worktree "); ok {
			if p = strings.TrimSpace(p); p != "" {
				paths = append(paths, p)
			}
		}
	}
	return paths
}
