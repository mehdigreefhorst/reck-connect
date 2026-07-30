// Canvas painting for the quota forecast (issue #130). Impure by nature —
// it draws — so it has no unit test; the geometry it draws is pinned in
// usage-forecast.test.ts and the result is covered by the e2e screenshots.
// Same split as usage-export-dialog.ts / usage-export.ts.
//
// Drawn in a uPlot `draw` hook rather than as uPlot series with native
// `bands`, for three reasons:
//
//   - Bands fill between two SERIES INDICES. The reset marker and the 100%
//     crossing are annotations at arbitrary (x, y), so a draw hook is needed
//     regardless; bands would mean two mechanisms for one feature.
//   - Bands would need four extra series (low/high x 5h/7d), each with its
//     `show` wired to the toggles, plus a bands array whose indices must
//     stay in lockstep with SERIES_TOGGLES' hard-coded seriesIdx.
//   - Band values must live in `data`, so the x array would grow by
//     synthetic indices with null values — putting cursor.idx values with no
//     bins[] behind them into the readout and the drill-down handler. With a
//     draw hook, `data` stays exactly what it is today.

import type uPlot from "uplot";
import type { ForecastGeometry, ProjectedLine } from "./usage-forecast";

/** One bucket's forecast, ready to draw. */
export interface ForecastLayer {
  geometry: ForecastGeometry;
  /** The series' own colour, so 5h and 7d stay attributable. */
  color: string;
  /** Short name for the reset marker's label, e.g. "5h". */
  label: string;
  /** Local-time formatter for the reset and crossing labels. */
  formatTime: (unixSeconds: number) => string;
}

export interface ForecastPaintOpts {
  layers: ForecastLayer[];
  /** Fill for the band between the bounds — the deep mustard. */
  bandColor: string;
  /** Muted text colour for the marker labels. */
  textColor: string;
}

/** Alpha suffixes as 8-digit hex. A projection is a guess and must never
 * compete with the data it is drawn beside. */
const BAND_ALPHA = "1f"; // ~12%
const BOUND_ALPHA = "66"; // ~40%
const RESET_ALPHA = "59"; // ~35%

/** uPlot renders at devicePixelRatio; every width and radius here is in CSS
 * pixels and scaled by it, or the marks come out hairline on retina. */
function paintLayer(u: uPlot, layer: ForecastLayer, opts: ForecastPaintOpts): void {
  const { ctx } = u;
  // valToPos(..., true) returns CANVAS pixels, and uPlot sizes its canvas at
  // the device ratio. Series widths get scaled by uPlot itself; raw ctx
  // drawing does not, so every width and radius below is authored in CSS
  // pixels and scaled here — otherwise the marks come out hairline on
  // retina and the dashes turn to dots.
  const r = window.devicePixelRatio || 1;
  const g = layer.geometry;

  const X = (idx: number) => u.valToPos(idx, "x", true);
  const Y = (pct: number) => u.valToPos(pct, "pct", true);

  const trace = (line: ProjectedLine) => {
    ctx.beginPath();
    line.points.forEach(([idx, pct], i) => {
      const x = X(idx);
      const y = Y(pct);
      if (i === 0) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    });
  };

  // --- band: up the high edge, back down the low one -------------------
  ctx.beginPath();
  g.high.points.forEach(([idx, pct], i) => {
    const x = X(idx);
    const y = Y(pct);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  for (let i = g.low.points.length - 1; i >= 0; i--) {
    const [idx, pct] = g.low.points[i];
    ctx.lineTo(X(idx), Y(pct));
  }
  ctx.closePath();
  ctx.fillStyle = opts.bandColor + BAND_ALPHA;
  ctx.fill();

  // --- the three lines -------------------------------------------------
  ctx.lineJoin = "round";
  ctx.setLineDash([4 * r, 4 * r]);
  ctx.lineWidth = 1 * r;
  ctx.strokeStyle = layer.color + BOUND_ALPHA;
  trace(g.low);
  ctx.stroke();
  trace(g.high);
  ctx.stroke();

  // Centre reads as the projection; the bounds as its span.
  ctx.lineWidth = 1.5 * r;
  ctx.strokeStyle = layer.color;
  trace(g.centre);
  ctx.stroke();
  ctx.setLineDash([]);

  // --- origin dot ------------------------------------------------------
  // The plotted series ends at a per-bin MAX() that has been forward-filled;
  // the forecast starts at the latest ACTUAL reading. At coarse bins the two
  // do not meet, and without this the gap reads as a rendering glitch rather
  // than as "here is the real number".
  ctx.beginPath();
  ctx.arc(X(g.originIdx), Y(g.originPct), 2.5 * r, 0, Math.PI * 2);
  ctx.fillStyle = layer.color;
  ctx.fill();

  // Canvas cannot resolve a CSS custom property, so the mono stack is named
  // here rather than read from --font-mono.
  ctx.font = `${10 * r}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  ctx.textBaseline = "top";

  // --- reset marker ----------------------------------------------------
  // Null when the reset lies beyond the horizon cap, which is the norm for a
  // 7d window; the caller surfaces the time in the readout instead.
  if (g.resetIdx !== null) {
    const x = X(g.resetIdx);
    ctx.setLineDash([3 * r, 3 * r]);
    ctx.lineWidth = 1 * r;
    ctx.strokeStyle = layer.color + RESET_ALPHA;
    ctx.beginPath();
    ctx.moveTo(x, u.bbox.top);
    ctx.lineTo(x, u.bbox.top + u.bbox.height);
    ctx.stroke();
    ctx.setLineDash([]);

    // Right-align the label when the marker sits near the plot's edge, so
    // it never spills outside the clip.
    const text = `${layer.label} resets ${layer.formatTime(g.resetsAt)}`;
    const w = ctx.measureText(text).width;
    const right = u.bbox.left + u.bbox.width;
    ctx.fillStyle = opts.textColor;
    ctx.fillText(text, x + 4 * r + w > right ? x - 4 * r - w : x + 4 * r, u.bbox.top + 2 * r);
  }

  // --- 100% crossing ---------------------------------------------------
  // The moment the projection says you get throttled. Marked on the centre
  // line only: one ring per series, not three.
  // Marked on the upper bound as well as the centre: the earliest crossing
  // is the one worth knowing about, and on a wide band the centre may never
  // reach 100% while the upper bound does.
  for (const line of [g.high, g.centre]) {
    if (line.crossesAt === null) continue;
    const crossIdx = line.points.find(([, pct]) => pct >= 100)?.[0];
    if (crossIdx === undefined || crossIdx > g.endIdx) continue;
    const radius = 3.5 * r;
    // Tangent BELOW the 100% line, not centred on it: the ceiling is the
    // top of the plot area and the clip would halve a centred ring.
    ctx.beginPath();
    ctx.arc(X(crossIdx), Y(100) + radius, radius, 0, Math.PI * 2);
    ctx.lineWidth = 1.5 * r;
    ctx.strokeStyle = layer.color;
    ctx.stroke();
  }
}

/** Paint every forecast layer over the plot. Safe to call with an empty
 * list. Clipping is mandatory: the lines run past the last bin by design. */
export function paintForecast(u: uPlot, opts: ForecastPaintOpts): void {
  if (opts.layers.length === 0) return;
  const { ctx } = u;
  ctx.save();
  try {
    ctx.beginPath();
    ctx.rect(u.bbox.left, u.bbox.top, u.bbox.width, u.bbox.height);
    ctx.clip();
    for (const layer of opts.layers) {
      paintLayer(u, layer, opts);
    }
  } finally {
    ctx.restore();
  }
}
