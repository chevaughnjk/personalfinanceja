const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

export { MONTHS };

// The one place the mock/dev device signature is declared. Previously
// re-declared independently as an identical literal in app.js,
// data-export.js and mock-personas.js.
export const DEV_SIGNATURE = 'chevcodes';

// The one place "this is a local development host" is decided. Previously
// re-declared independently as an identical array in app.js (service-worker
// registration) and mock-personas.js (the sample-data switcher's gate).
export const LOCAL_DEV_HOSTS = ['localhost', '127.0.0.1', '::1', '0.0.0.0'];
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
export function roundMoney(n) {
  return parseFloat(Number(n).toFixed(2));
}
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
  return (
    (neg ? '-' : '') +
    symbol +
    Math.abs(Number(n) || 0).toLocaleString(locale, {
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    })
  );
}

// Whether the person has asked the system to minimise motion. Guarded so this
// module stays importable in Node (tests) where window/matchMedia are absent.
export function prefersReducedMotion() {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}

// Whether privacy mode is currently on - a screen-presentation state only
// (blur), never a data-redaction one; export, print and "Copy summary"
// all read the real, unblurred figures regardless of this. Read directly
// from the root element's dataset, the same mechanism theme already uses
// (document.documentElement.dataset.theme), so no ctx wiring is needed at
// any call site - any render file can call this the same way several
// already call document.getElementById directly (focusTransactionRow).
// Guarded for Node/test environments exactly like prefersReducedMotion.
export function isPrivacyMode() {
  return (
    typeof document !== 'undefined' && document.documentElement.dataset.privacy === 'on'
  );
}
// The ONE smooth-scroll helpers every drill-down, "see all" and the new
// back-to-top button now share. Previously the same
// scrollIntoView({ behavior:'smooth', block:'start' }) was hand-written in
// several places and none of them honoured prefers-reduced-motion; routing all
// of them through here fixes that in a single place and keeps the behaviour
// identical everywhere. Both no-op safely off the main thread / in tests.
export function smoothScrollToTop() {
  if (typeof window === 'undefined') return;
  window.scrollTo({
    top: 0,
    left: 0,
    behavior: prefersReducedMotion() ? 'auto' : 'smooth',
  });
}
export function smoothScrollToEl(target) {
  if (typeof document === 'undefined') return;
  const node = typeof target === 'string' ? document.querySelector(target) : target;
  if (!node) return;
  // Open every closed <details> ancestor (and the target itself, if it is
  // one) before measuring position - scrolling to something inside a
  // collapsed disclosure previously measured a hidden, zero-height box and
  // landed nowhere meaningful, since the content genuinely was not rendered
  // open yet.
  let cur = node;
  while (cur) {
    if (cur.tagName === 'DETAILS' && !cur.open) cur.open = true;
    cur = cur.parentElement;
  }
  const stack = document.querySelector('.topbar-stack');
  const chrome = stack ? stack.getBoundingClientRect().height : 0;
  const top = node.getBoundingClientRect().top + window.scrollY - chrome - 12;
  window.scrollTo({
    top: Math.max(0, top),
    left: 0,
    behavior: prefersReducedMotion() ? 'auto' : 'smooth',
  });
  // Move focus to whatever was just scrolled to - preventScroll stops the
  // browser's own default focus-scroll fighting the scroll just performed.
  // A no-op on any target with no tabindex (browsers refuse to focus a
  // non-focusable element), so every EXISTING caller targeting a plain
  // element is unaffected; only a target that opts in (tabindex="-1",
  // e.g. '#acct-tx') gains this.
  // KNOWN, ACCEPTED TRADE-OFF: {preventScroll:true} was unsupported on
  // Safari before version 15 (2021) - on an older Safari, focus() may
  // trigger its own extra scroll-into-view immediately after the explicit
  // scrollTo above, causing a brief, self-correcting double-scroll. Not
  // shimmed, since this app's supported range is expected to be modern
  // evergreen browsers; noted here rather than silently left unexamined.
  if (node.focus) node.focus({ preventScroll: true });
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
      `${factoryName}: ctx is missing required dependenc${missing.length === 1 ? 'y' : 'ies'}: ${missing.join(', ')}. ` +
        `Check the object built for ${factoryName} at its call site (app.js) - each of these names must be present there.`
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
  c.special = Object.assign(
    {
      fallback: 'Uncategorised',
      paymentCategory: 'Card Payment',
      refundCategory: 'Refund / Reversal',
      feeCategories: ['Fees & Interest', 'Government & Tax'],
    },
    c.special || {}
  );
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
  return m ? +m[1] * 12 + (+m[2] - 1) : NaN;
}

// The signed distance, in months, from a to b ('YYYY-MM' keys). NaN when
// either key does not parse, so a caller can treat that as "cannot judge"
// rather than a false zero.
export function monthsBetween(a, b) {
  const ia = monthIndex(a),
    ib = monthIndex(b);
  return Number.isNaN(ia) || Number.isNaN(ib) ? NaN : ib - ia;
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

export const MONTHS_SHORT = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

export function isoDate(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? '' : value.toISOString().slice(0, 10);
  }
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value == null ? '' : value));
  return m ? `${m[1]}-${m[2]}-${m[3]}` : '';
}

export function formatDisplayDate(iso) {
  const s = String(iso == null ? '' : iso);
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return s;
  const mi = +m[2] - 1;
  if (mi < 0 || mi > 11) return s;
  return `${m[3]}-${MONTHS_SHORT[mi]}-${m[1].slice(2)}`;
}

export function yieldToBrowser() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

// The typical day-of-month a commitment lands on...
export function medianDayOfMonth(isoDates) {
  const days = (isoDates || [])
    .map((d) => {
      const m = /^\d{4}-\d{2}-(\d{2})/.exec(String(d == null ? '' : d));
      return m ? +m[1] : null;
    })
    .filter((d) => d != null)
    .sort((a, b) => a - b);

  if (!days.length) return null;

  const mid = Math.floor(days.length / 2);

  return days.length % 2 ? days[mid] : Math.round((days[mid - 1] + days[mid]) / 2);
}

export function addDaysIso(iso, days) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso == null ? '' : iso));
  if (!m) return iso;

  const ms = Date.UTC(+m[1], +m[2] - 1, +m[3]) + days * 86400000;

  return new Date(ms).toISOString().slice(0, 10);
}

export function isoDay(iso) {
  const m = /^\d{4}-\d{2}-(\d{2})/.exec(String(iso == null ? '' : iso));
  return m ? +m[1] : 0;
}

export function median(nums) {
  if (!nums || !nums.length) return 0;
  const s = nums.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

export function detectSustainedRise(monthlyEntries, opts = {}) {
  const recentWindow = opts.recentWindow == null ? 3 : opts.recentWindow;
  const minEarlierMonths = opts.minEarlierMonths == null ? 3 : opts.minEarlierMonths;
  const steadyTolerance = opts.steadyTolerance == null ? 0.15 : opts.steadyTolerance;
  const riseThreshold = opts.riseThreshold == null ? 0.2 : opts.riseThreshold;
  const entries = (monthlyEntries || []).slice().sort((a, b) => (a.month < b.month ? -1 : 1));
  if (entries.length < recentWindow + minEarlierMonths) return null;
  const recent = entries.slice(-recentWindow);
  const earlier = entries.slice(0, entries.length - recentWindow);
  if (earlier.length < minEarlierMonths) return null;
  const isSteady = (list, centre) =>
    list.every((e) => Math.abs(e.amount - centre) <= centre * steadyTolerance);
  const earlierMedian = median(earlier.map((e) => e.amount));
  if (!(earlierMedian > 0) || !isSteady(earlier, earlierMedian)) return null;
  const recentMedian = median(recent.map((e) => e.amount));
  if (!isSteady(recent, recentMedian)) return null;
  const riseRatio = (recentMedian - earlierMedian) / earlierMedian;
  if (riseRatio < riseThreshold) return null;
  return {
    oldTypical: roundMoney(earlierMedian),
    newTypical: roundMoney(recentMedian),
    sinceMonth: recent[0].month,
  };
}

// ---- filter-applicability predicates (Right Now's merged ledger) ----
// Pure predicates over state's filter facets, extracted here for the SAME
// reason drillToTransactions (below) is here: this is app-wide DECISION
// logic (whether/how a drill applies), not DOM rendering - it belongs
// beside this file's other "declared once, never hand-copied" helpers
// (monthIndex, recurringStatus) rather than scattered between app.js's
// closure and one specific render file. Each takes state explicitly, so a
// proof can construct a minimal state stub and assert these directly.

// Whether Right Now's merged ledger is genuinely narrowed by an active
// drill. Deliberately NOT the same as CARD_FACETS/BANK_FACETS' own
// activeFilterCount - hideInternal is countable there but toggling it OFF
// shows MORE rows, not fewer, which would make "Showing a filtered slice"
// a lie. This checks only facets that actually narrow what is visible.
export function ledgerIsNarrowed(state) {
  const f = state.filter,
    bf = state.bankFilter;
  return (
    f.category !== 'all' ||
    f.kind !== 'all' ||
    f.merchant !== '' ||
    f.reviewOnly ||
    f.foreignOnly ||
    f.min != null ||
    f.max != null ||
    f.search !== '' ||
    bf.payeeKey !== '' ||
    (bf.kind && bf.kind !== 'all') ||
    bf.search !== '' ||
    (state.bankAccount && state.bankAccount !== 'all')
  );
}

// Bank rows carry no spend category, merchant identity, foreign flag or
// review status at all (confirmed against the corpus: 0 bank rows have a
// Category) - so a category/merchant/reviewOnly/foreignOnly drill can never
// meaningfully narrow them; they are hidden entirely rather than sailing
// through unfiltered underneath a card-only drill.
export function bankRowsInapplicable(state) {
  const f = state.filter;
  return f.category !== 'all' || f.merchant !== '' || f.reviewOnly || f.foreignOnly;
}

// The mirror: cards carry no bank-style payee/counterparty identity, so a
// payee drill hides card rows entirely rather than showing them unfiltered.
export function cardRowsInapplicable(state) {
  return !!(state.bankFilter && state.bankFilter.payeeKey);
}

// ---- the one shared "drill to a card-side filter on Right Now's merged
// ledger" helper ----
// Every card-only drill (category, merchant, reviewOnly, foreignOnly) in
// this app goes through here now, whether launched FROM Right Now itself
// (cards-render.js's category/merchant/foreign/recurring panels, right-
// now-render.js's own "Worth a look" Refine actions and "Where money went"
// rows) or from a DIFFERENT tab entirely (Activity's treemap and ranked
// list). This was previously up to nine separately hand-written copies
// across three files, several of which never reset the BANK-side drill
// facets at all - so a stale payeeKey left over from an earlier drill
// could silently combine with a fresh card-only filter launched from the
// SAME tab. Declared once here, the same "declare a rule once, derive
// every check from it" principle CARD_FACETS/BANK_FACETS already
// established for the filter registries themselves (app.js).
//
// deps are passed explicitly (never closed over) so this is directly
// unit-testable with a minimal fake state/functions - the same pure+
// wrapper split goal-progress-ctx.js's buildNewEngineProgressCtx already
// uses, for the identical reason: logic nested inside bootUI's closure
// can never be imported directly by a standing proof.
//
// opts.scroll defaults to true (every call site's original behaviour)
// but can be overridden - preserves a real, pre-existing nuance: a row
// toggling ITSELF off (a deselect) should not force a scroll, only a
// genuinely NEW selection should.
export function drillToTransactions(deps, patch, opts = {}) {
  const { state, trackUsage, resetBankDrillFacets, applyFilter } = deps || {};
  const missing = ['state', 'trackUsage', 'resetBankDrillFacets', 'applyFilter'].filter(
    (k) => typeof (deps || {})[k] === 'undefined'
  );
  if (missing.length) {
    throw new Error(
      `drillToTransactions: missing required dependenc${missing.length === 1 ? 'y' : 'ies'}: ${missing.join(', ')}.`
    );
  }
  const scroll = opts.scroll !== undefined ? opts.scroll : true;
  // Drills land on Activity's Transactions tab (Right Now retired). Set both
  // the view and the sub-tab, so a drill launched from anywhere - a treemap
  // tile, a "where money went" row, a category link - opens the filtered
  // transaction list, not Activity's Analysis cards.
  if (state.view !== 'activity') {
    trackUsage('view-activity');
    state.view = 'activity';
  }
  state.activityTab = 'transactions';
  resetBankDrillFacets();
  applyFilter(patch, { expand: true, scroll });
}

// THE one shared "anchor to ONE specific transaction" helper - the
// identity-level counterpart to drillToTransactions above. Every existing
// drill (category, merchant, payee, kind) narrows the merged ledger to a
// CLASS of rows and scrolls to the top of the ledger card; when a click
// genuinely refers to a single transaction, that still leaves a person to
// read down a shortened list themselves to find it. This clears every
// filter facet - card, bank, AND the Transactions tab's own free-text
// search (previously untouched by resetCardDrillFacets/resetBankDrillFacets,
// since _txSearch lives outside CARD_FACETS/BANK_FACETS entirely - a real
// stale-filter risk this closes) - rather than applying a narrowing patch,
// since with every facet cleared any transaction is reachable regardless of
// its own category or merchant. No per-call-site filter knowledge is
// required. target: { ledger: 'card'|'bank', id }.
export function drillToTransaction(deps, target, opts = {}) {
  const { state, trackUsage, resetCardDrillFacets, resetBankDrillFacets, resetTxSearch, render } =
    deps || {};
  const missing = [
    'state',
    'trackUsage',
    'resetCardDrillFacets',
    'resetBankDrillFacets',
    'resetTxSearch',
    'render',
  ].filter((k) => typeof (deps || {})[k] === 'undefined');
  if (missing.length) {
    throw new Error(
      `drillToTransaction: missing required dependenc${missing.length === 1 ? 'y' : 'ies'}: ${missing.join(', ')}.`
    );
  }
  if (!target || !target.ledger || target.id == null) return;
  if (state.view !== 'activity') {
    trackUsage('view-activity');
    state.view = 'activity';
  }
  state.activityTab = 'transactions';
  resetCardDrillFacets();
  resetBankDrillFacets();
  resetTxSearch();
  state.showAllTx = true;
  state.bankShowAllTx = true;
  // Consumed once by renderMergedLedger (activity-render.js), which forces
  // this one row into the DOM regardless of the normal 10-row cap, marks it
  // already-open, and clears this key itself - so a later, unrelated
  // render() can never re-trigger the scroll/highlight a second time.
  state._focusTxnKey = target.ledger + ':' + target.id;
  render();
  focusTransactionRow('tx-' + target.ledger + '-' + target.id);
  void opts;
}

// Scrolls to and opens ONE specific transaction row (by the id
// renderMergedLedger gives every row it builds), centring it in the
// viewport rather than aligning it to the top the way smoothScrollToEl does
// for a whole card - a mid-list row aligned to the top can still sit hidden
// under the sticky top bar or, on mobile, the fixed bottom nav. block:
// 'center' has no notion of either fixed chrome (scrollIntoView cannot
// account for it natively), but centring makes both far less likely than
// top-alignment; a precise pixel-perfect clearance calculation was not
// pursued here - a deliberate, noted trade-off for a first pass.
export function focusTransactionRow(id) {
  if (typeof document === 'undefined') return;
  const node = document.getElementById(id);
  if (!node) return;
  let cur = node;
  while (cur) {
    if (cur.tagName === 'DETAILS' && !cur.open) cur.open = true;
    cur = cur.parentElement;
  }
  node.scrollIntoView({
    behavior: prefersReducedMotion() ? 'auto' : 'smooth',
    block: 'center',
  });
  if (node.focus) node.focus({ preventScroll: true });
}
