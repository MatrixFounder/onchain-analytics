import registryData from './registry.data.json' with { type: 'json' };
import { buildChainRegistry } from './registry-core.js';
import type { ChainRegistry, ChainRegistryDeps } from './registry-core.js';

/**
 * Runtime entry point for the chain registry (TASK-006, R-48/R-60). The logic lives in
 * `registry-core.ts`; this module's only job is to bind it to the SHIPPED snapshot, which is why
 * it is the only place that imports `registry.data.json`.
 */
/**
 * The shipped snapshot's registry, built at most once per process (vdd-multi cycle 5, H-4).
 *
 * **Why this is not the module singleton ARCHITECTURE.md §8 forbids.** §8 bans mutable
 * process-lifetime STATE that scaling would have to unwind. This is a memoized pure function of a
 * build-time constant: same input, same output, nothing observable can change it, and an injected
 * `deps.data` bypasses it entirely. The equivalent bridge in `chain/address.ts` already works this
 * way for the same reason.
 *
 * **What it costs to not do it.** Building the registry is a full zod parse of 458 rows plus four
 * indexes — measured at ~0.6 ms. `canonicalizeChain()` used to pay that on EVERY tool call to
 * perform a single `Map.get` (measured ×5500 overhead), and five adapters plus `CapabilityRegistry`
 * each built their own copy at startup. On a cache HIT — the path the whole cache exists to make
 * fast — the rebuild dominated the useful work.
 */
let shippedRegistry: ChainRegistry | null = null;

export function loadChainRegistry(deps: ChainRegistryDeps = {}): ChainRegistry {
  // `'data' in deps`, NOT `deps.data ?? registryData`: `null ?? x` yields `x`, so an explicit
  // `{data: null}` would silently fall back to the SHIPPED registry instead of failing. A test
  // that believes it runs on a synthetic document would then be exercising production data and
  // passing for the wrong reason. Absence of the key means "use the shipped snapshot"; a present
  // key means "use exactly this, and fail loudly if it is unusable".
  //
  // Only the shipped-snapshot branch is memoized: an injected document is built fresh every time,
  // so a test handing in two different synthetic registries gets two different registries.
  if ('data' in deps) return buildChainRegistry(deps.data);
  return (shippedRegistry ??= buildChainRegistry(registryData));
}

export { buildChainRegistry } from './registry-core.js';
export type {
  ChainInfo,
  ChainFamily,
  ChainRegistry,
  ChainRegistryDeps,
  ChainListFilter,
} from './registry-core.js';
