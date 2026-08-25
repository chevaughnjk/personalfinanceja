export const CATEGORY_RULES_TYPE = 'pfa-category-rules';
export const CATEGORY_RULES_VERSION = 1;

// Merchant-intelligence resolver (first-class source of truth for grouping
// and labelling). The SAME analytics that power Top Places, recurring
// detection and insights collapse by researched merchant group before
// falling back to the structural rooter. Adding a merchant to the
// intelligence file changes grouping with no edit to this file.
import { resolveMerchant } from './merchant-intelligence.js';
import { cutAtBranchHyphen } from '../application/core/shared-helpers.js';
// The structural fallback label lives in categorise.js. category-rules.js is
// allowed to import it because categorise.js never imports category-rules.js
// back (it only pulls merchant-intelligence.js and shared-helpers.js), so there
// is no import cycle. This one import is what lets merchantDisplayLabel below be
// the single, authoritative clean-name function every view calls.
import { merchantLabel } from '../application/statements/categorise.js';

function collapseSpaces(value) {
  return String(value == null ? '' : value)
    .replace(/\s+/g, ' ')
    .trim();
}

export function normaliseMerchantMatch(value) {
  return collapseSpaces(String(value == null ? '' : value).split(',')[0]).toLowerCase();
}

export function merchantRuleKeyFromMatch(match) {
  return normaliseMerchantMatch(match).toUpperCase().slice(0, 32);
}

export function merchantRuleKeyFromDescription(description) {
  return merchantRuleKeyFromMatch(description);
}

function isValidTimestamp(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value));
}

function cleanRule(rule) {
  if (!rule || typeof rule !== 'object') return null;
  const match = normaliseMerchantMatch(rule.match);
  const category = collapseSpaces(rule.category);
  const updatedAt = isValidTimestamp(rule.updatedAt) ? new Date(rule.updatedAt).toISOString() : '';
  if (!match || !category || !updatedAt) return null;
  return { match, category, updatedAt };
}

function seedRuleMap(rules = []) {
  const byKey = new Map();
  for (const raw of rules || []) {
    const rule = cleanRule(raw);
    if (!rule) continue;
    const key = merchantRuleKeyFromMatch(rule.match);
    const cur = byKey.get(key);
    if (!cur || Date.parse(rule.updatedAt) > Date.parse(cur.updatedAt)) byKey.set(key, rule);
  }
  return byKey;
}

export function rulesToMerchantOverrides(rules = []) {
  const overrides = {};
  for (const rule of seedRuleMap(rules).values())
    overrides[merchantRuleKeyFromMatch(rule.match)] = rule.category;
  return overrides;
}

export function mergeCategoryRules(existing = [], incoming = []) {
  const byKey = seedRuleMap(existing);
  let inserted = 0;
  let updated = 0;
  let ignored = 0;
  let skipped = 0;
  let conflicts = 0;
  for (const raw of incoming || []) {
    const rule = cleanRule(raw);
    if (!rule) {
      skipped++;
      continue;
    }
    const key = merchantRuleKeyFromMatch(rule.match);
    const cur = byKey.get(key);
    if (!cur) {
      byKey.set(key, rule);
      inserted++;
      continue;
    }
    const curMs = Date.parse(cur.updatedAt) || 0;
    const newMs = Date.parse(rule.updatedAt) || 0;
    if (newMs > curMs) {
      byKey.set(key, rule);
      updated++;
    } else if (newMs < curMs) {
      ignored++;
    } else if (cur.match === rule.match && cur.category === rule.category) {
      ignored++;
    } else {
      conflicts++;
      ignored++;
    }
  }
  return {
    rules: [...byKey.values()].sort(
      (a, b) => a.match.localeCompare(b.match) || a.updatedAt.localeCompare(b.updatedAt)
    ),
    inserted,
    updated,
    ignored,
    skipped,
    conflicts,
  };
}

export function upsertCategoryRule(rules = [], rule, updatedAt = new Date()) {
  return mergeCategoryRules(rules, [{ ...rule, updatedAt: updatedAt.toISOString() }]);
}

export function exportCategoryRulesFile(rules = [], exportedAt = new Date()) {
  const cleaned = [...rules]
    .map(cleanRule)
    .filter(Boolean)
    .sort((a, b) => a.match.localeCompare(b.match) || a.updatedAt.localeCompare(b.updatedAt));
  return JSON.stringify(
    {
      type: CATEGORY_RULES_TYPE,
      version: CATEGORY_RULES_VERSION,
      exportedAt: exportedAt.toISOString(),
      rules: cleaned,
    },
    null,
    2
  );
}

export function parseCategoryRulesFile(fileText) {
  let data;
  try {
    data = JSON.parse(fileText);
  } catch {
    throw new Error('This does not look like a category rules file.');
  }
  if (!data || data.type !== CATEGORY_RULES_TYPE) {
    throw new Error('This does not look like a category rules file.');
  }
  if (data.version !== CATEGORY_RULES_VERSION) {
    throw new Error('This rules file uses an unsupported version.');
  }
  const rules = [];
  let skipped = 0;
  for (const raw of Array.isArray(data.rules) ? data.rules : []) {
    const rule = cleanRule(raw);
    if (!rule) {
      skipped++;
      continue;
    }
    rules.push(rule);
  }
  return {
    type: CATEGORY_RULES_TYPE,
    version: CATEGORY_RULES_VERSION,
    exportedAt: typeof data.exportedAt === 'string' ? data.exportedAt : null,
    rules,
    skipped,
  };
}

export function categoryRuleStoreRecord(rule) {
  const clean = cleanRule(rule);
  if (!clean) return null;
  return { key: merchantRuleKeyFromMatch(clean.match), ...clean };
}

export function categoryRuleFromStoreRecord(record) {
  const clean = cleanRule(record);
  return clean ? clean : null;
}

/* ===========================================================================
 *  Merchant GROUPING layer  (additive; brand-level, rules-driven)
 *  ---------------------------------------------------------------------------
 *  A display-and-grouping overlay used ONLY by the analytics (Top Places,
 *  frequency-erosion, recurring detection, insights). It never mutates a
 *  transaction, its identity, its category, or the sealed bank normaliser.
 *  It rides the SAME rule mechanism as the category rules above: brand rules
 *  live in config (settings/config.json -> merchantBrands) and are compiled
 *  here, so an unseen merchant next year is handled by adding a rule, not by
 *  editing code. With NO rules it still collapses the two structural sources
 *  of fragmentation - the star-reference token and a trailing store/reference
 *  number - so grouping improves even before any brand rule is written.
 *  ======================================================================== */

// The rules-free brand ROOT of a merchant. It builds a stable, brand-level key
// STRUCTURALLY, so an unseen merchant collapses by construction rather than by
// a per-brand lookup. It never touches the stored description; it only decides
// which analytics group a row belongs to. Four structural strips, in order:
//   1. the star-reference token and everything after it (AMZN*REF, WWW.AMAZON* 113);
//   2. a trailing store number (#4446) and a trailing reference / phone group;
//   3. the branch/location tail after a hyphen separator - spaced ('Total - Manor
//      Park'), left-glued ('Total- Shortwood', 'Pricesmart- R/Hills'), right-glued
//      ('Fontana -Waterloo') or fully glued ('Starbucks-Ac Marriott') - guarded by
//      a minimum-head rule so a hyphen that is part of the brand is kept
//      ('Hi-Lo', 'Bk-Bar' survive because the head before the hyphen is < 3 letters);
//   4. trailing corporate/descriptor suffixes ('Limited', 'Ltd', 'Enterpr...',
//      'Services', 'Fresh Foods', 'Food Stores', 'Gas Station', 'Country Club',
//      'Corner Te...', 'Supermarket', store numbers) and a trailing country token.
// An OVER-MERGE GUARD keeps the key from ever dropping below three letters: it
// falls back up the chain (pre-suffix -> pre-cut -> first comma segment) rather
// than collapse two different businesses that merely share a leading word, so
// 'Island Grill' and 'Island Deli', or 'Boss Destinations' and 'Bluma', stay
// apart. Genuinely un-splittable single-word brands whose branch is glued on
// without a separator (e.g. 'Rubis Waterloo', 'Totalenergies') are left to the
// config exception layer above - config only patches what construction cannot.
const BRAND_SUFFIX_RE = new RegExp(
  '(?:' +
    [
      'gas\\s+station',
      'service\\s+station',
      'fresh\\s+foods?',
      'food\\s+stores?',
      'country\\s+club',
      'supermarket',
      'super\\s+cent(?:er|re)',
      'corner\\s+te\\w*',
      'enterprises?',
      'enterpr\\w*',
      'services?',
      'solutions?',
      'holdings?',
      'limited',
      'limite',
      'limit',
      'limi',
      'ltd',
      'llc',
      'inc',
      'energy',
      'stores?',
    ].join('|') +
    ')\\s*$',
  'i'
);
const BRAND_PLACE_TAIL_RE = /\s+(?:jamaica|default\s+city)\s*$/i;
function brandLetters(s) {
  return (String(s).match(/[A-Za-z]/g) || []).length;
}
// Cut the branch tail at the first hyphen whose preceding head already carries
// >= 3 letters. Whitespace around the hyphen is not required; the head guard is
// what keeps a brand-internal hyphen ('Hi-Lo', 'Bk-Bar') intact.
function cutBranchTail(root) {
  // Uses the shared cutAtBranchHyphen (shared-helpers.js) so brand grouping and
  // the category head match in categorise.js cut a branch tail the same way and
  // can never drift apart.
  return cutAtBranchHyphen(root);
}
function dropBrandSuffixes(root) {
  let prev;
  do {
    prev = root;
    root = collapseSpaces(root.replace(BRAND_SUFFIX_RE, ''));
  } while (root !== prev && root);
  return root || prev;
}
const _brandRootCache = new Map();
export function merchantBrandRoot(description) {
  const cacheKey = String(description == null ? '' : description);
  if (_brandRootCache.has(cacheKey)) return _brandRootCache.get(cacheKey);
  let seg = collapseSpaces(cacheKey.split(',')[0]);
  // Text before a star token ('AMZN*REF' and 'WWW.AMAZON* 113' both -> the head).
  let root = collapseSpaces(seg.split('*')[0]);
  root = root.replace(/#\s*\d[\d-]*\s*$/, ''); // trailing store number '#1026'
  root = root.replace(/\s+\d[\d-]{2,}\s*$/, ''); // trailing ref / phone group
  root = collapseSpaces(root.replace(/[\s-]+$/, ''));
  const beforeCut = root;
  root = cutBranchTail(root); // branch tail after a hyphen
  root = dropBrandSuffixes(root); // corporate / descriptor suffix
  root = collapseSpaces(root.replace(BRAND_PLACE_TAIL_RE, '')); // trailing country token
  root = dropBrandSuffixes(root);
  root = collapseSpaces(root.replace(/\s+\d[\d-]{2,}\s*$/, '')); // store no. a suffix exposed
  // Over-merge guard: never key on fewer than three letters; fall back up the chain.
  if (brandLetters(root) < 3) root = beforeCut;
  if (brandLetters(root) < 3) root = seg;
  const key = collapseSpaces(root).toUpperCase().slice(0, 32);
  const result = key || seg.toUpperCase().slice(0, 32) || 'UNKNOWN';
  _brandRootCache.set(cacheKey, result);
  return result;
}

// RETIRED as the primary brand source. Config-driven brand rules (cfg.merchantBrands)
// are superseded by the researched merchant list (jamaica-merchants.json): merchant
// grouping now comes from each merchant's merchantGroup / canonicalName / brand fields,
// resolved via resolveMerchant in merchantGroupKey / merchantBrandLabel below. config.json
// deliberately carries no merchantBrands key, so this returns an empty list, and the
// structural merchantBrandRoot() remains the fallback for any merchant NOT in the list.
// Kept (rather than deleted) so an existing cfg.merchantBrands array would still compile
// if a real future need arises. Same word-boundary IGNORECASE shape as compileRules above.
export function compileBrandRules(cfg) {
  const list = Array.isArray(cfg) ? cfg : (cfg && cfg.merchantBrands) || [];
  const out = [];
  for (const b of list) {
    const brand = collapseSpaces(b && b.brand);
    const words = ((b && b.patterns) || []).map(String).filter((w) => w.trim());
    if (!brand || !words.length) continue;
    out.push({
      re: new RegExp('(?<![a-z])(?:' + words.join('|') + ')', 'i'),
      key: brand.toUpperCase().slice(0, 32),
      label: brand,
    });
  }
  return out;
}

const _resolveMerchantCache = new WeakMap();
function resolveMerchantCached(description, intel) {
  if (!intel) return resolveMerchant(description, intel);
  let byDesc = _resolveMerchantCache.get(intel);
  if (!byDesc) {
    byDesc = new Map();
    _resolveMerchantCache.set(intel, byDesc);
  }
  const key = String(description == null ? '' : description);
  if (byDesc.has(key)) return byDesc.get(key);
  const result = resolveMerchant(description, intel);
  byDesc.set(key, result);
  return result;
}

export function merchantGroupKey(description, brandRules = [], intel = null) {
  if (intel) {
    const m = resolveMerchantCached(description, intel);
    if (m)
      return String(m.merchantGroup || m.canonicalName)
        .toUpperCase()
        .slice(0, 32);
  }
  const hay = collapseSpaces(
    String(description == null ? '' : description).split(',')[0]
  ).toLowerCase();
  for (const rule of brandRules || []) {
    if (rule && rule.re && rule.re.test(hay)) return rule.key;
  }
  return merchantBrandRoot(description);
}

// The display label for a group: the matched brand's own label (e.g. 'Amazon'),
// or null when no brand rule matched so the caller can fall back to its existing
// per-merchant label formatting. Never changes a stored description.
export function merchantBrandLabel(description, brandRules = [], intel = null) {
  if (intel) {
    const m = resolveMerchantCached(description, intel);
    if (m) return m.brand;
  }
  const hay = collapseSpaces(
    String(description == null ? '' : description).split(',')[0]
  ).toLowerCase();
  for (const rule of brandRules || []) {
    if (rule && rule.re && rule.re.test(hay)) return rule.label;
  }
  return null;
}

// THE single, authoritative clean display name for a merchant/place, used by
// every surface that shows one. It implements the one formula exactly once:
//   researched brand label (merchantBrandLabel via jamaica-merchants.json /
//   config brand rules), falling back to the structural merchantLabel of the
//   first comma-segment when the merchant is not in the researched list.
// Rule for callers: if a full row object is already in scope (it came from
// buildRows), read row.displayName instead of calling this again. Only the
// aggregations that group by key and the detectors, which hold a raw
// description string rather than a row, call this. Nowhere else re-writes the
// merchantBrandLabel(...) || merchantLabel(...) formula by hand. Pure;
// presentation-only, it never changes a stored description, category or total.
export function merchantDisplayLabel(
  description,
  brandRules = [],
  intel = null,
  keepUpper = new Set(),
  smallWords = new Set()
) {
  return (
    merchantBrandLabel(description, brandRules, intel) ||
    merchantLabel(
      String(description == null ? '' : description)
        .split(',')[0]
        .trim(),
      keepUpper,
      smallWords
    )
  );
}

// The branch / location of a merchant, kept queryable as a drill-down detail so
// brand grouping never loses the branch (e.g. brand WENDY'S keeps 'Constant
// Spring' vs 'Barbican'). Reads the second comma segment when it carries letters,
// else the text after a spaced ' - ' in the first segment; '' when neither holds
// a real place. Pure; presentation-only.
export function merchantBranch(description) {
  const parts = String(description == null ? '' : description)
    .split(',')
    .map((s) => collapseSpaces(s));
  const hasLetter = (s) => /[A-Za-z]/.test(s);
  if (parts.length > 1 && hasLetter(parts[1])) return parts[1];
  const m = /\s-\s*(.+)$/.exec(parts[0] || '');
  if (m && hasLetter(m[1])) return collapseSpaces(m[1]);
  return '';
}
