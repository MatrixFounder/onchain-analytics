/** Hit/miss counters for one capability (ARCHITECTURE.md §3.2 R-15). */
export interface CacheCounters {
  hit: number;
  miss: number;
}

/**
 * In-process counters (ARCHITECTURE.md §3.2 R-15), module-scoped for the process lifetime — not a
 * class instance, since there is exactly one cache per process (ARCHITECTURE.md §8 "factory, not
 * singleton" governs `CapabilityRegistry`/`CacheStore` construction; these counters are pure
 * observability state, not a swappable dependency).
 */
const counters = new Map<string, CacheCounters>();

function bucketFor(capability: string): CacheCounters {
  let existing = counters.get(capability);
  if (!existing) {
    existing = { hit: 0, miss: 0 };
    counters.set(capability, existing);
  }
  return existing;
}

/**
 * Records one cache lookup outcome and emits the mandatory stderr line (ARCHITECTURE.md §3.2 —
 * `cache=hit|miss provider=<id> capability=<cap> ageMs=<n>`, no args/secret values — greppable for
 * dev/CI without changing the MCP wire protocol). NEVER writes to stdout (M0 stdout-discipline
 * invariant, §7.3 — stdout is the JSON-RPC wire, stderr is the only safe out-of-band channel).
 *
 * Called from `TwoLevelStore.get()` (not from an edit to `CapabilityRegistry.resolve()` —
 * implementation choice, developer-guidelines §1.5): every meaningful cache lookup the Registry
 * performs while walking an available adapter already flows through `CacheStore.get(provider,
 * capability, argsHash)`, which is exactly the `(provider, capability)` pair this line and the
 * counters need — recording at that single seam captures the same outcomes a `registry.ts` edit
 * would, without touching `registry.ts` itself (it already calls `cache.get(...)` unchanged since
 * task 003-2).
 */
export function recordCacheAccess(
  provider: string,
  capability: string,
  outcome: 'hit' | 'miss',
  ageMs?: number,
): void {
  bucketFor(capability)[outcome] += 1;
  process.stderr.write(
    `cache=${outcome} provider=${provider} capability=${capability} ageMs=${ageMs ?? 0}\n`,
  );
}

/**
 * Snapshot of all counters recorded so far — consumed by tools' `_meta.cache` (task 003-7) and by
 * tests. Returns a plain object copy (not the live `Map`) so callers can't mutate internal state.
 */
export function getCacheStats(): Record<string, CacheCounters> {
  return Object.fromEntries(
    Array.from(counters, ([capability, value]) => [capability, { ...value }]),
  );
}

/**
 * Clears all counters. Test-only utility (module-scoped state would otherwise leak between test
 * files/cases) — production code never calls this; counters live for the process lifetime.
 */
export function resetCacheStats(): void {
  counters.clear();
}
