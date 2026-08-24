/*
 * manage-data.js  -  the "Manage data" group: reload config, remove a single
 * statement, and clear all data (start over).
 *
 * Stage 3b of the split. These five functions were lifted verbatim from bootUI
 * in app.js and wrapped in a factory that receives the bootUI members they use
 * via ctx, rather than closing over them. Nothing inside the bodies was renamed;
 * only where a name comes from changed. Two sanctioned line edits replace the
 * private pickerEl access, mirroring Stage 2 and Stage 3a: openRemoveStatement
 * and confirmClearAll now call openOverlay(overlay) to show their modal instead
 * of touching the private pickerEl variable directly. removeStatement and
 * doClearAll stay internal (called only by their siblings within the group);
 * the factory returns just the three names app.js still calls from
 * renderManageData: reloadConfig, openRemoveStatement and confirmClearAll.
 */

import { compileRules } from './categorise.js';
import { compileBrandRules } from '../settings/category-rules.js';
import { compileMerchantIntelligence } from '../settings/merchant-intelligence.js';
import { Store } from './storage.js';
import { requireCtx, withConfigDefaults } from './shared-helpers.js';
import { createMerchantResolver } from './merchant-resolver.js';

export function createManageData(ctx) {
  requireCtx(ctx, [
    'state', 'el', '$', 'toast', 'render', 'closePicker', 'openOverlay', 'openModal',
    'persist', 'persistBank', 'applyThemeColours', 'buildCategoryColours',
  ], 'createManageData');
  const { state, el, $, toast, render, closePicker, openOverlay, openModal, persist, persistBank, applyThemeColours, buildCategoryColours } = ctx;

  // Re-fetch config.json (cache-busting) and re-apply everything it drives, then
  // re-render. Presentation only: it never touches stored transactions.
  async function reloadConfig() {
    try {
        const res = await fetch(new URL('../settings/config.json?ts=' + Date.now(), import.meta.url), { cache: 'no-store' });
      const cfg = withConfigDefaults(await res.json());
      state.cfg = cfg;
      state.compiled = compileRules(cfg.categories);
      state.brandRules = compileBrandRules(cfg);
      // Re-fetch and recompile the merchant list too, so a runtime config reload
      // never leaves the merchant grouping and categorisation running on a stale list.
      try {
        const mFile = (cfg.merchants && cfg.merchants.file) || 'jamaica-merchants.json';
        const mRes = await fetch(new URL('../settings/' + mFile + '?ts=' + Date.now(), import.meta.url), { cache: 'no-store' });
        state.merchants = compileMerchantIntelligence(await mRes.json(), cfg);
        const cleanupRules = [];
        for (const r of ((cfg.bankDescriptorCleanup && cfg.bankDescriptorCleanup.rules) || [])) {
          if (!r || !r.pattern) continue;
          try { cleanupRules.push({ pattern: new RegExp(r.pattern, r.flags || 'i'), replacement: r.replacement || '' }); }
          catch { }
        }
        state.resolver = createMerchantResolver({ merchants: state.merchants, cleanupRules });
      } catch { state.merchants = []; state.resolver = null; }
      state.keepUpper = new Set(cfg.keepUpper);
      state.smallWords = new Set(cfg.smallWords);
      applyThemeColours();
      buildCategoryColours();
      render();
      toast('Configuration reloaded.');
    } catch { toast('That configuration file could not be read. Your current settings are unchanged.'); }
  }

  // Remove a single wrongly-imported statement and its transactions. Now
  // lists BOTH ledgers - previously only Store.allStatements() (card) was
  // read, so anyone on the Accounts tab (or with bank-only data) saw "No
  // statements are stored yet." even with bank statements plainly on screen.
  // That was survivable while Manage Data lived only on Cards; now that it
  // renders on every tab, it needs to be honest about every statement stored,
  // not just the card ledger's.
  async function openRemoveStatement() {
    const cardStmts = await Store.allStatements();
    const bankStmts = await Store.allBankStatements();
    if (!cardStmts.length && !bankStmts.length) { toast('No statements are stored yet.'); return; }
    closePicker();
    const byFile = {}; for (const r of state.rows) byFile[r.source_file] = (byFile[r.source_file] || 0) + 1;
    const byBankFile = {}; for (const r of state.bankRecords) byBankFile[r.source_file] = (byBankFile[r.source_file] || 0) + 1;
    const combined = [
      ...cardStmts.map((st) => ({ ...st, ledger: 'card' })),
      ...bankStmts.map((st) => ({ ...st, ledger: 'bank' })),
    ].sort((a, b) => String(b.importedAt || '').localeCompare(String(a.importedAt || '')));
    const list = el('div', { class: 'picker-list' });
    for (const st of combined) {
      const count = st.ledger === 'card' ? (byFile[st.source_file] || 0) : (byBankFile[st.source_file] || 0);
      const ledgerLabel = st.ledger === 'card' ? 'Card' : 'Account';
      list.append(el('div', { class: 'stmt-row' },
        el('div', { class: 'stmt-body' },
          el('div', { class: 'strong' }, `${st.source_file} · ${ledgerLabel}`),
          el('div', { class: 'muted small' }, `${st.period ? st.period + ' · ' : ''}${count} transaction${count === 1 ? '' : 's'}`)),
        el('button', { class: 'btn sm danger', onclick: () => (st.ledger === 'card' ? removeStatement(st) : removeBankStatement(st)) }, 'Remove')));
    }
    const box = el('div', { class: 'picker wide', role: 'dialog', 'aria-label': 'Remove a statement' },
      el('div', { class: 'picker-head' }, 'Remove a statement'),
      el('p', { class: 'muted small' }, 'This drops that statement and its transactions from this device. Re-import the PDF to bring it back. Your category rules are kept.'),
      list,
      el('div', { class: 'picker-actions' }, el('button', { class: 'btn sm ghost', onclick: closePicker }, 'Close')));
    openModal(box);
  }
  async function removeStatement(st) {
    const remaining = state.records.filter((r) => r.source_file !== st.source_file);
    const removed = state.records.length - remaining.length;
    state.records = remaining;
    await Store.deleteStatement(st.hash);
    await persist();
    closePicker(); render();
    toast(`Removed ${st.source_file} and ${removed} transaction${removed === 1 ? '' : 's'}.`);
  }
  // Bank-ledger counterpart to removeStatement, same shape: filter by
  // source_file (the same file-level granularity the card path already uses -
  // a consolidated PDF's transactions carry no finer per-statement link, so
  // this matches existing behaviour rather than introducing a new limitation),
  // delete the per-statement record, persist, refresh the cached statement
  // list, then close and report exactly like the card path does.
  async function removeBankStatement(st) {
    const remaining = state.bankRecords.filter((r) => r.source_file !== st.source_file);
    const removed = state.bankRecords.length - remaining.length;
    state.bankRecords = remaining;
    await Store.deleteBankStatement(st.hash);
    await persistBank();
    state._bankStatements = await Store.allBankStatements();
    closePicker(); render();
    toast(`Removed ${st.source_file} and ${removed} account transaction${removed === 1 ? '' : 's'}.`);
  }

  // Clear everything on this device (guarded). Rules are kept unless the person
  // explicitly chooses otherwise; nothing is wiped as a side effect.
  function confirmClearAll() {
    closePicker();
    const keep = el('label', { class: 'scope' }, el('input', { type: 'checkbox', checked: '' }), ' Keep my category rules');
    const box = el('div', { class: 'picker', role: 'dialog', 'aria-label': 'Clear all data' },
      el('div', { class: 'picker-head' }, 'Clear all data on this device?'),
      el('p', { class: 'muted small' }, 'This removes every transaction and statement from this device, so you will need to re-import your PDFs to rebuild. Export rules or Export history first if you want to keep your work.'),
      el('div', { class: 'picker-scope' }, keep),
      el('div', { class: 'picker-actions' },
        el('button', { class: 'btn sm ghost', onclick: closePicker }, 'Cancel'),
        el('button', { class: 'btn sm danger', onclick: () => doClearAll($('input', keep).checked) }, 'Clear all data')));
    openModal(box);
  }
  async function doClearAll(keepRules) {
    // Clear EVERY ledger, not just the card one. Previously the bank ledger and
    // the card-statement records survived a "start over", so a privacy-first
    // wipe silently kept a person's bank history. All three stores and their
    // in-memory state are cleared together.
    await Store.clearTransactions();
    await Store.clearStatements();
    await Store.clearBankTransactions();
    await Store.clearBankStatements();
    await Store.clearCardStatements();
    if (!keepRules) { state.rules = []; await Store.clearRules(); }
    state.records = [];
    state.bankRecords = []; state._bankStatements = []; state._cardStatements = [];
    // Learned own-account numbers (the card number, the my-accounts list) are
    // derived from imported statements, so they are reset too; user re-learns
    // them on the next import.
    state.cardAccounts = []; state.myAccounts = [];
    await Store.setMeta('bankCardAccounts', []);
    await Store.setMeta('bankMyAccounts', []);
    // Ledger-rule confirmations are also statement-derived: reset them too, so
    // "start over" truly leaves nothing behind.
    state.confirmedIncomeIds = []; state.roundTripIds = [];
    await Store.setMeta('bankConfirmedIncomeIds', []);
    await Store.setMeta('bankRoundTripIds', []);
    // Clear-all polish: reset the per-account selection and the last-imported
    // marker so no stale account or device note lingers after a wipe.
    state.bankAccount = 'all';
    state.lastImportedFrom = null;
    await Store.setMeta('lastImportedFrom', null);
    state.view = 'cards';
    await Store.setMeta('lastLocalUpdate', new Date().toISOString());
    closePicker(); render();
    toast(keepRules ? 'All transactions, statements and account data cleared. Your category rules were kept.' : 'All data cleared. Re-import your PDFs to rebuild.');
  }

  return { reloadConfig, openRemoveStatement, confirmClearAll };
}
