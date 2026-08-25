/* ===========================================================================
 * 10b) Printable report renderer  (dedicated print / PDF path)
 * ---------------------------------------------------------------------------
 * Builds a clean, shareable finance report as REAL DOM / SVG elements, wholly
 * separate from the interactive dashboard. Every dynamic value (merchant name,
 * category, amount, insight sentence) is inserted as text, so the browser
 * escapes it automatically - a name like "Ben & Jerry's" or "R&D" can never
 * emit a stray tag. The only markup is the small, hand-written section icons,
 * and those are built with createElementNS as genuine SVG nodes. Nothing here
 * ever concatenates icon or chart markup into a string that becomes text, so
 * the raw-markup bug (literal <svg…> printing on the page) cannot recur.
 *
 * Pure and DOM-standard: it takes a `document` and a plain data model and
 * returns the report root element, so it runs in the browser and can be
 * exercised in a lightweight test DOM.
 * ======================================================================== */

const REPORT_ICON_SHAPES = {
  cal: [
    ['rect', { x: 3, y: 4.5, width: 18, height: 16, rx: 2 }],
    ['path', { d: 'M3 9h18M8 2.5v4M16 2.5v4' }],
  ],
  card: [
    ['rect', { x: 2.5, y: 5, width: 19, height: 14, rx: 2.5 }],
    ['path', { d: 'M2.5 9.5h19' }],
  ],
  sum: [['path', { d: 'M5 4h14M5 4l7 8-7 8h14' }]],
  chart: [['path', { d: 'M4 20V6M10 20V4M16 20v-8M22 20H2' }]],
  pie: [
    ['path', { d: 'M12 3v9h9a9 9 0 1 0-9 9' }],
    ['path', { d: 'M21 12a9 9 0 0 0-9-9' }],
  ],
  store: [['path', { d: 'M4 9h16M5 9l-1-4h16l-1 4M5 9v11h14V9' }]],
  bulb: [
    [
      'path',
      {
        d: 'M9 18h6M10 21h4M12 3a6 6 0 0 0-3 11c.6.4 1 1 1 2h4c0-1 .4-1.6 1-2a6 6 0 0 0-3-11z',
      },
    ],
  ],
  list: [['path', { d: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01' }]],
};

function rpSvg(doc, tag, attrs = {}, kids = []) {
  const n = doc.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, String(v));
  for (const kid of kids) if (kid != null) n.appendChild(kid);
  return n;
}

/* A section-heading icon as a real SVG element (never a string). */
export function reportIconEl(doc, name, size = 17) {
  const shapes = REPORT_ICON_SHAPES[name] || REPORT_ICON_SHAPES.list;
  const kids = shapes.map(([t, a]) => rpSvg(doc, t, a));
  return rpSvg(
    doc,
    'svg',
    {
      viewBox: '0 0 24 24',
      width: size,
      height: size,
      fill: 'none',
      stroke: 'currentColor',
      'stroke-width': 1.7,
      'stroke-linecap': 'round',
      'stroke-linejoin': 'round',
      class: 'rp-ic',
    },
    kids
  );
}

/* Small HTML element helper for the report. String children become text nodes,
 * which the DOM escapes - this is what makes stray markup impossible. */
function rp(doc, tag, attrs = {}, ...kids) {
  const n = doc.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    if (k === 'class') n.setAttribute('class', v);
    else n.setAttribute(k, String(v));
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    n.appendChild(kid.nodeType ? kid : doc.createTextNode(String(kid)));
  }
  return n;
}

/* A coloured category chip: colour swatch paired with its text label so it
 * stays distinguishable in black-and-white printing (colour is never the only
 * signal). */
function rpSwatch(doc, colour, label, extraClass) {
  return rp(
    doc,
    'span',
    { class: 'rp-swatch-wrap' + (extraClass ? ' ' + extraClass : '') },
    rp(doc, 'span', { class: 'rp-swatch', style: `background:${colour}` }),
    rp(doc, 'span', { class: 'rp-swatch-label' }, label)
  );
}

/* Static spending-over-time chart, drawn as an SVG bar chart with a labelled
 * axis, per-bar period labels, and the historical average as a dashed
 * reference line. No tooltips - the figures are printed beside the chart. */
function rpTrendChart(doc, trend) {
  const bars = trend.bars || [];
  const W = 760,
    H = 250;
  const padL = 54,
    padR = 18,
    padT = 22,
    padB = 46;
  const plotW = W - padL - padR;
  const plotH = H - padT - padB;
  const values = bars.map((b) => b.value);
  const maxRaw = Math.max(...values, trend.avg || 0, 1);
  const max = maxRaw * 1.12;
  const yOf = (v) => padT + plotH - (v / max) * plotH;
  const n = bars.length || 1;
  const slot = plotW / n;
  const barW = Math.min(46, Math.max(8, slot * 0.55));

  const pal = trend.palette || {};
  const cHatchFill = pal.hatchFill || '#c9d3df';
  const cHatchLine = pal.hatchLine || '#8b98a8';
  const cGrid = pal.grid || '#e6eaf0';
  const cAvg = pal.avg || '#8a94a6';
  const cBar = pal.bar || '#1f6feb';
  const cBarMuted = pal.barMuted || '#9aa7b8';
  const cBarStroke = pal.barStroke || '#12539c';
  const cBaseline = pal.baseline || '#c2ccd8';

  const kids = [];

  const defs = rpSvg(doc, 'defs', {}, [
    rpSvg(
      doc,
      'pattern',
      {
        id: 'rp-hatch',
        width: 5,
        height: 5,
        patternUnits: 'userSpaceOnUse',
        patternTransform: 'rotate(45)',
      },
      [
        rpSvg(doc, 'rect', { width: 5, height: 5, fill: cHatchFill }),
        rpSvg(doc, 'line', {
          x1: 0,
          y1: 0,
          x2: 0,
          y2: 5,
          stroke: cHatchLine,
          'stroke-width': 2,
        }),
      ]
    ),
  ]);
  kids.push(defs);

  const short = trend.moneyShort || ((v) => String(Math.round(v)));
  [0, max / 2, max].forEach((gv) => {
    const y = yOf(gv);
    kids.push(
      rpSvg(doc, 'line', {
        x1: padL,
        y1: y,
        x2: W - padR,
        y2: y,
        stroke: cGrid,
        'stroke-width': 1,
      })
    );
    kids.push(
      rpSvg(doc, 'text', { x: padL - 8, y: y + 3.5, 'text-anchor': 'end', class: 'rp-axis' }, [
        doc.createTextNode(short(gv)),
      ])
    );
  });

  if (trend.avg > 0) {
    const ay = yOf(trend.avg);
    kids.push(
      rpSvg(doc, 'line', {
        x1: padL,
        y1: ay,
        x2: W - padR,
        y2: ay,
        stroke: cAvg,
        'stroke-width': 1.4,
        'stroke-dasharray': '5 4',
      })
    );
    kids.push(
      rpSvg(doc, 'text', { x: W - padR, y: ay - 5, 'text-anchor': 'end', class: 'rp-axis-avg' }, [
        doc.createTextNode(`avg ${trend.avgLabel || ''}`),
      ])
    );
  }

  bars.forEach((b, i) => {
    const cx = padL + slot * i + slot / 2;
    const x = cx - barW / 2;
    const y = yOf(b.value);
    const h = Math.max(1, padT + plotH - y);
    const fill = b.incomplete ? 'url(#rp-hatch)' : b.inPeriod ? cBar : cBarMuted;
    kids.push(
      rpSvg(doc, 'rect', {
        x,
        y,
        width: barW,
        height: h,
        rx: 2.5,
        fill,
        stroke: b.inPeriod ? cBarStroke : 'none',
        'stroke-width': b.inPeriod ? 1 : 0,
      })
    );
    kids.push(
      rpSvg(doc, 'text', { x: cx, y: H - padB + 16, 'text-anchor': 'middle', class: 'rp-axis' }, [
        doc.createTextNode(b.label),
      ])
    );
  });

  kids.push(
    rpSvg(doc, 'line', {
      x1: padL,
      y1: yOf(0),
      x2: W - padR,
      y2: yOf(0),
      stroke: cBaseline,
      'stroke-width': 1.2,
    })
  );

  return rpSvg(
    doc,
    'svg',
    {
      viewBox: `0 0 ${W} ${H}`,
      class: 'rp-chart',
      preserveAspectRatio: 'xMidYMid meet',
      role: 'img',
    },
    kids
  );
}

export function renderReport(doc, model) {
  const root = rp(doc, 'div', { class: 'rp' });
  const heading = (iconName, text) =>
    rp(doc, 'h2', { class: 'rp-h' }, reportIconEl(doc, iconName, 18), rp(doc, 'span', {}, text));

  /* 1) Header */
  const header = rp(
    doc,
    'header',
    { class: 'rp-header' },
    rp(
      doc,
      'div',
      { class: 'rp-brand' },
      reportIconEl(doc, 'card', 22),
      rp(doc, 'span', { class: 'rp-brand-name' }, model.app)
    ),
    rp(doc, 'h1', { class: 'rp-title' }, 'Spending report'),
    rp(
      doc,
      'div',
      { class: 'rp-meta' },
      rp(doc, 'span', { class: 'rp-meta-period' }, `Period: ${model.period}`),
      rp(doc, 'span', { class: 'rp-dot' }, '·'),
      rp(doc, 'span', {}, `Generated ${model.generated}`),
      rp(doc, 'span', { class: 'rp-dot' }, '·'),
      rp(doc, 'span', {}, `Amounts in ${model.currencyCode}`)
    ),
    rp(doc, 'div', { class: 'rp-privacy' }, model.privacy)
  );
  root.appendChild(header);
  // Screen-only guidance: the saved PDF loses background fills unless the
  // browser's "Background graphics" print option is on. Hidden in print via
  // @media print { .rp-print-hint { display: none } }.
  root.appendChild(
    rp(
      doc,
      'p',
      { class: 'rp-print-hint' },
      'Tip: enable "Background graphics" in the print dialog to include full colour.'
    )
  );

  /* 2) Key summary */
  const s = model.summary;
  const grid = rp(doc, 'div', { class: 'rp-summary' });
  const block = (label, value, sub, opts = {}) => {
    const b = rp(
      doc,
      'div',
      { class: 'rp-sum' + (opts.lead ? ' rp-sum-lead' : '') },
      rp(doc, 'div', { class: 'rp-sum-label' }, label),
      rp(
        doc,
        'div',
        { class: 'rp-sum-value' },
        opts.swatch
          ? rp(
              doc,
              'span',
              { class: 'rp-inline-cat' },
              rp(doc, 'span', {
                class: 'rp-swatch',
                style: `background:${opts.swatch}`,
              }),
              value
            )
          : value
      )
    );
    if (sub)
      b.appendChild(
        rp(doc, 'div', { class: 'rp-sum-sub' + (opts.tone ? ' tone-' + opts.tone : '') }, sub)
      );
    return b;
  };
  grid.appendChild(
    block(
      'Total spend',
      s.totalSpend,
      s.vsPrev ? `${s.vsPrev.text} (was ${s.vsPrev.prevMoney})` : 'No comparable period yet',
      { lead: true, tone: s.vsPrev ? s.vsPrev.dir : null }
    )
  );
  grid.appendChild(block('Purchases', s.nPurchases, s.vsAvg || null));
  grid.appendChild(
    s.leading
      ? block('Leading category', s.leading.label, `${s.leading.share} of spend`, {
          swatch: s.leading.colour,
        })
      : block('Leading category', '-', null)
  );
  grid.appendChild(
    block(
      'Paid to card',
      s.paidToCard,
      [s.fees ? `${s.fees} fees & tax` : null, s.refunds ? `${s.refunds} refunds` : null]
        .filter(Boolean)
        .join(' · ') || null
    )
  );
  root.appendChild(rp(doc, 'section', { class: 'rp-block' }, heading('sum', 'Key summary'), grid));

  /* 3) Spending over time */
  const trendSec = rp(
    doc,
    'section',
    { class: 'rp-block rp-avoid' },
    heading('chart', 'Spending over time')
  );
  if (model.trend.bars.length) {
    trendSec.appendChild(
      rp(doc, 'div', { class: 'rp-chart-wrap' }, rpTrendChart(doc, model.trend))
    );
    const note = model.trend.avgMoney
      ? `Monthly purchases only. The dashed line is your typical month of ${model.trend.avgMoney}. Hatched bars are part-month statements.`
      : 'Monthly purchases only. Hatched bars are part-month statements.';
    trendSec.appendChild(rp(doc, 'p', { class: 'rp-note' }, note));
    // small adjoining figures table
    const tbl = rp(doc, 'table', { class: 'rp-mini' });
    tbl.appendChild(
      rp(
        doc,
        'thead',
        {},
        rp(doc, 'tr', {}, rp(doc, 'th', {}, 'Month'), rp(doc, 'th', { class: 'num' }, 'Purchases'))
      )
    );
    const tb = rp(doc, 'tbody');
    for (const b of model.trend.bars) {
      tb.appendChild(
        rp(
          doc,
          'tr',
          { class: b.inPeriod ? 'rp-inperiod' : null },
          rp(doc, 'td', {}, b.label + (b.incomplete ? ' (part month)' : '')),
          rp(doc, 'td', { class: 'num' }, b.money)
        )
      );
    }
    tbl.appendChild(tb);
    trendSec.appendChild(tbl);
  } else {
    trendSec.appendChild(
      rp(doc, 'p', { class: 'rp-empty' }, 'No monthly spending to chart for this period.')
    );
  }
  root.appendChild(trendSec);

  /* 4) Spending by category */
  const catSec = rp(doc, 'section', { class: 'rp-block' }, heading('pie', 'Spending by category'));
  if (model.categories.length) {
    const list = rp(doc, 'div', { class: 'rp-cats' });
    const top = model.categories.filter((c) => !c.review);
    const maxAmt = top.length ? Math.max(...top.map((c) => c.shareNum)) : 1;
    for (const c of model.categories) {
      const row = rp(
        doc,
        'div',
        { class: 'rp-cat rp-avoid' + (c.review ? ' rp-cat-review' : '') },
        rp(
          doc,
          'div',
          { class: 'rp-cat-name' },
          rp(doc, 'span', {
            class: 'rp-swatch',
            style: `background:${c.colour}`,
          }),
          rp(doc, 'span', {}, c.name)
        ),
        rp(
          doc,
          'div',
          { class: 'rp-cat-bar' },
          rp(doc, 'span', {
            class: 'rp-cat-fill',
            style: `width:${Math.max(2, (c.shareNum / (maxAmt || 1)) * 100)}%;background:${c.colour}`,
          })
        ),
        rp(doc, 'div', { class: 'rp-cat-amt num' }, c.amount),
        rp(doc, 'div', { class: 'rp-cat-pct num' }, c.share)
      );
      list.appendChild(row);
    }
    catSec.appendChild(list);
    if (model.categories.some((c) => c.review)) {
      catSec.appendChild(
        rp(
          doc,
          'p',
          { class: 'rp-note' },
          '“To review” groups purchases not yet matched to a category and is shown separately from settled spending.'
        )
      );
    }
  } else {
    catSec.appendChild(rp(doc, 'p', { class: 'rp-empty' }, 'No purchases in this period.'));
  }
  root.appendChild(catSec);

  /* 5) Merchant insights */
  const merchSec = rp(doc, 'section', { class: 'rp-block' }, heading('store', 'Merchant insights'));
  if (model.merchants.length) {
    const t = rp(doc, 'table', { class: 'rp-table' });
    t.appendChild(
      rp(
        doc,
        'thead',
        {},
        rp(
          doc,
          'tr',
          {},
          rp(doc, 'th', {}, 'Merchant'),
          rp(doc, 'th', {}, 'Category'),
          rp(doc, 'th', { class: 'num' }, 'Txns'),
          rp(doc, 'th', { class: 'num' }, 'Total'),
          rp(doc, 'th', { class: 'num' }, 'Average')
        )
      )
    );
    const tb = rp(doc, 'tbody');
    for (const m of model.merchants) {
      tb.appendChild(
        rp(
          doc,
          'tr',
          { class: 'rp-avoid' },
          rp(doc, 'td', { class: 'rp-wrap' }, m.name),
          rp(doc, 'td', { class: 'rp-wrap' }, rpSwatch(doc, m.colour, m.category)),
          rp(doc, 'td', { class: 'num' }, m.count),
          rp(doc, 'td', { class: 'num strong' }, m.amount),
          rp(doc, 'td', { class: 'num' }, m.avg)
        )
      );
    }
    t.appendChild(tb);
    merchSec.appendChild(rp(doc, 'div', { class: 'rp-table-wrap' }, t));
  } else {
    merchSec.appendChild(
      rp(doc, 'p', { class: 'rp-empty' }, 'No merchants to show for this period.')
    );
  }
  root.appendChild(merchSec);

  /* 6) Notable patterns */
  const insSec = rp(
    doc,
    'section',
    { class: 'rp-block rp-avoid' },
    heading('bulb', 'Notable patterns')
  );
  const items = (model.insights || []).slice();
  if (model.reviewNote) items.push(model.reviewNote);
  if (items.length) {
    const ul = rp(doc, 'ul', { class: 'rp-insights' });
    for (const line of items) ul.appendChild(rp(doc, 'li', {}, line));
    insSec.appendChild(ul);
  } else {
    insSec.appendChild(
      rp(
        doc,
        'p',
        { class: 'rp-empty' },
        `A calm ${String(model.period).toLowerCase()} - nothing stands out against the usual pattern.`
      )
    );
  }
  root.appendChild(insSec);

  /* 7) Transaction detail */
  const txSec = rp(doc, 'section', { class: 'rp-block' }, heading('list', 'Transaction detail'));
  txSec.appendChild(rp(doc, 'p', { class: 'rp-scope' }, model.filtersText));
  if (model.txns.length) {
    const t = rp(doc, 'table', { class: 'rp-table rp-tx' });
    t.appendChild(
      rp(
        doc,
        'thead',
        {},
        rp(
          doc,
          'tr',
          {},
          rp(doc, 'th', { class: 'nowrap' }, 'Date'),
          rp(doc, 'th', {}, 'Merchant'),
          rp(doc, 'th', {}, 'Category'),
          rp(doc, 'th', {}, 'Type'),
          rp(doc, 'th', { class: 'num' }, `Amount (${model.currencyCode})`)
        )
      )
    );
    const tb = rp(doc, 'tbody');
    for (const r of model.txns) {
      tb.appendChild(
        rp(
          doc,
          'tr',
          {},
          rp(doc, 'td', { class: 'nowrap' }, r.date),
          rp(
            doc,
            'td',
            { class: 'rp-wrap' },
            rp(doc, 'div', {}, r.description),
            r.foreign ? rp(doc, 'div', { class: 'rp-fx' }, r.foreign) : null
          ),
          rp(doc, 'td', { class: 'rp-wrap' }, rpSwatch(doc, r.colour, r.category)),
          rp(doc, 'td', {}, r.kind),
          rp(doc, 'td', { class: 'num' + (r.credit ? ' rp-credit' : '') }, r.amount)
        )
      );
    }
    t.appendChild(tb);
    txSec.appendChild(rp(doc, 'div', { class: 'rp-table-wrap' }, t));
    txSec.appendChild(rp(doc, 'p', { class: 'rp-note' }, model.txCountText));
  } else {
    txSec.appendChild(
      rp(doc, 'p', { class: 'rp-empty' }, 'No transactions match the active view.')
    );
  }
  root.appendChild(txSec);

  /* 8) Footer (repeats each page via fixed positioning) */
  root.appendChild(
    rp(
      doc,
      'footer',
      { class: 'rp-footer' },
      rp(doc, 'span', {}, `${model.app} - private report`),
      rp(doc, 'span', {}, 'Data stays on this device.')
    )
  );

  return root;
}

/* Printable report for the bank Accounts ledger (Phase 1 parity). A dedicated
 * renderer beside renderReport, because a bank report needs its own sections
 * and labels - balances, Cash inflow/out, per-account breakdown, reconciliation
 * and a running-balance transaction table - not spending categories. It reuses
 * every .rp-* print style, so it prints light-on-white, paginates, and repeats
 * table headers exactly like the card report. Same DOM-standard, escape-safe
 * construction: every dynamic value is inserted as text, never markup. */
export function renderBankReport(doc, model) {
  const root = rp(doc, 'div', { class: 'rp' });
  const heading = (iconName, text) =>
    rp(doc, 'h2', { class: 'rp-h' }, reportIconEl(doc, iconName, 18), rp(doc, 'span', {}, text));

  /* 1) Header */
  root.appendChild(
    rp(
      doc,
      'header',
      { class: 'rp-header' },
      rp(
        doc,
        'div',
        { class: 'rp-brand' },
        reportIconEl(doc, 'card', 22),
        rp(doc, 'span', { class: 'rp-brand-name' }, model.app)
      ),
      rp(doc, 'h1', { class: 'rp-title' }, 'Account activity report'),
      rp(
        doc,
        'div',
        { class: 'rp-meta' },
        rp(doc, 'span', { class: 'rp-meta-period' }, `Scope: ${model.scope}`),
        rp(doc, 'span', { class: 'rp-dot' }, '\u00b7'),
        rp(doc, 'span', {}, `Generated ${model.generated}`),
        rp(doc, 'span', { class: 'rp-dot' }, '\u00b7'),
        rp(doc, 'span', {}, `Amounts in ${model.currencyCode}`)
      ),
      rp(doc, 'div', { class: 'rp-privacy' }, model.privacy)
    )
  );
  // Screen-only guidance: the saved PDF loses background fills unless the
  // browser's "Background graphics" print option is on. Hidden in print.
  root.appendChild(
    rp(
      doc,
      'p',
      { class: 'rp-print-hint' },
      'Tip: enable "Background graphics" in the print dialog to include full colour.'
    )
  );

  /* 2) Key summary */
  const s = model.summary;
  const grid = rp(doc, 'div', { class: 'rp-summary' });
  const block = (label, value, sub, lead) => {
    const b = rp(
      doc,
      'div',
      { class: 'rp-sum' + (lead ? ' rp-sum-lead' : '') },
      rp(doc, 'div', { class: 'rp-sum-label' }, label),
      rp(doc, 'div', { class: 'rp-sum-value' }, value)
    );
    if (sub) b.appendChild(rp(doc, 'div', { class: 'rp-sum-sub' }, sub));
    return b;
  };
  grid.appendChild(block(s.closingLabel, s.closingBalance, s.accountsSub, true));
  grid.appendChild(
    block('Cash inflow', s.moneyIn, 'Excludes transfers and other amounts shown in the notes below')
  );
  grid.appendChild(
    block(
      'Cash outflow',
      s.moneyOut,
      'Excludes transfers and other amounts shown in the notes below'
    )
  );
  grid.appendChild(block('Net movement', s.net, s.internalNote));
  root.appendChild(
    rp(doc, 'section', { class: 'rp-block' }, heading('sum', 'Account summary'), grid)
  );

  const notes = [model.usdNote, ...(model.adjustmentNotes || [])].filter(Boolean);

  for (const note of notes) {
    root.appendChild(rp(doc, 'p', { class: 'rp-note' }, note));
  }

  /* 3) Per-account breakdown (only when more than one account) */
  if (model.accounts && model.accounts.length > 1) {
    const t = rp(doc, 'table', { class: 'rp-table' });
    t.appendChild(
      rp(
        doc,
        'thead',
        {},
        rp(
          doc,
          'tr',
          {},
          rp(doc, 'th', {}, 'Account'),
          rp(doc, 'th', { class: 'num' }, 'Transactions'),
          rp(doc, 'th', { class: 'num' }, 'Cash inflow'),
          rp(doc, 'th', { class: 'num' }, 'Cash outflow'),
          rp(doc, 'th', { class: 'num' }, 'Closing balance')
        )
      )
    );
    const tb = rp(doc, 'tbody');
    for (const ac of model.accounts) {
      tb.appendChild(
        rp(
          doc,
          'tr',
          { class: 'rp-avoid' },
          rp(doc, 'td', {}, ac.account),
          rp(doc, 'td', { class: 'num' }, ac.count),
          rp(doc, 'td', { class: 'num' }, ac.moneyIn),
          rp(doc, 'td', { class: 'num' }, ac.moneyOut),
          rp(doc, 'td', { class: 'num strong' }, ac.closingBalance)
        )
      );
    }
    t.appendChild(tb);
    root.appendChild(
      rp(
        doc,
        'section',
        { class: 'rp-block' },
        heading('pie', 'By account'),
        rp(doc, 'div', { class: 'rp-table-wrap' }, t)
      )
    );
  }

  /* 4) Reconciliation - the trust line, per imported statement */
  const recSec = rp(doc, 'section', { class: 'rp-block' }, heading('sum', 'Reconciliation'));
  if (model.statements && model.statements.length) {
    const t = rp(doc, 'table', { class: 'rp-table' });
    t.appendChild(
      rp(
        doc,
        'thead',
        {},
        rp(
          doc,
          'tr',
          {},
          rp(doc, 'th', {}, 'Account'),
          rp(doc, 'th', {}, 'Period'),
          rp(doc, 'th', { class: 'num' }, 'Transactions'),
          rp(doc, 'th', { class: 'num' }, 'Closing balance'),
          rp(doc, 'th', {}, 'Result')
        )
      )
    );
    const tb = rp(doc, 'tbody');
    for (const st of model.statements) {
      tb.appendChild(
        rp(
          doc,
          'tr',
          { class: 'rp-avoid' },
          rp(doc, 'td', {}, st.account),
          rp(doc, 'td', { class: 'rp-wrap' }, st.period),
          rp(doc, 'td', { class: 'num' }, st.count),
          rp(doc, 'td', { class: 'num' }, st.closingBalance),
          rp(doc, 'td', {}, st.reconciled ? '\u2713 balance reconciles' : st.reconNote)
        )
      );
    }
    t.appendChild(tb);
    recSec.appendChild(rp(doc, 'div', { class: 'rp-table-wrap' }, t));
    if (model.reconNote) recSec.appendChild(rp(doc, 'p', { class: 'rp-note' }, model.reconNote));
  } else {
    recSec.appendChild(rp(doc, 'p', { class: 'rp-empty' }, 'No imported statements to reconcile.'));
  }
  root.appendChild(recSec);

  /* 5) Transaction detail with the running balance */
  const txSec = rp(doc, 'section', { class: 'rp-block' }, heading('list', 'Transaction detail'));
  txSec.appendChild(rp(doc, 'p', { class: 'rp-scope' }, model.filtersText));
  if (model.txns.length) {
    const t = rp(doc, 'table', { class: 'rp-table rp-tx' });
    t.appendChild(
      rp(
        doc,
        'thead',
        {},
        rp(
          doc,
          'tr',
          {},
          rp(doc, 'th', { class: 'nowrap' }, 'Date'),
          rp(doc, 'th', {}, 'Account'),
          rp(doc, 'th', {}, 'Counterparty'),
          rp(doc, 'th', {}, 'Flow'),
          rp(doc, 'th', { class: 'num' }, `Amount (${model.currencyCode})`),
          rp(doc, 'th', { class: 'num' }, 'Balance')
        )
      )
    );
    const tb = rp(doc, 'tbody');
    for (const r of model.txns) {
      tb.appendChild(
        rp(
          doc,
          'tr',
          {},
          rp(doc, 'td', { class: 'nowrap' }, r.date),
          rp(doc, 'td', { class: 'nowrap' }, r.account),
          rp(doc, 'td', { class: 'rp-wrap' }, r.description),
          rp(doc, 'td', {}, r.flow),
          rp(doc, 'td', { class: 'num' + (r.credit ? ' rp-credit' : '') }, r.amount),
          rp(doc, 'td', { class: 'num' }, r.balance)
        )
      );
    }
    t.appendChild(tb);
    txSec.appendChild(rp(doc, 'div', { class: 'rp-table-wrap' }, t));
    txSec.appendChild(rp(doc, 'p', { class: 'rp-note' }, model.txCountText));
  } else {
    txSec.appendChild(rp(doc, 'p', { class: 'rp-empty' }, 'No account transactions to show.'));
  }
  root.appendChild(txSec);

  /* 6) Footer (repeats each page via fixed positioning) */
  root.appendChild(
    rp(
      doc,
      'footer',
      { class: 'rp-footer' },
      rp(doc, 'span', {}, `${model.app} - private report`),
      rp(doc, 'span', {}, 'Data stays on this device.')
    )
  );

  return root;
}

/* Printable report for the combined Overview (Phase 3 roll-up). A dedicated
 * renderer beside renderReport and renderBankReport so printing from the
 * Overview tab yields an OVERVIEW report - net cash flow, income, external
 * spending, the two balances shown side by side, an income/spending trend and
 * the genuine external outflows - rather than the Accounts activity report the
 * Overview tab used to fall through to (the mismatch this fixes). It reuses
 * every .rp-* print style and the same escape-safe, text-only construction:
 * every dynamic value is inserted as text, never markup. All roll-up figures
 * are base-currency (USD accounts are surfaced on their own elsewhere and are
 * not blended into these headline numbers), so this pass introduces no new
 * currency handling. */
export function renderOverviewReport(doc, model) {
  const root = rp(doc, 'div', { class: 'rp' });
  const heading = (iconName, text) =>
    rp(doc, 'h2', { class: 'rp-h' }, reportIconEl(doc, iconName, 18), rp(doc, 'span', {}, text));

  /* 1) Header */
  root.appendChild(
    rp(
      doc,
      'header',
      { class: 'rp-header' },
      rp(
        doc,
        'div',
        { class: 'rp-brand' },
        reportIconEl(doc, 'card', 22),
        rp(doc, 'span', { class: 'rp-brand-name' }, model.app)
      ),
      rp(doc, 'h1', { class: 'rp-title' }, 'Overview report'),
      rp(
        doc,
        'div',
        { class: 'rp-meta' },
        rp(doc, 'span', { class: 'rp-meta-period' }, `Period: ${model.period}`),
        rp(doc, 'span', { class: 'rp-dot' }, '\u00b7'),
        rp(doc, 'span', {}, `Generated ${model.generated}`),
        rp(doc, 'span', { class: 'rp-dot' }, '\u00b7'),
        rp(doc, 'span', {}, `Amounts in ${model.currencyCode}`)
      ),
      rp(doc, 'div', { class: 'rp-privacy' }, model.privacy)
    )
  );
  // Screen-only guidance: the saved PDF loses background fills unless the
  // browser's "Background graphics" print option is on. Hidden in print.
  root.appendChild(
    rp(
      doc,
      'p',
      { class: 'rp-print-hint' },
      'Tip: enable "Background graphics" in the print dialog to include full colour.'
    )
  );

  /* 2) Money at a glance */
  const s = model.summary;
  const grid = rp(doc, 'div', { class: 'rp-summary' });
  const block = (label, value, sub, lead) => {
    const b = rp(
      doc,
      'div',
      { class: 'rp-sum' + (lead ? ' rp-sum-lead' : '') },
      rp(doc, 'div', { class: 'rp-sum-label' }, label),
      rp(doc, 'div', { class: 'rp-sum-value' }, value)
    );
    if (sub) b.appendChild(rp(doc, 'div', { class: 'rp-sum-sub' }, sub));
    return b;
  };
  grid.appendChild(block('Net cash flow', s.netCashFlow, s.netSub, true));
  grid.appendChild(
    block('Cash inflow', s.moneyIn, 'External income; transfers between your own accounts excluded')
  );
  grid.appendChild(block('Cash outflow', s.moneyOut, s.moneyOutSub));
  grid.appendChild(block('Cash on hand', s.cashOnHand, model.hasCard ? s.cardOwedSub : null));
  root.appendChild(
    rp(doc, 'section', { class: 'rp-block' }, heading('sum', 'Money at a glance'), grid)
  );
  // C3 (S20): the USD-separateness note, directly beneath the summary section.
  const notes = [model.usdNote, model.refundNote].filter(Boolean);
  for (const note of notes) {
    root.appendChild(rp(doc, 'p', { class: 'rp-note' }, note));
  }

  /* 3) Income and spending over time */
  const trendSec = rp(
    doc,
    'section',
    { class: 'rp-block rp-avoid' },
    heading('chart', model.hasCard ? 'Income and spending over time' : 'Cash flow over time')
  );
  if (model.trend.length) {
    const t = rp(doc, 'table', { class: 'rp-mini' });
    t.appendChild(
      rp(
        doc,
        'thead',
        {},
        rp(
          doc,
          'tr',
          {},
          rp(doc, 'th', {}, 'Month'),
          rp(doc, 'th', { class: 'num' }, 'Cash inflow'),
          rp(doc, 'th', { class: 'num' }, 'Spending'),
          rp(doc, 'th', { class: 'num' }, 'Net')
        )
      )
    );
    const tb = rp(doc, 'tbody');
    for (const r of model.trend) {
      tb.appendChild(
        rp(
          doc,
          'tr',
          {},
          rp(doc, 'td', {}, r.month),
          rp(doc, 'td', { class: 'num' }, r.income),
          rp(doc, 'td', { class: 'num' }, r.spending),
          rp(doc, 'td', { class: 'num' }, r.net)
        )
      );
    }
    t.appendChild(tb);
    trendSec.appendChild(t);
    trendSec.appendChild(rp(doc, 'p', { class: 'rp-note' }, model.trendNote));
  } else {
    trendSec.appendChild(
      rp(doc, 'p', { class: 'rp-empty' }, 'No money movement to chart for this period.')
    );
  }
  root.appendChild(trendSec);

  /* 4) Where money actually went */
  const outSec = rp(
    doc,
    'section',
    { class: 'rp-block' },
    heading('list', 'Where money actually went')
  );
  if (model.outflows.length) {
    const t = rp(doc, 'table', { class: 'rp-table' });
    t.appendChild(
      rp(
        doc,
        'thead',
        {},
        rp(
          doc,
          'tr',
          {},
          rp(doc, 'th', {}, 'Paid to'),
          rp(doc, 'th', { class: 'num' }, 'Payments'),
          rp(doc, 'th', { class: 'num' }, 'Total')
        )
      )
    );
    const tb = rp(doc, 'tbody');
    for (const g of model.outflows) {
      tb.appendChild(
        rp(
          doc,
          'tr',
          { class: 'rp-avoid' },
          rp(doc, 'td', { class: 'rp-wrap' }, g.label),
          rp(doc, 'td', { class: 'num' }, g.count),
          rp(doc, 'td', { class: 'num strong' }, g.amount)
        )
      );
    }
    t.appendChild(tb);
    outSec.appendChild(rp(doc, 'div', { class: 'rp-table-wrap' }, t));
    outSec.appendChild(
      rp(
        doc,
        'p',
        { class: 'rp-note' },
        'The largest genuine outflows to people and services outside your own accounts.'
      )
    );
  } else {
    outSec.appendChild(rp(doc, 'p', { class: 'rp-empty' }, 'No external outflows in this period.'));
  }
  root.appendChild(outSec);

  /* 5) Footer (repeats each page via fixed positioning) */
  root.appendChild(
    rp(
      doc,
      'footer',
      { class: 'rp-footer' },
      rp(doc, 'span', {}, `${model.app} - private report`),
      rp(doc, 'span', {}, 'Data stays on this device.')
    )
  );

  return root;
}
