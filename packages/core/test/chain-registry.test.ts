import { describe, expect, it, vi } from 'vitest';
import { loadChainRegistry, type ChainInfo } from '../src/chain/registry.js';
import { ChainRegistryLoadError, UnknownChainError } from '../src/chain/errors.js';

/**
 * Task 006-1 — Phase 2 `[LOGIC IMPLEMENTATION]`.
 *
 * Covers the Test Cases table of `docs/tasks/task-006-1-chain-registry-core.md`. The synthetic
 * documents below exist so that resolution/validation is asserted against a hand-readable set —
 * the shipped `registry.data.json` is exercised separately (last describe block) to prove the
 * committed data actually satisfies the same invariants.
 */

function chain(overrides: Partial<ChainInfo> & Pick<ChainInfo, 'caip2' | 'slug'>): ChainInfo {
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

function doc(chains: ChainInfo[], syncedAt = 1_785_110_400_000): unknown {
  return { syncedAt, chains };
}

const TWO_CHAINS = doc([
  chain({
    caip2: 'eip155:1',
    slug: 'ethereum',
    name: 'Ethereum',
    aliases: ['ethereum', 'eth', 'eip155:1'],
    nativeSymbol: 'ETH',
  }),
  chain({
    caip2: 'eip155:80094',
    slug: 'berachain',
    name: 'Berachain',
    aliases: ['bera'],
    nativeSymbol: 'BERA',
    tvlUsdAtSync: 50_579_539.42,
  }),
]);

describe('chain registry — resolution', () => {
  // Test Case 1
  it('resolves caip2, slug, alias and mixed case to the same canonical chain', () => {
    const reg = loadChainRegistry({ data: TWO_CHAINS });
    const expected = 'eip155:1';

    expect(reg.resolve('eip155:1').caip2).toBe(expected);
    expect(reg.resolve('ethereum').caip2).toBe(expected);
    expect(reg.resolve('eth').caip2).toBe(expected);
    expect(reg.resolve('Ethereum').caip2).toBe(expected);
    expect(reg.resolve('ETHEREUM').caip2).toBe(expected);
  });

  it('resolves a chain that never existed in the pre-TASK-006 enum', () => {
    const reg = loadChainRegistry({ data: TWO_CHAINS });
    expect(reg.resolve('berachain').caip2).toBe('eip155:80094');
    expect(reg.resolve('bera').caip2).toBe('eip155:80094');
  });

  // Test Case 2
  it('throws UnknownChainError with non-empty candidates on a near miss', () => {
    const reg = loadChainRegistry({ data: TWO_CHAINS });
    let thrown: unknown;
    try {
      reg.resolve('beara');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(UnknownChainError);
    const err = thrown as UnknownChainError;
    expect(err.candidates.length).toBeGreaterThan(0);
    // Assert the USEFUL property — every suggestion must actually resolve, and at least one must
    // lead to the chain the user was reaching for. Asserting the literal string 'berachain' would
    // encode the edit-distance cap into the test: 'beara'→'bera' is distance 1 while
    // 'beara'→'berachain' is 5, so the nearer alias is the better suggestion, and it resolves to
    // the very same chain.
    const reg2 = loadChainRegistry({ data: TWO_CHAINS });
    for (const candidate of err.candidates) expect(() => reg2.resolve(candidate)).not.toThrow();
    expect(err.candidates.map((c) => reg2.resolve(c).caip2)).toContain('eip155:80094');
    expect(err.message).toContain('Did you mean');
    expect(err.message).toContain('onchain_list_chains');
  });

  it('suggests nothing for input that resembles no chain, rather than guessing', () => {
    const reg = loadChainRegistry({ data: TWO_CHAINS });
    try {
      reg.resolve('zzzzzzzzzzzzzz');
      expect.unreachable('resolve must throw');
    } catch (error) {
      expect((error as UnknownChainError).candidates).toEqual([]);
      expect((error as UnknownChainError).message).not.toContain('Did you mean');
    }
  });

  // Test Case 3 — resolution is pure and offline.
  it('performs zero network calls while resolving (fetch is booby-trapped)', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('network call during chain resolution');
    });
    try {
      const reg = loadChainRegistry({ data: TWO_CHAINS });
      reg.resolve('ethereum');
      reg.tryResolve('nope');
      expect(() => reg.resolve('nope')).toThrow(UnknownChainError);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('tryResolve returns null instead of throwing, and rejects empty input', () => {
    const reg = loadChainRegistry({ data: TWO_CHAINS });
    expect(reg.tryResolve('nope')).toBeNull();
    expect(reg.tryResolve('')).toBeNull();
    expect(reg.tryResolve('ethereum')?.slug).toBe('ethereum');
  });

  it('refuses to guess when a fuzzy key is ambiguous between two chains', () => {
    // 'foo-bar' and 'foo.bar' normalize to the same key but belong to different chains: the
    // ambiguous key is dropped from the fuzzy index, so an exact match still works and the
    // ambiguous spelling fails loudly instead of silently picking one.
    const reg = loadChainRegistry({
      data: doc([
        chain({ caip2: 'eip155:10', slug: 'foo-bar' }),
        chain({ caip2: 'eip155:20', slug: 'foo.bar' }),
      ]),
    });
    expect(reg.resolve('foo-bar').caip2).toBe('eip155:10');
    expect(reg.resolve('foo.bar').caip2).toBe('eip155:20');
    expect(reg.tryResolve('FOOBAR')).toBeNull();
  });
});

describe('chain registry — load-time validation (R-60)', () => {
  // Test Case 4
  it('rejects a duplicate caip2', () => {
    expect(() =>
      loadChainRegistry({
        data: doc([
          chain({ caip2: 'eip155:1', slug: 'a' }),
          chain({ caip2: 'eip155:1', slug: 'b' }),
        ]),
      }),
    ).toThrow(ChainRegistryLoadError);
  });

  it('rejects a duplicate slug', () => {
    expect(() =>
      loadChainRegistry({
        data: doc([
          chain({ caip2: 'eip155:1', slug: 'a' }),
          chain({ caip2: 'eip155:2', slug: 'a' }),
        ]),
      }),
    ).toThrow(ChainRegistryLoadError);
  });

  // Test Case 5
  it("rejects an alias that collides with another chain's slug", () => {
    expect(() =>
      loadChainRegistry({
        data: doc([
          chain({ caip2: 'eip155:1', slug: 'ethereum' }),
          chain({ caip2: 'eip155:2', slug: 'other', aliases: ['ethereum'] }),
        ]),
      }),
    ).toThrow(/collides with slug/);
  });

  it('rejects an alias claimed by two different chains', () => {
    expect(() =>
      loadChainRegistry({
        data: doc([
          chain({ caip2: 'eip155:1', slug: 'a', aliases: ['shared'] }),
          chain({ caip2: 'eip155:2', slug: 'b', aliases: ['shared'] }),
        ]),
      }),
    ).toThrow(/claimed by both/);
  });

  it('allows a chain to alias its own slug and caip2', () => {
    expect(() =>
      loadChainRegistry({
        data: doc([
          chain({ caip2: 'eip155:1', slug: 'ethereum', aliases: ['ethereum', 'eip155:1'] }),
        ]),
      }),
    ).not.toThrow();
  });

  // Test Case 6
  it('rejects a malformed caip2', () => {
    expect(() =>
      loadChainRegistry({ data: doc([chain({ caip2: 'ethereum', slug: 'ethereum' })]) }),
    ).toThrow(ChainRegistryLoadError);
  });

  // Test Case 7 — the load path never degrades into a working-but-empty registry.
  it.each([
    ['null', null],
    ['undefined-ish object', {}],
    ['empty chains array', { syncedAt: 0, chains: [] }],
    ['unknown top-level key', { syncedAt: 0, chains: [], stray: 1 }],
    ['non-object', 'not a registry'],
  ])('refuses to load (%s) rather than yielding an empty registry', (_label, data) => {
    expect(() => loadChainRegistry({ data })).toThrow(ChainRegistryLoadError);
  });

  it('rejects an unknown key inside a chain row', () => {
    const bad = doc([chain({ caip2: 'eip155:1', slug: 'a' })]) as {
      chains: Array<Record<string, unknown>>;
    };
    bad.chains[0]!['typo'] = true;
    expect(() => loadChainRegistry({ data: bad })).toThrow(ChainRegistryLoadError);
  });
});

describe('chain registry — list and metadata', () => {
  it('filters by query across slug, name and aliases', () => {
    const reg = loadChainRegistry({ data: TWO_CHAINS });
    expect(reg.list({ query: 'bera' }).map((c) => c.slug)).toEqual(['berachain']);
    expect(reg.list({ query: 'Ethereum' }).map((c) => c.slug)).toEqual(['ethereum']);
    expect(reg.list({ query: 'eth' }).map((c) => c.slug)).toEqual(['ethereum']);
  });

  it('excludes deprecated chains unless explicitly included', () => {
    const data = doc([
      chain({ caip2: 'eip155:1', slug: 'live' }),
      chain({ caip2: 'eip155:2', slug: 'gone', deprecated: true }),
    ]);
    const reg = loadChainRegistry({ data });
    expect(reg.list().map((c) => c.slug)).toEqual(['live']);
    expect(reg.list({ includeDeprecated: true }).map((c) => c.slug)).toEqual(['live', 'gone']);
    // still resolvable — that is the whole point of keeping the row (R-49f)
    expect(reg.resolve('gone').deprecated).toBe(true);
  });

  it('filters by family', () => {
    const data = doc([
      chain({ caip2: 'eip155:1', slug: 'evm-one', family: 'evm' }),
      chain({ caip2: 'solana:abc', slug: 'svm-one', family: 'svm' }),
    ]);
    const reg = loadChainRegistry({ data });
    expect(reg.list({ family: 'svm' }).map((c) => c.slug)).toEqual(['svm-one']);
  });

  it('exposes size() and syncedAt() from the document', () => {
    const reg = loadChainRegistry({ data: TWO_CHAINS });
    expect(reg.size()).toBe(2);
    expect(reg.syncedAt()).toBe(1_785_110_400_000);
  });

  it('get() addresses chains by canonical id only, never by alias', () => {
    const reg = loadChainRegistry({ data: TWO_CHAINS });
    expect(reg.get('eip155:1')?.slug).toBe('ethereum');
    expect(reg.get('ethereum')).toBeNull();
  });
});

// Test Case 8 — the DI seam works, and the SHIPPED data satisfies every invariant above.
describe('chain registry — shipped snapshot', () => {
  it('loads the committed registry.data.json and resolves the legacy names', () => {
    const reg = loadChainRegistry();
    expect(reg.size()).toBeGreaterThanOrEqual(3);
    expect(reg.resolve('ethereum').caip2).toBe('eip155:1');
    expect(reg.resolve('solana').family).toBe('svm');
    expect(reg.resolve('dash').family).toBe('other');
  });

  it('keeps legacy chain names as aliases, not merely as slugs (R-59a)', () => {
    const eth = loadChainRegistry().resolve('ethereum');
    expect(eth.aliases).toContain('ethereum');
  });

  it('ships rpcHosts only over https, and only where curated (security.md §7.2.1)', () => {
    for (const c of loadChainRegistry().list({ includeDeprecated: true })) {
      if (c.rpcHosts === null) continue;
      for (const host of c.rpcHosts) expect(host.startsWith('https://')).toBe(true);
    }
  });
});
