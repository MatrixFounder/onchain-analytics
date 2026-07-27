import type { ProviderAdapter } from '../types.js';
import { NotImplementedInM1Error } from '../not-implemented-error.js';

/**
 * `dune` adapter (ARCHITECTURE.md §3.2/§11, R-8 — amended scope, architecture review cycle 1):
 * interface/config-stub only in M1. `capabilities()` declares `token.holders` (the one capability
 * no other of the nine adapters covers) so `providers.config.ts`'s route/registration for it has
 * a real, registered `ProviderAdapter` to resolve to a definite, explicit unavailability reason —
 * rather than the generic "no adapter registered for this id" `CapabilityRegistry` would otherwise
 * report. The HTTP step and normalization are NOT implemented (no live query authoring, no
 * fixture, no contract test beyond registration/availability — that lands in M2 alongside
 * `onchain_token_risk`, this capability's first real tool consumer). None of the four M1 Must
 * tools depends on `token.holders`, so an empty `.env` stays fully functional regardless of this
 * adapter's state (UC-1).
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
    // No `chains` literal — `chainSupport` owns that answer, and it serves none (M-7/L-10).
    capabilities: () => [{ id: 'token.holders' }],
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
