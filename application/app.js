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

import {
  // eslint-disable-next-line no-unused-vars
  categoryRuleFromStoreRecord,
  merchantGroupKey,
  compileBrandRules,
  rulesToMerchantOverrides,
} from '../settings/category-rules.js';

import {
  MONTHS_SHORT,
  fnv1a,
  monthKey,
  roundMoney,
  formatMoney,
  formatDisplayDate,
  smoothScrollToTop,
  smoothScrollToEl,
  drillToTransactions as drillToTransactionsPure,
  withConfigDefaults,
  yieldToBrowser,
  DEV_SIGNATURE,
  LOCAL_DEV_HOSTS,
  bankRowsInapplicable as bankRowsInapplicablePure,
  cardRowsInapplicable as cardRowsInapplicablePure,
} from './core/shared-helpers.js';
import {
  parseStatementLines,
  extractLines,
  statementContentHash,
  parseCardStatementSummary,
  splitCardStatements,
  setBankDescriptorCleanupRules,
  parseBankStatementLines,
  detectStatementFormat,
  reconcileBankStatement,
  bankTransactionIdentity,
  bankStatementHash,
  transactionIdentity,
  cardStatementHash,
  cardAccountsFromLines,
  mergeBankTransactions,
  mergeTransactions,
  reconcileCardStatement,
  cardStatementHealth,
  detectCardStatementFormat,
  parseNcbStatementLines,
  splitNcbStatements,
  buildNcbStatementRecord,
  scotiaCardHolderFirstName,
  scotiaBankHolderFirstName,
} from './statements/read-statements.js';
import {
  bankFlowOverTime,
  detectBankStandingDebits,
  analyseCombinedOverview,
  analyseRollup,
  analyseBankActivity,
} from './analysis/bank-analysis.js';
import { compileRules, merchantLabel } from './statements/categorise.js';
import { compileFromRaw } from './statements/merchant-resolver.js';
import { Store } from './core/storage.js';
import {
  buildRows,
  summarise,
  attentionItems,
  orderCategoriesForPicker,
  monthName,
  detectIncompleteMonth,
  resolvePeriod,
  analysePeriod,
  analysisForWindow,
  ymToday,
  detectRecurring,
  foreignSummary,
  missingMonths,
  monthlyCommitmentsTotal,
  typicalMonthlyOutflow,
  runwayDays,
  createPrintReports,
  buildBankAppropriateInsights,
  buildHeroSection,
  renderInsightList,
  renderExplainer,
  renderShareBar,
  MONEY_IN_PALETTE,
  MONEY_OUT_PALETTE,
  SHARE_PALETTE,
  buildStatementCoverage,
  normaliseEair,
  medianRecentPayment,
  computeGoalProgress,
  describeGoal,
} from './analysis/reporting.js';
import {
  iconUp,
  iconDown,
  iconInfo,
  iconChevron,
  iconBulb,
  iconFlag,
  iconChart,
  iconPie,
  iconStore,
  iconList,
  iconTag,
  iconAlert,
  iconSpark,
  iconRepeat,
  iconGlobe,
  iconReceipt,
  iconBack,
  iconPeak,
  iconGap,
  iconX,
  iconPhone,
  iconSpinner,
  iconCal,
} from './core/icons.js';
import { createAccountsRenderer } from './ui/accounts-render.js';
import { createCategoryPicker } from './ui/category-picker.js';
import { createManageData } from './ui/manage-data.js';
import { createDataExport } from './output/data-export.js';
import { createCardsRenderer } from './ui/cards-render.js';
import { createAheadRenderer } from './ui/ahead-render.js';
import { createOverviewRenderer } from './ui/overview-render.js';
import { createProvenModels } from './analysis/proven-models.js';
import { ensureMigrated } from './analysis/goal-migrate.js';
import { evaluateGoal } from './analysis/goals.js';
import { buildNewEngineProgressCtx as buildNewEngineProgressCtxPure } from './analysis/goal-progress-ctx.js';
import { makeIntention } from './analysis/category-intentions.js';
import { makeTag } from './analysis/tag-totals.js';
import {
  makeCustomCategory,
  mergeCategories,
  categoryNameExists,
  canDeleteCategory,
} from './analysis/custom-categories.js';
import { createPositionRenderer } from './ui/position-render.js';
import { createForecastChartRenderer } from './ui/forecast-chart-render.js';
import { createIncomeChartRenderer } from './ui/income-chart-render.js';
import { createFlowChartRenderer } from './ui/flow-chart-render.js';
import { createActivityRenderer } from './ui/activity-render.js';

import { makeManualAsset, NET_WORTH_CLASSES } from './analysis/position.js';
import { categoryTotalsWithSplits, splitsByTxnId } from './analysis/transaction-splits.js';

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
    for (const kid of kids.flat())
      if (kid != null && kid !== false)
        n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
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
    { key: 'search', default: '', additive: false, countable: true },
    { key: 'month', default: 'all', additive: true, countable: true },
    { key: 'min', default: null, additive: true, countable: true },
    { key: 'max', default: null, additive: true, countable: true },
    { key: 'category', default: 'all', additive: false, countable: true },
    { key: 'kind', default: 'all', additive: false, countable: true },
    { key: 'merchant', default: '', additive: false, countable: true },
    // Display-only companion of `merchant` - never checked on its own, so it
    // must not count a second time toward "how many filters are active".
    { key: 'merchantLabel', default: '', additive: false, countable: false },
    { key: 'foreignOnly', default: false, additive: false, countable: true },
    { key: 'reviewOnly', default: false, additive: false, countable: true },
  ];
  function cardFilterDefaults() {
    const out = {};
    for (const f of CARD_FACETS) out[f.key] = f.default;
    return out;
  }
  function clearFilters() {
    state.filter = cardFilterDefaults();
  }
  // Resets ONLY the drill facets, leaving every additive control (Month,
  // Min/Max) exactly as the person left it. Run by applyFilter() before it
  // applies a fresh drill's own patch.
  function resetCardDrillFacets() {
    for (const f of CARD_FACETS) if (!f.additive) state.filter[f.key] = f.default;
  }

  // Accounts' twin. bankAccount physically lives OUTSIDE state.bankFilter (it
  // predates that object) - exactly why it and payeeKey previously had two
  // INDEPENDENT, hand-written reset paths that drifted apart. Each entry
  // carries its own get/set so the registry reaches into either location
  // uniformly, without a wider rename of every state.bankAccount reference.
  const BANK_FACETS = [
    {
      key: 'bankAccount',
      default: 'all',
      additive: false,
      countable: true,
      get: () => state.bankAccount,
      set: (v) => {
        state.bankAccount = v;
      },
    },
    {
      key: 'payeeKey',
      default: '',
      additive: false,
      countable: true,
      get: () => state.bankFilter.payeeKey,
      set: (v) => {
        state.bankFilter.payeeKey = v;
      },
    },
    // Display-only companion of payeeKey - not counted a second time.
    {
      key: 'payeeLabel',
      default: '',
      additive: false,
      countable: false,
      get: () => state.bankFilter.payeeLabel,
      set: (v) => {
        state.bankFilter.payeeLabel = v;
      },
    },
    // A narrowing control, same risk class as bankAccount/payeeKey - resets
    // on a fresh drill so it can never silently intersect with a NEW slice.
    {
      key: 'search',
      default: '',
      additive: false,
      countable: true,
      get: () => state.bankFilter.search,
      set: (v) => {
        state.bankFilter.search = v;
      },
    },
    // A display preference (which rows show), not a narrowing target - the
    // same reasoning as Cards' Month - so it survives a drill.
    {
      key: 'hideInternal',
      default: true,
      additive: true,
      countable: true,
      get: () => state.bankFilter.hideInternal,
      set: (v) => {
        state.bankFilter.hideInternal = v;
      },
    },
    // Movement-kind drill, the bank twin of Cards' category facet: a click on
    // the "What the money was doing" breakdown narrows the transaction list to
    // that kind, so that card drills like every other summary list rather than
    // only scrolling. A DRILL facet - resets on any other drill.
    {
      key: 'kind',
      default: 'all',
      additive: false,
      countable: true,
      get: () => state.bankFilter.kind,
      set: (v) => {
        state.bankFilter.kind = v;
      },
    },
  ];
  function bankFilterDefaults() {
    const out = {};
    for (const f of BANK_FACETS) if (f.key !== 'bankAccount') out[f.key] = f.default;
    return out;
  }
  function clearBankFilters() {
    for (const f of BANK_FACETS) f.set(f.default);
  }
  function resetBankDrillFacets() {
    for (const f of BANK_FACETS) if (!f.additive) f.set(f.default);
  }

  const state = {
    cfg: null,
    compiled: [],
    keepUpper: new Set(),
    smallWords: new Set(),
    brandRules: [],
    merchants: [],
    resolver: null,
    records: [],
    rules: [],
    rows: [],
    allSummary: null,
    coverage: null,
    warnings: [],
    period: { type: 'latest-complete', from: null, to: null },
    // Built from CARD_FACETS above - the ONE declared source of these fields.
    filter: cardFilterDefaults(),
    sort: { key: 'date', dir: 'desc' },
    showAllTx: false,
    catColour: {},
    deviceId: null,
    lastImportedFrom: null,
    firstName: null,
    firstNameSource: null,
    lastLocalUpdate: null,
    // Bank ledger (Phase 1). Held separately from card `records`; `view` picks
    // which ledger is on screen and only appears once bank data exists.
    bankRecords: [],
    myAccounts: [],
    cardAccounts: [],
    view: 'overview',
    bankWarnings: [],
    bankAccount: 'all',
    activityTab: 'analysis',
    // Accounts-ledger transaction filter (Recommendation 1). Parallel to
    // state.filter (which is card-only: it reads category/kind/merchant/etc.
    // that bank rows do not have), so the two ledgers keep separate filter
    // models rather than one conflated pipeline. hideInternal defaults true so
    // the Accounts transaction list opens as a guided, de-noised view -
    // internal transfers are the bulk of the rows and are already excluded
    // from Cash inflow/out - instead of an uncapped wall; the toggle brings them
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
    confirmedIncomeIds: [],
    refundIncomeIds: [],
    sharedAccounts: [],
    householdPayees: [],
    // Round 4 (Where you're headed): the person's single stated goal, kept to
    // a short fixed set of choices (GOAL_TYPES, reporting.js), and a small
    // log of past months' honest follow-up checks against it. The goal
    // itself is a personal intention independent of any specific imported
    // statement, so it survives "Clear all data" (like state.firstName);
    // goalLog is a record of facts derived from statement data, so it is
    // reset alongside the other statement-derived fields (like
    // confirmedIncomeIds) - see manage-data.js's doClearAll.
    goal: null,
    goalLog: [],
    // v4 analysis stores (proven modules): loaded at boot, read by the
    // proven-models accessors. Additive; no existing field is touched.
    categoryIntentions: [],
    manualAssets: [],
    forecastSnapshots: [],
    tags: [],
    transactionSplits: [],
    // Private, on-device usage tally (Round 1 foundation): a count against a
    // screen or action name, nothing else. Loaded from meta at boot; see
    // trackUsage below for how it is written back.
    _usageTally: {},
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
  const monthShort = (ym) => {
    const m = /^(\d{4})-(\d{2})$/.exec(ym);
    if (!m) return ym;
    return `${MONTHS_SHORT[+m[2] - 1]} ${m[1].slice(2)}`;
  };
  const monthLabel = (ym) => monthName(ym);

  const toast = (msg, undoFn) => {
    const t = $('#toast');
    t.innerHTML = '';
    t.append(el('span', {}, msg));
    if (undoFn)
      t.append(
        el(
          'button',
          {
            class: 'undo',
            onclick: () => {
              t.classList.remove('show');
              undoFn();
            },
          },
          'Undo'
        )
      );
    t.classList.add('show');
    clearTimeout(t._h);
    t._h = setTimeout(() => t.classList.remove('show'), undoFn ? 10000 : 8000);
  };

  // Private, on-device usage tally (Round 1 foundation): a plain count of how
  // often a screen or action is opened, so a later decision to trim or keep
  // something (the "recent activity" glance, the Overview routing cards - see
  // section 7 of the restructuring plan) can be checked against real use
  // rather than guessed. Never transmitted anywhere; the only thing stored is
  // a name and a count, via the same meta key/value store every other small
  // setting already uses. Writes are debounced so a burst of clicks costs one
  // IndexedDB write, not one per click.
  let _usageTallyTimer = null;
  function trackUsage(key) {
    if (!key) return;
    state._usageTally[key] = (state._usageTally[key] || 0) + 1;
    clearTimeout(_usageTallyTimer);
    _usageTallyTimer = setTimeout(() => {
      Store.setMeta('usageTally', state._usageTally);
    }, 800);
  }

  /* ---- theme colours from config ---- */
  function applyThemeColours() {
    const c = state.cfg.colours || {};
    const r = document.documentElement.style;
    for (const [k, v] of Object.entries(c))
      r.setProperty('--' + k.replace(/[A-Z]/g, (m) => '-' + m.toLowerCase()), v);
  }

  /* ---- stable category → colour map (consistent everywhere) ----
   * PALETTE is the SAME array reporting.js exports as SHARE_PALETTE (the
   * share-bar's own fallback/collision palette). Previously declared here as
   * an independent, byte-identical copy; this import means the two can never
   * drift apart again. */
  const PALETTE = SHARE_PALETTE;
  let _colKey = null;
  function buildCategoryColours() {
    const themeKey = document.documentElement.dataset.theme || 'auto';
    if (_colKey && _colKey.cfg === state.cfg && _colKey.theme === themeKey) return;
    const map = {};
    const slot = (name) => {
      let h = 0;
      for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
      return PALETTE[h % PALETTE.length];
    };
    (state.cfg.categories || []).forEach((c) => {
      map[c.name] = slot(c.name);
    });
    map[FALLBACK()] =
      getComputedStyle(document.documentElement).getPropertyValue('--muted').trim() || '#8a8f99';
    state.catColour = map;
    _colKey = { cfg: state.cfg, theme: themeKey };
  }
  const catColour = (name) => state.catColour[name] || '#8a8f99';
  const isReview = (name) => name === FALLBACK();

  /* ---- recompute rows + all-time summary from records ---- */
  let _rcKey = null;
  function recompute() {
    if (
      _rcKey &&
      _rcKey.records === state.records &&
      _rcKey.rules === state.rules &&
      _rcKey.compiled === state.compiled &&
      _rcKey.merchants === state.merchants &&
      _rcKey.brandRules === state.brandRules &&
      _rcKey.resolver === state.resolver &&
      _rcKey.keepUpper === state.keepUpper &&
      _rcKey.smallWords === state.smallWords &&
      _rcKey.cfg === state.cfg &&
      _rcKey.splits === state.transactionSplits
    ) {
      return;
    }
    state.rows = buildRows(state.records, state.compiled, {
      keepUpper: state.keepUpper,
      smallWords: state.smallWords,
      fallback: state.cfg.special.fallback,
      paymentCategory: state.cfg.special.paymentCategory,
      refundCategory: state.cfg.special.refundCategory,
      feeCategories: new Set(state.cfg.special.feeCategories),
      merchantOverrides: rulesToMerchantOverrides(state.rules),
      merchants: state.merchants,
      brandRules: state.brandRules,
      resolver: state.resolver, // card-identity door for categorise (grouping still uses merchants)
    });
    state.allSummary = summarise(state.rows, {
      keepUpper: state.keepUpper,
      smallWords: state.smallWords,
      brandRules: state.brandRules,
      merchants: state.merchants,
      fallback: state.cfg.special.fallback,
      splits: state.transactionSplits,
    });
    _rcKey = {
      records: state.records,
      rules: state.rules,
      compiled: state.compiled,
      merchants: state.merchants,
      brandRules: state.brandRules,
      resolver: state.resolver,
      keepUpper: state.keepUpper,
      smallWords: state.smallWords,
      cfg: state.cfg,
      splits: state.transactionSplits,
    };
  }

  const allMonths = () => (state.allSummary ? state.allSummary.months : []);
  // The month domain the ONE shared period selector spans: every month present
  // in EITHER ledger (card statements and bank statements), sorted. A single
  // domain means the single selected period resolves to the identical window
  // for Cards, Accounts and Overview, so the three can never disagree on the
  // timeframe. Bank rows are dated YYYY-MM-DD; their month is the first 7 chars.
  const bankMonthsList = () => [
    ...new Set(
      (state.bankRecords || []).map((r) => String(r.date || '').slice(0, 7)).filter(Boolean)
    ),
  ];
  const allLedgerMonths = () => [...new Set([...allMonths(), ...bankMonthsList()])].sort();
  const merchantLabelFn = (s) => merchantLabel(s, state.keepUpper, state.smallWords);

  let _rsKey = null,
    _rsVal = null;
  function resolved() {
    const nowYM = ymToday();
    if (
      _rsKey &&
      _rsKey.p === state.period &&
      _rsKey.rw === state.rows &&
      _rsKey.br === state.bankRecords &&
      _rsKey.cov === state.coverage &&
      _rsKey.ym === nowYM
    ) {
      return _rsVal;
    }
    _rsVal = resolvePeriod(state.period, state.rows, allLedgerMonths(), new Date(), state.coverage);
    _rsKey = {
      p: state.period,
      rw: state.rows,
      br: state.bankRecords,
      cov: state.coverage,
      ym: nowYM,
    };
    // INVARIANT: this object is shared by reference across the ~10 callers in
    // a render. Treat it as READ-ONLY; never mutate a returned period.
    return _rsVal;
  }
  function bankRecordsInPeriod(recs) {
    const p = resolved();
    if (!p || state.period.type === 'all') return recs;
    return recs.filter((r) => {
      const m = String(r.date || '').slice(0, 7);
      return m >= p.from && m <= p.to;
    });
  }
  function bankRecordsInRange(recs, from, to) {
    if (!from || !to) return [];
    return recs.filter((r) => {
      const m = String(r.date || '').slice(0, 7);
      return m >= from && m <= to;
    });
  }
  let _anKey = null,
    _anVal = null;
  function analysis() {
    const p = resolved();
    if (!p) return null;
    if (
      _anKey &&
      _anKey.rows === state.rows &&
      _anKey.p === p &&
      _anKey.ku === state.keepUpper &&
      _anKey.sw === state.smallWords &&
      _anKey.br === state.brandRules &&
      _anKey.me === state.merchants &&
      _anKey.sp === state.transactionSplits
    ) {
      return _anVal;
    }
    _anVal = analysePeriod(state.rows, p, {
      keepUpperSet: state.keepUpper,
      smallWordsSet: state.smallWords,
      merchantLabelFn,
      brandRules: state.brandRules,
      merchants: state.merchants,
      splits: state.transactionSplits,
    });
    _anKey = {
      rows: state.rows,
      p,
      ku: state.keepUpper,
      sw: state.smallWords,
      br: state.brandRules,
      me: state.merchants,
      sp: state.transactionSplits,
    };
    return _anVal;
  }

  /* rows inside the current period (before drill-down filters) */
  function periodRows() {
    const p = resolved();
    if (!p) return [];
    return state.rows.filter((r) => r.month >= p.from && r.month <= p.to);
  }

  // Activity comparison helpers. These adapt the app's existing resolved
  // period and classified card rows to the thin activity renderer. No
  // transaction is reclassified or independently reconstructed here.
  // (previousPeriod is supplied to createActivityRenderer as an inline arrow
  // at its own construction call site further down this file - this
  // standalone copy was an unused, superseded duplicate.)

  function monthsInWindow(window) {
    if (!window || !window.from || !window.to) return [];

    const months = [];
    let year = Number(window.from.slice(0, 4));
    let month = Number(window.from.slice(5, 7));
    const endYear = Number(window.to.slice(0, 4));
    const endMonth = Number(window.to.slice(5, 7));

    while (year < endYear || (year === endYear && month <= endMonth)) {
      months.push(`${year}-${String(month).padStart(2, '0')}`);
      month += 1;
      if (month === 13) {
        month = 1;
        year += 1;
      }
    }

    return months;
  }

  function isPeriodFullyCovered(window) {
    const expected = monthsInWindow(window);
    if (!expected.length) return false;

    const available = new Set(allLedgerMonths());
    return expected.every((month) => available.has(month));
  }

  function categorySpend(category, window) {
    if (!category || !window || !window.from || !window.to) return null;

    const spendRows = state.rows.filter(
      (row) => row.month >= window.from && row.month <= window.to && row.kind === 'spend'
    );

    if (!spendRows.length) return 0;

    const splitMap = splitsByTxnId(state.transactionSplits || []);
    const { byCategory } = categoryTotalsWithSplits(spendRows, splitMap);

    return roundMoney(byCategory[category] || 0);
  }

  /* rows after the shared filter/drill-down state (used by explorer + recent + CSV) */
  // Memoised across a render pass: Recent (slice + "View all" count), the
  // explorer and CSV all ask for the same set, so compute it once and reuse it.
  // The cache key is a cheap signature of every input that affects the result
  // (filter, sort, resolved period and a rows-version bumped on recompute), so
  // it auto-invalidates the instant any of them change - same rows, same order,
  // same counts as before, just not recomputed on every call.
  let _vrKey = null,
    _vrVal = null,
    _vrRows = null;
  function visibleRowsSignature() {
    const f = state.filter;
    const p = state.period;
    return [
      f.search,
      f.category,
      f.kind,
      f.merchant,
      f.month,
      f.min,
      f.max,
      f.foreignOnly,
      f.reviewOnly,
      state.sort.key,
      state.sort.dir,
      p.type,
      p.from || '',
      p.to || '',
    ].join('|');
  }
  function visibleRows() {
    const key = visibleRowsSignature();
    if (key === _vrKey && _vrRows === state.rows) return _vrVal;
    const rows = computeVisibleRows();
    _vrKey = key;
    _vrVal = rows;
    _vrRows = state.rows;
    return rows;
  }
  function computeVisibleRows() {
    const f = state.filter;
    let rows = periodRows();
    if (f.month !== 'all') rows = rows.filter((r) => r.month === f.month);
    if (f.category !== 'all') rows = rows.filter((r) => r.category === f.category);
    if (f.kind !== 'all') rows = rows.filter((r) => r.kind === f.kind);
    if (f.merchant)
      rows = rows.filter(
        (r) => merchantGroupKey(r.description, state.brandRules, state.merchants) === f.merchant
      );
    if (f.foreignOnly) rows = rows.filter((r) => r.foreign);
    if (f.reviewOnly) rows = rows.filter((r) => r.category === FALLBACK() || r.needsReview);
    if (f.min != null) rows = rows.filter((r) => Math.abs(r.amount) >= f.min);
    if (f.max != null) rows = rows.filter((r) => Math.abs(r.amount) <= f.max);
    if (f.search) {
      const q = f.search.toLowerCase();
      rows = rows.filter(
        (r) =>
          r.description.toLowerCase().includes(q) ||
          r.raw_description.toLowerCase().includes(q) ||
          r.category.toLowerCase().includes(q) ||
          monthLabel(r.month).toLowerCase().includes(q) ||
          r.source_file.toLowerCase().includes(q) ||
          String(r.amount).includes(q) ||
          r.date.includes(q)
      );
    }
    const { key, dir } = state.sort;
    const s = dir === 'asc' ? 1 : -1;
    rows = rows.slice().sort((a, b) => {
      let av = a[key],
        bv = b[key];
      if (key === 'amount') {
        av = a.amount;
        bv = b.amount;
      }
      return av < bv ? -s : av > bv ? s : 0;
    });
    return rows;
  }

  // Bank-side twin of computeVisibleRows, above. Right Now's merged ledger
  // previously read NONE of these facets - drillToAccountsPayee (called from
  // Income's payee row, and every inflow/outflow row in "Where money went and
  // came from") set state.bankFilter.payeeKey correctly, but nothing ever
  // read it back, so the drill silently showed the full unfiltered list.
  // hideInternal was separately hardcoded true inside right-now-render.js
  // itself, ignoring the real toggle value entirely - moved here so the
  // registry-declared default is the ONE place that decision is made.
  // Bank rows carry no spend category, merchant identity, foreign flag or
  // review status - those are card-only concepts (confirmed: 0 bank rows
  // have a Category). So a category/merchant/reviewOnly/foreignOnly drill
  // can never narrow bank rows the way it narrows card rows - previously
  // this meant every bank transaction sailed through UNFILTERED underneath
  // a category drill, looking exactly like broken filtering rather than
  // "this facet doesn't apply here". This now hides bank rows entirely
  // while any of those four facets is active; the caller (right-now-
  // render.js) shows a plain explanation, never a silent empty list.
  function bankRowsInapplicable() {
    return bankRowsInapplicablePure(state);
  }
  function visibleBankRows(recs) {
    if (bankRowsInapplicable()) return [];
    const f = state.bankFilter;
    let rows = recs;
    if (f.hideInternal) rows = rows.filter((r) => !r.internalTransfer);
    if (f.payeeKey) rows = rows.filter((r) => r.counterpartyKey === f.payeeKey);
    if (f.kind && f.kind !== 'all') rows = rows.filter((r) => r.kind === f.kind);
    if (f.search) {
      const q = f.search.toLowerCase();
      rows = rows.filter(
        (r) =>
          (r.counterpartyLabel || '').toLowerCase().includes(q) ||
          (r.description || '').toLowerCase().includes(q) ||
          String(r.amount).includes(q) ||
          (r.date || '').includes(q)
      );
    }
    return rows;
  }

  // The mirror: a bank-only payee drill has no card-side equivalent (cards
  // have no "payee" concept the way a bank counterparty does), so card rows
  // are hidden while a payee drill is active - same principle, opposite
  // direction, so the two ledgers can never mislead each other.
  function cardRowsInapplicable() {
    return cardRowsInapplicablePure(state);
  }

  // DO NOT call this directly with { expand: true, scroll: true } from a
  // render file - that exact pattern is shared-helpers.js's
  // drillToTransactions now, the ONE place every card-only drill goes
  // through (so a stale bank-side facet can never silently combine with a
  // fresh card filter). This raw function stays here only as
  // drillToTransactions's own low-level implementation detail and for
  // additive-only calls (Month, Min/Max) that deliberately skip the reset.
  function applyFilter(patch = {}, opts = {}) {
    if (opts.expand) resetCardDrillFacets();
    Object.assign(state.filter, patch);
    if (opts.expand) state.showAllTx = false;
    render();
    if (opts.scroll) smoothScrollToEl('#acct-tx');
  }

  // THE one shared "drill to a card-side filter on the merged transaction
  // ledger" helper - every card-only drill (category, merchant, review-
  // only, foreign-only) in this app now goes through here, whether it is
  // launched FROM Right Now itself (cards-render.js's category/merchant/
  // foreign panels, right-now-render.js's own "Worth a look" Refine actions
  // and "Where money went" rows) or from a DIFFERENT tab entirely
  // (Activity's treemap and ranked list). Previously this exact "set the
  // view, reset the OTHER ledger's drill facets, apply this ledger's
  // patch, scroll" sequence was hand-written independently at five separate
  // call sites across three files - three of which (all the ones already
  // living on Right Now) never called resetBankDrillFacets at all, so a
  // stale bank-side facet (a payeeKey left over from an earlier drill)
  // could silently combine with a fresh card-only filter launched from
  // right there on the SAME tab. This is the exact class of "declared once,
  // drifted into N copies" bug CARD_FACETS/BANK_FACETS and requireCtx
  // already exist to prevent elsewhere in this app; this closes it here too.
  //
  // A no-op view-switch when already on Right Now (state.view check mirrors
  // switchLedgerView's own early-return), so a drill launched FROM Right
  // Now costs exactly the one render applyFilter already performs - never
  // a second, wasted render the way routing through switchLedgerView would.
  const drillToTransactions = (patch, opts) =>
    drillToTransactionsPure({ state, trackUsage, resetBankDrillFacets, applyFilter }, patch, opts);

  /* ===================================================================
   * RENDER
   * =================================================================== */
  function availableViews() {
    const v = [];
    // Overview's content (Available now, Cash in and out, Needs attention) is
    // entirely bank-derived - a lead figure keyed on income timing and a cash
    // movement chart, neither of which has a card-native equivalent to fall
    // back on. It therefore stays gated on bank data alone, not on BOTH
    // ledgers - the previous requirement of card data too was an unintended
    // asymmetry with every other view here, all of which gate on a single
    // ledger's presence, and it wrongly hid Overview from a bank-only person
    // with no card at all.
    if (state.bankRecords.length) v.push('overview');

    // Activity's committed-vs-flexible card does lean on bank-derived income,
    // but every other card on this tab (Where it went, How your card is
    // doing, Spending over time, Spent abroad, category ceilings, tags, the
    // Transactions ledger itself) is fully card-native and already degrades
    // cleanly with no bank data at all. Gating the WHOLE tab on bank data
    // previously hid all of that genuine, working value from a card-only
    // person for the sake of one card that already knows how to render
    // nothing when income can't be computed. Follows Position's own
    // either-ledger gate instead.
    if (state.bankRecords.length || (state._cardStatements || []).length) v.push('activity');

    // Position (third destination): appears whenever there is anything to
    // stand on - bank data (cash/debt/net worth) or a card balance. Ordered
    // BEFORE Ahead so the tab sequence runs Overview -> Activity -> Position
    // -> Forecast, moving from the most certain, present-tense surfaces to
    // the least certain, forward-looking one: Overview is "right now",
    // Activity is "what happened", Position is "where I stand" (established
    // fact), and the forecast is the synthesis built on top of all three, so
    // it belongs last. availableViews() is the single source of view
    // sequence: reordering these two push blocks propagates to the desktop
    // tablist, the mobile bottom nav (the same #ledger-switch element) and
    // the roving-tabindex arrow/Home/End order, since renderLedgerSwitch and
    // its keyboard handler both derive purely from this array. Every view
    // dispatch, drill, LABELS entry and mountView cache key is id-based, not
    // position-based, so none of them are affected.
    if (state.bankRecords.length || (state._cardStatements || []).length) {
      v.push('position');
    }

    // Ahead (fourth destination): its chart and accuracy card genuinely need
    // a bank-derived cash position and correctly show their own honest "add a
    // bank statement" state without one (ahead-render.js's renderNoBalance).
    // But the statement-cadence nudge, the goal card (including the clear-card
    // goal type, which reads card statements only) and the monthly follow-up
    // are all already built to work from card data alone - see
    // goal-progress-ctx.js's own per-goal-type data dependencies. Gating the
    // entire tab on bank data hid all of that from a card-only person for the
    // sake of the one sub-feature that already has its own honest fallback.
    // Follows the same either-ledger gate as Activity and Position.
    if (state.bankRecords.length || (state._cardStatements || []).length) v.push('ahead');

    return v;
  }

  function defaultDataView() {
    return availableViews()[0] || 'overview';
  }

  let _covKey = null;
  let _viewCache = {},
    _epochSnap = null;
  const _viewScroll = {};

  function render() {
    const app = $('#app');
    app.innerHTML = '';
    const hasCard = state.records.length > 0;
    const hasBank = state.bankRecords.length > 0;
    const views = availableViews();
    if (views.length && !views.includes(state.view)) state.view = views[0];
    if (state.records.length) {
      recompute();
      buildCategoryColours();
    }
    if (
      !_covKey ||
      _covKey.cs !== state._cardStatements ||
      _covKey.bs !== state._bankStatements ||
      _covKey.rows !== state.rows ||
      _covKey.bank !== state.bankRecords
    ) {
      const cardMonthsSet = new Set(
        state.rows.map((r) => r.month).filter((m) => m && m !== 'unknown')
      );
      const bankMonthsSet = new Set(
        (state.bankRecords || []).map((r) => String(r.date || '').slice(0, 7)).filter(Boolean)
      );
      state.coverage = buildStatementCoverage(
        state._cardStatements,
        state._bankStatements,
        cardMonthsSet,
        bankMonthsSet
      );
      _covKey = {
        cs: state._cardStatements,
        bs: state._bankStatements,
        rows: state.rows,
        bank: state.bankRecords,
      };
    }
    // Round 4 (Where you're headed): checked on every render, but the
    // function itself is a cheap no-op unless a genuinely new complete month
    // has actually arrived since the last check - see checkMonthlyGoalIfDue.
    if (hasCard || hasBank) checkMonthlyGoalIfDue();

    renderPeriodBar();
    renderLedgerSwitch(views);
    if (!hasCard && !hasBank) {
      _viewCache = {};
      app.append(renderEmpty());
      updateFooter();
      return;
    }
    const epoch = [
      state.rows,
      classifiedBank(),
      state.coverage,
      resolved(),
      state._cardStatements,
      state._bankStatements,
      state.catColour,
      state.warnings,
      state.cardAccounts,
      state.categoryIntentions,
      state.tags,
      state.transactionSplits,
      state.manualAssets,
    ];
    if (
      !_epochSnap ||
      _epochSnap.length !== epoch.length ||
      epoch.some((v, i) => v !== _epochSnap[i])
    ) {
      _viewCache = {};
      _epochSnap = epoch;
    }
    if (state.view === 'overview') {
      mountView(app, 'overview', '', () => {
        const w = renderOverview();
        w.append(renderManageData());
        return [w];
      });
      updateFooter();
      return;
    }

    if (state.view === 'activity') {
      const p = resolved();
      const sig =
        (p
          ? [state.period.type, p.from || '', p.to || '', p.prevFrom || '', p.prevTo || ''].join(
              '|'
            )
          : state.period.type) +
        '|' +
        activityTabSignature();

      mountView(app, 'activity', sig, () => {
        const w = renderActivity();
        w.append(renderManageData());
        return [w];
      });

      updateFooter();
      return;
    }

    if (state.view === 'ahead') {
      // Date-sensitive: the forecast is anchored to today regardless of the
      // shared period selector, so the cache signature includes today's date
      // (the epoch check above already invalidates on any data change).
      // ALSO includes ahead-render.js's own session-only draft-form state
      // (which goal type or safety-boundary kind is being edited) - without
      // this, clicking "Change goal"/"Change safe line" mutates that state
      // and calls render(), but mountView's cache still matches on the same
      // calendar day and silently returns the STALE pre-click DOM, so the
      // draft form never actually appears. A real, pre-existing bug this
      // session's testing surfaced, not something newly introduced.
      const sig = new Date().toISOString().slice(0, 10) + '|' + draftSignature();
      mountView(app, 'ahead', sig, () => {
        const w = renderAhead();
        w.append(renderManageData());
        return [w];
      });
      updateFooter();
      return;
    }

    if (state.view === 'position') {
      // Anchored to today (reconciled balances), independent of the period
      // selector, so its cache signature is the date + the data epoch (handled
      // by the epoch check above).
      const sig = new Date().toISOString().slice(0, 10);
      mountView(app, 'position', sig, () => {
        const w = renderPosition();
        w.append(renderManageData());
        return [w];
      });
      updateFooter();
      return;
    }

    // Fallthrough safety: state.view should always match one of the four
    // destinations above (the views.includes guard at the top of render()
    // resets an unknown view to the first available one). If it somehow does
    // not, fall back to Overview rather than rendering nothing.
    mountView(app, 'overview', '', () => {
      const w = renderOverview();
      w.append(renderManageData());
      return [w];
    });
    updateFooter();
  }

  function mountView(app, name, sig, build) {
    const cache = _viewCache[name];
    if (cache && cache.sig === sig) {
      for (const n of cache.nodes) app.append(n);
      return;
    }
    const nodes = build();
    _viewCache[name] = { sig, nodes };
    for (const n of nodes) app.append(n);
  }

  /* ---- the one place a ledger view change happens ---- */
  function switchLedgerView(id, opts = {}) {
    const anchorId = opts.anchorId || null;
    if (state.view === id) {
      // Already on this tab - still honour a specific-card request (a link
      // meant to jump to one card while already sitting on its tab) rather
      // than silently no-op'ing just because the TAB itself did not need to
      // change.
      if (anchorId) smoothScrollToEl(anchorId);
      return;
    }
    _viewScroll[state.view] = window.scrollY;
    clearBankFilters();
    state.bankShowAllTx = false;
    state.view = id;
    trackUsage('view-' + id);
    render();
    if (anchorId) smoothScrollToEl(anchorId);
    else window.scrollTo({ top: _viewScroll[id] || 0, left: 0, behavior: 'auto' });
  }

  function drillToAccountsPayee(key, label) {
    resetBankDrillFacets();
    state.bankFilter.payeeKey = key;
    state.bankFilter.payeeLabel = label;
    state.bankShowAllTx = true;
    if (state.view !== 'activity') {
      trackUsage('view-activity');
      state.view = 'activity';
    }
    state.activityTab = 'transactions';
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
  function drillToBankKind(kind) {
    resetBankDrillFacets();
    state.bankFilter.kind = kind;
    state.bankShowAllTx = true;
    render();
    smoothScrollToEl('#acct-tx');
  }
  /* ---- ledger switch (Cards / Accounts) ---- */
  function renderLedgerSwitch(views) {
    let host = $('#ledger-switch');
    if (!host) {
      host = el('div', {
        id: 'ledger-switch',
        class: 'ledger-switch',
        hidden: '',
      });
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
      if (appEl) {
        appEl.removeAttribute('role');
        appEl.removeAttribute('aria-labelledby');
      }
      return;
    }
    host.hidden = false;
    document.body.classList.add('has-bottom-nav');

    // Build the tablist from ONLY the views present, in the fixed display order
    // and with the fixed labels. state.view is always one of these (render()
    // guarantees it before calling here).
    const LABELS = {
      overview: 'Overview',
      activity: 'Activity',

      ahead: 'Forecast',
      position: 'Position',
    };
    const TABS = views.map((id) => [id, LABELS[id]]);
    const ids = TABS.map(([id]) => id);
    const tabDomId = (id) => 'ledger-tab-' + id;
    const switchTo = (id) => switchLedgerView(id);
    const focusTab = (id) => {
      const b = $('#' + tabDomId(id));
      if (b) b.focus();
    };
    const activateIndex = (idx) => {
      const id = ids[(idx + ids.length) % ids.length];
      switchTo(id);
      focusTab(id);
    };

    const tab = (id, label, index) =>
      el(
        'button',
        {
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
              case 'ArrowRight':
              case 'ArrowDown':
                e.preventDefault();
                activateIndex(index + 1);
                break;
              case 'ArrowLeft':
              case 'ArrowUp':
                e.preventDefault();
                activateIndex(index - 1);
                break;
              case 'Home':
                e.preventDefault();
                activateIndex(0);
                break;
              case 'End':
                e.preventDefault();
                activateIndex(ids.length - 1);
                break;
              default:
                break;
            }
          },
        },
        label
      );

    // Link the panel (#app) back to its active tab so a screen reader announces
    // "tab, N of 3, selected" and names the panel by the tab controlling it.
    if (appEl) {
      appEl.setAttribute('role', 'tabpanel');
      appEl.setAttribute('aria-labelledby', tabDomId(state.view));
    }

    host.append(
      el(
        'div',
        { class: 'ledger-tabs', role: 'tablist', 'aria-label': 'Ledger views' },
        ...TABS.map(([id, label], i) => tab(id, label, i))
      )
    );
  }

  let _ovKey = null,
    _ovVal = null;
  function overviewModel() {
    const p = resolved();
    const cb = classifiedBank();
    const ca = state.records.length ? analysis() : null;
    const cs = state._cardStatements;
    const asum = state.allSummary;
    if (
      _ovVal &&
      _ovKey &&
      _ovKey.p === p &&
      _ovKey.cb === cb &&
      _ovKey.ca === ca &&
      _ovKey.cs === cs &&
      _ovKey.asum === asum
    ) {
      return _ovVal;
    }
    const recs = bankRecordsInPeriod(cb);
    let cardSummary = null,
      cardSpendTotal = 0,
      cardSpendByMonth = {};
    if (ca) {
      cardSummary = {
        total_spend: ca.total_spend,
        n_transactions: ca.n_transactions,
      };
      cardSpendTotal = ca.total_spend;
      cardSpendByMonth = Object.assign({}, ca.by_month);
    }
    const ov = analyseCombinedOverview({
      bankRecords: recs,
      cardStatements: cs || [],
      cardSummary,
    });
    const roll = analyseRollup({
      bankRecords: recs,
      cardSpendTotal,
      cardSpendByMonth,
      cardStatements: cs || [],
    });
    const rollAllTrend = analyseRollup({
      bankRecords: cb,
      cardSpendTotal: 0,
      cardSpendByMonth: asum ? asum.by_month : {},
      cardStatements: [],
    }).trend;
    let prevIncome = null;
    if (p && p.prevFrom && p.prevTo) {
      const prevRecs = bankRecordsInRange(cb, p.prevFrom, p.prevTo);
      prevIncome = analyseRollup({
        bankRecords: prevRecs,
        cardSpendTotal: 0,
        cardSpendByMonth: {},
        cardStatements: [],
      }).income;
    }
    _ovVal = {
      recs,
      cardSummary,
      cardSpendTotal,
      cardSpendByMonth,
      ov,
      roll,
      rollAllTrend,
      prevIncome,
    };
    _ovKey = { p, cb, ca, cs, asum };
    return _ovVal;
  }

  let _cmKey = null,
    _cmVal = null;
  function commitmentsModel() {
    const cb = classifiedBank();
    if (
      _cmVal &&
      _cmKey &&
      _cmKey.rows === state.rows &&
      _cmKey.br === state.brandRules &&
      _cmKey.me === state.merchants &&
      _cmKey.cb === cb
    ) {
      return _cmVal;
    }
    const rec = detectRecurring(state.rows, 3, 0.15, state.brandRules, state.merchants);
    const bankDebits = detectBankStandingDebits(cb);
    _cmVal = {
      rec,
      bankDebits,
      combined: monthlyCommitmentsTotal(rec, bankDebits),
    };
    _cmKey = {
      rows: state.rows,
      br: state.brandRules,
      me: state.merchants,
      cb,
    };
    return _cmVal;
  }

  /* ===================================================================
   * Round 4 (Where you're headed): goal-setting, its monthly honest
   * follow-up, and the small persisted log that follow-up writes to.
   * computeGoalProgress/describeGoal (reporting.js) do the actual judging;
   * everything here is orchestration - building the right data bundle for
   * whichever goal type is active, persisting the goal itself, and
   * recording one frozen entry per genuinely new complete month.
   * =================================================================== */
  async function setGoal(type, params) {
    state.goal = {
      type,
      params,
      createdAt: new Date().toISOString().slice(0, 10),
    };
    await Store.setMeta('financeGoal', state.goal);
    render();
  }
  async function clearGoal() {
    // The goal itself is cleared; goalLog (the historical record of past
    // months' honest checks) is deliberately left intact, exactly like
    // closing a chapter without erasing what already happened in it.
    state.goal = null;
    await Store.setMeta('financeGoal', null);
    render();
  }
  // Restore a previously-cleared goal EXACTLY as it was - crucially keeping
  // its ORIGINAL createdAt, not today's date. setGoal() always stamps a fresh
  // createdAt (correct when genuinely setting a new goal), but an undo must
  // preserve the original, or the monthly-check gate (checkMonthlyGoalIfDue's
  // `month < createdMonth` test) would silently shift and a month already
  // logged under the old goal could be re-evaluated. So this restores the
  // whole stored object directly rather than routing through setGoal.
  async function restoreGoal(goalObject) {
    if (!goalObject) return;
    state.goal = goalObject;
    await Store.setMeta('financeGoal', goalObject);
    render();
  }

  // The data bundle computeGoalProgress needs for a specific goal type.
  // 'runway' and 'clear-card' both read LIVE current figures - genuinely "how
  // are things right now" readings, since reconstructing either honestly for
  // an arbitrary past month would need a fragile historical balance
  // rebuild this app does not attempt. 'spend-ceiling' instead reads the
  // ACTUAL completed month's real total spend for the given month - the one
  // goal type with a genuinely knowable historical fact, so it uses it.
  // Step 3 (goal-system migration): the new engine's equivalent of
  // goalDataForMonth, above - builds the exact progressCtx shape goals.js's
  // goalProgress expects. Proven byte-identical to the inline block it
  // replaces (previously duplicated inside ahead-render.js's live
  // comparison card) via parity_proof_ctx.mjs, on identical mock inputs,
  // including proof that the `month` parameter genuinely changes the
  // spend-ceiling reading rather than being ignored.
  //
  // Unlike the OLD inline block (which self-computed "latest month with
  // ANY data" for spend-ceiling), this takes month as an EXPLICIT required
  // parameter for spend-ceiling - the caller supplies it, matching
  // goalDataForMonth's own existing contract exactly. This is a deliberate
  // fix, not a preserved quirk: both callers below now pass the SAME
  // "latest COMPLETE month" concept the rest of the app already uses
  // (resolvePeriod({type:'latest-complete'})), closing the gap the
  // comparison card's own comment previously flagged as a known
  // simplification.
  //
  // cushion/clear-card remain LIVE-ONLY (month is accepted but ignored for
  // them), matching goalDataForMonth's own accepted design: reconstructing
  // an honest historical cash position or card balance for an arbitrary
  // past month is not attempted anywhere in this app.
  // Extracted to goal-progress-ctx.js (application/analysis/) so it is a
  // real, importable, top-level function - useful for goal_engine_parity_
  // proof.mjs to import directly, and matching the pattern already
  // established by goal-migrate.js/goals.js of small, pure, standalone
  // analysis files. This wrapper just supplies this closure's own live
  // bindings as explicit deps; the actual logic (and its own detailed
  // comment on the month-parameter design) now lives in that file.
  function buildNewEngineProgressCtx(migratedGoal, opts = {}) {
    return buildNewEngineProgressCtxPure(migratedGoal, opts, {
      classifiedBank,
      overviewModel,
      typicalMonthlyOutflow,
      ymToday,
      analyseBankActivity,
      bankFlowOverTime,
      state,
    });
  }

  // The single place "which month counts as latest-complete for goal
  // purposes" is resolved, shared by the live comparison card (Ahead) and
  // the monthly log below, so the two can never silently disagree on what
  // "this period" means for a spend-ceiling goal.
  function latestCompleteGoalMonth() {
    const months = allLedgerMonths();
    if (!months.length) return null;
    const period = resolvePeriod(
      { type: 'latest-complete' },
      state.rows,
      months,
      new Date(),
      state.coverage
    );
    return period ? period.from : null;
  }

  // The new engine's goalProgress returns a strict boolean `met` for
  // clear-card (balance <= 1) - correct for the live card, where
  // buildGoalModel already softens an in-progress goal with
  // tone:'neutral'/tag:'on a plan' rather than a warning. The monthly log
  // below has no such softening layer - it maps met straight to a dot
  // colour - so a strict boolean would show every unfinished clear-card
  // goal as a monthly WARNING until the day it's paid off, even while
  // genuinely on track. parity_proof.mjs proved this exact divergence
  // empirically (old.met=null, new.met=false for the identical
  // "in-progress, on-track" case). This restores the three real states
  // the old engine's computeGoalProgress always distinguished, using the
  // SAME `now` the caller already resolved its period with - never a
  // second, independent new Date() call, so a log entry judges the
  // deadline against one single clock, not two.
  function threeStateMetForLog(migratedGoal, progress, now) {
    if (migratedGoal.type !== 'clear-card') return progress.met;
    if (progress.current <= 1) return true;
    const targetMs = Date.parse(migratedGoal.targetDate);
    if (Number.isFinite(targetMs) && now.getTime() > targetMs) return false;
    return null; // still trying, deadline not yet passed
  }

  function goalDataForMonth(goal, month) {
    if (!goal) return null;
    if (goal.type === 'runway' || goal.type === 'cushion') {
      const cb = classifiedBank();
      const cashPosition = analyseBankActivity(cb).closingBalance;
      const asum = state.allSummary;
      const rollAllTrend = analyseRollup({
        bankRecords: cb,
        cardSpendTotal: 0,
        cardSpendByMonth: asum ? asum.by_month : {},
        cardStatements: [],
      }).trend;
      const monthlyOutflow = typicalMonthlyOutflow(rollAllTrend, ymToday());
      return { runwayDays: runwayDays(cashPosition, monthlyOutflow) };
    }
    if (goal.type === 'clear-card') {
      const roll = overviewModel().roll;
      const latestStmt = (state._cardStatements || [])
        .slice()
        .sort((a, b) => String(a.statementKey).localeCompare(String(b.statementKey)))
        .pop();
      const eairFrac = latestStmt ? normaliseEair(latestStmt.eair) : null;
      const typicalPayment = medianRecentPayment(state._cardStatements || []);
      return {
        cardOwed: roll.cardOwed,
        eairFrac,
        typicalPayment,
        now: new Date(),
      };
    }
    if (goal.type === 'spend-ceiling') {
      if (!month) return null;
      const cardSpendForMonth =
        state.allSummary && state.allSummary.by_month ? state.allSummary.by_month[month] || 0 : 0;
      const bankTrend = bankFlowOverTime(classifiedBank());
      const bankRow = bankTrend.find((t) => t.month === month);
      const bankSpendForMonth = bankRow ? bankRow.moneyOut : 0;
      return {
        monthSpend: roundMoney(cardSpendForMonth + bankSpendForMonth),
        monthLabel: monthName(month),
      };
    }
    return null;
  }

  // The monthly, honest follow-up (plan section 6.2, third bullet): fires
  // once per genuinely NEW complete month, appending a FROZEN record to
  // state.goalLog so a past month's verdict can never quietly change later
  // just because the goal was since altered. A month is checked at most
  // once (the log is searched for an existing entry first), and never a
  // month before the goal existed, so setting or changing a goal can never
  // retroactively grade history that predates it.
  function checkMonthlyGoalIfDue() {
    if (!state.goal) return;
    const months = allLedgerMonths();
    if (!months.length) return;
    // ONE Date instance for this whole check - reused below for the
    // three-state clear-card derivation, never a second independent
    // new Date() call, so "has the deadline passed" is judged against the
    // same clock the period itself was resolved against.
    const now = new Date();
    const period = resolvePeriod(
      { type: 'latest-complete' },
      state.rows,
      months,
      now,
      state.coverage
    );
    if (!period) return;
    const month = period.from;
    if (state.goalLog.some((g) => g.month === month)) return;
    const createdMonth = monthKey(state.goal.createdAt);
    if (month < createdMonth) return;

    // Step 3: repointed at the new engine. ensureMigrated() runs on a local
    // copy - never mutates the stored state.goal - matching the same
    // non-destructive discipline goal-migrate.js's own contract already
    // established. state.goal itself is left exactly as-is; only what
    // feeds this ONE log entry now comes from the proven engine.
    const migrated = ensureMigrated(state.goal);
    if (!migrated) return;
    const progressCtx = buildNewEngineProgressCtx(migrated, { month });
    if (!progressCtx) return;
    const evaluated = evaluateGoal(migrated, progressCtx, state.cfg);
    if (!evaluated) return;

    const met = threeStateMetForLog(migrated, evaluated.progress, now);
    const headline = evaluated.model.detail;

    // Flat fields from the MIGRATED shape (targetDays/targetDate/amount),
    // never a stale .params blob - a goal set under the old shape is
    // migrated above before being evaluated, so every future log entry
    // stores the same field names the new engine (and the live card)
    // already read, closing the shape gap the old log entry (type +
    // params) would otherwise have carried forward indefinitely.
    state.goalLog = [
      ...state.goalLog,
      {
        month,
        type: migrated.type,
        targetDays: migrated.targetDays ?? null,
        targetDate: migrated.targetDate ?? null,
        amount: migrated.amount ?? null,
        met,
        headline,
      },
    ].slice(-24);
    Store.setMeta('financeGoalLog', state.goalLog);
  }

  // Round 4: Overview's beat 11 needs a LIVE "how is this going right now"
  // reading, separate from checkMonthlyGoalIfDue's once-a-month FROZEN log
  // entry above - reuses the exact same goalDataForMonth/computeGoalProgress
  // pair rather than a second, possibly drifting reading. For 'spend-ceiling'
  // (the one type that needs a specific month), this reads the latest
  // complete month, matching how the rest of the app already frames "the
  // month we can currently trust" (detectIncompleteMonth/latestCompleteMonth).
  function liveGoalProgress() {
    if (!state.goal) return null;
    const months = allLedgerMonths();
    const period = months.length
      ? resolvePeriod({ type: 'latest-complete' }, state.rows, months, new Date(), state.coverage)
      : null;
    const data = goalDataForMonth(state.goal, period ? period.from : null);
    if (!data) return null;
    return computeGoalProgress(state.goal, data, bankMoney, formatDisplayDate);
  }

  // The honest check on whether LAST month's intention actually happened
  /* ---- empty state ---- */
  function renderEmpty() {
    const wrap = el('section', { class: 'card empty' });
    const lines = el('div', { class: 'empty-lines' });
    lines.append(
      el(
        'p',
        { class: 'muted' },
        'Add a Scotia PDF statement and your spending appears straight away.'
      )
    );
    lines.append(
      el('p', { class: 'muted' }, 'Everything is read on this device. Nothing leaves it.')
    );
    if (isIOS() && !isStandalone() && !window.ccDesktop) {
      lines.append(
        el(
          'p',
          { class: 'muted' },
          'On iPhone, add this to your Home Screen so your history is not cleared after a week.'
        )
      );
    }
    wrap.append(
      el('div', { class: 'empty-icon', html: emojiCard() }),
      el('h2', {}, 'Nothing here yet'),
      lines,
      el('button', { class: 'btn primary lg', onclick: pickStatements }, 'Add statement')
    );
    // Format support is a caveat on the button above it, not a headline
    // sentence, so it sits here as fine print alongside the drop-hint rather
    // than stacked mid-page between the pitch and the privacy line.
    wrap.append(
      el('p', { class: 'muted small empty-drop-hint' }, 'or drop PDFs anywhere on this window')
    );
    if (!isIOS() && !isStandalone()) {
      wrap.append(
        el(
          'p',
          { class: 'muted small empty-drop-hint' },
          'Also supports NCB credit-card statements. Bank statements are Scotia-only for now.'
        )
      );
    }
    if (window.ccDesktop)
      wrap.append(
        el(
          'button',
          { class: 'linkbtn', onclick: chooseFolder },
          'Or watch a statements folder for new PDFs'
        )
      );
    return wrap;
  }
  const emojiCard = () =>
    '<svg viewBox="0 0 24 24" width="40" height="40" fill="none" stroke="currentColor" stroke-width="1.6"><rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="M2.5 9.5h19"/></svg>';

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
    lines.append(
      el('p', { class: 'muted' }, `The period is set to ${label}, which holds no ${noun}.`)
    );
    const ms = (monthsWithData || []).filter(Boolean).slice().sort();
    if (ms.length) {
      const span =
        ms.length === 1
          ? monthLabel(ms[0])
          : `${monthLabel(ms[0])} to ${monthLabel(ms[ms.length - 1])}`;
      lines.append(
        el(
          'p',
          { class: 'muted' },
          `Your ${noun} run from ${span}. Widen the period or pick another range to see them.`
        )
      );
    } else {
      lines.append(el('p', { class: 'muted' }, `There are no ${noun} on record yet.`));
    }
    sec.append(
      el('div', { class: 'empty-icon', html: emojiCard() }),
      el('h2', {}, `No ${noun} in ${label}`),
      lines
    );
    if (ms.length) {
      sec.append(
        el(
          'button',
          {
            class: 'btn primary',
            onclick: () => {
              state.period = { type: 'all' };
              clearFilters();
              clearBankFilters();
              state.showAllTx = false;
              state.bankShowAllTx = false;
              render();
            },
          },
          'Show all time'
        )
      );
    }
    return sec;
  }

  /* ---- period bar ---- */
  function renderPeriodBar() {
    const bar = $('#period-bar');
    if (!bar) return;
    bar.innerHTML = '';
    const months = allLedgerMonths();
    if (!months.length) return; // nothing imported in either ledger yet
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
    const sel = el('select', {
      class: 'period-select',
      name: 'reporting-period',
      'aria-label': 'Reporting period',
      onchange: (e) => {
        const v = e.target.value;
        if (v === 'custom') {
          state.period = {
            type: 'custom',
            from: months[Math.max(0, months.length - 3)],
            to: months[months.length - 1],
          };
        } else state.period = { type: v };
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
        clearFilters();
        clearBankFilters();
        state.showAllTx = false;
        state.bankShowAllTx = false;
        render();
      },
    });
    for (const [v, label] of opts)
      sel.append(el('option', { value: v, selected: state.period.type === v ? '' : null }, label));

    const left = el(
      'div',
      { class: 'period-left' },
      el('span', { class: 'period-icon', html: iconCal() }),
      sel
    );
    bar.append(left);

    if (state.period.type === 'custom') {
      const from = el('select', {
        class: 'mini',
        name: 'period-from',
        'aria-label': 'Custom range start month',
        onchange: (e) => {
          state.period.from = e.target.value;
          if (state.period.from > state.period.to) state.period.to = state.period.from;
          render();
        },
      });
      const to = el('select', {
        class: 'mini',
        name: 'period-to',
        'aria-label': 'Custom range end month',
        onchange: (e) => {
          state.period.to = e.target.value;
          if (state.period.to < state.period.from) state.period.from = state.period.to;
          render();
        },
      });
      for (const m of months) {
        from.append(
          el('option', { value: m, selected: state.period.from === m ? '' : null }, monthLabel(m))
        );
        to.append(
          el('option', { value: m, selected: state.period.to === m ? '' : null }, monthLabel(m))
        );
      }
      bar.append(
        el('div', { class: 'period-range' }, from, el('span', { class: 'muted' }, 'to'), to)
      );
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
    if (p)
      bar.append(
        el(
          'div',
          { class: 'period-showing muted small', style: 'margin-left:auto' },
          `Showing ${p.label}`
        )
      );
  }

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
    return el(
      'div',
      { class: 'sec-manage-wrap' },
      el(
        'div',
        { class: 'sec-section sec-manage' },
        el('div', { class: 'sec-subhead' }, icon(iconInfo()), ' Manage data'),
        el(
          'p',
          { class: 'muted small' },
          'Everything lives only on this device - transactions, category corrections, personal rules and dismissed flags. Export rules or Export history first if you want to keep them.'
        ),
        el(
          'p',
          { class: 'muted small' },
          'Usage counts (which screens and actions get opened) are kept privately on this device to help decide what to improve, and nothing about them ever leaves it.'
        ),
        el(
          'div',
          { class: 'manage-actions' },
          el('button', { class: 'btn sm ghost', onclick: reloadConfig }, 'Reload configuration'),
          el(
            'button',
            { class: 'btn sm ghost', onclick: openRemoveStatement },
            'Remove a statement'
          ),
          el(
            'button',
            { class: 'btn sm danger', onclick: confirmClearAll },
            'Clear all data and start over'
          )
        )
      ),
      el(
        'div',
        { class: 'sec-section sec-contribute' },
        el('div', { class: 'sec-subhead' }, icon(iconInfo()), ' Help us recognise more merchants'),
        el(
          'p',
          { class: 'muted small' },
          'Send us the places we could not identify, so we can add them to a future update. Only the statement text and how often it appeared are included - nothing else.'
        ),
        el(
          'div',
          { class: 'manage-actions' },
          el(
            'button',
            { class: 'btn sm ghost', onclick: exportUnknownMerchants },
            'Share unrecognised places'
          )
        )
      ),
      customCategoriesSection(),
      nameSection()
    );
  }

  // The one place a person can see and correct the name the app greets them by.
  // The name is normally read from a statement, but a name set by inference must
  // always be correctable by hand, and NCB card statements supply no name at all,
  // so this field is the single, low-friction way to see, change or clear it. A
  // manual entry outranks any statement, so a later import never overwrites it.
  function nameSection() {
    const nameInput = el('input', {
      type: 'text',
      class: 'name-field',
      maxlength: '40',
      value: state.firstName || '',
      placeholder: 'Not set',
      'aria-label': 'Your first name',
    });
    const saveName = async () => {
      const v = nameInput.value.trim();
      await setFirstNameManual(v);
      render();
      toast(v ? `We\u2019ll greet you as ${v}.` : 'Name cleared. Greetings will drop the name.');
    };
    nameInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        saveName();
      }
    });
    return el(
      'div',
      { class: 'sec-section sec-name' },
      el('div', { class: 'sec-subhead' }, icon(iconInfo()), ' Your name'),
      el(
        'p',
        { class: 'muted small' },
        'Shown only to greet you when you open the app. It never leaves this device. Leave it blank to be greeted without a name.'
      ),
      el(
        'div',
        { class: 'manage-actions' },
        nameInput,
        el('button', { class: 'btn sm', onclick: saveName }, 'Save name')
      )
    );
  }
  /* ===========================================================================
   * B4 (custom categories): create/manage person-authored categories from
   * the same "Data & settings" surface every other low-frequency admin
   * action already lives on (Reload configuration, Remove a statement).
   * Assignment itself needs no new UI - a custom category already appears
   * in openCategoryPicker's list the instant it's added, since that picker
   * reads state.cfg.categories directly and this section keeps that ONE
   * array current. Delete is blocked (not just discouraged) when the
   * category is in use, via canDeleteCategory's honest usage count -
   * never a silent data-orphaning deletion.
   *
   * CACHING NOTE: buildCategoryColours/recompute both cache on
   * (something)Key.cfg === state.cfg. Mutating state.cfg.categories IN
   * PLACE (rather than replacing state.cfg itself) means state.cfg's own
   * reference never changes, so _colKey must be explicitly cleared here or
   * the colour map would silently keep showing stale colours (or none) for
   * a just-added category. state.compiled is reassigned to a genuinely NEW
   * array each time, which recompute()'s own cache check already catches
   * correctly with no extra help needed.
   * ======================================================================== */
  function customCategoriesSection() {
    const customs = (state.cfg.categories || []).filter((c) => c.custom);
    const list = el('div', {
      class: 'manage-actions',
      style: 'flex-direction:column;align-items:stretch;gap:6px',
    });
    for (const c of customs) {
      const check = canDeleteCategory(
        c.name,
        state.cfg.categories,
        state.rows,
        state.rules,
        state.transactionSplits
      );
      const btn = check.ok
        ? el(
            'button',
            {
              class: 'btn sm ghost',
              onclick: () => removeCustomCategory(c.name),
            },
            'Remove'
          )
        : el(
            'button',
            {
              class: 'btn sm ghost',
              disabled: '',
              title: `In use by ${check.usage.total} item${check.usage.total === 1 ? '' : 's'} - cannot remove`,
            },
            `In use (${check.usage.total})`
          );
      list.append(
        el(
          'div',
          { class: 'manage-actions', style: 'justify-content:space-between' },
          el('span', {}, c.name),
          btn
        )
      );
    }
    const nameInput = el('input', {
      type: 'text',
      class: 'name-field',
      placeholder: 'New category name',
      maxlength: '40',
    });
    const addBtn = el(
      'button',
      {
        class: 'btn sm',
        onclick: async () => {
          await addCustomCategory(nameInput.value.trim());
          nameInput.value = '';
        },
      },
      'Add category'
    );
    return el(
      'div',
      { class: 'sec-section sec-custom-categories' },
      el('div', { class: 'sec-subhead' }, icon(iconInfo()), ' Custom categories'),
      el(
        'p',
        { class: 'muted small' },
        'Categories you add here can be filed to any transaction from the category picker, alongside the built-in list.'
      ),
      customs.length ? list : null,
      el('div', { class: 'manage-actions' }, nameInput, addBtn)
    );
  }

  async function addCustomCategory(name) {
    if (!name) {
      toast('Enter a name first.');
      return;
    }
    if (categoryNameExists(name, state.cfg.categories)) {
      toast('That category already exists.');
      return;
    }
    const cat = makeCustomCategory({ name });
    state.customCategories = [...state.customCategories, cat];
    await Store.setMeta('customCategories', state.customCategories);
    state.cfg.categories = mergeCategories(
      state.cfg.categories.filter((c) => !c.custom),
      state.customCategories
    );
    state.compiled = compileRules(state.cfg.categories);
    _colKey = null;
    buildCategoryColours();
    trackUsage('manage-add-category');
    render();
    toast(`Category "${name}" added.`);
  }

  async function removeCustomCategory(name) {
    const check = canDeleteCategory(
      name,
      state.cfg.categories,
      state.rows,
      state.rules,
      state.transactionSplits
    );
    if (!check.ok) {
      toast('That category is in use and cannot be removed.');
      return;
    }
    state.customCategories = state.customCategories.filter(
      (c) => c.name.toLowerCase() !== name.toLowerCase()
    );
    await Store.setMeta('customCategories', state.customCategories);
    state.cfg.categories = mergeCategories(
      state.cfg.categories.filter((c) => !c.custom),
      state.customCategories
    );
    state.compiled = compileRules(state.cfg.categories);
    _colKey = null;
    buildCategoryColours();
    trackUsage('manage-remove-category');
    render();
    toast(`Category "${name}" removed.`);
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
    // Round 3: both ledgers' reconciliation trust lines now live together
    // here, since Right Now is the one place covering both ledgers at once
    // (Cards and Accounts, each of which used to host one line separately,
    // have both retired). Shown ONLY on Right Now so neither line clutters
    // the Overview hub or the Ahead forecast; each returns null when nothing
    // is stored for that ledger, so this stays inert for a single-ledger
    // device.
    if (state.view === 'activity') {
      const cardTrust = renderCardStatementTrust();
      if (cardTrust) details.append(cardTrust);
      const bankTrust = renderBankStatementTrust();
      if (bankTrust) details.append(bankTrust);
    }
    details.append(manageDataBody());
    return details;
  }

  function secItem(label, value) {
    return el(
      'div',
      { class: 'sec-item' },
      el('div', { class: 'sec-value' }, value),
      el('div', { class: 'sec-label muted small' }, label)
    );
  }
  function statusText() {
    if (
      state.lastImportedFrom &&
      state.lastImportedFrom.at &&
      state.lastImportedFrom.device === DEV_SIGNATURE
    ) {
      return `Last updated from ${state.lastImportedFrom.device} on ${new Date(state.lastImportedFrom.at).toLocaleDateString(state.cfg.currency.locale)}. This device keeps its own private history.`;
    }
    return 'This device keeps its own private history. Nothing leaves your device.';
  }

  function updateFooter() {
    const f = $('#footer');
    if (!f) return;
    f.textContent = statusText();
  }

  /* ---- tooltip ---- */
  let tipEl = null;
  function showTip(e, title, val) {
    if (!tipEl) {
      tipEl = el('div', { class: 'tip' });
      document.body.append(tipEl);
    }
    tipEl.innerHTML = `<b>${escapeHtml(title)}</b><span>${escapeHtml(val)}</span>`;
    tipEl.style.left = Math.min(e.clientX + 12, window.innerWidth - 180) + 'px';
    tipEl.style.top = e.clientY - 10 + 'px';
    tipEl.classList.add('show');
  }
  function hideTip() {
    if (tipEl) tipEl.classList.remove('show');
  }
  const escapeHtml = (s) =>
    String(s).replace(
      /[&<>"]/g,
      (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]
    );

  /* ===================================================================
   * Category correction (reversible)
   * =================================================================== */
  let pickerEl = null;
  function closePicker() {
    if (pickerEl) {
      pickerEl.remove();
      pickerEl = null;
    }
  }

  // Attach an overlay element as the active modal: put it on the page and record
  // it as the current picker so closePicker() can dismiss it. Extracted from the
  // inline picker pattern so code outside bootUI (accounts-render.js) can open a
  // modal without ever touching the private pickerEl variable directly.
  function openOverlay(overlay) {
    document.body.append(overlay);
    pickerEl = overlay;
  }
  // Read-only counterpart to openOverlay: hand the live overlay element to code
  // outside bootUI (category-picker.js) so it can inspect the current modal (for
  // example which scope radio is checked) without touching the private pickerEl.
  function getPickerEl() {
    return pickerEl;
  }

  // Shared modal-overlay constructor: wraps `box` in a .overlay that closes
  // the picker when the backdrop itself (not its contents) is clicked, then
  // opens it through the existing openOverlay/pickerEl mechanism. Previously
  // this exact three-line pattern was hand-written independently in
  // manage-data.js's openRemoveStatement and manage-data.js's confirmClearAll.
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
    const overlay = el(
      'div',
      {
        class: 'overlay',
        onclick: (e) => {
          if (e.target === overlay) closePicker();
        },
      },
      box
    );
    openOverlay(overlay);
  }

  /* ===================================================================
   * Intake (manual + desktop)
   * =================================================================== */
  async function pickStatements() {
    trackUsage('add-statement');
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

  async function learnFirstName(name, source) {
    if (!name) return;
    const rank = { manual: 2, card: 1, bank: 0 };
    if (state.firstName && (rank[source] || 0) <= (rank[state.firstNameSource] || 0)) return;
    state.firstName = name;
    state.firstNameSource = source;
    await Store.setMeta('firstName', name);
    await Store.setMeta('firstNameSource', source);
  }

  async function setFirstNameManual(name) {
    const clean = String(name == null ? '' : name)
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 40);
    state.firstName = clean || null;
    state.firstNameSource = clean ? 'manual' : null;
    await Store.setMeta('firstName', state.firstName);
    await Store.setMeta('firstNameSource', state.firstNameSource);
  }

  async function ingestFiles(files) {
    const list = [...files];
    if (await Store.getMeta('mockPersonaLoaded', null)) {
      await Store.clearTransactions();
      await Store.clearStatements();
      await Store.clearBankTransactions();
      await Store.clearBankStatements();
      await Store.clearCardStatements();
      await Store.setMeta('mockPersonaLoaded', null);
      await Store.setMeta('bankCardAccounts', []);
      await Store.setMeta('bankMyAccounts', []);
      await Store.setMeta('bankConfirmedIncomeIds', []);
      await Store.setMeta('bankRefundIncomeIds', []);
      await Store.setMeta('bankSharedAccounts', []);
      await Store.setMeta('bankHouseholdPayees', []);
      await Store.setMeta('lastImportedFrom', null);
      state.records = [];
      state.bankRecords = [];
      state._bankStatements = [];
      state._cardStatements = [];
      state.cardAccounts = [];
      state.myAccounts = [];
      state.confirmedIncomeIds = [];
      state.refundIncomeIds = [];
      state.sharedAccounts = [];
      state.householdPayees = [];
      state.bankAccount = 'all';
      state.lastImportedFrom = null;
      toast('Sample customer data cleared, so your imported statement is kept on its own.');
    }
    openProgress(list);
    let added = 0,
      dupes = 0,
      failed = 0;
    let bankAdded = 0,
      bankDupes = 0;
    let cardLearned = false,
      cardStmtLearned = false;
    const periods = [];
    const hadCardBefore = state.records.length > 0;
    const hadBankBefore = state.bankRecords.length > 0;
    state.warnings = [];
    state.bankWarnings = [];
    try {
      const pdfjs = await loadPdfjs();
      for (let i = 0; i < list.length; i++) {
        const file = list[i];
        setProgress(i, 'reading');
        await yieldToBrowser();
        let lines;
        try {
          const buf = await file.arrayBuffer();
          lines = await extractLines(buf.slice(0), pdfjs);
        } catch {
          setProgress(i, 'failed');
          failed++;
          state.warnings.push(
            `${file.name} could not be read. Try re-downloading it from your bank.`
          );
          continue;
        }
        // A bank account statement now routes to the bank ledger (Phase 1). The
        // card path below is untouched: only card statements reach it.
        if (detectStatementFormat(lines) === 'bank') {
          const parsed = parseBankStatementLines(lines, file.name);
          if (!parsed.statements.length || parsed.openingBalance == null) {
            setProgress(i, 'failed');
            failed++;
            state.bankWarnings.push(
              `${file.name} looks like a bank statement but its rows could not be read.`
            );
            continue;
          }
          await learnFirstName(scotiaBankHolderFirstName(lines), 'bank');
          const recon = reconcileBankStatement(parsed); // aggregate, for the file-level warning
          const recs = parsed.transactions.map((t) => ({
            ...t,
            id: bankTransactionIdentity(t),
          }));
          const merged = mergeBankTransactions(state.bankRecords, recs);
          state.bankRecords = merged.records;
          bankAdded += merged.added;
          // Store ONE traceable record PER STATEMENT (not per file), each with
          // its own period, account, count, closing balance and reconcile
          // result, deduped by a per-statement content hash. A file holding many
          // statements now shows one honest row each, and the same statement
          // arriving in both a consolidated and an individual PDF is stored once.
          let newStmts = 0;
          for (const st of parsed.statements) {
            const stHash = bankStatementHash(st);
            if (await Store.hasBankStatement(stHash)) continue;
            const r = reconcileBankStatement({
              openingBalance: st.openingBalance,
              closingBalance: st.closingBalance,
              transactions: st.transactions,
            });
            await Store.putBankStatement({
              hash: stHash,
              source_file: file.name,
              account: st.account,
              period: st.period,
              count: st.transactions.length,
              closingBalance: st.closingBalance,
              reconciled: r.ok,
              reconNote: r.balanceBreaks[0] || (r.closingOk ? '' : 'closing balance did not match'),
              importedAt: new Date().toISOString(),
            });
            newStmts++;
          }
          if (!recon.ok)
            state.bankWarnings.push(
              `${file.name}: ${recon.balanceBreaks[0] || 'balance did not fully reconcile'}.`
            );
          if (newStmts === 0 && merged.added === 0) bankDupes++;
          setProgress(
            i,
            newStmts === 0 && merged.added === 0 ? 'duplicate' : recon.ok ? 'done' : 'reconwarn',
            merged.added
          );
          continue;
        }
        if (detectCardStatementFormat(lines) === 'ncb') {
          for (const c of cardAccountsFromLines(lines)) {
            if (!state.cardAccounts.includes(c)) {
              state.cardAccounts = [...state.cardAccounts, c];
              cardLearned = true;
            }
          }
          const hash = statementContentHash(lines);
          if (await Store.hasStatement(hash)) {
            setProgress(i, 'duplicate');
            dupes++;
            continue;
          }
          const parsedNcb = parseNcbStatementLines(lines, file.name);
          if (!parsedNcb.transactions.length) {
            setProgress(i, 'failed');
            failed++;
            state.warnings.push(`${file.name} did not contain transactions we could read.`);
            continue;
          }
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
              ncbRecs.push({
                ...t,
                categoryOverride: null,
                reviewDismissed: false,
                lastChanged: new Date().toISOString(),
                originDevice: state.deviceId,
              });
            }
            if (built.summary.previousBalance != null && built.summary.newBalance != null) {
              await Store.putCardStatement({
                ...built.statementRecord,
                importedAt: new Date().toISOString(),
              });
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
              state.warnings.push(
                `${file.name}${where}: this statement did not fully add up. We expected the balance to change by ${expected}, but the transactions we read total ${got}. Some transactions may not have been read.`
              );
            }
          }
          const merged = mergeTransactions(state.records, ncbRecs);
          state.records = merged.records;
          added += merged.added;
          const period = ncbKeys.length
            ? ncbKeys.length === 1
              ? ncbKeys[0]
              : `${ncbKeys[0]} (+${ncbKeys.length - 1} more)`
            : '';
          await Store.putStatement({
            hash,
            source_file: file.name,
            period,
            importedAt: new Date().toISOString(),
          });
          if (period) periods.push(period);
          setProgress(i, 'done', merged.added);
          continue;
        }
        for (const c of cardAccountsFromLines(lines)) {
          if (!state.cardAccounts.includes(c)) {
            state.cardAccounts = [...state.cardAccounts, c];
            cardLearned = true;
          }
        }
        // Learn the person's own first name from the Scotiabank card statement's
        // labelled cardholder text (scotiaCardHolderFirstName reads only the
        // greeting / "CARD HOLDER (PRIMARY)" line, first token only). Only the
        // given name is stored - no surname, address or card number. A card name
        // outranks a bank-statement name but never a name set by hand; see
        // learnFirstName for how the sources are ranked.
        await learnFirstName(scotiaCardHolderFirstName(lines), 'card');
        const hash = statementContentHash(lines);
        if (await Store.hasStatement(hash)) {
          setProgress(i, 'duplicate');
          dupes++;
          continue;
        }
        const parsed = parseStatementLines(lines, file.name);
        if (!parsed.transactions.length) {
          setProgress(i, 'failed');
          failed++;
          state.warnings.push(`${file.name} did not contain transactions we could read.`);
          continue;
        }
        const recs = parsed.transactions.map((t) => ({
          ...t,
          id: transactionIdentity(t),
          categoryOverride: null,
          reviewDismissed: false,
          lastChanged: new Date().toISOString(),
          originDevice: state.deviceId,
        }));
        const merged = mergeTransactions(state.records, recs);
        state.records = merged.records;
        added += merged.added;
        await Store.putStatement({
          hash,
          source_file: file.name,
          period: parsed.period,
          importedAt: new Date().toISOString(),
        });
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
                state.warnings.push(
                  `${file.name}${where}: this statement did not fully add up. We expected the balance to change by ${expected}, but the transactions we read total ${got}. Some transactions may not have been read.`
                );
              }
              const chash = cardStatementHash(sum);
              if (!(await Store.hasCardStatement(chash))) {
                const health = cardStatementHealth(sum);
                await Store.putCardStatement({
                  hash: chash,
                  source_file: file.name,
                  account: sum.account,
                  period: sum.periodText,
                  statementKey: sum.statementKey,
                  periodStart: sum.periodStart,
                  periodEnd: sum.periodEnd,
                  previousBalance: sum.previousBalance,
                  purchases: sum.purchases,
                  payments: sum.payments,
                  newBalance: sum.newBalance,
                  creditLimit: sum.creditLimit,
                  creditAvailable: sum.creditAvailable,
                  minimumPayment: sum.minimumPayment,
                  amountOwing: sum.amountOwing,
                  interestCharges: sum.interestCharges,
                  eair: sum.eair,
                  utilisation: health.utilisation,
                  revolving: health.revolving,
                  payingInFull: health.payingInFull,
                  reconciled: rec.ok,
                  reconNote: rec.break || '',
                  importedAt: new Date().toISOString(),
                });
                cardStmtLearned = true;
              }
            }
          } catch (err) {
            console.warn(`Card statement summary could not be read for ${file.name}:`, err);
            state.warnings.push(
              `${file.name}'s reconciliation summary could not be read, so health details are missing for that statement.`
            );
          }
        }
        setProgress(i, 'done', merged.added);
      }
      await persist();
      if (bankAdded || bankDupes) {
        await persistBank();
        state._bankStatements = await Store.allBankStatements();
      }
      if (cardLearned) await Store.setMeta('bankCardAccounts', state.cardAccounts);
      if (cardStmtLearned) state._cardStatements = await Store.allCardStatements();
    } finally {
      setTimeout(closeProgress, 700);
    }
    if ((!hadCardBefore && state.records.length) || (!hadBankBefore && state.bankRecords.length))
      state.view = defaultDataView();
    render();
    if (!bankAdded && !added && (dupes || bankDupes) && !failed)
      toast(`Already imported, so nothing changed.`);
    else if (!bankAdded && !added && failed)
      toast(`We couldn't read ${failed === 1 ? 'that statement' : 'those statements'}.`);
    const welcomed = await maybeWelcomeFirstTime();
    if (!welcomed) {
      maybeOfferInstall();
      maybeOfferBackup();
      maybeOfferFirstRunHint();
    }
  }

  async function persistBank() {
    await Store.replaceBankTransactions(state.bankRecords);
  }

  // Persist the ledger-rule confirmations (income-confirmed deposits, round-trip
  // pairs). Pure metadata, no transaction is ever changed.
  async function persistLedgerRules() {
    await Store.setMeta('bankConfirmedIncomeIds', state.confirmedIncomeIds || []);
    await Store.setMeta('bankRefundIncomeIds', state.refundIncomeIds || []);
    await Store.setMeta('bankSharedAccounts', state.sharedAccounts || []);
    await Store.setMeta('bankHouseholdPayees', state.householdPayees || []);
  }

  /* progress dialog for imports */
  let progressState = null;
  function openProgress(files) {
    const rows = files.map((f, i) =>
      el(
        'div',
        { class: 'prog-row', id: 'prog-' + i },
        el('span', { class: 'prog-name' }, f.name),
        el('span', { class: 'prog-status', html: iconSpinner() })
      )
    );
    const heavy = files.length >= 3 || files.some((f) => (f.size || 0) > 1500000);
    const kids = [
      el(
        'div',
        { class: 'picker-head' },
        `Adding ${files.length} statement${files.length > 1 ? 's' : ''}`
      ),
    ];
    if (heavy)
      kids.push(
        el(
          'p',
          { class: 'muted small prog-privacy' },
          'A larger import can take a moment. It will finish on its own.'
        )
      );
    kids.push(el('div', { class: 'prog-list' }, ...rows));
    const box = el('div', { class: 'picker wide' }, ...kids);
    const overlay = el('div', { class: 'overlay' }, box);
    document.body.append(overlay);
    progressState = overlay;
  }
  function setProgress(i, status, added) {
    const row = $('#prog-' + i, progressState || document);
    if (!row) return;
    const s = $('.prog-status', row);
    if (status === 'reading') s.innerHTML = iconSpinner() + ' Reading…';
    else if (status === 'done') s.innerHTML = `<span class="ok">✓ ${added || 0} added</span>`;
    else if (status === 'duplicate') s.innerHTML = `<span class="muted">Already imported</span>`;
    else if (status === 'reconwarn')
      s.innerHTML = `<span class="warnc">Added · check balance</span>`;
    else if (status === 'failed') s.innerHTML = `<span class="warnc">Couldn't read</span>`;
  }
  function closeProgress() {
    if (progressState) {
      progressState.remove();
      progressState = null;
    }
  }

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
    mod.GlobalWorkerOptions.workerSrc = new URL(
      '../third-party/pdf.worker.min.mjs',
      import.meta.url
    ).href;
    _pdfjs = mod;
    return mod;
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
    if (!files) {
      toast("We can't find the folder we were watching. Choose where your statements live now.");
      return;
    }
    await ingestDesktopPaths(files);
  }
  async function ingestDesktopPaths(paths) {
    if (!paths || !paths.length) return;
    const fileLikes = [];
    for (const p of paths) {
      const data = await window.ccDesktop.readFile(p).catch((err) => {
        console.warn(`Watched-folder file could not be read: ${p}`, err);
        return null;
      });
      if (data)
        fileLikes.push({
          name: p.split(/[\\/]/).pop(),
          arrayBuffer: async () => data,
        });
    }
    if (fileLikes.length) await ingestFiles(fileLikes);
  }

  /* Export menu: CSV, print, encrypted history.
   * The CSV / rules / encrypted-history orchestration moved to data-export.js
   * (Stage 3c-i); the print-model + report-driver group moved to reporting.js
   * (Stage 5, createPrintReports). Both are wired up in the factory block below. */

  /* install prompt (iOS) */
  const isStandalone = () =>
    window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  const isIOS = () => /iphone|ipad|ipod/i.test(navigator.userAgent);
  async function maybeOfferInstall() {
    if (isStandalone() || !isIOS() || window.ccDesktop) return;
    if (await Store.getMeta('installDismissed', false)) return;
    if (!state.records.length) return;
    if (bannerAlreadyShown()) return;
    let banner = $('#install');
    if (!banner) {
      banner = el('div', {
        id: 'install',
        class: 'install-banner',
        role: 'note',
      });
      document.body.append(banner);
    }
    banner.innerHTML = '';
    banner.append(
      el('span', { class: 'install-icon', html: iconPhone() }),
      el(
        'span',
        {},
        'Add this to your Home Screen for reliable offline access and durable local storage. Tap the Share button, then “Add to Home Screen”.'
      ),
      el(
        'button',
        {
          class: 'btn sm ghost',
          onclick: () => {
            banner.classList.remove('show');
            Store.setMeta('installDismissed', true);
          },
        },
        'Not now'
      )
    );
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
    const statementTotal =
      (state._cardStatements || []).length + (state._bankStatements || []).length;
    if (statementTotal < 3) return; // fewer than 3 statements: not enough history yet
    if (bannerAlreadyShown()) return; // never stack over another banner at the same slot
    let banner = $('#backup-banner');
    if (!banner) {
      banner = el('div', {
        id: 'backup-banner',
        class: 'install-banner',
        role: 'note',
      });
      document.body.append(banner);
    }
    banner.innerHTML = '';
    banner.append(
      el('span', { class: 'install-icon', html: iconAlert() }),
      el(
        'span',
        {},
        "Everything you've set up lives only on this device. Make an encrypted backup so you don't lose it."
      ),
      el(
        'button',
        {
          class: 'btn sm',
          onclick: () => {
            banner.classList.remove('show');
            doExportHistory();
          },
        },
        'Back up now'
      ),
      el(
        'button',
        {
          class: 'btn sm ghost',
          onclick: () => {
            banner.classList.remove('show');
            Store.setMeta('backupPromptDismissed', true);
          },
        },
        'Not now'
      )
    );
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
    if (bannerAlreadyShown()) return; // never stack over another banner at the same slot
    let banner = $('#first-run-banner');
    if (!banner) {
      banner = el('div', {
        id: 'first-run-banner',
        class: 'install-banner',
        role: 'note',
      });
      document.body.append(banner);
    }
    banner.innerHTML = '';
    banner.append(
      el('span', { class: 'install-icon', html: iconChart() }),
      el(
        'span',
        {},
        'Add a couple more months to see trends, regular commitments, and how each month compares.'
      ),
      el(
        'button',
        {
          class: 'btn sm ghost',
          onclick: () => {
            banner.classList.remove('show');
            Store.setMeta('firstRunHintShown', true);
          },
        },
        'Got it'
      )
    );
    banner.classList.add('show');
  }

  /* Whether any of the three bottom banners is already visible. The three gates are close
   * to mutually exclusive in practice - the backup prompt needs 3+ statements, the first-run
   * hint needs fewer than 2 ledger-months, and install is iOS-only - so at most one normally
   * qualifies. This guard is belt-and-braces so that in the rare overlap they never sit on top
   * of each other at the same fixed bottom position; whichever runs first this import wins the slot. */
  function bannerAlreadyShown() {
    return ['#install', '#backup-banner', '#first-run-banner'].some((sel) => {
      const b = $(sel);
      return b && b.classList.contains('show');
    });
  }

  function mountTopGreeting(build, opts = {}) {
    const existing = $('#greeting');
    if (existing) {
      clearTimeout(existing._h);
      existing.remove();
    }
    const box = el('div', {
      id: 'greeting',
      role: 'status',
      'aria-live': 'polite',
    });
    const inner = el('div', { class: 'greeting-inner' });
    box.append(inner);
    const dismiss = () => {
      clearTimeout(box._h);
      box.classList.remove('show');
      setTimeout(() => box.remove(), 320);
    };
    for (const node of build(dismiss)) if (node) inner.append(node);
    const stack = $('.topbar-stack');
    if (stack) stack.append(box);
    else document.body.append(box);
    requestAnimationFrame(() => box.classList.add('show'));
    if (opts.autoMs) box._h = setTimeout(dismiss, opts.autoMs);
    return dismiss;
  }

  function greetingLine(lead, tail) {
    const name = (state.firstName || '').trim();
    return name ? `${lead}, ${name}${tail}` : `${lead}${tail}`;
  }

  async function maybeGreetReturning(lastVisit) {
    if (!(state.records.length || state.bankRecords.length)) return;
    if (!(await Store.getMeta('welcomedAt', null)))
      await Store.setMeta('welcomedAt', new Date().toISOString());
    const gapDays = lastVisit ? Math.floor((Date.now() - Date.parse(lastVisit)) / 86400000) : null;
    const away = gapDays != null && gapDays >= 14 ? ' It\u2019s been a while.' : '';
    const text = greetingLine('Welcome back', '.') + away;
    mountTopGreeting(
      (dismiss) => [
        el('span', { class: 'greeting-text' }, text),
        el(
          'button',
          {
            class: 'btn sm ghost greeting-dismiss',
            'aria-label': 'Dismiss',
            onclick: dismiss,
          },
          icon(iconX())
        ),
      ],
      { autoMs: 6000 }
    );
  }

  async function maybeWelcomeFirstTime() {
    if (await Store.getMeta('welcomedAt', null)) return false;
    if (!(state.records.length || state.bankRecords.length)) return false;
    await Store.setMeta('welcomedAt', new Date().toISOString());
    // The name, when there is one, has already been learned during import from a
    // Scotiabank card or bank statement, or set by hand in Data & settings, so a
    // first-ever import can greet by name with no field to fill in. When none is
    // known (for example an NCB-only import), the welcome simply drops the name
    // rather than asking for it.
    const heading = greetingLine('Welcome', ', your statements have loaded in.');
    mountTopGreeting(
      (dismiss) => [
        el(
          'div',
          { class: 'greeting-body' },
          el('span', { class: 'greeting-heading' }, heading),
          el(
            'p',
            { class: 'muted small greeting-sub' },
            'Everything stays on this device. Nothing leaves it.'
          )
        ),
        el(
          'button',
          {
            class: 'btn sm ghost greeting-dismiss',
            'aria-label': 'Dismiss',
            onclick: dismiss,
          },
          icon(iconX())
        ),
      ],
      { autoMs: 7000 }
    );
    return true;
  }
  /* ---- chrome ---- */
  function wireChrome() {
    const addInput = $('#add-input');
    if (addInput) addInput.addEventListener('change', onAddInputChange);
    const exportBtn = $('#export-btn');
    if (exportBtn)
      exportBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        toggleExportMenu();
      });
    // The four scope/detail CSV menu lines are now one row that opens a small
    // dialog (openCsvExportDialog, data-export.js) with a radio for scope and
    // a checkbox for detail level, rather than four near-identical sentences
    // in the dropdown itself.
    $('#exp-csv').addEventListener('click', openCsvExportDialog);
    $('#exp-print').addEventListener('click', printReport);
    $('#exp-rules-export').addEventListener('click', exportRules);
    const rulesInput = $('#exp-rules-input');
    if (rulesInput) {
      rulesInput.addEventListener('click', () => {
        setTimeout(() => toggleExportMenu(false), 0);
      });
      rulesInput.addEventListener('change', importRules);
    }
    $('#exp-export').addEventListener('click', doExportHistory);
    const historyInput = $('#exp-import-input');
    if (historyInput) {
      historyInput.addEventListener('click', () => {
        setTimeout(() => toggleExportMenu(false), 0);
      });
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
      const onMq = (e) => {
        if (!e.matches) exitPrint();
      };
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
      document.documentElement.dataset.theme = next;
      await Store.setMeta('theme', next);
      buildCategoryColours();
      paintTheme();
      if (state.records.length) render();
    });
    paintTheme();

    // drag & drop
    document.body.addEventListener('dragover', (e) => {
      e.preventDefault();
      document.body.classList.add('dropping');
    });
    document.body.addEventListener('dragleave', (e) => {
      if (e.target === document.body) document.body.classList.remove('dropping');
    });
    document.body.addEventListener('drop', (e) => {
      e.preventDefault();
      document.body.classList.remove('dropping');
      const files = [...(e.dataTransfer.files || [])].filter((f) =>
        f.name.toLowerCase().endsWith('.pdf')
      );
      if (files.length) ingestFiles(files);
    });

    const folderBtn = $('#folder-btn');
    if (window.ccDesktop && folderBtn) {
      folderBtn.hidden = false;
      folderBtn.addEventListener('click', chooseFolder);
    }

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
    window.addEventListener(
      'scroll',
      () => {
        if (!ticking) {
          ticking = true;
          requestAnimationFrame(update);
        }
      },
      { passive: true }
    );
    update();
  }

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
  const {
    classifiedBank,
    bankMoney,
    cleanCounterparty,
    renderBankStatementTrust,
    buildBankInsights,
    renderLedgerReview,
  } = createAccountsRenderer({
    state,
    el,
    icon,
    toast,
    render,
    persistLedgerRules,
    openOverlay,
    openModal,
    closePicker,
    bankMonthsList,
    iconInfo,
    iconReceipt,
    // Bank-appropriate insights (Part 2): period/range helpers and the extra
    // icons the new "What's changed" card for Accounts needs. pickStatements
    // lets the missing-months insight open the same add-statement flow the
    // Cards missingMonths insight already uses.
    resolved,
    bankRecordsInRange,
    pickStatements,
    iconUp,
    iconDown,
    iconAlert,
    iconSpark,
    iconGap,
    iconBulb,
    iconChevron,
    monthLabel,
    prevLabel: (...args) => prevLabelRef(...args),
    drillToAccountsPayee,
    clearFilters,
    clearBankFilters,
    trackUsage,
  });

  // Proven, corpus-tested analysis models bound to live state (additive).
  // classifiedBank is now in scope (destructured above); todayISO anchors the
  // forecast/position/available-now models to real "today", never the period
  // selector (those surfaces are period-independent by design).
  const todayISO = () => new Date().toISOString().slice(0, 10);
  const provenModels = createProvenModels({ state, classifiedBank, todayISO });

  const { renderForecastChart } = createForecastChartRenderer({
    el,
    provenModels,
    bankMoney,
    money0,
  });

  const { renderPosition } = createPositionRenderer({
    state,
    el,
    icon,
    provenModels,
    trackUsage,
    toast,
    bankMoney,
    money0,
    iconInfo,
    iconStore,
    iconAlert,
    iconList,
    Store,
    render,
    makeManualAsset,
    NET_WORTH_CLASSES,
    smoothScrollToEl,
    drillToAccount,
  });

  async function saveDailyForecastSnapshot() {
    if (!Store.forecastSnapshots || !provenModels.forecastSnapshot) return;

    const today = todayISO();
    const lastSaved = await Store.getMeta('lastForecastSnapshotDate', null);
    if (lastSaved === today) return;

    await Store.forecastSnapshots.put(provenModels.forecastSnapshot(90));
    await Store.setMeta('lastForecastSnapshotDate', today);
  }

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
  const { openCategoryPicker, dismissReview, openTagPicker } = createCategoryPicker({
    state,
    el,
    $,
    toast,
    render,
    closePicker,
    openModal,
    getPickerEl,
    persist,
    persistRules,
    catColour,
    isReview,
    trackUsage,
  });
  // Manage-data group (reload config, remove a statement, clear all data)
  // lives in manage-data.js (Stage 3b). Same pattern as Stages 2 and 3a: it
  // receives the bootUI members it uses via one context object; the three
  // names app.js still calls from renderManageData are destructured back out.
  // openOverlay stands in for the private pickerEl in openRemoveStatement and
  // confirmClearAll. Placed after every passed-in member is initialised,
  // before start().
  const { reloadConfig, openRemoveStatement, confirmClearAll } = createManageData({
    state,
    el,
    $,
    toast,
    render,
    closePicker,
    openOverlay,
    openModal,
    persist,
    persistBank,
    applyThemeColours,
    buildCategoryColours,
  });

  // Data export/import group (CSV, personal rules, encrypted history) lives in
  // data-export.js (Stage 3c-i). Same factory pattern as Stages 2-3b: it is the
  // stateful orchestration half of the pure serialisers in csv-export.js (toCSV /
  // bankToCSV) and history-codec.js (exportHistory / importHistory), receiving
  // the bootUI members it uses via one context object. currentBankViewRows is
  // passed in as a function reference - it lives with the print-model group in
  // reporting.js (createPrintReports), so this file calls it without owning it.
  // The names wireChrome and printReport still call are destructured back out.
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
  // Forward declaration, same pattern as printReports above: createCardsRenderer
  // (built first, line ~3338) needs a way to call Activity's drillToTransaction,
  // but createActivityRenderer (built second, line ~3420) is what actually
  // produces it. Neither factory is reordered - a lazy wrapper is passed into
  // createCardsRenderer's ctx instead, and the real function is assigned to
  // this outer variable once createActivityRenderer runs. Calling it before
  // that assignment (which cannot happen in practice, since nothing invokes
  // this until a person clicks the insight, long after boot completes) would
  // simply no-op rather than throw.
  let activityDrillToTransaction;
  const {
    toggleExportMenu,
    exportUnknownMerchants,
    exportRules,
    importRules,
    doExportHistory,
    doImportHistory,
    openCsvExportDialog,
  } = createDataExport({
    state,
    $,
    el,
    toast,
    render,
    persist,
    persistRules,
    persistBank,
    persistLedgerRules,
    openModal,
    closePicker,
    classifiedBank,
    visibleRows,
    defaultDataView,
    currentBankViewRows: (...args) => printReports.currentBankViewRows(...args),
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
    renderTrend,
    renderForeign,
    renderRecurring,
    renderCardFitness,
    renderCardStatementTrust,
    catTag,
    prevLabel,
    histMonthlyAverage,
    buildInsights,
  } = createCardsRenderer({
    state,
    el,
    icon,
    render,
    applyFilter,
    resolved,
    periodRows,
    clearFilters,
    money0,
    moneyShort,
    pct,
    monthLabel,
    monthShort,
    catColour,
    isReview,
    allMonths,
    pickStatements,
    secItem,
    showTip,
    hideTip,
    highestCompleteMonth,
    classifiedBank,
    commitmentsModel,
    drillToAccountsPayee,
    cleanCounterparty,
    iconInfo,
    iconUp,
    iconDown,
    iconChevron,
    iconChart,
    iconPie,
    iconStore,
    iconRepeat,
    iconGlobe,
    iconTag,
    iconAlert,
    iconSpark,
    iconReceipt,
    iconBack,
    iconPeak,
    iconGap,
    // Genuinely missing before this fix: this file needs trackUsage for
    // the new shared drill helper (which tracks 'view-right-now'), and
    // resetBankDrillFacets for the same helper's own bank-facet reset.
    trackUsage,
    resetBankDrillFacets,
    drillToTransactions,
    // Threads Activity's own drillToTransaction through so cards-render.js's
    // single-large-transaction insight can anchor straight to that one
    // transaction (open, scrolled to, highlighted) rather than a text-search
    // patch. A lazy wrapper, not the value itself: createActivityRenderer
    // (which produces the real function) has not run yet at this point in
    // the file - see the activityDrillToTransaction forward declaration
    // above for why this is a wrapper rather than a reordering.
    drillToTransaction: (target) => {
      if (activityDrillToTransaction) activityDrillToTransaction(target);
    },
  });

  // Bind the Accounts-hero forward reference now that prevLabel exists (see
  // the lazy-wrapper comment above createAccountsRenderer's construction).
  prevLabelRef = prevLabel;

  // Right Now (Round 3 of the restructuring plan) lives in right-now-render.js.
  // Placed here, after both createAccountsRenderer (renderBankTrend,
  // buildBankInsights, renderLedgerReview, classifiedBank, bankMoney,
  // cleanCounterparty) and createCardsRenderer (renderCategoryPanel,
  // renderForeign, renderRecurring, renderCardFitness, catTag) have already
  // constructed the building blocks this factory reuses unchanged, and before
  // start() runs the first render.
  const { renderIncomeChart } = createIncomeChartRenderer({
    el,
    money0,
    moneyShort,
    monthLabel,
  });
  const { renderFlowChart } = createFlowChartRenderer({
    el,
    bankMoney,
    monthLabel,
  });

  
  const {
    renderActivity,
    activityTabSignature,
    drillToTransaction,
  } = createActivityRenderer({
    state,
    el,
    icon,
    provenModels,
    resolved,
    trackUsage,
    applyFilter,
    categorySpend,
    iconInfo,
    iconPie,
    iconRepeat,
    previousPeriod: () => {
      const p = resolved();
      return p && p.prevFrom && p.prevTo ? { from: p.prevFrom, to: p.prevTo } : null;
    },
    isPeriodFullyCovered,
    Store,
    render,
    makeIntention,
    makeTag,
    toast,
    catColour,
    money0,
    resetBankDrillFacets,
    bankMoney,
    cleanCounterparty,
    drillToAccountsPayee,
    openCategoryPicker,
    openTagPicker,
    FALLBACK,
    iconList,
    visibleRows,
    visibleBankRows,
    bankRecordsInPeriod,
    classifiedBank,
    periodRows,
    bankRowsInapplicable,
    cardRowsInapplicable,
    clearFilters,
    clearBankFilters,
    catTag,
    analysis,
    renderRecurring,
    renderForeign,
    renderCardFitness,
    buildInsights,
    smoothScrollToEl,
    renderTrend,
    renderLedgerReview,
    renderIncomeChart,
    overviewModel,
    iconSpark,
    iconGap,
    moneyShort,
    buildBankInsights,
    iconBulb,
    iconChevron,
    resetCardDrillFacets,
    drillToTransactions,
  });
  activityDrillToTransaction = drillToTransaction;

  const { renderOverview } = createOverviewRenderer({
    state,
    el,
    icon,
    bankMoney,
    resolved,
    allLedgerMonths,
    overviewModel,
    periodEmptyNotice,
    switchLedgerView,
    trackUsage,
    provenModels,
    iconInfo,
    renderFlowChart,
    money0,
    dismissReview,
    pickStatements,
    drillToTransactions,
  });

  // Ahead - Coming Up (Round 2 of the restructuring plan) lives in
  // ahead-render.js. Same factory pattern as every other destination: it
  // receives the bootUI members it uses via one context object. Placed here,
  // after createAccountsRenderer (bankMoney, classifiedBank, cleanCounterparty)
  // and the plain helper functions above (bankMonthsList, commitmentsModel,
  // drillToAccountsPayee, switchLedgerView, pickStatements, trackUsage) are all
  // initialised, and before start() runs the first render.
  const { renderAhead, draftSignature } = createAheadRenderer({
    state,
    el,
    icon,
    render,
    bankMoney,
    classifiedBank,
    commitmentsModel,
    bankMonthsList,
    pickStatements,
    trackUsage,
    switchLedgerView,
    drillToAccountsPayee,
    drillToTransactions,
    cleanCounterparty,
    toast,
    overviewModel,
    analysis,
    setGoal,
    clearGoal,
    restoreGoal,
    liveGoalProgress,
    provenModels,
    renderForecastChart,
    Store,
    // Step 3: the SAME context-builder and month-resolver checkMonthlyGoalIfDue
    // now uses, so the live card and the monthly log can never silently
    // disagree on what "this period" means for a spend-ceiling goal.
    buildNewEngineProgressCtx,
    latestCompleteGoalMonth,
    evaluateGoal,
    iconCal,
    iconGap,
    iconRepeat,
    iconChart,
    iconFlag,
    money0,
    moneyShort,
    monthLabel,
  });

  // Print-model + report-driver group lives in reporting.js (Stage 5). It is the
  // orchestration half that feeds the three renderers now in report-render.js
  // (renderReport / renderBankReport / renderOverviewReport): it builds their plain data models
  // from live bootUI state and drives the print flow. Placed here, after every
  // ctx member is initialised - the accounts-render constants (classifiedBank /
  // bankMoney / cleanCounterparty) and the cards-render constants (prevLabel /
  // histMonthlyAverage / buildInsights) it depends on, plus toggleExportMenu -
  // and before start(). The four names app.js still calls are destructured back
  // out: printReport (Export menu), buildReportForCurrentView (beforeprint),
  // exitPrint (afterprint / close), and currentBankViewRows (handed to the
  // data-export factory above via the lazy wrapper).
  printReports = createPrintReports({
    state,
    $,
    el,
    toast,
    iconX,
    toggleExportMenu,
    bankRecordsInPeriod,
    resolved,
    analysis,
    periodRows,
    visibleRows,
    allMonths,
    FALLBACK,
    isReview,
    catColour,
    money0,
    moneyShort,
    pct,
    monthLabel,
    monthShort,
    prevLabel,
    histMonthlyAverage,
    buildInsights,
    classifiedBank,
    bankMoney,
    cleanCounterparty,
    overviewModel,
  });
  const { printReport, buildReportForCurrentView, exitPrint } = printReports;

  /* ---- start ---- */
  async function start() {
    const res = await fetch(new URL('../settings/config.json', import.meta.url));
    if (!res.ok) throw new Error(`Could not load configuration (HTTP ${res.status}).`);
    state.cfg = withConfigDefaults(await res.json());
    // Exchange rates: a small, dated, sourced file baked into the bundle by a
    // weekly GitHub Action - never a client-side FX call, so the privacy promise
    // and offline guarantee hold. Loaded exactly like config.json above. A
    // missing/unreadable file degrades to null, and foreign holdings then stay
    // shown separately and uncounted rather than converted at a guessed rate.
    try {
      const fxRes = await fetch(new URL('../settings/exchange-rates.json', import.meta.url));
      state.fxRates = fxRes.ok ? await fxRes.json() : null;
    } catch {
      state.fxRates = null;
    }
    // B4 (custom categories): merge person-authored categories on top of the
    // shipped, read-only register BEFORE anything compiles or reads
    // state.cfg.categories, so compileRules, buildCategoryColours, and the
    // category picker (which reads state.cfg.categories directly, with no
    // separate abstraction) all see ONE indistinguishable register - shipped
    // + custom - never a second, separately-maintained list. A custom
    // category carries empty patterns (assign-only), so merging it in never
    // changes what any OTHER category matches.
    state.customCategories = await Store.getMeta('customCategories', []);
    state.cfg.categories = mergeCategories(state.cfg.categories, state.customCategories);
    state.compiled = compileRules(state.cfg.categories);
    state.brandRules = compileBrandRules(state.cfg);
    // Jamaica/Scotiabank-specific bank-descriptor cleanup (ABM terminal marker,
    // processing-date suffix, trailing country code, wrapped "Financial
    // Centre" split, salary-month token, correspondent-bank suffix) is
    // config-driven - see config.json's bankDescriptorCleanup.rules. This call
    // was never added when that feature was built, so the app silently kept
    // running on read-statements.js's built-in 4-rule fallback all session -
    // which is exactly why the two newer config-only rules never fired.
    setBankDescriptorCleanupRules(
      state.cfg.bankDescriptorCleanup && state.cfg.bankDescriptorCleanup.rules
    ); // Load the researched merchant list named by config.merchants.file and
    // compile it once. This is the same compiled list categorise() and the
    // merchant grouping both read, so the whole app agrees on merchants.
    try {
      const mFile = (state.cfg.merchants && state.cfg.merchants.file) || 'jamaica-merchants.json';
      const mRes = await fetch(new URL('../settings/' + mFile, import.meta.url));
      const rawMerchants = await mRes.json();
      const cleanupRules = [];
      for (const r of (state.cfg.bankDescriptorCleanup && state.cfg.bankDescriptorCleanup.rules) ||
        []) {
        if (!r || !r.pattern) continue;
        try {
          cleanupRules.push({
            pattern: new RegExp(r.pattern, r.flags || 'i'),
            replacement: r.replacement || '',
          });
        } catch {
          // an unparsable cleanup rule pattern is skipped, not fatal
        }
      }
      state.resolver = compileFromRaw(rawMerchants, state.cfg, cleanupRules);
      state.merchants = state.resolver.compiled;
    } catch (err) {
      console.warn('Merchant list could not be loaded; category rules will decide alone.', err);
      state.merchants = [];
      state.resolver = null;
    }
    state.keepUpper = new Set(state.cfg.keepUpper);
    state.smallWords = new Set(state.cfg.smallWords);
    applyThemeColours();
    document.documentElement.dataset.theme = await Store.getMeta(
      'theme',
      (state.cfg.display && state.cfg.display.theme) || 'auto'
    );
    buildCategoryColours();
    state.deviceId = await Store.getMeta('deviceId', null);
    if (!state.deviceId) {
      state.deviceId = 'dev-' + fnv1a(String(Date.now()) + Math.random());
      await Store.setMeta('deviceId', state.deviceId);
    }
    state.lastImportedFrom = await Store.getMeta('lastImportedFrom', null);
    state.firstName = await Store.getMeta('firstName', null);
    state.firstNameSource = await Store.getMeta('firstNameSource', null);
    state.rules = await Store.allRules();
    state.records = await Store.allTransactions();
    // Bank ledger (Phase 1): load its own store and the "my accounts" list.
    state.bankRecords = await Store.allBankTransactions();
    state._bankStatements = await Store.allBankStatements();
    state.myAccounts = await Store.getMeta('bankMyAccounts', []);
    state.cardAccounts = await Store.getMeta('bankCardAccounts', []);
    state.confirmedIncomeIds = await Store.getMeta('bankConfirmedIncomeIds', []);
    state.refundIncomeIds = await Store.getMeta('bankRefundIncomeIds', []);
    state.sharedAccounts = await Store.getMeta('bankSharedAccounts', []);
    state.householdPayees = await Store.getMeta('bankHouseholdPayees', []);
    state._usageTally = await Store.getMeta('usageTally', {});
    // Non-destructive migration from the old goal shape (runway/clear-card/
    // spend-ceiling with .params) to the proven goals.js shape (cushion/
    // clear-card/spend-ceiling, flat fields). Inert on its own: nothing yet
    // reads the new shape, so computeGoalProgress below continues to work
    // unchanged - see goal-migrate.js's own contract for why this is safe.
    // goalLog is loaded completely separately, immediately below, and this
    // migration step never touches it.
    state.goal = ensureMigrated(await Store.getMeta('financeGoal', null));
    // Re-persist only if migration actually changed the shape, so a fresh
    // save is never written for a goal that was already current or absent.
    if (state.goal && state.goal.migratedFrom) await Store.setMeta('financeGoal', state.goal);
    state.goalLog = await Store.getMeta('financeGoalLog', []);
    // Step 2 continued: the safety-boundary, under its OWN storage key,
    // deliberately independent of financeGoal - see ahead-render.js's own
    // comment on why. null/absent means the frozen contract's 'none' state.
    state._goalBoundary = await Store.getMeta('financeGoalBoundary', null);
    // v4 record-schema guard + new analysis stores. Defensive: a storage.js
    // that predates versioning has no ensureSchema / typed stores, so each is
    // feature-detected and boot can never crash on an older storage layer.
    const _schema = Store.ensureSchema ? await Store.ensureSchema() : { ok: true };
    if (_schema && _schema.ok === false && _schema.reason === 'newer-schema') {
      console.warn(
        'Stored data was saved by a newer app version; new features run read-only.',
        _schema
      );
    }
    state.categoryIntentions = Store.categoryIntentions ? await Store.categoryIntentions.all() : [];
    state.manualAssets = Store.manualAssets ? await Store.manualAssets.all() : [];
    state.forecastSnapshots = Store.forecastSnapshots ? await Store.forecastSnapshots.all() : [];
    state.tags = Store.tags ? await Store.tags.all() : [];
    state.transactionSplits = Store.transactionSplits ? await Store.transactionSplits.all() : [];
    state._cardStatements = await Store.allCardStatements();

    await saveDailyForecastSnapshot();

    state.view = defaultDataView();
    document.title = state.cfg.app.name;
    const brand = $('#brand-name');
    if (brand) brand.textContent = state.cfg.app.name;
    wireChrome();
    render();
    if (typeof window !== 'undefined' && window.__pfaBoot) window.__pfaBoot.markStarted();
    const lastVisit = await Store.getMeta('lastVisit', null);
    await Store.setMeta('lastVisit', new Date().toISOString());
    if (state.records.length || state.bankRecords.length) await maybeGreetReturning(lastVisit);
    await maybeOfferInstall();
    await maybeOfferBackup();
    if (window.ccDesktop) {
      await scanWatchedFolder();
      window.ccDesktop.onNewFile(async (path) => {
        await ingestDesktopPaths([path]);
      });
      if (window.ccDesktop.onWatchError)
        window.ccDesktop.onWatchError(() =>
          toast("The folder we were watching is unavailable. Choose it again when you're ready.")
        );
    }
    // Register the offline service worker in production only. On localhost it
    // is deliberately skipped so development always serves live files with no
    // cache in front - edit, reload, see the change, with no version bump and
    // nothing to unregister. A real deployment (any non-localhost host) still
    // gets the full offline PWA. Any worker left over from a past localhost
    // session is torn down so it cannot keep serving a stale shell.
    const isLocalDev = LOCAL_DEV_HOSTS.includes(location.hostname);
    if ('serviceWorker' in navigator) {
      if (isLocalDev) {
        navigator.serviceWorker
          .getRegistrations()
          .then((regs) => regs.forEach((r) => r.unregister()))
          .catch((err) => {
            console.warn('Service worker cleanup (localhost) failed:', err);
          });
      } else {
        const swUrl = new URL('../service-worker.js', import.meta.url).href;
        const swScope = new URL('../', import.meta.url).href;
        navigator.serviceWorker
          .getRegistrations()
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
          .catch((err) => {
            console.warn('Service worker registration failed:', err);
          });
      }
    }
  }

  function highestCompleteMonth() {
    const months = allMonths();
    if (!months.length) return null;
    const inc = detectIncompleteMonth(state.rows, months, new Date(), {
      coverage: state.coverage,
    });
    let best = null;
    for (const m of months) {
      if (inc && m === inc.month) continue;
      const v = state.allSummary.by_month[m] || 0;
      if (!best || v > best.amount) best = { month: m, amount: v };
    }
    return best;
  }

  start().catch((err) => {
    console.error('The app could not start.', err);
    if (typeof window !== 'undefined' && window.__pfaBoot) window.__pfaBoot.reportFailure();
  });
}

// Boot the interface only in a browser with a DOM. In Node (tests) this file is
// imported purely for its exported functions and nothing runs.
if (typeof window !== 'undefined' && typeof document !== 'undefined' && document.getElementById) {
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bootUI);
  else bootUI();
}
