/* ===========================================================================
 *  custom-categories.js  -  person-authored categories that become first-class
 *  members of the category register, maintained throughout the app.
 *
 *  ARCHITECTURE (decided): the shipped register lives in settings/config.json,
 *  a READ-ONLY file. Custom categories therefore live in their own persisted
 *  meta array ('customCategories') and are MERGED on top of the shipped list at
 *  boot, so the one register every reader consumes (the category picker, the
 *  colour map buildCategoryColours, every dropdown, orderCategoriesForPicker) is
 *  shipped + custom, indistinguishable downstream.
 *
 *  A custom category is assign-only: it carries EMPTY patterns, so it never
 *  auto-matches statement text - a transaction only ever reaches it via an
 *  explicit categoryOverride (which buildRows reads first, before categorise),
 *  so no rule recompilation is needed for assignment to work.
 *
 *  DELETE-INTEGRITY: a custom category in use (any current row resolves to it,
 *  or any personal rule targets it) is NOT deletable - deleting it would leave
 *  transactions pointing at a category that no longer exists. canDeleteCategory
 *  reports usage so the UI blocks with an honest count.
 *
 *  PURE and Node-testable. No DOM, no fetch, no mutation of inputs.
 * ======================================================================== */

/* Build a custom-category record matching the shipped shape closely enough that
 * every reader works, flagged custom:true so it can be told apart for persist
 * and delete. Empty patterns = assign-only. */
export function makeCustomCategory({ name, description = '', now = new Date().toISOString() }) {
  const clean = String(name || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 40);
  return {
    name: clean,
    description: String(description || '')
      .trim()
      .slice(0, 120),
    sector: 'Custom',
    ownership: 'personal',
    custom: true,
    createdAt: now,
    patterns: { universal: [] }, // never auto-matches; assign-only
  };
}

/* Case-insensitive name equality, used for dedup and duplicate rejection. */
function sameName(a, b) {
  return (
    String(a || '')
      .trim()
      .toLowerCase() ===
    String(b || '')
      .trim()
      .toLowerCase()
  );
}

/* Is `name` already a category (shipped or custom)? Rejects duplicate creation. */
export function categoryNameExists(name, categories) {
  return (categories || []).some((c) => sameName(c.name, name));
}

/* The boot merge: shipped list + custom list, with shipped winning any name
 * clash (a custom category can never shadow or duplicate a shipped one). Order:
 * shipped first (their configured order preserved), then custom by creation. */
export function mergeCategories(shipped, custom) {
  const out = (shipped || []).slice();
  const shippedNames = new Set(out.map((c) => String(c.name).toLowerCase()));
  for (const c of custom || []) {
    if (!c || !c.name) continue;
    if (shippedNames.has(String(c.name).toLowerCase())) continue; // shipped wins
    out.push(c);
  }
  return out;
}

/* Usage of a category by NAME across the resolved rows and the personal rules -
 * everything that would be orphaned if it were deleted. rows are the built rows
 * (each carrying resolved .category); rules are state.rules ({ match, category }). */
export function categoryUsage(name, rows, rules, splits = []) {
  const inRows = (rows || []).filter((r) => sameName(r.category, name)).length;
  const inRules = (rules || []).filter((r) => sameName(r.category, name)).length;
  // A split PART pointing at this category counts as usage too - otherwise a
  // category used only via a split (never as a whole row's category, never in
  // a rule) could be deleted, leaving the split attributing money to a
  // category that no longer exists (a phantom line the person can't manage).
  // This closes a real gap: B4's original three-arg check missed split parts.
  const inSplits = (splits || []).reduce(
    (n, s) => n + (s && s.parts ? s.parts : []).filter((p) => sameName(p.category, name)).length,
    0
  );
  return {
    rows: inRows,
    rules: inRules,
    splits: inSplits,
    total: inRows + inRules + inSplits,
  };
}

/* Can this custom category be deleted? Only when nothing uses it. Shipped
 * categories are never deletable. Returns { ok, reason, usage }. */
export function canDeleteCategory(name, categories, rows, rules, splits = []) {
  const cat = (categories || []).find((c) => sameName(c.name, name));
  if (!cat)
    return {
      ok: false,
      reason: 'not-found',
      usage: { rows: 0, rules: 0, splits: 0, total: 0 },
    };
  if (!cat.custom)
    return {
      ok: false,
      reason: 'shipped',
      usage: { rows: 0, rules: 0, splits: 0, total: 0 },
    };
  const usage = categoryUsage(name, rows, rules, splits);
  if (usage.total > 0) return { ok: false, reason: 'in-use', usage };
  return { ok: true, reason: 'ok', usage };
}

/* The stable name->colour slot buildCategoryColours uses (same hash), lifted
 * here ONLY so a proof can confirm a custom name receives a valid, deterministic
 * palette colour with no extra wiring. The app keeps its own copy; this is a
 * verification mirror, not the source of truth. */
export function colourSlot(name, palette) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return palette[h % palette.length];
}
