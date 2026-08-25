/* ===========================================================================
 *  committed-flexible.js  -  Activity's distinctive lens: of the money that
 *  ARRIVED in a period, how much was already spoken for (committed) and how
 *  much was genuinely free to move (flexible), and how much of the free
 *  portion was actually spent.
 *
 *  This is the PAST-TENSE face of the same idea Overview shows in the present:
 *  it reuses the very same recurring detector the shared primitive exports
 *  (detectRecurring / twoWayKeys), so "committed" here can never drift from
 *  "commitments" there. Grounded in mental accounting - it names a split people
 *  already make in their heads (spoken-for money vs discretionary money).
 *
 *  PURE and Node-testable. No DOM, no fetch, no mutation.
 *
 *  DOUBLE-COUNT DISCIPLINE (the trap this module must avoid):
 *   - income is counted at the external credit, never the internal sweep.
 *   - discretionary CARD spend comes from the CARD ledger's spend rows; the
 *     bank-side card PAYMENT (an internal transfer to one's own card) is NOT
 *     counted, or the same money would appear twice.
 *   - committed = detected recurring standing debits only (insurance, loan,
 *     credit union). The card is NOT "committed" here, because card spend is
 *     itself the discretionary act being measured.
 *
 *  THE RECONCILING LINE (mental accounting's known failure mode):
 *  a "flexible" bucket must never be shown alone, or it reads as "safe to spend
 *  in full". So the model always carries a reconciling statement connecting
 *  flexible spending back to whether COMMITMENTS themselves moved this period.
 * ======================================================================== */
import { detectRecurring, twoWayKeys, resolveOpts } from './commitment-income.js';

function ymOf(iso) {
  return String(iso || '').slice(0, 7);
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
function keyOf(r) {
  return (
    r.counterpartyKey ||
    r.Group ||
    r.counterpartyLabel ||
    r['Counterparty / Merchant'] ||
    'ext:' + String(r.description || r['Raw Description'] || '').toUpperCase()
  );
}
function inPeriod(r, from, to) {
  const d = dateOf(r);
  return d >= from && d <= to;
}
function median(nums) {
  if (!nums.length) return 0;
  const s = nums.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
function r2(n) {
  return Math.round(Number(n || 0) * 100) / 100;
}

/* card ledger readers (spend/fee = discretionary; payment/refund excluded) */
function cardKind(r) {
  return r.kind || r.Type || r.type || '';
}
function cardIsSpend(r) {
  const k = String(cardKind(r)).toLowerCase();
  return k === 'spend' || k === 'fee';
}

/* ===========================================================================
 *  committedFlexible - the exported model builder for ONE completed period.
 *  bankRecords / cardRecords should be the FULL history (the detector needs
 *  history up to the period end to know what recurs); period = { from, to }.
 * ======================================================================== */
export function committedFlexible({ bankRecords = [], cardRecords = [], cfg = {}, period }) {
  const opts = resolveOpts(cfg);
  const { from, to } = period;
  const base = opts.baseCurrency;

  // --- the set of counterparties that recur as standing debits, judged from
  //     history up to the period end (reuses the shared detector) ------------
  const debits = detectRecurring(bankRecords, 'out', opts, to).filter(
    (d) => d.typical >= opts.commitmentFloor
  );
  const tw = twoWayKeys(bankRecords, opts, to);
  const committedKeys = new Set(debits.filter((d) => !tw.has(d.key)).map((d) => d.key));

  // --- income that ARRIVED this period (external credits, base ccy) ---------
  let income = 0;
  for (const r of bankRecords) {
    if (isInternal(r) || ccyOf(r, base) !== base || dirOf(r) !== 'in') continue;
    if (!inPeriod(r, from, to)) continue;
    income += amtOf(r);
  }

  // --- split this period's external bank outflow into committed vs flexible -
  let committed = 0,
    flexibleBankOut = 0;
  for (const r of bankRecords) {
    if (isInternal(r) || ccyOf(r, base) !== base || dirOf(r) !== 'out') continue;
    if (!inPeriod(r, from, to)) continue;
    if (committedKeys.has(keyOf(r))) committed += amtOf(r);
    else flexibleBankOut += amtOf(r); // cash, POS, transfers to people
  }

  // --- discretionary CARD spend this period (from the card ledger) ----------
  let cardSpend = 0;
  for (const r of cardRecords) {
    if (!cardIsSpend(r)) continue; // excludes payments/refunds
    if (ccyOf(r, base) !== base && (r.Currency || r.currency)) {
      /* still count: card spend is JMD-posted */
    }
    if (!inPeriod(r, from, to)) continue;
    cardSpend += amtOf(r);
  }

  const flexiblePool = r2(income - committed); // "yours to move"
  const flexibleSpent = r2(flexibleBankOut + cardSpend); // discretionary out
  const flexibleKept = r2(flexiblePool - flexibleSpent); // retained/saved

  // --- reconciling: did COMMITTED itself move vs its typical? ----------------
  // Compare this period's committed total against the median committed total of
  // prior complete months (same committed key set), so a spike/dip in fixed
  // obligations is surfaced rather than blamed on flexible spending.
  const priorMonths = [
    ...new Set(
      bankRecords
        .filter(
          (r) =>
            dirOf(r) === 'out' &&
            !isInternal(r) &&
            ccyOf(r, base) === base &&
            committedKeys.has(keyOf(r)) &&
            ymOf(dateOf(r)) < ymOf(from)
        )
        .map((r) => ymOf(dateOf(r)))
    ),
  ];
  const priorCommitTotals = priorMonths.map((m) =>
    bankRecords
      .filter(
        (r) =>
          committedKeys.has(keyOf(r)) &&
          dirOf(r) === 'out' &&
          !isInternal(r) &&
          ymOf(dateOf(r)) === m
      )
      .reduce((s, r) => s + amtOf(r), 0)
  );
  const typicalCommitted = r2(median(priorCommitTotals));
  let commitMove = 'in-line';
  if (typicalCommitted > 0) {
    if (committed > typicalCommitted * (1 + opts.tolerance)) commitMove = 'higher';
    else if (committed < typicalCommitted * (1 - opts.tolerance)) commitMove = 'lower';
  }

  const reconciling = buildReconciling({
    flexiblePool,
    flexibleSpent,
    flexibleKept,
    commitMove,
  });

  return {
    period: { from, to },
    income: r2(income),
    committed: r2(committed),
    flexiblePool,
    flexibleSpent,
    flexibleKept,
    breakdown: {
      cardSpend: r2(cardSpend),
      otherFlexibleOut: r2(flexibleBankOut),
    },
    committedKeyCount: committedKeys.size,
    typicalCommitted,
    commitMove, // 'higher' | 'lower' | 'in-line'
    reconciling, // the mandatory line that ties it together
  };
}

/* The reconciling statement: never let "flexible" stand alone. Connects how
 * much of the free pool was spent to whether commitments themselves moved. */
function buildReconciling({ flexiblePool, flexibleSpent, flexibleKept, commitMove }) {
  const spentAll = flexiblePool > 0 && flexibleKept <= 0;
  const spentMost = flexiblePool > 0 && flexibleSpent >= flexiblePool * 0.9 && flexibleKept > 0;
  let core;
  if (flexiblePool <= 0) core = 'commitments used up everything that came in this period';
  else if (spentAll) core = 'all of your discretionary money was spent';
  else if (spentMost) core = 'most of your discretionary money was spent';
  else core = 'some of your discretionary money was kept';
  let tail = '';
  if (commitMove === 'higher')
    tail = ', and commitments were higher than usual this period - worth checking why';
  else if (commitMove === 'lower')
    tail = ', helped by commitments being lower than usual this period';
  const text = core.charAt(0).toUpperCase() + core.slice(1) + tail + '.';
  const tone = flexiblePool <= 0 || spentAll || commitMove === 'higher' ? 'watch' : 'neutral';
  return { text, tone };
}

/* ===========================================================================
 *  view-model wrapper - the number/tag/detail content model for Activity, in
 *  the same frozen shape Overview uses (pronoun-free tags; detail may say you).
 * ======================================================================== */
export function buildCommittedFlexibleModel(result, cfg = {}) {
  const c = (cfg && cfg.currency) || {};
  let money;
  try {
    const f = new Intl.NumberFormat(c.locale || 'en-JM', {
      style: 'currency',
      currency: c.code || 'JMD',
      minimumFractionDigits: c.decimals == null ? 2 : c.decimals,
      maximumFractionDigits: c.decimals == null ? 2 : c.decimals,
    });
    money = (n) => f.format(Number(n || 0));
  } catch (_) {
    money = (n) => (c.symbol || '$') + Number(n || 0).toFixed(2);
  }
  const r = result;
  const pct = r.flexiblePool > 0 ? Math.round((r.flexibleSpent / r.flexiblePool) * 100) : 0;
  return {
    period: r.period,
    lead: {
      label: 'Discretionary this period',
      amount: r.flexiblePool,
      amountText: money(r.flexiblePool),
      tag: r.flexiblePool > 0 ? `${pct}% of it spent` : 'nothing discretionary',
      tone: r.reconciling.tone,
      detail: `Of the ${money(r.income)} that came in, ${money(r.committed)} was already committed to regular obligations, leaving ${money(r.flexiblePool)} of discretionary money - yours to spend or keep by choice. ${money(r.flexibleSpent)} of that was spent and ${money(r.flexibleKept)} was kept.`,
    },
    committed: {
      label: 'Already spoken for',
      amount: r.committed,
      amountText: money(r.committed),
      tag:
        r.commitMove === 'higher'
          ? 'higher than usual'
          : r.commitMove === 'lower'
            ? 'lower than usual'
            : 'usual',
      tone: r.commitMove === 'higher' ? 'watch' : 'neutral',
      detail: `Regular commitments detected from your history (${r.committedKeyCount} payee${r.committedKeyCount === 1 ? '' : 's'}). Typical for a period is about ${money(r.typicalCommitted)}.`,
    },
    flexibleSpent: {
      label: 'Discretionary spent',
      amount: r.flexibleSpent,
      amountText: money(r.flexibleSpent),
      tag: `${money(r.breakdown.cardSpend)} card`,
      tone: 'neutral',
      detail: `Made up of ${money(r.breakdown.cardSpend)} on the card and ${money(r.breakdown.otherFlexibleOut)} in cash, one-off payments and transfers to people.`,
    },
    reconciling: r.reconciling, // the mandatory tie-back line
  };
}
