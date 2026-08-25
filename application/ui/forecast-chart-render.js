/*
 * forecast-chart-render.js  -  renders the PROVEN forecast chart geometry
 * (forecast-chart-model.js) as real SVG. It owns no forecasting and no
 * geometry: every coordinate comes pre-computed and honesty-checked from the
 * model, so this file only maps points to SVG elements.
 *
 * THE HONESTY, VISIBLE IN THE SVG (not just the model):
 *   - the far horizon is a WIDENING CONE (a filled polygon), never a bare line,
 *     so uncertainty is seen fanning out;
 *   - a firm/wide divider marks where the trustworthy near-term ends;
 *   - the near-term trough is a marked point (the "dip before payday" answer);
 *   - recorded events (a known card payment) render SOLID, estimated events
 *     (a predicted pay) render DASHED - the frozen "recorded vs estimated look
 *     different" rule;
 *   - when the ending is wide, the model's own note is surfaced verbatim.
 *
 * PRIVACY: value labels (y-axis balances, the range/low figures) are emitted as
 * data-bearing text nodes the app's single privacy state can blur; the LINE and
 * CONE geometry carry no money value, so blurring never distorts the shape.
 *
 * Follows the app's render-factory pattern: requireCtx-guarded, receives its
 * members via ctx, returns { renderForecastChart }.
 */
import { requireCtx, isPrivacyMode } from '../core/shared-helpers.js';
import { buildForecastChartModel } from '../analysis/forecast-chart-model.js';

const SVGNS = 'http://www.w3.org/2000/svg';

export function createForecastChartRenderer(ctx) {
  requireCtx(ctx, ['el', 'provenModels'], 'createForecastChartRenderer');
  const { el, provenModels } = ctx;
  const bankMoney = ctx.bankMoney || ctx.money0 || ((n) => String(Math.round(Number(n) || 0)));
  const money0 = ctx.money0 || bankMoney;
  // Compact axis money: a forecast axis read to the cent ($2,873,858.07) is
  // visual noise. This abbreviates to the app's own short style ($2.87M / $312k)
  // for the y-axis labels only; every other figure on the card stays full and
  // exact via bankMoney. Kept local since moneyShort is not in this chart's ctx.
  const axisMoney = (n) => {
    const v = Number(n) || 0;
    const sign = v < 0 ? '-' : '';
    const a = Math.abs(v);
    if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(a >= 1e7 ? 1 : 2)}M`;
    if (a >= 1e3) return `${sign}$${Math.round(a / 1e3)}k`;
    return `${sign}$${Math.round(a)}`;
  };
  const r2FC = (n) => Math.round(Number(n || 0) * 100) / 100;
  // Optional: a card-side merchant drill (ahead-render.js's own
  // drillToTransactions wrapper), never required - the chart already
  // degraded gracefully with no click-through at all, so an absent
  // callback simply leaves every marker exactly as inert as it was before.
  const onEventClick = ctx.onEventClick || null;

  // Small SVG-element helper (createElementNS so nodes are real SVG, never a
  // string that would print literal <svg> markup - the same discipline the
  // print report uses).
  function svg(tag, attrs = {}, ...kids) {
    const n = document.createElementNS(SVGNS, tag);
    for (const [k, v] of Object.entries(attrs)) if (v != null) n.setAttribute(k, String(v));
    for (const kid of kids.flat()) if (kid != null && kid !== false) n.appendChild(kid);
    return n;
  }
  const ptStr = (pts) => pts.map((p) => `${p.x},${p.y}`).join(' ');

  function renderChart(model) {
    const { view, line, cone, trough } = model;
    const root = svg('svg', {
      viewBox: `0 0 ${view.w} ${view.h}`,
      class: 'fc-chart',
      role: 'img',
      preserveAspectRatio: 'none',
      'aria-label': isPrivacyMode()
        ? `Cash forecast over ${model.domain.horizonDays} days. Amount hidden while privacy mode is on.`
        : `Cash forecast over ${model.domain.horizonDays} days.`,
    });

    const floorY = view.h - view.padB;

    // Uncertainty band: the same widening cone, drawn FIRST (behind everything)
    // as a soft wash of the projection's OWN accent - a lighter extension of
    // the forecast, not a separate grey slab competing with the line. Its
    // widening from left to right IS the "the further out, the less certain"
    // signal, so the old dashed firm/wide divider is gone - the shape carries
    // that honesty geometrically.
    if (cone.bandAtEnd > 0) {
      const poly = cone.upper.concat(cone.lower.slice().reverse());
      root.appendChild(svg('polygon', { points: ptStr(poly), class: 'fc-band' }));
    }

    // The filled area under the projected line - the app's own bold, flat
    // filled-shape language (the flow bars, the treemap tiles, the timeline
    // bars), so a person reads the SHAPE of where cash is heading at a glance
    // rather than tracing a thin line. Built from the line points closed down
    // to the plot floor.
    const areaPts = line.concat([
      { x: line[line.length - 1].x, y: floorY },
      { x: line[0].x, y: floorY },
    ]);
    root.appendChild(svg('polygon', { points: ptStr(areaPts), class: 'fc-area' }));

    // The crisp projected line on top. vector-effect:non-scaling-stroke keeps
    // the stroke a true, even pixel width regardless of the viewBox's
    // non-uniform stretch - THE fix for the soft/blurred line: a normally
    // scaled stroke became thick-horizontal and thin-vertical under the
    // stretch, which read as blur. A non-scaling stroke renders sharp.
    root.appendChild(
      svg('polyline', {
        points: ptStr(line),
        class: 'fc-line',
        fill: 'none',
        'vector-effect': 'non-scaling-stroke',
      })
    );

    // One bold marker on the near-term low - the single number a person came
    // to this chart for. Tone judged against a real safe line when one is set,
    // else the reliability fallback (unchanged from before).
    const troughToneClass =
      model.safety && model.safety.asserts
        ? 'fc-trough-' + (trough.belowFloor ? 'warn' : 'firm')
        : 'fc-trough-' + trough.reliability;
    root.appendChild(
      svg('circle', {
        cx: trough.x,
        cy: trough.y,
        r: 4,
        class: 'fc-trough ' + troughToneClass,
        'vector-effect': 'non-scaling-stroke',
      })
    );
    return root;
  }

  // HTML overlay for every chart label - real text, positioned by percentage
  // over the SAME box the SVG occupies, so it reads at a genuine CSS pixel
  // size no matter how the SVG's own geometry is stretched (see renderChart's
  // own comment on why the SVG text this replaces read blurred).
  function buildOverlay(model) {
    const { view, xTicks, yTicks, trough, recordedEvents, estimatedEvents } = model;
    const pctX = (x) => r2FC((x / view.w) * 100);
    const pctY = (y) => r2FC((y / view.h) * 100);
    const overlay = el('div', { class: 'fc-overlay', 'aria-hidden': 'true' });

    for (const t of yTicks) {
      overlay.append(
        el(
          'span',
          {
            class: 'fc-label fc-axis-money money anchor-start',
            style: `left:${pctX(view.padL + 2)}%; top:${pctY(t.y)}%;`,
          },
          axisMoney(t.value)
        )
      );
    }

    for (const t of xTicks) {
      // First tick left-anchors, last right-anchors, others centre - so no
      // edge label is clipped at the chart's own edges.
      const anchor = t.day <= 0 ? 'start' : t.x > view.w - view.padR - 1 ? 'end' : 'mid';
      overlay.append(
        el(
          'span',
          {
            class: `fc-label fc-axis-date anchor-${anchor}`,
            style: `left:${pctX(t.x)}%; top:${pctY(view.h - 6)}%;`,
          },
          shortDate(t.date)
        )
      );
    }

    // A sharp jump in the line with no visible explanation (a large income
    // deposit landing) previously read as ambiguous on a static view, and
    // relied on hover for its name/amount - unavailable on a touch device
    // with no equivalent gesture. Each marker of real size now carries a
    // small always-visible label naming it, not just a coloured tick.
    const EVENT_LABEL_MIN_GAP = 40; // model-space px; skip a label that would collide with its neighbour
    let lastLabelX = -Infinity;
    function appendEventLabel(e, dashed) {
      if (e.x - lastLabelX < EVENT_LABEL_MIN_GAP) return;
      lastLabelX = e.x;
      const anchor = e.x > view.w - view.padR - 60 ? 'end' : 'start';
      overlay.append(
        el(
          'span',
          {
            class: `fc-label fc-ev-label${dashed ? ' fc-ev-label-estimated' : ''} anchor-${anchor}`,
            style: `left:${pctX(e.x + (anchor === 'end' ? -6 : 6))}%; top:${pctY(e.y - 10)}%;`,
          },
          e.label || ''
        )
      );
    }
    for (const e of recordedEvents) appendEventLabel(e, false);
    for (const e of estimatedEvents) appendEventLabel(e, true);

    // Trough callout: the headline sentence above names this exact point
    // ("Lowest point expected, around ...") but previously left the
    // connection between that sentence and the dot to be inferred from
    // position alone - this label closes that loop directly on the chart.
    // Defaults to sitting BEHIND the point (anchor-end, text extending left
    // over already-flat terrain) rather than the old default of extending
    // right: the trough sits right before this chart's own honest jump (the
    // income event), so a right-extending label previously ran straight
    // across that rising line. Only falls back to extending right when
    // there is genuinely no room to the left, near the chart's own left edge.
    const troughAnchor = trough.x < view.padL + 90 ? 'start' : 'end';
    overlay.append(
      el(
        'span',
        {
          class: `fc-label fc-trough-label money anchor-${troughAnchor}`,
          style: `left:${pctX(trough.x + (troughAnchor === 'end' ? -8 : 8))}%; top:${pctY(trough.y - 10)}%;`,
        },
        'Lowest: ' + bankMoney(trough.balance)
      )
    );

    return overlay;
  }

  function shortDate(iso) {
    const m = +String(iso || '').slice(5, 7),
      d = +String(iso || '').slice(8, 10);
    const MON = [
      '',
      'Jan',
      'Feb',
      'Mar',
      'Apr',
      'May',
      'Jun',
      'Jul',
      'Aug',
      'Sep',
      'Oct',
      'Nov',
      'Dec',
    ];
    return m ? `${d} ${MON[m]}` : '';
  }

  /* The card: chart + a legend that names solid=recorded / dashed=estimated,
   * and the honest wide-horizon note when the ending is a range not a line.
   *
   * safetyBoundary (optional): the SAME resolveSafetyBoundary() result the
   * goal card reads (goals.js), resolved by the caller from state._goalBoundary
   * - a boot-time, goal-independent value - so this comparison works whether
   * or not a goal has ever been set. When omitted or asserting nothing, the
   * headline and trough fall back to their prior reliability-only behaviour,
   * exactly as before this addition. */
  function renderForecastChart(horizonDays = 30, safetyBoundary = null) {
    const fc = provenModels.forecast(horizonDays);
    const sec = el('section', { class: 'card lead' });
    sec.append(
      el('div', { class: 'card-head' }, el('h3', { class: 'card-title' }, 'Cash forecast'))
    );

    // headline: the low point (the trustworthy output), framed as a range.
    const model = buildForecastChartModel(fc);
    model.safety = safetyBoundary;
    const lowMid = fc.low.balance;
    model.trough.balance = lowMid;
    model.trough.belowFloor =
      safetyBoundary && safetyBoundary.asserts && safetyBoundary.floor != null
        ? lowMid < safetyBoundary.floor
        : false;

    // "Compared to today": the one number a person actually wants alongside
    // the raw projection - is the low point better or worse than the cash
    // they have right now, and by how much. Computed directly from a field
    // the model already exposes (startingBalance); no new data fetched.
    const deltaFromToday = r2FC(lowMid - fc.startingBalance);
    const deltaTone = deltaFromToday < 0 ? 'tone-watch' : 'tone-good';
    const deltaText =
      deltaFromToday === 0
        ? 'about the same as today'
        : `${deltaFromToday < 0 ? 'down' : 'up'} ${money0(Math.abs(deltaFromToday))} from today`;

    // Number -> tag(s) -> dropdown: the SAME shared content-model shape every
    // other proven-figure card in this app uses (.vm/.vm-lead/.vm-tag/
    // .vm-detail, glass.css). This header previously appended its elements
    // directly onto the card body outside that component, which is why its
    // spacing read inconsistently with every neighbouring card.
    const vmTags = [el('span', { class: 'vm-tag ' + deltaTone }, deltaText)];

    // Part 6: the trough tag above tells only the SCARY half - "down $X from
    // today" - but for a net-positive person the line visibly RECOVERS past
    // today's balance after income lands, and a headline that omits the
    // recovery reads as contradicting the chart. When the projection ENDS
    // ahead of where it started (net-positive over the window), say so, as a
    // calm companion tag beside the trough. endBalance is the last projected
    // point's balance - fc.path is the full line the chart already draws, so
    // this fetches no new data. Both facts are true; the app now states both
    // the dip AND the recovery, not only the dip.
    const endBalance =
      fc.path && fc.path.length ? fc.path[fc.path.length - 1].balance : fc.startingBalance;
    const endDate = fc.path && fc.path.length ? fc.path[fc.path.length - 1].date : null;
    const netOverWindow = r2FC(endBalance - fc.startingBalance);
    // The recovery story is a full clause, not a few-word tag - forcing it
    // into a pill made it a sentence wearing a pill's clothing. It moves to
    // the content-model's supporting-line treatment (.vm-reconcile.tone-good)
    // beneath the tags, built into vmKids below. Only computed here.
    const recoveryLine =
      netOverWindow > 0 && endDate
        ? `Recovers to about ${bankMoney(endBalance)} by ${shortDate(endDate)}, ahead of today.`
        : null;

    // Part 5: forecast confidence, folded in as a quiet tag HERE rather than
    // a standalone hero card. Read directly from the same accuracy model the
    // old card used, but shown ONLY once genuinely scored - in the 'building'
    // state it stays silent (no "0 of 3"), because an app has nothing useful
    // to say about its own accuracy until it has actually been graded. The
    // full sentence lives behind the existing "Why" disclosure, matching the
    // app-wide rule that longer reasoning is opt-in.
    const accuracy = provenModels.accuracyFor ? provenModels.accuracyFor(horizonDays) : null;
    if (accuracy && accuracy.state === 'scored') {
      vmTags.push(
        el('span', { class: 'vm-tag tone-' + (accuracy.tone || 'neutral') }, `forecast ${accuracy.tag}`)
      );
    }
    let vmDetailText = null;
    if (safetyBoundary) {
      if (safetyBoundary.asserts && safetyBoundary.floor != null) {
        const clears = !model.trough.belowFloor;
        vmTags.push(
          el(
            'span',
            { class: 'vm-tag ' + (clears ? 'tone-good' : 'tone-watch') },
            clears
              ? `clears your safe line of ${bankMoney(safetyBoundary.floor)}`
              : `dips below your safe line of ${bankMoney(safetyBoundary.floor)}`
          )
        );
      } else if (safetyBoundary.explain) {
        // The frozen 'none' state's own explain text, moved behind the SAME
        // "Why" disclosure every other proven-model card already uses,
        // rather than sitting as a standing sentence on the card's surface -
        // matching the app-wide rule that longer reasoning is opt-in.
        vmDetailText = safetyBoundary.explain;
      }
    }
    const vmKids = [
      el(
        'div',
        { class: 'vm-lead' },
        el('div', { class: 'vm-number money' }, bankMoney(lowMid)),
        el('div', { class: 'vm-label' }, `Lowest point expected, around ${shortDate(fc.low.date)}`)
      ),
      // Tags in their own inline-WRAPPING row - .vm is flex-direction:column,
      // so tags appended straight to it stack vertically; .vm-tags wraps them
      // into a horizontal set of pills matching every other multi-tag card.
      el('div', { class: 'vm-tags' }, ...vmTags),
    ];
    // The recovery supporting line (Part 6), calm and tone-good, beneath the
    // tags - a clause belongs here, not in a pill.
    if (recoveryLine) {
      vmKids.push(el('div', { class: 'vm-reconcile tone-good' }, recoveryLine));
    }
    // One "Why" disclosure carries whatever longer reasoning applies - the
    // safety-line explanation and, when scored, the full forecast-accuracy
    // sentence (Part 5), so the confidence tag above has its detail on demand
    // without a second card. Both lines appear together when both apply.
    const whyLines = [];
    if (vmDetailText) whyLines.push(el('div', {}, vmDetailText));
    if (accuracy && accuracy.state === 'scored' && accuracy.detail) {
      whyLines.push(el('div', { style: whyLines.length ? 'margin-top:6px' : '' }, accuracy.detail));
    }
    if (whyLines.length) {
      vmKids.push(
        el(
          'details',
          { class: 'vm-detail' },
          el('summary', {}, 'Why'),
          el('div', { class: 'vm-detail-body' }, ...whyLines)
        )
      );
    }
    sec.append(el('div', { class: 'vm' }, ...vmKids));

    sec.append(el('div', { class: 'fc-chart-wrap' }, renderChart(model), buildOverlay(model)));

    // legend - two items now, matching the stripped-back chart: the projected
    // path and its widening range. The recorded/estimated distinction lives in
    // the event name labels (estimated ones lighter) rather than plot marks.
    sec.append(
      el(
        'div',
        { class: 'fc-legend muted small' },
        el(
          'span',
          { class: 'fc-legend-item' },
          el('span', { class: 'fc-key fc-key-area' }),
          ' projected balance'
        ),
        el(
          'span',
          { class: 'fc-legend-item' },
          el('span', { class: 'fc-key fc-key-band' }),
          ' range of likely values'
        )
      )
    );

    // the honest wide-horizon note, verbatim from the model, only when wide
    if (model.zones.endingWide && model.presentation.note) {
      sec.append(el('div', { class: 'vm-reconcile tone-watch' }, model.presentation.note));
    }
    return sec;
  }

  return { renderForecastChart };
}
