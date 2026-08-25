/* ===========================================================================
 *  available-now.js  -  Overview view-model for the three-layer "available now".
 *
 *  Turns the pure output of commitmentAndIncomePrimitive() into the frozen
 *  content model every card on the new surfaces uses:
 *      number  ->  the figure, largest thing, never hidden behind a click
 *      tag     ->  a few words closing the number against a reference point;
 *                  PRONOUN-FREE ("paid in full", "before payday", "usual")
 *      detail  ->  the fuller reasoning for the info dropdown, where the app
 *                  speaks as an outside source and MAY use "you"/"your"
 *
 *  PURE and Node-testable: takes the primitive result + cfg, returns a plain
 *  model. No DOM, no fetch, no mutation. The render layer (overview-render.js)
 *  consumes this and applies the single privacy state to the *Text fields.
 *
 *  HONESTY RULE (the reason this module is careful): partial data must never
 *  produce a complete-sounding conclusion. When the primitive reports
 *  confidence 'incomplete', the verdict here is explicitly hedged and the lead
 *  figure is labelled an estimate, never a crisp boundary.
 *
 *  LANGUAGE RULE: tags carry no pronoun; only the dropdown detail addresses the
 *  person as "you". Structural labels use "my" but those live in the render,
 *  not here.
 * ======================================================================== */

// Money formatter from config (JMD / $ / en-JM by default). Intl is available
// in the browser and in Node, so the same formatting is exercised by the proof.
export function makeMoney(cfg = {}) {
  const c = (cfg && cfg.currency) || {};
  const code = c.code || 'JMD';
  const locale = c.locale || 'en-JM';
  const decimals = c.decimals == null ? 2 : c.decimals;
  let fmt;
  try {
    fmt = new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: code,
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    });
  } catch (_) {
    fmt = {
      format: (n) => (c.symbol || '$') + Number(n || 0).toFixed(decimals),
    };
  }
  return (n) => fmt.format(Number(n || 0));
}

function dayOrdinal(iso) {
  const d = +String(iso || '').slice(8, 10) || 0;
  if (!d) return '';
  const s = d % 100 >= 11 && d % 100 <= 13 ? 'th' : { 1: 'st', 2: 'nd', 3: 'rd' }[d % 10] || 'th';
  return d + s;
}
function monthShort(iso) {
  const m = +String(iso || '').slice(5, 7);
  return (
    ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][m] ||
    ''
  );
}
function dateText(iso) {
  return iso ? `${dayOrdinal(iso)} ${monthShort(iso)}` : '';
}

/* ---- card leg -> tag + detail (honest about the transactor / window) ------ */
function cardView(card, money) {
  const basis = card.basis || '';
  const amt = Number(card.amountExpectedBeforeNextIncome || 0);
  if (basis === 'due-after-income') {
    return {
      amount: 0,
      amountText: money(0),
      tag: 'nothing due before payday',
      tone: 'good',
      detail:
        'Your card payment is due after your next pay lands, so it is not taken from what you have to move before then.',
    };
  }
  if (basis === 'due-before-income') {
    return {
      amount: amt,
      amountText: money(amt),
      tag: 'due before payday',
      tone: 'neutral',
      detail: `About ${money(amt)} is due on the card before your next pay, on ${dateText(card.dueDate)}, so it is set aside from what you have to move.`,
    };
  }
  if (basis === 'no-card-statement') {
    return {
      amount: 0,
      amountText: money(0),
      tag: 'no card statement yet',
      tone: 'watch',
      detail:
        'No card statement has been read yet, so any amount due on the card is not included. This figure is incomplete until a statement is imported.',
    };
  }
  // no-amount-due / amount-known-date-unknown / no-income-date
  return {
    amount: 0,
    amountText: money(0),
    tag: 'card date unknown',
    tone: 'watch',
    detail:
      'The card amount is known but its due date could not be read, so it cannot be placed before or after your next pay. This figure is left out until the date is confirmed.',
  };
}

/* ---- income -> tag + detail ----------------------------------------------- */
function incomeView(income, money) {
  if (!income) {
    return {
      present: false,
      tag: 'no regular income found',
      tone: 'watch',
      detail:
        'No repeating income has been detected yet, so the date of your next pay is unknown and the figures below are marked incomplete.',
    };
  }
  const conf = income.confidence === 'High' ? 'Steady' : 'Likely';
  return {
    present: true,
    amount: income.amount,
    amountText: money(income.amount),
    dateText: dateText(income.date),
    tag: `${conf} · ~${dayOrdinal(income.date)}`,
    tone: 'good',
    detail: `Your pay of about ${money(income.amount)} is expected around ${dateText(income.date)}, based on a ${income.confidence === 'high' ? 'well-established' : 'developing'} monthly pattern.`,
  };
}

/* ---- one plain verdict, honestly hedged when data is incomplete ----------- */
function buildVerdict(p, cardV, incomeV, money) {
  const est = p.layers.estimatedAvailableAfterCommitments;
  const incomplete = p.confidence === 'incomplete';
  const parts = [];
  // income clause
  if (incomeV.present) parts.push(incomeV.tone === 'Good' ? 'Steady income' : 'Income detected');
  // card clause
  if (cardV.tag === 'nothing due before payday')
    parts.push('nothing due on the card before payday');
  else if (cardV.tag === 'due before payday') parts.push('a card payment due before payday');
  // coverage clause
  const covered = est > 0;
  if (!incomplete) {
    parts.push(covered ? 'comfortably covered before your next pay' : 'tight before your next pay');
  }
  let text = parts.length ? parts.join(', ') : 'position calculated';
  text = text.charAt(0).toUpperCase() + text.slice(1) + '.';
  if (incomplete) {
    text = `${text} Some inputs are missing, so this is an estimate, not a firm figure.`;
  }
  const tone = incomplete ? 'watch' : covered ? 'good' : 'watch';
  return { text, tone };
}

/* ===========================================================================
 *  buildAvailableNowModel - the exported view-model builder.
 *  Lead figure = estimated available AFTER commitments, framed as a boundary
 *  ("left after what's already committed"), with the working beneath it.
 * ======================================================================== */
export function buildAvailableNowModel(primitiveResult, cfg = {}) {
  const money = makeMoney(cfg);
  const p = primitiveResult;
  const incomplete = p.confidence === 'incomplete';

  const cardV = cardView(p.card, money);
  const incomeV = incomeView(p.income, money);

  const nCommit = (p.commitments && p.commitments.length) || 0;
  const hasCardCommit = (p.commitments || []).some((c) => c.basis === 'card');

  const lead = {
    id: 'estimatedAvailable',
    label: 'Left after what is already committed',
    amount: p.layers.estimatedAvailableAfterCommitments,
    amountText: money(p.layers.estimatedAvailableAfterCommitments),
    // boundary framing, pronoun-free
    tag: incomplete
      ? 'estimate'
      : p.layers.estimatedAvailableAfterCommitments > 0
        ? 'free to move until payday'
        : 'nothing spare until payday',
    tone: incomplete ? 'watch' : p.layers.estimatedAvailableAfterCommitments > 0 ? 'good' : 'watch',
    detail: `This is your cash on hand of ${money(p.layers.availableBalance)} minus ${money(p.layers.commitmentsBeforeIncome)} of payments due before your next pay${hasCardCommit ? ', including your card payment' : ''}. It is what is genuinely free to move, not your full balance.`,
  };

  const working = [
    {
      id: 'availableBalance',
      label: 'Cash on hand',
      amount: p.layers.availableBalance,
      amountText: money(p.layers.availableBalance),
      tag: 'everyday accounts',
      tone: 'neutral',
      detail:
        'The latest balance across your everyday accounts. Savings in the same currency are included; foreign-currency accounts are shown separately, and the card is not part of this figure.',
    },
    {
      id: 'commitments',
      label: 'Committed before payday',
      amount: p.layers.commitmentsBeforeIncome,
      amountText: money(p.layers.commitmentsBeforeIncome),
      tag: nCommit
        ? `${nCommit} payment${nCommit > 1 ? 's' : ''}${hasCardCommit ? ' incl. card' : ''}`
        : 'nothing due before payday',
      tone: 'neutral',
      detail: nCommit
        ? `Payments already due to leave before your next pay: ${p.commitments.map((c) => `${money(c.amount)}${c.basis === 'card' ? ' (card)' : ''} on ${dateText(c.date)}`).join('; ')}.`
        : 'Nothing is due to leave before your next pay. Money that recurs on or after payday, and your full card balance, are not counted here.',
    },
  ];

  const verdict = buildVerdict(p, cardV, incomeV, money);

  return {
    asOf: p.asOf,
    confidence: p.confidence, // 'complete' | 'incomplete'
    verdict, // { text, tone } - one plain conclusion
    lead, // the boundary figure (number/tag/detail)
    working, // [cash on hand, committed] beneath it
    income: incomeV, // number/tag/detail
    card: cardV, // number/tag/detail, reassurance beside owed
    gaps: p.gaps || [], // named, surfaced honestly when incomplete
  };
}
