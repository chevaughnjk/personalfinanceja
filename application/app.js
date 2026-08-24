/*
 * Personal Finance Analyser - shared application core.
 *
 * One file holds every piece of shared behaviour so the desktop (Electron)
 * and the phone (installed PWA) run the identical logic:
 *   - PDF text extraction and statement parsing
 *   - wrapped-description and stranded-amount repair
 *   - foreign-currency handling
 *   - categorisation (ported verbatim from the original Python tool)
 *   - display-name formatting (presentation only)
 *   - transaction identity and duplicate detection
 *   - IndexedDB reads, writes and schema upgrades
 *   - totals, monthly / category / merchant analysis and insights
 *   - search, filtering and sorting
 *   - history import / export and merge (one encrypted file)
 *   - CSV and printable-report export
 *   - the shared desktop / mobile interface
 *
 * The numbers never depend on how names are shown: every total, count,
 * grouping and category is computed from the original raw statement text,
 * and name tidying is applied only for display. This mirrors the source tool.
 *
 * The pure logic below is exported so it can be unit-tested in Node with no
 * browser present. The interface only boots when a real DOM exists.
 */

import { categoryRuleFromStoreRecord, categoryRuleStoreRecord, exportCategoryRulesFile, mergeCategoryRules, merchantRuleKeyFromDescription, merchantGroupKey, compileBrandRules, parseCategoryRulesFile, rulesToMerchantOverrides, upsertCategoryRule } from '../settings/category-rules.js';
import { MONTHS, fnv1a, toIso, money, monthKey, roundMoney, capitaliseFirst, formatMoney, smoothScrollToTop, smoothScrollToEl, withConfigDefaults } from './shared-helpers.js';
import { statementPeriod, buildTxn, findStrandedDescription, lineContent, isContinuationLine, isMerchantFragment, isMerchantHeadFragment, isForexFragmentDesc, stripFooterPrefix, findAdjacentAmountFragment, findAdjacentMerchantFragment, mergeForexDescription, parseStatementLines, extractLines, statementContentHash, cardMoney, parseCardStatementSummary, splitCardStatements, parseCardPeriod, bankStatementPeriod, bankAccountNumber, makeBankDateResolver, bankStatementCurrency, isBankNoise, cleanBankCounterparty, setBankDescriptorCleanupRules, splitBankStatements, parseOneBankStatement, parseBankStatementLines, detectStatementFormat, reconcileOne, reconcileBankStatement, bankTransactionIdentity, bankStatementHash, transactionIdentity, cardStatementHash, linkCardPayments, cardAccountsFromLines, assignCardStatementKeys, mergeBankTransactions, mergeTransactions, reconcileCardStatement, cardStatementHealth, counterpartyDigits, counterpartyAccountTokens, buildOwnAccountIndex, normaliseCounterparty, classifyInternalTransfers, isCashSelfDeposit, applyLedgerRules, accountClosingBalance, bankCounterpartyGroups, externalOutflowShortlist, bankFlowOverTime, detectBankStandingDebits, analyseCombinedOverview, analyseRollup, overviewVerdict, detectCardStatementFormat, parseNcbStatementLines, splitNcbStatements, buildNcbStatementRecord } from './read-statements.js';
import { compileRules, categorise, smartTitle, merchantLabel } from './categorise.js';
import { compileMerchantIntelligence } from '../settings/merchant-intelligence.js';
import { createMerchantResolver } from './merchant-resolver.js';
import { Store } from './storage.js';
import { buildRows, summarise, attentionItems, orderCategoriesForPicker, monthName, detectIncompleteMonth, resolvePeriod, analysePeriod, analysisForWindow, ymToday, detectRecurring, foreignSummary, missingMonths, monthlyCommitmentsTotal, exportHistory, importHistory, toCSV, bankToCSV, createPrintReports, buildBankAppropriateInsights, buildHeroSection, renderInsightList, renderExplainer, buildStatementCoverage } from './reporting.js';
import { createAccountsRenderer } from './accounts-render.js';
import { createCategoryPicker } from './category-picker.js';
import { createManageData } from './manage-data.js';
import { createDataExport } from './data-export.js';
import { createCardsRenderer } from './cards-render.js';


function bootUI() {
  const $ = (sel, root = document) => root.querySelector(sel);
  const el = (tag, attrs = {}, ...kids) => {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null) continue;
      if (k === 'class') n.className = v;
      else if (k === 'html') n.innerHTML = v;
      else if (k === 'dataset') Object.assign(n.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
      else n.setAttribute(k, v);
    }
    for (const kid of kids.flat()) if (kid != null && kid !== false) n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return n;
  };

  // Turn a trusted, static icon markup string into a REAL DOM/SVG node so it can
  // be appended as an element child. Passing an icon string straight into el()
  // as a child would create a text node, printing the literal <svg…> markup.
  // Only ever called with the hand-written icon strings below, never with data.
  const icon = (markup) => {
    const tpl = document.createElement('template');
    tpl.innerHTML = String(markup).trim();
    return tpl.content.firstChild || document.createTextNode('');
  };

  /* ===================================================================
   * Filter / drill-facet registry - the ONE place every filter field for
   * BOTH ledgers is declared: its default, whether it is a DRILL facet or
   * an ADDITIVE control, and whether it counts toward "a filter is active".
   * clearFilters(), applyFilter()'s drill reset, activeFilterCount() and
   * their Accounts twins below are all DERIVED from these two tables -
   * nothing past this point re-lists a field name by hand.
   *
   * Previously the same field set was hand-copied in the initial state
   * object, in clearFilters(), in a manual if-chain counting active
   * filters, and (for Accounts) again at each drill entry point. A facet
   * added to only one of those silently escaped the others - exactly the
   * shape of bug that combined an account filter with a payee filter and
   * broke "Regular payments" on mobile.
   *
   * additive vs drill, and why each field is classified the way it is:
   *   - DRILL (additive:false, the default): a facet a click sets to jump
   *     to a slice - a category, a merchant, a payee, an account, a search
   *     term. Resets to its default the instant ANY drill fires, so two
   *     drills can never silently combine into an intersection nobody
   *     asked for. Search is classified as a DRILL facet, not additive -
   *     it is a narrowing control in the same risk class as category or
   *     merchant, so leaving it active across a drill risks the exact
   *     "combined into an empty result" failure this pass fixes.
   *   - ADDITIVE (additive:true): a facet the person dials in as a manual
   *     SCOPE choice rather than a destination - Month, Min/Max on Cards;
   *     the internal-transfers toggle on Accounts. These survive a fresh
   *     drill on purpose: resetting Month every time a category is
   *     clicked would silently discard a range the person deliberately set.
   *   Leaving `additive` off a new entry defaults it to a drill facet -
   *   the safe failure mode.
   * =================================================================== */
  const CARD_FACETS = [
    { key: 'search',        default: '',    additive: false, countable: true },
    { key: 'month',         default: 'all', additive: true,  countable: true },
    { key: 'min',           default: null,  additive: true,  countable: true },
    { key: 'max',           default: null,  additive: true,  countable: true },
    { key: 'category',      default: 'all', additive: false, countable: true },
    { key: 'kind',          default: 'all', additive: false, countable: true },
    { key: 'merchant',      default: '',    additive: false, countable: true },
    // Display-only companion of `merchant` - never checked on its own, so it
    // must not count a second time toward "how many filters are active".
    { key: 'merchantLabel', default: '',    additive: false, countable: false },
    { key: 'foreignOnly',   default: false, additive: false, countable: true },
    { key: 'reviewOnly',    default: false, additive: false, countable: true },
  ];
  function cardFilterDefaults() {
    const out = {}; for (const f of CARD_FACETS) out[f.key] = f.default; return out;
  }
  function clearFilters() { state.filter = cardFilterDefaults(); }
  // Resets ONLY the drill facets, leaving every additive control (Month,
  // Min/Max) exactly as the person left it. Run by applyFilter() before it
  // applies a fresh drill's own patch.
  function resetCardDrillFacets() {
    for (const f of CARD_FACETS) if (!f.additive) state.filter[f.key] = f.default;
  }
  const activeFilterCount = () => CARD_FACETS.filter((f) => f.countable && state.filter[f.key] !== f.default).length;

  // Accounts' twin. bankAccount physically lives OUTSIDE state.bankFilter (it
  // predates that object) - exactly why it and payeeKey previously had two
  // INDEPENDENT, hand-written reset paths that drifted apart. Each entry
  // carries its own get/set so the registry reaches into either location
  // uniformly, without a wider rename of every state.bankAccount reference.
  const BANK_FACETS = [
    { key: 'bankAccount',  default: 'all', additive: false, countable: true,
      get: () => state.bankAccount,             set: (v) => { state.bankAccount = v; } },
    { key: 'payeeKey',     default: '',    additive: false, countable: true,
      get: () => state.bankFilter.payeeKey,     set: (v) => { state.bankFilter.payeeKey = v; } },
    // Display-only companion of payeeKey - not counted a second time.
    { key: 'payeeLabel',   default: '',    additive: false, countable: false,
      get: () => state.bankFilter.payeeLabel,   set: (v) => { state.bankFilter.payeeLabel = v; } },
    // A narrowing control, same risk class as bankAccount/payeeKey - resets
    // on a fresh drill so it can never silently intersect with a NEW slice.
    { key: 'search',       default: '',    additive: false, countable: true,
      get: () => state.bankFilter.search,       set: (v) => { state.bankFilter.search = v; } },
    // A display preference (which rows show), not a narrowing target - the
    // same reasoning as Cards' Month - so it survives a drill.
    { key: 'hideInternal', default: true,  additive: true,  countable: true,
      get: () => state.bankFilter.hideInternal, set: (v) => { state.bankFilter.hideInternal = v; } },
  ];
  function bankFilterDefaults() {
    const out = {}; for (const f of BANK_FACETS) if (f.key !== 'bankAccount') out[f.key] = f.default; return out;
  }
  function clearBankFilters() { for (const f of BANK_FACETS) f.set(f.default); }
  function resetBankDrillFacets() { for (const f of BANK_FACETS) if (!f.additive) f.set(f.default); }
  function clearBankFacet(key) { const f = BANK_FACETS.find((x) => x.key === key); if (f) f.set(f.default); }
  const bankActiveFilterCount = () => BANK_FACETS.filter((f) => f.countable && f.get() !== f.default).length;

  const state = {
    cfg: null, compiled: [], keepUpper: new Set(), smallWords: new Set(), brandRules: [], merchants: [], resolver: null,
    records: [], rules: [], rows: [], allSummary: null, coverage: null,
    warnings: [],
    period: { type: 'latest-complete', from: null, to: null },
    // Built from CARD_FACETS above - the ONE declared source of these fields.
    filter: cardFilterDefaults(),
    sort: { key: 'date', dir: 'desc' },
    showAllTx: false,
    catColour: {},
    deviceId: null,
    lastImportedFrom: null,
    // Bank ledger (Phase 1). Held separately from card `records`; `view` picks
    // which ledger is on screen and only appears once bank data exists.
    bankRecords: [], myAccounts: [], cardAccounts: [], view: 'cards', bankWarnings: [], bankAccount: 'all',
    // Accounts-ledger transaction filter (Recommendation 1). Parallel to
    // state.filter (which is card-only: it reads category/kind/merchant/etc.
    // that bank rows do not have), so the two ledgers keep separate filter
    // models rather than one conflated pipeline. hideInternal defaults true so
    // the Accounts transaction list opens as a guided, de-noised view -
    // internal transfers are the bulk of the rows and are already excluded
    // from money in/out - instead of an uncapped wall; the toggle brings them
    // back. No sort here on purpose: the running-balance column is only
    // coherent newest-first, unlike Cards (which has no running balance).
    // Built from BANK_FACETS above (bankAccount itself stays a plain literal
    // just below, since it lives outside this object - see BANK_FACETS' own
    // comment for why).
    bankFilter: bankFilterDefaults(),
    bankShowAllTx: false,
    // Ledger-rule state (persisted in meta): cash/ABM deposits confirmed as own
    // income, confirmed round-trip transaction ids, the shared-account tails and
    // the household payees whose outflows are "support to household".
    confirmedIncomeIds: [], roundTripIds: [], sharedAccounts: [], householdPayees: [],
  };

  const FALLBACK = () => state.cfg.special.fallback;

  /* ---- formatting ---- */
  const money0 = (n) => {
    const { symbol = '$', locale = 'en-JM', decimals = 2 } = state.cfg.currency || {};
    return formatMoney(n, symbol, locale, decimals);
  };
  const moneyShort = (n) => {
    const { symbol = '$' } = state.cfg.currency || {};
    const a = Math.abs(n);
    if (a >= 1e6) return symbol + (n / 1e6).toFixed(a >= 1e7 ? 0 : 1) + 'M';
    if (a >= 1e3) return symbol + Math.round(n / 1e3) + 'k';
    return symbol + Math.round(n);
  };
  const pct = (x) => `${Math.round(x * 100)}%`;
  const monthShort = (ym) => { const m = /^(\d{4})-(\d{2})$/.exec(ym); if (!m) return ym; return `${['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][+m[2]-1]} ${m[1].slice(2)}`; };
  const monthLabel = (ym) => monthName(ym);

  const toast = (msg, undoFn) => {
    const t = $('#toast'); t.innerHTML = '';
    t.append(el('span', {}, msg));
    if (undoFn) t.append(el('button', { class: 'undo', onclick: () => { t.classList.remove('show'); undoFn(); } }, 'Undo'));
    t.classList.add('show');
    clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), undoFn ? 10000 : 8000);
  };

  /* ---- theme colours from config ---- */
  function applyThemeColours() {
    const c = state.cfg.colours || {};
    const r = document.documentElement.style;
    for (const [k, v] of Object.entries(c)) r.setProperty('--' + k.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase()), v);
  }

  /* ---- stable category → colour map (consistent everywhere) ---- */
  const PALETTE = ['#2f6fb0','#3f9d6b','#c98a1b','#a05fb4','#4aa3a3','#c65b7c',
    '#6b8e3d','#b5642e','#5a78c2','#8a8f2f','#3e8fb0','#9a5aa8','#c0603f','#557f9e'];
  let _colKey = null;
  function buildCategoryColours() {
    const themeKey = document.documentElement.dataset.theme || 'auto';
    if (_colKey && _colKey.cfg === state.cfg && _colKey.theme === themeKey) return;
    const map = {};
    (state.cfg.categories || []).forEach((c, i) => { map[c.name] = PALETTE[i % PALETTE.length]; });
    map[FALLBACK()] = getComputedStyle(document.documentElement).getPropertyValue('--muted').trim() || '#8a8f99';
    state.catColour = map;
    _colKey = { cfg: state.cfg, theme: themeKey };
  }  const catColour = (name) => state.catColour[name] || '#8a8f99';
  const isReview = (name) => name === FALLBACK();

  /* ---- recompute rows + all-time summary from records ---- */
  let _rcKey = null;
  function recompute() {
    if (_rcKey
      && _rcKey.records === state.records && _rcKey.rules === state.rules
      && _rcKey.compiled === state.compiled && _rcKey.merchants === state.merchants
      && _rcKey.brandRules === state.brandRules && _rcKey.resolver === state.resolver
      && _rcKey.keepUpper === state.keepUpper && _rcKey.smallWords === state.smallWords
      && _rcKey.cfg === state.cfg) {
      return;
    }
    state.rows = buildRows(state.records, state.compiled, {
      keepUpper: state.keepUpper, smallWords: state.smallWords,
      fallback: state.cfg.special.fallback, paymentCategory: state.cfg.special.paymentCategory,
      refundCategory: state.cfg.special.refundCategory, feeCategories: new Set(state.cfg.special.feeCategories),
      merchantOverrides: rulesToMerchantOverrides(state.rules),
      merchants: state.merchants, brandRules: state.brandRules,
      resolver: state.resolver,   // card-identity door for categorise (grouping still uses merchants)
    });
    state.allSummary = summarise(state.rows, { keepUpper: state.keepUpper, smallWords: state.smallWords, brandRules: state.brandRules, merchants: state.merchants, fallback: state.cfg.special.fallback });
    _rcKey = {
      records: state.records, rules: state.rules, compiled: state.compiled, merchants: state.merchants,
      brandRules: state.brandRules, resolver: state.resolver, keepUpper: state.keepUpper,
      smallWords: state.smallWords, cfg: state.cfg,
    };
  }

  const allMonths = () => state.allSummary ? state.allSummary.months : [];
  // The month domain the ONE shared period selector spans: every month present
  // in EITHER ledger (card statements and bank statements), sorted. A single
  // domain means the single selected period resolves to the identical window
  // for Cards, Accounts and Overview, so the three can never disagree on the
  // timeframe. Bank rows are dated YYYY-MM-DD; their month is the first 7 chars.
  const bankMonthsList = () => [...new Set((state.bankRecords || []).map((r) => String(r.date || '').slice(0, 7)).filter(Boolean))];
  const allLedgerMonths = () => [...new Set([...allMonths(), ...bankMonthsList()])].sort();
  const merchantLabelFn = (s) => merchantLabel(s, state.keepUpper, state.smallWords);

  let _rsKey = null, _rsVal = null;
  function resolved() {
    const nowYM = ymToday();
    if (_rsKey && _rsKey.p === state.period && _rsKey.rw === state.rows
      && _rsKey.br === state.bankRecords && _rsKey.cov === state.coverage
      && _rsKey.ym === nowYM) {
      return _rsVal;
    }
    _rsVal = resolvePeriod(state.period, state.rows, allLedgerMonths(), new Date(), state.coverage);
    _rsKey = { p: state.period, rw: state.rows, br: state.bankRecords, cov: state.coverage, ym: nowYM };
    // INVARIANT: this object is shared by reference across the ~10 callers in
    // a render. Treat it as READ-ONLY; never mutate a returned period.
    return _rsVal;
  }
  function bankRecordsInPeriod(recs) {
    const p = resolved();
    if (!p || state.period.type === 'all') return recs;
    return recs.filter((r) => { const m = String(r.date || '').slice(0, 7); return m >= p.from && m <= p.to; });
  }
  function bankRecordsInRange(recs, from, to) {
    if (!from || !to) return [];
    return recs.filter((r) => { const m = String(r.date || '').slice(0, 7); return m >= from && m <= to; });
  }
  let _anKey = null, _anVal = null;
  function analysis() {
    const p = resolved();
    if (!p) return null;
    if (_anKey && _anKey.rows === state.rows && _anKey.p === p
      && _anKey.ku === state.keepUpper && _anKey.sw === state.smallWords
      && _anKey.br === state.brandRules && _anKey.me === state.merchants) {
      return _anVal;
    }
    _anVal = analysePeriod(state.rows, p, { keepUpperSet: state.keepUpper, smallWordsSet: state.smallWords, merchantLabelFn, brandRules: state.brandRules, merchants: state.merchants });
    _anKey = { rows: state.rows, p, ku: state.keepUpper, sw: state.smallWords, br: state.brandRules, me: state.merchants };
    return _anVal;
  }

  /* rows inside the current period (before drill-down filters) */
  function periodRows() {
    const p = resolved(); if (!p) return [];
    return state.rows.filter((r) => r.month >= p.from && r.month <= p.to);
  }

  /* rows after the shared filter/drill-down state (used by explorer + recent + CSV) */
  // Memoised across a render pass: Recent (slice + "View all" count), the
  // explorer and CSV all ask for the same set, so compute it once and reuse it.
  // The cache key is a cheap signature of every input that affects the result
  // (filter, sort, resolved period and a rows-version bumped on recompute), so
  // it auto-invalidates the instant any of them change - same rows, same order,
  // same counts as before, just not recomputed on every call.
  let _vrKey = null, _vrVal = null, _vrRows = null;
  function visibleRowsSignature() {
    const f = state.filter; const p = state.period;
    return [
      f.search, f.category, f.kind, f.merchant, f.month, f.min, f.max, f.foreignOnly, f.reviewOnly,
      state.sort.key, state.sort.dir,
      p.type, p.from || '', p.to || '',
    ].join('|');
  }
  function visibleRows() {
    const key = visibleRowsSignature();
    if (key === _vrKey && _vrRows === state.rows) return _vrVal;
    const rows = computeVisibleRows();
    _vrKey = key; _vrVal = rows; _vrRows = state.rows;
    return rows;
  }
  function computeVisibleRows() {
    const f = state.filter;
    let rows = periodRows();
    if (f.month !== 'all') rows = rows.filter((r) => r.month === f.month);
    if (f.category !== 'all') rows = rows.filter((r) => r.category === f.category);
    if (f.kind !== 'all') rows = rows.filter((r) => r.kind === f.kind);
    if (f.merchant) rows = rows.filter((r) => merchantGroupKey(r.description, state.brandRules, state.merchants) === f.merchant);
    if (f.foreignOnly) rows = rows.filter((r) => r.foreign);
    if (f.reviewOnly) rows = rows.filter((r) => r.category === FALLBACK() || r.needsReview);
    if (f.min != null) rows = rows.filter((r) => Math.abs(r.amount) >= f.min);
    if (f.max != null) rows = rows.filter((r) => Math.abs(r.amount) <= f.max);
    if (f.search) {
      const q = f.search.toLowerCase();
      rows = rows.filter((r) => r.description.toLowerCase().includes(q) ||
        r.raw_description.toLowerCase().includes(q) || r.category.toLowerCase().includes(q) ||
        monthLabel(r.month).toLowerCase().includes(q) || r.source_file.toLowerCase().includes(q) ||
        String(r.amount).includes(q) || r.date.includes(q));
    }
    const { key, dir } = state.sort; const s = dir === 'asc' ? 1 : -1;
    rows = rows.slice().sort((a, b) => {
      let av = a[key], bv = b[key];
      if (key === 'amount') { av = a.amount; bv = b.amount; }
      return av < bv ? -s : av > bv ? s : 0;
    });
    return rows;
  }

    /* apply a drill-down (from a chart bar, category, merchant or insight) ----
   * opts.expand is the signal every real drill already passes, so it doubles
   * as "this is a fresh slice": resetCardDrillFacets() runs BEFORE the patch,
   * so a drill can only ever end up with the facet(s) it names plus every
   * OTHER drill facet's default - never an accidental intersection with a
   * facet an earlier, unrelated drill left behind. Additive controls (Month,
   * Min/Max) are untouched by this reset on purpose - see CARD_FACETS above. */
  function applyFilter(patch = {}, opts = {}) {
    if (opts.expand) resetCardDrillFacets();
    Object.assign(state.filter, patch);
    if (opts.expand) state.showAllTx = true;
    render();
    if (opts.scroll) smoothScrollToEl('#explorer');
  }

  /* ===================================================================
   * RENDER
   * =================================================================== */
  function availableViews() {
    const v = [];
    if (state.records.length && state.bankRecords.length) v.push('overview');
    if (state.records.length) v.push('cards');
    if (state.bankRecords.length) v.push('accounts');
    return v;
  }

  let _covKey = null;
  let _viewCache = {}, _epochSnap = null;
  const _viewScroll = {};

  function render() {
    const app = $('#app'); app.innerHTML = '';
    const hasCard = state.records.length > 0;
    const hasBank = state.bankRecords.length > 0;
    const views = availableViews();
    if (views.length && !views.includes(state.view)) state.view = views[0];
    if (state.records.length) { recompute(); buildCategoryColours(); }
    if (!_covKey || _covKey.cs !== state._cardStatements || _covKey.bs !== state._bankStatements
      || _covKey.rows !== state.rows || _covKey.bank !== state.bankRecords) {
      const cardMonthsSet = new Set(state.rows.map((r) => r.month).filter((m) => m && m !== 'unknown'));
      const bankMonthsSet = new Set((state.bankRecords || []).map((r) => String(r.date || '').slice(0, 7)).filter(Boolean));
      state.coverage = buildStatementCoverage(state._cardStatements, state._bankStatements, cardMonthsSet, bankMonthsSet);
      _covKey = { cs: state._cardStatements, bs: state._bankStatements, rows: state.rows, bank: state.bankRecords };
    }

    renderPeriodBar();
    renderLedgerSwitch(views);
    if (!hasCard && !hasBank) { _viewCache = {}; app.append(renderEmpty()); updateFooter(); return; }
    const epoch = [
      state.rows, classifiedBank(), state.coverage, resolved(),
      state._cardStatements, state._bankStatements, state.catColour,
      state.warnings, state.cardAccounts,
    ];
    if (!_epochSnap || _epochSnap.length !== epoch.length || epoch.some((v, i) => v !== _epochSnap[i])) {
      _viewCache = {};
      _epochSnap = epoch;
    }
    if (state.view === 'overview') {
      mountView(app, 'overview', '', () => { const w = renderOverview(); w.append(renderManageData()); return [w]; });
      updateFooter(); return;
    }
    if (state.view === 'accounts') {
      const sig = [state.bankAccount, state.bankFilter.payeeKey, state.bankFilter.payeeLabel, state.bankFilter.search, state.bankFilter.hideInternal, state.bankShowAllTx].join('|');
      mountView(app, 'accounts', sig, () => { const w = renderAccounts(); w.append(renderManageData()); return [w]; });
      updateFooter(); return;
    }
    const a = analysis();
    if (a && a.n_transactions === 0) { _viewCache = {}; app.append(periodEmptyNotice('card transactions', allMonths()), renderManageData()); updateFooter(); return; }
    const cardSig = visibleRowsSignature() + '|' + String(state.showAllTx);
    mountView(app, 'cards', cardSig, () => [
      renderHero(a),
      renderInsightsAndAttention(a),
      renderCardFitness(),
      renderTrend(a),
      renderCategoryPanel(a),
      renderForeign(a),
      renderMerchants(a),
      renderRecurring(),
      renderRecent(a),
      renderExplorer(a),
      renderSecondary(a),
    ].filter(Boolean));
    updateFooter();
  }


  function mountView(app, name, sig, build) {
    const cache = _viewCache[name];
    if (cache && cache.sig === sig) { for (const n of cache.nodes) app.append(n); return; }
    const nodes = build();
    _viewCache[name] = { sig, nodes };
    for (const n of nodes) app.append(n);
  }

  /* ---- the one place a ledger view change happens ---- */
  function switchLedgerView(id) {
    if (state.view === id) return;
    _viewScroll[state.view] = window.scrollY;
    clearBankFilters();
    state.bankShowAllTx = false;
    state.view = id;
    render();
    window.scrollTo({ top: _viewScroll[id] || 0, left: 0, behavior: 'auto' });
  }


  function drillToAccountsPayee(key, label) {
    resetBankDrillFacets();
    state.bankFilter.payeeKey = key;
    state.bankFilter.payeeLabel = label;
    state.bankShowAllTx = true;
    if (state.view !== 'accounts') state.view = 'accounts';
    render();
    smoothScrollToEl('#acct-tx');
  }

  function drillToAccount(account) {
    const turningOff = state.bankAccount === account;
    resetBankDrillFacets();
    state.bankAccount = turningOff ? 'all' : account;
    state.bankShowAllTx = true;
    render();
    smoothScrollToEl('#acct-tx');
  }
  /* ---- ledger switch (Cards / Accounts) ---- */
  function renderLedgerSwitch(views) {
    let host = $('#ledger-switch');
    if (!host) {
      host = el('div', { id: 'ledger-switch', class: 'ledger-switch', hidden: '' });
      const stack = $('.topbar-stack');
      const bar = $('#period-bar');
      if (stack) stack.append(host);
      else if (bar) bar.append(host);
      else {
        const appEl = $('#app');
        if (appEl && appEl.parentNode) appEl.parentNode.insertBefore(host, appEl);
        else document.body.insertBefore(host, document.body.firstChild);
      }
    }
    host.innerHTML = '';
    const appEl = $('#app');
    // The tab bar only earns its place when there is more than one destination.
    // With a single ledger there is nothing to switch between, so the bar is
    // hidden and the panel is not a tabpanel; strip the roles so an orphaned
    // tabpanel is never announced without its tabs.
    if (!views || views.length < 2) {
      host.hidden = true;
      document.body.classList.remove('has-bottom-nav');
      if (appEl) { appEl.removeAttribute('role'); appEl.removeAttribute('aria-labelledby'); }
      return;
    }
    host.hidden = false;
    document.body.classList.add('has-bottom-nav');

    // Build the tablist from ONLY the views present, in the fixed display order
    // and with the fixed labels. state.view is always one of these (render()
    // guarantees it before calling here).
    const LABELS = { overview: 'Overview', cards: 'Cards', accounts: 'Accounts' };
    const TABS = views.map((id) => [id, LABELS[id]]);
    const ids = TABS.map(([id]) => id);
    const tabDomId = (id) => 'ledger-tab-' + id;
    const switchTo = (id) => switchLedgerView(id);
    const focusTab = (id) => { const b = $('#' + tabDomId(id)); if (b) b.focus(); };
    const activateIndex = (idx) => {
      const id = ids[(idx + ids.length) % ids.length];
      switchTo(id);
      focusTab(id);
    };

    const tab = (id, label, index) => el('button', {
      id: tabDomId(id),
      role: 'tab',
      class: 'ledger-tab' + (state.view === id ? ' active' : ''),
      'aria-selected': state.view === id ? 'true' : 'false',
      'aria-controls': 'app',
      // Roving tabindex: active tab is tabbable, the rest are arrow-reachable.
      tabindex: state.view === id ? '0' : '-1',
      onclick: () => switchTo(id),
      onkeydown: (e) => {
        switch (e.key) {
          case 'ArrowRight': case 'ArrowDown': e.preventDefault(); activateIndex(index + 1); break;
          case 'ArrowLeft':  case 'ArrowUp':   e.preventDefault(); activateIndex(index - 1); break;
          case 'Home': e.preventDefault(); activateIndex(0); break;
          case 'End':  e.preventDefault(); activateIndex(ids.length - 1); break;
          default: break;
        }
      },
    }, label);

    // Link the panel (#app) back to its active tab so a screen reader announces
    // "tab, N of 3, selected" and names the panel by the tab controlling it.
    if (appEl) {
      appEl.setAttribute('role', 'tabpanel');
      appEl.setAttribute('aria-labelledby', tabDomId(state.view));
    }

    host.append(el('div', { class: 'ledger-tabs', role: 'tablist', 'aria-label': 'Ledger views' },
      ...TABS.map(([id, label], i) => tab(id, label, i))));
  }

  /* ---- Overview (Phase 2 hub, Phase 3 combined roll-up) ---- */

  function buildOverviewInsights(recs, roll, verdict) {
    const p = resolved();
    const recsAll = classifiedBank();
    let prevIncome = null;
    if (p && p.prevFrom && p.prevTo) {
      const prevRecs = bankRecordsInRange(recsAll, p.prevFrom, p.prevTo);
      prevIncome = analyseRollup({ bankRecords: prevRecs, cardSpendTotal: 0, cardSpendByMonth: {}, cardStatements: [] }).income;
    }
    return buildBankAppropriateInsights({
      recsAll, period: p, cfg: state.cfg,
      currentIncome: roll.income, prevIncome, verdict: null, coverage: state.coverage,
      bankMoney, prevLabel, monthLabel, bankMonthsList,
      onNavigate: () => switchLedgerView('accounts'),
      icons: { up: iconUp, down: iconDown, alert: iconAlert, spark: iconSpark, gap: iconGap, info: iconInfo },
    });
  }
  // Renders the "What's new or unusual" card, the Overview twin of Cards'
  // "What changed" insights card, placed directly below the hero - the same
  // position Cards' own insights card sits relative to its hero (render()'s
  // real DOM order there is renderHero, renderInsightsAndAttention). Reuses
  // the existing .insight-list / .insight / .insight-icon / .insight-text /
  // .insight-go CSS classes verbatim - no new UI is introduced.
  function renderOverviewInsightsCard(recs, roll, verdict) {
    const p = resolved();
    return renderInsightList(el, icon, {
      title: 'What\u2019s new or unusual',
      iconBulb, iconChevron,
      insights: buildOverviewInsights(recs, roll, verdict),
      emptyText: `A calm ${p ? p.label.toLowerCase() : 'period'}. Nothing stands out against your usual pattern.`,
    });
  }
  function renderOverview() {
    const wrap = el('div', { class: 'accounts-wrap' });
    // Both ledgers, scoped to the ONE shared reporting window. Bank rows are
    // narrowed to the period; card spend is taken from the same period analysis
    // the Cards tab uses (analysis()), so the roll-up headline and the trend
    // reconcile to the identical timeframe across all three views. The bank leg
    // that pays the card is an internal transfer and is already excluded.
    const recs = bankRecordsInPeriod(classifiedBank());
    let cardSummary = null, cardSpendTotal = 0, cardSpendByMonth = {};
    if (state.records.length) {
      const ca = analysis();               // card figures for the SAME window
      if (ca) {
        cardSummary = { total_spend: ca.total_spend, n_transactions: ca.n_transactions };
        cardSpendTotal = ca.total_spend;
        cardSpendByMonth = Object.assign({}, ca.by_month);
      }
    }
    // Shared-window empty state: neither ledger has activity in the selected
    // period. A plain notice instead of a roll-up of zeroes.
    if (!recs.length && (!cardSummary || cardSummary.n_transactions === 0)) {
      wrap.append(periodEmptyNotice('money movements', allLedgerMonths()));
      return wrap;
    }
    const ov = analyseCombinedOverview({ bankRecords: recs, cardStatements: state._cardStatements || [], cardSummary });
    const roll = analyseRollup({ bankRecords: recs, cardSpendTotal, cardSpendByMonth, cardStatements: state._cardStatements || [] });

    // Whole-history net-cash-flow trend, moved up from where the trend chart
    // built it further down (same pure call, now computed once and reused by
    // both the chart AND the hero's "typical month" baseline below, rather
    // than computed twice). cardSpendTotal is 0 here because only the trend's
    // per-month shape is needed, not a headline total; whole-history card
    // spend by month comes from allSummary, exactly as the chart already did.
    const rollAllTrend = analyseRollup({
      bankRecords: classifiedBank(),
      cardSpendTotal: 0,
      cardSpendByMonth: (state.allSummary ? state.allSummary.by_month : {}),
      cardStatements: [],
    }).trend;

    // Round 2 (B1): the calm one-line verdict leads the Overview and is the single
    // most prominent thing on the screen. It says only direction (more came in than
    // went out, or the reverse) and, when there is enough history, whether that
    // continues or breaks the recent pattern - no figures, no named cause, no next
    // action (all deferred). It renders FIRST, above the roll-up hero, so it is what
    // the eye lands on, reusing the hero-amount class (the heaviest text on this
    // screen, used for the net-cash-flow figure) rather than a new font size. Tone is
    // carried only by a quiet dot paired with the text, never colour alone and never a
    // red/green line. The closing line is a fixed reassurance until the review-step
    // detector exists in a later round.
    const verdict = overviewVerdict(roll);
    // Sentence case so the verdict matches the Title-Case chrome elsewhere; the
    // tone dot and hero-amount prominence are unchanged, only the casing.
    // capitaliseFirst is the shared helper imported from shared-helpers.js -
    // previously re-derived locally here as its own identical copy.
    // Parts D + E: ONE unified Overview hero. The standalone verdict card and the
    // separate "Your money at a glance" money card are merged into a single
    // .card.hero, so this tab carries exactly ONE lead number (net cash flow).
    // Part D gives the card the standard hero chrome every other hero has (an
    // eyebrow + title). Part E steps the verdict DOWN from the old .hero-amount
    // treatment to a .hero-verdict sub-headline sitting below the title, so it
    // interprets the net figure rather than competing with it. Every figure and
    // string below is byte-identical to the two former cards; only the container
    // and the wrapper class that carries the verdict text have changed.
    // Overview hero via the one shared buildHeroSection (reporting.js). This is
    // where the actual hierarchy fix lands: the "what needs tidying" chore block
    // used to render ABOVE net cash flow. It is now built as the `attention`
    // node, which the shared builder ALWAYS places below the lead figure and
    // facts - so the headline number is read first and the chores follow. The
    // chore logic itself (unreconciled statements = blocking; uncategorised /
    // machine deposits = optional) is unchanged; only its position moved.
    const cardUncat = periodRows().filter((r) => r.kind === 'spend' && r.category === FALLBACK() && !r.reviewDismissed).length;
    const bankDeposits = recs.filter((r) => r.cashDeposit && r.excludedFromIncome).length;
    const cardUnrec = (state._cardStatements || []).filter((s) => !s.reconciled).length;
    const bankUnrec = (state._bankStatements || []).filter((s) => !s.reconciled).length;
    const cardWork = cardUncat + cardUnrec;
    const acctWork = bankDeposits + bankUnrec;
    const attention = (() => {
      const wrapA = el('div', { class: 'hero-attention' });
      if (cardWork + acctWork === 0) {
        wrapA.append(el('p', { class: 'muted small' }, 'Nothing needs doing this month.'));
        return wrapA;
      }
      const unrecTotal = cardUnrec + bankUnrec;
      const link = (label, id) => el('button', { class: 'linkbtn', onclick: () => switchLedgerView(id) }, label);
      if (unrecTotal) {
        const pEl = el('p', { class: 'muted small' },
          `${unrecTotal} statement${unrecTotal === 1 ? '' : 's'} did not fully add up, so some totals may be incomplete. `);
        if (bankUnrec && cardUnrec) { pEl.append(link('Check cards', 'cards'), ' ', link('Check accounts', 'accounts')); }
        else pEl.append(link('Check', bankUnrec ? 'accounts' : 'cards'));
        wrapA.append(pEl);
      }
      const optParts = [];
      if (cardUncat) optParts.push(`${cardUncat} purchase${cardUncat === 1 ? '' : 's'} filed under “To review”`);
      if (bankDeposits) optParts.push(`${bankDeposits} machine deposit${bankDeposits === 1 ? '' : 's'} to confirm as income`);
      if (optParts.length) {
        const optSummary = optParts.length <= 1 ? optParts[0]
          : optParts.slice(0, -1).join(', ') + ' and ' + optParts[optParts.length - 1];
        const pEl = el('p', { class: 'muted small' },
          `Optional: ${optSummary}. Nothing is wrong, and the totals are already right. `);
        if (bankDeposits && cardUncat) { pEl.append(link('Refine cards', 'cards'), ' ', link('Refine accounts', 'accounts')); }
        else pEl.append(link('Refine', bankDeposits ? 'accounts' : 'cards'));
        wrapA.append(pEl);
      }
      return wrapA;
    })();

    const vp = resolved();
    const comparison = (verdict.comparison && vp && vp.from === vp.to) ? capitaliseFirst(verdict.comparison) : null;
    const spendNote = roll.hasCard
      ? `Money out is ${bankMoney(roll.bankExternalOut)} from your bank accounts plus ${bankMoney(roll.cardSpend)} on your card, with own-account transfers and card payments removed so nothing is counted twice, while money in is what arrived in your accounts. Money in and out are movements in the selected period; cash on hand and what you owe on the card are current balances, shown separately and never subtracted.`
      : `Money in is what arrived in your accounts and money out is what left, with transfers between your own accounts removed so nothing is counted twice. Money in and out are movements in the selected period; cash on hand is your current balance, shown separately.`;

    wrap.append(buildHeroSection(el, icon, iconInfo, {
      eyebrow: 'Overview',
      title: 'Your money at a glance',
      verdict: { tone: verdict.tone, text: capitaliseFirst(verdict.text), comparison },
      lead: {
        amount: (roll.netCashFlow >= 0 ? '+' : '') + bankMoney(roll.netCashFlow),
        label: 'Net cash flow',
      },
      facts: [
        { value: bankMoney(roll.income), label: 'Money in' },
        { value: bankMoney(roll.externalSpending), label: 'Money out' },
        { value: roll.cashPosition == null ? '-' : bankMoney(roll.cashPosition), label: 'Cash on hand' },
        roll.cardOwed == null ? null : { value: bankMoney(roll.cardOwed), label: 'Owed on card', tone: roll.cardOwed > 1 ? 'muted' : '' },
      ],
      attention,
      note: el('p', { class: 'hero-note' }, icon(iconInfo()), el('span', {}, spendNote)),
    }));

    // "What's new or unusual" (Part 2 of the hero-pill revert): bank-
    // appropriate insights, placed directly below the hero - the same
    // position Cards' own insights card sits relative to its hero.
    wrap.append(renderOverviewInsightsCard(recs, roll, verdict));

    // B4 (D18): one quiet supporting line for the combined monthly commitments -
    // the regular payments that leave every month across both ledgers, de-duped so
    // a payment seen on both sides counts once. Cards owns the itemised list; the
    // Overview shows only the number, as a muted supporting fact that never competes
    // with the verdict above. Whole-history (matching the Cards card, not the period).
    // classifiedBank() is passed so the bank standing debits exclude internal
    // transfers, the same commitment set the Cards card derives; the extra
    // ledger-rule flags applyLedgerRules adds are ignored by detectBankStandingDebits.
    // Part F: the two supporting lines below were bare paragraphs appended
    // straight to wrap, floating in the gap between cards with no container. They
    // now sit inside ONE titled card, so they read like every other card rather
    // than loose text. Their exact text, guards and figures are unchanged; only
    // the container changed from wrap.append(p) to a paragraph inside a titled
    // .card. The card is guarded on at least one line qualifying, so an empty card
    // is never rendered; if only one line qualifies the card shows just that line.
    const commitments = monthlyCommitmentsTotal(detectRecurring(state.rows, 3, 0.15, state.brandRules, state.merchants), detectBankStandingDebits(classifiedBank()));
    const showCommitments = commitments.total > 0;
    // Round 2 (B1): one derived liability line beneath the balances. Cash on hand and
    // card owed are shown side by side and never netted (D12); this states only the
    // arithmetic of clearing the card today - what would remain, with the rest still
    // owed. Uses roll.cardOwed (never ov.cardBalance). Plain text, no colour, never
    // framed as spendable or available, and shown only when both figures exist.
    const showLeftIfCleared = roll.cashPosition != null && roll.cardOwed != null;
    if (showCommitments || showLeftIfCleared) {
      const balancesCard = el('section', { class: 'card' });
      balancesCard.append(el('div', { class: 'card-head' }, el('h3', { class: 'card-title' }, icon(iconRepeat()), 'Balances and commitments')));
      if (showCommitments) {
        balancesCard.append(el('p', { class: 'muted small' },
          `Regular monthly commitments across your card and accounts: about ${bankMoney(commitments.total)} a month before day-to-day spending. The full list is on the Cards tab.`));
      }
      if (showLeftIfCleared) {
        const leftover = roll.cashPosition - roll.cardOwed;
        balancesCard.append(el('p', { class: 'muted small' },
          `If you cleared the card today, this is what would be left: ${bankMoney(leftover)}. The rest, ${bankMoney(roll.cardOwed)} is still owed.`));
      } 
      wrap.append(balancesCard);
    }

    // Two routing cards, one per sub-view (D8: summarise and route only).
    const row = el('div', { class: 'row2' });
    const cardsCard = el('section', { class: 'card' });
    cardsCard.append(el('div', { class: 'card-head' }, el('h3', { class: 'card-title' }, icon(iconInfo()), 'Cards')));
    // Demoted to a route (Item 8): the owed figure already leads the hero above
    // (Owed on card), so this card no longer restates it. A plain descriptor, plus
    // the genuinely different card-history spend line, then the route button.
    cardsCard.append(el('p', { class: 'muted small' }, ov.cardBalance == null
      ? 'Your card spending and statements.'
      : 'Your card spending, statements and what you owe.'));
    if (cardSummary) cardsCard.append(el('p', { class: 'muted small' }, `${money0(cardSummary.total_spend)} spent across your card history.`));
    cardsCard.append(el('button', { class: 'btn sm', onclick: () => switchLedgerView('cards') }, 'Open Cards'));

    const acctCard = el('section', { class: 'card' });
    acctCard.append(el('div', { class: 'card-head' }, el('h3', { class: 'card-title' }, icon(iconInfo()), 'Accounts')));
    // Demoted to a route (Item 8): Cash on hand already leads the hero above, so
    // this card drops the restated balance and keeps the account-count context.
    acctCard.append(el('p', { class: 'muted small' }, `Across ${ov.accounts.length} account${ov.accounts.length === 1 ? '' : 's'}. Money in, money out and balances.`));
    acctCard.append(el('button', { class: 'btn sm', onclick: () => switchLedgerView('accounts') }, 'Open Accounts'));
    row.append(cardsCard, acctCard);
    wrap.append(row);

    // Combined spending trend: each month's genuine outflow, bank external plus
    // card purchases, side by side with income. Card payments never appear here
    // (they are internal), so a card purchase is shown once via the card slice.
    // The chart is whole-history (like the Cards trend) so a single-month period
    // does not read as one lonely bar; the month(s) inside the selected period
    // are highlighted. cardSpendTotal only feeds headline figures, not the trend,
    // so 0 is fine here; whole-history card spend by month comes from allSummary.
    // rollAllTrend itself is now computed once, up near `roll`/`ov` above (it
    // also feeds the hero's typical-month baseline), and reused here unchanged.
    if (rollAllTrend.length) {
      const p = resolved();
      const tsec = el('section', { class: 'card' });
      tsec.append(el('div', { class: 'card-head' }, el('h3', { class: 'card-title' }, icon(iconChart()), roll.hasCard ? 'Income and spending over time' : 'Cash flow over time')));
      const shownTrend = rollAllTrend.slice(-12);
      const max = Math.max(1, ...shownTrend.map((t) => Math.max(t.income, t.spending)));
      // Items 9 + 10: bring the Overview trend to visual parity with the Cards
      // .trend treatment. The bars are drawn in the same H-based pixel space as
      // the Cards chart, hosted inside a .trend container, and a dashed average
      // reference line (.trend-avg / .trend-avg-label) sits at the mean of the
      // shown months' SPENDING series. Presentation only: the mean is computed
      // from the spending values already being iterated and no bar value changes.
      // Month labels use the same short month-name formatting the Cards trend
      // uses (monthShort with the trailing year stripped), so both read "Jul,
      // Aug" rather than "25-08".
      const H = 150;
      const spendVals = shownTrend.map((t) => t.spending);
      const avg = spendVals.length ? spendVals.reduce((x, y) => x + y, 0) / spendVals.length : 0;
      const avgY = avg > 0 ? H - Math.min(H, (avg / max) * H) : null;
      const chart = el('div', { class: 'trend' });
      if (avgY != null) {
        chart.append(el('div', { class: 'trend-avg', style: `top:${avgY}px`, title: `Typical month ${bankMoney(avg)}` },
          el('span', { class: 'trend-avg-label' }, `avg ${moneyShort(avg)}`)));
      }
      const bars = el('div', { class: 'trend-bars' });
      for (const t of shownTrend) {
        const title = roll.hasCard
          ? `${t.month}: income ${bankMoney(t.income)} · spending ${bankMoney(t.spending)} (accounts ${bankMoney(t.bankOut)} + card ${bankMoney(t.cardOut)})`
          : `${t.month}: income ${bankMoney(t.income)} · spending ${bankMoney(t.spending)}`;
        const inPeriod = p && t.month >= p.from && t.month <= p.to;
        const col = el('div', { class: 'trend-col' + (inPeriod ? ' in-period' : ''), title },
          el('span', { class: 'trend-bar', style: `height:${Math.max(3, (t.spending / max) * H)}px` }),
          el('span', { class: 'trend-mlabel' }, monthShort(t.month).replace(/ \d+$/, '')));
        bars.append(col);
      }
      chart.append(bars);
      tsec.append(chart);
      tsec.append(renderExplainer(el, roll.hasCard
        ? 'Bars show money leaving your accounts plus card purchases. Your inter-account transfers and payments are excluded.'
        : 'Bars show money left each month (excluding your inter-account transfers).', { label: 'How this chart is worked out' }));
      wrap.append(tsec);
    }

    // The real external-payment shortlist - the handful that actually left.
    if (ov.topOutflows.length) {
      const sec = el('section', { class: 'card' });
      sec.append(el('div', { class: 'card-head' }, el('h3', { class: 'card-title' }, icon(iconList()), 'Where money actually went')));
      const list = el('div', { class: 'recurring-list' });
      for (const g of ov.topOutflows) {
        list.append(el('button', { class: 'recurring-row',
          'aria-label': `${g.label}: ${g.count} payment${g.count === 1 ? '' : 's'}, ${bankMoney(g.moneyOut)}`,
          onclick: () => drillToAccountsPayee(g.key, cleanCounterparty(g.label)) },
          el('span', { class: 'recurring-name' }, cleanCounterparty(g.label)),
          el('span', { class: 'recurring-months muted small' }, `${g.count} payment${g.count === 1 ? '' : 's'}`),
          el('span', { class: 'recurring-amt num strong' }, bankMoney(g.moneyOut))));
      }
      sec.append(list);
      sec.append(el('p', { class: 'muted small' }, 'The largest genuine outflows to people and services outside your own accounts.'));
      wrap.append(sec);
    }
    return wrap;
  }


  /* ---- empty state ---- */
function renderEmpty() {
    const wrap = el('section', { class: 'card empty' });
    const lines = el('div', { class: 'empty-lines' });
    lines.append(el('p', { class: 'muted' }, 'Add a Scotia PDF statement and your spending appears straight away.'));
    lines.append(el('p', { class: 'muted' }, 'Everything is read on this device. Nothing leaves it.'));
    if (isIOS() && !isStandalone() && !window.ccDesktop) {
      lines.append(el('p', { class: 'muted' }, 'On iPhone, add this to your Home Screen so your history is not cleared after a week.'));
    }
    wrap.append(
      el('div', { class: 'empty-icon', html: emojiCard() }),
      el('h2', {}, 'Nothing here yet'),
      lines,
      el('button', { class: 'btn primary lg', onclick: pickStatements }, 'Add statement'),
    );
    // Format support is a caveat on the button above it, not a headline
    // sentence, so it sits here as fine print alongside the drop-hint rather
    // than stacked mid-page between the pitch and the privacy line.
    wrap.append(el('p', { class: 'muted small empty-drop-hint' }, 'or drop PDFs anywhere on this window'));
    if (!isIOS() && !isStandalone()) {
      wrap.append(el('p', { class: 'muted small empty-drop-hint' }, 'Also supports NCB credit-card statements. Bank statements are Scotia-only for now.'));
    }
    if (window.ccDesktop) wrap.append(el('button', { class: 'linkbtn', onclick: chooseFolder }, 'Or watch a statements folder for new PDFs'));
    return wrap;
  }
  const emojiCard = () => '<svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="M2.5 9.5h19"/></svg>';

  /* ---- period-empty notice ----
   * A plain, direct message for when the shared reporting window holds no data
   * for the tab on screen. The single period spans both ledgers, so a window
   * can legitimately land on months one ledger has and the other does not (for
   * example, "Latest complete month" resolving to a recent bank month the card
   * has not reached yet). Without this the tab would look blank or broken. It
   * names the active period, says which months DO hold data for this tab, and
   * offers a one-tap jump to All time, so it explains why and offers a way
   * forward rather than a dead end. Presentation only. */
  function periodEmptyNotice(noun, monthsWithData) {
    const p = resolved();
    const label = p ? p.label : 'this period';
    const sec = el('section', { class: 'card empty' });
    const lines = el('div', { class: 'empty-lines' });
    lines.append(el('p', { class: 'muted' }, `The period is set to ${label}, which holds no ${noun}.`));
    const ms = (monthsWithData || []).filter(Boolean).slice().sort();
    if (ms.length) {
      const span = ms.length === 1 ? monthLabel(ms[0]) : `${monthLabel(ms[0])} to ${monthLabel(ms[ms.length - 1])}`;
      lines.append(el('p', { class: 'muted' }, `Your ${noun} run from ${span}. Widen the period or pick another range to see them.`));
    } else {
      lines.append(el('p', { class: 'muted' }, `There are no ${noun} on record yet.`));
    }
    sec.append(
      el('div', { class: 'empty-icon', html: emojiCard() }),
      el('h2', {}, `No ${noun} in ${label}`),
      lines);
    if (ms.length) {
      sec.append(el('button', { class: 'btn primary', onclick: () => { state.period = { type: 'all' }; clearFilters(); clearBankFilters(); state.showAllTx = false; state.bankShowAllTx = false; render(); } }, 'Show all time'));
    }
    return sec;
  }

  /* ---- period bar ---- */
  function renderPeriodBar() {
    const bar = $('#period-bar'); if (!bar) return; bar.innerHTML = '';
    const months = allLedgerMonths();
    if (!months.length) return;   // nothing imported in either ledger yet
    const opts = [
      ['latest-complete', 'Latest complete month'],
      ['current-month', 'Current month'],
      ['previous-month', 'Previous month'],
      ['last-3', 'Last 3 months'],
      ['last-6', 'Last 6 months'],
      ['this-year', 'This year'],
      ['all', 'All time'],
      ['custom', 'Custom range'],
    ];
    const sel = el('select', { class: 'period-select', name: 'reporting-period', 'aria-label': 'Reporting period',
      onchange: (e) => {
        const v = e.target.value;
        if (v === 'custom') { state.period = { type: 'custom', from: months[Math.max(0, months.length - 3)], to: months[months.length - 1] }; }
        else state.period = { type: v };
        // A period change re-scopes the whole reporting window, so it is a
        // reset boundary for BOTH ledgers, not just Cards. clearBankFilters()
        // (registry-derived - see BANK_FACETS) already resets bankAccount
        // along with every other bank facet, so it is no longer set
        // separately here - one call now covers the whole ledger, the same
        // way clearFilters() covers Cards. Previously only clearFilters() ran
        // here, so a payee/account filter or an expanded Accounts transaction
        // list left active before the change rode straight through into the
        // new period, silently combined with whatever the new window happens
        // to show.
        clearFilters(); clearBankFilters();
        state.showAllTx = false; state.bankShowAllTx = false;
        render();
      } });
    for (const [v, label] of opts) sel.append(el('option', { value: v, selected: state.period.type === v ? '' : null }, label));

    const left = el('div', { class: 'period-left' }, el('span', { class: 'period-icon', html: iconCal() }), sel);
    bar.append(left);

    if (state.period.type === 'custom') {
      const from = el('select', { class: 'mini', name: 'period-from', 'aria-label': 'Custom range start month', onchange: (e) => { state.period.from = e.target.value; if (state.period.from > state.period.to) state.period.to = state.period.from; render(); } });
      const to = el('select', { class: 'mini', name: 'period-to', 'aria-label': 'Custom range end month', onchange: (e) => { state.period.to = e.target.value; if (state.period.to < state.period.from) state.period.from = state.period.to; render(); } });
      for (const m of months) {
        from.append(el('option', { value: m, selected: state.period.from === m ? '' : null }, monthLabel(m)));
        to.append(el('option', { value: m, selected: state.period.to === m ? '' : null }, monthLabel(m)));
      }
      bar.append(el('div', { class: 'period-range' }, from, el('span', { class: 'muted' }, 'to'), to));
    }

    // Centre slot for the ledger switch (Overview/Cards/Accounts). renderLedgerSwitch
    // fills this immediately after, so on desktop the tabs sit on THIS same sticky
    // row - centred between the period selector (left) and the "Showing <period>"
    // label (right) - rather than in a separate band. Rebuilt every render (the
    // period bar is wiped above), so it is inherently wipe-safe. On mobile CSS
    // detaches this to the fixed bottom bar, so this row layout is desktop-only.
    bar.append(el('div', { id: 'ledger-switch', class: 'ledger-switch', hidden: '' }));

    // Make the active window unmistakable on EVERY tab: a plain-language label
    // of the resolved period sits beside the control, so the figures below can
    // never be read against the wrong timeframe.
    const p = resolved();
    if (p) bar.append(el('div', { class: 'period-showing muted small', style: 'margin-left:auto' }, `Showing ${p.label}`));
  }
  
  const iconCal = () => '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="4.5" width="18" height="16" rx="2" /><path d="M3 9h18M8 2.5v4M16 2.5v4"/></svg>';

  /* Manage data - its own always-visible card so removing a statement or
   * starting over is one obvious step from the dashboard, not buried in a
   * collapsed accordion. The guarded confirm dialogs, the "keep my category
   * rules" option and the export-first reminder are unchanged; only the
   * placement and labelling changed. */
  // The manage-data ACTIONS body, as ONE shared section used in two places:
  // the standalone "Data & settings" card on Overview/Accounts (renderManageData
  // below), and inside the Cards "Data & settings" details (cards-render's
  // renderSecondary, via ctx). Single source of truth for these actions, so the
  // reload/remove/clear/contribute controls can never drift between tabs. Built
  // fresh on each call (a DOM node cannot live in two places), but only one
  // caller runs per render.
  function manageDataBody() {
    return el('div', { class: 'sec-section sec-manage' },
      el('div', { class: 'sec-subhead' }, icon(iconInfo()), ' Manage data'),
      el('p', { class: 'muted small' }, 'Everything lives only on this device - transactions, category corrections, personal rules and dismissed flags. Export rules or Export history first if you want to keep them.'),
      el('div', { class: 'manage-actions' },
        el('button', { class: 'btn sm ghost', onclick: reloadConfig }, 'Reload configuration'),
        el('button', { class: 'btn sm ghost', onclick: openRemoveStatement }, 'Remove a statement'),
        el('button', { class: 'btn sm danger', onclick: confirmClearAll }, 'Clear all data and start over')),
      // Contribute-back: a deliberately minimal, description-and-count-only CSV
      // of merchants the app could not identify at all - never a known merchant
      // it is merely uncertain about. No amount, date or account leaves the device.
      el('p', { class: 'muted small', style: 'margin-top:14px' },
        'Help us recognise more merchants: send us the places we could not identify, so we can add them to a future update. Only the statement text and how often it appeared are included - nothing else.'),
      el('div', { class: 'manage-actions' },
        el('button', { class: 'btn sm ghost', onclick: exportUnknownMerchants }, 'Help us recognise more merchants')));
  }

  // The standalone "Data & settings" card for Overview/Accounts (and the
  // period-empty branches): a collapsed details holding just the manage-data
  // section. On the Cards full view this card is NOT used - cards-render's
  // renderSecondary hosts the same manageDataBody() alongside its stats, so the
  // two stacked cards that used to sit at the Cards tail become one. Now a
  // collapsed, opt-in card everywhere (the actions are all low-frequency), and
  // the title is honest: "Data & settings" genuinely holds management now.
  function renderManageData() {
    const details = el('details', { class: 'card secondary' });
    details.append(el('summary', {}, icon(iconInfo()), ' Data & settings'));
    // Account-statement reconciliation belongs with its own ledger, mirroring
    // how the card-statement reconciliation sits inside the Cards tab's Data &
    // settings (renderSecondary → renderCardStatementTrust). Shown ONLY on the
    // Accounts tab so each ledger's trust line lives with that ledger and never
    // clutters the Overview hub. renderBankStatementTrust returns null when no
    // bank statements are stored, so this is inert for a card-only device.
    if (state.view === 'accounts') {
      const bankTrust = renderBankStatementTrust();
      if (bankTrust) details.append(bankTrust);
    }
    details.append(manageDataBody());
    return details;
  }

  function secItem(label, value) { return el('div', { class: 'sec-item' }, el('div', { class: 'sec-value' }, value), el('div', { class: 'sec-label muted small' }, label)); }
  function statementCount() { const set = new Set(state.rows.map((r) => r.source_file)); return set.size; }
  function statusText() {
    if (state.lastImportedFrom && state.lastImportedFrom.at) {
      return `Last updated from ${state.lastImportedFrom.device || 'another device'} on ${new Date(state.lastImportedFrom.at).toLocaleDateString(state.cfg.currency.locale)}. This device keeps its own private history.`;
    }
    return 'This device keeps its own private history. Nothing leaves your device.';
  }

  function updateFooter() {
    const f = $('#footer'); if (!f) return;
    f.textContent = statusText();
  }

  /* ---- tooltip ---- */
  let tipEl = null;
  function showTip(e, title, val) {
    if (!tipEl) { tipEl = el('div', { class: 'tip' }); document.body.append(tipEl); }
    tipEl.innerHTML = `<b>${escapeHtml(title)}</b><span>${escapeHtml(val)}</span>`;
    tipEl.style.left = Math.min(e.clientX + 12, window.innerWidth - 180) + 'px';
    tipEl.style.top = (e.clientY - 10) + 'px';
    tipEl.classList.add('show');
  }
  function hideTip() { if (tipEl) tipEl.classList.remove('show'); }
  const escapeHtml = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /* ===================================================================
   * Category correction (reversible)
   * =================================================================== */
  let pickerEl = null;
  function closePicker() { if (pickerEl) { pickerEl.remove(); pickerEl = null; } }

  // Attach an overlay element as the active modal: put it on the page and record
  // it as the current picker so closePicker() can dismiss it. Extracted from the
  // inline picker pattern so code outside bootUI (accounts-render.js) can open a
  // modal without ever touching the private pickerEl variable directly.
  function openOverlay(overlay) { document.body.append(overlay); pickerEl = overlay; }
  // Read-only counterpart to openOverlay: hand the live overlay element to code
  // outside bootUI (category-picker.js) so it can inspect the current modal (for
  // example which scope radio is checked) without touching the private pickerEl.
  function getPickerEl() { return pickerEl; }

  // Shared modal-overlay constructor: wraps `box` in a .overlay that closes
  // the picker when the backdrop itself (not its contents) is clicked, then
  // opens it through the existing openOverlay/pickerEl mechanism. Previously
  // this exact three-line pattern was hand-written independently in
  // manage-data.js's openRemoveStatement, manage-data.js's confirmClearAll,
  // and accounts-render.js's openRoundTripPicker.
  //
  // CURRENT RECEIVERS - update this list, and check each factory's own ctx
  // destructure, whenever a new consumer is added. This is manually kept in
  // sync (no compiler/lint check enforces it), and a mismatch here fails
  // silently until the exact button is clicked at runtime - it has already
  // happened four times in one session (formatMoney, renderKindTag x2,
  // openCsvExportDialog, and this openModal/closePicker gap in
  // data-export.js), always because one of the three sync points (the
  // definition, the ctx object passed at the call site, and the factory's
  // own destructure of ctx) was updated without the other two:
  //   - createAccountsRenderer  (accounts-render.js: openRoundTripPicker)
  //   - createManageData        (manage-data.js: openRemoveStatement, confirmClearAll)
  //   - createDataExport        (data-export.js: openCsvExportDialog)
  //   - createCategoryPicker    (category-picker.js: openCategoryPicker)
  // NOT currently wired to openModal (uses its own overlay construction by
  // design, not by gap):
  //   - askPassphrase (data-export.js) - Promise-based; needs an onDismiss
  //     hook added to openModal before it can safely switch over.
  //   - openProgress (app.js) - deliberately non-dismissible (no backdrop-
  //     click handler at all), so it must NOT be switched to openModal.
  function openModal(box) {
    const overlay = el('div', { class: 'overlay', onclick: (e) => { if (e.target === overlay) closePicker(); } }, box);
    openOverlay(overlay);
  }

  /* ===================================================================
   * Intake (manual + desktop)
   * =================================================================== */
  async function pickStatements() {
    const input = $('#add-input');
    if (input) input.click();
  }

  async function onAddInputChange(e) {
    const input = e.currentTarget;
    const files = [...(input.files || [])];
    if (!files.length) return;
    await ingestFiles(files);
    input.value = '';
  }

  async function ingestFiles(files) {
    const list = [...files];
    openProgress(list);
    let added = 0, dupes = 0, failed = 0; let bankAdded = 0, bankDupes = 0; let cardLearned = false, cardStmtLearned = false; const periods = [];
    state.warnings = []; state.bankWarnings = [];
    try {
      const pdfjs = await loadPdfjs();
      for (let i = 0; i < list.length; i++) {
        const file = list[i];
        setProgress(i, 'reading');
        let lines;
        try { const buf = await file.arrayBuffer(); lines = await extractLines(buf.slice(0), pdfjs); }
        catch { setProgress(i, 'failed'); failed++; state.warnings.push(`${file.name} could not be read. Try re-downloading it from your bank.`); continue; }
        // A bank account statement now routes to the bank ledger (Phase 1). The
        // card path below is untouched: only card statements reach it.
        if (detectStatementFormat(lines) === 'bank') {
          const parsed = parseBankStatementLines(lines, file.name);
          if (!parsed.statements.length || parsed.openingBalance == null) { setProgress(i, 'failed'); failed++; state.bankWarnings.push(`${file.name} looks like a bank statement but its rows could not be read.`); continue; }
          const recon = reconcileBankStatement(parsed); // aggregate, for the file-level warning
          const recs = parsed.transactions.map((t) => ({ ...t, id: bankTransactionIdentity(t) }));
          const merged = mergeBankTransactions(state.bankRecords, recs);
          state.bankRecords = merged.records; bankAdded += merged.added;
          // Store ONE traceable record PER STATEMENT (not per file), each with
          // its own period, account, count, closing balance and reconcile
          // result, deduped by a per-statement content hash. A file holding many
          // statements now shows one honest row each, and the same statement
          // arriving in both a consolidated and an individual PDF is stored once.
          let newStmts = 0;
          for (const st of parsed.statements) {
            const stHash = bankStatementHash(st);
            if (await Store.hasBankStatement(stHash)) continue;
            const r = reconcileBankStatement({ openingBalance: st.openingBalance, closingBalance: st.closingBalance, transactions: st.transactions });
            await Store.putBankStatement({ hash: stHash, source_file: file.name, account: st.account, period: st.period,
              count: st.transactions.length, closingBalance: st.closingBalance,
              reconciled: r.ok, reconNote: r.balanceBreaks[0] || (r.closingOk ? '' : 'closing balance did not match'),
              importedAt: new Date().toISOString() });
            newStmts++;
          }
          if (!recon.ok) state.bankWarnings.push(`${file.name}: ${recon.balanceBreaks[0] || 'balance did not fully reconcile'}.`);
          if (newStmts === 0 && merged.added === 0) bankDupes++;
          setProgress(i, (newStmts === 0 && merged.added === 0) ? 'duplicate' : (recon.ok ? 'done' : 'reconwarn'), merged.added);
          continue;
        }
        if (detectCardStatementFormat(lines) === 'ncb') {
          for (const c of cardAccountsFromLines(lines)) {
            if (!state.cardAccounts.includes(c)) { state.cardAccounts = [...state.cardAccounts, c]; cardLearned = true; }
          }
          const hash = statementContentHash(lines);
          if (await Store.hasStatement(hash)) { setProgress(i, 'duplicate'); dupes++; continue; }
          const parsedNcb = parseNcbStatementLines(lines, file.name);
          if (!parsedNcb.transactions.length) { setProgress(i, 'failed'); failed++; state.warnings.push(`${file.name} did not contain transactions we could read.`); continue; }
          const ncbRecs = [];
          const ncbKeys = [];
          for (const seg of splitNcbStatements(lines)) {
            const built = buildNcbStatementRecord(seg, file.name);
            // A statement whose ROWS parse must store those rows even when the
            // summary box or header key cannot be read (real pdf.js splits the
            // masked account "xxxx1234" into "xxxx1234"). Collect transactions
            // unconditionally; the per-statement summary/reconciliation record
            // below stays best-effort and its absence never discards rows.
            if (built.summary.statementKey) ncbKeys.push(built.summary.statementKey);
            for (const t of built.transactions) {
              // Keep the NCB identity already stamped on t (it has no reference
              // number); only add the per-row app fields Scotiabank rows carry.
              ncbRecs.push({ ...t, categoryOverride: null, reviewDismissed: false, lastChanged: new Date().toISOString(), originDevice: state.deviceId });
            }
            if (built.summary.previousBalance != null && built.summary.newBalance != null) {
              await Store.putCardStatement({ ...built.statementRecord, importedAt: new Date().toISOString() });
              cardStmtLearned = true;
            }
            // Part A: runtime reconciliation gate (NCB). The statement prints its
            // own previous and new balance, which the bank computes independently
            // of the row list, so when both are present the signed billing sum of
            // the rows we read must equal the printed balance movement
            // (reconcileNcbStatement, already computed in built.reconciliation).
            // Rows are ALWAYS stored above (never gated); a shortfall only raises
            // a plain, visible per-file warning through the SAME state.warnings
            // channel the other import messages use. When the balances are
            // unreadable, recon.checked is false and no false warning is raised.
            const recon = built.reconciliation;
            if (recon && recon.checked && !recon.ok) {
              const expected = money0(recon.targetDelta);
              const got = money0(recon.computedDelta);
              const where = built.summary.statementKey ? ` (${built.summary.statementKey})` : '';
              state.warnings.push(`${file.name}${where}: this statement did not fully add up. We expected the balance to change by ${expected}, but the transactions we read total ${got}. Some transactions may not have been read.`);
            }
          }
          const merged = mergeTransactions(state.records, ncbRecs);
          state.records = merged.records; added += merged.added;
          const period = ncbKeys.length ? (ncbKeys.length === 1 ? ncbKeys[0] : `${ncbKeys[0]} (+${ncbKeys.length - 1} more)`) : '';
          await Store.putStatement({ hash, source_file: file.name, period, importedAt: new Date().toISOString() });
          if (period) periods.push(period);
          setProgress(i, 'done', merged.added);
          continue;
        }
        for (const c of cardAccountsFromLines(lines)) {
          if (!state.cardAccounts.includes(c)) { state.cardAccounts = [...state.cardAccounts, c]; cardLearned = true; }
        }
        const hash = statementContentHash(lines);
        if (await Store.hasStatement(hash)) { setProgress(i, 'duplicate'); dupes++; continue; }
        const parsed = parseStatementLines(lines, file.name);
        if (!parsed.transactions.length) { setProgress(i, 'failed'); failed++; state.warnings.push(`${file.name} did not contain transactions we could read.`); continue; }
        const recs = parsed.transactions.map((t) => ({ ...t, id: transactionIdentity(t), categoryOverride: null, reviewDismissed: false, lastChanged: new Date().toISOString(), originDevice: state.deviceId }));
        const merged = mergeTransactions(state.records, recs);
        state.records = merged.records; added += merged.added;
        await Store.putStatement({ hash, source_file: file.name, period: parsed.period, importedAt: new Date().toISOString() });
        if (parsed.period) periods.push(parsed.period);
        for (const seg of splitCardStatements(lines)) {
          try {
            const sum = parseCardStatementSummary(seg, file.name);
          if (sum.previousBalance != null && sum.newBalance != null) {
            const rec = reconcileCardStatement(sum);
            if (rec.checked && !rec.ok) {
                const expected = money0(roundMoney(sum.newBalance - sum.previousBalance));
                const got = money0(roundMoney(sum.purchases + sum.payments));
                const where = sum.statementKey ? ` (${sum.statementKey})` : '';
                state.warnings.push(`${file.name}${where}: this statement did not fully add up. We expected the balance to change by ${expected}, but the transactions we read total ${got}. Some transactions may not have been read.`);
              }
              const chash = cardStatementHash(sum);
              if (!(await Store.hasCardStatement(chash))) {
                const health = cardStatementHealth(sum);
                await Store.putCardStatement({
                  hash: chash, source_file: file.name, account: sum.account,
                  period: sum.periodText, statementKey: sum.statementKey,
                  periodStart: sum.periodStart, periodEnd: sum.periodEnd,
                  previousBalance: sum.previousBalance, purchases: sum.purchases,
                  payments: sum.payments, newBalance: sum.newBalance,
                  creditLimit: sum.creditLimit, creditAvailable: sum.creditAvailable,
                  minimumPayment: sum.minimumPayment, amountOwing: sum.amountOwing,
                  interestCharges: sum.interestCharges, eair: sum.eair,
                  utilisation: health.utilisation, revolving: health.revolving,
                  payingInFull: health.payingInFull,
                  reconciled: rec.ok, reconNote: rec.break || '',
                  importedAt: new Date().toISOString(),
                });
                cardStmtLearned = true;
              }
            }
          } catch (err) {
            console.warn(`Card statement summary could not be read for ${file.name}:`, err);
            state.warnings.push(`${file.name}'s reconciliation summary could not be read, so health details are missing for that statement.`);
          }
        }
        setProgress(i, 'done', merged.added);
      }
      await persist();
      if (bankAdded || bankDupes) { await persistBank(); state._bankStatements = await Store.allBankStatements(); if (bankAdded) state.view = state.records.length ? 'overview' : 'accounts'; }
      if (cardLearned) await Store.setMeta('bankCardAccounts', state.cardAccounts);
      if (cardStmtLearned) state._cardStatements = await Store.allCardStatements();
    } finally { setTimeout(closeProgress, 700); }
    render();
    if (bankAdded) toast(`Added ${bankAdded} account transaction${bankAdded > 1 ? 's' : ''} to your Accounts ledger.`);
    else if (added) toast(`Added ${added} new transaction${added > 1 ? 's' : ''}${periods.length ? ' · ' + periods[periods.length - 1] : ''}.`);
    else if ((dupes || bankDupes) && !failed) toast(`Already imported, so nothing changed.`);
    else if (failed && !added) toast(`We couldn't read ${failed === 1 ? 'that statement' : 'those statements'}.`);
    maybeOfferInstall();
    maybeOfferBackup();
    maybeOfferFirstRunHint();
  }

  async function persistBank() {
    await Store.replaceBankTransactions(state.bankRecords);
  }

  // Persist the ledger-rule confirmations (income-confirmed deposits, round-trip
  // pairs). Pure metadata, no transaction is ever changed.
  async function persistLedgerRules() {
    await Store.setMeta('bankConfirmedIncomeIds', state.confirmedIncomeIds || []);
    await Store.setMeta('bankRoundTripIds', state.roundTripIds || []);
  }

  /* progress dialog for imports */
  let progressState = null;
  function openProgress(files) {
    const rows = files.map((f, i) => el('div', { class: 'prog-row', id: 'prog-' + i },
      el('span', { class: 'prog-name' }, f.name),
      el('span', { class: 'prog-status', html: iconSpinner() })));
    const box = el('div', { class: 'picker wide' },
      el('div', { class: 'picker-head' }, `Adding ${files.length} statement${files.length > 1 ? 's' : ''}`),
      el('div', { class: 'prog-list' }, ...rows));
    const overlay = el('div', { class: 'overlay' }, box);
    document.body.append(overlay); progressState = overlay;
  }
  function setProgress(i, status, added) {
    const row = $('#prog-' + i, progressState || document); if (!row) return;
    const s = $('.prog-status', row);
    if (status === 'reading') s.innerHTML = iconSpinner() + ' Reading…';
    else if (status === 'done') s.innerHTML = `<span class="ok">✓ ${added || 0} added</span>`;
    else if (status === 'duplicate') s.innerHTML = `<span class="muted">Already imported</span>`;
    else if (status === 'reconwarn') s.innerHTML = `<span class="warnc">Added · check balance</span>`;
    else if (status === 'failed') s.innerHTML = `<span class="warnc">Couldn't read</span>`;
  }
  function closeProgress() { if (progressState) { progressState.remove(); progressState = null; } }

  async function persist() {
    await Store.replaceTransactions(state.records);
    await Store.setMeta('lastLocalUpdate', new Date().toISOString());
  }

  async function persistRules() {
    await Store.replaceRules(state.rules);
  }

  /* pdf.js (vendored, offline) */
  let _pdfjs = null;
  async function loadPdfjs() {
    if (_pdfjs) return _pdfjs;
    const mod = await import('../third-party/pdf.min.mjs');
    mod.GlobalWorkerOptions.workerSrc = new URL('../third-party/pdf.worker.min.mjs', import.meta.url).href;
    _pdfjs = mod; return mod;
  }

  /* desktop folder watching */
  async function chooseFolder() {
    if (!window.ccDesktop) return;
    const folder = await window.ccDesktop.chooseFolder();
    if (!folder) return;
    await Store.setMeta('watchedFolder', folder);
    toast('Watching that folder. New statements appear on their own.');
    scanWatchedFolder();
  }
  async function scanWatchedFolder() {
    if (!window.ccDesktop) return;
    const folder = await Store.getMeta('watchedFolder', null);
    if (!folder) return;
    const files = await window.ccDesktop.scanFolder(folder).catch(() => null);
    if (!files) { toast("We can't find the folder we were watching. Choose where your statements live now."); return; }
    await ingestDesktopPaths(files);
  }
  async function ingestDesktopPaths(paths) {
    if (!paths || !paths.length) return;
    const fileLikes = [];
    for (const p of paths) {
      const data = await window.ccDesktop.readFile(p).catch((err) => { console.warn(`Watched-folder file could not be read: ${p}`, err); return null; });
      if (data) fileLikes.push({ name: p.split(/[\\/]/).pop(), arrayBuffer: async () => data });
    }
    if (fileLikes.length) await ingestFiles(fileLikes);
  }

  /* Export menu: CSV, print, encrypted history.
   * The CSV / rules / encrypted-history orchestration moved to data-export.js
   * (Stage 3c-i); the print-model + report-driver group moved to reporting.js
   * (Stage 5, createPrintReports). Both are wired up in the factory block below. */

  /* install prompt (iOS) */
  const isStandalone = () => window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent);
  async function maybeOfferInstall() {
    if (isStandalone() || !isIOS() || window.ccDesktop) return;
    if (await Store.getMeta('installDismissed', false)) return;
    if (!state.records.length) return;
    const banner = $('#install'); banner.innerHTML = '';
    banner.append(
      el('span', { class: 'install-icon', html: iconPhone() }),
      el('span', {}, 'Add this to your Home Screen for reliable offline access and durable local storage. Tap the Share button, then “Add to Home Screen”.'),
      el('button', { class: 'btn sm ghost', onclick: () => { banner.classList.remove('show'); Store.setMeta('installDismissed', true); } }, 'Not now'));
    banner.classList.add('show');
  }

  /* C1 (S21): offer an encrypted backup once there is enough history to be worth
   * protecting. Its own banner element (never #install), appended to document.body,
   * reusing the generic .install-banner styling (positioning/animation only, nothing
   * iOS-specific). The primary action runs doExportHistory (the same encrypted export
   * as the Export menu); dismissing hides it and remembers the choice. No backup/shield
   * glyph exists in this icon set, so iconAlert is used: it flags the risk of loss the
   * copy names and reads distinctly from the neutral iconInfo used on card headers. */
  async function maybeOfferBackup() {
    if (await Store.getMeta('backupPromptDismissed', false)) return;
    const statementTotal = (state._cardStatements || []).length + (state._bankStatements || []).length;
    if (statementTotal < 3) return;                 // fewer than 3 statements: not enough history yet
    if (bannerAlreadyShown()) return;               // never stack over another banner at the same slot
    let banner = $('#backup-banner');
    if (!banner) { banner = el('div', { id: 'backup-banner', class: 'install-banner', role: 'note' }); document.body.append(banner); }
    banner.innerHTML = '';
    banner.append(
      el('span', { class: 'install-icon', html: iconAlert() }),
      el('span', {}, "Your history lives only on this device. Make an encrypted backup so you don't lose it."),
      el('button', { class: 'btn sm', onclick: () => { banner.classList.remove('show'); doExportHistory(); } }, 'Back up now'),
      el('button', { class: 'btn sm ghost', onclick: () => { banner.classList.remove('show'); Store.setMeta('backupPromptDismissed', true); } }, 'Not now'));
    banner.classList.add('show');
  }

  /* C2 (S7): a first-run nudge to add a second month, so trends, regular payments and
   * month-to-month comparison become available. Same banner mechanics as C1 (its own
   * element, document.body, reused .install-banner), gated on there being fewer than two
   * ledger-months. One dismiss action, no primary. iconChart is used because the copy is
   * about the trends a second month unlocks. */
  async function maybeOfferFirstRunHint() {
    if (allLedgerMonths().length >= 2) return;
    if (await Store.getMeta('firstRunHintShown', false)) return;
    if (bannerAlreadyShown()) return;               // never stack over another banner at the same slot
    let banner = $('#first-run-banner');
    if (!banner) { banner = el('div', { id: 'first-run-banner', class: 'install-banner', role: 'note' }); document.body.append(banner); }
    banner.innerHTML = '';
    banner.append(
      el('span', { class: 'install-icon', html: iconChart() }),
      el('span', {}, 'Add a couple more months to see trends, regular payments, and how each month compares.'),
      el('button', { class: 'btn sm ghost', onclick: () => { banner.classList.remove('show'); Store.setMeta('firstRunHintShown', true); } }, 'Got it'));
    banner.classList.add('show');
  }

  /* Whether any of the three bottom banners is already visible. The three gates are close
   * to mutually exclusive in practice - the backup prompt needs 3+ statements, the first-run
   * hint needs fewer than 2 ledger-months, and install is iOS-only - so at most one normally
   * qualifies. This guard is belt-and-braces so that in the rare overlap they never sit on top
   * of each other at the same fixed bottom position; whichever runs first this import wins the slot. */
  function bannerAlreadyShown() {
    return ['#install', '#backup-banner', '#first-run-banner']
      .some((sel) => { const b = $(sel); return b && b.classList.contains('show'); });
  }

  /* ---- chrome ---- */
  function wireChrome() {
    const addInput = $('#add-input');
    if (addInput) addInput.addEventListener('change', onAddInputChange);
    const exportBtn = $('#export-btn');
    if (exportBtn) exportBtn.addEventListener('click', (e) => { e.stopPropagation(); toggleExportMenu(); });
    // The four scope/detail CSV menu lines are now one row that opens a small
    // dialog (openCsvExportDialog, data-export.js) with a radio for scope and
    // a checkbox for detail level, rather than four near-identical sentences
    // in the dropdown itself.
    $('#exp-csv').addEventListener('click', openCsvExportDialog);
    $('#exp-print').addEventListener('click', printReport);
    $('#exp-rules-export').addEventListener('click', exportRules);
    const rulesInput = $('#exp-rules-input');
    if (rulesInput) {
      rulesInput.addEventListener('click', () => { setTimeout(() => toggleExportMenu(false), 0); });
      rulesInput.addEventListener('change', importRules);
    }
    $('#exp-export').addEventListener('click', doExportHistory);
    const historyInput = $('#exp-import-input');
    if (historyInput) {
      historyInput.addEventListener('click', () => { setTimeout(() => toggleExportMenu(false), 0); });
      historyInput.addEventListener('change', doImportHistory);
    }

    // Also build the report for a direct browser print (Ctrl/Cmd+P), so the
    // clean report - not the interactive dashboard, and not a blank page - is
    // what gets printed. It now routes through the SAME view-aware builder as
    // the Export menu, so a Ctrl+P from the Accounts or Overview view prints the
    // account report (previously it only ever built the card model, which is
    // why Ctrl+P from Accounts produced a blank page). If the menu path already
    // built the report (host has children), this is a no-op.
    window.addEventListener('beforeprint', () => {
      const host = $('#print-report');
      if (host && !host.firstChild) buildReportForCurrentView();
    });
    // Best-effort secondary cleanup only. The on-screen "Back to dashboard"
    // control is the reliable way out; these events are not guaranteed to fire
    // on an installed iOS PWA when a share sheet is cancelled.
    window.addEventListener('afterprint', exitPrint);
    if (window.matchMedia) {
      const mq = window.matchMedia('print');
      const onMq = (e) => { if (!e.matches) exitPrint(); };
      if (mq.addEventListener) mq.addEventListener('change', onMq);
      else if (mq.addListener) mq.addListener(onMq);
    }

    const themeBtn = $('#theme-btn');
    const themeLabel = $('#theme-label', themeBtn) || themeBtn;
    const paintTheme = () => {
      const t = document.documentElement.dataset.theme || 'auto';
      const name = t === 'dark' ? 'Dark' : t === 'light' ? 'Light' : 'Auto';
      themeLabel.textContent = name;
      themeBtn.setAttribute('aria-label', `Theme: ${name}`);
      themeBtn.setAttribute('title', `Theme: ${name}`);
    };
    themeBtn.addEventListener('click', async () => {
      const cur = document.documentElement.dataset.theme || 'auto';
      const next = cur === 'auto' ? 'light' : cur === 'light' ? 'dark' : 'auto';
      document.documentElement.dataset.theme = next; await Store.setMeta('theme', next);
      buildCategoryColours(); paintTheme(); if (state.records.length) render();
    });
    paintTheme();

    // drag & drop
    document.body.addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('dropping'); });
    document.body.addEventListener('dragleave', (e) => { if (e.target === document.body) document.body.classList.remove('dropping'); });
    document.body.addEventListener('drop', (e) => {
      e.preventDefault(); document.body.classList.remove('dropping');
      const files = [...(e.dataTransfer.files || [])].filter((f) => f.name.toLowerCase().endsWith('.pdf'));
      if (files.length) ingestFiles(files);
    });

    const folderBtn = $('#folder-btn');
    if (window.ccDesktop && folderBtn) { folderBtn.hidden = false; folderBtn.addEventListener('click', chooseFolder); }

    wireBackToTop();
  }

  // Back-to-top: one floating affordance (index.html's #to-top), the desktop
  // complement to the now top-pinned view switcher. Hidden until JS runs (so the
  // no-JS page never shows a dead control), then revealed by class only after
  // the page has scrolled roughly one viewport, so a short page never shows it.
  // It scrolls up through the ONE shared smoothScrollToTop() (which honours
  // prefers-reduced-motion in a single place), and CSS lifts it above the mobile
  // bottom nav so the two never overlap. The scroll listener is rAF-throttled and
  // passive, so it never thrashes layout on a long, fast scroll.
  function wireBackToTop() {
    const btn = $('#to-top');
    if (!btn) return;
    btn.hidden = false; // JS present: the .show class now governs visibility
    btn.addEventListener('click', () => smoothScrollToTop());
    let ticking = false;
    const update = () => {
      ticking = false;
      btn.classList.toggle('show', window.scrollY > window.innerHeight * 0.9);
    };
    window.addEventListener('scroll', () => {
      if (!ticking) { ticking = true; requestAnimationFrame(update); }
    }, { passive: true });
    update();
  }

  /* ---- inline icons (currentColor) ---- */
  const S = (p, o = {}) => `<svg viewBox="0 0 24 24" width="${o.w || 16}" height="${o.h || 16}" fill="none" stroke="currentColor" stroke-width="${o.sw || 1.7}" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;
  const iconUp = () => S('<path d="M12 19V5M6 11l6-6 6 6"/>');
  const iconDown = () => S('<path d="M12 5v14M6 13l6 6 6-6"/>');
  const iconInfo = () => S('<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8h.01"/>');
  const iconChevron = () => S('<path d="M9 6l6 6-6 6"/>');
  const iconBulb = () => S('<path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3 11c.6.4 1 1 1 2h4c0-1 .4-1.6 1-2a6 6 0 0 0-3-11z"/>');
  const iconFlag = () => S('<path d="M5 21V4M5 4h11l-2 4 2 4H5"/>');
  const iconChart = () => S('<path d="M4 20V6M10 20V4M16 20v-8M22 20H2"/>');
  const iconPie = () => S('<path d="M12 3v9h9a9 9 0 1 0-9 9"/><path d="M21 12a9 9 0 0 0-9-9"/>');
  const iconStore = () => S('<path d="M4 9h16M5 9l-1-4h16l-1 4M5 9v11h14V9"/>');
  const iconList = () => S('<path d="M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01"/>');
  const iconExplore = () => S('<circle cx="11" cy="11" r="7"/><path d="M21 21l-4-4"/>');
  const iconTag = (c) => `<svg viewBox="0 0 24 24" width="16" height="16" fill="${c}" stroke="none"><circle cx="12" cy="12" r="6"/></svg>`;
  const iconAlert = () => S('<path d="M12 9v4M12 17h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z"/>');
  const iconSpark = () => S('<path d="M12 3v4M12 17v4M3 12h4M17 12h4M6 6l2 2M16 16l2 2M18 6l-2 2M8 16l-2 2"/>');
  const iconRepeat = () => S('<path d="M17 2l4 4-4 4"/><path d="M3 11V9a4 4 0 0 1 4-4h14M7 22l-4-4 4-4"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>');
  const iconGlobe = () => S('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a15 15 0 0 1 0 18M12 3a15 15 0 0 0 0 18"/>');
  const iconReceipt = () => S('<path d="M6 2v20l3-2 3 2 3-2 3 2V2l-3 2-3-2-3 2-3-2z"/><path d="M9 8h6M9 12h6"/>');
  const iconBack = () => S('<path d="M9 14 4 9l5-5"/><path d="M4 9h11a5 5 0 0 1 0 10h-1"/>');
  const iconPeak = () => S('<path d="M3 20h18M6 20l4-9 4 5 4-11"/>');
  const iconGap = () => S('<path d="M8 3H5a2 2 0 0 0-2 2v3M16 3h3a2 2 0 0 1 2 2v3M21 16v3a2 2 0 0 1-2 2h-3M3 16v3a2 2 0 0 0 2 2h3"/>');
  const iconX = () => S('<path d="M18 6 6 18M6 6l12 12"/>', { w: 12, h: 12 });
  const iconPhone = () => S('<rect x="7" y="2" width="10" height="20" rx="2"/><path d="M11 18h2"/>');
  const iconSpinner = () => '<svg class="spin" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 3a9 9 0 1 0 9 9" stroke-linecap="round"/></svg>';

  // Accounts view + ledger-review controls live in accounts-render.js (Stage 2).
  // They receive the bootUI members they use via this one context object; the
  // four names app.js still calls are destructured back out. Placed here, after
  // the icon helpers (iconGlobe/iconInfo/iconList) and every other passed-in
  // member are initialised, and before start() runs the first render.
  //
  // prevLabel itself is only created later by createCardsRenderer (it needs
  // members that do not exist yet at this point), so it cannot be passed
  // directly here without reordering every factory below it. The SAME lazy-
  // wrapper trick already used for currentBankViewRows (see createDataExport
  // below) is reused: a plain forward-reference variable, reassigned once
  // createCardsRenderer runs, and called only at actual render time (long
  // after every factory below has finished construction).
  let prevLabelRef;
  const { renderAccounts, classifiedBank, bankMoney, cleanCounterparty, renderBankStatementTrust } = createAccountsRenderer({
    state, el, icon, toast, render, persistLedgerRules, openOverlay, openModal, closePicker,
    periodEmptyNotice, bankMonthsList, bankRecordsInPeriod, iconGlobe, iconInfo, iconList,
    iconStore, iconReceipt, iconRepeat, iconX,
    // Bank-appropriate insights (Part 2): period/range helpers and the extra
    // icons the new "What's changed" card for Accounts needs. pickStatements
    // lets the missing-months insight open the same add-statement flow the
    // Cards missingMonths insight already uses.
    resolved, bankRecordsInRange, pickStatements,
    iconUp, iconDown, iconAlert, iconSpark, iconGap, iconBulb, iconChevron, monthLabel,
    prevLabel: (...args) => prevLabelRef(...args),
    drillToAccountsPayee, drillToAccount,
    bankActiveFilterCount, clearBankFacet,
  });

  // Category-correction group lives in category-picker.js (Stage 3a). Same
  // pattern as Stage 2: it receives the bootUI members it uses via one context
  // object; the two names app.js still calls (from txTable and renderAttention)
  // are destructured back out. openCategoryPicker opens its modal through the
  // shared openModal(box) constructor (which wraps the box in an .overlay and
  // calls openOverlay itself), so openModal MUST be passed here - it is the one
  // this factory destructures and calls, not openOverlay. Passing openOverlay
  // instead left openModal undefined inside the factory, which threw
  // "openModal is not a function" the instant a category tag was clicked.
  // getPickerEl still stands in for the private pickerEl so setCategory can read
  // the checked scope radio. Placed after every passed-in member is initialised,
  // before start().
  const { openCategoryPicker, dismissReview } = createCategoryPicker({
    state, el, $, toast, render, closePicker, openModal, getPickerEl,
    persist, persistRules, catColour, isReview,
  });
  // Manage-data group (reload config, remove a statement, clear all data)
  // lives in manage-data.js (Stage 3b). Same pattern as Stages 2 and 3a: it
  // receives the bootUI members it uses via one context object; the three
  // names app.js still calls from renderManageData are destructured back out.
  // openOverlay stands in for the private pickerEl in openRemoveStatement and
  // confirmClearAll. Placed after every passed-in member is initialised,
  // before start().
  const { reloadConfig, openRemoveStatement, confirmClearAll } = createManageData({
    state, el, $, toast, render, closePicker, openOverlay, openModal,
    persist, persistBank, applyThemeColours, buildCategoryColours,
  });

  // Data export/import group (CSV, personal rules, encrypted history) lives in
  // data-export.js (Stage 3c-i). Same factory pattern as Stages 2-3b: it is the
  // stateful orchestration half of reporting.js's pure serialisers (toCSV /
  // bankToCSV / exportHistory / importHistory), receiving the bootUI members it
  // uses via one context object. currentBankViewRows is passed in as a function
  // reference - it stays in app.js with the print-model group (deferred to the
  // Cards-render-tree stage), so this file calls it without owning it. The seven
  // names wireChrome and printReport still call are destructured back out.
  // Placed after every passed-in member is initialised, before start().
  // Print-model group now lives in reporting.js (Stage 5, createPrintReports),
  // and it is created AFTER cards-render because it needs prevLabel /
  // histMonthlyAverage / buildInsights. Data-export, created here, needs that
  // group's currentBankViewRows (exportCurrentCSV calls it), while the print
  // group in turn needs data-export's toggleExportMenu (printReport calls it).
  // Both names are only ever invoked at click time, never during construction,
  // so a forward declaration plus a lazy wrapper breaks that two-factory cycle
  // without changing any behaviour or call order the user can observe.
  let printReports;
  const {
    toggleExportMenu, exportCurrentCSV, exportAllCSV, exportCurrentDetailedCSV, exportAllDetailedCSV,
    exportUnknownMerchants, exportRules, importRules, doExportHistory, doImportHistory,
    openCsvExportDialog,
  } = createDataExport({
    state, $, el, toast, render, persist, persistRules, persistBank, openModal, closePicker,
    classifiedBank, visibleRows, currentBankViewRows: (...args) => printReports.currentBankViewRows(...args),
  });

  // Cards dashboard render tree lives in cards-render.js (Stage 4). Same factory
  // pattern as Stages 2-3c-i: the 29 functions receive the bootUI members they
  // use via one context object; the 13 names app.js still calls are destructured
  // back out - the ten render* functions render() appends, plus prevLabel,
  // histMonthlyAverage and buildInsights, which buildPrintModel (kept here with
  // the print-model group) calls. Placed after every passed-in member is
  // initialised - the icon helpers above, openCategoryPicker/dismissReview from
  // createCategoryPicker, and the formatting/period helpers - and before start().
  const {
    renderHero, renderInsightsAndAttention, renderTrend, renderCategoryPanel,
    renderForeign, renderMerchants, renderRecurring, renderRecent, renderExplorer,
    renderSecondary, renderCardFitness, prevLabel, histMonthlyAverage, buildInsights,
  } = createCardsRenderer({
    state, el, icon, $, render, applyFilter, resolved, analysis, periodRows,
    visibleRows, activeFilterCount, clearFilters, money0, moneyShort, pct,
    monthLabel, monthShort, catColour, isReview, FALLBACK, allMonths,
    updateFooter, pickStatements, secItem, statementCount, statusText, manageDataBody,
    openCategoryPicker, dismissReview, showTip, hideTip, highestCompleteMonth,
    // Same classifiedBank() (classifyInternalTransfers + applyLedgerRules) that
    // Accounts (createAccountsRenderer, above) and Overview (renderOverview)
    // already read for the combined "Regular payments" total and cross-ledger
    // payment matching. Cards previously called classifyInternalTransfers
    // directly and skipped applyLedgerRules, so a payment already confirmed as
    // a round-trip or flagged as household support on Accounts could still
    // reappear in Cards' combined total - the two tabs silently disagreeing on
    // the same figure. Passing the one shared function closes that gap.
    classifiedBank,
    iconInfo, iconUp, iconDown, iconBulb, iconChevron, iconFlag, iconChart,
    iconPie, iconStore, iconList, iconExplore, iconX, iconRepeat, iconGlobe,
    iconTag, iconAlert, iconSpark, iconReceipt, iconBack, iconPeak, iconGap,
    iconCal,
  });
  // Bind the Accounts-hero forward reference now that prevLabel exists (see
  // the lazy-wrapper comment above createAccountsRenderer's construction).
  prevLabelRef = prevLabel;

  // Print-model + report-driver group lives in reporting.js (Stage 5). It is the
  // orchestration half of reporting.js's three renderers (renderReport /
  // renderBankReport / renderOverviewReport): it builds their plain data models
  // from live bootUI state and drives the print flow. Placed here, after every
  // ctx member is initialised - the accounts-render constants (classifiedBank /
  // bankMoney / cleanCounterparty) and the cards-render constants (prevLabel /
  // histMonthlyAverage / buildInsights) it depends on, plus toggleExportMenu -
  // and before start(). The four names app.js still calls are destructured back
  // out: printReport (Export menu), buildReportForCurrentView (beforeprint),
  // exitPrint (afterprint / close), and currentBankViewRows (handed to the
  // data-export factory above via the lazy wrapper).
  printReports = createPrintReports({
    state, $, el, toast, iconX, toggleExportMenu, bankRecordsInPeriod,
    resolved, analysis, periodRows, visibleRows, allMonths, FALLBACK,
    isReview, catColour, money0, moneyShort, pct, monthLabel, monthShort,
    prevLabel, histMonthlyAverage, buildInsights, classifiedBank, bankMoney,
    cleanCounterparty,
  });
  const { printReport, buildReportForCurrentView, exitPrint } = printReports;


  /* ---- start ---- */
  async function start() {
    const res = await fetch(new URL('../settings/config.json', import.meta.url));
    if (!res.ok) throw new Error(`Could not load configuration (HTTP ${res.status}).`);
    state.cfg = withConfigDefaults(await res.json());
    state.compiled = compileRules(state.cfg.categories);
    state.brandRules = compileBrandRules(state.cfg);
    // Jamaica/Scotiabank-specific bank-descriptor cleanup (ABM terminal marker,
    // processing-date suffix, trailing country code, wrapped "Financial
    // Centre" split, salary-month token, correspondent-bank suffix) is
    // config-driven - see config.json's bankDescriptorCleanup.rules. This call
    // was never added when that feature was built, so the app silently kept
    // running on read-statements.js's built-in 4-rule fallback all session -
    // which is exactly why the two newer config-only rules never fired.
    setBankDescriptorCleanupRules(state.cfg.bankDescriptorCleanup && state.cfg.bankDescriptorCleanup.rules);    // Load the researched merchant list named by config.merchants.file and
    // compile it once. This is the same compiled list categorise() and the
    // merchant grouping both read, so the whole app agrees on merchants.
    try {
      const mFile = (state.cfg.merchants && state.cfg.merchants.file) || 'jamaica-merchants.json';
      const mRes = await fetch(new URL('../settings/' + mFile, import.meta.url));
      state.merchants = compileMerchantIntelligence(await mRes.json(), state.cfg);
      const cleanupRules = [];
      for (const r of ((state.cfg.bankDescriptorCleanup && state.cfg.bankDescriptorCleanup.rules) || [])) {
        if (!r || !r.pattern) continue;
        try { cleanupRules.push({ pattern: new RegExp(r.pattern, r.flags || 'i'), replacement: r.replacement || '' }); }
        catch { }
      }
      state.resolver = createMerchantResolver({ merchants: state.merchants, cleanupRules });
    } catch (err) {
      // If the list cannot be read, the app still runs; the generic category
      // rules decide on their own, exactly as before this feature existed.
      console.warn('Merchant list could not be loaded; category rules will decide alone.', err);
      state.merchants = [];
      state.resolver = null;
    }
    state.keepUpper = new Set(state.cfg.keepUpper);
    state.smallWords = new Set(state.cfg.smallWords);
    applyThemeColours();
    document.documentElement.dataset.theme = await Store.getMeta('theme', state.cfg.display && state.cfg.display.theme || 'auto');
    buildCategoryColours();
    state.deviceId = await Store.getMeta('deviceId', null);
    if (!state.deviceId) { state.deviceId = 'dev-' + fnv1a(String(Date.now()) + Math.random()); await Store.setMeta('deviceId', state.deviceId); }
    state.lastImportedFrom = await Store.getMeta('lastImportedFrom', null);
    state.rules = await Store.allRules();
    state.records = await Store.allTransactions();
    // Bank ledger (Phase 1): load its own store and the "my accounts" list.
    state.bankRecords = await Store.allBankTransactions();
    state._bankStatements = await Store.allBankStatements();
    state.myAccounts = await Store.getMeta('bankMyAccounts', []);
    state.cardAccounts = await Store.getMeta('bankCardAccounts', []);
    state.confirmedIncomeIds = await Store.getMeta('bankConfirmedIncomeIds', []);
    state.roundTripIds = await Store.getMeta('bankRoundTripIds', []);
    state.sharedAccounts = await Store.getMeta('bankSharedAccounts', []);
    state.householdPayees = await Store.getMeta('bankHouseholdPayees', []);
    state._cardStatements = await Store.allCardStatements();
    // Data-aware boot default: both ledgers land on the combined Overview,
    // bank-only on Accounts, card-only (or empty) on Cards. This never lands on
    // a view that has no data, so the first paint always shows something real.
    state.view = (state.records.length && state.bankRecords.length) ? 'overview'
      : state.bankRecords.length ? 'accounts' : 'cards';
    document.title = state.cfg.app.name;
    const brand = $('#brand-name'); if (brand) brand.textContent = state.cfg.app.name;
    wireChrome();
    render();
    if (window.ccDesktop) {
      await scanWatchedFolder();
      window.ccDesktop.onNewFile(async (path) => { await ingestDesktopPaths([path]); });
      if (window.ccDesktop.onWatchError) window.ccDesktop.onWatchError(() => toast("The folder we were watching is unavailable. Choose it again when you're ready."));
    }
    // Register the offline service worker in production only. On localhost it
    // is deliberately skipped so development always serves live files with no
    // cache in front - edit, reload, see the change, with no version bump and
    // nothing to unregister. A real deployment (any non-localhost host) still
    // gets the full offline PWA. Any worker left over from a past localhost
    // session is torn down so it cannot keep serving a stale shell.
    const isLocalDev = ['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(location.hostname);
    if ('serviceWorker' in navigator) {
      if (isLocalDev) {
        navigator.serviceWorker.getRegistrations()
          .then((regs) => regs.forEach((r) => r.unregister()))
          .catch((err) => { console.warn('Service worker cleanup (localhost) failed:', err); });
      } else {
        const swUrl = new URL('../service-worker.js', import.meta.url).href;
        const swScope = new URL('../', import.meta.url).href;
        navigator.serviceWorker.getRegistrations()
          .then(async (regs) => {
            // Removes any previously active worker whose script URL no longer
            // matches this location, so a worker registered before a folder
            // move or an account/domain rename is cleared automatically,
            // rather than needing every visitor to clear it by hand in DevTools.
            for (const r of regs) {
              if (r.active && r.active.scriptURL !== swUrl) await r.unregister();
            }
            await navigator.serviceWorker.register(swUrl, { scope: swScope });
          })
          .catch((err) => { console.warn('Service worker registration failed:', err); });
      }
    }
  }

  function highestCompleteMonth() {
    const months = allMonths(); if (!months.length) return null;
    const inc = detectIncompleteMonth(state.rows, months, new Date(), { coverage: state.coverage });
    let best = null;
    for (const m of months) { if (inc && m === inc.month) continue; const v = state.allSummary.by_month[m] || 0; if (!best || v > best.amount) best = { month: m, amount: v }; }
    return best;
  }

  start();
}

// Boot the interface only in a browser with a DOM. In Node (tests) this file is
// imported purely for its exported functions and nothing runs.
if (typeof window !== 'undefined' && typeof document !== 'undefined' && document.getElementById) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootUI);
  else bootUI();
}