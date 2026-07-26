import registryData from './registry.data.json' with { type: 'json' };
import { buildChainRegistry } from './registry-core.js';
import type { ChainRegistry, ChainRegistryDeps } from './registry-core.js';

/**
 * Runtime entry point for the chain registry (TASK-006, R-48/R-60). The logic lives in
 * `registry-core.ts`; this module's only job is to bind it to the SHIPPED snapshot, which is why
 * it is the only place that imports `registry.data.json`.
 */
export function loadChainRegistry(deps: ChainRegistryDeps = {}): ChainRegistry {
  // `'data' in deps`, NOT `deps.data ?? registryData`: `null ?? x` yields `x`, so an explicit
  // `{data: null}` would silently fall back to the SHIPPED registry instead of failing. A test
  // that believes it runs on a synthetic document would then be exercising production data and
  // passing for the wrong reason. Absence of the key means "use the shipped snapshot"; a present
  // key means "use exactly this, and fail loudly if it is unusable".
  return buildChainRegistry('data' in deps ? deps.data : registryData);
}

export { buildChainRegistry } from './registry-core.js';
export type {
  ChainInfo,
  ChainFamily,
  ChainRegistry,
  ChainRegistryDeps,
  ChainListFilter,
} from './registry-core.js';
