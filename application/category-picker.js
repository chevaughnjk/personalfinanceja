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

import { orderCategoriesForPicker } from './reporting.js';
import { merchantRuleKeyFromDescription, upsertCategoryRule } from '../settings/category-rules.js';
import { requireCtx } from './shared-helpers.js';
import { transactionIdentity } from './read-statements.js';

export function createCategoryPicker(ctx) {
  requireCtx(ctx, [
    'state', 'el', '$', 'toast', 'render', 'closePicker', 'openModal', 'getPickerEl',
    'persist', 'persistRules', 'catColour', 'isReview',
  ], 'createCategoryPicker');
  const { state, el, $, toast, render, closePicker, openModal, getPickerEl, persist, persistRules, catColour, isReview } = ctx;

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
      list.append(el('button', { class: 'picker-item' + (c === row.category ? ' current' : ''),
        dataset: { name: label.toLowerCase() }, onclick: () => setCategory(row, c) },
        el('span', { class: 'cat-dot', style: `background:${catColour(c)}` }), label,
        c === row.category ? el('span', { class: 'muted small' }, ' current') : null));
    }
    // Type-to-filter: correcting a category is the most repeated action, and the
    // list is long on a phone. Filtering is case-insensitive on the shown name.
    const noMatch = el('div', { class: 'picker-empty muted small', hidden: '' }, 'No matching category.');
    const filter = el('input', { type: 'text', class: 'picker-filter', placeholder: 'Filter categories…',
      'aria-label': 'Filter categories', oninput: (e) => {
        const q = e.target.value.trim().toLowerCase();
        let visible = 0;
        for (const item of list.children) { const hit = !q || item.dataset.name.includes(q); item.hidden = !hit; if (hit) visible++; }
        noMatch.hidden = visible > 0;
      } });
    const scopeOnly = el('label', { class: 'scope' }, el('input', { type: 'radio', name: 'scope', value: 'one', checked: '' }), ' Only this transaction');
    const scopeAll = el('label', { class: 'scope' }, el('input', { type: 'radio', name: 'scope', value: 'all' }), ` Every “${place}” charge, now and in future`);
    const box = el('div', { class: 'picker', role: 'dialog', 'aria-label': 'Change category' },
      el('div', { class: 'picker-head' }, `File “${place}” as`),
      filter, list, noMatch,
      el('div', { class: 'picker-scope' }, scopeOnly, scopeAll),
      el('div', { class: 'picker-actions' }, el('button', { class: 'btn sm ghost', onclick: closePicker }, 'Cancel')));
    openModal(box);
  }

  async function setCategory(row, category) {
    const applyAll = getPickerEl() && $('input[name="scope"]:checked', getPickerEl()) && $('input[name="scope"]:checked', getPickerEl()).value === 'all';
    closePicker();
    const before = [];
    const key = merchantRuleKeyFromDescription(row.raw_description);
    const beforeRules = state.rules.map((r) => ({ ...r }));
    for (const rec of state.records) {
      const rkey = merchantRuleKeyFromDescription(rec.description);
      const match = applyAll ? rkey === key : (rec.id || transactionIdentity(rec)) === row.id;
      if (match) { before.push({ rec, prev: rec.categoryOverride || null }); rec.categoryOverride = category; rec.lastChanged = new Date().toISOString(); }
    }
    if (applyAll) {
      state.rules = upsertCategoryRule(state.rules, { match: row.raw_description, category }, new Date()).rules;
      await persistRules();
    }
    await persist(); render();
    const place = row.displayName || row.description.split(',')[0].trim();
    toast(applyAll ? `Filed every "${place}" as ${category}.` : `Filed as ${category}.`,
      async () => {
        for (const b of before) b.rec.categoryOverride = b.prev;
        if (applyAll) { state.rules = beforeRules.map((r) => ({ ...r })); await persistRules(); }
        await persist(); render(); toast('Change undone.');
      });
  }

  // Mark the given rows as reviewed without changing their category, so the
  // "uncertain" items leave the attention list. Reversible, like corrections.
  async function dismissReview(rows) {
    const ids = new Set(rows.map((r) => r.id));
    const before = [];
    for (const rec of state.records) {
      const id = rec.id || transactionIdentity(rec);
      if (ids.has(id)) { before.push({ rec, prev: !!rec.reviewDismissed }); rec.reviewDismissed = true; rec.lastChanged = new Date().toISOString(); }
    }
    if (!before.length) return;
    await persist(); render();
    const n = before.length;
    toast(`Marked ${n} item${n === 1 ? '' : 's'} as reviewed.`, async () => {
      for (const b of before) b.rec.reviewDismissed = b.prev;
      await persist(); render(); toast('Change undone.');
    });
  }

  return { openCategoryPicker, dismissReview };
}
