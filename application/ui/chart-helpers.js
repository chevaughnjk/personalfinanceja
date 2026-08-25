/* chart-helpers.js - the small, genuinely-shared building blocks the income
 * and flow charts both use. Deliberately NOT a "bar chart primitive": the two
 * charts differ for honest reasons (income is single-series on a zoomed band
 * to reveal a raise; flow is two-series on a zero baseline to compare in vs
 * out), so only the low-level scaffolding is shared, never the scale or
 * geometry. Each chart owns its own model. */

// A month-label row aligned 1:1 under a bar strip. months: string[] 'YYYY-MM'.
// missingSet: optional Set of months to render dimmed. el/shortMonth injected.
export function monthLabelRow(el, months, shortMonth, missingSet) {
  const row = el('div', { class: 'ch-months' });
  for (const m of months) {
    const dim = missingSet && missingSet.has(m);
    row.append(el('span', { class: 'ch-month' + (dim ? ' is-dim' : '') }, shortMonth(m)));
  }
  return row;
}

// 'YYYY-MM' -> short month name, using the injected MONTHS_SHORT array.
export function shortMonthOf(MONTHS_SHORT) {
  return (ym) => MONTHS_SHORT[+String(ym).slice(5, 7) - 1] || ym;
}

// Ordinal suffix for a day-of-month (1st, 2nd, 3rd...). Shared by both charts'
// hover text.
export function ordinalDay(n) {
  const s = ['th', 'st', 'nd', 'rd'],
    v = n % 100;
  return s[(v - 20) % 10] || s[v] || s[0];
}

// Layout util (shared by the render factories): append two compact cards as a
// side-by-side PAIR when both exist - marking each .half so the 2-column grid
// (>=1000px) places them together. When only one exists it is appended
// full-width with NO .half, so a missing card never leaves an empty half-
// column. Below 1000px .half is inert and both simply stack. One robust rule
// for "pair where it makes sense", degrading cleanly to the mobile single stack.
export function pairCards(wrap, a, b) {
  if (a && b) {
    a.classList.add('half');
    b.classList.add('half');
    // A paired tile that contains a scrolling list must let that list fill
    // the shared height the grid gives the pair - otherwise a short list
    // beside a tall neighbour leaves the tile stretched but half-empty, with
    // a scrollbar appearing while room sits unused. Marking the tile lets the
    // stylesheet make its own body a column whose .pair-scroll child grows
    // into the leftover space. Only tiles that actually hold a .pair-scroll
    // list are marked, so a headline or small card paired with a taller list
    // keeps its natural size and is never forced tall with nothing to fill it.
    for (const card of [a, b]) {
      if (card.querySelector && card.querySelector('.pair-scroll')) {
        card.classList.add('half-fill');
      }
    }
    wrap.append(a, b);
  } else if (a) wrap.append(a);
  else if (b) wrap.append(b);
}
