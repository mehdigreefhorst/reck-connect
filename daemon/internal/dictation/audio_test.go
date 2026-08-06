package dictation

import (
	"encoding/binary"
	"math"
	"testing"
)

func pcm(samples ...int16) []byte {
	b := make([]byte, len(samples)*2)
	for i, s := range samples {
		binary.LittleEndian.PutUint16(b[i*2:], uint16(s))
	}
	return b
}

func unpcm(b []byte) []int16 {
	out := make([]int16, len(b)/2)
	for i := range out {
		out[i] = int16(binary.LittleEndian.Uint16(b[i*2:]))
	}
	return out
}

func TestResamplePCM16PassesThroughWhenRatesMatch(t *testing.T) {
	in := pcm(1, -2, 3, -4)
	out := resamplePCM16(in, 16000, 16000)
	if string(out) != string(in) {
		t.Fatalf("equal rates should be a passthrough; got %v want %v", unpcm(out), unpcm(in))
	}
}

func TestResamplePCM16LengthTracksRateRatio(t *testing.T) {
	// 16k -> 24k is 1.5×. 100 samples in, ~150 out.
	in := make([]int16, 100)
	for i := range in {
		in[i] = int16(i)
	}
	out := unpcm(resamplePCM16(pcm(in...), 16000, 24000))
	if got, want := len(out), 150; got < want-2 || got > want+2 {
		t.Fatalf("len = %d, want ~%d", got, want)
	}
}

// Upsampling a straight line must stay a straight line — that is what
// distinguishes interpolation from sample-and-hold, and a ramp is the
// cheapest signal that exposes the difference.
func TestResamplePCM16InterpolatesRatherThanRepeating(t *testing.T) {
	in := make([]int16, 64)
	for i := range in {
		in[i] = int16(i * 100)
	}
	out := unpcm(resamplePCM16(pcm(in...), 16000, 24000))

	for i, got := range out {
		// Position in source space for output sample i.
		src := float64(i) * 16000.0 / 24000.0
		if src > float64(len(in)-1) {
			continue
		}
		want := src * 100
		if math.Abs(float64(got)-want) > 1.5 {
			t.Fatalf("out[%d] = %d, want ~%.1f (linear ramp not preserved)", i, got, want)
		}
	}
}

func TestResamplePCM16Edges(t *testing.T) {
	tests := []struct {
		name     string
		in       []byte
		from, to int
	}{
		{"empty input", nil, 16000, 24000},
		{"single sample", pcm(42), 16000, 24000},
		{"odd trailing byte is ignored", append(pcm(1, 2), 0x7f), 16000, 24000},
		{"zero source rate is a passthrough", pcm(1, 2, 3), 0, 24000},
		{"zero target rate is a passthrough", pcm(1, 2, 3), 16000, 0},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			// The contract under test is "does not panic and stays even-length".
			out := resamplePCM16(tc.in, tc.from, tc.to)
			if len(out)%2 != 0 {
				t.Fatalf("output must be whole samples, got %d bytes", len(out))
			}
		})
	}
}

func TestResamplePCM16ClampsRatherThanWrapping(t *testing.T) {
	// Interpolating near the int16 ceiling must saturate, not wrap to
	// negative — a wrap is an audible click straight into the transcript.
	in := pcm(math.MaxInt16, math.MaxInt16, math.MaxInt16, math.MaxInt16)
	for _, s := range unpcm(resamplePCM16(in, 16000, 24000)) {
		if s < 0 {
			t.Fatalf("sample wrapped to %d instead of clamping", s)
		}
	}
}
