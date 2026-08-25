import { cutAtBranchHyphen } from '../core/shared-helpers.js';

export function compileRules(categories) {
  // categories: [{ name, description, patterns }], where `patterns` is EITHER a
  // legacy flat array of strings, OR a layered object
  // { universal:[...], 'jamaica-pack':[...], head:[...] }. Universal and
  // jamaica-pack are OR-joined into ONE per-category matcher: within a single
  // category the order of alternatives cannot change which category wins, so the
  // runtime match is identical to the old flat list - the layer tags are shareable
  // pack metadata, not a runtime reordering. `head` patterns are location
  // co-location guards, compiled separately and tested against the merchant HEAD
  // only (so a trailing "…-Ac Marriott" never assigns a category).
  const compiled = [];
  const flat = (p) =>
    Array.isArray(p) ? p : [...((p && p['jamaica-pack']) || []), ...((p && p.universal) || [])];
  for (const cat of categories) {
    const words = flat(cat.patterns)
      .map(String)
      .filter((w) => w.trim());
    const headWords = ((!Array.isArray(cat.patterns) && cat.patterns && cat.patterns.head) || [])
      .map(String)
      .filter((w) => w.trim());
    if (!words.length && !headWords.length) continue;
    // Reproduces the Python: (?<![a-z])(?:word1|word2|...) with IGNORECASE.
    const entry = {
      name: cat.name,
      re: words.length ? new RegExp('(?<![a-z])(?:' + words.join('|') + ')', 'i') : null,
    };
    if (headWords.length)
      entry.headRe = new RegExp('(?<![a-z])(?:' + headWords.join('|') + ')', 'i');
    compiled.push(entry);
  }
  return compiled;
}

// The merchant HEAD: the first comma segment, with a trailing branch after a
// hyphen removed when the text before that hyphen already carries >= 3 letters
// (so 'Starbucks-Ac Marriott' -> 'Starbucks', but a brand-internal hyphen like
// 'Hi-Lo' or 'Bk-Bar' is kept). Mirrors the branch cut used by the merchant
// rooter, so a location token glued on as a trailing co-location can never
// assign a spending category.
function merchantHead(text) {
  // Uses the shared cutAtBranchHyphen (shared-helpers.js) so the category head
  // match and the brand grouping in category-rules.js cut a branch tail the same
  // way and can never drift apart.
  return cutAtBranchHyphen(String(text == null ? '' : text).split(',')[0]);
}

// description:  the raw statement text.
// compiled:     the compiled CATEGORY RULES from compileRules() - shape [{name, re, headRe}].
// fallback:     the category name used when nothing matches.
// merchants:    the compiled MERCHANT LIST from compileMerchantIntelligence() -
//               shape [{re, merchant, priority, confRank, specificity}]. This is a
//               DIFFERENT shape from `compiled`; passing one where the other is
//               expected will silently misbehave. Keep them in their own slots.
export function categorise(
  description,
  compiled,
  fallback = 'Uncategorised',
  resolver = null,
  refundHint = null
) {
  if (!description) return { category: fallback, confidence: 0 };
  // 1) Researched merchant identity first, via the ONE shared resolver
  //    (card profile: no bank cleanup, no institution strip). A known merchant's
  //    category wins; low-confidence merchants are flagged. This replaces the
  //    former direct resolveMerchant import so card and bank share one door.
  if (resolver) {
    const r = resolver.resolve(description, { profile: 'card' });
    if (r.merchant) {
      const level = r.confidence;
      // Faithful to the previous rule: an explicit reviewRequired wins; otherwise
      // a low-confidence merchant is flagged. (r.reviewRequired defaults false, so
      // `|| level==='low'` reproduces the old `!=null ? flag : level==='low'` for
      // every entry in the researched list, all of whose low-confidence rows set
      // reviewRequired explicitly.)
      const needsReview = r.reviewRequired || level === 'low';
      return {
        category: r.category,
        confidence: level === 'low' ? 0.4 : 0.9,
        merchant: r.canonicalName,
        needsReview,
      };
    }
  }
  const text = description.toLowerCase();
  let head = null;
  for (const c of compiled) {
    if (c.re && c.re.test(text)) return { category: c.name, confidence: 0.9 };
    if (c.headRe) {
      if (head === null) head = merchantHead(text);
      if (c.headRe.test(head)) return { category: c.name, confidence: 0.9 };
    }
  }
  // Last-resort fallback: nothing above matched - no merchant, no keyword, no
  // head rule - so this is genuinely unclassifiable by wording alone. If the
  // caller tells us the transaction is a negative-amount credit (isCredit),
  // that fact alone is a reliable signal it is a refund, independent of what
  // words the bank happened to print. This only fires as the LAST possible step, so a refund from
  // a merchant or category we already recognise is completely unaffected - only genuinely unmatched
  // credits land here. Flagged needsReview so the person can confirm or
  // recategorise it themselves, since "it's a refund" is certain but "a refund of what" is not.
  if (refundHint && refundHint.isCredit && refundHint.refundCategory) {
    return {
      category: refundHint.refundCategory,
      confidence: 0.6,
      needsReview: true,
    };
  }
  return { category: fallback, confidence: 0 };
}

export function smartTitle(text, keepUpper, smallWords) {
  if (!text) return text;
  let first = true;
  return text.replace(/[A-Za-z]+(?:'[A-Za-z]+)?/g, (w) => {
    const isFirst = first;
    first = false;
    if (keepUpper.has(w.toUpperCase())) return w.toUpperCase();
    if (!isFirst && smallWords.has(w.toLowerCase())) return w.toLowerCase();
    return w[0].toUpperCase() + w.slice(1).toLowerCase();
  });
}

export function merchantLabel(firstSegment, keepUpper, smallWords) {
  let s = firstSegment || '';
  s = s.replace(/\*\S+/g, '');
  s = s.replace(/\b(?:MKTPL|MKTP|MKT)\b/gi, '');
  s = s.replace(/\d{3,}\s*$/, '');
  s = s.replace(/[\s\-*]+$/, '');
  s = s.replace(/\s{2,}/g, ' ').trim();
  if (!s) s = (firstSegment || '').replace(/\s{2,}/g, ' ').trim();
  return smartTitle(s, keepUpper, smallWords);
}
