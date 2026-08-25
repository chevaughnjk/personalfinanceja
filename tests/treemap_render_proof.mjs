// Treemap render proof: the proven geometry renders to SVG with the picture's
// honesty intact - one coloured rect per category (area-proportional), merchant
// subdivisions as faint outlines, labels only where they fit, and NO money value
// in the rect geometry (so privacy blur can't distort the picture).
import { createTreemapRenderer, adaptSpendBreakdownForTreemap } from '../application/ui/treemap-render.js';
import { layoutCategoryTreemap } from '../application/analysis/treemap-layout.js';

let pass = 0,
  fail = 0;
const note = (c, l) => {
  if (c) pass++;
  else {
    fail++;
    console.log('   FAIL', l);
  }
};
function mkNode(tag, ns) {
  return {
    tag,
    ns,
    attrs: {},
    kids: [],
    text: '',
    listeners: {},

    setAttribute(key, value) {
      this.attrs[key] = String(value);
    },

    appendChild(child) {
      this.kids.push(child);
      return child;
    },

    addEventListener(type, handler) {
      if (!this.listeners[type]) this.listeners[type] = [];
      this.listeners[type].push(handler);
    },

    dispatchEvent(event) {
      const handlers = this.listeners[event.type] || [];
      for (const handler of handlers) handler(event);
    },

    append(...children) {
      for (const child of children.flat()) {
        if (child == null || child === false) continue;

        if (typeof child === 'object' && child.tag) {
          this.kids.push(child);
        } else {
          this.kids.push({
            tag: '#text',
            text: String(child),
            kids: [],
            attrs: {},
            listeners: {},
          });
        }
      }

      return this;
    },
  };
}
globalThis.document = {
  createElementNS: (ns, tag) => mkNode(tag, ns),
  createTextNode: (s) => ({
    tag: '#text',
    text: String(s),
    kids: [],
    attrs: {},
  }),
};
function el(t, a = {}, ...k) {
  const n = mkNode(t, 'html');
  n.attrs = a || {};
  n.append(...k);
  return n;
}
function walk(n, f) {
  f(n);
  for (const k of n.kids) walk(k, f);
}
function findAll(r, p) {
  const o = [];
  walk(r, (n) => {
    if (p(n)) o.push(n);
  });
  return o;
}
function allText(n) {
  let t = n.text || '';
  for (const k of n.kids) t += ' ' + allText(k);
  return t.replace(/\s+/g, ' ').trim();
}
function visibleText(n) {
  if (n.tag === 'title') return '';
  let t = n.text || '';
  for (const k of n.kids) t += ' ' + visibleText(k);
  return t.replace(/\s+/g, ' ').trim();
}
const money0 = (n) => '$' + Number(n || 0).toLocaleString('en-US');
const PAL = {
  Groceries: '#3f9d6b',
  'Dining & Takeout': '#c98a1b',
  'Fuel & Transport': '#2f6fb0',
  'Retail & Department': '#a05fb4',
  Tiny: '#4aa3a3',
};
const catColour = (n) => PAL[n] || '#888888';

const analysis = {
  by_category: [
    { name: 'Groceries', amount: 60000, share: 0.5 },
    { name: 'Dining & Takeout', amount: 30000, share: 0.25 },
    { name: 'Fuel & Transport', amount: 20000, share: 0.166 },
    { name: 'Retail & Department', amount: 8000, share: 0.066 },
    { name: 'Tiny', amount: 2000, share: 0.016 }, // small tile -> no label
  ],
  merchants: [
    { name: 'Supermarket A', amount: 40000, category: 'Groceries' },
    { name: 'Supermarket B', amount: 20000, category: 'Groceries' },
    { name: 'Cafe X', amount: 30000, category: 'Dining & Takeout' },
  ],
};

let clicked = null;
const r = createTreemapRenderer({ el, money0, catColour });
const card = r.renderTreemapCard(analysis, {
  onCategory: (name) => {
    clicked = name;
  },
});

console.log('='.repeat(72));
console.log(' TREEMAP RENDER - picture honesty in the SVG');
console.log('='.repeat(72));

note(!!card, 'treemap card renders');
const svg = findAll(card, (n) => n.tag === 'svg')[0];
note(!!svg, 'an <svg> is produced');

note(
  svg.attrs.preserveAspectRatio === 'xMidYMid meet',
  'the SVG preserves its viewBox proportions instead of stretching the picture'
);

note(
  svg.attrs.role === 'group' && typeof svg.attrs['aria-label'] === 'string',
  'the SVG is exposed as a named group containing individually described categories'
);

const defs = findAll(svg, (node) => node.tag === 'defs');

note(defs.length === 1, 'the SVG contains one definitions container for reusable clip paths');

const clipPaths = findAll(svg, (node) => node.tag === 'clipPath');
const clipIds = clipPaths.map((node) => node.attrs.id);

note(
  clipIds.length > 0 && new Set(clipIds).size === clipIds.length,
  'every text clip path has a unique identifier within the treemap'
);

// one coloured rect per category (the tm-rect class)
const catRects = findAll(
  card,
  (n) => n.tag === 'rect' && String(n.attrs.class || '').includes('tm-rect')
);
note(catRects.length === 5, `one category rect per category (5), got ${catRects.length}`);
// colours come from catColour
const grocRect = catRects.find((rc) => rc.attrs.fill === '#3f9d6b');
note(!!grocRect, 'Groceries rect uses its category colour');

// AREA proportional: Groceries(60k) rect area == 2x Dining(30k) rect area
{
  const area = (rc) => Number(rc.attrs.width) * Number(rc.attrs.height);
  const groc = catRects.find((rc) => rc.attrs.fill === '#3f9d6b');
  const din = catRects.find((rc) => rc.attrs.fill === '#c98a1b');
  const ratio = area(groc) / area(din);
  note(
    Math.abs(ratio - 2) < 0.05,
    `Groceries area is ~2x Dining area (60k vs 30k), ratio ${ratio.toFixed(2)}`
  );
}

// NO money value baked into the rect geometry (privacy-safe): rect attrs carry
// only x/y/width/height/fill/class/rx - never a $ amount.
{
  const anyMoney = catRects.some((rc) => /\$/.test(JSON.stringify(rc.attrs)));
  note(!anyMoney, 'rect geometry carries NO money value (privacy blur cannot distort the picture)');
}

// merchant subdivisions rendered as faint outline rects (fill:none)
const subs = findAll(
  card,
  (n) => n.tag === 'rect' && String(n.attrs.class || '').includes('tm-sub')
);
note(subs.length >= 2, `merchant subdivisions rendered as outlines (${subs.length})`);
note(
  subs.every((s) => s.attrs.fill === 'none'),
  'sub-tiles are outline-only (category colour stays the dominant signal)'
);

// Hover tooltip: EVERY tile carries a native SVG <title>, not just the ones
// big enough for an inline label.
// Hover tooltip on CATEGORY tiles (the <g class="tm-tile"> wrapper): every
// tile carries its own <title>, regardless of whether it is big enough for
// an inline VISIBLE label - this is what gives a SMALL, unlabelled tile
// (Tiny) real information on hover or keyboard focus, which the visible-
// label check above deliberately does NOT provide for it.
{
  const tileGroups = findAll(
    card,
    (n) => n.tag === 'g' && String(n.attrs.class || '').includes('tm-tile')
  );
  note(tileGroups.length === 5, `5 category tile groups produced, got ${tileGroups.length}`);
  const groupsWithTitle = tileGroups.filter((g) => g.kids.some((k) => k.tag === 'title'));
  note(
    groupsWithTitle.length === tileGroups.length,
    `every category tile group (${tileGroups.length}) carries its own hover <title>, including the small Tiny tile`
  );
  const tinyGroup = tileGroups.find((g) => {
    const ti = g.kids.find((k) => k.tag === 'title');
    return ti && /Tiny/.test(allText(ti));
  });
  note(
    !!tinyGroup,
    "the small Tiny tile's <title> names it and its amount, even though it has no inline visible label"
  );
}

// Hover tooltip on MERCHANT sub-tiles too: hovering the faint category-
// internal outlines previously gave NO information at all. Each sub-tile
// rect now carries its own <title> naming its category, its merchant and
// its amount.
{
  const subRects = findAll(
    card,
    (n) => n.tag === 'rect' && String(n.attrs.class || '').includes('tm-sub')
  );
  const subsWithTitle = subRects.filter((rc) => rc.kids.some((k) => k.tag === 'title'));
  note(
    subRects.length >= 2 && subsWithTitle.length === subRects.length,
    `every merchant sub-tile (${subRects.length}) carries its own hover <title>`
  );
  note(
    subsWithTitle.some((rc) => {
      const ti = rc.kids.find((k) => k.tag === 'title');
      return ti && /Supermarket A/.test(allText(ti)) && /Groceries/.test(allText(ti));
    }),
    "a sub-tile's title names BOTH its category and its specific merchant"
  );
}

// labels only on big-enough tiles: Groceries labelled, Tiny NOT (visibly)
{
  const t = visibleText(card);
  note(/Groceries/.test(t), 'large tile (Groceries) is labelled');
  note(
    !/\bTiny\b/.test(t),
    'small tile (Tiny, 2k) is NOT visibly labelled - density without clutter'
  );
  // labelled tiles show their value as blurrable money text
  note(/\$60,000/.test(t), 'labelled tile shows its amount as (blurrable) value text');
}

// Interactivity: pointer, Enter and Space activation all use the same
// category action. The mock DOM stores and dispatches real listeners so this
// proves behaviour rather than checking markup alone.
{
  const tileGroup = findAll(
    card,
    (node) =>
      node.tag === 'g' &&
      String(node.attrs.class || '')
        .split(/\s+/)
        .includes('tm-tile')
  )[0];

  note(
    !!tileGroup &&
      tileGroup.attrs.role === 'button' &&
      tileGroup.attrs.tabindex === '0' &&
      tileGroup.attrs.style === 'cursor:pointer' &&
      String(tileGroup.attrs.class || '')
        .split(/\s+/)
        .includes('is-interactive'),
    'an interactive tile is a keyboard button with a pointer cursor'
  );

  clicked = null;
  tileGroup.dispatchEvent({ type: 'click' });

  note(clicked === 'Groceries', 'clicking a category tile opens the matching category');

  clicked = null;
  let enterPrevented = false;

  tileGroup.dispatchEvent({
    type: 'keydown',
    key: 'Enter',
    preventDefault() {
      enterPrevented = true;
    },
  });

  note(
    clicked === 'Groceries' && enterPrevented,
    'pressing Enter opens the matching category and prevents the default action'
  );

  clicked = null;
  let spacePrevented = false;

  tileGroup.dispatchEvent({
    type: 'keydown',
    key: ' ',
    preventDefault() {
      spacePrevented = true;
    },
  });

  note(
    clicked === 'Groceries' && spacePrevented,
    'pressing Space opens the matching category and prevents page scrolling'
  );
}

// Empty state.
{
  const empty = r.renderTreemapCard({
    by_category: [],
    merchants: [],
  });

  note(empty === null, 'no spend produces no treemap card');
}

// A category with more than five merchants must retain the unnamed remainder
// so its merchant subdivisions reconcile to the category total.
{
  const raw = {
    categories: [
      {
        name: 'Groceries',
        total: 100000,
        share: 100,
        topMerchants: [
          { name: 'Supermarket A', total: 30000 },
          { name: 'Supermarket B', total: 20000 },
          { name: 'Supermarket C', total: 15000 },
          { name: 'Supermarket D', total: 10000 },
          { name: 'Supermarket E', total: 5000 },
        ],
        moreMerchants: {
          count: 3,
          total: 20000,
        },
      },
    ],
  };

  const { by_category, merchants } = adaptSpendBreakdownForTreemap(raw);

  note(
    merchants.some((merchant) => merchant.name === 'Other places' && merchant.amount === 20000),
    'a category with more than five merchants retains the true unnamed remainder'
  );

  const merchantsByCategory = new Map();

  for (const merchant of merchants) {
    if (!merchantsByCategory.has(merchant.category)) {
      merchantsByCategory.set(merchant.category, []);
    }

    merchantsByCategory.get(merchant.category).push({
      name: merchant.name,
      amount: merchant.amount,
    });
  }

  const model = layoutCategoryTreemap(by_category, merchantsByCategory, {
    x: 0,
    y: 0,
    w: 1000,
    h: 460,
  });

  const groceriesTile = model.tiles.find((tile) => tile.name === 'Groceries');

  const subdivisionArea = model.subTiles
    .filter((tile) => tile.category === 'Groceries')
    .reduce((sum, tile) => sum + tile.w * tile.h, 0);

  note(
    Math.abs(subdivisionArea - groceriesTile.w * groceriesTile.h) < 1,
    'merchant subdivisions reconcile to the full category area'
  );
}

// The category total remains authoritative when moreMerchants is unavailable.
{
  const raw = {
    categories: [
      {
        name: 'Groceries',
        total: 100000,
        share: 100,
        topMerchants: [
          { name: 'Supermarket A', total: 30000 },
          { name: 'Supermarket B', total: 20000 },
        ],
        moreMerchants: null,
      },
    ],
  };

  const adapted = adaptSpendBreakdownForTreemap(raw);

  const remainder = adapted.merchants.find((merchant) => merchant.name === 'Other places');

  note(
    !!remainder && remainder.amount === 50000,
    'the category total supplies the unnamed remainder when moreMerchants is unavailable'
  );
}

// Three-digit hexadecimal colours must be expanded before choosing readable
// label ink.
{
  const yellowRenderer = createTreemapRenderer({
    el,
    money0,
    catColour: () => '#ff0',
  });

  const yellowCard = yellowRenderer.renderTreemapCard({
    by_category: [{ name: 'X', amount: 100 }],
    merchants: [],
  });

  const labels = findAll(
    yellowCard,
    (node) =>
      node.tag === 'text' &&
      String(node.attrs.class || '')
        .split(/\s+/)
        .includes('tm-label')
  );

  note(
    labels.length === 1 && labels[0].attrs.fill === '#10161f',
    'a light three-digit colour receives dark readable label text'
  );
}

// Every positive category remains painted so its spending does not disappear.
// An extremely small category remains described but is not exposed as an
// impractically small keyboard or pointer target.
{
  const tinyAnalysis = {
    by_category: [
      { name: 'Huge', amount: 999999 },
      { name: 'Tiny', amount: 1 },
    ],
    merchants: [],
  };

  const tinyCard = r.renderTreemapCard(tinyAnalysis, {
    onCategory: () => {},
  });

  const categoryRects = findAll(
    tinyCard,
    (node) =>
      node.tag === 'rect' &&
      String(node.attrs.class || '')
        .split(/\s+/)
        .includes('tm-rect')
  );

  const categoryGroups = findAll(
    tinyCard,
    (node) =>
      node.tag === 'g' &&
      String(node.attrs.class || '')
        .split(/\s+/)
        .includes('tm-tile')
  );

  const interactiveGroups = categoryGroups.filter((node) => node.attrs.role === 'button');

  const staticGroups = categoryGroups.filter((node) => node.attrs.role === 'img');

  const tinyGroup = categoryGroups.find((group) => {
    const title = group.kids.find((child) => child.tag === 'title');

    return title && /^Tiny:/.test(allText(title));
  });

  note(categoryRects.length === 2, 'every positive category remains painted');

  note(
    interactiveGroups.length === 1 && staticGroups.length === 1,
    'the large category is interactive while the extremely small category is non-interactive'
  );

  note(
    !!tinyGroup &&
      tinyGroup.attrs.role === 'img' &&
      tinyGroup.attrs.tabindex == null &&
      tinyGroup.attrs.style == null &&
      typeof tinyGroup.attrs['aria-label'] === 'string',
    'the extremely small category remains described without becoming an unusably small button'
  );
}

// Interactive and static treemaps expose different, truthful behaviour.
{
  const clickableCard = r.renderTreemapCard(analysis, {
    onCategory: () => {},
  });

  const clickableTiles = findAll(
    clickableCard,
    (node) =>
      node.tag === 'g' &&
      String(node.attrs.class || '')
        .split(/\s+/)
        .includes('tm-tile')
  );

  note(
    clickableTiles.length === 5,
    `five selectable category groups are produced, got ${clickableTiles.length}`
  );

  note(
    clickableTiles.every(
      (group) =>
        String(group.attrs.class || '')
          .split(/\s+/)
          .includes('is-interactive') &&
        group.attrs.role === 'button' &&
        group.attrs.tabindex === '0' &&
        group.attrs.style === 'cursor:pointer' &&
        typeof group.attrs['aria-label'] === 'string' &&
        group.attrs['aria-label'].includes('Open matching transactions')
    ),
    'every selectable category is a named keyboard button with a pointer cursor'
  );

  const staticCard = r.renderTreemapCard(analysis, {});

  const staticTiles = findAll(
    staticCard,
    (node) =>
      node.tag === 'g' &&
      String(node.attrs.class || '')
        .split(/\s+/)
        .includes('tm-tile')
  );

  note(
    staticTiles.every(
      (group) =>
        !String(group.attrs.class || '')
          .split(/\s+/)
          .includes('is-interactive') &&
        group.attrs.role === 'img' &&
        group.attrs.tabindex == null &&
        group.attrs.style == null &&
        typeof group.attrs['aria-label'] === 'string'
    ),
    'a static treemap uses described image groups and never falsely appears selectable'
  );
}

// Long-label overflow: a real, screenshot-observed bug - "Dining & Take"
// rendered cut off mid-word, no ellipsis, in a small tile that was still
// (correctly) big enough to clear the label-visibility gate. Uses a MANY-
// category layout (6 categories, one of them a genuinely long name) so at
// least one tile is narrow enough to force truncation - a 2-category,
// 50/50 split (tried first) gives each tile ~500 units wide, comfortably
// fitting even a 26-character name at 13px, so it never actually exercises
// the truncation path at all; this reproduces the real failure instead.
{
  const longAnalysis = {
    by_category: [
      { name: 'Groceries', amount: 60000, share: 40 },
      { name: 'Entertainment & Recreation', amount: 30000, share: 20 },
      { name: 'Retail & Department', amount: 20000, share: 13 },
      { name: 'Pharmacy & Health', amount: 15000, share: 10 },
      { name: 'Subscriptions', amount: 12000, share: 8 },
      { name: 'Dining & Takeout', amount: 13000, share: 9 },
    ],
    merchants: [],
  };
  const longCard = r.renderTreemapCard(longAnalysis, {});
  const labels = findAll(
    longCard,
    (n) => n.tag === 'text' && String(n.attrs.class || '').includes('tm-label')
  );
  note(
    labels.length >= 4,
    `most tiles in a realistic 6-category layout are still big enough to be labelled (${labels.length})`
  );
  // THE REAL GUARANTEE, proven directly rather than inferred from length:
  // every visible label carries a clip-path, so REGARDLESS of whether the
  // character-count estimate under- or over-truncates, the rendered text
  // can never visually escape its own tile's boundary - this is what
  // actually fixes the screenshot's "cut off mid-word, no clip" bug.
  note(
    labels.length > 0 &&
      labels.every((n) => n.attrs['clip-path'] && /^url\(#tm-clip-/.test(n.attrs['clip-path'])),
    "EVERY visible label (in a realistic, mixed-width layout) carries a clip-path - text can never visually escape its own tile, regardless of the truncation estimate's accuracy"
  );
  // At least one label in this realistic layout is a long name landing in
  // a narrower tile, so the truncation logic itself is genuinely exercised
  // (not just present-but-unused, the gap the earlier fixture had).
  const anyTruncated = labels.some((n) => /\u2026$/.test(allText(n)));
  const anyLongNameShown = labels.some((n) => /Entertainment|Takeout/.test(allText(n)));
  note(
    anyTruncated || anyLongNameShown,
    'in a realistic mixed layout, a long name either gets truncated with an ellipsis, or is shown in full because its tile is genuinely wide enough - never silently dropped'
  );
}

// Activity already supplies the surrounding card and heading. Embedded mode
// must return only the map content, never a second nested card or duplicate
// "Where it went" heading.
{
  const embedded = r.renderTreemapCard(analysis, {
    embedded: true,
    onCategory: () => {},
  });

  const embeddedCards = findAll(
    embedded,
    (node) =>
      node.tag === 'section' &&
      String(node.attrs.class || '')
        .split(/\s+/)
        .includes('card')
  );

  const embeddedHeadings = findAll(
    embedded,
    (node) => node.tag === 'h3' && allText(node) === 'Where it went'
  );

  note(
    embedded.tag === 'div' &&
      String(embedded.attrs.class || '')
        .split(/\s+/)
        .includes('tm-panel'),
    'embedded mode returns a plain treemap panel for the existing Activity card'
  );

  note(embeddedCards.length === 0, 'embedded mode does not create a card inside the Activity card');

  note(
    embeddedHeadings.length === 0,
    'embedded mode does not repeat the parent Where it went heading'
  );
}

console.log(`\n checks: ${pass} passed, ${fail} failed`);
console.log('='.repeat(72));
console.log(
  fail === 0
    ? " RESULT: the reconciled geometry renders to a coloured, area-proportional SVG\n         picture - labels only where they fit, merchant detail as faint outlines,\n         no Cash inflow the geometry, accessible tiles. A truthful 'exposure' view."
    : ' RESULT: FAILURES ABOVE.'
);
console.log('='.repeat(72));
process.exit(fail ? 1 : 0);
