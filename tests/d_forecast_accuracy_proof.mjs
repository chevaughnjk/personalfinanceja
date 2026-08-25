// D proof: the forecast accuracy scorer. The load-bearing invariant is that an
// IMMATURE snapshot (horizon not yet passed, or ledger short of it) is NEVER
// scored - no verdict before the horizon. Also proves: error direction
// (optimistic = predicted > actual); the 'building' honest state below the
// minimum; the signed-median lean (symmetric spread reads 'about right'); and
// single-source (actual comes from the injected liquidAt, not a private calc).
import {
  snapshotScorable,
  scoreSnapshot,
  accuracyReport,
  buildAccuracyModel,
} from '../application/analysis/forecast-accuracy.js';

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
const TODAY = '2026-07-01';
const BANKMAX = '2026-07-01'; // ledger reaches today

// helper: a snapshot with a given asOf/horizon/predicted, horizonEnd derived
const H = (days) => days;
function snap({ asOf, horizonDays, predictedEnding, predictedLow = predictedEnding }) {
  // horizonEnd = asOf + horizonDays
  const end = new Date(new Date(asOf + 'T00:00:00Z').getTime() + horizonDays * 86400000)
    .toISOString()
    .slice(0, 10);
  return {
    id: `fc_${asOf}_${horizonDays}`,
    asOf,
    horizonDays,
    horizonEnd: end,
    predictedEnding,
    predictedLow,
    predictedLowDate: end,
  };
}
// a liquidAt curried over a fixed map of date->actual balance
function liquidFrom(map) {
  return (dateISO) => (dateISO in map ? map[dateISO] : null);
}

console.log('='.repeat(72));
console.log(' D FORECAST ACCURACY SCORER - proof');
console.log('='.repeat(72));

// 1) THE INVARIANT: immature snapshot (horizon in the future) is NOT scorable
{
  const s = snap({
    asOf: '2026-06-15',
    horizonDays: 30,
    predictedEnding: 100000,
  }); // ends 2026-07-15, after TODAY(07-01)
  const v = snapshotScorable(s, TODAY, BANKMAX);
  note(!v.ok && v.reason === 'immature', 'immature snapshot (horizon not yet passed) is EXCLUDED');
}
// 1b) matured by date but ledger doesn't reach horizon -> excluded
{
  const s = snap({
    asOf: '2026-05-01',
    horizonDays: 30,
    predictedEnding: 100000,
  }); // ends 2026-05-31, past
  const v = snapshotScorable(s, TODAY, '2026-05-15'); // ledger only to mid-May
  note(
    !v.ok && v.reason === 'ledger-short',
    'matured-by-date but ledger short of horizon is EXCLUDED'
  );
}
// 1c) genuinely matured + ledger reaches it -> scorable
{
  const s = snap({
    asOf: '2026-05-01',
    horizonDays: 30,
    predictedEnding: 100000,
  }); // ends 2026-05-31
  note(
    snapshotScorable(s, TODAY, BANKMAX).ok,
    'matured snapshot with ledger reaching horizon IS scorable'
  );
}

// 2) error direction: predicted HIGHER than actual = optimistic
{
  const s = snap({
    asOf: '2026-05-01',
    horizonDays: 30,
    predictedEnding: 120000,
  }); // ends 05-31
  const opt = scoreSnapshot(s, liquidFrom({ '2026-05-31': 100000 }));
  note(
    opt.direction === 'optimistic' && opt.errorAbs === 20000,
    'predicted 120k vs actual 100k -> optimistic, +20k'
  );
  const cau = scoreSnapshot(
    snap({ asOf: '2026-05-01', horizonDays: 30, predictedEnding: 80000 }),
    liquidFrom({ '2026-05-31': 100000 })
  );
  note(
    cau.direction === 'cautious' && cau.errorAbs === -20000,
    'predicted 80k vs actual 100k -> cautious, -20k'
  );
  // errorPct uses max(50000,|actual|) denom
  note(opt.errorPct === 20, 'errorPct = 20% (20k / 100k)');
}

// 3) actual missing -> snapshot not scored (honest, not zero)
{
  const s = snap({
    asOf: '2026-05-01',
    horizonDays: 30,
    predictedEnding: 100000,
  });
  note(
    scoreSnapshot(s, liquidFrom({})) === null,
    'no actual balance at horizon -> NOT scored (null, never a fake 0)'
  );
}

// 4) 'building' state below the minimum
{
  const snaps = [
    snap({ asOf: '2026-05-01', horizonDays: 90, predictedEnding: 100000 }), // ends 2026-07-30 -> immature vs TODAY 07-01
  ];
  const rep = accuracyReport(snaps, liquidFrom({}), {
    todayISO: TODAY,
    bankMaxDate: BANKMAX,
    horizonDays: 90,
    minToScore: 3,
  });
  note(rep.state === 'building' && rep.scored === 0, 'below minimum -> building state, 0 scored');
  const vm = buildAccuracyModel(rep, cfg);
  note(
    vm.state === 'building' && /building history/.test(vm.tag),
    'model: honest building tag, no fabricated number'
  );
  note(
    !/\d+%/.test(vm.leadText) || /of \d/.test(vm.leadText),
    'building lead is a progress count (N of M), not an accuracy %'
  );
}

// 5) scored verdict: three matured 30-day snapshots, consistently optimistic
{
  const snaps = [
    snap({ asOf: '2026-04-01', horizonDays: 30, predictedEnding: 115000 }), // ends 05-01
    snap({ asOf: '2026-04-08', horizonDays: 30, predictedEnding: 110000 }), // ends 05-08
    snap({ asOf: '2026-04-15', horizonDays: 30, predictedEnding: 112000 }), // ends 05-15
  ];
  const actuals = {
    '2026-05-01': 100000,
    '2026-05-08': 100000,
    '2026-05-15': 100000,
  };
  const rep = accuracyReport(snaps, liquidFrom(actuals), {
    todayISO: TODAY,
    bankMaxDate: BANKMAX,
    horizonDays: 30,
    minToScore: 3,
  });
  note(rep.state === 'scored' && rep.scored === 3, 'three matured -> scored verdict');
  note(rep.lean === 'optimistic', 'consistently predicted-high -> lean optimistic');
  note(
    rep.medianErrorPct === 12,
    `median error ~12% (median of 15%,10%,12%) got ${rep.medianErrorPct}`
  );
  const vm = buildAccuracyModel(rep, cfg);
  note(
    /optimistic/.test(vm.tag) && vm.tone === 'watch',
    'model: reports "a little optimistic", watch tone'
  );
  note(!/over budget|wrong|failed|bad/i.test(vm.detail), 'no blame language in the verdict');
}

// 6) signed-median: a SYMMETRIC spread reads 'about right', not falsely leaning
{
  const snaps = [
    snap({ asOf: '2026-04-01', horizonDays: 30, predictedEnding: 120000 }), // +20k
    snap({ asOf: '2026-04-08', horizonDays: 30, predictedEnding: 100000 }), //  0
    snap({ asOf: '2026-04-15', horizonDays: 30, predictedEnding: 80000 }), // -20k
  ];
  const actuals = {
    '2026-05-01': 100000,
    '2026-05-08': 100000,
    '2026-05-15': 100000,
  };
  const rep = accuracyReport(snaps, liquidFrom(actuals), {
    todayISO: TODAY,
    bankMaxDate: BANKMAX,
    horizonDays: 30,
    minToScore: 3,
  });
  note(
    rep.lean === 'about-right',
    'symmetric errors (median 0) -> "about right", not falsely biased'
  );
  note(buildAccuracyModel(rep, cfg).tone === 'good', 'model: about-right reads as good tone');
}

console.log(`\n checks: ${pass} passed, ${fail} failed`);
console.log('='.repeat(72));
console.log(
  fail === 0
    ? " RESULT: immature snapshots are never scored, direction is right, the panel is\n         honest while history builds, and a symmetric spread reads 'about right'.\n         The forecast can now report its own bias without drifting into fiction."
    : ' RESULT: FAILURES ABOVE.'
);
console.log('='.repeat(72));
process.exit(fail ? 1 : 0);
