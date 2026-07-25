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
 * The default self-imposed daily ceiling, derived from the balance observed at the bucket's first
 * `/account` resync (Q-2). Exported for direct unit testing of the number itself.
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
export function deriveDailyCap(creditsRemaining: number): number {
  return Math.max(DERIVED_CAP_FLOOR, Math.floor(creditsRemaining * DERIVED_CAP_FRACTION));
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
 * Resolves the configured value into the cap to pin for a bucket (Q-2):
 * - `'off'` → `undefined` — no self-imposed ceiling; the vendor remainder alone bounds spend
 * - a number → that explicit operator-chosen ceiling
 * - unset → `deriveDailyCap(balance)`
 */
function resolveDailyCap(
  configured: DailyCreditCapConfig,
  creditsRemaining: number,
): number | undefined {
  if (configured === DAILY_CAP_OFF) return undefined;
  if (typeof configured === 'number') return configured;
  return deriveDailyCap(creditsRemaining);
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
  budgetWarnRatio?: number;
  now?: () => number;
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  throttle?: Throttle;
}

/** `ensureBudget()`'s success shape (task 005-3) — `bucket` is the SAME `dayBucketMs` fixed at
 * entry, threaded straight through so a caller (005-5's `fetch()` wiring) reconciles the exact
 * same `usage` row this reservation was written against, never a bucket recomputed later from a
 * fresh `Date.now()`. */
export interface NansenBudgetReservation {
  reservedTotal: number;
  bucket: number;
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
 * Pure ceiling formula (system-architecture.md §3.2 "Формула потолка бакета" — the anchor-rebased
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
 * rather than adding a second dedup flag to `NansenAccountState`; if request pressure ever becomes
 * a real problem the right fix is a circuit breaker around the capability itself, not a blindfold
 * on the ledger. Tracked as a known-issue rather than silently dropped.
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
 *    fail-closed, no valid ceiling to compute against a stale/absent snapshot.
 * 3. Computes the exact price (`costOf()`, cost-of.ts) under the now-current live `plan`, and
 *    fail-closes (`NansenBudgetExceededError`, never reaching `BudgetStore`) if that price isn't
 *    finite (R-37 MIN-3 — an unrecognized capability or a cost-table key that doesn't exist).
 * 4. Computes `effectiveCeilingFor()` from the live snapshot + the optional self-imposed cap, and
 *    atomically reserves the price via `BudgetStore.checkAndReserve` (005-2) — a `{ok:false}`
 *    result throws with a reason naming WHICH of the two limits was binding.
 * 5. On success, emits the warn-threshold stderr line at most once per bucket (`accountState`'s
 *    own `hasWarned()`/`markWarned()` flag, reset by the next `set()`/resync).
 *
 * This function is the ONLY thing this module exposes for actually spending budget — `NOT` yet
 * wired into `adapters/nansen/index.ts`'s `fetch()` in this task (that wiring lands in task
 * 005-5); `packages/core/src/index.ts` does not re-export this module at all (§3.2 "Budget gate —
 * ...не отдельный wrapper-объект" — the gate is an internal implementation seam of the adapter's
 * own `fetch()`, never a second, bypassable call site).
 */
export function createNansenBudgetGate(deps: NansenBudgetGateDeps): {
  ensureBudget(cap: string, args: Record<string, unknown>): Promise<NansenBudgetReservation>;
} {
  const now = deps.now ?? Date.now;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const env = deps.env ?? process.env;
  const throttleFn = deps.throttle ?? productionThrottle;
  const warnRatio = deps.budgetWarnRatio ?? DEFAULT_WARN_RATIO;

  /**
   * `GET /account` resync (system-architecture.md §3.2 "M-4 review" — header `apiKey`, the
   * generic Web credentials-header + token-prefix scheme is NOT used here, see this directory's
   * own .AGENTS.md note for why that distinction matters). Reads `usage.credits_used` for THIS
   * `bucket` in the SAME logical step as the HTTP call (no paid call in between) so the anchor
   * this snapshot forms can never go stale before it's saved.
   */
  async function refreshAccount(bucket: number): Promise<void> {
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

    await throttleFn('nansen', RATE_LIMIT);
    const response = await safeFetch(ACCOUNT_URL, { headers: { apiKey } }, HOSTS, fetchImpl);
    if (!response.ok) {
      throw new Error(`nansen budget gate: /account resync failed with HTTP ${response.status}`);
    }
    const body = (await response.json()) as AccountResponseBody;
    if (typeof body.credits_remaining !== 'number') {
      throw new Error('nansen budget gate: /account response missing credits_remaining');
    }
    // Unknown/future plan values fold to 'free' — the same conservative, safe-direction default
    // costOf() uses before the first resync (system-architecture.md §3.2 "Account-state").
    const plan: 'free' | 'pro' = body.plan === 'pro' ? 'pro' : 'free';

    // PIN the daily cap per bucket (Q-2). A mid-bucket resync (unreconciled → `/account`) carries
    // the previous snapshot's value forward verbatim; only a NEW bucket (or a cold start) derives a
    // fresh one. Re-deriving on every resync would make the "daily" ceiling shrink during the day —
    // at balance 200 the operator is told 50, then locked out after 40 — because each resync sees a
    // smaller balance. `previous` is the snapshot for THIS bucket, if one exists.
    const previous = deps.accountState.get();
    const dailyCapForBucket =
      previous !== undefined && previous.dayBucketMs === bucket
        ? previous.dailyCapForBucket
        : resolveDailyCap(deps.dailyCreditCap, body.credits_remaining);

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
  ): Promise<NansenBudgetReservation> {
    const bucket = dayBucketMs(now());

    if (needsResync(deps.accountState.get(), bucket, deps.accountState)) {
      await refreshAccount(bucket);
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

    const result = await deps.budgetStore.checkAndReserve('nansen', bucket, cost, effectiveCeiling);
    if (!result.ok) {
      const vendorCeiling = snapshot.usageAtObserve + snapshot.creditsRemainingAtObserve;
      const bindingIsVendor = effectiveCeiling === vendorCeiling;
      // Name WHICH ceiling refused, and — when it is the self-imposed one — whether that number was
      // configured or derived, so an operator can tell "my NANSEN_DAILY_CREDIT_CAP" apart from
      // "the default the engine chose for me" (and knows `NANSEN_DAILY_CREDIT_CAP=off` exists).
      const capOrigin = typeof deps.dailyCreditCap === 'number' ? 'configured' : 'derived';
      const reason = bindingIsVendor
        ? `vendor: need ${cost}, remaining (as of last resync) ${snapshot.creditsRemainingAtObserve}`
        : `self-imposed cap (${capOrigin}): need ${cost}, allows ${capNow}` +
          ` — set NANSEN_DAILY_CREDIT_CAP to raise it, or ${DAILY_CAP_OFF} to disable it`;
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

    return { reservedTotal: cost, bucket };
  }

  return { ensureBudget };
}
