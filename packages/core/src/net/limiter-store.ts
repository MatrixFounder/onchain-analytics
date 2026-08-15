import type { TokenBucketConfig } from './rate-limit.js';

/**
 * The limiter's bucket, addressed by a PAIR (task 014-17, R-7, `data-model.md` §4.5.6).
 *
 * **Why a store exists at all.** Today the token bucket is a `Map` inside one process, so two
 * processes hitting one vendor each get the full rate and the vendor sees double. R-7 makes the
 * limiter's state shared; this interface is the seam that lets it be, and task 014-18 puts the
 * atomic statement behind it.
 *
 * **Why the key is `(providerId, scopeKey)` and not one string.** `provider_buckets` is keyed on two
 * columns, and `provider` carries a foreign key to `onchain.providers`. A single fused string would
 * make the reference impossible and the "all of this provider's buckets" query a `LIKE`.
 */
export interface LimiterKey {
  readonly providerId: string;
  readonly scopeKey: string;
}

/**
 * The scope of a provider that declares no split: ONE bucket for all of its calls.
 *
 * **Why a sentinel and not `NULL`.** The column is part of a primary key, and `NULL` is not equal to
 * `NULL` in either engine — a nullable component would make every unsplit provider's rows distinct
 * from each other and the bucket would never be found twice.
 */
export const DEFAULT_SCOPE_KEY = '-';

/**
 * The separator between the two halves inside a `throttle` argument.
 *
 * **Why the scope travels inside `providerId` rather than as a new parameter.** Task 014-17 keeps
 * `throttle(providerId, config, weight?, deadlineAtMs?)` unchanged — it is called from eleven
 * adapters, and widening it would edit all of them to express a fact that concerns two. A provider
 * that splits composes its id here; the store splits it back into the two columns it stores.
 *
 * `#` is chosen because no adapter id contains it (they are lowercase and hyphenated) and no chain
 * slug does either, so the composition stays injective.
 */
export const SCOPE_SEPARATOR = '#';

/** Composes the argument a splitting provider passes to `throttle`. */
export function scopedProviderId(providerId: string, scope?: string | undefined): string {
  return scope === undefined || scope === ''
    ? providerId
    : `${providerId}${SCOPE_SEPARATOR}${scope}`;
}

/** Splits it back into the pair the store is keyed on. The inverse of {@link scopedProviderId}. */
export function limiterKeyOf(scopedId: string): LimiterKey {
  const at = scopedId.indexOf(SCOPE_SEPARATOR);
  return at === -1
    ? { providerId: scopedId, scopeKey: DEFAULT_SCOPE_KEY }
    : { providerId: scopedId.slice(0, at), scopeKey: scopedId.slice(at + 1) };
}

/**
 * What one `take` answers: the tokens left after this caller's weight, and how long to wait.
 *
 * **Named `LimiterTake` and not `LimiterSlot`** — `pg/stores.ts` already owns that name for a
 * different thing (which limiter an axis HAS), and two meanings of one word in one package is how a
 * reader ends up asserting the wrong one.
 */
export interface LimiterTake {
  /** Negative means a backlog: this caller consumed into it and must wait it out. */
  readonly tokensLeft: number;
  /** Milliseconds this caller must wait before proceeding. `0` when a token was free. */
  readonly waitMs: number;
}

/**
 * Refill, consume and read — ONE operation, because the three cannot be separated.
 *
 * **Why a single method and not read/write.** Two processes that read, decide and write would both
 * see the same tokens and both proceed: the interleaving is the whole failure R-7 is about. §4.5.6
 * specifies one `INSERT … ON CONFLICT … RETURNING`, and a seam that permitted a read-then-write
 * shape would let a correct implementation and an incorrect one both satisfy it.
 *
 * **Why the clock is a parameter.** The decision must read ONE sample — refill, spend and the
 * wait arithmetic all against the same instant — which is the premise `rate-limit.ts` already
 * states for its in-process bucket. A store that read its own clock would take a second sample.
 */
export interface LimiterStore {
  take(
    key: LimiterKey,
    config: TokenBucketConfig,
    weight: number,
    nowMs: number,
  ): Promise<LimiterTake>;
}

/**
 * The in-process store — the `[STUB]` half of task 014-17.
 *
 * It is a faithful model of the arithmetic and NOT of the sharing: one process, one map. That is
 * exactly the state R-7 exists to end, and saying so here is what keeps this from being mistaken for
 * the shared limiter. Task 014-18 lands the Postgres operator; task 014-19 makes THIS the declared
 * fallback when that operator's store fails, with a `limiter.degraded` row naming the degradation.
 */
export function createInProcessLimiterStore(): LimiterStore {
  const buckets = new Map<string, { tokens: number; lastRefillMs: number }>();
  return {
    take(key, config, weight, nowMs) {
      const id = `${key.providerId}${SCOPE_SEPARATOR}${key.scopeKey}`;
      const bucket = buckets.get(id) ?? { tokens: config.capacity, lastRefillMs: nowMs };
      const elapsedMs = Math.max(0, nowMs - bucket.lastRefillMs);
      const refilled = Math.min(
        config.capacity,
        bucket.tokens + (elapsedMs / 1000) * config.refillPerSec,
      );
      const tokensLeft = refilled - weight;
      buckets.set(id, { tokens: tokensLeft, lastRefillMs: nowMs });
      const waitMs = tokensLeft >= 0 ? 0 : Math.ceil((-tokensLeft / config.refillPerSec) * 1000);
      return Promise.resolve({ tokensLeft, waitMs });
    },
  };
}
