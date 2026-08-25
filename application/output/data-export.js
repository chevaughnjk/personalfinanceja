/*
 * data-export.js  -  the "get your data out or back in" group: CSV export
 * (current view / all), personal category-rule export & import, and the
 * encrypted full-history backup export & import - plus the little export-menu
 * open/close plumbing (toggleExportMenu / onDocClickMenu) that lives beside
 * these triggers.
 *
 * Stage 3c-i of the split. This file is the STATEFUL ORCHESTRATION HALF of the
 * pure serialisers that live in csv-export.js: toCSV / bankToCSV (the CSV
 * writers) and, in history-codec.js, exportHistory / importHistory (the
 * AES-GCM backup lock-and-key) are pure, bootUI-free transforms; the functions
 * here are what a button click runs - they read state, invoke those pure
 * serialisers, drive a file download or a file read, and show a toast.
 * Orchestration versus pure transformation is why this half needs a factory
 * wrapper closing over bootUI members and those pure files do not. The pairing
 * mirrors the ones already established: manage-data.js / storage.js and
 * accounts-render.js / read-statements.js.
 *
 * These functions were lifted verbatim from bootUI in app.js and wrapped
 * in a factory that receives the bootUI members they use via ctx, rather than
 * closing over them. Nothing inside the bodies was renamed; only where a name
 * comes from changed. currentBankViewRows lives with the print-model group in
 * reporting.js (createPrintReports) and is passed in as a function reference,
 * so this file calls it without owning it. today() is
 * a tiny date helper with no bootUI dependency, so it is defined locally here
 * rather than injected. askPassphrase, downloadFile and onDocClickMenu stay
 * internal (called only by their siblings within the group); the factory
 * returns the names wireChrome and printReport still call from app.js.
 */

import {
  bankToCSV,
  toCSV,
  bankToDetailedCSV,
  toDetailedCSV,
  buildUnknownMerchantsCSV,
  csvEscape,
  bankRowToCsvFields,
} from '../output/csv-export.js';
import { exportHistory, importHistory } from '../output/history-codec.js';
import {
  exportCategoryRulesFile,
  parseCategoryRulesFile,
  mergeCategoryRules,
} from '../../settings/category-rules.js';
import {
  mergeTransactions,
  mergeBankTransactions,
  cleanBankCounterparty,
} from '../statements/read-statements.js';
import { Store } from '../core/storage.js';
import { requireCtx, DEV_SIGNATURE } from '../core/shared-helpers.js';

export function createDataExport(ctx) {
  requireCtx(
    ctx,
    [
      'state',
      '$',
      'el',
      'toast',
      'render',
      'persist',
      'persistRules',
      'persistBank',
      'persistLedgerRules',
      'classifiedBank',
      'visibleRows',
      'defaultDataView',
      'currentBankViewRows',
      'openModal',
      'closePicker',
    ],
    'createDataExport'
  );
  const {
    state,
    $,
    el,
    toast,
    render,
    persist,
    persistRules,
    persistBank,
    persistLedgerRules,
    classifiedBank,
    visibleRows,
    defaultDataView,
    currentBankViewRows,
    openModal,
    closePicker,
  } = ctx;

  // One shared filename builder for every export this module produces, so
  // every file a person downloads reads the same way in Downloads: the ISO
  // date leads (files then sort chronologically with zero effort - the
  // standard reason to lead a filename with YYYY-MM-DD), followed by plain
  // English, with scope and tier called out the same way every time.
  // Replaces the old "finance-<ledger>-<scope>-<date>.csv" convention (e.g.
  // "finance-cards-all-2026-08-22.csv"), technically correct but read like an
  // internal slug rather than something a person chose to name.
  function exportFilename(label, { scope = null, detailed = false, ext = 'csv' } = {}) {
    const tier = detailed ? ' - Detailed' : '';
    const scopeText = scope ? ` (${scope === 'current' ? 'Filtered' : 'All'})` : '';
    return `${today()} ${label}${tier}${scopeText}.${ext}`;
  }

  function toggleExportMenu(force) {
    const m = $('#export-menu');
    if (!m) return;
    const show = force != null ? force : m.hidden;
    m.hidden = !show;
    if (show)
      setTimeout(() => document.addEventListener('click', onDocClickMenu, { once: true }), 0);
  }
  function onDocClickMenu(e) {
    if (!e.target.closest('#export-menu') && !e.target.closest('#export-btn'))
      toggleExportMenu(false);
    else document.addEventListener('click', onDocClickMenu, { once: true });
  }

  // The CSV scope × detail choice used to be four separately-worded menu
  // lines that a person had to read word-by-word to tell apart, since they
  // differ only in two independent axes flattened into prose. This reuses
  // the SAME .picker/.picker-scope/.scope classes confirmClearAll's "Keep my
  // category rules" checkbox already uses. The four underlying export
  // functions are unchanged; this dialog only decides which one to call.
  function openCsvExportDialog() {
    toggleExportMenu(false);
    let scope = 'current';
    let detailed = false;
    const scopeCurrent = el(
      'label',
      { class: 'scope' },
      el('input', {
        type: 'radio',
        name: 'csv-scope',
        checked: '',
        onchange: () => {
          scope = 'current';
        },
      }),
      ' Current view'
    );
    const scopeAll = el(
      'label',
      { class: 'scope' },
      el('input', {
        type: 'radio',
        name: 'csv-scope',
        onchange: () => {
          scope = 'all';
        },
      }),
      ' All transactions'
    );
    const detailedCheck = el(
      'label',
      { class: 'scope' },
      el('input', {
        type: 'checkbox',
        onchange: (e) => {
          detailed = e.target.checked;
        },
      }),
      ' Include detailed columns (raw statement text, category confidence, grouping keys)'
    );
    const box = el(
      'div',
      {
        class: 'picker',
        role: 'dialog',
        'aria-label': 'Export transactions as CSV',
      },
      el('div', { class: 'picker-head' }, 'Export transactions (CSV)'),
      el('div', { class: 'picker-scope' }, scopeCurrent, scopeAll, detailedCheck),
      el(
        'div',
        { class: 'picker-actions' },
        el('button', { class: 'btn sm ghost', onclick: closePicker }, 'Cancel'),
        el(
          'button',
          {
            class: 'btn sm',
            onclick: () => {
              closePicker();
              if (scope === 'current') {
                detailed ? exportCurrentDetailedCSV() : exportCurrentCSV();
              } else {
                detailed ? exportAllDetailedCSV() : exportAllCSV();
              }
            },
          },
          'Export'
        )
      )
    );
    openModal(box);
  }

  // The Overview is the consolidated view, so its CSV carries BOTH ledgers as
  // two clearly separated, separately-headed sections in one file (the CSV
  // analogue of separate tabs). No merged total is produced, so the two ledgers
  // stay apart (D1). toCSV / bankToCSV are the same pure serialisers the
  // single-ledger exports use.
  function combinedCSV(cardRows, bankRecs, code) {
    const head = [
      'Ledger',
      'Date',
      'Account',
      'Description',
      'Category',
      'Type',
      'Flow',
      'Amount',
      'Currency',
      'Running Balance',
      'Statement',
      'Foreign',
    ];
    const lines = [head.map(csvEscape).join(',')];
    for (const r of cardRows) {
      const desc = r.displayName || r.description;
      lines.push(
        [
          'Card',
          r.date,
          '',
          desc,
          r.category,
          r.kind,
          '',
          r.amount.toFixed(2),
          code,
          '',
          r.source_file,
          r.foreign || '',
        ]
          .map(csvEscape)
          .join(',')
      );
    }
    for (const r of bankRecs) {
      const { flow, signed, bal, cp } = bankRowToCsvFields(r, code);
      lines.push(
        [
          'Account',
          r.date,
          r.account || '',
          cp,
          '',
          '',
          flow,
          signed,
          r.currency || code,
          bal,
          r.source_file || '',
          '',
        ]
          .map(csvEscape)
          .join(',')
      );
    }
    return lines.join('\n') + '\n';
  }

  // The Detailed counterpart to combinedCSV: full traceability for BOTH
  // ledgers in one file - raw text, every cleaning stage, and each ledger's
  // own internal grouping key (merchantGroup for cards, counterpartyKey for
  // accounts) - so Overview gets the same Clean/Detailed choice as each
  // single ledger, rather than being stuck on one tier. Blank where a column
  // does not apply to that ledger, the same pattern combinedCSV already uses.
  function combinedDetailedCSV(cardRows, bankRecs, code) {
    const head = [
      'Ledger',
      'Date',
      'Account',
      'Reference',
      'Raw Description',
      'Cleaned Description',
      'Counterparty / Merchant',
      'Group',
      'Category',
      'Category Confidence',
      'Internal Transfer',
      'Type',
      'Flow',
      'Amount',
      'Currency',
      'Running Balance',
      'Foreign',
      'Statement',
    ];
    const lines = [head.map(csvEscape).join(',')];
    for (const r of cardRows) {
      lines.push(
        [
          'Card',
          r.date,
          '',
          r.ref || '',
          r.raw_description,
          r.description,
          r.displayName || r.description,
          r.merchantGroup || '',
          r.category,
          r.confidence,
          '',
          r.kind,
          '',
          r.amount.toFixed(2),
          code,
          '',
          r.foreign || '',
          r.source_file,
        ]
          .map(csvEscape)
          .join(',')
      );
    }
    for (const r of bankRecs) {
      const { flow, signed, bal, cp } = bankRowToCsvFields(r, code);
      lines.push(
        [
          'Account',
          r.date,
          r.account || '',
          '',
          r.description,
          cleanBankCounterparty(r.description),
          cp,
          r.counterpartyKey || '',
          '',
          '',
          r.internalTransfer ? 'Yes' : 'No',
          r.type || '',
          flow,
          signed,
          r.currency || code,
          bal,
          '',
          r.source_file || '',
        ]
          .map(csvEscape)
          .join(',')
      );
    }
    return lines.join('\n') + '\n';
  }

  // CSV export follows the ledger on screen. In the Accounts view it writes the
  // bank ledger (with flow and running balance); otherwise the card ledger. The
  // Overview writes both ledgers as two labelled sections in one file.
  // Labels correspond directly to the app's own tab names (Overview / Cards /
  // Accounts, per LABELS in renderLedgerSwitch), with "Transactions" added
  // where the tab name alone would not make clear this is the underlying
  // data rather than a screenshot of the dashboard.
  function exportLabel() {
    if (state.view === 'overview') return 'Overview';
    if (state.view === 'accounts') return 'Account Transactions';
    return 'Card Transactions';
  }

  function exportCurrentCSV() {
    toggleExportMenu(false);
    if (state.view === 'overview') {
      const card = visibleRows();
      const bank = currentBankViewRows();
      downloadFile(
        exportFilename(exportLabel(), { scope: 'current' }),
        combinedCSV(card, bank, state.cfg.currency.code),
        'text/csv'
      );
      toast(
        `Saved this view: ${card.length} card and ${bank.length} account transaction${card.length + bank.length === 1 ? '' : 's'}.`
      );
      return;
    }
    if (state.view === 'accounts' && state.bankRecords.length) {
      const recs = currentBankViewRows();
      const n = recs.length;
      downloadFile(
        exportFilename(exportLabel(), { scope: 'current' }),
        bankToCSV(recs, state.cfg.currency.code),
        'text/csv'
      );
      toast(`Saved ${n} account transaction${n === 1 ? '' : 's'} as CSV.`);
      return;
    }
    const n = visibleRows().length;
    downloadFile(
      exportFilename(exportLabel(), { scope: 'current' }),
      toCSV(visibleRows(), state.cfg.currency.code),
      'text/csv'
    );
    toast(`Saved ${n} transaction${n === 1 ? '' : 's'} as CSV.`);
  }
  function exportAllCSV() {
    toggleExportMenu(false);
    if (state.view === 'overview') {
      const card = state.rows;
      const bank = classifiedBank();
      downloadFile(
        exportFilename(exportLabel(), { scope: 'all' }),
        combinedCSV(card, bank, state.cfg.currency.code),
        'text/csv'
      );
      toast(
        `Saved all: ${card.length} card and ${bank.length} account transaction${card.length + bank.length === 1 ? '' : 's'}.`
      );
      return;
    }
    if (state.view === 'accounts' && state.bankRecords.length) {
      const recs = classifiedBank();
      const n = recs.length;
      downloadFile(
        exportFilename(exportLabel(), { scope: 'all' }),
        bankToCSV(recs, state.cfg.currency.code),
        'text/csv'
      );
      toast(`Saved all ${n} account transaction${n === 1 ? '' : 's'} as CSV.`);
      return;
    }
    const n = state.rows.length;
    downloadFile(
      exportFilename(exportLabel(), { scope: 'all' }),
      toCSV(state.rows, state.cfg.currency.code),
      'text/csv'
    );
    toast(`Saved all ${n} transaction${n === 1 ? '' : 's'} as CSV.`);
  }

  // Detailed tier: same view-aware branching as the Clean exports above,
  // calling each ledger's Detailed serialiser instead. A person reaches this
  // through a second, clearly separate menu action - never the default - so
  // the raw statement text and reference numbers never surface unless
  // deliberately asked for.
  function exportCurrentDetailedCSV() {
    toggleExportMenu(false);
    if (state.view === 'overview') {
      const card = visibleRows();
      const bank = currentBankViewRows();
      downloadFile(
        exportFilename(exportLabel(), { scope: 'current', detailed: true }),
        combinedDetailedCSV(card, bank, state.cfg.currency.code),
        'text/csv'
      );
      toast(
        `Saved detailed view: ${card.length} card and ${bank.length} account transaction${card.length + bank.length === 1 ? '' : 's'}.`
      );
      return;
    }
    if (state.view === 'accounts' && state.bankRecords.length) {
      const recs = currentBankViewRows();
      const n = recs.length;
      downloadFile(
        exportFilename(exportLabel(), { scope: 'current', detailed: true }),
        bankToDetailedCSV(recs, state.cfg.currency.code),
        'text/csv'
      );
      toast(`Saved ${n} detailed account transaction${n === 1 ? '' : 's'} as CSV.`);
      return;
    }
    const n = visibleRows().length;
    downloadFile(
      exportFilename(exportLabel(), { scope: 'current', detailed: true }),
      toDetailedCSV(visibleRows(), state.cfg.currency.code),
      'text/csv'
    );
    toast(`Saved ${n} detailed transaction${n === 1 ? '' : 's'} as CSV.`);
  }
  function exportAllDetailedCSV() {
    toggleExportMenu(false);
    if (state.view === 'overview') {
      const card = state.rows;
      const bank = classifiedBank();
      downloadFile(
        exportFilename(exportLabel(), { scope: 'all', detailed: true }),
        combinedDetailedCSV(card, bank, state.cfg.currency.code),
        'text/csv'
      );
      toast(
        `Saved all detailed: ${card.length} card and ${bank.length} account transaction${card.length + bank.length === 1 ? '' : 's'}.`
      );
      return;
    }
    if (state.view === 'accounts' && state.bankRecords.length) {
      const recs = classifiedBank();
      const n = recs.length;
      downloadFile(
        exportFilename(exportLabel(), { scope: 'all', detailed: true }),
        bankToDetailedCSV(recs, state.cfg.currency.code),
        'text/csv'
      );
      toast(`Saved all ${n} detailed account transaction${n === 1 ? '' : 's'} as CSV.`);
      return;
    }
    const n = state.rows.length;
    downloadFile(
      exportFilename(exportLabel(), { scope: 'all', detailed: true }),
      toDetailedCSV(state.rows, state.cfg.currency.code),
      'text/csv'
    );
    toast(`Saved all ${n} detailed transaction${n === 1 ? '' : 's'} as CSV.`);
  }

  // Contribute-back export (Manage Data, not the Export menu): a lightweight
  // feedback loop for merchant-intelligence gaps. Uses buildUnknownMerchantsCSV
  // (csv-export.js) over state.rows - whole history, no period scoping - so this
  // reflects total coverage rather than one month's view.
  function exportUnknownMerchants() {
    const { csv, count } = buildUnknownMerchantsCSV(state.rows, state.cfg.special.fallback);
    if (!count) {
      toast('No unrecognised merchants to send right now.');
      return;
    }
    downloadFile(exportFilename('Unrecognised Merchants'), csv, 'text/csv');
    toast(
      `Saved ${count} unrecognised merchant${count === 1 ? '' : 's'}. Feel free to remove any you don't want to include before sending.`
    );
  }

  function exportRules() {
    toggleExportMenu(false);
    if (!state.rules.length) {
      toast('No personal rules have been saved yet.');
      return;
    }
    downloadFile(
      exportFilename('Category Rules', { ext: 'json' }),
      exportCategoryRulesFile(state.rules),
      'application/json'
    );
    toast(`Exported ${state.rules.length} personal rule${state.rules.length === 1 ? '' : 's'}.`);
  }
  async function importRules(e) {
    const input = e.currentTarget;
    const file = input.files[0];
    if (!file) return;
    let parsed;
    try {
      parsed = parseCategoryRulesFile(await file.text());
    } catch (err) {
      toast(err.message);
      input.value = '';
      return;
    }
    if (!parsed.rules.length) {
      toast('No usable rules were found in that file.');
      input.value = '';
      return;
    }
    const beforeRows = state.rows.slice();
    const merged = mergeCategoryRules(state.rules, parsed.rules);
    state.rules = merged.rules;
    await persistRules();
    render();
    const beforeById = new Map(beforeRows.map((r) => [r.id, r.category]));
    const affected = state.rows.filter((r) => beforeById.get(r.id) !== r.category).length;
    const importedCount = merged.inserted + merged.updated;
    const skippedText = parsed.skipped
      ? ` · skipped ${parsed.skipped} malformed entr${parsed.skipped === 1 ? 'y' : 'ies'}`
      : '';
    toast(
      `Imported ${importedCount} rule${importedCount === 1 ? '' : 's'} and updated ${affected} transaction${affected === 1 ? '' : 's'}${skippedText}.`
    );
    input.value = '';
  }

  async function doExportHistory() {
    toggleExportMenu(false);
    const pass = await askPassphrase(
      'Set a passphrase for this history file. You will enter the same one when importing on the other device. It cannot be recovered.',
      { confirm: true }
    );
    if (!pass) return;
    const isMockData = !!(await Store.getMeta('mockPersonaLoaded', null));
    const meta = {
      device: isMockData ? DEV_SIGNATURE : state.deviceId,
      exportedAt: new Date().toISOString(),
      count: state.records.length,
    };
    // Carry ALL ledgers in the one file: card transactions, the bank ledger and
    // its statement records, the card-statement records, and the learned
    // own-account lists. A device move now keeps the whole picture.
    const bundle = {
      bankRecords: state.bankRecords || [],
      bankStatements: state._bankStatements || [],
      cardStatements: state._cardStatements || [],
      myAccounts: state.myAccounts || [],
      cardAccounts: state.cardAccounts || [],
      rules: state.rules || [],
      confirmedIncomeIds: state.confirmedIncomeIds || [],
      sharedAccounts: state.sharedAccounts || [],
      householdPayees: state.householdPayees || [],
      firstName: state.firstName || null,
      goal: state.goal || null,
      goalLog: state.goalLog || [],
    };
    const text = await exportHistory(state.records, meta, pass, bundle);
    downloadFile(
      exportFilename('Encrypted History Backup', { ext: 'ccah' }),
      text,
      'application/octet-stream'
    );
    toast('History file created. Move it to your other device, then Import history there.');
  }
  async function doImportHistory(e) {
    const input = e.currentTarget;
    const file = input.files[0];
    if (!file) return;
    const pass = await askPassphrase('Enter the passphrase you set when exporting this file.');
    if (!pass) {
      input.value = '';
      return;
    }
    let data;
    try {
      data = await importHistory(await file.text(), pass);
    } catch (err) {
      toast(err.message);
      input.value = '';
      return;
    }
    const sourceDevice = (data.meta && data.meta.device) || 'another device';
    const importedAt = new Date().toISOString();
    const tag = (raw) => ({
      ...raw,
      importedFrom: raw.importedFrom || sourceDevice,
      importedAt: raw.importedAt || importedAt,
    });
    const hadCardBefore = state.records.length > 0;
    const hadBankBefore = state.bankRecords.length > 0;
    const merged = mergeTransactions(state.records, (data.records || []).map(tag));
    state.records = merged.records;
    await persist();
    // Bring in the bank ledger and card-statement records too (v2 files). A v1
    // file simply carries none, so nothing bank-side changes.
    let bankAdded = 0;
    const bank = data.bank || {};
    const bankTx = (bank.transactions || []).map(tag);
    if (bankTx.length) {
      const bmerged = mergeBankTransactions(state.bankRecords, bankTx);
      state.bankRecords = bmerged.records;
      bankAdded = bmerged.added;
      await persistBank();
    }
    let addedBankStatements = false;
    for (const st of bank.statements || []) {
      if (st && st.hash && !(await Store.hasBankStatement(st.hash))) {
        await Store.putBankStatement(st);
        addedBankStatements = true;
      }
    }
    let addedCardStatements = false;
    for (const cs of bank.cardStatements || []) {
      if (cs && cs.hash && !(await Store.hasCardStatement(cs.hash))) {
        await Store.putCardStatement(cs);
        addedCardStatements = true;
      }
    }
    if (bankAdded || addedBankStatements) state._bankStatements = await Store.allBankStatements();
    if (addedCardStatements) state._cardStatements = await Store.allCardStatements();
    if (bank.cardAccounts && bank.cardAccounts.length) {
      state.cardAccounts = [...new Set([...(state.cardAccounts || []), ...bank.cardAccounts])];
      await Store.setMeta('bankCardAccounts', state.cardAccounts);
    }
    if (bank.myAccounts && bank.myAccounts.length) {
      state.myAccounts = [...new Set([...(state.myAccounts || []), ...bank.myAccounts])];
      await Store.setMeta('bankMyAccounts', state.myAccounts);
    }
    let rulesAdded = 0;
    if (data.rules && data.rules.length) {
      const rmerged = mergeCategoryRules(state.rules, data.rules);
      rulesAdded = rmerged.inserted + rmerged.updated;
      state.rules = rmerged.rules;
      await persistRules();
    }
    const lr = data.ledgerRules || {};
    state.confirmedIncomeIds = [
      ...new Set([...(state.confirmedIncomeIds || []), ...(lr.confirmedIncomeIds || [])]),
    ];
    state.sharedAccounts = [
      ...new Set([...(state.sharedAccounts || []), ...(lr.sharedAccounts || [])]),
    ];
    state.householdPayees = [
      ...new Set([...(state.householdPayees || []), ...(lr.householdPayees || [])]),
    ];
    await persistLedgerRules();
    if (!state.firstName && data.profile && data.profile.firstName) {
      state.firstName = data.profile.firstName;
      await Store.setMeta('firstName', state.firstName);
    }
    // Round 4: same "never overwrite what is already here" rule as firstName
    // above - an imported goal only ever fills a genuinely empty local goal,
    // never replaces one already set on this device. goalLog is a historical
    // record, so it merges by month instead (a month already logged locally
    // keeps its own local entry; only genuinely new months are brought in).
    if (!state.goal && data.profile && data.profile.goal) {
      state.goal = data.profile.goal;
      await Store.setMeta('financeGoal', state.goal);
    }
    if (data.profile && data.profile.goalLog && data.profile.goalLog.length) {
      const knownMonths = new Set(state.goalLog.map((g) => g.month));
      const newEntries = data.profile.goalLog.filter(
        (g) => g && g.month && !knownMonths.has(g.month)
      );
      if (newEntries.length) {
        state.goalLog = [...state.goalLog, ...newEntries]
          .sort((a, b) => (a.month < b.month ? -1 : 1))
          .slice(-24);
        await Store.setMeta('financeGoalLog', state.goalLog);
      }
    }
    state.lastImportedFrom = {
      at: new Date().toISOString(),
      device: data.meta.device || 'another device',
    };
    await Store.setMeta('lastImportedFrom', state.lastImportedFrom);
    if ((!hadCardBefore && state.records.length) || (!hadBankBefore && state.bankRecords.length))
      state.view = defaultDataView();
    render();
    const bankNote = bankAdded
      ? ` Plus ${bankAdded} account transaction${bankAdded === 1 ? '' : 's'}.`
      : '';
    const rulesNote = rulesAdded
      ? ` ${rulesAdded} category rule${rulesAdded === 1 ? '' : 's'} added.`
      : '';
    toast(
      `Brought in ${merged.added} transaction${merged.added === 1 ? '' : 's'}. ${merged.alreadyPresent} were already present.${bankNote}${rulesNote}`
    );
    input.value = '';
  }

  // When opts.confirm is set (export only), a second field must match the first
  // before Continue is allowed. A typo on export otherwise produces a file that
  // can never be opened, discovered only later on import. Import stays a single
  // field. Cancel/close always returns control to the dashboard (resolve null).
  function askPassphrase(prompt, opts = {}) {
    return new Promise((resolve) => {
      const inp = el('input', {
        type: 'password',
        placeholder: 'Passphrase',
        class: 'pass',
      });
      const kids = [el('div', { class: 'picker-head' }, prompt), inp];
      let confirmInp = null,
        note = null;
      if (opts.confirm) {
        confirmInp = el('input', {
          type: 'password',
          placeholder: 'Confirm passphrase',
          class: 'pass',
        });
        note = el('div', { class: 'pass-note', hidden: '' }, 'Those passphrases do not match yet.');
        kids.push(confirmInp, note);
      }
      const done = () => {
        const v = inp.value.trim();
        if (!v) return;
        if (opts.confirm) {
          if (v !== confirmInp.value.trim()) {
            note.hidden = false;
            return;
          }
        }
        overlay.remove();
        resolve(v);
      };
      kids.push(
        el(
          'div',
          { class: 'picker-actions' },
          el(
            'button',
            {
              class: 'btn sm ghost',
              onclick: () => {
                overlay.remove();
                resolve(null);
              },
            },
            'Cancel'
          ),
          el('button', { class: 'btn sm', onclick: done }, 'Continue')
        )
      );
      const box = el('div', { class: 'picker' }, ...kids);
      const overlay = el(
        'div',
        {
          class: 'overlay',
          onclick: (e) => {
            if (e.target === overlay) {
              overlay.remove();
              resolve(null);
            }
          },
        },
        box
      );
      document.body.append(overlay);
      inp.focus();
      const onKey = (e) => {
        if (e.key === 'Enter') done();
      };
      inp.addEventListener('keydown', onKey);
      if (confirmInp) {
        confirmInp.addEventListener('keydown', onKey);
        confirmInp.addEventListener('input', () => {
          note.hidden = true;
        });
      }
    });
  }

  function downloadFile(name, text, type) {
    const blob = new Blob([text], { type });
    const url = URL.createObjectURL(blob);
    const a = el('a', { href: url, download: name });
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const today = () => new Date().toISOString().slice(0, 10);

  return {
    toggleExportMenu,
    exportCurrentCSV,
    exportAllCSV,
    exportCurrentDetailedCSV,
    exportAllDetailedCSV,
    exportUnknownMerchants,
    exportRules,
    importRules,
    doExportHistory,
    doImportHistory,
    openCsvExportDialog,
  };
}
