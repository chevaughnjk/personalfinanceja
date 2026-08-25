// E proof: the "available now" preview renders the REAL buildAvailableNowModel
// shape (confirmed against available-now.js's actual return: asOf, confidence,
// verdict{text,tone}, lead{...}, working[cashOnHand,committed], income{...},
// card{...}, gaps[...]) - not an invented/assumed primitive shape. Proves: lead
// + both working items render; the incomplete case names its gaps; a null
// model renders nothing (safe).
import { createAvailableNow } from '../application/ui/available-now-preview.js';

let pass = 0,
  fail = 0;
const note = (c, l) => {
  if (c) pass++;
  else {
    fail++;
    console.log('   FAIL', l);
  }
};
function mk(t) {
  return {
    tag: t,
    attrs: {},
    kids: [],
    text: '',
    get childElementCount() {
      return this.kids.filter((k) => k.tag && k.tag !== '#text').length;
    },
    append(...m) {
      for (const x of m.flat()) {
        if (x == null || x === false) continue;
        if (typeof x === 'object' && x.tag) this.kids.push(x);
        else
          this.kids.push({
            tag: '#text',
            text: String(x),
            kids: [],
            attrs: {},
          });
      }
      return this;
    },
  };
}
function el(t, a = {}, ...k) {
  const n = mk(t);
  n.attrs = a || {};
  n.append(...k);
  return n;
}
const icon = () => mk('svg');
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
function hasClass(n, c) {
  return String(n.attrs.class || '')
    .split(/\s+/)
    .includes(c);
}
const bankMoney = (n) => '$' + Number(n || 0).toLocaleString('en-US');

// The REAL shape buildAvailableNowModel returns, per available-now.js:169-178.
const complete = {
  asOf: '2026-07-20',
  confidence: 'complete',
  verdict: {
    text: 'You have room to move before your next pay.',
    tone: 'good',
  },
  lead: {
    id: 'estimatedAvailable',
    label: 'Left after what is already committed',
    amount: 195000,
    amountText: '$195,000.00',
    tag: 'free to move until payday',
    tone: 'good',
    detail:
      'This is your cash on hand of $300,000.00 minus $105,000.00 of payments due before your next pay, including your card payment.',
  },
  working: [
    {
      id: 'availableBalance',
      label: 'Cash on hand',
      amount: 300000,
      amountText: '$300,000.00',
      tag: 'everyday accounts',
      tone: 'neutral',
      detail: 'The latest balance across your everyday accounts.',
    },
    {
      id: 'commitments',
      label: 'Committed before payday',
      amount: 105000,
      amountText: '$105,000.00',
      tag: '2 payments incl. card',
      tone: 'neutral',
      detail:
        'Payments already due to leave before your next pay: $60,000.00 on 21-Jul; $45,000.00 (card) on 22-Jul.',
    },
  ],
  income: {
    label: 'Next pay',
    amountText: '25-Jul',
    tag: '',
    tone: 'neutral',
    detail: '',
  },
  card: {
    label: 'Card',
    amountText: '$257,610.28',
    tag: 'owed',
    tone: 'neutral',
    detail: '',
  },
  gaps: [],
};
const incomplete = {
  asOf: '2026-07-20',
  confidence: 'incomplete',
  verdict: null,
  lead: {
    id: 'estimatedAvailable',
    label: 'Left after what is already committed',
    amount: 300000,
    amountText: '$300,000.00',
    tag: 'estimate',
    tone: 'watch',
    detail:
      'This is your cash on hand of $300,000.00 minus $0.00 of payments due before your next pay.',
  },
  working: [
    {
      id: 'availableBalance',
      label: 'Cash on hand',
      amount: 300000,
      amountText: '$300,000.00',
      tag: 'everyday accounts',
      tone: 'neutral',
      detail: '',
    },
    {
      id: 'commitments',
      label: 'Committed before payday',
      amount: 0,
      amountText: '$0.00',
      tag: 'nothing due before payday',
      tone: 'neutral',
      detail: '',
    },
  ],
  income: {
    label: 'Next pay',
    amountText: '-',
    tag: '',
    tone: 'neutral',
    detail: '',
  },
  card: {
    label: 'Card',
    amountText: '$0.00',
    tag: '',
    tone: 'neutral',
    detail: '',
  },
  gaps: ['no recurring income detected', 'card leg incomplete: amount-known-date-unknown'],
};

function render(model) {
  const r = createAvailableNow({
    el,
    icon,
    provenModels: { availableNow: () => model },
    bankMoney,
    iconInfo: () => '',
  });
  return r.renderAvailableNow();
}

console.log('='.repeat(72));
console.log(' E AVAILABLE-NOW PREVIEW - real shape, honesty structure intact');
console.log('='.repeat(72));

{
  const card = render(complete);
  note(!!card, 'preview renders');
  const t = allText(card);
  note(/Left after what is already committed/.test(t), 'lead label present');
  note(/Cash on hand/.test(t), 'working item 1 label present');
  note(/Committed before payday/.test(t), 'working item 2 label present');
  const nums = findAll(card, (n) => hasClass(n, 'vm-number')).map(allText);
  note(
    nums.some((x) => /195,000/.test(x)),
    'lead shows 195,000'
  );
  note(
    nums.some((x) => /300,000/.test(x)),
    'cash on hand shows 300,000'
  );
  note(
    nums.some((x) => /105,000/.test(x)),
    'committed shows 105,000'
  );
  const tags = findAll(card, (n) => hasClass(n, 'vm-tag')).map(allText);
  note(
    tags.some((x) => /free to move/.test(x)),
    'lead tagged with the free-to-move framing (complete case)'
  );
  note(!/\bfree to spend\b/i.test(t), 'never says plainly "free to spend"');
  note(
    /60,000|Rent|Payments already due/i.test(t) || /45,000/.test(t),
    'commitment detail discloses itemised amounts'
  );
  note(/You have room to move/.test(t), 'verdict sentence renders');
}

{
  const card = render(incomplete);
  const t = allText(card);
  note(/incomplete/i.test(t), 'says the estimate is incomplete');
  note(
    /no recurring income detected/.test(t) && /card leg incomplete/.test(t),
    'NAMES the specific gaps'
  );
  note(/rough figure|not a precise boundary/i.test(t), 'framed as rough, NOT a precise boundary');
  const leadTag = findAll(card, (n) => hasClass(n, 'vm-tag'))[0];
  note(
    leadTag && /estimate/.test(allText(leadTag)),
    'lead tag says "estimate" in the incomplete case'
  );
}

{
  note(render(null) === null, 'null model renders nothing (safe, no crash)');
}

console.log(`\n checks: ${pass} passed, ${fail} failed`);
console.log('='.repeat(72));
process.exit(fail ? 1 : 0);
