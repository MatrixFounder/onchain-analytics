import { describe, expect, it, vi } from 'vitest';
import type { CacheGetResult, CacheStore } from '../src/adapters/cache-store.js';
import { PassthroughCacheStore } from '../src/adapters/cache-store.js';
import { CapabilityRegistry, CapabilityUnavailableError } from '../src/adapters/registry.js';
import type { CapabilityRoute, ProviderAdapter } from '../src/adapters/types.js';
import { deriveArgsHash } from '../src/net/args-hash.js';
import type { Chain } from '../src/types/chain.js';

interface MockAdapterOpts {
  id: string;
  isAvailable?: () => { ok: true } | { ok: false; reason: string };
  fetchImpl?: (cap: string, args: Record<string, unknown>) => Promise<unknown>;
  normalizeImpl?: (cap: string, raw: unknown) => unknown;
}

function makeAdapter(opts: MockAdapterOpts): ProviderAdapter & {
  fetch: ReturnType<typeof vi.fn>;
  normalize: ReturnType<typeof vi.fn>;
} {
  const fetchImpl = opts.fetchImpl ?? (async () => ({ raw: true, from: opts.id }));
  const normalizeImpl =
    opts.normalizeImpl ?? ((_cap: string, raw: unknown) => ({ normalized: raw }));

  const adapter: ProviderAdapter & {
    fetch: ReturnType<typeof vi.fn>;
    normalize: ReturnType<typeof vi.fn>;
  } = {
    id: opts.id,
    capabilities: () => [],
    costOf: () => ({ credits: 0 }),
    fetch: vi.fn(fetchImpl),
    normalize: vi.fn(normalizeImpl),
    ...(opts.isAvailable ? { isAvailable: opts.isAvailable } : {}),
  };
  return adapter;
}

class FakeCacheStore implements CacheStore {
  public readonly setCalls: Array<{
    provider: string;
    capability: string;
    argsHash: string;
    value: unknown;
  }> = [];

  constructor(private readonly hits: Map<string, CacheGetResult> = new Map()) {}

  static key(provider: string, capability: string, argsHash: string): string {
    return `${provider}::${capability}::${argsHash}`;
  }

  async get(
    provider: string,
    capability: string,
    argsHash: string,
  ): Promise<CacheGetResult | undefined> {
    return this.hits.get(FakeCacheStore.key(provider, capability, argsHash));
  }

  async set(provider: string, capability: string, argsHash: string, value: unknown): Promise<void> {
    this.setCalls.push({ provider, capability, argsHash, value });
  }
}

const CHAIN: Chain = 'ethereum';

describe('CapabilityRegistry.resolve [Phase 2]', () => {
  it('routes to the (only) adapter declared for the capability+chain and returns the normalized result, not the raw one', async () => {
    const raw = { price: 123 };
    const adapter = makeAdapter({
      id: 'coingecko',
      fetchImpl: async () => raw,
      normalizeImpl: (_cap, r) => ({ priceUsd: (r as typeof raw).price }),
    });
    const routes: CapabilityRoute[] = [
      { capability: 'token.price', chains: ['ethereum', 'solana'], adapterIds: ['coingecko'] },
    ];
    const registry = new CapabilityRegistry(routes, new Map([['coingecko', adapter]]));

    const resolution = await registry.resolve('token.price', CHAIN, { address: '0xabc' });

    expect(resolution).toEqual({ result: { priceUsd: 123 }, source: 'coingecko', cache: 'miss' });
    expect(resolution.result).not.toBe(raw);
    expect(adapter.fetch).toHaveBeenCalledWith('token.price', { address: '0xabc' });
  });

  it('selects the route whose chains list matches the requested chain, not a same-capability route for a different chain', async () => {
    const evm = makeAdapter({ id: 'rpc-evm' });
    const solana = makeAdapter({ id: 'rpc-solana' });
    const routes: CapabilityRoute[] = [
      { capability: 'wallet.balances.native', chains: ['ethereum'], adapterIds: ['rpc-evm'] },
      { capability: 'wallet.balances.native', chains: ['solana'], adapterIds: ['rpc-solana'] },
    ];
    const registry = new CapabilityRegistry(
      routes,
      new Map([
        ['rpc-evm', evm],
        ['rpc-solana', solana],
      ]),
    );

    const ethResult = await registry.resolve('wallet.balances.native', 'ethereum', {});
    expect(ethResult.source).toBe('rpc-evm');
    expect(evm.fetch).toHaveBeenCalledTimes(1);
    expect(solana.fetch).not.toHaveBeenCalled();

    const solResult = await registry.resolve('wallet.balances.native', 'solana', {});
    expect(solResult.source).toBe('rpc-solana');
    expect(solana.fetch).toHaveBeenCalledTimes(1);
    expect(evm.fetch).toHaveBeenCalledTimes(1);
  });

  it('skips an adapter whose isAvailable() reports {ok:false} and falls through to the next adapterId (dash-platform -> platform-explorer shape)', async () => {
    const primary = makeAdapter({
      id: 'dash-platform',
      isAvailable: () => ({ ok: false, reason: 'dash-platform live transport deferred' }),
    });
    const fallback = makeAdapter({ id: 'platform-explorer' });
    const routes: CapabilityRoute[] = [
      {
        capability: 'privacy.shielded_pool',
        chains: ['dash'],
        adapterIds: ['dash-platform', 'platform-explorer'],
      },
    ];
    const registry = new CapabilityRegistry(
      routes,
      new Map([
        ['dash-platform', primary],
        ['platform-explorer', fallback],
      ]),
    );

    const resolution = await registry.resolve('privacy.shielded_pool', 'dash', {});

    expect(resolution.source).toBe('platform-explorer');
    expect(primary.fetch).not.toHaveBeenCalled();
    expect(fallback.fetch).toHaveBeenCalledTimes(1);
  });

  it('skips an adapter whose fetch() throws and moves on to the next adapterId', async () => {
    const broken = makeAdapter({
      id: 'flaky',
      fetchImpl: async () => {
        throw new Error('upstream 500');
      },
    });
    const healthy = makeAdapter({ id: 'backup' });
    const routes: CapabilityRoute[] = [
      { capability: 'token.price', adapterIds: ['flaky', 'backup'] },
    ];
    const registry = new CapabilityRegistry(
      routes,
      new Map([
        ['flaky', broken],
        ['backup', healthy],
      ]),
    );

    const resolution = await registry.resolve('token.price', CHAIN, {});

    expect(resolution.source).toBe('backup');
    expect(healthy.fetch).toHaveBeenCalledTimes(1);
  });

  it('skips an adapter whose normalize() throws and moves on to the next adapterId', async () => {
    const badNormalize = makeAdapter({
      id: 'bad-normalize',
      normalizeImpl: () => {
        throw new Error('unexpected shape');
      },
    });
    const healthy = makeAdapter({ id: 'backup' });
    const routes: CapabilityRoute[] = [
      { capability: 'token.price', adapterIds: ['bad-normalize', 'backup'] },
    ];
    const registry = new CapabilityRegistry(
      routes,
      new Map([
        ['bad-normalize', badNormalize],
        ['backup', healthy],
      ]),
    );

    const resolution = await registry.resolve('token.price', CHAIN, {});

    expect(resolution.source).toBe('backup');
  });

  it('treats an adapterId with no matching Map entry as unavailable and skips to the next one', async () => {
    const healthy = makeAdapter({ id: 'backup' });
    const routes: CapabilityRoute[] = [
      { capability: 'token.holders', adapterIds: ['dune', 'backup'] },
    ];
    const registry = new CapabilityRegistry(routes, new Map([['backup', healthy]]));

    const resolution = await registry.resolve('token.holders', CHAIN, {});

    expect(resolution.source).toBe('backup');
  });

  it('returns a cache hit without calling fetch/normalize at all, forwarding the stored ageMs', async () => {
    const adapter = makeAdapter({ id: 'coingecko' });
    const routes: CapabilityRoute[] = [{ capability: 'token.price', adapterIds: ['coingecko'] }];
    const cachedValue = { priceUsd: 42 };
    const args = { address: '0xabc' };
    // Real key depends on deriveArgsHash(capability, args) — recompute it exactly as resolve() will,
    // so the fake cache is pre-populated under the same key resolve() looks up.
    const argsHash = deriveArgsHash('token.price', args);
    const cache = new FakeCacheStore(
      new Map([
        [
          FakeCacheStore.key('coingecko', 'token.price', argsHash),
          { value: cachedValue, ageMs: 1234 },
        ],
      ]),
    );

    const registry = new CapabilityRegistry(routes, new Map([['coingecko', adapter]]), cache);
    const resolution = await registry.resolve('token.price', CHAIN, args);

    expect(resolution).toEqual({
      result: cachedValue,
      source: 'coingecko',
      cache: 'hit',
      ageMs: 1234,
    });
    expect(adapter.fetch).not.toHaveBeenCalled();
    expect(adapter.normalize).not.toHaveBeenCalled();
  });

  it('writes to the cache on a miss via cache.set(provider, capability, argsHash, normalizedResult)', async () => {
    const adapter = makeAdapter({ id: 'coingecko', normalizeImpl: () => ({ priceUsd: 7 }) });
    const routes: CapabilityRoute[] = [{ capability: 'token.price', adapterIds: ['coingecko'] }];
    const cache = new FakeCacheStore();
    const registry = new CapabilityRegistry(routes, new Map([['coingecko', adapter]]), cache);

    await registry.resolve('token.price', CHAIN, { address: '0xabc' });

    expect(cache.setCalls).toHaveLength(1);
    expect(cache.setCalls[0]).toMatchObject({
      provider: 'coingecko',
      capability: 'token.price',
      value: { priceUsd: 7 },
    });
  });

  it('defaults to a PassthroughCacheStore (always miss) when no cache is injected', async () => {
    const adapter = makeAdapter({ id: 'coingecko' });
    const routes: CapabilityRoute[] = [{ capability: 'token.price', adapterIds: ['coingecko'] }];
    const registry = new CapabilityRegistry(routes, new Map([['coingecko', adapter]]));

    const resolution = await registry.resolve('token.price', CHAIN, {});

    expect(resolution.cache).toBe('miss');
    expect(adapter.fetch).toHaveBeenCalledTimes(1);
  });

  it('is exercised identically via an explicit new PassthroughCacheStore()', async () => {
    const adapter = makeAdapter({ id: 'coingecko' });
    const routes: CapabilityRoute[] = [{ capability: 'token.price', adapterIds: ['coingecko'] }];
    const registry = new CapabilityRegistry(
      routes,
      new Map([['coingecko', adapter]]),
      new PassthroughCacheStore(),
    );

    const resolution = await registry.resolve('token.price', CHAIN, {});

    expect(resolution.cache).toBe('miss');
  });

  it('throws CapabilityUnavailableError listing every tried adapter when all are unavailable/failed', async () => {
    const unavailable = makeAdapter({
      id: 'dash-platform',
      isAvailable: () => ({ ok: false, reason: 'deferred' }),
    });
    const broken = makeAdapter({
      id: 'platform-explorer',
      fetchImpl: async () => {
        throw new Error('network down');
      },
    });
    const routes: CapabilityRoute[] = [
      {
        capability: 'privacy.shielded_pool',
        chains: ['dash'],
        adapterIds: ['dash-platform', 'platform-explorer'],
      },
    ];
    const registry = new CapabilityRegistry(
      routes,
      new Map([
        ['dash-platform', unavailable],
        ['platform-explorer', broken],
      ]),
    );

    const promise = registry.resolve('privacy.shielded_pool', 'dash', {});

    await expect(promise).rejects.toBeInstanceOf(CapabilityUnavailableError);
    await expect(promise).rejects.toMatchObject({
      capability: 'privacy.shielded_pool',
      chain: 'dash',
      tried: [
        { adapterId: 'dash-platform', reason: 'deferred' },
        { adapterId: 'platform-explorer', reason: 'network down' },
      ],
    });
  });

  it('throws CapabilityUnavailableError with an empty tried list when no route matches the capability/chain at all', async () => {
    const registry = new CapabilityRegistry([], new Map());

    const promise = registry.resolve('token.price', CHAIN, {});

    await expect(promise).rejects.toBeInstanceOf(CapabilityUnavailableError);
    await expect(promise).rejects.toMatchObject({ tried: [] });
  });

  it('treats an adapter with no isAvailable() method as always available', async () => {
    const adapter = makeAdapter({ id: 'dexscreener' });
    expect(adapter.isAvailable).toBeUndefined();
    const routes: CapabilityRoute[] = [{ capability: 'pairs.new', adapterIds: ['dexscreener'] }];
    const registry = new CapabilityRegistry(routes, new Map([['dexscreener', adapter]]));

    const resolution = await registry.resolve('pairs.new', CHAIN, {});

    expect(resolution.source).toBe('dexscreener');
  });
});
