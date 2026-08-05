import { DeadlineExceededError } from './safe-fetch.js';

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

/**
 * A bound throttle function for one bucket-state instance — see `createThrottle`.
 *
 * `weight` is how many tokens this ONE call consumes, default 1. It exists because a token bucket
 * counts OUR calls, while what a vendor's quota counts is upstream requests — and the two stop
 * agreeing the moment a vendor endpoint fans out server-side. `nansen` needs no weight: its
 * composite capabilities genuinely make N requests, so they call this N times and the arithmetic
 * takes care of itself. `blockscout`'s facade is the other shape — one request from us, three
 * upstreams and ~160 credits at the vendor — so one call must be able to cost more than one token.
 *
 * A weight rather than N sequential calls, deliberately: N calls compute N independent waits, each
 * capped at `MAX_WAIT_MS`, so a saturated bucket could park a single logical request for N × 30 s
 * — reintroducing the latency stacking that putting a free provider in front of a paid one was
 * supposed to avoid. One weighted call computes one wait against one cap.
 *
 * `deadlineAtMs` (task 012-7, R-146) is the caller's ABSOLUTE deadline in epoch-ms — never a
 * duration, for the reason `SafeFetchOptions.deadlineAtMs` gives. Omitted, the limiter behaves
 * exactly as it always has: the only ceiling on a wait is `MAX_WAIT_MS`.
 */
export type Throttle = (
  providerId: string,
  config: TokenBucketConfig,
  weight?: number,
  deadlineAtMs?: number,
) => Promise<void>;

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
 * Adversarial cycle 2, finding F-2 — the time that must STILL BE LEFT once a limiter wait has been
 * served, for admitting the call to be anything other than a way to spend the caller's whole budget
 * on sleep.
 *
 * **The defect the floor closes.** The refusal below used to read `waitMs > remainingMs`, so
 * `waitMs === remainingMs` was admitted, and so was every wait that leaves a sliver. The caller then
 * wakes with ~0 ms of budget, `safeFetch` refuses on hop entry with `DeadlineExceededError` — the
 * TERMINAL class — the registry sets `deadlineHit`, and every adapter BEHIND this one is refused
 * unasked. That is H-1 one floor down, produced by the very branch `DeadlineWouldExceedError` exists
 * to prevent it with: on `entity.labels` (`deadlineMs: 60_000`, `blockscout`'s `{capacity: 5,
 * refillPerSec: 2}`) an entry with 31 s left and a 30 s backlog slept 30 s and then cancelled
 * `nansen`, whose bucket was idle and for whom those 31 s were entirely real.
 *
 * **Where 5_000 comes from.** It is the shortest per-hop timeout configured by an adapter that ALSO
 * hands this limiter a `deadlineAtMs` — `REQUEST_TIMEOUT_MS`, configured identically by
 * `blockscout/index.ts` and `blockchain-info/index.ts`; `safeFetch`'s default is 15_000. With at
 * least that much left when the hop is issued, that adapter's own timeout expires no later than the
 * deadline does, so a hop that fails is reported as `SafeFetchTimeoutError` ("this vendor did not
 * answer") — which is NOT terminal for the registry — instead of as our own expiry, which is.
 *
 * **The evidence for that sentence was one adapter wide for three tasks, and is now two** (cycle 3,
 * perf, then WI-37). The original text cited `blockchain-info` beside `blockscout` on the strength of
 * the shared 5_000 — and, measured 2026-08-05, `blockchain-info` had ZERO `deadlineAtMs` occurrences:
 * it never passed one, never reached this branch, and so could not exercise the guarantee, which made
 * the evidence look twice as wide as it was. WI-37 threaded the deadline into it (and eight others),
 * so the citation is now true for the reason it was originally written. **The NUMBER is unchanged**:
 * 5_000 is still the shortest such timeout, because the eight adapters that joined either run on the
 * 15_000 default or, for `pg-history`, on a 20_000 in-process query bound.
 *
 * **The pre-wait test alone does not establish it, which is why there are two.** `remainingMs -
 * waitMs` is a PREDICTION evaluated before `await wait(waitMs)`: a timer resolves no EARLIER than its
 * delay and may resolve arbitrarily later (a busy event loop, a suspended process), so the budget
 * observed on waking can be below the floor the prediction promised. The re-check after the wait
 * turns it into an observation — see the second refusal in `createThrottle` below.
 *
 * **Where it can actually fire.** Not on the FIRST throttle call of an `entity.labels` walk
 * (`deadlineMs: 60_000`): `MAX_WAIT_MS` caps `waitMs` at 30_000 above, and ~60_000 remain, so the
 * remainder is ≥ 30_000 by arithmetic. It is reachable on later hops within one adapter's own
 * multi-hop fetch, and on any route whose budget is smaller. On `token.holders` —
 * `adapterIds: ['blockscout']` alone (`providers.config.ts`) — "ask the next one" has NO next one:
 * the caller gets `CapabilityUnavailableError` with several seconds still on the clock. That is the
 * intended trade (a refusal naming the saturated provider beats a terminal expiry naming us) and it
 * is not a fallback; it is also why the number is a floor and not a target.
 *
 * **What it does not establish.** It is not a measured vendor latency and it does not promise the
 * admitted request completes; for an adapter on the 15_000 default the attribution guarantee above
 * does not hold, and all the floor buys there is "the request is issued with a non-trivial budget".
 * Both directions cost: raising it refuses more free buckets and moves traffic to the PAID adapter
 * behind them sooner, lowering it re-opens the terminal misattribution above.
 */
const MIN_POST_WAIT_REMAINDER_MS = 5_000;

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
 * Sibling of `RateLimitRejectedError`, and deliberately NOT the same class as `DeadlineExceededError`
 * (task 012-7, finding H-A). It says: **this provider's bucket cannot free up in the time that is
 * left — but there IS time left.**
 *
 * The distinction is the whole point, and merging the two reproduces H-1 one floor down. On
 * `entity.labels` a burst saturates the free `blockscout` bucket (`capacity 5, refillPerSec 2`) into
 * a 30 s wait while 20 s of deadline remain. Reading that as "the deadline is spent" ends the
 * traversal and never asks `nansen`, whose bucket is idle and for whom those 20 s are entirely real
 * — a free source's unavailability cutting off the paid one, which is exactly what H-1 forbids.
 * So: `DeadlineExceededError` means "time is up for EVERY adapter on this route"; this class means
 * "not through THIS provider, ask the next one".
 *
 * The registry acts on that difference (task 012-8): this class does NOT set `deadlineHit` and does
 * not end the loop.
 *
 * **`minRemainderMs` (cycle 2, F-2).** The refusal is no longer "the wait is longer than the time
 * left" but "the wait would not leave `MIN_POST_WAIT_REMAINDER_MS` behind it" — see that constant
 * for why sleeping until the budget is a sliver produced the TERMINAL class one layer down and thus
 * the exact outcome this class exists to avoid. Carried on the error so the message can state the
 * rule that refused, rather than a rule that no longer decides anything.
 *
 * **`phase` (cycle 3, perf).** The same rule is applied twice, and the two are different facts about
 * a call: `'predicted'` refused BEFORE sleeping, on arithmetic, and cost nothing; `'observed'` slept
 * the full wait and then measured less budget than the arithmetic promised, which means a timer ran
 * long. They are one class because the caller acts identically on both — ask the next provider — and
 * a distinguishable field because only the second is evidence about the runtime rather than about the
 * bucket. `remainingMs` follows suit: the budget as PREDICTED at decision time, or as MEASURED on
 * waking.
 */
export class DeadlineWouldExceedError extends Error {
  constructor(
    public readonly providerId: string,
    public readonly computedWaitMs: number,
    public readonly remainingMs: number,
    public readonly minRemainderMs: number,
    public readonly phase: 'predicted' | 'observed' = 'predicted',
  ) {
    super(
      phase === 'predicted'
        ? `throttle: rejected for provider "${providerId}": computed wait ${Math.round(computedWaitMs)}ms ` +
            `would leave ${Math.round(remainingMs - computedWaitMs)}ms of the ${Math.round(remainingMs)}ms ` +
            `left before the call deadline — under the ${minRemainderMs}ms a request needs to be worth issuing`
        : `throttle: rejected for provider "${providerId}": waited ${Math.round(computedWaitMs)}ms and only ` +
            `${Math.round(remainingMs)}ms of the call deadline is left — under the ${minRemainderMs}ms a ` +
            `request needs to be worth issuing (the wait overran its computed duration)`,
    );
    this.name = 'DeadlineWouldExceedError';
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
 *
 * **The call deadline (task 012-7, R-146/AC-9), when `deadlineAtMs` is passed.** The wait used to be
 * unconditional up to `MAX_WAIT_MS`, so a call with a 15 s capability budget could sleep 30 s inside
 * the limiter — the budget being ignored by the very component that spends the most time. Three
 * refusals now sit on the deficit path, and they are three because they state DIFFERENT facts:
 *
 * | Condition                                                     | Meaning                                            | Result                    |
 * | ------------------------------------------------------------- | -------------------------------------------------- | ------------------------- |
 * | `remainingMs <= 0`                                            | our time is up — true for EVERY adapter on the route | `DeadlineExceededError`   |
 * | `remainingMs > 0`, `remainingMs - waitMs < MIN_POST_WAIT_REMAINDER_MS` | not through THIS bucket; other providers still have time | `DeadlineWouldExceedError` (`'predicted'`) |
 * | after the wait, `deadlineAtMs - now() < MIN_POST_WAIT_REMAINDER_MS`    | the wait overran what was computed for it          | `DeadlineWouldExceedError` (`'observed'`) |
 * | `remainingMs - waitMs >= MIN_POST_WAIT_REMAINDER_MS`          | the deadline was never the binding constraint      | waits, as always          |
 *
 * The third row is cycle 3's: rows two and four are arithmetic done BEFORE the sleep, and a timer
 * that fires late makes that arithmetic a hope rather than a fact. Only the post-wake measurement
 * makes "the hop starts with at least `MIN_POST_WAIT_REMAINDER_MS` left" a property of the call
 * instead of a property of the scheduler.
 *
 * The second row's test was `waitMs > remainingMs` until cycle 2's F-1..F-9 pass, which admitted the
 * equality AND every wait leaving a sliver — the caller then woke with no budget and produced the
 * TERMINAL class one layer down. `MIN_POST_WAIT_REMAINDER_MS` carries that whole argument.
 *
 * Both refusals refund the reservation (`bucket.tokens += weight`) exactly like the `MAX_WAIT_MS`
 * branch above them: a call that never waits must not leave its slot spent for whoever calls next.
 * The refusal decision reads the SAME `nowMs` sample as the refill and the spend, so it adds no
 * `await` before the bucket state is committed and the concurrency guarantee above still holds.
 */
export function createThrottle(deps: ThrottleDeps = {}): Throttle {
  const now = deps.now ?? Date.now;
  const wait = deps.wait ?? defaultWait;
  const buckets = new Map<string, BucketState>();

  return async function throttle(
    providerId: string,
    config: TokenBucketConfig,
    weight = 1,
    deadlineAtMs?: number,
  ): Promise<void> {
    if (config.refillPerSec <= 0) {
      throw new RateLimitRejectedError(
        providerId,
        'refillPerSec must be > 0 (misconfigured rate limit)',
      );
    }
    // Fail loudly rather than silently degrading to 1: a weight that is not a positive integer is a
    // caller bug, and the failure mode of guessing here is a limiter quietly not limiting.
    if (!Number.isInteger(weight) || weight < 1) {
      throw new RateLimitRejectedError(
        providerId,
        `weight must be a positive integer (got ${String(weight)})`,
      );
    }
    // A weight above `capacity` can never be satisfied — the bucket refills to `capacity` at most,
    // so the deficit never clears and the caller would wait out the fairness cap on every call, on
    // a full bucket, forever. Say so instead.
    if (weight > config.capacity) {
      throw new RateLimitRejectedError(
        providerId,
        `weight ${weight} exceeds bucket capacity ${config.capacity} — unsatisfiable`,
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

    bucket.tokens -= weight;
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
      // Refunds `weight`, not 1: a partial refund would leak tokens out of the bucket on every
      // rejected weighted call, tightening the limiter a little more each time until it stopped
      // admitting anything.
      bucket.tokens += weight;
      throw new RateLimitRejectedError(
        providerId,
        `computed wait ${Math.round(waitMs)}ms exceeds the ${MAX_WAIT_MS}ms fairness cap (saturated bucket)`,
      );
    }

    // The call deadline (task 012-7, R-146/AC-9). TWO conditions, never one — see
    // `DeadlineWouldExceedError` for why merging them reproduces H-1 one floor down.
    //
    // Placement, deliberately: HERE, on the deficit path, after the reservation and after the
    // fairness cap. (1) A refund is only meaningful where a reservation was made, and both
    // refusals below refund — so the branch belongs where `bucket.tokens` has already gone
    // negative. A caller whose deadline is spent but whose bucket is full is simply admitted; the
    // deadline is then enforced by `safeFetch`'s own entry check, one layer down, which is the
    // layer that would otherwise make the network call. (2) The fairness cap keeps its precedence
    // so its message and class are untouched — it is a statement about the bucket that is true
    // with or without a deadline, and neither refusal STOPS the registry's walk.
    //
    // "Non-terminal" is the honest word, and an earlier version of this note over-claimed with
    // "both refusals are non-terminal for the registry anyway" read as "the walk cannot end as a
    // deadline" (adversarial cycle 2, F-7). What `DeadlineWouldExceedError` guarantees is that the
    // adapters BEHIND this one are still asked; it does not guarantee the walk's final verdict.
    // The registry's terminal branch also reads the clock (`Date.now() >= effectiveDeadlineAtMs`),
    // and on a one-adapter route refused with a millisecond left that clock has moved by the time
    // it is read — so the walk can still end as `CapabilityDeadlineExceededError`. The mirror of
    // this note is on that branch in `adapters/registry.ts`.
    //
    // `nowMs`, not a fresh `now()`: the entire decision (refill, spend, wait-or-refuse) reads ONE
    // clock sample, which is the premise of this function's concurrency guarantee.
    if (deadlineAtMs !== undefined) {
      const remainingMs = deadlineAtMs - nowMs;
      if (remainingMs <= 0) {
        // Genuine expiry — true for EVERY adapter on the route, so this ends the traversal.
        bucket.tokens += weight;
        throw new DeadlineExceededError(`provider "${providerId}"`, deadlineAtMs);
      }
      // A different fact: time is left, but not through THIS provider's bucket. Ask the next one.
      //
      // The test is on what the wait LEAVES, not on whether it fits (cycle 2, F-2). A wait that
      // consumes the budget down to a sliver "fits" by the old arithmetic and then produces
      // `DeadlineExceededError` — the terminal class — from `safeFetch` a moment later, which ends
      // the traversal for every adapter behind this one. Refusing here instead keeps the fact
      // per-provider, which is this class's entire reason to exist.
      if (remainingMs - waitMs < MIN_POST_WAIT_REMAINDER_MS) {
        bucket.tokens += weight;
        throw new DeadlineWouldExceedError(
          providerId,
          waitMs,
          remainingMs,
          MIN_POST_WAIT_REMAINDER_MS,
        );
      }
    }

    await wait(waitMs);

    // THE SECOND HALF OF THE SAME RULE (cycle 3, perf). The test above is arithmetic performed
    // before the sleep; a timer is only guaranteed not to fire EARLY, so the budget actually left on
    // waking can be smaller than the arithmetic promised — an overloaded event loop, a suspended
    // process, or simply a `wait` implementation with coarse resolution. Without this the floor's
    // whole claim ("the hop is issued with at least the shortest hop timeout left, so its failure is
    // attributed to the vendor and not to us") would hold only under a scheduler nobody guarantees.
    //
    // A FRESH `now()`, unlike everywhere else in this function: the one-clock-sample rule exists so
    // the refill/spend/wait decision is internally consistent, and this is a different decision made
    // at a different time — reusing `nowMs` here would re-read the very prediction being checked.
    //
    // **No refund, deliberately** — and this is the one refusal that must not. The other two never
    // waited, so their reservation was never earned by elapsed time; this one slept the full
    // `waitMs`, and the deficit it left in `bucket.tokens` is repaid by the lazy refill the next
    // caller performs from `lastRefillMs`. Adding the token back as well would credit the bucket
    // twice for one interval and let it admit more than `refillPerSec` allows.
    if (deadlineAtMs !== undefined) {
      const observedRemainingMs = deadlineAtMs - now();
      if (observedRemainingMs < MIN_POST_WAIT_REMAINDER_MS) {
        throw new DeadlineWouldExceedError(
          providerId,
          waitMs,
          observedRemainingMs,
          MIN_POST_WAIT_REMAINDER_MS,
          'observed',
        );
      }
    }
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
