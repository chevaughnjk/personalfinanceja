/* ===========================================================================
 *  MERCHANT INTELLIGENCE
 *  ---------------------------------------------------------------------------
 *  A plain lookup of the researched merchant list (jamaica-merchants.json).
 *  Given a statement descriptor, it says which real merchant it is and what
 *  category, brand/group, parent and country that merchant has.
 *
 *  How it is used when a statement is imported:
 *    - categorise.js checks this list FIRST; if a merchant matches, its
 *      category is used. If nothing matches, the existing category rules decide.
 *    - category-rules.js uses the merchant's brand/group to collapse the many
 *      ways one business is written (AMZN MKTP US / AMAZON MKTPL -> Amazon;
 *      Monarch -> Fontana) so grouping, recurring detection and insights line up.
 *    - a person's own category correction always wins over both.
 *
 *  Adding a merchant to jamaica-merchants.json changes behaviour with no code
 *  change. An unknown merchant returns null and simply falls through to the
 *  category rules. Nothing here invents data.
 * ======================================================================== */

// The merchant is matched on the first comma-segment of a descriptor (the
// business name, before the branch/location), lower-cased. This is what keeps
// "Island Grill - Manor P, Kingston 8" matching Island Grill without a stray
// location word pulling in the wrong merchant.
function nameOf(description) {
  return String(description == null ? '' : description).split(',')[0].replace(/\s+/g, ' ').trim().toLowerCase();
}

// Turn each merchant's aliases into one case-insensitive matcher. Merchants are
// ordered so that, when two could match one line, the more important category
// wins (e.g. a Digicel top-up written as "Island Grill - Digicel" is Telecom,
// not a restaurant), then the more confident and more specific one.
export function compileMerchantIntelligence(merchantList, config) {
  const merchants = (merchantList && merchantList.merchants) || [];
  const order = new Map(((config && config.categories) || []).map((c, i) => [c.name, i]));
  const confRank = { high: 0, medium: 1, low: 2 };
  const out = [];
  for (const m of merchants) {
    const words = (m.aliases || []).map(String).filter((w) => w.trim());
    if (!words.length) continue;
    let re;
    try { re = new RegExp('(?<![a-z])(?:' + words.join('|') + ')', 'i'); }
    catch { continue; } // a bad alias must never break the whole list
    out.push({
      re, merchant: m,
      priority: order.has(m.category) ? order.get(m.category) : 999,
      confRank: confRank[m.categoryConfidence || m.confidence] == null ? 3 : confRank[m.categoryConfidence || m.confidence],
      specificity: words.reduce((n, w) => Math.max(n, w.length), 0),
    });
  }
  out.sort((a, b) => a.priority - b.priority || a.confRank - b.confRank || b.specificity - a.specificity);
  return out;
}

// The merchant a descriptor belongs to, or null if it is not in the list.
//
// The category-assignment precedence (a person's correction first, then this
// merchant list, then the generic category rules) lives in ONE place only:
// categorise.js's categorise() function. The earlier duplicate copies of that
// precedence here (classify / merchantCategory / merchantConfidence) were
// removed so the two can never drift apart; this file now only compiles the
// list and resolves a descriptor to a merchant. The review rule (only a
// merchant's explicit reviewRequired flag ever surfaces a review prompt; an
// unverified owner never does) is applied inside categorise().
export function resolveMerchant(description, compiled) {
  const name = nameOf(description);
  if (!name) return null;
  for (const c of compiled || []) {
    if (!c.re.test(name)) continue;
    // Location overrides are tested against the FULL description, never
    // nameOf(). nameOf() deliberately keeps only the first comma segment
    // (the business name), so branch/location text - "Kingston 6" vs
    // "Kingston 10", or a location word after a hyphen - lives strictly
    // outside what nameOf() returns. An override alias meant to distinguish
    // branches by location text would never match anything if tested the
    // same way the top-level merchant alias is.
    if (c.locationOverrides && c.locationOverrides.length) {
      const haystack = String(description == null ? '' : description).replace(/\s+/g, ' ').trim().toLowerCase();
      for (const o of c.locationOverrides) {
        // First matching override wins; a merchant with several branches
        // needing different treatment lists them in priority order in
        // jamaica-merchants.json. Returns a NEW object (never mutates the
        // shared compiled merchant), so every OTHER row resolving to this
        // same merchant is completely unaffected - only the branch whose
        // description matched this specific override alias gets the
        // overridden fields, and it gets them by spreading the parent
        // merchant first and the override's fields second, so anything the
        // override does NOT specify (e.g. merchantGroup, canonicalName,
        // brand) still falls through to the parent's own value untouched.
        if (o.re.test(haystack)) return { ...c.merchant, ...o.fields };
      }
    }
    // No override matched (or none exist for this merchant): the plain
    // parent merchant object, exactly as resolveMerchant has always
    // returned it. Every merchant with no locationOverrides array reaches
    // here every time, so behaviour for the entire existing merchant list
    // is byte-for-byte unchanged.
    return c.merchant;
  }
  return null;
}