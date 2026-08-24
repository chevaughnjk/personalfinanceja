const MONTHS = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
export { MONTHS };
// FNV-1a: a small, fast, deterministic string hash. Used for stable
// transaction identity and statement content hashing. Not cryptographic;
// it only needs to be stable and collision-resistant enough for dedupe.
export function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return ('00000000' + h.toString(16)).slice(-8);
}
export function toIso(d) {
  // "28-Nov-2024" -> "2024-11-28". Leaves anything unrecognised untouched.
  const m = /^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(d);
  if (!m) return d;
  const mi = MONTHS.indexOf(m[2].toLowerCase());
  if (mi < 0) return d;
  return `${m[3]}-${String(mi + 1).padStart(2, '0')}-${m[1].padStart(2, '0')}`;
}
export function money(s) {
  return parseFloat(String(s).replace(/\$/g, '').replace(/,/g, '').replace(/\s/g, ''));
}
export function monthKey(iso) {
  const m = /^(\d{4})-(\d{2})-\d{2}$/.exec(iso);
  return m ? `${m[1]}-${m[2]}` : 'unknown';
}
// Decimal rounding on the exact binary value (toFixed), which lines up with
// the source tool's Python round() for the supplied statements. Using the
// exact value avoids the float-multiply artefact that a *100 approach hits.
export function roundMoney(n) { return parseFloat(Number(n).toFixed(2)); }
// Cut a "Brand - Branch" string at the first hyphen whose preceding text
// already holds three or more letters, so a real branch tail (e.g.
// "Total - Manor Park") is dropped while a brand-internal hyphen (Hi-Lo,
// Bk-Bar) is kept intact. This is the ONE shared copy of the rule that
// categorise.js (merchantHead) and category-rules.js (cutBranchTail) both
// delegate to, so the two can never drift apart.
export function cutAtBranchHyphen(s) {
  const str = String(s == null ? '' : s);
  for (let i = 0; i < str.length; i++) {
    if (str[i] !== '-') continue;
    const head = str.slice(0, i).replace(/[\s-]+$/, '');
    if ((head.match(/[A-Za-z]/g) || []).length >= 3) return head;
  }
  return str;
}

// Capitalise the first letter of a sentence/word, leaving everything else
// untouched. Previously re-derived independently in three places (app.js's
// renderOverview, the pre-consolidation buildOverviewInsights, and the
// shared buildBankAppropriateInsights in reporting.js) as an identical
// one-line copy each time.
export function capitaliseFirst(s) {
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

// Shared money-formatting core, used by both money0 (app.js, card side) and
// bankMoney (accounts-render.js, bank side, which layers a currency-prefix
// branch on top). Previously each independently re-derived the identical
// locale/decimals/negative-sign/toLocaleString logic; bankMoney additionally
// guarded with Number(n) || 0 so a bad amount rendered as symbol+0.00, while
// money0 did not, so the identical bad amount would have rendered as
// "$NaN" - a small, silent divergence the duplication itself produced. The
// shared core applies that same NaN-safe guard everywhere now.
export function formatMoney(n, symbol, locale, decimals) {
  const neg = n < 0;
  return (neg ? '-' : '') + symbol + Math.abs(Number(n) || 0).toLocaleString(locale, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

// Whether the person has asked the system to minimise motion. Guarded so this
// module stays importable in Node (tests) where window/matchMedia are absent.
export function prefersReducedMotion() {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

// The ONE smooth-scroll helpers every drill-down, "see all" and the new
// back-to-top button now share. Previously the same
// scrollIntoView({ behavior:'smooth', block:'start' }) was hand-written in
// several places and none of them honoured prefers-reduced-motion; routing all
// of them through here fixes that in a single place and keeps the behaviour
// identical everywhere. Both no-op safely off the main thread / in tests.
export function smoothScrollToTop() {
  if (typeof window === 'undefined') return;
  window.scrollTo({ top: 0, left: 0, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
}
export function smoothScrollToEl(target) {
  if (typeof document === 'undefined') return;
  const node = typeof target === 'string' ? document.querySelector(target) : target;
  if (!node) return;
  const stack = document.querySelector('.topbar-stack');
  const chrome = stack ? stack.getBoundingClientRect().height : 0;
  const top = node.getBoundingClientRect().top + window.scrollY - chrome - 12;
  window.scrollTo({ top: Math.max(0, top), left: 0, behavior: prefersReducedMotion() ? 'auto' : 'smooth' });
}

// Fails loudly and specifically at FACTORY-CONSTRUCTION time when a factory's
// declared dependencies are missing from the ctx object handed to it at its
// call site - rather than surfacing as a cryptic "X is not defined" or "X is
// not a function" deep inside a click handler, possibly minutes after the
// page loaded, only when the exact control that needed X happens to be used.
// This is the SAME class of problem the filter-facet registry (app.js's
// CARD_FACETS/BANK_FACETS) already fixed for state, applied here to
// dependency injection: which dependencies a factory needs was kept in sync
// BY HAND across three places - the factory's own destructure, the object
// built for it at its call site, and the real definition of each name - with
// nothing enforcing the sync. That gap has already caused four separate
// runtime failures in this app (formatMoney, renderKindTag x2,
// openCsvExportDialog, and openModal/closePicker). Calling this as the FIRST
// line of every factory, before its own destructure, turns a silent
// undefined into an immediate, named error: which factory, which
// dependency(ies), checked once at app boot instead of discovered by a
// person's click days later.
export function requireCtx(ctx, keys, factoryName) {
  const missing = keys.filter((k) => !(k in (ctx || {})) || ctx[k] === undefined);
  if (missing.length) {
    throw new Error(
      `${factoryName}: ctx is missing required dependenc${missing.length === 1 ? 'y' : 'ies'}: ${missing.join(', ')}. `
      + `Check the object built for ${factoryName} at its call site (app.js) - each of these names must be present there.`
    );
  }
}

// Defensive defaults for the two config.json sections read with NO guard
// anywhere else in the app: cfg.special (state.cfg.special.fallback, read via
// FALLBACK() from isReview/recompute/renderAttention/buildInsights and more,
// plus paymentCategory/refundCategory/feeCategories, read directly in
// recompute()) and cfg.app (state.cfg.app.name, read at boot and in every
// printed-report model). Every OTHER config section already degrades safely
// at its own call site (state.cfg.currency || {}, cfg.insights || {},
// state.cfg.merchants && ..., state.cfg.bankDescriptorCleanup && ...), so a
// config.json missing one of those quietly falls back to a sensible default.
// These two never got that guard, so a config.json missing either section
// throws the FIRST time it is read - crashing boot, or a config reload,
// entirely - the same class of problem requireCtx (above) fixes for
// dependency injection, applied here to the two config reads with the
// highest blast radius. Called once at boot (app.js's start()) and once on
// every "Reload configuration" click (manage-data.js's reloadConfig) - the
// two places state.cfg is assigned from a freshly-fetched file - so a
// malformed or partial config.json can never crash either path.
// Deliberately narrow, NOT a full config schema validator: config.json is
// small and developer-maintained and changes rarely, unlike ctx wiring,
// which changes on nearly every factory edit. A complete version would
// extend this to one normaliseConfig(cfg) pass covering every section
// (categories, keepUpper, smallWords, currency) in one place instead of the
// scattered inline `|| {}` guards those sections currently rely on - not
// needed today, noted so it is not lost.
export function withConfigDefaults(cfg) {
  const c = cfg || {};
  c.special = Object.assign({
    fallback: 'Uncategorised',
    paymentCategory: 'Card Payment',
    refundCategory: 'Refund / Reversal',
    feeCategories: ['Fees & Interest', 'Government & Tax'],
  }, c.special || {});
  c.app = Object.assign({ name: 'Personal Finance Analyser' }, c.app || {});
  return c;
}

// Turn a 'YYYY-MM' month key into a comparable integer index, so two
// occurrence-months can be measured for distance. Returns NaN for anything
// that is not a well-formed month key. This was previously reimplemented
// independently, byte-for-byte, in two places - reporting.js's private
// recurringMonthIndex (used by maxConsecutiveGap, the card-side recurring
// cadence gate) and an inline duplicate inside read-statements.js's private
// standingDebitMonthGap (the bank-side equivalent) - the exact class of
// hand-copied-logic risk this session has already consolidated three times
// today (cutAtBranchHyphen, csvEscape, sortBankRecords). Both now delegate
// here. Lives in shared-helpers.js rather than reporting.js because
// read-statements.js does not import reporting.js (reporting.js imports
// read-statements.js; the reverse would be a cycle), and both already import
// this file.
export function monthIndex(ym) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(ym == null ? '' : ym));
  return m ? (+m[1]) * 12 + (+m[2] - 1) : NaN;
}

// The signed distance, in months, from a to b ('YYYY-MM' keys). NaN when
// either key does not parse, so a caller can treat that as "cannot judge"
// rather than a false zero.
export function monthsBetween(a, b) {
  const ia = monthIndex(a), ib = monthIndex(b);
  return (Number.isNaN(ia) || Number.isNaN(ib)) ? NaN : ib - ia;
}

// Whether a recurring commitment - a card merchant or a bank standing debit -
// is still ACTIVE or has LAPSED, given the month it was last actually seen and
// the most recent month the SAME ledger it was detected from actually reaches.
// This is the missing forward half of recurrence detection: detectRecurring
// and detectBankStandingDebits already gate a candidate on maxGapMonths
// BACKWARD (no two historical occurrences may be more than maxGapMonths
// apart, or it is never accepted as recurring at all) - but neither of them
// used to ask whether that same tolerance had since been breached going
// forward, so a commitment last seen in January still read as an active
// monthly cost in August. This reuses the identical maxGapMonths tolerance
// for the forward check, so "recurring" and "still recurring" share one
// cadence definition rather than two independently invented numbers - see
// CARD_FACETS/BANK_FACETS elsewhere in this app for the same "declare a
// tolerance once, derive every check from it" principle.
//
// latestLedgerMonth must be the newest month actually present in the SAME
// ledger the commitment came from (every row in the array passed to the
// detector, not just this one payee's own rows) - never real calendar
// "today". This mirrors how detectIncompleteMonth/latestCompleteMonth
// already anchor "how current is this" on the newest imported statement
// rather than wall-clock time, so a person who has not imported a statement
// in months never sees every commitment wrongly flagged lapsed just because
// the calendar moved on without them.
//
// Two states only, matching every other status this app surfaces
// (cardBehaviourState's pays-in-full/paying-interest/insufficient,
// buildStatementCoverage's full/partial/unknown) - a continuous confidence
// score would be new UI vocabulary this app does not otherwise use anywhere.
// An unparseable month key returns 'active' rather than guessing lapsed, the
// same defensive-by-construction default buildStatementCoverage uses for its
// own 'unknown' case.
export function recurringStatus(lastMonth, latestLedgerMonth, maxGapMonths = 2) {
  const gap = monthsBetween(lastMonth, latestLedgerMonth);
  if (!Number.isFinite(gap)) return 'active';
  return gap > maxGapMonths ? 'lapsed' : 'active';
}