import { describe, expect, it } from "vitest";
import {
  daemonEndpointingParams,
  deepgramEndpointingMs,
  MANUAL_SILENCE_MS,
} from "./endpointing";
import { coerceEndpointing, DEFAULT_ENDPOINTING } from "./transcriptionSettings";

describe("endpointing settings", () => {
  it("defaults to auto/500", () => {
    expect(DEFAULT_ENDPOINTING).toEqual({ mode: "auto", silenceMs: 500 });
    expect(coerceEndpointing(undefined)).toEqual(DEFAULT_ENDPOINTING);
  });

  it("clamps silence into the supported range and rounds it", () => {
    expect(coerceEndpointing({ mode: "auto", silenceMs: 10 }).silenceMs).toBe(100);
    expect(coerceEndpointing({ mode: "auto", silenceMs: 99_999 }).silenceMs).toBe(5000);
    expect(coerceEndpointing({ mode: "auto", silenceMs: 812.6 }).silenceMs).toBe(813);
  });

  it("falls back to auto for an unknown mode", () => {
    expect(coerceEndpointing({ mode: "whenever" }).mode).toBe("auto");
    expect(coerceEndpointing({ mode: "manual" }).mode).toBe("manual");
  });
});

describe("provider mapping", () => {
  it("passes the silence window straight through to Deepgram in auto mode", () => {
    expect(deepgramEndpointingMs({ mode: "auto", silenceMs: 900 })).toBe(900);
  });

  it("uses an effectively-never window for Deepgram in manual mode", () => {
    expect(deepgramEndpointingMs({ mode: "manual", silenceMs: 300 })).toBe(MANUAL_SILENCE_MS);
  });

  it("hands the daemon the raw preference (it maps per provider itself)", () => {
    expect(daemonEndpointingParams({ mode: "manual", silenceMs: 700 })).toEqual({
      mode: "manual",
      silenceMs: 700,
    });
  });
});
