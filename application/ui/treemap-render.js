/*
 * treemap-render.js  -  renders the PROVEN treemap geometry (treemap-layout.js)
 * as one complete rectangle per category, area proportional to spend, coloured
 * by category. A picture of "where you're exposed", not a list, and not a
 * table hiding underneath one.
 *
 * TEXT LIVES IN HTML, NOT SVG - real CSS pixels, never scaled with the
 * picture's own zoom level (see the earlier redesign's own reasoning).
 *
 * COLOUR: catColour is the app-wide identity mapping (category picker dots,
 * tags elsewhere) and is NEVER altered here. Within a SINGLE render, though,
 * two categories can still hash to the same colour by coincidence - a real,
 * observed bug (Retail & Department and Pharmacy & Health rendering
 * identically). resolveDistinctTileFills checks the categories actually
 * present in THIS render against each other and deterministically shifts any
 * collision to a distinct hue, so identity is never ambiguous on screen, without
 * touching the global colour contract other surfaces rely on.
 *
 * TEXT TIERING is decided from the tile's REAL, MEASURED rendered pixel size
 * (via ResizeObserver) and the REAL measured width of the actual candidate
 * strings (via canvas text measurement against this app's own computed font -
 * not an assumed font stack, not a character-count estimate). Preference
 * order: full name (1 line) -> full name wrapped at a real word boundary (2
 * lines) -> a deliberately short form (first word, or a clean few-letter
 * fragment - never CSS's arbitrary ellipsis cut) -> if nothing legible fits,
 * colour and hover ONLY. There is no list-shaped fallback: a tile's full
 * identity is always available via its own title/aria-label regardless of
 * what is visibly drawn on it, and every tile remains clickable regardless of
 * size - the list this file used to fall back to has been removed entirely,
 * so the picture (plus hover, plus click-through) is the whole experience.
 *
 * Owns no spend analysis. Screen-scoped; never prints.
 */
import { requireCtx, isPrivacyMode } from '../core/shared-helpers.js';
import { layoutTreemap } from '../analysis/treemap-layout.js';
import { describeComparisonText, comparisonTone } from '../analysis/spend-breakdown.js';

const SVGNS = 'http://www.w3.org/2000/svg';

// ---------------------------------------------------------------------
// Colour conversion + collision resolution - pure, no DOM, directly
// unit-testable.
// ---------------------------------------------------------------------

export function hexToHsl(hex) {
  let h = String(hex || '').replace('#', '');
  if (h.length === 3)
    h = h
      .split('')
      .map((c) => c + c)
      .join('');
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b);
  let hue = 0,
    sat = 0;
  const light = (max + min) / 2;
  const d = max - min;
  if (d !== 0) {
    sat = light > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === r) hue = (g - b) / d + (g < b ? 6 : 0);
    else if (max === g) hue = (b - r) / d + 2;
    else hue = (r - g) / d + 4;
    hue *= 60;
  }
  return { h: hue, s: sat, l: light };
}

export function hslToHex(h, s, l) {
  h = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let r = 0,
    g = 0,
    b = 0;
  if (h < 60) {
    r = c;
    g = x;
    b = 0;
  } else if (h < 120) {
    r = x;
    g = c;
    b = 0;
  } else if (h < 180) {
    r = 0;
    g = c;
    b = x;
  } else if (h < 240) {
    r = 0;
    g = x;
    b = c;
  } else if (h < 300) {
    r = x;
    g = 0;
    b = c;
  } else {
    r = c;
    g = 0;
    b = x;
  }
  const toHex = (v) =>
    Math.round((v + m) * 255)
      .toString(16)
      .padStart(2, '0');
  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

// Rotates a hex colour's hue by a fixed step per collision attempt, keeping
// its lightness/saturation so the result still reads as part of this app's
// palette, just genuinely distinct from whatever it collided with.
// Deterministic: the same base colour and attempt number always produce the
// same result, so a collision resolves identically on every render.
export function shiftHue(hex, attempt) {
  const { h, s, l } = hexToHsl(hex);
  return hslToHex(h + attempt * 47, s, l);
}

// Checks the categories genuinely present in ONE render against each other
// and reassigns any literal duplicate colour to a distinct hue. Does not
// alter catColour itself, and does not attempt full perceptual-distance
// separation (a "genuinely different-looking" guarantee, beyond "not
// identical", would need a further pass - noted, not solved here) - it
// guarantees no two categories on screen together share the same resolved
// colour, which is the actual reported failure.
export function resolveDistinctTileFills(names, catColour) {
  const used = new Set();
  const result = new Map();

  for (const raw of names) {
    const name = String(raw || '').trim();
    if (!name || result.has(name)) continue;

    let candidate = catColour(name);
    let attempt = 0;
    while (used.has(String(candidate).toLowerCase()) && attempt < 8) {
      attempt++;
      candidate = shiftHue(catColour(name), attempt);
    }

    used.add(String(candidate).toLowerCase());
    result.set(name, candidate);
  }

  return result;
}

// ---------------------------------------------------------------------
// Text-fitting logic - pure given a measure(text) => widthPx function, so
// it is directly testable with a fake measurer, independent of canvas/DOM.
// ---------------------------------------------------------------------

// Splits a name into two lines at every possible word boundary, best split
// first (the one that balances the two lines most evenly). Pure - returns
// candidate [firstLine, secondLine] pairs in preference order for the caller
// to test against the LIVE element. A single word with no space yields no
// candidates, which correctly means "cannot wrap".
export function twoLineCandidates(name) {
  const spaces = [];
  for (let i = 0; i < name.length; i++) if (name[i] === ' ') spaces.push(i);
  if (!spaces.length) return [];

  return spaces
    .map((i) => {
      const first = name.slice(0, i).trim();
      const second = name.slice(i + 1).trim();
      return {
        first,
        second,
        imbalance: Math.abs(first.length - second.length),
      };
    })
    .filter((c) => c.first && c.second)
    .sort((a, b) => a.imbalance - b.imbalance)
    .map((c) => [c.first, c.second]);
}

// ---------------------------------------------------------------------
// Adapts spend-breakdown.js's raw result shape into the generic
// {by_category, merchants} shape renderTreemapCard expects. Reconciliation
// note unchanged from the earlier round: the category TOTAL is the
// authority, never the sum of named merchants, so a missing/stale
// moreMerchants object can never silently misrepresent the total.
// ---------------------------------------------------------------------
export function adaptSpendBreakdownForTreemap(raw) {
  const categories = Array.isArray(raw && raw.categories) ? raw.categories : [];
  const by_category = [];
  const merchants = [];

  for (const cat of categories) {
    const category = String((cat && cat.name) || '').trim();
    const amount = Number(cat && cat.total);
    if (!category || !Number.isFinite(amount) || amount <= 0) continue;

    by_category.push({
      name: category,
      amount,
      share: Number.isFinite(Number(cat.share)) ? Number(cat.share) : null,
      comparison: cat.comparison || null,
    });

    let namedTotal = 0;
    for (const mch of Array.isArray(cat.topMerchants) ? cat.topMerchants : []) {
      const name = String((mch && mch.name) || '').trim();
      const merchantAmount = Number(mch && mch.total);
      if (!name || !Number.isFinite(merchantAmount) || merchantAmount <= 0) continue;
      merchants.push({ name, amount: merchantAmount, category });
      namedTotal += merchantAmount;
    }

    const remainder = Math.max(0, amount - namedTotal);
    if (remainder > 0.005) {
      merchants.push({ name: 'Other places', amount: remainder, category });
    }
  }

  return { by_category, merchants };
}

// ---------------------------------------------------------------------
// DOM-dependent rendering.
// ---------------------------------------------------------------------

export function createTreemapRenderer(ctx) {
  requireCtx(ctx, ['el', 'money0', 'catColour'], 'createTreemapRenderer');
  const { el, money0, catColour } = ctx;
  const VIEW = { w: 1000, h: 560 };

  function readableInk(hex) {
    let h = String(hex || '').replace('#', '');
    if (h.length === 3)
      h = h
        .split('')
        .map((c) => c + c)
        .join('');
    if (h.length < 6) return '#ffffff';
    const r = parseInt(h.slice(0, 2), 16);
    const g = parseInt(h.slice(2, 4), 16);
    const b = parseInt(h.slice(4, 6), 16);
    const lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    return lum > 0.55 ? '#10161f' : '#ffffff';
  }


  function setLines(labelSpan, lines) {
    labelSpan.textContent = '';
    lines.forEach((line, i) => {
      if (i > 0) labelSpan.appendChild(document.createElement('br'));
      labelSpan.appendChild(document.createTextNode(line));
    });
  }

  // Does the label span currently overflow its own tile's usable box? Read
  // directly from the live, rendered element - no font modelling, no
  // letter-spacing gap, no stale cache. scrollWidth/scrollHeight are the
  // element's real content extent; clientWidth/clientHeight are its real
  // padding-box. A 1px tolerance absorbs sub-pixel rounding.
  function labelOverflows(labelSpan) {
    return (
      labelSpan.scrollWidth > labelSpan.clientWidth + 1 ||
      labelSpan.scrollHeight > labelSpan.clientHeight + 1
    );
  }

  // The whole contract, made simple: show the COMPLETE name - on one line if
  // it fits, wrapped to two lines if that is what it takes - or show NOTHING.
  // No short forms, no truncation, no fragments. A visible label is always
  // the real, whole category name; a tile too small for it is a clean colour
  // block whose identity comes from hover (desktop) or tap-through (mobile),
  // both already wired. Measured against the live element, so it is correct
  // by construction and re-runs correctly on every ResizeObserver pass.
  function layoutTileLabel(record) {
    const { tileEl, labelSpan, valueSpan, trendSpan, category, amountText } = record;

    if (valueSpan) {
      valueSpan.textContent = '';
      valueSpan.style.display = 'none';
    }
    if (trendSpan) trendSpan.style.display = 'none';

    // 1) Full name, one line.
    labelSpan.style.whiteSpace = 'nowrap';
    setLines(labelSpan, [category]);
    let shown = !labelOverflows(labelSpan);

    // 2) Full name, wrapped to two lines at a real word boundary.
    if (!shown) {
      labelSpan.style.whiteSpace = 'normal';
      for (const pair of twoLineCandidates(category)) {
        setLines(labelSpan, pair);
        if (!labelOverflows(labelSpan)) {
          shown = true;
          break;
        }
      }
    }

    // 3) Neither fit: colour only. Recorded so renderTreemapPicture can fold
    //    this category into the aggregate "Other categories" tile.
    if (!shown) {
      labelSpan.textContent = '';
      record.hasLabel = false;
      return;
    }
    record.hasLabel = true;

    // The amount is additive: shown only if it fits without pushing the name out.
    if (valueSpan) {
      valueSpan.textContent = amountText;
      valueSpan.style.display = 'block';
      if (tileEl.scrollHeight > tileEl.clientHeight + 1) {
        valueSpan.textContent = '';
        valueSpan.style.display = 'none';
      }
    }

    // The trend marker is additive too; identity always outranks it.
    if (trendSpan) {
      trendSpan.style.display = 'block';
      if (labelOverflows(labelSpan) || tileEl.scrollWidth > tileEl.clientWidth + 1) {
        trendSpan.style.display = 'none';
      }
    }
  }

  function renderTreemapPicture(tiles, onTileClick) {
    const interactive = typeof onTileClick === 'function';
    const wrap = el('div', { class: 'tm-wrap' });
    let records = [];
    let aggregated = false;

    // Builds the SVG + HTML overlay for a given tile list. Called once with
    // the original categories, and (at most) once more with an aggregated
    // set once measurement shows some categories cannot carry a full name.
    function paint(tileList) {
      wrap.textContent = '';
      records = [];
      // Read fresh on every paint() call (initial render, and the possible
      // re-paint from aggregateInto below) rather than passed in from
      // renderTreemapCard's own scope, which this function cannot see -
      // that mismatch was the actual cause of a ReferenceError on every
      // treemap render, privacy mode on or off.
      const privacyOn = isPrivacyMode();

      const svgRoot = document.createElementNS(SVGNS, 'svg');
      svgRoot.setAttribute('viewBox', `0 0 ${VIEW.w} ${VIEW.h}`);
      svgRoot.setAttribute('preserveAspectRatio', 'none');
      svgRoot.setAttribute('class', 'tm-svg');
      svgRoot.setAttribute('aria-hidden', 'true');

      const overlay = el('div', { class: 'tm-overlay' });
      const distinctFills = resolveDistinctTileFills(
        tileList.map((t) => t.name),
        catColour
      );

      for (const tile of tileList) {
        if (!tile || tile.w <= 0 || tile.h <= 0) continue;

        const category = String(tile.name || 'Unlabelled category').trim();
        const isAggregate = tile.isAggregate === true;
        const fill = distinctFills.get(category) || catColour(category);
        const amountText = privacyOn ? 'amount hidden' : money0(tile.amount);
        const comparison = isAggregate ? null : tile.comparison || null;
        const tone = comparisonTone(comparison);
        const comparisonText = describeComparisonText(comparison, money0);
        const ink = readableInk(fill);

        const rect = document.createElementNS(SVGNS, 'rect');
        rect.setAttribute('x', tile.x);
        rect.setAttribute('y', tile.y);
        rect.setAttribute('width', Math.max(0, tile.w));
        rect.setAttribute('height', Math.max(0, tile.h));
        rect.setAttribute('fill', fill);
        rect.setAttribute('class', 'tm-rect');
        svgRoot.appendChild(rect);

        const leftPct = (tile.x / VIEW.w) * 100;
        const topPct = (tile.y / VIEW.h) * 100;
        const widthPct = (tile.w / VIEW.w) * 100;
        const heightPct = (tile.h / VIEW.h) * 100;

        // The aggregate tile's hover names every category folded into it, so
        // the bucket is honest about its own contents; nothing is hidden.
        const titleText = isAggregate
          ? `${category}: ${amountText}. Includes ${(tile.members || []).map((m) => m.name).join(', ')}.`
          : comparisonText
            ? `${category}: ${amountText}. ${comparisonText}`
            : `${category}: ${amountText}`;

        // The aggregate tile is NOT interactive: it stands for several
        // categories, and the shared drill only filters to ONE, so a click
        // could not honestly narrow to "these several". It is a labelled,
        // reconciling summary block, not a link.
        const tileInteractive = interactive && !isAggregate;

        const labelSpan = el('span', { class: 'tm-label' });
        const valueSpan = el('span', { class: 'tm-value money' });
        const trendSpan =
          tone !== 'neutral'
            ? el('span', {
                class: `tm-trend tone-${tone}`,
                'aria-hidden': 'true',
              })
            : null;

        const tileEl = el(tileInteractive ? 'button' : 'div', {
          class: 'tm-tile' + (tileInteractive ? ' is-interactive' : ''),
          type: tileInteractive ? 'button' : null,
          style: `left:${leftPct}%;top:${topPct}%;width:${widthPct}%;height:${heightPct}%;color:${ink};`,
          title: titleText,
          role: tileInteractive ? null : 'img',
          'aria-label': tileInteractive ? `${titleText}. Open matching transactions.` : titleText,
        });

        tileEl.append(labelSpan, valueSpan);
        if (trendSpan) tileEl.append(trendSpan);
        if (tileInteractive) tileEl.onclick = () => onTileClick(category);

        overlay.append(tileEl);

        records.push({
          category,
          amountText,
          isAggregate,
          tileEl,
          labelSpan,
          valueSpan,
          trendSpan,
          hasLabel: false,
        });
      }

      wrap.append(svgRoot, overlay);
    }

    // Folds every colour-only category into ONE "Other categories" tile that
    // is large enough to label and carries their summed amount, so the
    // picture still reconciles to the full total - never dropping spend, only
    // combining what is too small to name individually.
    function aggregateInto(smallNames) {
      const smallSet = new Set(smallNames);
      const kept = [];
      const members = [];
      let bucketTotal = 0;

      for (const t of tiles) {
        if (smallSet.has(String(t.name || '').trim())) {
          members.push({ name: t.name, amount: t.amount });
          bucketTotal += Number(t.amount) || 0;
        } else {
          kept.push({
            name: t.name,
            amount: t.amount,
            share: t.share,
            comparison: t.comparison,
          });
        }
      }

      kept.push({
        name: 'Other categories',
        amount: bucketTotal,
        isAggregate: true,
        members,
      });
      return layoutTreemap(kept, { x: 0, y: 0, w: VIEW.w, h: VIEW.h });
    }

    function relayout() {
      const box = wrap.getBoundingClientRect();
      if (!box.width || !box.height) return;

      for (const record of records) layoutTileLabel(record);

      // One-shot aggregation: after the first real measurement pass, if two
      // or more categories ended up colour-only, combine them. The flag makes
      // this happen at most once - the "Other" tile itself is never
      // re-bucketed and there is no measure/rebuild loop. A LONE colour-only
      // tile is left as-is: a one-item "Other" would imply a plurality that
      // is not there, worse than a single clean colour block.
      if (!aggregated) {
        const colourOnly = records.filter((r) => !r.hasLabel && !r.isAggregate);
        if (colourOnly.length >= 2) {
          aggregated = true;
          paint(aggregateInto(colourOnly.map((r) => r.category)));
          relayout();
        }
      }
    }

    paint(tiles);

    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(relayout).observe(wrap);
    } else {
      queueMicrotask(relayout);
    }

    return wrap;
  }

  function renderTreemapCard(analysis, opts = {}) {
    const cats = (Array.isArray(analysis && analysis.by_category) ? analysis.by_category : [])
      .map((category) => ({
        ...category,
        name: String((category && category.name) || '').trim(),
        amount: Number(category && category.amount),
      }))
      .filter(
        (category) => category.name && Number.isFinite(category.amount) && category.amount > 0
      );

    if (!cats.length) return null;

    // Privacy mode: tile AREA is proportional to spend, so a dominant tile
    // still says "this is clearly the biggest category" even with every
    // printed number blurred - the same double-encoding the flow chart's
    // bars have (see glass.css's own comment on that fix). Unlike the flow
    // chart, tile width/height are real SVG attributes set from layoutTreemap's
    // own computed geometry, not CSS-driven, so this has to happen here,
    // JS-side, rather than as a CSS override. Every tile is laid out from an
    // EQUAL amount instead of the real one while privacy is on - identity,
    // category grouping, and every other field (share, comparison) pass
    // through untouched via the spread below - then each tile's real amount
    // is restored afterwards purely for its printed label text, which the
    // existing .tm-value blur (glass.css) already masks on screen exactly
    // like every other figure.
    const privacyOn = isPrivacyMode();
    const layoutCats = privacyOn ? cats.map((c) => ({ ...c, amount: 1 })) : cats;
    const tiles = layoutTreemap(layoutCats, { x: 0, y: 0, w: VIEW.w, h: VIEW.h });
    if (privacyOn) {
      const realAmounts = new Map(cats.map((c) => [c.name, c.amount]));
      for (const t of tiles) {
        if (realAmounts.has(t.name)) t.amount = realAmounts.get(t.name);
      }
    }
    const interactive = typeof opts.onCategory === 'function';
    const embedded = opts.embedded === true;

    const container = el(embedded ? 'div' : 'section', {
      class: embedded ? 'tm-panel' : 'card',
      'aria-label': 'Spending by category map',
    });

    if (!embedded) {
      container.append(
        el('div', { class: 'card-head' }, el('h3', { class: 'card-title' }, 'Where it went'))
      );
    }

    container.append(renderTreemapPicture(tiles, interactive ? opts.onCategory : null));

    // Honesty: "its size shows how much was spent there" would be a false
    // claim while every tile has deliberately been made the same size for
    // privacy - the caption itself has to change, not just the picture.
    container.append(
      el(
        'p',
        { class: 'muted small tm-help' },
        privacyOn
          ? interactive
            ? 'Each block is one category. Amounts and relative sizes are hidden while privacy mode is on. Select a block to open its transactions.'
            : 'Each block is one category. Amounts and relative sizes are hidden while privacy mode is on.'
          : interactive
            ? 'Each block is one category. Its size shows how much was spent there. Select a block to open its transactions.'
            : 'Each block is one category. Its size shows how much was spent there.'
      )
    );

    return container;
  }

  return { renderTreemapCard };
}
