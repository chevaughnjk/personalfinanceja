// Proves the shared drill-to-transactions helper and its sibling filter-
// applicability predicates - extracted to shared-helpers.js so every
// card-only drill in this app (Activity's treemap/ranked list, Right Now's
// own places/second-look, Cards' category/merchant/foreign/recurring
// panels) goes through ONE tested implementation instead of nine
// independently hand-written copies, several of which never reset the
// bank-side drill facets at all.
import {
  drillToTransactions,
  ledgerIsNarrowed,
  bankRowsInapplicable,
  cardRowsInapplicable,
} from '../application/core/shared-helpers.js';

let pass = 0,
  fail = 0;
const note = (c, l) => {
  if (c) pass++;
  else {
    fail++;
    console.log('   FAIL', l);
  }
};
console.log('='.repeat(72));
console.log(' DRILL-TO-TRANSACTIONS + FILTER-APPLICABILITY - proof');
console.log('='.repeat(72));

function makeState(overrides = {}) {
  return {
    view: 'activity',
    activityTab: 'analysis',
    bankAccount: 'all',
    filter: {
      category: 'all',
      kind: 'all',
      merchant: '',
      reviewOnly: false,
      foreignOnly: false,
      min: null,
      max: null,
      search: '',
    },
    bankFilter: { payeeKey: '', kind: 'all', search: '' },
    showAllTx: false,
    ...overrides,
  };
}
function makeSpy() {
  const calls = [];
  const fn = (...a) => calls.push(a);
  fn.calls = calls;
  return fn;
}

// 1) switches view to Activity + sets the Transactions sub-tab + tracks usage
//    when NOT already on Activity
{
  const state = makeState({ view: 'overview' });
  const trackUsage = makeSpy();
  const resetBankDrillFacets = makeSpy();
  const applyFilter = makeSpy();
  drillToTransactions(
    { state, trackUsage, resetBankDrillFacets, applyFilter },
    { category: 'Subscriptions' }
  );
  note(state.view === 'activity', 'switches state.view to activity');
  note(
    state.activityTab === 'transactions',
    'sets the Activity Transactions sub-tab so the drill lands on the list, not Analysis'
  );
  note(
    trackUsage.calls.length === 1 && trackUsage.calls[0][0] === 'view-activity',
    'tracks the view switch exactly once'
  );
}

// 2) NO redundant view-switch / tracking when already on Activity, but the
//    Transactions sub-tab is STILL set (a drill from Activity's own Analysis
//    tab must still open the Transactions list)
{
  const state = makeState({ view: 'activity' });
  const trackUsage = makeSpy();
  const resetBankDrillFacets = makeSpy();
  const applyFilter = makeSpy();
  drillToTransactions({ state, trackUsage, resetBankDrillFacets, applyFilter }, { category: 'X' });
  note(trackUsage.calls.length === 0, 'no redundant view-switch tracking when already on activity');
  note(
    state.activityTab === 'transactions',
    'the Transactions sub-tab is set even when already on Activity, so a drill from the Analysis tab opens the list'
  );
}

// 3) ALWAYS resets bank drill facets - the actual bug this consolidation closes
{
  const state = makeState();
  const trackUsage = makeSpy();
  const resetBankDrillFacets = makeSpy();
  const applyFilter = makeSpy();
  drillToTransactions({ state, trackUsage, resetBankDrillFacets, applyFilter }, { category: 'X' });
  note(
    resetBankDrillFacets.calls.length === 1,
    'resetBankDrillFacets is ALWAYS called - a stale bank facet can never linger'
  );
}

// 4) applies the patch with expand+scroll(default true)
{
  const state = makeState();
  const applyFilter = makeSpy();
  drillToTransactions(
    {
      state,
      trackUsage: makeSpy(),
      resetBankDrillFacets: makeSpy(),
      applyFilter,
    },
    { category: 'Groceries' }
  );
  note(applyFilter.calls.length === 1, 'applyFilter called exactly once');
  const [patch, opts] = applyFilter.calls[0];
  note(patch.category === 'Groceries', 'patch passed through unchanged');
  note(opts.expand === true && opts.scroll === true, 'defaults to expand:true, scroll:true');
}

// 5) scroll override honoured (the deselect-should-not-scroll nuance)
{
  const applyFilter = makeSpy();
  drillToTransactions(
    {
      state: makeState(),
      trackUsage: makeSpy(),
      resetBankDrillFacets: makeSpy(),
      applyFilter,
    },
    { category: 'all' },
    { scroll: false }
  );
  note(
    applyFilter.calls[0][1].scroll === false,
    'an explicit scroll:false override is honoured (deselect never forces a scroll)'
  );
}

// 6) missing dependency throws a clear, SPECIFIC error - not a generic crash
{
  let threw = null;
  try {
    drillToTransactions({ state: makeState(), trackUsage: makeSpy(), applyFilter: makeSpy() }, {});
  } catch (e) {
    threw = e;
  }
  note(
    threw && /resetBankDrillFacets/.test(threw.message),
    'a missing dependency throws, NAMING exactly which one is missing'
  );
}

// 7) ledgerIsNarrowed: honest on defaults, true when any real facet is set
{
  note(ledgerIsNarrowed(makeState()) === false, 'defaults -> not narrowed');
  note(
    ledgerIsNarrowed(makeState({ filter: { ...makeState().filter, category: 'Groceries' } })) ===
      true,
    'a category filter -> narrowed'
  );
  note(
    ledgerIsNarrowed(makeState({ bankFilter: { ...makeState().bankFilter, payeeKey: 'x' } })) ===
      true,
    'a bank payeeKey -> narrowed'
  );
}

// 8) bankRowsInapplicable / cardRowsInapplicable
{
  note(bankRowsInapplicable(makeState()) === false, 'defaults -> bank rows applicable');
  note(
    bankRowsInapplicable(
      makeState({ filter: { ...makeState().filter, category: 'Groceries' } })
    ) === true,
    'a category filter -> bank rows inapplicable'
  );
  note(cardRowsInapplicable(makeState()) === false, 'defaults -> card rows applicable');
  note(
    cardRowsInapplicable(
      makeState({ bankFilter: { ...makeState().bankFilter, payeeKey: 'x' } })
    ) === true,
    'a payee filter -> card rows inapplicable'
  );
  note(
    cardRowsInapplicable({ view: 'x', filter: makeState().filter }) === false,
    'a missing bankFilter degrades to false, never throws'
  );
}

console.log(`\n checks: ${pass} passed, ${fail} failed`);
console.log('='.repeat(72));
process.exit(fail ? 1 : 0);
