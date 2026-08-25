import { cleanBankCounterparty } from '../statements/read-statements.js';
import { merchantRuleKeyFromDescription } from '../../settings/category-rules.js';
import { isUnrecognised } from '../analysis/reporting.js';

/* ===========================================================================
 * 9) CSV export
 * ======================================================================== */

// Shared CSV field escaper: quote a field only when it contains a comma, double
// quote or newline, doubling any embedded quote. This is the exact rule the
// local `esc` closures in toCSV/bankToCSV use; exported so other export-plumbing
// (the Overview combined CSV in data-export.js) reuses the identical helper
// rather than a weaker hand-rolled one, and the two can never drift.
export function csvEscape(v) {
  const s = String(v == null ? '' : v);
  return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

export function toCSV(rows, currency = 'JMD') {
  const head = [
    'Date',
    'Description',
    'Category',
    'Type',
    'Statement',
    `Amount (${currency})`,
    'Foreign',
  ];
  const lines = [head.join(',')];
  for (const r of rows) {
    const desc = r.displayName || r.description;
    lines.push(
      [r.date, desc, r.category, r.kind, r.source_file, r.amount.toFixed(2), r.foreign]
        .map(csvEscape)
        .join(',')
    );
  }
  return lines.join('\n');
}

// The Detailed counterpart to toCSV: every pipeline stage side by side, for
// auditing the categorisation/merchant-cleaning logic itself, rather than
// for using the data elsewhere. Additive - toCSV above is untouched, so
// every existing "Clean" export keeps behaving exactly as before.
export function toDetailedCSV(rows, currency = 'JMD') {
  const head = [
    'Date',
    'Reference',
    'Raw Description',
    'Cleaned Description',
    'Merchant',
    'Merchant Group',
    'Category',
    'Category Confidence',
    'Type',
    'Statement',
    `Amount (${currency})`,
    'Foreign',
  ];
  const lines = [head.join(',')];
  for (const r of rows) {
    lines.push(
      [
        r.date,
        r.ref || '',
        r.raw_description,
        r.description,
        r.displayName || '',
        r.merchantGroup || '',
        r.category,
        r.confidence,
        r.kind,
        r.source_file,
        r.amount.toFixed(2),
        r.foreign,
      ]
        .map(csvEscape)
        .join(',')
    );
  }
  return lines.join('\n');
}

// Shared multi-key sort for bank-ledger record lists: account (alphabetical),
// then date (chronological), then seq (a stable tiebreaker for same-day
// rows). Previously written out identically, twice, inside bankToCSV and
// bankToDetailedCSV.
export function sortBankRecords(records) {
  return (records || [])
    .slice()
    .sort(
      (a, b) =>
        String(a.account).localeCompare(String(b.account)) ||
        (a.date < b.date ? -1 : a.date > b.date ? 1 : 0) ||
        (a.seq == null ? 0 : a.seq) - (b.seq == null ? 0 : b.seq)
    );
}

// CSV for the bank Accounts ledger. A separate shape from the card CSV because
// the columns differ (flow direction, running balance, owning account) and the
// two ledgers are kept apart (D1). Pure and testable, mirroring toCSV. Internal
// transfers are marked so a spreadsheet can exclude them the way the app does.
export function bankRowToCsvFields(r, currency) {
  const flow = r.internalTransfer
    ? 'Internal transfer'
    : r.direction === 'in'
      ? 'Cash inflow'
      : 'Cash outflow';
  const signed = (r.direction === 'in' ? '' : '-') + Math.abs(Number(r.amount) || 0).toFixed(2);
  const bal = r.balanceAfter == null ? '' : Number(r.balanceAfter).toFixed(2);
  const hasRealLabel = r.counterpartyLabel && r.counterpartyLabel !== 'Unknown';
  const cp = hasRealLabel
    ? r.counterpartyLabel
    : cleanBankCounterparty(r.description) || r.type || '';
  return { flow, signed, bal, cp };
}

export function bankToCSV(records, currency = 'JMD') {
  const head = ['Date', 'Account', 'Currency', 'Counterparty', 'Flow', 'Amount', 'Running balance'];
  const rows = sortBankRecords(records);
  const lines = [head.join(',')];
  for (const r of rows) {
    const { flow, signed, bal, cp } = bankRowToCsvFields(r, currency);
    lines.push(
      [r.date, r.account || '', r.currency || currency, cp, flow, signed, bal]
        .map(csvEscape)
        .join(',')
    );
  }
  return lines.join('\n');
}

export function bankToDetailedCSV(records, currency = 'JMD') {
  const head = [
    'Date',
    'Account',
    'Currency',
    'Raw Description',
    'Counterparty',
    'Counterparty Group',
    'Internal Transfer',
    'Type',
    'Flow',
    'Amount',
    'Running Balance',
    'Statement',
  ];
  const rows = sortBankRecords(records);
  const lines = [head.join(',')];
  for (const r of rows) {
    const { flow, signed, bal, cp } = bankRowToCsvFields(r, currency);
    lines.push(
      [
        r.date,
        r.account || '',
        r.currency || currency,
        r.description || '',
        cp,
        r.counterpartyKey || '',
        r.internalTransfer ? 'Yes' : 'No',
        r.type || '',
        flow,
        signed,
        bal,
        r.source_file || '',
      ]
        .map(csvEscape)
        .join(',')
    );
  }
  return lines.join('\n');
}

// Contribute-back export (Manage Data): a deliberately minimal CSV of
// merchants the app could not identify AT ALL. This is narrower than "needs
// review" - it deliberately EXCLUDES a known merchant the app is merely
// uncertain about (e.g. WiPay, confidence 0.4, reviewRequired true in
// jamaica-merchants.json). That ambiguity is a structural fact about how the
// merchant itself works (a payment processor whose underlying business the
// descriptor never reveals), already captured in the merchant-intelligence
// file - sending it back would be noise, not a coverage gap. Only a row that
// fell all the way through categorise()'s last-resort branches with
// confidence 0 (genuinely unmatched by any merchant entry, keyword or head
// rule) counts here.
//
// Grouped by merchantRuleKeyFromDescription - the SAME key buildRows() already
// uses for merchant overrides and renderRecurring()'s drill-down - so "one
// merchant" means the same thing here it means everywhere else in the app,
// rather than a hand-rolled second definition that could drift.
//
// Whole history (the caller passes state.rows, not periodRows()), since this
// is about total merchant coverage, not a snapshot of one period.
//
// Deliberately minimal, by design, not by omission: only the original
// statement text and how many times it appeared. No amount, no date, no
// account - nothing that turns a vocabulary gap into a financial disclosure.
export function buildUnknownMerchantsCSV(rows, fallback = 'Uncategorised') {
  const groups = new Map();
  for (const r of rows || []) {
    // Was its own hand-written re-expression of exactly what attentionItems()
    // already checked (confidence===0, implicitly always paired with category
    // ===fallback by categorise()'s construction). Now reads the one shared
    // predicate, so a future change to categorise()'s fallback branch only
    // ever needs updating in isUnrecognised, not re-audited across every
    // place that used to ask the same question independently.
    if (!isUnrecognised(r, fallback)) continue;
    const key = merchantRuleKeyFromDescription(r.raw_description) || r.raw_description;
    if (!groups.has(key)) groups.set(key, { description: r.raw_description, count: 0 });
    groups.get(key).count += 1;
  }
  const list = [...groups.values()].sort((a, b) => b.count - a.count);
  const lines = [['Description', 'Occurrences'].join(',')];
  for (const g of list) lines.push([g.description, g.count].map(csvEscape).join(','));
  return { csv: lines.join('\n'), count: list.length };
}
