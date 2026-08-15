import { createHash, randomBytes } from 'node:crypto';
import type { EngineStore } from '../engine/pg-engine-store.js';
import { ulid } from '../ulid.js';
import type {
  AccessAuditEntry,
  IssueOptions,
  IssuedToken,
  Role,
  TokenLookupRow,
  TokenStatus,
  UserStatus,
} from './identity-types.js';

/**
 * The `api_tokens` repository, and — through `appendAudit` — the `access_audit` journal
 * (`data-model.md` §4.5.4, §4.5.5).
 *
 * Task 014-02 declared the address, task 014-06 declares the members, task 014-07 supplies the
 * CSPRNG, the peppered digest, revocation and the journal's append-only behaviour.
 *
 * **Why the access journal gets no repository of its own.** It is written on the same paths that
 * issue and revoke, and a sixth store would be a second way to reach one table.
 *
 * **The stub must not reach a running network profile.** Its `issue` returns a predictable value —
 * a credential check that always agrees is worse than none, because it reports success.
 */
export interface TokenStore {
  /**
   * Mints a token for a user under an access profile, and returns the secret ONCE.
   *
   * **Why the access profile is a parameter and not a default.** `api_tokens.access_profile_id` is
   * `NOT NULL` with a foreign key (§4.5.4): an issue with no profile has no row to insert. Making it
   * a parameter means the caller decides which settings the token works within, at the moment the
   * token exists — rather than a default deciding it for every token ever issued.
   *
   * The returned `token` is the only time the secret exists outside the client. It is not stored,
   * not logged and not recoverable (`security.md` §7.5.2).
   *
   * **Why `actorId` is a parameter, and why the journal row is written HERE** (task 014-08). Task
   * 014-06 declared this method with two parameters and left the journal to the caller. That leaves
   * R-15.7 — every admin operation writes an `access_audit` row — as a convention each call site has
   * to remember, and it leaves a window in which a token exists with nothing recording who issued
   * it. Issuing is an admin operation and never request-path code (R-15.4), so an actor always
   * exists; making it a parameter is what lets the row and its journal entry be one transaction.
   *
   * The precedent is inside T-014 already: `003_seed_engine_admin.sql` writes the `token.issue` row
   * in the same transaction as the token it describes.
   */
  issue(
    userId: string,
    accessProfileId: string,
    actorId: string,
    options?: IssueOptions,
  ): Promise<IssuedToken>;

  /**
   * Looks a presented token up by DIGEST and returns the seven values of §4.5.4, or `null`.
   *
   * **`null` means "no row", never "refused".** The four refusing states are decided in code over
   * the returned row, because a `WHERE` that filtered them would answer zero rows for all four and
   * R-26 needs the class. `null` is only the first of the four.
   *
   * **The digest is the only lookup path.** The `prefix` identifies a token in prose and never finds
   * one: a lookup over a shorter, non-secret value would be a weaker credential in the same table.
   */
  lookup(presented: string): Promise<TokenLookupRow | null>;

  /**
   * Revokes a token: `status = 'revoked'` and `revoked_at` stamped. The row is not deleted.
   *
   * **Why the row stays.** Withdrawal of access is a state, not an absence (§4.5.3) — and
   * `request_trace` rows reference the principal that held this token, so deleting it would strand
   * the record of what it did.
   *
   * `actorId` is the admin performing it, and it is a parameter because R-15.7 requires the journal
   * row that accompanies the change to name who made it.
   */
  revoke(tokenId: string, actorId: string): Promise<void>;

  /**
   * Appends one row to `access_audit`. Never updates, never deletes — both engines refuse.
   *
   * The entry carries its own `id`, `ts` and `createdAt`, the same shape `RequestTraceStore.append`
   * takes: an append is then a pure function of its argument and a test needs no clock.
   */
  appendAudit(entry: AccessAuditEntry): Promise<void>;
}

/**
 * The stub: fixed answers, no database (`[STUB]`, task 014-06).
 *
 * **Why the issued value is visibly a stub.** It has the SHAPE of a token — `oi_`, a label, a
 * separator, a secret-length tail — so a caller's parsing is exercised, and it is CONSTANT, so no
 * reader can mistake it for something minted. Task 014-07's TC-UNIT-05 asserts that two real issues
 * differ; this one deliberately does not.
 */
export function createTokenStoreStub(
  fixed: TokenLookupRow | null = null,
): TokenStore & { readonly audited: readonly AccessAuditEntry[] } {
  const audited: AccessAuditEntry[] = [];
  return {
    audited,
    issue(): Promise<IssuedToken> {
      return Promise.resolve({
        id: '01JSTUBTOKEN0000000000000',
        token: `oi_stubstub_${'S'.repeat(43)}`,
        prefix: 'oi_stubstub', // the leading 11 characters, as §7.5.2 defines the prefix
      });
    },
    lookup(): Promise<TokenLookupRow | null> {
      return Promise.resolve(fixed);
    },
    revoke(): Promise<void> {
      return Promise.resolve();
    },
    appendAudit(entry: AccessAuditEntry): Promise<void> {
      audited.push(entry);
      return Promise.resolve();
    },
  };
}

/* --------------------------------------------------------------------------------------------- *
 * Task 014-07 — the repository over the shared access mechanism.
 * --------------------------------------------------------------------------------------------- */

/** `oi_` + an 8-character label + `_` + a 43-character secret (`security.md` §7.5.2). */
const TOKEN_PREFIX = 'oi_';
const LABEL_BYTES = 6; // base64url of 6 bytes is exactly 8 characters, with no padding
const SECRET_BYTES = 32; // 256 bits — R-15.1 asks for at least 128
/** The stored `prefix` is the leading 11 characters: `oi_` plus the label. */
export const TOKEN_PREFIX_LENGTH = 11;

/**
 * How many times a mint may be retried after a `UNIQUE (prefix)` collision.
 *
 * The label is 48 bits, so a collision is a coincidence rather than an event to plan for; the bound
 * exists because a loop with no bound turns a database that refuses every insert — a revoked grant,
 * a full disk — into a process that spins instead of reporting.
 */
const MAX_MINT_ATTEMPTS = 5;

function base64url(bytes: Buffer): string {
  return bytes.toString('base64url');
}

/** Mints one token value. Exported for the shape test; the store calls it through its `mint` dep. */
export function mintToken(entropy: (size: number) => Buffer = randomBytes): string {
  return `${TOKEN_PREFIX}${base64url(entropy(LABEL_BYTES))}_${base64url(entropy(SECRET_BYTES))}`;
}

/**
 * The §7.5.2 form: `oi_` + 8 base64url characters + `_` + 43 base64url characters.
 *
 * **Anchored, and matched by POSITION rather than by splitting.** base64url's alphabet includes `_`,
 * so a 43-character secret contains one about half the time — anything that parsed these values by
 * splitting on the separator would be right in one run and wrong in the next.
 */
const TOKEN_SHAPE = /^oi_[A-Za-z0-9_-]{8}_[A-Za-z0-9_-]{43}$/;

export class MalformedTokenError extends Error {
  constructor() {
    // The value is never named (D10) — and naming it would print a live credential.
    super(
      'the supplied token is not in the form security.md §7.5.2 defines (oi_ + 8 + _ + 43 base64url characters)',
    );
    this.name = 'MalformedTokenError';
  }
}

export class TokenPrefixTakenError extends Error {
  constructor(readonly prefix: string) {
    super(
      `prefix ${prefix} is already in use; mint another value rather than writing an ambiguous row`,
    );
    this.name = 'TokenPrefixTakenError';
  }
}

/**
 * `sha256(pepper || presented)` as lowercase hex (`security.md` §7.5.2, `data-model.md` §4.5.4).
 *
 * **Why a pepper and not a per-row salt.** The read is one indexed equality on `token_hash`. A
 * per-row salt would force a scan over every candidate row, because there would be no single value
 * to look up.
 *
 * **Why the pepper lives outside the database.** A salt stored beside the digests makes a stolen
 * dump self-sufficient. Without the pepper, the same dump is not a candidate list for an offline
 * dictionary attack.
 *
 * **Consequence, stated in advance rather than discovered.** Rotating the pepper invalidates every
 * issued token at once, and there is no re-hash path: the presented secrets are not stored.
 */
export function tokenDigest(pepper: string, presented: string): string {
  return createHash('sha256').update(`${pepper}${presented}`, 'utf8').digest('hex');
}

export class MissingPepperError extends Error {
  constructor() {
    super(
      'ONCHAIN_TOKEN_HASH_SALT is not set; refusing to build a token store that would digest without a pepper',
    );
    this.name = 'MissingPepperError';
  }
}

export class TokenMintExhaustedError extends Error {
  constructor(readonly attempts: number) {
    super(`could not mint a token with an unused prefix in ${attempts} attempts`);
    this.name = 'TokenMintExhaustedError';
  }
}

export class TokenNotRevocableError extends Error {
  constructor(readonly tokenId: string) {
    super(`no active token ${tokenId} to revoke`);
    this.name = 'TokenNotRevocableError';
  }
}

export interface TokenStoreDeps {
  readonly engine: EngineStore;
  /** `ONCHAIN_TOKEN_HASH_SALT`, injected — no consumer reads the environment itself (R-13.3a). */
  readonly pepper: string;
  readonly now: () => number;
  /** Seams: a test needs a predictable id and a mint it can force into a collision. */
  readonly newId?: (nowMs: number) => string;
  readonly mint?: () => string;
}

/** Rows as the engine returns them — snake_case, exactly the column names. */
interface TokenLookupSqlRow {
  readonly id: string;
  readonly status: string;
  readonly expires_at: number | string | null;
  readonly access_profile_id: string;
  readonly user_id: string;
  readonly role: string;
  readonly user_status: string;
}

/**
 * `pg` returns `BIGINT` as a STRING, because an arbitrary 64-bit integer does not survive a JS
 * number. Every time column of migration 002 is `BIGINT`, so a store that forgot this would compare
 * `'1770000000000' <= now` — a string against a number — and answer whatever the coercion happened
 * to give. The SQLite axis returns numbers, so only a coercion applied on BOTH paths is correct on
 * both.
 */
function asEpochMs(value: number | string | null): number | null {
  if (value === null) return null;
  return typeof value === 'number' ? value : Number(value);
}

/**
 * The identity repository over the write client of task 014-39, reached through the shared access
 * mechanism of task 014-03.
 *
 * **Why not its own connection.** One write client per process, and the state role holds the grants
 * (`deployment.md` §10.5.1). A second connection opened from here would mean a second role and a
 * second grant set to keep in step with the first.
 */
export function createTokenStore(deps: TokenStoreDeps): TokenStore {
  if (deps.pepper.trim() === '') throw new MissingPepperError();
  const { engine, pepper, now } = deps;
  const newId = deps.newId ?? ((nowMs: number): string => ulid(nowMs));
  const mint = deps.mint ?? ((): string => mintToken());

  return {
    issue(userId, accessProfileId, actorId, options: IssueOptions = {}): Promise<IssuedToken> {
      // The token row and its journal row are ONE transaction, for the reason `revoke` gives below:
      // a credential that exists with nothing recording who issued it is worse than a failure.
      //
      // The retry sits INSIDE the transaction, and `ON CONFLICT DO NOTHING` is what makes that
      // possible. In Postgres a constraint violation aborts the whole transaction, so a version that
      // caught a driver error could not retry inside one — it would have to issue outside a
      // transaction and lose the pairing.
      // A value minted elsewhere is stored as presented and never re-minted: retrying would produce
      // the same value, so a prefix collision on it is reported rather than looped over.
      const supplied = options.token;
      if (supplied !== undefined && !TOKEN_SHAPE.test(supplied)) throw new MalformedTokenError();
      const attempts = supplied === undefined ? MAX_MINT_ATTEMPTS : 1;

      return engine.transaction(async (tx) => {
        for (let attempt = 1; attempt <= attempts; attempt += 1) {
          const token = supplied ?? mint();
          const prefix = token.slice(0, TOKEN_PREFIX_LENGTH);
          const createdAt = now();
          const id = newId(createdAt);
          // `ON CONFLICT (prefix) DO NOTHING RETURNING id` rather than catching a driver error: the
          // two engines word a constraint violation differently, and a store that parsed those
          // messages would be reading one dialect's prose to make a portable decision. An empty
          // `RETURNING` is the same answer in both. The conflict TARGET is named, so a duplicate
          // `token_hash` — which would mean the CSPRNG repeated — still raises instead of being
          // retried away.
          const written = await tx.query<{ id: string }>(
            `INSERT INTO ${engine.qualify('api_tokens')}
             (id, user_id, access_profile_id, token_hash, prefix, name, status, expires_at, revoked_at, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, NULL, $8)
           ON CONFLICT (prefix) DO NOTHING
           RETURNING id`,
            [
              id,
              userId,
              accessProfileId,
              tokenDigest(pepper, token),
              prefix,
              options.name ?? null,
              options.expiresAt ?? null,
              createdAt,
            ],
          );
          if (written.length === 0) continue;

          await tx.query(
            `INSERT INTO ${engine.qualify('access_audit')}
             (id, ts, actor_user_id, action, target_type, target_id, before_json, after_json, created_at)
           VALUES ($1, $2, $3, 'token.issue', 'api_token', $4, NULL, $5, $2)`,
            [
              newId(createdAt),
              createdAt,
              actorId,
              id,
              // The prefix, never the value and never the digest (§4.5.5).
              JSON.stringify({ status: 'active', prefix, access_profile_id: accessProfileId }),
            ],
          );
          return { id, token, prefix };
        }
        if (supplied !== undefined) {
          throw new TokenPrefixTakenError(supplied.slice(0, TOKEN_PREFIX_LENGTH));
        }
        throw new TokenMintExhaustedError(MAX_MINT_ATTEMPTS);
      });
    },

    async lookup(presented: string): Promise<TokenLookupRow | null> {
      // The read of §4.5.4, verbatim: one indexed equality, both objects schema-qualified. No
      // liveness predicate — see `classifyToken`.
      const rows = await engine.query<TokenLookupSqlRow>(
        `SELECT t.id, t.status, t.expires_at, t.access_profile_id,
                u.id AS user_id, u.role, u.status AS user_status
           FROM ${engine.qualify('api_tokens')} t
           JOIN ${engine.qualify('users')} u ON u.id = t.user_id
          WHERE t.token_hash = $1`,
        [tokenDigest(pepper, presented)],
      );
      const row = rows[0];
      if (row === undefined) return null;
      return {
        tokenId: row.id,
        tokenStatus: row.status as TokenStatus,
        expiresAt: asEpochMs(row.expires_at),
        accessProfileId: row.access_profile_id,
        userId: row.user_id,
        role: row.role as Role,
        userStatus: row.user_status as UserStatus,
      };
    },

    async revoke(tokenId: string, actorId: string): Promise<void> {
      const revokedAt = now();
      // The update and its journal row are one transaction. A revocation recorded with no journal
      // row, or a journal row for a revocation that did not happen, are both worse than a failure:
      // R-15.7 makes the journal the record of what an admin did, and a record that disagrees with
      // the state is read as the state.
      await engine.transaction(async (tx) => {
        const updated = await tx.query<{ id: string; prefix: string }>(
          `UPDATE ${engine.qualify('api_tokens')}
              SET status = 'revoked', revoked_at = $1
            WHERE id = $2 AND status = 'active'
            RETURNING id, prefix`,
          [revokedAt, tokenId],
        );
        const row = updated[0];
        // An unknown id and an already-revoked token are both "nothing to revoke". Refusing rather
        // than answering silently is the canon: an operator who mistyped an id must not be told the
        // revocation succeeded.
        if (row === undefined) throw new TokenNotRevocableError(tokenId);
        await tx.query(
          `INSERT INTO ${engine.qualify('access_audit')}
             (id, ts, actor_user_id, action, target_type, target_id, before_json, after_json, created_at)
           VALUES ($1, $2, $3, 'token.revoke', 'api_token', $4, $5, $6, $2)`,
          [
            newId(revokedAt),
            revokedAt,
            actorId,
            tokenId,
            // Neither side carries the secret or its digest (§4.5.5): the prefix is what identifies
            // a token to every reader of this journal, and there are more of them than of the
            // authentication path.
            JSON.stringify({ status: 'active', prefix: row.prefix }),
            JSON.stringify({ status: 'revoked', prefix: row.prefix, revoked_at: revokedAt }),
          ],
        );
      });
    },

    async appendAudit(entry: AccessAuditEntry): Promise<void> {
      await engine.query(
        `INSERT INTO ${engine.qualify('access_audit')}
           (id, ts, actor_user_id, action, target_type, target_id, before_json, after_json, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          entry.id,
          entry.ts,
          entry.actorUserId,
          entry.action,
          entry.targetType,
          entry.targetId,
          entry.beforeJson,
          entry.afterJson,
          entry.createdAt,
        ],
      );
    },
  };
}
