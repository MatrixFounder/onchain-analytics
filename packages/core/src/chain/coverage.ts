import type { CapabilityRoute, ProviderAdapter } from '../adapters/types.js';
import type { ChainInfo, ChainRegistry } from './registry-core.js';

/**
 * Capability × chain coverage (TASK-006 R-51 — data-model.md §4.2.3).
 *
 * Coverage is **derived, never stored**:
 *
 * ```
 * covered(capability, chain) := ∃ adapterId ∈ route(capability).adapterIds :
 *                                 adapter(adapterId).chainSupport(chainInfo) === true
 * ```
 *
 * A stored matrix would mean maintaining coverage in two places — the registry AND each adapter's
 * `capabilities()` — and the two would diverge on the first change. Deriving it leaves the registry
 * as the single source of facts about a chain and the adapter as the single source of facts about
 * itself.
 *
 * An adapter that declares no `chainSupport` is treated as not chain-bound, i.e. it covers whatever
 * its route covers. That keeps every pre-TASK-006 adapter behaving exactly as before until tasks
 * 006-5/006-9 give them real predicates.
 */
export interface Coverage {
  /** Is `capability` served on `chain` by at least one adapter of its route? */
  isCovered(capability: string, chain: ChainInfo): boolean;
  /** Every chain where `capability` is covered. */
  chainsFor(capability: string): ChainInfo[];
  /** Every capability covered on `chain` — the "available instead" list in an error message. */
  capabilitiesFor(chain: ChainInfo): string[];
  /** The first `limit` slugs where `capability` is covered, plus the true total. For error
   * messages, which render ten (vdd-multi cycle 6): the unbounded `chainsFor(...).map(slug)` this
   * replaces made a REFUSAL cost more than the cache-hit success path it protects — and a refusal
   * is what a confused agent hits over and over. */
  servedSlugs(capability: string, limit: number): { slugs: string[]; total: number };
}

export interface CoverageDeps {
  readonly routes: readonly CapabilityRoute[];
  readonly adapters: ReadonlyMap<string, ProviderAdapter>;
  readonly chains: ChainRegistry;
}

export function createCoverage(deps: CoverageDeps): Coverage {
  const { routes, adapters, chains } = deps;

  /**
   * Everything below is memoized per `Coverage` INSTANCE, and that is sound for one reason worth
   * stating: `routes`, `adapters` and `chains` are all constructor-injected and immutable for the
   * life of the instance, so every value here is a pure function of them. Nothing is process-wide
   * (ARCHITECTURE.md §8) — a second `CapabilityRegistry` gets a second, independent matrix.
   *
   * It matters because these are not once-per-request calls (vdd-multi cycle 6, perf): a single
   * `onchain_list_chains({capability})` used to run `routes.filter()` once per registry ROW — 458
   * throwaway arrays and ~8 700 comparisons to answer a question with a dozen distinct answers.
   */
  const routesByCapability = new Map<string, CapabilityRoute[]>();
  for (const route of routes) {
    const bucket = routesByCapability.get(route.capability);
    if (bucket) bucket.push(route);
    else routesByCapability.set(route.capability, [route]);
  }
  /** `capability → caip2s where it is covered`, built on first use. */
  const coveredByCapability = new Map<string, Set<string>>();
  /** `caip2 → covered capabilities`, built on first use. */
  const capabilitiesByChain = new Map<string, string[]>();

  const routesFor = (capability: string): readonly CapabilityRoute[] =>
    routesByCapability.get(capability) ?? [];

  function routeCoversChain(route: CapabilityRoute, chain: ChainInfo): boolean {
    for (const adapterId of route.adapterIds) {
      const adapter = adapters.get(adapterId);
      if (!adapter) continue; // an id with no registered adapter answers for nothing
      // No predicate ⇒ the adapter is not chain-bound ⇒ it covers whatever its route covers.
      if (!adapter.chainSupport) return true;
      if (adapter.chainSupport(chain, route.capability)) return true;
    }
    return false;
  }

  // Deprecated chains are NOT covered (vdd-multi cycle 5, M-5). `chainsFor`/`onchain_list_chains`
  // already excluded them — they go through `list()` — while the GATE did not, so a dead chain was
  // absent from every list a caller can read and yet passed the check and reached a real, possibly
  // paid, `fetch()`. Two views of one matrix disagreeing is precisely what deriving coverage
  // instead of storing it was meant to prevent, so the exclusion belongs in the predicate all three
  // share, not in one of its callers.
  /** The uncached predicate. `isCovered` below answers from the memo instead. */
  const computeCovered = (capability: string, chain: ChainInfo): boolean =>
    !chain.deprecated && routesFor(capability).some((route) => routeCoversChain(route, chain));

  /** `capability → the caip2 set`, computed once. One full scan replaces one scan per query. */
  function coveredSet(capability: string): Set<string> {
    let set = coveredByCapability.get(capability);
    if (!set) {
      set = new Set<string>();
      for (const chain of chains.list()) {
        if (computeCovered(capability, chain)) set.add(chain.caip2);
      }
      coveredByCapability.set(capability, set);
    }
    return set;
  }

  const isCovered = (capability: string, chain: ChainInfo): boolean =>
    // `chains.list()` excludes deprecated rows, so a deprecated chain is absent from the set —
    // which is the same answer `computeCovered` gives, by a different route. Checked explicitly
    // anyway so a caller holding a deprecated `ChainInfo` from `get()` gets the same verdict.
    !chain.deprecated && coveredSet(capability).has(chain.caip2);

  return {
    isCovered,
    chainsFor(capability: string): ChainInfo[] {
      const set = coveredSet(capability);
      return chains.list().filter((chain) => set.has(chain.caip2));
    },
    servedSlugs(capability: string, limit: number): { slugs: string[]; total: number } {
      const set = coveredSet(capability);
      const slugs: string[] = [];
      for (const chain of chains.list()) {
        if (!set.has(chain.caip2)) continue;
        if (slugs.length < limit) slugs.push(chain.slug);
      }
      return { slugs, total: set.size };
    },
    capabilitiesFor(chain: ChainInfo): string[] {
      if (chain.deprecated) return [];
      const cached = capabilitiesByChain.get(chain.caip2);
      if (cached) return cached;
      const covered = new Set<string>();
      for (const route of routes) {
        if (covered.has(route.capability)) continue;
        if (routeCoversChain(route, chain)) covered.add(route.capability);
      }
      const result = [...covered].sort();
      capabilitiesByChain.set(chain.caip2, result);
      return result;
    },
  };
}
