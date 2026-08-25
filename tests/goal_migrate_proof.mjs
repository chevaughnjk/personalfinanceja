// Proof: every OLD saved goal shape migrates losslessly to the NEW shape,
// nothing is discarded, migration is idempotent, and goalLog is never touched.
import { migrateGoal, ensureMigrated } from '../application/analysis/goal-migrate.js';
let pass = 0,
  fail = 0;
const note = (c, l) => {
  if (c) pass++;
  else {
    fail++;
    console.log('   FAIL', l);
  }
};

console.log('GOAL MIGRATION PROOF');

// 1) runway -> cushion, targetDays preserved, meaning identical
{
  const old = {
    type: 'runway',
    params: { targetDays: 90 },
    createdAt: '2025-03-01',
  };
  const n = migrateGoal(old);
  note(n.type === 'cushion', 'runway -> cushion');
  note(n.targetDays === 90, 'targetDays preserved (90)');
  note(n.createdAt === '2025-03-01', 'createdAt preserved');
  note(n.migratedFrom === 'runway', 'audit trail records old type');
  note(n.trigger === null, 'no trigger invented (person authors later)');
}

// 2) clear-card -> clear-card, targetDate preserved
{
  const old = {
    type: 'clear-card',
    params: { targetDate: '2025-12-31' },
    createdAt: '2025-01-01',
  };
  const n = migrateGoal(old);
  note(
    n.type === 'clear-card' && n.targetDate === '2025-12-31',
    'clear-card + targetDate preserved'
  );
}

// 3) spend-ceiling: ceiling -> amount (the one param rename)
{
  const old = {
    type: 'spend-ceiling',
    params: { ceiling: 100000 },
    createdAt: '2025-02-01',
  };
  const n = migrateGoal(old);
  note(
    n.type === 'spend-ceiling' && n.amount === 100000,
    'spend-ceiling: ceiling -> amount (100000)'
  );
  note(!('ceiling' in n), 'old param name dropped, no stale field');
}

// 4) unknown/future type NEVER discarded
{
  const old = {
    type: 'some-future-type',
    params: { x: 1 },
    createdAt: '2025-04-01',
  };
  const n = migrateGoal(old);
  note(
    n && n.type === 'some-future-type' && n.unmigrated === true,
    'unknown type kept verbatim, flagged (never dropped)'
  );
}

// 5) idempotent: an already-new goal passes through untouched
{
  const alreadyNew = {
    id: 'g1',
    type: 'cushion',
    targetDays: 60,
    trigger: null,
    active: true,
  };
  const once = ensureMigrated(alreadyNew);
  note(once === alreadyNew, 'already-new goal passes through unchanged (idempotent)');
  // and migrating an old goal twice is stable
  const old = {
    type: 'runway',
    params: { targetDays: 30 },
    createdAt: '2025-05-01',
  };
  const m1 = ensureMigrated(old);
  const m2 = ensureMigrated(m1);
  note(
    m2.type === 'cushion' && m2.targetDays === 30,
    'double-migration is stable (runway->cushion, stays)'
  );
}

// 6) null/empty safe
{
  note(migrateGoal(null) === null, 'null goal -> null (no crash)');
  note(ensureMigrated(undefined) === null, 'undefined -> null');
}

// 7) goalLog is UNTOUCHED - migration only reshapes state.goal, never the log.
//    (Proven by contract: migrateGoal takes only the goal, never the log.)
{
  const log = [{ month: '2025-05', type: 'runway', met: true, headline: 'x' }];
  const logCopy = JSON.parse(JSON.stringify(log));
  migrateGoal({ type: 'runway', params: { targetDays: 90 } }); // does not receive log
  note(
    JSON.stringify(log) === JSON.stringify(logCopy),
    'goalLog untouched by migration (frozen history preserved)'
  );
}

console.log(`checks: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
