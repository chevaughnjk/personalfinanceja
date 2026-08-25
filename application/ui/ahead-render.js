/*
 * ahead-render.js  -  the "Ahead" destination: Coming Up (Round 2) and Where
 * you're headed - goal-setting, the scenario tool, the monthly follow-up
 * (Round 4, plan section 6.2).
 *
 * The forecast switches on only once there is enough bank history to trust
 * it (state.cfg.ahead.minMonthsForForecast, default 2 months) and a readable
 * cash position exists. Below that, this shows a calm explanation of what is
 * missing and how close the person already is - never a shaky guess dressed
 * up as a real number, matching how every other "not enough yet" state in
 * this app already behaves (periodEmptyNotice, detectIncompleteMonth).
 *
 * Every Coming Up figure is read from data already stored - the current cash
 * position, the combined regular commitments (with their expected day), and
 * the recurring income pattern - never from day-to-day discretionary
 * spending, which this app does not attempt to predict.
 *
 * Where you're headed holds three things new to the app: a single stated
 * goal (GOAL_TYPES, reporting.js - a short fixed set the app can honestly
 * measure, never open text), a hands-on scenario tool that recomputes the
 * SAME runway figure Overview's own narrative already uses, and the monthly
 * honest follow-up - a frozen record app.js's checkMonthlyGoalIfDue already
 * builds each month, simply displayed here. Goal-setting itself is a plain
 * inline form (matching manage-data.js's "Your name" section), not a modal,
 * since it is a personal setting a person returns to and edits, not a
 * one-off per-row action.
 */
import {
  projectCashFlow,
  nextStatementNudge,
  GOAL_TYPES,
  describeGoal,
  computeScenario,
  typicalMonthlyOutflow,
  ymToday,
  monthName,
  runwayDays,
} from '../analysis/reporting.js';
import {
  analyseIncomePattern,
  analyseBankActivity,
} from '../analysis/bank-analysis.js';
import { formatDisplayDate, requireCtx, addDaysIso } from '../core/shared-helpers.js';
import { pairCards } from './chart-helpers.js';
// Goal-system migration, now complete: the PROVEN goals engine
// (goalProgress/buildGoalModel/resolveSafetyBoundary/safeContribution) is
// the SOLE engine behind every goal type - cushion, spend-ceiling and (as
// of G, the clear-card engine extension) clear-card too. The old
// reporting.js computeGoalProgress/describeGoal path is retired from the
// live card entirely; describeGoal is still imported above purely for the
// "not enough data yet" fallback sentence, which reads identically well
// under either engine.
import {
  goalProgress,
  resolveSafetyBoundary,
  safeContribution,
  buildGoalModel,
} from '../analysis/goals.js';
import { ensureMigrated } from '../analysis/goal-migrate.js';

// Module-level, session-only UI state - the same pattern cards-render.js
// already uses for _searchDebounce/_moreFiltersOpen: state that belongs to
// the interaction itself (which goal type is being drafted, which scenario
// items are toggled), never persisted, and reset naturally on a fresh load.
let _goalDraftType = null;
// key -> reduction fraction (0 keep / 0.5 cut half / 1 cut all). Replaces the
// old binary _scenarioExcluded Set: "Test a decision" now models spending
// LESS in a category, the realistic lever, not only removing it entirely.
let _scenarioReductions = new Map();
let _scenarioExtraCost = 0;
// Step 2 continued: the safety-boundary DRAFT kind being edited (null when
// the form is closed). The boundary itself, once saved, lives under its own
// storage key (financeGoalBoundary) - deliberately separate from state.goal,
// so it survives a goal change/clear/migration untouched, the same reasoning
// state.firstName survives doClearAll. Loaded once at boot into
// state._goalBoundary (app.js), read here, written here via a small local
// persist helper - this file does not own Store directly anywhere else, so
// that access is added narrowly, matching the existing pattern of goal
// persistence itself (setGoal/clearGoal live in app.js, not here).
let _boundaryDraftKind = null;

export function createAheadRenderer(ctx) {
  requireCtx(
    ctx,
    [
      'state',
      'el',
      'icon',
      'render',
      'bankMoney',
      'classifiedBank',
      'commitmentsModel',
      'money0',
      'moneyShort',
      'monthLabel',
      'bankMonthsList',
      'pickStatements',
      'trackUsage',
      'switchLedgerView',
      'drillToAccountsPayee',
      'drillToTransactions',
      'cleanCounterparty',
      'toast',
      'overviewModel',
      'analysis',
      'setGoal',
      'clearGoal',
      'restoreGoal',
      'renderForecastChart',
      'Store',
      'provenModels',
      'buildNewEngineProgressCtx',
      'latestCompleteGoalMonth',
      'evaluateGoal',
      'iconCal',
      'iconGap',
      'iconRepeat',
      'iconChart',
      'iconFlag',
    ],
    'createAheadRenderer'
  );
  const {
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
    renderForecastChart,
    Store,
    provenModels,
    buildNewEngineProgressCtx,
    latestCompleteGoalMonth,
    iconCal,
    iconGap,
    iconRepeat,
    iconChart,
    iconFlag,
  } = ctx;

  // Where a commitment or the income row should send a person when tapped.
  // A bank-side commitment (or the income row itself, which always carries a
  // real counterpartyKey) drills straight into its Right Now detail, the same
  // way every other bank commitment already does elsewhere in the app. A
  // card-side commitment has no equivalent deep link from here (Ahead has no
  // card transaction list of its own), so it opens Right Now plainly - the
  // same "go to the relevant tab" shallow route Overview's own routing card
  // already uses, rather than inventing a new kind of cross-tab link.
  function rowDrill(item) {
    // A card-side commitment refers to a recurring MERCHANT pattern, not
    // one single transaction, so this stays a filter-level drill (the same
    // merchant-drill shape used elsewhere for card rows), never an
    // identity-level anchor. Previously this branch only switched the view,
    // with no facet reset, no Transactions sub-tab forced, and no scroll -
    // weaker than every other drill in the app. Brought up to the same
    // standard here. item.key is assumed to carry the same merchant
    // identity key commitment/merchant objects already carry everywhere
    // else in this app (income.key, g.key, m.key) - if Coming Up's own
    // event objects do not actually carry one, this falls back to the
    // minimal standard (facets reset, correct tab, scroll) rather than
    // guessing at a filter that might not resolve to anything.
    if (item.source === 'card') {
      return () => {
        trackUsage('ahead-open-activity');
        if (item.key) {
          drillToTransactions({ merchant: item.key, merchantLabel: item.label, category: 'all' });
        } else {
          switchLedgerView('activity', { anchorId: '#acct-tx' });
        }
      };
    }
    if (item.key)
      return () => {
        trackUsage('ahead-drill-payee');
        drillToAccountsPayee(item.key, cleanCounterparty(item.label));
      };
    return null;
  }

  function eventRow(ev, dateIso) {
    const isIncome = ev.type === 'income';
    const onclick = rowDrill(ev);
    const kids = [
      el(
        'span',
        { class: 'commit-name' },
        el('span', { class: 'commit-name-main' }, ev.label),
        el(
          'span',
          { class: 'commit-name-sub muted small' },
          `Expected around ${formatDisplayDate(dateIso)}`
        )
      ),
      el(
        'span',
        { class: 'commit-amt num ' + (isIncome ? 'credit' : 'strong') },
        (isIncome ? '+' : '-') + bankMoney(Math.abs(ev.amount))
      ),
    ];
    return onclick
      ? el('button', { class: 'commit-row', onclick }, ...kids)
      : el('div', { class: 'commit-row' }, ...kids);
  }

  /* ===========================================================================
   * D (forecast accuracy loop): a small "how has the forecast been doing"
   * panel, reading provenModels.accuracyFor(90) - the same proven scorer that
   * compares stored snapshots against actual balances via the SAME
   * liquidBalance primitive the forecast itself is built from.
   *
   * TEMPORAL CONTRACT - the ONE sanctioned exception: this card is BACKWARD
   * content (it scores PAST forecasts against what actually happened), yet it
   * lives in Forecast (forward), because its sole meaning is "how much to trust
   * the projection beside it" - backward data in service of a forward decision.
   * It is the only card that resists the backward->Activity rule, and that
   * rarity is what confirms the rule holds everywhere else.
   *
   * Placed directly beside the forecast chart it grades; hidden entirely when the
   * forecast itself isn't showing (grading a forecast a person can't see
   * would be confusing, not useful). Number -> tag -> dropdown, matching
   * every other proven-model card in this app.
   * ======================================================================== */
  // (renderAccuracyCard removed - Part 5. Forecast confidence is now a quiet
  // tag inside the forecast chart's own header, built by renderForecastChart
  // from provenModels.accuracyFor, shown only when genuinely scored. There is
  // no longer a standalone accuracy card, and nothing else calls this.)
  // Round 2 (Ahead foundation): the readiness gate. Bank history alone (not
  // card history) powers the forecast, since "cash position" and "income"
  // are bank-ledger concepts everywhere else in this app too. Below the
  // configured minimum, or with no readable closing balance yet, this
  // explains plainly what is missing rather than guessing.
  function renderNotReady(monthsSoFar, minMonths) {
    const sec = el('section', { class: 'card empty' });
    const lines = el('div', { class: 'empty-lines' });
    // The cash forecast is built on a bank-derived cash position - no amount
    // of card history can ever satisfy this specific readiness check, so a
    // card-only person seeing "not enough history yet" would reasonably read
    // that as "keep importing card statements", which is not true. Stated
    // plainly instead when there is genuinely no bank history at all, rather
    // than the generic month-count message meant for someone who DOES have
    // bank statements building toward the threshold.
    if (monthsSoFar === 0) {
      lines.append(
        el(
          'p',
          { class: 'muted' },
          'This needs a bank statement - the cash forecast projects your bank balance forward, which a card statement alone cannot provide.'
        )
      );
    } else {
      lines.append(
        el(
          'p',
          { class: 'muted' },
          `${monthsSoFar} month${monthsSoFar === 1 ? '' : 's'} of bank history so far. A forecast appears once there are at least ${minMonths}.`
        )
      );
    }
    sec.append(
      el('div', { class: 'empty-icon', html: iconCal() }),
      el('h2', {}, 'Not enough history yet'),
      lines,
      el('button', { class: 'btn primary', onclick: pickStatements }, 'Add statement')
    );
    return sec;
  }

  function renderNoBalance() {
    const sec = el('section', { class: 'card empty' });
    const lines = el('div', { class: 'empty-lines' });
    lines.append(
      el(
        'p',
        { class: 'muted' },
        'Your statements do not carry a readable closing balance yet, so there is nothing to project forward.'
      )
    );
    sec.append(
      el('div', { class: 'empty-icon', html: iconCal() }),
      el('h2', {}, 'Nothing to project yet'),
      lines,
      el('button', { class: 'btn primary', onclick: pickStatements }, 'Add statement')
    );
    return sec;
  }

  function renderUpcoming(proj) {
    const rows = [];
    for (const d of proj.days) for (const ev of d.events) rows.push({ ...ev, date: d.date });
    if (!rows.length) return null;
    const sec = el('section', { class: 'card' });
    sec.append(
      el(
        'div',
        { class: 'card-head' },
        el('h3', { class: 'card-title' }, icon(iconRepeat()), 'Payments expected')
      )
    );

    const todayIso = proj.todayIso;
    const horizon = Math.max(1, proj.horizonDays || 21);
    const dayOffset = (iso) => {
      let n = 0;
      let cur = todayIso;
      while (cur < iso && n < horizon) {
        cur = addDaysIso(cur, 1);
        n++;
      }
      return n;
    };
    const awayText = (n) => {
      if (n <= 0) return 'today';
      if (n === 1) return 'tomorrow';
      if (n < 14) return `in ${n} days`;
      const weeks = Math.round(n / 7);
      return `in about ${weeks} week${weeks === 1 ? '' : 's'}`;
    };

    const byDate = new Map();
    for (const r of rows) {
      if (!byDate.has(r.date)) byDate.set(r.date, []);
      byDate.get(r.date).push(r);
    }
    const dates = [...byDate.keys()].sort();
    const maxAbs = rows.reduce((m, r) => Math.max(m, Math.abs(Number(r.amount) || 0)), 0) || 1;

    const timeline = el('div', { class: 'up-timeline' });
    timeline.append(
      el(
        'div',
        { class: 'up-now' },
        el('span', { class: 'up-now-dot' }),
        el('span', { class: 'up-now-label' }, 'Now')
      )
    );

    let prevOffset = 0;
    const listHost = el('div', { class: 'up-days' });
    dates.forEach((date, i) => {
      const group = byDate.get(date);
      const offset = dayOffset(date);
      const gapDays = Math.max(0, offset - prevOffset);
      prevOffset = offset;

      // Between two days, a spacer that grows in proportion to the real number
      // of days between them. When the paired tile is taller than the content,
      // the leftover height flows into these gaps - the longest waits open up
      // the most - so filling the card makes the time distances MORE legible
      // rather than stranding dead space. min-height keeps a small gap even
      // with no spare room (a long run then scrolls); the CSS max cap stops a
      // single gap ballooning when payments are sparse.
      if (i > 0) {
        listHost.append(
          el('div', {
            class: 'up-gap',
            style: `flex-grow:${Math.max(1, gapDays)};min-height:${Math.min(40, gapDays * 5)}px`,
          })
        );
      }

      const block = el('div', { class: 'up-day' });
      block.append(
        el(
          'div',
          { class: 'up-day-head' },
          el('span', { class: 'up-day-tick' }),
          el('span', { class: 'up-day-date' }, formatDisplayDate(date)),
          el('span', { class: 'up-day-away muted small' }, awayText(offset))
        )
      );
      for (const r of group) {
        const isIncome = r.type === 'income';
        // Gentler than linear: a square-root scale so one large payment
        // (e.g. a loan repayment) does not crush every smaller one into
        // near-identical slivers. The biggest still reaches full width and
        // clearly dominates, but mid and small amounts stay visibly
        // different from each other - the same "don't let one outlier set
        // the whole scale" technique the app's other charts use.
        const ratio = Math.abs(Number(r.amount) || 0) / maxAbs;
        const width = Math.max(8, Math.round(Math.sqrt(ratio) * 100));
        const colour = isIncome ? 'var(--flow-in, var(--down))' : 'var(--flow-out, var(--up))';
        const onclick = rowDrill(r);
        const kids = [
          el('span', { class: 'up-pay-name' }, r.label),
          el(
            'span',
            { class: 'up-pay-amt num ' + (isIncome ? 'credit' : 'strong') },
            (isIncome ? '+' : '-') + bankMoney(Math.abs(r.amount))
          ),
          el(
            'span',
            { class: 'up-pay-bar' },
            el('span', {
              class: 'up-pay-bar-fill',
              style: `width:${width}%;background:${colour}`,
            })
          ),
        ];
        block.append(
          onclick
            ? el('button', { class: 'up-pay', onclick }, ...kids)
            : el('div', { class: 'up-pay' }, ...kids)
        );
      }
      listHost.append(block);
    });

    // A quiet trailing spacer absorbs any room remaining after the between-day
    // gaps have each reached their cap (the sparse-payment case), so leftover
    // height settles at the foot rather than forcing one mid-list gap to
    // stretch oddly. Every payment in the window is shown - no truncation:
    // this is a short, capped horizon a person wants to see in full, and the
    // shared scroll ceiling handles the rare very-long run.
    listHost.append(el('div', { class: 'up-gap-tail' }));

    timeline.append(listHost);
    sec.append(el('div', { class: 'pair-scroll pair-scroll-upcoming' }, timeline));
    return sec;
  }


  // TEMPORAL CONTRACT: the income HISTORY card (the past months' bars) moved to
  // Activity (backward content belongs in the looking-back destination). Forecast
  // keeps only the FORWARD half of income - the projected next deposit and its
  // effect on the cash runway - which is already baked into projectCashFlow (the
  // forecast chart) and the statement nudge below, so no income card is needed
  // here. Same analyseIncomePattern data, split by temporal stance.

  function renderStatementNudge(nudge) {
    if (!nudge || nudge.status === 'ontrack') return null;
    const overdue = nudge.status === 'overdue';
    const text = overdue
      ? `${nudge.daysSinceLast} days since your last statement (through ${formatDisplayDate(nudge.latestEndDate)}) - longer than your usual ${nudge.cadenceDays}-day cycle.`
      : `Your last statement covered through ${formatDisplayDate(nudge.latestEndDate)}. A new one is usually available by now.`;
    const sec = el('section', { class: 'card attention' });
    sec.append(
      el(
        'div',
        { class: 'card-head' },
        el('h3', { class: 'card-title' }, icon(iconGap()), 'Add your next statement')
      )
    );
    sec.append(
      el(
        'div',
        { class: 'attn-item' },
        el('span', { class: 'attn-dot ' + (overdue ? 'warn' : 'review') }),
        el('div', { class: 'attn-body' }, el('div', {}, text)),
        el(
          'div',
          { class: 'attn-actions' },
          el('button', { class: 'btn sm', onclick: pickStatements }, 'Add statement')
        )
      )
    );
    return sec;
  }

  /* ===========================================================================
   * 6.2 Where you're headed: a single stated goal, kept to GOAL_TYPES' short
   * fixed set. No goal drafted yet - a plain form; a goal already set - its
   * description, a live progress reading, and a change/clear action.
   * ======================================================================== */
  function renderGoalForm() {
    const box = el('div', {});
    const typeList = el('div', { class: 'goal-choices' });
    // Short title + plain one-line description per choice, supplied here so
    // GOAL_TYPES stays the single measured-goal source untouched. Three
    // side-by-side choice tiles use the card's full width honestly, each a
    // scannable option (icon, title, what it means) rather than a stacked
    // full-width sentence-as-a-button.
    const goalMeta = {
      runway: {
        icon: iconGap(),
        title: 'Cash cushion',
        desc: 'Keep a buffer of a few days\u2019 spending.',
      },
      'clear-card': {
        icon: iconChart(),
        title: 'Clear the card',
        desc: 'Pay the balance off by a date.',
      },
      'spend-ceiling': {
        icon: iconFlag(),
        title: 'Spending cap',
        desc: 'Hold monthly spending under an amount.',
      },
    };
    for (const t of GOAL_TYPES) {
      const meta = goalMeta[t.id] || { icon: iconFlag(), title: t.label, desc: '' };
      typeList.append(
        el(
          'button',
          {
            class: 'goal-choice' + (_goalDraftType === t.id ? ' current' : ''),
            onclick: () => {
              _goalDraftType = t.id;
              render();
            },
          },
          el('span', { class: 'goal-choice-ic' }, icon(meta.icon)),
          el('span', { class: 'goal-choice-title' }, meta.title),
          el('span', { class: 'goal-choice-desc muted small' }, meta.desc)
        )
      );
    }
    box.append(typeList);
    if (_goalDraftType) {
      const type = GOAL_TYPES.find((t) => t.id === _goalDraftType);
      let input;
      if (type.unit === 'days')
        input = el('input', {
          type: 'number',
          class: 'name-field',
          placeholder: 'Number of days',
          min: '1',
        });
      else if (type.unit === 'date') input = el('input', { type: 'date', class: 'name-field' });
      else
        input = el('input', {
          type: 'number',
          class: 'name-field',
          placeholder: 'Amount',
          min: '1',
        });
      const confirm = () => {
        const raw = input.value;
        if (!raw) {
          toast('Enter a value first.');
          return;
        }
        const params = {};
        if (type.unit === 'days') params.targetDays = Math.max(1, Math.round(Number(raw)));
        else if (type.unit === 'date') params.targetDate = raw;
        else params.ceiling = Math.max(1, Math.round(Number(raw)));
        trackUsage('ahead-set-goal');
        _goalDraftType = null;
        setGoal(type.id, params);
      };
      // A cancel alongside the commit, so tapping a goal type in the picker
      // is never a one-way door: a person can back out of a half-made
      // selection without completing it or navigating away. Clears only the
      // draft state (never touches a live goal), matching the "try it on,
      // take it off" model this whole part is built around.
      const cancelDraft = () => {
        _goalDraftType = null;
        render();
      };
      box.append(
        el(
          'div',
          { class: 'manage-actions', style: 'margin-bottom:10px' },
          input,
          el('button', { class: 'btn sm', onclick: confirm }, 'Set this goal'),
          el('button', { class: 'btn sm ghost', onclick: cancelDraft }, 'Cancel')
        )
      );
    }
    return box;
  }

  /* ===========================================================================
   * G (clear-card engine extension) completes the goal-system migration: the
   * live card's engine dispatch is now UNCONDITIONAL - every goal type
   * (cushion, spend-ceiling, clear-card) renders through renderGoalCardNewEngine.
   * The old engine (reporting.js's describeGoal/computeGoalProgress path) has
   * no remaining live-card caller in this file.
   *
   * How the last gap closed: buildGoalModel's clear-card branch previously had
   * no deadline-passed detection and no payoff-feasibility check, so its
   * wording was MISLEADING for clear-card specifically (e.g. "needs
   * $50,000/month" toward a deadline already passed; no signal of whether a
   * pace was ever actually hit). G added both (a locally-ported
   * projectCardPayoff, goals.js), proven as a true superset of the old engine
   * by g_clearcard_proof.mjs and goal_engine_parity_proof.mjs's PART 3 (now
   * asserting the gap is CLOSED, not that it exists). met stays byte-identical
   * throughout (balance <= 1), so threeStateMetForLog's monthly-log protection
   * is untouched by any of this.
   *
   * Dispatch is on the MIGRATED type, not the raw state.goal.type - GOAL_TYPES
   * still uses the old id 'runway' (reporting.js), so a goal set THIS session
   * via renderGoalForm() is still literally type:'runway' until the next
   * reload's boot-time migration runs. Checking the migrated type means a
   * freshly-set goal gets the new engine's reading immediately, not after a
   * reload.
   * ======================================================================== */
  function renderGoalCard() {
    const sec = el('section', { class: 'card' });
    sec.append(
      el(
        'div',
        { class: 'card-head' },
        el('h3', { class: 'card-title' }, icon(iconFlag()), 'Goal setting')
      )
    );
    if (!state.goal) {
      sec.append(el('p', { class: 'muted small' }, 'Choose a goal to track.'));
      sec.append(renderGoalForm());
      return sec;
    }

    const migrated = ensureMigrated(state.goal);
    renderGoalCardNewEngine(sec, migrated);

    return sec;
  }

  // The new engine's reading, for every goal type. The plain
  // lead sentence IS buildGoalModel's own detail string (proven calm and
  // equivalent to the old headline - headline_compare.mjs). The safety
  // boundary and safe-contribution guard - the new engine's genuine added
  // value - sit behind a native <details> disclosure, never as the lead,
  // matching the "number -> tag -> dropdown" content model this app is
  // built around, not a second card's worth of machinery up front.
  function renderGoalCardNewEngine(sec, migrated) {
    const cb = classifiedBank();
    const month = latestCompleteGoalMonth();
    const progressCtx = buildNewEngineProgressCtx(migrated, { month });

    if (!progressCtx) {
      // Not enough data yet to judge this goal against - the same honest
      // "nothing to show yet" every other empty state in this app already
      // uses, never a blank card or a misleading number.
      sec.append(el('p', {}, describeGoal(migrated, bankMoney, formatDisplayDate)));
      sec.append(
        el('p', { class: 'muted small' }, 'There is not yet enough data to judge this against.')
      );
    } else {
      const commitmentsMonthly = commitmentsModel().combined.total;
      const dailyOutflow = progressCtx.typicalDailyOutflow;
      const asOf = progressCtx.asOf;
      const progress = goalProgress(migrated, progressCtx);
      const model = buildGoalModel(migrated, progress, null, state.cfg);
      const dot = progress.met === true ? 'good' : progress.met === false ? 'warn' : 'review';

      sec.append(
        el(
          'div',
          { class: 'attn-item', style: 'padding:8px 0' },
          el('span', { class: 'attn-dot ' + dot }),
          el('div', { class: 'attn-body' }, model.detail)
        )
      );

      const boundaryConfig = state._goalBoundary || null;
      const boundary = resolveSafetyBoundary(boundaryConfig, {
        typicalDailyOutflow: dailyOutflow,
        commitmentsMonthly,
      });
      // The safe-contribution guard is only meaningful for clear-card, where
      // there is a real proposed monthly payment to vet (the amount required
      // to clear the balance by the target date). For cushion/spend-ceiling,
      // there is no "contribution" concept, so this correctly stays 0 - the
      // guard then just reports the honest 90-day projected low with no
      // contribution assumed, exactly as before. Fixing this from a hardcoded
      // 0 (which made the guard trivially always "safe" for clear-card, since
      // testing "$0 a month" against a safety floor proves nothing) is the
      // one real functional gap this retirement closes, beyond the dispatch
      // change itself.
      const proposedMonthly =
        migrated.type === 'clear-card' && progress.monthlyNeeded > 0 ? progress.monthlyNeeded : 0;
      const guard = safeContribution({
        bankRecords: cb,
        cardStatements: state._cardStatements || [],
        cfg: state.cfg,
        asOf,
        proposedMonthly,
        boundary,
        goal: migrated,
        horizonDays: 90,
      });
      const guardDetail =
        guard.projectedLow != null
          ? `Projected low over the next 90 days: ${bankMoney(guard.projectedLow)}${guard.projectedLowDate ? ` around ${formatDisplayDate(guard.projectedLowDate)}` : ''}.`
          : guard.note || '';

      const disclosure = el('details', {
        class: 'explainer',
        style: 'margin-top:6px',
      });
      disclosure.append(el('summary', { class: 'muted small' }, 'Why'));
      const disclosureBody = el(
        'div',
        { class: 'muted small', style: 'margin-top:4px' },
        guardDetail
      );
      disclosure.append(disclosureBody);
      const boundaryStatus = renderBoundaryStatus(boundaryConfig);
      if (boundaryStatus) disclosure.append(boundaryStatus);
      sec.append(disclosure);

      if (_boundaryDraftKind !== null) {
        sec.append(renderBoundaryForm());
      } else {
        sec.append(
          el(
            'div',
            { class: 'manage-actions', style: 'margin-top:8px' },
            el(
              'button',
              {
                class: 'btn sm ghost',
                onclick: () => {
                  _boundaryDraftKind = boundaryConfig ? boundaryConfig.kind : 'chosen';
                  render();
                },
              },
              boundaryConfig && boundaryConfig.kind !== 'none'
                ? 'Change safe line'
                : 'Set a safe line'
            )
          )
        );
      }
    }

    if (_goalDraftType) {
      sec.append(renderGoalForm());
    } else {
      sec.append(
        el(
          'div',
          { class: 'manage-actions', style: 'margin-top:8px' },
          // GOAL_TYPES still uses the old id 'runway' for what the new engine
          // calls 'cushion' - map back so renderGoalForm() highlights the
          // right picker button and reads the right unit.
          el(
            'button',
            {
              class: 'btn sm ghost',
              onclick: () => {
                _goalDraftType = migrated.type === 'cushion' ? 'runway' : migrated.type;
                render();
              },
            },
            'Change goal'
          ),
          el(
            'button',
            {
              class: 'btn sm danger',
              onclick: () => {
                trackUsage('ahead-clear-goal');
                // Capture the exact goal object BEFORE clearing, so undo can
                // restore it byte-for-byte (its original createdAt included -
                // see restoreGoal's own comment). Reuses the app's own
                // established toast(msg, undoFn) undo idiom (the same one
                // category-picker.js uses for "Change undone."), so clearing
                // a goal is reversible with one tap and a person knows it is
                // safe to explore - the "try it on, take it off" model,
                // enforced at the moment of clearing rather than promised in
                // words.
                const prior = state.goal;
                clearGoal();
                toast('Goal cleared.', () => {
                  trackUsage('ahead-restore-goal');
                  restoreGoal(prior);
                });
              },
            },
            'Clear goal'
          )
        )
      );
    }
  }

  /* ===========================================================================
   * Step 2 continued: the safety-boundary authoring form. THREE explicit
   * states only, matching goals.js's frozen contract exactly - 'chosen' (a
   * number the person sets), 'calculated' (commitments + N cushion days), or
   * 'none' (cleared/default). Never invents a boundary; a suggestion from
   * resolveSafetyBoundary is informational only until saved here by hand.
   * ======================================================================== */
  function renderBoundaryStatus(boundaryConfig) {
    if (!boundaryConfig || boundaryConfig.kind === 'none') {
      return el(
        'p',
        { class: 'muted small' },
        'No safe line is set yet. Set one so a contribution can be checked against it.'
      );
    }
    if (boundaryConfig.kind === 'chosen') {
      return el(
        'p',
        { class: 'muted small' },
        `Safe line: keep at least ${bankMoney(boundaryConfig.value)}.`
      );
    }
    if (boundaryConfig.kind === 'calculated') {
      return el(
        'p',
        { class: 'muted small' },
        `Safe line: your regular commitments plus ${boundaryConfig.cushionDays} day${boundaryConfig.cushionDays === 1 ? '' : 's'} of typical spending.`
      );
    }
    return null;
  }

  function renderBoundaryForm() {
    const box = el('div', {});
    const options = [
      { kind: 'chosen', label: 'A number I choose' },
      { kind: 'calculated', label: 'Commitments plus a cushion of days' },
      { kind: 'none', label: 'No safe line (clear it)' },
    ];
    const typeList = el('div', {
      class: 'picker-list',
      style: 'margin-bottom:10px',
    });
    for (const o of options) {
      typeList.append(
        el(
          'button',
          {
            class: 'picker-item' + (_boundaryDraftKind === o.kind ? ' current' : ''),
            onclick: () => {
              _boundaryDraftKind = o.kind;
              render();
            },
          },
          o.label
        )
      );
    }
    box.append(typeList);

    if (_boundaryDraftKind === 'none') {
      box.append(
        el(
          'div',
          { class: 'manage-actions', style: 'margin-bottom:10px' },
          el(
            'button',
            {
              class: 'btn sm',
              onclick: () => {
                trackUsage('ahead-clear-boundary');
                saveBoundary(null);
                _boundaryDraftKind = null;
              },
            },
            'Clear safe line'
          )
        )
      );
      return box;
    }
    if (_boundaryDraftKind === 'chosen' || _boundaryDraftKind === 'calculated') {
      const input = el('input', {
        type: 'number',
        class: 'name-field',
        min: '0',
        placeholder: _boundaryDraftKind === 'chosen' ? 'Amount' : 'Number of days',
      });
      const confirm = () => {
        const raw = input.value;
        if (!raw) {
          toast('Enter a value first.');
          return;
        }
        const n = Math.max(0, Math.round(Number(raw)));
        const boundaryConfig =
          _boundaryDraftKind === 'chosen'
            ? { kind: 'chosen', value: n }
            : { kind: 'calculated', cushionDays: n };
        trackUsage('ahead-set-boundary');
        _boundaryDraftKind = null;
        saveBoundary(boundaryConfig);
      };
      box.append(
        el(
          'div',
          { class: 'manage-actions', style: 'margin-bottom:10px' },
          input,
          el('button', { class: 'btn sm', onclick: confirm }, 'Save safe line')
        )
      );
    }
    return box;
  }

  async function saveBoundary(boundaryConfig) {
    await Store.setMeta('financeGoalBoundary', boundaryConfig);
    state._goalBoundary = boundaryConfig;
    render();
  }

  // The monthly, honest follow-up: the frozen record app.js's
  // checkMonthlyGoalIfDue already builds once per genuinely new complete
  // month, simply displayed here, most recent first. Shown only once at
  // least one month has been checked, regardless of whether a goal is
  // currently active (a cleared goal's own history stays visible - see
  // clearGoal's own comment on why goalLog is never erased).
  function renderMonthlyFollowUp() {
    const log = state.goalLog || [];
    if (!log.length) return null;
    const sec = el('section', { class: 'card' });
    sec.append(
      el(
        'div',
        { class: 'card-head' },
        el('h3', { class: 'card-title' }, icon(iconGap()), 'Monthly check-in')
      )
    );
    const list = el('div', { class: 'recurring-list' });
    for (const entry of log.slice().reverse().slice(0, 12)) {
      const dot = entry.met === true ? 'good' : entry.met === false ? 'warn' : 'review';
      list.append(
        el(
          'div',
          { class: 'attn-item' },
          el('span', { class: 'attn-dot ' + dot }),
          el(
            'div',
            { class: 'attn-body' },
            el('div', { class: 'muted small' }, monthName(entry.month)),
            el('div', {}, entry.headline)
          )
        )
      );
    }
    sec.append(list);
    return sec;
  }

  /* ===========================================================================
   * The scenario tool: toggle a category or place off to test "what if I
   * stopped spending here"; add a hypothetical cost to test "what if this
   * came up". Both recompute the SAME runway figure Overview's own narrative
   * already uses (computeScenario, reporting.js), so the result here is
   * never a different idea of "how long the cushion lasts" from the rest of
   * the app. Toggleable items are the SAME categories and places already
   * shown on Right Now this period, so nothing new is introduced to scan.
   * ======================================================================== */
  // The SAME categories and places already shown on Right Now this period -
  // card categories via analysis().by_category, bank places via
  // bankCounterpartyGroups/externalOutflowShortlist (the identical shortlist
  // Right Now's own "where money went" ranking already uses) - so nothing new
  // is introduced here to scan, only a new way to test removing one.
  // Scoped deliberately to CARD SPENDING CATEGORIES only. Bank payees were
  // dropped for two reasons this tool's honesty depends on: (1) scale - a lump
  // payment to a person or an insurer sits at a wildly different order of
  // magnitude than a discretionary category, so mixing them made the list
  // incoherent (a $2.5M "item" beside a $31k one); (2) meaning - the tool tests
  // "what if I stopped spending here", which only applies to discretionary
  // spending a person actually controls, not a fixed obligation like an
  // insurance premium or a loan repayment. Categories are exactly that
  // discretionary lens, at a comparable scale, so the toggles now read as one
  // coherent set of genuine levers. This also removes the raw account-number
  // label leak ("... Limited 64") that the bank-payee labels carried here.
  function scenarioToggleItems() {
    const items = [];
    const a = analysis();
    if (a && a.by_category) {
      for (const c of a.by_category.slice(0, 8))
        items.push({ key: 'cat:' + c.name, label: c.name, amount: c.amount });
    }
    return items;
  }

  function renderScenarioCard() {
    const cb = classifiedBank();
    const cashPosition = analyseBankActivity(cb).closingBalance;
    // Without a readable cash position (no bank data at all), computeScenario
    // always returns scenarioRunwayDays: null regardless of what a person
    // toggles - the card would render a fully interactive checklist that can
    // never produce an answer, which is worse than either a working feature
    // or an absent one. Hidden entirely rather than left half-answered, the
    // same honest treatment renderNoBalance already gives the chart above it.
    if (cashPosition == null) return null;
    const { rollAllTrend } = overviewModel();
    const monthlyOutflow = typicalMonthlyOutflow(rollAllTrend, ymToday());
    const items = scenarioToggleItems();
    if (!items.length && monthlyOutflow <= 0) return null;

    const sec = el('section', { class: 'card' });
    sec.append(
      el(
        'div',
        { class: 'card-head' },
        el('h3', { class: 'card-title' }, icon(iconChart()), 'Test a decision')
      )
    );
    sec.append(
      el(
        'p',
        { class: 'muted small' },
        'Try spending less in a category and see how your safety net changes.'
      )
    );

    // The honest income figure the surplus-aware output below reads: the
    // SAME detected recurring-income typical amount the Activity income card
    // and Position's income-stability reading already trust
    // (analyseIncomePattern is already imported and called for the forecast
    // itself). Lets this tool tell the truth for a net-positive person,
    // rather than only ever answering the "if income stopped" question.
    const income = analyseIncomePattern(cb, state.cfg, new Date());
    const monthlyIncome = income && income.typicalAmount ? Number(income.typicalAmount) : 0;

    // The result line is rebuilt IN PLACE on every control press (its own
    // host element, rewritten by recompute()), never via a full render() -
    // the same in-place pattern the Transactions search uses, so pushing a
    // lever visibly moves the number without a whole-tab flash.
    const resultHost = el('div', { style: 'margin-top:10px' });

    function setReduction(key, fraction) {
      if (fraction <= 0) _scenarioReductions.delete(key);
      else _scenarioReductions.set(key, fraction);
      trackUsage('ahead-scenario-adjust');
      recompute();
    }

    // Three mutually-exclusive presets per category: Keep (full spend, the
    // default), Cut half (0.5), Cut all (1). Choosing "Cut half"/"Cut all"
    // reads in the DIRECTION of intent - it is cutting, not un-selecting a
    // box - fixing the old inverted checked-by-default gesture, and it
    // models spending LESS (the realistic decision), not only removing a
    // category entirely.
    const list = el('div', { class: 'recurring-list chk-list' });
    for (const it of items) {
      const current = _scenarioReductions.get(it.key) || 0;
      // One grouped segmented control (.seg / .seg-btn) rather than three
      // loose pills - so "these three are ONE choice" reads at a glance, in
      // the app's grouped-segmented language, compact enough to sit inline.
      //
      // Selection state is updated LIVE, in place, on press - the same
      // flash-free discipline recompute() uses for the result line. The old
      // code decided .active/aria-pressed ONCE at build time from
      // _scenarioReductions, and since setReduction only rewrites resultHost
      // (never re-renders the row), the highlight froze at its initial value
      // while the underlying state moved on: every row read "Keep" even as
      // the result correctly showed a reduction applied. This holds the
      // row's three buttons, and on any press clears .active/aria-pressed
      // from all three (mutual exclusivity - Keep OR Cut half OR Cut all)
      // then sets it on the pressed one, so the visible highlight AND the
      // accessible state both track the real selection without a re-render.
      const segButtons = [];
      const setActiveSegment = (chosenFraction) => {
        for (const b of segButtons) {
          const isActive = Number(b.dataset.fraction) === chosenFraction;
          b.classList.toggle('active', isActive);
          b.setAttribute('aria-pressed', isActive ? 'true' : 'false');
        }
      };
      const seg = (label, fraction) => {
        const b = el(
          'button',
          {
            class: 'seg-btn' + (current === fraction ? ' active' : ''),
            'aria-pressed': current === fraction ? 'true' : 'false',
            dataset: { fraction: String(fraction) },
            onclick: () => {
              setReduction(it.key, fraction);
              setActiveSegment(fraction);
            },
          },
          label
        );
        segButtons.push(b);
        return b;
      };
      list.append(
        el(
          'div',
          { class: 'recurring-row scenario-row' },
          el('span', { class: 'recurring-name' }, it.label),
          el('span', { class: 'recurring-amt num' }, bankMoney(it.amount)),
          el('span', { class: 'seg' }, seg('Keep', 0), seg('Cut half', 0.5), seg('Cut all', 1))
        )
      );
    }
    sec.append(el('div', { class: 'pair-scroll pair-scroll-recurring' }, list));

    const costInput = el('input', {
      type: 'number',
      class: 'name-field',
      placeholder: 'Amount',
      min: '0',
      value: _scenarioExtraCost || '',
    });
    sec.append(
      el(
        'div',
        { class: 'manage-actions', style: 'margin-top:10px;align-items:center' },
        el('span', { class: 'muted small' }, 'Add a cost you have not paid yet:'),
        costInput,
        el(
          'button',
          {
            class: 'btn sm ghost',
            onclick: () => {
              _scenarioExtraCost = Number(costInput.value) || 0;
              recompute();
            },
          },
          'Apply'
        )
      )
    );

    // Rewrites ONLY resultHost, in place, so every preset press / cost apply
    // updates the number live without re-rendering the whole tab.
    function recompute() {
      resultHost.textContent = '';
      const result = computeScenario({
        cashPosition,
        monthlyOutflow,
        toggleableItems: items,
        reductions: _scenarioReductions,
        extraCost: _scenarioExtraCost,
      });
      if (result.scenarioRunwayDays == null) {
        resultHost.append(
          el(
            'p',
            { class: 'muted small' },
            'Not enough information to project this scenario.'
          )
        );
        return;
      }
      const changed = result.scenarioRunwayDays !== result.baselineRunwayDays;
      // The number always answered "if your income stopped, how long would
      // your cash last" (runwayDays' own documented meaning) - naming that
      // assumption is what makes it honest, especially for a surplus person
      // for whom an unlabelled "days left" reads as odd.
      resultHost.append(
        el(
          'p',
          { class: 'strong' },
          changed
            ? `If your income stopped, your cash would last about ${result.scenarioRunwayDays} days - up from about ${result.baselineRunwayDays} today.`
            : `If your income stopped, your cash would last about ${result.scenarioRunwayDays} days.`
        )
      );
      // Surplus-aware second sentence: when income covers outflow, cutting a
      // category does not extend a runway that is not depleting - it grows
      // the monthly surplus. This is the TRUE story for a net-positive
      // person, added alongside (not replacing) the income-stopped runway.
      if (monthlyIncome > 0 && monthlyIncome >= monthlyOutflow && result.monthlySaved > 0) {
        resultHost.append(
          el(
            'p',
            { class: 'muted small', style: 'margin-top:4px' },
            `Since your income already covers your spending, cutting this adds about ${bankMoney(result.monthlySaved)} to what you keep each month.`
          )
        );
      }
    }

    sec.append(resultHost);
    recompute();
    return sec;
  }

  function renderAhead() {
    const wrap = el('div', { class: 'accounts-wrap accounts-grid' });
    const cfg = Object.assign({ minMonthsForForecast: 2, horizonDays: 21 }, state.cfg.ahead || {});
    const months = bankMonthsList();
    let goalPlaced = false;
    // Computed once, unconditionally: "Test a decision" needs no forecast
    // history to work (see the scenario tool's own comment block below), so
    // it must still appear even when the readiness gate has not passed. When
    // the forecast IS ready it pairs with "What's expected before then";
    // otherwise it appends on its own, full-width.
    const scenario = renderScenarioCard();
    // The statement-cadence nudge accepts card statements and bank statements
    // as two independent inputs and can compute a cadence from EITHER one
    // alone (nextStatementNudge, reporting.js) - it never needed a readable
    // cash position or a forecast-ready bank history. Previously nested
    // inside the innermost forecast-ready branch below, which meant a
    // card-only person (or anyone below the bank-months threshold) could
    // never see it even though it would have worked correctly for them.
    // Computed once here, independent of forecast readiness, so it appears
    // whenever there is anything for it to compare.
    const nudge = nextStatementNudge(
      state._cardStatements || [],
      state._bankStatements || [],
      { toleranceDays: cfg.statementToleranceDays },
      new Date()
    );
    const nudgeCard = renderStatementNudge(nudge);
    // 6.1 Coming Up - gated on its own readiness (enough history, a readable
    // balance). 6.2 Where you're headed, below, is deliberately NOT inside
    // either early-return: the plan is explicit that Ahead as a whole is
    // reachable even before enough data exists to power its forecast.
    if (months.length < cfg.minMonthsForForecast) {
      wrap.append(renderNotReady(months.length, cfg.minMonthsForForecast));
      if (nudgeCard) wrap.append(nudgeCard);
      if (scenario) wrap.append(scenario);
    } else {
      const cb = classifiedBank();
      // The SAME base-currency-only closing balance every other cash-position
      // figure in this app reads (analyseRollup's own cashPosition), so a
      // foreign (e.g. USD) account can never be silently mixed into the JMD
      // figure this forecast projects forward.
      const cashPosition = analyseBankActivity(cb).closingBalance;
      if (cashPosition == null) {
        wrap.append(renderNoBalance());
        if (nudgeCard) wrap.append(nudgeCard);
        if (scenario) wrap.append(scenario);
      } else {
        const income = analyseIncomePattern(cb, state.cfg, new Date());
        const combined = commitmentsModel().combined;
        const proj = projectCashFlow({
          cashPosition,
          commitments: combined.items,
          income,
          horizonDays: cfg.horizonDays,
          now: new Date(),
        });


        // Resolve the SAME safe-line boundary the goal card reads
        // (state._goalBoundary, loaded goal-independently at boot - see
        // app.js's own comment on why), from data already computed in this
        // scope, so the forecast chart can compare its trough against it
        // without depending on buildNewEngineProgressCtx or any goal being
        // set. The same typicalMonthlyOutflow/ymToday reference point
        // renderScenarioCard uses below, converted to a daily figure with
        // the same days-per-month arithmetic runwayDays (reporting.js)
        // uses internally, so this daily-burn figure can never quietly
        // drift from the one that function computes.
        const { rollAllTrend: rollAllTrendForBoundary } = overviewModel();
        const monthlyOutflowForBoundary = typicalMonthlyOutflow(
          rollAllTrendForBoundary,
          ymToday()
        );
        const dailyBurnForBoundary = monthlyOutflowForBoundary / (365.25 / 12);
        const safetyBoundary = resolveSafetyBoundary(state._goalBoundary, {
          typicalDailyOutflow: dailyBurnForBoundary,
          commitmentsMonthly: combined.total,
        });
        // ONE days-of-cover figure, computed here and shared by BOTH the
        // forecast hero (passed in below) and the decision tester (which
        // computes its baseline the identical way via computeScenario ->
        // runwayDays). Same cash position and same typical outflow as the
        // tester's baseline, so the number in the hero and the number in the
        // tester can never diverge - the brief's hard requirement.
        const baselineRunway = runwayDays(cashPosition, monthlyOutflowForBoundary);
        wrap.append(renderForecastChart(30, safetyBoundary, baselineRunway));
        // Goal setting sits directly beneath the Cash forecast, full-width -
        // its "what am I aiming for" framing reads best right under the
        // forecast it is judged against, and its height swings the most of
        // any card here, so full-width is its honest home (it never has to
        // match a neighbour and so never strands a void or gets dragged
        // tall). Placed here in the forecast-ready branch, before the paired
        // tools below; goalPlaced stops the shared tail appending it twice.
        const goalCardTop = renderGoalCard();
        if (goalCardTop) wrap.append(goalCardTop);
        goalPlaced = true;
        // Now that "Payments expected" is a VERTICAL timeline (tall and
        // narrow), it no longer needs a full-width row - it pairs cleanly
        // beside "Test a decision" as two similarly-shaped, list-tall
        // columns, which is more compact. Both hold a scrolling list, so the
        // shared-height + fill rule balances them: neither strands a void,
        // and a genuinely long run of payments scrolls within its own window
        // (Now stays anchored at the top; the far-future payments are a
        // scroll away, the imminent ones always in view).
        const upcoming = renderUpcoming(proj);
        pairCards(wrap, upcoming, scenario);
        pairCards(wrap, nudgeCard, null);
      }
    }

    // Goal setting for the not-ready / no-balance branches (no forecast shown
    // there, so it is appended full-width here so a person can still set a
    // goal). goalPlaced is true only when the forecast-ready branch above
    // already placed it beneath the Cash forecast, so it is never rendered
    // twice.
    if (!goalPlaced) {
      const goalCard = renderGoalCard();
      if (goalCard) wrap.append(goalCard);
    }
    const followUp = renderMonthlyFollowUp();
    if (followUp) wrap.append(followUp);
    return wrap;
  }

  // Session-only UI toggles that affect what renderAhead() produces but are
  // NOT part of state (goal-draft type, safety-boundary-draft kind). app.js's
  // mountView cache signature for 'ahead' is otherwise just today's date, so
  // without this a click that opens/changes a draft form calls render() but
  // silently reuses the STALE cached DOM - the form state changes in memory
  // but nothing rebuilds to show it. Exposed as a plain string so app.js can
  // fold it into that cache signature without reaching into this module's
  // private module-scope variables directly.
  function draftSignature() {
    const reductionSig = [..._scenarioReductions.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : 1))
      .map(([k, v]) => `${k}:${v}`)
      .join(',');
    return `${_goalDraftType || ''}|${_boundaryDraftKind || ''}|${reductionSig}|${_scenarioExtraCost || 0}`;
  }

  return { renderAhead, draftSignature };
}