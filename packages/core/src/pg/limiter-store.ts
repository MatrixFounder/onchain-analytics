import type { TokenBucketConfig } from '../net/rate-limit.js';
import {
  waitMsFor,
  type LimiterKey,
  type LimiterStore,
  type LimiterTake,
} from '../net/limiter-store.js';
import type { StateClient } from './state-client.js';

/** Constructor options for `PgLimiterStore`. */
export interface PgLimiterStoreOptions {
  /** The write-capable client (`createStateClient`) — the same one the cache and budget stores of
   * this axis take, so all three share one pool and one role. */
  client: StateClient;
  /**
   * The `providers` bootstrap barrier — `PgBudgetStore.ready`, which `pg/stores.ts` passes.
   *
   * `provider_buckets.provider` is the only cross-group foreign key of §4.5, so a bucket written
   * before the twelve registry rows land is a foreign-key refusal — and R-7.7 would read that
   * refusal as a storage failure and degrade the process to a per-process ceiling. Omitted, this
   * resolves immediately, which is correct for a caller that has already bootstrapped.
   */
  ready?: Promise<void>;
}

interface TokensRow {
  tokens: number;
}

/**
 * The limiter's bucket state on the Postgres axis — task 014-18, R-7.1/R-7.2, `data-model.md`
 * §4.5.6. Two `network` processes against one Postgres share one ceiling (AC-4), and the bucket
 * outlives either of them (AC-5).
 *
 * **Why the statement is written out here rather than reused from the SQLite store.** §4.5.6 fixes
 * the key, the columns and the arithmetic and leaves the scalar minimum to the dialect: `LEAST`
 * here, `MIN` there. Everything else is character-for-character the same decision, and the two
 * texts are compared by a test rather than by a reader's memory.
 *
 * **Why `client.query` and not `client.transaction`.** Both operations are ONE statement, and one
 * statement in Postgres is already atomic. A `BEGIN`/`COMMIT` around it would take a connection out
 * of the pool for the duration and buy nothing — the refill, the spend and the read are inside the
 * upsert precisely so no transaction has to hold them together.
 *
 * **Why `provider_buckets` needs no bootstrap of its own.** `provider_buckets.provider` references
 * `onchain.providers`, whose twelve rows `PgBudgetStore` upserts at construction. `pg/stores.ts`
 * builds the two together and hands that promise here, which is what makes the ordering a property
 * of the axis rather than of a call site.
 */
export class PgLimiterStore implements LimiterStore {
  private readonly client: StateClient;
  private readonly ready: Promise<void>;

  constructor(options: PgLimiterStoreOptions) {
    this.client = options.client;
    this.ready = options.ready ?? Promise.resolve();
  }

  /**
   * Refills, consumes and reads one bucket in a single statement, returning the tokens left after
   * this caller's `weight` was taken (negative means a backlog the next caller waits out).
   *
   * **Every parameter is cast explicitly, and in `CAST(x AS t)` form rather than `x::t`.** Postgres
   * infers a parameter's type from its context, and `$3 - $4` in the `VALUES` list has no context to
   * infer from — it refuses the statement with "could not determine data type of parameter". The
   * casts also pin the arithmetic: `tokens` is `DOUBLE PRECISION` and `last_refill_ms` is `BIGINT`.
   *
   * The FORM matters as much as the casts. `::` is Postgres-only syntax, while `CAST(x AS t)` is
   * standard and SQLite parses it (applying its own affinity, which is the same intent). That is
   * what lets `pg-store-parity.test.ts` execute THIS text — not a paraphrase of it — against an
   * in-memory engine, so the statement's arithmetic is measured in a suite that R-21 forbids to
   * reach a database.
   *
   * **`GREATEST(0, …)` on the elapsed interval** is the clamp the in-process bucket has always
   * applied. See the SQLite twin for the argument; it is the same one, and the two statements carry
   * it or neither does.
   */
  async take(
    key: LimiterKey,
    config: TokenBucketConfig,
    weight: number,
    nowMs: number,
  ): Promise<LimiterTake> {
    // The foreign-key target must exist before the row that references it — see `ready`.
    await this.ready;
    const rows = await this.client.query<TokensRow>(
      `INSERT INTO onchain.provider_buckets (provider, scope_key, tokens, last_refill_ms, updated_at)
       VALUES ($1, $2,
               CAST($3 AS DOUBLE PRECISION) - CAST($4 AS DOUBLE PRECISION),
               CAST($5 AS BIGINT), CAST($5 AS BIGINT))
       ON CONFLICT (provider, scope_key) DO UPDATE SET
         tokens = LEAST(CAST($3 AS DOUBLE PRECISION),
                        onchain.provider_buckets.tokens
                        + GREATEST(0, CAST($5 AS BIGINT) - onchain.provider_buckets.last_refill_ms)
                          / 1000.0 * CAST($6 AS DOUBLE PRECISION))
                  - CAST($4 AS DOUBLE PRECISION),
         last_refill_ms = CAST($5 AS BIGINT),
         updated_at = CAST($5 AS BIGINT)
       RETURNING tokens`,
      [key.providerId, key.scopeKey, config.capacity, weight, nowMs, config.refillPerSec],
    );
    const row = rows[0];
    // An upsert's `RETURNING` answers for both branches, so no row means the statement did not run.
    // This module has no reading of that state and refuses rather than papering over it with a full
    // bucket — which is the one wrong answer, because it admits the call.
    if (row === undefined) {
      throw new Error(
        `PgLimiterStore: the bucket statement returned no row for ` +
          `(${key.providerId}, ${key.scopeKey}) — the limiter has no state to decide on`,
      );
    }
    const tokensLeft = Number(row.tokens);
    return { tokensLeft, waitMs: waitMsFor(tokensLeft, config.refillPerSec) };
  }

  /** The refund (§4.5.6, "The refund is a second statement") — `tokens` only. See
   * `LimiterStore.refund` for why `last_refill_ms` must not move and why this is not an upsert. */
  async refund(key: LimiterKey, weight: number, nowMs: number): Promise<void> {
    await this.ready;
    await this.client.query(
      `UPDATE onchain.provider_buckets
          SET tokens = tokens + CAST($3 AS DOUBLE PRECISION), updated_at = CAST($4 AS BIGINT)
        WHERE provider = $1 AND scope_key = $2`,
      [key.providerId, key.scopeKey, weight, nowMs],
    );
  }
}
