/* ===========================================================================
 *  position.js  -  "Position" (renamed from Net Worth). Three jobs, split by
 *  DATA SOURCE so the reconciled half carries the value with no upkeep and the
 *  manual half is dated and visibly ageing.
 *
 *  FROZEN CONTRACT:
 *   1. Cash and debt (RECONCILED): cash position, card balance, utilisation,
 *      income stability, cash-flow summary. All from imported data. No upkeep.
 *   2. Recorded net worth (COVERAGE, never "complete"): assets - liabilities,
 *      reported with the classes INCLUDED and the classes NOT included / not
 *      confirmed, and a last-reviewed date. Manual assets decay visibly.
 *   3. Financial-position summary: an export from selected evidence, every
 *      figure carrying its PERIOD and SOURCE. Explicitly NOT "bank-ready".
 *
 *  INTEGRITY RULE (threaded throughout): a recorded figure and a self-reported
 *  figure never wear the same authority, and partial data never produces a
 *  complete-sounding conclusion. Net worth is therefore always "recorded" +
 *  a coverage statement, never a bare total.
 *
 *  PURE and Node-testable. No DOM, no fetch, no mutation. Manual assets live in
 *  the v4 `manualAssets` store (keyPath 'id').
 * ======================================================================== */
import { resolveOpts, liquidBalance, detectRecurring } from './commitment-income.js';

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
  return String(iso || '').slice(0, 7);
}
function daysBetween(a, b) {
  return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
}

/* the standard asset/liability classes we KNOW might exist but often can't see
 * from statements alone. Used to report coverage honestly. */
export const NET_WORTH_CLASSES = {
  assets: ['Cash & bank', 'Investments', 'Property', 'Vehicle', 'Pension', 'Other assets'],
  liabilities: ['Credit card', 'Loans', 'Mortgage', 'Hire purchase', 'Other debts'],
};

/* ===========================================================================
 *  1) CASH AND DEBT - fully reconciled, no upkeep.
 * ======================================================================== */
export function cashAndDebt({ bankRecords = [], cardStatements = [], cfg = {}, asOf }) {
  const opts = resolveOpts(cfg);
  const base = opts.baseCurrency;

  // liquid (base ccy) via the shared calc
  const liquid = liquidBalance(bankRecords, opts, asOf);

  // foreign balances, per currency, latest as-of (kept SEPARATE, never blended)
  const foreign = {};
  const seenForeign = new Map(); // ccy -> account -> {date, bal}
  for (const r of bankRecords) {
    const ccy = String(r.currency || r.Currency || base);
    if (ccy === base) continue;
    const bal =
      r.balanceAfter != null
        ? Number(r.balanceAfter)
        : r['Running Balance'] !== undefined && r['Running Balance'] !== ''
          ? Number(r['Running Balance'])
          : null;
    if (bal == null || Number.isNaN(bal)) continue;
    const d = String(r.date || r.Date || '');
    if (asOf && d > asOf) continue;
    const acct = r.account || r.Account || 'x';
    if (!seenForeign.has(ccy)) seenForeign.set(ccy, new Map());
    const m = seenForeign.get(ccy);
    const cur = m.get(acct);
    if (!cur || d >= cur.date) m.set(acct, { date: d, bal });
  }
  for (const [ccy, m] of seenForeign)
    foreign[ccy] = r2([...m.values()].reduce((s, v) => s + v.bal, 0));

  // card balance + utilisation from latest statement
  const stmts = (cardStatements || [])
    .slice()
    .sort((a, b) => String(a.statementKey).localeCompare(String(b.statementKey)));
  const latest = stmts[stmts.length - 1] || null;
  const cardBalance = latest && latest.newBalance != null ? r2(latest.newBalance) : null;
  const creditLimit = latest && latest.creditLimit != null ? r2(latest.creditLimit) : null;
  const utilisation =
    cardBalance != null && creditLimit && creditLimit > 0
      ? Math.round((Math.max(0, cardBalance) / creditLimit) * 100)
      : null;

  // income stability: measured from the DETECTED RECURRING income stream (the
  // salary a person actually relies on), NOT raw calendar-month sums. Monthly
  // sums are corrupted by pay-date drift across month boundaries: on the real
  // corpus a stable ~300k salary produces monthly totals of 0 (payday not yet
  // landed), ~600k (two paydays in one calendar month) and a ~1.7M bonus month,
  // giving a false CV of 0.87 that would mislabel steady income as "variable" -
  // actively harmful for, e.g., presenting a position to a bank. Measuring the
  // recurring stream's own per-occurrence amounts reflects the truth (CV ~0.3
  // here) and reuses the same detector Overview/Forecast use, so "income" means
  // the same thing everywhere. Falls back to monthly sums only when no recurring
  // income is detected (genuinely irregular earner).
  const inflows = detectRecurring(bankRecords, 'in', opts, asOf).filter(
    (c) => c.typical >= opts.incomeFloor
  );
  const salary = inflows[0] || null; // highest-typical recurring credit
  let cv = null,
    incomeBasis = 'none',
    monthsSeen;
  if (salary) {
    // gather this counterparty's per-month amounts (each month it appeared),
    // dropping the current partial month, so a not-yet-landed payday can't read
    // as a zero-income month.
    const byM = new Map();
    for (const r of bankRecords) {
      const key =
        r.counterpartyKey || r.Group || r.counterpartyLabel || r['Counterparty / Merchant'] || '';
      if (key !== salary.key) continue;
      const d = String(r.date || r.Date || '');
      if (!d || (asOf && d > asOf)) continue;
      byM.set(
        ymOf(d),
        (byM.get(ymOf(d)) || 0) + Math.abs(Number(r.amount != null ? r.amount : r.Amount) || 0)
      );
    }
    const curYm = ymOf(asOf);
    const amts = [...byM.entries()].filter(([m]) => m < curYm).map(([, v]) => v); // drop partial current month
    monthsSeen = amts.length;
    if (amts.length >= 2) {
      const mean = amts.reduce((s, v) => s + v, 0) / amts.length;
      const sd = Math.sqrt(amts.reduce((s, v) => s + (v - mean) ** 2, 0) / amts.length);
      cv = mean > 0 ? sd / mean : null;
      incomeBasis = 'recurring-stream';
    }
  } else {
    // genuinely irregular: fall back to monthly-sum CV, honestly labelled.
    const byMonth = new Map();
    for (const r of bankRecords) {
      const internal =
        r.internalTransfer != null
          ? !!r.internalTransfer
          : String(r.Flow || '') === 'Internal transfer';
      if (internal) continue;
      const ccy2 = String(r.currency || r.Currency || base);
      if (ccy2 !== base) continue;
      const dir =
        r.direction || (r.Flow === 'Cash inflow' ? 'in' : r.Flow === 'Cash outflow' ? 'out' : '');
      if (dir !== 'in') continue;
      const d = String(r.date || r.Date || '');
      if (asOf && d > asOf) continue;
      byMonth.set(
        ymOf(d),
        (byMonth.get(ymOf(d)) || 0) + Math.abs(Number(r.amount != null ? r.amount : r.Amount) || 0)
      );
    }
    const mv = [...byMonth.values()];
    monthsSeen = mv.length;
    if (mv.length >= 2) {
      const mean = mv.reduce((s, v) => s + v, 0) / mv.length;
      const sd = Math.sqrt(mv.reduce((s, v) => s + (v - mean) ** 2, 0) / mv.length);
      cv = mean > 0 ? sd / mean : null;
      incomeBasis = 'monthly-sums';
    }
  }
  const stability =
    cv == null ? 'Unknown' : cv <= 0.15 ? 'Steady' : cv <= 0.35 ? 'Mostly steady' : 'Variable';

  // cash-flow summary: median monthly in / out. Here monthly SUMS are the right
  // basis (this is actual money movement, not income reliability), but drop the
  // partial current month so it isn't understated, and use the recurring salary
  // as the typical-in when available so a double/zero-payday calendar month
  // doesn't skew the median.
  const inByMonth = new Map();
  const outByMonth = new Map();
  const curYm2 = ymOf(asOf);
  for (const r of bankRecords) {
    const internal =
      r.internalTransfer != null
        ? !!r.internalTransfer
        : String(r.Flow || '') === 'Internal transfer';
    if (internal) continue;
    const ccy = String(r.currency || r.Currency || base);
    if (ccy !== base) continue;
    const d = String(r.date || r.Date || '');
    if (!d || (asOf && d > asOf) || ymOf(d) >= curYm2) continue; // complete months only
    const dir =
      r.direction || (r.Flow === 'Cash inflow' ? 'in' : r.Flow === 'Cash outflow' ? 'out' : '');
    const a = Math.abs(Number(r.amount != null ? r.amount : r.Amount) || 0);
    if (dir === 'out') outByMonth.set(ymOf(d), (outByMonth.get(ymOf(d)) || 0) + a);
    else if (dir === 'in') inByMonth.set(ymOf(d), (inByMonth.get(ymOf(d)) || 0) + a);
  }
  // typical monthly income: prefer the recurring salary amount (robust to
  // boundary drift); fall back to the median of monthly in-sums.
  const typicalIn = salary ? r2(salary.typical) : r2(median([...inByMonth.values()]));

  return {
    asOf,
    baseCurrency: base,
    liquid: liquid.total,
    perAccount: liquid.perAccount,
    foreign, // { USD: n, ... } shown separately
    cardBalance,
    creditLimit,
    utilisation, // % or null
    incomeStability: {
      cv: cv == null ? null : r2(cv),
      label: stability,
      monthsSeen,
      basis: incomeBasis,
    },
    cashFlow: {
      typicalMonthlyIn: typicalIn,
      typicalMonthlyOut: r2(median([...outByMonth.values()])),
      monthsSeen: outByMonth.size,
    },
    // the one honest liability-vs-cash line: what clearing the card would leave.
    // shown side by side, NEVER auto-netted.
    ifCardCleared: cardBalance != null ? r2(liquid.total - cardBalance) : null,
  };
}

/* ===========================================================================
 *  2) RECORDED NET WORTH - coverage-based, never "complete".
 *     manualAssets: [{ id, class, label, amount, kind:'asset'|'liability',
 *                      lastReviewed:'YYYY-MM-DD' }]
 *     reconciled: the cashAndDebt result (auto-included as Cash & bank + card).
 * ======================================================================== */
export function recordedNetWorth({
  reconciled,
  manualAssets = [],
  asOf,
  staleAfterDays = 120,
  fx = null,
  fxStaleAfterDays = 14,
}) {
  const included = new Set();
  let assets = 0,
    liabilities = 0;
  const lines = [];

  // reconciled contributions (always fresh - dated asOf)
  if (reconciled) {
    const base = reconciled.baseCurrency;
    assets += reconciled.liquid;
    included.add('Cash & bank');
    lines.push({
      class: 'Cash & bank',
      kind: 'asset',
      amount: r2(reconciled.liquid),
      source: 'reconciled',
      asOf: reconciled.asOf,
    });
    // Foreign holdings are converted to the base currency at the shipped dated
    // rate and COUNTED in net worth at that converted value (the JMD amount is
    // what participates in the total). The native amount, rate, its date and
    // source ride on the line for the minimal on-screen dropdown and the export.
    // When no rate exists for a currency, the holding stays surfaced separately
    // and is NOT summed - a missing rate never becomes a guessed one.
    for (const [ccy, amt] of Object.entries(reconciled.foreign || {})) {
      const native = r2(amt);
      const rate =
        fx && fx.rates && fx.base === base && fx.rates[ccy] != null ? Number(fx.rates[ccy]) : null;
      if (rate && rate > 0) {
        const converted = r2(native * rate);
        const ageDays = fx.asOf ? daysBetween(fx.asOf, asOf) : null;
        const rateStale = ageDays != null && ageDays > fxStaleAfterDays;
        assets += converted;
        lines.push({
          class: 'Cash & bank',
          kind: 'asset',
          amount: converted,
          nativeAmount: native,
          currency: ccy,
          rate,
          rateAsOf: fx.asOf || null,
          rateSource: fx.source || null,
          rateStale,
          source: 'reconciled',
          asOf: reconciled.asOf,
        });
      } else {
        lines.push({
          class: 'Cash & bank',
          kind: 'asset',
          amount: native,
          currency: ccy,
          unconverted: true,
          source: 'reconciled',
          asOf: reconciled.asOf,
        });
      }
    }
    if (reconciled.cardBalance != null && reconciled.cardBalance > 1) {
      liabilities += reconciled.cardBalance;
      included.add('Credit card');
      lines.push({
        class: 'Credit card',
        kind: 'liability',
        amount: r2(reconciled.cardBalance),
        source: 'reconciled',
        asOf: reconciled.asOf,
      });
    }
  }

  // manual contributions (dated; may be stale)
  const staleLines = [];
  for (const m of manualAssets) {
    const amount = r2(Number(m.amount) || 0);
    const ageDays = m.lastReviewed ? daysBetween(m.lastReviewed, asOf) : null;
    const stale = ageDays != null && ageDays > staleAfterDays;
    const line = {
      id: m.id,
      class: m.class,
      kind: m.kind,
      amount,
      source: 'self-reported',
      lastReviewed: m.lastReviewed || null,
      ageDays,
      stale,
      label: m.label || m.class,
    };
    if (m.kind === 'liability') liabilities += amount;
    else assets += amount;
    included.add(m.class);
    lines.push(line);
    if (stale) staleLines.push(line);
  }

  const net = r2(assets - liabilities);

  // COVERAGE: which known classes are present vs not-confirmed
  const notIncluded = {
    assets: NET_WORTH_CLASSES.assets.filter((c) => !included.has(c)),
    liabilities: NET_WORTH_CLASSES.liabilities.filter((c) => !included.has(c)),
  };
  const totalClasses = NET_WORTH_CLASSES.assets.length + NET_WORTH_CLASSES.liabilities.length;
  const coveredClasses = included.size;

  return {
    asOf,
    recordedNetWorth: net,
    totalAssets: r2(assets),
    totalLiabilities: r2(liabilities),
    lines, // every figure with its source
    included: [...included],
    notIncluded, // named gaps - the honesty
    coverage: { covered: coveredClasses, of: totalClasses },
    staleLines, // dated figures needing a refresh
    // never a bare "net worth is X" - always paired with coverage below.
    isComplete: false, // by construction: cannot be known complete
  };
}

/* ===========================================================================
 *  3) FINANCIAL-POSITION SUMMARY - export from selected evidence, every figure
 *     with period + source. Explicitly NOT "bank-ready".
 * ======================================================================== */
export function financialPositionSummary({
  cashDebt,
  netWorth,
  cfg = {},
  asOf,
  periodLabel = 'as of today',
  fx = null,
}) {
  const c = (cfg && cfg.currency) || {};
  const code = c.code || 'JMD';
  const rows = [];
  const add = (label, value, source, period) =>
    rows.push({ label, value: r2(value), source, period });

  if (cashDebt) {
    // The EXPORT keeps full provenance deliberately - it is bank-facing plain
    // text with no dropdown, so source/period/rate stay in the words here even
    // though the interface strips them from its rows.
    add('Cash on hand', cashDebt.liquid, 'reconciled from statements', `as of ${cashDebt.asOf}`);
    for (const [ccy, amt] of Object.entries(cashDebt.foreign || {})) {
      const rate =
        fx && fx.rates && fx.base === cashDebt.baseCurrency && fx.rates[ccy] != null
          ? Number(fx.rates[ccy])
          : null;
      if (rate && rate > 0) {
        add(
          `Cash (${ccy}) - converted`,
          r2(amt * rate),
          `${ccy} ${r2(amt)} at ${rate} per ${ccy}, rate ${fx.asOf || 'unknown'} (${fx.source || 'source unknown'})`,
          `as of ${cashDebt.asOf}`
        );
      } else {
        add(
          `Cash (${ccy})`,
          amt,
          'reconciled from statements (not converted)',
          `as of ${cashDebt.asOf}`
        );
      }
    }
    if (cashDebt.cardBalance != null)
      add(
        'Card balance',
        cashDebt.cardBalance,
        'reconciled from statement',
        `as of ${cashDebt.asOf}`
      );
    if (cashDebt.utilisation != null)
      add(
        'Card utilisation %',
        cashDebt.utilisation,
        'reconciled from statement',
        `as of ${cashDebt.asOf}`
      );
    add(
      'Typical monthly income',
      cashDebt.cashFlow.typicalMonthlyIn,
      `median of ${cashDebt.cashFlow.monthsSeen} months`,
      'recent history'
    );
    add(
      'Typical monthly outflow',
      cashDebt.cashFlow.typicalMonthlyOut,
      `median of ${cashDebt.cashFlow.monthsSeen} months`,
      'recent history'
    );
  }
  const selfReported = [];
  if (netWorth) {
    add('Recorded net worth', netWorth.recordedNetWorth, 'mixed (see lines)', `as of ${asOf}`);
    for (const l of netWorth.lines.filter((x) => x.source === 'self-reported')) {
      selfReported.push({
        label: l.label,
        value: l.amount,
        kind: l.kind,
        lastReviewed: l.lastReviewed,
        stale: l.stale,
      });
    }
  }

  return {
    title: 'Financial position summary',
    currency: code,
    generatedFor: periodLabel,
    asOf,
    rows, // each with value/source/period (source/period read by the clipboard only)
    selfReported, // clearly separated from reconciled
    coverageNote: netWorth
      ? `Net worth covers ${netWorth.coverage.covered} of ${netWorth.coverage.of} common asset and debt classes. Not included or not confirmed: ${[...netWorth.notIncluded.assets, ...netWorth.notIncluded.liabilities].join(', ') || 'none'}.`
      : '',
    // Two disclaimers by medium: the SCREEN shows the terse caveat (a glance
    // reassurance under a card whose title already says what it is for); the
    // CLIPBOARD carries the fuller one, since a banker reading pasted text has
    // no card title and benefits from the self-reported/dated note spelled out.
    // Same split we already make for provenance (tag on screen, words in copy).
    disclaimer: 'A personal summary - not a verified or lender-approved statement.',
    exportDisclaimer:
      'A personal summary from your imported statements and figures you entered by hand. Figures you entered are marked self-reported and dated. Not a verified or lender-approved statement.',
  };
}

/* ===========================================================================
 *  view-models - number/tag/detail, frozen shape, pronoun-free tags.
 * ======================================================================== */
export function buildCashDebtModel(cd, cfg = {}) {
  const money = makeMoney(cfg);
  const cards = [];
  cards.push({
    id: 'cash',
    label: 'Cash on hand',
    amountText: money(cd.liquid),
    tag: Object.keys(cd.foreign || {}).length
      ? `plus ${Object.keys(cd.foreign).join(', ')} separate`
      : 'across accounts',
    tone: 'neutral',
    detail: `as of ${cd.asOf}`,
  });
  if (cd.cardBalance != null) {
    cards.push({
      id: 'card',
      label: 'Owed on card',
      amountText: money(cd.cardBalance),
      tag: cd.utilisation != null ? `${cd.utilisation}% of limit used` : 'balance',
      tone: cd.utilisation != null && cd.utilisation >= 50 ? 'watch' : 'neutral',
      detail: `Utilisation is a credit-score input, not a spending or interest measure.`,
    });
  }
  cards.push({
    id: 'income',
    label: 'Income stability',
    amountText: cd.incomeStability.label,
    tag: cd.incomeStability.monthsSeen + ' months',
    tone: cd.incomeStability.label === 'variable' ? 'watch' : 'good',
    detail: `Across ${cd.incomeStability.monthsSeen} months.`,
  });
  return { asOf: cd.asOf, cards };
}

export function buildNetWorthModel(nw, cfg = {}) {
  const money = makeMoney(cfg);
  const gaps = [...nw.notIncluded.assets, ...nw.notIncluded.liabilities];
  return {
    lead: {
      label: 'What you own minus what you owe',
      amountText: money(nw.recordedNetWorth),
      tag: `covers ${nw.coverage.covered} of ${nw.coverage.of} classes`,
      tone: 'neutral',
      detail: `Assets ${money(nw.totalAssets)} \u2212 debts ${money(nw.totalLiabilities)}.`,
    },
    coverageNote: gaps.length
      ? `Not included or not confirmed: ${gaps.join(', ')}.`
      : 'All common classes are represented.',
    staleWarning: nw.staleLines.length
      ? `${nw.staleLines.length} entered figure${nw.staleLines.length === 1 ? '' : 's'} may be out of date and could use a review.`
      : '',
    lines: nw.lines,
    notIncluded: nw.notIncluded,
  };
}

function makeMoney(cfg = {}) {
  const c = (cfg && cfg.currency) || {};
  try {
    const f = new Intl.NumberFormat(c.locale || 'en-JM', {
      style: 'currency',
      currency: c.code || 'JMD',
      minimumFractionDigits: c.decimals == null ? 2 : c.decimals,
      maximumFractionDigits: c.decimals == null ? 2 : c.decimals,
    });
    return (n) => f.format(Number(n || 0));
  } catch (_) {
    return (n) => (c.symbol || '$') + Number(n || 0).toFixed(2);
  }
}

/* helper: a stored manual-asset record */
export function makeManualAsset({
  class: cls,
  label,
  amount,
  kind,
  lastReviewed,
  now = new Date().toISOString(),
}) {
  return {
    id: `asset_${Math.random().toString(36).slice(2, 10)}`,
    class: cls,
    label: label || cls,
    amount: r2(amount),
    kind: kind || 'asset',
    lastReviewed: lastReviewed || now.slice(0, 10),
    createdAt: now,
    updatedAt: now,
  };
}
