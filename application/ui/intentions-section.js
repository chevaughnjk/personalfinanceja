/* Category-ceiling authoring section for Activity. It owns only DOM and store
 * wiring; the intention resolver and pace model remain in analysis/. */
import { spendableCategoryNames } from '../analysis/spendable-categories.js';

export function makeRenderIntentions(deps) {
  const { state, el, icon, provenModels, resolved, trackUsage, Store, render, makeIntention,
    categorySpend, iconRepeat, toast } = deps;

  async function saveCeiling(category, amount) {
    const p = resolved();
    const month = p && p.to ? String(p.to).slice(0, 7) : null;
    if (!category || !(amount > 0) || !month) {
      toast('Enter a category and an amount.');
      return;
    }
    const rec = makeIntention({ category, amount, kind: 'repeating', effectiveFrom: month });
    await Store.categoryIntentions.put(rec);
    state.categoryIntentions = await Store.categoryIntentions.all();
    trackUsage('activity-set-ceiling');
    render();
  }

  async function removeCeiling(category) {
    const all = await Store.categoryIntentions.all();
    for (const it of all.filter((r) => r.category === category)) {
      await Store.categoryIntentions.delete(it.id);
    }
    state.categoryIntentions = await Store.categoryIntentions.all();
    trackUsage('activity-remove-ceiling');
    render();
  }

  function renderCeilingForm() {
    const categories = spendableCategoryNames(state.cfg);
    const catSelect = el(
      'select',
      { class: 'name-field', id: 'ceiling-category-select' },
      ...categories.map((c) => el('option', { value: c }, c))
    );
    const amtInput = el('input', {
      type: 'number', class: 'name-field', placeholder: 'Ceiling amount', min: '1',
    });
    const confirm = async () => saveCeiling(catSelect.value, Number(amtInput.value));
    return el(
      'div', {}, el('p', { class: 'muted small' }, 'Set a category ceiling'),
      el('div', { class: 'manage-actions' }, catSelect, amtInput,
        el('button', { class: 'btn sm', onclick: confirm }, 'Set ceiling'))
    );
  }

  return function renderIntentions() {
    if (!categorySpend) return null;
    const p = resolved();
    if (!p || !p.to) return null;
    const month = String(p.to).slice(0, 7);
    const today = new Date();
    const asOfDay = month === today.toISOString().slice(0, 7)
      ? today.getUTCDate() : daysInMonth(month);
    const sec = el('section', { class: 'card', id: 'activity-ceilings' });
    sec.append(el('div', { class: 'card-head' },
      el('h3', { class: 'card-title' }, icon(iconRepeat()), 'Your category ceilings')));

    const categories = [...new Set((state.categoryIntentions || [])
      .filter((it) => it.active !== false).map((it) => it.category))];
    const models = [];
    for (const cat of categories) {
      const gov = provenModels.intentionFor(cat, month);
      if (!gov) continue;
      const pace = provenModels.paceFor(cat, month, categorySpend(cat, { from: month, to: month }), asOfDay);
      if (pace) models.push({ cat, gov, pace });
    }

    if (models.length) {
      const list = el('div', { class: 'recurring-list' });
      for (const { cat, gov, pace } of models) {
        const removeBtn = el('button', { class: 'btn sm ghost', onclick: () => removeCeiling(cat) }, 'Remove');
        if (removeBtn.setAttribute) removeBtn.setAttribute('data-id', gov.id);
        list.append(el('div', { class: 'recurring-row' },
          el('span', { class: 'recurring-name' }, cat),
          pace.tag ? el('span', { class: 'vm-tag tone-' + (pace.tone || 'neutral') }, pace.tag) : el('span', {}),
          el('span', { class: 'recurring-amt num' }, pace.amountText), removeBtn));
      }
      sec.append(list);
      sec.append(el('p', { class: 'muted small' }, 'How this month is tracking so far.'));
    }
    sec.append(renderCeilingForm());
    return sec;
  };
}

function daysInMonth(ym) {
  const y = +ym.slice(0, 4);
  const mo = +ym.slice(5, 7);
  return new Date(Date.UTC(y, mo, 0)).getUTCDate();
}
