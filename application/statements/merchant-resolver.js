/* =============================================================================
 *  merchant-resolver.js  -  the ONE place merchant identity is decided.
 * -----------------------------------------------------------------------------
 *  This module owns ALL merchant-name BEHAVIOUR: normalisation (canonicalise +
 *  strip data-driven reference codes), matching (exact registry, with room for
 *  a fuzzy fallback), and the incidental-institution post-step. It reads its
 *  INPUTS from config data (the compiled merchant list, the descriptor-cleanup
 *  rules, the confidence thresholds) but hard-codes none of them.
 *
 *  DATA vs BEHAVIOUR (the boundary rule that keeps this maintainable):
 *    - can it be evaluated WITHOUT running code? -> DATA -> config.json /
 *      jamaica-merchants.json (merchant entries, aliases, cleanup regexes,
 *      thresholds). Regex aliases LOOK like logic but are declarative data the
 *      module compiles and runs, so they stay in the JSON.
 *    - is it a decision, an ordering, a comparison, a loop, a score? ->
 *      BEHAVIOUR -> this module.
 *
 *    - STRUCTURAL SINGLE-SOURCE ENFORCEMENT: - This module owns merchant-identity BEHAVIOUR (normalise / resolve) and is the - door categorise.js and read-statements.js use for it. category-rules.js also - imports the compiled list from merchant-intelligence.js, but only to READ it - for structural grouping (merchantGroupKey / merchantBrandLabel) - it never - re-implements identity resolution, so no second identity door forms. Do not - add a third importer without routing it through one of these two read paths.
 *
 *  CONSTRUCTION RIGOUR:
 *    createMerchantResolver() fails loudly at construction time (via requireCtx)
 *    if its declared inputs are missing - the same guarantee requireCtx already
 *    gives every render factory - so a wiring gap surfaces at boot, not on a
 *    click days later.
 * ========================================================================== */

import {
  compileMerchantIntelligence,
  resolveMerchant,
} from '../../settings/merchant-intelligence.js';
import { requireCtx } from '../core/shared-helpers.js';

/* -----------------------------------------------------------------------------
 *  PUBLIC CONTRACT
 * -----------------------------------------------------------------------------
 *
 *  createMerchantResolver(deps) -> { normalise, resolve, compiled }
 *
 *    deps (all DATA, supplied once at construction; the module never fetches):
 *      merchants      REQUIRED  the compiled merchant list from
 *                               compileMerchantIntelligence(jamaica-merchants.json, config).
 *                               (Helper compileFromRaw() below wraps that call so
 *                               app.js/manage-data.js never touch the raw resolver.)
 *      cleanupRules   REQUIRED  compiled [{ pattern:RegExp, replacement:string }]
 *                               from config.bankDescriptorCleanup.rules. Applied,
 *                               in order, ONLY by normalise()'s 'bank' profile.
 *      options        OPTIONAL  behaviour thresholds read from config:
 *                                 institutionSectorRe : RegExp  (default below)
 *                                 fuzzy               : { enabled:false,
 *                                                          minScore:number,
 *                                                          reviewBelow:number }
 *
 *    Returns a small frozen surface. Callers import ONLY this.
 *
 *
 *  normalise(descriptor, opts) -> NormalisedName
 *  ---------------------------------------------
 *    Turns a raw statement descriptor into the stable string the matcher reads.
 *    Deterministic. No matching, no config decisions beyond the cleanup DATA.
 *
 *    opts.profile  'card' | 'bank'   (REQUIRED - this is the card-vs-bank switch)
 *       'card'  : matchName = first comma-segment, lower-cased, ws-collapsed.
 *                 NO cleanup rules applied. (Byte-identical to merchant-
 *                 intelligence.js nameOf(), so card behaviour is unchanged.)
 *       'bank'  : cleaned  = cleanupRules applied in order to the descriptor,
 *                           THEN the leading transfer/ref/prefix strips and the
 *                           trailing account-tail strip (the exact chain
 *                           normaliseCounterparty already runs today);
 *                 matchName = first comma-segment of `cleaned`, lower-cased.
 *
 *    Returns:
 *      {
 *        raw        : string,   // the descriptor as given
 *        cleaned    : string,   // 'bank': post-cleanup display form; 'card': raw
 *        matchName  : string,   // the lower-cased key the matcher tests
 *        identifiers: string[], // structured ref tokens the cleanup REMOVED
 *                               // (BIC / RTGS trace ids) - reported for audit,
 *                               // never re-injected. matchType stays 'identifier'
 *                               // room if one ever becomes an identity key.
 *      }
 *
 *
 *  resolve(descriptor, opts) -> Resolution
 *  ---------------------------------------
 *    The one merchant-identity decision. Normalises (via the same profile),
 *    matches the registry, applies the incidental-institution post-step for the
 *    bank profile, and returns identity + confidence. NEVER touches amount,
 *    direction, date, or the internal-transfer flag.
 *
 *    opts.profile             'card' | 'bank'   (REQUIRED)
 *    opts.stripInstitutions   boolean   default: (profile === 'bank')
 *                             when true, a resolved bank/CU/building-society whose
 *                             own name does NOT begin the cleaned counterparty is
 *                             treated as an incidental trailing reference (a
 *                             third-party transfer), and the genuine payee is
 *                             surfaced instead of letting the institution win.
 *
 *    Returns:
 *      {
 *        merchant        : object|null,  // the researched entry, or null
 *        canonicalName   : string|null,
 *        brand           : string|null,
 *        merchantGroup   : string|null,
 *        category        : string|null,
 *        sector          : string|null,
 *        confidence      : 'high'|'medium'|'low'|null,
 *        reviewRequired  : boolean,      // the merchant's own flag (WiPay etc.)
 *        matchType       : 'identifier'|'exact'|'fuzzy'|'none',
 *        score           : number,       // 1 exact/identifier; 0..1 fuzzy; 0 none
 *        // ---- grouping + display (identity only; caller decides prefixing) ----
 *        groupKey        : string|null,  // merchantGroup||canonicalName (UPPER)
 *        displayLabel    : string|null,  // brand||canonicalName
 *        // ---- incidental-institution post-step (bank profile) ----
 *        incidentalInstitution : boolean,
 *        payee           : string|null,  // the stripped genuine payee, when incidental
 *      }
 *
 *  NOTE ON PRECEDENCE: this module decides IDENTITY only. The app-wide category
 *  precedence (a person's own correction first, then this merchant list, then
 *  the generic category rules) stays exactly where it lives today -
 *  categorise.js - which now asks THIS module for the merchant instead of
 *  importing resolveMerchant directly.
 * -------------------------------------------------------------------------- */

// Default institution classifier (DATA-shaped, overridable via options): a
// resolved merchant is a bank / credit union / building society only when its
// category is Banking & Transfers AND its sector matches this. Insurers
// (Sagicor Life), processors, remittance, brokerages are deliberately excluded,
// so the incidental-institution strip only ever touches true institutions.
const DEFAULT_INSTITUTION_SECTOR_RE = /financial\s*-\s*(bank|credit union|building society)/i;

// The 'bank' profile's leading/trailing strips - the exact chain
// normaliseCounterparty runs today, lifted verbatim so behaviour is unchanged.
function bankPrefixStrip(cleaned) {
  return String(cleaned || '')
    .replace(/^(?:[A-Z]{2,5}\s+)?transfer\s+(to|from)\s+/i, '')
    .replace(/^trf\s+(to|from):?\s+/i, '')
    .replace(/^\d{2,}[,\s-]+/, '') // leading reference group ("12345 ", "12, ")
    .replace(/^\d{4,}-/, '') // "1234-" style prefix
    .replace(/[\s,-]+\d{3,}\s*$/, '') // trailing account tail
    .replace(/[\s,-]+$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function firstSegmentLower(s) {
  return String(s == null ? '' : s)
    .split(',')[0]
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

export function createMerchantResolver(deps) {
  requireCtx(deps, ['merchants', 'cleanupRules'], 'createMerchantResolver');
  const merchants = deps.merchants;
  const cleanupRules = deps.cleanupRules || [];
  const options = deps.options || {};
  const institutionSectorRe = options.institutionSectorRe || DEFAULT_INSTITUTION_SECTOR_RE;
  const fuzzy = Object.assign(
    { enabled: false, minScore: 0.9, reviewBelow: 0.95 },
    options.fuzzy || {}
  );

  // -- internal: does a resolved merchant count as a financial institution? --
  function isInstitution(m) {
    if (!m || m.category !== 'Banking & Transfers') return false;
    return institutionSectorRe.test(String(m.sector || ''));
  }
  // -- internal: does the institution's own name FAIL to begin `cleaned`? --
  function institutionIsIncidental(m, cleaned) {
    if (!isInstitution(m)) return false;
    const hay = String(cleaned || '').toLowerCase();
    for (const a of m.aliases || []) {
      try {
        if (new RegExp('^(?:' + a + ')', 'i').test(hay)) return false;
      } catch {
        /* skip an unparsable alias, matching resolveMerchant's own guard */
      }
    }
    return true;
  }
  // -- internal: cut the trailing institution reference off, leaving the payee --
  function stripTrailingInstitution(m, cleaned) {
    const base = String(cleaned || '');
    for (const a of m.aliases || []) {
      try {
        const stripped = base.replace(new RegExp('\\s+(?:' + a + ')\\b.*$', 'i'), '').trim();
        if (stripped && /[A-Za-z]/.test(stripped) && stripped.length >= 2) return stripped;
      } catch {
        /* skip an unparsable alias */
      }
    }
    return base.trim();
  }

  function normalise(descriptor, opts = {}) {
    const raw = String(descriptor == null ? '' : descriptor);
    const profile = opts.profile;
    if (profile !== 'card' && profile !== 'bank') {
      throw new Error("merchant-resolver.normalise: opts.profile must be 'card' or 'bank'.");
    }
    if (profile === 'card') {
      // Byte-identical to merchant-intelligence.js nameOf(): first segment only,
      // NO cleanup rules. Card behaviour is unchanged.
      return {
        raw,
        cleaned: raw,
        matchName: firstSegmentLower(raw),
        identifiers: [],
      };
    }
    // 'bank': apply the data-driven cleanup rules (BIC / RTGS strips live here,
    // in config), capturing what they removed, then the prefix/tail strips.
    let s = raw.trim();
    const identifiers = [];
    for (const rule of cleanupRules) {
      if (!rule || !rule.pattern) continue;
      const before = s;
      s = s.replace(rule.pattern, rule.replacement == null ? '' : rule.replacement);
      if (s !== before) {
        const m = before.match(rule.pattern);
        if (m && m[0] && m[0].trim()) identifiers.push(m[0].trim());
      }
    }
    const cleaned = bankPrefixStrip(s);
    return { raw, cleaned, matchName: firstSegmentLower(cleaned), identifiers };
  }

  function emptyResolution() {
    return {
      merchant: null,
      canonicalName: null,
      brand: null,
      merchantGroup: null,
      category: null,
      sector: null,
      confidence: null,
      reviewRequired: false,
      matchType: 'none',
      score: 0,
      groupKey: null,
      displayLabel: null,
      incidentalInstitution: false,
      payee: null,
    };
  }

  function resolve(descriptor, opts = {}) {
    const profile = opts.profile;
    if (profile !== 'card' && profile !== 'bank') {
      throw new Error("merchant-resolver.resolve: opts.profile must be 'card' or 'bank'.");
    }
    const stripInstitutions =
      opts.stripInstitutions == null ? profile === 'bank' : !!opts.stripInstitutions;
    const norm = normalise(descriptor, { profile });
    if (!norm.matchName) return emptyResolution();

    // --- match stage: exact registry match (the compiled resolveMerchant is
    //     the ONLY matcher this module owns; it reads the SAME first-segment key
    //     normalise produced, so card and bank now share one identity source). ---
    // For the bank profile, resolveMerchant must see the CLEANED string (its own
    // nameOf takes the first segment of whatever it is handed); for card it sees
    // the raw descriptor. Passing norm.cleaned covers both.
    const m = resolveMerchant(norm.cleaned, merchants);

    if (!m && fuzzy.enabled) {
      // Fuzzy fallback lives here, gated by config thresholds and the review bar.
      // Deliberately a stub: enabling it is a separate, reversible change once the
      // exact ladder is migrated and proven on the real corpus. Returns 'none'
      // until implemented so behaviour is byte-identical to today.
      return emptyResolution();
    }
    if (!m) return emptyResolution();

    const base = {
      merchant: m,
      canonicalName: m.canonicalName || null,
      brand: m.brand || null,
      merchantGroup: m.merchantGroup || null,
      category: m.category || null,
      sector: m.sector || null,
      confidence: m.categoryConfidence || m.confidence || null,
      reviewRequired: !!m.reviewRequired,
      matchType: 'exact',
      score: 1,
      groupKey: String(m.merchantGroup || m.canonicalName || norm.cleaned).toUpperCase(),
      displayLabel: m.brand || m.canonicalName || null,
      incidentalInstitution: false,
      payee: null,
    };

    // --- post-step: incidental institution (bank profile only) ---
    if (stripInstitutions && institutionIsIncidental(m, norm.cleaned)) {
      const payee = stripTrailingInstitution(m, norm.cleaned);
      return Object.assign(base, {
        incidentalInstitution: true,
        payee,
        // identity now belongs to the PERSON, not the incidental bank: the caller
        // groups/labels by payee. groupKey/displayLabel are recomputed from it.
        groupKey: payee ? payee.toUpperCase() : null,
        displayLabel: null, // caller title-cases the payee via its own smartTitle
      });
    }
    return base;
  }

  const _resolveCache = new Map();
  function resolveCached(descriptor, opts = {}) {
    if (opts && opts.stripInstitutions != null) return resolve(descriptor, opts);
    const profile = opts && opts.profile;
    if (profile !== 'card' && profile !== 'bank') return resolve(descriptor, opts);
    const key = profile + '\u0000' + String(descriptor == null ? '' : descriptor);
    if (_resolveCache.has(key)) return _resolveCache.get(key);
    const result = resolve(descriptor, opts);
    _resolveCache.set(key, result);
    return result;
  }

  return Object.freeze({
    normalise,
    resolve: resolveCached,
    compiled: merchants,
  });
}

// Convenience wrapper so app.js / manage-data.js build the resolver WITHOUT ever
// importing the raw merchant-intelligence.js themselves (keeps this module the
// single door). Pass the parsed jamaica-merchants.json, the app config, and the
// already-compiled bankDescriptorCleanup rules.
export function compileFromRaw(rawMerchantList, config, compiledCleanupRules, options) {
  return createMerchantResolver({
    merchants: compileMerchantIntelligence(rawMerchantList, config),
    cleanupRules: compiledCleanupRules || [],
    options: options || {},
  });
}
