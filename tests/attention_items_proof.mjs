/* attention_items_proof.mjs - the one resolver behind Right Now's "Worth a
 * look" and Overview's "Needs attention" produces the expected items, in the
 * expected severity order, from a fixed synthetic input. Guards the "one
 * resolver, read identically" promise: a future edit that silently changed
 * what one screen shows would change this fixture's output and fail here. */
import { buildAttentionItems } from '../application/analysis/reporting.js';

let pass = 0,
  fail = 0;
const note = (c, l) => {
  if (c) pass++;
  else {
    fail++;
    console.log('   FAIL', l);
  }
};
console.log('='.repeat(72));
console.log(' ATTENTION ITEMS - one resolver, both screens');
console.log('='.repeat(72));

const money0 = (n) => '$' + Number(n || 0).toLocaleString('en-US');
const formatDisplayDate = (d) => String(d);
const noop = () => {};

// Stub detectors with deterministic output so the proof asserts the
// resolver's ORDERING and SHAPING, independent of detector internals.
const isUnrecognised = (r, fb) => r.category === (fb || 'Uncategorised') && r.confidence === 0;
const detectPossibleDuplicates = () => [
  {
    label: 'Test Merchant',
    amount: 5000,
    dates: ['2026-06-01', '2026-06-01'],
    ids: ['a', 'b'],
  },
];
const detectCategorySpikes = () => [{ category: 'Dining', amount: 40000, typical: 12000 }];

const deps = {
  cardRows: [
    {
      kind: 'spend',
      category: 'Uncategorised',
      confidence: 0,
      amount: 3000,
      reviewDismissed: false,
    },
    {
      kind: 'spend',
      category: 'Groceries',
      confidence: 1,
      needsReview: true,
      amount: 2000,
      reviewDismissed: false,
    },
  ],
  cardStatements: [{ reconciled: false, period: '2026-06', reconNote: 'off by 12' }],
  bankStatements: [{ reconciled: false, period: '2026-05', reconNote: 'off by 8' }],
  brandRules: [],
  merchants: null,
  rows: [],
  period: { from: '2026-06', to: '2026-06' },
  cfg: {},
  splits: [],
  fallback: 'Uncategorised',
  availableNow: { lead: { amount: -25000 }, confidence: 'complete' },
  money0,
  formatDisplayDate,
  isUnrecognised,
  detectPossibleDuplicates,
  detectCategorySpikes,
  dismissReview: noop,
  pickStatements: noop,
  drillToTransactions: noop,
};

const items = buildAttentionItems(deps);

// --- blocking items come first, in the plan's severity order ---
const blocking = items.filter((i) => i.tone === 'blocking');
const optional = items.filter((i) => i.tone === 'optional');

note(items.length > 0, 'produces items from the fixture');
note(
  items.slice(0, blocking.length).every((i) => i.tone === 'blocking'),
  'every blocking item precedes every optional item (severity order)'
);

// 1) shortfall is present, blocking, and names the amount
const shortfall = items.find((i) => /run short/i.test(i.title));
note(!!shortfall && shortfall.tone === 'blocking', 'shortfall before income is a BLOCKING item');
note(
  shortfall && /\$25,000/.test(shortfall.title),
  'shortfall names the amount from availableNow.lead'
);

// 2) both unreconciled statements, blocking
note(
  blocking.filter((i) => /not reconciled/i.test(i.title)).length === 2,
  'both unreconciled statements (card + bank) are blocking'
);

// 3) review purchases folded into ONE optional item, counting both rows
const review = optional.find((i) => /second look/i.test(i.title));
note(
  !!review && /2 purchases/.test(review.title),
  'unrecognised + needs-review rows fold into one optional item counting both'
);

// 4) duplicate + spike are optional
note(
  optional.some((i) => /duplicate/i.test(i.title)),
  'possible duplicate is optional'
);
note(
  optional.some((i) => /higher than usual/i.test(i.title)),
  'category spike is optional'
);

// --- Overview's blocking-only filter yields exactly the decision-forcing head ---
const overviewHead = items.filter((i) => i.tone === 'blocking');
note(
  overviewHead.length === 3 && overviewHead.every((i) => i.tone === 'blocking'),
  "Overview's blocking-only filter yields exactly the shortfall + two unreconciled items, no tidying"
);

// --- incomplete confidence changes the shortfall wording, not its tone ---
{
  const items2 = buildAttentionItems({
    ...deps,
    availableNow: { lead: { amount: -25000 }, confidence: 'incomplete' },
  });
  const s2 = items2.find((i) => /run short/i.test(i.title));
  note(
    !!s2 && s2.tone === 'blocking' && /estimate/i.test(s2.detail),
    'an incomplete-confidence shortfall stays blocking but hedges its detail as an estimate'
  );
}

// --- no shortfall when lead is non-negative ---
{
  const items3 = buildAttentionItems({
    ...deps,
    availableNow: { lead: { amount: 40000 }, confidence: 'complete' },
  });
  note(
    !items3.some((i) => /run short/i.test(i.title)),
    'a positive available-now lead produces NO shortfall item'
  );
}

// --- calm case: nothing blocking when statements reconcile and lead is positive ---
{
  const calm = buildAttentionItems({
    ...deps,
    cardStatements: [{ reconciled: true }],
    bankStatements: [{ reconciled: true }],
    cardRows: [],
    availableNow: { lead: { amount: 40000 }, confidence: 'complete' },
    detectPossibleDuplicates: () => [],
    detectCategorySpikes: () => [],
  });
  note(
    calm.filter((i) => i.tone === 'blocking').length === 0,
    'calm inputs produce zero blocking items (Overview would show its calm confirmation)'
  );
}

console.log(`\n checks: ${pass} passed, ${fail} failed`);
console.log('='.repeat(72));
process.exit(fail ? 1 : 0);
