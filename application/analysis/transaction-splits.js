/* ===========================================================================
 *  transaction-splits.js  -  split one transaction across categories without
 *  ever double-counting it or drifting a total.
 *
 *  THE MODEL (decided from how buildRows/summarise/analysePeriod actually work):
 *  a split does NOT create new rows. The transaction stays ONE row - one id, one
 *  amount, appearing once in the ledger and counted once in the grand total.
 *  A split only changes HOW that one row's amount is DISTRIBUTED across
 *  categories when category totals (by_category) are computed. So the category
 *  breakdown reflects the split, while every count, the ledger list, row
 *  identity (tags/dedup/drill), and the spend total are all untouched.
 *
 *  THE RECONCILIATION INVARIANT (the entire risk): a split's parts MUST sum to
 *  the transaction's own amount, to the cent. If they do, the sum of all
 *  category totals is byte-identical whether or not the row is split - so
 *  cross-screen consistency cannot break. validateSplit enforces this; the
 *  category-total reader (categoryTotalsWithSplits) is written so that the
 *  split's parts REPLACE the row's single-category contribution, never add to
 *  it - an invalid split (parts != amount) is REJECTED and the row falls back
 *  to its whole amount on its own category, so a bad split can never silently
 *  distort a total.
 *
 *  SPLIT RECORD SHAPE (v4 `transactionSplits` store, keyPath 'id'):
 *    { id, txnId, parts: [ { category, amount } ], createdAt, updatedAt }
 *  amounts are POSITIVE magnitudes in the transaction's own currency; the reader
 *  applies them with the same sign/abs treatment buildRows already uses.
 *
 *  PURE and Node-testable. No DOM, no mutation of inputs.
 * ======================================================================== */
function r2(n) {
  return Math.round(Number(n || 0) * 100) / 100;
}

export function makeSplit({ txnId, parts, now = new Date().toISOString() }) {
  return {
    id: `split_${Math.random().toString(36).slice(2, 10)}`,
    txnId,
    parts: (parts || []).map((p) => ({
      category: p.category,
      amount: r2(Math.abs(Number(p.amount) || 0)),
    })),
    createdAt: now,
    updatedAt: now,
  };
}

/* Validate a split against the transaction's magnitude. Returns { ok, reason,
 * sum, target }. A split is valid only when: >=2 parts, every part has a
 * category and a positive amount, and the parts sum to |txnAmount| within a
 * cent. The 1-cent tolerance absorbs rounding, never a real imbalance. */
export function validateSplit(split, txnAmount) {
  const target = r2(Math.abs(Number(txnAmount) || 0));
  const parts = (split && split.parts) || [];
  if (parts.length < 2) return { ok: false, reason: 'need-two-parts', sum: 0, target };
  const categories = new Set();
  for (const p of parts) {
    if (!p.category) return { ok: false, reason: 'part-missing-category', sum: 0, target };
    if (!(Number(p.amount) > 0)) return { ok: false, reason: 'part-not-positive', sum: 0, target };

    const categoryKey = String(p.category).trim().toLowerCase();
    if (categories.has(categoryKey)) {
      return { ok: false, reason: 'duplicate-category', sum: 0, target };
    }
    categories.add(categoryKey);
  }

  const sum = r2(parts.reduce((s, p) => s + Math.abs(Number(p.amount) || 0), 0));
  if (Math.abs(sum - target) > 0.01) return { ok: false, reason: 'sum-mismatch', sum, target };
  return { ok: true, reason: 'ok', sum, target };
}

/* Split the LAST part so the parts sum exactly to the target - a UI convenience
 * so a person entering N-1 amounts gets the remainder filled and validation
 * always passes. Returns a new parts array (never mutates). */
export function balanceParts(parts, txnAmount) {
  const target = r2(Math.abs(Number(txnAmount) || 0));
  const head = (parts || []).slice(0, -1).map((p) => ({
    category: p.category,
    amount: r2(Math.abs(Number(p.amount) || 0)),
  }));
  const used = r2(head.reduce((s, p) => s + p.amount, 0));
  const last = (parts || [])[parts.length - 1] || { category: null };
  return [...head, { category: last.category, amount: r2(target - used) }];
}

/* THE READER: category totals over spend rows, applying valid splits.
 * For each spend row: if a valid split exists for its id, distribute |amount|
 * across the split's categories; otherwise put |amount| on the row's own
 * category. splitsByTxn is a Map(txnId -> split). Returns { byCategory, total }.
 * Because a valid split's parts sum to |amount|, `total` is identical to the
 * unsplit total - the reconciliation guarantee, by construction. */
export function categoryTotalsWithSplits(spendRows, splitsByTxn) {
  const byCat = {};
  let total = 0;
  const add = (cat, amt) => {
    byCat[cat] = r2((byCat[cat] || 0) + amt);
  };
  for (const r of spendRows || []) {
    const mag = Math.abs(Number(r.amount) || 0);
    total = r2(total + mag);
    const split = splitsByTxn && splitsByTxn.get ? splitsByTxn.get(r.id) : null;
    const v = split ? validateSplit(split, r.amount) : { ok: false };
    if (v.ok) {
      for (const p of split.parts) add(p.category, Math.abs(Number(p.amount) || 0));
    } else {
      add(r.category, mag); // no split, or an INVALID split -> whole amount, own category
    }
  }
  return { byCategory: byCat, total: r2(total) };
}

/* Build the fast lookup the reader wants from the raw stored split list. When a
 * transaction somehow has more than one split record, the most-recent wins
 * (updatedAt), so a stale split can never shadow the current one. */
export function splitsByTxnId(splits) {
  const m = new Map();
  for (const s of splits || []) {
    if (!s || !s.txnId) continue;
    const prev = m.get(s.txnId);
    if (!prev || String(s.updatedAt || '') >= String(prev.updatedAt || '')) m.set(s.txnId, s);
  }
  return m;
}
