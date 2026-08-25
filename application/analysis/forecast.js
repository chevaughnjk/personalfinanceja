/* ===========================================================================
 *  forecast.js  -  forward cash projection. Built to be PROVEN as plain numbers
 *  before any chart exists (frozen build order: arithmetic earns trust first).
 *
 *  Reads the SAME shared primitive Overview/Goals read (expectedIncome +
 *  recurring standing debits), so the forecast can never disagree with "what's
 *  coming" shown elsewhere. Projects a daily cash path from the liquid balance,
 *  applies recurring income and commitments on their predicted days, and burns
 *  an estimated flexible-spend rate in between.
 *
 *  PURE and Node-testable. No DOM, no fetch, no mutation.
 *
 *  OUTPUTS (per the frozen plan): projected ending position, expected LOW point
 *  and its DATE, the next major movement, and a RANGE that widens with horizon.
 *  Every modelled movement is labelled recorded-vs-estimated so a later chart
 *  can draw them differently.
 *
 *  HONESTY: if the primitive can't find recurring income, the forecast returns
 *  incomplete with a named gap rather than inventing a pay date.
 * ======================================================================== */
import {
  resolveOpts,
  expectedIncome,
  detectRecurring,
  twoWayKeys,
  liquidBalance,
} from './commitment-income.js';

function toDate(iso) {
  return new Date(iso + 'T00:00:00Z');
}
function isoOf(d) {
  return d.toISOString().slice(0, 10);
}
function addDays(iso, n) {
  const d = toDate(iso);
  d.setUTCDate(d.getUTCDate() + n);
  return isoOf(d);
}
function daysInMonth(y, mo) {
  return new Date(Date.UTC(y, mo, 0)).getUTCDate();
}
function clampDay(y, mo, day) {
  return Math.min(day, daysInMonth(y, mo));
}
function r2(n) {
  return Math.round(Number(n || 0) * 100) / 100;
}
function median(a) {
  if (!a.length) return 0;
  const s = a.slice().sort((x, y) => x - y);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function ymOf(iso) {
  return iso.slice(0, 7);
}

/* place a monthly recurring event on `day` for every month touched by
 * [asOf+1 .. horizonEnd]; returns [{date, amount}] within the window */
function monthlyEvents(asOf, horizonEnd, day, amount) {
  const out = [];
  let y = +asOf.slice(0, 4),
    mo = +asOf.slice(5, 7);
  // start from asOf's month, walk forward until past horizon
  for (let guard = 0; guard < 24; guard++) {
    const iso = `${y}-${String(mo).padStart(2, '0')}-${String(clampDay(y, mo, day)).padStart(2, '0')}`;
    if (iso > asOf && iso <= horizonEnd) out.push({ date: iso, amount });
    if (iso > horizonEnd) break;
    mo++;
    if (mo > 12) {
      mo = 1;
      y++;
    }
    if (`${y}-${String(mo).padStart(2, '0')}-01` > horizonEnd) {
      // still may have an event in this final month before horizonEnd
      const iso2 = `${y}-${String(mo).padStart(2, '0')}-${String(clampDay(y, mo, day)).padStart(2, '0')}`;
      if (iso2 > asOf && iso2 <= horizonEnd) out.push({ date: iso2, amount });
      break;
    }
  }
  return out;
}

/* estimate typical monthly flexible outflow = median over recent complete
 * months of (external out that is NOT a recurring commitment). Robust to the
 * occasional huge one-off (the corpus has several). */
function typicalFlexibleMonthly(bankRecords, opts, asOf, committedKeys) {
  const base = opts.baseCurrency;
  const byMonth = new Map();
  for (const r of bankRecords) {
    const d = String(r.date || r.Date || '');
    if (!d || d > asOf) continue;
    const internal =
      r.internalTransfer != null
        ? !!r.internalTransfer
        : String(r.Flow || '') === 'Internal transfer';
    if (internal) continue;
    const ccy = String(r.currency || r.Currency || base);
    if (ccy !== base) continue;
    const dir =
      r.direction || (r.Flow === 'Cash inflow' ? 'in' : r.Flow === 'Cash outflow' ? 'out' : '');
    if (dir !== 'out') continue;
    const key = r.counterpartyKey || r.Group || r['Counterparty / Merchant'] || '';
    if (committedKeys.has(key)) continue; // commitments handled separately
    const a = Math.abs(Number(r.amount != null ? r.amount : r.Amount) || 0);
    byMonth.set(ymOf(d), (byMonth.get(ymOf(d)) || 0) + a);
  }
  const months = [...byMonth.keys()].sort();
  const complete = months.slice(0, -1); // drop the (possibly partial) last month
  const vals = complete.map((m) => byMonth.get(m));
  return { monthly: r2(median(vals)), monthsUsed: vals.length };
}

/* median signed month-over-month change in LIQUID balance, over recent complete
 * months up to asOf. This is the empirical anchor: it captures ALL drains
 * (flexible spend, sweeps to non-tracked own accounts, big irregular transfers)
 * that a categorised reconstruction misses, and the median shrugs off the one
 * huge bonus month. Reuses liquidBalance so it can't drift from the level calc. */
function medianMonthlyLiquidDelta(bankRecords, opts, asOf) {
  // month-ends strictly before asOf, most recent ~8
  const yms = [
    ...new Set(bankRecords.map((r) => String(r.date || r.Date || '').slice(0, 7)).filter(Boolean)),
  ].sort();
  const ends = [];
  for (const ym of yms) {
    const y = +ym.slice(0, 4),
      mo = +ym.slice(5, 7);
    const end = `${ym}-${String(daysInMonth(y, mo)).padStart(2, '0')}`;
    if (end < asOf) ends.push(end);
  }
  // LEVEL (drift) tracks the CURRENT regime -> recent months only.
  const recent = ends.slice(-9);
  const recTot = recent.map((e) => liquidBalance(bankRecords, opts, e).total);
  const recDelta = [];
  for (let i = 1; i < recTot.length; i++) recDelta.push(recTot[i] - recTot[i - 1]);
  const drift = median(recDelta);
  // BAND (sigma) reflects LIFETIME volatility -> ALL available months, so the
  // range stays honest even when the recent window happens to be calm. This is
  // why the Aug-2025 band collapsed before: recent months were an accumulation
  // phase, but this person's full history includes large lumpy transfers.
  const allTot = ends.map((e) => liquidBalance(bankRecords, opts, e).total);
  const allDelta = [];
  for (let i = 1; i < allTot.length; i++) allDelta.push(allTot[i] - allTot[i - 1]);
  const m2 = median(allDelta);
  const mad = median(allDelta.map((d) => Math.abs(d - m2)));
  return {
    delta: r2(drift),
    mad: r2(mad),
    monthsUsed: recDelta.length,
    volMonthsUsed: allDelta.length,
  };
}

/* ===========================================================================
 *  buildForecast - project the cash path from asOf over `horizonDays`.
 * ======================================================================== */
export function buildForecast({
  bankRecords = [],
  cardStatements = [],
  cfg = {},
  asOf,
  horizonDays = 90,
  manualFutureItems = [],
}) {
  const opts = resolveOpts(cfg);
  const horizonEnd = addDays(asOf, horizonDays);

  // starting position = liquid balance as of asOf (same calc Overview uses)
  const liquid = liquidBalance(bankRecords, opts, asOf);
  const start = liquid.total;

  // recurring income (shared primitive)
  const inc = expectedIncome(bankRecords, opts, asOf);
  const gaps = [];
  if (!inc) gaps.push('no recurring income detected');

  // recurring commitments (shared detector + round-trip guard)
  const debits = detectRecurring(bankRecords, 'out', opts, asOf).filter(
    (d) => d.typical >= opts.commitmentFloor
  );
  const tw = twoWayKeys(bankRecords, opts, asOf);
  const commits = debits.filter((d) => !tw.has(d.key));
  const committedKeys = new Set(commits.map((d) => d.key));

  // --- burn calibration -----------------------------------------------------
  // LESSON FROM THE BACKTEST: reconstructing "flexible spend" from categorised
  // outflow systematically UNDER-counts, because real cash also leaves via
  // sweeps to own accounts outside the liquid set and large irregular transfers
  // - money the categorised view never sees. A model built only from
  // income - commitments - small-flexible over-predicts badly (median 49% end
  // error, worst 2918% on the naive version).
  //
  // Honest fix: anchor the monthly DRIFT to the ACTUAL median month-over-month
  // change in liquid balance (which captures every drain empirically, and is
  // robust to the one huge bonus month via the median). Keep the DATED income
  // and commitment events for the trough's SHAPE, and back out a daily RESIDUAL
  // burn = drift - (income - commitments) so the two are not double-counted.
  const flex = typicalFlexibleMonthly(bankRecords, opts, asOf, committedKeys); // kept for reporting
  const drift = medianMonthlyLiquidDelta(bankRecords, opts, asOf); // signed; usually negative
  const incomeMonthly = inc ? inc.amount : 0;
  const commitMonthly = commits.reduce((s, d) => s + d.typical, 0);
  const knownNetMonthly = incomeMonthly - commitMonthly; // dated events' net/mo
  // residual = everything the dated events don't explain (flexible + sweeps +
  // transfers), derived from reality. Clamp so a data-poor case can't invent a
  // positive residual that would inflate the balance.
  const residualMonthly = Math.min(0, r2(drift.delta - knownNetMonthly));
  const dailyFlex = -residualMonthly / 30; // positive daily burn

  // build dated events within the horizon
  const events = [];
  if (inc)
    for (const e of monthlyEvents(asOf, horizonEnd, inc.typicalDay, inc.amount))
      events.push({ ...e, type: 'income', kind: 'estimated' });
  for (const d of commits)
    for (const e of monthlyEvents(asOf, horizonEnd, d.typicalDay, -d.typical))
      events.push({ ...e, type: 'commitment', kind: 'estimated', key: d.key });
  // card payment: the amount due, on its due date, if within horizon
  const stmts = (cardStatements || [])
    .slice()
    .sort((a, b) => String(a.statementKey).localeCompare(String(b.statementKey)));
  const latest = stmts[stmts.length - 1];
  if (
    latest &&
    latest.amountDue != null &&
    latest.dueDate &&
    latest.dueDate > asOf &&
    latest.dueDate <= horizonEnd
  ) {
    events.push({
      date: latest.dueDate,
      amount: -Math.abs(Number(latest.amountDue)),
      type: 'card',
      kind: 'recorded',
    });
  }
  // Manual future items (dated, recorded): a planned purchase, or a goal
  // contribution the safe-contribution guard is vetting. Each is an exact,
  // known movement on its date, so it is 'recorded', not 'estimated'. Only
  // items strictly inside the horizon are applied.
  for (const m of manualFutureItems || []) {
    const md = String(m.date || '');
    if (md > asOf && md <= horizonEnd) {
      events.push({
        date: md,
        amount: Number(m.amount) || 0,
        type: m.type || 'manual',
        kind: 'recorded',
        key: m.key || 'manual',
      });
    }
  }
  events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

  // walk the daily path
  let bal = start;
  let low = { balance: start, date: asOf };
  let nextMajor = null;
  const path = [{ date: asOf, balance: r2(bal) }];
  let cursor = asOf;
  let ei = 0;
  for (let day = 1; day <= horizonDays; day++) {
    cursor = addDays(asOf, day);
    bal -= dailyFlex; // flexible burn each day
    while (ei < events.length && events[ei].date === cursor) {
      bal += events[ei].amount;
      if (!nextMajor && Math.abs(events[ei].amount) >= (inc ? inc.amount * 0.5 : 50000))
        nextMajor = { ...events[ei] };
      ei++;
    }
    bal = r2(bal);
    if (bal < low.balance) low = { balance: bal, date: cursor };
    path.push({ date: cursor, balance: bal });
  }
  const ending = r2(bal);

  // uncertainty band: MUST reflect real volatility, not flexible-spend. The
  // backtest showed this person's monthly liquid change swings by hundreds of
  // thousands (large irregular transfers), so a flexible-only band was absurdly
  // narrow and the actual fell far outside it. Calibrate the monthly sigma to
  // the actual spread (MAD, robust) of monthly liquid deltas, and widen with
  // sqrt(time). Coverage of actual within this band is the honesty metric the
  // proof now checks. A floor keeps a data-poor case from claiming false
  // precision.
  const sigmaMonthly = Math.max(drift.mad * 1.4826, (inc ? inc.amount : 50000) * 0.25);
  const bandAtLow = r2(sigmaMonthly * Math.sqrt(Math.max(1, daysBetween(asOf, low.date)) / 30));
  const bandAtEnd = r2(sigmaMonthly * Math.sqrt(horizonDays / 30));

  return {
    asOf,
    horizonDays,
    horizonEnd,
    startingBalance: r2(start),
    ending,
    endingRange: { low: r2(ending - bandAtEnd), high: r2(ending + bandAtEnd) },
    low: {
      balance: low.balance,
      date: low.date,
      range: {
        low: r2(low.balance - bandAtLow),
        high: r2(low.balance + bandAtLow),
      },
    },
    nextMajor, // next big movement (income/commitment/card)
    assumptions: {
      income: inc
        ? {
            amount: inc.amount,
            typicalDay: inc.typicalDay,
            confidence: inc.confidence,
          }
        : null,
      commitments: commits.map((d) => ({
        key: d.key,
        amount: r2(d.typical),
        typicalDay: d.typicalDay,
      })),
      flexibleMonthly: flex.monthly,
      flexMonthsUsed: flex.monthsUsed,
      driftMonthly: r2(drift.delta),
      driftMonthsUsed: drift.monthsUsed, // empirical anchor
      residualMonthly: r2(residualMonthly), // burn back-out
    },
    events, // dated, each recorded|estimated
    path, // daily [{date,balance}] for a later chart
    confidence: gaps.length ? 'incomplete' : 'complete',
    // per-horizon reliability, self-reported honestly. When the band at the
    // horizon is a large fraction of the starting balance, the far estimate is
    // wide and should be presented as a range, not a line. The near-term low is
    // driven by dated events and is the trustworthy output.
    reliability: {
      low: bandAtLow <= Math.abs(start) * 0.25 ? 'firm' : 'wide',
      // 'wide' only when uncertainty becomes material BEFORE the horizon ends
      // (band a day short of the end already exceeds the threshold), so a short
      // near-term window is not spuriously flagged wide on its final day. This
      // keeps the flag consistent with the chart's firm-zone geometry, which
      // resolves in integer days: the two honesty signals agree by construction.
      ending:
        sigmaMonthly * Math.sqrt(Math.max(0, horizonDays - 1) / 30) <= Math.abs(start) * 0.25
          ? 'firm'
          : 'wide',
      note:
        bandAtEnd > Math.abs(start) * 0.25
          ? 'Beyond the next pay cycle, large one-off transfers make the ending a wide range, not a firm figure.'
          : 'Projection is within a firm range over this horizon.',
    },
    gaps,
  };
}
function daysBetween(a, b) {
  return Math.round((toDate(b) - toDate(a)) / 86400000);
}

/* ===========================================================================
 *  snapshotForAccuracy - store just enough to score this forecast later against
 *  what actually happened (the frozen "accuracy tracking" requirement).
 * ======================================================================== */
export function snapshotForAccuracy(forecast) {
  return {
    id: `fc_${forecast.asOf}_${forecast.horizonDays}`,
    asOf: forecast.asOf,
    horizonDays: forecast.horizonDays,
    horizonEnd: forecast.horizonEnd,
    predictedEnding: forecast.ending,
    predictedLow: forecast.low.balance,
    predictedLowDate: forecast.low.date,
    assumptions: forecast.assumptions,
    takenAt: new Date().toISOString(),
  };
}
