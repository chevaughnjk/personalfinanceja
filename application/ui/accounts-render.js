/*
 * accounts-render.js  -  bank-side building blocks reused by Right Now.
 *
 * The Accounts tab itself has retired: its own hero, insights card
 * and full-page transaction view are gone, absorbed and rebuilt inside
 * right-now-render.js. What remains here is the bank-side analysis and the
 * ledger-review controls Right Now genuinely reuses unchanged: classifiedBank
 * (the internal-transfer/ledger-rule classification every tab reads),
 * bankMoney, cleanCounterparty, buildBankInsights, renderBankTrend,
 * renderLedgerReview, and renderBankStatementTrust.
 */

import { cleanBankCounterparty } from '../statements/read-statements.js';
import {
  classifyInternalTransfers,
  applyLedgerRules,
  analyseBankActivity,
  bankFlowOverTime,
  overviewVerdict,
} from '../analysis/bank-analysis.js';
import { smartTitle } from '../statements/categorise.js';
import {
  missingMonths,
  appendExpandable,
  buildBankAppropriateInsights,
  renderExplainer,
} from '../analysis/reporting.js';
import {
  formatMoney,
  smoothScrollToEl,
  requireCtx,
  formatDisplayDate,
  MONTHS_SHORT,
  isPrivacyMode,
} from '../core/shared-helpers.js';


// Shared, empty keep-upper / small-words set for smartTitle when tidying a bank
// counterparty for display (plain Title Case). Kept byte-identical to the set
// read-statements.js uses for the upstream counterparty label, so a payee shown
// through either path reads with exactly the same casing.
const CP_LABEL_SET = new Set();

export function createAccountsRenderer(ctx) {
  requireCtx(
    ctx,
    [
      'state',
      'el',
      'icon',
      'render',
      'persistLedgerRules',
      'bankMonthsList',
      'drillToAccountsPayee',
      'iconInfo',
      'iconReceipt',
      'resolved',
      'bankRecordsInRange',
      'prevLabel',
      'iconUp',
      'iconDown',
      'iconAlert',
      'iconSpark',
      'iconGap',
      'iconBulb',
      'iconChevron',
      'monthLabel',
      'clearFilters',
      'clearBankFilters',
      'trackUsage',
    ],
    'createAccountsRenderer'
  );
  const {
    state,
    el,
    icon,
    render,
    persistLedgerRules,
    bankMonthsList,
    drillToAccountsPayee,
    iconInfo,
    iconReceipt,
    // Bank-appropriate insights (Part 2): period/range helpers reused for the
    // income-change comparison and the large-payment/new-payee checks, plus
    // the extra icons and monthLabel the insights card needs.
    resolved,
    bankRecordsInRange,
    prevLabel,
    iconUp,
    iconDown,
    iconAlert,
    iconSpark,
    iconGap,
    monthLabel,
    clearFilters,
    clearBankFilters,
    trackUsage,
  } = ctx;
  /* ---- Accounts view (Phase 1: read-only, balance-first) ----
   * A minimal cash-flow and balance screen for the bank ledger: Cash inflow,
   * Cash outflow (internal transfers excluded), net movement and the closing
   * balance, then a transaction list carrying the running balance. Internal
   * transfers are shown but set apart. No categorisation, no card merchant
   * rules, no merging with card data (D1). */
  function bankMoney(n, currency) {
    const { symbol = '$', locale = 'en-JM', decimals = 2, code = 'JMD' } = state.cfg.currency || {};
    // A non-base currency (USD) is shown with its own prefix so a US$ figure is
    // never mistaken for a JMD one. The base currency keeps the plain symbol.
    const sym =
      currency && currency !== code ? (currency === 'USD' ? 'US$' : currency + ' ') : symbol;
    return formatMoney(n, sym, locale, decimals);
  }

  let _cbKey = null,
    _cbVal = null;
  function classifiedBank() {
    if (
      _cbKey &&
      _cbKey.br === state.bankRecords &&
      _cbKey.ma === state.myAccounts &&
      _cbKey.ca === state.cardAccounts &&
      _cbKey.rz === state.resolver &&
      _cbKey.ci === state.confirmedIncomeIds &&
      _cbKey.ri === state.refundIncomeIds &&
      _cbKey.sa === state.sharedAccounts &&
      _cbKey.hp === state.householdPayees
    ) {
      return _cbVal;
    }
    const base = classifyInternalTransfers(
      state.bankRecords,
      state.myAccounts,
      state.cardAccounts || [],
      state.resolver
    );
    // Apply the evidence-backed exclusions on top (cash/ABM self-deposits out of
    // income by default, shared-account support to household kept off the
    // personal headline).
    const out = applyLedgerRules(base, {
      confirmedIncomeIds: new Set(state.confirmedIncomeIds || []),
      refundIncomeIds: new Set(state.refundIncomeIds || []),
      sharedAccounts: state.sharedAccounts || [],
      householdPayees: state.householdPayees || [],
    });
    _cbKey = {
      br: state.bankRecords,
      ma: state.myAccounts,
      ca: state.cardAccounts,
      rz: state.resolver,
      ci: state.confirmedIncomeIds,
      ri: state.refundIncomeIds,
      sa: state.sharedAccounts,
      hp: state.householdPayees,
    };
    _cbVal = out;
    // INVARIANT: this array is now shared by reference across every caller
    // and across renders. Callers must treat it and its rows as READ-ONLY
    // (filter and read, never mutate a row in place), or the mutation will
    // silently reach every other view holding the same cached result.
    return out;
  }
  const _bankAnalysisCache = [];
  const _BANK_ANALYSIS_CACHE_MAX = 24;
  function bankAnalysis(fn, ...args) {
    for (const e of _bankAnalysisCache) {
      if (e.fn === fn && e.args.length === args.length && e.args.every((a, i) => a === args[i]))
        return e.value;
    }
    const value = fn(...args);
    _bankAnalysisCache.push({ fn, args, value });
    if (_bankAnalysisCache.length > _BANK_ANALYSIS_CACHE_MAX) _bankAnalysisCache.shift();
    return value;
  }

  let _rangeRecsAll = null,
    _rangeRecsFrom = null,
    _rangeRecsTo = null,
    _rangeRecsVal = null;
  function rangeRecs(recsAll, from, to) {
    if (_rangeRecsAll === recsAll && _rangeRecsFrom === from && _rangeRecsTo === to)
      return _rangeRecsVal;
    _rangeRecsVal = bankRecordsInRange(recsAll, from, to);
    _rangeRecsAll = recsAll;
    _rangeRecsFrom = from;
    _rangeRecsTo = to;
    return _rangeRecsVal;
  }

  function buildBankInsights(a, recs, recsAll) {
    const p = resolved();
    let prevIncome = null;
    if (p && p.prevFrom && p.prevTo) {
      const prevRecs = rangeRecs(recsAll, p.prevFrom, p.prevTo);
      prevIncome = bankAnalysis(analyseBankActivity, prevRecs).cashIn;
    }
    let verdict = null;
    if (p) {
      const trend = bankAnalysis(bankFlowOverTime, recs).map((t) => ({
        month: t.month,
        net: t.net,
      }));
      verdict = overviewVerdict({ netCashFlow: a.net, trend });
    }
    return buildBankAppropriateInsights({
      recsAll,
      period: p,
      cfg: state.cfg,
      currentIncome: a.cashIn,
      prevIncome,
      verdict,
      bankMoney,
      prevLabel,
      monthLabel,
      bankMonthsList,
      onNavigate: () => scrollToTx(),
      onDrillToPayee: (key, label) => drillToPayee(key, cleanCounterparty(label)),
      icons: {
        up: iconUp,
        down: iconDown,
        alert: iconAlert,
        spark: iconSpark,
        gap: iconGap,
        info: iconInfo,
      },
    });
  }
  // Scroll target shared by every Accounts insight that has no more specific
  // destination: the transaction list below (id="acct-tx", set in
  // renderAccounts). Accounts has no filter/search system to drill into
  // (unlike Cards' explorer), so every insight click surfaces the same real
  // transaction list the figures above already summarise.
  function scrollToTx() {
    if (!state.bankShowAllTx) {
      state.bankShowAllTx = true;
      render();
    }
    smoothScrollToEl('#acct-tx');
  }

  function drillToPayee(key, label) {
    drillToAccountsPayee(key, label);
  }

  function renderBankTrend() {
    const trend = bankAnalysis(bankFlowOverTime, classifiedBank());
    if (!trend.length) return null;
    const p = resolved();
    const monShort = (m) => {
      const x = /-(\d{2})$/.exec(m);
      return x ? MONTHS_SHORT[+x[1] - 1] : m;
    };
    const shown = trend.slice(-12);
    const H = 150;
    const max = Math.max(1, ...shown.map((t) => Math.max(t.moneyIn, t.moneyOut)));
    const sec = el('section', { class: 'card' });
    sec.append(
      el(
        'div',
        { class: 'card-head' },
        el('h3', { class: 'card-title' }, icon(iconSpark()), 'Cash in and out over time')
      )
    );
    sec.append(
      el(
        'div',
        { class: 'acct-trend-legend muted small' },
        el(
          'span',
          { class: 'acct-trend-key' },
          el('span', { class: 'acct-trend-swatch in' }),
          'Cash inflow'
        ),
        el(
          'span',
          { class: 'acct-trend-key' },
          el('span', { class: 'acct-trend-swatch out' }),
          'Cash outflow'
        )
      )
    );
    const chart = el('div', { class: 'trend acct-trend' });
    const bars = el('div', { class: 'acct-trend-bars' });
    for (const t of shown) {
      const inPeriod = p && t.month >= p.from && t.month <= p.to;
      bars.append(
        el(
          'button',
          {
            class: 'acct-trend-col' + (inPeriod ? ' in-period' : ''),
            'aria-label': isPrivacyMode()
              ? `${t.month}: amounts hidden. Focus this month.`
              : `${t.month}: in ${bankMoney(t.moneyIn)}, out ${bankMoney(t.moneyOut)}. Focus this month.`,

            title: `${t.month}: in ${bankMoney(t.moneyIn)} \u00b7 out ${bankMoney(t.moneyOut)}`,
            onclick: () => {
              state.period = { type: 'custom', from: t.month, to: t.month };
              clearFilters();
              clearBankFilters();
              state.showAllTx = false;
              state.bankShowAllTx = false;
              render();
            },
          },
          el(
            'div',
            { class: 'acct-trend-pair' },
            el('span', {
              class: 'acct-trend-bar in',
              style: `height:${Math.max(2, (t.moneyIn / max) * H)}px`,
            }),
            el('span', {
              class: 'acct-trend-bar out',
              style: `height:${Math.max(2, (t.moneyOut / max) * H)}px`,
            })
          ),
          el('span', { class: 'acct-trend-mlabel' }, monShort(t.month))
        )
      );
    }
    chart.append(bars);
    sec.append(chart);
    sec.append(
      renderExplainer(
        el,
        'Money arriving in and leaving your accounts each month, transfers between your own accounts excluded. Select a month to focus the tab on it.',
        { label: 'How this chart is worked out' }
      )
    );
    return sec;
  }

  function cleanCounterparty(desc) {
    let s = cleanBankCounterparty(desc); // strip stray header fragments first
    s = s.replace(/^transfer\s+(to|from)\s+/i, '');
    s = s.replace(/^trf\s+to:?\s+/i, '');
    s = s.replace(/^\d{2,}[,\s-]+/, ''); // leading ref group "12, " / "12345 "
    s = s.replace(/^\d{4,}-/, ''); // "1234-" style prefix
    s = s.replace(/[\s,-]+\d{3,}\s*$/, '').trim(); // trailing account tail
    s = s.replace(/[\s-]+$/, '').trim(); // dangling dash

    return smartTitle(s, CP_LABEL_SET, CP_LABEL_SET);
  }

  // Confirm a cash/ABM deposit as the person's own income (moves it back into
  // "Cash inflow"). Reversible from the same list.
  async function confirmDepositAsIncome(id, on) {
    if (on) trackUsage('confirm-deposit-income');
    const set = new Set(state.confirmedIncomeIds || []);
    if (on) set.add(id);
    else set.delete(id);
    state.confirmedIncomeIds = [...set];
    await persistLedgerRules();
    render();
  }
  // Confirm a refund/reversal as the person's own income (moves it back into
  // "Cash inflow"). Reversible from the same list.
  async function confirmRefundAsIncome(id, on) {
    if (on) trackUsage('confirm-refund-income');
    const set = new Set(state.refundIncomeIds || []);
    if (on) set.add(id);
    else set.delete(id);
    state.refundIncomeIds = [...set];
    await persistLedgerRules();
    render();
  }
  // The compact "Review & adjustments" card for the Accounts view: surfaces the
  // amounts kept out of the headline (cash/ABM deposits, household support,
  // refunds, confirmed round-trips) and gives one obvious control per decision.
  // Chunked into one place rather than scattered through the dense table.
  function renderLedgerReview(a, recs) {
    const deposits = recs.filter((r) => r.cashDeposit && r.excludedFromIncome);
    const confirmed = recs.filter((r) => r.cashDeposit && !r.excludedFromIncome);
    const refunds = recs.filter((r) => r.refundLike && r.refund);
    const confirmedRefunds = recs.filter((r) => r.refundLike && !r.refund);
    if (
      !deposits.length &&
      !confirmed.length &&
      !(a.householdSupport > 0) &&
      !refunds.length &&
      !confirmedRefunds.length
    )
      return null;
    const sec = el('section', { class: 'card acct-review' });
    sec.append(
      el(
        'div',
        { class: 'card-head' },
        el('h3', { class: 'card-title' }, icon(iconInfo()), 'Review & adjustments')
      )
    );
    if (deposits.length) {
      sec.append(
        el(
          'p',
          { class: 'muted small' },
          `${bankMoney(a.cashDeposits)} in cash/ABM deposits are not yet confirmed as income, because a machine deposit can be your own cash or cash for someone else. Confirm any that are genuinely your income.`
        )
      );
      const list = el('div', { class: 'recurring-list' });
      const renderDepositRow = (r) =>
        el(
          'div',
          { class: 'recurring-row' },
          el(
            'span',
            { class: 'recurring-name' },
            `${formatDisplayDate(r.date)} · ${cleanCounterparty(r.description) || r.type || 'Deposit'}`
          ),
          el('span', { class: 'recurring-amt num strong' }, bankMoney(r.amount)),
          el(
            'button',
            {
              class: 'btn sm',
              onclick: () => confirmDepositAsIncome(r.id, true),
            },
            'Count as income'
          )
        );
      appendExpandable(el, list, deposits, renderDepositRow, { initial: 5 });
      sec.append(list);
    }

    if (confirmed.length) {
      const list = el('div', { class: 'recurring-list' });
      const renderConfirmedRow = (r) =>
        el(
          'div',
          { class: 'recurring-row' },
          el(
            'span',
            { class: 'recurring-name muted' },
            `${formatDisplayDate(r.date)} · ${cleanCounterparty(r.description) || r.type || 'Deposit'}`
          ),
          el('span', { class: 'recurring-amt num' }, bankMoney(r.amount)),
          el(
            'button',
            {
              class: 'btn sm ghost',
              onclick: () => confirmDepositAsIncome(r.id, false),
            },
            'Undo'
          )
        );
      appendExpandable(el, list, confirmed, renderConfirmedRow, { initial: 5 });
      sec.append(
        renderExplainer(el, list, {
          label: `Confirmed as income (${confirmed.length})`,
        })
      );
    }
    if (a.householdSupport > 0) {
      sec.append(
        el(
          'p',
          { class: 'muted small', style: 'margin-top:8px' },
          `Support to household: ${bankMoney(a.householdSupport)} sent from your shared account to a household member. This is tracked here but kept out of your personal money-out figure.`
        )
      );
    }
    if (a.refunds > 0 || confirmedRefunds.length) {
      if (a.refunds > 0) {
        sec.append(
          el(
            'p',
            { class: 'muted small', style: 'margin-top:8px' },
            `${bankMoney(a.refunds)} came back as refunds or reversals. This money is not yet confirmed as income, since a refund is money returned rather than earned. Confirm any that are genuinely your income.`
          )
        );
        const list = el('div', { class: 'recurring-list' });
        const renderRefundRow = (r) =>
          el(
            'div',
            { class: 'recurring-row' },
            el(
              'span',
              { class: 'recurring-name' },
              `${formatDisplayDate(r.date)} · ${cleanCounterparty(r.description) || r.type || 'Refund'}`
            ),
            el('span', { class: 'recurring-amt num strong' }, bankMoney(r.amount)),
            el(
              'button',
              {
                class: 'btn sm',
                onclick: () => confirmRefundAsIncome(r.id, true),
              },
              'Count as income'
            )
          );
        appendExpandable(el, list, refunds, renderRefundRow, { initial: 5 });
        sec.append(list);
      }
      if (confirmedRefunds.length) {
        const list = el('div', { class: 'recurring-list' });
        const renderConfirmedRefundRow = (r) =>
          el(
            'div',
            { class: 'recurring-row' },
            el(
              'span',
              { class: 'recurring-name muted' },
              `${formatDisplayDate(r.date)} · ${cleanCounterparty(r.description) || r.type || 'Refund'}`
            ),
            el('span', { class: 'recurring-amt num' }, bankMoney(r.amount)),
            el(
              'button',
              {
                class: 'btn sm ghost',
                onclick: () => confirmRefundAsIncome(r.id, false),
              },
              'Undo'
            )
          );
        appendExpandable(el, list, confirmedRefunds, renderConfirmedRefundRow, {
          initial: 5,
        });
        sec.append(
          renderExplainer(el, list, {
            label: `Refunds confirmed as income (${confirmedRefunds.length})`,
          })
        );
      }
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
    const stmts = state._bankStatements || [];
    if (!stmts.length) return null;

    // The month keys a "DD Mon YYYY - DD Mon YYYY" period string covers, first
    // to last inclusive. Presentation only; no stored value changes.
    const MON = {
      jan: 0,
      feb: 1,
      mar: 2,
      apr: 3,
      may: 4,
      jun: 5,
      jul: 6,
      aug: 7,
      sep: 8,
      oct: 9,
      nov: 10,
      dec: 11,
    };
    const periodMonths = (period) => {
      const re = /(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})/g;
      const dates = [];
      let m;
      while ((m = re.exec(String(period || ''))) !== null) {
        const mo = MON[m[2].toLowerCase()];
        if (mo != null) dates.push(`${m[3]}-${String(mo + 1).padStart(2, '0')}`);
      }
      if (!dates.length) return [];
      const start = dates[0],
        end = dates[dates.length - 1];
      const out = [];
      let ym = start,
        guard = 0;
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
      const acc = s.account || '-';
      if (!byAccount.has(acc))
        byAccount.set(acc, {
          account: acc,
          statements: [],
          months: new Set(),
          reconciled: 0,
        });
      const g = byAccount.get(acc);
      g.statements.push(s);
      if (s.reconciled) g.reconciled++;
      for (const ym of periodMonths(s.period)) {
        g.months.add(ym);
        coveredAll.add(ym);
      }
      if (s.importedAt && (!latestImport || s.importedAt > latestImport))
        latestImport = s.importedAt;
    }

    const totalN = stmts.length;
    const totalOk = stmts.filter((s) => s.reconciled).length;
    const allOk = totalOk === totalN;
    const accountsN = byAccount.size;
    const coveredMonths = [...coveredAll].filter(Boolean).sort();
    const first = coveredMonths[0] || null;
    const last = coveredMonths[coveredMonths.length - 1] || null;
    const gaps = missingMonths(coveredMonths);
    const spanText = first
      ? first === last
        ? monthLabel(first)
        : `${monthLabel(first)} - ${monthLabel(last)}`
      : '-';

    const wrap = el('div', { class: 'sec-section' });

    // Heading carries a status pill on its right, so the verdict is the first
    // thing seen, coloured (calm green / caution) without relying on colour alone.
    wrap.append(
      el(
        'div',
        { class: 'sec-subhead stmt-head' },
        el('span', { class: 'stmt-head-title' }, icon(iconReceipt()), ' Account statements'),
        el(
          'span',
          { class: 'pill ' + (allOk ? 'ok' : 'caution') },
          allOk ? '\u2713 All add up' : `${totalN - totalOk} need a look`
        )
      )
    );

    // Three compact tiles: accuracy, coverage span, freshness. One glance answers
    // "do the figures add up, how much history is here, and how current is it".
    const stat = (value, label, dotTone) =>
      el(
        'div',
        { class: 'stmt-stat' },
        el(
          'div',
          { class: 'stmt-stat-value' },
          dotTone ? el('span', { class: 'stmt-dot ' + dotTone }) : null,
          value
        ),
        el('div', { class: 'stmt-stat-label' }, label)
      );
    wrap.append(
      el(
        'div',
        { class: 'stmt-summary' },
        stat(
          `${totalOk}/${totalN}`,
          allOk ? 'Statements reconcile' : 'Reconcile, rest need a look',
          allOk ? 'good' : 'warn'
        ),
        stat(spanText, `Covered \u00b7 ${accountsN} account${accountsN === 1 ? '' : 's'}`),
        stat(
          latestImport ? new Date(latestImport).toLocaleDateString(state.cfg.currency.locale) : '-',
          'Last updated'
        )
      )
    );

    // Completeness line: name any month inside the covered span with no
    // statement - the one thing a list of present statements can never show.
    if (first && last && first !== last) {
      wrap.append(
        el(
          'p',
          { class: 'muted small stmt-note' },
          gaps.length
            ? `No statement for ${gaps.slice(0, 3).map(monthLabel).join(', ')}${gaps.length > 3 ? ` and ${gaps.length - 3} more` : ''}, so that stretch is incomplete. Add those PDFs for a full picture.`
            : 'Every month in that range has a statement, so nothing is missing.'
        )
      );
    }

    // One row per account: its own span, statement count and health. Accounts
    // holding a statement that did not reconcile sort first, then by number.
    const accounts = [...byAccount.values()]
      .map((g) => {
        const ms = [...g.months].filter(Boolean).sort();
        return {
          account: g.account,
          n: g.statements.length,
          failed: g.statements.length - g.reconciled,
          first: ms[0] || null,
          last: ms[ms.length - 1] || null,
        };
      })
      .sort((a, b) => b.failed - a.failed || String(a.account).localeCompare(String(b.account)));

    // One compact tile per account: a peer object a person scans and compares,
    // so tiles wrap into columns on desktop and collapse to one column on
    // mobile (styles.css .stmt-grid), rather than full-width rows that waste
    // desktop width and grow the scroll as accounts are added. Health colour is
    // always paired with a word and a dot, never colour alone.
    const renderAccountCard = (g) => {
      const span = g.first
        ? g.first === g.last
          ? monthLabel(g.first)
          : `${monthLabel(g.first)} - ${monthLabel(g.last)}`
        : 'no dated statements';
      const health = g.failed
        ? el('span', { class: 'recon-warn' }, `${g.failed} of ${g.n} need a look`)
        : el('span', { class: 'recon-ok' }, '\u2713 all reconcile');
      return el(
        'div',
        { class: 'stmt-card' + (g.failed ? ' attn' : '') },
        el(
          'div',
          { class: 'stmt-card-head' },
          el('span', { class: 'stmt-dot ' + (g.failed ? 'warn' : 'good') }),
          el('span', { class: 'stmt-card-name' }, `Account ${g.account}`)
        ),
        el(
          'div',
          { class: 'stmt-card-meta muted small' },
          `${span} \u00b7 ${g.n} statement${g.n === 1 ? '' : 's'}`
        ),
        el('div', { class: 'stmt-card-health' }, health)
      );
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
      details.append(
        el(
          'summary',
          {},
          `Per-account detail (${healthy.length} account${healthy.length === 1 ? '' : 's'})`
        )
      );
      const grid = el('div', { class: 'stmt-grid' });
      for (const g of healthy) grid.append(renderAccountCard(g));
      details.append(el('div', { class: 'explainer-body' }, grid));
      wrap.append(details);
    }

    return wrap;
  }

  return {
    classifiedBank,
    bankMoney,
    cleanCounterparty,
    renderBankStatementTrust,
    renderBankTrend,
    buildBankInsights,
    renderLedgerReview,
  };
}
