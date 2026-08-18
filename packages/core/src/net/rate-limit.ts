import { DeadlineExceededError } from './safe-fetch.js';

/**
 * Per-provider token-bucket configuration (D4/R-26, `providers.config.ts`'s `rateLimit` field).
 */
import {
  createInProcessLimiterStore,
  limiterKeyOf,
  type LimiterKey,
  type LimiterStore,
  type LimiterTake,
} from './limiter-store.js';

export interface TokenBucketConfig {
  capacity: number;
  refillPerSec: number;
}

/** Injectable clock/waiter (task 003-2: "injectable clock for tests — NO real timers in unit
 * tests"). Production call sites omit both and get real `Date.now`/`setTimeout`. */
export interface ThrottleDeps {
  now?: () => number;
  wait?: (ms: number) => Promise<void>;
  /**
   * Where the bucket lives (task 014-17's seam, task 014-18's implementations; R-7, R-8).
   *
   * Absent means `createInProcessLimiterStore()` — one map, one process, which is exactly today's
   * behaviour and what every unit test in this package wants. `createStateStores` hands the axis's
   * shared store here instead, and from that point two processes against one `DATA_DIR` (or one
   * Postgres) hold ONE ceiling between them rather than one each.
   *
   * **Injectable, exactly as the clock is** (R-8): the limiter's dependency is a parameter and never
   * a module-level singleton, so a test can substitute a failing store and observe R-7.7's
   * degradation rather than simulate it.
   */
  store?: LimiterStore;
  /**
   * The degradation port (task 014-19, R-7.7, `system-architecture.md` §3.4.4).
   *
   * **Why a port of one method and not the diagnostics writer.** `throttle` lives in
   * `packages/core` and the writer lives in `packages/mcp-server`, the package `core` is forbidden
   * to know about (`security.md` §7.5.1). One method keeps `core` unable to name a table, a
   * principal or a connection.
   *
   * **Why `void` and not a promise.** Degradation is already the slow path: awaiting a write here
   * would add the store's latency to a call that just failed to reach a store. The sink owns its
   * own buffering.
   *
   * **Why optional.** Omitted, the limiter degrades exactly as it does with it and writes nothing.
   * `createThrottle()` is called with no arguments for the module singleton, and every existing
   * test constructs it the same way.
   */
  emit?: (event: 'limiter.degraded', detail: Record<string, unknown>) => void;
  /**
   * How a store call is bounded (§3.4.4 item 1). Injected by tests so a HANGING store is proven
   * without a real timer; production gets `setTimeout`.
   *
   * A hang is the failure a `try`/`catch` does not cover, and it is the one that matters most: a
   * throwing store costs a caller nothing, while a store that never answers parks every throttling
   * call in the process for as long as the outage lasts — turning a storage failure into the
   * service outage R-7.7 exists to prevent.
   */
  storeTimer?: (ms: number) => LimiterStoreTimer;
}

/** A cancellable deadline for one store call. `promise` never resolves; it only rejects. */
export interface LimiterStoreTimer {
  readonly promise: Promise<never>;
  readonly cancel: () => void;
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
 * How long one store call may take before the process treats the store as unavailable
 * (`system-architecture.md` §3.4.4 item 1, applied value).
 *
 * **Where the number comes from.** One fifth of `MIN_POST_WAIT_REMAINDER_MS`, and the ratio is the
 * point rather than the number: a failing store must cost the caller LESS time than the floor it
 * must still clear afterwards. At 1 000 ms a caller that meets a dead store still has at least
 * 4 000 ms of any budget that was going to clear the floor at all, so the outage does not convert
 * an admissible call into `DeadlineWouldExceedError` by itself.
 */
const STORE_CALL_TIMEOUT_MS = 1_000;

/**
 * How long the process serves from its own bucket before trying the store again (§3.4.4 item 4,
 * applied value; measured: none).
 *
 * **What it buys.** Without it, an outage is paid for once per call by every caller — each one
 * waiting out `STORE_CALL_TIMEOUT_MS` to learn what the previous one already learned. With it, the
 * cost of an outage is one timeout a minute per process.
 *
 * **What it costs, stated rather than left to be discovered.** Up to a minute of per-process
 * limiting after the store has recovered. That is the same direction as degradation itself — each
 * process holds itself to the declared ceiling and the SUM across processes may exceed it — so the
 * cooldown widens a window that is already accepted, and does not open a new kind of hole.
 */
const DEGRADED_COOLDOWN_MS = 60_000;

/** Production's bounded wait: a real timer, unref'd so a pending deadline cannot hold the process
 * open, and cancelled the moment the store answers. */
function realStoreTimer(ms: number): LimiterStoreTimer {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<never>((_resolve, reject) => {
    handle = setTimeout(() => {
      reject(new Error(`limiter store did not answer within ${ms}ms`));
    }, ms);
    handle.unref?.();
  });
  return {
    promise,
    cancel: (): void => {
      if (handle !== undefined) clearTimeout(handle);
    },
  };
}

/**
 * What the bucket held when it refused — R-9.4's «остаток и потолок» (task 014-20).
 *
 * **Why the refusal carries it at all.** Before the shared limiter, a saturated bucket was a fact
 * about one process and an operator could reproduce it by looking at that process. With two sessions
 * against one row, "the wait was 40 s" says nothing about WHY: a caller cannot tell a bucket
 * configured too tight from a bucket someone else drained, and those call for opposite responses —
 * raise the declared rate, or find the other tenant.
 *
 * **Why the rate is here beside the two numbers R-9.4 names.** A remainder without a refill rate
 * does not say when it clears: `-40` against 2/s is twenty seconds and against 0.05/s is thirteen
 * minutes. The requirement asks for the remainder and the ceiling; the rate is what makes the pair
 * actionable rather than merely present.
 *
 * **This is the OPERATOR half and it never reaches a client** (AC-47). It travels inside the
 * attempt list, which `toClientText` cuts before the wire (`transport/failure-classes.ts`).
 */
export interface LimiterBucketState {
  /** Tokens left after this caller's weight. Negative is the backlog — R-9.4's «остаток». */
  readonly remaining: number;
  /** What the bucket refills to — R-9.4's «потолок». */
  readonly ceiling: number;
  /** Tokens per second, so the remainder converts into a duration. */
  readonly refillPerSec: number;
}

/** The one rendering of {@link LimiterBucketState}, so both refusals say it identically. */
export function renderBucketState(bucket: LimiterBucketState): string {
  // Rounded to a tenth: the balance is a float and a caller reading `-1.0000000000000002` learns
  // nothing the tenth does not already tell them.
  return (
    `bucket remaining ${Math.round(bucket.remaining * 10) / 10} of ceiling ${bucket.ceiling} ` +
    `at ${bucket.refillPerSec}/s`
  );
}

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
    /**
     * Present on the saturation branch and absent on the two misconfiguration branches (task
     * 014-20, R-9.4). Absent is not "unknown": `refillPerSec <= 0` and an unsatisfiable `weight` are
     * refused BEFORE any bucket is touched, so there is no state to report and inventing one would
     * describe a bucket that was never read.
     */
    public readonly bucket?: LimiterBucketState,
  ) {
    super(
      `throttle: rejected for provider "${providerId}": ${reason}` +
        (bucket === undefined ? '' : ` (${renderBucketState(bucket)})`),
    );
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
    /** R-9.4, task 014-20 — see {@link LimiterBucketState}. Both phases carry it: the observed one
     * describes the bucket the caller actually waited on, which is the state an operator would
     * otherwise have to reconstruct from a wait duration. */
    public readonly bucket?: LimiterBucketState,
  ) {
    const state = bucket === undefined ? '' : `; ${renderBucketState(bucket)}`;
    super(
      phase === 'predicted'
        ? `throttle: rejected for provider "${providerId}": computed wait ${Math.round(computedWaitMs)}ms ` +
            `would leave ${Math.round(remainingMs - computedWaitMs)}ms of the ${Math.round(remainingMs)}ms ` +
            `left before the call deadline — under the ${minRemainderMs}ms a request needs to be worth ` +
            `issuing${state}`
        : `throttle: rejected for provider "${providerId}": waited ${Math.round(computedWaitMs)}ms and only ` +
            `${Math.round(remainingMs)}ms of the call deadline is left — under the ${minRemainderMs}ms a ` +
            `request needs to be worth issuing (the wait overran its computed duration)${state}`,
    );
    this.name = 'DeadlineWouldExceedError';
  }
}

/**
 * Builds a `throttle(providerId, config)` function over one bucket STORE (a factory, not a shared
 * module singleton — mirrors the `CapabilityRegistry`/`CacheStore` "factory, not singleton"
 * principle, ARCHITECTURE.md §8). Tests call this directly with an injected `now`/`wait` to get
 * deterministic, real-timer-free assertions; the module-level `throttle` export below is the
 * production singleton (real clock/timers, in-process bucket), built by calling this with no
 * overrides.
 *
 * Token-bucket algorithm: each `(providerId, scopeKey)` pair gets its own bucket, starting full
 * (`capacity` tokens). On every call, the bucket is refilled by `elapsedSeconds * refillPerSec`
 * (capped at `capacity`) based on time elapsed since its last check, then `weight` tokens are
 * unconditionally consumed. If the resulting balance is still `>= 0`, the call proceeds
 * immediately; otherwise it waits exactly as long as needed for that deficit to refill
 * (`-tokens / refillPerSec` seconds).
 *
 * **Where that arithmetic runs moved in task 014-18, and the arithmetic did not.** It is one
 * `store.take()` now, so the same three lines serve a `Map`, a SQLite row and a Postgres row —
 * `net/limiter-store.ts` states why a store may not offer a read/write pair instead.
 *
 * **Concurrency-safety (adversarial cycle 1, fix C — findings merged; restated for the store).**
 * N concurrent same-bucket callers must space out into distinct, cascading waits rather than race
 * on stale state. Two facts now carry that, one per topology:
 *
 * - **Within one process** it is still the synchronous prefix. `throttle` reaches `store.take()`
 *   with no `await` before it, and both in-process implementations commit their new state
 *   SYNCHRONOUSLY — the map assignment, and `better-sqlite3`'s statement — before the promise they
 *   return exists. JS's single-threaded model then guarantees the Nth caller's math sees the
 *   (N-1)th caller's committed bucket. A store that awaited I/O before committing would forfeit
 *   this, which is why the interface specifies one operation and not three.
 * - **Across processes** it is the statement. §4.5.6's `INSERT … ON CONFLICT … RETURNING` refills,
 *   spends and reads inside one engine-level atom, so two processes cannot both read the same
 *   tokens and both proceed. That is the failure R-7 exists to end, and no amount of care in this
 *   file could have ended it: the bucket was per-process.
 *
 * The PREVIOUS implementation broke the first guarantee: on the "must wait" path, it computed
 * `waitMs` from the CURRENT `tokens` value but deferred the actual state commit
 * (`bucket.tokens = 0; bucket.lastRefillMs = now()`) until AFTER `await wait(waitMs)` resolved.
 * Two callers arriving back-to-back while the first was still waiting would both read the SAME
 * pre-wait `tokens` value and compute the IDENTICAL `waitMs` — never spacing out. The fix: `tokens`
 * is allowed to go NEGATIVE and is committed immediately, on every call (never reset back to `0`
 * after a real wait resolves) — each subsequent caller's math then accounts for every
 * still-outstanding reservation ahead of it, so wait durations correctly accumulate (e.g. 0ms,
 * 500ms, 1000ms, ... for successive callers against a 1-capacity/2-per-second bucket) with no
 * explicit queue/mutex object needed. Both stored implementations keep that property: the negative
 * balance is what `provider_buckets.tokens` holds, and the column is `REAL` for exactly this reason.
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
 * Both refusals refund the reservation (`store.refund`) exactly like the `MAX_WAIT_MS` branch above
 * them: a call that never waits must not leave its slot spent for whoever calls next.
 *
 * **They decide against a clock sampled AFTER the store answered**, not against the bucket's own
 * instant (`system-architecture.md` §3.4.4). The bucket's arithmetic needs one sample to be
 * self-consistent; the deadline needs the CURRENT time, and a shared store puts a round trip
 * between the two. Deciding "there is time left" on a sample taken before that trip is how a
 * caller is admitted to a wait its budget no longer covers.
 */
export function createThrottle(deps: ThrottleDeps = {}): Throttle {
  const now = deps.now ?? Date.now;
  const wait = deps.wait ?? defaultWait;
  const storeTimer = deps.storeTimer ?? realStoreTimer;
  const shared = deps.store;
  /**
   * R-7.7's fallback, and also the whole limiter when no store is injected.
   *
   * Constructed unconditionally rather than lazily on the first failure: a bucket created at the
   * moment of an outage would start FULL, so the first burst after a store failed would be admitted
   * at capacity on top of whatever the shared row had already granted. Created here, it accumulates
   * nothing while unused and is simply the state this process would have had all along.
   */
  const fallback = createInProcessLimiterStore();

  /**
   * The instant the process may speak to the store again. Zero means "not degraded".
   *
   * One number and not a boolean, because the cooldown and the state are the same fact: while it is
   * in the future the store is not called at all, and the first call after it decides whether the
   * process is still degraded.
   */
  let degradedUntilMs = 0;

  /** Bounds one store call, and always cancels its deadline — a leaked timer per call would be a
   * slow leak in the hottest path this module has. */
  async function bounded<T>(run: () => Promise<T>): Promise<T> {
    const timer = storeTimer(STORE_CALL_TIMEOUT_MS);
    try {
      return await Promise.race([run(), timer.promise]);
    } finally {
      timer.cancel();
    }
  }

  /**
   * Enters degradation and announces it ONCE per transition (R-7.7, AC-45).
   *
   * **Announced on the transition, not on every degraded call.** A degraded process serves every
   * call from its own bucket, and an event per call would be a row per request for the length of an
   * outage — a channel that drowns the eight events `data-model.md` §4.5.8 declares. A second event
   * follows only after the cooldown has expired and a retry has failed again, which is a NEW fact:
   * the outage is still going.
   *
   * **A recovery announces nothing, and that is a residual rather than a decision.**
   * `DIAGNOSTIC_EVENTS` is a closed vocabulary behind a `CHECK` (§4.5.8) and has no member for it,
   * so recovery is visible only as degraded rows stopping. Naming it would mean widening a
   * vocabulary that four other tasks write into.
   */
  function degrade(nowMs: number, phase: 'take' | 'refund', key: LimiterKey, error: unknown): void {
    degradedUntilMs = nowMs + DEGRADED_COOLDOWN_MS;
    deps.emit?.('limiter.degraded', {
      providerId: key.providerId,
      scopeKey: key.scopeKey,
      phase,
      reason: error instanceof Error ? error.message : String(error),
      cooldownMs: DEGRADED_COOLDOWN_MS,
      retryAtMs: degradedUntilMs,
    });
  }

  /**
   * Takes a slot from the shared store, or from this process's own bucket when the store cannot be
   * reached — and says WHICH answered, because the refund has to go back to the same one.
   *
   * **Degradation never skips the bucket.** The alternative R-7.7 rejects is "let the call
   * through"; that would pierce the declared ceiling and, on a route with a paid fallback behind a
   * free source, move spend onto the paid one. So the fallback is consulted on exactly the terms
   * the store would have been.
   */
  async function acquire(
    key: LimiterKey,
    config: TokenBucketConfig,
    weight: number,
    nowMs: number,
  ): Promise<{ take: LimiterTake; served: LimiterStore }> {
    if (shared === undefined || nowMs < degradedUntilMs) {
      return { take: await fallback.take(key, config, weight, nowMs), served: fallback };
    }
    try {
      const take = await bounded(() => shared.take(key, config, weight, nowMs));
      // No `degradedUntilMs = 0` here, and its absence is the point: this branch is only reached
      // when `nowMs >= degradedUntilMs`, so the mark is already a point in the past, and a point in
      // the past is not degradation. Clearing it would be a line no test could distinguish from its
      // own removal — which is how a reader ends up believing recovery is a step rather than the
      // absence of one.
      return { take, served: shared };
    } catch (error) {
      degrade(nowMs, 'take', key, error);
      return { take: await fallback.take(key, config, weight, nowMs), served: fallback };
    }
  }

  /**
   * Returns a slot to whichever store granted it.
   *
   * **The store that served the take is the store that gets the refund**, never "the current one".
   * Crediting the fallback for a slot the shared row is holding would leave the row short by one
   * forever AND hand this process a token it never earned — both buckets wrong, in opposite
   * directions.
   *
   * **A failed refund is swallowed, and the slot stays spent.** The caller is already raising a
   * refusal, and turning a storage failure into a second, different throw would replace a refusal
   * the registry knows how to route ("ask the next provider") with one it does not. The cost is a
   * slot the shared bucket keeps: over-restricting, which is the direction §4.5.6 tolerates.
   */
  async function release(
    served: LimiterStore,
    key: LimiterKey,
    weight: number,
    nowMs: number,
  ): Promise<void> {
    try {
      await (served === shared
        ? bounded(() => served.refund(key, weight, nowMs))
        : served.refund(key, weight, nowMs));
    } catch (error) {
      degrade(nowMs, 'refund', key, error);
    }
  }

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
    // The pair the bucket is keyed on. A provider that declares no split composes nothing, so this
    // is `(providerId, '')` for twelve of the thirteen registrations (`net/limiter-store.ts`).
    const key = limiterKeyOf(providerId);

    // Refill, consume and read — ONE operation, and the reason the interface offers no other shape.
    // The negative balance it can return is deliberately NOT reset to zero: that backlog is exactly
    // what the NEXT call's refill reads, which is what makes concurrent callers space out instead
    // of racing on stale state.
    const {
      take: { tokensLeft, waitMs },
      served,
    } = await acquire(key, config, weight, nowMs);
    if (tokensLeft >= 0) {
      return;
    }

    // R-9.4 — what the bucket held when it refused, carried on every refusal below. Built once,
    // from the same take the wait was computed from, so no refusal can describe a different bucket
    // than the one that decided it.
    const bucket: LimiterBucketState = {
      remaining: tokensLeft,
      ceiling: config.capacity,
      refillPerSec: config.refillPerSec,
    };

    if (waitMs > MAX_WAIT_MS) {
      // Refund the reservation — this call will never actually wait/consume its slot, so it must
      // not permanently worsen the backlog for whoever calls next (adversarial cycle 2, fix 7).
      // Refunds `weight`, not 1: a partial refund would leak tokens out of the bucket on every
      // rejected weighted call, tightening the limiter a little more each time until it stopped
      // admitting anything.
      await release(served, key, weight, nowMs);
      throw new RateLimitRejectedError(
        providerId,
        `computed wait ${Math.round(waitMs)}ms exceeds the ${MAX_WAIT_MS}ms fairness cap (saturated bucket)`,
        bucket,
      );
    }

    // **A SECOND clock sample, taken after the store answered** (`system-architecture.md` §3.4.4).
    // `nowMs` above is the bucket's instant: refill, spend and the wait it implies must all read one
    // sample, or the arithmetic is internally inconsistent. The deadline is a different question
    // asked at a different time — and with a shared store, `store.take` is a round trip, so a
    // pre-call sample overstates the budget by however long that trip took. Admitting a wait on the
    // strength of a stale sample is how a caller wakes with less than `MIN_POST_WAIT_REMAINDER_MS`
    // and produces the TERMINAL class one layer down, which is the outcome the floor exists to
    // avoid. On the in-process store the two samples are the same instant and this costs nothing.
    const decidedAtMs = now();

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
      const remainingMs = deadlineAtMs - decidedAtMs;
      if (remainingMs <= 0) {
        // Genuine expiry — true for EVERY adapter on the route, so this ends the traversal.
        await release(served, key, weight, decidedAtMs);
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
        await release(served, key, weight, decidedAtMs);
        throw new DeadlineWouldExceedError(
          providerId,
          waitMs,
          remainingMs,
          MIN_POST_WAIT_REMAINDER_MS,
          'predicted',
          bucket,
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
    // `waitMs`, and the deficit it left in the bucket is repaid by the lazy refill the next caller
    // performs from `last_refill_ms`. Adding the token back as well would credit the bucket twice
    // for one interval and let it admit more than `refillPerSec` allows.
    if (deadlineAtMs !== undefined) {
      const observedRemainingMs = deadlineAtMs - now();
      if (observedRemainingMs < MIN_POST_WAIT_REMAINDER_MS) {
        throw new DeadlineWouldExceedError(
          providerId,
          waitMs,
          observedRemainingMs,
          MIN_POST_WAIT_REMAINDER_MS,
          'observed',
          bucket,
        );
      }
    }
  };
}

/**
 * Production default (ARCHITECTURE.md §3.2 `net/rate-limit.ts` — the exported flat `throttle`
 * call site every adapter uses): one in-process bucket store, real `Date.now`/`setTimeout`. Tests
 * should prefer `createThrottle({ now, wait })` for an isolated, real-timer-free instance instead
 * of this singleton.
 *
 * **This singleton is still per-process, and task 014-18 did not change that** — it made the change
 * POSSIBLE. Sharing the ceiling is `createThrottle({ store })` with the axis's store from
 * `createStateStores`, which is a wiring decision at the process entry point rather than a property
 * of this module. Until that wiring lands (task 014-19 carries it, together with the degradation
 * path), an adapter importing this constant gets exactly the limiter it always had.
 */
export const throttle: Throttle = createThrottle();
