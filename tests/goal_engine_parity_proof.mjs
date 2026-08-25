/* ===========================================================================
 *  goal_engine_parity_proof.mjs  -  Step 3's standing gate: proves the
 *  OLD engine (reporting.js's computeGoalProgress) and the NEW engine
 *  (goals.js's goalProgress) agree on `met` wherever they must, and
 *  encodes the TWO accepted, deliberate divergences as hard assertions -
 *  not prose - so a future change that accidentally re-aligns either one
 *  fails loudly and forces a conscious decision, rather than silently
 *  reintroducing a regression this proof already caught once.
 *
 *  Run alongside goal_migrate_proof.mjs and cross_screen_consistency.mjs
 *  as the third standing gate for the goal-system migration:
 *
 *      node tests/goal_engine_parity_proof.mjs
 *
 *  PART 1 (met-field parity): old computeGoalProgress vs new goalProgress,
 *  same real-world facts, same goal types.
 *
 *  PART 2 (context-builder regression coverage): buildNewEngineProgressCtx
 *  (goal-progress-ctx.js) against FIXED EXPECTED VALUES, not a second "old"
 *  implementation to diff against - the historical inline block it once
 *  replaced (inside ahead-render.js's live comparison card) no longer
 *  exists on disk, since the Step 3 repoint deleted it in favour of this
 *  shared builder. These fixtures are what that now-deleted block WOULD
 *  have produced on the same inputs, frozen at the moment the extraction
 *  was proven faithful - so this still catches any future accidental
 *  change to buildNewEngineProgressCtx's own behaviour.
 *
 *  THE TWO ACCEPTED DIVERGENCES (decisions, not bugs):
 *   1. cushion, rounding-boundary case: old engine rounds days first then
 *      compares integers; new engine compares raw dollar amounts. Accepted
 *      as-is - the new engine's raw comparison is MORE honest (no
 *      artificial day-rounding), the window is ~1 day of outflow wide, and
 *      "fixing" it would mean editing the PROVEN module's math to match a
 *      legacy rounding quirk, inverting the whole point of migrating
 *      toward it.
 *   2. clear-card, in-progress-on-track case: the new engine's goalProgress
 *      returns a strict boolean (met:false) for any unfinished clear-card
 *      goal; the old engine distinguished three real states (met:true /
 *      false / null-still-trying). This divergence is NOT accepted at the
 *      goalProgress layer - it is EXPLICITLY HANDLED one layer up, in
 *      app.js's threeStateMetForLog, which is what state.goalLog actually
 *      stores. This proof asserts BOTH halves: that goalProgress itself
 *      still diverges (proving the raw new-engine behaviour hasn't
 *      silently changed under it) AND that the log-level fix (a local
 *      re-implementation of app.js's threeStateMetForLog, kept here so
 *      this proof needs no browser/bootUI to run) is correctly implemented.
 *
 *  IMPORTANT: threeStateMetForLog below is a COPY of the real function in
 *  app.js's bootUI closure (which cannot be imported directly - it boots a
 *  browser UI and is not a top-level export). If app.js's real
 *  threeStateMetForLog is ever changed, this copy must be updated to
 *  match by hand - the same manual-sync risk this app's own openModal/
 *  requireCtx comment already documents for ctx wiring. Kept deliberately
 *  tiny and simple to minimise that risk.
 * ======================================================================== */
import { computeGoalProgress } from '../application/analysis/reporting.js';
import { goalProgress, buildGoalModel } from '../application/analysis/goals.js';
import { buildNewEngineProgressCtx } from '../application/analysis/goal-progress-ctx.js';

let pass = 0,
  fail = 0;
const deepEq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const note = (label, cond) => {
  if (cond) {
    pass++;
    console.log(`  [PASS] ${label}`);
  } else {
    fail++;
    console.log(`  [FAIL] ${label}`);
  }
};

const bankMoney = (n) => '$' + Number(n || 0).toLocaleString();
const formatDisplayDate = (iso) => iso;

// COPY of app.js's real threeStateMetForLog - see file header for why this
// cannot be imported directly, and the manual-sync obligation that implies.
function threeStateMetForLog(migratedGoal, progress, now) {
  if (migratedGoal.type !== 'clear-card') return progress.met;
  if (progress.current <= 1) return true;
  const targetMs = Date.parse(migratedGoal.targetDate);
  if (Number.isFinite(targetMs) && now.getTime() > targetMs) return false;
  return null;
}

console.log('='.repeat(78));
console.log(' GOAL ENGINE PARITY PROOF - old vs new, agreements + accepted divergences');
console.log('='.repeat(78));

console.log('\nPART 1: met-field parity (old computeGoalProgress vs new goalProgress)');
console.log('-'.repeat(78));

console.log('\n-- cushion --');
{
  const goal = { type: 'cushion', targetDays: 90 };
  const dailyOutflow = 1000;
  const cashPosition = 120000;
  const oldResult = computeGoalProgress(
    goal,
    { runwayDays: Math.max(0, Math.round(cashPosition / dailyOutflow)) },
    bankMoney,
    formatDisplayDate
  );
  const newResult = goalProgress(goal, {
    typicalDailyOutflow: dailyOutflow,
    liquidNow: cashPosition,
  });
  note(
    'comfortable margin: engines AGREE (met=true both)',
    oldResult.met === true && newResult.met === true
  );
}
{
  // ACCEPTED DIVERGENCE #1, asserted explicitly.
  const goal = { type: 'cushion', targetDays: 90 };
  const dailyOutflow = 1000;
  const cashPosition = 89550; // 89.55 days -> rounds to 90 (old) but < 90000 raw (new)
  const oldResult = computeGoalProgress(
    goal,
    { runwayDays: Math.max(0, Math.round(cashPosition / dailyOutflow)) },
    bankMoney,
    formatDisplayDate
  );
  const newResult = goalProgress(goal, {
    typicalDailyOutflow: dailyOutflow,
    liquidNow: cashPosition,
  });
  note(
    'ACCEPTED DIVERGENCE #1 (rounding boundary): old.met=true, new.met=false - still diverges as decided',
    oldResult.met === true && newResult.met === false
  );
}

console.log('\n-- clear-card --');
{
  const goal = { type: 'clear-card', targetDate: '2026-12-31' };
  const oldResult = computeGoalProgress(
    goal,
    { cardOwed: 0, now: new Date('2026-08-31') },
    bankMoney,
    formatDisplayDate
  );
  const newResult = goalProgress(goal, { asOf: '2026-08-31', cardBalance: 0 });
  note('cleared: engines AGREE (met=true both)', oldResult.met === true && newResult.met === true);
}
{
  const goal = { type: 'clear-card', targetDate: '2026-01-01' };
  const oldResult = computeGoalProgress(
    goal,
    { cardOwed: 50000, now: new Date('2026-08-31') },
    bankMoney,
    formatDisplayDate
  );
  const newResult = goalProgress(goal, {
    asOf: '2026-08-31',
    cardBalance: 50000,
  });
  note(
    'deadline passed: engines AGREE (met=false both)',
    oldResult.met === false && newResult.met === false
  );
}
{
  // ACCEPTED DIVERGENCE #2 at the goalProgress layer, asserted explicitly.
  const goal = { type: 'clear-card', targetDate: '2026-12-31' };
  const oldResult = computeGoalProgress(
    goal,
    {
      cardOwed: 257610.28,
      eairFrac: 0.42,
      typicalPayment: 60000,
      now: new Date('2026-08-31'),
    },
    bankMoney,
    formatDisplayDate
  );
  const newResult = goalProgress(goal, {
    asOf: '2026-08-31',
    cardBalance: 257610.28,
  });
  note(
    'ACCEPTED DIVERGENCE #2 (in-progress): raw goalProgress old.met=null, new.met=false - still diverges as decided',
    oldResult.met === null && newResult.met === false
  );

  // THE ACTUAL PROTECTION: threeStateMetForLog must recover the three-state
  // distinction for what state.goalLog actually stores.
  const now = new Date('2026-08-31');
  const migrated = { type: 'clear-card', targetDate: '2026-12-31' };
  const logMet = threeStateMetForLog(migrated, newResult, now);
  note(
    'LOG PROTECTION: threeStateMetForLog recovers met=null for in-progress-on-track (grey dot, not orange)',
    logMet === null
  );
}
{
  const now = new Date('2027-06-01'); // well past the target date
  const migrated = { type: 'clear-card', targetDate: '2026-12-31' };
  const progress = { current: 50000 };
  const logMet = threeStateMetForLog(migrated, progress, now);
  note(
    'LOG PROTECTION: threeStateMetForLog reports met=false once deadline has genuinely passed',
    logMet === false
  );
}
{
  const now = new Date('2026-08-31');
  const migrated = { type: 'clear-card', targetDate: '2026-12-31' };
  const progress = { current: 0 };
  const logMet = threeStateMetForLog(migrated, progress, now);
  note('LOG PROTECTION: threeStateMetForLog reports met=true once cleared', logMet === true);
}

console.log('\n-- spend-ceiling --');
{
  const goal = { type: 'spend-ceiling', amount: 100000 };
  const oldResult = computeGoalProgress(
    goal,
    { monthSpend: 475646.37, monthLabel: 'July 2026' },
    bankMoney,
    formatDisplayDate
  );
  const newResult = goalProgress(goal, { spendThisPeriod: 475646.37 });
  note(
    'over ceiling: engines AGREE (met=false both)',
    oldResult.met === false && newResult.met === false
  );
}
{
  const goal = { type: 'spend-ceiling', amount: 100000 };
  const oldResult = computeGoalProgress(
    goal,
    { monthSpend: 45000, monthLabel: 'July 2026' },
    bankMoney,
    formatDisplayDate
  );
  const newResult = goalProgress(goal, { spendThisPeriod: 45000 });
  note(
    'under ceiling: engines AGREE (met=true both)',
    oldResult.met === true && newResult.met === true
  );
}

console.log('\nPART 2: buildNewEngineProgressCtx - fixed-expectation regression coverage');
console.log('-'.repeat(78));

function makeDeps(overrides = {}) {
  return {
    classifiedBank: () => [{ id: 1 }],
    overviewModel: () => ({
      rollAllTrend: [
        { month: '2026-06', spending: 50000 },
        { month: '2026-07', spending: 52000 },
      ],
      roll: { cardOwed: 257610.28 },
    }),
    typicalMonthlyOutflow: (trend) => {
      const s = trend.map((t) => t.spending);
      return s.reduce((a, b) => a + b, 0) / s.length;
    },
    ymToday: () => '2026-08',
    analyseBankActivity: () => ({ closingBalance: 2220032.54 }),
    state: {
      allSummary: {
        months: ['2026-06', '2026-07'],
        by_month: { '2026-06': 40000, '2026-07': 475646.37 },
      },
      bankRecords: [{ date: '2026-07-15' }, { date: '2026-06-10' }],
    },
    bankFlowOverTime: () => [
      { month: '2026-07', moneyOut: 12000 },
      { month: '2026-06', moneyOut: 8000 },
    ],
    ...overrides,
  };
}

{
  const deps = makeDeps();
  const migrated = { type: 'cushion', targetDays: 90 };
  const ctx = buildNewEngineProgressCtx(migrated, { asOf: '2026-08-31', month: '2026-07' }, deps);
  // Fixed expected values, frozen at extraction time (see file header).
  note(
    'cushion, cash present: matches frozen expected shape',
    ctx &&
      ctx.asOf === '2026-08-31' &&
      ctx.liquidNow === 2220032.54 &&
      ctx.cardBalance === 257610.28 &&
      Math.abs(ctx.typicalDailyOutflow - 51000 / (365.25 / 12)) < 0.01
  );
}
{
  const deps = makeDeps({
    analyseBankActivity: () => ({ closingBalance: null }),
  });
  const migrated = { type: 'cushion', targetDays: 90 };
  const ctx = buildNewEngineProgressCtx(migrated, { month: '2026-07' }, deps);
  note(
    'cushion, NO cash position: correctly returns null (never a misleading 0 days)',
    ctx === null
  );
}
{
  const deps = makeDeps();
  const migrated = { type: 'clear-card', targetDate: '2026-12-31' };
  const ctxJune = buildNewEngineProgressCtx(
    migrated,
    { asOf: '2026-08-31', month: '2026-06' },
    deps
  );
  const ctxJuly = buildNewEngineProgressCtx(
    migrated,
    { asOf: '2026-08-31', month: '2026-07' },
    deps
  );
  note(
    "clear-card: month has NO effect (live-only, matching goalDataForMonth's own design)",
    deepEq(ctxJune, ctxJuly)
  );
}
{
  const deps = makeDeps();
  const migrated = { type: 'spend-ceiling', amount: 100000 };
  const ctx = buildNewEngineProgressCtx(migrated, { asOf: '2026-08-31', month: '2026-07' }, deps);
  // Frozen expected value: July card spend (475646.37) + July bank moneyOut (12000).
  note(
    'spend-ceiling, July: spendThisPeriod matches frozen expected value (487646.37)',
    ctx && Math.abs(ctx.spendThisPeriod - 487646.37) < 0.01
  );
}
{
  const deps = makeDeps();
  const migrated = { type: 'spend-ceiling', amount: 100000 };
  const ctx = buildNewEngineProgressCtx(migrated, { asOf: '2026-08-31', month: '2026-06' }, deps);
  // Frozen expected value: June card spend (40000) + June bank moneyOut (8000).
  note(
    'spend-ceiling, June: spendThisPeriod matches frozen expected value (48000)',
    ctx && Math.abs(ctx.spendThisPeriod - 48000) < 0.01
  );
}
{
  const deps = makeDeps();
  const migrated = { type: 'spend-ceiling', amount: 100000 };
  const ctx = buildNewEngineProgressCtx(migrated, { asOf: '2026-08-31' }, deps); // no month supplied
  note(
    "spend-ceiling, NO month supplied: correctly returns null (mirrors goalDataForMonth's own guard)",
    ctx === null
  );
}

console.log(
  '\nPART 3: LIVE-CARD RETIREMENT SCOPE - which types retire, and why it is now all of them'
);
console.log('-'.repeat(78));
console.log('  Decision recorded HERE, not just in a comment: cushion and');
console.log('  spend-ceiling retired first; clear-card retired once G (the');
console.log('  clear-card engine extension) added deadline-passed detection');
console.log('  and payoff-feasibility checking to buildGoalModel. All three');
console.log('  goal types now render from this one engine on the live card.');
{
  const goal = { type: 'cushion', targetDays: 90 };
  const progress = goalProgress(goal, {
    typicalDailyOutflow: 16575.63,
    liquidNow: 2220032.54,
  });
  const model = buildGoalModel(goal, progress, null, {});
  const looksPlain =
    /days of typical spending/.test(model.detail) &&
    !/guard|contribution|boundary/i.test(model.detail);
  note("RETIRE cushion: new engine's detail string is plain/calm, safe as sole lead", looksPlain);
}
{
  const goal = { type: 'spend-ceiling', amount: 100000 };
  const progress = goalProgress(goal, { spendThisPeriod: 45000 });
  const model = buildGoalModel(goal, progress, null, {});
  const looksPlain =
    /ceiling this period/.test(model.detail) && !/guard|contribution|boundary/i.test(model.detail);
  note(
    "RETIRE spend-ceiling: new engine's detail string is plain/calm, safe as sole lead",
    looksPlain
  );
}
{
  // The sentence TEMPLATE is identical whether a clear-card deadline is
  // decades away or years past - it never says "this deadline has already
  // passed", even though goalProgress's own met:false already knows it has.
  // (The required-pace NUMBER does differ once past - monthsBetweenISO
  // floors to 1 month - but the MEANING conveyed stays wrong either way.)
  const goalFuture = { type: 'clear-card', targetDate: '2099-01-01' };
  const goalPast = { type: 'clear-card', targetDate: '2020-01-01' };
  const progressFuture = goalProgress(goalFuture, {
    asOf: '2026-08-31',
    cardBalance: 50000,
  });
  const progressPast = goalProgress(goalPast, {
    asOf: '2026-08-31',
    cardBalance: 50000,
  });
  const modelFuture = buildGoalModel(goalFuture, progressFuture, null, {});
  const modelPast = buildGoalModel(goalPast, progressPast, null, {});
  // G: the gap is now CLOSED - a future deadline still reads as a forward
  // plan, but a passed one now says so plainly. This assertion is inverted
  // from its pre-G form (which proved the gap existed); it now proves G
  // closed it.
  const futureIsForwardPlan = /needs about/i.test(modelFuture.detail);
  const pastMentionsPassed = /passed|already|missed|overdue/i.test(modelPast.detail);
  note(
    'RETIRE clear-card (G): a passed deadline now states plainly that it has passed, while a future one stays a forward plan',
    futureIsForwardPlan && pastMentionsPassed
  );
}
{
  // Same wording shape whether the required pace is trivial or wildly
  // beyond anything the person has ever actually paid - no achievability
  // signal at all, unlike the old engine's on-track/off-track comparison.
  const goal = { type: 'clear-card', targetDate: '2026-12-31' };
  const progressEasy = goalProgress(goal, {
    asOf: '2026-08-31',
    cardBalance: 10000,
  });
  const progressHard = goalProgress(goal, {
    asOf: '2026-08-31',
    cardBalance: 10000000,
  });
  const modelEasy = buildGoalModel(goal, progressEasy, null, {});
  const modelHard = buildGoalModel(goal, progressHard, null, {});
  // G: the gap is now CLOSED - feasibility is only computable when eairFrac
  // AND typicalPayment are supplied. This test supplies both, so the model
  // must now distinguish an achievable pace from an implausible one.
  const progressEasyG = goalProgress(goal, {
    asOf: '2026-08-31',
    cardBalance: 10000,
    eairFrac: 0.42,
    typicalPayment: 60000,
  });
  const progressHardG = goalProgress(goal, {
    asOf: '2026-08-31',
    cardBalance: 10000000,
    eairFrac: 0.42,
    typicalPayment: 60000,
  });
  const modelEasyG = buildGoalModel(goal, progressEasyG, null, {});
  const modelHardG = buildGoalModel(goal, progressHardG, null, {});
  const easyStatesOnTrack = /on track/i.test(modelEasyG.detail);
  const hardStatesBehind = /not by it|after/i.test(modelHardG.detail);
  note(
    'RETIRE clear-card (G): with rate + payment data supplied, the model now states achievability (on track vs would clear after)',
    easyStatesOnTrack && hardStatesBehind
  );
}

console.log('\n' + '='.repeat(78));
console.log(`checks: ${pass} passed, ${fail} failed`);
console.log('='.repeat(78));
process.exit(fail ? 1 : 0);
