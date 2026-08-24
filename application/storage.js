// Storage layer for the Personal Finance Analyser: IndexedDB schema, the low-level
// open/transaction/request helpers, and the Store facade the app reads and
// writes through. Moved verbatim out of app.js; bodies are byte-for-byte
// unchanged, with only the `export` keyword added to each top-level binding.
// No DOM is touched here.
import { categoryRuleFromStoreRecord, categoryRuleStoreRecord } from '../settings/category-rules.js';

export const DB_NAME = 'pfa';
// v2 adds the bank-account ledger (a separate store, never mixed with card
// transactions per D1) and the small "my accounts" list for internal-transfer
// resolution. The upgrade only creates the new stores; existing card data,
// statements, rules and meta are untouched.
export const DB_VERSION = 3; // v3 adds the card-statement records store (Recommendations 1-4); additive only.

export function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains('transactions')) db.createObjectStore('transactions', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('statements')) db.createObjectStore('statements', { keyPath: 'hash' });
      if (!db.objectStoreNames.contains('rules')) db.createObjectStore('rules', { keyPath: 'key' });
      if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'key' });
      // Bank ledger (Phase 1): its own stores so the two data shapes never touch.
      if (!db.objectStoreNames.contains('bankTransactions')) db.createObjectStore('bankTransactions', { keyPath: 'id' });
      if (!db.objectStoreNames.contains('bankStatements')) db.createObjectStore('bankStatements', { keyPath: 'hash' });
      // Card statement records (Recommendations 1-4): a per-statement summary
      // with reconciliation + health. Additive; the card transactions store is
      // untouched, so card parsing, totals and identity are unaffected (D2).
      if (!db.objectStoreNames.contains('cardStatements')) db.createObjectStore('cardStatements', { keyPath: 'hash' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}
export function tx(db, store, mode) { return db.transaction(store, mode).objectStore(store); }
export function reqP(r) { return new Promise((res, rej) => { r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error); }); }

export const Store = {
  async allTransactions() { const db = await openDB(); return reqP(tx(db, 'transactions', 'readonly').getAll()); },
  async putTransactions(recs) {
    const db = await openDB(); const s = tx(db, 'transactions', 'readwrite');
    await Promise.all(recs.map((r) => reqP(s.put(r))));
  },
  async clearTransactions() { const db = await openDB(); return reqP(tx(db, 'transactions', 'readwrite').clear()); },
  // Atomic replace: clear + put all in ONE transaction, so the store is never
  // left empty if the app is interrupted mid-write. IndexedDB commits the whole
  // transaction or none of it. Prefer this over a separate clear+put pair.
  async replaceTransactions(records) {
    const db = await openDB(); const s = tx(db, 'transactions', 'readwrite');
    const clearReq = reqP(s.clear());
    const putReqs = records.map((r) => reqP(s.put(r)));
    await Promise.all([clearReq, ...putReqs]);
  },
  async hasStatement(hash) { const db = await openDB(); return !!(await reqP(tx(db, 'statements', 'readonly').get(hash))); },
  async putStatement(rec) { const db = await openDB(); return reqP(tx(db, 'statements', 'readwrite').put(rec)); },
  async allStatements() { const db = await openDB(); return reqP(tx(db, 'statements', 'readonly').getAll()); },
  async deleteStatement(hash) { const db = await openDB(); return reqP(tx(db, 'statements', 'readwrite').delete(hash)); },
  async clearStatements() { const db = await openDB(); return reqP(tx(db, 'statements', 'readwrite').clear()); },
  async allRules() { const db = await openDB(); return (await reqP(tx(db, 'rules', 'readonly').getAll())).map((r) => categoryRuleFromStoreRecord(r)).filter(Boolean); },
  async putRules(recs) {
    const db = await openDB(); const s = tx(db, 'rules', 'readwrite');
    await Promise.all(recs.map((r) => categoryRuleStoreRecord(r)).filter(Boolean).map((r) => reqP(s.put(r))));
  },
  async clearRules() { const db = await openDB(); return reqP(tx(db, 'rules', 'readwrite').clear()); },
  // Atomic replace for rules: clear + put all in ONE transaction (same rationale
  // as replaceTransactions). Rules are stored via categoryRuleStoreRecord, so
  // the same cleaning putRules applies is done here before the puts.
  async replaceRules(recs) {
    const db = await openDB(); const s = tx(db, 'rules', 'readwrite');
    const clearReq = reqP(s.clear());
    const cleaned = recs.map((r) => categoryRuleStoreRecord(r)).filter(Boolean);
    const putReqs = cleaned.map((r) => reqP(s.put(r)));
    await Promise.all([clearReq, ...putReqs]);
  },
  async getMeta(key, dflt) { const db = await openDB(); const v = await reqP(tx(db, 'meta', 'readonly').get(key)); return v ? v.value : dflt; },
  async setMeta(key, value) { const db = await openDB(); return reqP(tx(db, 'meta', 'readwrite').put({ key, value })); },
  // Bank ledger (Phase 1) - separate stores, mirroring the card methods above.
  async allBankTransactions() { const db = await openDB(); return reqP(tx(db, 'bankTransactions', 'readonly').getAll()); },
  async putBankTransactions(recs) { const db = await openDB(); const s = tx(db, 'bankTransactions', 'readwrite'); await Promise.all(recs.map((r) => reqP(s.put(r)))); },
  async clearBankTransactions() { const db = await openDB(); return reqP(tx(db, 'bankTransactions', 'readwrite').clear()); },
  // Atomic replace for the bank ledger: clear + put all in ONE transaction
  // (same rationale as replaceTransactions).
  async replaceBankTransactions(records) {
    const db = await openDB(); const s = tx(db, 'bankTransactions', 'readwrite');
    const clearReq = reqP(s.clear());
    const putReqs = records.map((r) => reqP(s.put(r)));
    await Promise.all([clearReq, ...putReqs]);
  },
  async hasBankStatement(hash) { const db = await openDB(); return !!(await reqP(tx(db, 'bankStatements', 'readonly').get(hash))); },
  async putBankStatement(rec) { const db = await openDB(); return reqP(tx(db, 'bankStatements', 'readwrite').put(rec)); },
  // Card statement records (Recommendations 1-4) - one per statement summary.
  async hasCardStatement(hash) { const db = await openDB(); return !!(await reqP(tx(db, 'cardStatements', 'readonly').get(hash))); },
  async putCardStatement(rec) { const db = await openDB(); return reqP(tx(db, 'cardStatements', 'readwrite').put(rec)); },
  async allCardStatements() { const db = await openDB(); return reqP(tx(db, 'cardStatements', 'readonly').getAll()); },
  async deleteCardStatement(hash) { const db = await openDB(); return reqP(tx(db, 'cardStatements', 'readwrite').delete(hash)); },
  async clearCardStatements() { const db = await openDB(); return reqP(tx(db, 'cardStatements', 'readwrite').clear()); },
  async allBankStatements() { const db = await openDB(); return reqP(tx(db, 'bankStatements', 'readonly').getAll()); },
  // Mirrors deleteStatement/deleteCardStatement above; the bank ledger never
  // had a per-statement delete, only clearBankStatements (a full wipe), which
  // is why "Remove a statement" could never remove a single bank statement.
  async deleteBankStatement(hash) { const db = await openDB(); return reqP(tx(db, 'bankStatements', 'readwrite').delete(hash)); },
  async clearBankStatements() { const db = await openDB(); return reqP(tx(db, 'bankStatements', 'readwrite').clear()); },
};
