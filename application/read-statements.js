import { fnv1a, toIso, money, monthKey, roundMoney, monthIndex, recurringStatus } from './shared-helpers.js';
import { smartTitle } from './categorise.js';

// A shared, empty keep-upper / small-words set for smartTitle when tidying a
// bank counterparty for DISPLAY. Bank rows carry no per-user config here, so
// plain Title Case is applied (no forced-upper acronyms, no forced-lower
// connectives) - the exact smartTitle the card-side merchantDisplayLabel uses
// for its own Title Case fallback. Reused everywhere the counterparty display
// label is built so a payee reads identically on every tab. categorise.js only
// imports merchant-intelligence.js and shared-helpers.js (never this module),
// so this import introduces no cycle.
const CP_LABEL_SET = new Set();

const DATE_RE = /\d{1,2}-[A-Za-z]{3}-\d{4}/;
const AMOUNT_RE = /\$-?[\d,]+\.\d{2}/;
const FULL_LINE = /^(\d{1,2}-[A-Za-z]{3}-\d{4})\s+(\d{1,2}-[A-Za-z]{3}-\d{4})\s+(\d{8,12})\s+(.*?)\s+(\$-?[\d,]+\.\d{2})\s*$/;
const STRANDED_LINE = /^(\d{1,2}-[A-Za-z]{3}-\d{4})\s+(\d{1,2}-[A-Za-z]{3}-\d{4})\s+(\d{8,12})\s+(\$-?[\d,]+\.\d{2})\s*$/;
// A real transaction row always begins with this prefix: transaction date,
// posting date and an 8-12 digit reference number. Statement footer/summary
// lines never do (their embedded dates are numeric dd-mm-yyyy, not dd-Mon-yyyy).
const TXN_PREFIX = /^\d{1,2}-[A-Za-z]{3}-\d{4}\s+\d{1,2}-[A-Za-z]{3}-\d{4}\s+\d{8,12}\b/;
// "date date ref DESCRIPTION" with NO trailing money amount - the wide-row
// split where the amount (and any forex bracket) wrapped onto the next line.
const HEADER_NO_AMOUNT = /^(\d{1,2}-[A-Za-z]{3}-\d{4})\s+(\d{1,2}-[A-Za-z]{3}-\d{4})\s+(\d{8,12})\s+(\S.*?)\s*$/;
const AMOUNT_END = /\$-?[\d,]+\.\d{2}\s*$/;
const SUMMARY_WORDS = /\b(total|balance|statement|page|summary|opening|closing|minimum|amount owing|previous|new balance|purchases,|payments &)\b/i;
const FOREX = /\(([\d,]+\.\d{2})\s*([A-Z]{3})\)/;

// The recurring per-page statement footer, e.g.
// It carries a long account-number run, two dd-mm-yyyy dates (all numeric, so
// distinct from the dd-Mon-yyyy transaction dates) and a trailing "- N" page
// marker. Such a line must never be treated as a transaction, an amount
// fragment or a merchant fragment, and must never leak into a description.
const NUMERIC_DATE = /\b\d{1,2}-\d{1,2}-\d{4}\b/;
const NUMERIC_DATE_G = /\b\d{1,2}-\d{1,2}-\d{4}\b/g;
function isFooterLine(s) {
  const t = String(s == null ? '' : s);
  if (!t.trim()) return false;
  if (/\d{10,}/.test(t) && NUMERIC_DATE.test(t)) return true;   // account no. + statement date
  const dates = t.match(NUMERIC_DATE_G);
  if (dates && dates.length >= 2) return true;                  // two statement dates
  if (/-\s*\d{3,4}\s*-/.test(t) && /-\s*\d{1,2}\s*$/.test(t)) return true; // short card-marker group + page no.
  return false;
}
// Remove a leading statement-footer prefix from a description, keeping only the
// real merchant text after the "… - dd-mm-yyyy - dd-mm-yyyy - N " page marker.
// Only fires when both an account-number run and a numeric date are present, so
// ordinary merchants (even ones with long digit strings) are never touched.
export function stripFooterPrefix(desc) {
  const s = String(desc == null ? '' : desc);
  if (!/\d{10,}/.test(s) || !NUMERIC_DATE.test(s)) return s;
  const cut = s.replace(/^.*?\b\d{1,2}-\d{1,2}-\d{4}\b\s*-\s*\b\d{1,2}-\d{1,2}-\d{4}\b\s*-\s*\d+\s+/, '');
  return (cut && cut !== s) ? cut : s;
}

// True when a "description" is really just a stray forex fragment left by a
// wrapped row, e.g. "USD)", "(103.71 USD)", "(103.71" or "9.99 USD". Such a
// fragment must never be allowed to become a merchant name.
export function isForexFragmentDesc(desc) {
  const s = String(desc == null ? '' : desc).trim();
  if (!s) return true;
  return /^[A-Za-z]{3}\)?$/.test(s) || /^\(?\s*[\d,]+\.\d{2}\s*[A-Za-z]{0,3}\)?$/.test(s);
}

// Find a nearby line that carries the stranded money amount (and possibly a
// forex bracket) for a header row whose amount wrapped. Scans a small window in
// each direction, skipping over blank / summary / page-footer lines (a footer
// can sit between the description and the amount when the row wraps across a
// page boundary), but never crossing into another transaction row.
export function findAdjacentAmountFragment(clean, i) {
  for (const dir of [1, -1]) {
    let j = i + dir; let hops = 0;
    while (j >= 0 && j < clean.length && hops < 4) {
      const c = clean[j];
      if (c && TXN_PREFIX.test(c)) break;                 // another transaction: stop
      if (!c || isFooterLine(c) || SUMMARY_WORDS.test(c)) { j += dir; hops++; continue; }
      if (AMOUNT_END.test(c)) return { text: c, index: j };
      break;                                              // some other content: stop this way
    }
  }
  return null;
}

// Find an adjacent line that carries the real merchant text for a row whose
// description was replaced by a forex fragment. Skips transaction starts,
// summary/footer lines, bare amount fragments and pure forex fragments.
export function findAdjacentMerchantFragment(clean, i) {
  for (const j of [i - 1, i + 1]) {
    if (j < 0 || j >= clean.length) continue;
    const c = clean[j];
    if (!c || TXN_PREFIX.test(c) || SUMMARY_WORDS.test(c) || isFooterLine(c)) continue;
    if (AMOUNT_END.test(c) || isForexFragmentDesc(c)) continue;
    if (/[A-Za-z]/.test(c.replace(/[A-Za-z]{3}\)?\s*$/, ''))) return { text: c, index: j };
  }
  return null;
}

// Rebuild a clean "MERCHANT (NN.NN CCY)" description from a merchant fragment
// (which may carry a partial "(NN.NN") and a trailing currency/forex fragment.
export function mergeForexDescription(merchantPart, forexPart) {
  const combined = `${merchantPart} ${forexPart}`;
  const num = (combined.match(/([\d,]+\.\d{2})/) || [])[1];
  const ccy = (combined.match(/\b([A-Z]{3})\b/) || [])[1];
  let merchant = String(merchantPart).replace(/\(?\s*[\d,]+\.\d{2}.*$/, '').replace(/[\s,]+$/g, '').trim();
  if (!merchant) merchant = String(merchantPart).trim();
  return num && ccy ? `${merchant} (${num} ${ccy})` : merchant;
}

export function statementPeriod(lines) {
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === 'Statement Period' && i + 1 < lines.length) {
      return lines[i + 1].trim();
    }
  }
  return '';
}

/* ===========================================================================
 *  Statement format detection  (Phase 0: the clean seam between two ledgers)
 *  A single, pure function that reads already-extracted lines and says whether
 *  the PDF is a credit-card statement (the only thing this app reads today) or
 *  a bank account statement (Withdrawals & Deposits ledger). It sits between
 *  generic text extraction and the card-specific parser, which is the natural
 *  insertion point for a future bank parser without disturbing the card path.
 *
 *  Detection is deliberately conservative: it only returns 'bank' on a clear,
 *  bank-specific signal, so every card statement still routes to the existing
 *  parser and nothing about card parsing, totals or identity changes. Bank
 *  statements in the sample set all carry a "Transactions (Withdrawals &
 *  Deposits)" ledger header and an "Account Summary" block on the first page;
 *  card statements carry neither. Either the explicit ledger header, or the
 *  Withdrawals + Deposits pairing alongside an Account Summary, is enough.
 *  ======================================================================== */
export function detectStatementFormat(lines) {
  const text = (Array.isArray(lines) ? lines.join('\n') : String(lines == null ? '' : lines))
    .toLowerCase().replace(/\s+/g, ' ');
  if (!text.trim()) return 'card'; // nothing to read: leave the existing path to report it
  const ledgerHeader = /transactions\s*\(?\s*withdrawals\s*(?:&|and)\s*deposits/.test(text);
  const hasWithdrawals = /\bwithdrawals?\b/.test(text);
  const hasDeposits = /\bdeposits?\b/.test(text);
  const hasAccountSummary = /\baccount summary\b/.test(text);
  if (ledgerHeader || (hasWithdrawals && hasDeposits && hasAccountSummary)) return 'bank';
  return 'card';
}

/* ===========================================================================
 *  Card statement issuer detection  (Part A: NCB vs Scotiabank, WITHIN the
 *  card path). A second pure sub-detector that runs only after
 *  detectStatementFormat has already routed a PDF to the card path; it says
 *  which card issuer produced the statement so ingest can pick the matching
 *  reader. It is deliberately ADDITIVE and wired to nothing here: the existing
 *  Scotiabank path stays the default, so nothing changes until it is branched
 *  on explicitly (Part E).
 *
 *  It returns 'ncb' ONLY on a conservative combination of NCB-specific markers
 *  that were confirmed to survive pdf.js text extraction on all twelve real NCB
 *  statements. The printed "NATIONAL COMMERCIAL BANK" logo is a raster image
 *  and never reaches the text layer, and the "POSTING ... BILLING AMOUNT"
 *  column header does not reliably survive as one line, so NEITHER is used.
 *  At least two of these four independent markers must be present, and none of
 *  them appears on a Scotiabank statement, so Scotiabank can never be misrouted
 *  and stays the default:
 *    - the NCB web address           (jncb.com)
 *    - the NCB card product line      ("NCB VISA CLASSIC" / "NCB VISA PLATINUM")
 *    - the NCB GCT registration       ("G.C.T. NO. 19453")
 *    - the NCB rewards page header    ("STATEMENT OF POINTS")
 *  Requiring two independent markers stops a stray single token (for example a
 *  merchant literally named in a Scotiabank row) from ever flipping the result.
 *  ======================================================================== */
export function detectCardStatementFormat(lines) {
  const text = (Array.isArray(lines) ? lines.join('\n') : String(lines == null ? '' : lines))
    .toLowerCase().replace(/\s+/g, ' ');
  if (!text.trim()) return 'scotia'; // nothing to read: leave the existing default path
  let signals = 0;
  if (/jncb\.com/.test(text)) signals++;
  if (/ncb\s+visa\s+(?:classic|platinum)/.test(text)) signals++;
  if (/g\.c\.t\.?\s*no\.?\s*19453/.test(text)) signals++;
  if (/statement of points/.test(text)) signals++;
  return signals >= 2 ? 'ncb' : 'scotia';
}

export function findStrandedDescription(clean, idx) {
  for (const j of [idx - 1, idx + 1]) {
    if (j >= 0 && j < clean.length) {
      const cand = clean[j];
      if (cand && !DATE_RE.test(cand) && !AMOUNT_RE.test(cand) &&
          !SUMMARY_WORDS.test(cand) && !isFooterLine(cand) && cand.length > 3) {
        return cand;
      }
    }
  }
  return 'UNKNOWN MERCHANT';
}

export function buildTxn(txnD, postD, ref, desc, amt, source, stitched) {
  let fxAmt = null, fxCcy = null;
  const fx = FOREX.exec(desc);
  if (fx) {
    const v = parseFloat(fx[1].replace(/,/g, ''));
    if (!Number.isNaN(v)) { fxAmt = v; fxCcy = fx[2]; }
    desc = desc.replace(/\(([\d,]+\.\d{2})\s*([A-Z]{3})\)/g, '').trim();
  }
  // Drop a stranded, unclosed forex fragment left by a wrapped line.
  desc = desc.replace(/\(\s*[\d,]+\.?\d*\s*[A-Z]{0,3}$/, '').replace(/^[\s,(]+|[\s,(]+$/g, '');
  // Strip any leading statement-footer prefix that a wide/page-boundary split
  // merged in, so a merchant is never imported as "- 1234 - … - 2 Coral Outlet".
  desc = stripFooterPrefix(desc);
  const foreign = (fxAmt && fxCcy)
    ? `${fxAmt.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${fxCcy}`
    : '';
  return {
    txn_date: toIso(txnD), posting_date: toIso(postD), ref,
    description: desc.replace(/^[\s,]+|[\s,]+$/g, ''),
    amount: money(amt), source_file: source, foreign, stitched,
  };
}

// A transaction anchor: the visual line that carries the two dd-Mon-yyyy dates,
// the 8-12 digit reference and the JMD amount. The amount always shares this
// line; only the DESCRIPTION ever wraps. The match is deliberately UN-anchored
// so a row is still recovered when extraction glues a page-footer or the
// cardholder name in front of it (e.g. "…- 2 30-Nov-2024 … $0.00" or
// "CARDHOLDER NAME 01-Aug-2025 … $0.00"). Description is optional so a
// bare "date date ref $amount" stranded row still anchors.
const TXN_ANYWHERE = /(\d{1,2}-[A-Za-z]{3}-\d{4})\s+(\d{1,2}-[A-Za-z]{3}-\d{4})\s+(\d{8,12})\s+(?:(.*?)\s+)?(\$-?[\d,]+\.\d{2})\s*$/;
// A description already carrying a closed "(NN.NN CCY)" forex bracket inline.
const COMPLETE_FOREX = /\([\d,]+\.\d{2}\s*[A-Z]{3}\)/;

// The real content of a line for continuation purposes: a pure page-footer
// yields '' (nothing to merge), while a footer that also glued on merchant text
// (page-boundary wrap) yields just that trailing merchant text, so the footer's
// account-number/date run can never leak into a description.
export function lineContent(line) {
  const s = String(line == null ? '' : line);
  if (isFooterLine(s)) {
    const cut = s.replace(/^.*?\b\d{1,2}-\d{1,2}-\d{4}\b\s*-\s*\b\d{1,2}-\d{1,2}-\d{4}\b\s*-\s*\d+\s+/, '');
    return (cut && cut !== s) ? cut.trim() : '';
  }
  return s.trim();
}

// A line that is a wrapped continuation of the row above it: a forex fragment
// ("(141.12 USD)", "BEA (247.08 USD)", a bare "USD)" completion) or a single
// stranded merchant token ("LAUDERDA"→handled via forex, "AMZN.COM/BILL", "10",
// "PROTECTION"). The lone "JMD" column marker is never a continuation.
export function isContinuationLine(text) {
  const t = String(text == null ? '' : text).trim();
  if (!t || t === 'JMD') return false;
  if (/\([\d,]+\.\d{2}/.test(t)) return true;   // opens/holds a forex bracket
  if (/[A-Z]{3}\)$/.test(t)) return true;       // "…USD)" or bare "USD)"
  if (/^\S+$/.test(t)) return true;             // a single wrapped tail token
  return false;
}

// A line that can supply the MERCHANT for an anchor whose own description
// wrapped away to just a forex tail (the "USD)" case). It must hold letters
// outside any forex bracket and not itself be a bare forex fragment.
export function isMerchantFragment(text) {
  const t = String(text == null ? '' : text).trim();
  if (!t || isForexFragmentDesc(t)) return false;
  return /[A-Za-z]/.test(t.replace(/\([\d,]+\.\d{2}.*$/, ''));
}

// A wrapped merchant HEAD stranded on the line directly ABOVE its anchor: the
// row's leading description part (e.g. "AMAZON MKTPL*NN8V805K1,") was pushed
// onto the previous visual line - often glued to a page-footer - while the
// anchor row itself kept only the continuation ("AMZN.COM/BILL"). Such a head
// carries no amount and no date/reference of its own, and ends at the wrap
// comma (the merchant-name / next-part break). That trailing comma is what
// separates a real wrapped head from column headers, the lone "JMD" marker,
// summary text and ordinary complete rows, none of which end in a comma.
export function isMerchantHeadFragment(text) {
  const t = String(text == null ? '' : text).trim();
  if (!t || t === 'JMD') return false;
  if (SUMMARY_WORDS.test(t)) return false;   // not a summary/footer word line
  if (AMOUNT_END.test(t)) return false;      // carries its own trailing amount
  if (TXN_PREFIX.test(t)) return false;      // is itself a transaction start
  return /,$/.test(t) && /[A-Za-z]/.test(t); // ends at the wrap comma, has letters
}

export function parseStatementLines(lines, sourceFile) {
  const out = { source_file: sourceFile, period: '', transactions: [], warnings: [] };
  if (!lines || !lines.some((l) => l.trim())) {
    out.warnings.push('No text could be read from this PDF.');
    return out;
  }
  out.period = statementPeriod(lines);
  const clean = lines.map((l) => l.replace(/\s+/g, ' ').trim());

  // Pass 0: locate every transaction anchor. Matching the amount-bearing line
  // anywhere (not only at start) means a footer/name prefix no longer swallows
  // the whole row, so no complete transaction is ever dropped from the pool.
  const isAnchor = new Array(clean.length).fill(false);
  const consumed = new Array(clean.length).fill(false);
  const anchors = [];
  for (let i = 0; i < clean.length; i++) {
    const m = clean[i] && TXN_ANYWHERE.exec(clean[i]);
    if (m) {
      isAnchor[i] = true;
      anchors.push({ i, txnD: m[1], postD: m[2], ref: m[3], desc: (m[4] || '').trim(), amt: m[5] });
    }
  }

  // Pass 0b: header-first wraps - some extractions place the amount (and the
  // "(NN.NN CCY)" bracket) on the NEXT visual line, leaving a bare
  // "date date ref DESCRIPTION" with no amount. Pair the header with the
  // following amount-bearing line, skipping any page-footer that fell between
  // them across a page break, so the row still anchors with its full
  // description, amount and foreign value and the footer never merges in.
  for (let i = 0; i < clean.length; i++) {
    if (isAnchor[i] || consumed[i] || !clean[i]) continue;
    if (AMOUNT_RE.test(clean[i])) continue;               // already carries an amount
    const hm = HEADER_NO_AMOUNT.exec(clean[i]);
    if (!hm) continue;
    let found = null;
    for (const dir of [1, -1]) {
      let j = i + dir, hops = 0;
      while (j >= 0 && j < clean.length && hops < 4) {
        if (isAnchor[j] || consumed[j]) break;            // never cross into another row
        const c = lineContent(clean[j]);
        if (!c) { j += dir; hops++; continue; }           // footer/blank between pages: skip
        if (AMOUNT_END.test(c)) found = { j, c };
        break;
      }
      if (found) break;
    }
    if (found) {
      const m = TXN_ANYWHERE.exec(`${hm[1]} ${hm[2]} ${hm[3]} ${hm[4]} ${found.c}`.replace(/\s+/g, ' ').trim());
      if (m) {
        isAnchor[i] = true; consumed[found.j] = true;
        anchors.push({ i, txnD: m[1], postD: m[2], ref: m[3], desc: (m[4] || '').trim(), amt: m[5] });
      }
    }
  }
  anchors.sort((a, b) => a.i - b.i);

  // Pass A: tail-only anchors - the description wrapped away leaving only a
  // forex tail ("USD)"). Rebuild the merchant from the adjacent orphan (the
  // wrapped merchant sits on the line ABOVE at a page boundary) and keep the
  // "(NN.NN CCY)"; a bare "USD)" or forex fragment is never left as the name.
  for (const a of anchors) {
    if (a.desc && !isForexFragmentDesc(a.desc)) continue;
    for (const j of [a.i - 1, a.i + 1]) {
      if (j < 0 || j >= clean.length || isAnchor[j] || consumed[j]) continue;
      const c = lineContent(clean[j]);
      if (isMerchantFragment(c)) { a.desc = mergeForexDescription(c, a.desc || ''); consumed[j] = true; break; }
    }
  }

  // Pass A1: head-above wraps - the row's leading merchant text spilled onto the
  // PREVIOUS visual line (commonly merged with a page-footer) while the anchor
  // kept only the continuation. Concatenate that head with the anchor's own
  // description so the full merchant is rebuilt - the leading tokens are joined,
  // never discarded - and the footer prefix, stripped by lineContent(), can
  // never leak in. Only an unclaimed, non-anchor, comma-terminated head above
  // the row qualifies, so a row that already parses whole on one line (its line
  // above being another anchor, a bare footer, a column header or "JMD") is
  // never altered. A merchant tail never ends in a comma, so this can never
  // collide with the below-line stitching in Pass B.
  for (const a of anchors) {
    if (!a.desc || isForexFragmentDesc(a.desc)) continue;
    const j = a.i - 1;
    if (j < 0 || isAnchor[j] || consumed[j]) continue;
    const head = lineContent(clean[j]);
    if (!isMerchantHeadFragment(head)) continue;
    if (a.desc.startsWith(head)) continue;             // already whole; leave as-is
    a.desc = `${head} ${a.desc}`.replace(/\s+/g, ' ').trim();
    consumed[j] = true;
  }

  // Pass B: normal wrapped rows - the merchant tail and/or the "(NN.NN CCY)"
  // forex bracket wrapped onto the following line. Stitch the first
  // continuation orphan below the anchor back on so the full description and
  // the foreign tag are both recovered; a line that is itself a transaction is
  // never consumed, and each orphan is claimed by exactly one anchor.
  for (const a of anchors) {
    if (!a.desc || isForexFragmentDesc(a.desc) || COMPLETE_FOREX.test(a.desc)) continue;
    let j = a.i + 1, hops = 0;
    while (j < clean.length && hops < 3) {
      if (isAnchor[j]) break;                          // reached the next transaction
      if (consumed[j]) { j++; hops++; continue; }
      const c = lineContent(clean[j]);
      if (!c) { j++; hops++; continue; }               // page-footer / blank: skip over
      if (isContinuationLine(c)) { a.desc = `${a.desc} ${c}`.replace(/\s+/g, ' ').trim(); consumed[j] = true; }
      break;                                           // only the first real line below
    }
  }

  for (const a of anchors) {
    out.transactions.push(buildTxn(a.txnD, a.postD, a.ref, a.desc, a.amt, sourceFile, false));
  }
  return out;
}

// pdf.js text extraction. Browser/worker only; kept thin so the tested logic
// (parseStatementLines) is independent of the PDF engine.
export async function extractLines(arrayBuffer, pdfjs) {
  const doc = await pdfjs.getDocument({ data: arrayBuffer, verbosity: 0 }).promise;
  const lines = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    // Reduce positioned text runs into visual lines. Items on the same visual
    // line can differ slightly in y, so cluster by y within a tolerance derived
    // from text height rather than requiring an exact match. This keeps each
    // transaction row on a single line for the row matcher.
    const items = content.items
      .filter((it) => it.str && it.str.trim())
      .map((it) => ({ x: it.transform[4], y: it.transform[5], h: it.height || 8, s: it.str }))
      .sort((a, b) => (b.y - a.y) || (a.x - b.x));
    let current = [];
    let baseY = null;
    const flush = () => {
      if (!current.length) return;
      const parts = current.sort((a, b) => a.x - b.x).map((r) => r.s);
      lines.push(parts.join(' ').replace(/\s+/g, ' ').trim());
      current = [];
    };
    for (const it of items) {
      const tol = Math.max(2, (it.h || 8) * 0.6);
      if (baseY === null || Math.abs(it.y - baseY) <= tol) {
        current.push(it);
        baseY = baseY === null ? it.y : baseY;
      } else {
        flush();
        current.push(it);
        baseY = it.y;
      }
    }
    flush();
  }
  return lines;
}

export function statementContentHash(lines) {
  return fnv1a(lines.map((l) => l.replace(/\s+/g, ' ').trim()).join('\n'));
}

/* ===========================================================================
 *  BANK STATEMENT SUPPORT  (Phase 1: read-only Accounts ledger, balance-first)
 *  A second parser beside the card parser above. Bank statements are a
 *  different document class (money in / out / transfer with a running balance),
 *  so they get their own pure functions, their own record shape and their own
 *  store, and never touch the card path (PRD D1, D2). The running balance
 *  printed on every statement is the backbone (D4): it repairs parsing, proves
 *  the import reconciles against the printed Account Summary, and disambiguates
 *  duplicates. Built inline here, beside its card equivalent, per D13 - no new
 *  shipped module. reuses fnv1a() and roundMoney() from the shared helpers above.
 *  ======================================================================== */

const BMONTHS = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12 };
const BMONTH_ABBR = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];

// "31JAN26 to 30APR26" -> { startY, startM, startD, endY, endM, endD }. The
// period can span a year end on the quarterly statements, which is why the
// year is read here and used to resolve the year-less DDMON transaction dates.
export function bankStatementPeriod(lines) {
  const text = lines.join('\n');
  const m = /(\d{1,2})([A-Z]{3})(\d{2})\s+to\s+(\d{1,2})([A-Z]{3})(\d{2})/i.exec(text);
  if (!m) return null;
  const sM = BMONTHS[m[2].toLowerCase()], eM = BMONTHS[m[5].toLowerCase()];
  if (!sM || !eM) return null;
  return { startY: 2000 + (+m[3]), startM: sM, startD: +m[1],
           endY: 2000 + (+m[6]), endM: eM, endD: +m[4] };
}

// The account this ledger belongs to, from the ledger header
// "Transactions ( Withdrawals & Deposits )  - 1234".
export function bankAccountNumber(lines) {
  for (const l of lines) {
    const m = /withdrawals\s*(?:&|and)\s*deposits\s*\)?\s*-\s*(\d{4,})/i.exec(l);
    if (m) return m[1];
  }
  return '';
}

// Resolve a year-less "02FEB" to a full ISO date using the statement period.
// Transactions are chronological, so when the month number drops below the
// previous month the year has rolled forward once.
export function makeBankDateResolver(period) {
  let curY = period ? period.startY : new Date().getFullYear();
  let prevM = period ? period.startM : 1;
  let started = false;
  return (day, monAbbr) => {
    const mo = BMONTHS[monAbbr.toLowerCase()];
    if (!mo) return '';
    if (started && mo < prevM) curY++;
    started = true; prevM = mo;
    return `${curY}-${String(mo).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  };
}

const B_OPENING = /opening balance\s*j?\$?\s*([\d,]+\.\d{2})/i;
const B_CLOSING = /closing balance\s*j?\$?\s*([\d,]+\.\d{2})/i;
// A transaction row: leading DDMON, a J$ amount, then OPTIONALLY a +/- sign,
// then OPTIONALLY the printed running balance or a "#Error" token. The sign and
// balance are both optional because the real Scotiabank layout prints a sign
// only on credits and a running balance only on the last row of a day-cluster;
// a signless mid-cluster debit is still a real transaction. A match is only
// accepted as a row when it carries a sign, a balance, or an error marker (see
// parse), so a stray amount line is never mistaken for a transaction.
// The currency marker before an amount is now OPTIONAL "j" then "$", so a USD
// savings statement (which prints "$ 22.36 +", no "J") matches the same way a
// JMD one ("J$ 1,000.00 +") does. The account's currency is read separately
// from the banner (bankStatementCurrency) and carried on every record, so a USD
// figure is always formatted and totalled as USD - never mixed into JMD.
const B_ROW = /^(\d{1,2})([A-Za-z]{3})\b.*?j?\$\s*([\d,]+\.\d{2})(?:\s*([+\-]))?(?:\s*j?\$\s*([\d,]+\.\d{2})|\s*(#?error))?/i;
const B_MONEY = (s) => parseFloat(String(s).replace(/,/g, ''));

// The currency of a bank statement, read from its account-type banner. Scotia
// prints "SAVINGS ACCOUNT - USD" (and the summary line "1234 - SAVINGS
// ACCOUNT - USD - USD") on the USD account; JMD statements print "- JMD". pdf.js
// sometimes splits the banner ("US D"), so both the spaced and unspaced forms
// are matched. Defaults to JMD - the base currency - when no USD marker is seen,
// so every existing JMD statement is unaffected.
export function bankStatementCurrency(lines) {
  // Confirmed via console logging against the real pdf.js extraction: the
  // previous regex required NO hyphen between the account number and the
  // currency code, so it could never match an account whose own type
  // wording contains a hyphen. Because it silently failed to match those accounts' own
  // genuine lines, it kept scanning the rest of the segment and matched a
  // DIFFERENT, unrelated account's line instead wherever one happened to
  // bleed in
  //
  // The fix ties the match to THIS segment's own account number (from
  // bankAccountNumber, already proven reliable throughout this debugging -
  // only currency was ever wrong, never the account) and simply takes
  // whichever currency code appears next on that SAME line, regardless of
  // how many words or hyphens sit in between. This is immune to both
  // problems at once: it never needs to know every possible account-type
  // wording, and it can never match a different account's line, since a
  // bled-over line for another account will never contain THIS account's
  // own digit sequence.
  const arr = Array.isArray(lines) ? lines : [String(lines || '')];
  const acct = bankAccountNumber(arr);
  if (acct) {
    const re = new RegExp('\\b' + acct + '\\b[^\\n]*?\\b(JMD|USD)\\b', 'i');
    for (const l of arr) {
      const m = re.exec(l);
      if (m) return m[1].toUpperCase();
    }
  }
  // Fallback for a statement whose own account number could not be read at
  // all: the banner-scan, scoped to before this segment's own ledger header.
  let bannerEnd = arr.length;
  for (let i = 0; i < arr.length; i++) {
    if (/withdrawals\s*(?:&|and)\s*deposits/i.test(arr[i])) { bannerEnd = i; break; }
  }
  const text = arr.slice(0, bannerEnd).join(' ').toUpperCase();
  if (/-\s*USD\b|\bUSD\s*-\s*USD\b|ACCOUNT\s*-\s*US\s?D\b|\bUS\s?D\b\s*RECORD/.test(text)) return 'USD';
  if (/\bUSD\b/.test(text) && !/\bJMD\b/.test(text)) return 'USD';
  return 'JMD';
}


// A line that is statement furniture (headers, footers, summary, bare account
// numbers) rather than a transaction's counterparty detail.
export function isBankNoise(line) {
  const t = String(line || '').trim();
  if (!t) return true;
  // Opening/closing balance lines are statement furniture, not a counterparty:
  // skipping them here stops "CLOSING BALANCE J$ ..." leaking into a
  // transaction's description (seen on WITHHOLDING TAX / GCT rows in the export).
  if (/opening balance|closing balance/i.test(t)) return true;
  // The account-type banner repeats on every page ("DAY-TO-DAY ACCOUNT",
  // "SAVINGS ACCOUNT - DIGITAL") and, once pdf.js has wrapped it, in spaced
  // fragment forms ("DA YTODA Y AC CO UN T", "SAV ING S AC CO UN T - DIG ITA L").
  // A page-break fragment can otherwise land next to a counterparty; skipping
  // these lines keeps the header out of the description.
  if (/day\s*-?\s*to\s*-?\s*day|savings account|digital|da\s?ytoda|sav\s?ing\s?s|dig\s?ita/i.test(t)) return true;
  if (/scotiabank|www\.|1-888|trademark|page\s+\d|account summary|transactions\s*\(|transaction date|service charge|transactional fee|record keeping|interest rate|gct rate|total charges|enclosures|help us protect|customer profile/i.test(t)) return true;
  if (/^[\d\s]{4,}$/.test(t)) return true; // bare account-number runs incl. spaced "4 2 0 9 0 8"
  return false;
}

// Tidy a counterparty for display and export (presentation only). Strips the
// "Transfer to/from" lead-in, and — critically — a stray account-type header
// fragment that pdf.js glued to the front at a page break (the "DIG Transfer
// to…", "UN …", "L …", "T …" rows visible in the exported CSV). The fragment
// set is limited to the known banner tokens so real words are never eaten.
const HDR_FRAG = /^(?:dig|ita|sav|ing|day|da|ac|co|un|l|t|s)\s+(?=(?:transfer|trf|\*bns|\*|fcib|interactive|\d))/i;

// Bank descriptor cleanup rules: Counterparty format (an ABM terminal marker, a processing-date
// suffix, a country code, a known PDF-wrap split) - never application logic,
// never a category decision. These now live in config.json's
// bankDescriptorCleanup.rules and are handed in once at boot via
// setBankDescriptorCleanupRules(), so adding a new pattern is a config edit,
// not a code change. The defaults below mirror the patterns confirmed against
// the real export, kept only so the app still works correctly before
// config.json loads or if that section is ever omitted. The SWIFT/BIC strip is
// the general ISO 9362 8/11-char shape bounded to the correspondent countries
// that route these wires (not one hardcoded country), and the trailing-
// reference strip removes any opaque alphanumeric trace token that carries a
// digit (not only digit-led ones); both keep a plain trailing place word or
// surname intact.
let _bankCleanupRules = [
  { pattern: /^\*(?:bns\s+)?/i, replacement: '' },
  { pattern: /\s+for\s+\d{1,2}[A-Za-z]{3}\d{2}\s*$/i, replacement: '' },
  { pattern: /\s+jm\s*$/i, replacement: '' },
  { pattern: /\bf\s+inan\.?\s+centre\b/i, replacement: 'Financial Centre' },
  { pattern: /,\s*[A-Z]{4}(?:JM|US|GB|CA|DE|FR|CH|NL|LU|IE|BE|HK|SG|BB|TT|KY|BS)[A-Z0-9]{2}(?:[A-Z0-9]{3})?(?=\s*,|\s*$)/, replacement: '' },
  { pattern: /(?:\s*,\s*(?=[A-Z0-9]*\d)[A-Z0-9]{8,})+\s*$/, replacement: '' },
];

// Called once at boot (app.js's start(), right after config.json loads) with
// state.cfg.bankDescriptorCleanup.rules. Silently keeps the built-in defaults
// above if the config section is missing, empty, or every pattern in it fails
// to compile - a malformed config entry must never crash the app or leave
// descriptor cleanup silently disabled.
export function setBankDescriptorCleanupRules(rules) {
  if (!Array.isArray(rules) || !rules.length) return;
  const compiled = [];
  for (const r of rules) {
    if (!r || !r.pattern) continue;
    try { compiled.push({ pattern: new RegExp(r.pattern, r.flags || 'i'), replacement: r.replacement || '' }); }
    catch { /* skip an unparsable pattern rather than crash the app */ }
  }
  if (compiled.length) _bankCleanupRules = compiled;
}

export function cleanBankCounterparty(desc) {
  let s = String(desc || '').trim();
  let prev;
  do { prev = s; s = s.replace(HDR_FRAG, ''); } while (s !== prev); // peel repeated fragments
  for (const rule of _bankCleanupRules) s = s.replace(rule.pattern, rule.replacement);
  return s.trim();
}

// Parse an extracted bank statement into records. Pure and testable with no PDF
// engine, exactly like parseStatementLines for cards.
// Split an extracted file into one segment per statement. A downloaded PDF can
// hold many statement periods, out of chronological order, each with its own
// OPENING/CLOSING balance, period and Account Summary (the real consolidated upload carries several
// carries six). Each statement begins at an "OPENING BALANCE" line; a segment
// runs from just after the previous statement's CLOSING BALANCE up to the line
// before the next OPENING. This lets every statement reconcile on its own
// running balance instead of one meaningless chain stitched across shuffled
// periods - the root cause of the balance breaks in the exported ledger.
export function splitBankStatements(lines) {
  const clean = (lines || []).map((l) => String(l).replace(/\s+/g, ' ').trim());
  const openings = [];
  for (let i = 0; i < clean.length; i++) if (/opening balance\s*j?\$?\s*[\d,]+\.\d{2}/i.test(clean[i])) openings.push(i);
  if (openings.length <= 1) return [clean];
  const segments = [];
  for (let s = 0; s < openings.length; s++) {
    let start;
    if (s === 0) start = 0;
    else {
      let cut = -1;
      for (let j = openings[s] - 1; j > openings[s - 1]; j--) {
        if (/closing balance/i.test(clean[j])) { cut = j; break; }
      }
      start = cut >= 0 ? cut + 1 : Math.max(openings[s - 1] + 1, openings[s] - 6);
    }
    const end = (s === openings.length - 1) ? clean.length : openings[s + 1];
    segments.push(clean.slice(start, end)); 
  }
  return segments;
}

// Parse ONE statement's lines into records. Pure.
export function parseOneBankStatement(clean, sourceFile, seqStart) {
  const out = {
    source_file: sourceFile, account: '', period: '', periodRange: null,
    openingBalance: null, closingBalance: null, transactions: [], warnings: [],
  };
  const range = bankStatementPeriod(clean);
  out.periodRange = range;
  out.account = bankAccountNumber(clean);
  out.currency = bankStatementCurrency(clean);   // 'JMD' (base) or 'USD'
  if (range) out.period = `${String(range.startD).padStart(2,'0')} ${BMONTH_ABBR[range.startM-1].replace(/^./, (c)=>c.toUpperCase())} ${range.startY} - ${String(range.endD).padStart(2,'0')} ${BMONTH_ABBR[range.endM-1].replace(/^./, (c)=>c.toUpperCase())} ${range.endY}`;
  const resolve = makeBankDateResolver(range);
  for (const l of clean) {
    const om = B_OPENING.exec(l); if (om && out.openingBalance == null) out.openingBalance = B_MONEY(om[1]);
    const cm = B_CLOSING.exec(l); if (cm && out.closingBalance == null) out.closingBalance = B_MONEY(cm[1]);
  }
  // Running prior balance, seeded from THIS statement's opening (never carried
  // across statements), so a signless row's direction is inferred against the
  // right context.
  let priorBal = out.openingBalance;
  let seq = seqStart;   // global, file order - used only for stable export sort
  let sseq = 0;         // per-statement index - identity tiebreaker for genuine
                        // same-day, same-amount, balance-less duplicates (e.g. two
                        // identical GCT rows). Stable per statement regardless of
                        // which file the statement arrives in, so re-import and
                        // combined-vs-individual imports still dedupe correctly.
  for (let i = 0; i < clean.length; i++) {
    const l = clean[i];
    if (/opening balance|closing balance/i.test(l)) continue;
    const m = B_ROW.exec(l);
    if (!m) continue;
    const sign = m[4] || '';
    const balanceAfter = m[5] ? B_MONEY(m[5]) : null; // null when not printed / #Error
    // NOTE: a signless row with no printed balance is a REAL debit in this
    // layout (only credits print '+', and only the last row of a day-cluster
    // prints '- <balance>'). The B_ROW anchor already requires a leading DDMON
    // date + "J$ amount", so a stray fragment cannot reach here; we therefore
    // accept every anchored row. An earlier guard that skipped signless,
    // balance-less rows silently dropped ~45% of withdrawals on multi-row days.
    const day = +m[1], mon = m[2];
    const amount = B_MONEY(m[3]);
    let direction;
    if (sign === '+') direction = 'in';
    else if (sign === '-') direction = 'out';
    else if (balanceAfter != null && priorBal != null) {
      direction = (balanceAfter - priorBal) > 0.005 ? 'in' : 'out';
    } else direction = 'out';
    let desc = '';
    for (let j = i + 1; j < clean.length && j < i + 3; j++) {
      if (B_ROW.test(clean[j])) break;
      if (!isBankNoise(clean[j])) { desc = clean[j]; break; }
    }
    const typeMatch = /^\d{1,2}[A-Za-z]{3}\s+(.*?)\s+j?\$/i.exec(l);
    out.transactions.push({
      date: resolve(day, mon), rawDate: `${day}${mon.toUpperCase()}`, seq: seq++, sseq: sseq++,
      type: typeMatch ? typeMatch[1].trim() : '', description: cleanBankCounterparty(desc),
      direction, amount: roundMoney(amount),
      signedAmount: roundMoney(direction === 'in' ? amount : -amount),
      balanceAfter: balanceAfter == null ? null : roundMoney(balanceAfter),
      account: out.account, currency: out.currency, source_file: sourceFile,
    });
    if (balanceAfter != null) priorBal = balanceAfter;
  }
  return out;
}

// Parse an extracted bank statement file. Splits a multi-statement file into
// per-statement segments, parses each on its own, and returns the combined
// transactions plus a `statements` array (one per statement, each with its own
// opening/closing/period/account) so every statement can be reconciled on its
// own chain. A `seq` is stamped in file order to keep a stable export order.
// Single-statement files behave exactly as before.
export function parseBankStatementLines(lines, sourceFile) {
  const out = {
    source_file: sourceFile, account: '', period: '', periodRange: null,
    openingBalance: null, closingBalance: null, transactions: [], statements: [], warnings: [],
  };
  if (!lines || !lines.some((l) => l && l.trim())) {
    out.warnings.push('No text could be read from this statement.');
    return out;
  }
  const segments = splitBankStatements(lines);
  let seq = 0;
  for (const seg of segments) {
    if (!seg.some((l) => /opening balance/i.test(l))) continue;
    const one = parseOneBankStatement(seg, sourceFile, seq);
    seq += one.transactions.length;
    out.statements.push(one);
    out.transactions.push(...one.transactions);
  }
  if (out.statements.length) {
    out.openingBalance = out.statements[0].openingBalance;
    out.closingBalance = out.statements[out.statements.length - 1].closingBalance;
    out.account = out.statements[0].account;
    out.currency = out.statements[0].currency;
    out.period = out.statements.length === 1 ? out.statements[0].period
      : `${out.statements[0].period} (+${out.statements.length - 1} more)`;
    out.periodRange = out.statements[0].periodRange;
  }
  return out;
}

// Reconcile ONE statement against its running balance and (optionally) its
// printed Account Summary.
export function reconcileOne(parsed, printedSummary = null) {
  const res = { ok: false, checkedBalances: 0, balanceBreaks: [],
    computedIn: 0, computedOut: 0, nIn: 0, nOut: 0, computedClosing: null,
    closingOk: false, totalsOk: null };
  if (parsed.openingBalance == null) { res.balanceBreaks.push('No opening balance found.'); return res; }
  let running = parsed.openingBalance;
  for (const t of parsed.transactions) {
    running = roundMoney(running + t.signedAmount);
    if (t.direction === 'in') { res.computedIn = roundMoney(res.computedIn + t.amount); res.nIn++; }
    else { res.computedOut = roundMoney(res.computedOut + t.amount); res.nOut++; }
    if (t.balanceAfter != null) {
      res.checkedBalances++;
      if (Math.abs(running - t.balanceAfter) > 0.01) res.balanceBreaks.push(`Balance break at ${t.rawDate}: printed ${t.balanceAfter.toFixed(2)}, computed ${running.toFixed(2)}`);
    }
  }
  res.computedClosing = roundMoney(running);
  if (parsed.closingBalance != null) res.closingOk = Math.abs(res.computedClosing - parsed.closingBalance) <= 0.01;
  if (printedSummary) {
    const dOk = printedSummary.deposits == null || Math.abs(res.computedIn - printedSummary.deposits) <= 0.01;
    const wOk = printedSummary.withdrawals == null || Math.abs(res.computedOut - printedSummary.withdrawals) <= 0.01;
    const ndOk = printedSummary.nDeposits == null || res.nIn === printedSummary.nDeposits;
    const nwOk = printedSummary.nWithdrawals == null || res.nOut === printedSummary.nWithdrawals;
    res.totalsOk = dOk && wOk && ndOk && nwOk;
  }
  res.ok = res.balanceBreaks.length === 0 && (parsed.closingBalance == null || res.closingOk) && (res.totalsOk !== false);
  return res;
}

// Reconcile a parsed file. When it holds several statements, reconcile each on
// its own chain (the only correct way) and aggregate: the file reconciles only
// if every statement does. Falls back to a single-statement reconcile for a
// one-statement parse or a bare {openingBalance, transactions} object, so
// existing callers and tests are unaffected.
export function reconcileBankStatement(parsed, printedSummary = null) {
  if (parsed && Array.isArray(parsed.statements) && parsed.statements.length) {
    const agg = { ok: true, checkedBalances: 0, balanceBreaks: [], computedIn: 0, computedOut: 0,
      nIn: 0, nOut: 0, computedClosing: null, closingOk: true, totalsOk: null, perStatement: [] };
    for (const st of parsed.statements) {
      const r = reconcileOne(st, null);
      agg.perStatement.push({ period: st.period, account: st.account, ok: r.ok,
        closingBalance: st.closingBalance, balanceBreaks: r.balanceBreaks });
      agg.checkedBalances += r.checkedBalances;
      agg.computedIn = roundMoney(agg.computedIn + r.computedIn);
      agg.computedOut = roundMoney(agg.computedOut + r.computedOut);
      agg.nIn += r.nIn; agg.nOut += r.nOut;
      if (r.balanceBreaks.length) agg.balanceBreaks.push(...r.balanceBreaks);
      if (!r.ok) agg.ok = false;
      if (!r.closingOk) agg.closingOk = false;
    }
    if (printedSummary) {
      const dOk = printedSummary.deposits == null || Math.abs(agg.computedIn - printedSummary.deposits) <= 0.01;
      const wOk = printedSummary.withdrawals == null || Math.abs(agg.computedOut - printedSummary.withdrawals) <= 0.01;
      const ndOk = printedSummary.nDeposits == null || agg.nIn === printedSummary.nDeposits;
      const nwOk = printedSummary.nWithdrawals == null || agg.nOut === printedSummary.nWithdrawals;
      agg.totalsOk = dOk && wOk && ndOk && nwOk;
      if (agg.totalsOk === false) agg.ok = false;
    }
    return agg;
  }
  return reconcileOne(parsed, printedSummary);
}

// Bank identity (D10): no reference number exists on these rows, so the
// running balance stands in for it beside date, signed amount and description.
export function bankTransactionIdentity(t) {
  const normDesc = String(t.description || '').replace(/\s+/g, ' ').trim().toUpperCase();
  const amt = roundMoney(Number(t.signedAmount) || 0).toFixed(2);
  const bal = t.balanceAfter == null ? '' : roundMoney(t.balanceAfter).toFixed(2);
  // The per-statement index only matters when nothing else separates two rows
  // (same account, date, signed amount, description, and no printed balance):
  // it keeps genuine same-day duplicates distinct without breaking dedupe of a
  // statement re-imported in another file (the index is stable per statement).
  const idx = t.sseq == null ? '' : String(t.sseq);
  return fnv1a([t.account || '', t.date, amt, bal, normDesc, idx].join('|'));
}

// A stable, content-based hash for ONE statement, built from its own
// transaction identities (which reset their per-statement index each statement).
// The SAME statement produces the SAME hash whether it arrives inside a
// consolidated multi-statement PDF or as an individual file, so the imported-
// statements record dedupes correctly across the two upload styles - the file
// this app is actually given both ways. Used only for the traceability record;
// transaction dedupe is handled separately by mergeBankTransactions.
export function bankStatementHash(st) {
  const ids = (st.transactions || []).map((t) => bankTransactionIdentity(t)).join(',');
  return fnv1a([st.account || '', st.period || '', st.openingBalance, st.closingBalance, ids].join('|'));
}

// Idempotent merge with implicit period-dedupe (D10): overlapping monthly and
// quarterly statements collapse only where identity (which includes the running
// balance) matches, so genuine same-amount pairs are kept and true duplicates
// are dropped. Re-importing a statement adds nothing.
export function mergeBankTransactions(existing, incoming) {
  const byId = new Map();
  for (const r of existing) byId.set(r.id || bankTransactionIdentity(r), { ...r, id: r.id || bankTransactionIdentity(r) });
  let added = 0, alreadyPresent = 0;
  for (const raw of incoming) {
    const rec = { ...raw, id: raw.id || bankTransactionIdentity(raw) };
    if (byId.has(rec.id)) { alreadyPresent++; continue; }
    byId.set(rec.id, rec); added++;
  }
  return { records: [...byId.values()], added, alreadyPresent };
}

// Trailing account digits a counterparty points at: "…Doe 1234" -> "1234",
// "Transfer to 1234" -> "1234". A named external person with no account tail
// yields "". Kept for back-compat; classification below uses the stronger
// any-position scan.
export function counterpartyDigits(desc) {
  const m = String(desc || '').match(/(\d{3,})\s*$/);
  return m ? m[1] : '';
}

// Account-number tokens a counterparty could be pointing at. For every 3+ digit
// group it yields the full number AND its last 4 and last 5 digits, because the
// SAME own account is printed several ways across the real statements
export function counterpartyAccountTokens(desc) {
  const groups = String(desc || '').match(/\d{3,}/g) || [];
  const tokens = new Set();
  for (const g of groups) {
    tokens.add(g);
    if (g.length >= 4) tokens.add(g.slice(-4));
    if (g.length >= 5) tokens.add(g.slice(-5));
  }
  return tokens;
}

// Build a token -> canonical-id index for the user's own accounts (imported bank
// accounts, imported credit card, and the user-kept "my accounts" list). Each
// account contributes its full number and its last-4 / last-5 tails, all mapped
// to one canonical short id (the last 4 digits), so any spelling of the account
// in a counterparty resolves to the same id. This is what lets a normaliser
export function buildOwnAccountIndex(accounts = []) {
  const idx = new Map();
  for (const a of accounts) {
    const digits = String(a == null ? '' : a).replace(/\D/g, '');
    if (!digits) continue;
    const canonical = digits.slice(-4);
    idx.set(digits, canonical);
    if (digits.length >= 4) idx.set(digits.slice(-4), canonical);
    if (digits.length >= 5) idx.set(digits.slice(-5), canonical);
  }
  return idx;
}

// Normalise a bank counterparty description to a stable canonical identity, so
// the same real counterparty groups as one regardless of how the statement spelt
// it. Returns { key, label, internal, account }:
//   - internal transfers to/from an OWN account (bank or card) collapse to a
//     single key per account ("own:1234"), whatever the spelling;
//   - external counterparties collapse by cleaned name with the trailing account
//     tail dropped ("John Smith 1234" and "John Smith" -> one key),
//     because the person is the counterparty, not the reference number.
// Pure and presentation-safe: it never changes an amount, only how rows are
// grouped and whether a row is flagged internal.
//
// A financial institution (bank, credit union or building society) named in a
// bank-ledger counterparty is often an INCIDENTAL destination reference inside
// a third-party transfer - "Eleanor Wright First Global Bank" is a payment to
// the PERSON, at their bank, not a payment to the bank itself. These three
// helpers let normaliseCounterparty tell that apart from a genuine, direct
// payment to an institution ("First Global Bank ...", "NCB ...", "C&WJ Credit
// Union"). Scoped to institutions by category + sector, so insurers (Sagicor
// Life, category Insurance), payment processors, remittance services,
// brokerages and every other merchant resolve exactly as before - only
// bank/credit-union/building-society names are ever treated as low-priority
// context.
function isFinancialInstitutionMerchant(m) {
  if (!m || m.category !== 'Banking & Transfers') return false;
  return /financial\s*-\s*(bank|credit union|building society)/i.test(String(m.sector || ''));
}
// True when a resolved institution's own name does NOT begin the cleaned
// counterparty - i.e. other name text (the real payee) precedes it, so the
// institution is only a trailing reference. A direct payment to the institution
// (its name at the start) returns false and is kept. A non-institution merchant
// always returns false, so nothing else changes.
function institutionIsIncidental(m, cleaned) {
  if (!isFinancialInstitutionMerchant(m)) return false;
  const hay = String(cleaned || '').toLowerCase();
  for (const a of (m.aliases || [])) {
    try { if (new RegExp('^(?:' + a + ')', 'i').test(hay)) return false; }
    catch { /* skip an unparsable alias, matching resolveMerchant's own guard */ }
  }
  return true;
}
// Remove a trailing institution reference (and anything after it) from a
// counterparty, leaving the genuine payee - "Eleanor Wright First Global Bank"
// -> "Eleanor Wright". Only ever called once the institution is known to be
// incidental (real name text precedes it), and it keeps the original name
// untouched if a strip would leave nothing meaningful behind.
function stripTrailingInstitution(m, cleaned) {
  const base = String(cleaned || '');
  for (const a of (m.aliases || [])) {
    try {
      const stripped = base.replace(new RegExp('\\s+(?:' + a + ')\\b.*$', 'i'), '').trim();
      if (stripped && /[A-Za-z]/.test(stripped) && stripped.length >= 2) return stripped;
    } catch { /* skip an unparsable alias */ }
  }
  return base.trim();
}

export function normaliseCounterparty(description, ownIndex = new Map(), resolver = null) {
  const tokens = counterpartyAccountTokens(description);
  for (const t of tokens) {
    if (ownIndex.has(t)) {
      const id = ownIndex.get(t);
      return { key: 'own:' + id, label: 'Account ' + id, internal: true, account: id };
    }
  }
  // Merchant identity via the ONE shared resolver (bank profile: it applies the
  // config bank-cleanup rules AND the incidental-institution strip internally,
  // so the Sagicor / First Global / JNCBJMKX behaviour is preserved without this
  // file re-implementing any of it). Runs only on external rows (own-account
  // returned above); only ever sets the group key and display label.
  if (resolver) {
    const r = resolver.resolve(description, { profile: 'bank' });
    if (r.merchant && r.incidentalInstitution) {
      return {
        key: r.groupKey ? 'ext:' + r.groupKey : 'ext:unknown',
        label: r.payee ? smartTitle(r.payee, CP_LABEL_SET, CP_LABEL_SET) : 'Unknown',
        internal: false, account: null,
      };
    }
    if (r.merchant) {
      return {
        key: r.groupKey ? 'ext:' + r.groupKey : 'ext:unknown',
        label: r.displayLabel || smartTitle(r.cleaned, CP_LABEL_SET, CP_LABEL_SET),
        internal: false, account: null,
      };
    }
  }
  // Non-merchant fallback: the SAME cleaned-name grouping/label as before, so a
  // counterparty that is not a known merchant reads byte-for-byte as it did.
  const cleaned = cleanBankCounterparty(description)
    .replace(/^(?:[A-Z]{2,5}\s+)?transfer\s+(to|from)\s+/i, '')
    .replace(/^trf\s+(to|from):?\s+/i, '')
    .replace(/^\d{2,}[,\s-]+/, '')
    .replace(/^\d{4,}-/, '')
    .replace(/[\s,-]+\d{3,}\s*$/, '')
    .replace(/[\s,-]+$/, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  const key = cleaned.toUpperCase();
  return {
    key: key ? 'ext:' + key : 'ext:unknown',
    label: cleaned ? smartTitle(cleaned, CP_LABEL_SET, CP_LABEL_SET) : 'Unknown',
    internal: false, account: null,
  };
}

// The credit-card account number, read from an already-extracted card statement
// (e.g. "************1234"). Additive and read-only: it does NOT change card
// parsing, totals, categorisation or identity (D2). It only lets the bank ledger
// learn that money it sends to that card is a credit-card PAYMENT between the
// user's own accounts - a transfer, not external spending - which is the
// documented way to avoid double-counting card purchases against the bank leg.
export function cardAccountsFromLines(lines) {
  const text = (Array.isArray(lines) ? lines.join('\n') : String(lines == null ? '' : lines));
  const out = new Set();
  const re = /\*{2,}\s*(\d{4})\b/g;    // masked card number: "************1234"
  let m; while ((m = re.exec(text))) out.add(m[1]);
  return [...out];
}

// Assisted internal-transfer classification (D9), now built on the counterparty
// normaliser. A row is an internal transfer when its counterparty resolves to
// one of the user's own accounts: any imported bank account (so both legs of a
// sweep are caught), the imported credit card (so bank->card payments are
// transfers, not spending - see cardAccountsFromLines), or an entry in the
// user-kept "my accounts" list (single-legged moves to an unseen own account).
// Each row also carries a stable counterpartyKey/Label for grouping. Only flags;
// never deletes; always reversible in the UI.
export function classifyInternalTransfers(records, myAccounts = [], cardAccounts = [], resolver = null) {
  const ownNumbers = [];
  for (const r of records) if (r.account) ownNumbers.push(String(r.account));
  for (const a of myAccounts) ownNumbers.push(String(a));
  for (const a of cardAccounts) ownNumbers.push(String(a));
  const ownIndex = buildOwnAccountIndex(ownNumbers);
  return records.map((r) => {
    const cpText = (r.description && r.description.trim()) ? r.description : (r.type || r.description);
    const n = normaliseCounterparty(cpText, ownIndex, resolver);
    return { ...r, internalTransfer: n.internal, counterpartyKey: n.key, counterpartyLabel: n.label };
  });
}

// True when a money-in row is a cash / ABM self-deposit rather than genuinely
// received income. On the real statements these read "ABM DEPOSIT" (a deposit
// the person makes at a machine) or a plain "DEPOSIT" cash lodgement. Because
// the depositor is often the account holder moving their own cash - or cash on
// behalf of another holder - such rows must NOT count as income by default
// (they are shown in the list, just not totalled into "money in") until a
// person confirms one as their own income. Deliberately narrow: it only fires
// on the ABM-deposit / cash-deposit markers, never on a normal credit.
export function isCashSelfDeposit(r) {
  // D-audit item 12: keyword matching is the right approach here and is kept. The
  // statement's own printed transaction-type field (ABM DEPOSIT / DEPOSIT / CASH
  // DEPOSIT) is the most reliable available signal for "this is the holder lodging
  // cash", and no better data exists offline - a behavioural cross-check (amount
  // regularity, counterparty) cannot tell the holder's own cash from cash lodged
  // on someone's behalf, which is exactly the ambiguity the confirm/exclude flow
  // already resolves. So this stays a narrow, explainable keyword gate, and the
  // person ratifies each deposit as income or not (Monarch-style confirm step).
  if (!r || r.direction !== 'in') return false;
  const t = String(r.type || '').toUpperCase();
  const d = String(r.description || '').toUpperCase();
  if (/\bABM\s*DEPOSIT\b/.test(t) || /\bABM\s*DEPOSIT\b/.test(d)) return true;
  if (/^DEPOSIT$/.test(t.trim())) return true;                 // plain cash lodgement
  if (/\bCASH\s*DEPOSIT\b/.test(t) || /\bCASH\s*DEPOSIT\b/.test(d)) return true;
  return false;
}

// Apply the three evidence-backed, user-confirmed rules on top of the internal-
// transfer classification, as explicit per-row flags (never deletions):
//   - excludedFromIncome: a cash/ABM self-deposit not confirmed as own income.
//   - roundTrip: BOTH legs of a confirmed matched pair (e.g. a car down-payment
//     and its refund) - netted out of money in AND money out together. Only a
//     pair the person has explicitly marked; no inference, no auto-matching.
//   - household: an outflow from a shared account to a household member (e.g.
//     1234 -> Jane Doe) - shown and tracked on its own line, but
//     excluded from the person's personal "money out".
// opts: { confirmedIncomeIds:Set, roundTripIds:Set (transaction ids that are
// part of a confirmed pair), sharedAccounts:[tails], householdPayees:[names] }.
// Pure; only adds flags.
export function applyLedgerRules(records, opts = {}) {
  const confirmedIncome = opts.confirmedIncomeIds instanceof Set ? opts.confirmedIncomeIds : new Set(opts.confirmedIncomeIds || []);
  const roundTripIds = opts.roundTripIds instanceof Set ? opts.roundTripIds : new Set(opts.roundTripIds || []);
  const sharedTails = new Set((opts.sharedAccounts || []).map((a) => String(a).replace(/\D/g, '').slice(-4)).filter(Boolean));
  const householdPayees = (opts.householdPayees || []).map((s) => String(s).toUpperCase());
  return records.map((r) => {
    const id = r.id != null ? r.id : bankTransactionIdentity(r);
    const cashDeposit = isCashSelfDeposit(r);
    const excludedFromIncome = cashDeposit && !confirmedIncome.has(id);
    const roundTrip = roundTripIds.has(id);
    const acctTail = String(r.account || '').slice(-4);
    const cpUpper = String(r.counterpartyLabel || r.description || '').toUpperCase();
    const household = !r.internalTransfer && r.direction === 'out' && sharedTails.has(acctTail)
      && householdPayees.some((p) => p && cpUpper.includes(p));
    return { ...r, id, cashDeposit, excludedFromIncome, roundTrip, household };
  });
}

// The closing balance for ONE account: its most recent printed running balance,
// by date then by original order (statements are chronological within a file).
export function accountClosingBalance(rows) {
  let closing = null;
  const sorted = rows.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  for (const r of sorted) if (r.balanceAfter != null) closing = r.balanceAfter;
  return closing;
}

// Account-mode totals (§7.4), now MULTI-ACCOUNT AWARE. The pooled figures in the
// screenshots were wrong because two owned accounts (1234 and 1234) were
// summed into one running-balance column and one closing balance: the column
// jumped between accounts and the headline "closing balance" was just whichever
// account happened to hold the latest printed balance. Here each account is
// analysed on its own, the combined closing balance is the SUM of per-account
// closings, and cash in/out exclude every internal transfer (both legs).
export function analyseBankActivity(records, baseCurrency = 'JMD') {
  const byAcct = new Map();
  for (const r of records) {
    const k = r.account || 'unknown';
    if (!byAcct.has(k)) byAcct.set(k, []);
    byAcct.get(k).push(r);
  }
  const accounts = [];        // every account, each carrying its own currency
  const foreignAccounts = []; // the non-base (e.g. USD) accounts, for side-by-side display
  // Combined figures are BASE-CURRENCY ONLY. A USD account is shown on its own
  // (in USD), but a US$ balance is never added to the JMD headline - mixing two
  // currencies in one "money out" or "cash on hand" number would be a lie. This
  // is the whole point of carrying currency on the record.
  // Headline money in / money out exclude, in addition to internal transfers:
  //   - excludedFromIncome (cash/ABM self-deposit, not confirmed as income),
  //   - roundTrip (both legs of a confirmed matched pair), and
  //   - household (support from a shared account to a household member).
  // Each excluded amount is tracked on its own aggregate line so the person can
  // still see it; nothing is deleted, only kept out of the headline totals.
  let cashIn = 0, cashOut = 0, internalIn = 0, internalOut = 0, closingBalance = 0, anyClosing = false;
  let cashDeposits = 0, roundTripIn = 0, roundTripOut = 0, householdSupport = 0;
  for (const [account, rows] of byAcct) {
    const acctCur = (rows.find((r) => r.currency) || {}).currency || baseCurrency;
    let aIn = 0, aOut = 0, iIn = 0, iOut = 0, aCashDep = 0, aRtIn = 0, aRtOut = 0, aHouse = 0;
    for (const r of rows) {
      if (r.internalTransfer) {
        if (r.direction === 'in') iIn = roundMoney(iIn + r.amount); else iOut = roundMoney(iOut + r.amount);
        continue;
      }
      if (r.roundTrip) { // both legs excluded from money in AND money out
        if (r.direction === 'in') aRtIn = roundMoney(aRtIn + r.amount); else aRtOut = roundMoney(aRtOut + r.amount);
        continue;
      }
      if (r.direction === 'in') {
        if (r.excludedFromIncome) { aCashDep = roundMoney(aCashDep + r.amount); continue; } // not income by default
        aIn = roundMoney(aIn + r.amount);
      } else {
        if (r.household) { aHouse = roundMoney(aHouse + r.amount); continue; } // support to household, off the personal headline
        aOut = roundMoney(aOut + r.amount);
      }
    }
    const close = accountClosingBalance(rows);
    const acct = { account, currency: acctCur, n: rows.length, cashIn: aIn, cashOut: aOut,
      internalIn: iIn, internalOut: iOut, closingBalance: close,
      cashDeposits: aCashDep, householdSupport: aHouse,
      months: [...new Set(rows.map((r) => r.date.slice(0, 7)))].sort() };
    accounts.push(acct);
    if (acctCur === baseCurrency) {
      if (close != null) { anyClosing = true; closingBalance = roundMoney(closingBalance + close); }
      cashIn = roundMoney(cashIn + aIn); cashOut = roundMoney(cashOut + aOut);
      internalIn = roundMoney(internalIn + iIn); internalOut = roundMoney(internalOut + iOut);
      cashDeposits = roundMoney(cashDeposits + aCashDep);
      roundTripIn = roundMoney(roundTripIn + aRtIn); roundTripOut = roundMoney(roundTripOut + aRtOut);
      householdSupport = roundMoney(householdSupport + aHouse);
    } else {
      foreignAccounts.push(acct);
    }
  }
  accounts.sort((a, b) => String(a.account).localeCompare(String(b.account)));
  foreignAccounts.sort((a, b) => String(a.account).localeCompare(String(b.account)));
  const baseRecords = records.filter((r) => (r.currency || baseCurrency) === baseCurrency);
  return { n: records.length, baseCurrency, accounts, foreignAccounts,
    cashIn, cashOut, net: roundMoney(cashIn - cashOut),
    internalIn, internalOut, closingBalance: anyClosing ? closingBalance : null,
    cashDeposits, roundTripIn, roundTripOut, householdSupport,
    months: [...new Set(baseRecords.map((r) => r.date.slice(0, 7)))].sort() };
}

/* ===========================================================================
 *  PHASE 2: cash flow, counterparties, and the combined overview
 *  ---------------------------------------------------------------------------
 *  Pure, testable functions beside their Phase-1 equivalents (D13: inline, no
 *  new module). They power the Accounts sub-view's deeper analysis and the new
 *  Overview tab. Every one excludes internal transfers from spend and income,
 *  which the classifier already flags - the §6.3 assumption the PRD requires
 *  proven before the overview is built. All amounts come straight from the
 *  reconciled records; nothing here re-parses or re-totals a statement.
 *  ======================================================================== */

// Group classified bank rows by their normalised counterparty. Internal
// transfers collapse to one "own account" group per account (own:XXXX); every
// external counterparty collapses by cleaned name (ext:NAME), so the three
// "1234" spellings, or "John Smith 1234" and "John Smith", read as
// one line. Returns rows sorted by absolute net movement, each carrying money
// in, money out, net, count and whether it is internal. Presentation-safe:
// it only groups and sums the signed amounts already on the records.
export function bankCounterpartyGroups(records, baseCurrency = 'JMD') {
  const byKey = new Map();
  for (const r of records) {
    // Base-currency only. A future USD external outflow must never blend into a
    // JMD counterparty total (the amounts are not comparable). USD accounts are
    // surfaced separately by analyseBankActivity.foreignAccounts.
    if ((r.currency || baseCurrency) !== baseCurrency) continue;
    const key = r.counterpartyKey || ('ext:' + String(r.description || 'unknown').toUpperCase());
    if (!byKey.has(key)) byKey.set(key, {
      key, label: r.counterpartyLabel || r.description || key, internal: !!r.internalTransfer,
      moneyIn: 0, moneyOut: 0, count: 0, accounts: new Set(),
    });
    const g = byKey.get(key);
    if (r.direction === 'in') g.moneyIn = roundMoney(g.moneyIn + r.amount);
    else g.moneyOut = roundMoney(g.moneyOut + r.amount);
    g.count++; if (r.account) g.accounts.add(r.account);
  }
  return [...byKey.values()].map((g) => ({
    key: g.key, label: g.label, internal: g.internal,
    moneyIn: g.moneyIn, moneyOut: g.moneyOut, net: roundMoney(g.moneyIn - g.moneyOut),
    count: g.count, accounts: [...g.accounts].sort(),
  })).sort((a, b) => Math.abs(b.net) - Math.abs(a.net));
}

// A single MOVEMENT KIND for one classified bank row - the bank-native answer
// to "what was this money doing", never the card spending taxonomy. Precedence,
// highest first: an own-account move (internalTransfer) or a confirmed
// round-trip is 'internal'; a cash/ABM self-deposit kept out of income is
// 'cash-deposit'; shared-account support to a household member is 'household';
// a resolved merchant's category is coarsened to a kind via cfg.categoryToKind;
// otherwise the statement's own printed TYPE is matched against cfg.typeRules
// (plain uppercase substrings, in order, no regex); the last resort is direction
// alone (in -> income, out -> payment). Pure; reads only fields already on the
// row plus the shared resolver and the config table, and never touches an
// amount, a sign or a flag. Card payments deliberately fold into 'internal'
// alongside own-account sweeps, matching how the headline already excludes both.
export function bankMovementKind(r, resolver = null, cfg = {}) {
  if (!r) return 'other';
  if (r.internalTransfer || r.roundTrip) return 'internal';
  if (r.excludedFromIncome) return 'cash-deposit';
  if (r.household) return 'household';
  const catToKind = cfg.categoryToKind || {};
  if (resolver) {
    const m = resolver.resolve(r.description || '', { profile: 'bank' });
    if (m && m.category && catToKind[m.category]) return catToKind[m.category];
  }
  const type = String(r.type || '').toUpperCase();
  for (const rule of (cfg.typeRules || [])) {
    const token = String((rule && rule.match) || '').toUpperCase();
    if (token && type.includes(token)) return rule.kind;
  }
  return r.direction === 'in' ? 'income' : 'payment';
}

// Aggregate classified bank rows into MOVEMENT-KIND totals, over base-currency
// rows only, using the SAME classified-and-ruled records the headline reads, so
// internal transfers, confirmed round-trips, unconfirmed cash deposits and
// shared-account household support each collapse into their own kind and never
// leak into the income/spend kinds - the breakdown reconciles with the hero
// figures instead of contradicting them. Returns one entry per kind that occurs,
// each { kind, moneyIn, moneyOut, count, total }, largest total movement first.
// Pure; the caller decides which kinds to show and how to label/colour them.
export function bankKindBreakdown(records, resolver = null, cfg = {}, baseCurrency = 'JMD') {
  const byKind = new Map();
  for (const r of (records || [])) {
    if ((r.currency || baseCurrency) !== baseCurrency) continue;
    const kind = bankMovementKind(r, resolver, cfg);
    if (!byKind.has(kind)) byKind.set(kind, { kind, moneyIn: 0, moneyOut: 0, count: 0 });
    const g = byKind.get(kind);
    if (r.direction === 'in') g.moneyIn = roundMoney(g.moneyIn + r.amount);
    else g.moneyOut = roundMoney(g.moneyOut + r.amount);
    g.count++;
  }
  return [...byKind.values()]
    .map((g) => ({ ...g, total: roundMoney(g.moneyIn + g.moneyOut) }))
    .sort((a, b) => b.total - a.total);
}

// The real external-payment shortlist (PRD §6.2/§7.4): the genuine money-out
// counterparties, internal transfers removed, largest first. This is the
// handful of payments that actually left the user's pocket - salary aside,
// most of these accounts' activity is the user moving their own funds, so this
// shortlist is the signal the bank view is built to surface.
export function externalOutflowShortlist(records, limit = 10, baseCurrency = 'JMD') {
  const groups = bankCounterpartyGroups(records, baseCurrency)
    .filter((g) => !g.internal && g.moneyOut > 0)
    .sort((a, b) => b.moneyOut - a.moneyOut);
  return (limit > 0 ? groups.slice(0, limit) : groups)
    .map((g) => ({ key: g.key, label: g.label, moneyOut: g.moneyOut, count: g.count, accounts: g.accounts }));
}

// Money in and money out per calendar month, EXTERNAL only (internal transfers
// excluded both legs), plus the account closing balance carried into each
// month. Drives the Accounts cash-flow-over-time chart and feeds the overview
// trend. Returns one row per month present in the data, oldest first.
export function bankFlowOverTime(records, baseCurrency = 'JMD') {
  const byMonth = new Map();
  for (const r of records) {
    if ((r.currency || baseCurrency) !== baseCurrency) continue; // never mix USD into JMD bars
    const m = (r.date || '').slice(0, 7); if (!m) continue;
    if (!byMonth.has(m)) byMonth.set(m, { month: m, moneyIn: 0, moneyOut: 0, internalIn: 0, internalOut: 0 });
    const row = byMonth.get(m);
    // Keep the trend in step with the headline: internal transfers, both legs
    // of a confirmed round-trip, cash/ABM self-deposits and shared-account
    // household support are all kept out of money in / money out.
    if (r.internalTransfer || r.roundTrip) {
      if (r.direction === 'in') row.internalIn = roundMoney(row.internalIn + r.amount);
      else row.internalOut = roundMoney(row.internalOut + r.amount);
    } else if (r.direction === 'in') {
      if (r.excludedFromIncome) continue;
      row.moneyIn = roundMoney(row.moneyIn + r.amount);
    } else {
      if (r.household) continue;
      row.moneyOut = roundMoney(row.moneyOut + r.amount);
    }
  }
  return [...byMonth.values()].sort((a, b) => (a.month < b.month ? -1 : 1))
    .map((r) => ({ ...r, net: roundMoney(r.moneyIn - r.moneyOut) }));
}

// Standing debits in the bank ledger (PRD §9 Phase 2: recurring reused for
// bank). An external money-out counterparty seen paying a similar amount in 3+
// distinct months - e.g. the monthly SAGICOR life debit, the C&WJ credit union
// bill. Reuses the same 3-months / similar-amount shape as the card recurring
// detector. Returns [{ label, months, typical }], largest typical first.
// The longest run of empty months between two consecutive occurrence-months in a
// set of 'YYYY-MM' keys. e.g. Feb..Jun then Dec (a five-month hole) returns 6.
// Local copy of the reporting.js cadence helper (importing it would make bank
// analysis depend on reporting, which already depends on this module).
// Standing debits in the bank ledger (PRD §9 Phase 2: recurring reused for
// bank). An external money-out counterparty seen paying a similar amount in 3+
// distinct months - e.g. the monthly SAGICOR life debit, the C&WJ credit union
// bill. Reuses the same 3-months / similar-amount shape as the card recurring
// detector. Returns [{ label, months, typical }], largest typical first.
// The longest run of empty months between two consecutive occurrence-months in a
// set of 'YYYY-MM' keys. e.g. Feb..Jun then Dec (a five-month hole) returns 6.
// Local copy of the reporting.js cadence helper (importing it would make bank
// analysis depend on reporting, which already depends on this module).
// Its month-key-to-index arithmetic now delegates to the shared monthIndex
// (shared-helpers.js) - previously reimplemented here privately, byte-for-
// byte identical to a second private copy inside reporting.js's own
// (former) recurringMonthIndex, used by its card-side twin maxConsecutiveGap.
function standingDebitMonthGap(monthKeys) {
  const idx = monthKeys
    .map(monthIndex)
    .filter((n) => !Number.isNaN(n)).sort((a, b) => a - b);
  let mx = 0;
  for (let i = 1; i < idx.length; i++) mx = Math.max(mx, idx[i] - idx[i - 1]);
  return mx;
}
export function detectBankStandingDebits(records, minMonths = 3, tolerance = 0.15, baseCurrency = 'JMD', maxGapMonths = 2) {
  const byKey = new Map();
  // Ledger-recency anchor for the forward lapsed check below: the most recent
  // month the WHOLE record set reaches, computed over EVERY record passed in -
  // before the currency/internal/direction filters below - not just the
  // external outflow rows any one payee is grouped from. Mirrors the same
  // "how current is this ledger" concept buildStatementCoverage/
  // detectIncompleteMonth already anchor on elsewhere, never real calendar
  // "today", so a payee is never wrongly flagged lapsed just because the
  // calendar moved on without a new statement being imported.
  let latestMonth = '';
  for (const r of records) { const m = (r.date || '').slice(0, 7); if (m > latestMonth) latestMonth = m; }
  for (const r of records) {
    if ((r.currency || baseCurrency) !== baseCurrency) continue; // base-currency only
    if (r.internalTransfer || r.direction !== 'out') continue;
    const key = r.counterpartyKey || ('ext:' + String(r.description || '').toUpperCase());
    if (!byKey.has(key)) byKey.set(key, { key, label: r.counterpartyLabel || r.description || key, byMonth: new Map() });
    const g = byKey.get(key); const m = (r.date || '').slice(0, 7);
    g.byMonth.set(m, roundMoney((g.byMonth.get(m) || 0) + r.amount));
  }
  const out = [];
  for (const g of byKey.values()) {
    const amounts = [...g.byMonth.values()]; if (amounts.length < minMonths) continue;
    // Cadence gate (D-audit item 2): a genuine standing debit recurs at a steady
    // monthly rhythm, so reject any payee whose longest gap between consecutive
    // occurrence-months exceeds maxGapMonths (default 2). This is the SAME gate
    // detectRecurring already applies on the card side; without it an irregular
    // repeat - e.g. the GCT/GOVT TAX that posts only when an ABM withdrawal
    // happens (Feb..Jun, then a jump to Dec: a six-month hole) - was wrongly
    // read as a monthly commitment and even leaked into the combined
    // monthly-commitments total. Verified against the real accounts export.
    if (standingDebitMonthGap([...g.byMonth.keys()]) > maxGapMonths) continue;
    const sorted = amounts.slice().sort((a, b) => a - b);
    const typical = sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
    if (typical <= 0) continue;
    const consistent = amounts.filter((a) => Math.abs(a - typical) <= typical * tolerance).length;
    if (consistent >= minMonths) {
      // The forward half of the SAME cadence gate above, applied
      // prospectively: a standing debit that recurred consistently in the
      // past is only still ACTIVE if its own last occurrence is within
      // maxGapMonths of the ledger's newest month; otherwise it has LAPSED.
      // lastMonth is carried on the returned item (previously only a bare
      // count was returned) so a caller can show exactly when it was last
      // paid, never just silently omit it.
      const lastMonth = [...g.byMonth.keys()].sort().pop();
      out.push({
        key: g.key, label: g.label, months: g.byMonth.size, typical: roundMoney(typical),
        lastMonth, status: recurringStatus(lastMonth, latestMonth, maxGapMonths),
      });
    }
  }
  return out.sort((a, b) => b.typical - a.typical);
}

/* ===========================================================================
 *  Bank-appropriate insights (Round: replacing the reverted hero-pill with a
 *  genuine "What's new or unusual" list for Overview/Accounts). Two pure
 *  detectors beside detectBankStandingDebits above, mirroring the shape and
 *  method of their card-side twins in reporting.js (attentionItems,
 *  detectPeriodNewMerchants) but adapted to what bank/cash-flow data actually
 *  supports - see each function's own note for the adaptation and why.
 *  ======================================================================== */

// Large/unusual external payment - the bank twin of attentionItems' card-side
// "large charge" flag, reusing the SAME median + MAD / modified-z-score
// method (Iglewicz & Hoaglin) and the SAME two guards: a robust z-score over
// cfg.insights.largeChargeZ, OR - when every peer is identical so MAD is 0 -
// at least cfg.insights.largeChargeMultiple times the peer median, plus the
// same flat floor cfg.insights.largeChargeMin. All three thresholds and the
// peer-count gate (largeChargeMinPeers) are read from the SAME config block
// attentionItems reads, so "what counts as unusual" is one config-driven
// concept for card charges and bank payments alike, not two.
//
// The one deliberate adaptation: a card merchant is charged repeatedly, so
// its OWN past charges are a meaningful "usual" baseline (attentionItems
// groups peers by merchant). A bank payee is very often paid once, or a
// handful of times at genuinely different amounts (a car-import deposit, a
// one-off contractor payment) - there is rarely a stable per-payee "usual" to
// compare against, and a same-payee-only comparison can never flag a
// genuine one-off (no peers of its own to be unusual against - confirmed on
// the real data: a single a single large one-off transfer with no same-payee peers has zero
// same-payee peers, and several identical large transfers to one recipiente-payee peers are
// each identical to the others, so neither the peer-count gate nor the
// multiple-of-median guard could ever fire on a same-payee comparison alone).
// The peer population here is therefore every OTHER genuine external outflow
// in the record set passed in (every payee pooled together) - the standard
// "how does this compare to a typical outflow" reading, and the one that
// actually catches both cases. Genuinely external only: internal transfers,
// confirmed round-trips and household support are already excluded upstream
// by classifyInternalTransfers/applyLedgerRules, so none of those can ever be
// flagged here. Base-currency only, matching every other bank aggregate.
// Returns [{ id, key, label, amount, date, z }], most unusual first. Pure -
// the caller decides what record set to pass (whole history for a reliable
// peer population, or something narrower) and, separately, which of the
// returned rows fall inside whichever period is on screen.
export function detectLargeBankOutflows(records, cfg = {}, baseCurrency = 'JMD') {
  const t = Object.assign({
    largeChargeMultiple: 2.5, largeChargeMin: 10000,
    largeChargeZ: 3.5, largeChargeMinPeers: 2,
  }, cfg.insights || {});
  const med = (arr) => { const s = arr.slice().sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
  const rows = (records || []).filter((r) => !r.internalTransfer && !r.roundTrip && !r.household
    && !r.excludedFromIncome && r.direction === 'out' && (r.currency || baseCurrency) === baseCurrency);
  const amounts = rows.map((r) => r.amount);
  const out = [];
  rows.forEach((r, i) => {
    if (r.amount < t.largeChargeMin) return;
    const others = amounts.filter((_, j) => j !== i);
    if (others.length < t.largeChargeMinPeers) return;
    const centre = med(others);
    const mad = med(others.map((x) => Math.abs(x - centre)));
    const zOk = mad > 0 ? ((0.6745 * (r.amount - centre)) / mad >= t.largeChargeZ) : true;
    const multipleOk = centre > 0 && r.amount >= centre * t.largeChargeMultiple;
    if (zOk && multipleOk) {
      const z = mad > 0 ? (0.6745 * (r.amount - centre)) / mad : Infinity;
      out.push({ id: r.id, key: r.counterpartyKey, label: r.counterpartyLabel || r.description, amount: roundMoney(r.amount), date: r.date, z });
    }
  });
  return out.sort((a, b) => b.z - a.z || b.amount - a.amount);
}

// New large payee this period - the bank twin of reporting.js's
// detectPeriodNewMerchants: a payee's TRUE first-ever external payment, by
// counterpartyKey, across the WHOLE record set passed in, counted as "new
// this period" only when that true first-ever month falls inside the given
// period (an all-time/first-ever view has no prior period, so it returns []
// rather than mislabelling every payee as new - the identical guard
// detectPeriodNewMerchants uses). Sums every qualifying payment to that payee
// within the period (not just the first row), exactly as
// detectPeriodNewMerchants sums a new merchant's period spend. Grouped by
// counterpartyKey/counterpartyLabel instead of merchantGroupKey/
// merchantDisplayLabel; genuine external outflows only, same exclusions and
// base-currency guard as detectLargeBankOutflows above. Returns
// [{ key, label, amount }], largest first. The caller applies whatever
// minimum counts as noteworthy (mirroring how detectPeriodNewMerchants itself
// carries no minimum - callers such as Cards' buildInsights apply
// newMerchantMin afterwards).
export function detectPeriodNewPayees(records, period, baseCurrency = 'JMD') {
  if (!period || !period.prevFrom) return [];
  const rows = (records || []).filter((r) => !r.internalTransfer && !r.roundTrip && !r.household
    && !r.excludedFromIncome && r.direction === 'out' && (r.currency || baseCurrency) === baseCurrency);
  const keyOf = (r) => r.counterpartyKey || ('ext:' + String(r.description || '').toUpperCase());
  const monthOf = (r) => String(r.date || '').slice(0, 7);
  // True first-ever occurrence month per payee, across the WHOLE set passed in.
  const firstMonth = {};
  for (const r of rows) {
    const key = keyOf(r); const m = monthOf(r);
    if (!(key in firstMonth) || m < firstMonth[key]) firstMonth[key] = m;
  }
  const amountByKey = {};
  const labelByKey = {};
  for (const r of rows) {
    const m = monthOf(r);
    if (m < period.from || m > period.to) continue;
    const key = keyOf(r);
    // Only a payee whose first-ever month is inside this period is genuinely new.
    if (firstMonth[key] < period.from || firstMonth[key] > period.to) continue;
    amountByKey[key] = (amountByKey[key] || 0) + r.amount;
    if (!(key in labelByKey)) labelByKey[key] = r.counterpartyLabel || r.description;
  }
  return Object.keys(amountByKey)
    .map((key) => ({ key, label: labelByKey[key], amount: roundMoney(amountByKey[key]) }))
    .sort((a, b) => b.amount - a.amount);
}

// The combined overview model (PRD §6.3, D7/D8/D12). Summarises net position,
// money in, money out and a balance trend across BOTH ledgers, and provides the
// two routing headlines - it never reproduces category or merchant analysis.
//   - cash position: the sum of each bank account's own closing balance.
//   - card balance: the latest card statement's new balance, shown as money
//     owed (a liability), never netted into the cash figure - there is no
//     net-worth headline (D12); the honest top line is net cash movement and
//     the balances shown side by side.
//   - money in / money out: EXTERNAL bank flow only. Card payments are internal
//     transfers to the card and are already excluded by the classifier once the
//     card account is known, so card spend is never double-counted here (the
//     turn-25 proof: a large sum of bank->card payments reclassified as internal).
//   - trend: external net cash flow per month.
// Card spend stays inside the Cards sub-view; only its headline balance and a
// route-in appear here.
export function analyseCombinedOverview(opts = {}) {
  const bankRecords = opts.bankRecords || [];
  const cardStatements = opts.cardStatements || [];
  const cardSummary = opts.cardSummary || null; // { total_spend, n_transactions } from the card ledger
  const bank = analyseBankActivity(bankRecords);
  const flow = bankFlowOverTime(bankRecords);
  // Latest card statement by statement key = current card balance owed.
  const latestCard = cardStatements.slice().sort((a, b) =>
    String(a.statementKey || a.period).localeCompare(String(b.statementKey || b.period))).pop() || null;
  const cardBalance = latestCard && latestCard.newBalance != null ? roundMoney(latestCard.newBalance) : null;
  const cardUtilisation = latestCard && latestCard.utilisation != null ? latestCard.utilisation : null;
  const shortlist = externalOutflowShortlist(bankRecords, 5);
  return {
    accounts: bank.accounts,
    foreignAccounts: bank.foreignAccounts,         // USD accounts, shown in their own currency
    cashPosition: bank.closingBalance,            // sum of per-account BASE (JMD) closings
    cardBalance,                                   // money owed on the card (liability, not netted)
    cardUtilisation,
    moneyIn: bank.cashIn,                           // external only
    moneyOut: bank.cashOut,                         // external only (card payments already internal)
    net: bank.net,
    internalIn: bank.internalIn, internalOut: bank.internalOut,
    months: bank.months,
    trend: flow.map((f) => ({ month: f.month, net: f.net, moneyIn: f.moneyIn, moneyOut: f.moneyOut })),
    topOutflows: shortlist,
    // Routing headlines, one per sub-view (D8: summarise and route, no detail).
    cardsRoute: {
      headline: cardBalance == null ? null : cardBalance,
      sub: latestCard ? (latestCard.period || latestCard.statementKey) : null,
      spendTotal: cardSummary ? cardSummary.total_spend : null,
    },
    accountsRoute: {
      headline: bank.closingBalance,
      accountCount: bank.accounts.length,
    },
  };
}

/* ===========================================================================
 *  PHASE 3: the combined roll-up (PRD §9 Phase 3, D12)
 *  ---------------------------------------------------------------------------
 *  One consolidated read of money across BOTH ledgers - income, the genuine
 *  external spending, and the net cash movement - plus the cash balances and
 *  the card balance shown side by side, never netted into a single net-worth
 *  figure (D12: the data is cash accounts and a card, not assets and
 *  liabilities). It is deliberately double-count-safe, proven on the real
 *  exports:
 *    - income        = external money INTO the bank accounts (salary, external
 *                      transfers). Internal transfers and card payments are
 *                      already excluded by the classifier.
 *    - external spend = bank external money OUT (transfers/card-payments
 *                      excluded) PLUS card purchases. The card PAYMENT that
 *                      settles the card is an internal bank->card transfer and
 *                      is excluded from the bank leg, so a card purchase is
 *                      counted exactly once - from the card side - and never
 *                      again as its bank payment (turn-27 proof: J$3.37M of
 *                      bank->card payments reclassified internal).
 *    - net cash flow  = income - external spend.
 *  Pure; nothing here re-parses or re-totals a statement. It only sums figures
 *  the two ledgers already computed.
 *  ======================================================================== */
export function analyseRollup(opts = {}) {
  const bankRecords = opts.bankRecords || [];
  const cardSpendTotal = roundMoney(opts.cardSpendTotal || 0);
  const cardSpendByMonth = opts.cardSpendByMonth || {};
  const cardStatements = opts.cardStatements || [];
  const bank = analyseBankActivity(bankRecords);
  const bankFlow = bankFlowOverTime(bankRecords);

  const income = bank.cashIn;                                   // external in
  const externalSpending = roundMoney(bank.cashOut + cardSpendTotal); // no double count
  const netCashFlow = roundMoney(income - externalSpending);

  // Combined outflow over time: bank external money out + card purchases per
  // month. Card payments are internal and already out of bankFlow, so a card
  // purchase shows once (in cardOut), never twice.
  const monthSet = new Set([...bankFlow.map((f) => f.month), ...Object.keys(cardSpendByMonth)]);
  const trend = [...monthSet].filter(Boolean).sort().map((m) => {
    const bf = bankFlow.find((x) => x.month === m) || { moneyIn: 0, moneyOut: 0 };
    const cardOut = roundMoney(cardSpendByMonth[m] || 0);
    return { month: m, income: bf.moneyIn, bankOut: bf.moneyOut, cardOut,
      spending: roundMoney(bf.moneyOut + cardOut), net: roundMoney(bf.moneyIn - (bf.moneyOut + cardOut)) };
  });

  const latestCard = cardStatements.slice().sort((a, b) =>
    String(a.statementKey || a.period).localeCompare(String(b.statementKey || b.period))).pop() || null;
  const cardOwed = latestCard && latestCard.newBalance != null ? roundMoney(latestCard.newBalance) : null;
  const cardUtilisation = latestCard && latestCard.utilisation != null ? latestCard.utilisation : null;

  return {
    income, externalSpending, netCashFlow,
    bankExternalOut: bank.cashOut, cardSpend: cardSpendTotal,
    internalOut: bank.internalOut,
    cashPosition: bank.closingBalance,         // sum of per-account BASE (JMD) closings
    cardOwed, cardUtilisation,                  // shown beside cash, never netted (D12)
    accounts: bank.accounts, foreignAccounts: bank.foreignAccounts,
    months: bank.months, trend,
    hasCard: cardSpendTotal > 0 || cardOwed != null,
  };
}

// A calm one-line verdict for the Overview (Round 1, A1), built from the roll
// object analyseRollup returns. The text follows the SIGN of the whole-window
// netCashFlow: net >= 0 reads "more came in than went out this period", net < 0
// reads "more went out than came in this period" - a plain sentence, no figures.
// The comparison inspects the last two to three trend entries by their .net
// signs: when the recent pattern shares the window's sign it continues, otherwise
// it breaks the recent pattern; with fewer than two trend entries the comparison
// is held back as ''. tone is 'good' when net >= 0 and the pattern continues,
// 'watch' when net < 0, and 'neutral' otherwise - a quiet dot at most, never any
// colour or grade language. Pure; no DOM.
export function overviewVerdict(roll) {
  const r = roll || {};
  const net = Number(r.netCashFlow) || 0;
  const positive = net >= 0;
  const text = positive
    ? 'more came in than went out this period'
    : 'more went out than came in this period';
  const trend = Array.isArray(r.trend) ? r.trend : [];
  if (trend.length < 2) {
    return { tone: positive ? 'neutral' : 'watch', text, comparison: '' };
  }
  const recent = trend.slice(-3);
  const recentPositive = recent.filter((t) => (Number(t.net) || 0) >= 0).length;
  const recentNegative = recent.length - recentPositive;
  const recentSignPositive = recentPositive >= recentNegative;
  const continues = recentSignPositive === positive;
  const comparison = continues ? 'this continues the recent pattern' : 'this breaks the recent pattern';
  let tone;
  if (positive && continues) tone = 'good';
  else if (!positive) tone = 'watch';
  else tone = 'neutral';
  return { tone, text, comparison };
}

/* ===========================================================================
 *  CREDIT-CARD STATEMENT SUPPORT  (statement-level records, reconciliation,
 *  health, cross-ledger link, statement-period dimension)
 *  ---------------------------------------------------------------------------
 *  The card TRANSACTION path (parseStatementLines) is unchanged (D2): parsing,
 *  categorisation, totals and identity all stay exactly as they were. These
 *  additions read the page-1 Account Summary of a card statement to build a
 *  per-statement record - the same balance-first reconciliation the bank ledger
 *  already has, now mirrored for the card. Every function is pure and tested
 *  against verbatim lines extracted from the real statement PDF.
 *
 *  Evidence: across all 20 real statements, PREVIOUS + PURCHASES + PAYMENTS =
 *  NEW BALANCE with zero breaks, and bank "Transfer to 1234" payments match the
 *  card's own "INTERNET - CARD PAYMENT" 144/145 within a few days - the basis
 *  for the reconciliation gate and the cross-ledger link below.
 *  ======================================================================== */

// Robust money read for the Account Summary lines. Card extraction can split a
// number with a stray space ("$8,9 28.10" is 8,928.10), so spaces inside the
// numeric run are stripped along with the thousands commas before parsing.
export function cardMoney(s) {
  const m = String(s == null ? '' : s).match(/-?[\d, ]+\.\d{2}/);
  return m ? parseFloat(m[0].replace(/[, ]/g, '')) : null;
}

// Split an extracted Scotiabank card file into one segment per statement,
// mirroring splitNcbStatements for the NCB path. Previously
// parseCardStatementSummary was handed the WHOLE file's lines regardless of
// how many statements it held; for a single-statement upload that's harmless,
// but the real consolidated 20-statement PDF made it silently read whichever
// statement's Account Summary happened to be physically LAST in the file,
// not any specific intended one - and it did so deterministically, with no
// warning, so a stale statement's balance could sit in Data & Settings
// indefinitely. "AMOUNT OWING ... MINIMUM PAYMENT ... PAY BY ..." appears
// exactly once, at the very top of page 1 of every statement, and does not
// recur on that statement's own later pages (their footers restate
// "Statement Period"/"Pay by" in a different combined phrase, never
// "AMOUNT OWING"), so it anchors reliably. The owing amount is paired with
// the pay-by date to build a key that stays unique even across two
// statements that both show $0.00 owing (confirmed distinct pay-by dates
// on the real consolidated export).
const CARD_STMT_ANCHOR = /AMOUNT OWING/i;
const CARD_PAY_BY = /PAY BY\**\s*([A-Za-z]+\s+\d{1,2},?\s*\d{4})/i;
const CARD_OWING_AMT = /AMOUNT OWING\**\s*\$?(-?[\d,]+\.\d{2})/i;

export function splitCardStatements(lines) {
  const clean = (lines || []).map((l) => String(l).replace(/\s+/g, ' ').trim());
  const anchors = [];
  for (let i = 0; i < clean.length; i++) {
    if (!CARD_STMT_ANCHOR.test(clean[i])) continue;
    let owing = null, payBy = null;
    for (let j = i; j < Math.min(i + 6, clean.length); j++) {
      if (owing == null) { const m = CARD_OWING_AMT.exec(clean[j]); if (m) owing = m[1]; }
      if (payBy == null) { const m = CARD_PAY_BY.exec(clean[j]); if (m) payBy = m[1]; }
      if (owing != null && payBy != null) break;
    }
    anchors.push({ i, key: `${owing || ''}|${payBy || ''}` });
  }
  if (anchors.length <= 1) return [clean];
  const segments = [];
  for (let b = 0; b < anchors.length; b++) {
    const start = b === 0 ? 0 : anchors[b].i;
    const end = b === anchors.length - 1 ? clean.length : anchors[b + 1].i;
    segments.push(clean.slice(start, end));
  }
  return segments;
}


// Parse the page-1 Account Summary of a credit-card statement into a plain
// record. Reads only labelled summary fields (never the transaction rows), so
// it is additive and cannot affect card transaction parsing. Any field it
// cannot find is left null; the statement still imports and its transactions
// are unaffected - only the reconciliation gate needs prev/purchases/new.
export function parseCardStatementSummary(lines, sourceFile) {
  const L = (lines || []).map((l) => String(l == null ? '' : l));
  const out = {
    source_file: sourceFile || '', account: '', periodText: '',
    periodStart: null, periodEnd: null, statementKey: '', payBy: '',
    previousBalance: null, purchases: null, payments: null, newBalance: null,
    interestCharges: null, feesInsurance: null, taxes: null,
    creditLimit: null, creditAvailable: null,
    amountOwing: null, minimumPayment: null, eair: null,
  };
  for (let i = 0; i < L.length; i++) {
    const ln = L[i]; const u = ln.toUpperCase();
    if (!out.account) { const a = ln.match(/\*{2,}\s*(\d{4})\b/); if (a) out.account = a[1]; }
    if (out.previousBalance == null && /PREVIOUS BALANCE/.test(u)) out.previousBalance = cardMoney(ln);
    else if (out.purchases == null && /PURCHASES,/.test(u)) {
      let val = /\d\.\d{2}/.test(ln) ? cardMoney(ln) : null;
      if (val == null) {
        for (let j = i + 1; j < Math.min(i + 3, L.length); j++) {
          if (/\d\.\d{2}/.test(L[j])) { val = cardMoney(L[j]); break; }
        }
      }
      if (val != null) out.purchases = val;
    }
    else if (out.payments == null && /PAYMENTS & CREDITS/.test(u)) out.payments = cardMoney(ln);
    else if (out.newBalance == null && /^NEW BALANCE/.test(u)) out.newBalance = cardMoney(ln);
    else if (out.interestCharges == null && /INTEREST CHARGES/.test(u)) out.interestCharges = cardMoney(ln);
    else if (out.feesInsurance == null && /INSURANCE PREMIUMS/.test(u)) out.feesInsurance = cardMoney(ln);
    else if (out.taxes == null && /^TAXES\b/.test(u)) out.taxes = cardMoney(ln);
    else if (out.creditLimit == null && /CREDIT LIMIT/.test(u) && /CREDIT AVAILABLE/.test(u)) {
      const nx = (L[i + 1] || '') + ' ' + ln;
      const vals = nx.match(/[\d, ]+\.\d{2}/g) || [];
      if (vals.length >= 2) { out.creditLimit = cardMoney(vals[vals.length - 2]); out.creditAvailable = cardMoney(vals[vals.length - 1]); }
    } else if (out.amountOwing == null && /AMOUNT OWING/.test(u) && /MINIMUM PAYMENT/.test(u)) {
      const nx = L[i + 1] || '';
      const vals = nx.match(/-?[\d, ]+\.\d{2}/g) || [];
      if (vals.length >= 1) out.amountOwing = cardMoney(vals[0]);
      if (vals.length >= 2) out.minimumPayment = cardMoney(vals[1]);
      const pb = nx.match(/([A-Za-z]+\s+\d{1,2},?\s*\d{0,4})\s*$/); if (pb) out.payBy = pb[1].trim();
    } else if (!out.periodText && /STATEMENT PERIOD/.test(u)) {
      out.periodText = (L[i + 1] || '').trim();
    } else if (out.eair == null && /ANNUAL\/EAIR/.test(u.replace(/\s+/g, ''))) {
      for (let j = i; j < Math.min(i + 4, L.length); j++) {
        const e = L[j].match(/([\d.]+)%\s*\/\s*([\d.]+)%/); if (e) { out.eair = parseFloat(e[2]); break; }
      }
    }
  }

  const per = parseCardPeriod(out.periodText);
  if (per) { out.periodStart = per.start; out.periodEnd = per.end; out.statementKey = per.key; }
  return out;
}

const CARD_MONTHS = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12 };
// "Dec 16 - Jan 15, 2025" -> { start:'2024-12-16', end:'2025-01-15', key:'2025-01' }.
// The printed year applies to the END; when the start month is after the end
// month the cycle crossed a year boundary, so the start year is one earlier.
export function parseCardPeriod(text) {
  const t = String(text || '');
  const m = t.match(/([A-Za-z]{3})\w*\s+(\d{1,2})\s*[-\u2013]\s*([A-Za-z]{3})\w*\s+(\d{1,2}),?\s*(\d{4})/);
  if (!m) return null;
  const sM = CARD_MONTHS[m[1].toLowerCase()], sD = +m[2];
  const eM = CARD_MONTHS[m[3].toLowerCase()], eD = +m[4], eY = +m[5];
  if (!sM || !eM) return null;
  const sY = sM > eM ? eY - 1 : eY;
  const iso = (y, mo, d) => `${y}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
  return { start: iso(sY, sM, sD), end: iso(eY, eM, eD), key: `${eY}-${String(eM).padStart(2, '0')}` };
}

// Reconcile a card statement: PREVIOUS + PURCHASES + PAYMENTS must equal NEW
// BALANCE (the printed Account Summary identity). Pure; proven across all 20
// real statements with zero breaks. Returns a plain, trustable verdict.
export function reconcileCardStatement(summary) {
  const res = { ok: false, computedNew: null, difference: null, checked: false, break: '' };
  const s = summary || {};
  if (s.previousBalance == null || s.purchases == null || s.payments == null || s.newBalance == null) {
    res.break = 'summary fields incomplete'; return res;
  }
  res.checked = true;
  res.computedNew = roundMoney(s.previousBalance + s.purchases + s.payments);
  res.difference = roundMoney(res.computedNew - s.newBalance);
  res.ok = Math.abs(res.difference) <= 0.01;
  if (!res.ok) res.break = `previous + purchases + payments = ${res.computedNew.toFixed(2)}, printed new balance ${s.newBalance.toFixed(2)}`;
  return res;
}

// A stable content hash for one card statement record, so re-importing the same
// statement (or the same statement inside a combined PDF) stores it once.
export function cardStatementHash(summary) {
  const s = summary || {};
  return fnv1a([s.account || '', s.statementKey || s.periodText || '', s.previousBalance, s.purchases, s.payments, s.newBalance].join('|'));
}

// Per-statement card-health record (Recommendation 4). Utilisation is the new
// balance against the credit limit; revolving means a balance was carried past
// the statement (new balance materially above zero - a small credit or zero is
// not revolving). All derived from the printed summary; nothing is inferred.
export function cardStatementHealth(summary) {
  const s = summary || {};
  const limit = s.creditLimit != null && s.creditLimit > 0 ? s.creditLimit : null;
  const nb = s.newBalance;
  const utilisation = (limit != null && nb != null) ? roundMoney(Math.max(0, nb) / limit * 100) : null;
  const revolving = nb != null ? nb > 1 : null;
  return {
    account: s.account || '', statementKey: s.statementKey || '', periodText: s.periodText || '',
    newBalance: nb, creditLimit: limit, creditAvailable: s.creditAvailable,
    utilisation, revolving,
    minimumPayment: s.minimumPayment, amountOwing: s.amountOwing,
    interestCharges: s.interestCharges, eair: s.eair,
    payingInFull: (nb != null && nb <= 1),
  };
}

// Cross-ledger payment link (Recommendation 2). Match each bank outflow that
// targets the card ("Transfer to 1234") to the card's own payment credit
// ("INTERNET - CARD PAYMENT") by equal amount within a few days - the bank
// debit date and the card posting date differ slightly. Greedy 1:1 nearest
// match. Pure; proven 144/145 on the real exports. Used to (a) confirm a
// payment appears on both sides and (b) exclude the bank leg from spend so a
// card purchase is never double-counted against its bank payment.
export function linkCardPayments(bankPayments, cardPayments, opts = {}) {
  // D-audit item 10: windowDays=4 is empirically validated, not a guess. Measured
  // on the real exports, 144/145 bank->card payments match a card payment credit,
  // the median gap is 0 days and the MAXIMUM observed gap is 3 days, so a 4-day
  // window matches every real pair with one day of headroom and no false links.
  // Kept as-is (overridable via opts.windowDays); no change warranted.
  const windowDays = opts.windowDays == null ? 4 : opts.windowDays;
  const day = 86400000;
  const toT = (iso) => { const p = String(iso || '').split('-').map(Number); return Date.UTC(p[0], (p[1] || 1) - 1, p[2] || 1); };
  const cards = cardPayments.map((c) => ({ ...c, _t: toT(c.date), _used: false, _amt: roundMoney(Math.abs(Number(c.amount) || 0)) }));
  const links = []; const unmatched = [];
  const banks = bankPayments.slice().sort((a, b) => (a.date < b.date ? -1 : 1));
  for (const b of banks) {
    const bt = toT(b.date); const amt = roundMoney(Math.abs(Number(b.amount) || 0));
    let best = null, bestGap = Infinity;
    for (const c of cards) {
      if (c._used || c._amt !== amt) continue;
      const gap = Math.abs(c._t - bt);
      if (gap <= windowDays * day && gap < bestGap) { best = c; bestGap = gap; }
    }
    if (best) { best._used = true; links.push({ bankId: b.id || null, cardId: best.id || null, amount: amt, bankDate: b.date, cardDate: best.date }); }
    else unmatched.push({ bankId: b.id || null, amount: amt, bankDate: b.date });
  }
  return { links, unmatched, matched: links.length, total: banks.length };
}

// Assign each card transaction to the statement cycle that contains its date
// (Recommendation 3: statement period as a first-class dimension). Returns a
// shallow-copied array with a `statementKey` added; never mutates identity,
// amount or category, so totals and dedupe are unaffected. Falls back to the
// calendar month when no statement period contains the date.
export function assignCardStatementKeys(cardTxns, statements) {
  const periods = (statements || []).filter((s) => s.periodStart && s.periodEnd)
    .map((s) => ({ start: s.periodStart, end: s.periodEnd, key: s.statementKey }));
  return (cardTxns || []).map((t) => {
    const d = t.date || t.txn_date || '';
    const hit = periods.find((p) => d >= p.start && d <= p.end);
    return { ...t, statementKey: hit ? hit.key : (d ? d.slice(0, 7) : '') };
  });
}

/* ===========================================================================
 * 4) Transaction identity  (stable, from raw fields only)
 * ======================================================================== */

export function transactionIdentity(t) {
  const normDesc = String(t.description || '').replace(/\s+/g, ' ').trim().toUpperCase();
  const amt = roundMoney(Number(t.amount) || 0).toFixed(2);
  return fnv1a([t.txn_date, amt, t.ref, normDesc].join('|'));
}

/* ===========================================================================
 * 7) Merge engine  (idempotent; used for import dedupe and history merge)
 * ======================================================================== */

export function mergeTransactions(existing, incoming) {
  const byId = new Map();
  for (const r of existing) byId.set(r.id || transactionIdentity(r), { ...r, id: r.id || transactionIdentity(r) });
  const result = { added: 0, alreadyPresent: 0, conflicts: 0 };
  for (const raw of incoming) {
    const rec = { ...raw, id: raw.id || transactionIdentity(raw) };
    const cur = byId.get(rec.id);
    if (!cur) { byId.set(rec.id, rec); result.added++; continue; }
    result.alreadyPresent++;
    const curOv = cur.categoryOverride || null;
    const recOv = rec.categoryOverride || null;
    if (curOv === recOv) continue; // equivalent
    if (curOv && !recOv) continue; // keep local explicit override
    if (!curOv && recOv) { byId.set(rec.id, { ...cur, categoryOverride: recOv, lastChanged: rec.lastChanged }); continue; }
    // Both overridden differently: newer lastChanged wins; else mark conflict.
    const ct = Date.parse(cur.lastChanged || 0) || 0;
    const rt = Date.parse(rec.lastChanged || 0) || 0;
    if (rt > ct) byId.set(rec.id, { ...cur, categoryOverride: recOv, lastChanged: rec.lastChanged });
    else if (rt === ct) { byId.set(rec.id, { ...cur, conflict: { a: curOv, b: recOv } }); result.conflicts++; }
  }
  return { records: [...byId.values()], ...result };
}

/* ===========================================================================
 *  NCB CREDIT-CARD STATEMENT SUPPORT  (Part B: pure transaction reader)
 *  ---------------------------------------------------------------------------
 *  A second card reader beside the Scotiabank one, reached only after
 *  detectCardStatementFormat() has said 'ncb'. It turns NCB statement pages
 *  into the SAME transaction record shape the Scotiabank reader produces
 *  (txn_date, posting_date, ref, description, amount, source_file, foreign,
 *  stitched), so everything downstream (categorisation, merge, totals,
 *  display) cannot tell the two issuers apart. Every function here is pure
 *  (no DOM, no state) and is exercised against verbatim lines extracted from
 *  the twelve real NCB statements.
 *
 *  NCB rows differ from Scotiabank in three ways this reader absorbs:
 *    1. No reference number and no "$": a row is
 *         DDMM(posting) DDMM(txn) <desc with letters> <txnAmt>[-] <billAmt>[-]
 *       with thousands commas and a TRAILING minus for credits.
 *    2. The billing ledger amount is the JMD figure; the transaction amount is
 *       the original (foreign, when the two differ). There is no printed
 *       currency code; all foreign merchants in the sample are US, so a
 *       mismatch is tagged USD and only ever feeds the "spent abroad" grouping,
 *       never a total.
 *    3. Extraction glues the column header ("... DATE ... N DATE ... AMOUNT")
 *       into the first row of every page, and can run a credit's trailing minus
 *       straight into the next row's posting date ("33325.93-2004"). Both are
 *       repaired below before the strict row match.
 *  ======================================================================== */

// The primary header value line: statement date (DDMMYYYY), account, new
// balance, minimum payment, due date (DDMMYYYY). The account field is printed
// several ways (xxxx1234, or a spurious 12-digit run like 000000000000), so it
// is matched loosely and never used as identity.
const NCB_PRIMARY = /^(\d{8})\s+(?:XXXX\s*\d{2,}|\d{6,})\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})\s+(\d{8})\s*$/;
// The secondary header value line: statement date, the masked card ("**** ****
// **** 1234" or an anonymised "1234"), the credit limit, the enquiries phone,
// the due date. Card last-4 and credit limit are read from here.
const NCB_SECONDARY = /^\d{8}\s+\*{2,}[\s*]*?(\d{4})\s+(\d{4,6})\s+1-8\d\d/;
// A transaction row AFTER the run-on split, matched STRUCTURALLY: two leading
// DDMM date tokens and two trailing decimal money columns (transaction amount,
// then billing amount) bound a row; the span between the second date and the
// amounts is the description. No header-fragment names are baked into the anchor
// - a generic pass (NCB_HEADER_WORDS, below) removes any stray isolated ALL-CAPS
// column-header word wherever the extractor glued it into a page's first row, so
// a header fragment never seen before is handled the same way the old
// DATE / N DATE / AMOUNT whitelist handled those three. The description must
// carry at least one letter (checked in code). Amounts are decimal with optional
// thousands commas and an optional TRAILING minus for a credit.
const NCB_ROW = /^(\d{4})\s+(.+?)\s+([\d,]+\.\d{2}-?)\s+([\d,]+\.\d{2}-?)\s*$/;
// The credit-card statement's column-header words, stripped generically as
// isolated tokens (not matched at fixed positions), so an unseen fragment such
// as POSTING or BILLING is removed just like DATE / N DATE / AMOUNT are today.
const NCB_HEADER_WORDS = /\b(?:POSTING|TRANSACTION|TRANSACTIO|DESCRIPTION|BILLING|AMOUNT|DATE|N)\b/g;

// Parse one NCB money token. A TRAILING minus marks a credit (payment, refund,
// reversal), so it becomes a negative number. money() from shared-helpers would
// silently drop the trailing minus (parseFloat stops at it), which is exactly
// why the ledger sign is handled here instead.
export function ncbAmount(token) {
  const t = String(token == null ? '' : token).trim();
  const neg = /-\s*$/.test(t);
  const n = parseFloat(t.replace(/[,\s-]/g, ''));
  if (Number.isNaN(n)) return null;
  return neg ? -n : n;
}

// Defensive run-on split (fixture: "...33325.93- 12345.67-0000 0000 EXAMPLE...").
// The extractor can run a credit's trailing minus straight into the next row's
// posting date, gluing two rows onto one line. Insert a break wherever a
// billing amount (optional trailing minus) is immediately followed by a fresh
// "DDMM DDMM " row start, then split. A clean, already-separated line has no
// such glue, so this is a no-op there and is safe to run on every line.
export function ncbSplitRunon(line) {
  const s = String(line == null ? '' : line);
  return s.replace(/([\d,]+\.\d{2}-?)(\d{4}\s+\d{4}\s+\S)/g, '$1\n$2').split('\n');
}

// Tidy a raw NCB description into the stored description. Two steps, in order:
//   1. strip star reference tokens ("AMZN MKTP US*826VC1TV3" -> "AMZN MKTP US",
//      "DIGICEL DING*82937145" -> "DIGICEL DING") using the SAME "*\S+" rule the
//      existing merchantLabel uses, so those refs stop fragmenting the merchant
//      grouping key;
//   2. insert a comma at the FIRST spaced " - ", so the app's existing
//      first-segment logic (description.split(',')[0]) groups by merchant/branch
//      ("BARBICAN TEXACO - KINGSTON 6" -> "BARBICAN TEXACO, KINGSTON 6";
//      "WENDY'S- BARBICAN - KINGSTON 8" -> "WENDY'S- BARBICAN, KINGSTON 8", whose
//      unspaced first hyphen is deliberately left alone).
// Star-stripping runs FIRST so a ref sitting right before the " - " cannot
// swallow the comma. Branch-level grouping is the goal here; chain-grouping is a
// later category-rules refinement and out of scope.
export function ncbTidyDescription(desc) {
  let s = String(desc == null ? '' : desc);
  s = s.replace(/\*\S+/g, '');
  s = s.replace(/\s{2,}/g, ' ').trim();
  s = s.replace(/ - /, ', ');
  return s.trim();
}

// Format a foreign figure WITHOUT asserting a currency. NCB rows never print a
// currency code, so the original transaction amount is a foreign figure of
// UNKNOWN currency. It is tagged with the app's neutral "FX" marker - the same
// fallback foreignSummary already uses for a code-less row - never "USD": this
// sample happens to be all-American, but a future GBP/EUR purchase must not be
// silently mislabelled. Only the "spent abroad" grouping reads this; every
// total is summed from the JMD billing figure, so no total can change.
function ncbForeignTag(amount) {
  const v = Math.abs(Number(amount) || 0);
  return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' FX';
}

// Resolve a year-less DDMM to a full ISO date using the statement's own date.
// A statement only reports transactions on or before its own date, so a
// transaction whose month/day falls after the statement's belongs to the
// previous calendar year (the December rows on a January statement). Pure;
// applied to the posting date and the transaction date independently.
export function makeNcbDateResolver(statementYear, statementMonth, statementDay) {
  // Build each year-less DDMM in the statement's own year, then roll it back one
  // year only when that would place it AFTER the statement date (beyond a few
  // days' grace, so a late-posting within the same cycle is not flipped).
  // Comparing the whole statement date, not the month alone, keeps a transaction
  // posted up to a couple of months earlier in the correct year instead of
  // flipping whenever its month merely exceeds the statement month. Falls back
  // to the month-only rule when the statement day is unknown, so older callers
  // are unaffected.
  const sDay = (statementDay != null && statementDay >= 1 && statementDay <= 31) ? statementDay : null;
  const GRACE_DAYS = 5;
  return (ddmm) => {
    const s = String(ddmm == null ? '' : ddmm);
    if (!/^\d{4}$/.test(s)) return '';
    const dd = +s.slice(0, 2), mm = +s.slice(2, 4);
    if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return '';
    let year;
    if (sDay == null) {
      year = mm > statementMonth ? statementYear - 1 : statementYear;
    } else {
      const stmt = Date.UTC(statementYear, statementMonth - 1, sDay);
      const here = Date.UTC(statementYear, mm - 1, dd);
      year = (here - stmt > GRACE_DAYS * 86400000) ? statementYear - 1 : statementYear;
    }
    return `${year}-${String(mm).padStart(2, '0')}-${String(dd).padStart(2, '0')}`;
  };
}

// Read the two header value lines of one NCB statement. Everything keys on the
// statement date and balances printed INSIDE the statement, never on a filename.
// Any field not found is left null so a partial statement still yields what it
// can. statementKey (YYYY-MM of the statement date) is the per-statement month
// used for grouping and dedupe.
export function parseNcbHeader(lines) {
  const clean = (lines || []).map((l) => String(l).replace(/\s+/g, ' ').trim());
  const out = {
    statementDateRaw: '', statementDate: '', statementKey: '',
    statementYear: null, statementMonth: null,
    newBalance: null, minimumPayment: null, dueDate: '',
    creditLimit: null, cardLast4: '',
  };
  const iso8 = (d) => `${d.slice(4, 8)}-${d.slice(2, 4)}-${d.slice(0, 2)}`;
  for (const l of clean) {
    const p = NCB_PRIMARY.exec(l);
    if (p && !out.statementDateRaw) {
      out.statementDateRaw = p[1];
      out.statementYear = +p[1].slice(4, 8);
      out.statementMonth = +p[1].slice(2, 4);
      out.statementDate = iso8(p[1]);
      out.statementKey = `${p[1].slice(4, 8)}-${p[1].slice(2, 4)}`;
      out.newBalance = ncbAmount(p[2]);
      out.minimumPayment = ncbAmount(p[3]);
      out.dueDate = iso8(p[4]);
    }
    const s = NCB_SECONDARY.exec(l);
    if (s && !out.cardLast4) {
      out.cardLast4 = s[1];
      out.creditLimit = ncbAmount(s[2]);
    }
  }
  return out;
}

// Split an extracted NCB file into one segment of lines per statement. The
// primary header (with the statement date) repeats on every page of a
// statement, so a new statement begins wherever that date changes. A single
// statement file returns one segment; the consolidated file returns twelve.
export function splitNcbStatements(lines) {
  const clean = (lines || []).map((l) => String(l).replace(/\s+/g, ' ').trim());
  const heads = [];
  for (let i = 0; i < clean.length; i++) {
    const m = NCB_PRIMARY.exec(clean[i]);
    if (m) heads.push({ i, date: m[1] });
  }
  if (!heads.length) return [clean];
  const bounds = [];
  let cur = null;
  for (const h of heads) { if (h.date !== cur) { bounds.push(h.i); cur = h.date; } }
  const segs = [];
  for (let b = 0; b < bounds.length; b++) {
    const start = b === 0 ? 0 : bounds[b];
    const end = b === bounds.length - 1 ? clean.length : bounds[b + 1];
    segs.push(clean.slice(start, end));
  }
  return segs;
}

// Parse ONE NCB statement segment into its header fields plus the SAME
// transaction record shape the Scotiabank reader produces. Collect rows across
// all of the statement's pages, stopping at "STATEMENT OF POINTS" (the rewards
// page, whose bare numbers must never be read as transactions). Each row is
// run through the defensive run-on split first, then the strict matcher; the
// billing amount is the JMD ledger amount (negative for a trailing-minus
// credit), and a transaction/billing mismatch tags the row foreign in USD.
// posIndex is the row's position within this statement, used later for a stable
// identity (NCB rows carry no reference number).
export function parseOneNcbStatement(segLines, sourceFile) {
  const clean = (segLines || []).map((l) => String(l).replace(/\s+/g, ' ').trim());
  const header = parseNcbHeader(clean);
  const resolve = makeNcbDateResolver(
    header.statementYear == null ? new Date().getFullYear() : header.statementYear,
    header.statementMonth == null ? 1 : header.statementMonth,
    header.statementDateRaw ? +header.statementDateRaw.slice(0, 2) : null);
  const transactions = [];
  let posIndex = 0;
  for (const raw of clean) {
    if (/STATEMENT OF POINTS/i.test(raw)) break; // rewards page: stop collecting
    for (const piece of ncbSplitRunon(raw)) {
      const m = NCB_ROW.exec(piece);
      if (!m) continue;
      // Structural read: m[1] is the posting date; m[3]/m[4] are the two money
      // columns. Everything between is the middle span. Strip any stray isolated
      // column-header word the extractor glued in, then read the transaction
      // date as the first remaining 4-digit token and the rest as the raw
      // description. Defined by two dates and two trailing amounts, not by
      // matching named header fragments.
      const middle = m[2].replace(NCB_HEADER_WORDS, ' ').replace(/\s{2,}/g, ' ').trim();
      const dm = /^(\d{4})\s+(.+)$/.exec(middle);
      if (!dm) continue;
      const desc = dm[2].trim();
      if (!/[A-Za-z]/.test(desc)) continue; // a row must name a merchant
      const txnAmt = ncbAmount(m[3]);
      const billAmt = ncbAmount(m[4]);
      if (txnAmt == null || billAmt == null) continue;
      const foreign = (roundMoney(txnAmt) !== roundMoney(billAmt)) ? ncbForeignTag(txnAmt) : '';
      // Part B: the row's natural key is its raw star/reference token, or the
      // raw pre-tidy description when there is no star. Kept for identity only;
      // the stored and displayed description stays tidied as before.
      const ncbRefRaw = (desc.match(/\*(\S+)/) || [])[1] || desc.replace(/\s+/g, ' ').trim();
      transactions.push({
        txn_date: resolve(dm[1]), posting_date: resolve(m[1]), ref: '',
        description: ncbTidyDescription(desc), amount: roundMoney(billAmt),
        source_file: sourceFile || '', foreign, stitched: false, posIndex: posIndex++,
        ncbRefRaw,
      });
    }
  }
  // Part B: assign each row a stable, order-independent identity discriminator.
  // A row with no same-key sibling keeps its legacy per-statement position index,
  // so its identity hash is byte-identical to before and nothing already stored
  // is re-keyed. Only rows that share every identity field with a sibling - the
  // genuine collision the position index used to paper over - switch to the raw
  // reference, so two same-day, same-amount orders stay distinct no matter which
  // order pdf.js extracted them in.
  const ncbSig = (t) => [t.txn_date, t.posting_date, String(t.description || '').replace(/\s+/g, ' ').trim().toUpperCase(), roundMoney(t.amount).toFixed(2)].join('|');
  const ncbGroupCount = new Map();
  for (const t of transactions) ncbGroupCount.set(ncbSig(t), (ncbGroupCount.get(ncbSig(t)) || 0) + 1);
  for (const t of transactions) {
    t.ncbDisc = ncbGroupCount.get(ncbSig(t)) > 1 ? ('r:' + String(t.ncbRefRaw || '')) : String(t.posIndex);
  }
  return { ...header, source_file: sourceFile || '', transactions };
}

// Parse an extracted NCB file. Splits a multi-statement file into per-statement
// segments, parses each on its own, and returns the combined transactions plus
// a `statements` array (one record per statement, each carrying its own header
// and transactions), mirroring parseBankStatementLines' shape so ingest can
// treat one-statement and consolidated files the same way.
export function parseNcbStatementLines(lines, sourceFile) {
  const out = { source_file: sourceFile || '', statements: [], transactions: [] };
  if (!lines || !lines.some((l) => l && String(l).trim())) {
    return out;
  }
  for (const seg of splitNcbStatements(lines)) {
    const one = parseOneNcbStatement(seg, sourceFile);
    if (!one.statementKey && !one.transactions.length) continue;
    out.statements.push(one);
    out.transactions.push(...one.transactions);
  }
  return out;
}

/* ===========================================================================
 *  NCB CREDIT-CARD STATEMENT SUPPORT  (Part C: positional summary + reconcile)
 *  ---------------------------------------------------------------------------
 *  The Scotiabank summary reader reads a label and its value on the SAME line;
 *  the NCB Account Summary is POSITIONAL - seven labels on one row and their
 *  seven values on the row beneath, aligned only by column - so it needs its
 *  own reader. The printed box is display-only: on two statements (Dec, Jan) it
 *  falls short of the new balance by exactly the statement's GCT, because the
 *  GCT posts as an ordinary transaction row but is left out of the box's "other
 *  charges". That is why the reconciliation GATE is the transaction-sum
 *  (new - previous == signed billing sum), proven on all twelve, with the box
 *  kept only as supporting display.
 *  ======================================================================== */

const NCB_BOX_LABEL = /PREVIOUS BALANCE.*NEW BALANCE/i;
const NCB_BOX_VALUES = /^([\d,]+\.\d{2})\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})\s*$/;

// Read the positional Account Summary box. Finds the
// "PREVIOUS BALANCE ... = NEW BALANCE" label row whose NEXT line is exactly the
// seven aligned values, and reads them by position:
//   [previous, purchases, payments, credits, interest, otherCharges, newBalance]
// boxComputedNew applies the printed identity
//   previous + purchases - payments - credits + interest + otherCharges
// which equals the printed new balance on ten statements and is short by the
// GCT on the two GCT statements. Returns present:false when no value row is
// found (the page-1 box is blank; the populated one is on the points page).
export function parseNcbSummaryBox(lines) {
  const clean = (lines || []).map((l) => String(l).replace(/\s+/g, ' ').trim());
  const out = {
    present: false, previousBalance: null, purchases: null, payments: null,
    credits: null, interest: null, otherCharges: null, newBalance: null,
    boxComputedNew: null,
  };
  for (let i = 0; i < clean.length; i++) {
    if (!NCB_BOX_LABEL.test(clean[i])) continue;
    const v = i + 1 < clean.length ? NCB_BOX_VALUES.exec(clean[i + 1]) : null;
    if (!v) continue;
    const n = (s) => parseFloat(s.replace(/,/g, ''));
    out.present = true;
    out.previousBalance = roundMoney(n(v[1]));
    out.purchases = roundMoney(n(v[2]));
    out.payments = roundMoney(n(v[3]));
    out.credits = roundMoney(n(v[4]));
    out.interest = roundMoney(n(v[5]));
    out.otherCharges = roundMoney(n(v[6]));
    out.newBalance = roundMoney(n(v[7]));
    out.boxComputedNew = roundMoney(out.previousBalance + out.purchases - out.payments
      - out.credits + out.interest + out.otherCharges);
    return out;
  }
  return out;
}

// The printed "G.C.T Total: $ X" from the points page (0.00 on most, 560.87 on
// Dec, 1082.61 on Jan). Display only; it is exactly the amount by which the box
// falls short of the new balance on the two GCT statements.
export function parseNcbGctTotal(lines) {
  const clean = (lines || []).map((l) => String(l));
  for (const l of clean) {
    const m = /G\.C\.T\s*Total:\s*\$?\s*([\d,]+\.\d{2})/i.exec(l);
    if (m) return roundMoney(parseFloat(m[1].replace(/,/g, '')));
  }
  return null;
}

// Days in the billing cycle, printed on the points page as the leading integer
// on the APR line ("31 42.000 3.500 42.000 3.500 NCB VISA ..."). Present and
// non-zero on all twelve statements (28 to 31).
export function parseNcbDaysInCycle(lines) {
  const clean = (lines || []).map((l) => String(l).replace(/\s+/g, ' ').trim());
  for (const l of clean) {
    const m = /^(\d{1,3})\s+\d+\.\d{3}\s+\d+\.\d{3}/.exec(l);
    if (m) { const d = +m[1]; if (d > 0 && d <= 366) return d; }
  }
  return null;
}

// Reads the printed purchase/cash rate quartet off an NCB statement. This is
// deliberately NOT line-anchored (no ^, no per-line-only matching): a real
// test against a live re-import showed the previous line-anchored version
// failing to populate eair at all on every one of 12 real NCB statements,
// even though the identical line-anchored approach in parseNcbDaysInCycle
// (unchanged, proven separately) reads the SAME physical row for its days
// figure. Rather than guess a second time at exactly how pdf.js's line
// clustering happens to split this row, the statement's cleaned lines are
// joined into one continuous text blob first, and the four-number rate
// pattern is searched for as a substring of that blob. This is robust to
// the number and the surrounding words landing in different array indices
// of `lines`, however pdf.js happened to cluster them, since string
// concatenation preserves their reading-order adjacency either way.
//
// Uniqueness of the pattern is structural, not brand-name-based: every real
// transaction/statement amount on an NCB statement is printed with exactly
// two decimal places (12.34), while these four disclosure figures are
// printed with exactly three (42.000, 3.500). A run of four such
// three-decimal numbers, preceded by a small 1-366 integer (the days-in-
// cycle figure printed immediately before them), does not occur anywhere
// else on the statement - so no card-product name needs to be hard-coded as an anchor,
// and this keeps working if NCB ever issues a differently-named product.
//
// Column order (purchase pair first, cash pair second) is self-checked
// against NCB's own disclosed relationship - the printed annual figure is
// defined as 12x the printed monthly figure - confirmed exactly on all 28
// real statements in the sample corpus (3.500 x 12 = 42.000). If the FIRST
// pair fails that check, the SECOND pair is tried as the purchase rate
// before giving up on that match and searching further in the text, so a
// future statement with a genuinely reversed column order, or cash and
// purchase rates that happen to differ, is still read correctly rather than
// silently mis-assigning a cash rate as a purchase rate. The search
// continues past a non-validating match (using the regex in global mode)
// rather than stopping at the first four-number run found, in case an
// unrelated numeric coincidence elsewhere in the statement happens to match
// the shape but is not the genuine rate row.
// Reads the printed purchase-rate pair (annual %, monthly %) off an NCB
// statement's rate-disclosure block.
const NCB_PURCHASE_RATE_LINE = /^(\d{1,3})\s+(\d{1,3}\.\d{3})\s+(\d{1,3}\.\d{3})/;
const NCB_CASH_RATE_FRAGMENT = /(\d{1,3}\.\d{3})\s+(\d{1,3}\.\d{3})/;
function findNcbCashRate(clean, skipLine) {
  for (const l of clean) {
    if (l === skipLine) continue;
    const m = NCB_CASH_RATE_FRAGMENT.exec(l);
    if (!m) continue;
    const annual = parseFloat(m[1]);
    const monthly = parseFloat(m[2]);
    if (!Number.isFinite(annual) || !Number.isFinite(monthly)) continue;
    if (Math.abs(monthly * 12 - annual) > 0.15) continue;
    return { annualCashPct: annual, monthlyCashPct: monthly };
  }
  return null;
}

export function parseNcbPurchaseRates(lines) {
  const clean = (lines || []).map((l) => String(l).replace(/\s+/g, ' ').trim()).filter(Boolean);
  for (const l of clean) {
    const m = NCB_PURCHASE_RATE_LINE.exec(l);
    if (!m) continue;
    const days = +m[1];
    if (!(days > 0 && days <= 366)) continue;
    const annualPurchase = parseFloat(m[2]);
    const monthlyPurchase = parseFloat(m[3]);
    if (!Number.isFinite(annualPurchase) || !Number.isFinite(monthlyPurchase)) continue;
    if (Math.abs(monthlyPurchase * 12 - annualPurchase) > 0.15) continue;
    const cash = findNcbCashRate(clean, l);
    return {
      annualPurchasePct: annualPurchase,
      monthlyPurchasePct: monthlyPurchase,
      annualCashPct: cash ? cash.annualCashPct : null,
      monthlyCashPct: cash ? cash.monthlyCashPct : null,
    };
  }
  if (typeof console !== 'undefined' && console.debug) {
    console.debug(
      'NCB purchase-rate line not found in statement text (',
      clean.length,
      'lines ).'
    );
  }
  return null;
}

export function effectiveAnnualRateFromMonthly(monthlyPct) {
  const r = Number(monthlyPct);
  if (!Number.isFinite(r) || r <= 0) return null;
  return roundMoney((Math.pow(1 + r / 100, 12) - 1) * 100);
}

// The full per-statement NCB summary: header fields (Part B) plus the positional
// box, the GCT total and the days-in-cycle. Pure; reads only the statement's own
// printed values, never a filename. newBalance comes from the header and is
// cross-checked against the box (they agree); previousBalance comes from the box.
export function parseNcbStatementSummary(lines, sourceFile) {
  const clean = (lines || []).map((l) => String(l).replace(/\s+/g, ' ').trim());
  const header = parseNcbHeader(clean);
  const box = parseNcbSummaryBox(clean);
  const gctTotal = parseNcbGctTotal(clean);
  const daysInCycle = parseNcbDaysInCycle(clean);
  const newBalance = header.newBalance != null ? header.newBalance : box.newBalance;
  const rates = parseNcbPurchaseRates(clean);
  const eair = rates ? effectiveAnnualRateFromMonthly(rates.monthlyPurchasePct) : null;
  return {
    source_file: sourceFile || '',
    cardLast4: header.cardLast4, account: header.cardLast4,
    statementDateRaw: header.statementDateRaw, statementDate: header.statementDate,
    statementKey: header.statementKey, dueDate: header.dueDate,
    newBalance, minimumPayment: header.minimumPayment, creditLimit: header.creditLimit,
    previousBalance: box.previousBalance, purchases: box.purchases, payments: box.payments,
    credits: box.credits, interest: box.interest, otherCharges: box.otherCharges,
    boxNewBalance: box.newBalance, boxComputedNew: box.boxComputedNew, boxPresent: box.present,
    gctTotal, daysInCycle,
    purchaseAnnualPct: rates ? rates.annualPurchasePct : null,
    purchaseMonthlyPct: rates ? rates.monthlyPurchasePct : null,
    eair, eairEstimated: eair != null,
  };
}

// Reconcile an NCB statement. The GATE is the transaction-sum identity:
//   new balance - previous balance == sum of signed billing amounts.
// This is what passes on all twelve statements. The printed box is kept only as
// supporting display: boxOk is true where box == new balance, and boxDifference
// is exactly the GCT on the two statements where the box falls short (560.87
// Dec, 1082.61 Jan). record carries previousBalance, newBalance and the
// signedBillingSum computed from the statement's transactions.
export function reconcileNcbStatement(record) {
  const r = record || {};
  const res = {
    ok: false, checked: false, computedDelta: null, targetDelta: null, difference: null,
    boxChecked: false, boxOk: null, boxDifference: null, break: '',
  };
  if (r.previousBalance == null || r.newBalance == null || r.signedBillingSum == null) {
    res.break = 'summary fields incomplete';
    return res;
  }
  res.checked = true;
  res.targetDelta = roundMoney(r.newBalance - r.previousBalance);
  res.computedDelta = roundMoney(r.signedBillingSum);
  res.difference = roundMoney(res.computedDelta - res.targetDelta);
  res.ok = Math.abs(res.difference) <= 0.01;
  if (r.boxComputedNew != null) {
    res.boxChecked = true;
    res.boxDifference = roundMoney(r.newBalance - r.boxComputedNew);
    res.boxOk = Math.abs(res.boxDifference) <= 0.01;
  }
  if (!res.ok) {
    res.break = `new - previous = ${res.targetDelta.toFixed(2)}, transaction sum ${res.computedDelta.toFixed(2)}`;
  }
  return res;
}

/* ===========================================================================
 *  NCB CREDIT-CARD STATEMENT SUPPORT  (Part D: identity, per-statement record,
 *  dedupe fingerprint)
 *  ---------------------------------------------------------------------------
 *  NCB rows carry NO reference number, so the Scotiabank transactionIdentity
 *  (which leans on the 8-12 digit ref) cannot separate two otherwise-identical
 *  rows. Identity here is stamped from the transaction date, the posting date,
 *  the tidied description and a per-statement position index - stable for the
 *  SAME statement whether it arrives inside the consolidated PDF or as its own
 *  file, so a row dedupes across the two upload styles. The per-statement record
 *  is stored in the EXISTING card-statement store with NO schema change, keyed
 *  by a fingerprint resting on the statement month plus the previous and new
 *  balances, so the consolidated copy and an individual copy of one statement
 *  collapse to a single record.
 *  ======================================================================== */

// Stable identity for one NCB transaction. No reference number exists, so the
// tidied description, both dates, the per-statement position index and the
// statement month stand in for it. The position index is what keeps genuine
// same-day, same-amount, same-merchant duplicates distinct, and because it is
// assigned in statement order it is identical from the consolidated file and
// the individual file, so re-import dedupes correctly.
export function ncbTransactionIdentity(t) {
  const r = t || {};
  const normDesc = String(r.description || '').replace(/\s+/g, ' ').trim().toUpperCase();
  // Discriminator: the parse-time ncbDisc when present. For an unambiguous row
  // that is the legacy per-statement position index, so the hash is byte-
  // identical to before; for a genuine same-key collision it is the raw
  // star/reference token, so the two rows stay distinct regardless of extraction
  // order. Records stored before this field existed carry no ncbDisc and fall
  // back to the position index, keeping their original hash - no re-key, no mass
  // re-add on the next import.
  const disc = (r.ncbDisc != null && r.ncbDisc !== '')
    ? String(r.ncbDisc)
    : (r.posIndex == null ? '' : String(r.posIndex));
  return fnv1a([r.statementKey || '', r.txn_date || '', r.posting_date || '', normDesc, disc].join('|'));
}

// A stable content fingerprint for ONE NCB statement: the statement month plus
// the previous and new balances. The SAME statement produces the SAME hash from
// the consolidated multi-statement PDF and from an individual file, so the
// per-statement record dedupes across both upload styles. Stored in the 'hash'
// keyPath of the existing card-statement store, exactly like cardStatementHash
// for Scotiabank, with no schema change.
export function ncbStatementFingerprint(summary) {
  const s = summary || {};
  const p = s.previousBalance == null ? '' : roundMoney(s.previousBalance).toFixed(2);
  const n = s.newBalance == null ? '' : roundMoney(s.newBalance).toFixed(2);
  return fnv1a([s.statementKey || '', p, n].join('|'));
}

// Build the complete stored artefacts for ONE NCB statement segment: the
// transactions (each stamped with its NCB identity) and one per-statement record
// shaped like the card-statement record the Scotiabank path already stores, so
// it flows through the SAME cardStatements store and the same health/rendering.
// Reconciliation uses the transaction-sum gate; health reuses the existing
// cardStatementHealth. Pure; ingest only adds importedAt.
export function buildNcbStatementRecord(segLines, sourceFile) {
  const parsed = parseOneNcbStatement(segLines, sourceFile);
  const summary = parseNcbStatementSummary(segLines, sourceFile);
  const transactions = parsed.transactions.map((t) => {
    const withKey = { ...t, statementKey: summary.statementKey };
    return { ...withKey, id: ncbTransactionIdentity(withKey) };
  });
  const signedBillingSum = roundMoney(transactions.reduce((a, t) => a + t.amount, 0));
  const recon = reconcileNcbStatement({
    previousBalance: summary.previousBalance, newBalance: summary.newBalance,
    boxComputedNew: summary.boxComputedNew, signedBillingSum,
  });
  const creditAvailable = (summary.creditLimit != null && summary.newBalance != null)
    ? roundMoney(summary.creditLimit - summary.newBalance) : null;
  const health = cardStatementHealth({
    creditLimit: summary.creditLimit, newBalance: summary.newBalance,
    account: summary.cardLast4, statementKey: summary.statementKey,
    minimumPayment: summary.minimumPayment, interestCharges: summary.interest,
    amountOwing: summary.newBalance, creditAvailable,
  });
  const statementRecord = {
    hash: ncbStatementFingerprint(summary),
    source_file: sourceFile || '', account: summary.cardLast4,
    period: summary.statementKey, statementKey: summary.statementKey,
    periodStart: null, periodEnd: null,
    previousBalance: summary.previousBalance, purchases: summary.purchases,
    payments: summary.payments == null ? null : roundMoney(-summary.payments),
    newBalance: summary.newBalance, creditLimit: summary.creditLimit,
    creditAvailable, minimumPayment: summary.minimumPayment,
    amountOwing: summary.newBalance, interestCharges: summary.interest,
    eair: summary.eair, eairEstimated: summary.eairEstimated,
    purchaseAnnualPct: summary.purchaseAnnualPct, purchaseMonthlyPct: summary.purchaseMonthlyPct,
    utilisation: health.utilisation, revolving: health.revolving,
    payingInFull: health.payingInFull, reconciled: recon.ok,
    reconNote: recon.break || '',
  };
  return { summary, transactions, statementRecord, reconciliation: recon };
}
