/* ===========================================================================
 *  goal-progress-ctx.js  -  builds the progressCtx shape goals.js's
 *  goalProgress expects, from the app's already-computed models. Extracted
 *  from bootUI's closure (app.js) so it is a real, importable, top-level
 *  function - a function nested inside bootUI can never be exported for
 *  goal_engine_parity_proof.mjs to import directly.
 *
 *  Pure with respect to its OWN logic (no state mutation, no I/O); its
 *  inputs are the app's live model outputs, passed in explicitly via deps
 *  rather than closed over - the same "pass live data in, compute, return"
 *  shape every other proven module in this app already follows.
 *
 *  Unlike the OLD inline block this replaces (which self-computed "latest
 *  month with ANY data" for spend-ceiling), this takes month as an EXPLICIT
 *  required parameter for spend-ceiling - the caller supplies it, matching
 *  goalDataForMonth's own existing contract exactly. cushion/clear-card
 *  remain LIVE-ONLY (month is accepted but ignored for them), matching
 *  goalDataForMonth's own accepted design: reconstructing an honest
 *  historical cash position or card balance for an arbitrary past month is
 *  not attempted anywhere in this app.
 * ======================================================================== */

import { normaliseEair, medianRecentPayment } from './reporting.js';

// deps: { classifiedBank, overviewModel, typicalMonthlyOutflow, ymToday,
//         analyseBankActivity, bankFlowOverTime, state }
export function buildNewEngineProgressCtx(migratedGoal, opts = {}, deps) {
  const {
    classifiedBank,
    overviewModel,
    typicalMonthlyOutflow,
    ymToday,
    analyseBankActivity,
    bankFlowOverTime,
    state,
  } = deps;

  const cb = classifiedBank();
  const asOf = opts.asOf || new Date().toISOString().slice(0, 10);
  const { rollAllTrend, roll } = overviewModel();
  const monthlyOutflow = typicalMonthlyOutflow(rollAllTrend, ymToday());
  const dailyOutflow = monthlyOutflow / (365.25 / 12);
  const cashPosition = analyseBankActivity(cb).closingBalance;

  // No readable cash position: skip rather than let a cushion goal read a
  // misleading 0 days. Matches renderNoBalance's own reasoning.
  if (migratedGoal.type === 'cushion' && cashPosition == null) return null;

  const progressCtx = {
    asOf,
    typicalDailyOutflow: dailyOutflow,
    liquidNow: cashPosition,
    cardBalance: roll.cardOwed,
  };

  // G (clear-card engine extension): the SAME derivation goalDataForMonth
  // (app.js) already uses for the old engine's clear-card ctx - reused here
  // verbatim so the new engine's feasibility check reads the identical rate
  // and recent-payment history the old engine's projectCardPayoff always
  // did. Without this, goalProgress's clear-card branch still runs fine -
  // feasible just stays honestly null (unknown), and the model falls back
  // to the calm "needs about X a month" wording. This is what ACTIVATES
  // feasibility; it is not required for correctness.
  if (migratedGoal.type === 'clear-card') {
    const latestStmt = (state._cardStatements || [])
      .slice()
      .sort((a, b) => String(a.statementKey).localeCompare(String(b.statementKey)))
      .pop();
    progressCtx.eairFrac = latestStmt ? normaliseEair(latestStmt.eair) : null;
    progressCtx.typicalPayment = medianRecentPayment(state._cardStatements || []);
  }

  if (migratedGoal.type === 'spend-ceiling') {
    const month = opts.month;
    if (!month) return null; // mirrors goalDataForMonth's own guard
    const cardSpendForMonth =
      state.allSummary && state.allSummary.by_month ? state.allSummary.by_month[month] || 0 : 0;
    const bankTrend = bankFlowOverTime(cb);
    const bankRow = bankTrend.find((t) => t.month === month);
    progressCtx.spendThisPeriod = cardSpendForMonth + (bankRow ? bankRow.moneyOut : 0);
  }

  return progressCtx;
}
