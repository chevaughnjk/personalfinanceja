/* ===========================================================================
 *  category-intentions.js  -  category spending intentions + the ONE precedence
 *  resolver that Activity, Needs-attention and Goals all read, so they can
 *  never compute against different boundaries.
 *
 *  This is the honest, forward half of a budget: a person names a ceiling on a
 *  category, and it surfaces as PACE (spend-so-far vs time-elapsed), never as a
 *  retrospective score. No grade, no streak, no guilt language - by design.
 *
 *  PURE and Node-testable. No DOM, no fetch, no mutation. Records come from the
 *  v4 `categoryIntentions` store (keyPath 'id').
 *
 *  INTENTION RECORD SHAPE (stored):
 *    {
 *      id, category, amount,
 *      kind: 'repeating' | 'month',
 *      month:        'YYYY-MM'   // only for kind='month' (a dated override)
 *      effectiveFrom:'YYYY-MM'   // only for kind='repeating' (non-retroactive)
 *      active:       true|false,
 *      createdAt, updatedAt
 *    }
 *
 *  PRECEDENCE RULES (frozen contract, locked correction #4):
 *    1. A dated one-month intention OVERRIDES the repeating intention for its
 *       exact month.
 *    2. When that month ends, the repeating intention RESUMES automatically.
 *    3. Changing an intention NEVER rewrites previous months: an edit is a new
 *       repeating record with a later effectiveFrom; the old record still
 *       governs the months before that. The resolver picks the repeating record
 *       with the latest effectiveFrom <= the target month.
 *    4. Pace uses ONLY transactions inside the applicable period.
 *    5. Refunds, exclusions and split transactions follow the SAME shared
 *       category calculation used everywhere else - passed in as
 *       `categorySpendInMonth`, never re-derived here.
 * ======================================================================== */
import { resolveOpts } from './commitment-income.js';

function ymOf(iso) {
  return String(iso || '').slice(0, 7);
}
function domOf(iso) {
  return +String(iso || '').slice(8, 10) || 0;
}
function daysInMonth(ym) {
  const y = +ym.slice(0, 4),
    mo = +ym.slice(5, 7);
  return new Date(Date.UTC(y, mo, 0)).getUTCDate();
}
function r2(n) {
  return Math.round(Number(n || 0) * 100) / 100;
}

/* ===========================================================================
 *  resolveIntention - THE single precedence resolver. Given all intentions for
 *  a category and a target month, return the one that governs, or null.
 *  Read identically by Activity, Needs-attention and Goals.
 * ======================================================================== */
export function resolveIntention(intentions, category, targetMonth) {
  const mine = (intentions || []).filter(
    (it) => it && it.active !== false && it.category === category
  );

  // Rule 1: a dated one-month override for exactly this month wins.
  const override = mine.find((it) => it.kind === 'month' && it.month === targetMonth);
  if (override) return { ...override, source: 'month-override' };

  // Rules 2 & 3: otherwise the repeating record with the latest effectiveFrom
  // that is <= the target month. (Resume after an override happens for free,
  // because the override only matched its own month.) Non-retroactive: a record
  // whose effectiveFrom is AFTER the target month does not apply, so editing
  // never rewrites earlier months.
  const repeating = mine
    .filter((it) => it.kind === 'repeating' && String(it.effectiveFrom || '') <= targetMonth)
    .sort((a, b) => {
      const byEffectiveFrom = String(b.effectiveFrom).localeCompare(String(a.effectiveFrom));
      if (byEffectiveFrom !== 0) return byEffectiveFrom;
      // Tiebreak: two repeating records can share the SAME effectiveFrom when
      // an edit is authored inside the period it already governs (editing
      // July's ceiling while July is still current, rather than the change
      // only taking effect next month). Without this, sort's stability
      // preserves INSERTION order on the tie, so the resolver would keep
      // returning the STALE ceiling after a save - the edit would silently
      // never take effect. The most recently CREATED record wins the tie;
      // effectiveFrom alone still protects every month BEFORE it from being
      // rewritten (Rule 3's real, unaffected guarantee).
      return String(b.createdAt || '').localeCompare(String(a.createdAt || ''));
    });
  if (repeating.length) return { ...repeating[0], source: 'repeating' };

  return null;
}

/* ===========================================================================
 *  paceForMonth - the forward pace signal for a resolved intention.
 *  spendSoFar and monthTotalSpend MUST come from the shared category calc
 *  (refunds/exclusions/splits already applied) - this function never re-derives
 *  category spend, it only turns it into a pace reading.
 *
 *  asOfDay: the day-of-month "today" within the target month (1..daysInMonth).
 *  For a COMPLETED past month, pass the full month (asOfDay = daysInMonth) and
 *  spendSoFar = monthTotalSpend.
 * ======================================================================== */
export function paceForMonth({ intention, targetMonth, spendSoFar, asOfDay, cfg = {} }) {
  const opts = resolveOpts(cfg);
  if (!intention) return null;
  const ceiling = Number(intention.amount) || 0;
  const dim = daysInMonth(targetMonth);
  const day = Math.max(1, Math.min(asOfDay || dim, dim));
  const fracElapsed = day / dim;

  // Linear projection of the full month from spend-so-far. Deliberately simple
  // and explainable; pace is a signal, not a forecast.
  const projected = fracElapsed > 0 ? r2(spendSoFar / fracElapsed) : 0;
  const expectedByNow = r2(ceiling * fracElapsed); // pro-rata ceiling to date
  const overBy = r2(projected - ceiling);

  // Signal thresholds use the same tolerance the rest of the app uses.
  let signal;
  if (ceiling <= 0) signal = 'no-ceiling';
  else if (projected > ceiling * (1 + opts.tolerance))
    signal = 'ahead-of-pace'; // will overshoot
  else if (projected < ceiling * (1 - opts.tolerance))
    signal = 'under-pace'; // comfortably under
  else signal = 'on-pace';

  return {
    category: intention.category,
    ceiling: r2(ceiling),
    source: intention.source,
    day,
    daysInMonth: dim,
    spendSoFar: r2(spendSoFar),
    projected,
    expectedByNow,
    overBy,
    signal, // 'on-pace' | 'ahead-of-pace' | 'under-pace' | 'no-ceiling'
  };
}

/* ===========================================================================
 *  view-model - number/tag/detail, frozen shape. Forward, pace-based language
 *  ONLY. No "over budget", no grade, no streak - the frozen no-guilt rule.
 * ======================================================================== */
export function buildPaceModel(pace, cfg = {}) {
  if (!pace) return null;
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

  const tagBy = {
    'on-pace': 'on track',
    'ahead-of-pace': 'spending fast',
    'under-pace': 'well under',
    'no-ceiling': '',
  };
  const toneBy = {
    'on-pace': 'good',
    'ahead-of-pace': 'watch',
    'under-pace': 'good',
    'no-ceiling': 'neutral',
  };

  // forward, plain-language detail; names the day so the pace is legible
  let detail;
  if (pace.signal === 'ahead-of-pace') {
    detail = `${pace.category} is on pace for about ${money(pace.projected)} this month against your ${money(pace.ceiling)} ceiling, and it is only day ${pace.day} of ${pace.daysInMonth}.`;
  } else if (pace.signal === 'under-pace') {
    detail = `${pace.category} is on pace for about ${money(pace.projected)} this month, comfortably under your ${money(pace.ceiling)} ceiling, on day ${pace.day} of ${pace.daysInMonth}.`;
  } else if (pace.signal === 'on-pace') {
    detail = `${pace.category} is tracking close to your ${money(pace.ceiling)} ceiling, on pace for about ${money(pace.projected)} by month end.`;
  } else {
    detail = `${pace.category}: no ceiling set.`;
  }

  return {
    category: pace.category,
    amount: pace.projected,
    amountText: money(pace.projected),
    ceilingText: money(pace.ceiling),
    spentText: money(pace.spendSoFar),
    tag: tagBy[pace.signal] || '', // pronoun-free
    tone: toneBy[pace.signal] || 'neutral',
    signal: pace.signal,
    detail,
  };
}

/* ---- helper to build a stored record (id + timestamps), for the app to save.
 *      Kept here so the shape lives in one place. Edits should CREATE a new
 *      repeating record with a later effectiveFrom, never mutate an old one. -- */
export function makeIntention({
  category,
  amount,
  kind,
  month = null,
  effectiveFrom = null,
  now = new Date().toISOString(),
}) {
  const id = `int_${Math.random().toString(36).slice(2, 10)}`;
  const base = {
    id,
    category,
    amount: r2(amount),
    kind,
    active: true,
    createdAt: now,
    updatedAt: now,
  };
  if (kind === 'month') return { ...base, month };
  return { ...base, effectiveFrom: effectiveFrom || ymOf(now) };
}
