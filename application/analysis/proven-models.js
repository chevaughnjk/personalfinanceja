/* ===========================================================================
 *  proven-models.js  -  app-level accessors that bind the PROVEN, corpus-tested
 *  analysis modules to live app state, following the app's own memoised-model
 *  conventions (the _key/_val single-slot caches used by overviewModel /
 *  commitmentsModel / analysis / resolved).
 *
 *  ADDITIVE BY DESIGN. This module introduces NEW capabilities and never
 *  replaces or shadows an existing model. It is constructed once in bootUI and
 *  handed to the render factories via ctx; a renderer opts in by calling an
 *  accessor. Nothing here runs until a consumer calls it, so importing and
 *  wiring it changes no existing behaviour.
 *
 *  Why a factory (not free functions): the accessors must read LIVE app state
 *  and reuse the app's already-memoised classifiedBank(), so they close over a
 *  small ctx exactly like every other render factory in this codebase. It fails
 *  loudly at construction (requireCtx) if a dependency is missing, the same
 *  guarantee the other factories give.
 * ======================================================================== */
import { requireCtx } from '../core/shared-helpers.js';
import { commitmentAndIncomePrimitive,resolveOpts, liquidBalance } from './commitment-income.js';
import { buildAvailableNowModel } from './available-now.js';
import { committedFlexible, buildCommittedFlexibleModel } from './committed-flexible.js';
import { spendBreakdown, buildSpendBreakdownModel } from './spend-breakdown.js';
import { resolveIntention, paceForMonth, buildPaceModel } from './category-intentions.js';
import { buildForecast, snapshotForAccuracy } from './forecast.js';
import { accuracyReport, buildAccuracyModel } from './forecast-accuracy.js';
import { buildForecastChartModel } from './forecast-chart-model.js';
import {
  cashAndDebt,
  recordedNetWorth,
  financialPositionSummary,
  buildCashDebtModel,
  buildNetWorthModel,
} from './position.js';
import { tagTotals, buildTagModel } from './tag-totals.js';

// FIX (period seam): the app's resolved() returns MONTH-granularity bounds
// ('YYYY-MM'), but the pure analysis modules compare against full ISO dates
// ('YYYY-MM-DD'). Passing month bounds straight through silently drops every
// end-of-month row (proven: a 25th-of-month salary vanished, income read 0).
// The binding layer normalises here so the modules stay pure and the app's
// period convention is honoured. from -> first of month; to -> last of month.
// Safe whether resolved() returns month or date bounds: a bound already in
// full YYYY-MM-DD form passes through unchanged.
function toDateBounds(period) {
  if (!period || !period.from || !period.to) return null;
  const from = /^\d{4}-\d{2}$/.test(period.from) ? period.from + '-01' : period.from;
  let to = period.to;
  if (/^\d{4}-\d{2}$/.test(to)) {
    const y = +to.slice(0, 4),
      mo = +to.slice(5, 7);
    const last = new Date(Date.UTC(y, mo, 0)).getUTCDate();
    to = `${to}-${String(last).padStart(2, '0')}`;
  }
  return { from, to };
}

export function createProvenModels(ctx) {
  requireCtx(ctx, ['state', 'classifiedBank', 'todayISO'], 'createProvenModels');
  const { state, classifiedBank, todayISO } = ctx;

  /* ---- shared commitment-and-income primitive (memoised, single slot) ----
   * Keyed on the exact inputs that change the result: the classified bank
   * array reference (already memoised upstream, so its identity is stable
   * until bank data changes), the card-statements reference, today, and cfg. */
  let _cipKey = null,
    _cipVal = null;
  function commitmentIncome() {
    const cb = classifiedBank();
    const cs = state._cardStatements;
    const asOf = todayISO();
    if (
      _cipVal &&
      _cipKey &&
      _cipKey.cb === cb &&
      _cipKey.cs === cs &&
      _cipKey.asOf === asOf &&
      _cipKey.cfg === state.cfg
    ) {
      return _cipVal;
    }
    _cipVal = commitmentAndIncomePrimitive({
      bankRecords: cb,
      cardStatements: cs || [],
      cfg: state.cfg,
      asOf,
    });
    _cipKey = { cb, cs, asOf, cfg: state.cfg };
    return _cipVal;
  }

  // "Available now" three-layer view-model (Overview surface).
  function availableNow() {
    return buildAvailableNowModel(commitmentIncome(), state.cfg);
  }

  /* ---- committed vs flexible (period-scoped) ----
   * cardRecords = state.rows (the built card rows carry .kind spend/fee/…,
   * .amount, .date, .category, .merchantGroup - the exact fields the module
   * reads), so it consumes what the app already computes, no re-derivation. */
  function committedFlexibleFor(period) {
    const b = toDateBounds(period);
    if (!b) return null;
    const res = committedFlexible({
      bankRecords: classifiedBank(),
      cardRecords: state.rows,
      cfg: state.cfg,
      period: b,
    });
    return buildCommittedFlexibleModel(res, state.cfg);
  }

  /* ---- "where it went": one category -> merchant drill (period + prior) ----
   * priorComplete should come from the app's coverage helper so a partial prior
   * month never yields an exaggerated percentage (the guard the proof added). */
  function spendBreakdownFor(period, priorPeriod = null, priorComplete = true) {
    const b = toDateBounds(period);
    if (!b) return null;
    const pb = priorPeriod ? toDateBounds(priorPeriod) : null;
    const res = spendBreakdown({
      cardRecords: state.rows,
      cfg: state.cfg,
      period: b,
      priorPeriod: pb,
      priorComplete,
      splits: state.transactionSplits || [],
    });
    return buildSpendBreakdownModel(res, state.cfg);
  }

  // E2 (treemap): the RAW spendBreakdown result, before buildSpendBreakdownModel
  // formats every figure into display text. The treemap needs real numbers
  // (amount, for its area math) that the formatted view-model no longer
  // carries - this is the SAME analysis run once, read at a different layer,
  // never a second computation. Same period/prior/splits handling as
  // spendBreakdownFor, so the two can never silently disagree on the
  // underlying numbers, only on how they're presented.
  function spendBreakdownRawFor(period, priorPeriod = null, priorComplete = true) {
    const b = toDateBounds(period);
    if (!b) return null;
    const pb = priorPeriod ? toDateBounds(priorPeriod) : null;
    return spendBreakdown({
      cardRecords: state.rows,
      cfg: state.cfg,
      period: b,
      priorPeriod: pb,
      priorComplete,
      splits: state.transactionSplits || [],
    });
  }

  /* ---- category intentions: forward pace for a category in a month ----
   * spendSoFar MUST be the app's own category spend for that window (refunds/
   * exclusions/splits already applied); this only turns it into a pace reading
   * via the single shared precedence resolver. Returns null when no intention. */
  function paceFor(category, targetMonth, spendSoFar, asOfDay) {
    const it = resolveIntention(state.categoryIntentions || [], category, targetMonth);
    if (!it) return null;
    const pace = paceForMonth({
      intention: it,
      targetMonth,
      spendSoFar,
      asOfDay,
      cfg: state.cfg,
    });
    return buildPaceModel(pace, state.cfg);
  }
  // The raw resolver, for callers that need the governing intention itself.
  function intentionFor(category, targetMonth) {
    return resolveIntention(state.categoryIntentions || [], category, targetMonth);
  }

  /* ---- forecast + chart geometry (per-horizon memo, invalidated by data/day) ---- */
  const _fc = new Map(); // horizon -> { cb, cs, asOf, val }
  function forecast(horizonDays = 30) {
    const cb = classifiedBank();
    const cs = state._cardStatements;
    const asOf = todayISO();
    const e = _fc.get(horizonDays);
    if (e && e.cb === cb && e.cs === cs && e.asOf === asOf && e.cfg === state.cfg) return e.val;
    const val = buildForecast({
      bankRecords: cb,
      cardStatements: cs || [],
      cfg: state.cfg,
      asOf,
      horizonDays,
    });
    _fc.set(horizonDays, { cb, cs, asOf, cfg: state.cfg, val });
    return val;
  }
  function forecastChart(horizonDays = 30) {
    return buildForecastChartModel(forecast(horizonDays));
  }
  // A snapshot for accuracy tracking; the caller persists it to the
  // forecastSnapshots store (never written here - this module has no I/O).
  function forecastSnapshot(horizonDays = 90) {
    return snapshotForAccuracy(forecast(horizonDays));
  }

  /* ===========================================================================
   * D (forecast accuracy loop): scores stored forecast snapshots against what
   * ACTUALLY happened. liquidAt is a thin wrapper around the SAME
   * liquidBalance(bankRecords, opts, asOf) primitive Overview/Position/the
   * forecast itself all read - so a scored "actual" can never disagree with
   * the balance shown anywhere else in the app. bankMaxDate is derived from
   * the SAME classifiedBank() rows every other bank-row reader in this app
   * already uses, so "does the ledger reach this horizon" is judged on the
   * identical data the forecast itself was built from.
   *
   * minToScore is config-driven (cfg.insights.accuracyMinToScore, default 3),
   * matching this app's existing tuning-surface pattern (categorySpikeMin,
   * paceMin, newMerchantMin, etc.) - no change to forecast-accuracy.js needed,
   * since accuracyReport already accepts minToScore as a parameter.
   * ======================================================================== */
  // Default aligned to the forecast chart's own default (30 days, ahead-render.js's
  // renderForecastChart(30)) rather than an unrelated 90-day default - the two
  // cards must describe the same window unless a caller deliberately asks
  // otherwise. 90-day snapshots simply won't exist going forward under this
  // default, so nothing here silently mixes two horizons' scored history.
  function accuracyFor(horizonDays = 30) {
    const cb = classifiedBank();
    const opts = resolveOpts(state.cfg);
    const liquidAt = (dateISO) => {
      const r = liquidBalance(cb, opts, dateISO);
      return r ? r.total : null;
    };
    const bankMaxDate = cb.reduce((mx, r) => ((r.date || '') > mx ? r.date || '' : mx), '');
    const minToScore = (state.cfg.insights && state.cfg.insights.accuracyMinToScore) || 3;
    const report = accuracyReport(state.forecastSnapshots || [], liquidAt, {
      todayISO: todayISO(),
      bankMaxDate,
      horizonDays,
      minToScore,
    });
    return buildAccuracyModel(report, state.cfg);
  }

  /* ---- position: cash & debt (reconciled) + coverage net worth + summary ---- */
  function positionModels() {
    const asOf = todayISO();
    const cd = cashAndDebt({
      bankRecords: classifiedBank(),
      cardStatements: state._cardStatements || [],
      cfg: state.cfg,
      asOf,
    });
    const nw = recordedNetWorth({
      reconciled: cd,
      manualAssets: state.manualAssets || [],
      asOf,
      fx: state.fxRates || null,
    });
    const summary = financialPositionSummary({
      cashDebt: cd,
      netWorth: nw,
      cfg: state.cfg,
      asOf,
      fx: state.fxRates || null,
    });
    return {
      cashDebt: cd,
      netWorth: nw,
      summary,
      cashDebtModel: buildCashDebtModel(cd, state.cfg),
      netWorthModel: buildNetWorthModel(nw, state.cfg),
    };
  }

  // Personal cross-category tags (B3a): joins state.tags against the SAME
  // combined card+bank rows the rest of this app already treats as one
  // ledger-agnostic set, so a tag's total can never disagree with any other
  // surface's idea of "what this transaction is". Ids are unique across
  // ledgers (transactionIdentity / bankTransactionIdentity), so no
  // collision risk mixing card rows and classifiedBank() rows here.
  function tags() {
    const rows = [...(state.rows || []), ...classifiedBank()];
    return tagTotals(state.tags || [], rows).map((tt) => buildTagModel(tt, state.cfg));
  }

  return {
    commitmentIncome,
    availableNow,
    committedFlexibleFor,
    spendBreakdownFor,
    spendBreakdownRawFor,
    paceFor,
    intentionFor,
    forecast,
    forecastChart,
    forecastSnapshot,
    positionModels,
    tags,
    accuracyFor,
  };
}
