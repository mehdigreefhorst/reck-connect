package usage

import (
	"errors"
	"testing"
	"time"
)

// fakeSettings is an in-memory stand-in for the store's settings table.
type fakeSettings struct {
	vals map[string]string
	err  error
}

func newFakeSettings() *fakeSettings { return &fakeSettings{vals: map[string]string{}} }

func (f *fakeSettings) Setting(key string) (string, bool, error) {
	if f.err != nil {
		return "", false, f.err
	}
	v, ok := f.vals[key]
	return v, ok, nil
}

func (f *fakeSettings) SetSetting(key, value string) error {
	if f.err != nil {
		return f.err
	}
	f.vals[key] = value
	return nil
}

func TestClampPollInterval(t *testing.T) {
	tests := []struct {
		name string
		in   time.Duration
		want time.Duration
	}{
		{"below the floor", time.Second, MinQuotaPollInterval},
		{"zero", 0, MinQuotaPollInterval},
		{"negative", -time.Hour, MinQuotaPollInterval},
		{"at the floor", MinQuotaPollInterval, MinQuotaPollInterval},
		{"in range", time.Minute, time.Minute},
		{"at the ceiling", MaxQuotaPollInterval, MaxQuotaPollInterval},
		{"above the ceiling", 48 * time.Hour, MaxQuotaPollInterval},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			if got := ClampPollInterval(tc.in); got != tc.want {
				t.Errorf("ClampPollInterval(%v) = %v, want %v", tc.in, got, tc.want)
			}
		})
	}
}

func TestPollSettingsEffective(t *testing.T) {
	// Disabled has to collapse to the runner's existing "<= 0 means off"
	// encoding, not a second convention it would have to learn.
	if got := (PollSettings{Enabled: false, Interval: time.Minute}).Effective(); got != 0 {
		t.Errorf("disabled Effective() = %v, want 0", got)
	}
	if got := (PollSettings{Enabled: true, Interval: 30 * time.Second}).Effective(); got != 30*time.Second {
		t.Errorf("enabled Effective() = %v, want 30s", got)
	}
}

func TestLoadPollSettingsFallsBackWhenUnset(t *testing.T) {
	// A station nobody has configured runs the flag/default, polling on.
	got := LoadPollSettings(newFakeSettings(), 2*time.Minute)
	if !got.Enabled || got.Interval != 2*time.Minute {
		t.Errorf("got %+v, want {Enabled:true Interval:2m}", got)
	}
}

func TestLoadPollSettingsStoredWins(t *testing.T) {
	// The saved choice beats the flag: the flag seeds a station that has
	// never been configured, and stops mattering once someone chooses.
	s := newFakeSettings()
	s.vals[SettingQuotaPollIntervalSec] = "30"
	s.vals[SettingQuotaPollEnabled] = "false"

	got := LoadPollSettings(s, time.Hour)
	if got.Enabled {
		t.Error("Enabled = true, want false from the stored value")
	}
	if got.Interval != 30*time.Second {
		t.Errorf("Interval = %v, want 30s from the stored value", got.Interval)
	}
	if got.Effective() != 0 {
		t.Errorf("Effective() = %v, want 0 while disabled", got.Effective())
	}
}

func TestLoadPollSettingsIgnoresJunk(t *testing.T) {
	// A hand-edited or half-written row must not take the poller down; it
	// falls back to the default rather than parking at some absurd value.
	tests := []struct {
		name     string
		interval string
		enabled  string
	}{
		{"unparseable interval", "not-a-number", "true"},
		{"empty interval", "", "true"},
		{"zero interval", "0", "true"},
		{"negative interval", "-30", "true"},
		{"unparseable enabled", "60", "maybe"},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			s := newFakeSettings()
			s.vals[SettingQuotaPollIntervalSec] = tc.interval
			s.vals[SettingQuotaPollEnabled] = tc.enabled

			got := LoadPollSettings(s, time.Minute)
			if !got.Enabled {
				t.Error("Enabled = false, want the default true")
			}
			if got.Interval < MinQuotaPollInterval || got.Interval > MaxQuotaPollInterval {
				t.Errorf("Interval = %v, want something inside the supported range", got.Interval)
			}
		})
	}
}

func TestLoadPollSettingsClampsStoredValue(t *testing.T) {
	// A value that predates a bounds change (or arrived some other way)
	// still has to produce a runnable interval.
	s := newFakeSettings()
	s.vals[SettingQuotaPollIntervalSec] = "1"
	if got := LoadPollSettings(s, time.Minute); got.Interval != MinQuotaPollInterval {
		t.Errorf("Interval = %v, want the floor %v", got.Interval, MinQuotaPollInterval)
	}
}

func TestLoadPollSettingsToleratesReadFailure(t *testing.T) {
	s := newFakeSettings()
	s.err = errors.New("db is gone")
	if got := LoadPollSettings(s, time.Minute); !got.Enabled || got.Interval != time.Minute {
		t.Errorf("got %+v, want the fallback when the store errors", got)
	}
	if got := LoadPollSettings(nil, time.Minute); !got.Enabled || got.Interval != time.Minute {
		t.Errorf("got %+v, want the fallback for a nil store", got)
	}
}

func TestSavePollSettingsClampsAndEchoes(t *testing.T) {
	s := newFakeSettings()
	saved, err := SavePollSettings(s, PollSettings{Enabled: true, Interval: time.Second})
	if err != nil {
		t.Fatalf("SavePollSettings: %v", err)
	}
	// What comes back is what will actually run, so the UI can show it.
	if saved.Interval != MinQuotaPollInterval {
		t.Errorf("saved.Interval = %v, want the floor %v", saved.Interval, MinQuotaPollInterval)
	}
	if s.vals[SettingQuotaPollIntervalSec] != "5" {
		t.Errorf("stored interval = %q, want the clamped 5", s.vals[SettingQuotaPollIntervalSec])
	}
	if s.vals[SettingQuotaPollEnabled] != "true" {
		t.Errorf("stored enabled = %q, want true", s.vals[SettingQuotaPollEnabled])
	}
}

func TestSavePollSettingsKeepsIntervalWhileDisabled(t *testing.T) {
	// Turning polling off must not forget the period, or turning it back
	// on would silently reset to a default the user didn't pick.
	s := newFakeSettings()
	if _, err := SavePollSettings(s, PollSettings{Enabled: false, Interval: 90 * time.Second}); err != nil {
		t.Fatalf("SavePollSettings: %v", err)
	}
	got := LoadPollSettings(s, time.Minute)
	if got.Enabled {
		t.Error("Enabled = true, want false")
	}
	if got.Interval != 90*time.Second {
		t.Errorf("Interval = %v, want the 90s that was saved alongside off", got.Interval)
	}
}

func TestPollSettingsSurviveReopen(t *testing.T) {
	// The point of the whole feature: the choice outlives the daemon.
	dir := t.TempDir()
	store, err := Open(dir)
	if err != nil {
		t.Fatalf("Open: %v", err)
	}
	if _, err := SavePollSettings(store, PollSettings{Enabled: true, Interval: 30 * time.Second}); err != nil {
		t.Fatalf("SavePollSettings: %v", err)
	}
	if err := store.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	reopened, err := Open(dir)
	if err != nil {
		t.Fatalf("reopen: %v", err)
	}
	t.Cleanup(func() { _ = reopened.Close() })

	got := LoadPollSettings(reopened, time.Hour)
	if !got.Enabled || got.Interval != 30*time.Second {
		t.Errorf("after reopen got %+v, want {Enabled:true Interval:30s}", got)
	}
}

func TestStoreSettingRoundTrip(t *testing.T) {
	store := openTestStore(t)

	if _, ok, err := store.Setting("nope"); err != nil || ok {
		t.Errorf("missing key: ok=%v err=%v, want false/nil", ok, err)
	}
	if err := store.SetSetting("k", "v1"); err != nil {
		t.Fatalf("SetSetting: %v", err)
	}
	if v, ok, err := store.Setting("k"); err != nil || !ok || v != "v1" {
		t.Errorf("got %q/%v/%v, want v1/true/nil", v, ok, err)
	}
	// Upsert, not a second row.
	if err := store.SetSetting("k", "v2"); err != nil {
		t.Fatalf("SetSetting overwrite: %v", err)
	}
	if v, _, _ := store.Setting("k"); v != "v2" {
		t.Errorf("got %q, want v2 after overwrite", v)
	}
	if err := store.SetSetting("", "x"); err == nil {
		t.Error("empty key should be rejected")
	}
}
