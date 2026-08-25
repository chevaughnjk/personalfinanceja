import { fnv1a } from '../core/shared-helpers.js';

/* ===========================================================================
 * 8) Encrypted history file  (export / import; AES-GCM + PBKDF2)
 * ---------------------------------------------------------------------------
 * One file carries the transactions and the small change metadata needed to
 * merge cleanly. The passphrase is set once and supplied again on import.
 * A passphrase cannot be recovered; a wrong one simply fails to open the file.
 * ======================================================================== */

// v1 carried card transactions only. v2 also carries the bank ledger and the
// card-statement records, so a device move keeps the WHOLE picture, not just
// card transactions. Both magics import: a v1 file simply has no bank/card
// bundle, so nothing bank-side is brought in (backward compatible).
const HISTORY_MAGIC = 'CCAHIST1';
const HISTORY_MAGIC_V2 = 'CCAHIST2';
// PBKDF2 work factor for the encrypted history file. Written into every
// exported envelope (iterations) and read back at import, so this value can be
// raised over time without breaking files created with an older count: each
// file is always decrypted with whatever count it was actually encrypted with.
const PBKDF2_ITERATIONS_DEFAULT = 600000;

function getCrypto() {
  const c = typeof globalThis !== 'undefined' && globalThis.crypto ? globalThis.crypto : null;
  if (!c || !c.subtle) throw new Error('WebCrypto is not available in this environment.');
  return c;
}
function b64(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoaSafe(s);
}
function unb64(str) {
  const s = atobSafe(str);
  const a = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i);
  return a;
}
function btoaSafe(s) {
  return typeof btoa === 'function' ? btoa(s) : Buffer.from(s, 'binary').toString('base64');
}
function atobSafe(s) {
  return typeof atob === 'function' ? atob(s) : Buffer.from(s, 'base64').toString('binary');
}

async function deriveKey(passphrase, salt, iterations) {
  const crypto = getCrypto();
  const enc = new TextEncoder();
  const base = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, [
    'deriveKey',
  ]);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

// `bundle` (optional, backward compatible) carries the bank ledger and the
// card-statement records alongside the card transactions, so all three ledgers
// travel in the one encrypted file. Old callers that pass three arguments still
// work: the bundle defaults to empty and the file is a valid card-only export.
export async function exportHistory(records, meta, passphrase, bundle = {}) {
  const crypto = getCrypto();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(passphrase, salt, PBKDF2_ITERATIONS_DEFAULT);
  const payload = new TextEncoder().encode(
    JSON.stringify({
      magic: HISTORY_MAGIC_V2,
      exportedAt: new Date().toISOString(),
      meta: meta || {},
      records,
      rules: bundle.rules || [],
      ledgerRules: {
        confirmedIncomeIds: bundle.confirmedIncomeIds || [],
        sharedAccounts: bundle.sharedAccounts || [],
        householdPayees: bundle.householdPayees || [],
      },
      profile: {
        firstName: bundle.firstName || null,
        // Round 4: the goal is a personal intention, portable across devices
        // like firstName; goalLog travels alongside it so a device move never
        // loses the honest monthly record already built up.
        goal: bundle.goal || null,
        goalLog: Array.isArray(bundle.goalLog) ? bundle.goalLog : [],
      },
      bank: {
        transactions: bundle.bankRecords || [],
        statements: bundle.bankStatements || [],
        cardStatements: bundle.cardStatements || [],
        myAccounts: bundle.myAccounts || [],
        cardAccounts: bundle.cardAccounts || [],
      },
    })
  );
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, payload));
  const dataB64 = b64(cipher);
  return JSON.stringify({
    format: HISTORY_MAGIC,
    kdf: 'PBKDF2-SHA256',
    iterations: PBKDF2_ITERATIONS_DEFAULT,
    salt: b64(salt),
    iv: b64(iv),
    data: dataB64,
    checksum: fnv1a(dataB64),
  });
}

export async function importHistory(fileText, passphrase) {
  const crypto = getCrypto();
  let env;
  try {
    env = JSON.parse(fileText);
  } catch {
    throw new Error('This does not look like a history file.');
  }
  if (
    !env ||
    env.format !== HISTORY_MAGIC ||
    typeof env.salt !== 'string' ||
    typeof env.iv !== 'string' ||
    typeof env.data !== 'string'
  ) {
    throw new Error('This does not look like a history file.');
  }
  if (typeof env.checksum === 'string' && env.checksum !== fnv1a(env.data)) {
    throw new Error(
      'This backup file looks corrupted or was not fully transferred. Get a fresh copy and try again.'
    );
  }
  // Read the iteration count the file was actually encrypted with. A genuinely
  // old file that predates this field, or one carrying a missing/invalid value,
  // falls back to the default so the count is never undefined or NaN.
  const fileIters = Number(env.iterations);
  const iterations =
    Number.isFinite(fileIters) && fileIters > 0 ? fileIters : PBKDF2_ITERATIONS_DEFAULT;
  let salt, iv, cipher;
  try {
    salt = unb64(env.salt);
    iv = unb64(env.iv);
    cipher = unb64(env.data);
  } catch {
    throw new Error(
      'This backup file looks corrupted or was not fully transferred. Get a fresh copy and try again.'
    );
  }
  if (!salt.length || !iv.length || !cipher.length) {
    throw new Error(
      'This backup file looks corrupted or was not fully transferred. Get a fresh copy and try again.'
    );
  }
  const key = await deriveKey(passphrase, salt, iterations);
  let plain;
  try {
    plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher);
  } catch {
    throw new Error('That passphrase did not open the file. Check it and try again.');
  }
  let obj;
  try {
    obj = JSON.parse(new TextDecoder().decode(plain));
  } catch {
    throw new Error(
      'This backup file looks corrupted or was not fully transferred. Get a fresh copy and try again.'
    );
  }
  if (!obj || !Array.isArray(obj.records)) {
    throw new Error(
      'This backup file looks corrupted or was not fully transferred. Get a fresh copy and try again.'
    );
  }
  const bank = obj.bank || {};
  const ledgerRules = obj.ledgerRules || {};
  const profile = obj.profile || {};
  return {
    records: obj.records || [],
    meta: obj.meta || {},
    exportedAt: obj.exportedAt,
    rules: Array.isArray(obj.rules) ? obj.rules : [],
    ledgerRules: {
      confirmedIncomeIds: Array.isArray(ledgerRules.confirmedIncomeIds)
        ? ledgerRules.confirmedIncomeIds
        : [],
      sharedAccounts: Array.isArray(ledgerRules.sharedAccounts) ? ledgerRules.sharedAccounts : [],
      householdPayees: Array.isArray(ledgerRules.householdPayees)
        ? ledgerRules.householdPayees
        : [],
    },
    profile: {
      firstName: typeof profile.firstName === 'string' ? profile.firstName : null,
      goal: profile.goal && typeof profile.goal === 'object' ? profile.goal : null,
      goalLog: Array.isArray(profile.goalLog) ? profile.goalLog : [],
    },
    bank: {
      transactions: bank.transactions || [],
      statements: bank.statements || [],
      cardStatements: bank.cardStatements || [],
      myAccounts: bank.myAccounts || [],
      cardAccounts: bank.cardAccounts || [],
    },
  };
}
