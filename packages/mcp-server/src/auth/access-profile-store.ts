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

/**
 * The seven settings of one access profile, reproduced field for field from `security.md` §7.5.3a
 * and column for column from `access_profiles` (`data-model.md` §4.5.3).
 *
 * **Why every value is accompanied by its mode.** "Unlimited" is DECLARED here, never inferred from
 * a missing value. A `null` that means unlimited cannot be told apart from a profile that was never
 * provisioned — the L-10 class of defect, where 43 of 458 chains answered a confident "not deployed"
 * and both gates stayed green. The three `CHECK` pairs in §4.5.3 keep the same distinction at the
 * engine level, and this type keeps it in the process.
 *
 * **Why `creditsBalanceRaw` is a string and not a number.** Credits are exact integers and a client
 * facing balance in our own currency. A JS number loses precision past 2^53, which is precisely why
 * `data-model.md` §4.5.3 declares the column `TEXT` (DB-SCHEMA §1.7). Reading it into a number here
 * would spend the exactness the column was chosen to preserve, one layer above the storage that
 * preserved it.
 *
 * **Why the type is named `AccessProfileRecord` and not `AccessProfile`.** Task 014-04 owns
 * `AccessProfile` in `auth/access-profile.ts` (`security.md` §7.5.3a), and `auth/index.ts` is a
 * barrel: two files exporting one name through it is a duplicate export, not a merge. The field
 * names and their value types are reproduced verbatim, so when 014-04 lands, collapsing this into
 * `export type AccessProfileRecord = AccessProfile` is a rename and never a reshape.
 *
 * **Why the declaration order differs from task 014-04's.** §7.5.3a lists `routeDisclosureMode`
 * sixth; 014-04 lists it last and says so. Property order is not part of a TypeScript type's
 * identity, so both orders compile to the same type — this file follows the architecture document it
 * is transcribing, and the difference is recorded here so nobody "repairs" one into the other.
 *
 * **What this shape deliberately does not carry.** `access_profiles` also holds `name`, `status`,
 * `created_at` and `updated_at`. §7.5.3a declares seven fields and only seven; a wider shape here
 * would give one entity two vocabularies, and the R-13.3a gate of task 014-04 counts exactly these
 * seven names. A supplier that must refuse a retired profile refuses — the reader's contract is
 * fail-closed (§7.5.3a) — rather than growing an eighth field for a caller to interpret.
 */
export interface AccessProfileRecord {
  readonly creditsMode: 'unlimited' | 'metered';
  readonly creditsBalanceRaw: string | null; // exact value as a string
  readonly rateLimitMode: 'unlimited' | 'metered';
  readonly rateLimitPerMin: number | null;
  readonly toolAllowlistMode: 'all' | 'list';
  readonly routeDisclosureMode: 'full' | 'none'; // R-20.4 — data-model.md §4.5.3
  readonly toolAllowlist: readonly string[] | null;
}

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
