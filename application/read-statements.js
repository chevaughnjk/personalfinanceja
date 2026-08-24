import { fnv1a, toIso, money, monthKey, roundMoney, monthIndex, recurringStatus } from './shared-helpers.js';
import { smartTitle } from './categorise.js';


const CP_LABEL_SET = new Set();

const DATE_RE = /\d{1,2}-[A-Za-z]{3}-\d{4}/;
const AMOUNT_RE = /\$-?[\d,]+\.\d{2}/;
const FULL_LINE = /^(\d{1,2}-[A-Za-z]{3}-\d{4})\s+(\d{1,2}-[A-Za-z]{3}-\d{4})\s+(\d{8,12})\s+(.*?)\s+(\$-?[\d,]+\.\d{2})\s*$/;
const STRANDED_LINE = /^(\d{1,2}-[A-Za-z]{3}-\d{4})\s+(\d{1,2}-[A-Za-z]{3}-\d{4})\s+(\d{8,12})\s+(\$-?[\d,]+\.\d{2})\s*$/;
const TXN_PREFIX = /^\d{1,2}-[A-Za-z]{3}-\d{4}\s+\d{1,2}-[A-Za-z]{3}-\d{4}\s+\d{8,12}\b/;
const HEADER_NO_AMOUNT = /^(\d{1,2}-[A-Za-z]{3}-\d{4})\s+(\d{1,2}-[A-Za-z]{3}-\d{4})\s+(\d{8,12})\s+(\S.*?)\s*$/;
const AMOUNT_END = /\$-?[\d,]+\.\d{2}\s*$/;
const SUMMARY_WORDS = /\b(total|balance|statement|page|summary|opening|closing|minimum|amount owing|previous|new balance|purchases,|payments &)\b/i;
const FOREX = /\(([\d,]+\.\d{2})\s*([A-Z]{3})\)/;

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

export function stripFooterPrefix(desc) {
  const s = String(desc == null ? '' : desc);
  if (!/\d{10,}/.test(s) || !NUMERIC_DATE.test(s)) return s;
  const cut = s.replace(/^.*?\b\d{1,2}-\d{1,2}-\d{4}\b\s*-\s*\b\d{1,2}-\d{1,2}-\d{4}\b\s*-\s*\d+\s+/, '');
  return (cut && cut !== s) ? cut : s;
}

export function isForexFragmentDesc(desc) {
  const s = String(desc == null ? '' : desc).trim();
  if (!s) return true;
  return /^[A-Za-z]{3}\)?$/.test(s) || /^\(?\s*[\d,]+\.\d{2}\s*[A-Za-z]{0,3}\)?$/.test(s);
}

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

const TXN_ANYWHERE = /(\d{1,2}-[A-Za-z]{3}-\d{4})\s+(\d{1,2}-[A-Za-z]{3}-\d{4})\s+(\d{8,12})\s+(?:(.*?)\s+)?(\$-?[\d,]+\.\d{2})\s*$/;
// A description already carrying a closed "(NN.NN CCY)" forex bracket inline.
const COMPLETE_FOREX = /\([\d,]+\.\d{2}\s*[A-Z]{3}\)/;

export function lineContent(line) {
  const s = String(line == null ? '' : line);
  if (isFooterLine(s)) {
    const cut = s.replace(/^.*?\b\d{1,2}-\d{1,2}-\d{4}\b\s*-\s*\b\d{1,2}-\d{1,2}-\d{4}\b\s*-\s*\d+\s+/, '');
    return (cut && cut !== s) ? cut.trim() : '';
  }
  return s.trim();
}

export function isContinuationLine(text) {
  const t = String(text == null ? '' : text).trim();
  if (!t || t === 'JMD') return false;
  if (/\([\d,]+\.\d{2}/.test(t)) return true;   // opens/holds a forex bracket
  if (/[A-Z]{3}\)$/.test(t)) return true;       // "…USD)" or bare "USD)"
  if (/^\S+$/.test(t)) return true;             // a single wrapped tail token
  return false;
}

export function isMerchantFragment(text) {
  const t = String(text == null ? '' : text).trim();
  if (!t || isForexFragmentDesc(t)) return false;
  return /[A-Za-z]/.test(t.replace(/\([\d,]+\.\d{2}.*$/, ''));
}

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

  for (const a of anchors) {
    if (a.desc && !isForexFragmentDesc(a.desc)) continue;
    for (const j of [a.i - 1, a.i + 1]) {
      if (j < 0 || j >= clean.length || isAnchor[j] || consumed[j]) continue;
      const c = lineContent(clean[j]);
      if (isMerchantFragment(c)) { a.desc = mergeForexDescription(c, a.desc || ''); consumed[j] = true; break; }
    }
  }

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

export async function extractLines(arrayBuffer, pdfjs) {
  const doc = await pdfjs.getDocument({ data: arrayBuffer, verbosity: 0 }).promise;
  const lines = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
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

const BMONTHS = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12 };
const BMONTH_ABBR = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];

export function bankStatementPeriod(lines) {
  const text = lines.join('\n');
  const m = /(\d{1,2})([A-Z]{3})(\d{2})\s+to\s+(\d{1,2})([A-Z]{3})(\d{2})/i.exec(text);
  if (!m) return null;
  const sM = BMONTHS[m[2].toLowerCase()], eM = BMONTHS[m[5].toLowerCase()];
  if (!sM || !eM) return null;
  return { startY: 2000 + (+m[3]), startM: sM, startD: +m[1],
           endY: 2000 + (+m[6]), endM: eM, endD: +m[4] };
}


export function bankAccountNumber(lines) {
  for (const l of lines) {
    const m = /withdrawals\s*(?:&|and)\s*deposits\s*\)?\s*-\s*(\d{4,})/i.exec(l);
    if (m) return m[1];
  }
  return '';
}


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
const B_ROW = /^(\d{1,2})([A-Za-z]{3})\b.*?j?\$\s*([\d,]+\.\d{2})(?:\s*([+\-]))?(?:\s*j?\$\s*([\d,]+\.\d{2})|\s*(#?error))?/i;
const B_MONEY = (s) => parseFloat(String(s).replace(/,/g, ''));
export function bankStatementCurrency(lines) {
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


export function isBankNoise(line) {
  const t = String(line || '').trim();
  if (!t) return true;
  if (/opening balance|closing balance/i.test(t)) return true;
  if (/day\s*-?\s*to\s*-?\s*day|savings account|digital|da\s?ytoda|sav\s?ing\s?s|dig\s?ita/i.test(t)) return true;
  if (/scotiabank|www\.|1-888|trademark|page\s+\d|account summary|transactions\s*\(|transaction date|service charge|transactional fee|record keeping|interest rate|gct rate|total charges|enclosures|help us protect|customer profile/i.test(t)) return true;
  if (/^[\d\s]{4,}$/.test(t)) return true; // bare account-number runs incl. spaced "4 2 0 9 0 8"
  return false;
}

const HDR_FRAG = /^(?:dig|ita|sav|ing|day|da|ac|co|un|l|t|s)\s+(?=(?:transfer|trf|\*bns|\*|fcib|interactive|\d))/i;

let _bankCleanupRules = [
  { pattern: /^\*(?:bns\s+)?/i, replacement: '' },
  { pattern: /\s+for\s+\d{1,2}[A-Za-z]{3}\d{2}\s*$/i, replacement: '' },
  { pattern: /\s+jm\s*$/i, replacement: '' },
  { pattern: /\bf\s+inan\.?\s+centre\b/i, replacement: 'Financial Centre' },
  { pattern: /,\s*[A-Z]{4}(?:JM|US|GB|CA|DE|FR|CH|NL|LU|IE|BE|HK|SG|BB|TT|KY|BS)[A-Z0-9]{2}(?:[A-Z0-9]{3})?(?=\s*,|\s*$)/, replacement: '' },
  { pattern: /(?:\s*,\s*(?=[A-Z0-9]*\d)[A-Z0-9]{8,})+\s*$/, replacement: '' },
];

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

export function bankTransactionIdentity(t) {
  const normDesc = String(t.description || '').replace(/\s+/g, ' ').trim().toUpperCase();
  const amt = roundMoney(Number(t.signedAmount) || 0).toFixed(2);
  const bal = t.balanceAfter == null ? '' : roundMoney(t.balanceAfter).toFixed(2);

  const idx = t.sseq == null ? '' : String(t.sseq);
  return fnv1a([t.account || '', t.date, amt, bal, normDesc, idx].join('|'));
}

export function bankStatementHash(st) {
  const ids = (st.transactions || []).map((t) => bankTransactionIdentity(t)).join(',');
  return fnv1a([st.account || '', st.period || '', st.openingBalance, st.closingBalance, ids].join('|'));
}

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


export function counterpartyDigits(desc) {
  const m = String(desc || '').match(/(\d{3,})\s*$/);
  return m ? m[1] : '';
}

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

export function normaliseCounterparty(description, ownIndex = new Map(), resolver = null) {
  const tokens = counterpartyAccountTokens(description);
  for (const t of tokens) {
    if (ownIndex.has(t)) {
      const id = ownIndex.get(t);
      return { key: 'own:' + id, label: 'Account ' + id, internal: true, account: id };
    }
  }

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

export function cardAccountsFromLines(lines) {
  const text = (Array.isArray(lines) ? lines.join('\n') : String(lines == null ? '' : lines));
  const out = new Set();
  const re = /\*{2,}\s*(\d{4})\b/g;    // masked card number: "************1234"
  let m; while ((m = re.exec(text))) out.add(m[1]);
  return [...out];
}

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

export function isCashSelfDeposit(r) {
  if (!r || r.direction !== 'in') return false;
  const t = String(r.type || '').toUpperCase();
  const d = String(r.description || '').toUpperCase();
  if (/\bABM\s*DEPOSIT\b/.test(t) || /\bABM\s*DEPOSIT\b/.test(d)) return true;
  if (/^DEPOSIT$/.test(t.trim())) return true;                 // plain cash lodgement
  if (/\bCASH\s*DEPOSIT\b/.test(t) || /\bCASH\s*DEPOSIT\b/.test(d)) return true;
  return false;
}

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

export function accountClosingBalance(rows) {
  let closing = null;
  const sorted = rows.slice().sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  for (const r of sorted) if (r.balanceAfter != null) closing = r.balanceAfter;
  return closing;
}

export function analyseBankActivity(records, baseCurrency = 'JMD') {
  const byAcct = new Map();
  for (const r of records) {
    const k = r.account || 'unknown';
    if (!byAcct.has(k)) byAcct.set(k, []);
    byAcct.get(k).push(r);
  }
  const accounts = [];        // every account, each carrying its own currency
  const foreignAccounts = []; // the non-base (e.g. USD) accounts, for side-by-side display

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

export function bankCounterpartyGroups(records, baseCurrency = 'JMD') {
  const byKey = new Map();
  for (const r of records) {
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

export function bankMovementKind(r, resolver = null, cfg = {}) {
  if (!r) return 'other';
  if (r.internalTransfer || r.roundTrip) return 'internal';
  if (r.excludedFromIncome) return 'cash-deposit';
  if (r.household) return 'household';
  const catToKind = cfg.categoryToKind || {};
  if (resolver) {
    const m = resolver.resolve(r.description || '', { profile: 'bank' });
    if (m && m.category && !m.incidentalInstitution && catToKind[m.category]) return catToKind[m.category];
  }
  const type = String(r.type || '').toUpperCase();
  for (const rule of (cfg.typeRules || [])) {
    const token = String((rule && rule.match) || '').toUpperCase();
    if (token && type.includes(token)) return rule.kind;
  }
  return r.direction === 'in' ? 'income' : 'payment';
}

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

export function externalOutflowShortlist(records, limit = 10, baseCurrency = 'JMD') {
  const groups = bankCounterpartyGroups(records, baseCurrency)
    .filter((g) => !g.internal && g.moneyOut > 0)
    .sort((a, b) => b.moneyOut - a.moneyOut);
  return (limit > 0 ? groups.slice(0, limit) : groups)
    .map((g) => ({ key: g.key, label: g.label, moneyOut: g.moneyOut, count: g.count, accounts: g.accounts }));
}

export function bankFlowOverTime(records, baseCurrency = 'JMD') {
  const byMonth = new Map();
  for (const r of records) {
    if ((r.currency || baseCurrency) !== baseCurrency) continue; // never mix USD into JMD bars
    const m = (r.date || '').slice(0, 7); if (!m) continue;
    if (!byMonth.has(m)) byMonth.set(m, { month: m, moneyIn: 0, moneyOut: 0, internalIn: 0, internalOut: 0 });
    const row = byMonth.get(m);
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

    if (standingDebitMonthGap([...g.byMonth.keys()]) > maxGapMonths) continue;
    const sorted = amounts.slice().sort((a, b) => a - b);
    const typical = sorted.length % 2 ? sorted[(sorted.length - 1) / 2] : (sorted[sorted.length / 2 - 1] + sorted[sorted.length / 2]) / 2;
    if (typical <= 0) continue;
    const consistent = amounts.filter((a) => Math.abs(a - typical) <= typical * tolerance).length;
    if (consistent >= minMonths) {

      const lastMonth = [...g.byMonth.keys()].sort().pop();
      out.push({
        key: g.key, label: g.label, months: g.byMonth.size, typical: roundMoney(typical),
        lastMonth, status: recurringStatus(lastMonth, latestMonth, maxGapMonths),
      });
    }
  }
  return out.sort((a, b) => b.typical - a.typical);
}


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

export function cardMoney(s) {
  const m = String(s == null ? '' : s).match(/-?[\d, ]+\.\d{2}/);
  return m ? parseFloat(m[0].replace(/[, ]/g, '')) : null;
}


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

export function cardStatementHash(summary) {
  const s = summary || {};
  return fnv1a([s.account || '', s.statementKey || s.periodText || '', s.previousBalance, s.purchases, s.payments, s.newBalance].join('|'));
}

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


export function linkCardPayments(bankPayments, cardPayments, opts = {}) {
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

export function assignCardStatementKeys(cardTxns, statements) {
  const periods = (statements || []).filter((s) => s.periodStart && s.periodEnd)
    .map((s) => ({ start: s.periodStart, end: s.periodEnd, key: s.statementKey }));
  return (cardTxns || []).map((t) => {
    const d = t.date || t.txn_date || '';
    const hit = periods.find((p) => d >= p.start && d <= p.end);
    return { ...t, statementKey: hit ? hit.key : (d ? d.slice(0, 7) : '') };
  });
}


export function transactionIdentity(t) {
  const normDesc = String(t.description || '').replace(/\s+/g, ' ').trim().toUpperCase();
  const amt = roundMoney(Number(t.amount) || 0).toFixed(2);
  return fnv1a([t.txn_date, amt, t.ref, normDesc].join('|'));
}

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

const NCB_PRIMARY = /^(\d{8})\s+(?:XXXX\s*\d{2,}|\d{6,})\s+([\d,]+\.\d{2})\s+([\d,]+\.\d{2})\s+(\d{8})\s*$/;
const NCB_SECONDARY = /^\d{8}\s+\*{2,}[\s*]*?(\d{4})\s+(\d{4,6})\s+1-8\d\d/;
const NCB_ROW = /^(\d{4})\s+(.+?)\s+([\d,]+\.\d{2}-?)\s+([\d,]+\.\d{2}-?)\s*$/;
const NCB_HEADER_WORDS = /\b(?:POSTING|TRANSACTION|TRANSACTIO|DESCRIPTION|BILLING|AMOUNT|DATE|N)\b/g;

export function ncbAmount(token) {
  const t = String(token == null ? '' : token).trim();
  const neg = /-\s*$/.test(t);
  const n = parseFloat(t.replace(/[,\s-]/g, ''));
  if (Number.isNaN(n)) return null;
  return neg ? -n : n;
}

export function ncbSplitRunon(line) {
  const s = String(line == null ? '' : line);
  return s.replace(/([\d,]+\.\d{2}-?)(\d{4}\s+\d{4}\s+\S)/g, '$1\n$2').split('\n');
}

export function ncbTidyDescription(desc) {
  let s = String(desc == null ? '' : desc);
  s = s.replace(/\*\S+/g, '');
  s = s.replace(/\s{2,}/g, ' ').trim();
  s = s.replace(/ - /, ', ');
  return s.trim();
}

function ncbForeignTag(amount) {
  const v = Math.abs(Number(amount) || 0);
  return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' FX';
}

export function makeNcbDateResolver(statementYear, statementMonth, statementDay) {
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

  const ncbSig = (t) => [t.txn_date, t.posting_date, String(t.description || '').replace(/\s+/g, ' ').trim().toUpperCase(), roundMoney(t.amount).toFixed(2)].join('|');
  const ncbGroupCount = new Map();
  for (const t of transactions) ncbGroupCount.set(ncbSig(t), (ncbGroupCount.get(ncbSig(t)) || 0) + 1);
  for (const t of transactions) {
    t.ncbDisc = ncbGroupCount.get(ncbSig(t)) > 1 ? ('r:' + String(t.ncbRefRaw || '')) : String(t.posIndex);
  }
  return { ...header, source_file: sourceFile || '', transactions };
}

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

export function parseNcbGctTotal(lines) {
  const clean = (lines || []).map((l) => String(l));
  for (const l of clean) {
    const m = /G\.C\.T\s*Total:\s*\$?\s*([\d,]+\.\d{2})/i.exec(l);
    if (m) return roundMoney(parseFloat(m[1].replace(/,/g, '')));
  }
  return null;
}

export function parseNcbDaysInCycle(lines) {
  const clean = (lines || []).map((l) => String(l).replace(/\s+/g, ' ').trim());
  for (const l of clean) {
    const m = /^(\d{1,3})\s+\d+\.\d{3}\s+\d+\.\d{3}/.exec(l);
    if (m) { const d = +m[1]; if (d > 0 && d <= 366) return d; }
  }
  return null;
}

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

export function ncbTransactionIdentity(t) {
  const r = t || {};
  const normDesc = String(r.description || '').replace(/\s+/g, ' ').trim().toUpperCase();
  const disc = (r.ncbDisc != null && r.ncbDisc !== '')
    ? String(r.ncbDisc)
    : (r.posIndex == null ? '' : String(r.posIndex));
  return fnv1a([r.statementKey || '', r.txn_date || '', r.posting_date || '', normDesc, disc].join('|'));
}

export function ncbStatementFingerprint(summary) {
  const s = summary || {};
  const p = s.previousBalance == null ? '' : roundMoney(s.previousBalance).toFixed(2);
  const n = s.newBalance == null ? '' : roundMoney(s.newBalance).toFixed(2);
  return fnv1a([s.statementKey || '', p, n].join('|'));
}

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
