/**
 * The identity types of T-014 — the shapes of `users`, `api_tokens` and `access_audit`
 * (task 014-06, `data-model.md` §4.5.3 – §4.5.5).
 *
 * **Why they live in `mcp-server` and not in `core`.** `security.md` §7.5.1: identity stays beside
 * the transport that needs it, and `packages/core` receives no type of token, role or header. The
 * boundary is checked, not trusted — `test/engine-store-contracts.test.ts` scans `packages/core/src`
 * for exactly these declarations.
 *
 * **Why the shapes follow the columns and the canon rather than the reference project.** The
 * reference (`n8n-lazy-loading-skills`, `sql/010_identity_tables.sql`) is a Postgres-only schema:
 * `uuid DEFAULT gen_random_uuid()`, `timestamptz DEFAULT now()`, `token_hash bytea`, `scopes text[]`,
 * `bigserial`. Every one of those is a value the SERVER owns or a type only one engine has, and
 * DB-SCHEMA §1 makes the engine move mechanical by owning neither. So: application-generated ULIDs
 * as `TEXT`, epoch-ms integers, a hex digest as `TEXT`, and no array column — the narrowing lives on
 * the access profile, which the token references.
 *
 * Five things the reference is followed on exactly: the `admin | user` role check, the
 * `active | suspended` status check, a visible `prefix` beside the digest, a minimum prefix length
 * of 8, and an audit journal the engine will not let anybody rewrite.
 */

/**
 * The two principals of `ADR-002` D8: `admin` is the operator, `user` the client.
 *
 * **The role sits on the USER, never on the token** (`data-model.md` §4.5.3). `_meta.budget`
 * visibility is a function of the principal's role (R-6.1), so two tokens of one person would
 * otherwise be able to disagree about what that person sees.
 *
 * **A role carries no number** (R-15.3b). A limit that differs by role is expressed by which access
 * profile the token references — one mechanism for limits, not two. That is why `User` below has no
 * `rateLimitPerMin` and no `creditsBalanceRaw`, and why adding one would be a second answer to a
 * question `AccessProfile` already answers.
 */
export type Role = 'admin' | 'user';

/** `users.status`. Access is withdrawn by suspension plus token revocation; no row is deleted. */
export type UserStatus = 'active' | 'suspended';

/** `api_tokens.status`. Revocation sets this and `revoked_at`; the row stays. */
export type TokenStatus = 'active' | 'revoked';

/**
 * The closed vocabulary of `access_audit.action` (`data-model.md` §4.5.5).
 *
 * Closed because the journal is queried by action, and an action invented at a call site is a row
 * no query finds. A sixth value is a schema change: the `CHECK` in both migrations carries the same
 * five.
 */
export type AuditAction =
  'user.create' | 'user.suspend' | 'token.issue' | 'token.revoke' | 'profile.update';

/** The closed vocabulary of `access_audit.target_type`. */
export type AuditTargetType = 'user' | 'api_token' | 'access_profile';

/**
 * One row of `users`.
 *
 * `email` is the only human-facing identity, and **the writer lowercases it before the insert**
 * (§4.5.3): neither engine folds case in a `UNIQUE` index by default, so `A@x` and `a@x` would be
 * admitted as two different people.
 *
 * Times are epoch-ms UTC integers, never strings and never engine time functions (DB-SCHEMA §1.2).
 * The engine move is mechanical only while no column's meaning depends on the engine's clock.
 */
export interface User {
  readonly id: string; // ULID, application-generated (§1.3)
  readonly email: string; // lowercased by the writer
  readonly displayName: string | null;
  readonly role: Role;
  readonly status: UserStatus;
  readonly createdAt: number; // epoch-ms UTC
  readonly updatedAt: number; // epoch-ms UTC
}

/** What a caller supplies to create a user. `id`, `status` and the two timestamps are the store's. */
export interface NewUser {
  readonly email: string;
  readonly displayName?: string | null;
  readonly role: Role;
}

/**
 * One row of `api_tokens`, as anything but the authentication path sees it.
 *
 * **The secret is absent, and so is its digest.** `token` never exists as a field: the value is
 * returned once, by `issue`, and is never read back from anywhere (`security.md` §7.5.2). The
 * `token_hash` column is absent for a narrower reason — nothing reads it. Lookup passes the digest
 * as a `WHERE` parameter and selects the seven values below; an admin listing shows the `prefix`;
 * an audit row is forbidden to carry the digest at all (§4.5.5). A field for it would exist only to
 * be copied somewhere it does not belong.
 *
 * **`prefix` is what identifies a token in prose** (R-15.2) — an audit row, an admin listing, a
 * diagnostics record. It is `UNIQUE`, because an ambiguous identification identifies nothing, and it
 * is **never a lookup key**: a second lookup path over a shorter non-secret value would be a weaker
 * credential wearing the same table.
 */
export interface ApiToken {
  readonly id: string; // ULID
  readonly userId: string;
  readonly accessProfileId: string;
  readonly prefix: string; // the visible leading characters (R-15.2)
  readonly name: string | null;
  readonly status: TokenStatus;
  readonly expiresAt: number | null; // epoch-ms UTC; null = no expiry
  readonly revokedAt: number | null; // epoch-ms UTC
  readonly createdAt: number; // epoch-ms UTC
}

/** What `issue` hands back. The `token` is the only time the secret exists outside the client. */
export interface IssuedToken {
  readonly id: string;
  readonly token: string;
  readonly prefix: string;
}

/** Optional columns of `api_tokens` an issuing operation may set, plus the value itself. */
export interface IssueOptions {
  readonly name?: string | null;
  readonly expiresAt?: number | null;
  /**
   * A token value minted elsewhere, stored instead of one this process mints.
   *
   * **Why the store accepts a value it did not create** (owner decision, task 014-08). The owner
   * mints the first token themselves, on their own machine, and hands over only what the database
   * keeps. A tool that could only mint its own would leave that path unsupported and push the
   * operator into writing SQL by hand.
   *
   * It is validated against the §7.5.2 form before it is stored. A value of another shape yields a
   * `prefix` that is not the leading 11 characters the server computes, so the row would be
   * identified by something no reader could reproduce — the failure PROD-RUNBOOK's first draft
   * shipped, where `openssl rand -base64 32` seeded a row the server could never match.
   */
  readonly token?: string;
}

/**
 * The seven values of the authentication read (`data-model.md` §4.5.4).
 *
 * **The liveness predicate is NOT in the query.** A `WHERE` that filtered on status and expiry would
 * answer zero rows for an unknown token, a revoked one, an expired one and a suspended person alike
 * — one answer for four states. R-26 needs the class and R-31 renders it twice, so the query returns
 * the row and the decision is taken in code over it.
 *
 * Token status and user status are separate fields for the same reason: they are two of the four
 * states, and folding them would make two of them one.
 */
export interface TokenLookupRow {
  readonly tokenId: string;
  readonly tokenStatus: TokenStatus;
  readonly expiresAt: number | null;
  readonly accessProfileId: string;
  readonly userId: string;
  readonly role: Role;
  readonly userStatus: UserStatus;
}

/**
 * One row of `access_audit` (`data-model.md` §4.5.5).
 *
 * **`beforeJson` and `afterJson` never carry the secret or its digest.** A token event records the
 * token's `id` and `prefix`. The journal has more readers than the authentication path, and a digest
 * is a verifier.
 *
 * **`actorUserId` is nullable, and the null has one meaning:** the seed migration that creates the
 * first admin, which has no actor to name because no admin exists yet (§4.5.3).
 *
 * The caller supplies `id`, `ts` and `createdAt` rather than the store stamping them — the same
 * shape `RequestTraceRecord` and `DiagnosticsRecord` take (task 014-02), so an append is a pure
 * function of its argument and a test needs no clock.
 */
export interface AccessAuditEntry {
  readonly id: string; // ULID; time-sortable, so the journal reads in order
  readonly ts: number; // epoch-ms UTC
  readonly actorUserId: string | null; // null only for the seed migration (§4.5.3)
  readonly action: AuditAction;
  readonly targetType: AuditTargetType;
  readonly targetId: string;
  readonly beforeJson: string | null; // JSON as TEXT (§1.4)
  readonly afterJson: string | null;
  readonly createdAt: number; // epoch-ms UTC
}

/**
 * The four states that refuse an authentication, each a distinct `refusal_class`
 * (`security.md` §7.5.2).
 *
 * All four answer `401` on the wire. The class is what an OPERATOR needs, and it is recorded in the
 * `auth.rejected` diagnostics row (§4.5.8); a caller holding no valid token learns nothing from the
 * difference.
 *
 * **The class is not written to `request_trace.refusal_class` on this path.** A request refused at
 * step 2 has no principal, and `request_trace.principal_id` is `NOT NULL`, so no row of that table
 * can exist for it (§4.5.7).
 */
export type AuthRefusalClass =
  'auth.unknown_token' | 'auth.revoked' | 'auth.expired' | 'auth.user_suspended';

export const AUTH_REFUSAL_CLASSES: readonly AuthRefusalClass[] = [
  'auth.unknown_token',
  'auth.revoked',
  'auth.expired',
  'auth.user_suspended',
];
