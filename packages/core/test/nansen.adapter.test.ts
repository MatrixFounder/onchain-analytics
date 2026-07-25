import { describe, expect, it } from 'vitest';
import { CapabilityRegistry, CapabilityUnavailableError } from '../src/adapters/registry.js';
import { createNansenAdapter, routes } from '../src/index.js';
import type { Chain } from '../src/types/chain.js';

// nansen is a registration/skeleton-only adapter in task 005-1 (R-29/R-30): capabilities() and
// isAvailable() are real, costOf()/fetch()/normalize() are fail-closed stubs replaced by the live
// HTTP step + real cost table in tasks 005-4/005-5. NO NANSEN_API_KEY in this test's process env
// — every `createNansenAdapter()` call below is given an explicit, empty `env` (or one with a
// fake key), never falling back to ambient `process.env`.

describe('nansen adapter (config-stub skeleton, R-30)', () => {
  it('capabilities() declares the three M2 capabilities on ethereum+solana', () => {
    const adapter = createNansenAdapter({ env: {} });
    expect(adapter.capabilities()).toEqual([
      { id: 'smart-money.flows', chains: ['ethereum', 'solana'] },
      { id: 'entity.labels', chains: ['ethereum', 'solana'] },
      { id: 'token.risk', chains: ['ethereum', 'solana'] },
    ]);
  });

  // costOf() became real in task 005-3 (table-driven, cost-of.ts — full coverage lives in
  // test/nansen.cost-of.test.ts); this smoke-level assertion just proves the adapter wires its
  // own accountState through to the real function instead of the 005-1 Infinity stub. An
  // UNRECOGNIZED capability still fails closed to Infinity, never 0 (R-37 MIN-3).
  it("costOf() delegates to the real cost table (005-3) — a live default-plan 'free' price per capability", () => {
    const adapter = createNansenAdapter({ env: {} });
    expect(adapter.costOf('smart-money.flows', {})).toEqual({ credits: 10 });
    expect(adapter.costOf('entity.labels', {})).toEqual({ credits: 0 });
    expect(adapter.costOf('token.risk', {})).toEqual({ credits: 6 });
  });

  it('costOf() is still fail-closed (Number.POSITIVE_INFINITY, NEVER 0) for an unrecognized capability', () => {
    const adapter = createNansenAdapter({ env: {} });
    expect(adapter.costOf('not-a-real-capability', {})).toEqual({
      credits: Number.POSITIVE_INFINITY,
    });
  });

  // Task 005-4 replaced fetch()/normalize()'s "not implemented" stubs with the real HTTP step +
  // normalization (see test/nansen.contract.test.ts for full golden/HTTP-contract coverage) — this
  // smoke-level case just re-confirms neither method silently resolves on bad input, matching the
  // spirit of the old 005-1-era assertion without asserting on the now-removed stub message
  // (a direct, necessary consequence of this task's own scope, same precedent as task 005-3's own
  // edit to this file — see packages/core/.AGENTS.md's task 005-4 section).
  it('fetch() without NANSEN_API_KEY throws a clear error, never silently resolves (defensive re-check)', async () => {
    const adapter = createNansenAdapter({ env: {} });
    await expect(adapter.fetch('smart-money.flows', {})).rejects.toThrow(/NANSEN_API_KEY/);
  });

  it('normalize() throws a clear normalization error on structurally invalid raw input, never crashes silently', () => {
    const adapter = createNansenAdapter({ env: {} });
    const malformedRaw = {
      chain: 'ethereum',
      tokenAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      netflow: { body: {}, creditsUsedHeader: null },
      holders: { body: {}, creditsUsedHeader: null },
    };
    expect(() => adapter.normalize('smart-money.flows', malformedRaw)).toThrow(
      /smart-money\/netflow response has no matching row/,
    );
  });

  describe('isAvailable() — real from this task', () => {
    it('reports {ok: false, reason naming NANSEN_API_KEY} when the key is absent, no value leaked', () => {
      const adapter = createNansenAdapter({ env: {} });
      expect(adapter.isAvailable?.()).toEqual({ ok: false, reason: 'needs NANSEN_API_KEY' });
    });

    it('reports {ok: true} when NANSEN_API_KEY is present', () => {
      const adapter = createNansenAdapter({ env: { NANSEN_API_KEY: 'test-key-not-real' } });
      expect(adapter.isAvailable?.()).toEqual({ ok: true });
    });

    it('reads env INSIDE the method itself, not captured once at factory-call time', () => {
      const env: NodeJS.ProcessEnv = {};
      const adapter = createNansenAdapter({ env });
      expect(adapter.isAvailable?.()).toEqual({ ok: false, reason: 'needs NANSEN_API_KEY' });
      env['NANSEN_API_KEY'] = 'set-after-construction';
      expect(adapter.isAvailable?.()).toEqual({ ok: true });
    });
  });

  describe('registry integration — the real providers.config.ts routes resolve to nansen (R-30)', () => {
    const CHAINS: Chain[] = ['ethereum', 'solana'];
    const CAPABILITIES = ['smart-money.flows', 'entity.labels', 'token.risk'];

    it.each(CAPABILITIES)(
      '%s resolves to nansen on every declared chain, recorded unavailable with no key in scope',
      async (capability) => {
        const registry = new CapabilityRegistry(
          routes,
          new Map([['nansen', createNansenAdapter({ env: {} })]]),
        );
        for (const chain of CHAINS) {
          const promise = registry.resolve(capability, chain, {});
          await expect(promise).rejects.toBeInstanceOf(CapabilityUnavailableError);
          await expect(promise).rejects.toMatchObject({
            capability,
            chain,
            tried: [{ adapterId: 'nansen', reason: 'needs NANSEN_API_KEY' }],
          });
        }
      },
    );
  });
});
