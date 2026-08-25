// B3b proof: transaction splits reconcile. The ENTIRE risk is that a split must
// not double-count a transaction or drift a category total. This proves:
// splitting a row leaves the grand total byte-identical to unsplit; the split's
// parts land on the right categories; an INVALID split (parts != amount) is
// rejected and the row falls back to its whole amount (never distorts a total);
// validation catches every bad shape; balanceParts makes the remainder exact;
// and multi-split precedence takes the newest.
import {
  makeSplit,
  validateSplit,
  balanceParts,
  categoryTotalsWithSplits,
  splitsByTxnId,
} from '../application/analysis/transaction-splits.js';

let pass = 0,
  fail = 0;
const note = (c, l) => {
  if (c) pass++;
  else {
    fail++;
    console.log('   FAIL', l);
  }
};
const r2 = (n) => Math.round(n * 100) / 100;
console.log('='.repeat(72));
console.log(' B3b TRANSACTION SPLITS - reconciliation proof');
console.log('='.repeat(72));

// spend rows (the shape by_category reads: {id, category, amount})
const rows = [
  { id: 't1', category: 'Retail & Department', amount: 30000 }, // will be split
  { id: 't2', category: 'Groceries', amount: 12000 },
  { id: 't3', category: 'Dining & Takeout', amount: 8000 },
];
const unsplitTotal = r2(rows.reduce((s, r) => s + Math.abs(r.amount), 0)); // 50000

// 1) NO splits -> reader matches the plain byCat loop exactly
{
  const { byCategory, total } = categoryTotalsWithSplits(rows, new Map());
  note(total === unsplitTotal, `no-split total = ${unsplitTotal} (got ${total})`);
  note(
    byCategory['Retail & Department'] === 30000 &&
      byCategory['Groceries'] === 12000 &&
      byCategory['Dining & Takeout'] === 8000,
    'no-split byCategory matches the plain loop'
  );
}

// 2) split t1 (30000) into Retail 18000 + Home Reno 12000 -> total UNCHANGED, categories redistributed
{
  const split = makeSplit({
    txnId: 't1',
    parts: [
      { category: 'Retail & Department', amount: 18000 },
      { category: 'Home Reno', amount: 12000 },
    ],
  });
  note(validateSplit(split, 30000).ok, 'valid split (parts sum to 30000) passes validation');
  const map = splitsByTxnId([split]);
  const { byCategory, total } = categoryTotalsWithSplits(rows, map);
  note(
    total === unsplitTotal,
    `RECONCILES: split total still ${unsplitTotal} (got ${total}) - transaction NOT double-counted`
  );
  note(byCategory['Retail & Department'] === 18000, 'Retail now holds only its split part (18000)');
  note(byCategory['Home Reno'] === 12000, 'the split created a Home Reno contribution (12000)');
  // the sum of all category totals equals the grand total, split or not
  const catSum = r2(Object.values(byCategory).reduce((s, v) => s + v, 0));
  note(catSum === unsplitTotal, `sum of category totals == grand total (${catSum})`);
}

// 3) an INVALID split (parts sum != amount) is rejected -> row falls back to whole amount
{
  const bad = makeSplit({
    txnId: 't1',
    parts: [
      { category: 'Retail & Department', amount: 18000 },
      { category: 'Home Reno', amount: 5000 },
    ],
  }); // 23000 != 30000
  note(
    !validateSplit(bad, 30000).ok && validateSplit(bad, 30000).reason === 'sum-mismatch',
    'invalid split (sum mismatch) is caught'
  );
  const { byCategory, total } = categoryTotalsWithSplits(rows, splitsByTxnId([bad]));
  note(total === unsplitTotal, `invalid split does NOT distort the total (still ${unsplitTotal})`);
  note(
    byCategory['Retail & Department'] === 30000 && byCategory['Home Reno'] == null,
    'invalid split -> row keeps its whole 30000 on its own category, no Home Reno leak'
  );
}

// 4) validation catches every bad shape
{
  note(
    validateSplit(makeSplit({ txnId: 't1', parts: [{ category: 'A', amount: 30000 }] }), 30000)
      .reason === 'need-two-parts',
    'rejects a single-part split'
  );
  note(
    validateSplit(
      makeSplit({
        txnId: 't1',
        parts: [
          { category: '', amount: 15000 },
          { category: 'B', amount: 15000 },
        ],
      }),
      30000
    ).reason === 'part-missing-category',
    'rejects a part with no category'
  );
  note(
    validateSplit(
      makeSplit({
        txnId: 't1',
        parts: [
          { category: 'A', amount: 0 },
          { category: 'B', amount: 30000 },
        ],
      }),
      30000
    ).reason === 'part-not-positive',
    'rejects a zero/negative part'
  );
}

note(
  validateSplit(
    makeSplit({
      txnId: 't1',
      parts: [
        { category: 'Groceries', amount: 15000 },
        { category: 'groceries', amount: 15000 },
      ],
    }),
    30000
  ).reason === 'duplicate-category',
  'rejects duplicate categories case-insensitively'
);

// 5) balanceParts fills the remainder so validation always passes
{
  const balanced = balanceParts(
    [
      { category: 'Retail & Department', amount: 18500 },
      { category: 'Home Reno', amount: 0 },
    ],
    30000
  );
  note(
    balanced[1].amount === 11500,
    'balanceParts fills the last part to the exact remainder (11500)'
  );
  const split = makeSplit({ txnId: 't1', parts: balanced });
  note(validateSplit(split, 30000).ok, 'a balanced split always validates');
}

// 6) rounding: three-way split of an odd amount still reconciles to the cent
{
  const odd = [{ id: 'x', category: 'A', amount: 100.0 }];
  const split = makeSplit({
    txnId: 'x',
    parts: balanceParts(
      [
        { category: 'A', amount: 33.33 },
        { category: 'B', amount: 33.33 },
        { category: 'C', amount: 0 },
      ],
      100
    ),
  });
  note(validateSplit(split, 100).ok, '3-way split of 100 with balanced remainder validates');
  const { total } = categoryTotalsWithSplits(odd, splitsByTxnId([split]));
  note(total === 100, `odd 3-way split reconciles to 100 exactly (got ${total})`);
}

// 7) multi-split precedence: newest wins
{
  const older = makeSplit({
    txnId: 't1',
    parts: [
      { category: 'A', amount: 15000 },
      { category: 'B', amount: 15000 },
    ],
    now: '2026-01-01T00:00:00Z',
  });
  const newer = makeSplit({
    txnId: 't1',
    parts: [
      { category: 'C', amount: 10000 },
      { category: 'D', amount: 20000 },
    ],
    now: '2026-06-01T00:00:00Z',
  });
  const map = splitsByTxnId([older, newer]);
  note(map.get('t1') === newer, 'when a txn has two split records, the newest wins');
}

console.log(`\n checks: ${pass} passed, ${fail} failed`);
console.log('='.repeat(72));
console.log(
  fail === 0
    ? ' RESULT: a split redistributes one row across categories WITHOUT double-\n         counting it; the grand total is byte-identical split or unsplit; an\n         invalid split is rejected and falls back safely. Reconciliation holds.'
    : ' RESULT: FAILURES ABOVE.'
);
console.log('='.repeat(72));
process.exit(fail ? 1 : 0);
