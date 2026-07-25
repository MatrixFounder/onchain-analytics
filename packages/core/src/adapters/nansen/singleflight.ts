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
export function createSingleflight(): <T>(key: string, fn: () => Promise<T>) => Promise<T> {
  const inFlight = new Map<string, Promise<unknown>>();

  /**
   * `singleflight(key, fn)` (task 005-5, Phase 2): an in-flight promise for `key` is returned
   * as-is to a second caller instead of invoking `fn()` again (TC-UNIT-08/10). A `key` with no
   * in-flight entry calls `fn()` and stores its promise BEFORE returning — synchronously, so a
   * second caller arriving before the first `await` inside `fn()` still observes the entry
   * (TC-UNIT-08's own "no `await` between the two starts" precondition). The entry is deleted in
   * `finally`, on EITHER settlement outcome (resolve or reject, TC-UNIT-11) — a call arriving after
   * that point is a genuinely new-in-time request and gets its own fresh `fn()` invocation
   * (TC-UNIT-09).
   */
  return function singleflight<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = inFlight.get(key);
    if (existing) {
      return existing as Promise<T>;
    }

    const promise = fn().finally(() => {
      inFlight.delete(key);
    });
    inFlight.set(key, promise);
    return promise;
  };
}
