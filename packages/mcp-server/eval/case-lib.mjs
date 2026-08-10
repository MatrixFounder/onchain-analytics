// Shared assertion helpers for the atomic eval cases in `cases/`.
//
// These were inline in `checks.mjs` while every check lived in one file. Splitting the checks into
// one file per case made them shared, so they moved here rather than being copied twelve times —
// a copy is two sources of one rule, and the copy is always the one that drifts.
//
// Nothing here knows about tools, capabilities or chains: a case file composes these into an
// assertion about ONE response shape, and that is the whole contract.

export const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** A finite, strictly positive number — used where zero is not a plausible real-world answer. */
export function positive(value, field) {
  const n = num(value);
  if (n === null) return `${field} is not a finite number (${JSON.stringify(value)})`;
  if (n <= 0) return `${field} is ${n} — a live chain/token should never report this`;
  return null;
}

/** Present and non-empty after trimming. */
export function nonEmpty(value, field) {
  if (typeof value !== 'string' || value.trim() === '') {
    return `${field} is missing or empty (${JSON.stringify(value)})`;
  }
  return null;
}
