import { DeadlineExceededError } from '../../net/safe-fetch.js';

/**
 * In-memory, per-process call coalescing for the `nansen` adapter's `fetch()` (system-architecture.md
 * §3.2 "Singleflight (R-39)", task 005-5). `createSingleflight()` returns a function
 * `(key, fn) => Promise<T>` closed over its OWN `Map<string, Promise<unknown>>` — one instance per
 * `createNansenAdapter()` call (constructed alongside `accountState`, never a module-level
 * singleton, ARCHITECTURE.md §8), so two different adapter instances never share coalescing state.
 *
 * Two concurrent calls sharing the same `key` — the second one starting BEFORE the first has
 * settled — share exactly ONE `fn()` invocation and its single resolved/rejected outcome (both
 * callers observe the same value, or the same error). A call arriving AFTER the first has already
 * settled is NOT coalesced — it is a genuinely new-in-time request and starts a fresh `fn()` call
 * with its own fresh budget check (system-architecture.md §3.2's own wording, task 005-5 task
 * file). This is deliberately NOT cross-process (a shared `DATA_DIR`/`cache.sqlite3` across several
 * concurrent `stdio` sessions is a DIFFERENT, already-solved concern — `BudgetStore.checkAndReserve`'s
 * own `BEGIN IMMEDIATE` transaction, see budget-store.ts) — two different processes issuing the
 * identical request concurrently are two legitimate, independently-priced calls; only THIS process's
 * own duplicate in-flight requests are coalesced here.
 *
 * `key` is always `deriveArgsHash(capability, args)` (`net/args-hash.ts`) — this module never
 * derives its own key, it only stores/looks one up (index.ts is this module's only caller).
 */
export function createSingleflight(): <T>(
  key: string,
  fn: () => Promise<T>,
  deadlineAtMs?: number,
  onCoalesced?: () => void,
) => Promise<T> {
  const inFlight = new Map<string, Promise<unknown>>();

  /**
   * `singleflight(key, fn, deadlineAtMs?)` (task 005-5, Phase 2; the deadline is task 012-9): an
   * in-flight promise for `key` is shared with a second caller instead of invoking `fn()` again
   * (TC-UNIT-08/10). A `key` with no in-flight entry calls `fn()` and stores its promise BEFORE
   * returning — synchronously, so a second caller arriving before the first `await` inside `fn()`
   * still observes the entry (TC-UNIT-08's own "no `await` between the two starts" precondition).
   * The entry is deleted in `finally`, on EITHER settlement outcome (resolve or reject, TC-UNIT-11)
   * — a call arriving after that point is a genuinely new-in-time request and gets its own fresh
   * `fn()` invocation (TC-UNIT-09).
   *
   * **`deadlineAtMs` bounds the FOLLOWER's wait and nothing else** (task 012-9, PLAN §0.3 seam #3):
   *
   * - The **leader** — the caller whose `fn()` this is — is never raced against it. Its `fn()` runs
   *   the budget gate and the paid sub-calls, and cutting that short is exactly the "paid and did not
   *   receive" outcome ADR-002 D4 п.2 forbids. The leader's own deadline is honoured INSIDE `fn()`,
   *   on the free work only (`budget-gate.ts`).
   * - A **follower** whose own deadline expires while the leader is still unsettled stops waiting and
   *   rejects — but it does NOT cancel the leader, which keeps running for every other waiter,
   *   including one with a wider deadline (`test/nansen-deadline-boundary.test.ts` TC-INT-03).
   * - The class thrown is the NETWORK-layer `DeadlineExceededError`, deliberately. The registry's
   *   own `CapabilityDeadlineExceededError` carries `{capability, chain, tried}`, none of which
   *   exists in here — this module knows a key and a promise. The registry's existing C-1 catch
   *   (task 012-8) translates it, the same translation it performs for every other net-layer
   *   deadline.
   *
   * `deadlineAtMs` is deliberately NOT part of `key` (the key is `deriveArgsHash(capability, args)`,
   * derived by the caller): two calls for the same `(capability, args)` with different deadlines are
   * one unfinished request, not two.
   */
  return function singleflight<T>(
    key: string,
    fn: () => Promise<T>,
    deadlineAtMs?: number,
    onCoalesced?: () => void,
  ): Promise<T> {
    const existing = inFlight.get(key);
    if (existing) {
      // **The follower announces itself, synchronously, before the shared promise is handed back**
      // (task 014-30). Leader and follower receive the SAME promise and the same value, so the fact
      // cannot travel in the result: it distinguishes CALLERS, not answers. One vendor call served
      // two charges, and T-015 reconciles the ledger against `usage` by exactly that count (R-27.3)
      // — without this signal the number of charges one vendor call produced is unrecoverable.
      onCoalesced?.();
      return deadlineAtMs === undefined
        ? (existing as Promise<T>)
        : followUntilDeadline(existing as Promise<T>, deadlineAtMs);
    }

    const promise = fn().finally(() => {
      inFlight.delete(key);
    });
    inFlight.set(key, promise);
    return promise;
  };
}

/** Where a follower's `DeadlineExceededError` says it happened. Not a URL — `redactContext()` leaves
 * it verbatim — and deliberately free of the args hash: the message is rendered into the model's
 * context, and the key identifies the caller's request. */
const FOLLOWER_CONTEXT = 'nansen singleflight (an identical call was already in flight)';

/**
 * Awaits the leader's promise but gives up at `deadlineAtMs`, WITHOUT touching the leader.
 *
 * Shape borrowed verbatim from `safeFetch`'s own `raceWithTimeout`: an `AbortSignal.timeout` plus a
 * listener removed on settlement, rather than a bare `Promise.race` with a `setTimeout` — the
 * listener form leaves no timer holding the event loop open once the leader answers first. A
 * rejection from the leader arriving AFTER the follower has already given up is still consumed by
 * the handler attached here, so it can never surface as an unhandled rejection.
 */
function followUntilDeadline<T>(leader: Promise<T>, deadlineAtMs: number): Promise<T> {
  const remainingMs = deadlineAtMs - Date.now();
  // Already spent on arrival — no timer, no waiting, same class. The duplicate of the check below,
  // for the same reason `safeFetch` keeps its own entry check: a timer can only fire after the fact.
  if (remainingMs <= 0) {
    return Promise.reject(new DeadlineExceededError(FOLLOWER_CONTEXT, deadlineAtMs));
  }
  return new Promise<T>((resolve, reject) => {
    const signal = AbortSignal.timeout(remainingMs);
    const onAbort = (): void => reject(new DeadlineExceededError(FOLLOWER_CONTEXT, deadlineAtMs));
    signal.addEventListener('abort', onAbort, { once: true });
    leader.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error instanceof Error ? error : new Error(String(error)));
      },
    );
  });
}
