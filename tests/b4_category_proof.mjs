// B4 proof: custom categories become first-class register members and are
// maintained throughout. Covers: shape; boot merge (custom appended, shipped
// wins clash, order preserved); duplicate rejection; the register list the
// picker reads includes custom names; usage counting; delete-integrity (blocked
// in use, allowed unused, shipped never deletable); and a custom name gets a
// valid deterministic colour with no extra wiring.
import {
  makeCustomCategory,
  mergeCategories,
  categoryNameExists,
  categoryUsage,
  canDeleteCategory,
  colourSlot,
} from '../application/analysis/custom-categories.js';

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
console.log(' B4 CUSTOM CATEGORIES PROOF');
console.log('='.repeat(72));

// a small stand-in for the shipped register (real shape)
const shipped = [
  { name: 'Groceries', patterns: { universal: ['x'] } },
  { name: 'Dining & Takeout', patterns: { universal: ['y'] } },
  { name: 'Fuel & Transport', patterns: { universal: ['z'] } },
];

// 1) shape
{
  const c = makeCustomCategory({
    name: '  Home  Renovation ',
    description: 'kitchen + bath',
  });
  note(c.name === 'Home Renovation', 'name trimmed/collapsed');
  note(c.custom === true, 'flagged custom:true');
  note(
    JSON.stringify(c.patterns) === '{"universal":[]}',
    'empty patterns (assign-only, never auto-matches)'
  );
  note(c.description === 'kitchen + bath', 'description kept');
}

// 2) boot merge: custom appended, order preserved, shipped wins a name clash
{
  const custom = [makeCustomCategory({ name: 'Renovation' }), makeCustomCategory({ name: 'Kids' })];
  const merged = mergeCategories(shipped, custom);
  note(merged.length === 5, 'merged register has shipped(3)+custom(2)=5');
  note(
    merged
      .slice(0, 3)
      .map((c) => c.name)
      .join('|') === 'Groceries|Dining & Takeout|Fuel & Transport',
    'shipped order preserved, first'
  );
  note(merged[3].name === 'Renovation' && merged[4].name === 'Kids', 'custom appended in order');
  // clash: a custom named like a shipped one is dropped (shipped wins)
  const clash = mergeCategories(shipped, [makeCustomCategory({ name: 'groceries' })]);
  note(clash.length === 3, 'a custom clashing with a shipped name (case-insensitive) is dropped');
  note(clash.filter((c) => c.custom).length === 0, 'no custom shadow of a shipped category');
}

// 3) the register list the PICKER reads includes custom names (the user's use case)
{
  const merged = mergeCategories(shipped, [makeCustomCategory({ name: 'Renovation' })]);
  const pickerNames = merged.map((c) => c.name); // exactly what openCategoryPicker builds
  note(
    pickerNames.includes('Renovation'),
    'picker register includes the custom category (assignable to any transaction)'
  );
}

// 4) duplicate rejection
{
  const merged = mergeCategories(shipped, [makeCustomCategory({ name: 'Renovation' })]);
  note(
    categoryNameExists('renovation', merged) === true,
    'duplicate detection is case-insensitive'
  );
  note(
    categoryNameExists('Brand New', merged) === false,
    'a genuinely new name is not a duplicate'
  );
}

// 5) usage counting across resolved rows AND rules
{
  const rows = [
    { id: 'r1', category: 'Renovation', amount: 10000 },
    { id: 'r2', category: 'Renovation', amount: 5000 },
    { id: 'r3', category: 'Groceries', amount: 3000 },
  ];
  const rules = [{ match: 'HOMEDEPOT', category: 'Renovation' }];
  const u = categoryUsage('Renovation', rows, rules);
  note(u.rows === 2 && u.rules === 1 && u.total === 3, 'usage counts 2 rows + 1 rule = 3');
  note(
    categoryUsage('Groceries', rows, rules).total === 1,
    'unrelated category counts only its own use'
  );
}

// 6) delete-integrity
{
  const merged = mergeCategories(shipped, [
    makeCustomCategory({ name: 'Renovation' }),
    makeCustomCategory({ name: 'Unused' }),
  ]);
  const rows = [{ id: 'r1', category: 'Renovation', amount: 1 }];
  const rules = [];
  const inUse = canDeleteCategory('Renovation', merged, rows, rules);
  note(
    inUse.ok === false && inUse.reason === 'in-use' && inUse.usage.total === 1,
    'a custom category in use CANNOT be deleted (blocked, count reported)'
  );
  const unused = canDeleteCategory('Unused', merged, rows, rules);
  note(unused.ok === true && unused.reason === 'ok', 'an unused custom category CAN be deleted');
  const shippedDel = canDeleteCategory('Groceries', merged, rows, rules);
  note(
    shippedDel.ok === false && shippedDel.reason === 'shipped',
    'a shipped category is NEVER deletable'
  );
}

// 7) a custom name gets a valid, deterministic colour with no extra wiring
{
  const PALETTE = ['#2f6fb0', '#3f9d6b', '#c98a1b', '#a05fb4', '#4aa3a3', '#c65b7c'];
  const a = colourSlot('Renovation', PALETTE);
  const b = colourSlot('Renovation', PALETTE);
  note(PALETTE.includes(a), 'custom name maps to a real palette colour');
  note(a === b, 'colour is deterministic (stable across renders/reloads)');
}

// 8) a category used ONLY via a split part still blocks deletion (the gap B4 missed)
{
  const merged = mergeCategories(shipped, [makeCustomCategory({ name: 'SplitOnly' })]);
  const rows = [];
  const rules = [];
  const splits = [
    {
      id: 's1',
      txnId: 't1',
      parts: [
        { category: 'Groceries', amount: 5000 },
        { category: 'SplitOnly', amount: 5000 },
      ],
    },
  ];
  const u = categoryUsage('SplitOnly', rows, rules, splits);
  note(u.splits === 1 && u.total === 1, 'split-part usage is counted');
  const check = canDeleteCategory('SplitOnly', merged, rows, rules, splits);
  note(
    check.ok === false && check.reason === 'in-use',
    'a category used only by a split part cannot be deleted'
  );
}

console.log(`\n checks: ${pass} passed, ${fail} failed`);
console.log('='.repeat(72));
console.log(
  fail === 0
    ? ' RESULT: custom categories merge into the one register the whole app reads,\n         are assignable to any transaction, reject duplicates, count usage, block\n         unsafe deletion, and get a stable colour for free. Sound.'
    : ' RESULT: FAILURES ABOVE.'
);
console.log('='.repeat(72));
process.exit(fail ? 1 : 0);
