/*
 * accounts-render.js  -  the bank Accounts view and its ledger-review controls.
 *
 * Stage 2 of the split. These nine functions were lifted verbatim from bootUI
 * in app.js. They are wrapped in a factory, createAccountsRenderer(ctx), that
 * receives the shared bootUI closure members it needs (state, DOM helpers, the
 * shared period helpers, the modal open/close pair) rather than closing over
 * them directly. Nothing inside the function bodies was renamed; only where a
 * name comes from changed - from the surrounding closure to the destructured
 * ctx below. The one exception is openRoundTripPicker's final line, which now
 * calls the injected openOverlay(overlay) instead of touching app.js's private
 * pickerEl variable directly.
 */

import { classifyInternalTransfers, applyLedgerRules, cleanBankCounterparty, analyseBankActivity, detectBankStandingDebits, externalOutflowShortlist, bankCounterpartyGroups, bankFlowOverTime, overviewVerdict, bankKindBreakdown, bankMovementKind } from './read-statements.js';
import { smartTitle } from './categorise.js';
import { Store } from './storage.js';
import { ymToday, missingMonths, appendExpandable, buildBankAppropriateInsights, renderKindTag, renderFlowArrow, buildHeroSection, renderInsightList, renderExplainer, renderFilterChips } from './reporting.js';
import { formatMoney, smoothScrollToEl, requireCtx } from './shared-helpers.js';

// Shared, empty keep-upper / small-words set for smartTitle when tidying a bank
// counterparty for display (plain Title Case). Kept byte-identical to the set
// read-statements.js uses for the upstream counterparty label, so a payee shown
// through either path reads with exactly the same casing.
const CP_LABEL_SET = new Set();

export function createAccountsRenderer(ctx) {
  requireCtx(ctx, [
    'state', 'el', 'icon', 'toast', 'render', 'persistLedgerRules', 'openOverlay', 'closePicker',
    'periodEmptyNotice', 'bankMonthsList', 'bankRecordsInPeriod', 'drillToAccountsPayee',
    'iconGlobe', 'iconInfo', 'iconList', 'iconStore', 'iconReceipt', 'iconRepeat', 'iconX',
    'resolved', 'bankRecordsInRange', 'prevLabel', 'pickStatements',
    'iconUp', 'iconDown', 'iconAlert', 'iconSpark', 'iconGap', 'iconBulb', 'iconChevron', 'monthLabel',
    'openModal', 'drillToAccount', 'bankActiveFilterCount', 'clearBankFacet',
  ], 'createAccountsRenderer');
  const {
    state, el, icon, toast, render, persistLedgerRules, openOverlay, closePicker, periodEmptyNotice, bankMonthsList, bankRecordsInPeriod, drillToAccountsPayee, iconGlobe, iconInfo, iconList, iconStore, iconReceipt, iconRepeat, iconX,
    // Bank-appropriate insights (Part 2): period/range helpers reused for the
    // income-change comparison and the large-payment/new-payee checks, plus
    // the extra icons and pickStatements/monthLabel the insights card needs.
    resolved, bankRecordsInRange, prevLabel, pickStatements,
    iconUp, iconDown, iconAlert, iconSpark, iconGap, iconBulb, iconChevron, monthLabel,
    // openModal is passed by app.js's createAccountsRenderer call but was never
    // destructured here, so openRoundTripPicker's openModal(box) threw a
    // ReferenceError the instant "pair" was clicked. Restored.
    openModal,
    // The account-drill twin of drillToAccountsPayee, and the two
    // registry-derived helpers - see app.js's BANK_FACETS for what each
    // facet resets to and why.
    drillToAccount, bankActiveFilterCount, clearBankFacet,
  } = ctx;

  let _acctSearchDebounce = null;
  let _kindShowInternal = false;

  /* ---- Accounts view (Phase 1: read-only, balance-first) ----
   * A minimal cash-flow and balance screen for the bank ledger: money in,
   * money out (internal transfers excluded), net movement and the closing
   * balance, then a transaction list carrying the running balance. Internal
   * transfers are shown but set apart. No categorisation, no card merchant
   * rules, no merging with card data (D1). */
  function bankMoney(n, currency) {
    const { symbol = '$', locale = 'en-JM', decimals = 2, code = 'JMD' } = state.cfg.currency || {};
    // A non-base currency (USD) is shown with its own prefix so a US$ figure is
    // never mistaken for a JMD one. The base currency keeps the plain symbol.
    const sym = (currency && currency !== code) ? (currency === 'USD' ? 'US$' : currency + ' ') : symbol;
    return formatMoney(n, sym, locale, decimals);
  }

  let _cbKey = null, _cbVal = null;
  function classifiedBank() {
    if (_cbKey
      && _cbKey.br === state.bankRecords && _cbKey.ma === state.myAccounts
      && _cbKey.ca === state.cardAccounts && _cbKey.rz === state.resolver
      && _cbKey.ci === state.confirmedIncomeIds && _cbKey.rt === state.roundTripIds
      && _cbKey.sa === state.sharedAccounts && _cbKey.hp === state.householdPayees) {
      return _cbVal;
    }
    const base = classifyInternalTransfers(state.bankRecords, state.myAccounts, state.cardAccounts || [], state.resolver);
    // Apply the evidence-backed exclusions on top (cash/ABM self-deposits out of
    // income by default, confirmed round-trip pairs netted out, shared-account
    // support to household kept off the personal headline).
    const out = applyLedgerRules(base, {
      confirmedIncomeIds: new Set(state.confirmedIncomeIds || []),
      roundTripIds: new Set(state.roundTripIds || []),
      sharedAccounts: state.sharedAccounts || [],
      householdPayees: state.householdPayees || [],
    });
    _cbKey = {
      br: state.bankRecords, ma: state.myAccounts, ca: state.cardAccounts, rz: state.resolver,
      ci: state.confirmedIncomeIds, rt: state.roundTripIds, sa: state.sharedAccounts, hp: state.householdPayees,
    };
    _cbVal = out;
    // INVARIANT: this array is now shared by reference across every caller
    // and across renders. Callers must treat it and its rows as READ-ONLY
    // (filter and read, never mutate a row in place), or the mutation will
    // silently reach every other view holding the same cached result.
    return out;
  }
  function buildBankInsights(a, recs, recsAll) {
    const p = resolved();
    let prevIncome = null;
    if (p && p.prevFrom && p.prevTo) {
      const prevRecs = bankRecordsInRange(recsAll, p.prevFrom, p.prevTo);
      prevIncome = analyseBankActivity(prevRecs).cashIn;
    }
    let verdict = null;
    if (p) {
      const trend = bankFlowOverTime(recs).map((t) => ({ month: t.month, net: t.net }));
      verdict = overviewVerdict({ netCashFlow: a.net, trend });
    }
    return buildBankAppropriateInsights({
      recsAll, period: p, cfg: state.cfg,
      currentIncome: a.cashIn, prevIncome, verdict,
      bankMoney, prevLabel, monthLabel, bankMonthsList,
      onNavigate: () => scrollToTx(),
      icons: { up: iconUp, down: iconDown, alert: iconAlert, spark: iconSpark, gap: iconGap, info: iconInfo },
    });
  }
  // Scroll target shared by every Accounts insight that has no more specific
  // destination: the transaction list below (id="acct-tx", set in
  // renderAccounts). Accounts has no filter/search system to drill into
  // (unlike Cards' explorer), so every insight click surfaces the same real
  // transaction list the figures above already summarise.
  function scrollToTx() {
    if (!state.bankShowAllTx) { state.bankShowAllTx = true; render(); }
    smoothScrollToEl('#acct-tx');
  }

  function drillToPayee(key, label) {
    drillToAccountsPayee(key, label);
  }

  // Renders the "What's new or unusual" card, the Accounts twin of Cards'
  // "What changed" insights card, placed directly below the hero - the same
  // position Cards' own insights card sits relative to its hero (render()'s
  // real DOM order there is renderHero, renderInsightsAndAttention). Reuses
  // the existing .insight-list / .insight / .insight-icon / .insight-text /
  // .insight-go CSS classes verbatim - no new UI is introduced.
  function renderBankInsightsCard(a, recs, recsAll) {
    const p = resolved();
    return renderInsightList(el, icon, {
      title: 'What\u2019s new or unusual',
      iconBulb, iconChevron,
      insights: buildBankInsights(a, recs, recsAll),
      emptyText: `A calm ${p ? p.label.toLowerCase() : 'period'}. Nothing stands out against your usual pattern.`,
    });
  }

  function renderBankTrend() {
    const trend = bankFlowOverTime(classifiedBank());
    if (!trend.length) return null;
    const p = resolved();
    const MON = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const monShort = (m) => { const x = /-(\d{2})$/.exec(m); return x ? MON[+x[1] - 1] : m; };
    const shown = trend.slice(-12);
    const max = Math.max(1, ...shown.map((t) => t.moneyOut));
    const H = 150;
    const vals = shown.map((t) => t.moneyOut);
    const avg = vals.length ? vals.reduce((x, y) => x + y, 0) / vals.length : 0;
    const avgY = avg > 0 ? H - Math.min(H, (avg / max) * H) : null;
    const sec = el('section', { class: 'card' });
    sec.append(el('div', { class: 'card-head' }, el('h3', { class: 'card-title' }, icon(iconSpark()), 'Money out over time')));
    const chart = el('div', { class: 'trend' });
    if (avgY != null) {
      chart.append(el('div', { class: 'trend-avg', style: `top:${avgY}px`, title: `Typical month ${bankMoney(avg)}` },
        el('span', { class: 'trend-avg-label' }, `avg ${bankMoney(avg)}`)));
    }
    const bars = el('div', { class: 'trend-bars' });
    for (const t of shown) {
      const inPeriod = p && t.month >= p.from && t.month <= p.to;
      bars.append(el('div', { class: 'trend-col' + (inPeriod ? ' in-period' : ''),
        title: `${t.month}: in ${bankMoney(t.moneyIn)} · out ${bankMoney(t.moneyOut)}` },
        el('span', { class: 'trend-bar', style: `height:${Math.max(3, (t.moneyOut / max) * H)}px` }),
        el('span', { class: 'trend-mlabel' }, monShort(t.month))));
    }
    chart.append(bars);
    sec.append(chart);
    sec.append(renderExplainer(el, 'Money leaving your accounts each month, transfers between your own accounts excluded. Bars inside the selected period are highlighted; the dashed line is your typical month.', { label: 'How this chart is worked out' }));
    return sec;
  }

  function renderAccounts() {
    const wrap = el('div', { class: 'accounts-wrap accounts-grid' });
    const recsAll = classifiedBank();
    const recs = bankRecordsInPeriod(recsAll);
    const periodEmpty = recsAll.length && !recs.length;
    const a = analyseBankActivity(periodEmpty ? recsAll : recs);
    const multi = a.accounts.length > 1;

    // Accounts hero via the one shared buildHeroSection (reporting.js), so the
    // eyebrow/title/lead/facts/note order is identical to Cards and Overview and
    // cannot drift. Already headline-first (Cash on hand leads), so this is a
    // pure consolidation - no reorder needed here, unlike Overview.
    wrap.append(buildHeroSection(el, icon, iconInfo, {
      eyebrow: 'Accounts',
      title: multi ? `Your account activity · ${a.accounts.length} accounts` : 'Your account activity',
      lead: {
        amount: a.closingBalance == null ? '—' : bankMoney(a.closingBalance),
        label: multi ? 'Total cash on hand' : 'Cash on hand',
      },
      facts: [
        { value: bankMoney(a.cashIn), label: 'Money in' },
        { value: bankMoney(a.cashOut), label: 'Money out' },
        { value: (a.net >= 0 ? '+' : '') + bankMoney(a.net), label: 'Net movement' },
      ],
      note: el('p', { class: 'muted small', style: 'margin-top:10px' },
        `Money in and out exclude transfers between your own accounts (${bankMoney(a.internalOut)} moved internally). Nothing here is mixed with your card spending.`),
    }));

    if (periodEmpty) {
      wrap.append(periodEmptyNotice('account transactions', bankMonthsList()));
      return wrap;
    }

    wrap.append(renderBankInsightsCard(a, recs, recsAll));

    const kindCfg = state.cfg.bankMovementKinds || {};
    const kindByKey = new Map();
    for (const r of recsAll) {
      const k = r.counterpartyKey;
      if (k && !kindByKey.has(k)) kindByKey.set(k, bankMovementKind(r, state.resolver, kindCfg));
    }
    const kindDot = (key) => {
      const colour = (kindCfg.colours || {})[kindByKey.get(key)];
      return colour ? el('span', { class: 'cat-dot', style: `background:${colour}` }) : null;
    };

    // Order mirrors the Cards tab: hero, "What's new or unusual", then the
    // concrete "who/where money moved" detail, and only then the analytical
    // breakdown and trend. Review leads because it is the one card that asks for
    // a decision; "Where money went" and "Who money moved with" follow directly
    // under the insights, each row carrying its movement-kind colour (kindDot)
    // so the breakdown below reads as their shared legend.
    const review = renderLedgerReview(a, recs);
    if (review) wrap.append(review);

    const outflows = externalOutflowShortlist(recs);
    if (outflows.length) {
      const sec = el('section', { class: 'card acct-pair' });
      sec.append(el('div', { class: 'card-head' }, el('h3', { class: 'card-title' }, icon(iconList()), 'Where money went')));
      const list = el('div', { class: 'recurring-list' });
      const renderOutflowRow = (g) => el('button', { class: 'recurring-row',
        'aria-label': `${g.label}: ${g.count} payment${g.count === 1 ? '' : 's'}, ${bankMoney(g.moneyOut)}`,
        onclick: () => drillToPayee(g.key, cleanCounterparty(g.label)) },
        el('span', { class: 'recurring-name' }, kindDot(g.key), cleanCounterparty(g.label)),
        el('span', { class: 'recurring-months muted small' }, `${g.count} payment${g.count === 1 ? '' : 's'}`),
        el('span', { class: 'recurring-amt num strong' }, bankMoney(g.moneyOut)));
      appendExpandable(el, list, outflows, renderOutflowRow, { initial: 5 });
      sec.append(list);
      sec.append(renderExplainer(el, 'External payments only, largest first. Transfers between your own accounts are not counted here.', { label: 'What\u2019s counted here' }));
      wrap.append(sec);
    }

    const payees = bankCounterpartyGroups(recs).filter((g) => !g.internal);
    if (payees.length) {
      const sec = el('section', { class: 'card acct-pair' });
      sec.append(el('div', { class: 'card-head' }, el('h3', { class: 'card-title' }, icon(iconStore()), 'Who money moved with')));
      const list = el('div', { class: 'recurring-list' });
      // g.key already exists on bankCounterpartyGroups output; this row -
      // previously a plain, inert <div> - now drills into the Transactions
      // card below like every other summary entity in the app.
      const renderPayeeRow = (g) => {
        const isIn = !(g.moneyOut > 0);
        const amount = isIn ? g.moneyIn : g.moneyOut;
        const dirWord = isIn ? 'in' : 'out';
        return el('button', { class: 'recurring-row',
          'aria-label': `${g.label}: ${g.count} transaction${g.count === 1 ? '' : 's'}, ${bankMoney(amount)} ${dirWord}`,
          onclick: () => drillToPayee(g.key, cleanCounterparty(g.label)) },
          el('span', { class: 'recurring-name' }, kindDot(g.key), cleanCounterparty(g.label)),
          el('span', { class: 'recurring-months muted small' }, `${g.count} transaction${g.count === 1 ? '' : 's'}`),
          el('span', { class: 'recurring-amt num strong' },
            renderFlowArrow(el, { up: iconUp, down: iconDown }, dirWord),
            (isIn ? '+' : '') + bankMoney(amount)));
      };
      appendExpandable(el, list, payees, renderPayeeRow, { initial: 5 });
      sec.append(list);
      sec.append(renderExplainer(el, 'External payees only, merged across spelling variants and ordered by how much moved. Transfers between your own accounts are shown separately below.', { label: 'What\u2019s counted here' }));
      wrap.append(sec);
    }

    // "What the money was doing" now sits BELOW the who/where detail as its
    // shared legend, not above it: its colours are the same ones the rows above
    // carry, so it reads as the key to them rather than a competing headline.
    const kindsAll = bankKindBreakdown(recs, state.resolver, kindCfg);
    const kinds = _kindShowInternal ? kindsAll : kindsAll.filter((k) => k.kind !== 'internal');
    if (kinds.length) {
      const labels = kindCfg.labels || {};
      const colours = kindCfg.colours || {};
      const ordered = kinds.slice().sort((x, y) => y.total - x.total);
      const maxTotal = kinds.reduce((mx, k) => Math.max(mx, k.total), 0) || 1;
      const grand = kinds.reduce((s, k) => s + k.total, 0) || 1;
      const sec = el('section', { class: 'card' });
      const head = el('div', { class: 'card-head' }, el('h3', { class: 'card-title' }, icon(iconList()), 'What the money was doing'));
      if (kindsAll.some((k) => k.kind === 'internal')) {
        head.append(el('button', { class: 'btn sm ghost', onclick: () => { _kindShowInternal = !_kindShowInternal; render(); } },
          _kindShowInternal ? 'Hide own transfers' : 'Include own transfers'));
      }
      sec.append(head);
      const list = el('div', { class: 'catlist' });
      const renderKindRow = (k) => {
        const label = labels[k.kind] || k.kind;
        const colour = colours[k.kind] || '#8a8f99';
        const share = Math.round((k.total / grand) * 100);
        return el('button', { class: 'catrow',
          'aria-label': `${label}: ${bankMoney(k.total)} across ${k.count} transaction${k.count === 1 ? '' : 's'}`,
          onclick: () => scrollToTx() },
          el('span', { class: 'cat-tag cat-name' },
            el('span', { class: 'cat-dot', style: `background:${colour}` }),
            el('span', { class: 'cat-tag-name' }, label)),
          el('span', { class: 'cat-track' }, el('span', { class: 'cat-fill', style: `width:${Math.max(3, (k.total / maxTotal) * 100)}%;background:${colour}` })),
          el('span', { class: 'cat-amt' }, bankMoney(k.total), el('span', { class: 'cat-pct' }, `${share}%`)));
      };
      appendExpandable(el, list, ordered, renderKindRow, { initial: 7 });
      sec.append(list);
      sec.append(renderExplainer(el, _kindShowInternal
        ? 'Every movement grouped by what it was, including transfers between your own accounts. Ordered by value, largest first.'
        : 'Money grouped by what it was for - income, payments to people, bills, fees, tax and cash - ordered by value, largest first. Transfers between your own accounts are folded out; use the toggle to include them.', { label: 'How this is grouped' }));
      wrap.append(sec);
    }

    // Money in and out over time, closing the analytical block: what's new ->
    // who/where -> what it was -> over time.
    const trendCard = renderBankTrend();
    if (trendCard) wrap.append(trendCard);

    const showBalance = !multi || state.bankAccount !== 'all';
    const shownRecs = (multi && state.bankAccount !== 'all')
      ? recs.filter((r) => r.account === state.bankAccount) : recs;

    function buildAcctTxCard() {
      const f = state.bankFilter;
      const sec = el('section', { class: 'card', id: 'acct-tx' });
      const head = el('div', { class: 'card-head' }, el('h3', { class: 'card-title' }, icon(iconList()), 'Transactions'));
      head.append(el('button', { class: 'btn sm ghost', onclick: () => { state.bankShowAllTx = !state.bankShowAllTx; render(); } },
        state.bankShowAllTx ? 'Hide' : 'Show'));
      sec.append(head);
      const chipItems = [];
      if (state.bankAccount !== 'all') chipItems.push({ label: `Account ${state.bankAccount}`, onClear: () => { clearBankFacet('bankAccount'); render(); } });
      if (f.payeeKey) chipItems.push({ label: f.payeeLabel || 'payee', onClear: () => { clearBankFacet('payeeKey'); clearBankFacet('payeeLabel'); refreshAcctTx(); } });
      const chips = renderFilterChips(el, iconX, chipItems, () => { clearBankFacet('bankAccount'); clearBankFacet('payeeKey'); clearBankFacet('payeeLabel'); render(); });
      if (chips) sec.append(chips);
      const filterActive = bankActiveFilterCount() > 0;
      if (!state.bankShowAllTx && !filterActive) {
        const p = resolved();
        const periodLabel = p ? p.label.toLowerCase() : 'this period';
        sec.append(el('p', { class: 'muted pad' },
          `${shownRecs.length} transaction${shownRecs.length === 1 ? '' : 's'} in ${periodLabel}. Use “Show” to search or review them.`));
        return sec;
      }

      // Filter bar: reuses the Cards explorer's .filters / .f-search / .f-check
      // styling, but with only the two controls that make sense for a bank
      // ledger - a search box and one internal-transfers toggle.
      const internalCount = shownRecs.filter((r) => r.internalTransfer).length;
      const searchInput = el('input', { type: 'search', class: 'f-search', placeholder: 'Search counterparty, amount, date…', value: f.search,
        oninput: (e) => { f.search = e.target.value; clearTimeout(_acctSearchDebounce); _acctSearchDebounce = setTimeout(refreshAcctTx, 200); } });
      // The checkbox reads "Show N internal transfers"; checked === show, so it
      // maps to !hideInternal. Only rendered when there are internal rows to
      // toggle, so a clean single-flow view never shows a dead control.
      const internalToggle = internalCount
        ? el('label', { class: 'f-check' }, el('input', { type: 'checkbox', checked: f.hideInternal ? null : '',
            onchange: (e) => { f.hideInternal = !e.target.checked; refreshAcctTx(); } }),
            ` Show ${internalCount} internal transfer${internalCount === 1 ? '' : 's'}`)
        : null;
      sec.append(el('div', { class: 'filters' }, searchInput, internalToggle));

      // Always newest-first (running balance is only coherent chronologically),
      // then apply the internal-transfers and search filters.
      let rows = shownRecs.slice().sort((x, y) => (x.date < y.date ? 1 : x.date > y.date ? -1 : 0));
      if (f.hideInternal) rows = rows.filter((r) => !r.internalTransfer);
      // Payee drill-down: same key derivation bankCounterpartyGroups /
      // externalOutflowShortlist / detectBankStandingDebits already group by,
      // so a row clicked in any of those three cards resolves to exactly the
      // transactions that fed its total.
      if (f.payeeKey) rows = rows.filter((r) =>
        (r.counterpartyKey || ('ext:' + String(r.description || 'unknown').toUpperCase())) === f.payeeKey);
      if (f.search) {
        const q = f.search.trim().toLowerCase();
        rows = rows.filter((r) =>
          (cleanCounterparty(r.description) || '').toLowerCase().includes(q) ||
          String(r.description || '').toLowerCase().includes(q) ||
          String(r.type || '').toLowerCase().includes(q) ||
          String(r.date || '').includes(q) ||
          String(Math.abs(Number(r.amount) || 0).toFixed(2)).includes(q));
      }

      if (!rows.length) {
        sec.append(el('p', { class: 'muted pad' }, (f.search || f.hideInternal || f.payeeKey)
          ? 'No transactions match. Clear the search, show internal transfers, or clear the payee filter, to see more.'
          : 'No account transactions yet.'));
        return sec;
      }

      const table = el('table', { class: 'grid banktx' });
      const headCells = [el('th', {}, 'Date')];
      if (!showBalance) headCells.push(el('th', {}, 'Account'));
      headCells.push(el('th', {}, 'Counterparty'), el('th', {}, 'Flow'), el('th', { class: 'num' }, 'Amount'));
      if (showBalance) headCells.push(el('th', { class: 'num' }, 'Balance'));
      table.append(el('thead', {}, el('tr', {}, ...headCells)));
      const body = el('tbody');

      const renderTxRow = (r) => {
        const flow = r.internalTransfer ? 'Internal'
          : r.roundTrip ? 'Round-trip'
          : (r.household ? 'Household' : (r.excludedFromIncome ? 'Not income' : (r.direction === 'in' ? 'In' : 'Out')));
        const cells = [el('td', { class: 'nowrap' }, r.date)];
        if (!showBalance) cells.push(el('td', { class: 'muted nowrap' }, r.account || '—'));
        // Internal rows read "Transfer between your accounts" for DISPLAY ONLY;
        // the record, grouping, pair-picker and every figure are untouched.
        const cpLabel = r.internalTransfer ? 'Transfer between your accounts' : (cleanCounterparty(r.description) || r.type || '—');
        const cpCell = el('td', {}, el('div', { class: 'desc' }, cpLabel));
        if (!r.internalTransfer && !r.roundTrip && !r.household && !r.excludedFromIncome) {
          cpCell.append(el('button', { class: 'linkbtn small', title: 'Mark as a confirmed round-trip (a matched pair)',
            onclick: () => openRoundTripPicker(r, recsAll) }, 'pair'));
        }
        // Bank-domain flow classes (not the borrowed Cards k-fee/k-refund).
        const flowCls = r.internalTransfer || r.roundTrip ? 'k-internal'
          : r.household ? 'k-household'
          : r.excludedFromIncome ? 'k-notincome'
          : r.direction === 'in' ? 'k-in' : 'k-out';
        cells.push(
          cpCell,
          el('td', {}, renderKindTag(el, flow, flowCls)),
          el('td', { class: 'num amt ' + (r.direction === 'in' ? 'credit' : '') }, (r.direction === 'in' ? '+' : '') + bankMoney(r.amount, r.currency)));
        if (showBalance) cells.push(el('td', { class: 'num muted' }, r.balanceAfter == null ? '' : bankMoney(r.balanceAfter, r.currency)));
        return el('tr', { class: (r.internalTransfer || r.roundTrip || r.household || r.excludedFromIncome) ? 'bank-internal' : '' }, ...cells);
      };

      // Cap via the shared helper. wrapToggle wraps the toggle in a full-width
      // <tr><td colspan> so it is valid inside <tbody> (the helper documents
      // exactly this table case). 12 initial rows: enough to be useful, capped
      // enough to stop being a wall.
      appendExpandable(el, body, rows, renderTxRow, {
        initial: 12,
        wrapToggle: (btn) => el('tr', {}, el('td', { colspan: headCells.length }, el('div', { class: 'show-more' }, btn))),
      });
      table.append(body);
      sec.append(el('div', { class: 'table-wrap' }, table));

      // Note adapts to whether the balance column is shown and whether internal
      // rows are hidden. When hidden with a balance column, it is honest that
      // the running balance still reflects the hidden internal activity, so a
      // "jump" between visible balances is not a bug.
      const note = showBalance
        ? (f.hideInternal
          ? 'Internal transfers between your own accounts are hidden and left out of money in and out above. The running balance still reflects them, so a gap between two shown balances is a hidden internal move.'
          : 'Internal rows are transfers between your own accounts and are left out of money in and out above.')
        : (f.hideInternal
          ? 'Internal transfers between your own accounts are hidden. Select an account above to see a running balance.'
          : 'Showing every account. Select an account above to see a running balance. Internal rows are transfers between your own accounts.');
      sec.append(el('p', { class: 'muted small' }, note));
      return sec;
    }

    // In-place refresh of ONLY the transaction card on search/toggle (keeps the
    // rest of the Accounts tab untouched and keeps search focus), the bank twin
    // of cards-render's renderExplorerOnly.
    function refreshAcctTx() {
      const old = document.getElementById('acct-tx');
      if (!old) { render(); return; }
      const next = buildAcctTxCard();
      old.replaceWith(next);
      const s = next.querySelector('.f-search');
      if (s) { s.focus(); s.setSelectionRange(s.value.length, s.value.length); }
    }

    const listSec = buildAcctTxCard();
    const standingAll = detectBankStandingDebits(recsAll);
    const standing = standingAll.filter((s) => s.status !== 'lapsed');
    const standingLapsed = standingAll.filter((s) => s.status === 'lapsed');
    if (standingAll.length) {
      const sec = el('section', { class: 'card acct-standing' });
      sec.append(el('div', { class: 'card-head' }, el('h3', { class: 'card-title' }, icon(iconRepeat()), 'Regular payments from your bank account')));
      if (standing.length) {
        const list = el('div', { class: 'recurring-list' });
        const renderStandingRow = (s) => el('button', { class: 'recurring-row',
          'aria-label': `${s.label}: about ${bankMoney(s.typical)} a month, ${s.months} month${s.months === 1 ? '' : 's'}`,
          onclick: () => drillToPayee(s.key, cleanCounterparty(s.label)) },
          el('span', { class: 'recurring-name' }, kindDot(s.key), cleanCounterparty(s.label)),
          el('span', { class: 'recurring-months muted small' }, `${s.months} month${s.months === 1 ? '' : 's'}`),
          el('span', { class: 'recurring-amt num strong' }, `${bankMoney(s.typical)}/mo`));
        appendExpandable(el, list, standing, renderStandingRow, { initial: 5 });
        sec.append(list);
      } else {
        sec.append(el('p', { class: 'muted pad' }, 'Nothing recurring is currently active - see below.'));
      } 
      if (standingLapsed.length) {
        const lapsedList = el('div', { class: 'recurring-list' });
        const renderLapsedRow = (s) => {
          const lastSeen = s.lastMonth ? `last paid ${monthLabel(s.lastMonth)}` : 'last payment unknown';
          return el('button', { class: 'recurring-row',
            'aria-label': `${s.label}: was about ${bankMoney(s.typical)} a month - ${lastSeen}`,
            onclick: () => drillToPayee(s.key, cleanCounterparty(s.label)) },
            el('span', { class: 'recurring-name muted' }, cleanCounterparty(s.label)),
            el('span', { class: 'recurring-months muted small' }, lastSeen),
            el('span', { class: 'recurring-amt num muted' }, `${bankMoney(s.typical)}/mo`));
        };
        appendExpandable(el, lapsedList, standingLapsed, renderLapsedRow, { initial: 5 });
        sec.append(renderExplainer(el, lapsedList, { label: `May have ended (${standingLapsed.length})` }));
      }
      sec.append(renderExplainer(el, 'Regular payments that leave your accounts at a steady amount, across your whole history. This is the account side only; the combined card-and-account total, with its full list, is on the Cards tab. Transfers between your own accounts are not counted here.', { label: 'What\u2019s counted here' }));
      wrap.append(sec);
    }
    if (multi) {
      const accSec = el('section', { class: 'card' });
      accSec.append(el('div', { class: 'card-head' }, el('h3', { class: 'card-title' }, icon(iconInfo()), 'By account')));
      const list = el('div', { class: 'recurring-list' });
      const renderAcctRow = (ac) => {
        const cur = ac.currency;
        return el('button', { class: 'stmt-row acct-row' + (state.bankAccount === ac.account ? ' selected' : ''),
          onclick: () => drillToAccount(ac.account) },
          el('div', { class: 'stmt-body' },
            el('div', { class: 'strong' }, `Account ${ac.account}${cur && cur !== state.cfg.currency.code ? ' · ' + cur : ''}`),
            el('div', { class: 'muted small' }, `${ac.n} transaction${ac.n === 1 ? '' : 's'} · in ${bankMoney(ac.cashIn, cur)} · out ${bankMoney(ac.cashOut, cur)}`)),
          el('span', { class: 'num strong' }, ac.closingBalance == null ? '—' : bankMoney(ac.closingBalance, cur)));
      };
      appendExpandable(el, list, a.accounts, renderAcctRow, { initial: 5 });
      accSec.append(list);
      accSec.append(el('p', { class: 'muted small' }, a.foreignAccounts && a.foreignAccounts.length
        ? 'Select an account to show only its transactions. Foreign-currency accounts are shown in their own currency and are never added into your JMD totals.'
        : 'Select an account to show only its transactions with a running balance.'));
      wrap.append(accSec);
    }

    wrap.append(listSec);

    // My-accounts editor: resolves single-legged transfers to the unseen
    // account (D9). Kept minimal - a comma-separated list of account tails.
    const myacc = el('section', { class: 'card' });
    myacc.append(el('div', { class: 'card-head' }, el('h3', { class: 'card-title' }, icon(iconList()), 'My accounts')));
    myacc.append(el('p', { class: 'muted small' }, 'List the last few digits of accounts that are your own (for example 1234). Transfers to these are treated as moving your own money, not spending.'));
    const input = el('input', { type: 'text', class: 'pass', style: 'margin-bottom:8px',
      value: state.myAccounts.join(', '), placeholder: 'e.g. 1234, 1234' });
    myacc.append(input);
    myacc.append(el('button', { class: 'btn sm', onclick: async () => {
      state.myAccounts = String(input.value).split(',').map((s) => s.trim()).filter(Boolean);
      await Store.setMeta('bankMyAccounts', state.myAccounts);
      render();
      toast('Updated your accounts list.');
    } }, 'Save'));
    wrap.append(myacc);
    return wrap;
  }

  function cleanCounterparty(desc) {
    let s = cleanBankCounterparty(desc);                  // strip stray header fragments first
    s = s.replace(/^transfer\s+(to|from)\s+/i, '');
    s = s.replace(/^trf\s+to:?\s+/i, '');
    s = s.replace(/^\d{2,}[,\s-]+/, '');                  // leading ref group "12, " / "12345 "
    s = s.replace(/^\d{4,}-/, '');                        // "1234-" style prefix
    s = s.replace(/[\s,-]+\d{3,}\s*$/, '').trim();        // trailing account tail
    s = s.replace(/[\s-]+$/, '').trim();                  // dangling dash

    return smartTitle(s, CP_LABEL_SET, CP_LABEL_SET);
  }

  // Confirm a cash/ABM deposit as the person's own income (moves it back into
  // "money in"). Reversible from the same list.
  async function confirmDepositAsIncome(id, on) {
    const set = new Set(state.confirmedIncomeIds || []);
    if (on) set.add(id); else set.delete(id);
    state.confirmedIncomeIds = [...set];
    await persistLedgerRules(); render();
  }
  // Mark (or clear) a confirmed round-trip pair by the two transaction ids. Both
  // legs are then netted out of money in and money out. No auto-matching: the
  // person chooses the two rows.
  async function setRoundTrip(ids, on) {
    const set = new Set(state.roundTripIds || []);
    for (const id of ids) { if (on) set.add(id); else set.delete(id); }
    state.roundTripIds = [...set];
    await persistLedgerRules(); render();
  }
  // Open a small picker to confirm a round-trip: given one external row, list
  // the opposite-direction external rows with the SAME amount (the only
  // candidates), and let the person pick the matching leg. Nothing is matched
  // automatically.
  function openRoundTripPicker(row, allRows) {
    closePicker();
    // D-audit item 11. Candidates are opposite-direction, same-amount rows. Unlike
    // linkCardPayments (fully automatic, so it needs a tight 4-day window to avoid
    // a wrong pairing), this is a manual, user-confirmed pairing where the two legs
    // can legitimately be far apart - a car-import down-payment and its later refund
    // may be weeks or months apart - so a hard time window would hide a genuine pair
    // and is deliberately NOT applied. Instead the candidates are ordered by date
    // proximity to the row being paired, so the most likely match sits at the top of
    // the list while a distant one is still reachable.
    const dayMs = 86400000;
    const toT = (iso) => { const p = String(iso || '').split('-').map(Number); return Date.UTC(p[0], (p[1] || 1) - 1, p[2] || 1); };
    const rowT = toT(row.date);
    const cands = allRows.filter((r) => r.id !== row.id && !r.internalTransfer && !r.roundTrip
      && r.direction !== row.direction && Math.abs(Math.abs(r.amount) - Math.abs(row.amount)) < 0.01)
      .sort((a, b) => Math.abs(toT(a.date) - rowT) - Math.abs(toT(b.date) - rowT));
    const list = el('div', { class: 'picker-list' });
    if (!cands.length) list.append(el('div', { class: 'picker-empty muted small' }, 'No opposite-direction transaction with the same amount was found to pair with.'));
    for (const c of cands) {
      const apart = Math.round(Math.abs(toT(c.date) - rowT) / dayMs);
      list.append(el('button', { class: 'picker-item', onclick: () => { closePicker(); setRoundTrip([row.id, c.id], true); toast('Marked as a confirmed round-trip. Both legs are now excluded.'); } },
        `${c.date} · ${apart}d apart · ${c.direction === 'in' ? 'in' : 'out'} ${bankMoney(Math.abs(c.amount))} · ${cleanCounterparty(c.description) || c.type || '—'}`));
    }
    const box = el('div', { class: 'picker wide', role: 'dialog', 'aria-label': 'Confirm a round-trip' },
      el('div', { class: 'picker-head' }, `Pair ${row.date} · ${bankMoney(Math.abs(row.amount))} with its return`),
      el('p', { class: 'muted small' }, 'Choose the matching transaction. Both will be excluded from money in and money out together. This never happens automatically.'),
      list,
      el('div', { class: 'picker-actions' }, el('button', { class: 'btn sm ghost', onclick: closePicker }, 'Cancel')));
    openModal(box);
  }
  // The compact "Review & adjustments" card for the Accounts view: surfaces the
  // amounts kept out of the headline (cash/ABM deposits, household support,
  // confirmed round-trips) and gives one obvious control per decision. Chunked
  // into one place rather than scattered through the dense table.
  function renderLedgerReview(a, recs) {
    const deposits = recs.filter((r) => r.cashDeposit && r.excludedFromIncome);
    const confirmed = recs.filter((r) => r.cashDeposit && !r.excludedFromIncome);
    const roundTrips = recs.filter((r) => r.roundTrip);
    if (!deposits.length && !confirmed.length && !roundTrips.length && !(a.householdSupport > 0)) return null;
    const sec = el('section', { class: 'card' });
    sec.append(el('div', { class: 'card-head' }, el('h3', { class: 'card-title' }, icon(iconInfo()), 'Review & adjustments')));
    if (deposits.length) {
      sec.append(el('p', { class: 'muted small' }, `${bankMoney(a.cashDeposits)} in cash/ABM deposits are not counted as income by default, because a machine deposit can be your own cash or cash for someone else. Confirm any that are genuinely your income.`));
      const list = el('div', { class: 'recurring-list' });
      const renderDepositRow = (r) => el('div', { class: 'recurring-row' },
        el('span', { class: 'recurring-name' }, `${r.date} · ${cleanCounterparty(r.description) || r.type || 'Deposit'}`),
        el('span', { class: 'recurring-amt num strong' }, bankMoney(r.amount)),
        el('button', { class: 'btn sm', onclick: () => confirmDepositAsIncome(r.id, true) }, 'Count as income'));
      appendExpandable(el, list, deposits, renderDepositRow, { initial: 5 });
      sec.append(list);
    }
    // Already-confirmed deposits and already-excluded round-trips are both
    // SETTLED, reference-only entries - the decision is already made, so
    // neither needs action and neither should sit at the same full visual
    // weight as the deposits list above (which is still awaiting a decision).
    // Both now use the one shared collapsed-but-discoverable disclosure
    // (renderExplainer) this app already uses for "How this is worked out"
    // and "More filters": closed by default, an info icon and a rotating
    // chevron naming the exact count up front, reachable by Tab and opened
    // with Enter/Space via the native <details>/<summary> element, with no
    // extra ARIA needed.
    if (confirmed.length) {
      const list = el('div', { class: 'recurring-list' });
      const renderConfirmedRow = (r) => el('div', { class: 'recurring-row' },
        el('span', { class: 'recurring-name muted' }, `${r.date} · counted as income · ${cleanCounterparty(r.description) || r.type || 'Deposit'}`),
        el('span', { class: 'recurring-amt num' }, bankMoney(r.amount)),
        el('button', { class: 'btn sm ghost', onclick: () => confirmDepositAsIncome(r.id, false) }, 'Undo'));
      appendExpandable(el, list, confirmed, renderConfirmedRow, { initial: 5 });
      sec.append(renderExplainer(el, list, { label: `Confirmed as income (${confirmed.length})` }));
    }
    if (a.householdSupport > 0) {
      sec.append(el('p', { class: 'muted small', style: 'margin-top:8px' }, `Support to household: ${bankMoney(a.householdSupport)} sent from your shared account to a household member. This is tracked here but kept out of your personal money-out figure.`));
    }
    if (roundTrips.length) {
      const list = el('div', { class: 'recurring-list' });
      const seen = new Set();
      const dedupedTrips = roundTrips.filter((r) => (seen.has(r.id) ? false : (seen.add(r.id), true)));
      const renderRoundTripRow = (r) => el('div', { class: 'recurring-row' },
        el('span', { class: 'recurring-name muted' }, `${r.date} · ${r.direction === 'in' ? 'in' : 'out'} · ${cleanCounterparty(r.description) || r.type || '—'}`),
        el('span', { class: 'recurring-amt num' }, bankMoney(r.amount)),
        el('button', { class: 'btn sm ghost', onclick: () => setRoundTrip([r.id], false) }, 'Unmark'));
      appendExpandable(el, list, dedupedTrips, renderRoundTripRow, { initial: 5 });
      sec.append(renderExplainer(el, list, { label: `Confirmed round-trips, excluded from money in and money out (${dedupedTrips.length})` }));
    }
    return sec;
  }

  // Account-statement reconciliation, relocated into "Data & settings" to
  // mirror renderCardStatementTrust on the card side: each ledger keeps its own
  // reconciliation line beside its management actions, not as a prominent card
  // in the main flow. Returns a .sec-section (the same shape the card version
  // returns, so the existing .secondary .sec-section styling applies), or null
  // when no bank statements are stored. Sorting is unchanged from the former
  // card: most recent first, unparseable periods last, account as a stable
  // tiebreaker. A one-line "N of M reconcile" summary leads, matching the card
  // line, then the full per-statement list stays available via appendExpandable.
  // Account statements: the one place a person comes to answer "can I trust that
  // what the rest of the app shows is my complete, accurate, current history".
  // That splits into accuracy (do the figures add up), completeness (is any
  // month missing) and freshness (how current is it). This leads with the
  // plain-language verdict, then states coverage + completeness in one line and
  // freshness in another, then gives ONE row per account (its own span, count
  // and reconcile health) instead of a flat wall of per-statement rows - so it
  // scales as more accounts and banks are added, and each account's own history
  // can be judged at a glance. Returns a .sec-section (styled by the existing
  // .secondary .sec-section rules) or null when nothing is stored.
  function renderBankStatementTrust() {
    const stmts = (state._bankStatements || []);
    if (!stmts.length) return null;

    // The month keys a "DD Mon YYYY - DD Mon YYYY" period string covers, first
    // to last inclusive. Presentation only; no stored value changes.
    const MON = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
    const periodMonths = (period) => {
      const re = /(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})/g;
      const dates = [];
      let m;
      while ((m = re.exec(String(period || ''))) !== null) {
        const mo = MON[m[2].toLowerCase()];
        if (mo != null) dates.push(`${m[3]}-${String(mo + 1).padStart(2, '0')}`);
      }
      if (!dates.length) return [];
      const start = dates[0], end = dates[dates.length - 1];
      const out = [];
      let ym = start, guard = 0;
      while (ym <= end && guard < 360) {
        out.push(ym);
        const [y, mo] = ym.split('-').map(Number);
        const d = new Date(Date.UTC(y, mo, 1)); // step to the next calendar month
        ym = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
        guard++;
      }
      return out;
    };

    // Group by account, union the covered months across every statement (a
    // period's own span PLUS any month that carries a transaction, so a quiet
    // month that still has a statement is never mis-read as a gap), and track
    // the newest import for the freshness line.
    const byAccount = new Map();
    const coveredAll = new Set(bankMonthsList());
    let latestImport = null;
    for (const s of stmts) {
      const acc = s.account || '—';
      if (!byAccount.has(acc)) byAccount.set(acc, { account: acc, statements: [], months: new Set(), reconciled: 0 });
      const g = byAccount.get(acc);
      g.statements.push(s);
      if (s.reconciled) g.reconciled++;
      for (const ym of periodMonths(s.period)) { g.months.add(ym); coveredAll.add(ym); }
      if (s.importedAt && (!latestImport || s.importedAt > latestImport)) latestImport = s.importedAt;
    }

    const totalN = stmts.length;
    const totalOk = stmts.filter((s) => s.reconciled).length;
    const allOk = totalOk === totalN;
    const accountsN = byAccount.size;
    const coveredMonths = [...coveredAll].filter(Boolean).sort();
    const first = coveredMonths[0] || null;
    const last = coveredMonths[coveredMonths.length - 1] || null;
    const gaps = missingMonths(coveredMonths);
    const spanText = first ? (first === last ? monthLabel(first) : `${monthLabel(first)} - ${monthLabel(last)}`) : '\u2014';

    const wrap = el('div', { class: 'sec-section' });

    // Heading carries a status pill on its right, so the verdict is the first
    // thing seen, coloured (calm green / caution) without relying on colour alone.
    wrap.append(el('div', { class: 'sec-subhead stmt-head' },
      el('span', { class: 'stmt-head-title' }, icon(iconReceipt()), ' Account statements'),
      el('span', { class: 'pill ' + (allOk ? 'ok' : 'caution') },
        allOk ? '\u2713 All add up' : `${totalN - totalOk} need a look`)));

    // Three compact tiles: accuracy, coverage span, freshness. One glance answers
    // "do the figures add up, how much history is here, and how current is it".
    const stat = (value, label, dotTone) => el('div', { class: 'stmt-stat' },
      el('div', { class: 'stmt-stat-value' },
        dotTone ? el('span', { class: 'stmt-dot ' + dotTone }) : null,
        value),
      el('div', { class: 'stmt-stat-label' }, label));
    wrap.append(el('div', { class: 'stmt-summary' },
      stat(`${totalOk}/${totalN}`, allOk ? 'Statements reconcile' : 'Reconcile, rest need a look', allOk ? 'good' : 'warn'),
      stat(spanText, `Covered \u00b7 ${accountsN} account${accountsN === 1 ? '' : 's'}`),
      stat(latestImport ? new Date(latestImport).toLocaleDateString(state.cfg.currency.locale) : '\u2014', 'Last updated')));

    // Completeness line: name any month inside the covered span with no
    // statement - the one thing a list of present statements can never show.
    if (first && last && first !== last) {
      wrap.append(el('p', { class: 'muted small stmt-note' }, gaps.length
        ? `No statement for ${gaps.slice(0, 3).map(monthLabel).join(', ')}${gaps.length > 3 ? ` and ${gaps.length - 3} more` : ''}, so that stretch is incomplete. Add those PDFs for a full picture.`
        : 'Every month in that range has a statement, so nothing is missing.'));
    }

    // One row per account: its own span, statement count and health. Accounts
    // holding a statement that did not reconcile sort first, then by number.
    const accounts = [...byAccount.values()].map((g) => {
      const ms = [...g.months].filter(Boolean).sort();
      return { account: g.account, n: g.statements.length, failed: g.statements.length - g.reconciled, first: ms[0] || null, last: ms[ms.length - 1] || null };
    }).sort((a, b) => (b.failed - a.failed) || String(a.account).localeCompare(String(b.account)));

    // One compact tile per account: a peer object a person scans and compares,
    // so tiles wrap into columns on desktop and collapse to one column on
    // mobile (styles.css .stmt-grid), rather than full-width rows that waste
    // desktop width and grow the scroll as accounts are added. Health colour is
    // always paired with a word and a dot, never colour alone.
    const renderAccountCard = (g) => {
      const span = g.first ? (g.first === g.last ? monthLabel(g.first) : `${monthLabel(g.first)} - ${monthLabel(g.last)}`) : 'no dated statements';
      const health = g.failed
        ? el('span', { class: 'recon-warn' }, `${g.failed} of ${g.n} need a look`)
        : el('span', { class: 'recon-ok' }, '\u2713 all reconcile');
      return el('div', { class: 'stmt-card' + (g.failed ? ' attn' : '') },
        el('div', { class: 'stmt-card-head' },
          el('span', { class: 'stmt-dot ' + (g.failed ? 'warn' : 'good') }),
          el('span', { class: 'stmt-card-name' }, `Account ${g.account}`)),
        el('div', { class: 'stmt-card-meta muted small' }, `${span} \u00b7 ${g.n} statement${g.n === 1 ? '' : 's'}`),
        el('div', { class: 'stmt-card-health' }, health));
    };

    // Accounts needing a look are surfaced up front and never hidden; healthy,
    // all-reconciling accounts fold into a collapsed native disclosure (the same
    // pattern as the app's explainers) so a clean ledger reads as one calm
    // verdict panel instead of a repeating wall of identical "all reconcile"
    // tiles, and stays that calm as more accounts and banks are added.
    const needAttention = accounts.filter((g) => g.failed);
    const healthy = accounts.filter((g) => !g.failed);

    if (needAttention.length) {
      const grid = el('div', { class: 'stmt-grid' });
      for (const g of needAttention) grid.append(renderAccountCard(g));
      wrap.append(grid);
    }

    if (healthy.length) {
      const details = el('details', { class: 'explainer stmt-accounts-more' });
      details.append(el('summary', {}, `Per-account detail (${healthy.length} account${healthy.length === 1 ? '' : 's'})`));
      const grid = el('div', { class: 'stmt-grid' });
      for (const g of healthy) grid.append(renderAccountCard(g));
      details.append(el('div', { class: 'explainer-body' }, grid));
      wrap.append(details);
    }

    return wrap;
  }

  return { renderAccounts, classifiedBank, bankMoney, cleanCounterparty, renderBankStatementTrust };
}
