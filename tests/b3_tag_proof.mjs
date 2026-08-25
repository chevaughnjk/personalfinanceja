// B3a proof: the tag reader + membership model, exercised the way the app will.
// Covers the reconciliation-adjacent risks specific to tags: totals sum only
// matching rows; membership survives RE-IMPORT (rows replaced with same-id rows);
// a deleted/absent txn degrades gracefully (contributes 0, flagged missing);
// target progress is correct; add/remove are non-mutating and reflect in totals;
// and the view-model carries the id (the B1 seam, pre-empted).
import { makeTag, tagAdd, tagRemove, tagTotals, buildTagModel } from '../application/analysis/tag-totals.js';

let pass = 0,
  fail = 0;
const note = (c, l) => {
  if (c) pass++;
  else {
    fail++;
    console.log('   FAIL', l);
  }
};
const cfg = { currency: { code: 'JMD' } };
console.log('='.repeat(72));
console.log(' B3a TAG READER + MEMBERSHIP PROOF');
console.log('='.repeat(72));

// synthetic rows, card+bank mixed, stable ids
const rows = [
  {
    id: 'c1',
    amount: 12000,
    kind: 'spend',
    category: 'Retail',
    date: '2026-07-02',
  },
  {
    id: 'c2',
    amount: 8000,
    kind: 'spend',
    category: 'Hardware',
    date: '2026-07-05',
  },
  {
    id: 'c3',
    amount: -3000,
    kind: 'refund',
    category: 'Retail',
    date: '2026-07-06',
  }, // a refund (abs summed)
  { id: 'b1', amount: 25000, direction: 'out', date: '2026-07-10' }, // a bank row
  { id: 'x9', amount: 9999, kind: 'spend', date: '2026-07-11' }, // NOT tagged
];

// 1) makeTag shape
{
  const t = makeTag({ name: '  Home Reno  ', target: 50000 });
  note(t.id.startsWith('tag_'), 'makeTag: id present');
  note(t.name === 'Home Reno', 'makeTag: name trimmed');
  note(t.target === 50000, 'makeTag: positive target kept');
  note(Array.isArray(t.txnIds) && t.txnIds.length === 0, 'makeTag: empty membership');
  const t0 = makeTag({ name: 'No target', target: 0 });
  note(t0.target === null, 'makeTag: non-positive target -> null (no target)');
}

// 2) add membership (non-mutating) + reader sums only matching rows
{
  let t = makeTag({ name: 'Renovation', target: 50000 });
  const orig = t;
  t = tagAdd(t, 'c1');
  t = tagAdd(t, 'c2');
  t = tagAdd(t, 'b1');
  t = tagAdd(t, 'c3');
  note(orig.txnIds.length === 0, 'tagAdd is non-mutating (original still empty)');
  note(t.txnIds.length === 4, 'tagAdd accumulated 4 members');
  note(
    JSON.stringify(tagAdd(t, 'c1').txnIds) === JSON.stringify(t.txnIds),
    'tagAdd idempotent (re-add is a no-op)'
  );
  const [tt] = tagTotals([t], rows);
  // sum abs: 12000 + 8000 + 25000 + 3000(refund abs) = 48000
  note(tt.total === 48000, `reader sums abs of matched rows = 48000 (got ${tt.total})`);
  note(tt.count === 4, 'reader counts 4 matched members');
  note(
    tt.total < 50000 && tt.remaining === 2000 && tt.pctOfTarget === 96 && !tt.overTarget,
    'target progress: 2000 left, 96%, not over'
  );
}

// 3) RE-IMPORT: rows replaced with a fresh array carrying the SAME ids -> total unchanged
{
  let t = makeTag({ name: 'Reno' });
  t = tagAdd(t, 'c1');
  t = tagAdd(t, 'b1');
  const before = tagTotals([t], rows)[0].total;
  const reimported = rows.map((r) => ({ ...r })); // new objects, same ids (what re-import produces)
  const after = tagTotals([t], reimported)[0].total;
  note(
    before === after && before === 37000,
    `membership survives re-import (total 37000 both, got ${before}/${after})`
  );
}

// 4) a member id with NO current row degrades gracefully
{
  let t = makeTag({ name: 'Holiday' });
  t = tagAdd(t, 'c1');
  t = tagAdd(t, 'DELETED_TXN');
  const [tt] = tagTotals([t], rows);
  note(tt.total === 12000, 'absent member contributes 0 to the total');
  note(tt.count === 1 && tt.missing === 1, 'absent member is not counted but is flagged missing');
}

// 5) remove membership (non-mutating) reflects in the total
{
  let t = makeTag({ name: 'Reno' });
  t = tagAdd(t, 'c1');
  t = tagAdd(t, 'c2');
  const beforeRemove = t;
  t = tagRemove(t, 'c1');
  note(beforeRemove.txnIds.length === 2, 'tagRemove non-mutating (original keeps 2)');
  note(
    tagTotals([t], rows)[0].total === 8000,
    'after remove, total drops to the remaining member (8000)'
  );
}

// 6) over-target tone + view-model carries id (B1 seam)
{
  let t = makeTag({ name: 'Splurge', target: 10000 });
  t = tagAdd(t, 'c1'); // 12000 > 10000
  const [tt] = tagTotals([t], rows);
  note(tt.overTarget === true, 'over-target detected');
  const vm = buildTagModel(tt, cfg);
  note(vm.id === t.id, 'view-model carries the tag id (remove/edit target is real, not undefined)');
  note(
    vm.tag === 'over target' && vm.tone === 'watch',
    'over-target model: tag "over target", tone watch'
  );
  note(!/\b(my|your|you)\b/i.test(vm.tag), 'tag label is pronoun-free');
}

// 7) no-target tag renders a plain count
{
  let t = makeTag({ name: 'Work trips' });
  t = tagAdd(t, 'c1');
  t = tagAdd(t, 'c2');
  const vm = buildTagModel(tagTotals([t], rows)[0], cfg);
  note(/2 transactions/.test(vm.tag), 'no-target tag shows a plain transaction count');
  note(vm.targetText === null, 'no-target tag has no target text');
}

console.log(`\n checks: ${pass} passed, ${fail} failed`);
console.log('='.repeat(72));
console.log(
  fail === 0
    ? ' RESULT: tag totals sum correctly, membership survives re-import, absent members\n         degrade gracefully, target progress is right, add/remove are non-mutating,\n         and the model carries the id. Reader is sound.'
    : ' RESULT: FAILURES ABOVE.'
);
console.log('='.repeat(72));
process.exit(fail ? 1 : 0);
