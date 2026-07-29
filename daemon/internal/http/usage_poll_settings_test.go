package http

import (
	"bytes"
	"encoding/json"
	"io"
	nethttp "net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/rudie-verweij/reck-connect/daemon/internal/usage"
)

// pollWire mirrors only the fields under test, like the other usage wire
// structs in this package.
type pollWire struct {
	Enabled     bool `json:"enabled"`
	IntervalSec int  `json:"interval_sec"`
	MinSec      int  `json:"min_interval_sec"`
	MaxSec      int  `json:"max_interval_sec"`
}

// putPollSettings PUTs a body and returns the status plus decoded response.
func putPollSettings(t *testing.T, url string, body string) (int, pollWire) {
	t.Helper()
	req, err := nethttp.NewRequest(nethttp.MethodPut, url, bytes.NewBufferString(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	resp, err := nethttp.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	raw, _ := io.ReadAll(resp.Body)
	resp.Body.Close()

	var out pollWire
	if resp.StatusCode == 200 {
		if err := json.Unmarshal(raw, &out); err != nil {
			t.Fatalf("PUT %s: parse: %v\n%s", url, err, raw)
		}
	}
	return resp.StatusCode, out
}

func TestPollSettingsDefaultsBeforeAnyoneChooses(t *testing.T) {
	srv, _ := planTestServer(t)

	var got pollWire
	getJSON(t, srv.URL+"/usage/poll-settings", &got)
	if !got.Enabled {
		t.Error("enabled = false, want polling on by default")
	}
	if want := int(usage.DefaultQuotaPollInterval / time.Second); got.IntervalSec != want {
		t.Errorf("interval_sec = %d, want the default %d", got.IntervalSec, want)
	}
	// The bounds ride along so the client validates against the daemon's
	// real clamp instead of keeping its own copy of the numbers.
	if got.MinSec != int(usage.MinQuotaPollInterval/time.Second) {
		t.Errorf("min_interval_sec = %d, want %d", got.MinSec, int(usage.MinQuotaPollInterval/time.Second))
	}
	if got.MaxSec != int(usage.MaxQuotaPollInterval/time.Second) {
		t.Errorf("max_interval_sec = %d, want %d", got.MaxSec, int(usage.MaxQuotaPollInterval/time.Second))
	}
}

func TestPollSettingsPersistThroughHTTP(t *testing.T) {
	srv, store := planTestServer(t)

	status, put := putPollSettings(t, srv.URL+"/usage/poll-settings", `{"enabled":true,"interval_sec":30}`)
	if status != 200 {
		t.Fatalf("PUT status = %d, want 200", status)
	}
	if put.IntervalSec != 30 || !put.Enabled {
		t.Errorf("PUT echoed %+v, want enabled with 30s", put)
	}

	// Readable again over HTTP...
	var got pollWire
	getJSON(t, srv.URL+"/usage/poll-settings", &got)
	if got.IntervalSec != 30 || !got.Enabled {
		t.Errorf("GET after PUT = %+v, want enabled with 30s", got)
	}

	// ...and actually on disk, not just in memory.
	if persisted := usage.LoadPollSettings(store, usage.DefaultQuotaPollInterval); persisted.Interval != 30*time.Second {
		t.Errorf("persisted interval = %v, want 30s", persisted.Interval)
	}
}

func TestPollSettingsClampsRatherThanRejects(t *testing.T) {
	srv, _ := planTestServer(t)

	// One second is below the floor: accepted, clamped, and the accepted
	// value comes back so the UI can show what took effect.
	status, put := putPollSettings(t, srv.URL+"/usage/poll-settings", `{"enabled":true,"interval_sec":1}`)
	if status != 200 {
		t.Fatalf("PUT status = %d, want 200 (clamp, don't reject)", status)
	}
	if want := int(usage.MinQuotaPollInterval / time.Second); put.IntervalSec != want {
		t.Errorf("interval_sec = %d, want the floor %d", put.IntervalSec, want)
	}

	status, put = putPollSettings(t, srv.URL+"/usage/poll-settings", `{"enabled":true,"interval_sec":999999}`)
	if status != 200 {
		t.Fatalf("PUT status = %d, want 200", status)
	}
	if want := int(usage.MaxQuotaPollInterval / time.Second); put.IntervalSec != want {
		t.Errorf("interval_sec = %d, want the ceiling %d", put.IntervalSec, want)
	}
}

func TestPollSettingsOffKeepsTheInterval(t *testing.T) {
	srv, _ := planTestServer(t)

	status, _ := putPollSettings(t, srv.URL+"/usage/poll-settings", `{"enabled":false,"interval_sec":45}`)
	if status != 200 {
		t.Fatalf("PUT status = %d, want 200", status)
	}
	var got pollWire
	getJSON(t, srv.URL+"/usage/poll-settings", &got)
	if got.Enabled {
		t.Error("enabled = true, want false")
	}
	// Turning polling back on must restore 45s, not a default.
	if got.IntervalSec != 45 {
		t.Errorf("interval_sec = %d, want the 45 saved alongside off", got.IntervalSec)
	}
}

func TestPollSettingsRejectsNonsenseInterval(t *testing.T) {
	srv, _ := planTestServer(t)
	for _, body := range []string{
		`{"enabled":true,"interval_sec":0}`,
		`{"enabled":true,"interval_sec":-30}`,
		`{"enabled":true}`,
	} {
		if status, _ := putPollSettings(t, srv.URL+"/usage/poll-settings", body); status != 400 {
			t.Errorf("PUT %s: status = %d, want 400", body, status)
		}
	}
}

func TestPollSettings404WhenTelemetryDisabled(t *testing.T) {
	// Deliberately NOT the {"enabled": false} body the other usage GETs
	// use: this route has its own `enabled` field meaning "polling is on",
	// and a client could not tell the two apart.
	s := newServer(t) // no UsageStore
	srv := httptest.NewServer(newTestHandler(t, s))
	t.Cleanup(srv.Close)

	resp, err := nethttp.Get(srv.URL + "/usage/poll-settings")
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != 404 {
		t.Errorf("GET status = %d, want 404", resp.StatusCode)
	}
	if status, _ := putPollSettings(t, srv.URL+"/usage/poll-settings", `{"enabled":true,"interval_sec":60}`); status != 404 {
		t.Errorf("PUT status = %d, want 404", status)
	}
}

func TestPollSettingsAppliesToRunningPoller(t *testing.T) {
	// Persisting without reconfiguring would silently revert on the next
	// restart, which is the harder failure to notice.
	store, err := usage.Open(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = store.Close() })

	s := newServer(t)
	s.UsageStore = store
	s.UsageQuotaPoller = usage.NewQuotaPoller(store)
	live := httptest.NewServer(newTestHandler(t, s))
	t.Cleanup(live.Close)

	if status, _ := putPollSettings(t, live.URL+"/usage/poll-settings", `{"enabled":true,"interval_sec":30}`); status != 200 {
		t.Fatal("PUT did not succeed")
	}
	if got := s.UsageQuotaPoller.Interval(); got != 30*time.Second {
		t.Errorf("live poller interval = %v, want 30s", got)
	}

	// Off has to reach the poller too, as the runner's zero encoding.
	if status, _ := putPollSettings(t, live.URL+"/usage/poll-settings", `{"enabled":false,"interval_sec":30}`); status != 200 {
		t.Fatal("PUT did not succeed")
	}
	if got := s.UsageQuotaPoller.Interval(); got != 0 {
		t.Errorf("live poller interval = %v, want 0 while polling is off", got)
	}
}
