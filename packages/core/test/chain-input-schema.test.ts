import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import {
  ChainInputSchema,
  canonicalizeChain,
  createChainInputSchema,
} from '../src/chain/input-schema.js';
import { loadChainRegistry } from '../src/chain/registry.js';

/** Task 006-6 — the tool-boundary schema (R-50/R-59). */
describe('ChainInputSchema', () => {
  it('accepts every spelling the registry knows', () => {
    for (const spelling of ['ethereum', 'eth', 'eip155:1', 'Ethereum', 'berachain', 'base']) {
      expect(ChainInputSchema.safeParse(spelling).success, spelling).toBe(true);
    }
  });

  it('canonicalizeChain collapses every spelling to the SAME slug', () => {
    // This is the property that keeps one logical request from becoming two cache entries —
    // and, on a paid route, two charges (data-model.md §4.2.2).
    expect(canonicalizeChain('ethereum')).toBe('ethereum');
    expect(canonicalizeChain('eth')).toBe('ethereum');
    expect(canonicalizeChain('eip155:1')).toBe('ethereum');
    expect(canonicalizeChain('Ethereum')).toBe('ethereum');
  });

  it('keeps the legacy names working (R-59a — aliases, not a transition period)', () => {
    expect(canonicalizeChain('ethereum')).toBe('ethereum');
    expect(canonicalizeChain('solana')).toBe('solana');
  });

  it('stays representable as JSON Schema — the MCP SDK renders it for tools/list', () => {
    // A `.transform()` here answered tools/list with "-32603 Transforms cannot be represented in
    // JSON Schema", i.e. it broke tool DISCOVERY for the whole server. Guard the property directly.
    expect(() => z.toJSONSchema(z.object({ chain: ChainInputSchema }))).not.toThrow();
  });

  it('rejects an unknown chain with a did-you-mean list and no network call', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('network call during chain validation');
    });
    try {
      const parsed = ChainInputSchema.safeParse('beara');
      expect(parsed.success).toBe(false);
      const message = parsed.success ? '' : parsed.error.issues[0]!.message;
      expect(message).toContain("unknown chain 'beara'");
      expect(message).toContain('Did you mean');
      expect(message).toContain('onchain_list_chains');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('is injectable for tests (a synthetic registry, not the shipped snapshot)', () => {
    const schema = createChainInputSchema({
      chains: loadChainRegistry({
        data: {
          syncedAt: 1,
          chains: [
            {
              caip2: 'eip155:99',
              slug: 'only-chain',
              name: 'Only',
              family: 'evm',
              aliases: ['oc'],
              nativeSymbol: null,
              vendors: {},
              rpcHosts: null,
              tvlUsdAtSync: null,
              deprecated: false,
            },
          ],
        },
      }),
    });
    expect(schema.safeParse('oc').success).toBe(true);
    expect(schema.safeParse('ethereum').success).toBe(false);
  });

  it('bounds the input length before doing any registry work', () => {
    expect(ChainInputSchema.safeParse('x'.repeat(65)).success).toBe(false);
    expect(ChainInputSchema.safeParse('').success).toBe(false);
  });
});
