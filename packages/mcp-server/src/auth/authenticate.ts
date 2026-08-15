import type { AuthRefusalClass, TokenLookupRow } from './identity-types.js';

/**
 * The verification decision (task 014-07, `security.md` §7.5.2, `data-model.md` §4.5.4).
 *
 * **Why it is a function over a row and not a `WHERE` clause.** A query that filtered on status,
 * expiry and the person's status would answer zero rows for four different situations, and an
 * operator reading `auth.rejected` could not tell a token that never existed from one they revoked
 * this morning. R-26 needs the class; R-31 renders it twice. So the query returns the row and this
 * decides over it.
 *
 * **All four answer `401` on the wire.** The class is what an operator needs, in the diagnostics
 * row; a caller holding no valid token learns nothing from the difference (§7.5.2). Rendering the
 * response is tasks 014-12 and 014-26 — this supplies the class.
 */

export type AuthOutcome =
  | { readonly ok: true; readonly row: TokenLookupRow }
  | { readonly ok: false; readonly refusalClass: AuthRefusalClass };

/**
 * Classifies a lookup result at instant `nowMs`.
 *
 * **The order is §7.5.2's table order, and it is stated because it is arbitrary in one case only:** a
 * token that is both revoked and expired reports `auth.revoked`. Revocation is an act somebody
 * performed and expiry is a date passing, so the act is the more informative of the two — and the
 * caller's outcome is identical either way.
 *
 * **Expiry is `<= now`, not `< now`.** The column's own `CHECK` requires `expires_at > created_at`,
 * so the instant named by `expires_at` is the first instant the token is no longer valid, not the
 * last one it is.
 */
export function classifyToken(row: TokenLookupRow | null, nowMs: number): AuthOutcome {
  if (row === null) return { ok: false, refusalClass: 'auth.unknown_token' };
  if (row.tokenStatus === 'revoked') return { ok: false, refusalClass: 'auth.revoked' };
  if (row.expiresAt !== null && row.expiresAt <= nowMs) {
    return { ok: false, refusalClass: 'auth.expired' };
  }
  if (row.userStatus === 'suspended') return { ok: false, refusalClass: 'auth.user_suspended' };
  return { ok: true, row };
}
