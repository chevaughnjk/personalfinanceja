/*
 * overview-render.js  -  Overview: where things stand today.
 *
 * The plan's Overview, no narration. The lead is "Available now" (three honest
 * layers, available-now-preview.js), followed by the money-in vs money-out
 * flow chart (its own card), the period-coverage note, and the two onward
 * doorways (Right Now, Ahead). Every figure it shows lives elsewhere in full -
 * this screen answers one question (where things stand) and does not restate
 * a number a person can see on its home screen.
 *
 * The twelve-beat narrative (buildOverviewNarrative) that this file once
 * rendered is retired: its figures each live on their own screens (net
 * position on Position, runway on Ahead, income anomaly on the income card,
 * category spikes on Right Now's "Worth a look"), so narrating them here was
 * duplication the plan explicitly forbids. A dedicated "Needs attention"
 * section (the plan's own Overview element) is a later stage, not built here.
 */
import {
  periodCoverageNote,
  buildAttentionItems,
  renderAttentionList,
  isUnrecognised,
  detectPossibleDuplicates,
  detectCategorySpikes,
} from '../analysis/reporting.js';
import { requireCtx, formatDisplayDate } from '../core/shared-helpers.js';
import { createAvailableNow } from './available-now-preview.js';
import { pairCards } from './chart-helpers.js';

export function createOverviewRenderer(ctx) {
  requireCtx(
    ctx,
    [
      'state',
      'el',
      'icon',
      'bankMoney',
      'resolved',
      'allLedgerMonths',
      'overviewModel',
      'periodEmptyNotice',
      'switchLedgerView',
      'trackUsage',
      'iconInfo',
      'provenModels',
      'renderFlowChart',
      'money0',
      'dismissReview',
      'pickStatements',
      'drillToTransactions',
    ],
    'createOverviewRenderer'
  );

  const {
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
    iconInfo,
    provenModels,
    renderFlowChart,
    money0,
    dismissReview,
    pickStatements,
    drillToTransactions,
  } = ctx;

  // The plan's "available now" lead hero card. Built once here, matching
  // every other factory-scoped renderer in this app.
  const { renderAvailableNow } = createAvailableNow({
    el,
    icon,
    provenModels,
    bankMoney,
    iconInfo,
  });

  function renderOverview() {
    const wrap = el('div', { class: 'accounts-wrap accounts-grid' });
    const { recs, cardSummary, rollAllTrend } = overviewModel();

    // Shared-window empty state: neither ledger has activity in the selected
    // period. A plain notice instead of a screen built on nothing.
    if (!recs.length && (!cardSummary || cardSummary.n_transactions === 0)) {
      wrap.append(periodEmptyNotice('money movements', allLedgerMonths()));
      return wrap;
    }

    // 1) The lead hero: "available now" as one figure, working folded into Why.
    const lead = renderAvailableNow();
    if (lead) wrap.append(lead);

    // 2) Needs attention: only items that call for a DECISION (the plan's own
    // bar). Reads the SAME buildAttentionItems (reporting.js) Right Now's
    // fuller "Worth a look" queue reads, filtered here to the blocking head -
    // a shortfall before income (from the same availableNow model the lead
    // card above shows) or an unreconciled statement. The optional tidying
    // (review-worthy purchases, duplicates, category spikes) stays on Right
    // Now, never duplicated here. One resolver, two views, no divergence.
    const attnItems = buildAttentionItems({
      cardRows: [], // Overview's blocking items are statement/shortfall level,
      cardStatements: state._cardStatements || [],
      bankStatements: state._bankStatements || [],
      brandRules: state.brandRules,
      merchants: state.merchants,
      rows: state.rows,
      period: resolved(),
      cfg: state.cfg,
      splits: state.transactionSplits || [],
      fallback: undefined,
      availableNow: provenModels.availableNow(),
      money0,
      formatDisplayDate,
      isUnrecognised,
      detectPossibleDuplicates,
      detectCategorySpikes,
      dismissReview,
      pickStatements,
      drillToTransactions,
    }).filter((it) => it.tone === 'blocking');
    const attnCard = renderAttentionList(el, icon, {
      title: 'Needs attention',
      iconInfo,
      items: attnItems,
      calmText: 'Nothing needs a decision right now.',
    });

    // 3) Cash inflow vs Cash outflow over the recent months, its own card. Shows
    // direction and the ahead/short balance at a glance - the plan's "recent
    // movement" element. Reads rollAllTrend (the full-history trend), moves no
    // total, so cross_screen_consistency stays green by construction.
    const flowChart = renderFlowChart(rollAllTrend);
    if (flowChart) {
      const chartCard = el('section', { class: 'card' });
      chartCard.append(
        el(
          'div',
          { class: 'card-head' },
          el('h3', { class: 'card-title' }, icon(iconInfo()), 'Cash in and out')
        )
      );
      chartCard.append(flowChart);
      wrap.append(chartCard);
    }

    // 3) Honest partial-data note when the period's coverage is incomplete -
    // the "partial data never looks complete" rule, kept.
    const covNote = periodCoverageNote(state.coverage, resolved());
    if (covNote) {
      const noteCard = el('section', { class: 'card' });
      noteCard.append(el('p', { class: 'muted small', style: 'margin:0' }, covNote));
      wrap.append(noteCard);
    }

    // 4) Where to go next: the two onward doorways. Compact card (no divider/
    // heavy padding) so it reads as a tidy action pair, not a hollow panel.
    // Header matches every other card's card-head/card-title/icon convention
    // so this reads as a true peer of "Needs attention" beside it, not a
    // leftover label style from the retired narrative-era Overview.
    const next = el('section', { class: 'card' });
    next.append(
      el(
        'div',
        { class: 'card-head' },
        el('h3', { class: 'card-title' }, icon(iconInfo()), 'Where to next')
      )
    );
    const nextActions = el('div', { class: 'overview-next-actions' });
    nextActions.append(
      el(
        'button',
        {
          class: 'btn primary',
          onclick: () => {
            trackUsage('overview-open-activity');
            switchLedgerView('activity');
          },
        },
        'Open Activity'
      )
    );
    if (state.bankRecords.length) {
      nextActions.append(
        el(
          'button',
          {
            class: 'btn primary',
            onclick: () => {
              trackUsage('overview-open-ahead');
              switchLedgerView('ahead');
            },
          },
          'Open Forecast'
        )
      );
    }
    next.append(nextActions);

    // Needs attention + Where to next: two short cards, paired side by side on
    // desktop (both are compact - one calm line and two buttons - so stacking
    // them full-width wasted a row each). The flow chart above stays full-width.
    pairCards(wrap, attnCard, next);

    return wrap;
  }

  return { renderOverview };
}
