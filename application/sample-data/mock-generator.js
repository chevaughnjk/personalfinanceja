import { roundMoney, MONTHS_SHORT } from '../core/shared-helpers.js';
import {
  transactionIdentity,
  bankTransactionIdentity,
  cardStatementHash,
  bankStatementHash,
} from '../statements/read-statements.js';
import {
  CARD_MERCHANTS,
  CARD_AMOUNTS,
  SUBSCRIPTION_POOL,
  BANK_BILLS,
  BANK_POS_MERCHANTS,
} from './mock-data.js';

const MON_ABBR = MONTHS_SHORT;
const USD_RATE = 158;

function hashSeed(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

function makeRng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick(rng, arr) {
  return arr[Math.floor(rng() * arr.length)];
}

function amountIn(rng, [min, max, mode]) {
  const m = mode == null ? min + (max - min) * 0.35 : mode;
  const u = rng();
  const c = max === min ? 0 : (m - min) / (max - min);
  const x =
    u < c
      ? min + Math.sqrt(u * (max - min) * (m - min))
      : max - Math.sqrt((1 - u) * (max - min) * (max - m));
  return roundMoney(x);
}

function weightedCategory(rng, weights) {
  const entries = Object.entries(weights);
  const total = entries.reduce((s, [, w]) => s + w, 0);
  let r = rng() * total;
  for (const [name, w] of entries) {
    r -= w;
    if (r <= 0) return name;
  }
  return entries[0][0];
}

// The set of subscriptions one person carries, chosen once and then billed
// unchanged every month. A persona can name its own set; otherwise a stable
// handful is drawn from the pool by the seeded generator, so different people
// carry different services while any one person's are steady month to month.
function chooseSubscriptions(persona, rng) {
  if (Array.isArray(persona.subscriptions)) {
    return SUBSCRIPTION_POOL.filter((s) => persona.subscriptions.includes(s.desc));
  }
  const k = persona.subscriptionCount == null ? 3 : persona.subscriptionCount;
  const pool = SUBSCRIPTION_POOL.slice();
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = pool[i];
    pool[i] = pool[j];
    pool[j] = tmp;
  }
  return pool.slice(0, Math.min(k, pool.length));
}

function iso(y, m, d) {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function lastDayOf(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function ymOf(y, m) {
  return `${y}-${String(m).padStart(2, '0')}`;
}

function monthSequence(count) {
  const now = new Date();
  let yy = now.getUTCFullYear();
  let mm = now.getUTCMonth();
  if (mm === 0) {
    mm = 12;
    yy -= 1;
  }
  const out = [];
  for (let i = 0; i < count; i++) {
    out.unshift({ y: yy, m: mm });
    mm -= 1;
    if (mm === 0) {
      mm = 12;
      yy -= 1;
    }
  }
  return out;
}

function cardRow(dateIso, desc, amount, opts = {}) {
  const t = {
    txn_date: dateIso,
    posting_date: dateIso,
    ref: opts.ref || '',
    description: desc,
    amount: roundMoney(amount),
    source_file: 'Mock Card Statements.pdf',
    foreign: opts.foreign || '',
    stitched: false,
  };
  return {
    ...t,
    id: transactionIdentity(t),
    categoryOverride: null,
    reviewDismissed: false,
    lastChanged: new Date().toISOString(),
    originDevice: 'mock',
  };
}

function bankRow(ev, running, seq, sseq, account, currency) {
  const signedAmount = roundMoney(ev.direction === 'in' ? ev.amount : -ev.amount);
  const balanceAfter = roundMoney(running + signedAmount);
  const t = {
    date: ev.date,
    rawDate: ev.rawDate,
    seq,
    sseq,
    type: ev.type || '',
    description: ev.desc,
    direction: ev.direction,
    amount: roundMoney(ev.amount),
    signedAmount,
    balanceAfter,
    account,
    currency,
    source_file: 'Mock Bank Statements.pdf',
  };
  return { row: { ...t, id: bankTransactionIdentity(t) }, balanceAfter };
}

function buildCardLedger(persona, rng) {
  const months = monthSequence(persona.months);
  const records = [];
  const statements = [];
  const perStatement = [];
  let previousBalance = 0;
  const subs = chooseSubscriptions(persona, rng);

  months.forEach(({ y, m }, monthIdx) => {
    const monthRecords = [];
    for (const sub of subs) {
      const day = 3 + Math.floor(rng() * 5);
      monthRecords.push(cardRow(iso(y, m, day), sub.desc, sub.amount));
    }
    // A real, disclosed card annual fee that posts once a year, in the month
    // the persona's card renews. It rides through as an ordinary purchase, so
    // the statement still reconciles, and it is exactly the kind of fixed
    // yearly charge a rewards card carries.
    if (persona.cardAnnualFee && monthIdx === (persona.cardAnnualFee.monthIndex || 0)) {
      const fee = persona.cardAnnualFee;
      const day = 1 + Math.floor(rng() * 3);
      monthRecords.push(cardRow(iso(y, m, day), fee.desc, fee.amount));
    }
    // A deliberate one-off big-ticket buy in a named month, such as a fridge or
    // a laptop, so there is a genuine outlier for the large-charge detector to
    // catch rather than only the ordinary month-to-month noise.
    for (const o of persona.cardOneOffs || []) {
      if (o.monthIndex !== monthIdx) continue;
      monthRecords.push(
        cardRow(iso(y, m, o.day || 15), o.desc, o.amount, o.foreign ? { foreign: o.foreign } : {})
      );
    }
    const n = persona.cardTxnsPerMonth;
    for (let i = 0; i < n; i++) {
      const cat = weightedCategory(rng, persona.spendWeights);
      const merchant = pick(rng, CARD_MERCHANTS[cat]);
      let amount = amountIn(rng, CARD_AMOUNTS[cat]);
      const day = 1 + Math.floor(rng() * lastDayOf(y, m));
      let opts = {};
      if (cat === 'Online Shopping' && rng() < 0.6) {
        const usd = roundMoney(5 + rng() * 90);
        amount = roundMoney(usd * USD_RATE);
        opts = { foreign: `${usd.toFixed(2)} USD` };
      }
      monthRecords.push(cardRow(iso(y, m, day), merchant, amount, opts));
    }
    // An occasional refund or return: a negative-amount card line, the way a
    // sent-back purchase or a reversed charge posts. It exercises the
    // categoriser's credit path and naturally reduces the month's purchases, so
    // the statement still reconciles with no special handling.
    if (persona.refundChance && rng() < persona.refundChance) {
      const cat = pick(rng, ['Retail & Department', 'Online Shopping']);
      const merchant = pick(rng, CARD_MERCHANTS[cat]);
      const day = 6 + Math.floor(rng() * 18);
      monthRecords.push(cardRow(iso(y, m, day), merchant, -amountIn(rng, [3000, 40000])));
    }

    const spendSum = roundMoney(monthRecords.reduce((s, r) => s + r.amount, 0));
    const revolver = persona.cardBehaviour === 'revolver';
    const interestRate = persona.interestRate == null ? 0.041 : persona.interestRate;
    const interestCharges =
      revolver && previousBalance > 0 ? roundMoney(previousBalance * interestRate) : 0;
    const purchases = roundMoney(spendSum + interestCharges);
    const minPay = roundMoney(Math.max((previousBalance + purchases) * 0.05, 2000));
    let payment;
    if (previousBalance <= 0) {
      payment = 0;
    } else if (revolver && persona.revolverPayFraction === 0) {
      payment = 0;
    } else if (revolver) {
      const targetUtil = persona.targetUtilisation == null ? 0.6 : persona.targetUtilisation;
      const target = persona.creditLimit > 0 ? persona.creditLimit * targetUtil : 0;
      let raw = -Math.max(0, previousBalance + purchases - target);
      if (raw === 0 && previousBalance + purchases > 1) raw = -minPay;
      else if (raw < 0 && Math.abs(raw) < minPay) raw = -minPay;
      payment = roundMoney(raw);
    } else {
      payment = roundMoney(-previousBalance);
    }
    if (previousBalance > 0 && payment !== 0) {
      const payDay = 8 + Math.floor(rng() * 6);
      monthRecords.push(cardRow(iso(y, m, payDay), 'INTERNET - CARD PAYMENT', payment));
    }
    const newBalance = roundMoney(previousBalance + purchases + payment);

    records.push(...monthRecords);

    const statementKey = ymOf(y, m);
    const creditLimit = persona.creditLimit;
    const summary = {
      source_file: 'Mock Card Statements.pdf',
      account: persona.cardAccount,
      periodText: `${MON_ABBR[m - 1]} 1 - ${MON_ABBR[m - 1]} ${lastDayOf(y, m)}, ${y}`,
      periodStart: iso(y, m, 1),
      periodEnd: iso(y, m, lastDayOf(y, m)),
      statementKey,
      previousBalance,
      purchases,
      payments: payment,
      newBalance,
      creditLimit,
      creditAvailable: roundMoney(creditLimit - newBalance),
      minimumPayment: roundMoney(Math.max(newBalance * 0.05, 1000)),
      amountOwing: newBalance,
      interestCharges,
      eair: revolver ? 47.9 : 0,
      utilisation:
        creditLimit > 0 ? roundMoney((Math.max(0, newBalance) / creditLimit) * 100) : null,
      revolving: newBalance > 1,
      payingInFull: newBalance <= 1,
    };
    statements.push({
      hash: cardStatementHash(summary),
      ...summary,
      reconciled: true,
      reconNote: '',
      importedAt: new Date().toISOString(),
    });
    perStatement.push(summary);
    previousBalance = newBalance;
  });
  return { records, statements, perStatement };
}

function buildBankLedgerForAccount(persona, acct, rng) {
  const months = monthSequence(persona.months);
  const records = [];
  const statements = [];
  const parses = [];
  let running = acct.opening;
  let seq = 0;
  const skip = new Set(acct.skip || []);

  months.forEach(({ y, m }, monthIdx) => {
    if (skip.has(monthIdx)) return;
    const dim = lastDayOf(y, m);
    const events = [];
    const raw = (d) => `${String(d).padStart(2, '0')}${MON_ABBR[m - 1].toUpperCase()}`;

    if (acct.income) {
      // Some employers pay one monthly salary; many pay in two fortnightly
      // halves. A persona can ask for either, so the income line reads the way
      // that person is actually paid rather than one flat monthly deposit for
      // everyone.
      if (persona.payFrequency === 'fortnightly') {
        const half = roundMoney(persona.monthlyIncome / 2);
        events.push({
          date: iso(y, m, 10),
          rawDate: raw(10),
          type: persona.incomeType,
          desc: persona.incomeDesc,
          direction: 'in',
          amount: half,
        });
        events.push({
          date: iso(y, m, 25),
          rawDate: raw(25),
          type: persona.incomeType,
          desc: persona.incomeDesc,
          direction: 'in',
          amount: roundMoney(persona.monthlyIncome - half),
        });
      } else {
        events.push({
          date: iso(y, m, 25),
          rawDate: raw(25),
          type: persona.incomeType,
          desc: persona.incomeDesc,
          direction: 'in',
          amount: persona.monthlyIncome,
        });
      }
    }
    // Extra money that arrives every month beyond the main salary, such as a
    // retainer paid into a foreign-currency account. Optional; a persona that
    // sets none is generated exactly as before.
    for (const credit of acct.recurringIn || []) {
      const day = credit.day || 25;
      events.push({
        date: iso(y, m, day),
        rawDate: raw(day),
        type: credit.type || 'SCOTIA DIRECT CREDIT',
        desc: credit.desc,
        direction: 'in',
        amount: credit.amount,
      });
    }
    if (acct.bills) {
      let d = 2;
      for (const bill of BANK_BILLS) {
        events.push({
          date: iso(y, m, d),
          rawDate: raw(d),
          type: bill.type,
          desc: bill.desc,
          direction: 'out',
          amount: bill.amount,
        });
        d += 2;
      }
      events.push({
        date: iso(y, m, 16),
        rawDate: raw(16),
        type: 'SERVICE CHARGE',
        desc: 'MONTHLY SERVICE CHARGE',
        direction: 'out',
        amount: 350,
      });
    }
    // Fixed monthly commitments that leave on their own: a mortgage (sometimes
    // in two legs, an NHT loan plus a commercial top-up), rent, a car note, a
    // student-loan repayment, a standing sweep into an investment fund. Each is
    // one event a month, so the running balance always adds up. Optional per
    // account.
    for (const out of acct.recurringOut || []) {
      const day = out.day || 1;
      events.push({
        date: iso(y, m, day),
        rawDate: raw(day),
        type: out.type || 'ELECTRONIC DATA DEBIT',
        desc: out.desc,
        direction: 'out',
        amount: out.amount,
      });
    }
    // Costs that fall by the term rather than every month, such as private
    // school fees, which land only in the months named for that account.
    for (const term of acct.termlyOut || []) {
      if (!(term.termMonths || []).includes(monthIdx)) continue;
      const day = term.day || 5;
      events.push({
        date: iso(y, m, day),
        rawDate: raw(day),
        type: term.type || 'POINT OF SALE',
        desc: term.desc,
        direction: 'out',
        amount: term.amount,
      });
    }
    // One-offs that land in a single named month: a big-ticket furniture or
    // appliance buy for the large-charge detector, a government or tax payment,
    // or a one-time refund/reversal landing back in the account. Direction
    // defaults to out; a refund sets it to in.
    for (const o of acct.oneOffs || []) {
      if (o.monthIndex !== monthIdx) continue;
      const day = o.day || 15;
      events.push({
        date: iso(y, m, day),
        rawDate: raw(day),
        type: o.type || 'POINT OF SALE',
        desc: o.desc,
        direction: o.direction || 'out',
        amount: o.amount,
      });
    }
    if (acct.cashDeposits) {
      const dep = roundMoney(20000 + rng() * 60000);
      events.push({
        date: iso(y, m, 18),
        rawDate: raw(18),
        type: 'ABM DEPOSIT',
        desc: 'ABM DEPOSIT',
        direction: 'in',
        amount: dep,
      });
      events.push({
        date: iso(y, m, 22),
        rawDate: raw(22),
        type: 'ABM WITHDRAWAL',
        desc: 'ABM WITHDRAWAL',
        direction: 'out',
        amount: roundMoney(8000 + rng() * 12000),
      });
    }
    if (acct.cardPayment && persona.hasCard) {
      events.push({
        date: iso(y, m, 10),
        rawDate: raw(10),
        type: 'PC-BILL PAYMENT',
        desc: `TRANSFER TO ${persona.cardAccount}`,
        direction: 'out',
        amount: roundMoney(30000 + rng() * 40000),
      });
    }
    // A transfer between the person's own accounts. The amount can differ by
    // account, so a move out of the Jamaican account (a larger figure) and the
    // matching move into a US-dollar account (a small US-dollar figure) each
    // read at their own realistic scale, while both stay recognisable as the
    // person's own money changing pockets.
    const internalAmount = acct.internalAmount || 50000;
    for (const peer of acct.internalTo || []) {
      events.push({
        date: iso(y, m, 15),
        rawDate: raw(15),
        type: 'TRANSFER',
        desc: `TRANSFER TO ${peer}`,
        direction: 'out',
        amount: internalAmount,
      });
    }
    for (const peer of acct.internalFrom || []) {
      events.push({
        date: iso(y, m, 15),
        rawDate: raw(15),
        type: 'TRANSFER',
        desc: `TRANSFER FROM ${peer}`,
        direction: 'in',
        amount: internalAmount,
      });
    }
    // Everyday debit-card spending, now drawn from a proper spread of national
    // point-of-sale places rather than one short repeated list.
    const spends = acct.externalSpends || 0;
    const band = acct.spendBand || [3000, 25000];
    const pool = acct.posMerchants || BANK_POS_MERCHANTS;
    for (let i = 0; i < spends; i++) {
      const payee = pick(rng, pool);
      const d = 1 + Math.floor(rng() * dim);
      events.push({
        date: iso(y, m, d),
        rawDate: raw(d),
        type: 'POINT OF SALE',
        desc: payee,
        direction: 'out',
        amount: roundMoney(band[0] + rng() * (band[1] - band[0])),
      });
    }

    events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));

    const opening = running;
    let sseq = 0;
    const monthRows = [];
    for (const ev of events) {
      const { row, balanceAfter } = bankRow(ev, running, seq++, sseq++, acct.number, acct.currency);
      running = balanceAfter;
      monthRows.push(row);
    }
    records.push(...monthRows);

    const period = `01 ${MON_ABBR[m - 1]} ${y} - ${String(dim).padStart(2, '0')} ${MON_ABBR[m - 1]} ${y}`;
    const stObj = {
      account: acct.number,
      period,
      openingBalance: opening,
      closingBalance: running,
      transactions: monthRows,
    };
    parses.push(stObj);
    statements.push({
      hash: bankStatementHash(stObj),
      source_file: 'Mock Bank Statements.pdf',
      account: acct.number,
      period,
      count: monthRows.length,
      closingBalance: roundMoney(running),
      reconciled: true,
      reconNote: '',
      importedAt: new Date().toISOString(),
    });
  });
  return { records, statements, parses };
}

function buildBankLedger(persona, rng) {
  const records = [];
  const statements = [];
  const parses = [];
  for (const acct of persona.accounts || []) {
    const built = buildBankLedgerForAccount(persona, acct, rng);
    records.push(...built.records);
    statements.push(...built.statements);
    parses.push(...built.parses);
  }
  return { records, statements, parses };
}

export { hashSeed, makeRng, buildCardLedger, buildBankLedger, ymOf };
