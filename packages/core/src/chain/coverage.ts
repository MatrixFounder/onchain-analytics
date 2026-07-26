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
  /** Every chain where `capability` is covered — the "available on" list in an error message. */
  chainsFor(capability: string): ChainInfo[];
  /** Every capability covered on `chain` — the "available instead" list in an error message. */
  capabilitiesFor(chain: ChainInfo): string[];
}

export interface CoverageDeps {
  readonly routes: readonly CapabilityRoute[];
  readonly adapters: ReadonlyMap<string, ProviderAdapter>;
  readonly chains: ChainRegistry;
}

export function createCoverage(deps: CoverageDeps): Coverage {
  const { routes, adapters, chains } = deps;

  const routesFor = (capability: string): CapabilityRoute[] =>
    routes.filter((route) => route.capability === capability);

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

  const isCovered = (capability: string, chain: ChainInfo): boolean =>
    routesFor(capability).some((route) => routeCoversChain(route, chain));

  return {
    isCovered,
    chainsFor(capability: string): ChainInfo[] {
      // `list()` already excludes deprecated chains: offering a dead chain as an alternative is
      // worse than offering none.
      return chains.list().filter((chain) => isCovered(capability, chain));
    },
    capabilitiesFor(chain: ChainInfo): string[] {
      const covered = new Set<string>();
      for (const route of routes) {
        if (covered.has(route.capability)) continue;
        if (routeCoversChain(route, chain)) covered.add(route.capability);
      }
      return [...covered].sort();
    },
  };
}
