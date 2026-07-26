import { describe, expect, it, vi } from 'vitest';
import { buildChainRegistry } from '../src/chain/registry-core.js';
import { loadChainRegistry } from '../src/chain/registry.js';
import { ChainRegistryLoadError } from '../src/chain/errors.js';

/**
 * Task 006-10 (R-60c/d) — the registry must fail LOUDLY at load, never degrade.
 *
 * The failure mode this guards against is specific and nasty: an empty registry would turn every
 * request into "unknown chain" while the process still looked perfectly healthy — a total outage
 * wearing the costume of normal operation. Every case below asserts a throw, and the throw has to
 * happen at LOAD, not at the first request hours later.
 */
describe('chain registry refuses to load rather than degrade (R-60d)', () => {
  it.each([
    ['null document', null],
    ['undefined document', undefined],
    ['a string', 'not a registry'],
    ['an array', []],
    ['an empty object', {}],
    ['no chains key', { syncedAt: 1 }],
    ['an EMPTY chains array', { syncedAt: 1, chains: [] }],
    ['a negative syncedAt', { syncedAt: -1, chains: [] }],
    ['an unknown top-level key', { syncedAt: 1, chains: [], stray: true }],
  ])('throws on %s', (_label, data) => {
    expect(() => buildChainRegistry(data)).toThrow(ChainRegistryLoadError);
  });

  it('throws on a malformed JSON document the way a corrupted file would arrive', () => {
    let parsed: unknown;
    try {
      parsed = JSON.parse('{ "syncedAt": 1, "chains": [ ');
    } catch {
      parsed = undefined; // a corrupted file never even reaches the loader as an object
    }
    expect(() => buildChainRegistry(parsed)).toThrow(ChainRegistryLoadError);
  });

  const row = (over: Record<string, unknown>) => ({
    caip2: 'eip155:1',
    slug: 'a',
    name: 'A',
    family: 'evm',
    aliases: [],
    nativeSymbol: null,
    vendors: {},
    rpcHosts: null,
    tvlUsdAtSync: null,
    deprecated: false,
    ...over,
  });

  it.each([
    ['duplicate caip2', [row({}), row({ slug: 'b' })]],
    ['duplicate slug', [row({}), row({ caip2: 'eip155:2' })]],
    [
      'an alias colliding with another chain’s slug',
      [row({}), row({ caip2: 'eip155:2', slug: 'b', aliases: ['a'] })],
    ],
    [
      'an alias claimed by two chains',
      [row({ aliases: ['x'] }), row({ caip2: 'eip155:2', slug: 'b', aliases: ['x'] })],
    ],
    ['a malformed caip2', [row({ caip2: 'ethereum' })]],
    ['an unknown family', [row({ family: 'quantum' })]],
    ['an empty slug', [row({ slug: '' })]],
    ['an unknown key inside a row', [row({ typo: 1 })]],
  ])('throws on %s', (_label, chains) => {
    expect(() => buildChainRegistry({ syncedAt: 1, chains })).toThrow(ChainRegistryLoadError);
  });

  it('never yields a usable-but-empty registry on ANY failure path', () => {
    // The dangerous outcome is not "it threw" but "an object came back that can still answer" —
    // a size-0 registry would reply "unknown chain" to everything while looking perfectly healthy.
    const built = (data: unknown): { size: () => number } | null => {
      try {
        return buildChainRegistry(data);
      } catch {
        return null;
      }
    };

    for (const bad of [null, {}, { syncedAt: 1, chains: [] }, 'x']) {
      expect(built(bad), JSON.stringify(bad)).toBeNull();
    }
  });
});

describe('the shipped registry loads offline (R-60a/b)', () => {
  it('loads with the network booby-trapped', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('network call while loading the chain registry');
    });
    try {
      const registry = loadChainRegistry();
      expect(registry.size()).toBeGreaterThan(100);
      expect(registry.resolve('ethereum').caip2).toBe('eip155:1');
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it('satisfies its own invariants — the shipped data is not exempt from validation', () => {
    const registry = loadChainRegistry();
    const slugs = new Set<string>();
    const ids = new Set<string>();
    const aliases = new Map<string, string>();

    for (const chain of registry.list({ includeDeprecated: true })) {
      expect(ids.has(chain.caip2), chain.caip2).toBe(false);
      expect(slugs.has(chain.slug), chain.slug).toBe(false);
      ids.add(chain.caip2);
      slugs.add(chain.slug);
      for (const alias of chain.aliases) {
        const owner = aliases.get(alias);
        expect(owner === undefined || owner === chain.caip2, `${alias} claimed twice`).toBe(true);
        aliases.set(alias, chain.caip2);
      }
    }
    for (const [alias, owner] of aliases) {
      const bySlug = registry.list({ includeDeprecated: true }).find((c) => c.slug === alias);
      expect(bySlug === undefined || bySlug.caip2 === owner, `${alias}`).toBe(true);
    }
  });
});
