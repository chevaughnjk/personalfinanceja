import { Store } from '../core/storage.js';
import {
  reconcileCardStatement,
  cardStatementHealth,
  reconcileBankStatement,
} from '../statements/read-statements.js';
import {
  classifyInternalTransfers,
  applyLedgerRules,
  analyseBankActivity,
  bankFlowOverTime,
  overviewVerdict,
  detectBankStandingDebits,
} from '../analysis/bank-analysis.js';
import {
  buildRows,
  summarise,
  detectRecurring,
  cardBehaviourState,
  buildStatementCoverage,
  isPeriodFullyCovered,
  resolvePeriod,
  buildBankAppropriateInsights,
} from '../analysis/reporting.js';
import {
  roundMoney,
  withConfigDefaults,
  DEV_SIGNATURE,
  LOCAL_DEV_HOSTS,
  MONTHS_SHORT,
} from '../core/shared-helpers.js';
import { compileRules } from '../statements/categorise.js';
import { compileBrandRules } from '../../settings/category-rules.js';
import { compileFromRaw } from '../statements/merchant-resolver.js';
import { PERSONAS, PERSONA_LABELS } from './mock-data.js';
import { hashSeed, makeRng, buildCardLedger, buildBankLedger, ymOf } from './mock-generator.js';

const MON_ABBR = MONTHS_SHORT;
const MOCK_FLAG_KEY = 'mockPersonaLoaded';
const IS_LOCAL_DEV = typeof location !== 'undefined' && LOCAL_DEV_HOSTS.includes(location.hostname);

function money(n, currency) {
  const sym = currency === 'USD' ? 'US$' : '$';
  return sym + Number(n || 0).toFixed(2);
}

function monthLabel(ym) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(ym || ''));
  return m ? `${MON_ABBR[+m[2] - 1]} ${m[1]}` : String(ym || '');
}

async function loadAnalysisContext() {
  const res = await fetch(new URL('../settings/config.json', import.meta.url));
  const cfg = withConfigDefaults(await res.json());
  const compiled = compileRules(cfg.categories);
  const brandRules = compileBrandRules(cfg);
  let merchants = [];
  let resolver = null;
  try {
    const mFile = (cfg.merchants && cfg.merchants.file) || 'jamaica-merchants.json';
    const mRes = await fetch(new URL('../settings/' + mFile, import.meta.url));
    const rawMerchants = await mRes.json();
    const cleanupRules = [];
    for (const r of (cfg.bankDescriptorCleanup && cfg.bankDescriptorCleanup.rules) || []) {
      if (!r || !r.pattern) continue;
      try {
        cleanupRules.push({
          pattern: new RegExp(r.pattern, r.flags || 'i'),
          replacement: r.replacement || '',
        });
      } catch (e) {
        void e;
      }
    }
    resolver = compileFromRaw(rawMerchants, cfg, cleanupRules);
    merchants = resolver.compiled;
  } catch (e) {
    void e;
    merchants = [];
    resolver = null;
  }
  return {
    cfg,
    compiled,
    brandRules,
    merchants,
    resolver,
    keepUpper: new Set(cfg.keepUpper),
    smallWords: new Set(cfg.smallWords),
  };
}

function buildCardRows(records, ctx) {
  return buildRows(records, ctx.compiled, {
    keepUpper: ctx.keepUpper,
    smallWords: ctx.smallWords,
    fallback: ctx.cfg.special.fallback,
    paymentCategory: ctx.cfg.special.paymentCategory,
    refundCategory: ctx.cfg.special.refundCategory,
    feeCategories: new Set(ctx.cfg.special.feeCategories),
    merchantOverrides: {},
    merchants: ctx.merchants,
    brandRules: ctx.brandRules,
    resolver: ctx.resolver,
  });
}

function classifiedBank(bankRecords, persona, ctx) {
  const myAccounts = (persona.accounts || []).map((a) => a.number);
  const cardAccounts = [persona.cardAccount].filter(Boolean);
  const base = classifyInternalTransfers(bankRecords, myAccounts, cardAccounts, ctx.resolver);
  return applyLedgerRules(base, {
    confirmedIncomeIds: new Set(),
    roundTripIds: new Set(),
    sharedAccounts: [],
    householdPayees: [],
  });
}

function recsInWindow(recs, from, to) {
  if (!from || !to) return [];
  return recs.filter((r) => {
    const m = String(r.date || '').slice(0, 7);
    return m >= from && m <= to;
  });
}

function missingSequenceMonths(months) {
  const sorted = [...new Set(months)].filter(Boolean).sort();
  if (sorted.length < 2) return [];
  const gaps = [];
  const set = new Set(sorted);
  let cur = sorted[0];
  const last = sorted[sorted.length - 1];
  const step = (ym) => {
    const [y, m] = ym.split('-').map(Number);
    const d = new Date(Date.UTC(y, m, 1));
    return ymOf(d.getUTCFullYear(), d.getUTCMonth() + 1);
  };
  while (cur < last) {
    cur = step(cur);
    if (cur < last && !set.has(cur)) gaps.push(cur);
  }
  return gaps;
}

async function verifyPersona(name, overrides = {}) {
  const preset = PERSONAS[name];
  if (!preset) {
    console.warn(`Unknown persona "${name}". Available: ${Object.keys(PERSONAS).join(', ')}`);
    return;
  }
  const persona = { ...preset, ...overrides };
  const seedStr = String(overrides.seed || persona.seed);
  const seedInt = hashSeed(seedStr);
  const rng = makeRng(seedInt);
  const ctx = await loadAnalysisContext();

  console.group(`%cVERIFY persona "${name}"`, 'font-weight:bold');

  console.group('1. INPUTS (reproducible)');
  console.log('seed string:', JSON.stringify(seedStr));
  console.log('seed integer (hashSeed):', seedInt);
  console.log(
    'regenerate with:',
    `PFAMock.verifyPersona("${name}"${Object.keys(overrides).length ? ', ' + JSON.stringify(overrides) : ''})`
  );
  console.log(
    'months:',
    persona.months,
    '| hasCard:',
    persona.hasCard,
    '| hasBank:',
    persona.hasBank
  );
  console.log(
    'cardBehaviour:',
    persona.cardBehaviour,
    '| creditLimit:',
    persona.creditLimit,
    '| interestRate:',
    persona.interestRate == null ? 0.041 : persona.interestRate,
    '| revolverPayFraction:',
    persona.revolverPayFraction == null ? 0.06 : persona.revolverPayFraction
  );
  console.log(
    'accounts:',
    (persona.accounts || []).map((a) => ({
      number: a.number,
      currency: a.currency,
      opening: a.opening,
      income: !!a.income,
      bills: !!a.bills,
      skip: a.skip || [],
    }))
  );
  console.groupEnd();

  let cardBuilt = null;
  let cardRows = [];
  if (persona.hasCard) {
    cardBuilt = buildCardLedger(persona, rng);
    cardRows = buildCardRows(cardBuilt.records, ctx);

    console.group('2. CARD STATEMENTS + reconciliation');
    console.table(
      cardBuilt.perStatement.map((s) => ({
        statementKey: s.statementKey,
        previousBalance: s.previousBalance,
        purchases: s.purchases,
        payments: s.payments,
        newBalance: s.newBalance,
        interestCharges: s.interestCharges,
        creditLimit: s.creditLimit,
      }))
    );
    const recon = cardBuilt.perStatement.map((s) => {
      const r = reconcileCardStatement(s);
      return {
        statementKey: s.statementKey,
        expected_newBalance: roundMoney(s.previousBalance + s.purchases + s.payments),
        printed_newBalance: s.newBalance,
        difference: r.difference,
        reconciled_ok: r.ok,
        note: r.break || '',
      };
    });
    console.table(recon);
    const reconFail = recon.filter((r) => !r.reconciled_ok).length;
    console.log(
      `reconcileCardStatement: ${recon.length - reconFail}/${recon.length} pass (invariant previous + purchases + payments == newBalance, tolerance 0.01). Failures: ${reconFail}`
    );
    const refunds = cardBuilt.records.filter(
      (r) => r.amount < 0 && r.description !== 'INTERNET - CARD PAYMENT'
    );
    console.log(
      'refund / return credits generated:',
      refunds.length,
      refunds.slice(0, 5).map((r) => `${r.txn_date} ${r.description} ${r.amount}`)
    );
    console.groupEnd();

    console.group('3. cardStatementHealth (latest statement)');
    const latest = cardBuilt.perStatement[cardBuilt.perStatement.length - 1];
    const health = cardStatementHealth(latest);
    console.log('inputs -> creditLimit:', latest.creditLimit, '| newBalance:', latest.newBalance);
    console.log(
      'utilisation:',
      health.utilisation,
      '% (= max(0, newBalance)/creditLimit*100 =',
      latest.creditLimit > 0
        ? roundMoney((Math.max(0, latest.newBalance) / latest.creditLimit) * 100)
        : null,
      ')'
    );
    console.log(
      'revolving (newBalance > 1):',
      health.revolving,
      '| payingInFull (newBalance <= 1):',
      health.payingInFull
    );
    console.groupEnd();

    console.group(
      '4. cardBehaviourState (keys on interestCharges, window = last 3, minCycles 2, interestFloor 1)'
    );
    const sortedStmts = cardBuilt.statements
      .slice()
      .sort((a, b) => String(a.statementKey).localeCompare(String(b.statementKey)));
    const windowStmts = sortedStmts.slice(-3);
    console.log(
      'window statementKeys:',
      windowStmts.map((s) => s.statementKey)
    );
    console.log(
      'interestCharges per window cycle:',
      windowStmts.map((s) => s.interestCharges)
    );
    console.log(
      'cycles carrying interest > 1:',
      windowStmts.filter((s) => Number(s.interestCharges) > 1).length,
      '| cycles with finite interestCharges:',
      windowStmts.filter((s) => Number.isFinite(Number(s.interestCharges))).length
    );
    console.log('=> cardBehaviourState:', cardBehaviourState(cardBuilt.statements));
    console.groupEnd();

    console.group('5. CARD categorisation (real buildRows + summarise)');
    const summary = summarise(cardRows, {
      keepUpper: ctx.keepUpper,
      smallWords: ctx.smallWords,
      brandRules: ctx.brandRules,
      merchants: ctx.merchants,
      fallback: ctx.cfg.special.fallback,
    });
    console.log(
      'n_transactions:',
      summary.n_transactions,
      '| n_spend:',
      summary.n_spend,
      '| total_spend:',
      summary.total_spend,
      '| coverage_pct:',
      summary.coverage_pct,
      '| uncategorised_spend:',
      summary.n_uncategorised_spend
    );
    console.table(
      Object.entries(summary.by_category)
        .slice(0, 10)
        .map(([name2, amount]) => ({
          category: name2,
          amount,
          share_pct: summary.total_spend ? roundMoney((amount / summary.total_spend) * 100) : 0,
        }))
    );
    console.table(
      summary.top_merchants.slice(0, 8).map((mm) => ({
        merchant: mm.merchant,
        count: mm.count,
        amount: mm.amount,
        category: mm.category,
      }))
    );
    const cardRecurring = detectRecurring(cardRows, 3, 0.15, ctx.brandRules, ctx.merchants);
    console.log('detectRecurring (card, whole history):', cardRecurring.length, 'found');
    console.table(
      cardRecurring.map((r) => ({
        merchant: r.label,
        months: r.months,
        typical: r.typical,
        status: r.status,
      }))
    );
    console.groupEnd();
  }

  let bankBuilt = null;
  let recsAll = [];
  if (persona.hasBank) {
    bankBuilt = buildBankLedger(persona, rng);
    recsAll = classifiedBank(bankBuilt.records, persona, ctx);

    console.group('6. BANK reconciliation + balance-chain invariant');
    const bankRecon = bankBuilt.parses.map((p) => {
      const r = reconcileBankStatement({
        openingBalance: p.openingBalance,
        closingBalance: p.closingBalance,
        transactions: p.transactions,
      });
      return {
        account: p.account,
        period: p.period,
        opening: roundMoney(p.openingBalance),
        printed_closing: roundMoney(p.closingBalance),
        computed_closing: r.computedClosing,
        closingOk: r.closingOk,
        balanceBreaks: r.balanceBreaks.length,
        reconciled_ok: r.ok,
      };
    });
    console.table(bankRecon);
    const bankFail = bankRecon.filter((r) => !r.reconciled_ok).length;
    console.log(
      `reconcileBankStatement: ${bankRecon.length - bankFail}/${bankRecon.length} pass. Failures: ${bankFail}`
    );
    let mismatch = 0;
    let checked = 0;
    for (const p of bankBuilt.parses) {
      let run = roundMoney(p.openingBalance);
      for (const t of p.transactions) {
        run = roundMoney(run + t.signedAmount);
        checked++;
        if (Math.abs(run - t.balanceAfter) > 0.005) mismatch++;
      }
    }
    console.log(
      `rounding invariant: recompute roundMoney(prev + signedAmount) == balanceAfter for ${checked} rows. Mismatches: ${mismatch} (0 = rounding applied consistently at every step).`
    );
    console.groupEnd();

    console.group('7. analyseBankActivity (whole history)');
    const aAll = analyseBankActivity(recsAll);
    console.log(
      'cashIn (Cash inflow, JMD):',
      aAll.cashIn,
      '| cashOut:',
      aAll.cashOut,
      '| net:',
      aAll.net,
      '| closingBalance (JMD only):',
      aAll.closingBalance
    );
    console.log(
      'internalOut:',
      aAll.internalOut,
      '| cashDeposits (excluded from income by default):',
      aAll.cashDeposits
    );
    console.table(
      aAll.accounts.map((ac) => ({
        account: ac.account,
        currency: ac.currency,
        n: ac.n,
        cashIn: ac.cashIn,
        cashOut: ac.cashOut,
        closing: ac.closingBalance,
      }))
    );
    console.log(
      'foreignAccounts (never blended into JMD totals):',
      aAll.foreignAccounts.map(
        (ac) => `${ac.account} (${ac.currency}) closing ${money(ac.closingBalance, ac.currency)}`
      )
    );
    const standing = detectBankStandingDebits(recsAll);
    console.log('detectBankStandingDebits:', standing.length, 'found');
    console.table(
      standing.map((s) => ({
        payee: s.label,
        months: s.months,
        typical: s.typical,
        status: s.status,
      }))
    );
    console.groupEnd();
  }

  console.group('8. COVERAGE (buildStatementCoverage + isPeriodFullyCovered)');
  const cardStatements = cardBuilt ? cardBuilt.statements : [];
  const bankStatements = bankBuilt ? bankBuilt.statements : [];
  const cardMonths = new Set(cardRows.map((r) => r.month).filter((m) => m && m !== 'unknown'));
  const bankMonths = new Set(
    (bankBuilt ? bankBuilt.records : [])
      .map((r) => String(r.date || '').slice(0, 7))
      .filter(Boolean)
  );
  const coverage = buildStatementCoverage(cardStatements, bankStatements, cardMonths, bankMonths);
  const allMonths = [...new Set([...cardMonths, ...bankMonths])].sort();
  console.log('all ledger months:', allMonths);
  console.log('missing months in the sequence:', missingSequenceMonths(allMonths));
  console.table(
    Object.keys(coverage.months)
      .sort()
      .map((ym) => ({
        month: ym,
        card: coverage.months[ym].card,
        bank: coverage.months[ym].bank,
      }))
  );
  const period = resolvePeriod(
    { type: 'latest-complete' },
    cardRows,
    allMonths,
    new Date(),
    coverage
  );
  if (period) {
    console.log('resolved period "latest-complete":', {
      from: period.from,
      to: period.to,
      label: period.label,
      prevFrom: period.prevFrom,
      prevTo: period.prevTo,
    });
    console.log(
      'isPeriodFullyCovered(coverage, period):',
      isPeriodFullyCovered(coverage, period),
      '(false only if a month in [from,to] is provably partial; unknown does not block).'
    );
  } else {
    console.log('resolvePeriod returned null (no months).');
  }
  console.groupEnd();

  if (persona.hasBank) {
    console.group('9. INSIGHTS (overviewVerdict + buildBankAppropriateInsights)');
    const p = resolvePeriod({ type: 'latest-complete' }, cardRows, allMonths, new Date(), coverage);
    const periodRecs = p ? recsInWindow(recsAll, p.from, p.to) : recsAll;
    const a = analyseBankActivity(periodRecs);
    const trend = bankFlowOverTime(periodRecs).map((t) => ({
      month: t.month,
      net: t.net,
    }));
    const verdict = overviewVerdict({ netCashFlow: a.net, trend });
    console.log('period net cash flow:', a.net, '=> overviewVerdict:', verdict);
    const prevIncome =
      p && p.prevFrom
        ? analyseBankActivity(recsInWindow(recsAll, p.prevFrom, p.prevTo)).cashIn
        : null;
    console.log('currentIncome (period cashIn):', a.cashIn, '| prevIncome:', prevIncome);
    const bankMonthsList = () => [
      ...new Set(recsAll.map((r) => String(r.date || '').slice(0, 7)).filter(Boolean)),
    ];
    const noIcon = () => '';
    const insights = buildBankAppropriateInsights({
      recsAll,
      period: p,
      cfg: ctx.cfg,
      currentIncome: a.cashIn,
      prevIncome,
      verdict,
      coverage,
      bankMoney: money,
      prevLabel: () => 'the previous period',
      monthLabel,
      bankMonthsList,
      onNavigate: () => {},
      onDrillToPayee: () => () => {},
      icons: {
        up: noIcon,
        down: noIcon,
        alert: noIcon,
        spark: noIcon,
        gap: noIcon,
        info: noIcon,
      },
    });
    console.log(
      'bank insights produced:',
      insights.length,
      '(config maxInsights:',
      ctx.cfg.insights.maxInsights,
      ')'
    );
    console.table(insights.map((i) => ({ kind: i.kind, tone: i.tone, text: i.text })));
    console.groupEnd();
  }

  console.groupEnd();
  return { seedStr, seedInt };
}

async function verifyAll(overrides = {}) {
  for (const name of Object.keys(PERSONAS)) {
    await verifyPersona(name, overrides);
  }
}

async function hasRealDataPresent() {
  if (await Store.getMeta(MOCK_FLAG_KEY, null)) return false;
  if ((await Store.allTransactions()).length) return true;
  if ((await Store.allBankTransactions()).length) return true;
  if ((await Store.allStatements()).length) return true;
  if ((await Store.allBankStatements()).length) return true;
  if ((await Store.allCardStatements()).length) return true;
  return false;
}

async function loadPersona(name, overrides = {}) {
  const preset = PERSONAS[name];
  if (!preset) {
    console.warn(`Unknown persona "${name}". Available: ${Object.keys(PERSONAS).join(', ')}`);
    return;
  }
  if (await hasRealDataPresent()) {
    console.warn(
      'This device has your own imported statements on it. Loading a sample customer would replace them, so it was stopped. Clear your real data first (Data & settings, then Clear all data) if you truly want sample data.'
    );
    return;
  }
  const persona = { ...preset, ...overrides };
  const rng = makeRng(hashSeed(String(overrides.seed || persona.seed)));

  await clearPersona(false);

  if (persona.hasCard) {
    const card = buildCardLedger(persona, rng);
    await Store.replaceTransactions(card.records);
    for (const st of card.statements) await Store.putCardStatement(st);
    await Store.putStatement({
      hash: 'mock-card',
      source_file: 'Mock Card Statements.pdf',
      period: card.statements[card.statements.length - 1].statementKey,
      importedAt: new Date().toISOString(),
    });
    await Store.setMeta('bankCardAccounts', [persona.cardAccount].filter(Boolean));
  }

  if (persona.hasBank) {
    const bank = buildBankLedger(persona, rng);
    await Store.replaceBankTransactions(bank.records);
    for (const st of bank.statements) await Store.putBankStatement(st);
    await Store.setMeta(
      'bankMyAccounts',
      (persona.accounts || []).map((a) => a.number)
    );
  }

  const loadedAt = new Date().toISOString();
  await Store.setMeta('lastImportedFrom', {
    device: DEV_SIGNATURE,
    at: loadedAt,
  });
  await Store.setMeta('firstName', persona.firstName || null);
  await Store.setMeta(MOCK_FLAG_KEY, name);
  await Store.setMeta('lastLocalUpdate', loadedAt);
  console.log(
    `Loaded persona "${name}" (seed ${JSON.stringify(String(overrides.seed || persona.seed))}). Run PFAMock.verifyPersona("${name}") for the full verification log. Reloading...`
  );
  location.reload();
}

async function clearPersona(reload = true) {
  await Store.clearTransactions();
  await Store.clearStatements();
  await Store.clearBankTransactions();
  await Store.clearBankStatements();
  await Store.clearCardStatements();
  await Store.setMeta('bankCardAccounts', []);
  await Store.setMeta('bankMyAccounts', []);
  await Store.setMeta('bankConfirmedIncomeIds', []);
  await Store.setMeta('bankRefundIncomeIds', []);
  await Store.setMeta('bankRoundTripIds', []);
  await Store.setMeta('firstName', null);
  await Store.setMeta('lastImportedFrom', null);
  await Store.setMeta(MOCK_FLAG_KEY, null);
  if (reload) {
    console.log('Cleared all data. Reloading...');
    location.reload();
  }
}

function mountPersonaSwitcher() {
  if (!IS_LOCAL_DEV || typeof document === 'undefined') return;
  if (document.getElementById('pfa-mock-switcher')) return;

  const host = document.createElement('div');
  host.id = 'pfa-mock-switcher';
  host.setAttribute(
    'style',
    'position:fixed;left:12px;bottom:12px;z-index:2147483000;font:13px system-ui,Segoe UI,Roboto,sans-serif;color:#10161f;'
  );

  const panel = document.createElement('div');
  panel.setAttribute(
    'style',
    'display:none;width:300px;padding:12px;background:#fff;border:2px dashed #B4460E;border-radius:12px;box-shadow:0 8px 30px rgba(16,24,40,.18);margin-bottom:8px;'
  );

  const title = document.createElement('div');
  title.textContent = 'Sample customer data (developer only)';
  title.setAttribute('style', 'font-weight:700;margin-bottom:2px;');

  const sub = document.createElement('div');
  sub.textContent = 'Loads pretend data for testing. Never shown to real users.';
  sub.setAttribute('style', 'color:#5a6675;margin-bottom:10px;');

  const status = document.createElement('div');
  status.setAttribute('style', 'margin-bottom:10px;font-weight:650;');

  const select = document.createElement('select');
  select.setAttribute(
    'style',
    'width:100%;padding:8px;border:1px solid #d0d5dd;border-radius:8px;margin-bottom:8px;'
  );
  for (const key of Object.keys(PERSONAS)) {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = PERSONA_LABELS[key] || key;
    select.appendChild(opt);
  }

  const msg = document.createElement('div');
  msg.setAttribute(
    'style',
    'display:none;margin:0 0 8px;padding:8px;border-radius:8px;background:#fdf0e8;color:#8a3410;'
  );
  const showMsg = (text) => {
    msg.textContent = text;
    msg.style.display = 'block';
  };
  const hideMsg = () => {
    msg.style.display = 'none';
  };

  const loadBtn = document.createElement('button');
  loadBtn.textContent = 'Load this sample customer';
  loadBtn.setAttribute(
    'style',
    'width:100%;padding:9px;border:0;border-radius:8px;background:#0F6CBD;color:#fff;font-weight:650;cursor:pointer;margin-bottom:8px;'
  );

  const clearBtn = document.createElement('button');
  clearBtn.textContent = 'Clear to an empty app';
  clearBtn.setAttribute(
    'style',
    'width:100%;padding:9px;border:1px solid #d0d5dd;border-radius:8px;background:#fff;color:#10161f;font-weight:650;cursor:pointer;'
  );

  loadBtn.onclick = async () => {
    hideMsg();
    if (await hasRealDataPresent()) {
      showMsg(
        'Your own imported statements are on this device. Clear them from Data & settings, then Clear all data, before loading a sample customer.'
      );
      return;
    }
    loadBtn.disabled = true;
    loadBtn.textContent = 'Loading...';
    await loadPersona(select.value);
  };

  clearBtn.onclick = async () => {
    hideMsg();
    if (await hasRealDataPresent()) {
      showMsg(
        'Only sample data is cleared here. Your own imported statements are present, so clear those from Data & settings, then Clear all data.'
      );
      return;
    }
    clearBtn.disabled = true;
    clearBtn.textContent = 'Clearing...';
    await clearPersona(true);
  };

  panel.appendChild(title);
  panel.appendChild(sub);
  panel.appendChild(status);
  panel.appendChild(select);
  panel.appendChild(msg);
  panel.appendChild(loadBtn);
  panel.appendChild(clearBtn);

  const pill = document.createElement('button');
  pill.setAttribute(
    'style',
    'display:block;padding:8px 12px;background:#B4460E;color:#fff;border:0;border-radius:999px;font-weight:700;cursor:pointer;box-shadow:0 6px 18px rgba(16,24,40,.18);'
  );

  const refresh = async () => {
    const current = await Store.getMeta(MOCK_FLAG_KEY, null);
    if (current) {
      status.textContent =
        'Now showing: ' + (PERSONA_LABELS[current] || current) + ' (sample data)';
      pill.textContent = 'Sample: ' + current;
      if (PERSONAS[current] && select.value !== current) select.value = current;
    } else {
      status.textContent = 'No sample data loaded.';
      pill.textContent = 'Sample data';
    }
  };

  pill.onclick = () => {
    const open = panel.style.display === 'block';
    panel.style.display = open ? 'none' : 'block';
    if (!open) refresh();
  };

  host.appendChild(panel);
  host.appendChild(pill);
  document.body.appendChild(host);
  refresh();
}

if (typeof window !== 'undefined') {
  window.PFAMock = {
    loadPersona,
    clearPersona,
    verifyPersona,
    verifyAll,
    personas: Object.keys(PERSONAS),
  };
}

if (IS_LOCAL_DEV && typeof document !== 'undefined') {
  if (document.readyState === 'loading')
    document.addEventListener('DOMContentLoaded', mountPersonaSwitcher);
  else mountPersonaSwitcher();
}

export { loadPersona, clearPersona, verifyPersona, verifyAll, PERSONAS };
