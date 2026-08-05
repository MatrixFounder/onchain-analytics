import { describe, expect, it } from 'vitest';
import { CapabilityRegistry } from '@onchain-intel/core';
import type { CapabilityRoute, ProviderAdapter } from '@onchain-intel/core';
import { ProtocolTvlInputSchema, protocolTvlHandler } from '../../src/tools/protocol-tvl.js';

/**
 * Unit tests for `src/tools/protocol-tvl.ts` (task 003-7, R-19) — see `get-token.test.ts`'s
 * docstring for the shared testing convention.
 */

const ROUTES: CapabilityRoute[] = [{ capability: 'protocol.tvl', adapterIds: ['defillama'] }];

const FAKE_TVL = {
  protocol: 'Uniswap',
  chain: 'ethereum' as const,
  tvlUsd: 1_000_000,
  totalTvlUsd: 5_000_000,
  source: 'defillama',
  fetchedAt: 1_800_000_000_000,
};

function fakeDefillamaAdapter(): ProviderAdapter {
  return {
    id: 'defillama',
    capabilities: () => [{ id: 'protocol.tvl', chains: ['ethereum', 'solana'] }],
    costOf: () => ({ credits: 0 }),
    fetch: async () => ({}),
    normalize: () => FAKE_TVL,
    isAvailable: () => ({ ok: true }),
  };
}

describe('ProtocolTvlInputSchema', () => {
  it('accepts a valid chain + protocolSlug', () => {
    expect(() =>
      ProtocolTvlInputSchema.parse({ chain: 'ethereum', protocolSlug: 'uniswap' }),
    ).not.toThrow();
  });

  // CHANGED EXPECTATION (task 006-6, R-50). The schema used to reject anything outside a
  // two-value enum. It now accepts any chain the REGISTRY knows and rejects only what the registry
  // does not — because refusing at the schema is the wrong layer for "this capability is not
  // served there": that answer belongs to the coverage matrix, which can say WHERE it IS served
  // (§4.2.3). A schema-level refusal could only say "no".
  it('accepts any registry chain and rejects an unknown one (R-50c)', () => {
    expect(() =>
      ProtocolTvlInputSchema.parse({ chain: 'ethereum', protocolSlug: 'uniswap' }),
    ).not.toThrow();
    const unknown = ProtocolTvlInputSchema.safeParse({
      chain: 'not-a-real-chain',
      protocolSlug: 'uniswap',
    });
    expect(unknown.success).toBe(false);
    if (!unknown.success) {
      expect(unknown.error.issues.some((i) => i.message.includes('unknown chain'))).toBe(true);
    }
  });

  it('rejects an empty protocolSlug', () => {
    expect(() => ProtocolTvlInputSchema.parse({ chain: 'ethereum', protocolSlug: '' })).toThrow();
  });

  it('rejects an unexpected extra key (.strict())', () => {
    expect(() =>
      ProtocolTvlInputSchema.parse({ chain: 'ethereum', protocolSlug: 'uniswap', unexpected: 'x' }),
    ).toThrow();
  });

  it('rejects a pathologically long protocolSlug FAST (post-M1 polish, fix 2 — bounded .max(128))', () => {
    const hugeSlug = 'x'.repeat(10_000);
    const start = performance.now();
    const result = ProtocolTvlInputSchema.safeParse({ chain: 'ethereum', protocolSlug: hugeSlug });
    const elapsedMs = performance.now() - start;

    expect(result.success).toBe(false);
    expect(elapsedMs).toBeLessThan(100);
  });
});

describe('protocolTvlHandler', () => {
  it('resolves via the registry and returns the ProtocolTvlResult shape + cache meta on success', async () => {
    const registry = new CapabilityRegistry(
      ROUTES,
      new Map([['defillama', fakeDefillamaAdapter()]]),
    );
    const outcome = await protocolTvlHandler(
      { chain: 'ethereum', protocolSlug: 'uniswap' },
      { registry },
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('expected ok:true');
    expect(outcome.output).toStrictEqual(FAKE_TVL);
    expect(outcome.cache).toStrictEqual({
      status: 'miss',
      provider: 'defillama',
      capability: 'protocol.tvl',
    });
  });

  it('returns {ok:false, reason} (never throws) when no adapter is registered for the capability', async () => {
    const registry = new CapabilityRegistry(ROUTES, new Map());
    const outcome = await protocolTvlHandler(
      { chain: 'ethereum', protocolSlug: 'uniswap' },
      { registry },
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('expected ok:false');
    expect(outcome.reason).toContain('protocol.tvl');
  });

  it('returns {ok:false, reason} (never throws) when the adapter returns data violating the output contract (adversarial cycle 2, finding 1a)', async () => {
    function fakeAdapterWithNegativeTvl(): ProviderAdapter {
      return {
        id: 'defillama',
        capabilities: () => [{ id: 'protocol.tvl', chains: ['ethereum', 'solana'] }],
        costOf: () => ({ credits: 0 }),
        fetch: async () => ({}),
        normalize: () => ({ ...FAKE_TVL, tvlUsd: -1 }),
        isAvailable: () => ({ ok: true }),
      };
    }
    const registry = new CapabilityRegistry(
      ROUTES,
      new Map([['defillama', fakeAdapterWithNegativeTvl()]]),
    );

    const outcome = await protocolTvlHandler(
      { chain: 'ethereum', protocolSlug: 'uniswap' },
      { registry },
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('expected ok:false');
    expect(outcome.reason).toContain('provider returned data violating the tool contract');
    expect(outcome.reason).toContain('tvlUsd');
    // Never a raw, multi-issue zod-error dump.
    expect(outcome.reason).not.toContain('ZodError');
  });
});
