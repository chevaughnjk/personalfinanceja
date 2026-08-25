/* flow-chart-render.js - the money-in vs money-out diverging bar row for
 * Overview. Two series per month: income rises above a centre break-even line,
 * spending falls below it, both measured from the SAME zero baseline so they
 * are directly comparable - here zero is the meaningful reference (break-even),
 * unlike the income chart's zoomed band. A month where more came in than went
 * out shows a taller up-bar; a short month shows a taller down-bar. Across the
 * row, the shifting balance IS the trend the narrative used to describe in
 * words. Reads roll.trend (analyseRollup) - moves no total. */
import { requireCtx, MONTHS_SHORT, isPrivacyMode } from '../core/shared-helpers.js';
import { monthLabelRow, shortMonthOf } from './chart-helpers.js';

export function flowChartModel(trend, opts = {}) {
  const rows = (Array.isArray(trend) ? trend : [])
    .filter((r) => r && /^\d{4}-\d{2}$/.test(String(r.month)))
    .map((r) => ({
      month: String(r.month),
      income: Math.max(0, Number(r.income) || 0),
      spending: Math.max(0, Number(r.spending) || 0),
      net: Number(r.net) || 0,
    }))
    .sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0));
  if (rows.length < 2) return null;

  const maxBars = opts.maxBars && opts.maxBars > 0 ? opts.maxBars : 12;
  const months = rows.slice(-maxBars);

  // Both series share ONE scale, measured from the same centre break-even line
  // so up and down bars stay directly comparable. The scale is NOT the single
  // largest value - one bonus-income or big-outflow month would then flatten
  // every ordinary month into an unreadable stub. Instead it is a ROBUST
  // reference: the median of all non-zero in/out values sets where a typical
  // month reaches ~62% height, and true outliers are allowed to exceed that
  // (soft-capped at 100%). So an ordinary month is clearly legible AND a spike
  // still reads as taller, without one month deciding the whole axis.
  const vals = [];
  for (const r of months) {
    if (r.income > 0) vals.push(r.income);
    if (r.spending > 0) vals.push(r.spending);
  }
  const sorted = vals.slice().sort((a, b) => a - b);
  const med = sorted.length
    ? sorted.length % 2
      ? sorted[sorted.length >> 1]
      : (sorted[(sorted.length >> 1) - 1] + sorted[sorted.length >> 1]) / 2
    : 1;
  const peakRaw = Math.max(...months.map((r) => Math.max(r.income, r.spending)), 1);
  // Reference at which a value maps to ~62%; never below a sensible floor, and
  // never so high that the true peak is off-scale (kept within 1.6x the median
  // so a genuine spike still visibly exceeds a typical month without dwarfing it).
  // Reference tuned so an ORDINARY (median) month reaches ~72% of the half-plot,
  // not 62% - the many small months were rendering as near-invisible slivers.
  // A lower reference (median-led, only lightly pulled up by a true peak) lifts
  // every ordinary bar into a readable height while a genuine spike still tops
  // out near 100%. Floor raised to 8% so even the smallest month is clearly a bar.
  const ref = Math.max(med * 1.15, peakRaw / 2.4, 1);
  const scale = (v) => (v <= 0 ? 0 : Math.max(8, Math.min(100, (v / ref) * 72)));
  const bars = months.map((r) => ({
    month: r.month,
    income: r.income,
    spending: r.spending,
    net: r.net,
    incomePct: scale(r.income),
    spendingPct: scale(r.spending),
  }));

  const peak = peakRaw;

  return { bars, peak, months: months.map((r) => r.month) };
}

export function createFlowChartRenderer(ctx) {
  requireCtx(ctx, ['el', 'bankMoney', 'monthLabel'], 'createFlowChartRenderer');
  const { el, bankMoney, monthLabel } = ctx;
  const shortMonth = shortMonthOf(MONTHS_SHORT);

  function buildAria(model) {
    if (isPrivacyMode()) {
      return `Cash in and out over ${model.bars.length} months. Amounts hidden while privacy mode is on.`;
    }
    const ahead = model.bars.filter((b) => b.net >= 0).length;
    const short = model.bars.length - ahead;
    const parts = [`Cash in and out over ${model.bars.length} months`];
    parts.push(`${ahead} month${ahead === 1 ? '' : 's'} ahead`);
    if (short > 0) parts.push(`${short} short`);
    return parts.join(', ') + '.';
  }

  function renderFlowChart(trend, opts = {}) {
    const model = flowChartModel(trend, opts);
    if (!model) return null;

    const chart = el('div', {
      class: 'fl-chart',
      role: 'img',
      'aria-label': buildAria(model),
    });
    const plot = el('div', { class: 'fl-plot' });

    // Two bars per month, side by side from a SHARED baseline, converging on
    // the exact pattern the account-side trend chart (accounts-render.js's
    // renderBankTrend / .acct-trend-* CSS) already proves - in and out grow
    // upward together so "did more come in than went out this month" is
    // readable at a glance for every month, which the old stacked
    // (green-over-orange, offset baselines) column made needlessly hard.
    // These charts share a VISUAL language but not their classes or
    // behaviour: this one is read-only and percentage-sized (from
    // flowChartModel's own scale); the account chart is an interactive
    // click-to-focus button, pixel-sized. Kept as parallel rule sets rather
    // than shared selectors so neither carries the other's exceptions - see
    // .fl-pair / .fl-bar in styles.css, which mirror .acct-trend-pair /
    // .acct-trend-bar deliberately.
    for (const bar of model.bars) {
      const ahead = bar.net >= 0;
      const title =
        `${monthLabel(bar.month)}: ${bankMoney(bar.income)} in, ${bankMoney(bar.spending)} out ` +
        `- ${ahead ? 'ahead by' : 'short by'} ${bankMoney(Math.abs(bar.net))}`;
      const col = el('div', { class: 'fl-col', title });

      col.append(
        el(
          'div',
          { class: 'fl-pair' },
          el('span', { class: 'fl-bar in', style: `height:${bar.incomePct}%` }),
          el('span', { class: 'fl-bar out', style: `height:${bar.spendingPct}%` })
        )
      );

      plot.append(col);
    }

    chart.append(plot);
    chart.append(monthLabelRow(el, model.months, shortMonth, null));
    chart.append(
      el(
        'div',
        { class: 'fl-legend' },
        el('span', { class: 'fl-key' }, el('span', { class: 'fl-swatch in' }), 'Cash inflow'),
        el('span', { class: 'fl-key' }, el('span', { class: 'fl-swatch out' }), 'Cash outflow')
      )
    );

    // When both series barely move month to month (a steady salary against
    // steady fixed commitments - a genuinely common, healthy profile), eight
    // near-identical bar pairs read as "this didn't load" rather than as the
    // real, reassuring signal they carry. A monthly bar chart exists to show
    // CHANGE; when there is honestly almost none, a plain-language line does
    // the job the bars can't, without pretending flat data has movement.
    // Only shown when the pattern genuinely holds: every month positive AND
    // the spread of monthly net is small relative to typical income.
    const nets = model.bars.map((b) => b.net);
    const everyMonthAhead = nets.every((n) => n >= 0);
    const typicalIn =
      model.bars.reduce((s, b) => s + b.income, 0) / (model.bars.length || 1);
    const netSpread = Math.max(...nets) - Math.min(...nets);
    const flatEnough = typicalIn > 0 && netSpread <= typicalIn * 0.15;
    if (everyMonthAhead && flatEnough && model.bars.length >= 3) {
      chart.append(
        el(
          'p',
          { class: 'muted small fl-steady-note' },
          'Steady in, steady out - comfortably ahead each month.'
        )
      );
    }

    return chart;
  }

  return { renderFlowChart };
}
