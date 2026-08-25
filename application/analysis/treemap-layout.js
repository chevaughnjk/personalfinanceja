/* ===========================================================================
 *  treemap-layout.js  -  squarified treemap geometry for spending composition.
 *  Turns a ranked [{ name, amount, ... }] list into rectangles whose AREA is
 *  proportional to amount, tiling a given box exactly. This is the "see your
 *  exposure in one glance" picture: big rectangle = big spend.
 *
 *  THE GEOMETRY INVARIANT (this module's equivalent of split reconciliation):
 *  the rectangles must (1) have area proportional to amount, (2) tile the box
 *  with no gap and no overlap, and (3) sum to the box area. A treemap that does
 *  not reconcile its areas misrepresents the data visually, exactly as a split
 *  that does not sum misrepresents it numerically. layoutTreemap guarantees all
 *  three by construction; the proof asserts them.
 *
 *  Squarified algorithm (Bruls, Huizing, van Wijk 2000): lay items into rows
 *  along the shorter side, greedily keeping each row's aspect ratios as close to
 *  square as possible, so no sliver rectangles. Deterministic and pure.
 *
 *  PURE and Node-testable. No DOM.
 * ======================================================================== */
function worst(row, side, scale) {
  // worst aspect ratio in a row given the fixed side length (Bruls et al.)
  let max = 0,
    min = Infinity,
    sum = 0;
  for (const v of row) {
    const a = v * scale;
    sum += a;
    if (a > max) max = a;
    if (a < min) min = a;
  }
  const s2 = sum * sum,
    w2 = side * side;
  return Math.max((w2 * max) / s2, s2 / (w2 * min));
}

/* items: [{ name, amount, ...passthrough }] with amount > 0.
 * box: { x, y, w, h }. Returns [{ ...item, x, y, w, h, area }]. */
export function layoutTreemap(items, box) {
  const clean = (items || []).filter((it) => Number(it.amount) > 0);
  const totalAmt = clean.reduce((s, it) => s + Number(it.amount), 0);
  const out = [];
  if (!clean.length || totalAmt <= 0 || box.w <= 0 || box.h <= 0) return out;
  const boxArea = box.w * box.h;
  const scale = boxArea / totalAmt; // amount -> area
  // work on a mutable rect; consume items largest-first
  let { x, y, w, h } = box;
  const queue = clean.slice().sort((a, b) => b.amount - a.amount);
  let i = 0;
  while (i < queue.length) {
    const shortSide = Math.min(w, h);
    const row = [queue[i]];
    let rowVals = [queue[i].amount];
    // grow the row while it improves (lowers worst aspect ratio)
    let j = i + 1;
    while (j < queue.length) {
      const cur = worst(rowVals, shortSide, scale);
      const nxt = worst([...rowVals, queue[j].amount], shortSide, scale);
      if (nxt > cur) break;
      row.push(queue[j]);
      rowVals.push(queue[j].amount);
      j++;
    }
    // place `row` along the shorter side, filling the strip depth-first
    const rowAmt = rowVals.reduce((s, v) => s + v, 0);
    const rowArea = rowAmt * scale;
    if (w <= h) {
      // horizontal strip across the top; depth = rowArea / w
      const stripH = rowArea / w;
      let cx = x;
      for (const it of row) {
        const cw = (it.amount * scale) / stripH;
        out.push({
          ...it,
          x: cx,
          y,
          w: cw,
          h: stripH,
          area: it.amount * scale,
        });
        cx += cw;
      }
      y += stripH;
      h -= stripH;
    } else {
      // vertical strip down the left; depth = rowArea / h
      const stripW = rowArea / h;
      let cy = y;
      for (const it of row) {
        const ch = (it.amount * scale) / stripW;
        out.push({
          ...it,
          x,
          y: cy,
          w: stripW,
          h: ch,
          area: it.amount * scale,
        });
        cy += ch;
      }
      x += stripW;
      w -= stripW;
    }
    i = j;
  }
  return out;
}

/* Two-level treemap: each category tile is subdivided into its own merchants.
 * categories: [{ name, amount, colour }]; merchantsByCat: Map(catName -> [{name,amount}]).
 * Returns { tiles: category rects, subTiles: merchant rects within them }. The
 * merchant rects for a category sum to that category's rect area, so the whole
 * picture reconciles at both levels. */
export function layoutCategoryTreemap(categories, merchantsByCat, box) {
  const tiles = layoutTreemap(categories, box);
  const subTiles = [];
  for (const t of tiles) {
    const kids = (merchantsByCat && merchantsByCat.get ? merchantsByCat.get(t.name) : null) || [];
    if (kids.length && t.w > 2 && t.h > 2) {
      for (const st of layoutTreemap(kids, {
        x: t.x,
        y: t.y,
        w: t.w,
        h: t.h,
      })) {
        subTiles.push({ ...st, category: t.name });
      }
    }
  }
  return { tiles, subTiles };
}
