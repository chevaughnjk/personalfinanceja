/*
 * reporting.js  -  pure analysis, the shared on-screen render building blocks,
 * and the print-model orchestration for the Personal Finance Analyser.
 *
 * Pure and browser/Node-safe: no DOM is required except by the shared render
 * helpers and the print-model group, which take a `document` argument, so the
 * whole module is unit-testable. The printable-report renderers themselves now
 * live in report-render.js, the CSV writers in csv-export.js, and the encrypted
 * backup lock-and-key in history-codec.js; this file imports the report
 * renderers only to drive them, and holds none of those three itself. */
import {
  merchantRuleKeyFromDescription,
  merchantGroupKey,
  merchantBrandLabel,
  merchantBranch,
  merchantDisplayLabel,
} from '../../settings/category-rules.js';
import { categorise, smartTitle, merchantLabel } from '../statements/categorise.js';
import { transactionIdentity } from '../statements/read-statements.js';
import {
  analyseBankActivity,
  analyseCombinedOverview,
  analyseRollup,
  detectLargeBankOutflows,
  detectPeriodNewPayees,
} from '../analysis/bank-analysis.js';
import {
  roundMoney,
  capitaliseFirst,
  requireCtx,
  monthIndex,
  recurringStatus,
  monthKey,
  formatDisplayDate,
  medianDayOfMonth,
  addDaysIso,
  isoDay,
  detectSustainedRise,
} from '../core/shared-helpers.js';
import { renderReport, renderBankReport, renderOverviewReport } from '../output/report-render.js';
import { categoryTotalsWithSplits, splitsByTxnId, validateSplit } from './transaction-splits.js';

const MONTH_LONG = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

// Decimal rounding on the exact binary value (toFixed), which lines up with
// the source tool's Python round() for the supplied statements. Using the
// exact value avoids the float-multiply artefact that a *100 approach hits.
function round1(n) {
  return parseFloat(Number(n).toFixed(1));
}

export function buildRows(records, compiled, options = {}) {
  const {
    keepUpper = new Set(),
    smallWords = new Set(),
    fallback = 'Uncategorised',
    paymentCategory = 'Card Payment',
    refundCategory = 'Refund / Reversal',
    feeCategories = new Set(['Fees & Interest', 'Government & Tax']),
    merchantOverrides = {},
    merchants = null, // compiled MERCHANT LIST for GROUPING (merchantGroupKey/displayLabel)
    resolver = null, // the identity door for categorise() only
    brandRules = [], // compiled config brand rules (empty in shipped config); merchant intel wins first
  } = options;

  const rows = records.map((t) => {
    // needsReview and merchant were previously discarded here: categorise() already returns five fields - { category, confidence, merchant, needsReview } - but only category/confidence ever reached the row. That silently dropped a genuine, already-researched signal (e.g. WiPay: categoryConfidence "low", reviewRequired true, with a real reason recorded in jamaica-merchants.json) before any downstream code could ever see it. Both fields default to a deliberate "not flagged" state (false / null) on the two branches that never call categorise() at all - a person's own categoryOverride or an existing personal rule (merchantOverrides) is an explicit, confirmed decision, never an "unrecognised" or "needs review" case, so those two branches must not inherit a stale needsReview/merchant value from a previous iteration.
    let category,
      confidence,
      needsReview = false,
      merchant = null;
    const firstSeg = merchantRuleKeyFromDescription(t.description);
    if (t.categoryOverride) {
      category = t.categoryOverride;
      confidence = 1;
    } else if (merchantOverrides[firstSeg]) {
      category = merchantOverrides[firstSeg];
      confidence = 1;
    } else {
      // categorise's 2nd arg is the compiled CATEGORY RULES ([{name, re, headRe}]); its 4th arg is the compiled MERCHANT LIST ([{re, merchant, ...}]). Different shapes - do not swap them.
      const c = categorise(t.description, compiled, fallback, resolver, {
        isCredit: t.amount < 0,
        refundCategory,
      });
      category = c.category;
      confidence = c.confidence;
      needsReview = !!c.needsReview;
      merchant = c.merchant || null;
    }
    let kind;
    if (category === paymentCategory) kind = 'payment';
    else if (category === refundCategory) kind = 'refund';
    else if (feeCategories.has(category)) kind = 'fee';
    else kind = t.amount > 0 ? 'spend' : 'refund'; // // a credit sign alone can't distinguish refund from cashback/goodwill/dispute credit (industry-wide, not just here), so 'refund' is the only defensible catch-all kind
    // displayName is the ONE canonical, cleaned merchant/place name shown to a user on every transaction surface (Recent, the Explorer, Spent abroad, the printed report). It is computed IDENTICALLY to the Top Places label (merchantBrandLabel via the researched merchant list, falling back to the structural merchantLabel of the first segment), so a single row reads the same "Amazon" in the transaction list and in Top Places instead of the raw "Www.Amazon* 113-217508". Display-layer only: description and raw_description are unchanged, so categorisation, matching, grouping, totals and identity are all untouched. The full statement wording is still preserved verbatim on raw_description for the detail panel's "Original statement text" field.
    const description = smartTitle(t.description, keepUpper, smallWords);
    return {
      id: t.id || transactionIdentity(t),
      date: t.txn_date,
      month: monthKey(t.txn_date),
      description,
      displayName: merchantDisplayLabel(
        t.description,
        brandRules,
        merchants,
        keepUpper,
        smallWords
      ),
      // The SAME grouping key summarise()/analysePeriod() already derive on
      // demand whenever they group by merchant. Cached here so it can be
      // exported per row for the Detailed CSV; no total or grouping changes.
      merchantGroup: merchantGroupKey(description, brandRules, merchants) || '',
      raw_description: t.description,
      category,
      amount: roundMoney(t.amount),
      kind,
      source_file: t.source_file,
      confidence,
      foreign: t.foreign || '',
      overridden: !!t.categoryOverride,
      reviewDismissed: !!t.reviewDismissed,
      // Scotiabank card rows carry a reference number; NCB card rows and every
      // bank row do not - '' there.
      ref: t.ref || '',
      needsReview,
      merchant,
    };
  });
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return rows;
}

export function summarise(rows, options = {}) {
  const {
    keepUpper = new Set(),
    smallWords = new Set(),
    brandRules = [],
    merchants = null,
    fallback = 'Uncategorised',
    splits = [],
  } = options;
  const spend = rows.filter((r) => r.kind === 'spend');
  const totalSpend = spend.reduce((a, r) => a + r.amount, 0);
  const totalPayments = rows.filter((r) => r.kind === 'payment').reduce((a, r) => a - r.amount, 0);
  const totalRefunds = rows.filter((r) => r.kind === 'refund').reduce((a, r) => a - r.amount, 0);
  const totalFees = rows.filter((r) => r.kind === 'fee').reduce((a, r) => a + r.amount, 0);
  const months = [...new Set(rows.filter((r) => r.month !== 'unknown').map((r) => r.month))].sort();
  const nMonths = Math.max(months.length, 1);

  // Category totals apply any valid transaction splits: a split redistributes
  // ONE row's amount across categories WITHOUT changing the row, its count, or
  // the grand total (a valid split's parts sum to |amount| - the reconciliation
  // invariant proven in b3b_split_proof.mjs). totalSpend/byMonth/merchants are
  // left untouched on purpose: a split changes CATEGORY attribution only, never
  // which place the money went or how many transactions there were.
  const splitsByTxn = splitsByTxnId(splits);
  const { byCategory: byCatSplit } = categoryTotalsWithSplits(spend, splitsByTxn);
  const byCategory = Object.fromEntries(
    Object.entries(byCatSplit)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => [k, roundMoney(v)])
  );

  const byMonthRaw = Object.fromEntries(months.map((m) => [m, 0]));
  for (const r of spend) if (r.month in byMonthRaw) byMonthRaw[r.month] += r.amount;
  const byMonth = Object.fromEntries(
    Object.entries(byMonthRaw).map(([k, v]) => [k, roundMoney(v)])
  );

  const byMerchant = {};
  for (const r of spend) {
    // Group by the additive brand key (star-token + trailing reference stripped, brand rules applied); display and totals are unchanged. The group keeps its first row's raw description so the label is produced by the one shared merchantDisplayLabel, not a hand-copied formula.
    const key = merchantGroupKey(r.description, brandRules, merchants) || 'UNKNOWN';
    if (!byMerchant[key])
      byMerchant[key] = {
        amount: 0,
        count: 0,
        category: r.category,
        descSrc: r.description,
      };
    byMerchant[key].amount += r.amount;
    byMerchant[key].count += 1;
  }
  const topMerchants = Object.values(byMerchant)
    .map((v) => ({
      merchant: merchantDisplayLabel(v.descSrc, brandRules, merchants, keepUpper, smallWords),
      amount: roundMoney(v.amount),
      count: v.count,
      category: v.category,
    }))
    .sort((a, b) => b.amount - a.amount)
    .slice(0, 15);

  const n_uncategorised_spend = spend.filter((r) => r.category === fallback).length;
  const coverage = (100 * (spend.length - n_uncategorised_spend)) / Math.max(spend.length, 1);

  return {
    total_spend: roundMoney(totalSpend),
    total_payments: roundMoney(totalPayments),
    total_refunds: roundMoney(totalRefunds),
    total_fees: roundMoney(totalFees),
    n_transactions: rows.length,
    n_spend: spend.length,
    n_months: nMonths,
    avg_monthly_spend: roundMoney(totalSpend / nMonths),
    months,
    by_category: byCategory,
    by_month: byMonth,
    top_merchants: topMerchants,
    coverage_pct: round1(coverage),
    n_uncategorised_spend,
  };
}

/* ===========================================================================
 * 6) Insights  (plain-language observations for the top of the dashboard)
 * ======================================================================== */

/* The "new this month" merchants, as a reusable pure function (Round 1, A2). seenBefore is the set of first-segment keys (r.description.split(',')[0].trim().toUpperCase()) over spend rows in months earlier than `month`. Any spend row in `month` whose key is not in that set is a new merchant, and its amount is aggregated by key. Returns [{ key, label, amount }] sorted by amount desc, where label is the original (untidied) first segment of a matching row. Empty array when none. Pure. */
export function detectNewMerchants(rows, month, brandRules = [], merchants = null) {
  const spendRows = (rows || []).filter((r) => r.kind === 'spend');
  const keyOf = (r) => merchantGroupKey(r.description, brandRules, merchants);
  const seenBefore = new Set(spendRows.filter((r) => r.month < month).map(keyOf));
  const amountByKey = {};
  const labelByKey = {};
  for (const r of spendRows.filter((r) => r.month === month)) {
    const key = keyOf(r);
    if (seenBefore.has(key)) continue;
    amountByKey[key] = (amountByKey[key] || 0) + r.amount;
    // Display label only: tidy the first-segment token ("Amazon Mktpl*..." ->
    // "Amazon"). The key (keyOf) and dedup above are untouched, so grouping and
    // identity are unaffected. Empty sets still strip the "*..."/MKTPL/trailing-
    // digit junk without needing config here.
    if (!(key in labelByKey))
      labelByKey[key] = merchantDisplayLabel(r.description, brandRules, merchants);
  }
  return Object.keys(amountByKey)
    .map((key) => ({ key, label: labelByKey[key], amount: amountByKey[key] }))
    .sort((a, b) => b.amount - a.amount);
}

/* The merchants that FIRST appeared inside the current period (Bug 1 fix). detectNewMerchants above compares one month against everything before it, which cannot answer "new in this period" honestly on an all-time or first-ever view: there is no month strictly before the earliest one, so every merchant would read as new. This function instead asks, for each merchant group, when it FIRST appeared across the WHOLE rows array, and only counts it as new when that true first-ever month falls inside the period (period.from to period.to inclusive). Returns [] immediately when period.prevFrom is falsy. That is the all-time / first-period case with no genuine prior period to compare against, and the correct behaviour is to surface nothing rather than everything. Groups by merchantGroupKey (the same key the rest of the analytics use). Sums each qualifying merchant's amount within the period, and resolves its display label via merchantBrandLabel, falling back to merchantLabel when no brand label exists. *
 * Returns [{ key, label, amount }] sorted by amount descending. Pure. */
export function detectPeriodNewMerchants(rows, period, brandRules = [], merchants = null) {
  if (!period || !period.prevFrom) return [];
  const spendRows = (rows || []).filter((r) => r.kind === 'spend');
  const keyOf = (r) => merchantGroupKey(r.description, brandRules, merchants);
  // The true first-ever occurrence month for each merchant group, across ALL
  // history, not just the period.
  const firstMonth = {};
  for (const r of spendRows) {
    const key = keyOf(r);
    if (!(key in firstMonth) || r.month < firstMonth[key]) firstMonth[key] = r.month;
  }
  const amountByKey = {};
  const labelByKey = {};
  for (const r of spendRows) {
    if (r.month < period.from || r.month > period.to) continue;
    const key = keyOf(r);
    // Only a merchant whose first-ever month is inside this period is genuinely new.
    if (firstMonth[key] < period.from || firstMonth[key] > period.to) continue;
    amountByKey[key] = (amountByKey[key] || 0) + r.amount;
    if (!(key in labelByKey))
      labelByKey[key] = merchantDisplayLabel(r.description, brandRules, merchants);
  }
  return Object.keys(amountByKey)
    .map((key) => ({ key, label: labelByKey[key], amount: amountByKey[key] }))
    .sort((a, b) => b.amount - a.amount);
}

// The ONE place "is this transaction genuinely unrecognised" is decided. Previously this fact was independently re-derived in two places with two slightly different expressions of it: attentionItems() checked only `r.confidence === 0`, while buildUnknownMerchantsCSV() (added later, same file) checked `r.confidence === 0 && r.category === fallback`. In categorise()'s current implementation those two conditions happen to be equivalent - confidence 0 is set in exactly one branch, the final `return { category: fallback, confidence: 0 }` - but that equivalence was implicit and unenforced: nothing stopped a future change to categorise() from setting confidence 0 anywhere else without also setting category to fallback, at which point the two call sites would silently disagree. This is deliberately the STRICT case: a KNOWN merchant categorise() flagged needsReview is NOT unrecognised - the app knows exactly what it is, it only could not resolve a spending category from the descriptor alone - so needsReview is deliberately NOT read here.
export function isUnrecognised(row, fallback = 'Uncategorised') {
  return row.confidence === 0 && row.category === fallback;
}

// The ONE place the class-driven "why is this worth a second look" sentence is generated - consolidating what Round 2 wrote inline inside attentionItems(). Now that a second consumer needs the identical wording (the transaction detail panel, cards-render.js's toggleDetail), inlining it twice would recreate the exact duplication this session has spent several rounds removing. Two classes, both fully generic - no merchant-specific template, no jargon, no confidence number: isUnrecognised(row) means nothing matched at all, so the honest statement is that the app genuinely does not know what this is; row.needsReview means categorise() DID resolve something (a real merchant match it could not confidently categorise, e.g. a payment processor whose underlying business the descriptor never reveals; or the refund-fallback branch, which knows the money came back but not from whom) - branches on whether row.merchant is present, since that is the one fact that actually differs between those two needsReview cases, rather than inventing a third bucket to describe them. Returns null when neither applies, so a caller can skip rendering entirely rather than showing an empty or placeholder line.
export function reviewReasonText(
  row,
  fallback = 'Uncategorised',
  brandRules = [],
  merchants = null
) {
  if (isUnrecognised(row, fallback)) {
    return `We're not sure what this is: ${merchantDisplayLabel(row.description, brandRules, merchants)}. Is this right?`;
  }
  if (row.needsReview) {
    return row.merchant
      ? `We know this is ${row.merchant}, but we're not sure how to categorise it.`
      : `We're not fully sure about this one - worth a quick check.`;
  }
  return null;
}

export function attentionItems(rows, cfg = {}, brandRules = [], merchants = null) {
  // D-audit item 3. The plain arithmetic MEAN of a merchant's other charges is fragile: a single large past charge inflates it (masking the next real outlier), and a peer set of two makes the "average" almost meaningless. The standard robust upgrade (fraud/anomaly-detection literature: median + MAD, Iglewicz & Hoaglin modified z-score) is used instead - the median and the Median Absolute Deviation are barely moved by one unusually large charge. A charge is flagged only when its robust z-score exceeds largeChargeZ AND it clears the flat JMD floor (kept: on a single-currency Jamaican card a hard floor is the right "is this even worth a look" gate). The old multiple-of-the-mean rule is kept as a fallback ONLY when MAD is zero (every peer charge identical), so a genuinely unusual amount is still caught where a robust spread cannot be formed. Verified on the real card export: this keeps genuine outliers even with few peers that a naive "require >=3 peers" rule would have wrongly dropped, while shedding a marginal mean-only flag that was not actually unusual for that payee.
  const t = Object.assign(
    {
      largeChargeMultiple: 2.5,
      largeChargeMin: 10000,
      largeChargeZ: 3.5, // modified-z threshold (Iglewicz & Hoaglin's standard cut)
      largeChargeMinPeers: 2, // need at least this many prior charges to judge "usual"
    },
    cfg.insights || {}
  );
  // Reads the SAME config path FALLBACK()/buildRows() read (state.cfg.special.
  // fallback), so "unrecognised" means the exact same category name everywhere
  // in the app. cfg.special is absent when this runs via reviewItems()'s empty
  // {} call, so the shipped default 'Uncategorised' is used there, matching
  // isUnrecognised's own default and config.json's actual configured value.
  const fallback = (cfg.special && cfg.special.fallback) || 'Uncategorised';
  const med = (a) => {
    const s = a.slice().sort((x, y) => x - y);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const byMerchant = {};
  const keyByRow = new Map();
  for (const r of rows.filter((r) => r.kind === 'spend')) {
    const k = merchantGroupKey(r.description, brandRules, merchants);
    keyByRow.set(r, k);
    (byMerchant[k] = byMerchant[k] || []).push(r);
  }
  const flags = [];
  for (const r of rows.filter((r) => r.kind === 'spend' && !r.reviewDismissed)) {
    const k = keyByRow.get(r);
    const peers = byMerchant[k];
    const others = peers.filter((p) => p.id !== r.id).map((p) => p.amount);
    if (others.length >= t.largeChargeMinPeers && r.amount >= t.largeChargeMin) {
      const centre = med(others);
      const mad = med(others.map((x) => Math.abs(x - centre)));
      // Two guards, both required, so a charge is flagged only when it is BOTH
      // statistically unusual and materially larger than normal for that payee:
      //  1) robust z-score (0.6745*(x-median)/MAD) over the largeChargeZ cut, the
      //     Iglewicz-Hoaglin modified z. When MAD is 0 (identical peers) the score
      //     is infinite, so this reduces to guard 2 alone;
      //  2) at least largeChargeMultiple x the median. This defends the MAD->0
      //     degenerate case: a payee whose charges cluster tightly (e.g. an
      //     a payee whose charges cluster tightly) has a tiny MAD, so a trivially higher
      //     $29k would otherwise score just over the z-cut - guard 2 stops that,
      //     while a genuine jump (a genuine jump far above the payee's median) sails
      //     through both. Verified against the real card export.
      const zOk = mad > 0 ? (0.6745 * (r.amount - centre)) / mad >= t.largeChargeZ : true;
      const multipleOk = centre > 0 && r.amount >= centre * t.largeChargeMultiple;
      if (zOk && multipleOk) {
        flags.push({
          id: r.id,
          type: 'large',
          text: `This ${merchantDisplayLabel(r.description, brandRules, merchants)} charge is larger than usual - worth a look?`,
          row: r,
        });
      }
    }
    // Two genuinely different situations were previously flagged with the
    // SAME generic text ("We weren't sure how to file X"), which quietly
    // overclaimed in the second case below: when isUnrecognised is true, the
    // app truly has no idea what this is - the honest thing to say is exactly
    // that. When it is false but r.needsReview is true, the app DOES know the
    // counterparty (categorise() resolved a real merchant match, e.g. a
    // payment processor whose underlying business the descriptor never
    // reveals) - only the CATEGORY is uncertain, so saying "we're not sure
    // what this is" there would understate what the app actually knows. Both
    // sentences are still fully generic and class-driven (isUnrecognised /
    // needsReview), never a per-merchant template - r.merchant (added in
    // Round 1) supplies the name for the second case with no merchant-specific
    // wording anywhere in this function.
    // Reads the SAME shared function the detail panel now reads (see
    // reviewReasonText above), so the dashboard's insight list and a
    // person's own tap-to-expand view can never quietly drift into two
    // different explanations for the identical fact.
    const reviewText = reviewReasonText(r, fallback, brandRules, merchants);
    if (reviewText) {
      flags.push({ id: r.id, type: 'uncertain', text: reviewText, row: r });
    }
  }
  return flags;
}

/* Assemble the monthly review list (Round 1, A2b). Assembles only; it recomputes
 * nothing. Large charges come from attentionItems over ALL rows (it needs full
 * history to judge "larger than usual"), then narrowed to type 'large' whose row
 * sits in `month`. New merchants come from detectNewMerchants(rows, month).
 * Unreconciled statements are the card/bank statement records not marked
 * reconciled. Returns ONE flat array of
 * { kind:'unreconciled'|'large'|'new', id?, label, detail }, ordered by severity
 * so the item most likely to be real money is never below noise: all
 * unreconciled first, then large, then new. Empty array when nothing qualifies.
 * Pure. */
export function reviewItems({
  rows,
  month,
  cardStatements,
  bankStatements,
  brandRules = [],
  merchants = null,
} = {}) {
  const allRows = rows || [];
  const out = [];
  const addUnreconciled = (list, source) => {
    for (const s of list || []) {
      if (s.reconciled) continue;
      out.push({
        kind: 'unreconciled',
        id: s.hash != null ? s.hash : undefined,
        label: `${source} statement not reconciled`,
        detail: [s.account ? `account ${s.account}` : '', s.period || '', s.reconNote || '']
          .filter(Boolean)
          .join(' · '),
      });
    }
  };
  addUnreconciled(cardStatements, 'Card');
  addUnreconciled(bankStatements, 'Bank');
  for (const it of attentionItems(allRows, {}, brandRules, merchants)) {
    if (it.type === 'large' && it.row && it.row.month === month) {
      out.push({
        kind: 'large',
        id: it.id,
        label: merchantDisplayLabel(it.row.description, brandRules, merchants),
        detail: it.text,
      });
    } else if (it.type === 'uncertain' && it.row && it.row.month === month) {
      out.push({
        kind: 'uncertain',
        id: it.id,
        label: merchantDisplayLabel(it.row.description, brandRules, merchants),
        detail: it.text,
      });
    }
  }

  for (const nm of detectNewMerchants(allRows, month, brandRules, merchants)) {
    out.push({
      kind: 'new',
      id: nm.key,
      label: nm.label,
      detail: 'New place this month',
    });
  }
  return out;
}

/* Ordering for the category picker (pure, presentation-only).
 * Returns every category exactly once, ordered so the quickest corrections are
 * nearest the top: the row's current category first, then the categories that
 * already appear in the current data (so common fixes are one or two taps),
 * then everything else in its configured order. This adds no stored state - it
 * is only an ordering, derived fresh from what is on screen. It never drops or
 * duplicates a category. */
export function orderCategoriesForPicker(allCategories, currentCategory, presentCategories = []) {
  const seen = new Set();
  const out = [];
  const push = (c) => {
    if (c != null && allCategories.includes(c) && !seen.has(c)) {
      seen.add(c);
      out.push(c);
    }
  };
  push(currentCategory);
  for (const c of presentCategories) push(c);
  for (const c of allCategories) push(c);
  return out;
}

/* Cap a row list for the printable report (pure, presentation-only). Returns
 * the first `cap` rows to render plus how many were held back, so a very long
 * period cannot spill an unbounded transaction table across dozens of printed
 * pages. It only slices a prefix - it never reorders, drops from the middle,
 * or duplicates - so `shown` followed by the `hidden` remainder always equals
 * the input, in the same order. A non-positive/omitted cap means "show all".
 * This mirrors the on-screen explorer's row-cap concept (TX_PAGE) and touches
 * no total, count, sort or filter. */
export function capForPrint(rows, cap) {
  const all = Array.isArray(rows) ? rows : [];
  if (!(cap > 0) || all.length <= cap) return { shown: all.slice(), hidden: 0 };
  return { shown: all.slice(0, cap), hidden: all.length - cap };
}

// Progressive-disclosure list helper, shared by every "show the first N,
// reveal the rest on request" list in both the Cards and Accounts render
// trees (categories, top places, regular payments, where money went, grouped
// by payee, imported statements, review items). NN/g's guidance is to show
// only the most important items up front and defer the rest to an explicit
// request, rather than either dumping everything on screen or silently
// truncating with no way to see what's hidden - the two failure modes found
// across this app's lists before this helper existed. Miller's chunking
// research (~7±2 items in working memory) is why 5 is the shipped default,
// comfortably under that limit.
//
// `items` is the FULL list (already sorted by relevance/amount by the
// caller); `renderItem(item)` returns one real DOM node per item; `parent` is
// the element the items (and the toggle) are appended into directly - a
// plain list div, or a <tbody>, so this works for both card-style rows and
// table rows without a second implementation. `opts.initial` (default 5)
// controls how many show before the toggle. `opts.wrapToggle(button)` lets a
// caller wrap the toggle button in whatever markup its list shape needs (a
// table needs a <tr><td colspan></td></tr>; a plain list just needs the
// button itself inside the existing .show-more treatment already used
// elsewhere in this app for exactly this purpose).
export function appendExpandable(el, parent, items, renderItem, opts = {}) {
  const initial = opts.initial || 5;
  const step = opts.step || 3;
  const shown = items.slice(0, initial);
  const rest = items.slice(initial);
  for (const item of shown) parent.append(renderItem(item));
  if (!rest.length) return;
  const restNodes = rest.map(renderItem);
  let visible = 0;
  const moreBtn = el('button', { class: 'btn sm ghost' }, 'See more');
  const allBtn = el('button', { class: 'btn sm' }, 'See all');
  const hideBtn = el('button', { class: 'btn sm ghost' }, 'Hide all');
  const controls = el('div', { class: 'show-more show-more-multi' }, moreBtn, allBtn, hideBtn);
  const anchor = opts.wrapToggle ? opts.wrapToggle(controls) : controls;
  const sync = () => {
    const remaining = rest.length - visible;
    moreBtn.hidden = remaining <= 0;
    allBtn.hidden = remaining <= 0;
    hideBtn.hidden = visible <= 0;
  };
  const reveal = (n) => {
    const end = Math.min(visible + n, restNodes.length);
    for (let i = visible; i < end; i++) anchor.before(restNodes[i]);
    visible = end;
    sync();
  };
  const collapse = () => {
    for (let i = 0; i < visible; i++) restNodes[i].remove();
    visible = 0;
    sync();
    // Removing many revealed rows shifts everything below the toggle upward
    // by however much was removed, with nothing previously correcting for
    // it - a disorienting jump if the toggle row itself had scrolled out of
    // view above the fold before "Hide all" was clicked. Brings it back into
    // view, honouring the same reduced-motion preference every other scroll
    // in this app already respects.
    const reduceMotion =
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    anchor.scrollIntoView({ behavior: reduceMotion ? 'auto' : 'smooth', block: 'nearest' });
  };
  moreBtn.addEventListener('click', () => reveal(step));
  allBtn.addEventListener('click', () => {
    if (opts.onExpandChange) opts.onExpandChange(true);
    else reveal(restNodes.length);
  });
  hideBtn.addEventListener('click', () => {
    if (opts.onExpandChange) opts.onExpandChange(false);
    else collapse();
  });
  sync();
  parent.append(anchor);
  if (opts.expandAll) reveal(restNodes.length);
}

// Shared low-level renderer for the small "coloured dot + text label" type
// indicator used by both ledgers' transaction tables (cards-render.js's
// kindTag, accounts-render.js's flow column). Previously accounts-render.js
// hand-built the same .ktag/.kdot/.klabel markup inline instead of calling
// the equivalent component cards-render.js already exports, AND reused
// Cards-domain class names (k-fee, k-refund) for bank-only concepts
// (household transfers, income-excluded deposits) that have nothing to do
// with fees or refunds - a semantic leak on top of the duplication. This
// takes only the already-resolved label and CSS class, so each caller
// supplies its own domain-appropriate mapping while sharing one DOM shape.
export function renderKindTag(el, label, cls) {
  return el(
    'span',
    { class: 'ktag ' + cls },
    el('span', { class: 'kdot' }),
    el('span', { class: 'klabel' }, label)
  );
}
export const SHARE_PALETTE = [
  '#2f6fb0',
  '#3f9d6b',
  '#c98a1b',
  '#a05fb4',
  '#4aa3a3',
  '#c65b7c',
  '#6b8e3d',
  '#b5642e',
  '#5a78c2',
  '#8a8f2f',
  '#3e8fb0',
  '#9a5aa8',
  '#c0603f',
  '#557f9e',
];
// Cash inflow is one green family and Cash outflow is one orange family, matching the
// app's colour language (green = toward you, warm = away). Each is a single-hue
// ramp stepping from light to deep, so every slice in a bar reads unmistakably
// as "in" (green) or "out" (orange) while staying distinct from its neighbours
// by lightness alone - no stray blue, rose or purple breaking the family.
export const MONEY_IN_PALETTE = ['#5cbf8c', '#3aa06c', '#2a8656', '#1e6d44', '#155835', '#0e4327'];
export const MONEY_OUT_PALETTE = ['#f2a35a', '#e5852f', '#d16f22', '#b45a18', '#954712', '#78380d'];
export function renderShareBar(el, opts = {}) {
  const segments = (opts.segments || []).filter((s) => s && Number(s.amount) > 0);
  let total = segments.reduce((sum, s) => sum + Number(s.amount), 0);
  if (!segments.length || total <= 0) return null;
  const parts = segments.slice();
  const shownTotal = total;
  const grandTotal =
    opts.grandTotal != null && opts.grandTotal > shownTotal ? opts.grandTotal : shownTotal;
  const remainder = grandTotal - shownTotal;
  if (remainder > 0) {
    parts.push({
      colour: opts.remainderColour || 'var(--dim)',
      amount: remainder,
      label: opts.remainderLabel || 'Everything else',
    });
    total = grandTotal;
  }
  // The money-direction colour language, chosen in ONE place. A caller states
  // which way the money moves (direction:'in' or 'out') and this picks the
  // matching family - Cash inflow in the cool/green family, Cash outflow in the warm
  // family - so every "came in" bar and every "went out" bar across the whole
  // product is coloured the same way, without each caller importing or choosing
  // a palette of its own and risking drift. An explicit opts.palette still wins
  // as an escape hatch. When neither is given the bar keeps the collision-
  // avoiding behaviour below: any slice whose colour repeats an earlier one is
  // bumped to the next free SHARE_PALETTE entry, which stops two adjacent slices
  // sharing a hue.
  const directionPalette =
    opts.direction === 'in'
      ? MONEY_IN_PALETTE
      : opts.direction === 'out'
        ? MONEY_OUT_PALETTE
        : null;
  const paletteByPosition =
    Array.isArray(opts.palette) && opts.palette.length ? opts.palette : directionPalette;
  const leadCount = remainder > 0 ? parts.length - 1 : parts.length;
  const used = new Set();
  for (let i = 0; i < leadCount; i++) {
    if (paletteByPosition) {
      const c = paletteByPosition[i % paletteByPosition.length];
      parts[i] = { ...parts[i], colour: c };
      used.add(c);
      continue;
    }
    let c = parts[i].colour;
    if (used.has(c)) {
      const free = SHARE_PALETTE.find((p) => !used.has(p));
      if (free) {
        c = free;
        parts[i] = { ...parts[i], colour: c };
      }
    }
    used.add(c);
  }
  const track = el('div', {
    class: 'share-bar-track',
    role: 'img',
    'aria-label': opts.ariaLabel || 'Share of the total',
  });
  const escKey = (k) =>
    typeof CSS !== 'undefined' && CSS.escape
      ? CSS.escape(k)
      : String(k).replace(/["\\\]]/g, '\\$&');
  const setHot = (node, key, on) => {
    node.classList.toggle('anchor-hot', on);
    if (key == null) return;
    const scope = node.closest('.share-bar');
    const root = scope && scope.parentNode ? scope.parentNode : document;
    root.querySelectorAll('[data-anchor="' + escKey(String(key)) + '"]').forEach((n) => {
      if (n !== node) n.classList.toggle('anchor-hot', on);
    });
  };
  for (const s of parts) {
    const pct = (Number(s.amount) / total) * 100;
    const interactive = !!(s.key != null || s.onActivate);
    const attrs = {
      class: 'share-bar-seg' + (interactive ? ' anchorable' : ''),
      style: `width:${pct}%;background:${s.colour}`,
      title: s.label || null,
    };
    if (s.key != null) attrs.dataset = { anchor: String(s.key) };
    if (interactive) attrs['aria-label'] = s.label || null;
    const seg = el(interactive ? 'button' : 'span', attrs);
    if (interactive) {
      let lp = null,
        held = false;
      seg.addEventListener('pointerenter', () => setHot(seg, s.key, true));
      seg.addEventListener('pointerleave', () => setHot(seg, s.key, false));
      seg.addEventListener('pointerdown', () => {
        held = false;
        lp = setTimeout(() => {
          held = true;
          setHot(seg, s.key, true);
        }, 350);
      });
      const end = () => {
        clearTimeout(lp);
        if (held) setTimeout(() => setHot(seg, s.key, false), 1200);
      };
      seg.addEventListener('pointerup', end);
      seg.addEventListener('pointercancel', end);
      if (s.onActivate)
        seg.addEventListener('click', (e) => {
          if (held) {
            e.preventDefault();
            return;
          }
          s.onActivate();
        });
    }
    track.append(seg);
  }
  const bar = el('div', { class: 'share-bar' }, track);
  if (opts.centerValue != null || opts.centerLabel != null) {
    const cap = el('div', { class: 'share-bar-cap muted small' });
    if (opts.centerValue != null)
      cap.append(el('span', { class: 'share-bar-total' }, opts.centerValue));
    if (opts.centerLabel != null) cap.append(el('span', {}, ' ' + opts.centerLabel));
    bar.append(cap);
  }
  return bar;
}

export function renderFlowArrow(el, icons, direction) {
  const isIn = direction === 'in';
  return el('span', {
    class: 'flow-arrow ' + (isIn ? 'in' : 'out'),
    'aria-hidden': 'true',
    html: isIn ? icons.up() : icons.down(),
  });
}

// The ONE shared "active filters" chip row, used by Cards' All-transactions
// explorer and Accounts' Transactions card. Previously each ledger built this
// independently: Cards as a proper wrapping chip row, Accounts as concatenated
// title text plus one button per active facet with no wrap behaviour - so two
// simultaneous Accounts facets (an account + a payee) plus its Show/Hide button
// overflowed the header on a narrow phone. Chips wrap by construction (.chips
// is already flex-wrap), so any future combination of facets, on either tab,
// degrades safely on any width instead of clipping. items is
// [{ label, onClear }]; returns a real .chips node, or null when nothing is
// active so the caller can omit an empty row entirely.
export function renderFilterChips(el, iconX, items, onClearAll) {
  if (!items.length) return null;
  const chips = items.map(({ label, onClear }) =>
    el(
      'button',
      { class: 'chip removable', onclick: onClear },
      label,
      el('span', { class: 'chip-x', html: iconX() })
    )
  );
  return el(
    'div',
    { class: 'chips' },
    el('span', { class: 'muted small' }, 'Filters:'),
    ...chips,
    el('button', { class: 'linkbtn', onclick: onClearAll }, 'Clear all')
  );
}

// One shared fact chip for the hero facts row, replacing the two near-identical
// hand-rolled builders that had drifted apart: Cards' `fact(value, label,
// onClick, colour, cls)` and Accounts' `bankFact(label, value, cls)` (note the
// argument order even disagreed). Takes a pure-data fact and renders the exact
// same DOM both produced, so a fact reads and behaves identically on every tab.
function heroFact(el, f) {
  const attrs = {
    class: 'fact' + (f.onClick ? ' clickable' : '') + (f.tone ? ' ' + f.tone : ''),
  };
  if (f.onClick) attrs.onclick = f.onClick;
  const v = el(
    'div',
    { class: 'fact-value' },
    f.colour ? el('span', { class: 'swatch', style: `background:${f.colour}` }) : null,
    el('span', {}, f.value)
  );
  return el(f.onClick ? 'button' : 'div', attrs, v, el('div', { class: 'fact-label' }, f.label));
}

// The ONE shared top-of-tab hero builder. Previously each tab hand-built its
// own hero inline (Cards' renderHero, the Accounts block inside renderAccounts,
// the Overview block inside renderOverview), in three different orders - which
// is exactly how the Overview hero came to render its "what needs tidying"
// chore block ABOVE net cash flow, inverting the dashboard hierarchy (status/
// headline first, chores and detail after). This builder emits ONE fixed order
// that encodes the Level 1-4 hierarchy as code structure, so no tab can put
// chores above the headline again:
//   1. eyebrow + title (+ optional caution pill)
//   2. verdict sub-headline (optional)
//   3. hero-body: the ONE lead figure (+ any comparison extras) and the facts row
//   4. attention line - the single, calm "what could use a look" line, ALWAYS
//      below the numbers, never above
//   5. note - a muted caveat
// The spec is plain data (functions in onClick are fine - it is never
// serialised). Interactive/prebuilt nodes (lead.extra, attention, note) are
// built by the caller, which owns the closures; the builder owns only WHERE
// each slot goes, which is what enforces the hierarchy.
export function buildHeroSection(el, icon, iconInfo, spec) {
  const sec = el('section', {
    class: 'card hero' + (spec.verdict ? ' verdict' : ''),
  });
  const head = el(
    'div',
    { class: 'hero-head' },
    el(
      'div',
      {},
      el('div', { class: 'hero-eyebrow' }, spec.eyebrow),
      el('h2', { class: 'hero-title' }, spec.title)
    )
  );
  if (spec.pill)
    head.append(
      el(
        'span',
        { class: 'pill caution', title: spec.pill.title },
        icon(iconInfo()),
        spec.pill.text
      )
    );
  sec.append(head);
  if (spec.pill && spec.pill.subline)
    sec.append(el('p', { class: 'muted small mobile-context' }, spec.pill.subline));
  if (spec.verdict) {
    sec.append(
      el(
        'div',
        { class: 'hero-verdict' },
        el('span', { class: `attn-dot ${spec.verdict.tone}` }),
        ' ',
        spec.verdict.text
      )
    );
    if (spec.verdict.comparison) sec.append(el('p', { class: 'muted' }, spec.verdict.comparison));
  }
  const figure = el(
    'div',
    { class: 'hero-figure' },
    el('div', { class: 'hero-amount' }, spec.lead.amount),
    el('div', { class: 'hero-amount-label' }, spec.lead.label),
    ...(spec.lead.extra || []).filter(Boolean)
  );
  const facts = el(
    'div',
    { class: 'hero-facts' },
    ...spec.facts.filter(Boolean).map((f) => heroFact(el, f))
  );
  sec.append(el('div', { class: 'hero-body' }, figure, facts));
  if (spec.attention) sec.append(spec.attention);
  if (spec.note) sec.append(spec.note);
  return sec;
}

// The ONE shared "insights" card, replacing three byte-identical copies
// (cards-render's renderInsightCards, accounts-render's renderBankInsightsCard,
// app.js's renderOverviewInsightsCard) that only differed in which insight
// array and empty-text they carried. One concept ("what's new or unusual")
// now renders one way everywhere. Each insight is { tone, icon (html string),
// text, onClick }, the shape all three insight engines already produce.
export function renderInsightList(el, icon, opts) {
  const { title, iconBulb, iconChevron, insights, emptyText } = opts;
  const sec = el('section', { class: 'card insights' });
  sec.append(
    el('div', { class: 'card-head' }, el('h3', { class: 'card-title' }, icon(iconBulb()), title))
  );
  if (!insights.length) {
    sec.append(el('p', { class: 'muted pad' }, emptyText));
    return sec;
  }
  const list = el('div', { class: 'insight-list' });
  for (const i of insights)
    list.append(
      el(
        'button',
        { class: 'insight tone-' + i.tone, onclick: i.onClick },
        el('span', { class: 'insight-icon', html: i.icon }),
        el('span', { class: 'insight-text' }, i.text),
        el('span', { class: 'insight-go', html: iconChevron() })
      )
    );
  sec.append(list);
  return sec;
}

// The ONE shared standalone "needs attention" card, the twin of renderInsightList
// for the attention surface. Cards' "Worth a look" is exactly this shape - a
// dot-toned list of one-line items, each with an optional muted detail and a
// row of action buttons - so this primitive owns that presentation once, giving
// every standalone attention card the same dot convention, the same body layout
// and the same button vocabulary. Reuses the existing .card.attention /
// .attn-item / .attn-dot / .attn-body / .attn-actions styles verbatim, so no new
// CSS is introduced. Each item is { tone: 'blocking'|'optional'|'good', title,
// detail?, actions?[{ label, onClick, variant }] }, where tone maps to the quiet
// dot (blocking->warn, optional->review, good->good) that is always paired with
// the text beside it, and variant maps to the existing .btn treatments (primary
// is the plain .btn.sm, ghost and danger add their class). A caller with no
// items either passes calmText for a reassuring line or omits the card itself.
export function renderAttentionList(el, icon, opts) {
  const { title, iconInfo, items, calmText } = opts;
  const sec = el('section', { class: 'card attention' });
  sec.append(
    el('div', { class: 'card-head' }, el('h3', { class: 'card-title' }, icon(iconInfo()), title))
  );
  if (!items.length) {
    if (calmText) sec.append(el('p', { class: 'muted pad' }, calmText));
    return sec;
  }
  for (const it of items) {
    const dot = it.tone === 'blocking' ? 'warn' : it.tone === 'good' ? 'good' : 'review';
    const actionNodes = (it.actions || []).map((a) =>
      el(
        'button',
        {
          class: 'btn sm' + (a.variant && a.variant !== 'primary' ? ' ' + a.variant : ''),
          onclick: a.onClick,
        },
        a.label
      )
    );
    sec.append(
      el(
        'div',
        { class: 'attn-item' },
        el('span', { class: 'attn-dot ' + dot }),
        el(
          'div',
          { class: 'attn-body' },
          el('div', {}, it.title),
          it.detail ? el('div', { class: 'muted small' }, it.detail) : null
        ),
        actionNodes.length ? el('div', { class: 'attn-actions' }, ...actionNodes) : null
      )
    );
  }
  return sec;
}

/* ===========================================================================
 * The ONE attention-item builder, read identically by Right Now's full
 * "Worth a look" queue and Overview's decision-forcing "Needs attention"
 * head - the plan's "one resolver, read identically by Activity, Needs
 * attention and Goals" rule, applied here so the two screens can never
 * author two divergent attention lists. Pure: every input is passed in via
 * deps (never closed over), so it is directly testable and both callers
 * feed it the SAME live models. Returns { tone:'blocking'|'optional',
 * title, detail, actions:[{label,onClick,variant}] }[], severity-ordered
 * (blocking first). renderAttentionList turns this into DOM; this function
 * decides only WHAT is worth attention, never how it looks.
 *
 * The shortfall item (the plan's lead attention item - "an expected
 * shortfall before income") is derived from the SAME availableNow model the
 * Overview lead card renders: its lead figure going negative IS the
 * shortfall, single-sourced, never a second calculation.
 * ======================================================================== */
export function buildAttentionItems(deps) {
  const {
    cardRows = [],
    bankRecs = [],
    cardStatements = [],
    bankStatements = [],
    brandRules = [],
    merchants = null,
    rows = [],
    period = null,
    cfg = {},
    splits = [],
    fallback = 'Uncategorised',
    availableNow = null,
    money0,
    formatDisplayDate,
    isUnrecognised,
    detectPossibleDuplicates,
    detectCategorySpikes,
    dismissReview,
    pickStatements,
    drillToTransactions,
  } = deps;

  const items = [];

  // 1) BLOCKING: an expected shortfall before the next income - the plan's
  // lead attention item. Read from availableNow's lead figure (the same one
  // Overview's hero card shows); negative means known commitments outrun the
  // cash expected before payday.
  if (
    availableNow &&
    availableNow.lead &&
    typeof availableNow.lead.amount === 'number' &&
    availableNow.lead.amount < 0
  ) {
    items.push({
      tone: 'blocking',
      title: `Cash may run short before your next income by ${money0(Math.abs(availableNow.lead.amount))}`,
      detail:
        availableNow.confidence === 'incomplete'
          ? 'This is an estimate - a missing statement or income date could change it. Add what is missing to firm it up.'
          : 'Known commitments before your next income come to more than the cash expected to cover them.',
      actions: [{ label: 'Add statement', onClick: pickStatements, variant: 'ghost' }],
    });
  }

  // 2) BLOCKING: unreconciled statements (card and bank) - a total could be
  // short until they are resolved.
  const cardUnrec = (cardStatements || []).filter((s) => !s.reconciled);
  const bankUnrec = (bankStatements || []).filter((s) => !s.reconciled);
  for (const s of cardUnrec)
    items.push({
      tone: 'blocking',
      title: `Card statement not reconciled${s.period ? ` (${s.period})` : ''}`,
      detail: s.reconNote || '',
      actions: [{ label: 'Add statement', onClick: pickStatements, variant: 'ghost' }],
    });
  for (const s of bankUnrec)
    items.push({
      tone: 'blocking',
      title: `Account statement not reconciled${s.period ? ` (${s.period})` : ''}`,
      detail: s.reconNote || '',
      actions: [{ label: 'Add statement', onClick: pickStatements, variant: 'ghost' }],
    });

  // 3) OPTIONAL: purchases worth a second look. Totals already count them, so
  // refining is optional tidying, not a blocker.
  const uncategorised = cardRows.filter(
    (r) => r.kind === 'spend' && isUnrecognised(r, fallback) && !r.reviewDismissed
  );
  const needsReviewRows = cardRows.filter(
    (r) => r.kind === 'spend' && r.needsReview && !r.reviewDismissed
  );
  const reviewRows = [...uncategorised, ...needsReviewRows];
  if (reviewRows.length) {
    const reviewTotal = reviewRows.reduce((s, r) => s + r.amount, 0);
    items.push({
      tone: 'optional',
      title: `${reviewRows.length} purchase${reviewRows.length === 1 ? '' : 's'} could use a second look (${money0(reviewTotal)})`,
      detail:
        'The totals already count them, so refining is optional. Tap any of them for the reason.',
      actions: [
        {
          label: 'Looks fine',
          onClick: () => dismissReview(reviewRows),
          variant: 'ghost',
        },
        {
          label: 'Refine',
          onClick: () => drillToTransactions({ reviewOnly: true, category: 'all' }),
          variant: 'primary',
        },
      ],
    });
  }

  // 4) OPTIONAL: possible duplicate charges.
  const dups = detectPossibleDuplicates(cardRows, brandRules, merchants);
  for (const d of dups) {
    items.push({
      tone: 'optional',
      title: `Possible duplicate: ${d.label}, ${money0(d.amount)} charged twice`,
      detail: `${formatDisplayDate(d.dates[0])} and ${formatDisplayDate(d.dates[1])}. Worth confirming this is not a double charge.`,
      actions: [
        {
          label: 'Looks fine',
          onClick: () => dismissReview(d.ids.map((id) => ({ id }))),
          variant: 'ghost',
        },
      ],
    });
  }

  // 5) OPTIONAL: a category running much hotter than usual this period.
  const spikes = period ? detectCategorySpikes(rows, period, cfg, splits) : [];
  for (const sp of spikes) {
    items.push({
      tone: 'optional',
      title: `${sp.category} spending is much higher than usual this period (${money0(sp.amount)} vs a typical ${money0(sp.typical)})`,
      detail: 'No single charge stands out, but the category total does.',
      actions: [
        {
          label: 'Refine',
          onClick: () => drillToTransactions({ category: sp.category, reviewOnly: false }),
          variant: 'primary',
        },
      ],
    });
  }

  return items;
}

// Shared "how this is worked out" disclosure for methodology / caveat prose
// (Recommendation 4, Class 5). Dense grey explanatory paragraphs used to sit
// permanently under heroes and cards - read once, ignored forever - making
// otherwise calm screens read as text-heavy. This wraps such prose in a native
// <details>, CLOSED by default so the screen stays calm, revealed on demand by
// anyone who wants the detail. Native <details> mirrors the app's existing
// "Data & settings" card pattern, needs no JS, and is keyboard / screen-reader
// accessible by default. `body` may be a string or a prebuilt node. Used ONLY
// for genuinely multi-sentence methodology; one-line hints, warnings and
// interaction cues stay inline where hiding them would cost more than it saves.
export function renderExplainer(el, body, opts = {}) {
  const d = el('details', {
    class: 'explainer' + (opts.class ? ' ' + opts.class : ''),
  });
  d.append(el('summary', {}, opts.label || 'How this is worked out'));
  d.append(el('div', { class: 'explainer-body muted small' }, body));
  return d;
}

/* ===========================================================================
 * 10b) Period + analysis helpers  (pure, additive, testable)
 * ---------------------------------------------------------------------------
 * These power the reorganised dashboard: a period selector, an honest
 * "latest complete month" default, comparison with the previous comparable
 * period and the historical average, incomplete-month detection, recurring
 * charge detection and richer insights. They are pure functions of the rows
 * (and an optional "today") so they can be unit-tested without a browser and
 * never change any stored value.
 * ======================================================================== */

const DAYS_IN_MONTH = (y, m) => new Date(y, m, 0).getDate(); // m = 1..12

// 'YYYY-MM' -> 'Month YYYY'. Uses MONTH_LONG from the preserved core (same module scope).
export function monthName(ym) {
  const m = /^(\d{4})-(\d{2})$/.exec(ym);
  return m ? `${MONTH_LONG[+m[2] - 1]} ${m[1]}` : ym;
}

export function ymToday(now = new Date()) {
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
}
function addMonthsYM(ym, delta) {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function dayOfIso(iso) {
  const m = /^\d{4}-\d{2}-(\d{2})$/.exec(iso);
  return m ? +m[1] : 0;
}
function median(nums) {
  if (!nums.length) return 0;
  const s = nums.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/* ===========================================================================
 * Statement coverage model  (fact-based calendar-month completeness)
 * ---------------------------------------------------------------------------
 * buildRows already buckets every transaction by its CALENDAR month, so "June"
 * means 1-30 June app-wide, not a 15-May-to-15-June billing cycle. What was
 * missing was any knowledge of HOW MUCH of each calendar month is actually
 * imported. detectIncompleteMonth used to GUESS this from the shape of spending
 * (a quiet-but-complete month read as partial; a partial month carrying one big
 * charge read as complete - the "18% less than June" distortion). This replaces
 * the guess with a FACT derived from the statement periods the app already
 * stores. For each ledger and calendar month it reports 'full' (statements span
 * the whole month), 'partial' (only part), 'none' (the ledger has data that
 * month but no parseable covering statement), or 'absent' (no data that month).
 *
 * Defensive by construction: any statement whose dates cannot be parsed simply
 * contributes no span, so an unrecognised statement shape degrades a month to
 * 'unknown' at the verdict level and the caller falls back to the old spend
 * heuristic - never worse than today, better wherever the dates parse.
 *
 * Field shapes read (confirm against read-statements.js if coverage does not
 * activate): card statements carry ISO periodStart/periodEnd ('YYYY-MM-DD');
 * bank statements carry a `period` string "DD Mon YYYY - DD Mon YYYY" (the
 * exact form accounts-render already parses to sort statements). NCB card
 * records may carry neither, in which case their months read 'none'/'unknown'
 * and fall back to the heuristic - a noted follow-up, not a regression.
 * ======================================================================== */

const COVERAGE_MON = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

// Parse ISO 'YYYY-MM-DD' to a UTC day-ms, or null. UTC throughout so a device
// time zone can never shift a statement date across a month boundary.
function coverageIsoMs(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(s || ''));
  return m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : null;
}

// Parse the two "DD Mon YYYY" dates out of a bank period string -> [startMs,
// endMs], or null when fewer than two dates are present/parseable.
function coverageBankSpan(period) {
  const re = /(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})/g;
  const found = [];
  let m;
  while ((m = re.exec(String(period || ''))) !== null) {
    const mo = COVERAGE_MON[m[2].toLowerCase()];
    if (mo != null) found.push(Date.UTC(+m[3], mo, +m[1]));
  }
  return found.length >= 2 ? [found[0], found[found.length - 1]] : null;
}

// Classify one calendar month against covered [startMs,endMs] spans: 'full'
// when the spans, starting on or before day 1, reach the last day with no gap;
// 'partial' when they cover only part; 'none' when nothing touches the month.
function coverageMonthStatus(spans, ym) {
  const [y, mo] = ym.split('-').map(Number);
  if (!y || !mo) return 'none';
  const firstMs = Date.UTC(y, mo - 1, 1);
  const lastDay = new Date(Date.UTC(y, mo, 0)).getUTCDate();
  const lastMs = Date.UTC(y, mo - 1, lastDay);
  const clamped = [];
  for (const [a, b] of spans) {
    const lo = Math.max(a, firstMs),
      hi = Math.min(b, lastMs);
    if (lo <= hi) clamped.push([lo, hi]);
  }
  if (!clamped.length) return 'none';
  clamped.sort((x, z) => x[0] - z[0]);
  if (clamped[0][0] > firstMs) return 'partial'; // coverage starts mid-month
  let reach = clamped[0][1];
  for (let i = 1; i < clamped.length; i++) {
    if (clamped[i][0] <= reach + 86400000) reach = Math.max(reach, clamped[i][1]);
    else break; // gap: stop counting
  }
  return reach >= lastMs ? 'full' : 'partial';
}

// Build the coverage map. cardMonths/bankMonths are the Sets of 'YYYY-MM' that
// actually carry transactions on each ledger, so a month with no data on a
// ledger reads 'absent' (never blocking completeness) rather than 'none'.
export function buildStatementCoverage(
  cardStatements = [],
  bankStatements = [],
  cardMonths = new Set(),
  bankMonths = new Set()
) {
  const cardSpans = [];
  for (const s of cardStatements || []) {
    const a = coverageIsoMs(s.periodStart),
      b = coverageIsoMs(s.periodEnd);
    if (a != null && b != null && a <= b) cardSpans.push([a, b]);
  }
  const bankSpans = [];
  for (const s of bankStatements || []) {
    const span = coverageBankSpan(s.period);
    if (span) bankSpans.push(span);
  }
  const months = {};
  for (const ym of new Set([...cardMonths, ...bankMonths])) {
    months[ym] = {
      card: cardMonths.has(ym) ? coverageMonthStatus(cardSpans, ym) : 'absent',
      bank: bankMonths.has(ym) ? coverageMonthStatus(bankSpans, ym) : 'absent',
    };
  }
  return { months };
}

// The shared verdict a calendar month gets, considering only ledgers that have
// data that month: 'partial' if any present ledger is provably partial, 'full'
// if every present ledger is provably full, 'unknown' otherwise (nothing
// parseable to decide - the caller falls back).
function monthCoverageVerdict(coverage, ym) {
  const c = coverage && coverage.months && coverage.months[ym];
  if (!c) return 'unknown';
  const present = [];
  if (c.card !== 'absent') present.push(c.card);
  if (c.bank !== 'absent') present.push(c.bank);
  if (!present.length) return 'unknown';
  if (present.some((s) => s === 'partial')) return 'partial';
  if (present.every((s) => s === 'full')) return 'full';
  return 'unknown';
}

// Is every month in a resolved period provably fully covered? Gates period-
// over-period comparisons so a half-imported current month is never compared
// as if whole. Conservative: an 'unknown' month does NOT block the comparison
// (no regression where statement dates cannot yet be parsed); only a provably
// 'partial' month does.
export function isPeriodFullyCovered(coverage, period) {
  if (!coverage || !period || !period.from || !period.to) return true;
  let ym = period.from;
  while (ym <= period.to) {
    if (monthCoverageVerdict(coverage, ym) === 'partial') return false;
    if (ym === period.to) break;
    ym = addMonthsYM(ym, 1);
  }
  return true;
}

// Coverage disclosure (Round 1, foundation): how many of the months in a
// multi-month period are provably NOT partial (full or unknown), out of the
// total months the period spans. Reuses the exact same per-month verdict and
// the same conservative rule isPeriodFullyCovered already applies - an
// 'unknown' month (no parseable statement dates) is never counted against the
// total, only a PROVABLY 'partial' month is - so this can never wrongly claim
// "based on 0 of 6 months" on a complete history the coverage model simply
// cannot classify. Returns null for a single-month period (from === to): that
// case already has its own, more specific "may be incomplete" wording at the
// call site, and "based on 1 of 1 months" would say nothing useful. Also
// returns null when every month is confirmed-not-partial, so a caller can
// treat null as "nothing to disclose". Pure.
export function periodCoverage(coverage, period) {
  if (!coverage || !period || !period.from || !period.to || period.from === period.to) return null;
  let total = 0,
    full = 0;
  let ym = period.from;
  while (true) {
    total++;
    if (monthCoverageVerdict(coverage, ym) !== 'partial') full++;
    if (ym === period.to) break;
    ym = addMonthsYM(ym, 1);
  }
  if (full >= total) return null;
  return { full, total };
}

// The plain-language sentence built from periodCoverage, above - the fixed
// "based on N of M months" wording used everywhere a multi-month total, list
// or breakdown rests on a period with a provably partial month in it. One
// wording, one place it is built, so it can never drift between the three
// tabs that each show it.
export function periodCoverageNote(coverage, period) {
  const c = periodCoverage(coverage, period);
  if (!c) return null;
  const missing = c.total - c.full;
  return `Based on ${c.full} of ${c.total} months. ${missing === 1 ? 'One month is' : `${missing} months are`} only partly imported, so this total may be a little higher.`;
}

/* Which month, if any, looks incomplete. The latest month is flagged when it
 * is the live calendar month (more can still post), or when its statement
 * clearly has not closed: it did not reach near the month end AND its spend is
 * far below the recent norm. Returns { month, reason } or null. Language stays
 * cautious ("may be incomplete") because this is a heuristic, not a fact. */
export function detectIncompleteMonth(rows, months, now = new Date(), opts = {}) {
  // D-audit item 5. The two constants below are a product judgement call, not a
  // derivable fact (how conservative should "this month looks unfinished" feel?),
  // so they are now overridable via config while keeping the shipped defaults:
  //   incompleteDayMargin (3) - the latest month's newest transaction must be at
  //     least this many days short of month-end for it to look unclosed;
  //   incompleteSpendRatio (0.6) - AND its spend must be below this fraction of
  //     the recent median month. Both conditions must hold, so an ordinary quiet
  //     month that simply ran to month-end is never flagged. Defaults preserved.
  const dayMargin = opts.dayMargin == null ? 3 : opts.dayMargin;
  const spendRatio = opts.spendRatio == null ? 0.6 : opts.spendRatio;
  if (!months.length) return null;
  const latest = months[months.length - 1];
  const todayYM = ymToday(now);
  if (latest === todayYM) return { month: latest, reason: 'current' };
  if (latest > todayYM) return null; // future-dated data: don't guess

  // Coverage-first: when the imported statements can decide whether the newest
  // calendar month is fully or only partly imported, trust that FACT and skip
  // the spend-shape guess below. Only 'unknown' (no parseable statement dates
  // for a ledger with data that month) falls through to the heuristic - so this
  // is never worse than before, and better wherever statement dates parse.
  const coverage = opts.coverage || null;
  if (coverage) {
    const verdict = monthCoverageVerdict(coverage, latest);
    if (verdict === 'partial') return { month: latest, reason: 'partial' };
    if (verdict === 'full') return null;
    // 'unknown' → fall through to the spend-shape heuristic below.
  }

  const spendByMonth = {};
  let lastDay = 0;
  for (const r of rows) {
    if (r.kind !== 'spend') continue;
    spendByMonth[r.month] = (spendByMonth[r.month] || 0) + r.amount;
    if (r.month === latest) lastDay = Math.max(lastDay, dayOfIso(r.date));
  }
  const prior = months.slice(0, -1).slice(-3);
  if (prior.length >= 2) {
    const [y, m] = latest.split('-').map(Number);
    const dim = DAYS_IN_MONTH(y, m);
    const med = median(prior.map((mm) => spendByMonth[mm] || 0));
    const latestTotal = spendByMonth[latest] || 0;
    if (lastDay > 0 && lastDay < dim - dayMargin && med > 0 && latestTotal < spendRatio * med) {
      return { month: latest, reason: 'partial' };
    }
  }
  return null;
}

/* The latest month we can report on with confidence. */
export function latestCompleteMonth(rows, months, now = new Date(), coverage = null) {
  if (!months.length) return null;
  const inc = detectIncompleteMonth(rows, months, now, { coverage });
  if (inc && inc.month === months[months.length - 1]) {
    return months.length >= 2 ? months[months.length - 2] : months[months.length - 1];
  }
  return months[months.length - 1];
}

/* Resolve a period selection into a concrete { from, to } month range (both
 * inclusive, 'YYYY-MM'), plus a label and the previous comparable range for
 * change calculations. `sel` is { type, month?, from?, to? }. */
export function resolvePeriod(sel, rows, months, now = new Date(), coverage = null) {
  if (!months.length) return null;
  const first = months[0];
  const last = months[months.length - 1];
  const todayYM = ymToday(now);
  const lcm = latestCompleteMonth(rows, months, now, coverage);
  const clampLo = (ym) => (ym < first ? first : ym);
  const mk = (from, to, label, prevFrom, prevTo, kind) => ({
    from: clampLo(from),
    to,
    label,
    prevFrom: prevFrom ? clampLo(prevFrom) : null,
    prevTo: prevTo || null,
    kind: kind || sel.type,
  });

  switch (sel.type) {
    case 'latest-complete': {
      const t = lcm || last;
      return mk(t, t, monthName(t), addMonthsYM(t, -1), addMonthsYM(t, -1), 'month');
    }
    case 'current-month': {
      const t = last; // newest month present (may be in progress)
      return mk(t, t, monthName(t), addMonthsYM(t, -1), addMonthsYM(t, -1), 'month');
    }
    case 'previous-month': {
      const base = lcm || last;
      const t = addMonthsYM(base, -1);
      return mk(t, t, monthName(t), addMonthsYM(t, -1), addMonthsYM(t, -1), 'month');
    }
    case 'last-3': {
      const to = lcm || last;
      const from = addMonthsYM(to, -2);
      return mk(from, to, 'Last 3 months', addMonthsYM(from, -3), addMonthsYM(to, -3), 'range');
    }
    case 'last-6': {
      const to = lcm || last;
      const from = addMonthsYM(to, -5);
      return mk(from, to, 'Last 6 months', addMonthsYM(from, -6), addMonthsYM(to, -6), 'range');
    }
    case 'this-year': {
      const y = (lcm || last).slice(0, 4);
      const from = `${y}-01`;
      const to = lcm || last;
      const py = String(+y - 1);
      return mk(from, to, `${y}`, `${py}-01`, `${py}-12`, 'range');
    }
    case 'custom': {
      const from = sel.from || first;
      const to = sel.to || last;
      const span = monthSpanCount(from, to);
      return mk(
        from,
        to,
        `${monthName(from)} - ${monthName(to)}`,
        addMonthsYM(from, -span),
        addMonthsYM(to, -span),
        'range'
      );
    }
    case 'all':
    default:
      return mk(first, last, 'All time', null, null, 'all');
  }
}

function monthSpanCount(from, to) {
  const [fy, fm] = from.split('-').map(Number);
  const [ty, tm] = to.split('-').map(Number);
  return (ty - fy) * 12 + (tm - fm) + 1;
}
function inRange(ym, from, to) {
  return ym >= from && ym <= to;
}

/* Analyse a resolved period into everything the dashboard shows for it:
 * totals split by kind, purchase count, leading category, category and
 * merchant breakdowns, per-month spend, and change vs the previous comparable
 * period and vs the historical monthly average. Pure. */
export function analysePeriod(rows, period, opts = {}) {
  // Named merchantIntel here (not `merchants`) to avoid colliding with the local
  // `const merchants` result array built below; it is the compiled merchant list.
  const {
    keepUpperSet = new Set(),
    smallWordsSet = new Set(),
    merchantLabelFn = (s) => s,
    brandRules = [],
    merchants: merchantIntel = null,
    splits = [],
  } = opts;
  const inP = rows.filter((r) => inRange(r.month, period.from, period.to));
  const spend = inP.filter((r) => r.kind === 'spend');

  const totalSpend = roundMoney(spend.reduce((a, r) => a + r.amount, 0));
  const totalPayments = roundMoney(
    inP.filter((r) => r.kind === 'payment').reduce((a, r) => a - r.amount, 0)
  );
  const totalRefunds = roundMoney(
    inP.filter((r) => r.kind === 'refund').reduce((a, r) => a - r.amount, 0)
  );
  const totalFees = roundMoney(
    inP.filter((r) => r.kind === 'fee').reduce((a, r) => a + r.amount, 0)
  );

  const monthsInP = [...new Set(inP.map((r) => r.month))].sort();

  // See summarise's own comment: splits redistribute category attribution only.
  // Shares still sum to ~1 because the split total equals the unsplit total.
  const splitsByTxn = splitsByTxnId(splits);
  const { byCategory: byCatSplit } = categoryTotalsWithSplits(spend, splitsByTxn);
  const byCategory = Object.entries(byCatSplit)
    .map(([name, amt]) => ({
      name,
      amount: roundMoney(amt),
      share: totalSpend ? amt / totalSpend : 0,
    }))
    .sort((a, b) => b.amount - a.amount);

  const byMonth = {};
  for (const r of spend) byMonth[r.month] = roundMoney((byMonth[r.month] || 0) + r.amount);

  const merch = {};
  for (const r of spend) {
    // Additive brand key for grouping; per-transaction display/totals unchanged.
    // The group keeps its first row's raw description so its display label comes
    // from the one shared merchantDisplayLabel, not a hand-copied formula.
    const key = merchantGroupKey(r.description, brandRules, merchantIntel) || 'UNKNOWN';
    if (!merch[key])
      merch[key] = {
        key,
        amount: 0,
        count: 0,
        category: r.category,
        descSrc: r.description,
        branches: new Set(),
        ids: [],
      };
    const br = merchantBranch(r.description);
    if (br) merch[key].branches.add(br);
    merch[key].amount += r.amount;
    merch[key].count += 1;
    merch[key].ids.push(r.id);
  }
  const merchants = Object.values(merch)
    .map((v) => ({
      merchant: merchantDisplayLabel(
        v.descSrc,
        brandRules,
        merchantIntel,
        keepUpperSet,
        smallWordsSet
      ),
      key: v.key,
      branches: [...v.branches].sort(),
      amount: roundMoney(v.amount),
      count: v.count,
      avg: roundMoney(v.amount / v.count),
      share: totalSpend ? v.amount / totalSpend : 0,
      category: v.category,
    }))
    .sort((a, b) => b.amount - a.amount);

  const leading = byCategory[0] || null;

  // Previous comparable period (same number of months, immediately before).
  let prevTotal = null;
  if (period.prevFrom && period.prevTo) {
    const prev = rows.filter(
      (r) => r.kind === 'spend' && inRange(r.month, period.prevFrom, period.prevTo)
    );
    prevTotal = roundMoney(prev.reduce((a, r) => a + r.amount, 0));
  }

  return {
    from: period.from,
    to: period.to,
    label: period.label,
    kind: period.kind,
    months: monthsInP,
    total_spend: totalSpend,
    total_payments: totalPayments,
    total_refunds: totalRefunds,
    total_fees: totalFees,
    n_purchases: spend.length,
    n_transactions: inP.length,
    by_category: byCategory,
    by_month: byMonth,
    merchants,
    leading,
    prev_total: prevTotal,
  };
}

/* Make a PREVIOUS window addressable as a full breakdown (Round 1, A0).
 * analysePeriod only ever runs for the current window; a previous window is
 * otherwise exposed only as the scalar prev_total. This wraps analysePeriod over
 * an explicit { from, to } with no previous-of-the-previous, and forwards opts
 * unchanged so keepUpperSet / smallWordsSet / merchantLabelFn are applied - the
 * merchant labels then come back tidied, so a later comparison never mismatches
 * "STARBUCKS" against "Starbucks". Adds no analysis logic. Pure. */
export function analysisForWindow(rows, from, to, opts = {}) {
  const period = {
    from,
    to,
    label: '',
    kind: 'range',
    prevFrom: null,
    prevTo: null,
  };
  return analysePeriod(rows, period, opts);
}

/* The largest gap, in months, between consecutive occurrence-months. A steady
 * monthly commitment has a maximum gap of 1; a charge seen twice in quick
 * succession and then not again for six months has a gap of 6. Used by
 * detectRecurring to reject an irregular repeat purchase that a bare "3+ months
 * at a similar amount" test would otherwise accept as recurring. Its own
 * month-key-to-index arithmetic now delegates to the shared monthIndex
 * (shared-helpers.js) - previously reimplemented here privately, byte-for-
 * byte identical to a second private copy inside read-statements.js's
 * standingDebitMonthGap. */
export function maxConsecutiveGap(monthKeys) {
  const idx = monthKeys
    .map(monthIndex)
    .filter((n) => !Number.isNaN(n))
    .sort((a, b) => a - b);
  let mx = 0;
  for (let i = 1; i < idx.length; i++) mx = Math.max(mx, idx[i] - idx[i - 1]);
  return mx;
}

/* Detect likely recurring charges: the same merchant appearing in 3+ distinct
 * months at a similar amount, AND with those months close together in time.
 * Returns [{ merchant, months, typical }].
 *
 * D-audit item 1 - day-of-month is deliberately NOT used as a filter. A genuine
 * monthly subscription often DOES charge near the same date, and Plaid's public
 * cadence model leans on that regularity; but on real statement data the printed
 * transaction/posting date drifts from the true billing date, and one merchant
 * group can bill several services on different anniversary days (Apple). Measured
 * on the real card export, the clearest true subscriptions have a WIDE
 * day-of-month spread - a wide day-of-month spread - so a day-of-month
 * regularity gate would produce false negatives on exactly the charges it should
 * keep. The month-count + maximum-gap cadence gate below is the well-grounded
 * signal that survives that noise; day-of-month is left out on purpose. (If ever
 * wanted, it belongs as a soft confidence score shown to the user, never as a
 * hard filter.) */
export function detectRecurring(
  rows,
  minMonths = 3,
  tolerance = 0.15,
  brandRules = [],
  merchants = null,
  maxGapMonths = 2
) {
  const byMerch = {};
  for (const r of rows.filter((r) => r.kind === 'spend')) {
    const key = merchantGroupKey(r.description, brandRules, merchants);
    (byMerch[key] = byMerch[key] || []).push(r);
  }
  // Ledger-recency anchor for the forward lapsed check below: the most recent
  // month ANY row (any kind, not just spend) in the WHOLE rows array reaches -
  // the same "how current is this ledger" concept detectIncompleteMonth/
  // latestCompleteMonth already anchor on, never real calendar "today". This
  // is computed once, over the entire ledger, not per-merchant, so it reflects
  // how current the ledger is as a whole, independent of any one merchant's
  // own last appearance.
  const latestMonth = (rows || []).reduce((mx, r) => (r.month > mx ? r.month : mx), '');
  const out = [];
  for (const [key, list] of Object.entries(byMerch)) {
    const byM = {};
    for (const r of list) byM[r.month] = (byM[r.month] || 0) + r.amount;
    const monthsSeen = Object.keys(byM);
    if (monthsSeen.length < minMonths) continue;
    // Cadence gate: a genuine monthly commitment recurs at a steady rhythm, so
    // reject any merchant whose longest gap between consecutive occurrence-months
    // exceeds maxGapMonths (default 2). This is what separates a standing charge
    // from an irregular large purchase that merely repeated a few times.
    if (maxConsecutiveGap(monthsSeen) > maxGapMonths) continue;
    const amounts = Object.values(byM);
    const typical = median(amounts);
    if (typical <= 0) continue;
    const consistent = amounts.filter((a) => Math.abs(a - typical) <= typical * tolerance).length;
    if (consistent >= minMonths) {
      // The forward half of the SAME cadence gate above, applied prospectively:
      // a commitment that recurred consistently in the past is only still
      // ACTIVE if its own last occurrence is within maxGapMonths of the
      // ledger's newest month; otherwise it has LAPSED. lastMonth is carried
      // on the returned item (previously only a bare count was returned) so a
      // caller can show exactly when it was last seen, never just "gone".
      const lastMonth = monthsSeen.slice().sort().pop();
      out.push({
        key,
        label: merchantDisplayLabel(list[0].description, brandRules, merchants),
        months: monthsSeen.length,
        typical: roundMoney(typical),
        lastMonth,
        status: recurringStatus(lastMonth, latestMonth, maxGapMonths),
        expectedDay: medianDayOfMonth(list.map((r) => r.date)),
        risen: detectSustainedRise(
          Object.entries(byM).map(([month, amount]) => ({ month, amount }))
        ),
      });
    }
  }
  return out.sort((a, b) => b.typical - a.typical);
}

/* One combined monthly-commitments figure, de-duplicated across the two ledgers
 * (Round 1, A3). Inputs are the outputs of detectRecurring(...) (card side) and
 * detectBankStandingDebits(...) (bank side). A commitment is de-duped on a
 * normalised label (trim + toUpperCase); when the same label appears on both
 * sides the card one is kept, marked source 'card', and its typical is counted
 * once, never twice. Returns { total, items:[{ label, typical, source }] } sorted
 * by typical desc, with total the sum of the kept typicals. Pure. */
export function monthlyCommitmentsTotal(cardRecurring, bankStandingDebits) {
  const byNorm = new Map();
  const norm = (s) =>
    String(s == null ? '' : s)
      .trim()
      .toUpperCase();
  for (const c of cardRecurring || []) {
    const k = norm(c.label);
    if (!byNorm.has(k))
      byNorm.set(k, {
        label: c.label,
        key: c.key || null,
        typical: roundMoney(c.typical),
        source: 'card',
        lastMonth: c.lastMonth || null,
        status: c.status || 'active',
        expectedDay: c.expectedDay || null,
        risen: c.risen || null,
      });
  }
  for (const b of bankStandingDebits || []) {
    const k = norm(b.label);
    if (byNorm.has(k)) continue;
    byNorm.set(k, {
      label: b.label,
      key: b.key || null,
      typical: roundMoney(b.typical),
      source: 'bank',
      lastMonth: b.lastMonth || null,
      status: b.status || 'active',
      expectedDay: b.expectedDay || null,
      risen: b.risen || null,
    });
  }
  const all = [...byNorm.values()].sort((a, b) => b.typical - a.typical);
  const items = all.filter((it) => it.status !== 'lapsed');
  const lapsed = all.filter((it) => it.status === 'lapsed');
  const total = roundMoney(items.reduce((a, it) => a + it.typical, 0));
  return { total, items, lapsed };
}

export function projectCashFlow(opts = {}) {
  const cashPosition = opts.cashPosition;
  if (cashPosition == null || !Number.isFinite(cashPosition)) return null;
  const commitments = (opts.commitments || []).filter((c) => c.expectedDay);
  const income = opts.income || null;
  const now = opts.now || new Date();
  const horizonDays = Math.max(7, Math.min(28, opts.horizonDays || 21));
  const todayIso = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

  const days = [];
  let balance = roundMoney(cashPosition);
  let lowPoint = { date: todayIso, balance };
  for (let i = 1; i <= horizonDays; i++) {
    const date = addDaysIso(todayIso, i);
    const day = isoDay(date);
    const events = [];
    for (const c of commitments) {
      if (c.expectedDay === day) {
        balance = roundMoney(balance - c.typical);
        events.push({
          type: 'commitment',
          label: c.label,
          amount: -c.typical,
          source: c.source || null,
          key: c.key || null,
        });
      }
    }
    if (income && income.nextExpectedDate === date) {
      balance = roundMoney(balance + income.typicalAmount);
      events.push({
        type: 'income',
        label: income.label,
        amount: income.typicalAmount,
        source: 'bank',
        key: income.key || null,
      });
    }
    days.push({ date, balance, events });
    if (balance < lowPoint.balance) lowPoint = { date, balance };
  }

  return {
    startBalance: roundMoney(cashPosition),
    todayIso,
    horizonDays,
    days,
    lowPoint,
    nextIncome:
      income && income.nextExpectedDate
        ? { date: income.nextExpectedDate, amount: income.typicalAmount }
        : null,
  };
}

export function nextStatementNudge(cardStatements, bankStatements, opts = {}, now = new Date()) {
  const toleranceDays = opts.toleranceDays == null ? 4 : opts.toleranceDays;
  const ends = [];
  for (const s of cardStatements || []) {
    const ms = coverageIsoMs(s.periodEnd);
    if (ms != null) ends.push(ms);
  }
  for (const s of bankStatements || []) {
    const span = coverageBankSpan(s.period);
    if (span) ends.push(span[1]);
  }
  if (ends.length < 2) return null;
  ends.sort((a, b) => a - b);
  const gaps = [];
  for (let i = 1; i < ends.length; i++) gaps.push((ends[i] - ends[i - 1]) / 86400000);
  const cadenceDays = Math.round(median(gaps));
  if (cadenceDays <= 0) return null;
  const latestEndMs = ends[ends.length - 1];
  const daysSinceLast = Math.round((now.getTime() - latestEndMs) / 86400000);
  let status = 'ontrack';
  if (daysSinceLast >= cadenceDays + toleranceDays) status = 'overdue';
  else if (daysSinceLast >= cadenceDays - toleranceDays) status = 'due';
  return {
    status,
    cadenceDays,
    daysSinceLast,
    latestEndDate: new Date(latestEndMs).toISOString().slice(0, 10),
  };
}

// A robust "typical month's Cash outflow" from the roll-up trend (each row's
// .spending is bank external outflow plus card purchases, transfers and card
// payments already removed). Uses the median of recent complete months so one
// unusually large or quiet month never skews it. currentYm, when supplied,
// drops an in-progress current month, which is naturally partial and would
// understate the norm. Returns 0 when there is nothing to measure. Pure.
export function typicalMonthlyOutflow(trend, currentYm = null) {
  const rows = (trend || []).filter((t) => t && t.month && Number(t.spending) >= 0);
  const complete = currentYm ? rows.filter((t) => t.month !== currentYm) : rows;
  const use = (complete.length ? complete : rows)
    .slice(-6)
    .map((t) => Number(t.spending) || 0)
    .filter((v) => v > 0);
  if (!use.length) return 0;
  const s = use.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// How many days the cash on hand would last at a typical recent monthly
// outflow - the "runway" a person feels as "if income stopped, how long could
// I actually last". cashPosition is the current base-currency cash balance;
// monthlyOutflow is typicalMonthlyOutflow above. Returns whole days, or null
// when either input is missing or non-positive, so a caller with no honest
// number to show (e.g. a card-only device with no cash balance) can fall back
// rather than invent one. Pure.
export function runwayDays(cashPosition, monthlyOutflow) {
  if (cashPosition == null || !(cashPosition > 0) || !(monthlyOutflow > 0)) return null;
  const dailyBurn = monthlyOutflow / (365.25 / 12); // ~30.44 days per month
  return Math.max(0, Math.round(cashPosition / dailyBurn));
}
/* Name the single category or merchant most responsible for an increase, or null
 * when the rise is spread (Round 1, A4). current and previous are full analysis
 * objects (each with by_category and merchants); previous MUST come from
 * analysisForWindow (the real previous breakdown), never from the scalar
 * prev_total. For every category (matched by name) and every merchant (matched by
 * key) the delta is current amount minus previous amount, a side missing on
 * either counting as 0. The largest positive delta across both sets is the
 * candidate, and it is returned only when it accounts for at least driverShare of
 * the sum of all positive deltas (config insights.driverShare, default 0.5 so an
 * older config still works); otherwise null. Pure. */
export function insightDriver(current, previous, cfg = {}) {
  const share = cfg.insights && cfg.insights.driverShare != null ? cfg.insights.driverShare : 0.5;
  const index = (arr, keyFn) => {
    const m = new Map();
    for (const it of arr || []) m.set(keyFn(it), it);
    return m;
  };
  const deltas = [];
  const curCat = index(current && current.by_category, (c) => c.name);
  const prevCat = index(previous && previous.by_category, (c) => c.name);
  for (const name of new Set([...curCat.keys(), ...prevCat.keys()])) {
    const cur = curCat.has(name) ? curCat.get(name).amount : 0;
    const prev = prevCat.has(name) ? prevCat.get(name).amount : 0;
    deltas.push({ label: name, kind: 'category', delta: cur - prev });
  }
  const curMer = index(current && current.merchants, (m) => m.key);
  const prevMer = index(previous && previous.merchants, (m) => m.key);
  for (const key of new Set([...curMer.keys(), ...prevMer.keys()])) {
    const cur = curMer.has(key) ? curMer.get(key).amount : 0;
    const prev = prevMer.has(key) ? prevMer.get(key).amount : 0;
    const label = curMer.has(key) ? curMer.get(key).merchant : prevMer.get(key).merchant;
    deltas.push({ label, kind: 'merchant', delta: cur - prev });
  }
  const positiveSum = deltas.reduce((a, d) => a + (d.delta > 0 ? d.delta : 0), 0);
  if (positiveSum <= 0) return null;
  let top = null;
  for (const d of deltas) if (d.delta > 0 && (!top || d.delta > top.delta)) top = d;
  if (!top) return null;
  return top.delta >= share * positiveSum ? { label: top.label, kind: top.kind } : null;
}

/* Detect a consistent pay-in-full cardholder (Round 1, A5). A copy of the
 * statements is sorted by statementKey exactly the way renderCardStatementHealth
 * sorts them (String(a.statementKey).localeCompare(String(b.statementKey))), the
 * most recent 3 are taken, and the result is true only when every one of them is
 * payingInFull === true. With fewer than 3 present the decision is made on those
 * present; any revolving statement in that window makes it false. Pure. */
export function payingInFullPattern(cardStatements) {
  const sorted = (cardStatements || [])
    .slice()
    .sort((a, b) => String(a.statementKey).localeCompare(String(b.statementKey)));
  const window = sorted.slice(-3);
  if (!window.length) return false;
  if (window.some((s) => s.revolving === true)) return false;
  return window.every((s) => s.payingInFull === true);
}

// The observed card-BEHAVIOUR state, decided from evidence the statements
// actually carry - never an assumption about intent. The credit-card
// literature defines the split by INTEREST, not by balance: a transactor pays
// in full and incurs no interest; a revolver carries a balance and pays
// interest (Crook & Osipenko; Beales & Plache), and a single cycle must not
// characterise behaviour, so this reads a recent window. Keys on
// `interestCharges`, NOT the stored payingInFull/revolving booleans (which are
// balance-derived and mislabelled a $0-interest large-balance pay-in-full user
// as a revolver). Returns 'pays-in-full' | 'paying-interest' | 'insufficient'.
export function cardBehaviourState(cardStatements, opts = {}) {
  const interestFloor = opts.interestFloor == null ? 1 : opts.interestFloor;
  const minCycles = opts.minCycles == null ? 2 : opts.minCycles;
  const sorted = (cardStatements || [])
    .slice()
    .sort((a, b) => String(a.statementKey).localeCompare(String(b.statementKey)));
  if (!sorted.length) return 'insufficient';
  const window = sorted.slice(-3);
  const withInterest = window.filter(
    (s) => s.interestCharges != null && Number.isFinite(Number(s.interestCharges))
  );
  if (withInterest.length < minCycles) return 'insufficient';
  const carryingInterest = withInterest.some((s) => Number(s.interestCharges) > interestFloor);
  return carryingInterest ? 'paying-interest' : 'pays-in-full';
}

// Forward payoff estimate, amortised month by month so the interest figure is
// TRUE (depends on the rate and the declining balance) rather than the old
// `payment*months - balance`, which over-counted total paid as "interest" and
// referenced no rate at all. `eairFrac` is the effective annual rate as a
// fraction; the monthly rate is the one that compounds to it. Returns
// { neverClears:true } when the payment cannot cover a month's interest, or
// null when there is no balance / rate / payment to work with.
export function projectCardPayoff(balance, eairFrac, payment) {
  if (!(balance > 0) || eairFrac == null || !(payment > 0)) return null;
  const r = Math.pow(1 + eairFrac, 1 / 12) - 1;
  if (payment <= balance * r) return { neverClears: true };
  let bal = balance;
  let totalInterest = 0;
  let months = 0;
  while (bal > 0.005 && months < 600) {
    // 600 = 50-year safety cap
    const interest = bal * r;
    totalInterest += interest;
    bal = bal + interest - payment;
    if (bal < 0) bal = 0;
    months++;
  }
  return {
    months,
    totalInterest: roundMoney(totalInterest),
    neverClears: false,
  };
}

// The month-by-month balance path projectCardPayoff summarises, exposed so the
// "How your card is doing" card can DRAW the trajectory (the payoff chart), not
// just state the endpoint. Identical amortisation to projectCardPayoff (a
// monthly-compounded EAIR, payment applied after interest), so the picture and
// the sentence can never disagree. Returns series[0]=today's balance through
// each month, whether it clears, and the month it reaches zero (null when it
// never does, so the chart never draws a zero the pace cannot reach). Additive:
// projectCardPayoff itself is unchanged.
export function cardPayoffSeries(balance, eairFrac, payment, maxMonths = 120) {
  if (!(balance > 0) || eairFrac == null || !(payment > 0)) return null;
  const r = Math.pow(1 + eairFrac, 1 / 12) - 1;
  const neverClears = payment <= balance * r;
  const series = [roundMoney(balance)];
  let bal = balance,
    months = 0,
    clearedMonth = null;
  while (months < maxMonths) {
    const interest = bal * r;
    bal = bal + interest - payment;
    if (bal < 0) bal = 0;
    months++;
    series.push(roundMoney(bal));
    if (bal <= 0.005) {
      clearedMonth = months;
      break;
    }
  }
  return { series, neverClears, clearedMonth };
}

export function totalCardInterest(cardStatements) {
  return roundMoney(
    (cardStatements || []).reduce((s, st) => s + (Number(st.interestCharges) || 0), 0)
  );
}

// Round 4: lifted out of cards-render.js's private normEair/medianPayment so
// the goal-tracking logic below (the "clear the card by" goal type) can share
// the EXACT same reading of a card's rate and recent payment behaviour that
// "How your card is doing" already uses, rather than a second, possibly
// drifting copy. cards-render.js now imports both from here.
//
// Normalise a stored EAIR to a fraction. Some card records carry a percent
// (42.0), others a fraction (0.42); anything > 1 is read as a percent.
// Returns null when absent or non-positive, so a caller degrades to a calm
// status with no projection rather than inventing a rate.
export function normaliseEair(eair) {
  const n = Number(eair);
  if (!Number.isFinite(n) || n <= 0) return null;
  return n > 1 ? n / 100 : n;
}

// The median posted payment over the most recent (up to 6) statements that
// carry one - roughly what the person has actually been paying, robust to a
// single unusually large or small month. 0 when none is recorded.
export function medianRecentPayment(cardStatements) {
  const pays = (cardStatements || [])
    .slice(-6)
    .map((s) => Math.abs(Number(s.payments) || 0))
    .filter((v) => v > 0);
  if (!pays.length) return 0;
  return median(pays);
}

/* ===========================================================================
 * Round 4: goal-setting ("Where you're headed") - a person's single stated
 * target, kept to a short, fixed set of choices the app can honestly measure
 * (the plan's own restriction: never open-ended text). GOAL_TYPES is the ONE
 * declared source of that set - both the goal-picker UI (ahead-render.js) and
 * every describeGoal/computeGoalProgress call below read from it, so a new
 * type (should one ever be added) is declared in exactly one place.
 * ======================================================================== */
export const GOAL_TYPES = [
  {
    id: 'runway',
    label: 'Keep a cushion of at least this many days',
    unit: 'days',
    paramKey: 'targetDays',
  },
  {
    id: 'clear-card',
    label: 'Clear the card by a date',
    unit: 'date',
    paramKey: 'targetDate',
  },
  {
    id: 'spend-ceiling',
    label: 'Keep monthly spending under an amount',
    unit: 'amount',
    paramKey: 'ceiling',
  },
];

// The plain-language description of a goal's TARGET (never its progress) -
// the sentence a person set, restated so Overview and Ahead can never phrase
// the same goal two different ways. bankMoney/formatDisplayDate are passed in
// since this file has no DOM/currency formatting of its own. Pure.
export function describeGoal(goal, bankMoney, formatDisplayDate) {
  if (!goal) return null;
  // Accepts BOTH the old shape (type: 'runway', params.targetDays/.targetDate)
  // and the migrated shape (type: 'cushion', flat targetDays/targetDate) - see
  // goal-migrate.js. Step 3 will retire the old branches once the new engine
  // is verified end to end.
  if (goal.type === 'runway' || goal.type === 'cushion') {
    const days = goal.targetDays != null ? goal.targetDays : goal.params && goal.params.targetDays;
    return `Keep a cushion of at least ${days} days`;
  }
  if (goal.type === 'clear-card') {
    const targetDate =
      goal.targetDate != null ? goal.targetDate : goal.params && goal.params.targetDate;
    return `Clear the card by ${formatDisplayDate(targetDate)}`;
  }
  if (goal.type === 'spend-ceiling')
    return `Keep monthly spending under ${bankMoney(goal.amount != null ? goal.amount : goal.params && goal.params.ceiling)}`;
  return null;
}

/* The one place a goal's progress is judged, for EITHER a live "right now"
 * reading or a specific past month's honest follow-up - the caller decides
 * which by what it puts in `data`; this function does not know or care which.
 * Returns { met: true|false|null, headline }, where met is null only for a
 * still-in-progress goal with no clean verdict yet (currently only
 * 'clear-card' before its target date and before the card is cleared) -
 * never for 'runway' or 'spend-ceiling', which always have a clean monthly
 * reading. headline is the one sentence stating that reading in plain
 * language. bankMoney/formatDisplayDate are passed in for the same reason as
 * describeGoal. Pure. */
export function computeGoalProgress(goal, data, bankMoney, formatDisplayDate) {
  if (!goal) return null;
  if (goal.type === 'runway' || goal.type === 'cushion') {
    const targetDays =
      goal.targetDays != null ? goal.targetDays : goal.params && goal.params.targetDays;
    const days = data.runwayDays;
    if (days == null)
      return {
        met: null,
        headline: 'There is not yet enough of a cash position to judge this against.',
      };
    const met = days >= targetDays;
    return {
      met,
      headline: met
        ? `Keeping about ${days} days of cushion, at or above your ${targetDays}-day target.`
        : `Currently keeping about ${days} days of cushion, below your ${targetDays}-day target.`,
    };
  }
  if (goal.type === 'clear-card') {
    const targetDate =
      goal.targetDate != null ? goal.targetDate : goal.params && goal.params.targetDate;
    const owed = data.cardOwed;
    if (owed == null || owed <= 1) return { met: true, headline: 'The card is clear.' };
    const targetMs = Date.parse(targetDate);
    const nowMs = data.now ? data.now.getTime() : Date.now();
    if (Number.isFinite(targetMs) && nowMs > targetMs) {
      return {
        met: false,
        headline: `The card was not cleared by ${formatDisplayDate(targetDate)}; ${bankMoney(owed)} is still owed.`,
      };
    }
    const monthsRemaining = Number.isFinite(targetMs)
      ? Math.max(0.1, (targetMs - nowMs) / (86400000 * 30.44))
      : null;
    const projection =
      data.eairFrac != null && data.typicalPayment > 0
        ? projectCardPayoff(owed, data.eairFrac, data.typicalPayment)
        : null;
    if (monthsRemaining != null && projection && !projection.neverClears) {
      const onTrack = projection.months <= monthsRemaining;
      return {
        met: null,
        headline: onTrack
          ? `On track to clear ${bankMoney(owed)} by ${formatDisplayDate(targetDate)}, at your recent pace.`
          : `At your recent pace, ${bankMoney(owed)} would clear after ${formatDisplayDate(targetDate)}, not by it.`,
      };
    }
    return {
      met: null,
      headline: `${bankMoney(owed)} is still owed, aiming to clear it by ${formatDisplayDate(targetDate)}.`,
    };
  }
  if (goal.type === 'spend-ceiling') {
    const spend = data.monthSpend;
    if (spend == null)
      return {
        met: null,
        headline: 'There is not yet a complete month to judge this against.',
      };
    const ceiling = goal.amount != null ? goal.amount : goal.params && goal.params.ceiling;
    const met = spend <= ceiling;
    const monthText = data.monthLabel ? ` in ${data.monthLabel}` : '';
    return {
      met,
      headline: met
        ? `Spending${monthText} was ${bankMoney(spend)}, under your ${bankMoney(ceiling)} ceiling.`
        : `Spending${monthText} was ${bankMoney(spend)}, over your ${bankMoney(ceiling)} ceiling.`,
    };
  }
  return null;
}

/* Summarise foreign-currency spending. Sums ONLY the JMD amount (r.amount) over
 * spend rows that carry a foreign leg; the foreign values themselves are mixed
 * currencies and must never be summed. Groups by the trailing currency code
 * parsed from r.foreign (e.g. "6.49 USD" -> "USD"). Pure. */
export function foreignSummary(rows) {
  const items = (rows || []).filter((r) => r && r.kind === 'spend' && r.foreign);
  let totalJmd = 0;
  const counts = {};
  for (const r of items) {
    totalJmd += Number(r.amount) || 0;
    const m = /([A-Za-z]{3})\s*$/.exec(String(r.foreign).trim());
    const ccy = m ? m[1].toUpperCase() : 'FX';
    counts[ccy] = (counts[ccy] || 0) + 1;
  }
  const byCurrency = Object.entries(counts)
    .map(([ccy, count]) => ({ ccy, count }))
    .sort((a, b) => b.count - a.count || a.ccy.localeCompare(b.ccy));
  return {
    count: items.length,
    totalJmd: roundMoney(totalJmd),
    byCurrency,
    items,
  };
}

export function effectiveForeignRate(row) {
  const m = /([\d,]+\.\d{2})\s*([A-Za-z]{3})\s*$/.exec(String((row && row.foreign) || '').trim());
  if (!m) return null;
  const foreignAmount = parseFloat(m[1].replace(/,/g, ''));
  if (!(foreignAmount > 0)) return null;
  const localAmount = Number(row && row.amount) || 0;
  return {
    rate: localAmount / foreignAmount,
    ccy: m[2].toUpperCase(),
    foreignAmount,
  };
}

export function averageForeignRates(rows) {
  const byCcy = new Map();
  for (const r of rows || []) {
    const eff = effectiveForeignRate(r);
    if (!eff) continue;
    if (!byCcy.has(eff.ccy)) byCcy.set(eff.ccy, { ccy: eff.ccy, localSum: 0, foreignSum: 0 });
    const g = byCcy.get(eff.ccy);
    g.localSum += Number(r.amount) || 0;
    g.foreignSum += eff.foreignAmount;
  }
  return [...byCcy.values()]
    .filter((g) => g.foreignSum > 0)
    .map((g) => ({ ccy: g.ccy, rate: g.localSum / g.foreignSum }))
    .sort((a, b) => a.ccy.localeCompare(b.ccy));
}

export function pairCardRefunds(rows, brandRules = [], merchants = null, opts = {}) {
  const windowDays = opts.windowDays == null ? 120 : opts.windowDays;
  const dayMs = 86400000;
  const toT = (iso) => {
    const p = String(iso || '')
      .split('-')
      .map(Number);
    return Date.UTC(p[0], (p[1] || 1) - 1, p[2] || 1);
  };
  const byGroup = new Map();
  for (const r of rows) {
    if (r.kind !== 'spend') continue;
    const key = merchantGroupKey(r.description, brandRules, merchants);
    if (!byGroup.has(key)) byGroup.set(key, []);
    byGroup.get(key).push(r);
  }
  const refunds = (rows || [])
    .filter((r) => r.kind === 'refund')
    .sort((a, b) => (a.date < b.date ? -1 : 1));
  const claimed = new Set();
  const pairs = [];
  for (const ref of refunds) {
    const key = merchantGroupKey(ref.description, brandRules, merchants);
    const candidates = (byGroup.get(key) || []).filter((p) => {
      if (claimed.has(p.id)) return false;
      if (Math.abs(Math.abs(p.amount) - Math.abs(ref.amount)) > 0.01) return false;
      const gap = toT(ref.date) - toT(p.date);
      return gap >= 0 && gap <= windowDays * dayMs;
    });
    if (candidates.length === 1) {
      claimed.add(candidates[0].id);
      pairs.push({
        refundId: ref.id,
        purchaseId: candidates[0].id,
        amount: roundMoney(Math.abs(ref.amount)),
      });
    }
  }
  return { pairs, pairedPurchaseIds: claimed };
}

export function mergedMoneyMovedRanking(
  rows,
  cardMerchants,
  bankOutflows,
  bankInflows,
  refundPairs = [],
  brandRules = [],
  merchants = null
) {
  const byId = new Map((rows || []).map((r) => [r.id, r]));
  const refundByKey = new Map();
  for (const p of refundPairs) {
    const purchase = byId.get(p.purchaseId);
    if (!purchase) continue;
    const key = merchantGroupKey(purchase.description, brandRules, merchants);
    refundByKey.set(key, (refundByKey.get(key) || 0) + p.amount);
  }
  const out = (cardMerchants || []).map((m) => ({
    label: m.merchant,
    key: m.key,
    amount: roundMoney(Math.max(0, m.amount - (refundByKey.get(m.key) || 0))),
    count: m.count,
    source: 'card',
    direction: 'out',
  }));
  for (const g of bankOutflows || [])
    out.push({
      label: g.label,
      key: g.key,
      amount: roundMoney(g.moneyOut),
      count: g.count,
      source: 'bank',
      direction: 'out',
    });
  for (const g of bankInflows || [])
    out.push({
      label: g.label,
      key: g.key,
      amount: roundMoney(g.moneyIn),
      count: g.count,
      source: 'bank',
      direction: 'in',
    });
  return out.filter((g) => g.amount > 0).sort((a, b) => b.amount - a.amount);
}

export function detectPossibleDuplicates(rows, brandRules = [], merchants = null, opts = {}) {
  const windowDays = opts.windowDays == null ? 3 : opts.windowDays;
  const dayMs = 86400000;
  const toT = (iso) => {
    const p = String(iso || '')
      .split('-')
      .map(Number);
    return Date.UTC(p[0], (p[1] || 1) - 1, p[2] || 1);
  };
  const byGroup = new Map();
  for (const r of rows) {
    if (r.kind !== 'spend') continue;
    const key = merchantGroupKey(r.description, brandRules, merchants);
    if (!byGroup.has(key)) byGroup.set(key, []);
    byGroup.get(key).push(r);
  }
  const out = [];
  const flagged = new Set();
  for (const list of byGroup.values()) {
    const sorted = list.slice().sort((a, b) => (a.date < b.date ? -1 : 1));
    for (let i = 0; i < sorted.length; i++) {
      for (let j = i + 1; j < sorted.length; j++) {
        const a = sorted[i],
          b = sorted[j];
        const gap = toT(b.date) - toT(a.date);
        if (gap > windowDays * dayMs) break;
        if (Math.abs(a.amount - b.amount) > 0.01) continue;
        if (flagged.has(a.id) || flagged.has(b.id)) continue;
        flagged.add(a.id);
        flagged.add(b.id);
        out.push({
          ids: [a.id, b.id],
          label: merchantDisplayLabel(a.description, brandRules, merchants),
          amount: roundMoney(a.amount),
          dates: [a.date, b.date],
        });
      }
    }
  }
  return out;
}

export function detectCategorySpikes(rows, period, cfg = {}, splits = []) {
  const t = Object.assign(
    { categorySpikeZ: 3.5, categorySpikeMin: 10000, categorySpikeMinMonths: 3 },
    cfg.insights || {}
  );
  if (!period) return [];
  const spend = (rows || []).filter((r) => r.kind === 'spend');
  // Split-aware: a category spike must be judged on the SAME category
  // attribution every other reader (summarise/analysePeriod/spendBreakdown)
  // uses, or a split transaction could trigger (or silently miss) a spike
  // based on stale, whole-transaction attribution. Mirrors spend-breakdown.js's
  // own contributionsFor exactly - see that file's comment for the reasoning.
  const splitMap = splitsByTxnId(splits);
  const contributionsFor = (r) => {
    const split = splitMap.get(r.id);
    if (split && validateSplit(split, r.amount).ok) {
      return split.parts.map((p) => ({
        category: p.category,
        amount: Math.abs(Number(p.amount) || 0),
      }));
    }
    return [{ category: r.category, amount: Math.abs(Number(r.amount) || 0) }];
  };
  const byMonthCat = new Map();
  for (const r of spend) {
    if (!byMonthCat.has(r.month)) byMonthCat.set(r.month, new Map());
    const m = byMonthCat.get(r.month);
    for (const part of contributionsFor(r)) {
      m.set(part.category, (m.get(part.category) || 0) + part.amount);
    }
  }
  const currentMonths = new Set(
    [...byMonthCat.keys()].filter((m) => m >= period.from && m <= period.to)
  );
  const currentTotals = new Map();
  for (const m of currentMonths) {
    for (const [cat, amt] of byMonthCat.get(m))
      currentTotals.set(cat, (currentTotals.get(cat) || 0) + amt);
  }
  const out = [];
  for (const [cat, curAmt] of currentTotals) {
    if (curAmt < t.categorySpikeMin) continue;
    const history = [];
    for (const [m, catMap] of byMonthCat) {
      if (currentMonths.has(m)) continue;
      if (catMap.has(cat)) history.push(catMap.get(cat));
    }
    if (history.length < t.categorySpikeMinMonths) continue;
    const centre = median(history);
    const mad = median(history.map((v) => Math.abs(v - centre)));
    const z =
      mad > 0
        ? (0.6745 * (curAmt - centre)) / mad
        : centre > 0 && curAmt >= centre * 2.5
          ? t.categorySpikeZ
          : 0;
    if (z >= t.categorySpikeZ && curAmt > centre)
      out.push({
        category: cat,
        amount: roundMoney(curAmt),
        typical: roundMoney(centre),
        z,
      });
  }
  return out.sort((a, b) => b.z - a.z);
}

export function detectMidMonthPace(rows, cfg = {}, now = new Date()) {
  const t = Object.assign(
    { paceMinMonths: 3, paceThreshold: 1.5, paceMin: 5000 },
    cfg.insights || {}
  );
  const months = [
    ...new Set(
      (rows || []).filter((r) => r.kind === 'spend' && r.month !== 'unknown').map((r) => r.month)
    ),
  ].sort();
  if (!months.length) return [];
  const latest = months[months.length - 1];
  if (latest !== ymToday(now)) return [];
  const [y, mo] = latest.split('-').map(Number);
  const daysInMonth = new Date(y, mo, 0).getDate();
  const dayOfMonth = now.getDate();
  if (dayOfMonth >= daysInMonth - 1) return [];
  const elapsedFraction = dayOfMonth / daysInMonth;
  const spend = rows.filter((r) => r.kind === 'spend');
  const byMonthCat = new Map();
  for (const r of spend) {
    if (!byMonthCat.has(r.month)) byMonthCat.set(r.month, new Map());
    const m = byMonthCat.get(r.month);
    m.set(r.category, (m.get(r.category) || 0) + r.amount);
  }
  const currentCat = byMonthCat.get(latest) || new Map();
  const out = [];
  for (const [cat, soFar] of currentCat) {
    if (soFar < t.paceMin) continue;
    const history = [];
    for (const [m, catMap] of byMonthCat) {
      if (m === latest) continue;
      if (catMap.has(cat)) history.push(catMap.get(cat));
    }
    if (history.length < t.paceMinMonths) continue;
    const typical = median(history);
    if (typical <= 0) continue;
    const projected = soFar / elapsedFraction;
    if (projected >= typical * t.paceThreshold)
      out.push({
        category: cat,
        projected: roundMoney(projected),
        typical: roundMoney(typical),
        dayOfMonth,
        daysInMonth,
      });
  }
  return out.sort((a, b) => b.projected / b.typical - a.projected / a.typical);
}

export function ordinalSuffix(n) {
  const v = n % 100;
  if (v >= 11 && v <= 13) return 'th';
  switch (n % 10) {
    case 1:
      return 'st';
    case 2:
      return 'nd';
    case 3:
      return 'rd';
    default:
      return 'th';
  }
}

export function buildIncomeHero(income, bankMoney) {
  if (!income) return null;
  const lastText = income.lastAmount != null ? bankMoney(income.lastAmount) : null;
  const typicalText = income.typicalAmount != null ? bankMoney(income.typicalAmount) : null;
  if (!lastText) return null;
  let deltaTone = 'neutral';
  let deltaText = null;
  if (typicalText && income.stepChange === 'up') {
    deltaTone = 'good';
    deltaText = `above usual ${typicalText}`;
  } else if (typicalText && income.stepChange === 'down') {
    deltaTone = 'watch';
    deltaText = `below usual ${typicalText}`;
  }
  return {
    amountText: lastText,
    label: income.label || null,
    deltaText,
    deltaTone,
  };
}

export function buildIncomeCaption(income) {
  if (!income) return null;
  const parts = [];
  if (income.regularity === 'Steady' && income.expectedDay) {
    parts.push(`Usually around the ${income.expectedDay}${ordinalSuffix(income.expectedDay)}.`);
  } else if (income.regularity !== 'Steady') {
    parts.push('Arrives on no fixed day, so the timing is a rough guide.');
  }
  if (income.late) {
    parts.push(
      `Next deposit due - the most recent was ${formatDisplayDate(income.lastDate)}. Add the latest statement to update.`
    );
  }
  return parts.length ? parts.join(' ') : null;
}

/* ===========================================================================
 * Round 4: the hands-on scenario tool (plan section 6.2, second bullet) - the
 * first tool in the app that lets a person rehearse a decision before making
 * it. Toggling a category or place off tests "what if I stopped spending
 * here"; a hypothetical extra cost tests "what if this came up". Both
 * recompute the SAME runway figure (runwayDays, already used by Overview's
 * beat 4 and Right Now's own cash-position framing), so the scenario result
 * and the real figure elsewhere in the app are never two different ideas of
 * "how long the cushion lasts".
 *
 * toggleableItems is [{ key, label, amount }] - the amounts this period
 * contributed to typical monthly outflow, already computed and shown
 * elsewhere (Right Now's category panel and "where money went" ranking); a
 * checked-off item's amount is subtracted from monthlyOutflow before the
 * scenario's runway is computed. extraCost is a one-off amount subtracted
 * from cashPosition only (a future cost, not a recurring one). Returns
 * { baselineRunwayDays, scenarioRunwayDays, scenarioOutflow, scenarioCash }.
 * Pure. */
export function computeScenario(opts = {}) {
  const cashPosition = opts.cashPosition;
  const monthlyOutflow = opts.monthlyOutflow;
  // reductions: a Map (or plain object) of item.key -> reduction FRACTION in
  // [0,1], where 0 = keep in full, 0.5 = cut half, 1 = cut entirely. This
  // generalises the previous binary excludedKeys Set (which only expressed
  // "removed entirely" = fraction 1) to partial reductions, so the scenario
  // tool can model "spend LESS here", the realistic decision, not only
  // "spend nothing here". Back-compat: an excludedKeys Set is still accepted
  // and treated as fraction 1 for each key, so any existing caller keeps
  // working unchanged.
  const reductions =
    opts.reductions instanceof Map
      ? opts.reductions
      : new Map(Object.entries(opts.reductions || {}));
  const legacyExcluded =
    opts.excludedKeys instanceof Set ? opts.excludedKeys : new Set(opts.excludedKeys || []);
  const extraCost = Number(opts.extraCost) || 0;
  const toggleableItems = opts.toggleableItems || [];

  const fractionFor = (key) => {
    if (reductions.has(key)) {
      const f = Number(reductions.get(key));
      return Number.isFinite(f) ? Math.max(0, Math.min(1, f)) : 0;
    }
    return legacyExcluded.has(key) ? 1 : 0;
  };

  const removedAmount = toggleableItems.reduce(
    (s, it) => s + (Number(it.amount) || 0) * fractionFor(it.key),
    0
  );
  const scenarioOutflow = Math.max(0, (Number(monthlyOutflow) || 0) - removedAmount);
  const scenarioCash = cashPosition == null ? null : roundMoney(cashPosition - extraCost);

  return {
    baselineRunwayDays: runwayDays(cashPosition, monthlyOutflow),
    scenarioRunwayDays: runwayDays(scenarioCash, scenarioOutflow),
    scenarioOutflow: roundMoney(scenarioOutflow),
    scenarioCash,
    monthlySaved: roundMoney(removedAmount),
  };
}

// The ONE priority scale both insight engines rank against (buildInsights on
// the card side, buildBankAppropriateInsights on the bank side). Higher = more
// important. Previously each engine showed the first `maxInsights` it authored
// in code order, so a genuinely important flag (a large unusual charge, a
// missing statement month) could be silently dropped below the cap by an
// earlier but milder insight. Ranking against one shared scale means the three
// shown are the three that matter, and "importance" means the same thing on
// every tab. Tuned in ONE place; a kind absent here sinks below all named ones.
export const INSIGHT_WEIGHTS = {
  // Needs a look now - possible error or genuine anomaly.
  'large-charge': 90,
  'large-payment': 90,
  // Completeness of the whole picture.
  'missing-months': 70,
  // Meaningful change, with a named cause.
  'overall-change': 60,
  'money-in-change': 60,
  'category-move': 55,
  // Direction / what it cost.
  verdict: 50,
  fees: 50,
  'new-merchant': 45,
  'new-payee': 45,
  refunds: 40,
  // Steady context.
  recurring: 30,
  foreign: 30,
  'high-month': 25,
};

// Rank a candidate insight list by INSIGHT_WEIGHTS and cap it. Stable within a
// tier via an explicit index tiebreak, so equal-weight insights keep their
// authored order (which is a sensible secondary priority). An untagged insight
// (missing/unknown kind) gets a low default so it sinks rather than jumps the
// queue. Pure; used by both engines so the cap and the ordering are identical.
export function rankInsights(insights, cap = 3) {
  const weightOf = (i) => (i && INSIGHT_WEIGHTS[i.kind] != null ? INSIGHT_WEIGHTS[i.kind] : 20);
  return insights
    .map((ins, idx) => ({ ins, idx, weight: weightOf(ins) }))
    .sort((a, b) => b.weight - a.weight || a.idx - b.idx)
    .slice(0, cap > 0 ? cap : insights.length)
    .map((x) => x.ins);
}

/* Any gaps in the monthly sequence (missing statement periods). */
export function missingMonths(months) {
  if (months.length < 2) return [];
  const gaps = [];
  let cur = months[0];
  const set = new Set(months);
  while (cur < months[months.length - 1]) {
    cur = addMonthsYM(cur, 1);
    if (!set.has(cur) && cur < months[months.length - 1]) gaps.push(cur);
  }
  return gaps;
}

// The ONE shared "What's new or unusual" bank-insight builder. Previously
// this exact logic - the money-in-vs-previous-period comparison, the large/
// unusual-payment check, the new-payee check, the missing-statement-months
// check, all reading the SAME config thresholds - existed as two separate,
// independently hand-written copies: buildOverviewInsights (app.js, Overview
// tab) and buildBankInsights (accounts-render.js, Accounts tab). They had
// already begun to drift (compare the two large-payment sentences: "A ... is
// much larger than a typical outflow - worth a look?" vs "Payment to ... is
// larger than usual. Worth a look?" - the second carried a stray double
// space, a small but real sign of independent maintenance). Consolidating
// removes that drift risk entirely: both tabs now read one authoritative
// implementation, and a future threshold or wording change only ever
// happens once.
//
// What stays per-caller, deliberately NOT absorbed here, because it is
// genuinely different between the two tabs, not duplicated:
//   - currentIncome/prevIncome: Overview compares analyseRollup's
//     cross-ledger income; Accounts compares analyseBankActivity's bank-only
//     cashIn. Both arrive here as already-resolved NUMBERS, so this function
//     never needs to know which analysis produced them.
//   - verdict: already computed by the caller via overviewVerdict(), each
//     from its own appropriately-shaped trend (Overview's whole cross-ledger
//     roll-up trend; Accounts' own bankFlowOverTime trend) - reused here
//     exactly as buildOverviewInsights already reused it, never recomputed.
//   - onNavigate: where a click should take the person (switch to Accounts
//     from Overview; scroll to the transaction list already on screen from
//     Accounts itself).
export function buildBankAppropriateInsights(opts) {
  const {
    recsAll,
    period,
    cfg,
    currentIncome,
    prevIncome,
    verdict,
    coverage,
    bankMoney,
    prevLabel,
    monthLabel,
    bankMonthsList,
    onNavigate,
    onDrillToPayee,
    icons,
  } = opts;
  const insightsCfg = cfg.insights || {};
  const drillTo = (key, label) => (onDrillToPayee ? () => onDrillToPayee(key, label) : onNavigate);
  const out = [];

  // 1) Cash inflow vs the previous comparable period.
  // Fairness gate: never compare a not-yet-complete window against a full one -
  // that is what produced "`` (delete - empty replacement) near-zero income vs a full prior month" when
  // the current month was only part-imported. A provably partial period
  // suppresses the comparison entirely (an unknown one is allowed through, so
  // ledgers whose statement dates cannot yet be parsed keep today's behaviour).
  if (
    prevIncome != null &&
    prevIncome > 0 &&
    currentIncome != null &&
    isPeriodFullyCovered(coverage, period)
  ) {
    const diff = currentIncome - prevIncome;
    const dp = Math.round((diff / prevIncome) * 100);
    if (
      Math.abs(dp) >= (insightsCfg.meaningfulChangePct || 25) &&
      Math.abs(diff) >= (insightsCfg.meaningfulChangeMin || 3000)
    ) {
      out.push({
        // Income, not spending: more income read as the green family, less as the
        // warm family. The tone-up/tone-down classes are spending-valenced (up=warm,
        // down=green), so an income movement must flip them to land in the right
        // family. The up/down ARROW (icon) still tracks the actual direction.
        tone: diff > 0 ? 'down' : 'up',
        kind: 'money-in-change',
        icon: diff > 0 ? icons.up() : icons.down(),

        text: `Cash inflow this period was ${bankMoney(Math.abs(diff))} ${diff > 0 ? 'higher' : 'lower'} than ${prevLabel()}, at ${bankMoney(currentIncome)} vs ${bankMoney(prevIncome)}.`,
        onClick: onNavigate,
      });
    }
  }

  // 2) Large/unusual external payment: the SAME median + MAD / modified-
  // z-score method attentionItems() uses on the card side, applied to bank
  // payees. Peer population is the whole classified history (recsAll).
  const largeAll = detectLargeBankOutflows(recsAll, cfg);
  const largeInPeriod = period
    ? largeAll.filter((f) => {
        const m = String(f.date || '').slice(0, 7);
        return m >= period.from && m <= period.to;
      })
    : largeAll;
  if (largeInPeriod.length) {
    const f = largeInPeriod[0];
    out.push({
      tone: 'up',
      kind: 'large-payment',
      icon: icons.alert(),
      text: `A payment to ${f.label} of ${bankMoney(f.amount)} is larger than usual - worth a look?`,
      onClick: drillTo(f.key, f.label),
    });
  }

  // 3) New large payee this period: true first-ever occurrence, reusing the
  // SAME newMerchantMin config value Cards' own "new merchant" insight uses.
  const newPayees = detectPeriodNewPayees(recsAll, period);
  const newBig = newPayees.filter((x) => x.amount >= (insightsCfg.newMerchantMin || 2000))[0];
  if (newBig) {
    out.push({
      tone: 'new',
      kind: 'new-payee',
      icon: icons.spark(),
      text: `New this period: ${newBig.label} (${bankMoney(newBig.amount)}).`,
      onClick: drillTo(newBig.key, newBig.label),
    });
  }

  // 4) Net cash-flow direction and pattern continuation - reusing the
  // CALLER's own already-computed verdict, never a second copy of that logic.
  if (verdict) {
    out.push({
      // Cash-flow valence, not spending valence: a GOOD verdict (more came in
      // than went out) reads as the green family, a WATCH verdict as the warm
      // family. The tone-up/tone-down classes are spending-valenced (up=warm,
      // down=green), so the mapping is flipped to land in the right family -
      // the same correction insight #1 (money-in-change) already makes. The
      // up/down ARROW still tracks the actual direction.
      tone: verdict.tone === 'good' ? 'down' : verdict.tone === 'watch' ? 'up' : 'info',
      icon:
        verdict.tone === 'good'
          ? icons.up()
          : verdict.tone === 'watch'
            ? icons.down()
            : icons.info(),
      kind: 'verdict',
      text: `${capitaliseFirst(verdict.text)}${verdict.comparison ? ', and ' + verdict.comparison : ''}.`,
      onClick: onNavigate,
    });
  }
  // 5) Missing statement months.
  const gaps = missingMonths(bankMonthsList().slice().sort());
  if (gaps.length) {
    out.push({
      tone: 'info',
      kind: 'missing-months',
      icon: icons.gap(),
      text: `No account statement found for ${gaps.slice(0, 2).map(monthLabel).join(' and ')}${gaps.length > 2 ? ` and ${gaps.length - 2} more` : ''}. Add ${gaps.length === 1 ? 'it' : 'them'} for a complete picture.`,
      onClick: opts.onMissingMonths || onNavigate,
    });
  }

  return rankInsights(out, insightsCfg.maxInsights || 3);
}

/* ===========================================================================
 *  Print-model orchestration + report driver  (Stage 5 of the split)
 *  --------------------------------------------------------------------------- 
/* The ONE factory-wrapped group in this file. Everything above is a plain, bootUI-free export; this section is different by nature. These functions build the plain data models that the three printable-report renderers (renderReport / renderBankReport / renderOverviewReport, now in report-render.js and imported at the top of this file) turn into a printed page, and they drive the actual print flow - so they need live bootUI state (the current view, the selected period, the classified bank rows, the formatting helpers). That is why they take a ctx, exactly like the accounts-render / category-picker / manage-data / data-export / cards-render factories, while the pure report renderers they drive do not. They were the print-model group deferred at Stage 3c-i: buildPrintModel needed buildInsights / prevLabel / histMonthlyAverage, which only became clean factory exports once the Cards render tree moved (Stage 4). The group lands HERE, beside the analysis it feeds on and next to the imported renderers it drives - capForPrint and detectIncompleteMonth resolve as plain in-file references (module-scope function declarations, hoisted, reachable from inside this factory's closure), the three renderers resolve through the report-render.js import, and only the cross-ledger analysers (analyseBankActivity / analyseCombinedOverview / analyseRollup) needed adding to the read-statements import above. currentBankViewRows stays internal to the factory but is also returned, so app.js can hand it to the data-export factory (exportCurrentCSV calls it), mirroring how it was passed by reference before the move. printReport, buildReportForCurrentView and exitPrint
 *  ======================================================================== */
export function createPrintReports(ctx) {
  requireCtx(
    ctx,
    [
      'state',
      '$',
      'el',
      'toast',
      'iconX',
      'toggleExportMenu',
      'bankRecordsInPeriod',
      'resolved',
      'analysis',
      'periodRows',
      'visibleRows',
      'allMonths',
      'FALLBACK',
      'isReview',
      'catColour',
      'money0',
      'moneyShort',
      'pct',
      'monthLabel',
      'monthShort',
      'prevLabel',
      'histMonthlyAverage',
      'buildInsights',
      'classifiedBank',
      'bankMoney',
      'cleanCounterparty',
      'overviewModel',
    ],
    'createPrintReports'
  );
  const {
    state,
    $,
    el,
    toast,
    iconX,
    toggleExportMenu,
    bankRecordsInPeriod,
    resolved,
    analysis,
    periodRows,
    visibleRows,
    allMonths,
    FALLBACK,
    isReview,
    catColour,
    money0,
    moneyShort,
    pct,
    monthLabel,
    monthShort,
    prevLabel,
    histMonthlyAverage,
    buildInsights,
    classifiedBank,
    bankMoney,
    cleanCounterparty,
    overviewModel,
  } = ctx;

  // Build the report for whichever ledger is on screen and return true if it was
  // populated. Shared by the Export menu AND the browser's own Ctrl+P (via the
  // beforeprint listener in wireChrome), so both build the correct report - the
  // fix for a raw Ctrl+P producing a blank page because nothing built the report.
  function buildReportForCurrentView() {
    // Round 3: Right Now shows both ledgers together, exactly like Overview,
    // so printing from it produces the SAME combined report Overview already
    // produces, rather than the single-ledger card or bank report either of
    // the two retired tabs used to print. Only when a device has bank data
    // (state.bankRecords.length) does this combined path apply; a card-only
    // device on Right Now falls through to the ordinary card report below.
    const overviewView = state.view === 'overview' && state.bankRecords.length > 0;
    // Ahead has no printed report of its own (Round 2 delivers the on-screen
    // forecast only). It is built entirely from the bank ledger, so printing
    // from it reuses the Accounts activity report - the honest choice already
    // available - rather than silently falling through to a card spending
    // report that has nothing to do with what is on screen.
    const accountsView = state.view === 'ahead' && state.bankRecords.length > 0;
    const bankView = overviewView || accountsView;
    if (bankView ? !state.bankRecords.length : !state.records.length) return false;
    const host = $('#print-report');
    if (!host) return false;
    host.textContent = '';
    resolveReportTheme();
    host.appendChild(
      el(
        'button',
        {
          class: 'report-close',
          'aria-label': 'Back to dashboard',
          onclick: exitPrint,
        },
        el('span', { class: 'report-close-x', html: iconX() }),
        el('span', {}, 'Back to dashboard')
      )
    );
    try {
      const node = overviewView
        ? renderOverviewReport(document, buildOverviewPrintModel())
        : accountsView
          ? renderBankReport(document, buildBankPrintModel())
          : renderReport(document, buildPrintModel());
      host.appendChild(node);
    } catch (err) {
      console.error(err);
      toast('Could not build the report.');
      exitPrint();
      return false;
    }
    document.documentElement.classList.add('printing');
    return true;
  }

  function printReport() {
    toggleExportMenu(false);
    if (!buildReportForCurrentView()) {
      toast('Add a statement first, then create a report.');
      return;
    }
    setTimeout(() => window.print(), 60);
  }

  function resolveReportTheme() {
    const root = document.documentElement;
    const setting = root.dataset.theme || 'auto';
    let effective = setting;
    if (setting === 'auto') {
      const prefersDark =
        typeof window !== 'undefined' &&
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-color-scheme: dark)').matches;
      effective = prefersDark ? 'dark' : 'light';
    }
    root.dataset.reportTheme = effective;
    return effective;
  }

  function reportChartPalette() {
    const cs = getComputedStyle(document.documentElement);
    const tok = (name, fallback) => cs.getPropertyValue(name).trim() || fallback;
    return {
      hatchFill: tok('--edge', '#c9d3df'),
      hatchLine: tok('--dim', '#8b98a8'),
      grid: tok('--edge', '#e6eaf0'),
      avg: tok('--dim', '#8a94a6'),
      bar: tok('--accent', '#1f6feb'),
      barMuted: tok('--dim', '#9aa7b8'),
      barStroke: tok('--accent-dark', '#12539c'),
      baseline: tok('--edge', '#c2ccd8'),
    };
  }

  // Rows currently on screen in the Accounts view: classified for internal
  // transfers, narrowed to the selected account when one is chosen, newest
  // first - so the report and CSV match exactly what the person is looking at.
  function currentBankViewRows() {
    // Scoped to the shared reporting window so "Current view" CSV matches
    // exactly what the Accounts tab is showing under the active period.
    const recs = bankRecordsInPeriod(classifiedBank());
    const one = state.bankAccount && state.bankAccount !== 'all';
    return one ? recs.filter((r) => r.account === state.bankAccount) : recs;
  }

  /* Assemble the plain data model the bank report renders from. Every figure
   * comes from the same analyseBankActivity the Accounts view uses, so the
   * report and the live screen can never disagree. */
  function buildBankPrintModel() {
    const recs = classifiedBank();
    const a = analyseBankActivity(recs);
    const multi = a.accounts.length > 1;
    const one = state.bankAccount && state.bankAccount !== 'all';
    const scope = one
      ? `Account ${state.bankAccount}`
      : multi
        ? `All accounts (${a.accounts.length})`
        : `Account ${a.accounts[0] ? a.accounts[0].account : '-'}`;

    const stmts = (state._bankStatements || [])
      .slice()
      .sort(
        (x, y) =>
          String(x.account).localeCompare(String(y.account)) ||
          String(x.period).localeCompare(String(y.period))
      )
      .map((st) => ({
        account: st.account || '-',
        period: st.period || st.source_file,
        count: String(st.count == null ? '' : st.count),
        closingBalance: st.closingBalance == null ? '-' : bankMoney(st.closingBalance),
        reconciled: !!st.reconciled,
        reconNote: st.reconNote || 'balance did not reconcile',
      }));
    const allReconciled = stmts.length && stmts.every((st) => st.reconciled);

    const viewRows = one ? recs.filter((r) => r.account === state.bankAccount) : recs;
    const txns = viewRows
      .slice()
      .sort((x, y) => (x.date < y.date ? 1 : x.date > y.date ? -1 : 0))
      .map((r) => ({
        date: formatDisplayDate(r.date),
        account: r.account || '-',
        description: cleanCounterparty(r.description) || r.type || '-',
        flow: r.internalTransfer
          ? 'Internal'
          : r.refund
            ? 'Refund'
            : r.household
              ? 'Household'
              : r.excludedFromIncome
                ? 'Not yet income'
                : r.direction === 'in'
                  ? 'In'
                  : 'Out',
        // Each row is shown in its OWN currency, exactly as the live Accounts
        // transaction table does (bankMoney(r.amount, r.currency)). A USD row was
        // printing with a J$ prefix on a correct USD number - a mislabel, not a
        // wrong figure. No amount is converted or summed here; only the symbol
        // now matches the row's currency.
        amount: (r.direction === 'in' ? '+' : '') + bankMoney(r.amount, r.currency),
        credit: r.direction === 'in',
        balance: r.balanceAfter == null ? '' : bankMoney(r.balanceAfter, r.currency),
      }));

    return {
      app: state.cfg.app.name,
      scope,
      generated: new Date().toLocaleString(state.cfg.currency.locale),
      currencyCode: state.cfg.currency.code,
      privacy: 'Generated on this device. Your statement data never leaves it.',
      // C3 (S20): same USD note as the Overview model, keyed off a.foreignAccounts
      // (analyseBankActivity surfaces non-base accounts there). Null when none.
      usdNote:
        a.foreignAccounts && a.foreignAccounts.length
          ? 'A USD account exists on this device and is shown separately. Its balance is not included in these base-currency totals.'
          : null,
      adjustmentNotes: [
        a.refunds > 0
          ? `${bankMoney(a.refunds)} came back as refunds or reversals and is kept out of Cash inflow.`
          : null,
        a.cashDeposits > 0
          ? `${bankMoney(a.cashDeposits)} in cash deposits is not yet confirmed as income.`
          : null,
        a.householdSupport > 0
          ? `${bankMoney(a.householdSupport)} sent to a household member is kept out of personal Cash outflow.`
          : null,
      ].filter(Boolean),
      summary: {
        closingLabel: multi ? 'Total cash position' : 'Cash position',
        closingBalance: a.closingBalance == null ? '-' : bankMoney(a.closingBalance),
        accountsSub: multi ? `Across ${a.accounts.length} accounts` : null,
        moneyIn: bankMoney(a.cashIn),
        moneyOut: bankMoney(a.cashOut),
        net: (a.net >= 0 ? '+' : '') + bankMoney(a.net),
        internalNote: `${bankMoney(a.internalOut)} moved between your own accounts (excluded above).`,
      },
      // Per-account rows are each shown in the account's OWN currency, matching
      // the live "By account" section (bankMoney(ac.cashIn, cur) etc.). A USD
      // account's own Cash inflow/out/closing are pure USD figures computed only
      // from that account's rows - never blended into the JMD headline above,
      // which analyseBankActivity sums from base-currency accounts only. This
      // fix corrects the symbol, not the number.
      accounts: a.accounts.map((ac) => ({
        account: ac.account,
        count: String(ac.n),
        moneyIn: bankMoney(ac.cashIn, ac.currency),
        moneyOut: bankMoney(ac.cashOut, ac.currency),
        closingBalance: ac.closingBalance == null ? '-' : bankMoney(ac.closingBalance, ac.currency),
      })),
      statements: stmts,
      reconNote: stmts.length
        ? allReconciled
          ? 'Every imported statement reconciles: opening balance plus each transaction reaches the printed closing balance to the cent.'
          : 'Some statements did not fully reconcile. The result column shows the first difference found.'
        : null,
      filtersText: one
        ? `Showing account ${state.bankAccount} only.`
        : 'Showing every imported account.',
      txns,
      txCountText: `${txns.length} transaction${txns.length === 1 ? '' : 's'} shown \u00b7 amounts in ${state.cfg.currency.code}. Internal rows are transfers between your own accounts.`,
    };
  }

  function buildOverviewPrintModel() {
    const { ov, roll } = overviewModel();
    const p = resolved();
    return {
      app: state.cfg.app.name,
      period: p ? p.label : 'All time',
      generated: new Date().toLocaleString(state.cfg.currency.locale),
      currencyCode: state.cfg.currency.code,
      privacy: 'Generated on this device. Your statement data never leaves it.',
      hasCard: !!roll.hasCard,
      // C3 (S20): note that a USD account exists and is shown separately, so the
      // print reader knows the base-currency totals deliberately exclude it. Null
      // when there is no foreign account, matching the always-present-key style of
      // this model object (cardOwedSub is likewise always set, never omitted).
      usdNote:
        roll.foreignAccounts && roll.foreignAccounts.length
          ? 'A USD account exists on this device and is shown separately. Its balance is not included in these base-currency totals.'
          : null,
      coverageNote: periodCoverageNote(state.coverage, p),
      summary: {
        netCashFlow: (roll.netCashFlow >= 0 ? '+' : '') + bankMoney(roll.netCashFlow),
        netSub: roll.netCashFlow >= 0 ? 'More came in than went out' : 'More went out than came in',
        moneyIn: bankMoney(roll.income),
        moneyOut: bankMoney(roll.externalSpending),
        moneyOutSub: roll.hasCard
          ? `${bankMoney(roll.bankExternalOut)} from your bank account + ${bankMoney(roll.cardSpend)} on your card`
          : 'External spending; transfers between your own accounts excluded',
        cashOnHand: roll.cashPosition == null ? '-' : bankMoney(roll.cashPosition),
        cardOwedSub:
          roll.cardOwed == null
            ? 'No card balance yet'
            : `${bankMoney(roll.cardOwed)} owed on card (shown separately, never netted)`,
      },
      trend: (roll.trend || []).map((tr) => ({
        month: monthShort(tr.month),
        income: bankMoney(tr.income),
        spending: bankMoney(tr.spending),
        net: (tr.net >= 0 ? '+' : '') + bankMoney(tr.net),
      })),
      trendNote: roll.hasCard
        ? 'Spending each month is money leaving your accounts plus card purchases. Own-account transfers and card payments are excluded, so nothing is counted twice.'
        : 'Cash outflow each month, with transfers between your own accounts excluded.',
      outflows: (ov.topOutflows || []).map((g) => ({
        label: cleanCounterparty(g.label),
        count: String(g.count),
        amount: bankMoney(g.moneyOut),
      })),
    };
  }

  // Unconditionally restore the dashboard. Used by the on-screen close control
  // and as best-effort secondary cleanup after printing; it never relies on any
  // browser event firing.
  function exitPrint() {
    document.documentElement.classList.remove('printing');
    document.documentElement.removeAttribute('data-report-theme');
    const host = $('#print-report');
    if (host) host.textContent = '';
  }

  // Row cap for the printable transaction table. Mirrors the explorer's
  // row-cap concept: show a generous prefix, note the rest in txCountText, so a
  // long period cannot spill an unbounded table across dozens of printed pages.
  // capForPrint treats any non-positive value as "show all".
  const TX_PAGE = 200;

  /* Assemble the plain data model the printable report renders from. All the
   * period figures come from the same pure analysis the dashboard uses, so the
   * report and the live screen can never disagree. */
  function buildPrintModel() {
    const a = analysis();
    const p = resolved();
    const f = state.filter;

    const parts = [];
    if (f.month !== 'all') parts.push(monthLabel(f.month));
    if (f.category !== 'all') parts.push(isReview(f.category) ? 'To review' : f.category);
    if (f.merchant) parts.push(f.merchantLabel || f.merchant);
    if (f.kind !== 'all')
      parts.push(
        {
          spend: 'Purchases',
          payment: 'Payments',
          refund: 'Refunds',
          fee: 'Fees & tax',
        }[f.kind]
      );
    if (f.foreignOnly) parts.push('Foreign only');
    if (f.reviewOnly) parts.push('To review');
    if (f.min != null) parts.push(`≥ ${money0(f.min)}`);
    if (f.max != null) parts.push(`≤ ${money0(f.max)}`);
    if (f.search) parts.push(`“${f.search}”`);

    let vsPrev = null;
    if (a.prev_total != null && a.prev_total !== 0) {
      const diff = a.total_spend - a.prev_total;
      const dp = Math.round((diff / a.prev_total) * 100);
      vsPrev = {
        text: `${Math.abs(dp)}% ${diff > 0 ? 'more' : diff < 0 ? 'less' : 'the same as'} than ${prevLabel()}`,
        prevMoney: money0(a.prev_total),
        dir: diff > 0 ? 'up' : diff < 0 ? 'down' : 'flat',
      };
    }
    const hist = histMonthlyAverage();
    let vsAvg = null;
    if (hist) {
      const perMonth = a.months.length ? a.total_spend / a.months.length : a.total_spend;
      const d = (perMonth - hist) / hist;
      const word = Math.abs(d) < 0.08 ? 'about the same as' : d > 0 ? 'above' : 'below';
      vsAvg = `That is ${word} your typical month of ${money0(hist)}.`;
    }

    const months = allMonths();
    const shown = months.length > 13 ? months.slice(-13) : months;
    const inc = detectIncompleteMonth(state.rows, months, new Date(), {
      coverage: state.coverage,
    });
    const bars = shown.map((m) => {
      const v = state.allSummary.by_month[m] || 0;
      return {
        label: monthShort(m),
        value: v,
        money: money0(v),
        incomplete: !!(inc && inc.month === m),
        inPeriod: !!(p && m >= p.from && m <= p.to),
      };
    });

    const cats = a.by_category
      .map((c) => ({
        name: isReview(c.name) ? 'To review' : c.name,
        amount: money0(c.amount),
        share: pct(c.share),
        shareNum: c.share,
        colour: catColour(c.name),
        review: isReview(c.name),
      }))
      .sort((x, y) => (x.review ? 1 : 0) - (y.review ? 1 : 0));

    const merchants = a.merchants.slice(0, 12).map((m) => ({
      name: m.merchant,
      category: isReview(m.category) ? 'To review' : m.category,
      count: String(m.count),
      amount: money0(m.amount),
      avg: money0(m.avg),
      colour: catColour(m.category),
    }));

    const insights = buildInsights(a).map((i) => i.text);

    const uncategorised = periodRows().filter(
      (r) => r.kind === 'spend' && r.category === FALLBACK()
    );
    const reviewNote = uncategorised.length
      ? `${uncategorised.length} purchase${uncategorised.length === 1 ? '' : 's'} totalling ${money0(uncategorised.reduce((s, r) => s + r.amount, 0))} still need a category; they appear under “To review”.`
      : null;

    // The printable report caps its transaction table (reusing the explorer's
    // row-cap concept) so a long period cannot spill an unbounded table across
    // many pages. The held-back count is noted in txCountText below, keeping
    // renderReport itself unchanged.
    const allVisible = visibleRows();
    const { shown: rows, hidden: hiddenTxns } = capForPrint(allVisible, TX_PAGE);
    const kindLabel = {
      spend: 'Purchase',
      payment: 'Payment',
      refund: 'Refund',
      fee: 'Fee',
    };
    const txns = rows.map((r) => ({
      date: formatDisplayDate(r.date),
      description: r.displayName || r.description,
      foreign: r.foreign || '',
      category: isReview(r.category) ? 'To review' : r.category,
      colour: catColour(r.category),
      kind: kindLabel[r.kind] || r.kind,
      amount: (r.amount < 0 ? '+' : '') + money0(Math.abs(r.amount)),
      credit: r.amount < 0,
    }));

    return {
      app: state.cfg.app.name,
      period: a.label,
      filtersText: parts.length
        ? `Filtered to: ${parts.join(' · ')}`
        : 'All transactions in this period.',
      generated: new Date().toLocaleString(state.cfg.currency.locale),
      currencyCode: state.cfg.currency.code,
      privacy: 'Generated on this device. Your statement data never leaves it.',
      coverageNote: periodCoverageNote(state.coverage, p),
      summary: {
        totalSpend: money0(a.total_spend),
        vsPrev,
        vsAvg,
        nPurchases: String(a.n_purchases),
        leading: a.leading
          ? {
              label: isReview(a.leading.name) ? 'To review' : a.leading.name,
              share: pct(a.leading.share),
              colour: catColour(a.leading.name),
            }
          : null,
        paidToCard: money0(a.total_payments),
        fees: a.total_fees ? money0(a.total_fees) : null,
        refunds: a.total_refunds ? money0(a.total_refunds) : null,
      },
      trend: {
        bars,
        avg: hist || 0,
        avgLabel: hist ? moneyShort(hist) : null,
        avgMoney: hist ? money0(hist) : null,
        moneyShort,
        palette: reportChartPalette(),
      },
      categories: cats,
      merchants,
      insights,
      reviewNote,
      txns,
      txCountText:
        `${rows.length} transaction${rows.length === 1 ? '' : 's'} shown · amounts in ${state.cfg.currency.code}.` +
        (hiddenTxns > 0
          ? ` ${hiddenTxns} further transaction${hiddenTxns === 1 ? ' is' : 's are'} not shown - narrow the period or add a filter to include them.`
          : ''),
    };
  }

  return {
    printReport,
    buildReportForCurrentView,
    exitPrint,
    currentBankViewRows,
  };
}
