/* ===========================================================================
 *  spend-breakdown.js  -  "Where it went": the merged category -> merchant drill.
 *
 *  Replaces the two separate cards (renderCategoryPanel + renderMerchants) with
 *  ONE structure: a category shows its total, and expands to its OWN top
 *  merchants. A high-level category opening onto its own merchants is one story,
 *  not two cards telling it twice.
 *
 *  PURE and Node-testable. No DOM, no fetch, no mutation.
 *
 *  DATA BOUNDARY: card-side only. The bank ledger carries no spend category
 *  (proven against the corpus: 0 bank rows have a Category), so the drill reads
 *  the CARD ledger's spend/fee rows and groups by the same merchant key the app
 *  already uses (Group / merchantGroupKey). Payments and refunds are excluded.
 *
 *  COMPARISON GUARD (frozen rule): comparisons state direction, size AND period,
 *  and a TINY prior value must never produce an exaggerated percentage. When the
 *  prior total is below the materiality floor, the change is reported as an
 *  absolute amount with NO percentage, and flagged 'new' when prior was zero.
 *
 *  DRILL-DOWN: every total (category and merchant) carries the row indices that
 *  produced it, so the UI can open the exact transactions behind any figure -
 *  the trust mechanism the plan requires ("every total traces to its rows").
 * ======================================================================== */
import { resolveOpts } from './commitment-income.js';
import { categoryTotalsWithSplits, splitsByTxnId, validateSplit } from './transaction-splits.js';

function dateOf(r) {
  return String(r.date || r.Date || '');
}
function amtOf(r) {
  return Math.abs(Number(r.amount != null ? r.amount : r.Amount) || 0);
}
function catOf(r) {
  return r.category || r.Category || 'Uncategorised';
}
function merchOf(r) {
  return (
    r.merchantGroup ||
    r.Group ||
    r.counterpartyLabel ||
    r['Counterparty / Merchant'] ||
    r.merchant ||
    '-'
  );
}
function cardKind(r) {
  return String(r.kind || r.Type || r.type || '').toLowerCase();
}
function isSpend(r) {
  const k = cardKind(r);
  return k === 'spend' || k === 'fee';
}
function inPeriod(r, from, to) {
  const d = dateOf(r);
  return d >= from && d <= to;
}
function r2(n) {
  return Math.round(Number(n || 0) * 100) / 100;
}

/* Compare a current total to a prior total under the frozen guard. Returns a
 * plain comparison object the view-model turns into a marker. */
export function compareToPrior(current, prior, opts, priorComplete = true) {
  const absChange = r2(current - prior);
  const floor = opts.commitmentFloor; // materiality floor
  if (prior <= 0) {
    return current > 0
      ? { direction: 'up', kind: 'new', absChange, pct: null } // brand new spend
      : { direction: 'flat', kind: 'none', absChange: 0, pct: null };
  }
  // PARTIAL-PRIOR GUARD (caught by the proof: a 3-day first month produced a
  // misleading "488% vs last"). An incomplete prior period is an unreliable
  // denominator, so - like a tiny prior - report the amount only, no percentage.
  // Same family as the materiality guard: partial data must not produce a
  // complete-sounding conclusion. Caller passes coverage from the shared helper.
  if (!priorComplete) {
    return {
      direction: absChange > 0 ? 'up' : absChange < 0 ? 'down' : 'flat',
      kind: 'amount-only-partial',
      absChange,
      pct: null,
    };
  }
  if (prior < floor) {
    // prior too small for a meaningful %: report the amount only
    return {
      direction: absChange > 0 ? 'up' : absChange < 0 ? 'down' : 'flat',
      kind: 'amount-only',
      absChange,
      pct: null,
    };
  }
  const pct = Math.round((absChange / prior) * 100);
  const direction = absChange > 0 ? 'up' : absChange < 0 ? 'down' : 'flat';
  return { direction, kind: 'pct', absChange, pct };
}

/* ===========================================================================
 *  spendBreakdown - build the merged drill for a period, with prior comparison.
 *  cardRecords: full card history (spend rows); period { from, to };
 *  priorPeriod optional { from, to } for the comparison (usually prior month).
 * ======================================================================== */
export function spendBreakdown({
  cardRecords = [],
  cfg = {},
  period,
  priorPeriod = null,
  priorComplete = true,
  topMerchantsPerCategory = 5,
  splits = [],
}) {
  const opts = resolveOpts(cfg);
  const { from, to } = period;

  const splitMap = splitsByTxnId(splits);
  // A valid split changes category attribution only. The transaction remains
  // one row, one merchant visit and one contribution to the grand total.
  const contributionsFor = (r) => {
    const split = splitMap.get(r.id);
    if (split && validateSplit(split, r.amount).ok) {
      return split.parts.map((p) => ({
        category: p.category,
        amount: Math.abs(Number(p.amount) || 0),
      }));
    }
    return [{ category: catOf(r), amount: amtOf(r) }];
  };

  // index period spend rows so every total can point back to them
  const cur = [];
  cardRecords.forEach((r, i) => {
    if (isSpend(r) && inPeriod(r, from, to)) cur.push({ r, i });
  });

  // prior totals by category, for comparison (guarded)
  const priorCatTotal = new Map();
  if (priorPeriod) {
    for (const r of cardRecords) {
      if (!isSpend(r) || !inPeriod(r, priorPeriod.from, priorPeriod.to)) continue;

      for (const part of contributionsFor(r)) {
        priorCatTotal.set(part.category, (priorCatTotal.get(part.category) || 0) + part.amount);
      }
    }
  }

  // group current: category -> { total, rowIdx[], merchants: Map }
  const cats = new Map();
  let grandTotal = 0;
  for (const { r, i } of cur) {
    const merch = merchOf(r);
    const amount = amtOf(r);

    // Count the transaction and its merchant amount once in the overall total.
    grandTotal += amount;

    // Distribute only its category attribution.
    for (const part of contributionsFor(r)) {
      const cat = part.category;
      const partAmount = part.amount;

      if (!cats.has(cat)) {
        cats.set(cat, { total: 0, rowIdx: [], merchants: new Map() });
      }

      const c = cats.get(cat);
      c.total += partAmount;
      if (!c.rowIdx.includes(i)) c.rowIdx.push(i);

      if (!c.merchants.has(merch)) {
        c.merchants.set(merch, { total: 0, count: 0, rowIdx: [] });
      }

      const m = c.merchants.get(merch);
      m.total += partAmount;
      m.count += 1;
      if (!m.rowIdx.includes(i)) m.rowIdx.push(i);
    }
  }
  ``;

  // assemble sorted output
  const categories = [...cats.entries()]
    .map(([name, c]) => {
      const merchants = [...c.merchants.entries()]
        .map(([mname, m]) => ({
          name: mname,
          total: r2(m.total),
          count: m.count,
          rowIdx: m.rowIdx,
        }))
        .sort((a, b) => b.total - a.total);
      const shown = merchants.slice(0, topMerchantsPerCategory);
      const restCount = merchants.length - shown.length;
      const restTotal = r2(
        merchants.slice(topMerchantsPerCategory).reduce((s, x) => s + x.total, 0)
      );
      const comparison = priorPeriod
        ? compareToPrior(r2(c.total), r2(priorCatTotal.get(name) || 0), opts, priorComplete)
        : null;
      return {
        name,
        total: r2(c.total),
        share: grandTotal > 0 ? Math.round((c.total / grandTotal) * 100) : 0,
        rowIdx: c.rowIdx, // drill-down: every category total -> its rows
        topMerchants: shown, // each with its own rowIdx
        moreMerchants: restCount > 0 ? { count: restCount, total: restTotal } : null,
        comparison, // guarded { direction, kind, absChange, pct }
      };
    })
    .sort((a, b) => b.total - a.total);

  return {
    period: { from, to },
    grandTotal: r2(grandTotal),
    categories,
    txnCount: cur.length,
  };
}

/* ===========================================================================
 *  view-model - the number/tag/detail content model, frozen shape.
 *  Each category is a row that expands (drill) to its own merchants; the tag is
 *  the guarded comparison marker; detail lists the merchants for the dropdown.
 * ======================================================================== */
// Shared, exported comparison-to-wording and comparison-to-tone mappings -
// the SINGLE place "how do we describe/colour a vs-prior comparison" is
// decided. Previously this lived ONLY as a private function inside
// buildSpendBreakdownModel; extracted the moment a second real consumer
// (treemap-render.js's category tiles) needed the identical logic, so the
// two can never independently drift into phrasing or colouring the same
// guarded comparison two different ways.
export function describeComparisonText(cmp, money) {
  if (!cmp) return '';
  if (cmp.kind === 'new') return 'new this period';
  if (cmp.kind === 'none') return '';
  if (cmp.kind === 'amount-only')
    return `${cmp.direction === 'up' ? '+' : '−'}${money(Math.abs(cmp.absChange))} vs last`;
  if (cmp.kind === 'amount-only-partial')
    return `${cmp.direction === 'up' ? '+' : '−'}${money(Math.abs(cmp.absChange))} (last period partial)`;
  if (cmp.pct === 0) return 'same as last';
  return `${cmp.pct > 0 ? '▲' : '▼'} ${Math.abs(cmp.pct)}% vs last`; // direction + size + period
}

export function comparisonTone(cmp) {
  if (!cmp) return 'neutral';
  if (cmp.kind === 'new') return 'watch';
  if (cmp.direction === 'up') return 'watch';
  if (cmp.direction === 'down') return 'good';
  return 'neutral';
}

export function buildSpendBreakdownModel(result, cfg = {}) {
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

  const markerText = (cmp) => describeComparisonText(cmp, money);
  const markerTone = (cmp) => comparisonTone(cmp);

  return {
    period: result.period,
    total: {
      label: 'Where it went',
      amount: result.grandTotal,
      amountText: money(result.grandTotal),
      tag: `${result.txnCount} transaction${result.txnCount === 1 ? '' : 's'}`,
      tone: 'neutral',
    },
    categories: result.categories.map((cat) => ({
      name: cat.name,
      amount: cat.total,
      amountText: money(cat.total),
      share: cat.share,
      tag: markerText(cat.comparison), // pronoun-free comparison marker
      tone: markerTone(cat.comparison),
      rowIdx: cat.rowIdx, // drill-down handle
      // the drill: this category's own top merchants (replaces the 2nd card)
      merchants: cat.topMerchants.map((m) => ({
        name: m.name,
        amountText: money(m.total),
        tag: `${m.count} time${m.count === 1 ? '' : 's'}`,
        rowIdx: m.rowIdx, // drill-down to exact rows
      })),
      more: cat.moreMerchants
        ? {
            count: cat.moreMerchants.count,
            amountText: money(cat.moreMerchants.total),
          }
        : null,
      detail: `${money(cat.total)} across ${cat.topMerchants.length}${cat.moreMerchants ? '+' : ''} place${cat.topMerchants.length === 1 && !cat.moreMerchants ? '' : 's'}, ${cat.share}% of card spend this period.`,
    })),
  };
}
