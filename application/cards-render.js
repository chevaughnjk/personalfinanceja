/*
 * cards-render.js  -  the Cards dashboard render tree.
 *
 * Stage 4 of the split. These 29 functions were lifted verbatim from bootUI in
 * app.js and wrapped in a factory that receives the bootUI members they use via
 * ctx, rather than closing over them. Nothing inside the bodies was renamed;
 * only where a name comes from changed. The group moves as ONE file because its
 * internal calls run several levels deep (renderHero -> fact / histMonthlyAverage
 * / prevLabel; buildInsights -> prevLabel; txTable -> catTag / kindTag / setSort /
 * toggleDetail -> detailKV) - splitting it further would recreate the cross-file
 * interleaving already seen in category-picker.js.
 *
 * Two-way coupling with app.js: buildPrintModel stays in app.js (part of the
 * deferred print-model group) and calls three functions from this group -
 * prevLabel, histMonthlyAverage and buildInsights - so those three are returned
 * by the factory alongside the ten render* functions render() calls, exactly as
 * Stage 2 handled buildPrintModel's calls to classifiedBank / bankMoney /
 * cleanCounterparty. The factory therefore returns 13 names; the other 16
 * functions in the group stay internal to this module.
 *
 * The one thing not passed via ctx is _searchDebounce: it is a private debounce
 * handle used only by renderFilters and renderExplorerOnly, both of which live
 * in this module, so its `let` declaration moved here with them rather than
 * being shared back through ctx.
 */
import { detectIncompleteMonth, detectRecurring, detectPeriodNewMerchants, missingMonths, foreignSummary, attentionItems, analysisForWindow, insightDriver, monthlyCommitmentsTotal, cardBehaviourState, projectCardPayoff, appendExpandable, isUnrecognised, reviewReasonText, renderKindTag, buildHeroSection, renderInsightList, renderExplainer, rankInsights, isPeriodFullyCovered, renderFilterChips } from './reporting.js';
import { merchantLabel } from './categorise.js';
import { merchantRuleKeyFromDescription } from '../settings/category-rules.js';
// classifyInternalTransfers is no longer imported here directly: both call
// sites that used it (renderRecurring's bank standing debits, and
// renderCardStatementTrust's bank-to-card payment match) now read
// state.bankRecords through the shared classifiedBank() passed in via ctx -
// the same function Accounts and Overview use - so this file can no longer
// apply a different set of ledger rules than the other two tabs.
import { counterpartyAccountTokens, linkCardPayments, detectBankStandingDebits } from './read-statements.js';
import { smoothScrollToEl, requireCtx } from './shared-helpers.js';
export function createCardsRenderer(ctx) {
  requireCtx(ctx, [
    'state', 'el', 'icon', '$', 'render', 'applyFilter', 'resolved', 'analysis', 'periodRows',
    'visibleRows', 'activeFilterCount', 'clearFilters', 'money0', 'moneyShort', 'pct',
    'monthLabel', 'monthShort', 'catColour', 'isReview', 'FALLBACK', 'allMonths',
    'updateFooter', 'pickStatements', 'secItem', 'statementCount', 'statusText', 'manageDataBody',
    'openCategoryPicker', 'dismissReview', 'showTip', 'hideTip', 'highestCompleteMonth', 'classifiedBank',
    'iconInfo', 'iconUp', 'iconDown', 'iconBulb', 'iconChevron', 'iconFlag', 'iconChart',
    'iconPie', 'iconStore', 'iconList', 'iconExplore', 'iconX', 'iconRepeat', 'iconGlobe',
    'iconTag', 'iconAlert', 'iconSpark', 'iconReceipt', 'iconBack', 'iconPeak', 'iconGap',
    'iconCal',
  ], 'createCardsRenderer');
  const {
    state, el, icon, $, render, applyFilter, resolved, analysis, periodRows,
    visibleRows, activeFilterCount, clearFilters, money0, moneyShort, pct,
    monthLabel, monthShort, catColour, isReview, FALLBACK, allMonths,
    updateFooter, pickStatements, secItem, statementCount, statusText, manageDataBody,
    openCategoryPicker, dismissReview, showTip, hideTip, highestCompleteMonth, classifiedBank,
    iconInfo, iconUp, iconDown, iconBulb, iconChevron, iconFlag, iconChart,
    iconPie, iconStore, iconList, iconExplore, iconX, iconRepeat, iconGlobe,
    iconTag, iconAlert, iconSpark, iconReceipt, iconBack, iconPeak, iconGap,
    iconCal,
  } = ctx;

  // Private debounce handle for the explorer search box, used only by
  // renderFilters and renderExplorerOnly below. Moved here with them.
  let _searchDebounce = null;
  // Open state of the search-first "More filters" disclosure. renderExplorerOnly
  // rebuilds the whole #explorer node on each debounced search keystroke (and on
  // each Min/Max keystroke), which would otherwise snap a native <details> shut
  // mid-interaction. Holding the state here (module-local, exactly like
  // _searchDebounce) lets the rebuilt panel reopen to where it was left.
  let _moreFiltersOpen = false;

  /* ---- 1) hero: period summary ---- */
  function renderHero(a) {
    const inc = detectIncompleteMonth(state.rows, allMonths(), new Date(), { coverage: state.coverage });
    const periodIncomplete = inc && a.months.includes(inc.month);

    // primary figure + comparisons (unchanged logic; now assembled as the
    // lead figure's `extra` nodes so the shared hero builder places them).
    const prev = a.prev_total;
    const changeEl = (() => {
      if (prev == null || prev === 0) return el('span', { class: 'cmp muted' }, 'No comparable period yet');
      // Fairness gate: a not-yet-complete period must not show a "% vs last
      // month" pill (the "18% less than June" distortion when July was only
      // half-imported). A provably partial window shows a calm in-progress
      // note instead; unknown coverage is allowed through unchanged.
      if (!isPeriodFullyCovered(state.coverage, resolved())) {
        return el('span', { class: 'cmp muted' }, 'This period is still filling in');
      }
      const diff = a.total_spend - prev; const dp = Math.round((diff / prev) * 100);
      const up = diff > 0;
      const cls = up ? 'up' : (diff < 0 ? 'down' : 'flat');
      return el('button', { class: 'cmp ' + cls, title: `Previous: ${money0(prev)}`,
        onclick: () => setPeriodToPrevious() },
        el('span', { class: 'arrow', html: up ? iconUp() : iconDown() }),
        el('span', {}, `${Math.abs(dp)}% ${up ? 'more' : 'less'} than ${prevLabel()}`));
    })();
    const avgLine = (() => {
      const hist = histMonthlyAverage();
      if (!hist) return null;
      const perMonth = a.months.length ? a.total_spend / a.months.length : a.total_spend;
      const d = hist ? (perMonth - hist) / hist : 0;
      const word = Math.abs(d) < 0.08 ? 'about the same as' : (d > 0 ? 'above' : 'below');
      const text = a.months.length > 1
        ? `That averages ${money0(perMonth)} a month over ${a.months.length} months, ${word} your typical month of ${money0(hist)}.`
        : `That is ${word} your typical month of ${money0(hist)}.`;
      return el('div', { class: 'hero-avg muted' }, text);
    })();

    const note = periodIncomplete
      ? el('p', { class: 'hero-note' }, icon(iconInfo()),
          inc.reason === 'current'
            ? ' This month is still in progress, so the total will keep rising as new transactions post.'
            : ' This looks like a part-month statement, so the total is lower than a full month. It is not a real drop in spending.')
      : null;

    return buildHeroSection(el, icon, iconInfo, {
      eyebrow: 'Cards',
      title: 'Your card spending',
      pill: periodIncomplete ? {
        text: inc.reason === 'current' ? 'In progress' : 'May be incomplete',
        title: 'Some transactions for this month may not have posted yet.',
        subline: 'Some transactions for this month may not have posted yet.',
      } : null,
      lead: {
        amount: money0(a.total_spend),
        label: 'spent on purchases',
        extra: [
          changeEl,
          prev != null && prev !== 0 ? el('div', { class: 'muted small mobile-context' }, `Previous: ${money0(prev)}.`) : null,
          avgLine,
        ],
      },
      facts: [
        { value: String(a.n_purchases), label: a.n_purchases === 1 ? 'purchase' : 'purchases',
          onClick: () => applyFilter({ kind: 'spend' }, { expand: true, scroll: true }) },
        a.leading ? { value: a.leading.name, label: `leading category · ${pct(a.leading.share)}`,
          onClick: () => applyFilter({ category: a.leading.name }, { expand: true, scroll: true }), colour: catColour(a.leading.name) } : null,
        // Guarded like its sibling muted extras (fees, refunds): a "$0 paid to
        // card" fact is clutter, not signal. Absent when zero; the primary
        // triads on the Accounts/Overview heroes stay always-present by design.
        a.total_payments ? { value: moneyShort(a.total_payments), label: 'paid to card', tone: 'muted' } : null,        a.total_fees ? { value: moneyShort(a.total_fees), label: 'fees & tax',
          onClick: () => applyFilter({ kind: 'fee' }, { expand: true, scroll: true }), tone: 'muted' } : null,
        a.total_refunds ? { value: moneyShort(a.total_refunds), label: 'refunds',
          onClick: () => applyFilter({ kind: 'refund' }, { expand: true, scroll: true }), tone: 'muted' } : null,
      ],
      note,
    });
  }
  const prevLabel = () => {
    const p = resolved();
    if (!p || !p.prevFrom) return 'before';
    if (p.kind === 'month') return monthLabel(p.prevFrom);
    if (state.period.type === 'this-year') return p.prevFrom.slice(0, 4);
    return 'the period before';
  };
  function setPeriodToPrevious() {
    const p = resolved(); if (!p || !p.prevFrom) return;
    if (p.kind === 'month') { state.period = { type: 'custom', from: p.prevFrom, to: p.prevTo }; }
    else state.period = { type: 'custom', from: p.prevFrom, to: p.prevTo };
    clearFilters(); render();
  }
  function histMonthlyAverage() {
    // D-audit item 7. The "typical month" every insight compares against was a
    // plain mean of complete months, so one unusually large month (a big one-off
    // - on the real corpus, one unusually large month, e.g. an annual insurance renewal)
    // permanently pulled the baseline up (~+8.5% here). A robust baseline is used
    // instead: months more than 3 modified-z (median + MAD, the standard robust
    // spread) from the median are dropped as one-offs, then the remaining months
    // are averaged. With no clear outlier this equals the old mean; when a whale
    // month exists it is excluded so "typical" reflects an ordinary month. The
    // incomplete latest month is still excluded first, exactly as before.
    const months = allMonths(); if (months.length < 1) return 0;
    const inc = detectIncompleteMonth(state.rows, months, new Date(), { coverage: state.coverage });
    const complete = months.filter((m) => !inc || m !== inc.month);
    const vals = complete.map((m) => state.allSummary.by_month[m] || 0);
    if (!vals.length) return 0;
    const med = (a) => { const s = a.slice().sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
    const centre = med(vals);
    const mad = med(vals.map((v) => Math.abs(v - centre)));
    // Need enough months for a robust spread to mean anything; below that, and
    // when MAD is zero, fall back to the plain mean of every complete month.
    const kept = (vals.length >= 4 && mad > 0)
      ? vals.filter((v) => Math.abs(0.6745 * (v - centre) / mad) <= 3.5)
      : vals;
    const use = kept.length ? kept : vals;
    return use.reduce((x, y) => x + y, 0) / use.length;
  }

  /* ---- 2) insights + attention ---- */
  function renderInsightsAndAttention(a) {
    // "Worth a look" now omits itself when empty (renderAttention returns
    // null). When it does, the insights card takes the full row via the
    // .row2-single modifier, instead of a tall empty half-width placeholder
    // stretching beside it.
    const attention = renderAttention(a);
    const wrap = el('div', { class: 'row2' + (attention ? '' : ' row2-single') });
    wrap.append(renderInsightCards(a));
    if (attention) wrap.append(attention);
    return wrap;
  }

  function buildInsights(a) {
    const out = [];
    const p = resolved();
    const spend = periodRows().filter((r) => r.kind === 'spend');
    const inc = detectIncompleteMonth(state.rows, allMonths(), new Date());

    // 1) Overall change vs previous comparable period.
    // FIX (redundancy): this used to fire on any move past the meaningful-change
    // threshold and simply restate the same percentage/figures the hero pill
    // above already shows (a.prev_total). That made the card say the same thing
    // twice in two places on the same screen. Now it only surfaces here when a
    // genuine single driver (insightDriver) can be named - i.e. it always adds
    // something the pill does not already say - and leads with that driver
    // rather than repeating the headline number.
    if (a.prev_total != null && a.prev_total > 0) {
      const diff = a.total_spend - a.prev_total; const dp = Math.round((diff / a.prev_total) * 100);
      // D-audit item 4: this fallback was 20 while config.json uses 25, so the two
      // "meaningful change" code paths could disagree about what counts as
      // meaningful. Aligned to 25 so all paths share one threshold.
      if (Math.abs(dp) >= (state.cfg.insights.meaningfulChangePct || 25) && Math.abs(diff) >= (state.cfg.insights.meaningfulChangeMin || 3000)) {
        // Insight attribution (§11, B6): name the single category or merchant most
        // responsible for the move, via the pure insightDriver over the same two
        // windows this insight already compares - the current period and the
        // previous comparable period. analysisForWindow gives a full breakdown for
        // each (its labels tidied identically on both sides so a driver never
        // mismatches "STARBUCKS" against "Starbucks"). A null driver (a change
        // spread evenly, with no single dominant cause) now suppresses this
        // insight entirely, since without a driver it has nothing to say beyond
        // what the hero pill already shows.
        let driver = null;
        if (p && p.prevFrom && p.prevTo) {
          const opts = { keepUpperSet: state.keepUpper, smallWordsSet: state.smallWords, merchantLabelFn: (s) => merchantLabel(s, state.keepUpper, state.smallWords) };
          const currentA = analysisForWindow(state.rows, p.from, p.to, opts);
          const previousA = analysisForWindow(state.rows, p.prevFrom, p.prevTo, opts);
          driver = insightDriver(currentA, previousA, state.cfg);
        }
        if (driver) {
                    out.push({ tone: diff > 0 ? 'up' : 'down', kind: 'overall-change', icon: diff > 0 ? iconUp() : iconDown(),
            text: `${driver.label} was the main reason spending ${diff > 0 ? 'rose' : 'fell'} this period, ${money0(Math.abs(diff))} ${diff > 0 ? 'more' : 'less'} than ${prevLabel()}.`,
            onClick: () => applyFilter({ kind: 'spend' }, { expand: true, scroll: true }) });
        }
      }
    }

    // 2) Category with the biggest move vs the previous comparable period.
    if (p && p.prevFrom) {
      const prevRows = state.rows.filter((r) => r.kind === 'spend' && r.month >= p.prevFrom && r.month <= p.prevTo);
      const cur = {}; for (const r of spend) cur[r.category] = (cur[r.category] || 0) + r.amount;
      const pre = {}; for (const r of prevRows) pre[r.category] = (pre[r.category] || 0) + r.amount;
      let best = null;
      for (const cat of new Set([...Object.keys(cur), ...Object.keys(pre)])) {
        const d = (cur[cat] || 0) - (pre[cat] || 0);
        const base = pre[cat] || 0;
        // D-audit item 4: read the shared percentage from config (as a fraction)
        // rather than hardcoding 0.25, so this category-move threshold can never
        // drift from the overall-change threshold above.
        if (Math.abs(d) >= (state.cfg.insights.meaningfulChangeMin || 3000) && (base === 0 || Math.abs(d) / base >= (state.cfg.insights.meaningfulChangePct || 25) / 100)) {
          if (!best || Math.abs(d) > Math.abs(best.d)) best = { cat, d, cur: cur[cat] || 0 };
        }
      }
      // Item 15: a category dropping to zero this period is noise, not signal, so
      // skip the move insight when the current-period value is 0 (the category
      // vanished). Only the "down to $0.00" case is suppressed; any genuine up or
      // down move where the category still has spend (best.cur > 0) is unaffected.
      if (best && best.cur > 0) out.push({ tone: best.d > 0 ? 'up' : 'down', kind: 'category-move', icon: iconTag(catColour(best.cat)),
        text: `${best.cat} is ${best.d > 0 ? 'up' : 'down'} ${money0(Math.abs(best.d))} on ${prevLabel()}, now ${money0(best.cur)}.`,
        onClick: () => applyFilter({ category: best.cat }, { expand: true, scroll: true }) });
    }

    // 3) Large / unusual single transaction in the period.
    // FIX (point 2): attentionItems is run over periodRows(), which on a wide
    // period (e.g. "All time") can span years. Without narrowing, the single
    // largest flagged charge anywhere in that whole span surfaces here under
    // "What changed" - a heading that implies something recent - even if it
    // happened a year or more ago. When the resolved period is not a single
    // month, this now narrows candidates to the latest month actually present
    // in the period, so only a genuinely recent large charge is ever shown here.
    // Single-month periods are unaffected (a.months already has length 1 there).
    let flags = attentionItems(periodRows(), state.cfg, state.brandRules, state.merchants).filter((f) => f.type === 'large');
    if (flags.length && p && p.kind !== 'month' && a.months.length) {
      const latestMonthInPeriod = a.months[a.months.length - 1];
      flags = flags.filter((f) => f.row.month === latestMonthInPeriod);
    }
    if (flags.length) {
      const f = flags.sort((x, y) => y.row.amount - x.row.amount)[0];
      out.push({ tone: 'up', kind: 'large-charge', icon: iconAlert(),
        text: `A ${f.row.displayName} charge of ${money0(f.row.amount)} on ${f.row.date} is larger than usual for that place.`,
        onClick: () => applyFilter({ search: f.row.description.split(',')[0].trim() }, { expand: true, scroll: true }) });
    }

    // 4) New merchant this period. Uses detectPeriodNewMerchants, which keys a
    // merchant as new on its TRUE first-ever occurrence month across all history
    // and only counts it when that first-ever month falls inside the period. On
    // an all-time or first-ever view (no prior period) it returns nothing, so a
    // long-established merchant is never mislabelled as new. state.brandRules and
    // state.merchants are passed exactly as detectRecurring is called below.
    const newMerchants = detectPeriodNewMerchants(state.rows, p, state.brandRules, state.merchants);
    const newBig = newMerchants.filter((m) => m.amount >= (state.cfg.insights.newMerchantMin || 2000))[0];
    if (newBig) {
      out.push({ tone: 'new', kind: 'new-merchant', icon: iconSpark(), text: `New this period: ${newBig.label} (${money0(newBig.amount)}).`,
        onClick: () => applyFilter({ merchant: newBig.key, merchantLabel: newBig.label, category: 'all' }, { expand: true, scroll: true }) });
    }

    // 5) Likely recurring charges across history (steady context).
    const rec = detectRecurring(state.rows, 3, 0.15, state.brandRules, state.merchants);
    if (rec.length) { const totalRec = rec.reduce((s, r) => s + r.typical, 0);
      out.push({ tone: 'info', kind: 'recurring', icon: iconRepeat(), text: `${rec.length} likely recurring charge${rec.length === 1 ? '' : 's'} totalling about ${money0(totalRec)} a month, such as ${rec.slice(0, 2).map((r) => r.label).join(' and ')}.`,
        onClick: () => applyFilter({ category: 'Subscriptions' }, { expand: true, scroll: true }) }); }

    // 6) Foreign-currency spending in the period.
    const fx = spend.filter((r) => r.foreign);
    if (fx.length) { const fxTotal = fx.reduce((s, r) => s + r.amount, 0);
      out.push({ tone: 'info', kind: 'foreign', icon: iconGlobe(), text: `${fx.length} foreign-currency purchase${fx.length === 1 ? '' : 's'} this period, ${money0(fxTotal)} in total.`,
        onClick: () => applyFilter({ foreignOnly: true }, { expand: true, scroll: true }) }); }

    // 7) Fees & interest in the period.
    if (a.total_fees > 0) out.push({ tone: 'up', kind: 'fees', icon: iconReceipt(), text: `You paid ${money0(a.total_fees)} in fees and tax this period.`,
      onClick: () => applyFilter({ kind: 'fee' }, { expand: true, scroll: true }) });

    // 8) Refunds in the period.
    if (a.total_refunds > 0) out.push({ tone: 'down', kind: 'refunds', icon: iconBack(), text: `${money0(a.total_refunds)} came back to the card in refunds this period.`,
      onClick: () => applyFilter({ kind: 'refund' }, { expand: true, scroll: true }) });

    // 9) Unusually high complete month across history.
    const hi = highestCompleteMonth();
    if (hi && a.months.includes(hi.month)) out.push({ tone: 'up', kind: 'high-month', icon: iconPeak(), text: `${monthLabel(hi.month)} is your highest-spending month so far at ${money0(hi.amount)}.`,
      onClick: () => { state.period = { type: 'custom', from: hi.month, to: hi.month }; clearFilters(); render(); } });

    // 10) Missing statement periods.
    const gaps = missingMonths(allMonths());
    if (gaps.length) out.push({ tone: 'info', kind: 'missing-months', icon: iconGap(), text: `No statement found for ${gaps.slice(0, 2).map(monthLabel).join(' and ')}${gaps.length > 2 ? ` and ${gaps.length - 2} more` : ''}. Add ${gaps.length === 1 ? 'it' : 'them'} for a complete picture.`,
      onClick: () => pickStatements() });

    return rankInsights(out, state.cfg.insights.maxInsights || 3);
  }

  function renderInsightCards(a) {
    // Heading unified across all three tabs to "What's new or unusual" (was
    // "What changed" here). One concept, one name - the superset framing that
    // reads correctly for card spending changes, cash-flow shifts and anomalies
    // alike. Now uses the one shared renderInsightList (reporting.js).
    return renderInsightList(el, icon, {
      title: 'What\u2019s new or unusual',
      iconBulb, iconChevron,
      insights: buildInsights(a),
      emptyText: `A calm ${a.label.toLowerCase()}. Nothing stands out against your usual pattern.`,
    });
  }

  function renderAttention(a) {
    // Dismissed items drop out of the attention list without forcing a category
    // change (reviewDismissed), mirroring attentionItems() in the pure core.
    // Two classes now combine into ONE calm, undifferentiated count, per the
    // cognitive-load principle: a person does not need to know there are
    // technically two different reasons a transaction landed here -
    // isUnrecognised (nothing matched at all) and needsReview (a real
    // merchant match categorise() still could not confidently categorise,
    // e.g. WiPay) - only that a small number of things could use a glance.
    // The two classes are mutually exclusive by construction in
    // categorise()/buildRows(), so concatenating them can never double-count
    // a single transaction.
    const uncategorised = periodRows().filter((r) => r.kind === 'spend' && isUnrecognised(r, FALLBACK()) && !r.reviewDismissed);
    const needsReviewRows = periodRows().filter((r) => r.kind === 'spend' && r.needsReview && !r.reviewDismissed);
    const reviewRows = [...uncategorised, ...needsReviewRows];
    const reviewTotal = reviewRows.reduce((s, r) => s + r.amount, 0);
    const warns = state.warnings || [];
    // Omit-when-empty (Class 6): nothing to review and no warnings -> return
    // null, so renderInsightsAndAttention gives the insights card the full row
    // instead of a half-width "All clear here" placeholder. The reassurance is
    // the card's absence. Matches the omit-when-empty rule the Spent abroad /
    // Regular payments cards already follow.
    if (!reviewRows.length && !warns.length) return null;
    const sec = el('section', { class: 'card attention' });
    sec.append(el('div', { class: 'card-head' }, el('h3', { class: 'card-title' }, icon(iconInfo()), 'Worth a look')));
    // Blocking first: a statement we could not fully read can leave the totals
    // short, so it is the one thing that genuinely affects trust in the numbers.
    // It keeps the warning dot and leads the card, above any optional tidying.
    for (const w of warns.slice(0, 3)) {
      sec.append(el('div', { class: 'attn-item' },
        el('span', { class: 'attn-dot warn' }),
        el('div', { class: 'attn-body' }, el('div', {}, w)),
        el('button', { class: 'btn sm ghost', onclick: pickStatements }, 'Try again')));
    }
    // Then the optional tidying. These purchases are already filed and every
    // total already counts them, so the framing shows the app did the sorting
    // and leaves refining optional, never homework. The muted review dot is
    // preserved. The SPECIFIC per-transaction reason (reviewReasonText) is
    // deliberately NOT repeated here - it surfaces only inside an individual
    // transaction's detail panel (toggleDetail, below), the one place a
    // person has already chosen to look closer. This card stays one honest,
    // calm sentence regardless of how many different underlying reasons sit
    // behind the count.
    if (reviewRows.length) {
      sec.append(el('div', { class: 'attn-item' },
        el('span', { class: 'attn-dot review' }),
        el('div', { class: 'attn-body' },
          el('div', {}, `${reviewRows.length} purchase${reviewRows.length === 1 ? '' : 's'} could use a second look (${money0(reviewTotal)})`),
          el('div', { class: 'muted small' }, 'The totals already count them, so refining is optional. Tap any of them for the reason.')),
        el('div', { class: 'attn-actions' },
          el('button', { class: 'btn sm ghost', onclick: () => dismissReview(reviewRows) }, 'Looks fine'),
          el('button', { class: 'btn sm', onclick: () => applyFilter({ reviewOnly: true, category: 'all' }, { expand: true, scroll: true }) }, 'Refine'))));
    }
    return sec;
  }

  /* ---- 3) spending over time ---- */
  function renderTrend(a) {
    const sec = el('section', { class: 'card' });
    const head = el('div', { class: 'card-head' }, el('h3', { class: 'card-title' }, icon(iconChart()), 'Spending over time'));
    if (state.filter.month !== 'all') head.append(el('button', { class: 'btn sm ghost', onclick: () => applyFilter({ month: 'all' }) }, 'Show all months'));
    sec.append(head);

    const months = allMonths();
    const shown = months.length > 13 ? months.slice(-13) : months;
    const vals = shown.map((m) => state.allSummary.by_month[m] || 0);
    const max = Math.max(...vals, 1);
    const inc = detectIncompleteMonth(state.rows, months, new Date());
    const avg = histMonthlyAverage();
    const p = resolved();

    const chart = el('div', { class: 'trend' });
    const H = 150;
    const avgY = avg > 0 ? H - Math.min(H, (avg / max) * H) : null;
    if (avgY != null) {
      chart.append(el('div', { class: 'trend-avg', style: `top:${avgY}px`, title: `Typical month ${money0(avg)}` },
        el('span', { class: 'trend-avg-label' }, `avg ${moneyShort(avg)}`)));
    }
    const barsWrap = el('div', { class: 'trend-bars' });
    for (let i = 0; i < shown.length; i++) {
      const m = shown[i]; const v = vals[i];
      const h = Math.max(3, (v / max) * H);
      const incomplete = inc && inc.month === m;
      const inPeriod = p && m >= p.from && m <= p.to;
      const selected = state.filter.month === m || (state.filter.month === 'all' && inPeriod && p.kind === 'month');
      const col = el('button', {
        class: 'trend-col' + (inPeriod ? ' in-period' : '') + (selected ? ' selected' : '') + (incomplete ? ' incomplete' : ''),
        'aria-label': `${monthLabel(m)}: ${money0(v)}${incomplete ? ', may be incomplete' : ''}`,
        onmousemove: (e) => showTip(e, `${monthLabel(m)}`, `${money0(v)}${incomplete ? ' · may be incomplete' : ''}`),
        onmouseleave: hideTip,
        onclick: (e) => {
          if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) {
            const rect = e.currentTarget.getBoundingClientRect();
            showTip({ clientX: rect.left + rect.width / 2, clientY: rect.top + 8 }, `${monthLabel(m)}`, `${money0(v)}${incomplete ? ' · may be incomplete' : ''}`);
            clearTimeout(state.tipTimer);
            state.tipTimer = setTimeout(hideTip, 1800);
          }
          if (inPeriod) applyFilter({ month: state.filter.month === m ? 'all' : m });
          else { state.period = { type: 'custom', from: m, to: m }; clearFilters(); render(); }
        },
      },
        el('span', { class: 'trend-bar', style: `height:${h}px` }),
        el('span', { class: 'trend-mlabel' }, monthShort(m).replace(/ \d+$/, '')));
      barsWrap.append(col);
    }
    chart.append(barsWrap);
    sec.append(chart);
    if (avgY != null) sec.append(el('p', { class: 'muted small mobile-context' }, `Typical month ${money0(avg)}.`));
    sec.append(el('p', { class: 'muted small' }, 'Monthly purchases only - payments, refunds and fees are left out so the trend reflects what you actually bought. Hatched bars may be part-month statements. Select a bar to focus the dashboard on that month.'));
    return sec;
  }

  /* ---- 4) spending by category ---- */
  function renderCategoryPanel(a) {
    const sec = el('section', { class: 'card' });
    sec.append(el('div', { class: 'card-head' }, el('h3', { class: 'card-title' }, icon(iconPie()), 'Where it went'),
      state.filter.category !== 'all' ? el('button', { class: 'btn sm ghost', onclick: () => applyFilter({ category: 'all' }) }, 'Clear category') : null));
    const cats = a.by_category;
    if (!cats.length) { sec.append(el('p', { class: 'muted pad' }, 'No purchases in this period.')); return sec; }
    const max = cats[0].amount || 1;
    // If the selected category sits past the first 5, bring it forward so
    // drilling into a category from elsewhere (Top places, an insight) never
    // hides its own selected state behind a collapsed "Show more" toggle.
    let catsOrdered = cats;
    if (state.filter.category !== 'all') {
      const idx = cats.findIndex((c) => c.name === state.filter.category);
      if (idx > 4) { catsOrdered = cats.slice(); const [sel] = catsOrdered.splice(idx, 1); catsOrdered.unshift(sel); }
    }
    const list = el('div', { class: 'catlist' });
    const renderCatRow = (c) => {
      const selected = state.filter.category === c.name;
      const review = isReview(c.name);
      const frag = el('div', {});
      frag.append(el('button', { class: 'catrow' + (selected ? ' selected' : '') + (review ? ' review' : ''),
        'aria-label': `${review ? 'To review' : c.name}: ${money0(c.amount)}, ${pct(c.share)} of spending`,
        onclick: () => applyFilter({ category: selected ? 'all' : c.name, reviewOnly: false }, { expand: true, scroll: !selected }) },
        catTag(c.name, { class: 'cat-name' }),
        el('span', { class: 'cat-track' }, el('span', { class: 'cat-fill' + (review ? ' review' : ''), style: `width:${Math.max(3, (c.amount / max) * 100)}%;background:${catColour(c.name)}` })),
        el('span', { class: 'cat-amt' }, money0(c.amount), el('span', { class: 'cat-pct' }, pct(c.share)))));
      if (selected) {
        const lead = a.merchants.filter((m) => m.category === c.name).slice(0, 3);
        if (lead.length) {
          const sub = el('div', { class: 'cat-sub' });
          sub.append(el('span', { class: 'muted small' }, 'Top places: '));
          lead.forEach((m) => { sub.append(el('button', { class: 'chip tiny', onclick: () => applyFilter({ merchant: m.key, merchantLabel: m.merchant, category: 'all' }, { expand: true, scroll: true }) }, `${m.merchant} ${money0(m.amount)}`)); });
          frag.append(sub);
        }
      }
      return frag;
    };
    appendExpandable(el, list, catsOrdered, renderCatRow, { initial: 5 });
    sec.append(list);
    return sec;
  }
  /* ---- 5) top places (merchants) ---- */
  function renderMerchants(a) {
    const sec = el('section', { class: 'card' });
    sec.append(el('div', { class: 'card-head' }, el('h3', { class: 'card-title' }, icon(iconStore()), 'Top places'),
      state.filter.merchant ? el('button', { class: 'btn sm ghost', onclick: () => applyFilter({ merchant: '', merchantLabel: '' }) }, 'Clear place') : null));
    const list = a.merchants;
    if (!list.length) { sec.append(el('p', { class: 'muted pad' }, 'No purchases in this period.')); return sec; }
    const table = el('table', { class: 'grid merch' });
    table.append(el('thead', {}, el('tr', {},
      el('th', {}, 'Place'), el('th', {}, 'Category'),
      el('th', { class: 'num' }, 'Times'), el('th', { class: 'num' }, 'Total'),
      el('th', { class: 'num' }, 'Average'), el('th', { class: 'num' }, 'Share'))));
    const body = el('tbody');
    const renderMerchRow = (m) => el('tr', { class: 'clickable' + (state.filter.merchant === m.key ? ' selected' : ''),
      onclick: () => applyFilter({ merchant: state.filter.merchant === m.key ? '' : m.key, merchantLabel: m.merchant, category: 'all' }, { expand: true, scroll: true }) },
      el('td', {}, el('span', { class: 'merch-name' }, m.merchant)),
      el('td', {}, catTag(m.category)),
      el('td', { class: 'num' }, m.count),
      el('td', { class: 'num strong' }, money0(m.amount)),
      el('td', { class: 'num muted' }, money0(m.avg)),
      el('td', { class: 'num muted' }, pct(m.share)));
    appendExpandable(el, body, list, renderMerchRow, {
      initial: 12,
      wrapToggle: (btn) => el('tr', {}, el('td', { colspan: 6 }, el('div', { class: 'show-more' }, btn))),
    });
    table.append(body); sec.append(el('div', { class: 'table-wrap' }, table));
    sec.append(renderExplainer(el, 'A high “Times” with a low “Average” is everyday spending; a low “Times” with a high “Total” is a one-off. Places are grouped only when the statement text matches.', { label: 'How to read this' }));
    return sec;  }

  /* ---- 5b) regular payments (recurring, whole-history) ---- */
  /* Surfaces detectRecurring over ALL history (state.rows), not the selected
   * period, because it needs 3+ distinct months. The subtitle makes that
   * explicit so it never appears to conflict with the period figures. If
   * nothing recurs (or there are fewer than 3 months of data) the card is not
   * rendered at all. */
  function renderRecurring() {
    const rec = detectRecurring(state.rows, 3, 0.15, state.brandRules, state.merchants);
    // Bank standing debits (D18) are read from the SAME classified-and-ruled bank ledger the Accounts and Overview tabs use (classifyInternalTransfers + applyLedgerRules), not from classifyInternalTransfers alone. Two reasons: (1) detectBankStandingDebits excludes internal transfers via r.internalTransfer and groups by r.counterpartyKey, both of which only exist after classifyInternalTransfers runs, so raw state.bankRecords would mis-surface a monthly card payment or an own-account sweep as a standing debit; (2) a payment already confirmed as a round-trip or flagged as household support on the Accounts tab must stay excluded here too - reading classifyInternalTransfers alone skipped applyLedgerRules entirely, so a confirmed exclusion on Accounts could still silently reappear in this combined total. classifiedBank() is the one shared function Accounts, Overview and Cards all call for this now, so the three can no longer drift apart on the same figure.
    const bankDebits = detectBankStandingDebits(classifiedBank());
    // Render when EITHER ledger carries a commitment. The old guard suppressed
    // the whole card (and every bank standing debit with it) for anyone whose
    // regular payments are all on the bank side; that must never happen again.
    if (!rec.length && !bankDebits.length) return null;
    const combined = monthlyCommitmentsTotal(rec, bankDebits);
    const sec = el('section', { class: 'card' });
    sec.append(el('div', { class: 'card-head' },
      el('h3', { class: 'card-title' }, icon(iconRepeat()), 'Regular payments')));
    // Total first: one clear headline figure for every regular commitment across
    // both ledgers, de-duplicated so a payment seen on both sides counts once.
    // Reuses the existing fact-value convention (kept prominent with an inline
    // size, the same way renderCardStatementHealth sets an inline size) inside a
    // plain hero-figure container; no new CSS is introduced. combined.items is
    // now ACTIVE commitments only (monthlyCommitmentsTotal, reporting.js, keeps
    // a lapsed one out of both the total and this count), so the headline never
    // overstates an ongoing monthly cost with something that has stopped.
    sec.append(el('div', { class: 'hero-figure' },
      el('div', { class: 'fact-value', style: 'font-size:26px' }, `${money0(combined.total)} a month`),
      el('div', { class: 'muted small' }, `Total of ${combined.items.length} regular payment${combined.items.length === 1 ? '' : 's'}, before anything else.${combined.lapsed.length ? ` ${combined.lapsed.length} more may have ended - see below.` : ''}`)));
    sec.append(el('p', { class: 'muted small recurring-sub' }, 'All regular payments across your card and accounts, de-duplicated so a payment seen on both sides counts once. Across your whole history, not just this period.'));
    const list = el('div', { class: 'recurring-list' });
    const renderRecurringRow = (item) => {
      // The middle column names the SOURCE ledger rather than a month count,
      // because monthlyCommitmentsTotal carries { label, typical, source } and no
      // per-item month figure. In a mixed view the source is the more useful cue.
      const sourceLabel = item.source === 'bank' ? 'from your bank account' : 'on your card';
      if (item.source === 'card') {
        // Card-sourced rows keep the existing merchant drill-down into the card ledger.
        return el('button', { class: 'recurring-row',
          'aria-label': `${item.label}: about ${money0(item.typical)} a month, ${sourceLabel}`,
          onclick: () => applyFilter({ merchant: merchantRuleKeyFromDescription(item.label), merchantLabel: item.label, category: 'all' }, { expand: true, scroll: true }) },
          el('span', { class: 'recurring-name' }, item.label),
          el('span', { class: 'recurring-months muted small' }, sourceLabel),
          el('span', { class: 'recurring-amt num strong' }, `${money0(item.typical)}/mo`));
      }
      // Bank-sourced rows are a standing debit in the Accounts ledger. The card
      // merchant filter cannot resolve a bank counterparty, so drilling in would
      // land on an empty card view; these render as plain, non-interactive rows -
      // the same non-button .recurring-row pattern the Accounts review list uses.
      return el('div', { class: 'recurring-row',
        'aria-label': `${item.label}: about ${money0(item.typical)} a month, ${sourceLabel}` },
        el('span', { class: 'recurring-name' }, item.label),
        el('span', { class: 'recurring-months muted small' }, sourceLabel),
        el('span', { class: 'recurring-amt num strong' }, `${money0(item.typical)}/mo`));
    };
    appendExpandable(el, list, combined.items, renderRecurringRow, { initial: 5 });
    sec.append(list);
    // "May have ended": commitments that recurred consistently before but have
    // fallen further behind the ledger's own current month than their own
    // cadence tolerance allows (recurringStatus, shared-helpers.js). Never
    // silently dropped from the app - kept only out of the active total and
    // list above - the same "flag, never delete" treatment this app already
    // gives cash-deposit exclusions and confirmed round-trips on the Accounts
    // tab. lastMonth (added to both detectors' output alongside status) is what
    // lets this say exactly when, rather than just that it stopped.
    //
    // Collapsed by default, using the ONE shared disclosure this app already
    // has for calm-by-default, clearly discoverable secondary detail
    // (renderExplainer, the same closed <details> with an info icon and a
    // rotating chevron already used under "How to read this" on Top places and
    // "More filters" in the explorer). A stopped commitment is settled,
    // reference information, not something needing a decision, so it no longer
    // sits at full visual weight below the active list, but the summary line
    // names the exact count up front, so it is never a mystery toggle. The
    // native <details>/<summary> element makes it reachable by Tab and openable
    // with Enter/Space, with its state announced to screen readers with no
    // extra ARIA needed.
    if (combined.lapsed.length) {
      const lapsedBody = el('div', {});
      lapsedBody.append(el('p', { class: 'muted small', style: 'margin-top:0' }, 'These recurred consistently before but have not charged recently, so they are kept out of the total above.'));
      const lapsedList = el('div', { class: 'recurring-list' });
      const renderLapsedRow = (item) => {
        const sourceLabel = item.source === 'bank' ? 'from your accounts' : 'on your card';
        const lastSeen = item.lastMonth ? `last charged ${monthLabel(item.lastMonth)}` : 'last charge unknown';
        const label = `${item.label}: was about ${money0(item.typical)} a month, ${sourceLabel} - ${lastSeen}`;
        const body = [
          el('span', { class: 'recurring-name muted' }, item.label),
          el('span', { class: 'recurring-months muted small' }, lastSeen),
          el('span', { class: 'recurring-amt num muted' }, `${money0(item.typical)}/mo`),
        ];
        // Card-sourced lapsed rows keep the same merchant drill-down active rows
        // use - still useful to review what it used to look like. Bank-sourced
        // rows stay non-interactive, matching the active list's own reasoning.
        if (item.source === 'card') {
          return el('button', { class: 'recurring-row', 'aria-label': label,
            onclick: () => applyFilter({ merchant: merchantRuleKeyFromDescription(item.label), merchantLabel: item.label, category: 'all' }, { expand: true, scroll: true }) }, ...body);
        }
        return el('div', { class: 'recurring-row', 'aria-label': label }, ...body);
      };
      appendExpandable(el, lapsedList, combined.lapsed, renderLapsedRow, { initial: 5 });
      lapsedBody.append(lapsedList);
      sec.append(renderExplainer(el, lapsedBody, { label: `May have ended (${combined.lapsed.length})` }));
    }
    return sec;
  }

  /* ---- 4b) spent abroad (foreign summary for the selected period) ---- */
  /* Scoped to periodRows() spend so it tracks the selected period like the rest
   * of the dashboard. Sums only the JMD amounts (foreignSummary never sums the
   * mixed foreign-currency values). If nothing foreign, the card is not
   * rendered. */
  function renderForeign(a) {
    const fx = foreignSummary(periodRows().filter((r) => r.kind === 'spend'));
    if (!fx.count) return null;
    const drill = () => applyFilter({ foreignOnly: true }, { expand: true, scroll: true });
    const sec = el('section', { class: 'card' });
    sec.append(el('div', { class: 'card-head' },
      el('h3', { class: 'card-title' }, icon(iconGlobe()), 'Spent abroad'),
      el('button', { class: 'btn sm ghost', onclick: drill }, 'View all')));
    const ccyText = fx.byCurrency.map((c) => c.ccy).join(', ');
    sec.append(el('div', { class: 'foreign-headline' },
      el('button', { class: 'foreign-amt', onclick: drill, title: 'Show all foreign purchases' }, money0(fx.totalJmd)),
      el('div', { class: 'muted small' }, `${fx.count} purchase${fx.count === 1 ? '' : 's'} in ${ccyText}`)));
    const list = el('div', { class: 'foreign-list' });
    const shown = fx.items.slice().sort((x, y) => y.amount - x.amount).slice(0, 8);
    for (const r of shown) {
      list.append(el('div', { class: 'foreign-row' },
        el('span', { class: 'swatch sm', style: `background:${catColour(r.category)}` }),
        el('span', { class: 'foreign-place' }, r.displayName || r.description.split(',')[0].trim()),
        el('span', { class: 'foreign-fx muted small' }, r.foreign),
        el('span', { class: 'foreign-jmd num strong' }, money0(r.amount))));
    }
    sec.append(list);
    if (fx.count > shown.length) sec.append(el('p', { class: 'muted small' }, `Showing the ${shown.length} largest. Use “View all” to see every foreign purchase.`));
    return sec;
  }

  /* ---- 6) recent activity (a light glance, not a second table) ----
     Recent answers one question, "what happened lately", so it is a short, calm
     list rather than a shorter copy of the All transactions table. It carries no
     column headers, no sort control and no Type column; each line is the place,
     its category, the amount and the date. Finding, filtering, sorting, opening
     and correcting all live in All transactions (renderExplorer), so the two
     surfaces no longer do the same job. "See all transactions" is the single way
     through to that deeper surface, and it reveals and scrolls to it. */
  function renderRecent(a) {
    const sec = el('section', { class: 'card' });
    const all = visibleRows();                 // one shared computation (memoised)
    const rows = all.slice(0, 5);
    sec.append(el('div', { class: 'card-head' },
      el('h3', { class: 'card-title' }, icon(iconList()), 'Recent activity')));
    if (!rows.length) { sec.append(el('p', { class: 'muted pad' }, 'No transactions match the current view.')); return sec; }
    const list = el('div', { class: 'recent-list' });
    for (const r of rows) {
      list.append(el('div', { class: 'recent-item' },
        el('div', { class: 'recent-main' },
          el('span', { class: 'recent-name' }, r.displayName || r.description),
          el('span', { class: 'recent-amt' + (r.amount < 0 ? ' credit' : '') }, (r.amount < 0 ? '+' : '') + money0(Math.abs(r.amount)))),
        el('div', { class: 'recent-meta' },
          el('span', { class: 'recent-cat' },
            el('span', { class: 'cat-dot', style: `background:${catColour(r.category)}` }),
            el('span', { class: 'recent-cat-name' }, isReview(r.category) ? 'To review' : r.category)),
          el('span', { class: 'recent-date muted small' }, r.date))));
    }
    sec.append(list);
    sec.append(el('button', { class: 'btn sm ghost recent-seeall',
      onclick: () => {
        state.showAllTx = true; render();
        smoothScrollToEl('#explorer');
      } }, `See all ${all.length} transactions \u2192`));
    return sec;
  }

  /* ---- 7) All transactions (search-first) ----
     This is the investigate surface, so it leads with search, not a wall of
     controls. The search field sits first and always; Month and Category are one
     tap away beneath it; Type, an amount range, Foreign and To review sit inside a
     "More filters" disclosure that stays closed until wanted. The applied-filter
     chips sit directly above the results, so the effect of any refinement is
     always visible next to the data it changed.
     The list is revealed on intent, not by default: with nothing searched or
     filtered it shows a calm one-line prompt, so the dashboard leads with its
     conclusions and Recent activity carries the "data exists" reassurance. Once a
     search term or any filter is active, the results appear, capped so a very
     large history never renders thousands of rows at once; "Show all" lifts the
     cap on request. */
  function renderExplorer(a) {
    const sec = el('section', { class: 'card', id: 'explorer' });
    const rows = visibleRows();
    const CAP = 50;
    sec.append(el('div', { class: 'card-head' },
      el('h3', { class: 'card-title' }, icon(iconExplore()), 'All transactions')));
    sec.append(renderFilters(a));
    sec.append(renderChips());
    // Unrefined and not explicitly opened: a calm search-first prompt, never an
    // auto-rendered slab of rows. "show all" reveals the full list on request.
    const refined = activeFilterCount() > 0;
    if (!refined && !state.showAllTx) {
      sec.append(el('p', { class: 'muted pad' },
        `${rows.length} transaction${rows.length === 1 ? '' : 's'} in ${a.label}. Search above, pick a filter, or `,
        el('button', { class: 'linkbtn', onclick: () => { state.showAllTx = true; render(); } }, `show all ${rows.length}`),
        '.'));
      return sec;
    }
    sec.append(renderMobileSortControls());
    if (!rows.length) {
      sec.append(el('div', { class: 'empty-row-lg' },
        el('p', {}, 'Nothing matches your search or filters.'),
        el('p', { class: 'muted' }, 'The search and filters are still active so the reason the view is empty stays visible.'),
        el('button', { class: 'btn sm', onclick: () => { clearFilters(); render(); } }, 'Clear search and filters')));
      return sec;
    }
    const capped = !state.showAllTx && rows.length > CAP;
    const shownRows = capped ? rows.slice(0, CAP) : rows;
    sec.append(txTable(shownRows, true));
    if (capped) {
      sec.append(el('div', { class: 'show-more' },
        el('span', { class: 'muted small' }, `Showing ${CAP} of ${rows.length}. Amounts in ${state.cfg.currency.code}.`),
        el('button', { class: 'btn sm', onclick: () => { state.showAllTx = true; render(); } }, `Show all ${rows.length}`)));
    } else {
      sec.append(el('p', { class: 'muted small' }, `${rows.length} shown. Amounts in ${state.cfg.currency.code}. Tap a row for the full detail.`));
    }
    return sec;
  }

  function renderFilters(a) {
    const f = state.filter;
    const wrap = el('div', { class: 'tx-filters' });
    // 1) Search leads, and is always present. A real label is supplied for
    //    assistive tech; the placeholder repeats the intent for sighted users.
    //    Debounced exactly as before: the value is captured immediately, the
    //    re-filter/re-render fires after a short pause, so nothing is lost.
    const search = el('input', { type: 'search', class: 'f-search', 'aria-label': 'Search transactions',
      placeholder: 'Search places, categories, amounts, dates…', value: f.search,
      oninput: (e) => { f.search = e.target.value; clearTimeout(_searchDebounce); _searchDebounce = setTimeout(renderExplorerOnly, 200); } });
    wrap.append(search);
    // 2) The two most-used refinements sit one tap away, beneath the search.
    const monthSel = el('select', { 'aria-label': 'Month', onchange: (e) => { f.month = e.target.value; render(); } },
      el('option', { value: 'all' }, 'All months in period'),
      ...a.months.slice().reverse().map((m) => el('option', { value: m, selected: f.month === m ? '' : null }, monthLabel(m))));
    const catSel = el('select', { 'aria-label': 'Category', onchange: (e) => { f.category = e.target.value; f.reviewOnly = false; render(); } },
      el('option', { value: 'all' }, 'All categories'),
      ...a.by_category.map((c) => el('option', { value: c.name, selected: f.category === c.name ? '' : null }, isReview(c.name) ? 'To review' : c.name)));
    wrap.append(el('div', { class: 'tx-quick' }, monthSel, catSel));
    // 3) Everything heavier lives behind a disclosure that stays closed until
    //    asked for. Native <details> keeps this keyboard- and screen-reader-
    //    accessible with no extra script, mirrors the app's existing
    //    explainer / "Data & settings" disclosures, and needs no modal plumbing.
    //    _moreFiltersOpen preserves the open state across the debounced
    //    renderExplorerOnly rebuilds, so typing an amount never snaps it shut.
    //    Min/Max carry distinct classes (f-min / f-max) so renderExplorerOnly
    //    can return focus to the exact field after a rebuild.
    const kindSel = el('select', { 'aria-label': 'Type', onchange: (e) => { f.kind = e.target.value; render(); } },
      ...[['all', 'All types'], ['spend', 'Purchases'], ['payment', 'Card payments'], ['refund', 'Refunds'], ['fee', 'Fees & tax']]
        .map(([v, l]) => el('option', { value: v, selected: f.kind === v ? '' : null }, l)));
    const min = el('input', { type: 'number', class: 'f-num f-min', 'aria-label': 'Minimum amount', placeholder: 'Min', value: f.min ?? '', oninput: (e) => { f.min = e.target.value ? +e.target.value : null; renderExplorerOnly(); } });
    const max = el('input', { type: 'number', class: 'f-num f-max', 'aria-label': 'Maximum amount', placeholder: 'Max', value: f.max ?? '', oninput: (e) => { f.max = e.target.value ? +e.target.value : null; renderExplorerOnly(); } });
    const fx = el('label', { class: 'f-check' }, el('input', { type: 'checkbox', checked: f.foreignOnly ? '' : null, onchange: (e) => { f.foreignOnly = e.target.checked; render(); } }), ' Foreign only');
    const rev = el('label', { class: 'f-check' }, el('input', { type: 'checkbox', checked: f.reviewOnly ? '' : null, onchange: (e) => { f.reviewOnly = e.target.checked; render(); } }), ' To review');
    const more = el('details', { class: 'tx-more', open: _moreFiltersOpen ? '' : null,
      ontoggle: (e) => { _moreFiltersOpen = e.target.open; } });
    more.append(el('summary', {}, 'More filters'));
    more.append(el('div', { class: 'tx-more-body' },
      el('label', { class: 'tx-field' }, el('span', { class: 'tx-field-label muted small' }, 'Type'), kindSel),
      el('div', { class: 'tx-field' }, el('span', { class: 'tx-field-label muted small' }, 'Amount'),
        el('div', { class: 'f-range' }, min, el('span', { class: 'muted' }, '-'), max)),
      fx, rev,
      el('button', { class: 'btn sm ghost', onclick: () => { clearFilters(); render(); } }, 'Clear search and filters')));
    wrap.append(more);
    return wrap;
  }

  function renderMobileSortControls() {
    const fields = [
      ['date', 'Date'],
      ['amount', 'Amount'],
      ['category', 'Category'],
      ['description', 'Description'],
    ];
    const fieldSel = el('select', { class: 'mobile-sort-field', name: 'sort-transactions-by', 'aria-label': 'Sort transactions by', onchange: (e) => { if (state.sort.key !== e.target.value) setSort(e.target.value); } },
      ...fields.map(([value, label]) => el('option', { value, selected: state.sort.key === value ? '' : null }, label)));
    const dirBtn = el('button', { class: 'btn sm mobile-sort-dir', 'aria-label': `Sort ${state.sort.dir === 'asc' ? 'ascending' : 'descending'}`,
      onclick: () => setSort(state.sort.key) },
      el('span', { class: 'btn-ic', html: state.sort.dir === 'asc' ? iconUp() : iconDown() }),
      el('span', { class: 'btn-label' }, state.sort.dir === 'asc' ? 'Asc' : 'Desc'));
    return el('div', { class: 'mobile-sort' }, el('span', { class: 'muted small' }, 'Sort by'), fieldSel, dirBtn);
  }

  // Light refresh of just the explorer contents on search / amount typing.
  // Remembers which filter field is focused (and, for the text search, the caret
  // position) so a rebuild never throws the person out of the field being typed
  // in. Number inputs (Min / Max) do not support selection ranges, so only the
  // search caret is captured and restored; the amount fields are simply
  // refocused. The "More filters" panel reopens on its own via _moreFiltersOpen.
  function renderExplorerOnly() {
    const old = $('#explorer'); if (!old) { render(); return; }
    const active = document.activeElement;
    let focusSel = null, selStart = null, selEnd = null;
    if (active && old.contains(active)) {
      if (active.classList.contains('f-search')) focusSel = '.f-search';
      else if (active.classList.contains('f-min')) focusSel = '.f-min';
      else if (active.classList.contains('f-max')) focusSel = '.f-max';
      if (focusSel === '.f-search') { selStart = active.selectionStart; selEnd = active.selectionEnd; }
    }
    const a = analysis();
    const next = renderExplorer(a);
    old.replaceWith(next);
    updateFooter();
    if (focusSel) {
      const t = $('#explorer ' + focusSel);
      if (t) {
        t.focus();
        if (focusSel === '.f-search' && selStart != null && t.setSelectionRange) {
          try { t.setSelectionRange(selStart, selEnd); } catch { /* non-text input: focus only */ }
        }
      }
    }
  }

  function renderChips() {
    const f = state.filter;
    const items = [];
    const add = (label, clear) => items.push({ label, onClear: () => { clear(); render(); } });
    if (f.month !== 'all') add(monthLabel(f.month), () => f.month = 'all');
    if (f.category !== 'all') add(isReview(f.category) ? 'To review' : f.category, () => f.category = 'all');
    if (f.merchant) add(f.merchantLabel || f.merchant, () => { f.merchant = ''; f.merchantLabel = ''; });
    if (f.kind !== 'all') add({ spend: 'Purchases', payment: 'Payments', refund: 'Refunds', fee: 'Fees & tax' }[f.kind], () => f.kind = 'all');
    if (f.foreignOnly) add('Foreign only', () => f.foreignOnly = false);
    if (f.reviewOnly) add('To review', () => f.reviewOnly = false);
    if (f.min != null) add(`≥ ${money0(f.min)}`, () => f.min = null);
    if (f.max != null) add(`≤ ${money0(f.max)}`, () => f.max = null);
    if (f.search) add(`“${f.search}”`, () => f.search = '');
    return renderFilterChips(el, iconX, items, () => { clearFilters(); render(); }) || el('span');
  }

  // One shared category tag used everywhere a category is shown (the category
  // panel, Top places and every transaction row): a small colour dot followed
  // by the category name at one consistent size and weight. Presentation only -
  // it reads catColour/isReview but never changes a category or a total.
  // Passing `onclick` makes it the tappable picker trigger for a transaction
  // row (rendered as a button); otherwise it is a plain, non-interactive tag.
  // The fallback keeps its muted "To review" treatment in every place.
  function catTag(name, opts = {}) {
    const review = isReview(name);
    const cls = 'cat-tag' + (review ? ' review' : '') + (opts.onclick ? ' cat-tag-btn' : '') + (opts.class ? ' ' + opts.class : '');
    const kids = [
      el('span', { class: 'cat-dot', style: `background:${catColour(name)}` }),
      el('span', { class: 'cat-tag-name' }, review ? 'To review' : name),
    ];
    if (opts.onclick) return el('button', { class: cls, type: 'button', onclick: opts.onclick }, ...kids);
    return el('span', { class: cls }, ...kids);
  }

  function txTable(rows, full) {
    const th = (key, label, num) => el('th', { class: (num ? 'num ' : '') + 'sortable' + (state.sort.key === key ? ' sorted' : ''),
      onclick: () => setSort(key) }, label, state.sort.key === key ? el('span', { class: 'sort-caret', html: state.sort.dir === 'asc' ? iconUp() : iconDown() }) : null);
    const table = el('table', { class: 'grid tx' + (full ? ' full' : '') });
    table.append(el('thead', {}, el('tr', {},
      th('date', 'Date'), th('description', 'Description'), el('th', {}, 'Type'), th('category', 'Category'),
      th('amount', `Amount (${state.cfg.currency.code})`, true))));
    const body = el('tbody');
    for (const r of rows) {
      const tr = el('tr', { class: 'tx-row', tabindex: '0',
        onclick: (e) => { if (e.target.closest('.cat-tag-btn')) return; toggleDetail(tr, r); },
        onkeydown: (e) => { if (e.key === 'Enter') toggleDetail(tr, r); } });
      tr.append(
        el('td', { class: 'nowrap' }, r.date),
        el('td', {}, el('div', { class: 'desc' }, r.displayName || r.description), r.foreign ? el('div', { class: 'fx-line muted small' }, r.foreign) : null),
        el('td', { 'data-label': 'Type' }, kindTag(r.kind)),
        el('td', { 'data-label': 'Category' }, catTag(r.category, { onclick: (e) => { e.stopPropagation(); openCategoryPicker(r); } })),
        el('td', { class: 'num amt ' + (r.amount < 0 ? 'credit' : '') }, (r.amount < 0 ? '+' : '') + money0(Math.abs(r.amount))),
      );
      body.append(tr);
    }
    table.append(body);
    return el('div', { class: 'table-wrap' + (full ? ' sticky' : '') }, table);
  }

  // The type indicator is now a quiet dot + text label rather than a bordered
  // chip, so a dense transaction row no longer out-shouts the calm cards above.
  // The colour lives on the dot; the text label always names the type, so the
  // distinction never relies on colour alone.
  function kindTag(kind) {
    const map = { spend: ['Purchase', 'k-spend'], payment: ['Payment', 'k-pay'], refund: ['Refund', 'k-refund'], fee: ['Fee', 'k-fee'] };
    const [label, cls] = map[kind] || ['-', ''];
    return renderKindTag(el, label, cls);
  }

  function toggleDetail(tr, r) {
    const next = tr.nextElementSibling;
    if (next && next.classList.contains('tx-detail')) { next.remove(); tr.classList.remove('open'); return; }
    document.querySelectorAll('.tx-detail').forEach((d) => { const p = d.previousElementSibling; if (p) p.classList.remove('open'); d.remove(); });
    tr.classList.add('open');
    // Progressive disclosure: the plain-language reason a transaction was
    // flagged (reviewReasonText) is never shown up front on the dashboard -
    // it appears only here, the same place "Original statement text" already
    // lives, reached only by a person deliberately tapping a row. For an
    // ordinary, fully-resolved transaction reviewReasonText returns null, so
    // this line is simply absent from the DOM - never a blank row, never a
    // dash, never a "no issues" placeholder cluttering the common case.
    const reviewReason = reviewReasonText(r, FALLBACK(), state.brandRules, state.merchants);
    const cell = el('td', { colspan: 5 },
      el('div', { class: 'detail-grid' },
        detailKV('Original statement text', r.raw_description),
        detailKV('Statement file', r.source_file),
        detailKV('Posted', r.date),
        r.foreign ? detailKV('Foreign amount', r.foreign) : null,
        detailKV('Type', ({ spend: 'Purchase', payment: 'Card payment', refund: 'Refund', fee: 'Fee / tax' }[r.kind] || r.kind)),
        reviewReason ? detailKV('Why we flagged this', reviewReason) : null,
        el('div', { class: 'detail-actions' }, el('button', { class: 'btn sm', onclick: () => openCategoryPicker(r) }, 'Change category'))));
    tr.after(el('tr', { class: 'tx-detail' }, cell));
  }
  function detailKV(k, v) { return el('div', { class: 'kv' }, el('div', { class: 'kv-k muted small' }, k), el('div', { class: 'kv-v' }, v)); }

  function setSort(key) {
    if (state.sort.key === key) state.sort.dir = state.sort.dir === 'asc' ? 'desc' : 'asc';
    else state.sort = { key, dir: (key === 'amount' || key === 'date') ? 'desc' : 'asc' };
    render();
  }

  /* ---- 8) secondary technical / data info ---- */
  function renderSecondary(a) {
    const s = state.allSummary;
    const details = el('details', { class: 'card secondary' });
    details.append(el('summary', {}, icon(iconInfo()), ' Data & settings'));
    const grid = el('div', { class: 'sec-grid' },
      secItem('Lifetime purchases', money0(s.total_spend)),
      secItem('Typical month', money0(histMonthlyAverage())),
      secItem('Months on record', String(s.n_months)),
      secItem('Sorted automatically', `${s.n_spend - s.n_uncategorised_spend} of ${s.n_spend} (${s.coverage_pct}%)`),
      secItem('Transactions stored', String(s.n_transactions)),
      secItem('Statements analysed', String(statementCount())),
    );
    details.append(grid);
    const gaps = missingMonths(allMonths());
    if (gaps.length) details.append(el('p', { class: 'muted small' }, `Missing statement months: ${gaps.map(monthLabel).join(', ')}.`));
    // Card fitness moved UP to a first-class card (renderCardFitness, in
    // render()'s Cards sequence). What stays here is only the data-quality
    // plumbing: how many statements reconcile and the cross-ledger payment
    // link. Those are trust signals, not a statement about how the card is
    // serving the person, so they belong in Data & settings.
    const cardTrust = renderCardStatementTrust();
    if (cardTrust) details.append(cardTrust);
    // Manage-data actions section (Recommendation 3): the former standalone
    // "Manage data" card is now a labelled section inside this one "Data &
    // settings" details, so the Cards tail is a single collapsed card. Uses the
    // one shared manageDataBody() from app.js (the same body the standalone
    // Overview/Accounts card uses), so the actions never drift between tabs.
    details.append(manageDataBody());
    details.append(el('p', { class: 'muted small', id: 'status-line-sec' }, statusText()));
    return details;
  }

  /* Card statement health block (Recommendations 1-4). Reads the stored
   * per-statement records: how many reconcile, the latest cycle's utilisation
   * and revolving status, minimum payment, and how many card payments are
   * matched to a bank transfer (double-count avoided). Presentation only. */
  // Normalise a stored EAIR to a fraction. Some card records carry a percent
  // (42.0), others a fraction (0.42); anything > 1 is read as a percent.
  // Returns null when absent or non-positive, so the caller degrades to a calm
  // status with no projection rather than inventing a rate.
  function normEair(eair) {
    const n = Number(eair);
    if (!Number.isFinite(n) || n <= 0) return null;
    return n > 1 ? n / 100 : n;
  }
  // The median posted payment over the most recent (up to 6) statements that
  // carry one - roughly what the person has actually been paying, robust to a
  // single unusually large or small month. 0 when none is recorded.
  function medianPayment(stmts) {
    const pays = stmts.slice(-6).map((s) => Math.abs(Number(s.payments) || 0)).filter((v) => v > 0);
    if (!pays.length) return 0;
    const s = pays.slice().sort((x, y) => x - y);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }
  /* "How your card is doing" (persona move 2: instrument fitness).
   * Rewritten to classify BEHAVIOUR from evidence, not from a single cycle's
   * balance. cardBehaviourState (reporting.js) keys on interest actually
   * charged over recent cycles - the defining signal in the credit-card
   * literature (a transactor pays in full and incurs no interest; a revolver
   * carries a balance and pays interest) - so a large statement balance that
   * accrued $0 interest correctly reads as pay-in-full, not as debt (the exact
   * case that was mislabelled before). Three honest states, each saying only
   * what the statements support and never asserting the user's intent:
   *   - pays-in-full: no interest recently -> calm confirmation, no payoff maths.
   *   - paying-interest: interest charged -> the real interest cost, how often
   *     it has appeared, and an "if this continues" projection using proper
   *     month-by-month amortisation (projectCardPayoff) - an observation, never
   *     a "you should".
   *   - insufficient: too few cycles, or interest/rate fields unreadable (e.g.
   *     NCB) -> exact figures, explicitly no verdict.
   * Utilisation is framed wherever shown: it is a statement-closing-balance,
   * credit-score input, not a spend or debt measure - so a score-builder and a
   * debt-carrier both read it correctly. Card-only; returns null with no card
   * statements. Reuses existing card / hero-figure / sec-grid styles. */
  function renderCardFitness() {
    const stmts = (state._cardStatements || []).slice()
      .sort((a, b) => String(a.statementKey).localeCompare(String(b.statementKey)));
    if (!stmts.length) return null;
    const latest = stmts[stmts.length - 1];
    const sec = el('section', { class: 'card' });
    sec.append(el('div', { class: 'card-head' },
      el('h3', { class: 'card-title' }, icon(iconReceipt()), 'How your card is doing')));

    const eairFrac = normEair(latest.eair);
    const behaviour = cardBehaviourState(state._cardStatements);

    // Utilisation framed as a credit-score input on the statement-closing
    // balance, so it is never mistaken for spending or debt. Shown in every
    // branch that has a utilisation figure.
    const utilisationNote = () => (latest.utilisation == null ? null
      : el('p', { class: 'muted small' },
          `Credit used is ${latest.utilisation}% - the balance on your statement date against your limit. It reflects the statement-closing balance and is mainly a credit-score input, not a measure of your spending or interest.`));

    // 1) Pays in full: no interest recently. Calm confirmation, no payoff maths.
    if (behaviour === 'pays-in-full') {
      const n = Math.min(stmts.length, 3);
      const nText = n === 1 ? 'your latest statement' : `your last ${n} statements`;
      sec.append(el('div', { class: 'hero-figure' },
        el('div', { class: 'fact-value', style: 'font-size:22px' }, 'Paid in full, no interest'),
        el('div', { class: 'muted small' }, `No interest has been charged on ${nText}, so you are not carrying a cost on the card.`)));
      if (eairFrac != null) {
        const eairPct = Math.round(eairFrac * 100);
        if (latest.eairEstimated && latest.purchaseAnnualPct != null) {
          const disclosedPct = Math.round(latest.purchaseAnnualPct);
          const monthlyPct = latest.purchaseMonthlyPct;
          sec.append(el('p', { class: 'muted small' },
            `Your statement shows a purchase rate of ${disclosedPct}% a year${monthlyPct != null ? ` (${monthlyPct}% a month)` : ''}. Carrying a balance would compound that monthly to a real yearly cost closer to ${eairPct}%, but clearing the statement each cycle means you pay none of it.`));
        } else if (latest.eairEstimated) {
          sec.append(el('p', { class: 'muted small' },
            `Clearing the statement each cycle avoids interest at an estimated ${eairPct}% a year, worked out from the monthly rate printed on your statement.`));
        } else {
          sec.append(el('p', { class: 'muted small' },
            `Clearing the statement each cycle avoids interest at about ${eairPct}% a year.`));
        }
      }
      const un = utilisationNote(); if (un) sec.append(un);
      return sec;
    }

    // 2) Insufficient signal: too few cycles, or interest/rate not readable.
    if (behaviour === 'insufficient') {
      const owed = latest.newBalance != null ? latest.newBalance : latest.amountOwing;
      sec.append(el('div', { class: 'hero-figure' },
        el('div', { class: 'fact-value', style: 'font-size:26px' }, owed == null ? '\u2014' : money0(owed)),
        el('div', { class: 'muted small' }, 'balance on your latest statement')));
      const grid = el('div', { class: 'sec-grid', style: 'margin-top:12px' },
        secItem('Credit used', latest.utilisation == null ? '\u2014' : `${latest.utilisation}%`),
        latest.interestCharges == null ? null : secItem('Interest this cycle', money0(latest.interestCharges)),
        latest.minimumPayment == null ? null : secItem('Minimum payment', money0(latest.minimumPayment)),
      );
      sec.append(grid);
      const un = utilisationNote(); if (un) sec.append(un);
      sec.append(renderExplainer(el, 'There is not enough statement history yet - or the interest and rate details could not be read from these statements - to characterise how the card is being used or to estimate a payoff. The figures shown are exact.', { label: 'Why there\u2019s no payoff estimate yet' }));
      return sec;
    }

    // 3) Paying interest: a real cost is being carried. Lead with the balance,
    // state the interest actually charged and how often it has appeared, then an
    // "if this continues" projection (proper amortisation) - observation, not
    // instruction, and never a claim about why the balance is being carried.
    const owed = latest.newBalance != null ? latest.newBalance : latest.amountOwing;
    sec.append(el('div', { class: 'hero-figure' },
      el('div', { class: 'fact-value', style: 'font-size:26px' }, owed == null ? '\u2014' : money0(owed)),
      el('div', { class: 'muted small' }, 'carried on your card')));

    const interest = Number(latest.interestCharges) || 0;
    const recent = stmts.slice(-3).filter((s) => s.interestCharges != null);
    const chargedCount = recent.filter((s) => Number(s.interestCharges) > 1).length;
    if (interest > 0) {
      sec.append(el('p', { class: 'muted small' },
        `You were charged ${money0(interest)} in interest on your latest statement`
        + (chargedCount > 1 ? `, and interest has appeared on ${chargedCount} of your last ${recent.length} statements.` : '.')));
    }

    const typicalPayment = medianPayment(stmts);
    const projection = projectCardPayoff(owed, eairFrac, typicalPayment);
    if (projection && !projection.neverClears) {
      sec.append(el('p', { class: 'muted small' },
        `If that continues, at about what you have been paying (${money0(typicalPayment)} a month), the balance would clear in about ${projection.months} month${projection.months === 1 ? '' : 's'} and cost roughly ${money0(projection.totalInterest)} more in interest.`));
    } else if (projection && projection.neverClears) {
      sec.append(el('p', { class: 'muted small' },
        `At about what you have been paying (${money0(typicalPayment)} a month), the balance is barely moving - almost all of that payment is going to interest.`));
    }
    if (latest.minimumPayment != null && latest.minimumPayment > 0) {
      sec.append(el('p', { class: 'muted small' },
        `The minimum payment this cycle is ${money0(latest.minimumPayment)}. On most cards the minimum falls as the balance does, so paying only the minimum stretches a balance out for a long time.`));
    }

    const grid = el('div', { class: 'sec-grid', style: 'margin-top:12px' },
      secItem('Credit used', latest.utilisation == null ? '\u2014' : `${latest.utilisation}%`),
      latest.interestCharges == null ? null : secItem('Interest this cycle', money0(latest.interestCharges)),
      latest.minimumPayment == null ? null : secItem('Minimum payment', money0(latest.minimumPayment)),
    );
    sec.append(grid);
    const un = utilisationNote(); if (un) sec.append(un);

    if (eairFrac == null) {
      sec.append(renderExplainer(el, 'The projection needs the card\u2019s interest rate, which could not be read from this statement. The balance, interest and payments shown are exact; only the forward estimate is unavailable.', { label: 'Why there\u2019s no payoff estimate' }));
    }
    return sec;
  }

  /* The data-quality plumbing that stays in Data & settings: how many
   * statements reconcile, and how many card payments trace to a bank transfer
   * (so cross-ledger totals are not double-counted). Trust signals, not a
   * verdict on how the card is serving the person - which is why they sit here
   * and the fitness answer above sits at the top of the tab. Byte-identical to
   * the reconciliation + cross-ledger lines of the former renderCardStatementHealth. */
  function renderCardStatementTrust() {
    const stmts = (state._cardStatements || []).slice()
      .sort((a, b) => String(a.statementKey).localeCompare(String(b.statementKey)));
    if (!stmts.length) return null;
    const wrap = el('div', { class: 'sec-section' });
    wrap.append(el('div', { class: 'sec-subhead' }, icon(iconInfo()), ' Card statements'));
    const reconciled = stmts.filter((s) => s.reconciled).length;
    wrap.append(el('p', { class: 'muted small' },
      `${reconciled} of ${stmts.length} statement${stmts.length === 1 ? '' : 's'} reconcile (previous balance + purchases + payments = new balance).`));
    if (state.bankRecords && state.bankRecords.length && state.cardAccounts && state.cardAccounts.length) {
      const card4 = new Set(state.cardAccounts.map((c) => String(c).slice(-4)));
      const bankToCard = classifiedBank()
        .filter((r) => r.direction === 'out' && counterpartyAccountTokens(r.description).size &&
          [...counterpartyAccountTokens(r.description)].some((t) => card4.has(String(t).slice(-4))))
        .map((r) => ({ id: r.id, date: r.date, amount: r.amount }));
      const cardPays = state.records.filter((r) => r.kind === 'payment')
        .map((r) => ({ id: r.id, date: r.date, amount: r.amount }));
      if (bankToCard.length && cardPays.length) {
        const link = linkCardPayments(bankToCard, cardPays, { windowDays: 4 });
        wrap.append(el('p', { class: 'muted small' },
          `${link.matched} of ${link.total} card payments trace to a bank transfer, so those are counted once, not twice.`));
      }
    }
    return wrap;
  }
  return {
    renderHero, renderInsightsAndAttention, renderTrend, renderCategoryPanel,
    renderForeign, renderMerchants, renderRecurring, renderRecent, renderExplorer,
    renderSecondary, renderCardFitness, prevLabel, histMonthlyAverage, buildInsights,
  };
}