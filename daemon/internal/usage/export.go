package usage

import (
	"encoding/csv"
	"fmt"
	"io"
	"strconv"
	"time"
)

// CSV export of the usage store, for the Satellite's download button.
//
// Three datasets, because "the usage data" means different things
// depending on what you're doing with it:
//
//	binned — exactly what the chart plots: one row per bin, token sums
//	         plus the quota peaks inside that bin. What you want to hand
//	         to a spreadsheet or paste into a report.
//	turns  — the authoritative per-turn rows behind those sums, one per
//	         message_id, with session/model attribution. What you want
//	         when a bin looks wrong and you need to see what made it.
//	quota  — every 5h/7d reading, polled and statusline alike. What you
//	         want to see a window reset actually happen rather than
//	         inferring it from a binned peak.
//
// Timestamps are emitted twice per row: an ISO-8601 local time (so a
// spreadsheet parses it and a human can read it) and the raw unix
// seconds (so nothing is lost to formatting). Local means the CALLER's
// offset, matching how bins are aligned.

// ExportDataset selects which table the export draws from.
type ExportDataset string

const (
	DatasetBinned ExportDataset = "binned"
	DatasetTurns  ExportDataset = "turns"
	DatasetQuota  ExportDataset = "quota"
)

// maxExportRows bounds a single export so a pathological range can't
// stream forever. Far above any real ask: a year of 5-minute polling is
// ~105k quota rows.
const maxExportRows = 1_000_000

// ExportParams selects the dataset, range, and (for binned) bin width.
// Since/Until are unix seconds, half-open [Since, Until).
type ExportParams struct {
	Dataset     ExportDataset
	Since       int64
	Until       int64
	Bucket      HistogramBucket // binned only
	ProjectID   string          // binned + turns; quota is account-level
	TZOffsetMin int
}

// Validate checks the dataset, range, and tz offset up front so the HTTP
// handler can map caller mistakes to 400s.
func (p ExportParams) Validate() error {
	switch p.Dataset {
	case DatasetBinned:
		// Bucket grammar and bin-count cap are the histogram's rules.
		return HistogramParams{
			Bucket: p.Bucket, Since: p.Since, Until: p.Until,
			ProjectID: p.ProjectID, TZOffsetMin: p.TZOffsetMin,
		}.Validate()
	case DatasetTurns, DatasetQuota:
	default:
		return fmt.Errorf("usage: export: unknown dataset %q (want binned, turns, or quota)", p.Dataset)
	}
	if p.Since <= 0 || p.Until <= 0 || p.Since >= p.Until {
		return fmt.Errorf("usage: export: invalid range [%d, %d)", p.Since, p.Until)
	}
	if p.TZOffsetMin < -14*60 || p.TZOffsetMin > 14*60 {
		return fmt.Errorf("usage: export: invalid tz offset %d", p.TZOffsetMin)
	}
	return nil
}

// Filename is the suggested download name, e.g.
// "reck-usage-binned-2026-07-23_2026-07-24.csv". Derived server-side so
// the name always matches the data actually exported.
func (p ExportParams) Filename() string {
	loc := time.FixedZone("caller", p.TZOffsetMin*60)
	from := time.Unix(p.Since, 0).In(loc).Format("2006-01-02")
	to := time.Unix(p.Until, 0).In(loc).Format("2006-01-02")
	if p.Dataset == DatasetBinned && p.Bucket != "" {
		return fmt.Sprintf("reck-usage-binned-%s-%s_%s.csv", p.Bucket, from, to)
	}
	return fmt.Sprintf("reck-usage-%s-%s_%s.csv", p.Dataset, from, to)
}

// ExportCSV streams the selected dataset as CSV, header row first, and
// reports how many data rows were written.
//
// The store mutex is held for the duration: this is a low-rate,
// operator-initiated export against a local database, and streaming
// beats buffering an unbounded result set in memory.
func (s *Store) ExportCSV(w io.Writer, p ExportParams) (int, error) {
	if err := p.Validate(); err != nil {
		return 0, err
	}
	cw := csv.NewWriter(w)
	defer cw.Flush()

	switch p.Dataset {
	case DatasetBinned:
		return s.exportBinned(cw, p)
	case DatasetTurns:
		return s.exportTurns(cw, p)
	default:
		return s.exportQuota(cw, p)
	}
}

// localISO renders a unix timestamp in the caller's offset. Seconds
// precision — sub-second detail is noise in a usage export.
func localISO(unix int64, tzOffsetMin int) string {
	return time.Unix(unix, 0).In(time.FixedZone("caller", tzOffsetMin*60)).Format(time.RFC3339)
}

func f64s(v float64) string { return strconv.FormatFloat(v, 'f', -1, 64) }

// nullableF renders a *float64 as a number or an empty cell. Empty, not
// 0 — a window Anthropic didn't report is absent, not zero usage.
func nullableF(p *float64) string {
	if p == nil {
		return ""
	}
	return f64s(*p)
}

func nullableI(p *int64) string {
	if p == nil {
		return ""
	}
	return strconv.FormatInt(*p, 10)
}

// exportBinned writes the plotted series: the histogram plus the plan in
// force on each bin's local day.
func (s *Store) exportBinned(cw *csv.Writer, p ExportParams) (int, error) {
	hp := HistogramParams{
		Bucket: p.Bucket, Since: p.Since, Until: p.Until,
		ProjectID: p.ProjectID, TZOffsetMin: p.TZOffsetMin,
	}
	bins, err := s.Histogram(hp)
	if err != nil {
		return 0, err
	}
	// Plan is day-granular regardless of bin width, so map each bin onto
	// its local day rather than asking per bin.
	days, err := s.PlanDays(p.Since, p.Until, p.TZOffsetMin)
	if err != nil {
		return 0, err
	}
	planByDay := make(map[int64]string, len(days))
	for _, d := range days {
		planByDay[d.Day] = d.Subscription
	}
	off := int64(p.TZOffsetMin) * 60

	if err := cw.Write([]string{
		"bin_start", "bin_start_unix", "input_tokens", "output_tokens",
		"cache_creation_tokens", "cache_read_tokens", "total_tokens", "turns",
		"five_hour_peak_pct", "seven_day_peak_pct", "plan",
	}); err != nil {
		return 0, err
	}

	n := 0
	for _, b := range bins {
		dayStart := ((b.T+off)/86400)*86400 - off
		plan := planByDay[dayStart]
		if plan == "" {
			plan = PlanUnknown
		}
		if err := cw.Write([]string{
			localISO(b.T, p.TZOffsetMin),
			strconv.FormatInt(b.T, 10),
			strconv.FormatInt(b.Input, 10),
			strconv.FormatInt(b.Output, 10),
			strconv.FormatInt(b.CacheCreation, 10),
			strconv.FormatInt(b.CacheRead, 10),
			strconv.FormatInt(b.Total, 10),
			strconv.FormatInt(b.Turns, 10),
			nullableF(b.FiveHourPeak),
			nullableF(b.SevenDayPeak),
			plan,
		}); err != nil {
			return n, err
		}
		n++
	}
	return n, cw.Error()
}

// exportTurns writes the authoritative per-turn rows behind the sums.
func (s *Store) exportTurns(cw *csv.Writer, p ExportParams) (int, error) {
	if err := cw.Write([]string{
		"ts", "ts_unix", "message_id", "session_id", "project_id", "agent", "model",
		"input_tokens", "output_tokens", "cache_creation_tokens", "cache_read_tokens",
		"total_tokens",
	}); err != nil {
		return 0, err
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	q := `SELECT ts, message_id, session_id, project_id, agent, model,
	             input_tokens, output_tokens, cache_creation, cache_read
	      FROM turn_usage WHERE ts >= ? AND ts < ?`
	args := []any{p.Since, p.Until}
	if p.ProjectID != "" {
		q += ` AND project_id = ?`
		args = append(args, p.ProjectID)
	}
	q += ` ORDER BY ts ASC, message_id ASC LIMIT ?`
	args = append(args, maxExportRows)

	rows, err := s.db.Query(q, args...)
	if err != nil {
		return 0, fmt.Errorf("usage: export turns: %w", err)
	}
	defer rows.Close()

	n := 0
	for rows.Next() {
		var (
			ts                              int64
			msgID, sess, proj, agent, model string
			in, out, cc, cr                 int64
		)
		if err := rows.Scan(&ts, &msgID, &sess, &proj, &agent, &model, &in, &out, &cc, &cr); err != nil {
			return n, fmt.Errorf("usage: export turns scan: %w", err)
		}
		if err := cw.Write([]string{
			localISO(ts, p.TZOffsetMin), strconv.FormatInt(ts, 10),
			msgID, sess, proj, agent, model,
			strconv.FormatInt(in, 10), strconv.FormatInt(out, 10),
			strconv.FormatInt(cc, 10), strconv.FormatInt(cr, 10),
			strconv.FormatInt(in+out+cc+cr, 10),
		}); err != nil {
			return n, err
		}
		n++
	}
	if err := rows.Err(); err != nil {
		return n, fmt.Errorf("usage: export turns: %w", err)
	}
	return n, cw.Error()
}

// exportQuota writes every quota reading in range. `source` distinguishes
// a timer poll from a statusline render — the column that makes a window
// reset legible rather than inferred.
func (s *Store) exportQuota(cw *csv.Writer, p ExportParams) (int, error) {
	if err := cw.Write([]string{
		"ts", "ts_unix",
		"five_hour_pct", "five_hour_resets_at",
		"seven_day_pct", "seven_day_resets_at",
		"seven_day_opus_pct", "seven_day_sonnet_pct",
		"source", "reported_by_session", "model_family",
	}); err != nil {
		return 0, err
	}

	s.mu.Lock()
	defer s.mu.Unlock()

	rows, err := s.db.Query(`
		SELECT ts, five_hour_pct, five_hour_resets_at,
		       seven_day_pct, seven_day_resets_at,
		       seven_day_opus_pct, seven_day_sonnet_pct,
		       source, reported_by_session, model_family
		FROM quota_samples WHERE ts >= ? AND ts < ?
		ORDER BY ts ASC, id ASC LIMIT ?`, p.Since, p.Until, maxExportRows)
	if err != nil {
		return 0, fmt.Errorf("usage: export quota: %w", err)
	}
	defer rows.Close()

	n := 0
	for rows.Next() {
		var (
			ts                      int64
			fhPct, sdPct            *float64
			opusPct, sonnetPct      *float64
			fhReset, sdReset        *int64
			source, session, family string
		)
		if err := rows.Scan(&ts, &fhPct, &fhReset, &sdPct, &sdReset,
			&opusPct, &sonnetPct, &source, &session, &family); err != nil {
			return n, fmt.Errorf("usage: export quota scan: %w", err)
		}
		if err := cw.Write([]string{
			localISO(ts, p.TZOffsetMin), strconv.FormatInt(ts, 10),
			nullableF(fhPct), nullableI(fhReset),
			nullableF(sdPct), nullableI(sdReset),
			nullableF(opusPct), nullableF(sonnetPct),
			source, session, family,
		}); err != nil {
			return n, err
		}
		n++
	}
	if err := rows.Err(); err != nil {
		return n, fmt.Errorf("usage: export quota: %w", err)
	}
	return n, cw.Error()
}
