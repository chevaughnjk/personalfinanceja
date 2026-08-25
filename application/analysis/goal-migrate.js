/*
 * goal-migrate.js  -  non-destructive migration from the OLD goal shape
 * (state.goal = { type, params, createdAt }, types runway/clear-card/spend-ceiling)
 * to the proven goals.js shape. Runs once on load. NEVER discards a saved goal
 * and NEVER touches goalLog (the frozen monthly follow-up history stays intact
 * as a read-only record, exactly as clearGoal already preserves it).
 *
 * Mapping (from the side-by-side model map):
 *   runway         -> cushion       (targetDays; identical meaning: N days of outflow buffer)
 *   clear-card     -> clear-card     (targetDate; unchanged)
 *   spend-ceiling  -> spend-ceiling  (params.ceiling -> amount)
 *
 * The old goal carried no safety boundary or trigger, so the migrated goal gets
 * NONE (boundary 'none', trigger null) - the person authors those later. That is
 * the honest default: we never invent a boundary the user didn't set.
 */
export function migrateGoal(oldGoal) {
  if (!oldGoal || !oldGoal.type) return null;
  const p = oldGoal.params || {};
  const base = {
    id: oldGoal.id || `goal_${Math.random().toString(36).slice(2, 10)}`,
    active: true,
    trigger: null, // old goals had none; person authors later
    createdAt: oldGoal.createdAt || new Date().toISOString(),
    migratedFrom: oldGoal.type, // audit trail: what it used to be
  };
  switch (oldGoal.type) {
    case 'runway':
      return {
        ...base,
        type: 'cushion',
        targetDays: Number(p.targetDays) || null,
      };
    case 'clear-card':
      return { ...base, type: 'clear-card', targetDate: p.targetDate || null };
    case 'spend-ceiling':
      return {
        ...base,
        type: 'spend-ceiling',
        amount: Number(p.ceiling) || null,
      };
    default:
      // Unknown/future type: keep it verbatim rather than dropping it, flagged
      // so a later build can decide. Never silently discards user state.
      return { ...base, type: oldGoal.type, params: p, unmigrated: true };
  }
}

// Idempotent guard: a goal already in the new shape (has no .params, has a
// known new type) passes through untouched, so running migration twice is safe.
export function ensureMigrated(goal) {
  if (!goal) return null;
  const NEW_TYPES = new Set(['cushion', 'clear-card', 'spend-ceiling']);
  const looksNew = NEW_TYPES.has(goal.type) && !('params' in goal);
  return looksNew ? goal : migrateGoal(goal);
}
