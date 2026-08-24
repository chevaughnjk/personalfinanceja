/*
 * reporting.js  -  pure analysis, printable-report renderers, encrypted-history
 * codec and CSV serialisers for the Personal Finance Analyser.
 *
/* Stage 1 of the split. Every function here was already defined outside bootUI at the top level of the original file, so nothing here touches bootUI's closure or its state object. The history codec (exportHistory / importHistory) and CSV serialisers (toCSV / bankToCSV) were missing from the current app.js and are restored here verbatim from app (original).js, fixing the "Uncaught ReferenceError: toCSV is not defined" runtime bug. Pure and browser/Node-safe: no DOM is required except by the render* helpers, which take a `document` argument, so the whole module is unit-testable. */

import { merchantRuleKeyFromDescription, merchantGroupKey, merchantBrandLabel, merchantBranch, merchantDisplayLabel } from '../settings/category-rules.js';
import { categorise, smartTitle, merchantLabel } from './categorise.js';
import { transactionIdentity, cleanBankCounterparty, analyseBankActivity, analyseCombinedOverview, analyseRollup, detectLargeBankOutflows, detectPeriodNewPayees } from './read-statements.js';
import { roundMoney, capitaliseFirst, requireCtx, monthIndex, recurringStatus, monthKey } from './shared-helpers.js';

const MONTH_LONG = ['January','February','March','April','May','June','July',
  'August','September','October','November','December'];

// Decimal rounding on the exact binary value (toFixed), which lines up with
// the source tool's Python round() for the supplied statements. Using the
// exact value avoids the float-multiply artefact that a *100 approach hits.
function round1(n) { return parseFloat(Number(n).toFixed(1)); }

export function buildRows(records, compiled, options = {}) {
  const {
    keepUpper = new Set(), smallWords = new Set(),
    fallback = 'Uncategorised', paymentCategory = 'Card Payment',
    refundCategory = 'Refund / Reversal',
    feeCategories = new Set(['Fees & Interest', 'Government & Tax']),
    merchantOverrides = {},
    merchants = null,   // compiled MERCHANT LIST for GROUPING (merchantGroupKey/displayLabel)
    resolver = null,    // the identity door for categorise() only
    brandRules = [],    // compiled config brand rules (empty in shipped config); merchant intel wins first
  } = options;

  const rows = records.map((t) => {
// needsReview and merchant were previously discarded here: categorise() already returns five fields - { category, confidence, merchant, needsReview } - but only category/confidence ever reached the row. That silently dropped a genuine, already-researched signal (e.g. WiPay: categoryConfidence "low", reviewRequired true, with a real reason recorded in jamaica-merchants.json) before any downstream code could ever see it. Both fields default to a deliberate "not flagged" state (false / null) on the two branches that never call categorise() at all - a person's own categoryOverride or an existing personal rule (merchantOverrides) is an explicit, confirmed decision, never an "unrecognised" or "needs review" case, so those two branches must not inherit a stale needsReview/merchant value from a previous iteration.
    let category, confidence, needsReview = false, merchant = null;
    const firstSeg = merchantRuleKeyFromDescription(t.description);
    if (t.categoryOverride) {
      category = t.categoryOverride; confidence = 1;
    } else if (merchantOverrides[firstSeg]) {
      category = merchantOverrides[firstSeg]; confidence = 1;
    } else {
      // categorise's 2nd arg is the compiled CATEGORY RULES ([{name, re, headRe}]); its 4th arg is the compiled MERCHANT LIST ([{re, merchant, ...}]). Different shapes - do not swap them.
      const c = categorise(t.description, compiled, fallback, resolver, { isCredit: t.amount < 0, refundCategory });
      category = c.category; confidence = c.confidence;
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
      date: t.txn_date, month: monthKey(t.txn_date),
      description,
      displayName: merchantDisplayLabel(t.description, brandRules, merchants, keepUpper, smallWords),
      // The SAME grouping key summarise()/analysePeriod() already derive on
      // demand whenever they group by merchant. Cached here so it can be
      // exported per row for the Detailed CSV; no total or grouping changes.
      merchantGroup: merchantGroupKey(description, brandRules, merchants) || '',
      raw_description: t.description,
      category, amount: roundMoney(t.amount), kind,
      source_file: t.source_file, confidence, foreign: t.foreign || '',
      overridden: !!t.categoryOverride, reviewDismissed: !!t.reviewDismissed,
      // Scotiabank card rows carry a reference number; NCB card rows and every
      // bank row do not - '' there.
      ref: t.ref || '',
      // Stage 1 of the split. Every function here was already defined outside bootUI at the top level of the original file, so nothing here touches bootUI's closure or its state object. The history codec (exportHistory / importHistory) and the CSV serialisers (toCSV / bankToCSV) were missing from the current app.js and are restored here verbatim from app (original).js, fixing the "Uncaught ReferenceError: toCSV is not defined" runtime bug. Pure and browser/Node-safe: no DOM is required except by the render* helpers, which take a `document` argument, so the whole module is unit-testable. */
      needsReview, merchant,
    };
  });
  rows.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return rows;
}


export function summarise(rows, options = {}) {
  const { keepUpper = new Set(), smallWords = new Set(), brandRules = [], merchants = null, fallback = 'Uncategorised' } = options;
  const spend = rows.filter((r) => r.kind === 'spend');
  const totalSpend = spend.reduce((a, r) => a + r.amount, 0);
  const totalPayments = rows.filter((r) => r.kind === 'payment').reduce((a, r) => a - r.amount, 0);
  const totalRefunds = rows.filter((r) => r.kind === 'refund').reduce((a, r) => a - r.amount, 0);
  const totalFees = rows.filter((r) => r.kind === 'fee').reduce((a, r) => a + r.amount, 0);
  const months = [...new Set(rows.filter((r) => r.month !== 'unknown').map((r) => r.month))].sort();
  const nMonths = Math.max(months.length, 1);

  const byCat = {};
  for (const r of spend) byCat[r.category] = (byCat[r.category] || 0) + r.amount;
  const byCategory = Object.fromEntries(
    Object.entries(byCat).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, roundMoney(v)]));

  const byMonthRaw = Object.fromEntries(months.map((m) => [m, 0]));
  for (const r of spend) if (r.month in byMonthRaw) byMonthRaw[r.month] += r.amount;
  const byMonth = Object.fromEntries(Object.entries(byMonthRaw).map(([k, v]) => [k, roundMoney(v)]));

  const byMerchant = {};
  for (const r of spend) {
  // Group by the additive brand key (star-token + trailing reference stripped, brand rules applied); display and totals are unchanged. The group keeps its first row's raw description so the label is produced by the one shared merchantDisplayLabel, not a hand-copied formula.
    const key = merchantGroupKey(r.description, brandRules, merchants) || 'UNKNOWN';
    if (!byMerchant[key]) byMerchant[key] = { amount: 0, count: 0, category: r.category, descSrc: r.description };
    byMerchant[key].amount += r.amount;
    byMerchant[key].count += 1;
  }
  const topMerchants = Object.values(byMerchant)
    .map((v) => ({ merchant: merchantDisplayLabel(v.descSrc, brandRules, merchants, keepUpper, smallWords), amount: roundMoney(v.amount), count: v.count, category: v.category }))
    .sort((a, b) => b.amount - a.amount).slice(0, 15);

  const n_uncategorised_spend = spend.filter((r) => r.category === fallback).length;
  const coverage = 100 * (spend.length - n_uncategorised_spend) / Math.max(spend.length, 1);

  return {
    total_spend: roundMoney(totalSpend), total_payments: roundMoney(totalPayments),
    total_refunds: roundMoney(totalRefunds), total_fees: roundMoney(totalFees),
    n_transactions: rows.length, n_spend: spend.length, n_months: nMonths,
    avg_monthly_spend: roundMoney(totalSpend / nMonths), months,
    by_category: byCategory, by_month: byMonth, top_merchants: topMerchants,
    coverage_pct: round1(coverage), n_uncategorised_spend,
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
    if (!(key in labelByKey)) labelByKey[key] = merchantDisplayLabel(r.description, brandRules, merchants);
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
    if (!(key in labelByKey)) labelByKey[key] = merchantDisplayLabel(r.description, brandRules, merchants);
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
export function reviewReasonText(row, fallback = 'Uncategorised', brandRules = [], merchants = null) {
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
  const t = Object.assign({
    largeChargeMultiple: 2.5, largeChargeMin: 10000,
    largeChargeZ: 3.5,        // modified-z threshold (Iglewicz & Hoaglin's standard cut)
    largeChargeMinPeers: 2,   // need at least this many prior charges to judge "usual"
  }, cfg.insights || {});
  // Reads the SAME config path FALLBACK()/buildRows() read (state.cfg.special.
  // fallback), so "unrecognised" means the exact same category name everywhere
  // in the app. cfg.special is absent when this runs via reviewItems()'s empty
  // {} call, so the shipped default 'Uncategorised' is used there, matching
  // isUnrecognised's own default and config.json's actual configured value.
  const fallback = (cfg.special && cfg.special.fallback) || 'Uncategorised';
  const med = (a) => { const s = a.slice().sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const byMerchant = {};
  for (const r of rows.filter((r) => r.kind === 'spend')) {
    const k = merchantGroupKey(r.description, brandRules, merchants);
    (byMerchant[k] = byMerchant[k] || []).push(r);
  }
  const flags = [];
  for (const r of rows.filter((r) => r.kind === 'spend' && !r.reviewDismissed)) {
    const k = merchantGroupKey(r.description, brandRules, merchants);
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
      const zOk = mad > 0 ? ((0.6745 * (r.amount - centre)) / mad >= t.largeChargeZ) : true;
      const multipleOk = centre > 0 && r.amount >= centre * t.largeChargeMultiple;
      if (zOk && multipleOk) {
        flags.push({ id: r.id, type: 'large', text: `This ${merchantDisplayLabel(r.description, brandRules, merchants)} charge is larger than usual - worth a look?`, row: r });
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
export function reviewItems({ rows, month, cardStatements, bankStatements, brandRules = [], merchants = null } = {}) {
  const allRows = rows || [];
  const out = [];
  const addUnreconciled = (list, source) => {
    for (const s of (list || [])) {
      if (s.reconciled) continue;
      out.push({
        kind: 'unreconciled',
        id: s.hash != null ? s.hash : undefined,
        label: `${source} statement not reconciled`,
        detail: [s.account ? `account ${s.account}` : '', s.period || '', s.reconNote || '']
          .filter(Boolean).join(' · '),
      });
    }
  };
  addUnreconciled(cardStatements, 'Card');
  addUnreconciled(bankStatements, 'Bank');
  for (const it of attentionItems(allRows, {}, brandRules, merchants)) {
    if (it.type === 'large' && it.row && it.row.month === month) {
      out.push({ kind: 'large', id: it.id, label: merchantDisplayLabel(it.row.description, brandRules, merchants), detail: it.text });
    } else if (it.type === 'uncertain' && it.row && it.row.month === month) {
      out.push({ kind: 'uncertain', id: it.id, label: merchantDisplayLabel(it.row.description, brandRules, merchants), detail: it.text });
    }
  }

  for (const nm of detectNewMerchants(allRows, month, brandRules, merchants)) {
    out.push({ kind: 'new', id: nm.key, label: nm.label, detail: 'New place this month' });
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
  const push = (c) => { if (c != null && allCategories.includes(c) && !seen.has(c)) { seen.add(c); out.push(c); } };
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
  const shown = items.slice(0, initial);
  const rest = items.slice(initial);
  for (const item of shown) parent.append(renderItem(item));
  if (!rest.length) return;
  const restNodes = rest.map(renderItem);
  let expanded = false;
  const btn = el('button', { class: 'btn sm ghost' }, `Show ${rest.length} more`);
  const anchor = opts.wrapToggle ? opts.wrapToggle(btn) : el('div', { class: 'show-more' }, btn);
  btn.addEventListener('click', () => {
    expanded = !expanded;
    if (expanded) { for (const n of restNodes) anchor.before(n); btn.textContent = 'Show less'; }
    else { for (const n of restNodes) n.remove(); btn.textContent = `Show ${rest.length} more`; }
  });
  parent.append(anchor);
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
  return el('span', { class: 'ktag ' + cls }, el('span', { class: 'kdot' }), el('span', { class: 'klabel' }, label));
}

export function renderFlowArrow(el, icons, direction) {
  const isIn = direction === 'in';
  return el('span', { class: 'flow-arrow ' + (isIn ? 'in' : 'out'), 'aria-hidden': 'true',
    html: isIn ? icons.up() : icons.down() });
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
  const chips = items.map(({ label, onClear }) => el('button', { class: 'chip removable', onclick: onClear }, label, el('span', { class: 'chip-x', html: iconX() })));
  return el('div', { class: 'chips' }, el('span', { class: 'muted small' }, 'Filters:'), ...chips,
    el('button', { class: 'linkbtn', onclick: onClearAll }, 'Clear all'));
}

// One shared fact chip for the hero facts row, replacing the two near-identical
// hand-rolled builders that had drifted apart: Cards' `fact(value, label,
// onClick, colour, cls)` and Accounts' `bankFact(label, value, cls)` (note the
// argument order even disagreed). Takes a pure-data fact and renders the exact
// same DOM both produced, so a fact reads and behaves identically on every tab.
function heroFact(el, f) {
  const attrs = { class: 'fact' + (f.onClick ? ' clickable' : '') + (f.tone ? ' ' + f.tone : '') };
  if (f.onClick) attrs.onclick = f.onClick;
  const v = el('div', { class: 'fact-value' },
    f.colour ? el('span', { class: 'swatch', style: `background:${f.colour}` }) : null,
    el('span', {}, f.value));
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
  const sec = el('section', { class: 'card hero' + (spec.verdict ? ' verdict' : '') });
  const head = el('div', { class: 'hero-head' },
    el('div', {},
      el('div', { class: 'hero-eyebrow' }, spec.eyebrow),
      el('h2', { class: 'hero-title' }, spec.title)));
  if (spec.pill) head.append(el('span', { class: 'pill caution', title: spec.pill.title }, icon(iconInfo()), spec.pill.text));
  sec.append(head);
  if (spec.pill && spec.pill.subline) sec.append(el('p', { class: 'muted small mobile-context' }, spec.pill.subline));
  if (spec.verdict) {
    sec.append(el('div', { class: 'hero-verdict' }, el('span', { class: `attn-dot ${spec.verdict.tone}` }), ' ', spec.verdict.text));
    if (spec.verdict.comparison) sec.append(el('p', { class: 'muted' }, spec.verdict.comparison));
  }
  const figure = el('div', { class: 'hero-figure' },
    el('div', { class: 'hero-amount' }, spec.lead.amount),
    el('div', { class: 'hero-amount-label' }, spec.lead.label),
    ...((spec.lead.extra || []).filter(Boolean)));
  const facts = el('div', { class: 'hero-facts' },
    ...spec.facts.filter(Boolean).map((f) => heroFact(el, f)));
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
  sec.append(el('div', { class: 'card-head' }, el('h3', { class: 'card-title' }, icon(iconBulb()), title)));
  if (!insights.length) { sec.append(el('p', { class: 'muted pad' }, emptyText)); return sec; }
  const list = el('div', { class: 'insight-list' });
  for (const i of insights) list.append(el('button', { class: 'insight tone-' + i.tone, onclick: i.onClick },
    el('span', { class: 'insight-icon', html: i.icon }),
    el('span', { class: 'insight-text' }, i.text),
    el('span', { class: 'insight-go', html: iconChevron() })));
  sec.append(list);
  return sec;
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
  const d = el('details', { class: 'explainer' + (opts.class ? ' ' + opts.class : '') });
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
  const d = new Date(y, (m - 1) + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function dayOfIso(iso) { const m = /^\d{4}-\d{2}-(\d{2})$/.exec(iso); return m ? +m[1] : 0; }
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

const COVERAGE_MON = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };

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
    const lo = Math.max(a, firstMs), hi = Math.min(b, lastMs);
    if (lo <= hi) clamped.push([lo, hi]);
  }
  if (!clamped.length) return 'none';
  clamped.sort((x, z) => x[0] - z[0]);
  if (clamped[0][0] > firstMs) return 'partial';   // coverage starts mid-month
  let reach = clamped[0][1];
  for (let i = 1; i < clamped.length; i++) {
    if (clamped[i][0] <= reach + 86400000) reach = Math.max(reach, clamped[i][1]);
    else break;                                     // gap: stop counting
  }
  return reach >= lastMs ? 'full' : 'partial';
}

// Build the coverage map. cardMonths/bankMonths are the Sets of 'YYYY-MM' that
// actually carry transactions on each ledger, so a month with no data on a
// ledger reads 'absent' (never blocking completeness) rather than 'none'.
export function buildStatementCoverage(cardStatements = [], bankStatements = [], cardMonths = new Set(), bankMonths = new Set()) {
  const cardSpans = [];
  for (const s of (cardStatements || [])) {
    const a = coverageIsoMs(s.periodStart), b = coverageIsoMs(s.periodEnd);
    if (a != null && b != null && a <= b) cardSpans.push([a, b]);
  }
  const bankSpans = [];
  for (const s of (bankStatements || [])) {
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
    from: clampLo(from), to, label, prevFrom: prevFrom ? clampLo(prevFrom) : null,
    prevTo: prevTo || null, kind: kind || sel.type,
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
      const to = lcm || last; const from = addMonthsYM(to, -2);
      return mk(from, to, 'Last 3 months', addMonthsYM(from, -3), addMonthsYM(to, -3), 'range');
    }
    case 'last-6': {
      const to = lcm || last; const from = addMonthsYM(to, -5);
      return mk(from, to, 'Last 6 months', addMonthsYM(from, -6), addMonthsYM(to, -6), 'range');
    }
    case 'this-year': {
      const y = (lcm || last).slice(0, 4);
      const from = `${y}-01`; const to = (lcm || last);
      const py = String(+y - 1);
      return mk(from, to, `${y}`, `${py}-01`, `${py}-12`, 'range');
    }
    case 'custom': {
      const from = sel.from || first; const to = sel.to || last;
      const span = monthSpanCount(from, to);
      return mk(from, to, `${monthName(from)} - ${monthName(to)}`,
        addMonthsYM(from, -span), addMonthsYM(to, -span), 'range');
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
function inRange(ym, from, to) { return ym >= from && ym <= to; }

/* Analyse a resolved period into everything the dashboard shows for it:
 * totals split by kind, purchase count, leading category, category and
 * merchant breakdowns, per-month spend, and change vs the previous comparable
 * period and vs the historical monthly average. Pure. */
export function analysePeriod(rows, period, opts = {}) {
  // Named merchantIntel here (not `merchants`) to avoid colliding with the local
  // `const merchants` result array built below; it is the compiled merchant list.
  const { keepUpperSet = new Set(), smallWordsSet = new Set(), merchantLabelFn = (s) => s, brandRules = [], merchants: merchantIntel = null } = opts;
  const inP = rows.filter((r) => inRange(r.month, period.from, period.to));
  const spend = inP.filter((r) => r.kind === 'spend');

  const totalSpend = roundMoney(spend.reduce((a, r) => a + r.amount, 0));
  const totalPayments = roundMoney(inP.filter((r) => r.kind === 'payment').reduce((a, r) => a - r.amount, 0));
  const totalRefunds = roundMoney(inP.filter((r) => r.kind === 'refund').reduce((a, r) => a - r.amount, 0));
  const totalFees = roundMoney(inP.filter((r) => r.kind === 'fee').reduce((a, r) => a + r.amount, 0));

  const monthsInP = [...new Set(inP.map((r) => r.month))].sort();

  const byCat = {};
  for (const r of spend) byCat[r.category] = (byCat[r.category] || 0) + r.amount;
  const byCategory = Object.entries(byCat).map(([name, amt]) => ({
    name, amount: roundMoney(amt), share: totalSpend ? amt / totalSpend : 0,
  })).sort((a, b) => b.amount - a.amount);

  const byMonth = {};
  for (const r of spend) byMonth[r.month] = roundMoney((byMonth[r.month] || 0) + r.amount);

  const merch = {};
  for (const r of spend) {
    // Additive brand key for grouping; per-transaction display/totals unchanged.
    // The group keeps its first row's raw description so its display label comes
    // from the one shared merchantDisplayLabel, not a hand-copied formula.
    const key = merchantGroupKey(r.description, brandRules, merchantIntel) || 'UNKNOWN';
    if (!merch[key]) merch[key] = { key, amount: 0, count: 0, category: r.category, descSrc: r.description, branches: new Set(), ids: [] };
    const br = merchantBranch(r.description); if (br) merch[key].branches.add(br);
    merch[key].amount += r.amount; merch[key].count += 1; merch[key].ids.push(r.id);
  }
  const merchants = Object.values(merch).map((v) => ({
    merchant: merchantDisplayLabel(v.descSrc, brandRules, merchantIntel, keepUpperSet, smallWordsSet), key: v.key,
    branches: [...v.branches].sort(),
    amount: roundMoney(v.amount), count: v.count, avg: roundMoney(v.amount / v.count),
    share: totalSpend ? v.amount / totalSpend : 0, category: v.category,
  })).sort((a, b) => b.amount - a.amount);

  const leading = byCategory[0] || null;

  // Previous comparable period (same number of months, immediately before).
  let prevTotal = null;
  if (period.prevFrom && period.prevTo) {
    const prev = rows.filter((r) => r.kind === 'spend' && inRange(r.month, period.prevFrom, period.prevTo));
    prevTotal = roundMoney(prev.reduce((a, r) => a + r.amount, 0));
  }

  return {
    from: period.from, to: period.to, label: period.label, kind: period.kind,
    months: monthsInP, total_spend: totalSpend, total_payments: totalPayments,
    total_refunds: totalRefunds, total_fees: totalFees,
    n_purchases: spend.length, n_transactions: inP.length,
    by_category: byCategory, by_month: byMonth, merchants, leading,
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
  const period = { from, to, label: '', kind: 'range', prevFrom: null, prevTo: null };
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
  const idx = monthKeys.map(monthIndex).filter((n) => !Number.isNaN(n)).sort((a, b) => a - b);
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
export function detectRecurring(rows, minMonths = 3, tolerance = 0.15, brandRules = [], merchants = null, maxGapMonths = 2) {
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
        key, label: merchantDisplayLabel(list[0].description, brandRules, merchants),
        months: monthsSeen.length, typical: roundMoney(typical),
        lastMonth, status: recurringStatus(lastMonth, latestMonth, maxGapMonths),
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
  const norm = (s) => String(s == null ? '' : s).trim().toUpperCase();
  for (const c of (cardRecurring || [])) {
    const k = norm(c.label);
    if (!byNorm.has(k)) byNorm.set(k, { label: c.label, typical: roundMoney(c.typical), source: 'card', lastMonth: c.lastMonth || null, status: c.status || 'active' });
  }
  for (const b of (bankStandingDebits || [])) {
    const k = norm(b.label);
    if (byNorm.has(k)) continue; // shared label: the card side is already kept, so never add its typical twice
    byNorm.set(k, { label: b.label, typical: roundMoney(b.typical), source: 'bank', lastMonth: b.lastMonth || null, status: b.status || 'active' });
  }
  const all = [...byNorm.values()].sort((a, b) => b.typical - a.typical);
  // Active-only headline: a commitment whose last charge has fallen further
  // behind the ledger's own newest month than its own cadence tolerance
  // allows (detectRecurring/detectBankStandingDebits's recurringStatus, above)
  // is no longer safe to count as an ongoing monthly cost, even though it
  // recurred consistently before. Never silently dropped - see `lapsed` below
  // - only kept out of the active total and the main list, the same
  // "flag, never delete" convention this app already applies to cash-deposit
  // exclusions and confirmed round-trips.
  const items = all.filter((it) => it.status !== 'lapsed');
  const lapsed = all.filter((it) => it.status === 'lapsed');
  const total = roundMoney(items.reduce((a, it) => a + it.typical, 0));
  return { total, items, lapsed };
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
  const share = (cfg.insights && cfg.insights.driverShare != null) ? cfg.insights.driverShare : 0.5;
  const index = (arr, keyFn) => {
    const m = new Map();
    for (const it of (arr || [])) m.set(keyFn(it), it);
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
  return (top.delta >= share * positiveSum) ? { label: top.label, kind: top.kind } : null;
}

/* Detect a consistent pay-in-full cardholder (Round 1, A5). A copy of the
 * statements is sorted by statementKey exactly the way renderCardStatementHealth
 * sorts them (String(a.statementKey).localeCompare(String(b.statementKey))), the
 * most recent 3 are taken, and the result is true only when every one of them is
 * payingInFull === true. With fewer than 3 present the decision is made on those
 * present; any revolving statement in that window makes it false. Pure. */
export function payingInFullPattern(cardStatements) {
  const sorted = (cardStatements || []).slice()
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
  const sorted = (cardStatements || []).slice()
    .sort((a, b) => String(a.statementKey).localeCompare(String(b.statementKey)));
  if (!sorted.length) return 'insufficient';
  const window = sorted.slice(-3);
  const withInterest = window.filter((s) => s.interestCharges != null && Number.isFinite(Number(s.interestCharges)));
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
  while (bal > 0.005 && months < 600) {   // 600 = 50-year safety cap
    const interest = bal * r;
    totalInterest += interest;
    bal = bal + interest - payment;
    if (bal < 0) bal = 0;
    months++;
  }
  return { months, totalInterest: roundMoney(totalInterest), neverClears: false };
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
  return { count: items.length, totalJmd: roundMoney(totalJmd), byCurrency, items };
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
  'large-charge': 90, 'large-payment': 90,
  // Completeness of the whole picture.
  'missing-months': 70,
  // Meaningful change, with a named cause.
  'overall-change': 60, 'money-in-change': 60,
  'category-move': 55,
  // Direction / what it cost.
  'verdict': 50, 'fees': 50,
  'new-merchant': 45, 'new-payee': 45,
  'refunds': 40,
  // Steady context.
  'recurring': 30, 'foreign': 30,
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
    .sort((a, b) => (b.weight - a.weight) || (a.idx - b.idx))
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
    recsAll, period, cfg,
    currentIncome, prevIncome, verdict, coverage,
    bankMoney, prevLabel, monthLabel, bankMonthsList,
    onNavigate, icons,
  } = opts;
  const insightsCfg = cfg.insights || {};
  const out = [];

  // 1) Money in vs the previous comparable period.
  // Fairness gate: never compare a not-yet-complete window against a full one -
  // that is what produced "`` (delete — empty replacement) near-zero income vs a full prior month" when
  // the current month was only part-imported. A provably partial period
  // suppresses the comparison entirely (an unknown one is allowed through, so
  // ledgers whose statement dates cannot yet be parsed keep today's behaviour).
  if (prevIncome != null && prevIncome > 0 && currentIncome != null && isPeriodFullyCovered(coverage, period)) {
    const diff = currentIncome - prevIncome;
    const dp = Math.round((diff / prevIncome) * 100);
    if (Math.abs(dp) >= (insightsCfg.meaningfulChangePct || 25) && Math.abs(diff) >= (insightsCfg.meaningfulChangeMin || 3000)) {
      out.push({
        tone: diff > 0 ? 'up' : 'down', kind: 'money-in-change', icon: diff > 0 ? icons.up() : icons.down(),

        text: `Money in this period was ${bankMoney(Math.abs(diff))} ${diff > 0 ? 'higher' : 'lower'} than ${prevLabel()}, at ${bankMoney(currentIncome)} vs ${bankMoney(prevIncome)}.`,
        onClick: onNavigate,
      });
    }
  }

  // 2) Large/unusual external payment: the SAME median + MAD / modified-
  // z-score method attentionItems() uses on the card side, applied to bank
  // payees. Peer population is the whole classified history (recsAll).
  const largeAll = detectLargeBankOutflows(recsAll, cfg);
  const largeInPeriod = period ? largeAll.filter((f) => { const m = String(f.date || '').slice(0, 7); return m >= period.from && m <= period.to; }) : largeAll;
  if (largeInPeriod.length) {
    const f = largeInPeriod[0];
    out.push({
      tone: 'up', kind: 'large-payment', icon: icons.alert(),
      text: `A payment to ${f.label} of ${bankMoney(f.amount)} is much larger than a typical outflow - worth a look?`,
      onClick: onNavigate,
    });
  }

  // 3) New large payee this period: true first-ever occurrence, reusing the
  // SAME newMerchantMin config value Cards' own "new merchant" insight uses.
  const newPayees = detectPeriodNewPayees(recsAll, period);
  const newBig = newPayees.filter((x) => x.amount >= (insightsCfg.newMerchantMin || 2000))[0];
  if (newBig) {
    out.push({ tone: 'new', kind: 'new-payee', icon: icons.spark(), text: `New this period: ${newBig.label} (${bankMoney(newBig.amount)}).`, onClick: onNavigate });
  }

  // 4) Net cash-flow direction and pattern continuation - reusing the
  // CALLER's own already-computed verdict, never a second copy of that logic.
  if (verdict) {
    out.push({
      tone: verdict.tone === 'good' ? 'up' : (verdict.tone === 'watch' ? 'down' : 'info'),
      icon: verdict.tone === 'good' ? icons.up() : (verdict.tone === 'watch' ? icons.down() : icons.info()),
      kind: 'verdict',
      text: `${capitaliseFirst(verdict.text)}${verdict.comparison ? ', and ' + verdict.comparison : ''}.`,
      onClick: onNavigate,
    });
  }
  // 5) Missing statement months.
  const gaps = missingMonths(bankMonthsList().slice().sort());
  if (gaps.length) {
    out.push({
      tone: 'info', kind: 'missing-months', icon: icons.gap(),
      text: `No account statement found for ${gaps.slice(0, 2).map(monthLabel).join(' and ')}${gaps.length > 2 ? ` and ${gaps.length - 2} more` : ''}. Add ${gaps.length === 1 ? 'it' : 'them'} for a complete picture.`,
      onClick: opts.onMissingMonths || onNavigate,
    });
  }

  return rankInsights(out, insightsCfg.maxInsights || 3);
}

/* ===========================================================================
 * 10b) Printable report renderer  (dedicated print / PDF path)
 * ---------------------------------------------------------------------------
 * Builds a clean, shareable finance report as REAL DOM / SVG elements, wholly
 * separate from the interactive dashboard. Every dynamic value (merchant name,
 * category, amount, insight sentence) is inserted as text, so the browser
 * escapes it automatically - a name like "Ben & Jerry's" or "R&D" can never
 * emit a stray tag. The only markup is the small, hand-written section icons,
 * and those are built with createElementNS as genuine SVG nodes. Nothing here
 * ever concatenates icon or chart markup into a string that becomes text, so
 * the raw-markup bug (literal <svg…> printing on the page) cannot recur.
 *
 * Pure and DOM-standard: it takes a `document` and a plain data model and
 * returns the report root element, so it runs in the browser and can be
 * exercised in a lightweight test DOM.
 * ======================================================================== */

const REPORT_ICON_SHAPES = {
  cal:   [['rect', { x: 3, y: 4.5, width: 18, height: 16, rx: 2 }], ['path', { d: 'M3 9h18M8 2.5v4M16 2.5v4' }]],
  card:  [['rect', { x: 2.5, y: 5, width: 19, height: 14, rx: 2.5 }], ['path', { d: 'M2.5 9.5h19' }]],
  sum:   [['path', { d: 'M5 4h14M5 4l7 8-7 8h14' }]],
  chart: [['path', { d: 'M4 20V6M10 20V4M16 20v-8M22 20H2' }]],
  pie:   [['path', { d: 'M12 3v9h9a9 9 0 1 0-9 9' }], ['path', { d: 'M21 12a9 9 0 0 0-9-9' }]],
  store: [['path', { d: 'M4 9h16M5 9l-1-4h16l-1 4M5 9v11h14V9' }]],
  bulb:  [['path', { d: 'M9 18h6M10 21h4M12 3a6 6 0 0 0-3 11c.6.4 1 1 1 2h4c0-1 .4-1.6 1-2a6 6 0 0 0-3-11z' }]],
  list:  [['path', { d: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01' }]],
};

function rpSvg(doc, tag, attrs = {}, kids = []) {
  const n = doc.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, String(v));
  for (const kid of kids) if (kid != null) n.appendChild(kid);
  return n;
}

/* A section-heading icon as a real SVG element (never a string). */
export function reportIconEl(doc, name, size = 17) {
  const shapes = REPORT_ICON_SHAPES[name] || REPORT_ICON_SHAPES.list;
  const kids = shapes.map(([t, a]) => rpSvg(doc, t, a));
  return rpSvg(doc, 'svg', {
    viewBox: '0 0 24 24', width: size, height: size, fill: 'none',
    stroke: 'currentColor', 'stroke-width': 1.7, 'stroke-linecap': 'round',
    'stroke-linejoin': 'round', class: 'rp-ic',
  }, kids);
}

/* Small HTML element helper for the report. String children become text nodes,
 * which the DOM escapes - this is what makes stray markup impossible. */
function rp(doc, tag, attrs = {}, ...kids) {
  const n = doc.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === 'class') n.setAttribute('class', v);
    else n.setAttribute(k, String(v));
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    n.appendChild(kid.nodeType ? kid : doc.createTextNode(String(kid)));
  }
  return n;
}

/* A coloured category chip: colour swatch paired with its text label so it
 * stays distinguishable in black-and-white printing (colour is never the only
 * signal). */
function rpSwatch(doc, colour, label, extraClass) {
  return rp(doc, 'span', { class: 'rp-swatch-wrap' + (extraClass ? ' ' + extraClass : '') },
    rp(doc, 'span', { class: 'rp-swatch', style: `background:${colour}` }),
    rp(doc, 'span', { class: 'rp-swatch-label' }, label));
}

/* Static spending-over-time chart, drawn as an SVG bar chart with a labelled
 * axis, per-bar period labels, and the historical average as a dashed
 * reference line. No tooltips - the figures are printed beside the chart. */
function rpTrendChart(doc, trend) {
  const bars = trend.bars || [];
  const W = 760, H = 250;
  const padL = 54, padR = 18, padT = 22, padB = 46;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const values = bars.map((b) => b.value);
  const maxRaw = Math.max(...values, trend.avg || 0, 1);
  const max = maxRaw * 1.12;
  const yOf = (v) => padT + plotH - (v / max) * plotH;
  const n = bars.length || 1;
  const slot = plotW / n;
  const barW = Math.min(46, Math.max(8, slot * 0.55));

  const kids = [];

  // hatch pattern for part-month (incomplete) bars
  const defs = rpSvg(doc, 'defs', {}, [
    rpSvg(doc, 'pattern', { id: 'rp-hatch', width: 5, height: 5, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' }, [
      rpSvg(doc, 'rect', { width: 5, height: 5, fill: '#c9d3df' }),
      rpSvg(doc, 'line', { x1: 0, y1: 0, x2: 0, y2: 5, stroke: '#8b98a8', 'stroke-width': 2 }),
    ]),
  ]);
  kids.push(defs);

  // y gridlines + labels (0, mid, max)
  const short = trend.moneyShort || ((v) => String(Math.round(v)));
  [0, max / 2, max].forEach((gv) => {
    const y = yOf(gv);
    kids.push(rpSvg(doc, 'line', { x1: padL, y1: y, x2: W - padR, y2: y, stroke: '#e6eaf0', 'stroke-width': 1 }));
    kids.push(rpSvg(doc, 'text', { x: padL - 8, y: y + 3.5, 'text-anchor': 'end', class: 'rp-axis' }, [doc.createTextNode(short(gv))]));
  });

  // average reference line
  if (trend.avg > 0) {
    const ay = yOf(trend.avg);
    kids.push(rpSvg(doc, 'line', { x1: padL, y1: ay, x2: W - padR, y2: ay, stroke: '#8a94a6', 'stroke-width': 1.4, 'stroke-dasharray': '5 4' }));
    kids.push(rpSvg(doc, 'text', { x: W - padR, y: ay - 5, 'text-anchor': 'end', class: 'rp-axis-avg' },
      [doc.createTextNode(`avg ${trend.avgLabel || ''}`)]));
  }

  // bars + labels
  bars.forEach((b, i) => {
    const cx = padL + slot * i + slot / 2;
    const x = cx - barW / 2;
    const y = yOf(b.value);
    const h = Math.max(1, padT + plotH - y);
    const fill = b.incomplete ? 'url(#rp-hatch)' : (b.inPeriod ? '#1f6feb' : '#9aa7b8');
    kids.push(rpSvg(doc, 'rect', { x, y, width: barW, height: h, rx: 2.5, fill, stroke: b.inPeriod ? '#12539c' : 'none', 'stroke-width': b.inPeriod ? 1 : 0 }));
    // period label under the axis
    kids.push(rpSvg(doc, 'text', { x: cx, y: H - padB + 16, 'text-anchor': 'middle', class: 'rp-axis' }, [doc.createTextNode(b.label)]));
  });

  // baseline
  kids.push(rpSvg(doc, 'line', { x1: padL, y1: yOf(0), x2: W - padR, y2: yOf(0), stroke: '#c2ccd8', 'stroke-width': 1.2 }));

  return rpSvg(doc, 'svg', { viewBox: `0 0 ${W} ${H}`, class: 'rp-chart', preserveAspectRatio: 'xMidYMid meet', role: 'img' }, kids);
}

export function renderReport(doc, model) {
  const root = rp(doc, 'div', { class: 'rp' });
  const heading = (iconName, text) => rp(doc, 'h2', { class: 'rp-h' }, reportIconEl(doc, iconName, 18), rp(doc, 'span', {}, text));

  /* 1) Header */
  const header = rp(doc, 'header', { class: 'rp-header' },
    rp(doc, 'div', { class: 'rp-brand' }, reportIconEl(doc, 'card', 22), rp(doc, 'span', { class: 'rp-brand-name' }, model.app)),
    rp(doc, 'h1', { class: 'rp-title' }, 'Spending report'),
    rp(doc, 'div', { class: 'rp-meta' },
      rp(doc, 'span', { class: 'rp-meta-period' }, `Period: ${model.period}`),
      rp(doc, 'span', { class: 'rp-dot' }, '·'),
      rp(doc, 'span', {}, `Generated ${model.generated}`),
      rp(doc, 'span', { class: 'rp-dot' }, '·'),
      rp(doc, 'span', {}, `Amounts in ${model.currencyCode}`)),
    rp(doc, 'div', { class: 'rp-privacy' }, model.privacy));
  root.appendChild(header);
  // Screen-only guidance: the saved PDF loses background fills unless the
  // browser's "Background graphics" print option is on. Hidden in print via
  // @media print { .rp-print-hint { display: none } }.
  root.appendChild(rp(doc, 'p', { class: 'rp-print-hint' }, 'Tip: enable "Background graphics" in the print dialog to include full colour.'));

  /* 2) Key summary */
  const s = model.summary;
  const grid = rp(doc, 'div', { class: 'rp-summary' });
  const block = (label, value, sub, opts = {}) => {
    const b = rp(doc, 'div', { class: 'rp-sum' + (opts.lead ? ' rp-sum-lead' : '') },
      rp(doc, 'div', { class: 'rp-sum-label' }, label),
      rp(doc, 'div', { class: 'rp-sum-value' }, opts.swatch
        ? rp(doc, 'span', { class: 'rp-inline-cat' }, rp(doc, 'span', { class: 'rp-swatch', style: `background:${opts.swatch}` }), value)
        : value));
    if (sub) b.appendChild(rp(doc, 'div', { class: 'rp-sum-sub' + (opts.tone ? ' tone-' + opts.tone : '') }, sub));
    return b;
  };
  grid.appendChild(block('Total spend', s.totalSpend,
    s.vsPrev ? `${s.vsPrev.text} (was ${s.vsPrev.prevMoney})` : 'No comparable period yet',
    { lead: true, tone: s.vsPrev ? s.vsPrev.dir : null }));
  grid.appendChild(block('Purchases', s.nPurchases, s.vsAvg || null));
  grid.appendChild(s.leading
    ? block('Leading category', s.leading.label, `${s.leading.share} of spend`, { swatch: s.leading.colour })
    : block('Leading category', '-', null));
  grid.appendChild(block('Paid to card', s.paidToCard,
    [s.fees ? `${s.fees} fees & tax` : null, s.refunds ? `${s.refunds} refunds` : null].filter(Boolean).join(' · ') || null));
  root.appendChild(rp(doc, 'section', { class: 'rp-block' }, heading('sum', 'Key summary'), grid));

  /* 3) Spending over time */
  const trendSec = rp(doc, 'section', { class: 'rp-block rp-avoid' }, heading('chart', 'Spending over time'));
  if (model.trend.bars.length) {
    trendSec.appendChild(rp(doc, 'div', { class: 'rp-chart-wrap' }, rpTrendChart(doc, model.trend)));
    const note = model.trend.avgMoney
      ? `Monthly purchases only. The dashed line is your typical month of ${model.trend.avgMoney}. Hatched bars are part-month statements.`
      : 'Monthly purchases only. Hatched bars are part-month statements.';
    trendSec.appendChild(rp(doc, 'p', { class: 'rp-note' }, note));
    // small adjoining figures table
    const tbl = rp(doc, 'table', { class: 'rp-mini' });
    tbl.appendChild(rp(doc, 'thead', {}, rp(doc, 'tr', {}, rp(doc, 'th', {}, 'Month'), rp(doc, 'th', { class: 'num' }, 'Purchases'))));
    const tb = rp(doc, 'tbody');
    for (const b of model.trend.bars) {
      tb.appendChild(rp(doc, 'tr', { class: b.inPeriod ? 'rp-inperiod' : null },
        rp(doc, 'td', {}, b.label + (b.incomplete ? ' (part month)' : '')),
        rp(doc, 'td', { class: 'num' }, b.money)));
    }
    tbl.appendChild(tb);
    trendSec.appendChild(tbl);
  } else {
    trendSec.appendChild(rp(doc, 'p', { class: 'rp-empty' }, 'No monthly spending to chart for this period.'));
  }
  root.appendChild(trendSec);

  /* 4) Spending by category */
  const catSec = rp(doc, 'section', { class: 'rp-block' }, heading('pie', 'Spending by category'));
  if (model.categories.length) {
    const list = rp(doc, 'div', { class: 'rp-cats' });
    const top = model.categories.filter((c) => !c.review);
    const maxAmt = top.length ? Math.max(...top.map((c) => c.shareNum)) : 1;
    for (const c of model.categories) {
      const row = rp(doc, 'div', { class: 'rp-cat rp-avoid' + (c.review ? ' rp-cat-review' : '') },
        rp(doc, 'div', { class: 'rp-cat-name' }, rp(doc, 'span', { class: 'rp-swatch', style: `background:${c.colour}` }), rp(doc, 'span', {}, c.name)),
        rp(doc, 'div', { class: 'rp-cat-bar' }, rp(doc, 'span', { class: 'rp-cat-fill', style: `width:${Math.max(2, (c.shareNum / (maxAmt || 1)) * 100)}%;background:${c.colour}` })),
        rp(doc, 'div', { class: 'rp-cat-amt num' }, c.amount),
        rp(doc, 'div', { class: 'rp-cat-pct num' }, c.share));
      list.appendChild(row);
    }
    catSec.appendChild(list);
    if (model.categories.some((c) => c.review)) {
      catSec.appendChild(rp(doc, 'p', { class: 'rp-note' }, '“To review” groups purchases not yet matched to a category and is shown separately from settled spending.'));
    }
  } else {
    catSec.appendChild(rp(doc, 'p', { class: 'rp-empty' }, 'No purchases in this period.'));
  }
  root.appendChild(catSec);

  /* 5) Merchant insights */
  const merchSec = rp(doc, 'section', { class: 'rp-block' }, heading('store', 'Merchant insights'));
  if (model.merchants.length) {
    const t = rp(doc, 'table', { class: 'rp-table' });
    t.appendChild(rp(doc, 'thead', {}, rp(doc, 'tr', {},
      rp(doc, 'th', {}, 'Merchant'), rp(doc, 'th', {}, 'Category'),
      rp(doc, 'th', { class: 'num' }, 'Txns'), rp(doc, 'th', { class: 'num' }, 'Total'),
      rp(doc, 'th', { class: 'num' }, 'Average'))));
    const tb = rp(doc, 'tbody');
    for (const m of model.merchants) {
      tb.appendChild(rp(doc, 'tr', { class: 'rp-avoid' },
        rp(doc, 'td', { class: 'rp-wrap' }, m.name),
        rp(doc, 'td', { class: 'rp-wrap' }, rpSwatch(doc, m.colour, m.category)),
        rp(doc, 'td', { class: 'num' }, m.count),
        rp(doc, 'td', { class: 'num strong' }, m.amount),
        rp(doc, 'td', { class: 'num' }, m.avg)));
    }
    t.appendChild(tb);
    merchSec.appendChild(rp(doc, 'div', { class: 'rp-table-wrap' }, t));
  } else {
    merchSec.appendChild(rp(doc, 'p', { class: 'rp-empty' }, 'No merchants to show for this period.'));
  }
  root.appendChild(merchSec);

  /* 6) Notable patterns */
  const insSec = rp(doc, 'section', { class: 'rp-block rp-avoid' }, heading('bulb', 'Notable patterns'));
  const items = (model.insights || []).slice();
  if (model.reviewNote) items.push(model.reviewNote);
  if (items.length) {
    const ul = rp(doc, 'ul', { class: 'rp-insights' });
    for (const line of items) ul.appendChild(rp(doc, 'li', {}, line));
    insSec.appendChild(ul);
  } else {
    insSec.appendChild(rp(doc, 'p', { class: 'rp-empty' }, `A calm ${String(model.period).toLowerCase()} - nothing stands out against the usual pattern.`));
  }
  root.appendChild(insSec);

  /* 7) Transaction detail */
  const txSec = rp(doc, 'section', { class: 'rp-block' }, heading('list', 'Transaction detail'));
  txSec.appendChild(rp(doc, 'p', { class: 'rp-scope' }, model.filtersText));
  if (model.txns.length) {
    const t = rp(doc, 'table', { class: 'rp-table rp-tx' });
    t.appendChild(rp(doc, 'thead', {}, rp(doc, 'tr', {},
      rp(doc, 'th', { class: 'nowrap' }, 'Date'), rp(doc, 'th', {}, 'Merchant'),
      rp(doc, 'th', {}, 'Category'), rp(doc, 'th', {}, 'Type'),
      rp(doc, 'th', { class: 'num' }, `Amount (${model.currencyCode})`))));
    const tb = rp(doc, 'tbody');
    for (const r of model.txns) {
      tb.appendChild(rp(doc, 'tr', {},
        rp(doc, 'td', { class: 'nowrap' }, r.date),
        rp(doc, 'td', { class: 'rp-wrap' }, rp(doc, 'div', {}, r.description), r.foreign ? rp(doc, 'div', { class: 'rp-fx' }, r.foreign) : null),
        rp(doc, 'td', { class: 'rp-wrap' }, rpSwatch(doc, r.colour, r.category)),
        rp(doc, 'td', {}, r.kind),
        rp(doc, 'td', { class: 'num' + (r.credit ? ' rp-credit' : '') }, r.amount)));
    }
    t.appendChild(tb);
    txSec.appendChild(rp(doc, 'div', { class: 'rp-table-wrap' }, t));
    txSec.appendChild(rp(doc, 'p', { class: 'rp-note' }, model.txCountText));
  } else {
    txSec.appendChild(rp(doc, 'p', { class: 'rp-empty' }, 'No transactions match the active view.'));
  }
  root.appendChild(txSec);

  /* 8) Footer (repeats each page via fixed positioning) */
  root.appendChild(rp(doc, 'footer', { class: 'rp-footer' },
    rp(doc, 'span', {}, `${model.app} - private report`),
    rp(doc, 'span', {}, 'Data stays on this device.')));

  return root;
}

/* Printable report for the bank Accounts ledger (Phase 1 parity). A dedicated
 * renderer beside renderReport, because a bank report needs its own sections
 * and labels - balances, money in/out, per-account breakdown, reconciliation
 * and a running-balance transaction table - not spending categories. It reuses
 * every .rp-* print style, so it prints light-on-white, paginates, and repeats
 * table headers exactly like the card report. Same DOM-standard, escape-safe
 * construction: every dynamic value is inserted as text, never markup. */
export function renderBankReport(doc, model) {
  const root = rp(doc, 'div', { class: 'rp' });
  const heading = (iconName, text) => rp(doc, 'h2', { class: 'rp-h' }, reportIconEl(doc, iconName, 18), rp(doc, 'span', {}, text));

  /* 1) Header */
  root.appendChild(rp(doc, 'header', { class: 'rp-header' },
    rp(doc, 'div', { class: 'rp-brand' }, reportIconEl(doc, 'card', 22), rp(doc, 'span', { class: 'rp-brand-name' }, model.app)),
    rp(doc, 'h1', { class: 'rp-title' }, 'Account activity report'),
    rp(doc, 'div', { class: 'rp-meta' },
      rp(doc, 'span', { class: 'rp-meta-period' }, `Scope: ${model.scope}`),
      rp(doc, 'span', { class: 'rp-dot' }, '\u00b7'),
      rp(doc, 'span', {}, `Generated ${model.generated}`),
      rp(doc, 'span', { class: 'rp-dot' }, '\u00b7'),
      rp(doc, 'span', {}, `Amounts in ${model.currencyCode}`)),
    rp(doc, 'div', { class: 'rp-privacy' }, model.privacy)));
  // Screen-only guidance: the saved PDF loses background fills unless the
  // browser's "Background graphics" print option is on. Hidden in print.
  root.appendChild(rp(doc, 'p', { class: 'rp-print-hint' }, 'Tip: enable "Background graphics" in the print dialog to include full colour.'));

  /* 2) Key summary */
  const s = model.summary;
  const grid = rp(doc, 'div', { class: 'rp-summary' });
  const block = (label, value, sub, lead) => {
    const b = rp(doc, 'div', { class: 'rp-sum' + (lead ? ' rp-sum-lead' : '') },
      rp(doc, 'div', { class: 'rp-sum-label' }, label),
      rp(doc, 'div', { class: 'rp-sum-value' }, value));
    if (sub) b.appendChild(rp(doc, 'div', { class: 'rp-sum-sub' }, sub));
    return b;
  };
  grid.appendChild(block(s.closingLabel, s.closingBalance, s.accountsSub, true));
  grid.appendChild(block('Money in', s.moneyIn, 'Excludes transfers between your own accounts'));
  grid.appendChild(block('Money out', s.moneyOut, 'Excludes transfers between your own accounts'));
  grid.appendChild(block('Net movement', s.net, s.internalNote));
  root.appendChild(rp(doc, 'section', { class: 'rp-block' }, heading('sum', 'Account summary'), grid));
  // C3 (S20): the USD-separateness note, directly beneath the summary section.
  if (model.usdNote) root.appendChild(rp(doc, 'p', { class: 'rp-note' }, model.usdNote));

  /* 3) Per-account breakdown (only when more than one account) */
  if (model.accounts && model.accounts.length > 1) {
    const t = rp(doc, 'table', { class: 'rp-table' });
    t.appendChild(rp(doc, 'thead', {}, rp(doc, 'tr', {},
      rp(doc, 'th', {}, 'Account'), rp(doc, 'th', { class: 'num' }, 'Transactions'),
      rp(doc, 'th', { class: 'num' }, 'Money in'), rp(doc, 'th', { class: 'num' }, 'Money out'),
      rp(doc, 'th', { class: 'num' }, 'Closing balance'))));
    const tb = rp(doc, 'tbody');
    for (const ac of model.accounts) {
      tb.appendChild(rp(doc, 'tr', { class: 'rp-avoid' },
        rp(doc, 'td', {}, ac.account), rp(doc, 'td', { class: 'num' }, ac.count),
        rp(doc, 'td', { class: 'num' }, ac.moneyIn), rp(doc, 'td', { class: 'num' }, ac.moneyOut),
        rp(doc, 'td', { class: 'num strong' }, ac.closingBalance)));
    }
    t.appendChild(tb);
    root.appendChild(rp(doc, 'section', { class: 'rp-block' }, heading('pie', 'By account'),
      rp(doc, 'div', { class: 'rp-table-wrap' }, t)));
  }

  /* 4) Reconciliation - the trust line, per imported statement */
  const recSec = rp(doc, 'section', { class: 'rp-block' }, heading('sum', 'Reconciliation'));
  if (model.statements && model.statements.length) {
    const t = rp(doc, 'table', { class: 'rp-table' });
    t.appendChild(rp(doc, 'thead', {}, rp(doc, 'tr', {},
      rp(doc, 'th', {}, 'Account'), rp(doc, 'th', {}, 'Period'),
      rp(doc, 'th', { class: 'num' }, 'Transactions'), rp(doc, 'th', { class: 'num' }, 'Closing balance'),
      rp(doc, 'th', {}, 'Result'))));
    const tb = rp(doc, 'tbody');
    for (const st of model.statements) {
      tb.appendChild(rp(doc, 'tr', { class: 'rp-avoid' },
        rp(doc, 'td', {}, st.account), rp(doc, 'td', { class: 'rp-wrap' }, st.period),
        rp(doc, 'td', { class: 'num' }, st.count), rp(doc, 'td', { class: 'num' }, st.closingBalance),
        rp(doc, 'td', {}, st.reconciled ? '\u2713 balance reconciles' : st.reconNote)));
    }
    t.appendChild(tb);
    recSec.appendChild(rp(doc, 'div', { class: 'rp-table-wrap' }, t));
    if (model.reconNote) recSec.appendChild(rp(doc, 'p', { class: 'rp-note' }, model.reconNote));
  } else {
    recSec.appendChild(rp(doc, 'p', { class: 'rp-empty' }, 'No imported statements to reconcile.'));
  }
  root.appendChild(recSec);

  /* 5) Transaction detail with the running balance */
  const txSec = rp(doc, 'section', { class: 'rp-block' }, heading('list', 'Transaction detail'));
  txSec.appendChild(rp(doc, 'p', { class: 'rp-scope' }, model.filtersText));
  if (model.txns.length) {
    const t = rp(doc, 'table', { class: 'rp-table rp-tx' });
    t.appendChild(rp(doc, 'thead', {}, rp(doc, 'tr', {},
      rp(doc, 'th', { class: 'nowrap' }, 'Date'), rp(doc, 'th', {}, 'Account'),
      rp(doc, 'th', {}, 'Counterparty'), rp(doc, 'th', {}, 'Flow'),
      rp(doc, 'th', { class: 'num' }, `Amount (${model.currencyCode})`), rp(doc, 'th', { class: 'num' }, 'Balance'))));
    const tb = rp(doc, 'tbody');
    for (const r of model.txns) {
      tb.appendChild(rp(doc, 'tr', {},
        rp(doc, 'td', { class: 'nowrap' }, r.date),
        rp(doc, 'td', { class: 'nowrap' }, r.account),
        rp(doc, 'td', { class: 'rp-wrap' }, r.description),
        rp(doc, 'td', {}, r.flow),
        rp(doc, 'td', { class: 'num' + (r.credit ? ' rp-credit' : '') }, r.amount),
        rp(doc, 'td', { class: 'num' }, r.balance)));
    }
    t.appendChild(tb);
    txSec.appendChild(rp(doc, 'div', { class: 'rp-table-wrap' }, t));
    txSec.appendChild(rp(doc, 'p', { class: 'rp-note' }, model.txCountText));
  } else {
    txSec.appendChild(rp(doc, 'p', { class: 'rp-empty' }, 'No account transactions to show.'));
  }
  root.appendChild(txSec);

  /* 6) Footer (repeats each page via fixed positioning) */
  root.appendChild(rp(doc, 'footer', { class: 'rp-footer' },
    rp(doc, 'span', {}, `${model.app} - private report`),
    rp(doc, 'span', {}, 'Data stays on this device.')));

  return root;
}


/* Printable report for the combined Overview (Phase 3 roll-up). A dedicated
 * renderer beside renderReport and renderBankReport so printing from the
 * Overview tab yields an OVERVIEW report - net cash flow, income, external
 * spending, the two balances shown side by side, an income/spending trend and
 * the genuine external outflows - rather than the Accounts activity report the
 * Overview tab used to fall through to (the mismatch this fixes). It reuses
 * every .rp-* print style and the same escape-safe, text-only construction:
 * every dynamic value is inserted as text, never markup. All roll-up figures
 * are base-currency (USD accounts are surfaced on their own elsewhere and are
 * not blended into these headline numbers), so this pass introduces no new
 * currency handling. */
export function renderOverviewReport(doc, model) {
  const root = rp(doc, 'div', { class: 'rp' });
  const heading = (iconName, text) => rp(doc, 'h2', { class: 'rp-h' }, reportIconEl(doc, iconName, 18), rp(doc, 'span', {}, text));

  /* 1) Header */
  root.appendChild(rp(doc, 'header', { class: 'rp-header' },
    rp(doc, 'div', { class: 'rp-brand' }, reportIconEl(doc, 'card', 22), rp(doc, 'span', { class: 'rp-brand-name' }, model.app)),
    rp(doc, 'h1', { class: 'rp-title' }, 'Overview report'),
    rp(doc, 'div', { class: 'rp-meta' },
      rp(doc, 'span', { class: 'rp-meta-period' }, `Period: ${model.period}`),
      rp(doc, 'span', { class: 'rp-dot' }, '\u00b7'),
      rp(doc, 'span', {}, `Generated ${model.generated}`),
      rp(doc, 'span', { class: 'rp-dot' }, '\u00b7'),
      rp(doc, 'span', {}, `Amounts in ${model.currencyCode}`)),
    rp(doc, 'div', { class: 'rp-privacy' }, model.privacy)));
  // Screen-only guidance: the saved PDF loses background fills unless the
  // browser's "Background graphics" print option is on. Hidden in print.
  root.appendChild(rp(doc, 'p', { class: 'rp-print-hint' }, 'Tip: enable "Background graphics" in the print dialog to include full colour.'));

  /* 2) Money at a glance */
  const s = model.summary;
  const grid = rp(doc, 'div', { class: 'rp-summary' });
  const block = (label, value, sub, lead) => {
    const b = rp(doc, 'div', { class: 'rp-sum' + (lead ? ' rp-sum-lead' : '') },
      rp(doc, 'div', { class: 'rp-sum-label' }, label),
      rp(doc, 'div', { class: 'rp-sum-value' }, value));
    if (sub) b.appendChild(rp(doc, 'div', { class: 'rp-sum-sub' }, sub));
    return b;
  };
  grid.appendChild(block('Net cash flow', s.netCashFlow, s.netSub, true));
  grid.appendChild(block('Money in', s.moneyIn, 'External income; transfers between your own accounts excluded'));
  grid.appendChild(block('Money out', s.moneyOut, s.moneyOutSub));
  grid.appendChild(block('Cash on hand', s.cashOnHand, model.hasCard ? s.cardOwedSub : null));
  root.appendChild(rp(doc, 'section', { class: 'rp-block' }, heading('sum', 'Money at a glance'), grid));
  // C3 (S20): the USD-separateness note, directly beneath the summary section.
  if (model.usdNote) root.appendChild(rp(doc, 'p', { class: 'rp-note' }, model.usdNote));

  /* 3) Income and spending over time */
  const trendSec = rp(doc, 'section', { class: 'rp-block rp-avoid' },
    heading('chart', model.hasCard ? 'Income and spending over time' : 'Cash flow over time'));
  if (model.trend.length) {
    const t = rp(doc, 'table', { class: 'rp-mini' });
    t.appendChild(rp(doc, 'thead', {}, rp(doc, 'tr', {},
      rp(doc, 'th', {}, 'Month'), rp(doc, 'th', { class: 'num' }, 'Money in'),
      rp(doc, 'th', { class: 'num' }, 'Spending'), rp(doc, 'th', { class: 'num' }, 'Net'))));
    const tb = rp(doc, 'tbody');
    for (const r of model.trend) {
      tb.appendChild(rp(doc, 'tr', {},
        rp(doc, 'td', {}, r.month),
        rp(doc, 'td', { class: 'num' }, r.income),
        rp(doc, 'td', { class: 'num' }, r.spending),
        rp(doc, 'td', { class: 'num' }, r.net)));
    }
    t.appendChild(tb);
    trendSec.appendChild(t);
    trendSec.appendChild(rp(doc, 'p', { class: 'rp-note' }, model.trendNote));
  } else {
    trendSec.appendChild(rp(doc, 'p', { class: 'rp-empty' }, 'No money movement to chart for this period.'));
  }
  root.appendChild(trendSec);

  /* 4) Where money actually went */
  const outSec = rp(doc, 'section', { class: 'rp-block' }, heading('list', 'Where money actually went'));
  if (model.outflows.length) {
    const t = rp(doc, 'table', { class: 'rp-table' });
    t.appendChild(rp(doc, 'thead', {}, rp(doc, 'tr', {},
      rp(doc, 'th', {}, 'Paid to'), rp(doc, 'th', { class: 'num' }, 'Payments'),
      rp(doc, 'th', { class: 'num' }, 'Total'))));
    const tb = rp(doc, 'tbody');
    for (const g of model.outflows) {
      tb.appendChild(rp(doc, 'tr', { class: 'rp-avoid' },
        rp(doc, 'td', { class: 'rp-wrap' }, g.label),
        rp(doc, 'td', { class: 'num' }, g.count),
        rp(doc, 'td', { class: 'num strong' }, g.amount)));
    }
    t.appendChild(tb);
    outSec.appendChild(rp(doc, 'div', { class: 'rp-table-wrap' }, t));
    outSec.appendChild(rp(doc, 'p', { class: 'rp-note' }, 'The largest genuine outflows to people and services outside your own accounts.'));
  } else {
    outSec.appendChild(rp(doc, 'p', { class: 'rp-empty' }, 'No external outflows in this period.'));
  }
  root.appendChild(outSec);

  /* 5) Footer (repeats each page via fixed positioning) */
  root.appendChild(rp(doc, 'footer', { class: 'rp-footer' },
    rp(doc, 'span', {}, `${model.app} - private report`),
    rp(doc, 'span', {}, 'Data stays on this device.')));

  return root;
}

/* ===========================================================================
 * 8) Encrypted history file  (export / import; AES-GCM + PBKDF2)
 * ---------------------------------------------------------------------------
 * One file carries the transactions and the small change metadata needed to
 * merge cleanly. The passphrase is set once and supplied again on import.
 * A passphrase cannot be recovered; a wrong one simply fails to open the file.
 * ======================================================================== */

// v1 carried card transactions only. v2 also carries the bank ledger and the
// card-statement records, so a device move keeps the WHOLE picture, not just
// card transactions. Both magics import: a v1 file simply has no bank/card
// bundle, so nothing bank-side is brought in (backward compatible).
const HISTORY_MAGIC = 'CCAHIST1';
const HISTORY_MAGIC_V2 = 'CCAHIST2';
// PBKDF2 work factor for the encrypted history file. Written into every
// exported envelope (iterations) and read back at import, so this value can be
// raised over time without breaking files created with an older count: each
// file is always decrypted with whatever count it was actually encrypted with.
const PBKDF2_ITERATIONS_DEFAULT = 600000;

function getCrypto() {
  const c = (typeof globalThis !== 'undefined' && globalThis.crypto) ? globalThis.crypto : null;
  if (!c || !c.subtle) throw new Error('WebCrypto is not available in this environment.');
  return c;
}
function b64(bytes) { let s = ''; for (const b of bytes) s += String.fromCharCode(b); return btoaSafe(s); }
function unb64(str) { const s = atobSafe(str); const a = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i); return a; }
function btoaSafe(s) { return (typeof btoa === 'function') ? btoa(s) : Buffer.from(s, 'binary').toString('base64'); }
function atobSafe(s) { return (typeof atob === 'function') ? atob(s) : Buffer.from(s, 'base64').toString('binary'); }

async function deriveKey(passphrase, salt, iterations) {
  const crypto = getCrypto();
  const enc = new TextEncoder();
  const base = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

// `bundle` (optional, backward compatible) carries the bank ledger and the
// card-statement records alongside the card transactions, so all three ledgers
// travel in the one encrypted file. Old callers that pass three arguments still
// work: the bundle defaults to empty and the file is a valid card-only export.
export async function exportHistory(records, meta, passphrase, bundle = {}) {
  const crypto = getCrypto();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, PBKDF2_ITERATIONS_DEFAULT);
  const payload = new TextEncoder().encode(JSON.stringify({
    magic: HISTORY_MAGIC_V2, exportedAt: new Date().toISOString(), meta: meta || {}, records,
    bank: {
      transactions: bundle.bankRecords || [],
      statements: bundle.bankStatements || [],
      cardStatements: bundle.cardStatements || [],
      myAccounts: bundle.myAccounts || [],
      cardAccounts: bundle.cardAccounts || [],
    },
  }));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, payload));
  return JSON.stringify({ format: HISTORY_MAGIC, kdf: 'PBKDF2-SHA256', iterations: PBKDF2_ITERATIONS_DEFAULT, salt: b64(salt), iv: b64(iv), data: b64(cipher) });
}

export async function importHistory(fileText, passphrase) {
  const crypto = getCrypto();
  let env;
  try { env = JSON.parse(fileText); } catch { throw new Error('This does not look like a history file.'); }
  if (!env || env.format !== HISTORY_MAGIC) throw new Error('This does not look like a history file.');
  // Read the iteration count the file was actually encrypted with. A genuinely
  // old file that predates this field, or one carrying a missing/invalid value,
  // falls back to the default so the count is never undefined or NaN.
  const fileIters = Number(env.iterations);
  const iterations = (Number.isFinite(fileIters) && fileIters > 0) ? fileIters : PBKDF2_ITERATIONS_DEFAULT;
  const key = await deriveKey(passphrase, unb64(env.salt), iterations);
  let plain;
  try {
    plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(env.iv) }, key, unb64(env.data));
  } catch {
    throw new Error('That passphrase did not open the file. Check it and try again.');
  }
  const obj = JSON.parse(new TextDecoder().decode(plain));
  const bank = obj.bank || {};
  return {
    records: obj.records || [], meta: obj.meta || {}, exportedAt: obj.exportedAt,
    bank: {
      transactions: bank.transactions || [], statements: bank.statements || [],
      cardStatements: bank.cardStatements || [],
      myAccounts: bank.myAccounts || [], cardAccounts: bank.cardAccounts || [],
    },
  };
}

/* ===========================================================================
 * 9) CSV export
 * ======================================================================== */

// Shared CSV field escaper: quote a field only when it contains a comma, double
// quote or newline, doubling any embedded quote. This is the exact rule the
// local `esc` closures in toCSV/bankToCSV use; exported so other export-plumbing
// (the Overview combined CSV in data-export.js) reuses the identical helper
// rather than a weaker hand-rolled one, and the two can never drift.
export function csvEscape(v) {
  const s = String(v == null ? '' : v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export function toCSV(rows, currency = 'JMD') {
  const head = ['Date', 'Description', 'Category', 'Type', 'Statement', `Amount (${currency})`, 'Foreign'];
  const lines = [head.join(',')];
  for (const r of rows) {
    const desc = r.displayName || r.description;
    lines.push([r.date, desc, r.category, r.kind, r.source_file, r.amount.toFixed(2), r.foreign].map(csvEscape).join(','));
  }
  return lines.join('\n');
}

// The Detailed counterpart to toCSV: every pipeline stage side by side, for
// auditing the categorisation/merchant-cleaning logic itself, rather than
// for using the data elsewhere. Additive - toCSV above is untouched, so
// every existing "Clean" export keeps behaving exactly as before.
export function toDetailedCSV(rows, currency = 'JMD') {
  const head = [
    'Date', 'Reference', 'Raw Description', 'Cleaned Description', 'Merchant',
    'Merchant Group', 'Category', 'Category Confidence', 'Type', 'Statement',
    `Amount (${currency})`, 'Foreign',
  ];
  const lines = [head.join(',')];
  for (const r of rows) {
    lines.push([
      r.date, r.ref || '', r.raw_description, r.description, r.displayName || '',
      r.merchantGroup || '', r.category, r.confidence, r.kind, r.source_file,
      r.amount.toFixed(2), r.foreign,
    ].map(csvEscape).join(','));
  }
  return lines.join('\n');
}

// Shared multi-key sort for bank-ledger record lists: account (alphabetical),
// then date (chronological), then seq (a stable tiebreaker for same-day
// rows). Previously written out identically, twice, inside bankToCSV and
// bankToDetailedCSV.
export function sortBankRecords(records) {
  return (records || []).slice().sort((a, b) =>
    String(a.account).localeCompare(String(b.account))
    || (a.date < b.date ? -1 : a.date > b.date ? 1 : 0)
    || ((a.seq == null ? 0 : a.seq) - (b.seq == null ? 0 : b.seq)));
}

// CSV for the bank Accounts ledger. A separate shape from the card CSV because
// the columns differ (flow direction, running balance, owning account) and the
// two ledgers are kept apart (D1). Pure and testable, mirroring toCSV. Internal
// transfers are marked so a spreadsheet can exclude them the way the app does.
export function bankToCSV(records, currency = 'JMD') {
  // A Currency column is included because a mixed export can hold both JMD and
  // USD accounts. The Amount and Running balance are each in the row's own
  // currency; a spreadsheet must not sum a JMD and a USD column together.
  const head = ['Date', 'Account', 'Currency', 'Counterparty', 'Flow', 'Amount', 'Running balance'];
  const rows = sortBankRecords(records);
  const lines = [head.join(',')];
  for (const r of rows) {
    const flow = r.internalTransfer ? 'Internal transfer' : (r.direction === 'in' ? 'Money in' : 'Money out');
    const signed = (r.direction === 'in' ? '' : '-') + Math.abs(Number(r.amount) || 0).toFixed(2);
    const bal = r.balanceAfter == null ? '' : Number(r.balanceAfter).toFixed(2);
    // Confirmed via a real export: normaliseCounterparty's own fallback is the
    // literal string 'Unknown', which is non-empty and therefore used to WIN
    // an `||` chain even when it is the worst answer available - a system
    // showing "Unknown" in Description while the perfectly informative type
    // text sat unused right next to it. This guard skips that placeholder and
    // falls through to the banner-only cleanup, then to the statement's own
    // type text, exactly as it did before counterpartyLabel was introduced.
    const hasRealLabel = r.counterpartyLabel && r.counterpartyLabel !== 'Unknown';
    const cp = hasRealLabel ? r.counterpartyLabel : (cleanBankCounterparty(r.description) || r.type || '');
    // Clean reader actually needs (Internal transfer / Money in / Money out).
    lines.push([r.date, r.account || '', r.currency || currency, cp, flow, signed, bal].map(csvEscape).join(','));
  }
  return lines.join('\n');
}

// The Detailed counterpart to bankToCSV. Mirrors toDetailedCSV's shape for
// the card side: the raw statement text, the curated counterparty, and the
// same grouping key (counterpartyKey) analyseBankActivity/bankCounterpartyGroups
// already use internally, so a person can see exactly how a row was grouped.
export function bankToDetailedCSV(records, currency = 'JMD') {
  const head = [
    'Date', 'Account', 'Currency', 'Raw Description', 'Counterparty',
    'Counterparty Group', 'Internal Transfer', 'Type', 'Flow', 'Amount',
    'Running Balance', 'Statement',
  ];
  const rows = sortBankRecords(records);
  const lines = [head.join(',')];
  for (const r of rows) {
    const flow = r.internalTransfer ? 'Internal transfer' : (r.direction === 'in' ? 'Money in' : 'Money out');
    const signed = (r.direction === 'in' ? '' : '-') + Math.abs(Number(r.amount) || 0).toFixed(2);
    const bal = r.balanceAfter == null ? '' : Number(r.balanceAfter).toFixed(2);
    const hasRealLabel = r.counterpartyLabel && r.counterpartyLabel !== 'Unknown';
    const cp = hasRealLabel ? r.counterpartyLabel : (cleanBankCounterparty(r.description) || r.type || '');
    lines.push([
      r.date, r.account || '', r.currency || currency, r.description || '',
      cp, r.counterpartyKey || '', r.internalTransfer ? 'Yes' : 'No',
      r.type || '', flow, signed, bal, r.source_file || '',
    ].map(csvEscape).join(','));
  }
  return lines.join('\n');
}

// Contribute-back export (Manage Data): a deliberately minimal CSV of
// merchants the app could not identify AT ALL. This is narrower than "needs
// review" - it deliberately EXCLUDES a known merchant the app is merely
// uncertain about (e.g. WiPay, confidence 0.4, reviewRequired true in
// jamaica-merchants.json). That ambiguity is a structural fact about how the
// merchant itself works (a payment processor whose underlying business the
// descriptor never reveals), already captured in the merchant-intelligence
// file - sending it back would be noise, not a coverage gap. Only a row that
// fell all the way through categorise()'s last-resort branches with
// confidence 0 (genuinely unmatched by any merchant entry, keyword or head
// rule) counts here.
//
// Grouped by merchantRuleKeyFromDescription - the SAME key buildRows() already
// uses for merchant overrides and renderRecurring()'s drill-down - so "one
// merchant" means the same thing here it means everywhere else in the app,
// rather than a hand-rolled second definition that could drift.
//
// Whole history (the caller passes state.rows, not periodRows()), since this
// is about total merchant coverage, not a snapshot of one period.
//
// Deliberately minimal, by design, not by omission: only the original
// statement text and how many times it appeared. No amount, no date, no
// account - nothing that turns a vocabulary gap into a financial disclosure.
export function buildUnknownMerchantsCSV(rows, fallback = 'Uncategorised') {
  const groups = new Map();
  for (const r of (rows || [])) {
    // Was its own hand-written re-expression of exactly what attentionItems()
    // already checked (confidence===0, implicitly always paired with category
    // ===fallback by categorise()'s construction). Now reads the one shared
    // predicate, so a future change to categorise()'s fallback branch only
    // ever needs updating in isUnrecognised, not re-audited across every
    // place that used to ask the same question independently.
    if (!isUnrecognised(r, fallback)) continue;
    const key = merchantRuleKeyFromDescription(r.raw_description) || r.raw_description;
    if (!groups.has(key)) groups.set(key, { description: r.raw_description, count: 0 });
    groups.get(key).count += 1;
  }
  const list = [...groups.values()].sort((a, b) => b.count - a.count);
  const lines = [['Description', 'Occurrences'].join(',')];
  for (const g of list) lines.push([g.description, g.count].map(csvEscape).join(','));
  return { csv: lines.join('\n'), count: list.length };
}

/* ===========================================================================
 *  Print-model orchestration + report driver  (Stage 5 of the split)
 *  --------------------------------------------------------------------------- 
/* The ONE factory-wrapped group in this file. Everything above is a plain, bootUI-free export; this section is different by nature. These seven functions build the plain data models that the three renderers above (renderReport / renderBankReport / renderOverviewReport) turn into a printed page, and they drive the actual print flow - so they need live bootUI state (the current view, the selected period, the classified bank rows, the formatting helpers). That is why they take a ctx, exactly like the accounts-render / category-picker / manage-data / data-export / cards-render factories, while the pure serialisers they sit beside do not. They were the print-model group deferred at Stage 3c-i: buildPrintModel needed buildInsights / prevLabel / histMonthlyAverage, which only became clean factory exports once the Cards render tree moved (Stage 4). With that done, the group lands HERE rather than in a new file, because it exists specifically to feed this file's own renderers - so renderReport, renderBankReport, renderOverviewReport, capForPrint and detectIncompleteMonth resolve as plain in-file references (module-scope function declarations, hoisted, reachable from inside this factory's closure), and only the cross-ledger analysers (analyseBankActivity / analyseCombinedOverview / analyseRollup) needed adding to the read-statements import above. currentBankViewRows stays internal to the factory but is also returned, so app.js can hand it to the data-export factory (exportCurrentCSV calls it), mirroring how it was passed by reference before the move. printReport, buildReportForCurrentView and exitPrint are returned for 
 *  ======================================================================== */
export function createPrintReports(ctx) {
  requireCtx(ctx, [
    'state', '$', 'el', 'toast', 'iconX', 'toggleExportMenu', 'bankRecordsInPeriod',
    'resolved', 'analysis', 'periodRows', 'visibleRows', 'allMonths', 'FALLBACK',
    'isReview', 'catColour', 'money0', 'moneyShort', 'pct', 'monthLabel', 'monthShort',
    'prevLabel', 'histMonthlyAverage', 'buildInsights', 'classifiedBank', 'bankMoney',
    'cleanCounterparty',
  ], 'createPrintReports');
  const {
    state, $, el, toast, iconX, toggleExportMenu, bankRecordsInPeriod,
    resolved, analysis, periodRows, visibleRows, allMonths, FALLBACK,
    isReview, catColour, money0, moneyShort, pct, monthLabel, monthShort,
    prevLabel, histMonthlyAverage, buildInsights, classifiedBank, bankMoney,
    cleanCounterparty,
  } = ctx;

  // Build the report for whichever ledger is on screen and return true if it was
  // populated. Shared by the Export menu AND the browser's own Ctrl+P (via the
  // beforeprint listener in wireChrome), so both build the correct report - the
  // fix for a raw Ctrl+P producing a blank page because nothing built the report.
  function buildReportForCurrentView() {
    // Three tabs, three reports. The Overview tab must print an OVERVIEW report
    // (the combined roll-up), the Accounts tab the account-activity report, and
    // the Cards tab the spending report. Previously Overview fell into the same
    // branch as Accounts and silently printed the Accounts report - the mismatch
    // this fixes. Overview and Accounts both need bank data; Cards needs card
    // data.
    const overviewView = state.view === 'overview' && state.bankRecords.length > 0;
    const accountsView = state.view === 'accounts' && state.bankRecords.length > 0;
    const bankView = overviewView || accountsView;
    if (bankView ? !state.bankRecords.length : !state.records.length) return false;
    const host = $('#print-report'); if (!host) return false;
    host.textContent = '';
    // Always-visible way back that lives in the on-screen report but is excluded
    // from the printed page / saved PDF (see .report-close in styles.css).
    host.appendChild(el('button', { class: 'report-close', 'aria-label': 'Back to dashboard', onclick: exitPrint },
      el('span', { class: 'report-close-x', html: iconX() }),
      el('span', {}, 'Back to dashboard')));
    try {
      const node = overviewView ? renderOverviewReport(document, buildOverviewPrintModel())
        : accountsView ? renderBankReport(document, buildBankPrintModel())
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
    if (!buildReportForCurrentView()) { toast('Add a statement first, then create a report.'); return; }
    setTimeout(() => window.print(), 60);
  }

  // Rows currently on screen in the Accounts view: classified for internal
  // transfers, narrowed to the selected account when one is chosen, newest
  // first - so the report and CSV match exactly what the person is looking at.
  function currentBankViewRows() {
    // Scoped to the shared reporting window so "Current view" CSV matches
    // exactly what the Accounts tab is showing under the active period.
    const recs = bankRecordsInPeriod(classifiedBank());
    const one = state.bankAccount && state.bankAccount !== 'all';
    return (one ? recs.filter((r) => r.account === state.bankAccount) : recs);
  }

  /* Assemble the plain data model the bank report renders from. Every figure
   * comes from the same analyseBankActivity the Accounts view uses, so the
   * report and the live screen can never disagree. */
  function buildBankPrintModel() {
    const recs = classifiedBank();
    const a = analyseBankActivity(recs);
    const multi = a.accounts.length > 1;
    const one = state.bankAccount && state.bankAccount !== 'all';
    const scope = one ? `Account ${state.bankAccount}` : (multi ? `All accounts (${a.accounts.length})` : `Account ${a.accounts[0] ? a.accounts[0].account : '\u2014'}`);

    const stmts = (state._bankStatements || []).slice()
      .sort((x, y) => String(x.account).localeCompare(String(y.account)) || String(x.period).localeCompare(String(y.period)))
      .map((st) => ({
        account: st.account || '\u2014', period: st.period || st.source_file,
        count: String(st.count == null ? '' : st.count),
        closingBalance: st.closingBalance == null ? '\u2014' : bankMoney(st.closingBalance),
        reconciled: !!st.reconciled, reconNote: st.reconNote || 'balance did not reconcile',
      }));
    const allReconciled = stmts.length && stmts.every((st) => st.reconciled);

    const viewRows = one ? recs.filter((r) => r.account === state.bankAccount) : recs;
    const txns = viewRows.slice().sort((x, y) => (x.date < y.date ? 1 : x.date > y.date ? -1 : 0)).map((r) => ({
      date: r.date, account: r.account || '\u2014',
      description: cleanCounterparty(r.description) || r.type || '\u2014',
      flow: r.internalTransfer ? 'Internal' : (r.direction === 'in' ? 'In' : 'Out'),
      // Each row is shown in its OWN currency, exactly as the live Accounts
      // transaction table does (bankMoney(r.amount, r.currency)). A USD row was
      // printing with a J$ prefix on a correct USD number - a mislabel, not a
      // wrong figure. No amount is converted or summed here; only the symbol
      // now matches the row's currency.
      amount: (r.direction === 'in' ? '+' : '') + bankMoney(r.amount, r.currency), credit: r.direction === 'in',
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
      usdNote: (a.foreignAccounts && a.foreignAccounts.length)
        ? 'A USD account exists on this device and is shown separately. Its balance is not included in these base-currency totals.'
        : null,
      summary: {
        closingLabel: multi ? 'Total cash on hand' : 'Cash on hand',
        closingBalance: a.closingBalance == null ? '\u2014' : bankMoney(a.closingBalance),
        accountsSub: multi ? `Across ${a.accounts.length} accounts` : null,
        moneyIn: bankMoney(a.cashIn), moneyOut: bankMoney(a.cashOut),
        net: (a.net >= 0 ? '+' : '') + bankMoney(a.net),
        internalNote: `${bankMoney(a.internalOut)} moved between your own accounts (excluded above).`,
      },
      // Per-account rows are each shown in the account's OWN currency, matching
      // the live "By account" section (bankMoney(ac.cashIn, cur) etc.). A USD
      // account's own money in/out/closing are pure USD figures computed only
      // from that account's rows - never blended into the JMD headline above,
      // which analyseBankActivity sums from base-currency accounts only. This
      // fix corrects the symbol, not the number.
      accounts: a.accounts.map((ac) => ({
        account: ac.account, count: String(ac.n),
        moneyIn: bankMoney(ac.cashIn, ac.currency), moneyOut: bankMoney(ac.cashOut, ac.currency),
        closingBalance: ac.closingBalance == null ? '\u2014' : bankMoney(ac.closingBalance, ac.currency),
      })),
      statements: stmts,
      reconNote: stmts.length
        ? (allReconciled
          ? 'Every imported statement reconciles: opening balance plus each transaction reaches the printed closing balance to the cent.'
          : 'Some statements did not fully reconcile. The result column shows the first difference found.')
        : null,
      filtersText: one ? `Showing account ${state.bankAccount} only.` : 'Showing every imported account.',
      txns,
      txCountText: `${txns.length} transaction${txns.length === 1 ? '' : 's'} shown \u00b7 amounts in ${state.cfg.currency.code}. Internal rows are transfers between your own accounts.`,
    };
  }

  /* Assemble the plain data model the Overview report renders from. It reads
   * the SAME period-scoped roll-up the Overview screen uses - bank rows narrowed
   * to the shared window, card spend from the same period analysis() - so the
   * printed Overview matches what is on screen, and it is an Overview report,
   * not the Accounts report that used to print from this tab. Roll-up headline
   * figures are base-currency by construction, so no currency handling changes
   * here (the USD-in-print gap stays separately tracked). */
  function buildOverviewPrintModel() {
    const recs = bankRecordsInPeriod(classifiedBank());
    let cardSummary = null, cardSpendTotal = 0, cardSpendByMonth = {};
    if (state.records.length) {
      const ca = analysis();
      if (ca) {
        cardSummary = { total_spend: ca.total_spend, n_transactions: ca.n_transactions };
        cardSpendTotal = ca.total_spend;
        cardSpendByMonth = Object.assign({}, ca.by_month);
      }
    }
    const ov = analyseCombinedOverview({ bankRecords: recs, cardStatements: state._cardStatements || [], cardSummary });
    const roll = analyseRollup({ bankRecords: recs, cardSpendTotal, cardSpendByMonth, cardStatements: state._cardStatements || [] });
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
      usdNote: (roll.foreignAccounts && roll.foreignAccounts.length)
        ? 'A USD account exists on this device and is shown separately. Its balance is not included in these base-currency totals.'
        : null,
      summary: {
        netCashFlow: (roll.netCashFlow >= 0 ? '+' : '') + bankMoney(roll.netCashFlow),
        netSub: roll.netCashFlow >= 0 ? 'More came in than went out' : 'More went out than came in',
        moneyIn: bankMoney(roll.income),
        moneyOut: bankMoney(roll.externalSpending),
        moneyOutSub: roll.hasCard
          ? `${bankMoney(roll.bankExternalOut)} from your bank account + ${bankMoney(roll.cardSpend)} on your card`
          : 'External spending; transfers between your own accounts excluded',
        cashOnHand: roll.cashPosition == null ? '\u2014' : bankMoney(roll.cashPosition),
        cardOwedSub: roll.cardOwed == null ? 'No card balance yet'
          : `${bankMoney(roll.cardOwed)} owed on card (shown separately, never netted)`,
      },
      trend: (roll.trend || []).map((tr) => ({
        month: tr.month,
        income: bankMoney(tr.income),
        spending: bankMoney(tr.spending),
        net: (tr.net >= 0 ? '+' : '') + bankMoney(tr.net),
      })),
      trendNote: roll.hasCard
        ? 'Spending each month is money leaving your accounts plus card purchases. Own-account transfers and card payments are excluded, so nothing is counted twice.'
        : 'Money out each month, with transfers between your own accounts excluded.',
      outflows: (ov.topOutflows || []).map((g) => ({
        label: cleanCounterparty(g.label), count: String(g.count), amount: bankMoney(g.moneyOut),
      })),
    };
  }

  // Unconditionally restore the dashboard. Used by the on-screen close control
  // and as best-effort secondary cleanup after printing; it never relies on any
  // browser event firing.
  function exitPrint() {
    document.documentElement.classList.remove('printing');
    const host = $('#print-report'); if (host) host.textContent = '';
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
    if (f.kind !== 'all') parts.push({ spend: 'Purchases', payment: 'Payments', refund: 'Refunds', fee: 'Fees & tax' }[f.kind]);
    if (f.foreignOnly) parts.push('Foreign only');
    if (f.reviewOnly) parts.push('To review');
    if (f.min != null) parts.push(`≥ ${money0(f.min)}`);
    if (f.max != null) parts.push(`≤ ${money0(f.max)}`);
    if (f.search) parts.push(`“${f.search}”`);

    let vsPrev = null;
    if (a.prev_total != null && a.prev_total !== 0) {
      const diff = a.total_spend - a.prev_total; const dp = Math.round((diff / a.prev_total) * 100);
      vsPrev = { text: `${Math.abs(dp)}% ${diff > 0 ? 'more' : (diff < 0 ? 'less' : 'the same as')} than ${prevLabel()}`,
        prevMoney: money0(a.prev_total), dir: diff > 0 ? 'up' : (diff < 0 ? 'down' : 'flat') };
    }
    const hist = histMonthlyAverage();
    let vsAvg = null;
    if (hist) {
      const perMonth = a.months.length ? a.total_spend / a.months.length : a.total_spend;
      const d = (perMonth - hist) / hist;
      const word = Math.abs(d) < 0.08 ? 'about the same as' : (d > 0 ? 'above' : 'below');
      vsAvg = `That is ${word} your typical month of ${money0(hist)}.`;
    }

    const months = allMonths();
    const shown = months.length > 13 ? months.slice(-13) : months;
    const inc = detectIncompleteMonth(state.rows, months, new Date(), { coverage: state.coverage });
    const bars = shown.map((m) => {
      const v = state.allSummary.by_month[m] || 0;
      return { label: monthShort(m), value: v, money: money0(v),
        incomplete: !!(inc && inc.month === m), inPeriod: !!(p && m >= p.from && m <= p.to) };
    });

    const cats = a.by_category.map((c) => ({
      name: isReview(c.name) ? 'To review' : c.name, amount: money0(c.amount),
      share: pct(c.share), shareNum: c.share, colour: catColour(c.name), review: isReview(c.name),
    })).sort((x, y) => (x.review ? 1 : 0) - (y.review ? 1 : 0));

    const merchants = a.merchants.slice(0, 12).map((m) => ({
      name: m.merchant, category: isReview(m.category) ? 'To review' : m.category,
      count: String(m.count), amount: money0(m.amount), avg: money0(m.avg), colour: catColour(m.category),
    }));

    const insights = buildInsights(a).map((i) => i.text);

    const uncategorised = periodRows().filter((r) => r.kind === 'spend' && r.category === FALLBACK());
    const reviewNote = uncategorised.length
      ? `${uncategorised.length} purchase${uncategorised.length === 1 ? '' : 's'} totalling ${money0(uncategorised.reduce((s, r) => s + r.amount, 0))} still need a category; they appear under “To review”.`
      : null;

    // The printable report caps its transaction table (reusing the explorer's
    // row-cap concept) so a long period cannot spill an unbounded table across
    // many pages. The held-back count is noted in txCountText below, keeping
    // renderReport itself unchanged.
    const allVisible = visibleRows();
    const { shown: rows, hidden: hiddenTxns } = capForPrint(allVisible, TX_PAGE);
    const kindLabel = { spend: 'Purchase', payment: 'Payment', refund: 'Refund', fee: 'Fee' };
    const txns = rows.map((r) => ({
      date: r.date, description: r.displayName || r.description, foreign: r.foreign || '',
      category: isReview(r.category) ? 'To review' : r.category, colour: catColour(r.category),
      kind: kindLabel[r.kind] || r.kind,
      amount: (r.amount < 0 ? '+' : '') + money0(Math.abs(r.amount)), credit: r.amount < 0,
    }));

    return {
      app: state.cfg.app.name,
      period: a.label,
      filtersText: parts.length ? `Filtered to: ${parts.join(' · ')}` : 'All transactions in this period.',
      generated: new Date().toLocaleString(state.cfg.currency.locale),
      currencyCode: state.cfg.currency.code,
      privacy: 'Generated on this device. Your statement data never leaves it.',
      summary: {
        totalSpend: money0(a.total_spend), vsPrev, vsAvg,
        nPurchases: String(a.n_purchases),
        leading: a.leading ? { label: isReview(a.leading.name) ? 'To review' : a.leading.name, share: pct(a.leading.share), colour: catColour(a.leading.name) } : null,
        paidToCard: money0(a.total_payments),
        fees: a.total_fees ? money0(a.total_fees) : null,
        refunds: a.total_refunds ? money0(a.total_refunds) : null,
      },
      trend: { bars, avg: hist || 0, avgLabel: hist ? moneyShort(hist) : null, avgMoney: hist ? money0(hist) : null, moneyShort },
      categories: cats, merchants, insights, reviewNote, txns,
      txCountText: `${rows.length} transaction${rows.length === 1 ? '' : 's'} shown · amounts in ${state.cfg.currency.code}.`
        + (hiddenTxns > 0
          ? ` ${hiddenTxns} further transaction${hiddenTxns === 1 ? ' is' : 's are'} not shown - narrow the period or add a filter to include them.`
          : ''),
    };
  }

  return { printReport, buildReportForCurrentView, exitPrint, currentBankViewRows };
}
