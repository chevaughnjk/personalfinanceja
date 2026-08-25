/* commitment-income.js - shared commitment-and-income primitive (see spec). */
export function resolveOpts(cfg = {}) {
  const ahead = (cfg && cfg.ahead) || {};
  const insights = (cfg && cfg.insights) || {};
  const currency = (cfg && cfg.currency) || {};
  return {
    minMonths: ahead.minMonths == null ? 3 : ahead.minMonths,
    tolerance: ahead.tolerance == null ? 0.15 : ahead.tolerance,
    maxGapMonths: ahead.maxGapMonths == null ? 2 : ahead.maxGapMonths,
    lateGraceDays: ahead.lateGraceDays == null ? 5 : ahead.lateGraceDays,
    baseCurrency: currency.code || 'JMD',
    incomeFloor: insights.meaningfulChangeMin == null ? 3000 : insights.meaningfulChangeMin,
    commitmentFloor: 1000,
  };
}
function ymOf(iso) {
  return String(iso || '').slice(0, 7);
}
function domOf(iso) {
  return +String(iso || '').slice(8, 10) || 0;
}
function toParts(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  return m ? { y: +m[1], mo: +m[2], d: +m[3] } : null;
}
function daysInMonth(y, mo) {
  return new Date(Date.UTC(y, mo, 0)).getUTCDate();
}
function isoOf(y, mo, d) {
  const dd = Math.min(d, daysInMonth(y, mo));
  return `${y}-${String(mo).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
}
function nextOccurrenceAfter(asOf, day) {
  const p = toParts(asOf);
  if (!p) return null;
  let { y, mo } = p;
  let cand = isoOf(y, mo, day);
  if (cand <= asOf) {
    mo += 1;
    if (mo > 12) {
      mo = 1;
      y += 1;
    }
    cand = isoOf(y, mo, day);
  }
  return cand;
}
function median(nums) {
  if (!nums.length) return 0;
  const s = nums.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function maxConsecutiveGap(monthKeys) {
  const idx = monthKeys
    .map((m) => +m.slice(0, 4) * 12 + +m.slice(5, 7))
    .filter((n) => !Number.isNaN(n))
    .sort((a, b) => a - b);
  let mx = 0;
  for (let i = 1; i < idx.length; i++) mx = Math.max(mx, idx[i] - idx[i - 1]);
  return mx;
}
function isInternal(r) {
  if (r.internalTransfer != null) return !!r.internalTransfer;
  return String(r.Flow || '') === 'Internal transfer';
}
function dirOf(r) {
  if (r.direction) return r.direction;
  const f = String(r.Flow || '');
  return f === 'Cash inflow' ? 'in' : f === 'Cash outflow' ? 'out' : '';
}
function amtOf(r) {
  return Math.abs(Number(r.amount != null ? r.amount : r.Amount) || 0);
}
function dateOf(r) {
  return String(r.date || r.Date || '');
}
function ccyOf(r, base) {
  return String(r.currency || r.Currency || base);
}
function counterpartyKeyOf(r) {
  return (
    r.counterpartyKey ||
    r.Group ||
    r.counterpartyLabel ||
    r['Counterparty / Merchant'] ||
    'ext:' + String(r.description || r['Raw Description'] || 'unknown').toUpperCase()
  );
}
export function detectRecurring(records, direction, opts, asOf = null) {
  const wantIn = direction === 'in';
  const by = new Map();
  for (const r of records || []) {
    if (isInternal(r)) continue;
    if (ccyOf(r, opts.baseCurrency) !== opts.baseCurrency) continue;
    if ((dirOf(r) === 'in') !== wantIn) continue;
    if (asOf && dateOf(r) > asOf) continue;
    const key = counterpartyKeyOf(r);
    if (!by.has(key)) by.set(key, []);
    by.get(key).push(r);
  }
  const out = [];
  for (const [key, rows] of by) {
    const byMonth = new Map();
    for (const r of rows)
      byMonth.set(ymOf(dateOf(r)), (byMonth.get(ymOf(dateOf(r))) || 0) + amtOf(r));
    const months = [...byMonth.keys()].sort();
    if (months.length < opts.minMonths) continue;
    if (maxConsecutiveGap(months) > opts.maxGapMonths) continue;
    const vals = [...byMonth.values()];
    const typical = median(vals);
    if (typical <= 0) continue;
    const steady = vals.filter((a) => Math.abs(a - typical) <= typical * opts.tolerance).length;
    if (steady < opts.minMonths) continue;
    const days = rows.map((r) => domOf(dateOf(r))).sort((a, b) => a - b);
    const typicalDay = days[days.length >> 1];
    const recent = rows
      .slice()
      .sort((a, b) => (dateOf(a) < dateOf(b) ? -1 : 1))
      .slice(-3)
      .map(amtOf);
    out.push({
      key,
      occurrences: rows.length,
      months: months.length,
      typical,
      typicalDay,
      lastMonth: months[months.length - 1],
      recent,
    });
  }
  return out.sort((a, b) => b.typical - a.typical);
}
export function twoWayKeys(records, opts, asOf = null) {
  const seen = new Map();
  for (const r of records || []) {
    if (ccyOf(r, opts.baseCurrency) !== opts.baseCurrency) continue;
    if (asOf && dateOf(r) > asOf) continue;
    const key = counterpartyKeyOf(r);
    const s = seen.get(key) || { in: 0, out: 0 };
    if (dirOf(r) === 'in') s.in++;
    else if (dirOf(r) === 'out') s.out++;
    seen.set(key, s);
  }
  const out = new Set();
  for (const [key, s] of seen) if (s.in >= 2 && s.out >= 2) out.add(key);
  return out;
}
export function expectedIncome(bankRecords, opts, asOf) {
  const cands = detectRecurring(bankRecords, 'in', opts, asOf).filter(
    (c) => c.typical >= opts.incomeFloor
  );
  if (!cands.length) return null;
  const inc = cands[0];
  const med3 = median(inc.recent);
  const latest = inc.recent[inc.recent.length - 1];
  const amount = Math.abs(latest - med3) <= med3 * opts.tolerance ? latest : med3;
  const date = nextOccurrenceAfter(asOf, inc.typicalDay);
  return {
    key: inc.key,
    amount: Math.round(amount * 100) / 100,
    date,
    typicalDay: inc.typicalDay,
    confidence: inc.months >= 6 ? 'high' : 'medium',
  };
}
export function cardLegBeforeIncome(cardStatements, opts, asOf, nextIncomeDate) {
  const stmts = (cardStatements || [])
    .slice()
    .sort((a, b) => String(a.statementKey || '').localeCompare(String(b.statementKey || '')));
  const latest = stmts[stmts.length - 1] || null;
  if (!latest) return { amount: 0, basis: 'no-card-statement', stale: true };
  const due =
    latest.amountDue != null
      ? Number(latest.amountDue)
      : latest.newBalance != null
        ? Number(latest.newBalance)
        : null;
  const dueDate = latest.dueDate || latest.payBy || null;
  if (due == null) return { amount: 0, basis: 'no-amount-due', stale: true };
  if (!dueDate)
    return {
      amount: 0,
      basis: 'amount-known-date-unknown',
      stale: true,
      knownAmount: Math.round(due * 100) / 100,
    };
  if (!nextIncomeDate)
    return {
      amount: 0,
      basis: 'no-income-date',
      stale: true,
      knownAmount: Math.round(due * 100) / 100,
    };
  const inWindow = String(dueDate) > String(asOf) && String(dueDate) < String(nextIncomeDate);
  return {
    amount: inWindow ? Math.round(due * 100) / 100 : 0,
    basis: inWindow ? 'due-before-income' : 'due-after-income',
    dueDate,
    stale: false,
  };
}
export function commitmentsBeforeIncome(
  bankRecords,
  opts,
  asOf,
  nextIncomeDate,
  manualFutureItems = []
) {
  if (!nextIncomeDate) return [];
  const debits = detectRecurring(bankRecords, 'out', opts, asOf).filter(
    (d) => d.typical >= opts.commitmentFloor
  );
  const tw = twoWayKeys(bankRecords, opts, asOf);
  const items = [];
  for (const d of debits) {
    if (tw.has(d.key)) continue;
    const due = nextOccurrenceAfter(asOf, d.typicalDay);
    if (due && due > asOf && due < nextIncomeDate)
      items.push({
        key: d.key,
        amount: Math.round(d.typical * 100) / 100,
        date: due,
        basis: 'recurring',
      });
  }
  for (const m of manualFutureItems || []) {
    const md = String(m.date || '');
    if (md > asOf && md < nextIncomeDate)
      items.push({
        key: m.key || 'manual',
        amount: Math.round(Number(m.amount) * 100) / 100,
        date: md,
        basis: 'manual',
      });
  }
  return items.sort((a, b) => (a.date < b.date ? -1 : 1));
}
export function liquidBalance(bankRecords, opts, asOf) {
  const byAcct = new Map();
  const seenAccts = new Set();
  let staleAccounts = 0;
  for (const r of bankRecords || []) {
    if (ccyOf(r, opts.baseCurrency) !== opts.baseCurrency) continue;
    if (asOf && dateOf(r) > asOf) continue;
    const acct = r.account || r.Account || 'unknown';
    seenAccts.add(acct);
    const bal =
      r.balanceAfter != null
        ? Number(r.balanceAfter)
        : r['Running Balance'] !== undefined && r['Running Balance'] !== ''
          ? Number(r['Running Balance'])
          : null;
    if (bal == null || Number.isNaN(bal)) continue;
    const seq = r.seq != null ? r.seq : 0;
    const cur = byAcct.get(acct);
    const key = [dateOf(r), seq];
    if (!cur || key[0] > cur.date || (key[0] === cur.date && key[1] >= cur.seq))
      byAcct.set(acct, { date: key[0], seq: key[1], bal });
  }
  let total = 0;
  const perAccount = {};
  for (const [acct, v] of byAcct) {
    total += v.bal;
    perAccount[acct] = v.bal;
  }
  for (const a of seenAccts) if (!(a in perAccount)) staleAccounts++;
  return { total: Math.round(total * 100) / 100, perAccount, staleAccounts };
}
export function commitmentAndIncomePrimitive({
  bankRecords,
  cardStatements = [],
  cfg = {},
  asOf,
  manualFutureItems = [],
}) {
  const opts = resolveOpts(cfg);
  const gaps = [];
  const income = expectedIncome(bankRecords, opts, asOf);
  if (!income) gaps.push('no recurring income detected');
  const nextIncomeDate = income ? income.date : null;
  const card = cardLegBeforeIncome(cardStatements, opts, asOf, nextIncomeDate);
  if (card.stale) gaps.push('card leg incomplete: ' + card.basis);
  const commitments = commitmentsBeforeIncome(
    bankRecords,
    opts,
    asOf,
    nextIncomeDate,
    manualFutureItems
  );
  // FROZEN CONTRACT (locked correction #2): the card amount expected before the
  // next income belongs UNDER commitments, NOT netted into available balance.
  // So the card leg is added as a commitment item (when it falls in the window)
  // and availableBalance stays pure liquid. Layer 3 is unchanged either way, but
  // this places all pre-payday outgoings together, which is both the frozen
  // definition and the clearer thing for a person to read.
  if (card.amount > 0)
    commitments.push({
      key: 'card',
      amount: card.amount,
      date: card.dueDate || nextIncomeDate,
      basis: 'card',
    });
  commitments.sort((a, b) => (String(a.date) < String(b.date) ? -1 : 1));
  const liquid = liquidBalance(bankRecords, opts, asOf);
  if (liquid.staleAccounts > 0)
    gaps.push(liquid.staleAccounts + ' account(s) with no current balance');
  const layer1 = Math.round(liquid.total * 100) / 100;
  const layer2 = Math.round(commitments.reduce((s, c) => s + c.amount, 0) * 100) / 100;
  const layer3 = Math.round((layer1 - layer2) * 100) / 100;
  return {
    asOf,
    income,
    liquid,
    card: {
      amountExpectedBeforeNextIncome: card.amount,
      basis: card.basis,
      dueDate: card.dueDate || null,
    },
    commitments,
    layers: {
      availableBalance: layer1,
      commitmentsBeforeIncome: layer2,
      estimatedAvailableAfterCommitments: layer3,
    },
    confidence: gaps.length ? 'incomplete' : 'complete',
    gaps,
  };
}
