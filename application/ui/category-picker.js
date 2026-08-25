/*
 * category-picker.js  -  the reversible category-correction group.
 *
 * Stage 3a of the split. These three functions were lifted verbatim from
 * bootUI in app.js and wrapped in a factory that receives the bootUI members
 * they use via ctx, rather than closing over them. Nothing inside the bodies
 * was renamed; only where a name comes from changed. Two sanctioned line edits
 * replace the private pickerEl access, mirroring Stage 2: openCategoryPicker
 * now calls openOverlay(overlay) to show its modal, and setCategory reads the
 * live overlay through getPickerEl() instead of the bare pickerEl variable.
 *
 * setCategory stays internal (only openCategoryPicker calls it); the factory
 * returns just openCategoryPicker and dismissReview, the two names app.js
 * still calls from txTable and renderAttention.
 */

import { orderCategoriesForPicker } from '../analysis/reporting.js';
import {
  merchantRuleKeyFromDescription,
  upsertCategoryRule,
} from '../../settings/category-rules.js';
import { requireCtx } from '../core/shared-helpers.js';
import { transactionIdentity } from '../statements/read-statements.js';
import { Store } from '../core/storage.js';
import { makeSplit, validateSplit, balanceParts } from '../analysis/transaction-splits.js';
import { spendableCategoryNames } from '../analysis/spendable-categories.js';
import { tagAdd, tagRemove } from '../analysis/tag-totals.js';

export function createCategoryPicker(ctx) {
  requireCtx(
    ctx,
    [
      'state',
      'el',
      '$',
      'toast',
      'render',
      'closePicker',
      'openModal',
      'getPickerEl',
      'persist',
      'persistRules',
      'catColour',
      'isReview',
      'trackUsage',
    ],
    'createCategoryPicker'
  );
  const {
    state,
    el,
    $,
    toast,
    render,
    closePicker,
    openModal,
    getPickerEl,
    persist,
    persistRules,
    catColour,
    isReview,
    trackUsage,
  } = ctx;

  function openCategoryPicker(row) {
    closePicker();
    const cats = state.cfg.categories.map((c) => c.name);
    // Categories already present in the current data, most-used first, so the
    // most likely corrections sit near the top (ordering only, no stored state).
    const counts = {};
    for (const r of state.rows) counts[r.category] = (counts[r.category] || 0) + 1;
    const present = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
    const ordered = orderCategoriesForPicker(cats, row.category, present);
    // Show the SAME canonical clean name the transaction list shows, so the
    // picker title and scope line read "Amazon", not "Www.Amazon* 113-217508".
    // Matching still keys on row.raw_description below, so behaviour is unchanged.
    const place = row.displayName || row.description.split(',')[0].replace(/\s+/g, ' ').trim();
    const list = el('div', { class: 'picker-list' });
    for (const c of ordered) {
      const label = isReview(c) ? 'To review' : c;
      list.append(
        el(
          'button',
          {
            class: 'picker-item' + (c === row.category ? ' current' : ''),
            dataset: { name: label.toLowerCase() },
            onclick: () => setCategory(row, c),
          },
          el('span', { class: 'cat-dot', style: `background:${catColour(c)}` }),
          label,
          c === row.category ? el('span', { class: 'muted small' }, ' current') : null
        )
      );
    }
    // Type-to-filter: correcting a category is the most repeated action, and the
    // list is long on a phone. Filtering is case-insensitive on the shown name.
    const noMatch = el(
      'div',
      { class: 'picker-empty muted small', hidden: '' },
      'No matching category.'
    );
    const filter = el('input', {
      type: 'text',
      class: 'picker-filter',
      placeholder: 'Filter categories…',
      'aria-label': 'Filter categories',
      oninput: (e) => {
        const q = e.target.value.trim().toLowerCase();
        let visible = 0;
        for (const item of list.children) {
          const hit = !q || item.dataset.name.includes(q);
          item.hidden = !hit;
          if (hit) visible++;
        }
        noMatch.hidden = visible > 0;
      },
    });
    const scopeOnly = el(
      'label',
      { class: 'scope' },
      el('input', { type: 'radio', name: 'scope', value: 'one', checked: '' }),
      ' Only this transaction'
    );
    const scopeAll = el(
      'label',
      { class: 'scope' },
      el('input', { type: 'radio', name: 'scope', value: 'all' }),
      ` Every “${place}” charge, now and in future`
    );
    const box = el(
      'div',
      { class: 'picker', role: 'dialog', 'aria-label': 'Change category' },
      el('div', { class: 'picker-head' }, `File “${place}” as`),
      filter,
      list,
      noMatch,
      el('div', { class: 'picker-scope' }, scopeOnly, scopeAll),
      el(
        'div',
        { class: 'picker-actions' },
        el(
          'button',
          { class: 'btn sm ghost', onclick: () => openSplitEditor(row) },
          'Split across categories'
        ),
        el('button', { class: 'btn sm ghost', onclick: closePicker }, 'Cancel')
      )
    );
    openModal(box);
  }

  /* ===========================================================================
   * Split editor (B3b): distribute ONE transaction across categories. Uses the
   * proven primitives (makeSplit / validateSplit / balanceParts) so the parts
   * always sum to the transaction's own amount before saving - an invalid split
   * is refused with a plain message, never silently stored. Only spendable
   * categories are offered (Improvement 3: you can't sensibly file part of a
   * purchase as Card Payment or a fee). Seeds from the current category (least
   * typing) or from an existing split (edit-in-place). "Clear split" reverts to
   * a single category. The split store is the ONLY thing written; the row, its
   * count, and the grand total are untouched by construction.
   * ======================================================================== */
  function openSplitEditor(row) {
    closePicker();
    const target = Math.round(Math.abs(Number(row.amount) || 0) * 100) / 100;
    const place = row.displayName || row.description.split(',')[0].replace(/\s+/g, ' ').trim();
    const spendable = spendableCategoryNames(state.cfg);
    const sym = (state.cfg.currency && state.cfg.currency.symbol) || '$';
    const money = (n) => sym + (Math.round((Number(n) || 0) * 100) / 100).toFixed(2);
    const existing = (state.transactionSplits || [])
      .filter((s) => s.txnId === row.id)
      .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')))[0];

    let parts =
      existing && existing.parts && existing.parts.length
        ? existing.parts.map((p) => ({
            category: p.category,
            amount: p.amount,
          }))
        : [
            { category: row.category, amount: target },
            { category: '', amount: 0 },
          ];

    const body = el('div', { class: 'picker-list' });
    const remainderLine = el('div', {
      class: 'muted small',
      style: 'padding:6px 0',
    });
    const sumOf = () =>
      Math.round(parts.reduce((s, p) => s + Math.abs(Number(p.amount) || 0), 0) * 100) / 100;
    const syncRemainder = () => {
      const rem = Math.round((target - sumOf()) * 100) / 100;
      remainderLine.textContent =
        rem === 0
          ? `Balanced - the parts add up to ${money(target)}.`
          : `Remainder: ${money(rem)} of ${money(target)} still to allocate.`;
    };
    const redraw = () => {
      body.innerHTML = '';
      parts.forEach((p, i) => {
        const sel = el(
          'select',
          {
            class: 'name-field',
            onchange: (e) => {
              parts[i].category = e.target.value;
            },
          },
          el('option', { value: '' }, '- category -'),
          ...spendable.map((c) =>
            el('option', { value: c, selected: c === p.category ? '' : null }, c)
          )
        );
        const amt = el('input', {
          type: 'number',
          class: 'name-field',
          min: '0',
          value: p.amount || '',
          oninput: (e) => {
            parts[i].amount = Number(e.target.value) || 0;
            syncRemainder();
          },
        });
        const rm =
          parts.length > 2
            ? el(
                'button',
                {
                  class: 'btn sm ghost',
                  onclick: () => {
                    parts.splice(i, 1);
                    redraw();
                  },
                },
                '\u00d7'
              )
            : null;
        body.append(el('div', { class: 'manage-actions' }, sel, amt, rm));
      });
      syncRemainder();
    };

    async function save() {
      const clean = parts.filter((p) => p.category && Number(p.amount) > 0);
      const split = makeSplit({ txnId: row.id, parts: clean });
      const v = validateSplit(split, target);
      if (!v.ok) {
        const msg =
          {
            'need-two-parts': 'Add at least two categories.',
            'part-missing-category': 'Every part needs a category.',
            'part-not-positive': 'Every part needs an amount above zero.',
            'duplicate-category': 'Choose each category only once.',
            'sum-mismatch': `The parts add up to ${money(v.sum)}, but the transaction is ${money(v.target)}. Adjust them to match.`,
          }[v.reason] || 'That split does not add up.';
        toast(msg);
        return;
      }
      const previous = (state.transactionSplits || []).filter((s) => s.txnId === row.id);

      // Write the replacement first. If this write fails, the existing split
      // remains intact. Once the new record exists, remove only older records.
      await Store.transactionSplits.put(split);
      for (const old of previous) {
        if (old.id !== split.id) await Store.transactionSplits.delete(old.id);
      }

      state.transactionSplits = await Store.transactionSplits.all();
      closePicker();
      render();
      toast(`Split “${place}” across ${clean.length} categories.`);
    }
    async function clearSplit() {
      for (const s of (state.transactionSplits || []).filter((s) => s.txnId === row.id))
        await Store.transactionSplits.delete(s.id);
      state.transactionSplits = await Store.transactionSplits.all();
      closePicker();
      render();
      toast('Split cleared.');
    }

    const box = el(
      'div',
      { class: 'picker', role: 'dialog', 'aria-label': 'Split transaction' },
      el('div', { class: 'picker-head' }, `Split “${place}” (${money(target)})`),
      body,
      el(
        'button',
        {
          class: 'btn sm ghost',
          onclick: () => {
            parts.push({ category: '', amount: 0 });
            redraw();
          },
        },
        '+ Add a category'
      ),
      el(
        'button',
        {
          class: 'btn sm ghost',
          onclick: () => {
            parts = balanceParts(parts, target);
            redraw();
          },
        },
        'Fill remainder in the last part'
      ),
      remainderLine,
      el(
        'div',
        { class: 'picker-actions' },
        el('button', { class: 'btn sm', onclick: save }, 'Save split'),
        existing
          ? el('button', { class: 'btn sm ghost', onclick: clearSplit }, 'Clear split')
          : null,
        el('button', { class: 'btn sm ghost', onclick: closePicker }, 'Cancel')
      )
    );
    redraw();
    openModal(box);
  }

  /* ===========================================================================
  * Custom label picker: attach/detach ONE transaction to any of the person's personal
  * custom labels. A transaction can belong to several labels at once (each label owns its
   * own txnIds list), so this is a CHECKBOX list, not a single choice. Uses the
   * proven pure writers (tagAdd/tagRemove, tag-totals.js), which return a NEW
   * tag record and never mutate - the SAME store (Store.tags) create/remove
   * already write to, so a tag's total (read by provenModels.tags via the
   * txnIds join) populates the moment a transaction is added, with no other
   * change to the row, its category, or any total. When no tags exist yet, this
   * points the person to the Analysis tab's Tags card to make one first.
   * ======================================================================== */
  function openTagPicker(row) {
    closePicker();
    const place =
      row.displayName || (row.description || '').split(',')[0].replace(/\s+/g, ' ').trim();
    const tags = state.tags || [];

    if (!tags.length) {
      const box = el(
        'div',
        { class: 'picker', role: 'dialog', 'aria-label': 'Custom label transaction' },
        el('div', { class: 'picker-head' }, `Custom label “${place}”`),
        el(
          'p',
          { class: 'muted small', style: 'padding:4px 0' },
          'No custom labels yet. Create one first in the Custom labels card on the Analysis tab (for a renovation, a holiday, anything that spans categories and months), then add transactions to it.'
        ),
        el(
          'div',
          { class: 'picker-actions' },
          el('button', { class: 'btn sm ghost', onclick: closePicker }, 'Close')
        )
      );
      openModal(box);
      return;
    }

    const list = el('div', { class: 'picker-list' });
    for (const t of tags) {
      const member = (t.txnIds || []).includes(row.id);
      const cb = el('input', { type: 'checkbox', checked: member ? '' : null });
      const rowEl = el(
        'label',
        {
          class: 'scope',
          style: 'display:flex;align-items:center;gap:8px;justify-content:space-between',
        },
        el('span', { style: 'display:inline-flex;align-items:center;gap:8px' }, cb, t.name),
        el('span', { class: 'muted small' }, `${(t.txnIds || []).length} labelled`)
      );
      cb.addEventListener('change', () => toggleTag(t.id, row.id, cb.checked));
      list.append(rowEl);
    }

    const box = el(
      'div',
      { class: 'picker', role: 'dialog', 'aria-label': 'Custom label transaction' },
      el('div', { class: 'picker-head' }, `Custom label “${place}”`),
      el(
        'p',
        { class: 'muted small', style: 'padding:2px 0 6px' },
        'Add this transaction to any of your custom labels. A transaction can belong to more than one.'
      ),
      list,
      el(
        'div',
        { class: 'picker-actions' },
        el('button', { class: 'btn sm', onclick: closePicker }, 'Done')
      )
    );
    openModal(box);
  }

  async function toggleTag(tagId, txnId, on) {
    const tag = (state.tags || []).find((t) => t.id === tagId);
    if (!tag) return;
    const next = on ? tagAdd(tag, txnId) : tagRemove(tag, txnId);
    await Store.tags.put(next);
    state.tags = await Store.tags.all();
    trackUsage('activity-tag-toggle');
    render();
    toast(on ? `Added to “${tag.name}”.` : `Removed from “${tag.name}”.`);
  }

  async function setCategory(row, category) {
    const applyAll =
      getPickerEl() &&
      $('input[name="scope"]:checked', getPickerEl()) &&
      $('input[name="scope"]:checked', getPickerEl()).value === 'all';
    closePicker();
    const before = [];
    const key = merchantRuleKeyFromDescription(row.raw_description);
    const beforeRules = state.rules.map((r) => ({ ...r }));
    for (const rec of state.records) {
      const rkey = merchantRuleKeyFromDescription(rec.description);
      const match = applyAll ? rkey === key : (rec.id || transactionIdentity(rec)) === row.id;
      if (match) {
        before.push({ rec, prev: rec.categoryOverride || null });
        rec.categoryOverride = category;
        rec.lastChanged = new Date().toISOString();
      }
    }
    state.records = state.records.slice();
    if (applyAll) {
      state.rules = upsertCategoryRule(
        state.rules,
        { match: row.raw_description, category },
        new Date()
      ).rules;
      await persistRules();
    }
    await persist();
    render();
    const place = row.displayName || row.description.split(',')[0].trim();
    toast(
      applyAll ? `Filed every "${place}" as ${category}.` : `Filed as ${category}.`,
      async () => {
        for (const b of before) b.rec.categoryOverride = b.prev;
        state.records = state.records.slice();
        if (applyAll) {
          state.rules = beforeRules.map((r) => ({ ...r }));
          await persistRules();
        }
        await persist();
        render();
        toast('Change undone.');
      }
    );
  }

  // Mark the given rows as reviewed without changing their category, so the
  // "uncertain" items leave the attention list. Reversible, like corrections.
  async function dismissReview(rows) {
    const ids = new Set(rows.map((r) => r.id));
    const before = [];
    for (const rec of state.records) {
      const id = rec.id || transactionIdentity(rec);
      if (ids.has(id)) {
        before.push({ rec, prev: !!rec.reviewDismissed });
        rec.reviewDismissed = true;
        rec.lastChanged = new Date().toISOString();
      }
    }
    if (!before.length) return;
    state.records = state.records.slice();
    await persist();
    render();
    const n = before.length;
    toast(`Marked ${n} item${n === 1 ? '' : 's'} as reviewed.`, async () => {
      for (const b of before) b.rec.reviewDismissed = b.prev;
      state.records = state.records.slice();
      await persist();
      render();
      toast('Change undone.');
    });
  }

  return { openCategoryPicker, dismissReview, openTagPicker };
}
