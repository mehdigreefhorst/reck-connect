// User-adjustable quota polling settings, persisted in the store's
// settings table so a choice survives a daemon restart.
//
// The logic lives here rather than in main.go for the reason main.go has
// almost no tests: resolution has real rules (stored beats flag, out-of-
// range is clamped rather than rejected, "off" is a state not an error) and
// those rules deserve to be exercised directly.

package usage

import (
	"fmt"
	"strconv"
	"strings"
	"time"
)

// Setting keys. Namespaced by subsystem so the table stays legible as
// other settings arrive.
const (
	SettingQuotaPollEnabled     = "quota_poll_enabled"
	SettingQuotaPollIntervalSec = "quota_poll_interval_sec"
)

// Bounds on the poll interval. The floor exists because the endpoint is
// Anthropic's, not ours: five seconds is fast enough to watch a window
// reset happen live, and is the point past which we would be generating
// load with no new information behind it — the quota moves when Claude is
// used, not when we look at it. The ceiling is a day, past which "polling"
// stops meaning anything.
const (
	MinQuotaPollInterval = 5 * time.Second
	MaxQuotaPollInterval = 24 * time.Hour
)

// PollSettings is the user's quota-polling choice. Enabled is kept
// separate from Interval so turning polling off and back on restores the
// interval they picked rather than resetting it to a default.
type PollSettings struct {
	Enabled  bool
	Interval time.Duration
}

// Effective is the interval to hand RunQuotaPoller: zero when polling is
// off, reusing the runner's established "<= 0 means don't poll" encoding
// rather than introducing a second way to say the same thing.
func (p PollSettings) Effective() time.Duration {
	if !p.Enabled {
		return 0
	}
	return p.Interval
}

// ClampPollInterval brings a requested interval inside the supported
// range. Deliberately clamps rather than erroring: a slider that silently
// refuses is worse than one that visibly stops, and the caller echoes the
// accepted value back so the UI can show what actually took effect.
func ClampPollInterval(d time.Duration) time.Duration {
	switch {
	case d < MinQuotaPollInterval:
		return MinQuotaPollInterval
	case d > MaxQuotaPollInterval:
		return MaxQuotaPollInterval
	default:
		return d
	}
}

// settingReader is the slice of Store that LoadPollSettings needs, so
// tests can supply a fake instead of a database.
type settingReader interface {
	Setting(key string) (string, bool, error)
}

// settingWriter is the equivalent for SavePollSettings.
type settingWriter interface {
	SetSetting(key, value string) error
}

// LoadPollSettings reads the stored choice, falling back to fallback for
// anything absent or unparseable.
//
// Precedence is stored-over-flag: --usage-poll-interval seeds a station
// that has never had the setting touched, and stops mattering the moment
// someone sets it from the UI. A station whose flag and stored value
// disagree is not a conflict to resolve — it means the user changed their
// mind after install, and the later choice wins.
func LoadPollSettings(store settingReader, fallback time.Duration) PollSettings {
	s := PollSettings{Enabled: true, Interval: ClampPollInterval(fallback)}
	if store == nil {
		return s
	}
	if raw, ok, err := store.Setting(SettingQuotaPollIntervalSec); err == nil && ok {
		if sec, err := strconv.Atoi(strings.TrimSpace(raw)); err == nil && sec > 0 {
			s.Interval = ClampPollInterval(time.Duration(sec) * time.Second)
		}
	}
	if raw, ok, err := store.Setting(SettingQuotaPollEnabled); err == nil && ok {
		if enabled, err := strconv.ParseBool(strings.TrimSpace(raw)); err == nil {
			s.Enabled = enabled
		}
	}
	return s
}

// SavePollSettings persists the choice, clamping the interval first so
// what is stored is what will actually run.
func SavePollSettings(store settingWriter, s PollSettings) (PollSettings, error) {
	if store == nil {
		return s, fmt.Errorf("usage: no store to save poll settings to")
	}
	s.Interval = ClampPollInterval(s.Interval)
	sec := int(s.Interval / time.Second)
	if err := store.SetSetting(SettingQuotaPollIntervalSec, strconv.Itoa(sec)); err != nil {
		return s, err
	}
	if err := store.SetSetting(SettingQuotaPollEnabled, strconv.FormatBool(s.Enabled)); err != nil {
		return s, err
	}
	return s, nil
}
