import { summarise, analysePeriod } from '../application/analysis/reporting.js';
import { spendBreakdown } from '../application/analysis/spend-breakdown.js';
import { makeSplit } from '../application/analysis/transaction-splits.js';

let pass = 0;
let fail = 0;

const note = (condition, label) => {
  if (condition) pass++;
  else {
    fail++;
    console.log('   FAIL', label);
  }
};

const rows = [
  {
    id: 't1',
    date: '2026-07-02',
    month: '2026-07',
    kind: 'spend',
    category: 'Retail & Department',
    amount: 30000,
    description: 'HOME STORE',
    raw_description: 'HOME STORE',
    merchantGroup: 'Home Store',
  },
  {
    id: 't2',
    date: '2026-07-05',
    month: '2026-07',
    kind: 'spend',
    category: 'Groceries',
    amount: 12000,
    description: 'SUPERMARKET',
    raw_description: 'SUPERMARKET',
    merchantGroup: 'Supermarket',
  },
  {
    id: 't3',
    date: '2026-07-06',
    month: '2026-07',
    kind: 'spend',
    category: 'Dining & Takeout',
    amount: 8000,
    description: 'CAFE',
    raw_description: 'CAFE',
    merchantGroup: 'Cafe',
  },
];

const split = makeSplit({
  txnId: 't1',
  parts: [
    { category: 'Retail & Department', amount: 18000 },
    { category: 'Home Reno', amount: 12000 },
  ],
  now: '2026-07-31T00:00:00Z',
});

const splits = [split];
const period = {
  from: '2026-07',
  to: '2026-07',
  label: 'July 2026',
  kind: 'month',
};

console.log('='.repeat(72));
console.log(' B3b REPORTING INTEGRATION PROOF');
console.log('='.repeat(72));

const summary = summarise(rows, { splits });
const analysed = analysePeriod(rows, period, { splits });
const breakdown = spendBreakdown({
  cardRecords: rows,
  cfg: {},
  period: { from: '2026-07-01', to: '2026-07-31' },
  splits,
});

note(summary.total_spend === 50000, 'summarise grand total remains 50000');
note(analysed.total_spend === 50000, 'analysePeriod grand total remains 50000');
note(breakdown.grandTotal === 50000, 'spendBreakdown grand total remains 50000');

note(
  summary.by_category['Retail & Department'] === 18000,
  'summarise Retail split amount is 18000'
);
note(summary.by_category['Home Reno'] === 12000, 'summarise Home Reno split amount is 12000');

const analysedByCategory = Object.fromEntries(
  analysed.by_category.map((item) => [item.name, item.amount])
);

note(
  analysedByCategory['Retail & Department'] === 18000,
  'analysePeriod Retail split amount is 18000'
);
note(analysedByCategory['Home Reno'] === 12000, 'analysePeriod Home Reno split amount is 12000');

const breakdownByCategory = Object.fromEntries(
  breakdown.categories.map((item) => [item.name, item.total])
);

note(
  breakdownByCategory['Retail & Department'] === 18000,
  'spendBreakdown Retail split amount is 18000'
);
note(breakdownByCategory['Home Reno'] === 12000, 'spendBreakdown Home Reno split amount is 12000');

const summaryCategoryTotal = Object.values(summary.by_category).reduce(
  (sum, amount) => sum + amount,
  0
);

const analysedCategoryTotal = analysed.by_category.reduce((sum, item) => sum + item.amount, 0);

const breakdownCategoryTotal = breakdown.categories.reduce((sum, item) => sum + item.total, 0);

note(summaryCategoryTotal === 50000, 'summarise category totals reconcile');
note(analysedCategoryTotal === 50000, 'analysePeriod category totals reconcile');
note(breakdownCategoryTotal === 50000, 'spendBreakdown category totals reconcile');

note(breakdown.txnCount === 3, 'spendBreakdown still counts three transactions');

console.log(`\n checks: ${pass} passed, ${fail} failed`);
console.log('='.repeat(72));
process.exit(fail ? 1 : 0);
