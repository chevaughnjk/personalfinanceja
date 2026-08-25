/* ===========================================================================
 *  goals.js  -  measurable goals, the three-state safety boundary, and the
 *  safe-contribution guard. Composes the PROVEN primitive and forecast; it
 *  invents no numbers of its own.
 *
 *  FROZEN CONTRACT (pruned goal model):
 *   - THREE measurable types, each checkable from data:
 *       'cushion'      keep a cash buffer of N days of typical outflow
 *       'clear-card'   clear the card balance by a date
 *       'spend-ceiling' hold spending under an amount over a repeating period
 *   - Each goal carries: a measurable target, a date or continuing threshold, a
 *     present value (MEASURED, not entered), one forecast consequence, and one
 *     OPTIONAL personal trigger the person explicitly saves.
 *
 *  THE SAFETY BOUNDARY - three explicit states, never a silent judgement:
 *     1. 'chosen'     a value the person set
 *     2. 'calculated' a saved formula: known commitments + a chosen cushion
 *     3. 'none'       nothing configured -> show the projected low point and
 *                     assert nothing about safe / unsafe
 *   The app may SUGGEST a starting boundary, but it is inert until reviewed and
 *   saved (returned as `suggestion`, never applied).
 *
 *  THE SAFE-CONTRIBUTION GUARD:
 *   A goal never recommends a contribution that would push the forecast low
 *   point below the safety boundary. Where the target and available cash
 *   conflict, it states the shortfall and offers a smaller amount OR a later
 *   date - it never silently proceeds, and never states the decision for the
 *   person.
 *
 *  PURE and Node-testable. No DOM, no fetch, no mutation. Records live in the
 *  v4 `goals` store (keyPath 'id').
 *
 * G (clear-card engine extension, formerly KNOWN DEFERRED WORK): resolved.
 * buildGoalModel's clear-card branch now detects a passed deadline and
 * states payoff feasibility (via the locally-ported projectCardPayoffLocal,
 * below) - a true superset of the old reporting.js's computeGoalProgress.
 * met stays byte-identical (balance <= 1), so threeStateMetForLog's log
 * protection is untouched. g_clearcard_proof.mjs is the standing gate;
 * goal_engine_parity_proof.mjs's PART 3 now asserts the gap is CLOSED,
 * not that it exists. Retiring clear-card's LIVE CARD off the old engine
 * (ahead-render.js's renderGoalCardOldEngine) is its own separate, staged
 * step - not folded into this edit, same discipline as every retirement
 * this session.
 *
 * ======================================================================== */
import { resolveOpts } from './commitment-income.js';
import { buildForecast } from './forecast.js';

function toDate(iso) {
  return new Date(iso + 'T00:00:00Z');
}
function daysBetween(a, b) {
  return Math.round((toDate(b) - toDate(a)) / 86400000);
}
// Whole pay cycles from a to b, by CALENDAR month (what "clear it by December"
// actually means), not a 30-day approximation that turns 6 months into 7.
function monthsBetweenISO(a, b) {
  const da = toDate(a),
    db = toDate(b);
  let m = (db.getUTCFullYear() - da.getUTCFullYear()) * 12 + (db.getUTCMonth() - da.getUTCMonth());
  if (db.getUTCDate() < da.getUTCDate()) m -= 1; // not a full final month
  return m;
}
function addMonthsISO(iso, n) {
  const d = toDate(iso);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() + n);
  const dim = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, dim));
  return d.toISOString().slice(0, 10);
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

function formatGoalDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso == null ? '' : iso));
  if (!m) return String(iso == null ? '' : iso);
  const mi = +m[2] - 1;
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  if (mi < 0 || mi > 11) return String(iso);
  return `${m[3]}-${MON[mi]}-${m[1].slice(2)}`;
}

/* Ported from reporting.js's projectCardPayoff so goals.js gains NO new import
 * (keeping the proven module's dependency footprint intact - the old engine
 * pulls this from reporting.js; importing that here would drag in a large
 * dependency lineage, refused, same discipline as the goal-migration work).
 * Month-by-month amortisation: monthly rate compounds to the EAIR; returns
 * months to clear, or neverClears when a payment can't cover a month's
 * interest. Pure. */
function projectCardPayoffLocal(balance, eairFrac, payment) {
  if (!(balance > 0) || eairFrac == null || !(payment > 0)) return null;
  const rMo = Math.pow(1 + eairFrac, 1 / 12) - 1;
  if (payment <= balance * rMo) return { months: Infinity, neverClears: true };
  let bal = balance,
    months = 0;
  while (bal > 0.005 && months < 600) {
    bal = bal + bal * rMo - payment;
    if (bal < 0) bal = 0;
    months++;
  }
  return { months, neverClears: false };
}

/* ===========================================================================
 *  1) SAFETY BOUNDARY - the three explicit states.
 *     boundaryConfig is what the person has SAVED:
 *       { kind:'chosen', value }                       -> state 'chosen'
 *       { kind:'calculated', cushionDays }             -> state 'calculated'
 *       null / undefined / { kind:'none' }             -> state 'none'
 *     ctx supplies the live numbers (commitments/mo, typical daily outflow,
 *     projected low) so 'calculated' and 'none' resolve from real data.
 * ======================================================================== */
export function resolveSafetyBoundary(boundaryConfig, ctx = {}) {
  const cfgB = boundaryConfig || { kind: 'none' };
  const dailyOutflow = Number(ctx.typicalDailyOutflow) || 0;
  const commitmentsMonthly = Number(ctx.commitmentsMonthly) || 0;

  if (cfgB.kind === 'chosen' && cfgB.value != null) {
    return {
      state: 'chosen',
      floor: r2(cfgB.value),
      asserts: true,
      explain: 'A minimum balance you set.',
    };
  }
  if (cfgB.kind === 'calculated') {
    const cushionDays = Number(cfgB.cushionDays) || 0;
    const floor = r2(commitmentsMonthly + dailyOutflow * cushionDays);
    return {
      state: 'calculated',
      floor,
      asserts: true,
      cushionDays,
      explain: `Your regular commitments plus ${cushionDays} day${cushionDays === 1 ? '' : 's'} of typical spending.`,
    };
  }
  // 'none' - assert nothing; only report the projected low point.
  const suggestion =
    commitmentsMonthly > 0
      ? {
          kind: 'calculated',
          cushionDays: 30,
          floor: r2(commitmentsMonthly + dailyOutflow * 30),
        }
      : null;
  return {
    state: 'none',
    floor: null,
    asserts: false,
    projectedLow: ctx.projectedLow != null ? r2(ctx.projectedLow) : null,
    explain: 'No safe line is set, so the projected low point is shown without judging it.',
    suggestion, // inert; the app offers it, the person must save it
  };
}

/* ===========================================================================
 *  2) GOAL PROGRESS - present value MEASURED from data, per type.
 *     Each returns a normalised progress view + the pace needed to hit the
 *     target by its date, and one forecast consequence handle.
 * ======================================================================== */
export function goalProgress(goal, ctx = {}) {
  const now = ctx.asOf;
  if (goal.type === 'cushion') {
    // target: keep >= targetDays of typical daily outflow as cash.
    const dailyOutflow = Number(ctx.typicalDailyOutflow) || 0;
    const targetAmount = r2(dailyOutflow * (Number(goal.targetDays) || 0));
    const current = Number(ctx.liquidNow) || 0;
    const currentDays = dailyOutflow > 0 ? Math.floor(current / dailyOutflow) : null;
    return {
      type: 'cushion',
      targetDays: goal.targetDays,
      targetAmount,
      current: r2(current),
      currentDays,
      met: current >= targetAmount,
      shortfall: r2(Math.max(0, targetAmount - current)),
      threshold: true, // continuing threshold, not a one-off date
    };
  }
  if (goal.type === 'clear-card') {
    const balance = Number(ctx.cardBalance) || 0;
    const monthsLeft = goal.targetDate ? Math.max(1, monthsBetweenISO(now, goal.targetDate)) : null;
    const monthlyNeeded = monthsLeft ? r2(balance / monthsLeft) : null;
    // G (clear-card engine extension): two ADDITIVE fields. met stays EXACTLY
    // balance <= 1, unchanged - threeStateMetForLog's log protection depends
    // on this, and PART-1 of the parity proof asserts it stays this way.
    const deadlinePassed = goal.targetDate ? String(now) > String(goal.targetDate) : false;
    const eairFrac = ctx.eairFrac != null ? Number(ctx.eairFrac) : null;
    const typicalPayment = ctx.typicalPayment != null ? Number(ctx.typicalPayment) : null;
    // feasible: true/false only when a rate AND a payment are known and the
    // deadline is still open; null (unknown) otherwise, so the model degrades
    // to its old calm wording rather than inventing a verdict.
    let feasible = null;
    if (
      balance > 1 &&
      !deadlinePassed &&
      monthsLeft &&
      eairFrac != null &&
      typicalPayment != null
    ) {
      const proj = projectCardPayoffLocal(balance, eairFrac, typicalPayment);
      if (proj) feasible = !proj.neverClears && proj.months <= monthsLeft;
    }
    return {
      type: 'clear-card',
      targetDate: goal.targetDate,
      current: r2(balance),
      met: balance <= 1, // UNCHANGED - log protection (threeStateMetForLog) depends on this
      monthsLeft,
      monthlyNeeded, // the contribution the guard will vet
      deadlinePassed, // NEW
      feasible, // NEW: true | false | null (unknown)
    };
  }
  if (goal.type === 'spend-ceiling') {
    // continuing threshold: hold spending under `amount` over a repeating period.
    const spent = Number(ctx.spendThisPeriod) || 0;
    const ceiling = Number(goal.amount) || 0;
    return {
      type: 'spend-ceiling',
      ceiling: r2(ceiling),
      spent: r2(spent),
      remaining: r2(ceiling - spent),
      met: spent <= ceiling,
      threshold: true,
    };
  }
  return { type: goal.type, unsupported: true };
}

/* ===========================================================================
 *  3) SAFE-CONTRIBUTION GUARD - never push the forecast low below the safety
 *     boundary. Given a proposed monthly contribution and the forecast inputs,
 *     it re-runs the PROVEN forecast with the contribution added as a recurring
 *     outflow and checks the resulting low against the boundary floor.
 *
 *     Returns one of:
 *       { ok:true, contribution }                       - safe as proposed
 *       { ok:false, reason:'no-floor', ... }            - boundary is 'none':
 *           cannot vouch safety; reports projected low, asserts nothing
 *       { ok:false, shortfall, maxSafe, laterDate, ... } - conflict: offers a
 *           smaller amount OR a later date; never decides for the person
 * ======================================================================== */
export function safeContribution({
  bankRecords,
  cardStatements = [],
  cfg = {},
  asOf,
  proposedMonthly,
  boundary,
  goal = null,
  horizonDays = 90,
}) {
  const opts = resolveOpts(cfg);
  const contributionDay = 1; // model the contribution just after pay is settled

  const runWith = (monthly) =>
    buildForecast({
      bankRecords,
      cardStatements,
      cfg,
      asOf,
      horizonDays,
      // extra recurring outflow: a manual future item on day `contributionDay`
      // each month of the horizon. buildForecast accepts manualFutureItems via
      // the primitive path; here we fold it into the events by pre-seeding.
      manualFutureItems: monthlyContributionItems(asOf, horizonDays, contributionDay, monthly),
    });

  // If the boundary asserts nothing, we cannot vouch for safety - report the
  // projected low honestly and refuse to claim it is safe.
  if (!boundary || boundary.asserts === false || boundary.floor == null) {
    const fc = runWith(proposedMonthly);
    return {
      ok: false,
      reason: 'no-floor',
      projectedLow: fc.low.balance,
      projectedLowDate: fc.low.date,
      note: 'No safe line is set, so this contribution cannot be confirmed safe. The projected low point is shown for you to judge.',
    };
  }

  const floor = boundary.floor;
  const fcProposed = runWith(proposedMonthly);
  if (fcProposed.low.balance >= floor) {
    return {
      ok: true,
      contribution: r2(proposedMonthly),
      projectedLow: fcProposed.low.balance,
      floor,
    };
  }

  // Conflict: find the largest contribution that keeps the low at/above floor.
  // Monotonic in `monthly` (more contribution -> lower low), so binary search.
  let lo = 0,
    hi = proposedMonthly,
    maxSafe = 0;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    const fc = runWith(mid);
    if (fc.low.balance >= floor) {
      maxSafe = mid;
      lo = mid;
    } else {
      hi = mid;
    }
  }
  maxSafe = r2(maxSafe);

  // Alternative: keep the proposed amount but push the date out. If it's a
  // clear-card goal, compute the later date implied by maxSafe.
  let laterDate = null;
  if (
    goal &&
    goal.type === 'clear-card' &&
    ctxCardBalance(goal, cardStatements) > 0 &&
    maxSafe > 0
  ) {
    const months = Math.ceil(ctxCardBalance(goal, cardStatements) / maxSafe);
    laterDate = addMonthsISO(asOf, months);
  }

  return {
    ok: false,
    reason: 'conflict',
    proposed: r2(proposedMonthly),
    projectedLow: fcProposed.low.balance,
    floor,
    shortfall: r2(floor - fcProposed.low.balance),
    maxSafe, // "a smaller amount"
    laterDate, // "a later date" (clear-card only)
    note: `Contributing ${r2(proposedMonthly)} a month would dip your projected balance below your safe line. You could contribute up to ${maxSafe} a month instead${laterDate ? `, or keep the amount and move the date to ${laterDate}` : ''}.`,
  };
}

/* recurring monthly contribution as manual future items across the horizon */
function monthlyContributionItems(asOf, horizonDays, day, monthly) {
  if (!(monthly > 0)) return [];
  const out = [];
  const end = new Date(toDate(asOf).getTime() + horizonDays * 86400000).toISOString().slice(0, 10);
  let cur = addMonthsISO(asOf, 1);
  // align to `day`
  cur = cur.slice(0, 8) + String(day).padStart(2, '0');
  for (let g = 0; g < 24 && cur <= end; g++) {
    if (cur > asOf)
      out.push({
        key: 'goal-contribution',
        amount: -Math.abs(monthly),
        date: cur,
      });
    cur = addMonthsISO(cur, 1);
  }
  return out;
}
function ctxCardBalance(goal, cardStatements) {
  const stmts = (cardStatements || [])
    .slice()
    .sort((a, b) => String(a.statementKey).localeCompare(String(b.statementKey)));
  const latest = stmts[stmts.length - 1];
  return latest && latest.newBalance != null
    ? Math.abs(Number(latest.newBalance))
    : Number(goal.startingBalance) || 0;
}

/* ===========================================================================
 *  view-model - number/tag/detail, frozen shape. Pronoun-free tags; detail may
 *  address "you". A goal always shows its target, present value, and (when a
 *  contribution is in play) the guard's verdict.
 * ======================================================================== */
export function buildGoalModel(goal, progress, guard, cfg = {}) {
  const c = (cfg && cfg.currency) || {};
  let money;
  try {
    const f = new Intl.NumberFormat(c.locale || 'en-JM', {
      style: 'currency',
      currency: c.code || 'JMD',
      minimumFractionDigits: c.decimals == null ? 2 : c.decimals,
      maximumFractionDigits: c.decimals == null ? 2 : c.decimals,
    });
    money = (n) => f.format(Number(n || 0));
  } catch (_) {
    money = (n) => (c.symbol || '$') + Number(n || 0).toFixed(2);
  }

  let lead, tag, tone, detail;
  if (progress.type === 'cushion') {
    lead = progress.currentDays == null ? '-' : `${progress.currentDays} days`;
    tag = progress.met ? 'buffer met' : 'below buffer';
    tone = progress.met ? 'good' : 'watch';
    detail = progress.met
      ? `Your cash covers about ${progress.currentDays} days of typical spending, at or above your ${goal.targetDays}-day target.`
      : `Your cash covers about ${progress.currentDays} days of typical spending, short of your ${goal.targetDays}-day target by ${money(progress.shortfall)}.`;
  } else if (progress.type === 'clear-card') {
    lead = money(progress.current);
    if (progress.met) {
      tag = 'cleared';
      tone = 'good';
      detail = 'The card is effectively clear.';
    } else if (progress.deadlinePassed) {
      // G: a passed deadline is stated plainly, not dressed as a forward plan.
      tag = 'deadline passed';
      tone = 'watch';
      detail = `The ${formatGoalDate(goal.targetDate)} deadline has passed and ${money(progress.current)} is still owed.`;
    } else {
      const base = `Clearing ${money(progress.current)} by ${formatGoalDate(goal.targetDate)} needs about ${money(progress.monthlyNeeded)} a month`;
      if (progress.feasible === true) {
        tag = 'on track';
        tone = 'good';
        detail = `${base}, which is on track at your recent pace.`;
      } else if (progress.feasible === false) {
        tag = 'behind';
        tone = 'watch';
        detail = `${base} - more than your recent payments, so it would clear after ${formatGoalDate(goal.targetDate)}, not by it.`;
      } else {
        // feasibility unknown (no rate/payment) -> the ORIGINAL calm wording, unchanged.
        tag = progress.monthlyNeeded != null ? 'on a plan' : 'no date set';
        tone = 'neutral';
        detail = `${base}.`;
      }
    }
  } else if (progress.type === 'spend-ceiling') {
    lead = money(progress.spent);
    tag = progress.met ? 'within ceiling' : 'over ceiling';
    tone = progress.met ? 'good' : 'watch';
    detail = `${money(progress.spent)} of your ${money(progress.ceiling)} ceiling this period, ${money(Math.abs(progress.remaining))} ${progress.remaining >= 0 ? 'remaining' : 'over'}.`;
  } else {
    lead = '-';
    tag = '';
    tone = 'neutral';
    detail = 'Unsupported goal type.';
  }

  const guardBlock = guard
    ? {
        ok: guard.ok,
        tag: guard.ok
          ? 'contribution safe'
          : guard.reason === 'no-floor'
            ? 'no safe line set'
            : 'would dip below safe line',
        tone: guard.ok ? 'good' : 'watch',
        detail:
          guard.note ||
          (guard.ok
            ? `Contributing ${money(guard.contribution)} a month keeps your projected balance above your safe line.`
            : ''),
      }
    : null;

  return {
    id: goal.id,
    type: progress.type,
    leadText: lead,
    tag, // pronoun-free
    tone,
    detail,
    guard: guardBlock, // present only when a contribution is being vetted
    trigger: goal.trigger || null, // optional, person-authored; shown, never invented here
  };
}

/* helper: build a stored goal record (edits create new records where relevant) */
export function makeGoal(fields, now = new Date().toISOString()) {
  const id = `goal_${Math.random().toString(36).slice(2, 10)}`;
  return {
    id,
    active: true,
    createdAt: now,
    updatedAt: now,
    trigger: null,
    ...fields,
  };
}

/* ===========================================================================
 *  evaluateGoal - ADDITIVE composition of the two exports above, for a
 *  caller that only needs progress + a headline (no contribution guard).
 *  Adds ZERO new imports and touches NONE of the five existing exports
 *  (resolveSafetyBoundary, goalProgress, safeContribution, buildGoalModel,
 *  makeGoal), all of which remain byte-for-byte unchanged above this point.
 *  guard is always null here; a caller that IS vetting a contribution (the
 *  live Ahead comparison card) keeps calling safeContribution itself and
 *  passes its result to buildGoalModel directly, exactly as before.
 * ======================================================================== */
export function evaluateGoal(goal, progressCtx, cfg = {}) {
  const progress = goalProgress(goal, progressCtx);
  if (progress.unsupported) return null;
  const model = buildGoalModel(goal, progress, null, cfg);
  return { progress, model };
}
