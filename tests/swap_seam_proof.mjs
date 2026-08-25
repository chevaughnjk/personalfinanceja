import { createProvenModels } from '../application/analysis/proven-models.js';
let pass = 0,
  fail = 0;
const note = (c, l) => {
  if (c) pass++;
  else {
    fail++;
    console.log('   FAIL', l);
  }
};
const cfg = { currency: { code: 'JMD' }, insights: {} };
// June has 60k groceries; May (prior) had 50k -> a normal +20% comparison.
const rows = [
  { kind: 'spend', date: '2025-05-10', amount: 50000, category: 'Groceries' },
  { kind: 'spend', date: '2025-06-10', amount: 60000, category: 'Groceries' },
  { kind: 'spend', date: '2025-06-14', amount: 30000, category: 'Dining' }, // new this period
];
const pm = createProvenModels({
  state: { rows, cfg },
  classifiedBank: () => [],
  todayISO: () => '2025-06-30',
});
// resolved() shape the app produces: month-granularity current + prior
const period = { from: '2025-06', to: '2025-06' };
// 1) COMPLETE prior: groceries 60k vs 50k -> +20%
const complete = pm.spendBreakdownFor(period, { from: '2025-05', to: '2025-05' }, true);
const groc = complete.categories.find((c) => c.name === 'Groceries');
note(/20% vs last/.test(groc.tag), `complete prior -> +20% (got "${groc.tag}")`);
const din = complete.categories.find((c) => c.name === 'Dining');
note(/new this period/.test(din.tag), `zero prior -> "new this period" (got "${din.tag}")`);
// 2) PARTIAL prior (the guard): same numbers, priorComplete=false -> amount, NO %
const partial = pm.spendBreakdownFor(period, { from: '2025-05', to: '2025-05' }, false);
const grocP = partial.categories.find((c) => c.name === 'Groceries');
note(
  /partial/.test(grocP.tag) && !/%/.test(grocP.tag),
  `partial prior -> amount, NOT a % (got "${grocP.tag}")`
);
// 3) month-granularity bounds captured June rows (the seam fix): grand total = 90k
note(
  /^\$90,000(\.00)?$/.test(complete.total.amountText),
  `month bounds captured all June spend: ${complete.total.amountText}`
);
console.log(`checks: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
