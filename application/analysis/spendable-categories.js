/* ===========================================================================
 *  spendable-categories.js  -  the subset of the category register a person can
 *  meaningfully set a spending ceiling / intention against.
 *
 *  A ceiling means "keep discretionary spending under X". That excludes the
 *  categories that are not discretionary spending at all: paying your own card
 *  (paymentCategory), money returning (refundCategory), statutory/fee buckets
 *  (feeCategories), and the not-yet-filed fallback. Everything else - including
 *  every PERSON-AUTHORED custom category (which is personal spending by
 *  definition) - is a valid ceiling target.
 *
 *  Config-driven: the exclusion set is read from cfg.special, so it can never
 *  drift from what those categories are named elsewhere in the app.
 *
 *  PURE. No DOM, no mutation.
 * ======================================================================== */
export function spendableCategoryNames(cfg) {
  const sp = (cfg && cfg.special) || {};
  const exclude = new Set(
    [
      sp.fallback,
      sp.paymentCategory,
      sp.refundCategory,
      ...(Array.isArray(sp.feeCategories) ? sp.feeCategories : []),
    ]
      .filter(Boolean)
      .map((n) => String(n).toLowerCase())
  );
  return (cfg && cfg.categories ? cfg.categories : [])
    .map((c) => c.name)
    .filter((name) => name && !exclude.has(String(name).toLowerCase()));
}
