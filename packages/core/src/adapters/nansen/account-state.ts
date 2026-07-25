/**
 * Live Nansen account snapshot — the sole source of "how much vendor budget is left" and "which
 * plan is active right now" (system-architecture.md §3.2 "Account-state — общая опора...", task
 * 005-3, R-36). `usageAtObserve` and `creditsRemainingAtObserve` are read in ONE logical resync
 * step (budget-gate.ts's `refreshAccount()`) — never a paid call apart in between — so the anchor
 * this snapshot forms can never go stale before it is even saved.
 */
export interface NansenAccountSnapshot {
  plan: 'free' | 'pro';
  /** Vendor-reported `credits_remaining` from `/account`, AT THE MOMENT this snapshot was taken. */
  creditsRemainingAtObserve: number;
  /** `usage.credits_used(provider, dayBucketMs)` read in the SAME step as `/account` — the
   * anchor `effectiveCeiling` rebases the vendor remainder onto (budget-gate.ts). */
  usageAtObserve: number;
  observedAtMs: number;
  /** Which day-bucket this snapshot serves — `dayBucketMs(observedAtMs)`. A snapshot whose
   * `dayBucketMs` no longer matches "now"'s bucket is stale and forces a resync. */
  dayBucketMs: number;
  /**
   * The self-imposed daily ceiling in force for THIS bucket, already resolved from config
   * (`undefined` = no self-imposed ceiling, i.e. the vendor remainder alone bounds spend).
   *
   * **Pinned, not recomputed** (Q-2): a mid-bucket resync (`markUnreconciled()` → `/account`)
   * carries this value forward verbatim instead of re-deriving it from the now-smaller balance.
   * Re-deriving would make a "daily" ceiling shrink *during* the day — at balance 200 the operator
   * is told the ceiling is 50, then gets locked out after spending 40, because each resync recomputes
   * a smaller cap. Pinning gives the number honest semantics: 50 means 50 until the bucket rolls over.
   */
  dailyCapForBucket: number | undefined;
}

/**
 * Mutable, in-memory holder for the adapter's own live account state (system-architecture.md
 * §3.2 "Account-state" + "Budget-warning threshold", task 005-3). ONE instance per
 * `createNansenAdapter()` call — constructed once inside the factory and shared between
 * `costOf()` (cost-of.ts) and the budget gate (budget-gate.ts), never a module-level singleton
 * (ARCHITECTURE.md §8 "factory, not singleton"). Package-internal — not re-exported from this
 * package's top-level `src/index.ts` (§3.2 "Budget gate — размещение"); tests import it directly
 * by relative path, the same convention already used for `cache/budget-store.ts` in this package.
 *
 * `hasWarned()`/`markWarned()` are a task 005-3 addition beyond the architecture doc's original
 * 5-method sketch: the SAME doc's later "Budget-warning threshold" section requires "a boolean
 * flag in NansenAccountState, reset on the next resync" so the warn-threshold stderr line
 * (budget-gate.ts) fires at most once per crossing per bucket. This is the natural home for that
 * flag — it shares the exact same "reset on resync" lifecycle as `unreconciled` conceptually
 * shares with a *different* trigger (developer-guidelines §1.6 documented implementation choice).
 */
export interface NansenAccountState {
  /** `undefined` = never resolved in this process (cold start) — the caller must resync before
   * trusting any budget decision on it. */
  get(): NansenAccountSnapshot | undefined;
  /** Also resets the warn-flag back to `false` — every successful resync starts a fresh "have we
   * already warned for THIS snapshot" window. */
  set(snapshot: NansenAccountSnapshot): void;
  /** R-38 — set after a transport failure/timeout, or a `402 Payment Required`, on a
   * reserved-but-unconfirmed paid call; forces the NEXT `ensureBudget()` entry to resync before
   * trusting the (possibly stale) local snapshot. */
  markUnreconciled(): void;
  isUnreconciled(): boolean;
  /** Cleared ONLY by a successful `refreshAccount()` resync — deliberately NOT by a successful
   * paid call (the flag means "don't trust the live counter until the next resync", not "the last
   * call failed"). */
  clearUnreconciled(): void;
  hasWarned(): boolean;
  markWarned(): void;
}

/**
 * Constructs a fresh, isolated `NansenAccountState` (factory, not singleton — ARCHITECTURE.md
 * §8). Starts cold (`get()` returns `undefined`, `isUnreconciled()`/`hasWarned()` both `false`) —
 * every field is a plain closed-over local, no external state, no I/O.
 */
export function createNansenAccountState(): NansenAccountState {
  let snapshot: NansenAccountSnapshot | undefined;
  let unreconciled = false;
  let warned = false;

  return {
    get: () => snapshot,
    set: (next) => {
      snapshot = next;
      warned = false;
    },
    markUnreconciled: () => {
      unreconciled = true;
    },
    isUnreconciled: () => unreconciled,
    clearUnreconciled: () => {
      unreconciled = false;
    },
    hasWarned: () => warned,
    markWarned: () => {
      warned = true;
    },
  };
}
