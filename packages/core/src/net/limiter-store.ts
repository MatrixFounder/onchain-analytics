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
 *
 * **Why the empty string specifically, and why this changed in task 014-18.** Task 014-17 declared
 * the sentinel as `'-'` while every other statement of the same fact said `''`: `data-model.md`
 * §4.5.6 (`scope_key TEXT NOT NULL DEFAULT ''`, "'' = one bucket per provider"), the SQLite
 * declaration in `cache/ddl.ts`, the Postgres one in `sql/migrations/002_t014_network_profile.sql`,
 * task 014-36, and both DDL gates. Nothing had ever written a row, so the divergence cost nothing
 * and would have cost the first operator who ran `WHERE scope_key = ''` against a table full of
 * `'-'` — and the column DEFAULT, which is the value an out-of-band `INSERT` gets, would have been
 * a scope no process ever uses. 014-18 is the task that starts writing this column, so it is the
 * last moment the two can be reconciled for free.
 */
export const DEFAULT_SCOPE_KEY = '';

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
 * **Named `LimiterTake` and not `LimiterSlot`** — an earlier revision of `pg/stores.ts` owned that
 * name for a different thing, and two meanings of one word in one package is how a reader ends up
 * asserting the wrong one. (That type was retired by task 014-18 once both axes had a store; the
 * name stays taken as far as this comment is concerned, because reviving it would revive the
 * ambiguity.)
 */
export interface LimiterTake {
  /** Negative means a backlog: this caller consumed into it and must wait it out. */
  readonly tokensLeft: number;
  /** Milliseconds this caller must wait before proceeding. `0` when a token was free. */
  readonly waitMs: number;
}

/**
 * The wait a deficit implies — ONE definition, shared by all three stores (task 014-18).
 *
 * **Why it is a function here rather than arithmetic in each store.** The three implementations
 * differ in where the bucket lives and in nothing else; a wait computed one way in the map and
 * another way in SQL would make "the same bucket state" produce two different waits depending on
 * which profile the process runs under, and that difference would surface as a flaky latency
 * measurement long before anyone suspected the limiter.
 *
 * **Not rounded, deliberately.** Task 014-17's in-process stub applied `Math.ceil` and had no
 * consumer; `rate-limit.ts` has computed the raw float since task 003-2. Rounding up would move
 * every wait by up to a millisecond and, on a deficit carrying float dust (`-0.6000000000000001`,
 * which is what 700 ms of refill against a 2/sec bucket actually leaves), by a whole one — so the
 * arithmetic that has always run is the arithmetic kept.
 */
export function waitMsFor(tokensLeft: number, refillPerSec: number): number {
  return tokensLeft >= 0 ? 0 : (-tokensLeft / refillPerSec) * 1000;
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

  /**
   * Puts `weight` back for a caller that was refused and will never spend its slot (task 014-18,
   * `data-model.md` §4.5.6: "The refund is a second statement").
   *
   * **Why a second statement and not `take` with a negative weight.** A refund must not refill and
   * must not clamp: it adds exactly what was taken, to whatever the bucket now holds. Routed
   * through `take`, it would re-apply `MIN(capacity, …)` and could hand back a token the elapsed
   * time had not earned — the bucket credited twice for one interval, which is the defect the
   * post-wake refusal in `rate-limit.ts` documents from the other side.
   *
   * **Why `last_refill_ms` is not touched.** It marks the instant the bucket was last brought
   * forward. Moving it on a refund would discard the interval between that instant and now, and the
   * next caller's refill would start from the wrong place — a limiter that quietly tightens on
   * every refusal.
   *
   * **Between the two statements another process can observe a more negative bucket.** That
   * over-restricts and never over-admits, which is the direction a vendor ceiling tolerates
   * (§4.5.6).
   *
   * **`nowMs` is passed even though no arithmetic reads it.** It stamps `updated_at`, and a store
   * that sampled its own clock for that would be the one place in this seam where a real timer
   * reaches a unit test. An implementation with no such column simply declares two parameters.
   */
  refund(key: LimiterKey, weight: number, nowMs: number): Promise<void>;
}

/**
 * The in-process store — task 014-17's `[STUB]`, and task 014-19's declared FALLBACK.
 *
 * It is a faithful model of the arithmetic and NOT of the sharing: one process, one map. That is
 * exactly the state R-7 exists to end, and saying so here is what keeps this from being mistaken for
 * the shared limiter.
 *
 * **It survives task 014-18 rather than being replaced by it.** R-7.7 degrades a process whose STORE
 * fails to a per-process bucket, and this is the bucket it degrades to (`system-architecture.md`
 * §3.4.4). Deleting it once the shared stores existed would have left 014-19 to write it again.
 *
 * It is also what `createThrottle` builds when no store is injected, so a caller that wants today's
 * single-process behaviour — every unit test in this package, and `stdio` before the axis is wired —
 * gets it by omission rather than by naming a second constructor.
 */
export function createInProcessLimiterStore(): LimiterStore {
  const buckets = new Map<string, { tokens: number; lastRefillMs: number }>();
  const idOf = (key: LimiterKey): string => `${key.providerId}${SCOPE_SEPARATOR}${key.scopeKey}`;
  return {
    take(key, config, weight, nowMs) {
      const id = idOf(key);
      const bucket = buckets.get(id) ?? { tokens: config.capacity, lastRefillMs: nowMs };
      const elapsedMs = Math.max(0, nowMs - bucket.lastRefillMs);
      const refilled = Math.min(
        config.capacity,
        bucket.tokens + (elapsedMs / 1000) * config.refillPerSec,
      );
      const tokensLeft = refilled - weight;
      buckets.set(id, { tokens: tokensLeft, lastRefillMs: nowMs });
      return Promise.resolve({ tokensLeft, waitMs: waitMsFor(tokensLeft, config.refillPerSec) });
    },

    refund(key, weight) {
      // A refund reaches a bucket that `take` created a moment ago, so the absent case is not a
      // real path. Ignoring it rather than seeding a row keeps the two engine implementations
      // honest: neither of them can invent a bucket on a refund either, because a refund carries no
      // capacity to seed one with.
      const bucket = buckets.get(idOf(key));
      if (bucket !== undefined) bucket.tokens += weight;
      return Promise.resolve();
    },
  };
}
