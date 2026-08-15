/**
 * The table-backed side of the access profile: reading the seven settings a token references out of
 * `access_profiles` (`data-model.md` §4.5.3, `security.md` §7.5.3a).
 *
 * Task 014-02 declares the SHAPE and ships a stub under it. No table is created here — the Postgres
 * declaration is task 014-35, the SQLite one 014-36 — and no row is read: the stub answers with a
 * fixed value until a table-backed supplier lands after T-014.
 *
 * **Why this lives in `mcp-server` and not in `core`.** `security.md` §7.5.1 keeps the checks beside
 * the transport that needs them, and keeps `packages/core` free of tokens, roles and headers. SQL
 * that names an identity table is written from this package for the same reason.
 *
 * **Why a store beside `AccessProfileReader`, rather than instead of it.** R-13.2/R-13.3 give the
 * reader ONE asynchronous interface with TWO suppliers behind it: T-014's code defaults
 * (task 014-04, `auth/default-access-profile.ts`) and, later, this table. AC-38 observes the
 * substitution, so the second supplier has to exist as its own declaration rather than as a branch
 * inside the first.
 */

import type { AccessProfile } from './access-profile.js';

/**
 * The seven settings of one access profile — the SAME type task 014-04 declares, under this file's
 * name for it.
 *
 * **Why an alias and not a second declaration** (collapsed by task 014-04). While 014-04 was
 * unlanded this file carried its own seven-field interface, reproduced from `security.md` §7.5.3a,
 * with a note saying that collapsing it into an alias when 014-04 arrived would be a rename and
 * never a reshape. That is this line. Two structurally identical declarations of one entity are two
 * places to add a field to, and the R-13.3a gate counts field names in exactly one of them.
 *
 * The declaration order differed between the two (§7.5.3a lists `routeDisclosureMode` sixth, 014-04
 * lists it last) — property order is not part of a TypeScript type's identity, so nothing about the
 * collapse turns on it.
 */
export type AccessProfileRecord = AccessProfile;

/**
 * Reading one profile out of `access_profiles` by its id.
 *
 * **Why `null` rather than a thrown "not found".** The two outcomes a caller must be able to tell
 * apart are "the row is not there" and "the store could not be asked" — an unknown id versus an
 * unreachable database. `null` is the first; the second throws. Folding them together would let an
 * outage read as an unprovisioned profile, which is the shape of a fail-OPEN.
 *
 * **`null` is not permission to proceed.** The new legal negative answer widens what every gate
 * above it accepts (L-10), so the rule is stated where the value is declared: a caller that reads
 * `null` REFUSES. It does not substitute a default profile — §7.5.3a makes a failed read refuse the
 * session at creation and refuse the request on the request path, because a substituted default
 * widens an inventory or a ceiling at the exact moment the settings source is unavailable.
 *
 * **Why asynchronous with a synchronous stub behind it.** The second supplier is a table behind a
 * connection. A synchronous signature would have to be rewritten to admit it (R-13.2), which is the
 * rewrite this declaration exists to avoid.
 */
export interface AccessProfileStore {
  read(accessProfileId: string): Promise<AccessProfileRecord | null>;
}

/**
 * The fixed answer this task's stub gives, until a table-backed supplier replaces it.
 *
 * **Why this is NOT the phase-0 default.** Task 014-04 owns the phase-0 supplier
 * (`auth/default-access-profile.ts`), where R-13.4 requires each default to carry its measurement
 * beside it. This constant is a stub's fixed answer and is named so that no reader mistakes it for a
 * configured default: phase 0 declares all three limits unlimited, and this value does not.
 *
 * **Why the balance is `2^53 + 1`.** It is the smallest integer a JS number cannot represent
 * exactly, so any implementation that ever parses this column into a number fails visibly on the
 * stub's own value rather than silently on a customer's balance. The paired mode is `metered`,
 * because §4.5.3's `CHECK ((credits_mode = 'metered') = (credits_balance_raw IS NOT NULL))` admits
 * a balance only under that mode.
 */
export const STUB_ACCESS_PROFILE: AccessProfileRecord = Object.freeze({
  creditsMode: 'metered',
  creditsBalanceRaw: '9007199254740993',
  rateLimitMode: 'unlimited',
  rateLimitPerMin: null,
  toolAllowlistMode: 'all',
  routeDisclosureMode: 'full',
  toolAllowlist: null,
});

/**
 * The stub, `[STUB]` in the task title's sense: it satisfies `AccessProfileStore` and answers every
 * id with one fixed value.
 *
 * **Why it does not model row identity.** A stub that kept a map of ids would be a small, untested
 * reimplementation of the table it stands in for, and the first behaviour to diverge from it. This
 * one answers the same thing for every id, and the `fixed` parameter is the seam that lets a test
 * exercise the `null` path — the same injection pattern `PgPoolCtor` uses in
 * `packages/core/src/pg/read-client.ts`, so no test needs a database (R-21).
 */
export function createAccessProfileStoreStub(
  fixed: AccessProfileRecord | null = STUB_ACCESS_PROFILE,
): AccessProfileStore {
  return {
    read(): Promise<AccessProfileRecord | null> {
      return Promise.resolve(fixed);
    },
  };
}
