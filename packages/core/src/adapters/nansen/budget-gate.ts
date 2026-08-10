import type { BudgetStore } from '../../cache/budget-store.js';
import { dayBucketMs } from '../../cache/day-bucket.js';
import { throttle as productionThrottle } from '../../net/rate-limit.js';
import type { Throttle } from '../../net/rate-limit.js';
import { safeFetch } from '../../net/safe-fetch.js';
import { adapterRegistrations } from '../../providers.config.js';
import type { NansenAccountSnapshot, NansenAccountState } from './account-state.js';
import { costOf } from './cost-of.js';

const REGISTRATION = adapterRegistrations.find((r) => r.id === 'nansen');
if (!REGISTRATION) {
  throw new Error('nansen: no matching entry in adapterRegistrations (providers.config.ts)');
}
const HOSTS = REGISTRATION.hosts;
const RATE_LIMIT = REGISTRATION.rateLimit;
const ACCOUNT_URL = `https://${HOSTS[0]}/api/v1/account`;

/** system-architecture.md §3.2 "Budget-warning threshold" — a fraction of `effectiveCeiling`, not
 * an absolute credit count (the ceiling itself is live and can move between resyncs). */
const DEFAULT_WARN_RATIO = 0.8;

/**
 * Fraction of the observed balance the derived daily cap allows (Q-2). A FRACTION rather than an
 * absolute number because owner decision #1 (2026-07-23) is "design for `free` and `Pro`
 * simultaneously, zero code change on upgrade": any fixed number is paralysis on one plan and a
 * no-op on the other (30 vs a 10 000-credit Pro balance; 2500 vs a 100-credit free balance).
 *
 * 25% is a PACING HEURISTIC, not a derivation — Nansen documents no credit reset cadence anywhere
 * (the committed spec has zero occurrences of `monthly`/`per month`/`renew`/`quota`; every `reset`
 * hit is a rate-limit window in seconds). It encodes "one incident must not cost more than a
 * quarter of the account", not "this is your fair share of the period". See `docs/issues/q-2-*.md`.
 */
const DERIVED_CAP_FRACTION = 0.25;

/**
 * Floor under the derived cap — three calls of the dearest default-path capability
 * (`smart-money.flows` = 10cr). Without it, a nearly-exhausted account derives a cap of ~0 and the
 * gate refuses its OWN calls before the vendor would, i.e. the guard bricks the product it protects.
 *
 * The floor can never permit spending money that does not exist: `effectiveCeilingFor()` still takes
 * `Math.min(vendorCeiling, cap)`, so below ~30 credits the vendor remainder binds and the floor is
 * inert (balance 5 → ceiling 5, not 30).
 */
const DERIVED_CAP_FLOOR = 30;

/**
 * The default self-imposed daily ceiling (Q-2). Exported for direct unit testing of the number itself.
 *
 * **The argument is the bucket-START balance — `usageAtObserve + creditsRemainingAtObserve`, the
 * SAME anchor rebasing `effectiveCeilingFor()` performs — never the raw live remainder.** That is
 * load-bearing, not stylistic (vdd-multi cycle 4, logic L-2). The derived cap is compared by
 * `checkAndReserve()` against `used`, a CUMULATIVE bucket counter; deriving it from a POST-spend
 * balance mixes two reference frames and re-subtracts the day's own spend from its own allowance:
 *
 *   balance 1000 at 00:00 → cap 250. Spend 200. The MCP server restarts (every Claude Code session
 *   boundary does), so the in-memory pin is gone and the cap is derived afresh. From the raw
 *   remainder: `max(30, floor(800 × 0.25)) = 200`, and `used(200) + 10 > 200` refuses EVERY paid
 *   call for the rest of the UTC day — while the operator was told the ceiling was 250 and 50
 *   credits of both the cap and the balance are still there. Repeated restarts compound it.
 *
 * From the anchor, `200 + 800 = 1000 → 250` on every cold start, resync, and concurrent session
 * alike: the same self-correcting property the vendor ceiling already has, and the only thing that
 * makes `NansenAccountSnapshot.dailyCapForBucket`'s "50 means 50 until the bucket rolls over"
 * promise true across a process restart rather than only within one.
 *
 * Regimes (note the crossover is **124, not 120** — `floor()` truncation keeps the result at 30
 * through balance 123, so a test written against 121 would assert the wrong regime):
 * - balance < 30 → the vendor remainder binds, this floor is inert
 * - 30 ≤ balance ≤ 123 → the floor (30) binds
 * - balance ≥ 124 → the 25% fraction binds
 *
 * A useful property falls out with no special-case rule: `entity.labels`' `exhaustive` tier (100cr)
 * stays unreachable until the balance is ≥ 400 — the dearest call in the system should not be
 * reachable on a nearly-empty account.
 */
export function deriveDailyCap(bucketStartBalance: number): number {
  return Math.max(DERIVED_CAP_FLOOR, Math.floor(bucketStartBalance * DERIVED_CAP_FRACTION));
}

/**
 * Sentinel that switches the self-imposed ceiling OFF entirely, leaving only the vendor remainder
 * (the pre-Q-2 behaviour). Deliberately a WORD, not `0`: `0` is one truncation/typo away from being
 * produced by accident on a money guard, and semantically "0" should mean "spend nothing", not
 * "spend without limit". `EnvSchema` keeps rejecting `0` as invalid for exactly that reason.
 */
export const DAILY_CAP_OFF = 'off';
export type DailyCreditCapConfig = number | typeof DAILY_CAP_OFF | undefined;

/**
 * Width of the velocity window (SEC-1). One minute: short enough that a runaway loop is stopped
 * while a human could still be reading the first response, long enough that a burst of legitimate
 * interactive calls is not chopped up.
 *
 * **Tumbling, not sliding** — stated plainly rather than implied. A tumbling window admits up to
 * 2× the ceiling across a boundary (full allowance at :59, full allowance again at :01). A sliding
 * window would need per-call history instead of one counter, and the guard's job is to buy a human
 * time to notice, which a 2× worst case does not undermine. If that ever stops being true, the
 * shape to reach for is a second, wider window — not a rewrite of this one.
 */
export const VELOCITY_WINDOW_MS = 60_000;

/**
 * The daily allowance is divided by this to get one window's allowance (SEC-1). 20 means a full
 * day's budget takes at least ~20 minutes of sustained spending to exhaust — the difference between
 * "an operator sees it happening" and "an operator sees it happened".
 */
const VELOCITY_DIVISOR = 20;

/**
 * Floor under the derived velocity limit — the price of the DEAREST single call in the system
 * (`entity.labels` at its `exhaustive` tier, 100cr).
 *
 * Load-bearing, not a comfort margin: a velocity limit below the cost of one call would make that
 * capability structurally impossible rather than merely rate-limited, which is a worse failure than
 * the one this guard prevents. Where the floor exceeds what the daily cap would allow, the daily
 * cap binds first anyway — the two guards compose, and the tighter one wins.
 */
const VELOCITY_FLOOR = 100;

/**
 * Credits one window may hold, derived from whatever ceiling is actually in force (SEC-1).
 *
 * Derived rather than absolute, for the same reason `deriveDailyCap` is: owner decision #1 —
 * `free` and `Pro` must both work with zero code change, and any fixed number is paralysis on one
 * and a no-op on the other.
 */
export function deriveVelocityCap(effectiveCeiling: number): number {
  if (!Number.isFinite(effectiveCeiling)) return VELOCITY_FLOOR;
  return Math.max(VELOCITY_FLOOR, Math.floor(effectiveCeiling / VELOCITY_DIVISOR));
}

/** Sentinel switching the velocity guard off, mirroring `DAILY_CAP_OFF` exactly — a word, never
 * `0`, because on a money guard `0` should mean "spend nothing". */
export const VELOCITY_OFF = 'off';
export type VelocityCapConfig = number | typeof VELOCITY_OFF | undefined;

/**
 * Calls one window may hold (Q-3) — the SECOND denominator, and the only one that can see a call
 * costing zero credits.
 *
 * `entity.labels`' query tier is priced `{free: 0, pro: 0}`, so `used + 0 > ceiling` is false for
 * the entire life of any bucket under any cap: the credit gate three review rounds hardened can
 * never refuse it. The calls are still two real HTTPS round trips against the operator's own vendor
 * account, and each carries up to 200 characters of free text, so every one is a fresh `args_hash`
 * — a guaranteed cache miss and a new `cache_entries` row with an attacker-selectable key.
 *
 * **A FIXED number, not derived — the asymmetry from `deriveVelocityCap` is deliberate.** The
 * credit limits are derived because credits differ by orders of magnitude between `free` and `Pro`,
 * and owner decision #1 requires both to work unchanged. A call is a call on either plan: neither
 * the vendor's rate limits nor the row-growth pressure scales with the balance, so there is nothing
 * to derive FROM. 60 per minute is one sustained call per second — comfortably above anything an
 * interactive session produces, and ~5x below what the throttle alone would permit.
 *
 * It also bounds consequence #2 of Q-3 without a separate mechanism: at 60 calls/min against a
 * 3600s TTL, cache rows for this capability reach a steady state of ~3600 instead of growing
 * without limit.
 */
const DEFAULT_MAX_CALLS_PER_WINDOW = 60;

/** Sentinel switching the CALL limit off — same word-not-zero reasoning as the two above. */
export const MAX_CALLS_OFF = 'off';
export type MaxCallsConfig = number | typeof MAX_CALLS_OFF | undefined;

/** The call allowance in force: an explicit number, the fixed default, or `undefined` when off. */
export function resolveMaxCalls(configured: MaxCallsConfig): number | undefined {
  if (configured === MAX_CALLS_OFF) return undefined;
  if (typeof configured === 'number') return configured;
  return DEFAULT_MAX_CALLS_PER_WINDOW;
}

/** Epoch-ms UTC start of the velocity window `ts` falls in — the same flooring discipline as
 * `dayBucketMs`, just a different width (DB-SCHEMA-CONCEPT §1.2: no `Date` objects, no local time). */
export function velocityWindowMs(ts: number): number {
  return Math.floor(ts / VELOCITY_WINDOW_MS) * VELOCITY_WINDOW_MS;
}

/**
 * Resolves the configured value into the cap to pin for a bucket (Q-2):
 * - `'off'` → `undefined` — no self-imposed ceiling; the vendor remainder alone bounds spend
 * - a number → that explicit operator-chosen ceiling
 * - unset → `deriveDailyCap(bucketStartBalance)`
 *
 * `bucketStartBalance` MUST be the anchor (`usageAtObserve + creditsRemainingAtObserve`), not the
 * live remainder — see `deriveDailyCap`'s docstring for the day-long lockout that the raw remainder
 * produces on a mid-day process restart.
 */
function resolveDailyCap(
  configured: DailyCreditCapConfig,
  bucketStartBalance: number,
): number | undefined {
  if (configured === DAILY_CAP_OFF) return undefined;
  if (typeof configured === 'number') return configured;
  return deriveDailyCap(bucketStartBalance);
}

/**
 * The cap actually in force for a call. Only the DERIVED default is read from the snapshot; an
 * explicit configuration is applied directly and never depends on snapshot state.
 *
 * That asymmetry is deliberate. Pinning exists because the derived value is a function of the
 * balance, which drifts during the day (see `NansenAccountSnapshot.dailyCapForBucket`). A
 * configured number is static — routing it through the snapshot would mean an operator's
 * `NANSEN_DAILY_CREDIT_CAP` silently stops applying whenever a snapshot exists that predates it
 * (e.g. one seeded out-of-band, or carried across a config change), because `undefined` in the
 * snapshot is indistinguishable from "off". A money guard must not be able to disappear that way.
 */
function capInForce(
  configured: DailyCreditCapConfig,
  snapshot: NansenAccountSnapshot,
): number | undefined {
  if (configured === DAILY_CAP_OFF) return undefined;
  if (typeof configured === 'number') return configured;
  return snapshot.dailyCapForBucket;
}

/**
 * Constructor deps for `createNansenBudgetGate` (task 005-3). `budgetStore`/`accountState` are
 * REQUIRED — there is no meaningful gate without a ledger to reserve against or a place to keep
 * the live account snapshot; `dailyCreditCap`/`budgetWarnRatio`/`now`/`fetchImpl`/`env` mirror the
 * same optional-DI convention already used across this package's adapters.
 *
 * `throttle` is a task-005-3-local addition NOT present on the adapter's own public
 * `NansenAdapterDeps` (index.ts): this gate's OWN test suite constructs dozens of independent
 * `ensureBudget()` scenarios in one file, each potentially triggering a `/account` resync — if
 * they all shared the package's single production `throttle` singleton (a real, process-lifetime
 * token bucket, `net/rate-limit.ts`), later test cases would incur genuine multi-second real-timer
 * waits or even a `RateLimitRejectedError` once the bucket saturates, entirely as an artifact of
 * test ordering rather than anything about the gate's own logic. Defaults to the real production
 * singleton in the absence of an override, so production wiring (005-5) needs zero extra plumbing.
 */
export interface NansenBudgetGateDeps {
  budgetStore: BudgetStore;
  accountState: NansenAccountState;
  dailyCreditCap?: DailyCreditCapConfig;
  /** Credits per `VELOCITY_WINDOW_MS` (SEC-1). Unset ⇒ derived from the ceiling in force;
   * `VELOCITY_OFF` ⇒ no rate brake, leaving only the daily ceiling. */
  velocityCap?: VelocityCapConfig;
  /** CALLS per `VELOCITY_WINDOW_MS` (Q-3) — the denominator that can bound a zero-credit call.
   * Unset => 60; `MAX_CALLS_OFF` => unbounded, the pre-Q-3 behaviour. */
  maxCallsPerWindow?: MaxCallsConfig;
  budgetWarnRatio?: number;
  now?: () => number;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  throttle?: Throttle;
  /**
   * The transport seam (task 012-9, PLAN §0.3 seam #1, owner decision OD-6), same shape and same
   * default as `NansenEndpointDeps.safeFetchImpl`.
   *
   * It exists on BOTH sides of the reservation on purpose. The free `/account` resync below is the
   * one network step that MUST be handed the deadline, and the paid sub-calls are the ones that must
   * never be — a contract test that could observe only the paid side would be unable to tell "the
   * boundary holds" from "the deadline was never threaded at all", and one that could observe only
   * the limiter would be checking the half of the path that spends no money. One injected transport
   * observes both legs, and the ONLY difference between them is the argument this task is about.
   */
  safeFetchImpl?: typeof safeFetch;
}

/** `ensureBudget()`'s success shape (task 005-3) — `bucket` is the SAME `dayBucketMs` fixed at
 * entry, threaded straight through so a caller (005-5's `fetch()` wiring) reconciles the exact
 * same `usage` row this reservation was written against, never a bucket recomputed later from a
 * fresh `Date.now()`. */
export interface NansenBudgetReservation {
  reservedTotal: number;
  bucket: number;
  /** The velocity window this reservation was written into, or `undefined` when the guard is off.
   * Threaded through for the SAME reason as `bucket` (SEC-1): reconciliation must refund into the
   * window that actually spent, not into whichever window is current when the call returns — a
   * call outliving its window would otherwise hand the next one free headroom. */
  window?: number;
}

/**
 * Thrown by `ensureBudget()` on refusal (task 005-3). `reason` always names WHICH of the two
 * independent limits was binding — "vendor: need X, remaining (as of last resync) Y" vs
 * "self-imposed cap: need X, NANSEN_DAILY_CREDIT_CAP allows Y" (system-architecture.md §3.2
 * "Атомарный check+reserve") — or, for a fail-closed price, a message naming the unknown
 * capability. The API key value NEVER appears in this message.
 */
export class NansenBudgetExceededError extends Error {
  constructor(public readonly reason: string) {
    super(`nansen budget gate refused: ${reason}`);
    this.name = 'NansenBudgetExceededError';
  }
}

/**
 * Pure ceiling formula (system-architecture.md §3.2 "The bucket ceiling formula" — the anchor-rebased
 * fix for the naive, double-counting `min(creditsRemainingAtObserve, cap)` defect found on
 * review). Exported for direct unit testing (TC-UNIT-06 — asserting the number itself, not just
 * an indirect pass/fail outcome) in addition to being used internally by `ensureBudget()`.
 *
 * `usageAtObserve + creditsRemainingAtObserve` rebases the vendor's anchor-relative remainder onto
 * a bucket-relative scalar BEFORE the `min()` with the optional self-imposed cap — this is the
 * ONLY point in this module where `min()` against `creditsRemainingAtObserve` is correct; a
 * `Math.min(creditsRemainingAtObserve, cap)` WITHOUT the `usageAtObserve +` rebasing first would
 * silently re-subtract already-accounted spend on every mid-bucket resync (see the module-level
 * numeric walkthrough in system-architecture.md §3.2).
 */
export function effectiveCeilingFor(
  snapshot: NansenAccountSnapshot,
  dailyCreditCap: number | undefined,
): number {
  const vendorCeiling = snapshot.usageAtObserve + snapshot.creditsRemainingAtObserve;
  return dailyCreditCap !== undefined ? Math.min(vendorCeiling, dailyCreditCap) : vendorCeiling;
}

/** The handful of `/account` response fields this gate actually reads — the real response may
 * carry more, none of which the budget formula needs. */
interface AccountResponseBody {
  plan?: unknown;
  credits_remaining?: unknown;
}

/** True when the CURRENT snapshot cannot be trusted without a fresh `/account` resync
 * (system-architecture.md §3.2 "Когда происходит resync"): cold start, a snapshot left over from
 * a PAST day-bucket, or an explicit `markUnreconciled()` (transport failure/timeout or a `402` on
 * a previous reserved-but-unconfirmed call, R-38). Deliberately NOT triggered on every call — the
 * `else` branch (an existing, same-bucket, reconciled snapshot) is the common case.
 *
 * The degrade-triggered resync is DELIBERATELY NOT rate-limited (cycle-2 review R-4 / cycle-1 F-6 —
 * considered, implemented, and reverted on evidence).
 *
 * The finding is real: if a degrade cause is persistent (the vendor renames or a CDN blanks
 * `X-Nansen-Credits-Used`), every subsequent capability call adds an extra `/account` round trip,
 * and cycle 1's throttle raise (1/s → 10/s) made that loop ~10x faster. Both critics rated it
 * MINOR, availability-only, 0 credits.
 *
 * But a minimum-interval guard was tried here and it broke three tests that encode UC-6's actual
 * contract: after a `402` or a transport failure, the NEXT gate entry must resync. That resync is
 * the authoritative drift correction — the vendor has just told us our local ledger is wrong, and
 * re-reading `/account` is how the anchor rebases. Suppressing it for a cooldown window trades a
 * money-CORRECTNESS property (the engine's view of remaining credits converging back to the
 * vendor's) for an availability nicety. That trade is backwards for this milestone.
 *
 * Accepted residual: under a persistent degrade the `reconcile()` stderr line repeats per call
 * (log noise only — `/account` is free and the budget stays correct). Left as-is deliberately
 * rather than adding a second dedup flag to `NansenAccountState`. Tracked as a known-issue rather
 * than silently dropped (`docs/issues/q-1-*.md`, `status: by-design`).
 *
 * **If this is ever picked up, here is the design that works** (cycle-3 formulation, WI-8's sibling
 * WI-4, recorded here rather than in a backlog file because this is where the decision gets made).
 * The reason the cooldown attempt failed is that `markUnreconciled()` collapses TWO causes into one
 * flag:
 *
 * - **(a) a `402` or a transport failure** — the vendor has just made a statement about our ledger,
 *   so the next-entry resync is the mandatory correction. This is what UC-6's three tests encode,
 *   and it must never be suppressed.
 * - **(b) `reconcile()`'s header-degrade branch** — no such statement, merely a missing
 *   `X-Nansen-Credits-Used`. This is the only cause that can persist indefinitely, i.e. the actual
 *   storm driver, and the only one worth rate-limiting.
 *
 * Splitting the flag and applying a minimum-interval cooldown to **(b) alone** preserves all three
 * UC-6 tests. A blanket cooldown — the thing that was tried — cannot, because it necessarily
 * suppresses (a) too. Do not re-attempt the blanket version; it will fail the same three tests for
 * the same reason. Worth doing only if request pressure becomes real; it is availability polish,
 * not a correctness fix.
 */
function needsResync(
  snapshot: NansenAccountSnapshot | undefined,
  bucket: number,
  accountState: NansenAccountState,
): boolean {
  if (!snapshot) return true;
  if (snapshot.dayBucketMs !== bucket) return true;
  return accountState.isUnreconciled();
}

/**
 * `createNansenBudgetGate(deps)` — the pre-call budget gate (system-architecture.md §3.2 "Budget
 * gate — размещение", task 005-3, R-36/R-37). Builds one `ensureBudget(cap, args)` function that:
 *
 * 1. Fixes `bucket = dayBucketMs(now())` ONCE, at entry (M-2 review) — never recomputed below.
 * 2. Resyncs `/account` (`refreshAccount()`) ONLY when `needsResync()` says the current snapshot
 *    can't be trusted — NOT on every call (`/account` is free in credits but not in rate-limit
 *    slot/latency). A resync failure throws HERE, before `costOf`/`checkAndReserve` ever run —
 *    fail-closed, no valid ceiling to compute against a stale/absent snapshot. **This step, and only
 *    this side of step 4, receives the caller's `deadlineAtMs`** (task 012-9): it is free and
 *    cancellable, so a spent deadline may end the call here — where nothing has been paid for yet.
 * 3. Computes the exact price (`costOf()`, cost-of.ts) under the now-current live `plan`, and
 *    fail-closes (`NansenBudgetExceededError`, never reaching `BudgetStore`) if that price isn't
 *    finite (R-37 MIN-3 — an unrecognized capability or a cost-table key that doesn't exist).
 * 4. Computes `effectiveCeilingFor()` from the live snapshot + the optional self-imposed cap, and
 *    atomically reserves the price via `BudgetStore.checkAndReserve` (005-2) — a `{ok:false}`
 *    result throws with a reason naming WHICH of the two limits was binding.
 * 5. On success, emits the warn-threshold stderr line at most once per SNAPSHOT — not per bucket
 *    (vdd-multi cycle 4, logic L-11). `accountState.set()` clears the warn flag on every successful
 *    resync, and mid-bucket resyncs are routine (402 / transport failure / a reconcile degrade all
 *    call `markUnreconciled()`), so a bucket with N resyncs can legitimately emit N warn lines. The
 *    bound is "never twice for the same observation", which is what keeps a steady-state session
 *    quiet; it is NOT the strict once-a-day the earlier wording promised. Same family as Q-1 —
 *    stderr volume under a persistent degrade — and deliberately left as-is for the same reason:
 *    rate-limiting the resync itself would break UC-6's authoritative drift correction. The
 *    mechanism is `accountState`'s own `hasWarned()`/`markWarned()` flag, reset by the next
 *    `set()`/resync.
 *
 * This function is the ONLY thing this module exposes for actually spending budget, and it HAS been
 * wired into `adapters/nansen/index.ts`'s `fetch()` since task 005-5 (this docstring said "not yet
 * wired ... lands in 005-5" long after that landed — vdd-multi cycle 4, completeness G-7).
 * `packages/core/src/index.ts` re-exports only the pure, inert pieces of this module —
 * `DAILY_CAP_OFF`, `deriveDailyCap`, `DailyCreditCapConfig` — for the mcp-server's env layer and
 * for direct unit testing of the number itself. `createNansenBudgetGate` is deliberately NOT among
 * them (§3.2 "Budget gate — ...не отдельный wrapper-объект": the gate is an internal implementation
 * seam of the adapter's own `fetch()`, never a second, bypassable call site).
 */
export function createNansenBudgetGate(deps: NansenBudgetGateDeps): {
  ensureBudget(
    cap: string,
    args: Record<string, unknown>,
    deadlineAtMs?: number,
  ): Promise<NansenBudgetReservation>;
} {
  const now = deps.now ?? Date.now;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const env = deps.env ?? process.env;
  const throttleFn = deps.throttle ?? productionThrottle;
  const safeFetchFn = deps.safeFetchImpl ?? safeFetch;
  const warnRatio = deps.budgetWarnRatio ?? DEFAULT_WARN_RATIO;

  /**
   * `GET /account` resync (system-architecture.md §3.2 "M-4 review" — header `apiKey`, the
   * generic Web credentials-header + token-prefix scheme is NOT used here, see this directory's
   * own .AGENTS.md note for why that distinction matters). Reads `usage.credits_used` for THIS
   * `bucket` in the SAME logical step as the HTTP call (no paid call in between) so the anchor
   * this snapshot forms can never go stale before it's saved.
   */
  async function refreshAccount(bucket: number, deadlineAtMs?: number): Promise<void> {
    const apiKey = env['NANSEN_API_KEY'];
    if (!apiKey) {
      // Defensive re-check (coingecko's fetch()-level re-normalization precedent,
      // developer-guidelines §1.6): the real adapter's isAvailable() already keeps
      // CapabilityRegistry from ever reaching here without a key — this guards a direct/
      // out-of-band gate construction (e.g. a test) from producing a confusing fetch error
      // instead of a clear one.
      throw new Error('nansen budget gate: NANSEN_API_KEY is required to resync /account');
    }

    // M-7 (adversarial review cycle 1): read the LOCAL usage counter BEFORE the throttle/safeFetch
    // round trip below, never after. A reservation `checkAndReserve()`s IN that window (another
    // in-process call, or another process sharing this same DATA_DIR/cache.sqlite3) would otherwise
    // land in BOTH `usageAtObserve` (read after) AND the vendor's own `credits_remaining` (which
    // already reflects any call the VENDOR has by then processed) — double-counting it and
    // inflating `effectiveCeilingFor()`'s ceiling, i.e. over-spend against the vendor. Reading it
    // first makes the failure mode strictly conservative (under-spend, self-correcting on the next
    // resync) instead of over-spend.
    const usageAtObserve = await deps.budgetStore.getUsage('nansen', bucket);

    // **The deadline reaches BOTH steps of the free leg** (task 012-9, ADR-002 D4 п.2). This resync
    // costs zero credits and is roughly half of the measured cancellable part of a Nansen call, so
    // cutting the deadline off at `ensureBudget()`'s front door — the earlier wording of the rule —
    // would deny it to precisely the step the cancellable window exists for. The boundary is the
    // COMMITTED reservation (`checkAndReserve()` below), not this function.
    //
    // The weight is stated positionally as `1` (its default) because `deadlineAtMs` is the fourth
    // parameter; the limiter's behaviour is unchanged by naming it.
    await throttleFn('nansen', RATE_LIMIT, 1, deadlineAtMs);
    const response = await safeFetchFn(
      ACCOUNT_URL,
      { headers: { apiKey } },
      HOSTS,
      fetchImpl,
      deadlineAtMs === undefined ? {} : { deadlineAtMs },
    );
    if (!response.ok) {
      throw new Error(`nansen budget gate: /account resync failed with HTTP ${response.status}`);
    }
    const body = (await response.json()) as AccountResponseBody;
    // DOMAIN validation, not just `typeof` (vdd-multi cycle 4, security S-1). This single field
    // defines the entire ceiling, so it gets at least the discipline `reconcile.ts` already applies
    // to the far less consequential credits-used header. A bare `typeof === 'number'` admits
    // `Infinity` (`JSON.parse('{"credits_remaining":1e999}')` yields it — valid JSON, no throw) and
    // absurd finite magnitudes; either one makes `effectiveCeilingFor()` unbounded AND gets PINNED
    // for the rest of the bucket, so every reservation is approved for the remainder of the day and
    // a later healthy resync cannot repair it. Failing the resync instead keeps the previous
    // snapshot and the `unreconciled` flag, i.e. fail-closed.
    if (
      typeof body.credits_remaining !== 'number' ||
      !Number.isInteger(body.credits_remaining) ||
      !Number.isSafeInteger(body.credits_remaining) ||
      body.credits_remaining < 0
    ) {
      throw new Error(
        'nansen budget gate: /account credits_remaining is missing or not a non-negative safe integer',
      );
    }
    // Unknown/future plan values fold to 'free' — the same conservative, safe-direction default
    // costOf() uses before the first resync (system-architecture.md §3.2 "Account-state").
    const plan: 'free' | 'pro' = body.plan === 'pro' ? 'pro' : 'free';

    // PIN the daily cap per bucket (Q-2). A mid-bucket resync (unreconciled → `/account`) carries
    // the previous snapshot's value forward verbatim; only a NEW bucket (or a cold start) derives a
    // fresh one.
    //
    // The derivation input is the bucket-START balance — the SAME `usageAtObserve + remaining`
    // anchor `effectiveCeilingFor()` rebases onto — never the raw live remainder (vdd-multi cycle 4,
    // logic L-2; see `deriveDailyCap`). The pin alone was never sufficient: it lives in memory only,
    // so a mid-day MCP-server restart re-derived from a post-spend balance and could lock the whole
    // paid layer out for the rest of the UTC day. With the anchor, every cold start, resync and
    // concurrent session derives the SAME number, and the pin is what keeps it stable if the vendor's
    // own accounting drifts from ours mid-bucket. `previous` is the snapshot for THIS bucket, if one
    // exists.
    const previous = deps.accountState.get();
    const dailyCapForBucket =
      previous !== undefined && previous.dayBucketMs === bucket
        ? previous.dailyCapForBucket
        : resolveDailyCap(deps.dailyCreditCap, usageAtObserve + body.credits_remaining);

    const snapshot: NansenAccountSnapshot = {
      plan,
      creditsRemainingAtObserve: body.credits_remaining,
      usageAtObserve,
      observedAtMs: now(),
      dayBucketMs: bucket,
      dailyCapForBucket,
    };
    deps.accountState.set(snapshot);
    deps.accountState.clearUnreconciled();

    // Announce the ceiling in force — ONCE per bucket, which falls out of the pinning above (a
    // fresh derivation happens exactly once per bucket). Q-2 caveat 3: without this the active
    // guard is invisible — an operator cannot tell which bound is in force, nor that a self-imposed
    // ceiling exists at all. stderr, never stdout (that channel is the MCP protocol).
    if (previous === undefined || previous.dayBucketMs !== bucket) {
      process.stderr.write(
        `nansen budget: bucket=${bucket} plan=${plan} creditsRemaining=${body.credits_remaining} ` +
          `dailyCap=${dailyCapForBucket ?? DAILY_CAP_OFF} ` +
          `effectiveCeiling=${effectiveCeilingFor(snapshot, dailyCapForBucket)}\n`,
      );
    }
  }

  async function ensureBudget(
    cap: string,
    args: Record<string, unknown>,
    deadlineAtMs?: number,
  ): Promise<NansenBudgetReservation> {
    const bucket = dayBucketMs(now());

    if (needsResync(deps.accountState.get(), bucket, deps.accountState)) {
      await refreshAccount(bucket, deadlineAtMs);
    }

    const cost = costOf(deps.accountState, cap, args);
    if (!Number.isFinite(cost)) {
      throw new NansenBudgetExceededError(
        `unknown price for capability=${cap} (fail-closed — never treated as free)`,
      );
    }

    // Non-null: refreshAccount() above always leaves a snapshot in place by this line — either it
    // just ran (needsResync() was true), or one already existed (needsResync() was false).
    const snapshot = deps.accountState.get() as NansenAccountSnapshot;
    // `capInForce()`, never `deps.dailyCreditCap` raw (Q-2): when the cap is DERIVED (the default,
    // `NANSEN_DAILY_CREDIT_CAP` unset) the raw config is `undefined`, which `effectiveCeilingFor()`
    // reads as "no self-imposed ceiling" — silently disabling the very guard it should apply.
    const capNow = capInForce(deps.dailyCreditCap, snapshot);
    const effectiveCeiling = effectiveCeilingFor(snapshot, capNow);

    // SEC-1 — the rate brake, resolved here and enforced INSIDE the same reservation transaction.
    // `undefined` when switched off, which is the only way to get the pre-SEC-1 behaviour back.
    const velocityCeiling =
      deps.velocityCap === VELOCITY_OFF
        ? undefined
        : typeof deps.velocityCap === 'number'
          ? deps.velocityCap
          : deriveVelocityCap(effectiveCeiling);
    // Q-3 — the CALL limit is independent of the credit one: it applies even when the credit brake
    // is switched off, because a zero-cost call is invisible to any credit-denominated limit.
    const maxCalls = resolveMaxCalls(deps.maxCallsPerWindow);
    const window = velocityWindowMs(now());
    const velocity =
      velocityCeiling === undefined && maxCalls === undefined
        ? undefined
        : {
            windowStartMs: window,
            // `Infinity` when only the CALL limit is on: the credit comparison then always passes,
            // which is exactly "this denominator is not in force" without a second code path.
            ceiling: velocityCeiling ?? Number.POSITIVE_INFINITY,
            ...(maxCalls === undefined ? {} : { maxCalls }),
          };

    // ⟵ THE PAID BOUNDARY (task 012-9, ADR-002 D4 п.2, R-141/AC-10). Everything above this line was
    // told the deadline; from the moment this call returns `{ok:true}`, nothing is — not the first
    // sub-call, not sub-calls 2..N, not the limiter waits between them. The reservation is for the
    // SUM of the sub-calls' prices, so abandoning a later one after paying for all of them is the
    // same "paid and did not receive", one step later.
    //
    // **No `deadlineAtMs <= now()` re-check is made here, and that is a decision.** The registry
    // already refuses to enter an adapter with a spent deadline (`registry.ts`'s per-adapter
    // pre-check), so a check here would be dead code on every production path; and D4 п.2 asks for
    // the deadline to be THREADED to the free work, not for a new refusal to be invented at the
    // till. Adding one would also change `NansenBudgetExceededError`'s meaning for direct callers.
    const result = await deps.budgetStore.checkAndReserve(
      'nansen',
      bucket,
      cost,
      effectiveCeiling,
      velocity,
    );
    if (!result.ok) {
      // The velocity refusal must be distinguishable from the daily one (SEC-1): they call for
      // opposite responses — wait out the window versus raise a ceiling — and an operator who
      // cannot tell them apart will "fix" the wrong one. `BudgetStore` already labels its own
      // reason; this branch keeps that label and adds the actionable half.
      if (result.reason.startsWith('call rate limit reached')) {
        const origin = typeof deps.maxCallsPerWindow === 'number' ? 'configured' : 'default';
        throw new NansenBudgetExceededError(
          `call rate limit (${origin}): ${maxCalls} calls per ${VELOCITY_WINDOW_MS / 1000}s — ` +
            `this bound counts CALLS, not credits, so it applies to zero-credit tiers too and ` +
            `raising a credit ceiling will not move it. Retry after the window rolls over, or set ` +
            `NANSEN_MAX_CALLS_PER_MIN to raise it, or ${MAX_CALLS_OFF} to disable it. ` +
            `(${result.reason})`,
        );
      }
      if (result.reason.startsWith('velocity limit reached')) {
        const capOrigin = typeof deps.velocityCap === 'number' ? 'configured' : 'derived';
        throw new NansenBudgetExceededError(
          `velocity limit (${capOrigin}): ${velocityCeiling} credits per ${VELOCITY_WINDOW_MS / 1000}s, ` +
            `need ${cost} — the DAILY budget is not exhausted; retry after the window rolls over, ` +
            `or set NANSEN_VELOCITY_CREDITS_PER_MIN to raise it, or ${VELOCITY_OFF} to disable it. ` +
            `(${result.reason})`,
        );
      }
      const vendorCeiling = snapshot.usageAtObserve + snapshot.creditsRemainingAtObserve;
      const bindingIsVendor = effectiveCeiling === vendorCeiling;
      // Name WHICH ceiling refused, and — when it is the self-imposed one — whether that number was
      // configured or derived, so an operator can tell "my NANSEN_DAILY_CREDIT_CAP" apart from
      // "the default the engine chose for me" (and knows `NANSEN_DAILY_CREDIT_CAP=off` exists).
      const capOrigin = typeof deps.dailyCreditCap === 'number' ? 'configured' : 'derived';
      let reason: string;
      if (bindingIsVendor) {
        reason = `vendor: need ${cost}, remaining (as of last resync) ${snapshot.creditsRemainingAtObserve}`;
      } else {
        // Q-6: the two branches of ONE refusal used to answer two different questions — the vendor
        // branch named the REMAINING allowance, this one named the CEILING. "need 6, allows 30"
        // while refusing reads as a self-contradiction, and the single number that explains the
        // refusal (the remainder, 4 in the filed case) was the only one absent. The reader could
        // not compare the two branches, act on either, or learn one rule from them.
        //
        // Best-effort, and never allowed to REPLACE the refusal: `getUsage()` can throw for
        // reasons that have nothing to do with the budget (SQLITE_BUSY), and turning a clear
        // budget refusal into a storage error would destroy the message this exists to sharpen.
        // The ceiling stays in the text either way, so the fallback is strictly less informative
        // than the fix and never less informative than what it replaced.
        let usedNow: number | null;
        try {
          usedNow = await deps.budgetStore.getUsage('nansen', bucket);
        } catch {
          usedNow = null;
        }
        // `effectiveCeiling`, not `capNow`. In this branch the two are the same number by
        // construction — a self-imposed cap that is not the binding one cannot have refused — but
        // `capNow` is `number | undefined` (`undefined` when the cap is switched off), and the
        // line this replaces interpolated it raw, so a mis-shaped call would have rendered
        // "allows undefined". The ceiling that actually refused is both the type-safe value and
        // the honest one to name.
        const budget =
          usedNow === null
            ? `cap ${effectiveCeiling} (remaining unavailable)`
            : `remaining ${Math.max(0, effectiveCeiling - usedNow)} of ${effectiveCeiling}`;
        reason =
          `self-imposed cap (${capOrigin}): need ${cost}, ${budget}` +
          ` — set NANSEN_DAILY_CREDIT_CAP to raise it, or ${DAILY_CAP_OFF} to disable it`;
      }
      throw new NansenBudgetExceededError(reason);
    }

    // M-2(a) (adversarial review cycle 1): the reservation above is ALREADY committed at this
    // point — everything below is best-effort observability, never allowed to fail the call.
    // `getUsage()`/`process.stderr.write()` can both throw for reasons that have nothing to do
    // with whether the reservation itself is good (SQLITE_BUSY, EPIPE once the stdio client has
    // closed, ...): letting either propagate would reject `ensureBudget()` AFTER the credits were
    // already spent, and (pre-fix) that throw landed OUTSIDE `index.ts`'s own try/catch, so neither
    // `markUnreconciled()` nor `reconcile()` ever ran for it — a phantom charge for zero HTTP calls,
    // with no resync ever scheduled to absorb it. Same "never fail a committed write over an
    // observability side effect" contract `registry.ts` already applies to cache faults.
    if (!deps.accountState.hasWarned()) {
      try {
        const usedAfter = await deps.budgetStore.getUsage('nansen', bucket);
        if (usedAfter / effectiveCeiling >= warnRatio) {
          deps.accountState.markWarned();
          // Same out-of-band channel as M1 cache metrics (cache/stats.ts) — NEVER stdout (the
          // JSON-RPC wire, M0 §7.3 invariant).
          process.stderr.write(
            `nansen budget warn: provider=nansen bucket=${bucket} used=${usedAfter} ` +
              `ceiling=${effectiveCeiling} ratio=${(usedAfter / effectiveCeiling).toFixed(2)}\n`,
          );
        }
      } catch {
        // Best-effort only — see this block's own comment above.
      }
    }

    // `window` only when the guard is on — reconciliation refunds into THIS window or none.
    return { reservedTotal: cost, bucket, ...(velocity === undefined ? {} : { window }) };
  }

  return { ensureBudget };
}
