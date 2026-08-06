package dictation

import "encoding/binary"

// resamplePCM16 converts mono little-endian PCM16 between sample rates.
//
// The satellite captures at 16 kHz because that is what Deepgram wants and
// what Claude Code's endpoint expects. OpenAI's realtime API wants 24 kHz, so
// exactly one provider needs a rate change and it is cheaper to do it here
// than to make capture provider-aware.
//
// Linear interpolation is deliberate. Speech-to-text at these rates is not
// sensitive to the imaging artifacts a proper polyphase filter would remove,
// and the alternative — pulling in a resampling dependency — costs more than
// it buys for a 1.5× upsample of voice.
//
// Input that is not a whole number of samples has its trailing byte dropped;
// frames arrive from a WebSocket and a torn one should degrade, not error.
func resamplePCM16(in []byte, fromRate, toRate int) []byte {
	if fromRate <= 0 || toRate <= 0 || fromRate == toRate {
		return evenLen(in)
	}
	src := evenLen(in)
	n := len(src) / 2
	if n == 0 {
		return nil
	}
	if n == 1 {
		return src
	}

	outN := (n*toRate + fromRate/2) / fromRate
	if outN <= 0 {
		return nil
	}
	out := make([]byte, outN*2)
	ratio := float64(fromRate) / float64(toRate)

	for i := 0; i < outN; i++ {
		pos := float64(i) * ratio
		j := int(pos)
		if j >= n-1 {
			// Past the last full interval: hold the final sample rather than
			// extrapolating off the end of the frame.
			binary.LittleEndian.PutUint16(out[i*2:], uint16(sampleAt(src, n-1)))
			continue
		}
		frac := pos - float64(j)
		a := float64(sampleAt(src, j))
		b := float64(sampleAt(src, j+1))
		binary.LittleEndian.PutUint16(out[i*2:], uint16(clampInt16(a+(b-a)*frac)))
	}
	return out
}

func sampleAt(b []byte, i int) int16 {
	return int16(binary.LittleEndian.Uint16(b[i*2:]))
}

// evenLen drops a trailing odd byte so the result is whole samples.
func evenLen(b []byte) []byte {
	if len(b)%2 == 0 {
		return b
	}
	return b[:len(b)-1]
}

// clampInt16 saturates instead of wrapping. Interpolating near the ceiling
// can exceed it by a fraction, and a wrap there is an audible click that the
// transcriber would happily turn into a spurious word.
func clampInt16(v float64) int16 {
	switch {
	case v > 32767:
		return 32767
	case v < -32768:
		return -32768
	}
	return int16(v)
}
