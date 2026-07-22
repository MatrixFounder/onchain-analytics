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
 * `capacity`) based on time elapsed since its last check. If at least one token is available, one
 * is consumed and the call proceeds immediately; otherwise the call waits exactly as long as
 * needed for one token to become available (`deficit / refillPerSec` seconds) before proceeding.
 */
export function createThrottle(deps: ThrottleDeps = {}): Throttle {
  const now = deps.now ?? Date.now;
  const wait = deps.wait ?? defaultWait;
  const buckets = new Map<string, BucketState>();

  return async function throttle(providerId: string, config: TokenBucketConfig): Promise<void> {
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

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return;
    }

    const deficit = 1 - bucket.tokens;
    const waitMs =
      config.refillPerSec > 0 ? (deficit / config.refillPerSec) * 1000 : Number.POSITIVE_INFINITY;
    await wait(waitMs);
    bucket.tokens = 0;
    bucket.lastRefillMs = now();
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
