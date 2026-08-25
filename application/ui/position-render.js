/*
 * PROVENANCE RULE (applies to every render surface, not just this file):
 * The reconciled default is SILENT - a figure from statements is just the
 * number, never labelled "from statements" / "reconciled" / "as of X" on the
 * row. Trustworthiness is the app's baseline promise, stated once in the
 * footer, never re-asserted per line. Only a DEPARTURE from that default
 * carries a minimal mark: self-reported (a quiet cue + Remove), stale ("may be
 * out of date"), or estimated (the "≈" glyph). The full working lives behind
 * the existing "Why"/detail dropdown and in the export ONLY - a banker reading
 * pasted text has no dropdown and needs the words; the interface does not.
 * Do not print where-a-number-came-from as row text; encode it as state. A
 * label is also redundant when another visual element already encodes it: a
 * signed, coloured amount already says inflow vs outflow, so no "Cash inflow /
 * Cash outflow" word is printed beside it.
 *
 * position-render.js  -  the "Position" destination (fourth tab). Renders the
 * proven position models (cash & debt, coverage-based net worth, financial-
 * position summary) via the shared number -> tag -> dropdown content model.
 *
 * Follows the app's established render-factory pattern EXACTLY: constructed once
 * in bootUI, receives the members it uses via one ctx object, fails loudly at
 * construction (requireCtx) if a dependency is missing, and returns the one
 * name render() calls (renderPosition). It owns no analysis - every figure
 * comes from provenModels.positionModels(), which is corpus-proven; this file
 * only turns that model into DOM.
 *
 * INTEGRITY, ENFORCED IN THE MARKUP (not just the model):
 *   - reconciled figures (cash, card, income stability) render as authoritative
 *     content-model cards;
 *   - the recorded net worth NEVER shows a bare "complete" total: its tag states
 *     coverage ("covers N of M classes") and its own note names the gaps;
 *   - self-reported lines are visually separated from reconciled ones and a
 *     stale entry is flagged;
 *   - the summary export keeps each figure's source, and is labelled a personal
 *     summary, not a lender-approved statement.
 */
import { requireCtx } from '../core/shared-helpers.js';
import { renderShareBar } from '../analysis/reporting.js';

export function createPositionRenderer(ctx) {
  requireCtx(
    ctx,
    [
      'state',
      'el',
      'icon',
      'provenModels',
      'iconInfo',
      'trackUsage',
      'Store',
      'render',
      'makeManualAsset',
      'NET_WORTH_CLASSES',
      'toast',
      'smoothScrollToEl',
      'drillToAccount',
    ],
    'createPositionRenderer'
  );
  const {
    state,
    el,
    icon,
    provenModels,
    iconInfo,
    trackUsage,
    Store,
    render,
    makeManualAsset,
    NET_WORTH_CLASSES,
    smoothScrollToEl,
    drillToAccount,
  } = ctx;  // Optional icons: used when present, degraded gracefully when not (so this
  // renderer never crashes if the icon set lacks one of these names).
  const iconStore = ctx.iconStore || iconInfo;
  const iconList = ctx.iconList || iconInfo;
  const toast = ctx.toast || (() => {});

  /* ---- the shared content-model component: number -> tag -> dropdown ----
   * Emits the exact .vm / .vm-number / .vm-tag / .vm-detail markup glass.css
   * styles. The number is plain content (never glassy); the tag is pronoun-free
   * with the tone dot; the detail hides in a native <details>. */
  function renderVM(m, opts = {}) {
    if (!m) return null;
    const kids = [
      el(
        'div',
        { class: 'vm-lead' },
        el(
          'div',
          { class: 'vm-number' + (opts.lead ? ' lg' : '') },
          m.amountText != null ? m.amountText : m.leadText != null ? m.leadText : ''
        ),
        m.label ? el('div', { class: 'vm-label' }, m.label) : null
      ),
    ];
    if (m.tag) kids.push(el('span', { class: 'vm-tag tone-' + (m.tone || 'neutral') }, m.tag));
    if (m.detail) {
      kids.push(
        el(
          'details',
          { class: 'vm-detail' },
          el('summary', {}, 'Why'),
          el('div', { class: 'vm-detail-body' }, m.detail)
        )
      );
    }
    return el('div', { class: 'vm' }, ...kids);
  }

  /* ---- cash & debt: the reconciled half, authoritative, no upkeep ---- */
  function renderCashDebt(cashDebtModel, cashDebt) {
    const sec = el('section', { class: 'card lead', id: 'position-cashdebt' });
    sec.append(
      el(
        'div',
        { class: 'card-head' },
        el('h3', { class: 'card-title' }, icon(iconInfo()), 'Cash and debt')
      )
    );
    // All of this card's figures now sit in ONE flexible row - cash on hand,
    // owed on card AND income stability together - rather than the old split
    // of cash/card as a 2-up pair with income stability full-width beneath.
    // That split was reasoned as "currency peers vs a different kind of
    // value", which is a real distinction, but it left the right two-thirds
    // of the card empty whenever "Owed on card" and "Income stability" both
    // rendered short, reading as an unfinished layout rather than a
    // deliberate one. .vm-row (glass.css) is a genuine N-column grid, not a
    // hardcoded 3-up rule, so this holds correctly whether one, two, three,
    // or (if a figure is ever added here later) more cards exist, and still
    // stacks fully below 1000px exactly like the old .vm-pair did.
    const cardsToShow = cashDebtModel.cards;
    if (cardsToShow.length) {
      const row = el('div', {
        class: 'vm-row' + (cardsToShow.length < 2 ? ' solo' : ''),
      });
      for (const c of cardsToShow) row.append(renderVM(c));
      sec.append(row);
    }

    const perAccount = cashDebt && cashDebt.perAccount ? cashDebt.perAccount : null;
    const accounts = perAccount ? Object.keys(perAccount) : [];
    if (accounts.length > 1) {
      const formatMoney = ctx.bankMoney || ctx.money0 || ((n) => String(n));
      // Last-four identifier, matching Activity's account chips, so the same
      // account reads identically across the app. Full number kept as an
      // unambiguous fallback when any two share a last-4.
      const acctLabel = (acct) => {
        const s = String(acct);
        const last4 = s.slice(-4);
        const collides = accounts.filter((x) => String(x).slice(-4) === last4).length > 1;
        return collides || s.length <= 4 ? s : '\u2026' + last4;
      };
      const list = el('div', { class: 'recurring-list' });
      for (const acct of accounts.sort()) {
        list.append(
          el(
            'button',
            {
              class: 'recurring-row',
              onclick: () => {
                trackUsage('position-drill-account');
                drillToAccount(acct);
              },
            },
            el('span', { class: 'recurring-name' }, acctLabel(acct)),
            el('span', { class: 'recurring-amt num strong' }, formatMoney(perAccount[acct]))
          )
        );
      }
      // Collapsed by default, matching "Add an asset or debt" below: the
      // headline reconciled figures above stay lean, and the per-account
      // breakdown becomes something a person opens deliberately rather than a
      // permanent fixture on the screen's single lead card. Reuses the same
      // .secondary disclosure language as every other opt-in detail in this app.
      const disclosure = el('details', { class: 'secondary', style: 'margin-top:12px' });
      disclosure.append(el('summary', {}, icon(iconInfo()), ` By account (${accounts.length})`));
      const body = el('div', { class: 'sec-section' });
      // A proportion bar above the list. Only positive-balance accounts
      // segment; the list beneath keeps exact figures. Shown only when the
      // cash is GENUINELY split across accounts - when one account holds
      // almost everything, the bar is a single dominant segment with
      // invisible slivers that says nothing the list doesn't, so it is
      // shown only when the top account holds under 85% of the total.
      const positive = accounts.filter((a) => Number(perAccount[a]) > 0);
      const posTotal = positive.reduce((s, a) => s + Number(perAccount[a]), 0);
      const topShare = positive.length ? Math.max(...positive.map((a) => Number(perAccount[a]))) / (posTotal || 1) : 1;
      if (positive.length > 1 && topShare < 0.85) {
        const bar = renderShareBar(el, {
          segments: positive
            .sort((a, b) => perAccount[b] - perAccount[a])
            .map((a) => ({
              amount: Number(perAccount[a]),
              label: acctLabel(a),
            })),
        });
        if (bar) body.append(el('div', { style: 'width:100%;margin:0 0 10px' }, bar));
      }
      body.append(list);
      disclosure.append(body);
      sec.append(disclosure);
    }

    return sec;
  }

  /* ---- recorded net worth: the complete balance-sheet frame ----
   * Every standard class is shown whether filled or empty. A filled class shows
   * its figure(s) and where they came from; an empty class shows a quiet "not
   * added yet" with an Add that opens a small inline form already set to that
   * class - so the missing pieces are structural gaps a person fills in place,
   * not a sentence to read. This IS the coverage honesty, shown as structure.
   * Cash and card come from statements (not addable here); everything else is
   * self-reported, dated, and ages visibly. The old worded "not included:" list
   * is redundant against the frame and dropped from the card; the export
   * summary keeps the worded version for a bank reading pasted plain text.
   * An empty class is an INVITATION, never a nag - no warning tone, no "missing",
   * since many classes (pension, mortgage) are legitimately empty forever. */
  function renderNetWorth(nwModel, nw) {
    const sec = el('section', { class: 'card', id: 'position-networth' });
    sec.append(
      el(
        'div',
        { class: 'card-head' },
        el('h3', { class: 'card-title' }, icon(iconStore()), 'Recorded net worth')
      )
    );
    sec.append(renderVM(nwModel.lead));
    if (nwModel.staleWarning) {
      sec.append(el('div', { class: 'vm-reconcile tone-watch' }, nwModel.staleWarning));
    }

    // Composition bar: what-you-own vs what-you-owe, so the net figure is SEEN,
    // not just read. Assets in the calm/green money-in family, debts in the warm
    // money-out family (renderShareBar's direction palette), matching the app's
    // money-direction colour language. Only renders when both sides are non-zero.
    const totA = Number(nw && nw.totalAssets) || 0;
    const totL = Number(nw && nw.totalLiabilities) || 0;
    if (totA > 0 && totL > 0) {
      const money = ctx.bankMoney || ctx.money0 || ((n) => String(n));
      // OWN vs OWE, two opposing quantities compared on ONE shared scale - the
      // same grammar as "Cash in and out" (green = holding, orange = obligation),
      // not a single stacked track (which read backwards: debt-first, assets as
      // "remainder"). Both bars scale against the larger value (assets), so the
      // green "own" bar is full and the orange "owe" bar is a genuinely short
      // proportion beside it - the shape of the net figure, seen at a glance.
      // Colours are the app's money-direction families (MONEY_IN / MONEY_OUT).
      const scale = Math.max(totA, totL) || 1;
      const OWN = '#3aa06c';   // MONEY_IN family
      const OWE = '#e5852f';   // MONEY_OUT family
      const bar = (label, amount, colour) => el('div', { class: 'ownowe-row' },
        el('span', { class: 'ownowe-label muted small' }, label),
        el('span', { class: 'ownowe-track' },
          el('span', { class: 'ownowe-fill', style: `width:${Math.max(2, (amount / scale) * 100)}%;background:${colour}` })),
        el('span', { class: 'ownowe-amt num small' }, money(amount)));
      sec.append(el('div', { class: 'ownowe', style: 'margin:8px 0 14px' },
        bar('Own', totA, OWN),
        bar('Owe', totL, OWE)));
    }

    // Coverage indicator: "covers N of M classes" shown as M small segments, N
    // filled - so how complete the net-worth picture is reads at a glance, not
    // just as the text tag on the lead. The named gaps stay in the lead's "Why"
    // and the export; this is only the at-a-glance completeness signal.
    const cov = nw && nw.coverage;
    if (cov && cov.of > 0) {
      const track = el('div', {
        class: 'nw-coverage',
        'aria-label': `Covers ${cov.covered} of ${cov.of} asset and debt classes`,
      });
      for (let i = 0; i < cov.of; i++) {
        track.append(
          el('span', {
            class: 'nw-cov-seg' + (i < cov.covered ? ' filled' : ''),
          })
        );
      }
      sec.append(
        el(
          'div',
          { class: 'nw-cov-row' },
          track,
          el('span', { class: 'muted small' }, `${cov.covered} of ${cov.of} classes recorded`)
        )
      );
    }

    const lines = nw && nw.lines ? nw.lines : [];
    const notIncluded = nwModel.notIncluded || { assets: [], liabilities: [] };

    // Opens "Add an asset or debt" below with the given class pre-selected
    // and scrolled into view - previously notIncluded was computed and
    // named correctly in the model but never actually rendered anywhere on
    // screen, so a person had no way to act on a gap without scrolling down
    // and finding the right option themselves.
    function openAddFor(kind, cls) {
      trackUsage('position-add-gap');
      const select = document.getElementById('position-add-class-select');
      if (select) {
        select.value = kind + ':' + cls;
        select.dispatchEvent(new Event('change'));
      }
      smoothScrollToEl('#position-add-disclosure');
    }
    const gapClasses = [
      ...notIncluded.assets.map((c) => ({ cls: c, kind: 'asset' })),
      ...notIncluded.liabilities.map((c) => ({ cls: c, kind: 'liability' })),
    ];
    if (gapClasses.length) {
      // Collapsed by default, matching "Add an asset or debt" directly below -
      // this list previously rendered as a permanently open, nine-row wall
      // regardless of how many classes were genuinely missing, which made
      // this the single heaviest block on the card even though the coverage
      // dots one line up already give the at-a-glance "how much is missing"
      // signal. An empty class is an invitation, never a nag (this card's own
      // frozen rule, above) - defaulting this open would push a warning-like
      // wall of "Add" rows in front of someone with little recorded yet,
      // exactly what that rule forbids. Each row's behaviour is unchanged:
      // still opens the real add form with that class pre-selected.
      const gapBox = el('details', { class: 'secondary' });
      gapBox.append(
        el('summary', {}, icon(iconInfo()), ' Not included or not confirmed')
      );
      const gapBody = el('div', { class: 'sec-section' });
      const gapList = el('div', { class: 'recurring-list' });
      for (const g of gapClasses) {
        gapList.append(
          el(
            'button',
            { class: 'recurring-row', onclick: () => openAddFor(g.kind, g.cls) },
            el('span', { class: 'recurring-name' }, g.cls),
            el('span', { class: 'recurring-amt muted small' }, 'Add')
          )
        );
      }
      gapBody.append(gapList);
      gapBox.append(gapBody);
      sec.append(gapBox);
    }


    // One line, filled only. Reconciled lines (cash, card, converted foreign)
    // carry their source; self-reported lines are dated, age visibly, and are
    // removable. Empty classes are NEVER pre-listed here - adding lives behind
    // the single collapsed disclosure below, so the card shows only what is
    // actually held.
    function renderFilledLine(l) {
      const cls = l.class;
      const isConverted = l.rate != null && l.nativeAmount != null;
      const label =
        (l.label && l.label !== cls ? l.label : cls) + (l.currency ? ` (${l.currency})` : '');
      // Silent default: a reconciled figure carries NO source text. Only real
      // departures speak - a self-reported figure's age (actionable), a stale
      // flag, or a stale rate. "from statements" / "converted" / "entered by
      // you" are plumbing and are gone from the row.
      const meta = [];
      if (l.source === 'reconciled') {
        if (l.rateStale) meta.push('rate may be out of date');
      } else {
        if (l.stale) meta.push('may be out of date');
        else if (l.lastReviewed) meta.push(l.lastReviewed);
      }
      const amtText = (isConverted ? '\u2248 ' : '') + formatLineAmount(l);
      const kids = [
        el('span', { class: 'recurring-name' }, label),
        meta.length
          ? el('span', { class: 'recurring-months muted small' }, meta.join(' \u00b7 '))
          : el('span', {}),
        el('span', { class: 'recurring-amt num strong' }, amtText),
      ];
      if (l.source === 'self-reported' && l.id) {
        kids.push(
          el(
            'button',
            {
              class: 'linkbtn',
              title: 'Remove',
              'aria-label': `Remove ${label}`,
              onclick: () => removeAsset(l.id),
            },
            'Remove'
          )
        );
      }
      const frag = el('div', {});
      frag.append(el('div', { class: 'recurring-row' + (l.stale ? ' lapsed' : '') }, ...kids));
      if (isConverted) {
        const nativeText =
          (l.currency === 'USD' ? 'US$' : l.currency + ' ') +
          Number(l.nativeAmount).toLocaleString(undefined, {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
          });
        const d = el('details', {
          class: 'vm-detail',
          style: 'margin:2px 0 8px',
        });
        d.append(
          el('summary', { class: 'muted small' }, 'Rate'),
          el(
            'div',
            { class: 'vm-detail-body muted small' },
            `${nativeText} \u00d7 ${l.rate}${l.rateAsOf ? ` \u00b7 ${l.rateAsOf}` : ''}`
          )
        );
        frag.append(d);
      }
      return frag;
    }

    const ownLines = lines.filter((l) => l.kind === 'asset');
    const oweLines = lines.filter((l) => l.kind === 'liability');

    if (ownLines.length) {
      sec.append(el('div', { class: 'sec-subhead' }, icon(iconInfo()), ' What you own'));
      const ownList = el('div', { class: 'recurring-list' });
      for (const l of ownLines) ownList.append(renderFilledLine(l));
      sec.append(ownList);
    }
    if (oweLines.length) {
      sec.append(el('div', { class: 'sec-subhead' }, icon(iconInfo()), ' What you owe'));
      const oweList = el('div', { class: 'recurring-list' });
      for (const l of oweLines) oweList.append(renderFilledLine(l));
      sec.append(oweList);
    }

    // The single, unobtrusive add mechanism - collapsed by default, so nothing
    // is prompted until the person chooses to add. Picking a class from the
    // "What you own / What you owe" groups pre-fills its kind and name, so the
    // person supplies only the amount (the frame's classification intelligence,
    // without the always-on empty rows).
    sec.append(renderAddDisclosure(notIncluded));
    return sec;
  }

  function renderAddDisclosure() {
    const box = el('details', { class: 'secondary', id: 'position-add-disclosure' });
    box.append(el('summary', {}, icon(iconInfo()), ' Add an asset or debt'));
    const body = el('div', { class: 'sec-section' });
    // Only classes not already fully represented are offered; a class can still
    // be re-added (a second property) since manual classes hold many entries.
    const assetClasses = NET_WORTH_CLASSES.assets.filter((c) => c !== 'Cash & bank');
    const liabilityClasses = NET_WORTH_CLASSES.liabilities.filter((c) => c !== 'Credit card');

    const classSel = el('select', {
      class: 'mini',
      id: 'position-add-class-select',
      'aria-label': 'What is it',
    });

    const ownGroup = el('optgroup', { label: 'What you own' });
    for (const c of assetClasses) ownGroup.append(el('option', { value: 'asset:' + c }, c));
    const oweGroup = el('optgroup', { label: 'What you owe' });
    for (const c of liabilityClasses) oweGroup.append(el('option', { value: 'liability:' + c }, c));
    classSel.append(ownGroup, oweGroup);

    const nameInput = el('input', {
      type: 'text',
      class: 'name-field',
      maxlength: '40',
      placeholder: 'Name (optional)',
      'aria-label': 'Name (optional)',
    });
    const amountInput = el('input', {
      type: 'number',
      class: 'name-field',
      min: '0',
      step: '1',
      inputmode: 'decimal',
      placeholder: 'Amount',
      'aria-label': 'Amount',
    });

    // "Other assets"/"Other debts" genuinely need a name; the standard classes
    // read fine named after themselves, so the name field only signals required
    // for the two catch-alls.
    const syncName = () => {
      const cls = classSel.value.split(':')[1] || '';
      const needsName = cls === 'Other assets' || cls === 'Other debts';
      nameInput.placeholder = needsName ? 'Name (e.g. what it is)' : 'Name (optional)';
    };
    classSel.addEventListener('change', syncName);
    syncName();

    const save = async () => {
      const [kind, cls] = classSel.value.split(':');
      const amount = Number(amountInput.value);
      if (!(amount > 0)) {
        toast('Enter an amount first.');
        return;
      }
      const rec = makeManualAsset({
        class: cls,
        label: (nameInput.value || '').trim() || cls,
        amount,
        kind,
      });
      await Store.manualAssets.put(rec);
      state.manualAssets = await Store.manualAssets.all();
      trackUsage('position-add-asset');
      render();
      toast(`Added ${rec.label}.`);
    };
    amountInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        save();
      }
    });

    body.append(
      el(
        'div',
        { class: 'manage-actions', style: 'flex-wrap:wrap;gap:8px' },
        classSel,
        nameInput,
        amountInput,
        el('button', { class: 'btn sm', onclick: save }, 'Add')
      )
    );
    box.append(body);
    return box;
  }

  async function removeAsset(id) {
    if (!id) return;
    await Store.manualAssets.delete(id);
    state.manualAssets = await Store.manualAssets.all();
    trackUsage('position-remove-asset');
    render();
    toast('Removed.');
  }

  function formatLineAmount(l) {
    // The model already rounds; show the money via the app's formatter if we
    // have a raw amount, else fall back to a plain figure. Liabilities carry a
    // leading minus so the sign is unmistakable.
    const money = ctx.bankMoney || ctx.money0 || ((n) => String(n));
    const v = Number(l.amount) || 0;
    return (l.kind === 'liability' ? '-' : '') + money(Math.abs(v));
  }

  /* ---- financial-position summary: the lean on-screen PREVIEW of what gets
   * copied. This card is interface, not the export - so it obeys the provenance
   * rule at the top of this file: label + amount only, NO per-row source/period
   * column (that was the cramped "reconciled from statements · as of ..." mess),
   * and NO boxed coverage wall (the named gaps live in the net-worth card's
   * "Why" above, and in the copied text below). It reads SECONDARY to the two
   * authoritative cards above it - a "here is the bundle you'll hand a bank,
   * ready to copy" footer. copySummary keeps EVERYTHING (per-row sources, the
   * coverage note, the fuller exportDisclaimer): the screen is a lean view of
   * the data, the clipboard the complete one. Same data, two fidelities. */
  function renderSummary(summary) {
    const sec = el('section', { class: 'card' });
    sec.append(
      el(
        'div',
        { class: 'card-head' },
        el('h3', { class: 'card-title' }, icon(iconList()), 'For a financial conversation')
      )
    );

    const money = ctx.bankMoney || ctx.money0 || ((n) => String(n));
    const list = el('div', { class: 'recurring-list summary-rows' });
    for (const r of summary.rows) {
      list.append(
        el(
          'div',
          { class: 'recurring-row' },
          el('span', { class: 'recurring-name' }, r.label),
          el(
            'span',
            { class: 'recurring-amt num strong' },
            typeof r.value === 'number' && /%$/.test(r.label)
              ? String(r.value) + '%'
              : money(r.value)
          )
        )
      );
    }
    sec.append(list);

    sec.append(el('p', { class: 'muted small' }, summary.disclaimer));
    sec.append(
      el(
        'div',
        { class: 'manage-actions' },
        el(
          'button',
          {
            class: 'btn sm',
            onclick: () => {
              copySummary(summary, money);
              trackUsage('position-copy-summary');
            },
          },
          'Copy summary'
        )
      )
    );
    return sec;
  }
  function copySummary(summary, money) {
    // The clipboard artifact keeps FULL provenance the screen dropped: per-row
    // source + period, the named-gaps coverage note, and the fuller disclaimer
    // - a banker reading pasted text has no dropdown and needs the words.
    const lines = [summary.title, `Prepared ${summary.generatedFor} (${summary.currency})`, ''];
    for (const r of summary.rows) {
      const val = /%$/.test(r.label) ? String(r.value) + '%' : money(r.value);
      lines.push(`${r.label}: ${val}  [${r.source}, ${r.period}]`);
    }
    if (summary.coverageNote) {
      lines.push('');
      lines.push(summary.coverageNote);
    }
    lines.push('');
    lines.push(summary.exportDisclaimer || summary.disclaimer);
    const text = lines.join('\n');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        () => toast('Summary copied.'),
        () => toast('Could not copy - select and copy manually.')
      );
    } else {
      toast('Copy not available on this device.');
    }
  }

  /* ---- the destination ---- */
  function renderPosition() {
    trackUsage('view-position');
    const wrap = el('div', { class: 'accounts-wrap accounts-grid' });
    // No bank data -> nothing reconciled to stand on. A card-only device still
    // has a card balance, so guard on there being ANY position to show.
    const hasBank = (state.bankRecords || []).length > 0;
    const hasCard = (state._cardStatements || []).length > 0;
    if (!hasBank && !hasCard) {
      const empty = el(
        'section',
        { class: 'card empty' },
        el('h2', {}, 'No position yet'),
        el(
          'p',
          { class: 'muted' },
          'Import a bank or card statement and your cash, debt and net-worth picture appears here.'
        )
      );
      wrap.append(empty);
      return wrap;
    }
    const m = provenModels.positionModels();
    wrap.append(renderCashDebt(m.cashDebtModel, m.cashDebt));
    wrap.append(renderNetWorth(m.netWorthModel, m.netWorth));
    wrap.append(renderSummary(m.summary));
    return wrap;
  }

  return { renderPosition };
}
