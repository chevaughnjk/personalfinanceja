/*
 * available-now.js (render)  -  Overview's lead hero card: "Available now".
 * Turns provenModels.availableNow()'s view-model (buildAvailableNowModel,
 * analysis/available-now.js) into DOM as a genuine hero: one lead figure at
 * full size, a one-line honest verdict beneath it, and the supporting layers
 * (cash on hand, committed before payday) plus any incomplete-data reason
 * folded into a single "Why" dropdown - never stacked on the surface as
 * co-equal number blocks. This is the plan's own rule: the decision-useful
 * figure first, the reasoning on demand.
 *
 * The model's `gaps` array can carry internal state tokens (e.g.
 * 'amount-known-date-unknown'); those are translated to plain language here
 * before they ever reach the surface, never printed verbatim.
 */
import { requireCtx } from '../core/shared-helpers.js';

// Internal gap tokens -> plain language. The primitive names gaps with terse
// state tokens for its own logic; a person must never see them. Anything not
// listed falls back to a generic, honest phrase rather than leaking the token.
const GAP_PLAIN = {
  'amount-known-date-unknown': 'a card payment is known but its due date could not be read',
  'no-card-statement': 'no card statement has been imported yet',
  'no-income-date': 'the date of the next income could not be determined',
  'no-regular-income': 'no regular income pattern has been detected yet',
  'card-leg-incomplete': 'the card side of this figure is incomplete',
};
function plainGap(raw) {
  const key = String(raw || '').trim();
  if (GAP_PLAIN[key]) return GAP_PLAIN[key];
  // A compound token like "card leg incomplete: amount-known-date-unknown":
  // take the part after the colon if it maps, else a clean generic.
  const tail = key.includes(':') ? key.split(':').pop().trim() : key;
  if (GAP_PLAIN[tail]) return GAP_PLAIN[tail];
  return 'some inputs are still missing';
}

export function createAvailableNow(ctx) {
  requireCtx(ctx, ['el', 'icon', 'provenModels', 'bankMoney', 'iconInfo'], 'createAvailableNow');
  const { el, icon, provenModels, bankMoney, iconInfo } = ctx;

  function card(m) {
    const sec = el('section', { class: 'card hero' });
    sec.append(
      el(
        'div',
        { class: 'hero-head' },
        el(
          'div',
          {},
          el('div', { class: 'hero-eyebrow' }, icon(iconInfo()), 'Available now'),
          el(
            'h2',
            { class: 'hero-title' },
            m.lead && m.lead.amountText != null ? m.lead.amountText : ''
          )
        )
      )
    );

    // The honest one-line subtitle: the lead's own label, then the verdict.
    // This carries the plain hedge ("...this is an estimate") on the surface,
    // so the incomplete-data fact is never hidden, without a heavy warning box.
    const subParts = [];
    if (m.lead && m.lead.label) subParts.push(m.lead.label);
    const sub = el('div', { class: 'hero-amount-label' }, subParts.join(''));
    sec.append(el('div', { class: 'hero-body' }, sub));

    if (m.lead && m.lead.tag) {
      sec.append(el('span', { class: 'vm-tag tone-' + (m.lead.tone || 'neutral') }, m.lead.tag));
    }

    // The single "Why" dropdown: the two working layers as the breakdown, plus
    // the specific incomplete-data reason in plain language when present. This
    // is where a person who wants the working finds it, out of the way of one
    // who just wants the figure. The verdict sentence (the longer "why this is
    // an estimate"-style explanation) now lives here too, rather than standing
    // permanently visible on the card's surface - the tag alone ("estimate")
    // already tells someone at a glance that the figure isn't firm, and the
    // fuller reasoning is exactly the kind of detail every other card in this
    // app already defers to this same disclosure.
    const why = el('details', { class: 'vm-detail', style: 'margin-top:8px' });
    why.append(el('summary', {}, 'Why'));
    const body = el('div', { class: 'vm-detail-body' });

    if (m.verdict && m.verdict.text) {
      body.append(el('p', { style: 'margin:0 0 8px' }, m.verdict.text));
    }
    if (m.lead && m.lead.detail) {
      body.append(el('p', { style: 'margin:0 0 8px' }, m.lead.detail));
    }
    for (const layer of m.working || []) {
      body.append(
        el(
          'div',
          { class: 'vm-lead', style: 'margin-bottom:6px' },
          el('div', { class: 'vm-number' }, layer.amountText != null ? layer.amountText : ''),
          el('div', { class: 'vm-label' }, layer.label + (layer.detail ? ' - ' + layer.detail : ''))
        )
      );
    }
    if (m.confidence === 'incomplete' && m.gaps && m.gaps.length) {
      const plain = m.gaps.map(plainGap);
      body.append(
        el(
          'p',
          { class: 'muted small', style: 'margin:8px 0 0' },
          `This is an estimate because ${plain.join('; ')}. Add the missing statement or income and it will firm up.`
        )
      );
    }
    why.append(body);
    sec.append(why);

    return sec;
  }

  function renderAvailableNow() {
    const model = provenModels.availableNow();
    if (!model) return null;
    return card(model);
  }

  return { renderAvailableNow };
}
