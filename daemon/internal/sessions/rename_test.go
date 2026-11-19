package sessions

import (
	"testing"
	"time"
)

// TestSetDisplayName_roundTripsThroughGet walks a session through set →
// get → clear → get. Guards the common path a rename endpoint takes.
func TestSetDisplayName_roundTripsThroughGet(t *testing.T) {
	s, _ := newStore(t)
	sid := NewUUID()
	if err := s.Upsert("proj", Entry{
		SessionID:    sid,
		Name:         "proj/abc",
		Cwd:          "/tmp/proj",
		CreatedAt:    time.Now(),
		LastActiveAt: time.Now(),
	}); err != nil {
		t.Fatalf("Upsert: %v", err)
	}

	if err := s.SetDisplayName("proj", sid, "My Label"); err != nil {
		t.Fatalf("SetDisplayName: %v", err)
	}
	got, ok, err := s.Get("proj", sid)
	if err != nil || !ok {
		t.Fatalf("Get: ok=%v err=%v", ok, err)
	}
	if got.DisplayName != "My Label" {
		t.Fatalf("DisplayName = %q, want %q", got.DisplayName, "My Label")
	}

	// Clearing round-trips too.
	if err := s.SetDisplayName("proj", sid, ""); err != nil {
		t.Fatalf("clear: %v", err)
	}
	got, _, _ = s.Get("proj", sid)
	if got.DisplayName != "" {
		t.Fatalf("expected DisplayName empty after clear, got %q", got.DisplayName)
	}
}

// TestSetDisplayName_unknownSessionIsNoOp mirrors Touch/SetLive semantics:
// racing with a session deletion shouldn't surface as an error.
func TestSetDisplayName_unknownSessionIsNoOp(t *testing.T) {
	s, _ := newStore(t)
	if err := s.SetDisplayName("proj", "does-not-exist", "Whatever"); err != nil {
		t.Fatalf("expected nil, got %v", err)
	}
}

// TestSetDisplayName_emptySessionIDIsNoOp matches the Touch convention —
// callers sometimes hand us a shell pane with no session_id.
func TestSetDisplayName_emptySessionIDIsNoOp(t *testing.T) {
	s, _ := newStore(t)
	if err := s.SetDisplayName("proj", "", "Whatever"); err != nil {
		t.Fatalf("expected nil for empty session_id, got %v", err)
	}
}

// TestUpsert_preservesDisplayNameOnResume is the whole point of persisting
// the label in the sessions store: a resume upserts a fresh Entry (built
// from the new pane's view) and must not clobber a rename the user
// performed before the kickstart.
func TestUpsert_preservesDisplayNameOnResume(t *testing.T) {
	s, _ := newStore(t)
	sid := NewUUID()
	now := time.Now()
	if err := s.Upsert("proj", Entry{
		SessionID: sid, Name: "proj/abc", Cwd: "/tmp", CreatedAt: now, LastActiveAt: now,
	}); err != nil {
		t.Fatal(err)
	}
	if err := s.SetDisplayName("proj", sid, "Deployment Agent"); err != nil {
		t.Fatal(err)
	}
	// Simulate a respawn: Manager builds a fresh Entry without DisplayName.
	if err := s.Upsert("proj", Entry{
		SessionID: sid, Name: "proj/abc", Cwd: "/tmp", LastActiveAt: now.Add(time.Second),
	}); err != nil {
		t.Fatal(err)
	}
	got, _, _ := s.Get("proj", sid)
	if got.DisplayName != "Deployment Agent" {
		t.Fatalf("Upsert clobbered DisplayName; got %q want %q", got.DisplayName, "Deployment Agent")
	}
}

// --- auto-title baseline (issue #174) ---

func baselineStore(t *testing.T) (*Store, string) {
	t.Helper()
	s, _ := newStore(t)
	sid := NewUUID()
	if err := s.Upsert("proj", Entry{
		SessionID:    sid,
		Name:         "proj/abc",
		Cwd:          "/tmp/proj",
		CreatedAt:    time.Now(),
		LastActiveAt: time.Now(),
	}); err != nil {
		t.Fatalf("Upsert: %v", err)
	}
	return s, sid
}

func baselineOf(t *testing.T, s *Store, sid string) *string {
	t.Helper()
	e, ok, err := s.Get("proj", sid)
	if err != nil || !ok {
		t.Fatalf("Get: ok=%v err=%v", ok, err)
	}
	return e.AutoTitleAtRename
}

func TestSetDisplayNameWithBaseline_persistsAndSurvivesUpsert(t *testing.T) {
	s, sid := baselineStore(t)
	title := "claude-title"
	if err := s.SetDisplayNameWithBaseline("proj", sid, "manual", &title); err != nil {
		t.Fatal(err)
	}
	if b := baselineOf(t, s, sid); b == nil || *b != "claude-title" {
		t.Fatalf("baseline = %v, want claude-title", b)
	}
	// A resume re-upserts the row without a DisplayName; both the name
	// and its baseline must survive together.
	if err := s.Upsert("proj", Entry{SessionID: sid, Name: "proj/abc", Cwd: "/tmp/proj", LastActiveAt: time.Now()}); err != nil {
		t.Fatal(err)
	}
	e, _, _ := s.Get("proj", sid)
	if e.DisplayName != "manual" || e.AutoTitleAtRename == nil || *e.AutoTitleAtRename != "claude-title" {
		t.Fatalf("after Upsert: display=%q baseline=%v", e.DisplayName, e.AutoTitleAtRename)
	}
}

func TestSetDisplayName_resetsBaselineToUnknown(t *testing.T) {
	s, sid := baselineStore(t)
	title := "t"
	_ = s.SetDisplayNameWithBaseline("proj", sid, "manual", &title)
	if err := s.SetDisplayName("proj", sid, "manual-2"); err != nil {
		t.Fatal(err)
	}
	if b := baselineOf(t, s, sid); b != nil {
		t.Fatalf("baseline = %q, want nil after a baseline-less rename", *b)
	}
}

func TestSetDisplayNameWithBaseline_clearingNameDropsBaseline(t *testing.T) {
	s, sid := baselineStore(t)
	title := "t"
	_ = s.SetDisplayNameWithBaseline("proj", sid, "manual", &title)
	if err := s.SetDisplayNameWithBaseline("proj", sid, "", &title); err != nil {
		t.Fatal(err)
	}
	if b := baselineOf(t, s, sid); b != nil {
		t.Fatalf("baseline = %q, want nil once the name is cleared", *b)
	}
}

func TestSetAutoTitleBaseline_onlyFillsMissingBaseline(t *testing.T) {
	s, sid := baselineStore(t)
	// No DisplayName → nothing to baseline.
	if err := s.SetAutoTitleBaseline("proj", sid, "x"); err != nil {
		t.Fatal(err)
	}
	if b := baselineOf(t, s, sid); b != nil {
		t.Fatalf("baseline recorded without a DisplayName: %q", *b)
	}
	_ = s.SetDisplayName("proj", sid, "manual")
	// Empty title is a valid baseline ("Claude had no title").
	if err := s.SetAutoTitleBaseline("proj", sid, ""); err != nil {
		t.Fatal(err)
	}
	if b := baselineOf(t, s, sid); b == nil || *b != "" {
		t.Fatalf("baseline = %v, want captured empty string", b)
	}
	// Already captured → never overwritten.
	_ = s.SetAutoTitleBaseline("proj", sid, "later")
	if b := baselineOf(t, s, sid); b == nil || *b != "" {
		t.Fatalf("captured baseline was overwritten: %v", b)
	}
}

func TestClearDisplayNameIfUnchanged(t *testing.T) {
	s, sid := baselineStore(t)
	title := "t"
	_ = s.SetDisplayNameWithBaseline("proj", sid, "manual", &title)
	// A manual rename raced in: the stale clear must not discard it.
	if err := s.ClearDisplayNameIfUnchanged("proj", sid, "older-name"); err != nil {
		t.Fatal(err)
	}
	if e, _, _ := s.Get("proj", sid); e.DisplayName != "manual" {
		t.Fatalf("DisplayName = %q, want manual (expected value did not match)", e.DisplayName)
	}
	if err := s.ClearDisplayNameIfUnchanged("proj", sid, "manual"); err != nil {
		t.Fatal(err)
	}
	e, _, _ := s.Get("proj", sid)
	if e.DisplayName != "" || e.AutoTitleAtRename != nil {
		t.Fatalf("after clear: display=%q baseline=%v", e.DisplayName, e.AutoTitleAtRename)
	}
}
