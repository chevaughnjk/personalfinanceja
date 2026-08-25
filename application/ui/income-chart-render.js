/* income-chart-render.js - the income-over-months bar row. Pure model
 * (incomeChartModel) proven separately; DOM renderer maps it to HTML bars. */
import { requireCtx, MONTHS_SHORT, isPrivacyMode } from '../core/shared-helpers.js';
import { shortMonthOf, ordinalDay } from './chart-helpers.js';

export function fillMonthRange(from, to) {
  const parse = (m) => {
    const mm = /^(\d{4})-(\d{2})$/.exec(String(m));
    return mm ? +mm[1] * 12 + (+mm[2] - 1) : NaN;
  };
  const toKey = (idx) => `${Math.floor(idx / 12)}-${String((idx % 12) + 1).padStart(2, '0')}`;
  const a = parse(from),
    b = parse(to);
  if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) return [String(from)];
  const out = [];
  for (let i = a; i <= b; i++) out.push(toKey(i));
  return out;
}

export function incomeChartModel(income, opts = {}) {
  if (!income || !Array.isArray(income.series)) return null;

  const raw = income.series
    .filter(
      (s) =>
        s &&
        /^\d{4}-\d{2}$/.test(String(s.month)) &&
        Number.isFinite(Number(s.amount)) &&
        Number(s.amount) >= 0
    )
    .map((s) => ({
      month: String(s.month),
      amount: Number(s.amount),
      day: Number.isFinite(Number(s.day)) && Number(s.day) > 0 ? Number(s.day) : null,
    }))
    .sort((a, b) => (a.month < b.month ? -1 : a.month > b.month ? 1 : 0));
  if (raw.length < 2) return null;

  const byMonth = new Map(raw.map((s) => [s.month, s]));
  const allMonths = fillMonthRange(raw[0].month, raw[raw.length - 1].month);
  const maxCells = opts.maxCells && opts.maxCells > 0 ? opts.maxCells : 12;
  const months = allMonths.slice(-maxCells);

  const presentAmounts = months.filter((m) => byMonth.has(m)).map((m) => byMonth.get(m).amount);
  if (presentAmounts.length < 2) return null;

  const typical = Number.isFinite(Number(income.typicalAmount))
    ? Number(income.typicalAmount)
    : null;

  // ±18% of typical marks a genuinely unusual month (a bonus, a short month),
  // versus an ordinary raise of a few percent that stays calm. These outliers
  // are ALSO excluded from the axis-band computation below, so one spike (a
  // ~509k month against a ~294k norm) can never flatten the eleven ordinary
  // months back into an unreadable band.
  const OFF_RATIO = 0.18;
  const isOff = (amount) =>
    typical != null && typical > 0 && Math.abs((amount - typical) / typical) >= OFF_RATIO;

  // Axis band: the salary chart's whole job is showing the RAISE, so the bars
  // are scaled to the real spread of the ORDINARY months, not from zero - a
  // zero baseline would flatten a genuine 7% climb into invisible near-equal
  // bars. This is honest amplification of REAL change, made transparent by the
  // labelled baseline (bandMin) the renderer prints, never a hidden non-zero
  // axis. Outliers are excluded from the band so they set the ceiling, not the
  // scale. Padding keeps the smallest ordinary bar visibly off the floor and
  // the largest ordinary bar clear of the top (where a capped outlier sits).
  const ordinary = presentAmounts.filter((a) => !isOff(a));
  const bandSource = ordinary.length >= 2 ? ordinary : presentAmounts;
  const lo = Math.min(...bandSource);
  const hi = Math.max(...bandSource);
  const spread = hi - lo;
  // A floor of pad so a genuinely flat stream (spread ~0) still renders sane
  // mid-height bars rather than dividing by zero.
  const pad = spread > 0 ? spread * 0.35 : Math.max(1, hi * 0.05);
  const bandMin = Math.max(0, lo - pad);
  const bandMax = hi + pad;
  const bandRange = bandMax - bandMin || 1;

  const cells = months.map((month) => {
    const hit = byMonth.get(month);
    if (!hit) {
      return {
        month,
        present: false,
        amount: null,
        day: null,
        off: false,
        offDirection: null,
        heightPct: 0,
      };
    }
    const amount = hit.amount;
    const off = isOff(amount);
    const offDirection = off ? (amount > typical ? 'higher' : 'lower') : null;
    // Every present month is drawn at its true scaled height within the band.
    // An off month (a bonus, a short month) simply reads as taller or shorter;
    // its exact figure and "higher/lower than usual" note are on hover. No cap
    // treatment - the tallest bar just reads as the tallest.
    // Cap at 88% (not 100%) so the tallest bar clears the plot top rather than
    // touching the card edge, and floor at 10% so the shortest ordinary month is
    // clearly a bar. The zoomed band (bandMin..bandMax) still amplifies the real
    // month-to-month change - the chart's honest purpose - just within a plot
    // that has breathing room top and bottom, matching the other month charts.
    const heightPct = Math.max(10, Math.min(88, ((amount - bandMin) / bandRange) * 88));
    return {
      month,
      present: true,
      amount,
      day: hit.day,
      off,
      offDirection,
      heightPct,
    };
  });

  const typicalPct =
    typical != null && typical >= bandMin && typical <= bandMax
      ? ((typical - bandMin) / bandRange) * 100
      : null;

  return {
    cells,
    typicalAmount: typical,
    typicalPct,
    bandMin,
    bandMax,
    label: income.label || null,
    regularity: income.regularity || null,
    stepChange: income.stepChange || null,
  };
}

export function createIncomeChartRenderer(ctx) {
  requireCtx(ctx, ['el', 'money0', 'moneyShort', 'monthLabel'], 'createIncomeChartRenderer');
  const { el, money0, moneyShort, monthLabel } = ctx;

  const shortMonth = shortMonthOf(MONTHS_SHORT);

  function buildAriaLabel(model) {
    if (isPrivacyMode())
      return 'Your income pattern over time. Amounts hidden while privacy mode is on.';
    const present = model.cells.filter((c) => c.present).length;
    const missing = model.cells.length - present;
    const off = model.cells.filter((c) => c.off).length;
    const parts = [`Income in ${present} of the last ${model.cells.length} months`];
    if (model.typicalAmount != null) parts.push(`typically ${money0(model.typicalAmount)}`);
    if (off > 0)
      parts.push(`${off} month${off === 1 ? '' : 's'} notably above or below the usual amount`);
    if (missing > 0)
      parts.push(`${missing} month${missing === 1 ? '' : 's'} with no deposit found`);
    if (model.stepChange === 'up') parts.push('most recent stepped up');
    if (model.stepChange === 'down') parts.push('most recent stepped down');
    return parts.join(', ') + '.';
  }

  function renderIncomeChart(income, opts = {}) {
    const model = incomeChartModel(income, opts);
    if (!model) return null;

    const chart = el('div', {
      class: 'ic-chart',
      role: 'img',
      'aria-label': buildAriaLabel(model),
    });
    const plot = el('div', { class: 'ic-plot' });

    const strip = el('div', { class: 'ic-strip' });
    for (const cell of model.cells) {
      const cls = 'ic-bar' + (cell.present ? '' : ' is-missing');
      let title;
      if (!cell.present) {
        title = `${monthLabel(cell.month)}: no deposit found`;
      } else {
        const dayText = cell.day ? `, landed on the ${cell.day}${ordinalDay(cell.day)}` : '';
        const offText = cell.off ? ` - ${cell.offDirection} than usual` : '';
        title = `${monthLabel(cell.month)}: ${money0(cell.amount)}${dayText}${offText}`;
      }
      const bar = el('div', { class: cls, title });
      const fill = el('div', {
        class: 'ic-bar-fill',
        style: `height:${cell.heightPct}%`,
      });
      bar.append(fill);
      strip.append(bar);
    }
    plot.append(strip);
    chart.append(plot);

    // A plain-language note that the bars are zoomed to the salary's own
    // range rather than from zero - enough to keep the scale honest (the
    // heights show change, not absolute size) without printing another
    // precise figure into an already number-heavy card.
    chart.append(
      el(
        'p',
        { class: 'muted small ic-scale-note' },
        'Heights show the change month to month, not the full amount.'
      )
    );

    const monthsRow = el('div', { class: 'ic-months' });
    for (const cell of model.cells) {
      monthsRow.append(
        el(
          'span',
          { class: 'ic-month' + (cell.present ? '' : ' is-missing') },
          shortMonth(cell.month)
        )
      );
    }
    chart.append(monthsRow);

    return chart;
  }

  return { renderIncomeChart };
}
