/*
 * activity-render.js  -  the "Activity" surface's distinctive analysis cards,
 * rendered from the PROVEN models via the shared number -> tag -> dropdown
 * content model:
 *   - committed vs flexible (the past-tense lens; genuinely new to the app)
 *   - "where it went": the merged category -> merchant drill
 *   - category spending intentions surfaced as forward PACE
 *
 * It owns no analysis - every figure comes from the corpus-proven modules via
 * provenModels; this file only turns those models into DOM. Follows the app's
 * render-factory pattern (requireCtx-guarded, ctx-injected, returns the render
 * functions the host appends).
 *
 * COLLISION NOTE (deliberate): the spend-breakdown card REPLACES right-now's
 * separate category + merchant cards - it is the one merged drill, not a second
 * spending view. Rendering both would show two breakdowns that could disagree.
 * So the SHIPPING Activity branch calls renderCommittedFlexible() +
 * renderIntentions() only; renderSpendBreakdown()/renderActivity() stay defined
 * but uncalled until right-now's category/merchant cards are removed in the SAME
 * pass. committed-vs-flexible has no existing equivalent, so it is additive.
 *
 * HONESTY, ENFORCED IN THE MARKUP:
 *   - committed-vs-flexible always renders its reconciling line BENEATH the
 *     split, never as a separate dismissible element;
 *   - the drill's comparison markers carry direction + size + period, and a
 *     partial-prior month shows an amount, never an exaggerated percentage;
 *   - intention pace uses forward, no-guilt language only.
 */
import {
  requireCtx,
  formatDisplayDate,
  drillToTransaction as drillToTransactionPure,
  ledgerIsNarrowed as ledgerIsNarrowedPure,
} from '../core/shared-helpers.js';
import {
  reviewReasonText,
  appendExpandable,
  buildIncomeHero,
  buildIncomeCaption,
  detectMidMonthPace,
  pairCardRefunds,
  mergedMoneyMovedRanking,
  renderShareBar,
  rankInsights,
  renderInsightList,
} from '../analysis/reporting.js';
import { splitsByTxnId, validateSplit } from '../analysis/transaction-splits.js';
import {
  analyseBankActivity,
  analyseIncomePattern,
  externalOutflowShortlist,
  externalInflowShortlist,
  bankCounterpartyGroups,
  isCardPaymentTransfer,
} from '../analysis/bank-analysis.js';
import { createTreemapRenderer, adaptSpendBreakdownForTreemap } from './treemap-render.js';
import { pairCards } from './chart-helpers.js';
import { makeRenderIntentions } from './intentions-section.js';

// Session-only Transactions-tab search text, the same module-scope pattern
// ahead-render.js uses for its own draft state. Folded into activityTabSignature
// so a keystroke rebuilds the ledger; reset naturally on reload.
let _txSearch = '';

export function createActivityRenderer(ctx) {
  requireCtx(
    ctx,
    [
      'state',
      'el',
      'icon',
      'provenModels',
      'resolved',
      'trackUsage',
      'Store',
      'render',
      'makeIntention',
      'makeTag',
      'toast',
      'catColour',
      'money0',
      'resetBankDrillFacets',
      'bankMoney',
      'cleanCounterparty',
      'drillToAccountsPayee',
      'openCategoryPicker',
      'openTagPicker',
      'FALLBACK',
      'iconList',
      'visibleRows',
      'visibleBankRows',
      'bankRecordsInPeriod',
      'classifiedBank',
      'periodRows',
      'bankRowsInapplicable',
      'cardRowsInapplicable',
      'clearFilters',
      'clearBankFilters',
      'catTag',
      'analysis',
      'renderRecurring',
      'renderForeign',
      'renderCardFitness',
      'renderTrend',
      'renderLedgerReview',
      'renderIncomeChart',
      'overviewModel',
      'iconSpark',
      'iconGap',
      'moneyShort',
      'buildBankInsights',
      'buildInsights',
      'iconBulb',
      'iconChevron',
      'smoothScrollToEl',
      'resetCardDrillFacets',
      'drillToTransactions',
    ],
    'createActivityRenderer'
  );  const {
    state,
    el,
    icon,
    provenModels,
    resolved,
    trackUsage,
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
    renderTrend,
    renderLedgerReview,
    renderIncomeChart,
    overviewModel,
    iconSpark,
    iconGap,
    moneyShort,
    buildBankInsights,
    buildInsights,
    iconBulb,
    iconChevron,
    smoothScrollToEl,
    resetCardDrillFacets,
    drillToTransactions,
  } = ctx;
  const iconInfo = ctx.iconInfo || (() => '');
  const iconPie = ctx.iconPie || iconInfo;
  const iconRepeat = ctx.iconRepeat || iconInfo;
  const applyFilter = ctx.applyFilter || null; // optional: enables drill-to-transactions
  const isPeriodFullyCovered = ctx.isPeriodFullyCovered || (() => true);
  const previousPeriod = ctx.previousPeriod || null;
  const categorySpend = ctx.categorySpend || null; // shared category calc, for intentions
  const renderIntentions = makeRenderIntentions({
    state,
    el,
    icon,
    provenModels,
    resolved,
    trackUsage,
    Store,
    render,
    makeIntention,
    categorySpend,
    iconRepeat,
    toast,
  });
  const { renderTreemapCard } = createTreemapRenderer({
    el,
    money0,
    catColour,
  });

  // The one place _txSearch is ever cleared from outside this module - a
  // plain reset, so drillToTransaction (below) can genuinely guarantee an
  // empty search before jumping to a specific row, closing the stale-search
  // gap CARD_FACETS/BANK_FACETS never covered (see shared-helpers.js's own
  // comment on why).
  function resetTxSearch() {
    _txSearch = '';
  }

  // Identity-level anchor: jumps straight to and opens ONE specific
  // transaction, rather than narrowing the ledger to a class of rows and
  // leaving a person to find it themselves. Exposed on this factory's
  // return value too, so other renderers (cards-render.js) that reference a
  // single, already-identified transaction can call the same mechanism.
  function drillToTransaction(target) {
    drillToTransactionPure(
      { state, trackUsage, resetCardDrillFacets, resetBankDrillFacets, resetTxSearch, render },
      target
    );
  }
  /* ---- shared content-model component: number -> tag -> dropdown ---- */
  function renderVM(m, opts = {}) {
    if (!m) return null;
    const kids = [
      el(
        'div',
        { class: 'vm-lead' },
        el(
          'div',
          { class: 'vm-number' + (opts.lead ? ' lg' : '') },
          m.amountText != null ? m.amountText : ''
        ),
        m.label ? el('div', { class: 'vm-label' }, m.label) : null
      ),
    ];
    if (m.tag) kids.push(el('span', { class: 'vm-tag tone-' + (m.tone || 'neutral') }, m.tag));
    if (m.detail)
      kids.push(
        el(
          'details',
          { class: 'vm-detail' },
          el('summary', {}, 'Why'),
          el('div', { class: 'vm-detail-body' }, m.detail)
        )
      );
    return el('div', { class: 'vm' }, ...kids);
  }

  /* ===================================================================
   * 1) COMMITTED vs FLEXIBLE - the distinctive lens. Reconciling line is
   *    ALWAYS attached beneath the split, never omitted.
   * =================================================================== */
  function renderCommittedFlexible() {
    const p = resolved();
    if (!p || !p.from || !p.to) return null;
    const m = provenModels.committedFlexibleFor({ from: p.from, to: p.to });
    if (!m) return null;
    const sec = el('section', { class: 'card lead' });
    sec.append(
      el(
        'div',
        { class: 'card-head' },
        el('h3', { class: 'card-title' }, icon(iconInfo()), 'Committed and discretionary')
      )
    );
    // All three figures - the headline total plus its two components - now
    // sit in ONE flexible row (.vm-row, glass.css), the same fix already
    // applied to Position's Cash and debt card. Previously the lead figure
    // sat full-width above a 2-up pair beneath it, splitting three genuine
    // peer figures across two visual tiers for no real reason; .vm-row holds
    // however many cards are given to it as equal columns and still stacks
    // fully below 1000px, so this is a direct structural match to Cash and
    // debt, not a new pattern. The reconciling line stays exactly where it
    // was, full-width beneath the row - it reconciles all three figures
    // together, not just one pair, so it belongs anchored under the whole
    // row regardless of how many columns sit above it.
    const row = el('div', { class: 'vm-row' });
    row.append(renderVM(m.lead));
    row.append(renderVM(m.committed));
    row.append(renderVM(m.flexibleSpent));
    sec.append(row);
    if (m.reconciling && m.reconciling.text) {
      sec.append(
        el(
          'div',
          { class: 'vm-reconcile tone-' + (m.reconciling.tone || 'neutral') },
          m.reconciling.text
        )
      );
    }
    return sec;
  }

  /* ===================================================================
   * 2) "WHERE IT WENT" - the merged category -> merchant drill. REPLACES
   *    right-now's category + merchant cards (kept uncalled until that swap).
   * =================================================================== */
  function renderSpendBreakdown() {
    const p = resolved();
    if (!p || !p.from || !p.to) return null;
    const prior = previousPeriod ? previousPeriod({ from: p.from, to: p.to }) : null;
    const priorComplete = prior ? isPeriodFullyCovered(prior) : true;
    // m.categories is checked ONLY as a presence guard (no categories with
    // spend -> nothing to show at all) - the array's contents are no longer
    // rendered directly here; the treemap below reads its OWN separately-
    // fetched raw result (spendBreakdownRawFor) instead.
    const m = provenModels.spendBreakdownFor({ from: p.from, to: p.to }, prior, priorComplete);
    if (!m || !m.categories || !m.categories.length) return null;

    const sec = el('section', { class: 'card' });
    sec.append(
      el(
        'div',
        { class: 'card-head' },
        el('h3', { class: 'card-title' }, icon(iconPie()), 'Where it went')
      )
    );
    sec.append(
      el(
        'div',
        { class: 'vm-lead' },
        el('div', { class: 'vm-number' }, m.total.amountText),

        el('div', { class: 'vm-label' }, m.total.tag)
      )
    );

    // E2: the spending treemap, previewed ABOVE the existing ranked list. Both
    // read spendBreakdownRawFor - the SAME underlying spendBreakdown() run
    // provenModels.spendBreakdownFor already uses for the ranked list above -
    // so the two can never disagree on the numbers, only on presentation.
    // Shape adapter: spendBreakdown()'s raw result nests merchants inside
    // each category (categories[].topMerchants[]) and uses `total` (not
    // `amount`); createTreemapRenderer expects a flat by_category/merchants
    // pair with `amount`. This maps one to the other; it computes nothing new.
    const raw = provenModels.spendBreakdownRawFor({ from: p.from, to: p.to }, prior, priorComplete);
    if (raw && raw.categories && raw.categories.length) {
      // adaptSpendBreakdownForTreemap (treemap-render.js) folds each
      // category's "moreMerchants" remainder into a synthetic "Other
      // places" entry, so sub-tile areas always reconcile to their
      // category's true total - see that function's own comment for the
      // real-world reconciliation bug this closes (a naive top-5-only
      // mapping silently inflated the visible merchants' sub-tiles).
      const { by_category, merchants } = adaptSpendBreakdownForTreemap(raw);
      const tm = renderTreemapCard(
        { by_category, merchants },
        {
          embedded: true,

          // Clicking a block jumps straight to Right Now's "All transactions"
          // section, already filtered to that category.
          onCategory: (name) => {
            if (!applyFilter) return;
            trackUsage('activity-drill-category-treemap');
            drillToTransactions({ category: name });
          },
        }
      );
      if (tm) sec.append(tm);
    }

    // The ranked per-category list (and its merchant drill-down) has been
    // removed. Its two roles now live elsewhere: the trend-vs-prior signal
    // moved INTO each treemap tile as a shape+colour marker (see
    // treemap-render.js), reusing the SAME guarded comparison via the
    // shared describeComparisonText/comparisonTone exports (spend-
    // breakdown.js) - never a second, independently-worded copy. The share
    // percentage was dropped entirely: the treemap's own relative tile area
    // already communicates a category's share of the total more honestly
    // than a printed number can. Per-merchant drill-down is unaffected -
    // clicking a category tile still opens that category's transactions
    // (drillToTransactions, below).
    return sec;
  }

  /* ===================================================================
   * 3) CATEGORY INTENTIONS - forward pace, no-guilt language, PLUS the
   *    authoring form (B2): a person sets, edits, or removes a category
   *    ceiling directly from this card. The card is now the ONE entry
   *    point - it never returns null when categorySpend exists, even with
   *    zero ceilings set, so the empty state IS the "way in" rather than
   *    a card that only ever appears once a ceiling already exists
   *    somewhere else (proven by b2_render_proof.mjs's card-always-renders
   *    check).
   *
   *    Save NEVER mutates an existing record - it always creates a NEW
   *    repeating intention, matching category-intentions.js's own frozen
   *    contract (an edit is a new record, never a rewrite of history).
   *    Remove clears EVERY record for that category, reverting it fully to
   *    "no ceiling set" - there is no partial/point-in-time removal exposed
   *    here; the precise single-record delete-by-id path already exists
   *    and is proven correct at the resolver level (b2_resolver_proof.mjs).
   *
   *    Each row's Remove button carries the GOVERNING record's real id
   *    (from provenModels.intentionFor, never a raw/unresolved record) as
   *    a data-id attribute - a defensive, always-real reference, guarding
   *    against the exact "undefined id" class of bug an earlier round hit.
   * =================================================================== */
  /* ===================================================================
  * 4) CUSTOM LABELS - cross-category totals against an optional target
   *    (a renovation, a holiday - spending a monthly pace signal can't
   *    express since it spans categories and months). Same pattern as
   *    intentions: the card is ALWAYS the way in, never appearing only
   *    once a tag already exists. Reads provenModels.tags() (the proven
   *    reader), never re-derives totals here. Assignment (attaching a
  *    transaction to a custom label) IS wired: every row in the merged Transactions
  *    ledger (renderMergedLedger, both card and bank) carries a "+ Custom label" /
  *    "Custom label \u00d7N" control that opens the same label picker this card's
   *    totals read from, so a tag's count updates the moment a row is
   *    attached, with no separate assignment surface left to build.
   * =================================================================== */  async function createTag(name, target) {
    if (!name) {
      toast('Name the custom label first.');
      return;
    }
    await Store.tags.put(makeTag({ name, target }));
    state.tags = await Store.tags.all();
    trackUsage('activity-create-tag');
    render();
    toast(`Custom label "${name}" created.`);
  }

  async function removeTag(id) {
    await Store.tags.delete(id);
    state.tags = await Store.tags.all();
    trackUsage('activity-remove-tag');
    render();
    toast('Custom label removed.');
  }

  function renderTagForm() {
    const nameInput = el('input', {
      type: 'text',
      class: 'name-field',
      placeholder: 'Custom label name',
      maxlength: '40',
    });
    const targetInput = el('input', {
      type: 'number',
      class: 'name-field',
      placeholder: 'Target (optional)',
      min: '1',
    });
    const confirm = async () => {
      await createTag(nameInput.value.trim(), Number(targetInput.value) || null);
      nameInput.value = '';
      targetInput.value = '';
    };
    return el(
      'div',
      {},
      el('p', { class: 'muted small' }, 'Create a custom label'),
      el(
        'div',
        { class: 'manage-actions' },
        nameInput,
        targetInput,
        el('button', { class: 'btn sm', onclick: confirm }, 'Create custom label')
      )
    );
  }

  function renderTags() {
    const models = provenModels.tags();
    const sec = el('section', { class: 'card' });
    sec.append(
      el(
        'div',
        { class: 'card-head' },
        el('h3', { class: 'card-title' }, icon(iconRepeat()), 'Custom labels')
      )
    );

    if (models.length) {
      const list = el('div', { class: 'recurring-list' });
      for (const m of models) {
        const removeBtn = el(
          'button',
          { class: 'btn sm ghost', onclick: () => removeTag(m.id) },
          'Remove'
        );
        if (removeBtn.setAttribute) {
          removeBtn.setAttribute('data-id', m.id);
        }
        list.append(
          el(
            'div',
            { class: 'recurring-row' },
            el('span', { class: 'recurring-name' }, m.name),
            m.tag
              ? el('span', { class: 'vm-tag tone-' + (m.tone || 'neutral') }, m.tag)
              : el('span', {}),
            el('span', { class: 'recurring-amt num' }, m.amountText),
            removeBtn
          )
        );
      }
      sec.append(list);
    }

    sec.append(renderTagForm());
    return sec;
  }

  function validSplitFor(row) {
    const split = splitsByTxnId(state.transactionSplits || []).get(row.id);
    return split && validateSplit(split, row.amount).ok ? split : null;
  }

  // How many custom labels this transaction belongs to (0 = none), for
  // the row's membership marker. Reads state.tags' txnIds directly - the same
  // membership the Custom labels card totals from - so a marker here can never
  // disagree with a label's own count.
  function tagCountFor(row) {
    let n = 0;
    for (const t of state.tags || []) if ((t.txnIds || []).includes(row.id)) n++;
    return n;
  }

  function ledgerIsNarrowed() {
    return ledgerIsNarrowedPure(state);
  }

  // Custom label names a transaction belongs to, lowercased, for search matching
  // - so typing a label's name surfaces its members (the plan's "search across ... label"
  // clause), reading the same state.tags membership the marker and Custom labels card use.
  function tagNamesFor(row) {
    const names = [];
    for (const t of state.tags || [])
      if ((t.txnIds || []).includes(row.id)) names.push(String(t.name || '').toLowerCase());
    return names;
  }

  // Does a merged entry match the current search text? Case-insensitive over
  // the description/payee, the category (card side), the absolute amount, and
  // any tag names. Empty search matches everything.
  function matchesSearch(m, q) {
    if (!q) return true;
    const r = m.row;
    const hay = [
      r.displayName,
      r.description,
      r.counterpartyLabel,
      m.ledger === 'card' ? r.category : '',
      String(Math.abs(Number(r.amount) || 0)),
      ...tagNamesFor(r),
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return hay.includes(q);
  }

  function renderMergedLedger(cardRows, bankRecs) {
    const q = _txSearch.trim().toLowerCase();
    const all = [
      ...cardRows.map((r) => ({ ledger: 'card', date: r.date, row: r })),
      ...bankRecs.map((r) => ({ ledger: 'bank', date: r.date, row: r })),
    ].sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
    const totalCount = all.length;
    const merged = q ? all.filter((m) => matchesSearch(m, q)) : all;
    // Consumed here, once: drillToTransaction (shared-helpers.js) sets this
    // key before calling render(); if the target row is present in THIS
    // period's merged list, it is forced into the DOM below regardless of
    // the normal 10-row cap, and marked open/highlighted at build time. The
    // key is cleared immediately after use so an unrelated later render()
    // never re-triggers the highlight a second time.
    const focusKey = state._focusTxnKey || null;
    const focusIndex = focusKey
      ? merged.findIndex((m) => m.ledger + ':' + m.row.id === focusKey)
      : -1;
    if (focusKey) state._focusTxnKey = null;
    const sec = el('section', { class: 'card', id: 'acct-tx', tabindex: '-1' });
    sec.append(
      el(
        'div',
        { class: 'card-head' },
        el('h3', { class: 'card-title' }, icon(iconList()), 'All transactions')
      )
    );

    if (bankRowsInapplicable()) {
      sec.append(
        el(
          'div',
          { class: 'attn-item', style: 'padding:6px 0' },
          el('span', { class: 'attn-dot review' }),
          el(
            'div',
            { class: 'attn-body' },
            "Bank transactions aren't shown while filtering by category, merchant, foreign-only or review - those don't apply to bank statements."
          ),
          el(
            'button',
            {
              class: 'btn sm ghost',
              onclick: () => {
                trackUsage('activity-clear-ledger-filters');
                clearFilters();
                clearBankFilters();
                state.showAllTx = false;
                state.bankShowAllTx = false;
                render();
              },
            },
            'Show all transactions'
          )
        )
      );
    } else if (cardRowsInapplicable()) {
      sec.append(
        el(
          'div',
          { class: 'attn-item', style: 'padding:6px 0' },
          el('span', { class: 'attn-dot review' }),
          el(
            'div',
            { class: 'attn-body' },
            "Card transactions aren't shown while filtering by payee - cards have no equivalent payee identity to match against."
          ),
          el(
            'button',
            {
              class: 'btn sm ghost',
              onclick: () => {
                trackUsage('activity-clear-ledger-filters');
                clearFilters();
                clearBankFilters();
                state.showAllTx = false;
                state.bankShowAllTx = false;
                render();
              },
            },
            'Show all transactions'
          )
        )
      );
    } else if (ledgerIsNarrowed()) {
      sec.append(
        el(
          'div',
          { class: 'attn-item', style: 'padding:6px 0' },
          el('span', { class: 'attn-dot review' }),
          el('div', { class: 'attn-body' }, 'Showing a filtered slice of your transactions.'),
          el(
            'button',
            {
              class: 'btn sm ghost',
              onclick: () => {
                trackUsage('activity-clear-ledger-filters');
                clearFilters();
                clearBankFilters();
                state.showAllTx = false;
                state.bankShowAllTx = false;
                render();
              },
            },
            'Show all transactions'
          )
        )
      );
    }

    const table = el('table', { class: 'grid tx' });
    table.append(
      el(
        'thead',
        {},
        el(
          'tr',
          {},
          el('th', {}, 'Date'),
          el('th', {}, 'Description'),
          el('th', {}, 'Ledger'),
          el('th', { class: 'num' }, `Amount (${state.cfg.currency.code})`)
        )
      )
    );
    const body = el('tbody');
    // The fuller detail behind each row - raw statement text, the account
    // tail, the transaction's kind - kept off the row itself (which stays a
    // scannable single line) and revealed only when a person opens it.
    // Reuses .tx-detail/.detail-grid, the same "opened row detail" language
    // the account ledger's own detail rows already use elsewhere.
    function buildDetailRow(m) {
      const r = m.row;
      const rows = [];
      rows.push(['Statement text', r.description || '']);
      if (m.ledger === 'card') {
        if (r.raw_description && r.raw_description !== r.description)
          rows.push(['Full statement line', r.raw_description]);
        if (r.kind) rows.push(['Type', r.kind]);
      } else if (r.account) {
        rows.push(['Account', `\u2026${String(r.account).slice(-4)}`]);
        // A bank statement already carries its own printed running balance
        // per row (r.balanceAfter) - the one already reconciled and trusted
        // for bank-statement reconciliation elsewhere in this app. Surfacing
        // it here is a plain read, not a new calculation.
        if (r.balanceAfter != null) rows.push(['Balance after', bankMoney(r.balanceAfter)]);
      }
      const grid = el('div', { class: 'detail-grid' });
      for (const [k, v] of rows) {
        if (!v) continue;
        grid.append(
          el(
            'div',
            {},
            el('div', { class: 'kv-k muted small' }, k),
            el('div', { class: 'kv-v' }, String(v))
          )
        );
      }
      const tr = el('tr', { class: 'tx-detail', hidden: '' });
      tr.append(el('td', { colspan: 4 }, grid));
      return tr;
    }
    // Wires a row to its detail row: click (outside any inner button) or
    // Enter/Space toggles both the visible open state and aria-expanded, so
    // a row's fuller detail is one click or keypress away without disturbing
    // any of the row's own inline controls (category, tag, drill).
    function attachRowToggle(mainTr, detailTr) {
      mainTr.classList.add('clickable');
      mainTr.tabIndex = 0;
      mainTr.setAttribute('role', 'button');
      mainTr.setAttribute('aria-expanded', 'false');
      const toggle = () => {
        const open = mainTr.classList.toggle('open');
        detailTr.hidden = !open;
        mainTr.setAttribute('aria-expanded', open ? 'true' : 'false');
      };
      mainTr.addEventListener('click', (e) => {
        if (e.target.closest && e.target.closest('button')) return;
        toggle();
      });
      mainTr.addEventListener('keydown', (e) => {
        if (e.target !== mainTr) return;
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          toggle();
        }
      });
    }
    const renderMergedRow = (m) => {
      if (m.ledger === 'card') {
        const r = m.row;
        const reason = reviewReasonText(r, FALLBACK(), state.brandRules, state.merchants);
        const split = validSplitFor(r);
        const nameCell = el(
          'td',
          {},
          el(
            'button',
            {
              class: 'linkbtn',
              style: 'padding:0;font-weight:600',
              onclick: () => {
                trackUsage('activity-open-category');
                openCategoryPicker(r);
              },
            },
            r.displayName || r.description
          ),
          el(
            'div',
            { class: 'muted small', style: 'margin-top:2px' },
            catTag(r.category, {}),
            split
              ? el(
                  'span',
                  {
                    class: 'vm-tag tone-neutral',
                    title: 'This transaction is distributed across categories',
                    style: 'margin-left:6px',
                  },
                  'Split'
                )
              : null,
            tagCountFor(r) > 0
              ? el(
                  'button',
                  {
                    class: 'vm-tag tone-neutral',
                    title: 'Edit custom labels for this transaction',
                    style: 'margin-left:6px',
                    onclick: () => {
                      trackUsage('activity-open-tag');
                      openTagPicker(r);
                    },
                  },
                  `Custom label${tagCountFor(r) > 1 ? ` \u00d7${tagCountFor(r)}` : ''}`
                )
              : el(
                  'button',
                  {
                    class: 'row-tag-action',
                    title: 'Add this transaction to a custom label',
                    onclick: () => {
                      trackUsage('activity-open-tag');
                      openTagPicker(r);
                    },
                  },
                  '+ Custom label'
                )
          ),
          reason ? el('div', { class: 'muted small' }, reason) : null
        );
        // Every row now carries a stable, addressable id - previously
        // nothing in this table could be referenced from outside it, which
        // was the actual prerequisite gap behind "clicking through lands
        // near a transaction, not on it". isFocused marks the ONE row a
        // drillToTransaction call just asked for, pre-opening its detail and
        // giving it a brief highlight, rather than requiring a second,
        // separate click after landing here.
        const rowKey = m.ledger + ':' + r.id;
        const isFocused = rowKey === focusKey;
        const mainTr = el(
          'tr',
          {
            class: 'tx-row' + (isFocused ? ' open focus-row' : ''),
            id: 'tx-' + m.ledger + '-' + r.id,
          },
          el('td', { class: 'nowrap' }, formatDisplayDate(r.date)),
          nameCell,
          el('td', {}, 'Card'),
          el(
            'td',
            { class: 'num amt ' + (r.amount < 0 ? 'credit' : '') },
            (r.amount < 0 ? '+' : '-') + money0(Math.abs(r.amount))
          )
        );
        const detailTr = buildDetailRow(m);
        detailTr.id = 'tx-detail-' + m.ledger + '-' + r.id;
        if (isFocused) detailTr.hidden = false;
        attachRowToggle(mainTr, detailTr);
        if (isFocused) mainTr.setAttribute('aria-expanded', 'true');
        const frag = document.createDocumentFragment();
        frag.append(mainTr, detailTr);
        return frag;
      }
      const r = m.row;
      const label = r.household ? 'Household' : r.excludedFromIncome ? 'Not yet income' : '';
      const bankTagCtrl =
        tagCountFor(r) > 0
          ? el(
              'button',
              {
                class: 'vm-tag tone-neutral',
                title: 'Edit custom labels for this transaction',
                style: 'margin-left:6px',
                onclick: () => {
                  trackUsage('activity-open-tag');
                  openTagPicker(r);
                },
              },
              `Custom label${tagCountFor(r) > 1 ? ` \u00d7${tagCountFor(r)}` : ''}`
            )
          : el(
              'button',
              {
                class: 'row-tag-action',
                title: 'Add this transaction to a custom label',
                onclick: () => {
                  trackUsage('activity-open-tag');
                  openTagPicker(r);
                },
              },
              '+ Custom label'
            );
      // Bank rows now share the card branch's name-cell shape - a name line,
      // then one meta line beneath it for whatever badges apply - so a mixed
      // list of card and bank rows reads as one row family, not two.
      const nameCell = el(
        'td',
        {},
        el(
          'button',
          {
            class: 'linkbtn',
            style: 'padding:0;font-weight:600',
            onclick: () => {
              trackUsage('activity-drill-payee');
              drillToAccountsPayee(r.counterpartyKey, cleanCounterparty(r.counterpartyLabel));
            },
          },
          cleanCounterparty(r.counterpartyLabel || r.description)
        ),
        el(
          'div',
          { class: 'muted small', style: 'margin-top:2px' },
          label ? el('span', { class: 'vm-tag tone-neutral' }, label) : null,
          bankTagCtrl
        )
      );
      const rowKey = m.ledger + ':' + r.id;
      const isFocused = rowKey === focusKey;
      const mainTr = el(
        'tr',
        {
          class: 'tx-row' + (isFocused ? ' open focus-row' : ''),
          id: 'tx-' + m.ledger + '-' + r.id,
        },
        el('td', { class: 'nowrap' }, formatDisplayDate(r.date)),
        nameCell,
        el('td', {}, r.account ? `Bank \u00b7 \u2026${String(r.account).slice(-4)}` : 'Bank'),
        el(
          'td',
          { class: 'num amt ' + (r.direction === 'in' ? 'credit' : '') },
          (r.direction === 'in' ? '+' : '-') + bankMoney(Math.abs(r.amount))
        )
      );
      const detailTr = buildDetailRow(m);
      detailTr.id = 'tx-detail-' + m.ledger + '-' + r.id;
      if (isFocused) detailTr.hidden = false;
      attachRowToggle(mainTr, detailTr);
      if (isFocused) mainTr.setAttribute('aria-expanded', 'true');
      const frag = document.createDocumentFragment();
      frag.append(mainTr, detailTr);
      return frag;
    };
    // A search shows every match with no cap (so a match past row 10 is never
    // hidden); no search keeps the calm 10-row initial cap with See more/all.
    // A focused single-transaction target ALSO forces a full reveal for this
    // one render pass - simplest guarantee the row genuinely exists in the
    // DOM before focusTransactionRow tries to scroll to it. A more surgical
    // "reveal exactly up to the target" is possible (appendExpandable's own
    // reveal(n) already accepts an arbitrary count) but was not pursued here
    // in favour of the simpler, unambiguously-correct option.
    const showAll = state.showAllTx || state.bankShowAllTx || !!q || focusIndex >= 0;
    appendExpandable(el, body, merged, renderMergedRow, {
      initial: showAll ? merged.length : 10,
      wrapToggle: (controls) => el('tr', {}, el('td', { colspan: 4 }, controls)),
    });
    table.append(body);
    // Plain table-wrap (no 'sticky'): the sticky variant traps rows in a fixed-
    // height inner scroll (max-height: min(72vh,860px)), which doubled the
    // See-more / See-all paradigm - two scroll models for one list. The list
    // now grows with its rows and is governed solely by See-more / See-all, one
    // paradigm. The merch table (cards-render) already uses plain table-wrap, so
    // this is isolated to the merged ledger.
    sec.append(el('div', { class: 'table-wrap' }, table));
    const footer = q
      ? `Showing ${merged.length} of ${totalCount} transaction${totalCount === 1 ? '' : 's'} matching "${_txSearch.trim()}".`
      : `${merged.length} transaction${merged.length === 1 ? '' : 's'}.`;
    sec.append(el('p', { class: 'muted small' }, footer));
    return sec;
  }

  /* TEMPORAL CONTRACT: this is BACKWARD content - the income that has already
     ARRIVED over the past months (the history bars, "your income has been X").
     It belongs in Activity (looking back), not Forecast. Forecast owns the
     FORWARD half - projecting the next deposit and the cash runway - which
     lives in the forecast chart itself, not a card. Same data
     (analyseIncomePattern), two temporal stances, two homes: the past series
     here, the projection there. */
  function renderIncome(income) {
    const hero = buildIncomeHero(income, bankMoney);
    if (!hero) return null;
    const caption = buildIncomeCaption(income);
    const sec = el('section', { class: 'card' });
    sec.append(
      el(
        'div',
        { class: 'card-head' },
        el('h3', { class: 'card-title' }, icon(iconSpark()), 'Your income pattern')
      )
    );
    const lead = el(
      'div',
      { class: 'vm-lead' },
      el('div', { class: 'vm-number' }, hero.amountText),
      hero.label ? el('div', { class: 'vm-label' }, hero.label) : null
    );
    const onclick = income.key
      ? () => {
          trackUsage('activity-drill-income');
          drillToAccountsPayee(income.key, cleanCounterparty(income.label));
        }
      : null;
    sec.append(
      onclick
        ? el(
            'button',
            {
              class: 'linkbtn',
              style: 'display:block;text-align:left;padding:0;width:100%',
              onclick,
            },
            lead
          )
        : lead
    );
    if (hero.deltaText)
      sec.append(el('span', { class: 'vm-tag tone-' + hero.deltaTone }, hero.deltaText));
    const chart = renderIncomeChart(income);
    if (chart) sec.append(chart);
    if (caption) sec.append(el('p', { class: 'muted small', style: 'margin:8px 0 0' }, caption));
    return sec;
  }

  function renderPace() {
    const pace = detectMidMonthPace(state.rows, state.cfg, new Date());
    if (!pace.length) return null;
    const sec = el('section', { class: 'card' });
    sec.append(
      el(
        'div',
        { class: 'card-head' },
        el('h3', { class: 'card-title' }, icon(iconGap()), 'Partway through the month')
      )
    );
    // Each warning already names the exact category running hot; previously
    // that was the end of the road, with the actual tool to act on it (a
    // category ceiling) sitting a scroll away on this same tab and no link
    // between the two. Jumps straight there and pre-selects the same
    // category, rather than leaving a person to find it themselves.
    function goSetCeiling(category) {
      trackUsage('activity-pace-set-ceiling');
      const select = document.getElementById('ceiling-category-select');
      if (select) {
        select.value = category;
        select.dispatchEvent(new Event('change'));
      }
      smoothScrollToEl('#activity-ceilings');
    }
    for (const p of pace) {
      sec.append(
        el(
          'div',
          { class: 'muted small', style: 'margin-bottom:6px' },
          `${p.category} spending is on pace for about ${money0(p.projected)} this month, against a typical ${money0(p.typical)}. It is only day ${p.dayOfMonth} of ${p.daysInMonth}, so this is a projection, not a final figure.`,
          ' ',
          el(
            'button',
            { class: 'linkbtn', onclick: () => goSetCeiling(p.category) },
            'Set a ceiling'
          )
        )
      );
    }
    return sec;
  }

  function renderMergedPlaces(cardRows, bankRecs) {
    const cardMerchants = (analysis() || {}).merchants || [];
    const refundPairs = pairCardRefunds(cardRows, state.brandRules, state.merchants).pairs;
    const cpGroups = bankCounterpartyGroups(bankRecs);
    const outflows = externalOutflowShortlist(cpGroups, 8).filter((g) => {
      const rec = bankRecs.find((r) => r.counterpartyKey === g.key);
      return !rec || !isCardPaymentTransfer(rec, state.cardAccounts);
    });
    const inflows = externalInflowShortlist(cpGroups, 8);
    const merged = mergedMoneyMovedRanking(
      cardRows,
      cardMerchants,
      outflows,
      inflows,
      refundPairs,
      state.brandRules,
      state.merchants
    ).slice(0, 10);
    if (!merged.length) return null;
    const sec = el('section', { class: 'card' });
    sec.append(
      el(
        'div',
        { class: 'card-head' },
        el('h3', { class: 'card-title' }, icon(iconList()), 'Where money flowed in and out')
      )
    );
    const total = merged.reduce((s, g) => s + g.amount, 0) || 1;
    // The multi-segment share bar was illegible (six tiny colour chips) and the
    // ranked list below already carries the proportion clearly, so it is
    // dropped - the list is the honest, readable representation.
    function drillPlace(g) {
      trackUsage('activity-drill-place');
      if (g.source === 'card')
        drillToTransactions({
          merchant: g.key,
          merchantLabel: g.label,
          category: 'all',
        });
      else drillToAccountsPayee(g.key, cleanCounterparty(g.label));
    }

    const list = el('div', { class: 'recurring-list' });
    const renderRow = (g) =>
      el(
        'button',
        { class: 'recurring-row', onclick: () => drillPlace(g) },
        el(
          'span',
          { class: 'recurring-name' },
          el('span', { class: 'commit-name-main' }, g.label),
          el(
            'span',
            { class: 'commit-name-sub muted small', style: 'margin-left:6px' },
            `\u00b7 ${g.count} transaction${g.count === 1 ? '' : 's'}`
          )
        ),
        el(
          'span',
          {
            class: 'recurring-amt num ' + (g.direction === 'in' ? 'credit' : 'strong'),
          },
          (g.direction === 'in' ? '+' : '') + money0(g.amount)
        )
      );
    appendExpandable(el, list, merged, renderRow, { initial: 5 });
    sec.append(list);
    return sec;
  }

  function renderMergedInsights(a, cardRows, bankRecs) {
    // Previously hardcoded to an empty array regardless of what the card
    // ledger actually showed, meaning this card's only real content ever came
    // from bank data - for a card-only person (or a bank-only person, in
    // reverse) it always read "calm, nothing stands out" no matter what was
    // genuinely unusual in their own ledger. buildInsights (cards-render.js)
    // already computes real per-category and per-merchant signals from the
    // same resolved period and periodRows() this whole tab already reads;
    // it was simply never wired into this merge.
    const cardInsights = buildInsights(a);
    const bankInsights = buildBankInsights(a, bankRecs, classifiedBank());
    const merged = rankInsights(
      [...cardInsights, ...bankInsights],
      (state.cfg.insights && state.cfg.insights.maxInsights) || 3
    );
    return renderInsightList(el, icon, {
      title: 'What\u2019s new or unusual',
      iconBulb,
      iconChevron,
      insights: merged,
      emptyText: 'A calm period. Nothing stands out against your usual pattern.',
    });
  }


  function renderActivityTabs() {
    const strip = el('div', {
      class: 'ledger-tabs activity-tabs',
      role: 'tablist',
      'aria-label': 'Activity views',
    });
    const mkTab = (id, label) =>
      el(
        'button',
        {
          class: 'ledger-tab' + (state.activityTab === id ? ' active' : ''),
          role: 'tab',
          'aria-selected': state.activityTab === id ? 'true' : 'false',
          onclick: () => {
            if (state.activityTab !== id) {
              state.activityTab = id;
              trackUsage('activity-tab-' + id);
              render();
            }
          },
        },
        label
      );
    strip.append(mkTab('analysis', 'Analysis'), mkTab('transactions', 'Transactions'));

    return strip;
  }

  function renderAnalysisTab() {
    const wrap = el('div', { class: 'accounts-wrap accounts-grid' });
    const a = analysis();
    const bankRecs = bankRecordsInPeriod(classifiedBank());
    const cardRows = periodRows();

    const cf = renderCommittedFlexible();
    if (cf) wrap.append(cf);

    const insightsCard = renderMergedInsights(a, cardRows, bankRecs);
    if (insightsCard) wrap.append(insightsCard);

    const income = analyseIncomePattern(classifiedBank(), state.cfg, new Date());
    const incomeCard = renderIncome(income);
    if (incomeCard) wrap.append(incomeCard);

    const sb = renderSpendBreakdown();
    if (sb) wrap.append(sb);

    // Where money flowed + Regular commitments: two proportion lists, paired.
    const placesCard = renderMergedPlaces(cardRows, bankRecs);
    const commitCard = renderRecurring();
    pairCards(wrap, placesCard, commitCard);

    if (a && cardRows.length) {
      // Spending over time + Spent abroad: two spending-history cards, paired.
      const trendCard = renderTrend(a);
      const foreignCard = renderForeign(a);
      pairCards(wrap, trendCard, foreignCard);
    }

    if (bankRecs.length) {
      const bankA = analyseBankActivity(bankRecs);
      const reviewCard = renderLedgerReview(bankA, bankRecs);
      if (reviewCard) wrap.append(reviewCard);
    }

    const fitnessCard = renderCardFitness();
    if (fitnessCard) wrap.append(fitnessCard);

    const paceCard = renderPace();
    if (paceCard) wrap.append(paceCard);

    // Category ceilings + Tags: two authoring forms, paired.
    const ci = renderIntentions();
    const tg = renderTags();
    pairCards(wrap, ci, tg);

    if (wrap.childElementCount === 0) {
      wrap.append(
        el(
          'section',
          { class: 'card empty' },
          el('h2', {}, 'Nothing to analyse yet'),
          el(
            'p',
            { class: 'muted' },
            'Import a statement and this period\u2019s spending analysis appears here.'
          )
        )
      );
    }
    return wrap;
  }

  // A short, scannable label for an account. No account name exists in the
  // data (analyseBankActivity carries only the raw number), so the last four
  // digits - the universal "account ending in" convention people recognise -
  // are used when they are unique across the person's accounts, with the full
  // number as an unambiguous fallback when any two share a last-4. The balance
  // is deliberately NOT shown here: it lives on Position, and fusing it onto
  // the selection token made picking an account a reading task, not a
  // recognition one.
  function accountChipLabel(account, allAccounts) {
    const s = String(account);
    const last4 = s.slice(-4);
    const collides = allAccounts.filter((a) => String(a.account).slice(-4) === last4).length > 1;
    return collides || s.length <= 4 ? s : '\u2026' + last4;
  }

  function renderAccountSelector() {
    const ov = overviewModel().ov;
    const bankAccounts = (ov && ov.accounts) || [];
    // The card joins this same selector as a genuine third state, not a
    // second, disconnected picker - a person cycles through "All", each bank
    // account, and the card in one row. Shown whenever there is more than one
    // thing to choose between: either multiple bank accounts, or a card
    // alongside even a single bank account.
    const pm = provenModels.positionModels();
    const cardBalance = pm && pm.cashDebt ? pm.cashDebt.cardBalance : null;
    const hasCard = cardBalance != null;
    if (bankAccounts.length < 2 && !hasCard) return null;

    const current = state.bankAccount || 'all';
    const bankTotal = analyseBankActivity(classifiedBank()).closingBalance;

    const sec = el('section', { class: 'card' });
    sec.append(
      el(
        'div',
        { class: 'card-head' },
        el('h3', { class: 'card-title' }, icon(iconInfo()), 'Show one account')
      )
    );
    const slicer = el('div', {
      class: 'acct-slicer',
      'aria-label': 'Filter transactions by account or card',
    });

    function select(value) {
      if (current === value) return;
      resetBankDrillFacets();
      state.bankAccount = value;
      state.bankShowAllTx = true;
      state.showAllTx = true;
      trackUsage('activity-select-account');
      render();
    }
    const tile = (value, name, sub, owe) =>
      el(
        'button',
        {
          class: 'acct-chip' + (current === value ? ' active' : ''),
          'aria-pressed': current === value ? 'true' : 'false',
          onclick: () => select(value),
        },
        el('span', { class: 'acct-chip-name' }, name),
        el('span', { class: 'acct-chip-sub' + (owe ? ' owe' : '') }, sub)
      );

    slicer.append(tile('all', 'All bank accounts', bankMoney(bankTotal)));
    for (const a of bankAccounts) {
      slicer.append(
        tile(a.account, accountChipLabel(a.account, bankAccounts), bankMoney(a.closingBalance))
      );
    }
    if (hasCard) {
      // Never folded into "All accounts": a card balance is money OWED, the
      // opposite direction a bank balance moves in, and this app never
      // silently nets debt against cash into one blended figure anywhere
      // else (Position's own "Cash and debt" card keeps them separate for
      // the identical reason). The card stays its own tile with its own
      // figure - signed, warm-toned - so the reversed direction is
      // unmistakable without adding any explanatory text to what is meant
      // to stay a quick, scannable strip.
      slicer.append(tile('card', 'Credit card', '-' + bankMoney(Math.abs(cardBalance)), true));
    }
    sec.append(slicer);

    const oneBank = current !== 'all' && current !== 'card';
    sec.append(
      el(
        'p',
        { class: 'muted small', style: 'margin:8px 0 0' },
        oneBank
          ? 'Tap an account or your card to show only its transactions below, with a running balance.'
          : 'Tap an account or your card to show only its transactions below.'
      )
    );
    return sec;
  }

  function renderTransactionsTab() {
    const cardRowsAll = periodRows();
    const bankRecsAll = bankRecordsInPeriod(classifiedBank());
    const selected = state.bankAccount || 'all';
    // Each tile isolates its OWN ledger, matching the panel's own title
    // ("Show one account") and caption ("show only its transactions") -
    // selecting a bank account no longer leaves every card transaction
    // showing alongside it, and selecting the card excludes bank rows.
    const isCard = selected === 'card';
    const isOneBank = selected !== 'all' && !isCard;
    const cardRows = isOneBank ? [] : cardRowsAll;
    const bankRecs = isCard
      ? []
      : isOneBank
        ? bankRecsAll.filter((r) => r.account === selected)
        : bankRecsAll;
    const wrap = el('div', { class: 'accounts-wrap' });
    if (!cardRows.length && !bankRecs.length) {
      wrap.append(
        el(
          'section',
          { class: 'card empty' },
          el('h2', {}, 'Transactions'),
          el('p', { class: 'muted' }, 'Import a statement and your transactions appear here.')
        )
      );
      return wrap;
    }
    const selector = renderAccountSelector();
    if (selector) wrap.append(selector);

    // Search: the plan's Transactions spec - find a transaction across its
    // description, category, amount or tag name, LIVE as you type. The input is
    // built ONCE and lives outside the ledger; typing calls a local rebuild that
    // rewrites only the ledger container, never the input, so focus and caret
    // are preserved perfectly - the same reason the category picker filters its
    // list in-place rather than re-rendering the whole view. No render() call.
    const search = el('input', {
      type: 'search',
      class: 'f-search',
      placeholder: 'Search transactions - name, category, amount, or custom label',
      'aria-label': 'Search transactions',
      value: _txSearch,
    });
    wrap.append(el('div', { class: 'tx-filters' }, search));

    if (isOneBank) {
      wrap.append(
        el(
          'p',
          { class: 'muted small', style: 'margin:0 0 8px' },
          `Showing account ending ${String(selected).slice(-4)} only. Card transactions are hidden.`
        )
      );
    } else if (isCard) {
      wrap.append(
        el(
          'p',
          { class: 'muted small', style: 'margin:0 0 8px' },
          'Showing your card only. Bank account transactions are hidden.'
        )
      );
    }

    const ledgerHost = el('div', {});
    wrap.append(ledgerHost);
    const rebuildLedger = () => {
      ledgerHost.textContent = '';
      // visibleRows()/visibleBankRows() still apply every OTHER active filter
      // facet (category, kind, merchant, search, payee...); the account/card
      // tile narrows on top of that by simply excluding the other ledger's
      // rows outright when one specific account or the card is selected.
      const cardRowsForLedger = isOneBank ? [] : visibleRows();
      ledgerHost.append(renderMergedLedger(cardRowsForLedger, visibleBankRows(bankRecs)));
    };
    search.addEventListener('input', () => {
      _txSearch = search.value;
      trackUsage('activity-tx-search');
      rebuildLedger();
    });
    rebuildLedger();
    return wrap;
  }
  function renderActivity() {
    trackUsage('view-activity');
    const wrap = el('div', { class: 'accounts-wrap' });
    wrap.append(renderActivityTabs());

    wrap.append(
      state.activityTab === 'transactions' ? renderTransactionsTab() : renderAnalysisTab()
    );
    return wrap;
  }

  // The Activity cache signature (app.js's mountView keys on this). It must
  // include EVERYTHING that changes what the Transactions tab shows - not just
  // which tab is open. Without the filter/account facets here, a drill into
  // Transactions (a treemap category click, a "where money went" row, an
  // account chip, or the "Show all transactions" clear) mutates state and calls
  // render(), but mountView sees an unchanged signature and reuses stale DOM -
  // exactly the class of bug the goal-draft signature already fixed. Mirrors
  // Right Now's own signature facet set (app.js), so both surfaces rebuild on
  // the same state changes.
  function activityTabSignature() {
    const f = state.filter,
      bf = state.bankFilter;
    return [
      state.activityTab,
      state.bankAccount,
      _txSearch,
      f.category,
      f.kind,
      f.merchant,
      f.month,
      f.min,
      f.max,
      f.foreignOnly,
      f.reviewOnly,
      f.search,
      bf.payeeKey,
      bf.kind,
      bf.search,
      bf.hideInternal,
      state.showAllTx,
      state.bankShowAllTx,
    ].join('|');
  }

  return {
    renderActivity,
    renderCommittedFlexible,
    renderSpendBreakdown,
    renderIntentions,
    renderTags,
    activityTabSignature,
    drillToTransaction,
  };
}
