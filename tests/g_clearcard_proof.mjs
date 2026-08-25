// G proof: the extended clear-card logic (deadline-passed + payoff-feasibility),
// run against the REAL, shipped goals.js - not a local recreation. Proves:
// met is UNCHANGED (log protection preserved); passed-deadline wording now
// SAYS passed; feasibility is now stated (on-track vs not); unknown-rate
// cases keep the old calm wording; and no blame language creeps in even
// when behind. This is the standing gate; g_clearcard_proof_design.mjs (if
// kept) was the pre-edit sandbox used to validate the design before the
// real edit landed.
import { goalProgress, buildGoalModel } from '../application/analysis/goals.js';

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
console.log(' G CLEAR-CARD ENGINE EXTENSION - proof (real goals.js)');
console.log('='.repeat(72));

const asOf = '2026-08-31';

// 1) met is UNCHANGED across every case (log protection preserved) - checked
// directly against the old engine's own rule (balance <= 1), since the real
// goals.js has only ONE goalProgress now, not a "current" vs "extended" pair.
{
  for (const [bal, td] of [
    [0, '2026-12-31'],
    [50000, '2026-01-01'],
    [257610.28, '2026-12-31'],
  ]) {
    const g = { type: 'clear-card', targetDate: td };
    const p = goalProgress(g, { asOf, cardBalance: bal });
    note(p.met === bal <= 1, `met is balance<=1 for balance ${bal} (got ${p.met})`);
  }
}

// 2) PASSED DEADLINE: wording now SAYS passed
{
  const g = { type: 'clear-card', targetDate: '2020-01-01' };
  const p = goalProgress(g, { asOf, cardBalance: 50000 });
  const m = buildGoalModel(g, p, null, {});
  note(p.deadlinePassed === true, 'passed deadline detected');
  note(/passed/i.test(m.detail), 'wording SAYS the deadline has passed');
  const gf = { type: 'clear-card', targetDate: '2099-01-01' };
  const mf = buildGoalModel(gf, goalProgress(gf, { asOf, cardBalance: 50000 }), null, {});
  note(!/passed/i.test(mf.detail), 'future deadline wording does NOT say passed');
}

// 3) FEASIBILITY: an achievable pace reads on-track; an impossible one reads behind
{
  const g = { type: 'clear-card', targetDate: '2026-12-31' };
  const easy = goalProgress(g, {
    asOf,
    cardBalance: 10000,
    eairFrac: 0.42,
    typicalPayment: 60000,
  });
  note(easy.feasible === true, 'small balance + real payment -> feasible');
  note(/on track/i.test(buildGoalModel(g, easy, null, {}).detail), 'states it is on track');
  const hard = goalProgress(g, {
    asOf,
    cardBalance: 10000000,
    eairFrac: 0.42,
    typicalPayment: 60000,
  });
  note(hard.feasible === false, 'huge balance + small payment -> NOT feasible');
  note(
    /not by it|after/i.test(buildGoalModel(g, hard, null, {}).detail),
    'states it would clear after, not by it'
  );
}

// 4) NO rate/payment data -> feasibility unknown -> OLD calm wording preserved
{
  const g = { type: 'clear-card', targetDate: '2026-12-31' };
  const p = goalProgress(g, { asOf, cardBalance: 50000 });
  note(p.feasible === null, 'no rate/payment -> feasibility unknown (null)');
  const m = buildGoalModel(g, p, null, {});
  note(
    !/on track|after/i.test(m.detail) && /needs about/.test(m.detail),
    'unknown feasibility falls back to the old wording, never a false verdict'
  );
}

// 5) no-blame language even when behind
{
  const g = { type: 'clear-card', targetDate: '2026-12-31' };
  const m = buildGoalModel(
    g,
    goalProgress(g, {
      asOf,
      cardBalance: 10000000,
      eairFrac: 0.42,
      typicalPayment: 60000,
    }),
    null,
    {}
  );
  note(
    !/failed|bad|should have|too late|irresponsible/i.test(m.detail),
    'no blame language in the behind case'
  );
}

console.log(`\n checks: ${pass} passed, ${fail} failed`);
console.log('='.repeat(72));
console.log(
  fail === 0
    ? ' RESULT: clear-card now detects a passed deadline and states payoff feasibility,\n         met is unchanged (log protection intact), and unknown-rate cases keep the\n         old calm wording. The new engine is now a true superset of the old.'
    : ' RESULT: FAILURES ABOVE.'
);
console.log('='.repeat(72));
process.exit(fail ? 1 : 0);
