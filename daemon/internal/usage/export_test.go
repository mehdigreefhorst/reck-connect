package usage

import (
	"bytes"
	"encoding/csv"
	"strings"
	"testing"
	"time"
)

func exportStore(t *testing.T) *Store {
	t.Helper()
	s, err := Open(t.TempDir())
	if err != nil {
		t.Fatalf("open store: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

// readCSV runs an export and parses it back, returning header + rows.
func readCSV(t *testing.T, s *Store, p ExportParams) ([]string, [][]string) {
	t.Helper()
	var buf bytes.Buffer
	if _, err := s.ExportCSV(&buf, p); err != nil {
		t.Fatalf("ExportCSV: %v", err)
	}
	recs, err := csv.NewReader(&buf).ReadAll()
	if err != nil {
		t.Fatalf("parse csv: %v", err)
	}
	if len(recs) == 0 {
		t.Fatal("no header row")
	}
	return recs[0], recs[1:]
}

func TestExportValidate(t *testing.T) {
	day := func(d int) int64 { return time.Date(2026, 7, d, 0, 0, 0, 0, time.UTC).Unix() }
	tests := []struct {
		name string
		p    ExportParams
		ok   bool
	}{
		{"binned ok", ExportParams{Dataset: DatasetBinned, Bucket: BucketDay, Since: day(1), Until: day(2)}, true},
		{"turns ok", ExportParams{Dataset: DatasetTurns, Since: day(1), Until: day(2)}, true},
		{"quota ok", ExportParams{Dataset: DatasetQuota, Since: day(1), Until: day(2)}, true},
		{"unknown dataset", ExportParams{Dataset: "everything", Since: day(1), Until: day(2)}, false},
		{"binned without bucket", ExportParams{Dataset: DatasetBinned, Since: day(1), Until: day(2)}, false},
		{"reversed range", ExportParams{Dataset: DatasetQuota, Since: day(2), Until: day(1)}, false},
		{"zero range", ExportParams{Dataset: DatasetQuota, Since: 0, Until: 0}, false},
		{"absurd tz", ExportParams{Dataset: DatasetQuota, Since: day(1), Until: day(2), TZOffsetMin: 15 * 60}, false},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			err := tc.p.Validate()
			if tc.ok && err != nil {
				t.Errorf("unexpected error: %v", err)
			}
			if !tc.ok && err == nil {
				t.Error("expected an error, got nil")
			}
		})
	}
}

func TestExportFilename(t *testing.T) {
	since := time.Date(2026, 7, 23, 0, 0, 0, 0, time.UTC).Unix()
	until := time.Date(2026, 7, 25, 0, 0, 0, 0, time.UTC).Unix()
	tests := []struct {
		name string
		p    ExportParams
		want string
	}{
		{"binned carries the bin width", ExportParams{Dataset: DatasetBinned, Bucket: "1h", Since: since, Until: until},
			"reck-usage-binned-1h-2026-07-23_2026-07-25.csv"},
		{"turns", ExportParams{Dataset: DatasetTurns, Since: since, Until: until},
			"reck-usage-turns-2026-07-23_2026-07-25.csv"},
		{"quota", ExportParams{Dataset: DatasetQuota, Since: since, Until: until},
			"reck-usage-quota-2026-07-23_2026-07-25.csv"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.p.Filename(); got != tc.want {
				t.Errorf("Filename() = %q, want %q", got, tc.want)
			}
		})
	}
}

func TestExportBinnedMatchesTheChart(t *testing.T) {
	s := exportStore(t)
	base := time.Date(2026, 7, 23, 0, 0, 0, 0, time.UTC)

	if _, err := s.InsertTurnUsage(TurnUsage{
		MessageID: "m1", TS: base.Add(90 * time.Minute), SessionID: "s1", ProjectID: "p1",
		Agent: "claude-code", Model: "claude-opus-4-8",
		InputTokens: 10, OutputTokens: 20, CacheCreation: 30, CacheRead: 40,
	}); err != nil {
		t.Fatal(err)
	}
	if err := s.InsertQuotaSample(QuotaSample{
		TS: base.Add(95 * time.Minute), FiveHour: Bucket{Pct: f64ptr(86)}, Source: "poll",
	}); err != nil {
		t.Fatal(err)
	}
	if err := s.InsertPlanSample(PlanSample{TS: base, Subscription: "max"}); err != nil {
		t.Fatal(err)
	}

	header, rows := readCSV(t, s, ExportParams{
		Dataset: DatasetBinned, Bucket: BucketHour,
		Since: base.Unix(), Until: base.Add(3 * time.Hour).Unix(),
	})

	wantHeader := []string{
		"bin_start", "bin_start_unix", "input_tokens", "output_tokens",
		"cache_creation_tokens", "cache_read_tokens", "total_tokens", "turns",
		"five_hour_peak_pct", "seven_day_peak_pct", "plan",
	}
	if strings.Join(header, ",") != strings.Join(wantHeader, ",") {
		t.Fatalf("header = %v\nwant %v", header, wantHeader)
	}
	if len(rows) != 3 {
		t.Fatalf("rows = %d, want 3 dense hourly bins", len(rows))
	}

	// Hour 1 holds the turn and the quota reading.
	got := rows[1]
	if got[2] != "10" || got[3] != "20" || got[4] != "30" || got[5] != "40" {
		t.Errorf("token columns = %v, want 10/20/30/40", got[2:6])
	}
	if got[6] != "100" || got[7] != "1" {
		t.Errorf("total/turns = %s/%s, want 100/1", got[6], got[7])
	}
	if got[8] != "86" {
		t.Errorf("five_hour_peak = %q, want 86", got[8])
	}
	if got[10] != "max" {
		t.Errorf("plan = %q, want max", got[10])
	}
	// An empty bin is a real zero for tokens, but an ABSENT quota peak —
	// blank, not 0, so a reader can't mistake "no reading" for "0% used".
	if empty := rows[0]; empty[6] != "0" || empty[8] != "" {
		t.Errorf("empty bin: total=%q five_hour_peak=%q; want 0 and blank", empty[6], empty[8])
	}
	// Timestamps come in both forms.
	if !strings.HasPrefix(rows[0][0], "2026-07-23T00:00:00") {
		t.Errorf("bin_start = %q, want an ISO local timestamp", rows[0][0])
	}
	if rows[0][1] != "1784764800" && rows[0][1] == "" {
		t.Errorf("bin_start_unix missing")
	}
}

func TestExportBinnedRespectsCallerTimezone(t *testing.T) {
	s := exportStore(t)
	base := time.Date(2026, 7, 23, 0, 0, 0, 0, time.UTC)

	_, rows := readCSV(t, s, ExportParams{
		Dataset: DatasetBinned, Bucket: BucketHour,
		Since: base.Unix(), Until: base.Add(2 * time.Hour).Unix(),
		TZOffsetMin: 120,
	})
	// +02:00 must show in the rendered timestamp, so a spreadsheet reads
	// the same wall-clock the user saw in the chart.
	if !strings.HasSuffix(rows[0][0], "+02:00") {
		t.Errorf("bin_start = %q, want a +02:00 offset", rows[0][0])
	}
}

func TestExportTurnsIsRawRows(t *testing.T) {
	s := exportStore(t)
	base := time.Date(2026, 7, 23, 10, 0, 0, 0, time.UTC)

	for _, tu := range []TurnUsage{
		{MessageID: "m1", TS: base, SessionID: "s1", ProjectID: "p1", Agent: "claude-code",
			Model: "claude-opus-4-8", InputTokens: 1, OutputTokens: 2, CacheCreation: 3, CacheRead: 4},
		{MessageID: "m2", TS: base.Add(time.Minute), SessionID: "s2", ProjectID: "p2", Agent: "claude-code",
			Model: "claude-sonnet-5", InputTokens: 5, OutputTokens: 6},
	} {
		if _, err := s.InsertTurnUsage(tu); err != nil {
			t.Fatal(err)
		}
	}

	header, rows := readCSV(t, s, ExportParams{
		Dataset: DatasetTurns, Since: base.Add(-time.Hour).Unix(), Until: base.Add(time.Hour).Unix(),
	})
	if header[2] != "message_id" || header[6] != "model" {
		t.Fatalf("header = %v", header)
	}
	if len(rows) != 2 {
		t.Fatalf("rows = %d, want 2 (one per turn, unbinned)", len(rows))
	}
	if rows[0][2] != "m1" || rows[0][6] != "claude-opus-4-8" {
		t.Errorf("row 0 = %v", rows[0])
	}
	// total_tokens is derived, so the CSV is useful without a formula.
	if rows[0][11] != "10" {
		t.Errorf("total_tokens = %q, want 10", rows[0][11])
	}

	// Project filter narrows turns.
	_, filtered := readCSV(t, s, ExportParams{
		Dataset: DatasetTurns, ProjectID: "p2",
		Since: base.Add(-time.Hour).Unix(), Until: base.Add(time.Hour).Unix(),
	})
	if len(filtered) != 1 || filtered[0][2] != "m2" {
		t.Errorf("project filter: got %v", filtered)
	}
}

func TestExportQuotaKeepsSourceAndNulls(t *testing.T) {
	s := exportStore(t)
	base := time.Date(2026, 7, 23, 10, 0, 0, 0, time.UTC)
	reset := base.Add(time.Hour).Unix()

	// A poll and a statusline row, the second with no 7d reading.
	if err := s.InsertQuotaSample(QuotaSample{
		TS: base, Source: "poll",
		FiveHour: Bucket{Pct: f64ptr(86), ResetsAt: &reset},
		SevenDay: Bucket{Pct: f64ptr(24)},
	}); err != nil {
		t.Fatal(err)
	}
	if err := s.InsertQuotaSample(QuotaSample{
		TS: base.Add(time.Minute), Source: "statusline", ReportedBySession: "sess-1",
		FiveHour: Bucket{Pct: f64ptr(87)},
	}); err != nil {
		t.Fatal(err)
	}

	header, rows := readCSV(t, s, ExportParams{
		Dataset: DatasetQuota, Since: base.Add(-time.Hour).Unix(), Until: base.Add(time.Hour).Unix(),
	})
	if header[8] != "source" {
		t.Fatalf("header = %v", header)
	}
	if len(rows) != 2 {
		t.Fatalf("rows = %d, want 2", len(rows))
	}
	// The source column is the whole point: it's what makes a window
	// reset legible instead of inferred.
	if rows[0][8] != "poll" || rows[1][8] != "statusline" {
		t.Errorf("source column = %q/%q", rows[0][8], rows[1][8])
	}
	if rows[0][3] != "1784768400" && rows[0][3] == "" {
		t.Error("five_hour_resets_at should be populated on row 0")
	}
	// Absent readings must be blank, never 0.
	if rows[1][4] != "" {
		t.Errorf("seven_day_pct = %q, want blank for an unreported window", rows[1][4])
	}
	if rows[0][9] != "" || rows[1][9] != "sess-1" {
		t.Errorf("reported_by_session = %q/%q", rows[0][9], rows[1][9])
	}
}

func TestExportRangeIsHalfOpen(t *testing.T) {
	s := exportStore(t)
	base := time.Date(2026, 7, 23, 10, 0, 0, 0, time.UTC)
	for i, ts := range []time.Time{base.Add(-time.Second), base, base.Add(time.Hour)} {
		if err := s.InsertQuotaSample(QuotaSample{
			TS: ts, Source: "poll", FiveHour: Bucket{Pct: f64ptr(float64(i))},
		}); err != nil {
			t.Fatal(err)
		}
	}
	// [base, base+1h) includes base, excludes base+1h.
	_, rows := readCSV(t, s, ExportParams{
		Dataset: DatasetQuota, Since: base.Unix(), Until: base.Add(time.Hour).Unix(),
	})
	if len(rows) != 1 || rows[0][2] != "1" {
		t.Errorf("half-open range: got %v", rows)
	}
}

func TestExportEmptyStoreStillWritesHeader(t *testing.T) {
	// A CSV with no data rows must still be a valid CSV, so a spreadsheet
	// opens it and shows the columns rather than erroring.
	s := exportStore(t)
	base := time.Date(2026, 7, 23, 0, 0, 0, 0, time.UTC)
	for _, ds := range []ExportDataset{DatasetTurns, DatasetQuota} {
		t.Run(string(ds), func(t *testing.T) {
			header, rows := readCSV(t, s, ExportParams{
				Dataset: ds, Since: base.Unix(), Until: base.Add(time.Hour).Unix(),
			})
			if len(header) == 0 {
				t.Error("expected a header row")
			}
			if len(rows) != 0 {
				t.Errorf("rows = %d, want 0", len(rows))
			}
		})
	}
}

func TestExportEscapesAwkwardValues(t *testing.T) {
	// Model/session strings come from external payloads. A comma or quote
	// must not shift every later column by one.
	s := exportStore(t)
	base := time.Date(2026, 7, 23, 10, 0, 0, 0, time.UTC)
	nasty := `weird,"model` + "\n" + `name`
	if _, err := s.InsertTurnUsage(TurnUsage{
		MessageID: "m1", TS: base, SessionID: "s1", ProjectID: "p1",
		Agent: "claude-code", Model: nasty, InputTokens: 1,
	}); err != nil {
		t.Fatal(err)
	}
	_, rows := readCSV(t, s, ExportParams{
		Dataset: DatasetTurns, Since: base.Add(-time.Hour).Unix(), Until: base.Add(time.Hour).Unix(),
	})
	if len(rows) != 1 {
		t.Fatalf("rows = %d, want 1", len(rows))
	}
	if rows[0][6] != nasty {
		t.Errorf("model round-trip = %q, want %q", rows[0][6], nasty)
	}
	if rows[0][7] != "1" {
		t.Errorf("column after the nasty value = %q, want 1 (alignment lost)", rows[0][7])
	}
}

func f64ptr(v float64) *float64 { return &v }
