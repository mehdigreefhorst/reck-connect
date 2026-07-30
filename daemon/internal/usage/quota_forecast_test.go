package usage

import (
	"math"
	"testing"
	"time"
)

// reading builds one bucket reading at `minutesAgo` before `now`.
func reading(now int64, minutesAgo int, pct float64, resetsAt int64) quotaReading {
	return quotaReading{ts: now - int64(minutesAgo)*60, pct: pct, resetsAt: resetsAt}
}

// steady builds a run of readings climbing at a constant %/hour inside one
// window, oldest first, ending `endMinutesAgo` before now.
func steady(now int64, resetsAt int64, startPct, ratePerHour float64, n, stepMin, endMinutesAgo int) []quotaReading {
	out := make([]quotaReading, 0, n)
	for i := 0; i < n; i++ {
		minutesAgo := endMinutesAgo + (n-1-i)*stepMin
		out = append(out, quotaReading{
			ts:       now - int64(minutesAgo)*60,
			pct:      startPct + ratePerHour*float64(i*stepMin)/60,
			resetsAt: resetsAt,
		})
	}
	return out
}

func TestBuildForecastAnchorsOnTheLatestActualReading(t *testing.T) {
	now := time.Date(2026, 7, 30, 17, 0, 0, 0, time.UTC).Unix()
	resets := now + int64(2*time.Hour.Seconds())

	// 20 %/h for two hours, sampled every 10 minutes.
	got := buildForecast(steady(now, resets, 20, 20, 13, 10, 0), fiveHourWindow, now)
	if got == nil {
		t.Fatal("buildForecast = nil, want a forecast")
	}
	if got.Pct != 60 {
		t.Errorf("Pct = %v, want 60 (the last actual reading)", got.Pct)
	}
	if got.ResetsAt != resets {
		t.Errorf("ResetsAt = %d, want %d", got.ResetsAt, resets)
	}
	// Window start is derived, never detected: resets_at minus the width.
	if want := resets - int64(fiveHourWindow.Seconds()); got.WindowStart != want {
		t.Errorf("WindowStart = %d, want %d", got.WindowStart, want)
	}
	for _, c := range []struct {
		name string
		rate float64
	}{{"low", got.RateLow}, {"centre", got.RateCentre}, {"high", got.RateHigh}} {
		if math.Abs(c.rate-20) > 0.01 {
			t.Errorf("Rate%s = %v, want ~20 %%/h", c.name, c.rate)
		}
	}
}

func TestBuildForecastOrdersItsBounds(t *testing.T) {
	now := time.Date(2026, 7, 30, 17, 0, 0, 0, time.UTC).Unix()
	resets := now + 3600

	// Alternating fast and slow intervals inside one window.
	rs := []quotaReading{
		reading(now, 100, 0, resets),
		reading(now, 90, 2, resets),  // 12 %/h
		reading(now, 80, 10, resets), // 48 %/h
		reading(now, 70, 12, resets), // 12 %/h
		reading(now, 60, 20, resets), // 48 %/h
		reading(now, 50, 22, resets), // 12 %/h
		reading(now, 40, 31, resets), // 54 %/h
	}
	got := buildForecast(rs, fiveHourWindow, now)
	if got == nil {
		t.Fatal("buildForecast = nil, want a forecast")
	}
	if !(got.RateLow <= got.RateCentre && got.RateCentre <= got.RateHigh) {
		t.Errorf("bounds out of order: low=%v centre=%v high=%v",
			got.RateLow, got.RateCentre, got.RateHigh)
	}
	if got.RateLow == got.RateHigh {
		t.Errorf("bounds collapsed to %v despite a spread of observed rates", got.RateLow)
	}
}

// The headline test: quantiles must shrug off the artifact that min/max
// would adopt as a bound outright.
func TestQuantilesResistASingleWildTick(t *testing.T) {
	now := time.Date(2026, 7, 30, 17, 0, 0, 0, time.UTC).Unix()
	resets := now + 3600

	clean := steady(now, resets, 0, 20, 13, 10, 0)
	base := buildForecast(clean, fiveHourWindow, now)
	if base == nil {
		t.Fatal("clean series produced no forecast")
	}

	// Splice in one absurd jump: +40 points in a single 10-minute step,
	// i.e. 240 %/h — the shape a stale cached rate_limits block produces.
	spiked := make([]quotaReading, len(clean))
	copy(spiked, clean)
	for i := 6; i < len(spiked); i++ {
		spiked[i].pct += 40
	}
	got := buildForecast(spiked, fiveHourWindow, now)
	if got == nil {
		t.Fatal("spiked series produced no forecast")
	}

	// The literal maximum slope IS the artifact. The 90th percentile is not.
	if got.RateHigh > 60 {
		t.Errorf("RateHigh = %v %%/h — the outlier became the bound", got.RateHigh)
	}
	if math.Abs(got.RateCentre-base.RateCentre) > 0.01 {
		t.Errorf("RateCentre moved from %v to %v on one bad tick",
			base.RateCentre, got.RateCentre)
	}
}

func TestActiveSlopesRejectsReadingsBelowTheWindowRunningMax(t *testing.T) {
	now := time.Date(2026, 7, 30, 17, 0, 0, 0, time.UTC).Unix()
	resets := now + 3600

	// A clean climb with one impossible dip: quota is cumulative inside a
	// window, so 8% after 30% cannot have happened.
	rs := []quotaReading{
		reading(now, 60, 10, resets),
		reading(now, 50, 20, resets),
		reading(now, 40, 30, resets),
		reading(now, 30, 8, resets), // stale cached block
		reading(now, 20, 40, resets),
		reading(now, 10, 50, resets),
	}
	slopes := activeSlopes(rs, now)

	// Without the filter the dip yields a huge fake recovery slope
	// (8% -> 40% in 10 min = 192 %/h). Every real interval here is 60 %/h.
	for _, s := range slopes {
		if s.rate > 100 {
			t.Errorf("slope %v %%/h survived — the dip was not rejected", s.rate)
		}
	}
	if len(slopes) < forecastMinSlopes {
		t.Fatalf("got %d slopes, want at least %d", len(slopes), forecastMinSlopes)
	}
}

func TestActiveSlopesNeverMeasuresAcrossAReset(t *testing.T) {
	now := time.Date(2026, 7, 30, 17, 0, 0, 0, time.UTC).Unix()
	oldWindow := now - 1800
	newWindow := now + 16200

	// A window ending at 90%, then a fresh one starting at 2%. Grouping by
	// resets_at means the 90 -> 2 drop is never seen as an interval at all,
	// so a real reset can't be mistaken for an anomaly.
	rs := []quotaReading{
		reading(now, 70, 70, oldWindow),
		reading(now, 60, 80, oldWindow),
		reading(now, 50, 90, oldWindow),
		reading(now, 40, 2, newWindow),
		reading(now, 30, 12, newWindow),
		reading(now, 20, 22, newWindow),
	}
	for _, s := range activeSlopes(rs, now) {
		if s.rate < 0 {
			t.Errorf("negative slope %v — a reset was measured as an interval", s.rate)
		}
		if s.rate > 100 {
			t.Errorf("slope %v %%/h — a cross-window interval leaked in", s.rate)
		}
	}
}

func TestActiveSlopesExcludesIdleIntervals(t *testing.T) {
	now := time.Date(2026, 7, 30, 17, 0, 0, 0, time.UTC).Unix()
	resets := now + 3600

	// Two hours of genuine idling around one burst of work. Counting the
	// flat intervals would drag the low quantile to 0 %/h — technically
	// true, but it answers "what if I stop", not "what if I keep going".
	rs := []quotaReading{
		reading(now, 180, 10, resets),
		reading(now, 150, 10, resets),
		reading(now, 120, 10, resets),
		reading(now, 90, 10, resets),
		reading(now, 60, 30, resets),
		reading(now, 50, 40, resets),
		reading(now, 40, 50, resets),
	}
	for _, s := range activeSlopes(rs, now) {
		if s.rate <= 0 {
			t.Errorf("idle interval kept as slope %v", s.rate)
		}
	}
	if got := len(activeSlopes(rs, now)); got != 3 {
		t.Errorf("got %d active slopes, want 3 (the rising intervals only)", got)
	}
}

func TestRecencyWeightHalvesEveryHalfLife(t *testing.T) {
	now := time.Date(2026, 7, 30, 17, 0, 0, 0, time.UTC).Unix()

	if w := recencyWeight(now, now); math.Abs(w-1) > 1e-9 {
		t.Errorf("weight now = %v, want 1", w)
	}
	if w := recencyWeight(now-int64(forecastHalfLifeDays*86400), now); math.Abs(w-0.5) > 1e-9 {
		t.Errorf("weight at one half-life = %v, want 0.5", w)
	}
	// The current window outweighs the same behaviour a week ago, which is
	// what makes "weight the current session higher" fall out of one
	// parameter instead of a special case.
	if recencyWeight(now-600, now) <= recencyWeight(now-6*86400, now) {
		t.Error("a 10-minute-old observation must outweigh a 6-day-old one")
	}
}

func TestRecencyWeightingPullsTheCentreTowardCurrentBehaviour(t *testing.T) {
	now := time.Date(2026, 7, 30, 17, 0, 0, 0, time.UTC).Unix()
	resets := now + 3600
	oldWindow := now - 5*86400

	var rs []quotaReading
	// Five days ago: a long, slow 6 %/h stretch (many samples).
	for i := 0; i < 12; i++ {
		rs = append(rs, quotaReading{
			ts:       now - 5*86400 + int64(i)*600,
			pct:      float64(i) * 1,
			resetsAt: oldWindow,
		})
	}
	// Right now: a short, fast 60 %/h burst (few samples).
	for i := 0; i < 5; i++ {
		rs = append(rs, quotaReading{
			ts:       now - int64(40-i*10)*60,
			pct:      float64(i) * 10,
			resetsAt: resets,
		})
	}

	got := buildForecast(rs, fiveHourWindow, now)
	if got == nil {
		t.Fatal("buildForecast = nil")
	}
	// Unweighted, the 11 stale slow slopes would outvote the 4 fresh fast
	// ones and drag the median to 6 %/h.
	if got.RateCentre < 30 {
		t.Errorf("RateCentre = %v %%/h — stale behaviour outvoted the live window", got.RateCentre)
	}
}

func TestBuildForecastWithholdsWhenItCannotBeHonest(t *testing.T) {
	now := time.Date(2026, 7, 30, 17, 0, 0, 0, time.UTC).Unix()
	resets := now + 3600

	tests := []struct {
		name     string
		readings []quotaReading
	}{
		{"no readings at all", nil},
		{
			// A daemon offline across a reset leaves the newest STORED row
			// describing a window that is already over.
			name:     "the newest window has already reset",
			readings: steady(now, now-60, 0, 20, 13, 10, 0),
		},
		{
			name: "too few active intervals to fit",
			readings: []quotaReading{
				reading(now, 30, 10, resets),
				reading(now, 20, 20, resets),
			},
		},
		{
			name: "readings exist but nothing was ever burned",
			readings: []quotaReading{
				reading(now, 40, 10, resets),
				reading(now, 30, 10, resets),
				reading(now, 20, 10, resets),
				reading(now, 10, 10, resets),
			},
		},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := buildForecast(tc.readings, fiveHourWindow, now); got != nil {
				t.Errorf("buildForecast = %+v, want nil", got)
			}
		})
	}
}

func TestWeightedQuantileEdges(t *testing.T) {
	s := []weightedSlope{
		{rate: 10, weight: 1},
		{rate: 20, weight: 1},
		{rate: 30, weight: 1},
	}
	if got := weightedQuantile(s, 0.5); got != 20 {
		t.Errorf("median = %v, want 20", got)
	}
	if got := weightedQuantile(s, 0); got != 10 {
		t.Errorf("q0 = %v, want 10", got)
	}
	if got := weightedQuantile(s, 1); got != 30 {
		t.Errorf("q1 = %v, want 30", got)
	}
	if got := weightedQuantile(nil, 0.5); got != 0 {
		t.Errorf("empty = %v, want 0", got)
	}
}

func TestQuotaForecastsEndToEnd(t *testing.T) {
	s := newPlanStore(t)
	now := time.Now().UTC().Truncate(time.Second)
	fhReset := now.Add(2 * time.Hour).Unix()
	sdReset := now.Add(72 * time.Hour).Unix()

	for i := 0; i < 13; i++ {
		ts := now.Add(-time.Duration(120-i*10) * time.Minute)
		fh := float64(i) * 5   // 30 %/h
		sd := float64(i) * 0.5 // 3 %/h
		if err := s.InsertQuotaSample(QuotaSample{
			TS:       ts,
			FiveHour: Bucket{Pct: &fh, ResetsAt: &fhReset},
			SevenDay: Bucket{Pct: &sd, ResetsAt: &sdReset},
			Source:   "poll",
		}); err != nil {
			t.Fatalf("insert: %v", err)
		}
	}

	gotFH, gotSD, err := s.QuotaForecasts(now)
	if err != nil {
		t.Fatalf("QuotaForecasts: %v", err)
	}
	if gotFH == nil || gotSD == nil {
		t.Fatalf("got (%v, %v), want both buckets", gotFH, gotSD)
	}
	if math.Abs(gotFH.RateCentre-30) > 0.01 {
		t.Errorf("5h RateCentre = %v, want ~30 %%/h", gotFH.RateCentre)
	}
	if math.Abs(gotSD.RateCentre-3) > 0.01 {
		t.Errorf("7d RateCentre = %v, want ~3 %%/h", gotSD.RateCentre)
	}
	// The two buckets carry their own window widths.
	if want := fhReset - int64(fiveHourWindow.Seconds()); gotFH.WindowStart != want {
		t.Errorf("5h WindowStart = %d, want %d", gotFH.WindowStart, want)
	}
	if want := sdReset - int64(sevenDayWindow.Seconds()); gotSD.WindowStart != want {
		t.Errorf("7d WindowStart = %d, want %d", gotSD.WindowStart, want)
	}
}

func TestQuotaForecastsEmptyStore(t *testing.T) {
	s := newPlanStore(t)
	fh, sd, err := s.QuotaForecasts(time.Now().UTC())
	if err != nil {
		t.Fatalf("QuotaForecasts on empty store: %v", err)
	}
	if fh != nil || sd != nil {
		t.Errorf("got (%v, %v), want (nil, nil)", fh, sd)
	}
}
