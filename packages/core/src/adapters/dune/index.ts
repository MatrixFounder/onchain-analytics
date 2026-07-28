import type { ProviderAdapter } from '../types.js';
import { NotImplementedInM1Error } from '../not-implemented-error.js';

/**
 * `dune` adapter (ARCHITECTURE.md §3.2/§11, R-8 — amended scope, architecture review cycle 1):
 * interface/config-stub only, and since TASK-008 it declares **no capability at all**.
 *
 * It used to declare `token.holders` so that the route for it resolved to a real registered adapter
 * with an explicit unavailability reason rather than the generic "no adapter registered". That
 * argument expired the moment the capability got a working provider: `token.holders` now routes to
 * `blockscout` (R-74), and a second adapter declaring the same capability while covering zero
 * chains only adds a dead entry to the route walk. Declaring nothing is the honest state of a stub
 * — the registration itself remains, so the providers FK (§4.2) and the DUNE_API_KEY story are
 * untouched, and a future real implementation re-declares whatever it actually serves.
 */
export function createDuneAdapter(): ProviderAdapter {
  return {
    id: 'dune',
    // **Serves no chain** (vdd-multi cycle 5, L-10). This used to answer `true` for ethereum on the
    // reasoning that an unconditionally-false `isAvailable()` made the coverage answer academic. It
    // is not academic: the coverage matrix is derived from routes × `chainSupport` and does NOT
    // consult `isAvailable()`, so `onchain_list_chains` listed `token.holders` among ethereum's
    // capabilities — advertising, to the one tool built to answer "what can I actually get here",
    // a capability that in M1 can never be served by anything.
    chainSupport: (): boolean => false,
    // Empty since TASK-008 — see the docstring. An adapter that serves nothing declares nothing.
    capabilities: () => [],
    costOf: () => ({ credits: 0 }),
    // Unreachable through CapabilityRegistry in M1 (isAvailable() below always skips this
    // adapter) — throws loudly rather than silently if ever called directly/out-of-band.
    fetch: async () => {
      throw new NotImplementedInM1Error('dune', 'fetch');
    },
    normalize: () => {
      throw new NotImplementedInM1Error('dune', 'normalize');
    },
    // Unconditional in M1, independent of DUNE_API_KEY's presence — live query authoring
    // (query id, parameterization) is deferred to M2, together with the first real consumer.
    isAvailable: () => ({ ok: false, reason: 'dune query authoring deferred to M2' }),
  };
}
