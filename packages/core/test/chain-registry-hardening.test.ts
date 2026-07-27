import { describe, expect, it } from 'vitest';
import { buildChainRegistry } from '../src/chain/registry-core.js';
import { loadChainRegistry } from '../src/chain/registry.js';
import { ChainInputSchema, canonicalizeChain } from '../src/chain/input-schema.js';
import { ChainRegistryLoadError, UnknownChainError } from '../src/chain/errors.js';
import { normalizeAddress, isValidAddress } from '../src/chain/address.js';
import { createCoverage } from '../src/chain/coverage.js';
import type { ChainInfo } from '../src/chain/registry-core.js';
import type { ProviderAdapter } from '../src/adapters/types.js';

/**
 * vdd-multi cycle 5 — hardening of the chain registry and its input boundary.
 *
 * Every case below is a defect this cycle found and fixed, written so it fails again if the fix is
 * undone. Nothing here touches the network.
 */

function row(overrides: Partial<ChainInfo> & Pick<ChainInfo, 'caip2' | 'slug'>): ChainInfo {
  return {
    name: overrides.slug,
    family: 'evm',
    aliases: [],
    nativeSymbol: null,
    nativeDecimals: null,
    vendors: {},
    rpcHosts: null,
    tvlUsdAtSync: null,
    deprecated: false,
    ...overrides,
  };
}

const doc = (chains: ChainInfo[]): unknown => ({ syncedAt: 1, chains });

describe('H-2 — an over-long chain input costs O(1), not O(length × registry)', () => {
  // The measured baseline before the fix: 64 chars → 9.8 ms, 20 000 chars → 416 ms, linear.
  // `.max(64)` did NOT stop it: zod 4 raises `too_big` with `continue: true`, so `superRefine`
  // ran on a string of any length and walked ~1300 Levenshtein candidates.
  it('rejects a 100 000-character chain in under 50 ms', () => {
    const started = performance.now();
    const parsed = ChainInputSchema.safeParse('x'.repeat(100_000));
    const elapsed = performance.now() - started;

    expect(parsed.success).toBe(false);
    expect(elapsed).toBeLessThan(50);
  });

  it('is not merely fast because it is fast for everything — a near miss still suggests', () => {
    // Guards against "fixing" the timing by deleting the suggestion feature outright.
    const parsed = ChainInputSchema.safeParse('etherium');
    expect(parsed.success).toBe(false);
    const message = parsed.success ? '' : (parsed.error.issues[0]?.message ?? '');
    expect(message).toContain('Did you mean');
    expect(message).toContain('ethereum');
  });
});

describe('L-4 — an error message never echoes an unbounded input back to the model', () => {
  it('truncates the reflected chain and says how long it really was', () => {
    const error = new UnknownChainError('z'.repeat(5000), [], 458);
    expect(error.message.length).toBeLessThan(300);
    expect(error.message).toContain('5000 chars');
  });

  it('leaves a normal-length input intact', () => {
    expect(new UnknownChainError('beara', ['berachain'], 458).message).toContain("'beara'");
  });
});

describe('M-3 — an EMPTY rpcHosts list is a load failure, not "no hosts"', () => {
  it('refuses to load `rpcHosts: []`', () => {
    // `[]` passed `rpcHosts !== null`, so `rpc-evm` claimed coverage and then fell back to
    // ETHEREUM's endpoints — another chain's balance, cached and schema-valid.
    expect(() =>
      buildChainRegistry(doc([row({ caip2: 'eip155:1', slug: 'eth', rpcHosts: [] })])),
    ).toThrow(ChainRegistryLoadError);
  });

  it('still accepts `null` (honestly uncovered) and a non-empty list', () => {
    expect(() =>
      buildChainRegistry(
        doc([
          row({ caip2: 'eip155:1', slug: 'a', rpcHosts: null }),
          row({ caip2: 'eip155:2', slug: 'b', rpcHosts: ['https://rpc.example.com'] }),
        ]),
      ),
    ).not.toThrow();
  });
});

describe('L-8 — an alias may not collide with another chain’s CAIP-2 id', () => {
  it('rejects it at load, like the slug and alias collisions beside it', () => {
    // `tryResolve` checks `byCaip2` FIRST, so such an alias is dead on arrival: the caller
    // silently gets the other chain.
    expect(() =>
      buildChainRegistry(
        doc([
          row({ caip2: 'eip155:1', slug: 'one' }),
          row({ caip2: 'eip155:2', slug: 'two', aliases: ['eip155:1'] }),
        ]),
      ),
    ).toThrow(/collides with caip2/);
  });
});

describe('L-7 — list({query}) searches CAIP-2, which resolve() already accepts', () => {
  it('finds a chain by the id resolve() understands', () => {
    const registry = loadChainRegistry();
    const found = registry.list({ query: 'eip155:1' });
    expect(found.map((chain) => chain.slug)).toContain('ethereum');
  });
});

describe('suggestions never propose a deprecated chain', () => {
  it('omits a dead row even when it is the closest match', () => {
    const registry = buildChainRegistry(
      doc([
        row({ caip2: 'eip155:1', slug: 'alive' }),
        row({ caip2: 'eip155:2', slug: 'deadchain', deprecated: true }),
      ]),
    );
    const thrown = (() => {
      try {
        registry.resolve('deadchian'); // one transposition away from the deprecated slug
        return null;
      } catch (error) {
        return error as UnknownChainError;
      }
    })();
    expect(thrown).toBeInstanceOf(UnknownChainError);
    expect(thrown!.candidates).not.toContain('deadchain');
  });

  it('but a deprecated chain still RESOLVES by its exact name (ids stored elsewhere keep working)', () => {
    const registry = buildChainRegistry(
      doc([row({ caip2: 'eip155:2', slug: 'deadchain', deprecated: true })]),
    );
    expect(registry.resolve('deadchain').slug).toBe('deadchain');
  });
});

describe('H-4 — the shipped registry is built once, an injected one every time', () => {
  it('returns the identical instance for the shipped snapshot', () => {
    expect(loadChainRegistry()).toBe(loadChainRegistry());
  });

  it('never memoizes an injected document (two synthetic registries stay distinct)', () => {
    const first = loadChainRegistry({ data: doc([row({ caip2: 'eip155:1', slug: 'first' })]) });
    const second = loadChainRegistry({ data: doc([row({ caip2: 'eip155:2', slug: 'second' })]) });
    expect(first).not.toBe(second);
    expect(first.tryResolve('second')).toBeNull();
    expect(second.tryResolve('first')).toBeNull();
  });

  it('canonicalizes against the registry it is HANDED, not the shipped one', () => {
    // The correctness half of H-4: the handler canonicalized against the shipped snapshot while
    // the coverage gate resolved against `ctx.registry` — two dictionaries for one request.
    const synthetic = loadChainRegistry({
      data: doc([row({ caip2: 'eip155:99', slug: 'only-chain', aliases: ['oc'] })]),
    });
    expect(canonicalizeChain('oc', synthetic)).toBe('only-chain');
    expect(() => canonicalizeChain('ethereum', synthetic)).toThrow(UnknownChainError);
  });
});

describe('L-3 — an unresolvable chain is not silently treated as "no validator"', () => {
  it('normalizeAddress throws rather than feeding an uncanonicalized value to a cache key', () => {
    expect(() => normalizeAddress('no-such-chain-anywhere', '0xabc')).toThrow(/unknown chain/);
  });

  it('isValidAddress stays permissive, so the chain error is not double-reported as an address error', () => {
    expect(isValidAddress('no-such-chain-anywhere', 'anything')).toBe(true);
  });

  it('a real chain still gets its family’s canonicalization', () => {
    const lower = '0xd8da6bf26964af9d7eed9e03e53415d37aa96045';
    expect(normalizeAddress('berachain', lower)).not.toBe(lower); // EIP-55 applied
  });
});

describe('L-2 — a prototype key is not mistaken for a chain family', () => {
  it("resolves 'toString' as an unknown chain, never as a function", () => {
    expect(() => normalizeAddress('toString', '0xabc')).toThrow(/unknown chain/);
  });
});

describe('M-5 — a deprecated chain is uncovered in the GATE too, not only in the lists', () => {
  const adapters = new Map<string, ProviderAdapter>([
    [
      'stub',
      {
        id: 'stub',
        capabilities: () => [{ id: 'token.price' }],
        costOf: () => ({ credits: 0 }),
        fetch: async () => ({}),
        normalize: () => ({}),
      },
    ],
  ]);

  it('isCovered agrees with chainsFor / capabilitiesFor', () => {
    const chains = buildChainRegistry(
      doc([
        row({ caip2: 'eip155:1', slug: 'alive' }),
        row({ caip2: 'eip155:2', slug: 'dead', deprecated: true }),
      ]),
    );
    const coverage = createCoverage({
      routes: [{ capability: 'token.price', adapterIds: ['stub'] }],
      adapters,
      chains,
    });

    const dead = chains.resolve('dead');
    // Before the fix this was `true` — the chain passed the gate and reached a real fetch() while
    // being absent from every list a caller can read.
    expect(coverage.isCovered('token.price', dead)).toBe(false);
    expect(coverage.capabilitiesFor(dead)).toEqual([]);
    expect(coverage.chainsFor('token.price').map((chain) => chain.slug)).toEqual(['alive']);
  });
});
