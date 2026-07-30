package usage

import (
	"database/sql"
	"fmt"
	"math"
	"sort"
	"time"
)

// Burn-rate forecasting for the rate-limit windows.
//
// The Satellite draws three projected lines from "now" to the window's
// reset: a centre and two bounds. All three rates are computed HERE, from
// raw quota_samples, rather than in the renderer from the binned histogram.
// That is the whole point of this file, for three reasons:
//
//   - Bin width stops mattering. A 90-minute trailing window gives the
//     renderer ~18 points at Day/5m but only 3 at Week/30m — too few to fit
//     anything trustworthy. The raw table has ~90 readings for the same span
//     whatever the caller is plotting.
//   - The projection origin is exact. The plotted series is a per-bin MAX()
//     that is then forward-filled, so anchoring a forecast on its last value
//     projects from a peak, and from one up to a bin-width stale.
//   - The wire stays tiny: six numbers per bucket instead of raw rows.
//
// The bounds are NOT a confidence interval and must not be presented as one.
// They are the 10th and 90th percentile of the burn rates this account has
// actually sustained — "if you keep working at your slowest / fastest
// observed pace". The centre is the median of the same sample.

const (
	// forecastPoolDays is how far back the rate sample reaches. A week
	// spans the working rhythm (weekday vs weekend, deep sessions vs
	// triage) without reaching into behaviour that is no longer typical.
	forecastPoolDays = 7

	// forecastHalfLifeDays decays each observation's weight by age, so the
	// current window dominates simply by being the youngest data in the
	// pool and the window before it still counts. One parameter instead of
	// a special case for "the current session".
	forecastHalfLifeDays = 2.0

	// forecastMinSlopes is the fewest active intervals worth fitting. Below
	// this the quantiles are noise wearing a number's clothes, so the
	// forecast is withheld entirely — no line beats a wrong line.
	forecastMinSlopes = 3

	// minSlopeSeconds is the shortest interval a rate may be measured over.
	//
	// This is load-bearing, not a tidiness guard. The ingest gate writes
	// IMMEDIATELY on a jump of DefaultJumpPct (2 points), bypassing its
	// one-minute rate cap — so during a burst two rows land seconds apart
	// with a 2-point delta between them. Divided by a 5-second dt that is
	// 1440 %/hour, and every burst manufactures a fistful of them. They are
	// rising and inside their window, so neither the monotonic filter nor
	// the active filter touches them; they simply swamp the upper quantile
	// and the forecast reads "you hit 100% in twenty minutes" forever.
	//
	// Five minutes is comfortably longer than the jump path can produce and
	// short enough to still resolve a burst.
	minSlopeSeconds = 300

	// maxSlopeSeconds bounds the other end: an interval spanning a long
	// quiet stretch measures the average of working and not working, which
	// is not the "if I keep going" rate being asked for. Beyond this the
	// anchor restarts rather than straddling the gap.
	maxSlopeSeconds = 1800

	fiveHourWindow = 5 * time.Hour
	sevenDayWindow = 7 * 24 * time.Hour
)

// QuotaForecast is the live state of one rate-limit window plus the burn
// rates projected from it. Rates are percentage points per hour.
type QuotaForecast struct {
	// TS is when Pct was observed; Pct is the latest ACTUAL reading, not a
	// bin peak. The caller projects from this point, not from the plotted
	// series' last value.
	TS  int64
	Pct float64

	// ResetsAt is Anthropic-reported and therefore exact. WindowStart is
	// derived as ResetsAt minus the window width rather than by looking for
	// where the series dropped to zero: MAX() binning hides a reset
	// whenever one bin straddles it, so drop-detection is unreliable by
	// construction.
	ResetsAt    int64
	WindowStart int64

	// RateCentre is the median sustained burn rate; RateLow and RateHigh
	// the 10th and 90th percentile. RateLow <= RateCentre <= RateHigh by
	// construction.
	RateCentre float64
	RateLow    float64
	RateHigh   float64
}

// quotaReading is one bucket's slice of a quota_samples row.
type quotaReading struct {
	ts       int64
	pct      float64
	resetsAt int64
}

// QuotaForecasts reports the live 5h and 7d windows with their projected
// burn rates. Either may be nil — meaning "nothing worth drawing" — without
// that being an error: no reading carried an expiry, the newest window has
// already reset (a daemon down for six hours leaves exactly that), or too
// few active intervals survived to fit.
func (s *Store) QuotaForecasts(now time.Time) (fiveHour, sevenDay *QuotaForecast, err error) {
	nowUnix := now.UTC().Unix()
	since := now.UTC().Add(-forecastPoolDays * 24 * time.Hour).Unix()

	s.mu.Lock()
	defer s.mu.Unlock()

	// One query for both buckets. A 7-day pool at the default 1/min poll is
	// ~10k rows; splitting it in two would double the scan to save nothing.
	rows, err := s.db.Query(
		`SELECT ts, five_hour_pct, five_hour_resets_at, seven_day_pct, seven_day_resets_at
		 FROM quota_samples WHERE ts >= ? AND ts <= ? ORDER BY ts ASC, id ASC`,
		since, nowUnix,
	)
	if err != nil {
		return nil, nil, fmt.Errorf("usage: quota forecasts: %w", err)
	}
	defer rows.Close()

	var fh, sd []quotaReading
	for rows.Next() {
		var (
			ts               int64
			fhPct, sdPct     sql.NullFloat64
			fhReset, sdReset sql.NullInt64
		)
		if err := rows.Scan(&ts, &fhPct, &fhReset, &sdPct, &sdReset); err != nil {
			return nil, nil, fmt.Errorf("usage: quota forecasts scan: %w", err)
		}
		// A row needs both halves: a percentage with no expiry can't be
		// attributed to a window, and an expiry with no percentage has
		// nothing to contribute to a rate.
		if fhPct.Valid && fhReset.Valid {
			fh = append(fh, quotaReading{ts: ts, pct: fhPct.Float64, resetsAt: fhReset.Int64})
		}
		if sdPct.Valid && sdReset.Valid {
			sd = append(sd, quotaReading{ts: ts, pct: sdPct.Float64, resetsAt: sdReset.Int64})
		}
	}
	if err := rows.Err(); err != nil {
		return nil, nil, fmt.Errorf("usage: quota forecasts: %w", err)
	}

	return buildForecast(fh, fiveHourWindow, nowUnix),
		buildForecast(sd, sevenDayWindow, nowUnix),
		nil
}

// buildForecast turns one bucket's ascending readings into a forecast, or
// nil when there isn't enough to say anything honest.
func buildForecast(readings []quotaReading, window time.Duration, now int64) *QuotaForecast {
	if len(readings) == 0 {
		return nil
	}
	latest := readings[len(readings)-1]
	// A window that has already reset describes the past. dropExpiredWindows
	// (quota_stale.go) NULLs these at ingest, but a daemon that was offline
	// across a reset leaves the newest STORED row describing a dead window.
	if latest.resetsAt <= now {
		return nil
	}

	slopes := activeSlopes(readings, now)
	if len(slopes) < forecastMinSlopes {
		return nil
	}
	sort.Slice(slopes, func(i, j int) bool { return slopes[i].rate < slopes[j].rate })

	return &QuotaForecast{
		TS:          latest.ts,
		Pct:         latest.pct,
		ResetsAt:    latest.resetsAt,
		WindowStart: latest.resetsAt - int64(window.Seconds()),
		RateLow:     weightedQuantile(slopes, 0.10),
		RateCentre:  weightedQuantile(slopes, 0.50),
		RateHigh:    weightedQuantile(slopes, 0.90),
	}
}

// weightedSlope is one observed burn rate and how much it counts.
type weightedSlope struct {
	rate   float64 // percentage points per hour
	weight float64
}

// activeSlopes derives the burn rates between consecutive readings.
//
// Three filters, each earning its place:
//
//   - Readings are grouped by resets_at, so a slope is never measured
//     ACROSS a reset. Because the grouping is by the window's own identity,
//     a genuine reset can never be mistaken for an anomaly.
//   - Within a window quota is cumulative, so any reading below its
//     window's running maximum is impossible and dropped. That is the
//     stale-cache artifact quota_stale.go documents: Claude Code re-serves
//     the rate_limits block it cached from the session's last API response,
//     which lands as a single tick at the wrong level.
//   - Only rising intervals count. Most intervals over a week are idle, and
//     including them drags the low quantile to ~0 %/h — true (if you stop
//     working, quota stops rising) but useless, since the question being
//     asked is "if I keep working, when do I run out".
func activeSlopes(readings []quotaReading, now int64) []weightedSlope {
	var out []weightedSlope

	for start := 0; start < len(readings); {
		end := start
		for end < len(readings) && readings[end].resetsAt == readings[start].resetsAt {
			end++
		}
		window := readings[start:end]
		start = end

		runningMax := math.Inf(-1)
		var anchor *quotaReading
		for i := range window {
			r := window[i]
			if r.pct < runningMax {
				continue // impossible within a live window: a stale reading
			}
			runningMax = r.pct

			cur := r
			if anchor == nil {
				anchor = &cur
				continue
			}

			// Measure over a bounded interval, never between whichever two
			// rows the write gate happened to emit. Too short and the rate is
			// an artifact of the gate's jump path (see minSlopeSeconds); too
			// long and it averages in the idling between bursts.
			dt := r.ts - anchor.ts
			switch {
			case dt < minSlopeSeconds:
				// Hold the anchor and keep accumulating: the pair is too
				// close together in time to divide by.
			case dt > maxSlopeSeconds:
				// The gap swallowed the interval. Start again from here
				// rather than reporting the average across it.
				anchor = &cur
			default:
				if rate := (r.pct - anchor.pct) / (float64(dt) / 3600); rate > 0 {
					out = append(out, weightedSlope{
						rate:   rate,
						weight: recencyWeight(r.ts, now),
					})
				}
				anchor = &cur
			}
		}
	}
	return out
}

// recencyWeight halves an observation's influence every
// forecastHalfLifeDays. Always positive, so nothing is silently dropped by
// being old — only outvoted.
func recencyWeight(ts, now int64) float64 {
	ageDays := float64(now-ts) / 86400
	if ageDays < 0 {
		ageDays = 0
	}
	return math.Pow(2, -ageDays/forecastHalfLifeDays)
}

// weightedQuantile returns the q-th weighted quantile of `slopes`, which
// MUST already be sorted ascending by rate.
//
// Quantiles rather than the literal min and max the bounds might suggest:
// min and max are the two most outlier-sensitive statistics available, so a
// single bad tick would not merely perturb a bound, it would BECOME one.
func weightedQuantile(slopes []weightedSlope, q float64) float64 {
	if len(slopes) == 0 {
		return 0
	}
	total := 0.0
	for _, s := range slopes {
		total += s.weight
	}
	if total <= 0 {
		return slopes[len(slopes)/2].rate
	}
	target := q * total
	cum := 0.0
	for _, s := range slopes {
		cum += s.weight
		if cum >= target {
			return s.rate
		}
	}
	return slopes[len(slopes)-1].rate
}
