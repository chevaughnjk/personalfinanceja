/* ===========================================================================
 *  forecast-accuracy.js  -  the scoring half of the accuracy loop. Compares
 *  stored past forecast snapshots against what ACTUALLY happened, so the
 *  forecast can honestly report whether it runs optimistic or cautious - the
 *  frozen plan's "keeps the forecast from drifting into fiction".
 *
 *  SINGLE-SOURCE: the "actual balance on a date" comes from the SAME
 *  liquidBalance(bankRecords, opts, asOf) primitive Overview and Position read,
 *  passed in as `liquidAt`, so a scored actual can never disagree with the
 *  balance shown elsewhere.
 *
 *  THE LOAD-BEARING INVARIANT (D's equivalent of reconciliation): NEVER present
 *  an accuracy verdict on a forecast whose horizon has not yet passed. A
 *  snapshot is scorable only when horizonEnd <= today AND the ledger actually
 *  reaches horizonEnd (a balance exists on/at it). An immature or unreachable
 *  snapshot is EXCLUDED - partial data must never produce a complete-sounding
 *  conclusion. With too few matured snapshots, the reader returns a 'building'
 *  state with an honest count, never a fabricated accuracy number.
 *
 *  DIRECTION: predicted HIGHER than actual = the forecast ran OPTIMISTIC (it
 *  expected more money than there was); predicted LOWER = CAUTIOUS.
 *
 *  PURE and Node-testable. No DOM, no fetch, no mutation.
 * ======================================================================== */
function r2(n) {
  return Math.round(Number(n || 0) * 100) / 100;
}
function median(a) {
  if (!a.length) return 0;
  const s = a.slice().sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/* Is this snapshot mature enough to score as of `todayISO`, and does the ledger
 * actually reach its horizon? liquidAt(dateISO) -> { total, ... } | null-ish.
 * A snapshot is scorable only when its horizonEnd has passed AND a real balance
 * exists at horizonEnd (bankReachesHorizon). Returns a reason when not. */
export function snapshotScorable(snap, todayISO, bankMaxDate) {
  if (!snap || !snap.horizonEnd) return { ok: false, reason: 'no-horizon' };
  if (String(snap.horizonEnd) > String(todayISO)) return { ok: false, reason: 'immature' }; // horizon not yet passed
  if (bankMaxDate && String(snap.horizonEnd) > String(bankMaxDate))
    return { ok: false, reason: 'ledger-short' }; // data doesn't reach the horizon yet
  return { ok: true, reason: 'ok' };
}

/* Score ONE matured snapshot. liquidAt is the app's liquidBalance-as-of, curried
 * to take a date: liquidAt(dateISO) -> number (base-currency total) or null.
 * Returns the per-snapshot error, or null if it cannot be honestly scored. */
export function scoreSnapshot(snap, liquidAt) {
  if (snap.predictedEnding == null) return null;
  const actual = liquidAt(snap.horizonEnd);
  if (actual == null || Number.isNaN(Number(actual))) return null; // no real actual -> not scored
  const predicted = r2(snap.predictedEnding);
  const act = r2(actual);
  const errorAbs = r2(predicted - act); // + = optimistic, - = cautious
  const denom = Math.max(50000, Math.abs(act)); // avoid tiny-denominator blowups
  const errorPct = Math.round((errorAbs / denom) * 100);
  return {
    id: snap.id,
    asOf: snap.asOf,
    horizonDays: snap.horizonDays,
    horizonEnd: snap.horizonEnd,
    predicted,
    actual: act,
    errorAbs,
    errorPct,
    direction: errorAbs > 0 ? 'optimistic' : errorAbs < 0 ? 'cautious' : 'exact',
  };
}

/* The reader: score every matured snapshot for a given horizon and aggregate an
 * honest verdict. `snapshots` is state.forecastSnapshots; liquidAt as above.
 * minToScore gates the verdict so one lucky/unlucky snapshot never reads as a
 * pattern (default 3). Returns a 'building' state below that, never a fake number. */
export function accuracyReport(
  snapshots,
  liquidAt,
  { todayISO, bankMaxDate, horizonDays = 90, minToScore = 3 } = {}
) {
  const forHorizon = (snapshots || []).filter((s) => s && s.horizonDays === horizonDays);
  const total = forHorizon.length;
  const mature = forHorizon.filter((s) => snapshotScorable(s, todayISO, bankMaxDate).ok);
  const scored = mature.map((s) => scoreSnapshot(s, liquidAt)).filter(Boolean);

  if (scored.length < minToScore) {
    return {
      state: 'building',
      horizonDays,
      stored: total,
      matured: mature.length,
      scored: scored.length,
      needed: minToScore,
      // honest, no number: this is a "collecting history" panel, not a verdict.
    };
  }

  const medPct = Math.round(median(scored.map((s) => s.errorPct)));
  const medAbs = r2(median(scored.map((s) => s.errorAbs)));
  const optimistic = scored.filter((s) => s.direction === 'optimistic').length;
  const cautious = scored.filter((s) => s.direction === 'cautious').length;
  // The lean is the SIGNED median, so a symmetric spread of errors reads as
  // "about right", not falsely optimistic or cautious.
  const lean = medAbs > 0 ? 'optimistic' : medAbs < 0 ? 'cautious' : 'about-right';
  return {
    state: 'scored',
    horizonDays,
    stored: total,
    matured: mature.length,
    scored: scored.length,
    medianErrorPct: Math.abs(medPct),
    medianErrorAbs: Math.abs(medAbs),
    lean,
    optimisticCount: optimistic,
    cautiousCount: cautious,
    samples: scored.slice(-6), // recent scored snapshots, for a small detail list
  };
}

/* view-model: one plain sentence + tag. Forward, no blame, honest about state. */
export function buildAccuracyModel(report, cfg = {}) {
  const c = (cfg && cfg.currency) || {};
  let money;
  try {
    const f = new Intl.NumberFormat(c.locale || 'en-JM', {
      style: 'currency',
      currency: c.code || 'JMD',
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    });
    money = (n) => f.format(Number(n || 0));
  } catch (_) {
    money = (n) => (c.symbol || '$') + Math.round(Number(n || 0));
  }

  if (report.state === 'building') {
    return {
      state: 'building',
      leadText: `${report.scored} of ${report.needed}`,
      label: `${report.horizonDays}-day forecasts scored so far`,
      tag: 'building history',
      tone: 'neutral',
      detail: `Accuracy needs at least ${report.needed} past forecasts whose ${report.horizonDays}-day window has finished. ${report.stored} stored, ${report.matured} matured. This fills in as time passes.`,
    };
  }
  const leanText =
    report.lean === 'about-right'
      ? 'about right'
      : report.lean === 'optimistic'
        ? 'a little optimistic'
        : 'a little cautious';
  return {
    state: 'scored',
    leadText: report.lean === 'about-right' ? 'About right' : `${report.medianErrorPct}%`,
    label: `typical ${report.horizonDays}-day gap`,
    tag: leanText,
    tone: report.lean === 'about-right' ? 'good' : 'watch',
    detail:
      report.lean === 'about-right'
        ? `Across ${report.scored} finished forecasts, the ${report.horizonDays}-day projection has been about right (typical gap ${money(report.medianErrorAbs)}).`
        : `Across ${report.scored} finished forecasts, the ${report.horizonDays}-day projection has run ${leanText} - typically ${money(report.medianErrorAbs)} (${report.medianErrorPct}%) ${report.lean === 'optimistic' ? 'more than' : 'less than'} what actually happened.`,
  };
}
