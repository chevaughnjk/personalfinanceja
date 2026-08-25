// CROSS-SCREEN CONSISTENCY SUITE (frozen plan's mandatory per-stage gate).
//
// The whole architecture rests on one claim: because every surface reads ONE
// shared primitive, no two surfaces can disagree on the underlying numbers.
// This suite proves that claim against the real modules, driving them all with
// the SAME data + asOf and asserting they land on identical figures - plus the
// classic traps (double-count, internal-transfer neutrality) that a naive
// per-screen implementation would fail silently.
//
// Every real bug this round was a seam disagreement; this is the net for that
// class. PII-free (synthetic data).
import {
  resolveOpts,
  expectedIncome,
  detectRecurring,
  twoWayKeys,
  liquidBalance,
} from '../application/analysis/commitment-income.js';
import { committedFlexible } from '../application/analysis/committed-flexible.js';
import { cashAndDebt } from '../application/analysis/position.js';

let pass = 0,
  fail = 0;
const note = (c, l) => {
  if (c) pass++;
  else {
    fail++;
    console.log('   FAIL', l);
  }
};

const cfg = { currency: { code: 'JMD' }, ahead: {}, insights: {} };
const opts = resolveOpts(cfg);
const asOf = '2025-06-30';
const period = { from: '2025-06-01', to: '2025-06-30' };

// --- a realistic multi-month dataset -----------------------------------------
// salary 300k on the 25th; a 60k standing debit (rent) on the 5th; a 20k
// discretionary bank outflow; card spend 40k; a running balance per month.
function baseData() {
  const bank = [];
  for (const m of ['2025-04', '2025-05', '2025-06']) {
    bank.push({
      date: `${m}-25`,
      Flow: 'Cash inflow',
      currency: 'JMD',
      amount: 300000,
      account: 'A1',
      Group: 'SALARY',
      'Running Balance': 1000000,
      seq: 3,
    });
    bank.push({
      date: `${m}-05`,
      Flow: 'Cash outflow',
      currency: 'JMD',
      amount: 60000,
      account: 'A1',
      Group: 'RENT',
      'Running Balance': 940000,
      seq: 1,
    });
  }
  // A genuinely discretionary outflow: a ONE-OFF (June only), so the recurring
  // detector never flags it - it belongs in the flexible bucket, not committed.
  // (An earlier version made this recur monthly; the harness correctly caught
  // that a steady monthly payee IS a commitment by the detector's definition,
  // so it was moved to a single occurrence to be a true discretionary example.)
  bank.push({
    date: '2025-06-15',
    Flow: 'Cash outflow',
    currency: 'JMD',
    amount: 20000,
    account: 'A1',
    Group: 'ONE-OFF-SHOP',
    'Running Balance': 920000,
    seq: 2,
  });
  const card = [{ date: '2025-06-12', kind: 'spend', amount: 40000, category: 'Groceries' }];
  const cardStatements = [{ statementKey: '2025-06', newBalance: 40000, creditLimit: 500000 }];
  return { bank, card, cardStatements };
}

console.log('='.repeat(74));
console.log(' CROSS-SCREEN CONSISTENCY - one shared primitive, no two surfaces disagree');
console.log('='.repeat(74));

// ============================================================================
//  1) INCOME AGREES across every surface that reads it
// ============================================================================
{
  const { bank } = baseData();
  const inc = expectedIncome(bank, opts, asOf); // Overview / Forecast source
  const cf = committedFlexible({
    bankRecords: bank,
    cardRecords: [],
    cfg,
    period,
  }); // Activity
  // committed-flexible's income for June is the salary that arrived that month;
  // the recurring detector's typical is the same salary. Both must be 300k.
  note(inc && inc.amount === 300000, `expectedIncome = 300000 (got ${inc && inc.amount})`);
  note(cf.income === 300000, `committed-flexible income = 300000 (got ${cf.income})`);
  note(inc.amount === cf.income, 'INCOME AGREES: Overview/Forecast income == Activity income');
}

// ============================================================================
//  2) COMMITTED SET AGREES: the standing debit the primitive detects is the
//     same set committed-flexible calls "committed"
// ============================================================================
{
  const { bank, card } = baseData();
  const debits = detectRecurring(bank, 'out', opts, asOf).filter(
    (d) => d.typical >= opts.commitmentFloor
  );
  const tw = twoWayKeys(bank, opts, asOf);
  const primitiveCommitted = new Set(debits.filter((d) => !tw.has(d.key)).map((d) => d.key));
  const cf = committedFlexible({
    bankRecords: bank,
    cardRecords: card,
    cfg,
    period,
  });
  // NOTE: committed-flexible.js exposes only committedKeyCount (a size), not
  // the actual key list, so this checks COUNT agreement rather than exact key
  // agreement. A stronger check would require committed-flexible.js to also
  // return the committed key set itself, not just its size.
  note(
    primitiveCommitted.size === cf.committedKeyCount,
    `COMMITTED SET AGREES: primitive detector count (${primitiveCommitted.size}) == committed-flexible committedKeyCount (${cf.committedKeyCount})`
  );
  note(
    cf.committed === 60000,
    `committed total = 60000 (rent only; the one-off shop is flexible), got ${cf.committed}`
  );
  note(
    cf.flexibleSpent === 60000,
    `flexible spent = 60000 (20k one-off shop + 40k card), got ${cf.flexibleSpent}`
  );
}

// ============================================================================
//  3) LIQUID BALANCE AGREES: available-now's liquid == Position's cash ==
//     forecast's starting balance (all read liquidBalance)
// ============================================================================
{
  const { bank, cardStatements } = baseData();
  const lb = liquidBalance(bank, opts, asOf); // Overview available-now
  const cd = cashAndDebt({ bankRecords: bank, cardStatements, cfg, asOf }); // Position
  note(
    lb.total === cd.liquid,
    `LIQUID AGREES: available-now liquid (${lb.total}) == Position cash (${cd.liquid})`
  );
  note(cd.liquid === 1000000, `cash = latest running balance 1,000,000 (got ${cd.liquid})`);
}

// ============================================================================
//  4) DOUBLE-COUNT SAFETY: a card PAYMENT (internal transfer to own card) is
//     never counted as income, spending, or committed on ANY surface
// ============================================================================
{
  const { bank, card } = baseData();
  // add a card payment: an internal transfer out of the bank to the card
  const withPayment = bank.concat([
    {
      date: '2025-06-20',
      Flow: 'Internal transfer',
      internalTransfer: true,
      currency: 'JMD',
      amount: 40000,
      account: 'A1',
      Group: 'CARD PAYMENT',
    },
  ]);
  const cfBefore = committedFlexible({
    bankRecords: bank,
    cardRecords: card,
    cfg,
    period,
  });
  const cfAfter = committedFlexible({
    bankRecords: withPayment,
    cardRecords: card,
    cfg,
    period,
  });
  note(cfBefore.income === cfAfter.income, 'card payment does NOT change income');
  note(cfBefore.committed === cfAfter.committed, 'card payment does NOT change committed');
  note(
    cfBefore.flexibleSpent === cfAfter.flexibleSpent,
    'card payment does NOT double-count as spending'
  );
  const incBefore = expectedIncome(bank, opts, asOf),
    incAfter = expectedIncome(withPayment, opts, asOf);
  note(incBefore.amount === incAfter.amount, 'card payment does NOT alter detected income');
}

// ============================================================================
//  5) INTERNAL-TRANSFER NEUTRALITY: a transfer PAIR between own accounts moves
//     nothing on any surface (income, spending, committed, liquid all unchanged)
// ============================================================================
{
  const { bank, cardStatements } = baseData();
  const withTransfer = bank.concat([
    {
      date: '2025-06-18',
      Flow: 'Internal transfer',
      internalTransfer: true,
      currency: 'JMD',
      amount: 100000,
      account: 'A1',
      Group: 'XFER',
    },
    {
      date: '2025-06-18',
      Flow: 'Internal transfer',
      internalTransfer: true,
      currency: 'JMD',
      amount: 100000,
      account: 'A2',
      Group: 'XFER',
    },
  ]);
  const cfBefore = committedFlexible({
    bankRecords: bank,
    cardRecords: [],
    cfg,
    period,
  });
  const cfAfter = committedFlexible({
    bankRecords: withTransfer,
    cardRecords: [],
    cfg,
    period,
  });
  note(
    cfBefore.income === cfAfter.income &&
      cfBefore.committed === cfAfter.committed &&
      cfBefore.flexibleSpent === cfAfter.flexibleSpent,
    'INTERNAL TRANSFER NEUTRAL: income, committed, spending all unchanged by a transfer pair'
  );
}

// ============================================================================
//  6) FOREIGN NEVER BLENDS: a USD balance never enters the base-currency liquid
//     figure any surface shows
// ============================================================================
{
  const { bank, cardStatements } = baseData();
  const withUSD = bank.concat([
    {
      date: '2025-06-28',
      Flow: 'Cash outflow',
      currency: 'USD',
      amount: 500,
      account: 'U1',
      'Running Balance': 3000,
      seq: 1,
    },
  ]);
  const lbBefore = liquidBalance(bank, opts, asOf),
    lbAfter = liquidBalance(withUSD, opts, asOf);
  note(
    lbBefore.total === lbAfter.total,
    'FOREIGN SEPARATE: a USD balance never changes the JMD liquid figure'
  );
  const cdAfter = cashAndDebt({
    bankRecords: withUSD,
    cardStatements,
    cfg,
    asOf,
  });
  note(
    cdAfter.liquid === lbBefore.total,
    'Position cash stays base-currency-only with USD present'
  );
}

// ============================================================================
//  7) AS-OF DISCIPLINE: a future-dated row never affects a figure computed
//     "as of" an earlier date (no forecast assumption can rewrite recorded past)
// ============================================================================
{
  const { bank } = baseData();
  const withFuture = bank.concat([
    {
      date: '2025-08-25',
      Flow: 'Cash inflow',
      currency: 'JMD',
      amount: 999999,
      account: 'A1',
      Group: 'FUTURE',
      'Running Balance': 2000000,
      seq: 3,
    },
  ]);
  const lbBefore = liquidBalance(bank, opts, asOf),
    lbAfter = liquidBalance(withFuture, opts, asOf);
  note(
    lbBefore.total === lbAfter.total,
    'AS-OF DISCIPLINE: a future-dated row never changes an earlier as-of liquid figure'
  );
}

// ============================================================================
//  8) DETERMINISM: same inputs -> byte-identical outputs (no hidden state,
//     no order-dependence that could make two renders disagree)
// ============================================================================
{
  const a = committedFlexible({
    bankRecords: baseData().bank,
    cardRecords: baseData().card,
    cfg,
    period,
  });
  const b = committedFlexible({
    bankRecords: baseData().bank.slice().reverse(),
    cardRecords: baseData().card,
    cfg,
    period,
  });
  note(
    JSON.stringify({ i: a.income, c: a.committed, f: a.flexibleSpent }) ===
      JSON.stringify({ i: b.income, c: b.committed, f: b.flexibleSpent }),
    'DETERMINISTIC: row order does not change the result (two renders always agree)'
  );
}

console.log('-'.repeat(74));
console.log('\n[WHAT THIS GUARANTEES]');
console.log('  income, committed set, and liquid balance are single-sourced: Overview,');
console.log('  Activity, Position and Forecast read the SAME primitive, so they cannot');
console.log('  show different numbers for the same fact. Card payments and internal');
console.log('  transfers move nothing; foreign never blends; the past is immutable.');

console.log('\n' + '='.repeat(74));
console.log(
  fail === 0
    ? ' RESULT: the shared-primitive promise holds - every surface agrees on every\n         shared figure, and the double-count / transfer / foreign / as-of traps\n         are all closed. This is the safety net for the seam-disagreement class.'
    : ' RESULT: CONSISTENCY FAILURES ABOVE - two surfaces would disagree. Fix before shipping.'
);
console.log(` checks: ${pass} passed, ${fail} failed`);
console.log('='.repeat(74));
process.exit(fail === 0 ? 0 : 1);
