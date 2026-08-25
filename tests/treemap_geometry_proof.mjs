// Treemap geometry proof: the invariant is that tile AREA is proportional to
// amount, tiles TILE the box (no gap, no overlap, no overflow), and areas SUM to
// the box area - a treemap that doesn't reconcile its areas lies visually the
// same way a split that doesn't sum lies numerically. Proves all three, plus the
// two-level (category->merchant) reconciliation and edge cases.
import { layoutTreemap, layoutCategoryTreemap } from '../application/analysis/treemap-layout.js';

let pass = 0,
  fail = 0;
const note = (c, l) => {
  if (c) pass++;
  else {
    fail++;
    console.log('   FAIL', l);
  }
};
const EPS = 1e-6;
console.log('='.repeat(72));
console.log(' TREEMAP GEOMETRY - area reconciliation proof');
console.log('='.repeat(72));

const box = { x: 0, y: 0, w: 800, h: 400 };
const boxArea = box.w * box.h;
// realistic category spend (like analysePeriod by_category)
const cats = [
  { name: 'Groceries', amount: 60000, colour: '#3f9d6b' },
  { name: 'Dining & Takeout', amount: 30000, colour: '#c98a1b' },
  { name: 'Fuel & Transport', amount: 20000, colour: '#2f6fb0' },
  { name: 'Retail & Department', amount: 15000, colour: '#a05fb4' },
  { name: 'Subscriptions', amount: 8000, colour: '#4aa3a3' },
  { name: 'Utilities', amount: 5000, colour: '#c65b7c' },
];
const total = cats.reduce((s, c) => s + c.amount, 0);
const tiles = layoutTreemap(cats, box);

// 1) every item placed exactly once
note(tiles.length === cats.length, `all ${cats.length} categories placed (got ${tiles.length})`);
note(new Set(tiles.map((t) => t.name)).size === cats.length, 'no category dropped or duplicated');

// 2) AREA proportional to amount (the core honesty: big spend = big rectangle)
{
  let ok = true;
  for (const t of tiles) {
    const expected = (t.amount / total) * boxArea;
    const got = t.w * t.h;
    if (Math.abs(got - expected) > 0.5) {
      ok = false;
      console.log(`   area mismatch ${t.name}: ${got} vs ${expected}`);
    }
  }
  note(ok, 'every tile area is proportional to its amount (area = share * boxArea)');
}

// 3) areas SUM to the box area (reconciliation)
{
  const sum = tiles.reduce((s, t) => s + t.w * t.h, 0);
  note(
    Math.abs(sum - boxArea) < 0.5,
    `tile areas sum to the box area (${Math.round(sum)} vs ${boxArea})`
  );
}

// 4) every tile is INSIDE the box (no overflow)
{
  let inside = true;
  for (const t of tiles) {
    if (t.x < -EPS || t.y < -EPS || t.x + t.w > box.w + 0.5 || t.y + t.h > box.h + 0.5)
      inside = false;
  }
  note(inside, 'no tile overflows the box');
}

// 5) NO OVERLAP between any two tiles
{
  let overlap = false;
  for (let a = 0; a < tiles.length; a++)
    for (let b = a + 1; b < tiles.length; b++) {
      const A = tiles[a],
        B = tiles[b];
      const ox = Math.max(0, Math.min(A.x + A.w, B.x + B.w) - Math.max(A.x, B.x));
      const oy = Math.max(0, Math.min(A.y + A.h, B.y + B.h) - Math.max(A.y, B.y));
      if (ox > 0.01 && oy > 0.01) overlap = true;
    }
  note(!overlap, 'no two tiles overlap');
}

// 6) ORDER preserved by size: the biggest amount gets the biggest area
{
  const bySize = tiles.slice().sort((a, b) => b.w * b.h - a.w * a.h);
  note(bySize[0].name === 'Groceries', 'largest spend (Groceries) has the largest tile');
}

// 7) squarified => no extreme slivers (aspect ratio stays reasonable)
{
  let worstAspect = 0;
  for (const t of tiles) {
    const ar = Math.max(t.w / t.h, t.h / t.w);
    if (ar > worstAspect) worstAspect = ar;
  }
  note(
    worstAspect < 8,
    `no extreme sliver tiles (worst aspect ratio ${worstAspect.toFixed(1)} < 8)`
  );
}

// 8) TWO-LEVEL: merchant sub-tiles reconcile to their category's rect
{
  const merchantsByCat = new Map([
    [
      'Groceries',
      [
        { name: 'Supermarket A', amount: 40000 },
        { name: 'Supermarket B', amount: 20000 },
      ],
    ],
    [
      'Dining & Takeout',
      [
        { name: 'Cafe X', amount: 18000 },
        { name: 'Restaurant Y', amount: 12000 },
      ],
    ],
  ]);
  const { tiles: ct, subTiles } = layoutCategoryTreemap(cats, merchantsByCat, box);
  // Groceries sub-tiles must sum to the Groceries tile area
  const groc = ct.find((t) => t.name === 'Groceries');
  const grocSubs = subTiles.filter((s) => s.category === 'Groceries');
  const subSum = grocSubs.reduce((s, x) => s + x.w * x.h, 0);
  note(
    Math.abs(subSum - groc.w * groc.h) < 1,
    'merchant sub-tiles sum to their category tile area (two-level reconciliation)'
  );
  // and each sub-tile sits inside its category rect
  let insideCat = true;
  for (const s of grocSubs) {
    if (
      s.x < groc.x - EPS ||
      s.y < groc.y - EPS ||
      s.x + s.w > groc.x + groc.w + 0.5 ||
      s.y + s.h > groc.y + groc.h + 0.5
    )
      insideCat = false;
  }
  note(insideCat, 'each merchant sub-tile sits inside its parent category rect');
  note(grocSubs.length === 2, 'Groceries subdivided into its 2 merchants');
}

// 9) edge cases
{
  note(layoutTreemap([], box).length === 0, 'empty list -> no tiles (no crash)');
  note(layoutTreemap([{ name: 'X', amount: 0 }], box).length === 0, 'zero-amount item excluded');
  const one = layoutTreemap([{ name: 'Solo', amount: 100 }], box);
  note(
    one.length === 1 && Math.abs(one[0].w * one[0].h - boxArea) < 0.5,
    'single item fills the whole box'
  );
}

console.log(`\n checks: ${pass} passed, ${fail} failed`);
console.log('='.repeat(72));
console.log(
  fail === 0
    ? ' RESULT: tile area is proportional to amount, tiles fill the box with no gap or\n         overlap, areas reconcile to the total at both levels, and no slivers.\n         The picture is a truthful visual of composition.'
    : ' RESULT: FAILURES ABOVE.'
);
console.log('='.repeat(72));
process.exit(fail ? 1 : 0);
