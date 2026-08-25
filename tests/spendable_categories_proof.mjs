import { spendableCategoryNames } from '../application/analysis/spendable-categories.js';
let pass = 0,
  fail = 0;
const note = (c, l) => {
  if (c) pass++;
  else {
    fail++;
    console.log('   FAIL', l);
  }
};
// a register mirroring config.json: internal/statutory ones + real spend + a custom
const cfg = {
  special: {
    fallback: 'Uncategorised',
    paymentCategory: 'Card Payment',
    refundCategory: 'Refund / Reversal',
    feeCategories: ['Fees & Interest', 'Government & Tax'],
  },
  categories: [
    { name: 'Card Payment' },
    { name: 'Refund / Reversal' },
    { name: 'Fees & Interest' },
    { name: 'Government & Tax' },
    { name: 'Groceries' },
    { name: 'Dining & Takeout' },
    { name: 'Fuel & Transport' },
    { name: 'Home Reno', custom: true }, // person-authored
  ],
};
const out = spendableCategoryNames(cfg);
console.log('spendable:', JSON.stringify(out));
note(!out.includes('Card Payment'), 'excludes Card Payment (paying your own card is not spending)');
note(!out.includes('Refund / Reversal'), 'excludes Refund / Reversal (money returning)');
note(
  !out.includes('Fees & Interest') && !out.includes('Government & Tax'),
  'excludes statutory/fee buckets'
);
note(
  out.includes('Groceries') && out.includes('Dining & Takeout') && out.includes('Fuel & Transport'),
  'keeps real discretionary spend categories'
);
note(
  out.includes('Home Reno'),
  'KEEPS the custom category (person-authored spending is a valid ceiling target)'
);
note(out.length === 4, 'exactly 4 spendable categories (3 shipped + 1 custom)');
// robustness: missing cfg parts
note(spendableCategoryNames({}).length === 0, 'empty cfg -> empty list, no crash');
note(
  spendableCategoryNames({ categories: [{ name: 'X' }] }).length === 1,
  'no special block -> nothing excluded, category kept'
);
console.log(`\n checks: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
