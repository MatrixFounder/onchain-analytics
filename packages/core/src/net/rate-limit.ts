/**
 * Per-provider token-bucket configuration (D4/R-26, `providers.config.ts`'s `rateLimit` field).
 */
export interface TokenBucketConfig {
  capacity: number;
  refillPerSec: number;
}

/** Injectable clock/waiter (task 003-2: "injectable clock for tests — NO real timers in unit
 * tests"). Production call sites omit both and get real `Date.now`/`setTimeout`. */
export interface ThrottleDeps {
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
}

/** A bound throttle function for one bucket-state instance — see `createThrottle`. */
export type Throttle = (providerId: string, config: TokenBucketConfig) => Promise<void>;

interface BucketState {
  tokens: number;
  lastRefillMs: number;
}

function defaultWait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Adversarial cycle 2, fix 7 — the maximum `waitMs` `throttle()` will ever actually await before
 * rejecting instead. See `RateLimitRejectedError`'s "saturation" branch below for the full
 * rationale: a caller stuck behind a severely backed-up bucket should get a clear, fast, typed
 * rejection rather than silently blocking a request handler for up to (or beyond) 30 seconds. */
const MAX_WAIT_MS = 30_000;

/**
 * Thrown by `throttle()` for either of two DISTINCT reasons — both are misconfiguration/overload
 * conditions this module refuses to silently paper over:
 *
 * 1. **Misconfigured rate limit** (adversarial cycle 1, fix C): `config.refillPerSec <= 0`. A
 *    non-positive refill rate can never grant another token — the PREVIOUS code computed
 *    `waitMs = Number.POSITIVE_INFINITY` and awaited it, but `setTimeout`'s own documented
 *    behavior clamps an out-of-range delay (anything `> 2147483647` or `< 1`) down to `1`, so that
 *    branch didn't actually hang forever, it silently resolved almost immediately, defeating the
 *    rate limit entirely without any signal that something was misconfigured.
 * 2. **Saturated bucket** (adversarial cycle 2, fix 7): the computed `waitMs` for THIS call
 *    exceeds `MAX_WAIT_MS` (30s) — e.g. a burst of concurrent callers has queued up a backlog
 *    deep enough that this caller's own slot is more than 30s out. Blocking a request handler for
 *    that long is worse than failing fast with a clear, typed, "this provider's rate limit is
 *    saturated" signal the caller's own fallback logic (or the MCP tool's `{ok:false, reason}`
 *    contract) can act on. The reserved token is refunded (`bucket.tokens += 1`) before this
 *    throw, so a rejected call — which will never actually consume its slot — doesn't permanently
 *    worsen the backlog for subsequent, legitimate callers.
 */
export class RateLimitRejectedError extends Error {
  constructor(
    public readonly providerId: string,
    reason: string,
  ) {
    super(`throttle: rejected for provider "${providerId}": ${reason}`);
    this.name = 'RateLimitRejectedError';
  }
}

/**
 * Builds a `throttle(providerId, config)` function with its own isolated per-`providerId` bucket
 * state (a factory, not a shared module singleton — mirrors the `CapabilityRegistry`/`CacheStore`
 * "factory, not singleton" principle, ARCHITECTURE.md §8). Tests call this directly with an
 * injected `now`/`wait` to get deterministic, real-timer-free assertions; the module-level
 * `throttle` export below is the production singleton (real clock/timers), built by calling this
 * with no overrides.
 *
 * Token-bucket algorithm: each `providerId` gets its own bucket, starting full (`capacity`
 * tokens). On every call, the bucket is refilled by `elapsedSeconds * refillPerSec` (capped at
 * `capacity`) based on time elapsed since its last check, then one token is unconditionally
 * consumed. If the resulting balance is still `>= 0`, the call proceeds immediately; otherwise it
 * waits exactly as long as needed for that deficit to refill (`-tokens / refillPerSec` seconds).
 *
 * **Concurrency-safety (adversarial cycle 1, fix C — findings merged).** The refill + consume +
 * decide-whether-to-wait step above is entirely SYNCHRONOUS — there is no `await` anywhere before
 * it fully commits the bucket's new state. This is what makes N concurrent same-`providerId`
 * callers (e.g. `await Promise.all([throttle(id, cfg), throttle(id, cfg), throttle(id, cfg)])`)
 * space out into distinct, cascading wait durations instead of racing on stale state: JS's
 * single-threaded execution model guarantees a batch of concurrent calls run their synchronous
 * prefixes back-to-back, in order, with no interleaving — the Nth call's math always sees the
 * (N-1)th call's fully-committed bucket, never a half-updated one.
 *
 * The PREVIOUS implementation broke exactly this guarantee: on the "must wait" path, it computed
 * `waitMs` from the CURRENT `tokens` value but deferred the actual state commit
 * (`bucket.tokens = 0; bucket.lastRefillMs = now()`) until AFTER `await wait(waitMs)` resolved.
 * Two callers arriving back-to-back while the first was still waiting would both read the SAME
 * pre-wait `tokens` value and compute the IDENTICAL `waitMs` — never spacing out. The fix: `tokens`
 * is allowed to go NEGATIVE and is committed synchronously, immediately, on every call (never
 * reset back to `0` after a real wait resolves) — each subsequent caller's synchronous math then
 * immediately accounts for every still-outstanding reservation ahead of it, so wait durations
 * correctly accumulate (e.g. 0ms, 500ms, 1000ms, ... for successive callers against a
 * 1-capacity/2-per-second bucket) with no explicit queue/mutex object needed.
 */
export function createThrottle(deps: ThrottleDeps = {}): Throttle {
  const now = deps.now ?? Date.now;
  const wait = deps.wait ?? defaultWait;
  const buckets = new Map<string, BucketState>();

  return async function throttle(providerId: string, config: TokenBucketConfig): Promise<void> {
    if (config.refillPerSec <= 0) {
      throw new RateLimitRejectedError(
        providerId,
        'refillPerSec must be > 0 (misconfigured rate limit)',
      );
    }

    const nowMs = now();
    let bucket = buckets.get(providerId);

    if (!bucket) {
      bucket = { tokens: config.capacity, lastRefillMs: nowMs };
      buckets.set(providerId, bucket);
    } else {
      const elapsedSec = Math.max(0, (nowMs - bucket.lastRefillMs) / 1000);
      bucket.tokens = Math.min(config.capacity, bucket.tokens + elapsedSec * config.refillPerSec);
      bucket.lastRefillMs = nowMs;
    }

    bucket.tokens -= 1;
    if (bucket.tokens >= 0) {
      return;
    }

    // Deliberately NOT reset to 0 here (see docstring above) — the negative backlog left in
    // `bucket.tokens` is exactly what the NEXT call's synchronous refill computation reads, which
    // is what makes concurrent callers space out instead of racing on stale state.
    const waitMs = (-bucket.tokens / config.refillPerSec) * 1000;
    if (waitMs > MAX_WAIT_MS) {
      // Refund the reservation — this call will never actually wait/consume its slot, so it must
      // not permanently worsen the backlog for whoever calls next (adversarial cycle 2, fix 7).
      bucket.tokens += 1;
      throw new RateLimitRejectedError(
        providerId,
        `computed wait ${Math.round(waitMs)}ms exceeds the ${MAX_WAIT_MS}ms fairness cap (saturated bucket)`,
      );
    }
    await wait(waitMs);
  };
}

/**
 * Production default (ARCHITECTURE.md §3.2 `net/rate-limit.ts` — the exported flat `throttle`
 * call site future adapters use): a single shared in-process bucket-state instance, real
 * `Date.now`/`setTimeout` (in-memory, one process, no persistence needed in M1 — §3.2/§8). Tests
 * should prefer `createThrottle({ now, wait })` for an isolated, real-timer-free instance instead
 * of this singleton.
 */
export const throttle: Throttle = createThrottle();
