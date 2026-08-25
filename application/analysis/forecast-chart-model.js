/* ===========================================================================
 *  forecast-chart-model.js  -  turns a proven forecast result into chart-ready
 *  GEOMETRY. The point of doing this as a pure model (not inline in the render)
 *  is that the FORECAST'S HONESTY RULES become geometric invariants that can be
 *  PROVEN, rather than left to a render pass to get right:
 *
 *    - the near-term trough is a marked point on the line (the trustworthy bit);
 *    - the far horizon is a WIDENING CONE, never a confident line, so a person
 *      literally sees the estimate fan out;
 *    - the "firm" near zone (to the next pay cycle) is bounded and visually
 *      distinct from the "wide" far zone;
 *    - recorded events (a known card payment) and estimated events (a predicted
 *      pay) are separate marker sets, so the render can draw solid vs dashed.
 *
 *  PURE and Node-testable. No DOM. Emits coordinates in a fixed viewBox plus
 *  value LABELS kept separate from geometry, so the render can blur the labels
 *  under the single privacy state without touching the shape.
 * ======================================================================== */

// padL/padR widened so the y-value labels (drawn at padL+2) sit in a gutter
// rather than overlapping the plot, and the first/last x-tick labels are not
// clipped at the chart edges. padB holds the x-labels clear of the baseline.
const VIEW = { w: 800, h: 300, padL: 20, padR: 20, padT: 16, padB: 26 };

function toDate(iso) {
  return new Date(iso + 'T00:00:00Z');
}
function dayIndex(asOf, iso) {
  return Math.round((toDate(iso) - toDate(asOf)) / 86400000);
}
function r2(n) {
  return Math.round(Number(n || 0) * 100) / 100;
}

/* ===========================================================================
 *  buildForecastChartModel(forecast, opts?) -> geometry + labels
 * ======================================================================== */
export function buildForecastChartModel(forecast, opts = {}) {
  const view = Object.assign({}, VIEW, opts.view || {});
  const H = forecast.horizonDays;
  const path = forecast.path || [];

  // ---- per-day uncertainty band -------------------------------------------
  // band(day) scales as sqrt(time), pinned to the forecast's own band at the
  // horizon: bandAtEnd = half the ending range. This makes the cone MONOTONIC-
  // widening by construction - a geometric guarantee, not a hope.
  const bandAtEnd = Math.max(0, r2((forecast.endingRange.high - forecast.endingRange.low) / 2));
  const bandAt = (day) => (H > 0 ? bandAtEnd * Math.sqrt(day / H) : 0);

  // ---- firm vs wide zones (computed BEFORE the y-domain below, so the
  // domain can be scaled to the firm zone rather than the full-horizon cone
  // extremes) ---------------------------------------------------------------
  // The firm zone is the contiguous initial span where the uncertainty band
  // stays within the SAME threshold the forecast uses for its 'wide' flag
  // (25% of the starting balance). Defining it this way ties the geometry to
  // the reliability flag BY CONSTRUCTION: the ending is 'wide' iff the band at
  // the horizon exceeds the threshold iff the firm zone ends before the horizon.
  // The two honesty signals can no longer disagree (the earlier "next payday"
  // definition could run past a short horizon and contradict a 'wide' ending).
  const firmThreshold = Math.abs(forecast.startingBalance || 0) * 0.25;
  let firmUntilDay = H;
  for (let d = 0; d <= H; d++) {
    if (bandAt(d) > firmThreshold) {
      firmUntilDay = d;
      break;
    }
  }
  const endingWide = !!(forecast.reliability && forecast.reliability.ending === 'wide');

  // ---- y-domain: scaled to the FIRM zone's real values only ----------------
  // Scaling to the WHOLE horizon (the previous approach) let the wide zone's
  // necessarily large uncertainty band - which is correct and intentional, the
  // cone is SUPPOSED to widen - set the vertical scale for the entire chart.
  // Every near-term point then compressed into whatever sliver of that
  // inflated range it actually occupied, flattening real day-to-day movement
  // in the one zone a person is meant to trust. The domain now comes only
  // from the firm zone's own line and band; the wide zone's cone still widens
  // exactly as before (bandAt keeps growing past firmUntilDay) and is simply
  // allowed to run past this domain, clipping at the SVG's own viewBox edge -
  // the same "let a genuine outlier run off-scale rather than flatten
  // everyone else" rule already proven on the income and flow charts.
  // Scale to the LINE's own travel, not the cone's full reach. Previously
  // yMin/yMax included the uncertainty band's outer edges (balance +/- b), so
  // a wide firm-zone band stretched the vertical range far past where the line
  // actually goes - the line then compressed into the bottom third with a
  // large empty band above it. The domain now comes from the firm-zone
  // BALANCES themselves, with a modest symmetric pad, so the line uses the
  // plot's full height. The cone still draws its true width via bandAt and is
  // simply allowed to run to the plot edges, exactly as this file's own
  // "let it run off-scale rather than flatten everyone else" comment intends.
  let yMin = Infinity,
    yMax = -Infinity;
  for (const p of path) {
    const d = dayIndex(forecast.asOf, p.date);
    if (d > firmUntilDay) continue;
    yMin = Math.min(yMin, p.balance);
    yMax = Math.max(yMax, p.balance);
  }
  if (!(yMin < yMax)) {
    yMin = (forecast.startingBalance || 0) - 1;
    yMax = (forecast.startingBalance || 0) + 1;
  }
  // Always include the near-term trough, then pad by 8% of the line's own
  // range for breathing room top and bottom.
  if (forecast.low && forecast.low.balance < yMin) yMin = forecast.low.balance;
  const pad = (yMax - yMin) * 0.08 || 1;
  yMin -= pad;
  yMax += pad;
  // HONESTY GUARD (preserved from the original): if the trough is genuinely
  // close to empty, snap the floor to zero so "near empty" is visible rather
  // than zoomed away - a person heading toward the floor must SEE the floor.
  // Only snaps when the low is within ~15% of the padded range above zero;
  // a comfortably-positive forecast keeps the tightened scale (the aesthetic
  // win) and is never dragged down to a distant zero it never approaches.
  const lowBal = forecast.low ? forecast.low.balance : yMin;
  if (lowBal <= (yMax - yMin) * 0.15) yMin = 0;
  if (yMin < 0) yMin = 0; // never cross the zero baseline
  const plotW = view.w - view.padL - view.padR;
  const plotH = view.h - view.padT - view.padB;
  const xOf = (day) => r2(view.padL + (H > 0 ? (day / H) * plotW : 0));
  const yOf = (bal) =>
    r2(view.padT + (yMax > yMin ? 1 - (bal - yMin) / (yMax - yMin) : 0.5) * plotH);

  // ---- projected line + cone boundaries ------------------------------------
  const line = [];
  const coneUpper = [];
  const coneLower = [];
  let prevBand = -1,
    coneMonotonic = true;
  for (const p of path) {
    const day = dayIndex(forecast.asOf, p.date);
    const b = bandAt(day);
    if (b + 1e-9 < prevBand) coneMonotonic = false; // should never happen
    prevBand = b;
    const x = xOf(day);
    line.push({ x, y: yOf(p.balance) });
    coneUpper.push({ x, y: yOf(p.balance + b) });
    coneLower.push({ x, y: yOf(p.balance - b) });
  }

  const firmUntilX = xOf(Math.max(0, Math.min(H, firmUntilDay)));

  // ---- trough marker (the marked trustworthy point) ------------------------
  const lowDay = dayIndex(forecast.asOf, forecast.low.date);
  const trough = {
    x: xOf(Math.max(0, Math.min(H, lowDay))),
    y: yOf(forecast.low.balance),
    date: forecast.low.date,
    // value kept as a label field (blurrable), not baked into geometry
    label: 'low point',
    reliability: (forecast.reliability && forecast.reliability.low) || 'firm',
  };

  // ---- event markers, split recorded vs estimated --------------------------
  const evOf = (e) => {
    const day = dayIndex(forecast.asOf, e.date);
    // place the marker on the line at that day
    const pt = path.find((p) => dayIndex(forecast.asOf, p.date) === day);
    return {
      x: xOf(Math.max(0, Math.min(H, day))),
      y: pt ? yOf(pt.balance) : yOf(forecast.startingBalance),
      date: e.date,
      type: e.type,
      label: e.label || '',
      // Passed through so the render layer can make a marker clickable -
      // the same identity key every commitment/merchant object elsewhere in
      // this app already carries (income.key, g.key, m.key). Previously
      // dropped here, which is why these markers named a payment on the
      // chart but offered no way to reach it - the one remaining place in
      // the app referencing a transaction with no path down to it.
      key: e.key || null,
      direction: e.amount >= 0 ? 'in' : 'out',
    };
  };
  const recordedEvents = (forecast.events || []).filter((e) => e.kind === 'recorded').map(evOf);
  const estimatedEvents = (forecast.events || []).filter((e) => e.kind === 'estimated').map(evOf);

  // ---- axis ticks (dates on x, coarse balances on y) -----------------------
  const xTicks = [];
  const stepDays = H <= 14 ? 7 : H <= 45 ? 15 : 30;
  for (let d = 0; d <= H; d += stepDays) {
    const iso = path[Math.min(d, path.length - 1)]
      ? path[Math.min(d, path.length - 1)].date
      : forecast.asOf;
    xTicks.push({ x: xOf(d), day: d, date: iso });
  }
  const yTicks = [yMin, (yMin + yMax) / 2, yMax].map((v) => ({
    y: yOf(v),
    value: r2(v),
  }));

  return {
    view,
    domain: {
      yMin: r2(yMin),
      yMax: r2(yMax),
      horizonDays: H,
      asOf: forecast.asOf,
      horizonEnd: forecast.horizonEnd,
    },
    line, // the projected balance path
    cone: {
      upper: coneUpper,
      lower: coneLower,
      monotonic: coneMonotonic,
      bandAtEnd,
    },
    zones: { firmUntilX, firmUntilDay, endingWide },
    trough, // marked near-term low
    recordedEvents, // solid markers (known payments)
    estimatedEvents, // dashed markers (predicted flows)
    xTicks,
    yTicks,
    // presentation flags + text the render surfaces verbatim
    presentation: {
      drawConeAfterFirm: endingWide, // cone emphasised in the wide zone
      note: (forecast.reliability && forecast.reliability.note) || '',
      endingRange: forecast.endingRange,
      lowRange: forecast.low.range,
    },
  };
}
