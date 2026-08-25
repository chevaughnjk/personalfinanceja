/* ===========================================================================
 *  tag-totals.js  -  personal cross-category tags: the tag record shape, and
 *  the reader that turns a set of tags + the current transaction rows into
 *  totals (and progress against an optional target).
 *
 *  MEMBERSHIP MODEL (deliberate): a tag OWNS a list of transaction ids
 *  (txnIds). It never writes a field onto the transaction record - those are
 *  re-derived from statement imports, so a tag that referenced them by mutation
 *  would be fragile across re-import. Transaction ids are stable identities
 *  (transactionIdentity / bankTransactionIdentity), so a tag's membership
 *  survives re-import untouched, and the reader simply JOINS txnIds against
 *  whatever rows currently exist. A txnId with no current row contributes 0 and
 *  is not counted - so a deleted/re-imported-away transaction degrades a tag
 *  gracefully rather than corrupting its total.
 *
 *  Ledger-agnostic: rows may be card rows, bank rows, or both, since ids are
 *  unique across ledgers. Sums the absolute amount of each matched row.
 *
 *  PURE and Node-testable. No DOM, no fetch, no mutation. Tags live in the v4
 *  `tags` store (keyPath 'id').
 * ======================================================================== */
function r2(n) {
  return Math.round(Number(n || 0) * 100) / 100;
}

/* A stored tag record. target is the OPTIONAL bounded cap a monthly pace signal
 * cannot express (a renovation, a holiday) - null when none set. */
export function makeTag({ name, target = null, now = new Date().toISOString() }) {
  const t = Number(target);
  return {
    id: `tag_${Math.random().toString(36).slice(2, 10)}`,
    name: String(name || '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 40),
    target: Number.isFinite(t) && t > 0 ? r2(t) : null,
    txnIds: [],
    createdAt: now,
    updatedAt: now,
  };
}

/* Add / remove a transaction from a tag, returning a NEW record (never mutates).
 * Idempotent: adding an id already present is a no-op; removing an absent id too. */
export function tagAdd(tag, txnId, now = new Date().toISOString()) {
  const ids = new Set(tag.txnIds || []);
  ids.add(txnId);
  return { ...tag, txnIds: [...ids], updatedAt: now };
}
export function tagRemove(tag, txnId, now = new Date().toISOString()) {
  return {
    ...tag,
    txnIds: (tag.txnIds || []).filter((id) => id !== txnId),
    updatedAt: now,
  };
}

/* The reader: tags + current rows -> per-tag totals and target progress. */
export function tagTotals(tags, rows) {
  const byId = new Map((rows || []).map((r) => [r.id, r]));
  return (tags || [])
    .map((t) => {
      const ids = t.txnIds || [];
      let total = 0,
        count = 0;
      for (const id of ids) {
        const r = byId.get(id);
        if (r) {
          total += Math.abs(Number(r.amount) || 0);
          count += 1;
        }
      }
      total = r2(total);
      const target = t.target != null ? r2(t.target) : null;
      return {
        id: t.id,
        name: t.name,
        target,
        total,
        count,
        txnIds: ids,
        remaining: target != null ? r2(target - total) : null,
        pctOfTarget: target && target > 0 ? Math.round((total / target) * 100) : null,
        overTarget: target != null ? total > target : false,
        // count of member ids that no longer match a current row (honest staleness)
        missing: ids.length - count,
      };
    })
    .sort((a, b) => b.total - a.total);
}

/* view-model: number/tag/detail, frozen shape, pronoun-free tag. */
export function buildTagModel(tt, cfg = {}) {
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

  let tag = '',
    tone = 'neutral',
    detail;
  if (tt.target != null) {
    tag = tt.overTarget ? 'over target' : `${tt.pctOfTarget}% of target`;
    tone = tt.overTarget ? 'watch' : 'neutral';
    detail = tt.overTarget
      ? `${tt.name} totals ${money(tt.total)} across ${tt.count} transaction${tt.count === 1 ? '' : 's'}, over the ${money(tt.target)} target you set.`
      : `${tt.name} totals ${money(tt.total)} across ${tt.count} transaction${tt.count === 1 ? '' : 's'}, ${money(tt.remaining)} left of the ${money(tt.target)} target.`;
  } else {
    tag = `${tt.count} transaction${tt.count === 1 ? '' : 's'}`;
    detail = `${tt.name} totals ${money(tt.total)} across ${tt.count} transaction${tt.count === 1 ? '' : 's'}. No target set.`;
  }
  if (tt.missing > 0)
    detail += ` ${tt.missing} tagged item${tt.missing === 1 ? '' : 's'} are not in the current data.`;

  return {
    id: tt.id,
    name: tt.name,
    amount: tt.total,
    amountText: money(tt.total),
    targetText: tt.target != null ? money(tt.target) : null,
    tag,
    tone,
    detail,
  };
}
