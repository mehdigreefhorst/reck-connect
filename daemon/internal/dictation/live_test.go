package dictation

// Live verification against the real provider endpoints, using whatever
// credentials this machine holds. Opt-in, because each run spends a couple of
// seconds of the user's subscription/API quota and needs the network:
//
//	RECK_DICTATION_LIVE=1 go test ./internal/dictation -run TestLive -v
//
// A provider whose credential is missing or expired is skipped, not failed —
// the machine's sign-in state is not what these tests judge. What they judge
// is the protocol code: testdata/quick_brown_fox.wav (16 kHz mono PCM16,
// spoken by macOS `say`) is streamed at realtime pace, and the transcript
// must come back containing "fox".

import (
	"context"
	"encoding/binary"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// liveSampleRate is the fixture's rate — the same 16 kHz the satellite
// captures at. The chunk size and the fixture check derive from it so a
// re-generated fixture can't silently mismatch the declared rate.
const liveSampleRate = 16000

// liveChunk is 100 ms of mono PCM16 — the granularity a satellite's mic
// capture would send.
const liveChunk = liveSampleRate * 2 / 10

func TestLiveProviders(t *testing.T) {
	if os.Getenv("RECK_DICTATION_LIVE") != "1" {
		t.Skip("live provider test: set RECK_DICTATION_LIVE=1 to run against real endpoints")
	}
	pcm := readFixturePCM16(t, filepath.Join("testdata", "quick_brown_fox.wav"))

	cases := []struct {
		name string
		p    Provider
		load func() (Credential, error)
	}{
		{"claude", ProviderClaude, LoadClaude},
		{"codex", ProviderCodex, LoadCodex},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			cred, err := tc.load()
			if err != nil {
				if errors.Is(err, ErrNoCredentials) || errors.Is(err, ErrTokenExpired) {
					t.Skipf("no usable %s credential on this machine: %v", tc.name, err)
				}
				t.Fatalf("loading %s credential: %v", tc.name, err)
			}
			t.Logf("using %s", cred)

			var mu sync.Mutex
			var finals, errs []string
			h := Handlers{
				OnPartial: func(text string) {
					mu.Lock()
					defer mu.Unlock()
					t.Logf("partial: %q", text)
				},
				OnFinal: func(text string) {
					mu.Lock()
					defer mu.Unlock()
					finals = append(finals, text)
					t.Logf("final:   %q", text)
				},
				OnError: func(msg string) {
					mu.Lock()
					defer mu.Unlock()
					errs = append(errs, msg)
					t.Logf("error:   %q", msg)
				},
				OnDebug: func(msg string) { t.Logf("debug:   %s", msg) },
			}

			ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
			defer cancel()
			s, err := Dial(ctx, tc.p, cred, Config{SampleRate: liveSampleRate}, "", h)
			if err != nil {
				t.Fatalf("Dial: %v", err)
			}
			// Close is idempotent; this defer covers every t.Fatalf below —
			// without it, the read goroutine outlives the subtest and its
			// t.Logf panics ("Log in goroutine after test has completed").
			defer s.Close()

			// Speech at realtime pace, then over a second of silence so
			// endpointing/VAD sees the utterance end before we hang up.
			silence := make([]byte, liveChunk)
			for off := 0; off < len(pcm)+12*liveChunk; off += liveChunk {
				chunk := silence
				if off < len(pcm) {
					end := off + liveChunk
					if end > len(pcm) {
						end = len(pcm)
					}
					chunk = pcm[off:end]
				}
				if err := s.SendAudio(ctx, chunk); err != nil {
					t.Fatalf("SendAudio: %v", err)
				}
				time.Sleep(100 * time.Millisecond)
			}
			s.Close()

			mu.Lock()
			defer mu.Unlock()
			got := strings.ToLower(strings.Join(finals, " "))
			if len(errs) > 0 {
				t.Errorf("provider reported errors: %q", errs)
			}
			if !strings.Contains(got, "fox") {
				t.Fatalf("transcript %q does not contain %q", got, "fox")
			}
		})
	}
}

// readFixturePCM16 returns the raw sample bytes of a 16 kHz mono PCM16 WAV,
// failing the test if the fixture is any other shape — a resampled or stereo
// fixture would silently test the wrong contract.
func readFixturePCM16(t *testing.T, path string) []byte {
	t.Helper()
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("reading fixture: %v", err)
	}
	if len(raw) < 12 || string(raw[0:4]) != "RIFF" || string(raw[8:12]) != "WAVE" {
		t.Fatalf("fixture %s is not a RIFF/WAVE file", path)
	}
	var data []byte
	sawFmt := false
	for off := 12; off+8 <= len(raw); {
		id := string(raw[off : off+4])
		size := int64(binary.LittleEndian.Uint32(raw[off+4 : off+8]))
		if int64(off)+8+size > int64(len(raw)) {
			t.Fatalf("fixture chunk %q at offset %d overruns the file", id, off)
		}
		body := raw[off+8 : off+8+int(size)]
		switch id {
		case "fmt ":
			if len(body) < 16 {
				t.Fatalf("fixture fmt chunk too short: %d bytes", len(body))
			}
			format := binary.LittleEndian.Uint16(body[0:2])
			channels := binary.LittleEndian.Uint16(body[2:4])
			rate := binary.LittleEndian.Uint32(body[4:8])
			bits := binary.LittleEndian.Uint16(body[14:16])
			if format != 1 || channels != 1 || rate != liveSampleRate || bits != 16 {
				t.Fatalf("fixture must be PCM16 mono %d Hz, got format=%d channels=%d rate=%d bits=%d",
					liveSampleRate, format, channels, rate, bits)
			}
			sawFmt = true
		case "data":
			data = body
		}
		off += 8 + int(size) + int(size&1) // chunks are word-aligned
	}
	if !sawFmt || len(data) == 0 {
		t.Fatalf("fixture %s has no fmt/data chunks", path)
	}
	return data
}
