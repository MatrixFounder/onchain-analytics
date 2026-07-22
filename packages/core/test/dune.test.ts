import { describe, expect, it } from 'vitest';
import { createDuneAdapter, NotImplementedInM1Error } from '../src/index.js';

// dune is a registration/availability-only config-stub in M1 (R-8, amended scope, architecture
// review cycle 1) — no live call, no fixture, no golden/contract test beyond these checks.

describe('dune adapter (config-stub, R-8)', () => {
  const adapter = createDuneAdapter();

  it('capabilities() declares token.holders on ethereum', () => {
    expect(adapter.capabilities()).toEqual([{ id: 'token.holders', chains: ['ethereum'] }]);
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
