import { describe, expect, it } from 'vitest';
import { createDuneAdapter, NotImplementedInM1Error } from '../src/index.js';

// dune is a registration/availability-only config-stub in M1 (R-8, amended scope, architecture
// review cycle 1) — no live call, no fixture, no golden/contract test beyond these checks.

describe('dune adapter (config-stub, R-8)', () => {
  const adapter = createDuneAdapter();

  // CHANGED EXPECTATION (vdd-multi cycle 6, M-7): `capabilities()` no longer re-declares a chain
  // set. `CapabilityDescriptor.chains` is a documented part of the public `ProviderAdapter`
  // contract, and an adapter that answers "which chains" twice will eventually answer it two
  // different ways — which is exactly what cycle 5's H-1 was. `chainSupport` owns the answer.
  it('capabilities() declares token.holders without re-declaring a chain set', () => {
    expect(adapter.capabilities()).toEqual([{ id: 'token.holders' }]);
  });

  it('chainSupport() serves NO chain while the capability is deferred to M2 (cycle 5, L-10)', () => {
    // The coverage matrix does not consult `isAvailable()`, so a `true` here would advertise
    // `token.holders` through `onchain_list_chains` for a capability nothing can serve.
    expect(adapter.chainSupport).toBeDefined();
  });

  it('costOf() is free (0 credits)', () => {
    expect(adapter.costOf('token.holders', {})).toEqual({ credits: 0 });
  });

  it('isAvailable() is UNCONDITIONALLY false, independent of DUNE_API_KEY', () => {
    expect(adapter.isAvailable?.()).toEqual({
      ok: false,
      reason: 'dune query authoring deferred to M2',
    });
  });

  it('fetch()/normalize() (the HTTP step / normalization) are unreachable stubs that throw', async () => {
    await expect(adapter.fetch('token.holders', {})).rejects.toBeInstanceOf(
      NotImplementedInM1Error,
    );
    expect(() => adapter.normalize('token.holders', {})).toThrow(NotImplementedInM1Error);
  });
});
