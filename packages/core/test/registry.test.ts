import { describe, expect, it, vi } from 'vitest';
import type { CacheGetResult, CacheStore } from '../src/adapters/cache-store.js';
import { PassthroughCacheStore } from '../src/adapters/cache-store.js';
import {
  CapabilityRegistry,
  CapabilityUnavailableError,
  type CapabilityResolution,
} from '../src/adapters/registry.js';
import type { CapabilityRoute, ProviderAdapter } from '../src/adapters/types.js';
import { deriveArgsHash } from '../src/net/args-hash.js';
import type { Chain } from '../src/types/chain.js';
import type { ChainInfo } from '../src/chain/registry-core.js';

interface MockAdapterOpts {
  id: string;
  isAvailable?: () => { ok: true } | { ok: false; reason: string };
  fetchImpl?: (cap: string, args: Record<string, unknown>) => Promise<unknown>;
  normalizeImpl?: (cap: string, raw: unknown) => unknown;
  chainSupport?: (chain: ChainInfo, capability: string) => boolean;
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
    ...(opts.chainSupport ? { chainSupport: opts.chainSupport } : {}),
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
    const routes: CapabilityRoute[] = [{ capability: 'token.price', adapterIds: ['coingecko'] }];
    const registry = new CapabilityRegistry(routes, new Map([['coingecko', adapter]]));

    const resolution = await registry.resolve('token.price', CHAIN, { address: '0xabc' });

    // `attempted` (cycle 2, F-4) — the adapters the walk ENTERED, which is the fact a paid-route
    // budget reading needs and `source` cannot give once a route has more than one adapter.
    expect(resolution).toEqual({
      result: { priceUsd: 123 },
      source: 'coingecko',
      cache: 'miss',
      attempted: ['coingecko'],
    });
    expect(resolution.result).not.toBe(raw);
    // Task 012-8: the THIRD argument is the walk's `effectiveDeadlineAtMs` (ADR-002 D4). Matched as
    // `expect.any(Number)` rather than a value — `token.price`'s manifest budget is what fixes it,
    // and pinning the number here would make this case a second, silent owner of that row. Its own
    // value is asserted in `registry.deadline.test.ts` (TC-UNIT-01/02), where the manifest is
    // injected. THE ONLY EDIT task 012-8 made to a pre-existing test file, and it is mechanical:
    // `toHaveBeenCalledWith` matches the full argument list, so one more argument fails it.
    expect(adapter.fetch).toHaveBeenCalledWith(
      'token.price',
      { address: '0xabc' },
      expect.any(Number),
    );
  });

  it('selects the route whose chains list matches the requested chain, not a same-capability route for a different chain', async () => {
    const evm = makeAdapter({ id: 'rpc-evm', chainSupport: (chain) => chain.slug === 'ethereum' });
    const solana = makeAdapter({
      id: 'rpc-solana',
      chainSupport: (chain) => chain.slug === 'solana',
    });
    const routes: CapabilityRoute[] = [
      { capability: 'wallet.balances.native', adapterIds: ['rpc-evm'] },
      { capability: 'wallet.balances.native', adapterIds: ['rpc-solana'] },
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
    const routes: CapabilityRoute[] = [{ capability: 'pairs.active', adapterIds: ['dexscreener'] }];
    const registry = new CapabilityRegistry(routes, new Map([['dexscreener', adapter]]));

    const resolution = await registry.resolve('pairs.active', CHAIN, {});

    expect(resolution.source).toBe('dexscreener');
  });

  describe('cache-fault resilience (adversarial cycle 1, findings A1/A2)', () => {
    class ThrowingCacheStore implements CacheStore {
      constructor(
        private readonly failGet: boolean,
        private readonly failSet: boolean,
      ) {}

      async get(): Promise<CacheGetResult | undefined> {
        if (this.failGet) throw new Error('cache backend unreachable (get)');
        return undefined;
      }

      async set(): Promise<void> {
        if (this.failSet) throw new Error('cache backend unreachable (set)');
      }
    }

    it('a cache.set() failure never converts a successful fetch into CapabilityUnavailableError — the result is still returned as a miss (A1)', async () => {
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const adapter = makeAdapter({ id: 'coingecko', normalizeImpl: () => ({ priceUsd: 42 }) });
      const routes: CapabilityRoute[] = [{ capability: 'token.price', adapterIds: ['coingecko'] }];
      const cache = new ThrowingCacheStore(false, true);
      const registry = new CapabilityRegistry(routes, new Map([['coingecko', adapter]]), cache);

      const resolution = await registry.resolve('token.price', CHAIN, { address: '0xabc' });

      expect(resolution).toEqual({
        result: { priceUsd: 42 },
        source: 'coingecko',
        cache: 'miss',
        attempted: ['coingecko'],
      });
      expect(adapter.fetch).toHaveBeenCalledTimes(1);
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('cache.set failed'));
      stderrSpy.mockRestore();
    });

    it('a cache.get() failure is treated as a miss (logged, not fatal) and resolve() still fetches and returns (A2)', async () => {
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const adapter = makeAdapter({ id: 'coingecko', normalizeImpl: () => ({ priceUsd: 7 }) });
      const routes: CapabilityRoute[] = [{ capability: 'token.price', adapterIds: ['coingecko'] }];
      const cache = new ThrowingCacheStore(true, false);
      const registry = new CapabilityRegistry(routes, new Map([['coingecko', adapter]]), cache);

      const resolution = await registry.resolve('token.price', CHAIN, { address: '0xabc' });

      expect(resolution).toEqual({
        result: { priceUsd: 7 },
        source: 'coingecko',
        cache: 'miss',
        attempted: ['coingecko'],
      });
      expect(adapter.fetch).toHaveBeenCalledTimes(1);
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('cache.get failed'));
      stderrSpy.mockRestore();
    });
  });
});

/**
 * Issue L-1 — negative caching of DETERMINISTIC failures.
 *
 * `resolve()` caches only after `normalize()` returns, so every throw there discarded an
 * already-fetched (and, on a paid provider, already-PAID) response: nothing cached, the adapter
 * recorded as failed, the caller's retry paying full price to be rejected identically. On Nansen
 * that is 10cr per `smart-money.flows` attempt and 100cr for the exhaustive `entity.labels` tier.
 */
describe('CapabilityRegistry — negative caching (L-1)', () => {
  /** A cache that genuinely round-trips, unlike `FakeCacheStore` which only records writes. */
  class RoundTripCacheStore implements CacheStore {
    private readonly store = new Map<string, { value: unknown; writtenAtMs: number }>();
    public setCalls: Array<{ value: unknown; ttlSecondsOverride?: number }> = [];

    private static key(p: string, c: string, h: string): string {
      return `${p}::${c}::${h}`;
    }

    async get(p: string, c: string, h: string): Promise<CacheGetResult | undefined> {
      const hit = this.store.get(RoundTripCacheStore.key(p, c, h));
      return hit ? { value: hit.value, ageMs: Date.now() - hit.writtenAtMs } : undefined;
    }

    async set(
      p: string,
      c: string,
      h: string,
      value: unknown,
      ttlSecondsOverride?: number,
    ): Promise<void> {
      this.setCalls.push({
        value,
        ...(ttlSecondsOverride === undefined ? {} : { ttlSecondsOverride }),
      });
      this.store.set(RoundTripCacheStore.key(p, c, h), { value, writtenAtMs: Date.now() });
    }

    /** Overwrites the stored entry in place — used to plant an ALREADY-EXPIRED negative. */
    poke(p: string, c: string, h: string, value: unknown): void {
      this.store.set(RoundTripCacheStore.key(p, c, h), { value, writtenAtMs: Date.now() });
    }
  }

  const routes: CapabilityRoute[] = [{ capability: 'token.price', adapterIds: ['coingecko'] }];
  const args = { address: '0xabc' };

  it('remembers a normalize() failure so the SECOND identical call never fetches again', async () => {
    const adapter = makeAdapter({
      id: 'coingecko',
      normalizeImpl: () => {
        throw new Error('response has no matching row');
      },
    });
    const cache = new RoundTripCacheStore();
    const registry = new CapabilityRegistry(routes, new Map([['coingecko', adapter]]), cache);

    await expect(registry.resolve('token.price', CHAIN, args)).rejects.toBeInstanceOf(
      CapabilityUnavailableError,
    );
    expect(adapter.fetch).toHaveBeenCalledTimes(1);

    // The retry: still a loud failure (never a fabricated empty result — that is the DF-1 lesson),
    // but ZERO further fetches, i.e. zero further credits.
    await expect(registry.resolve('token.price', CHAIN, args)).rejects.toThrow(/cached negative/);
    expect(adapter.fetch).toHaveBeenCalledTimes(1);
  });

  it('writes the negative under a SHORT ttl override, not the capability TTL', async () => {
    const adapter = makeAdapter({
      id: 'coingecko',
      normalizeImpl: () => {
        throw new Error('malformed');
      },
    });
    const cache = new RoundTripCacheStore();
    const registry = new CapabilityRegistry(routes, new Map([['coingecko', adapter]]), cache);

    await expect(registry.resolve('token.price', CHAIN, args)).rejects.toThrow();

    expect(cache.setCalls).toHaveLength(1);
    expect(cache.setCalls[0]?.ttlSecondsOverride).toBe(60);
    expect(cache.setCalls[0]?.value).toMatchObject({
      __onchainNegative: true,
      reason: 'malformed',
    });
  });

  it('does NOT cache a fetch() failure — a transport blip must not become a self-inflicted outage', async () => {
    const adapter = makeAdapter({
      id: 'coingecko',
      fetchImpl: async () => {
        throw new Error('socket hang up');
      },
    });
    const cache = new RoundTripCacheStore();
    const registry = new CapabilityRegistry(routes, new Map([['coingecko', adapter]]), cache);

    await expect(registry.resolve('token.price', CHAIN, args)).rejects.toThrow(/socket hang up/);
    await expect(registry.resolve('token.price', CHAIN, args)).rejects.toThrow(/socket hang up/);

    // Called twice — the second attempt genuinely retried instead of replaying a cached verdict.
    expect(adapter.fetch).toHaveBeenCalledTimes(2);
    expect(cache.setCalls).toHaveLength(0);
  });

  it('lets an EXPIRED negative fall through and pay again — the vendor may now have data', async () => {
    let normalizeShouldThrow = true;
    const adapter = makeAdapter({
      id: 'coingecko',
      normalizeImpl: () => {
        if (normalizeShouldThrow) throw new Error('no matching row');
        return { priceUsd: 7 };
      },
    });
    const cache = new RoundTripCacheStore();
    const registry = new CapabilityRegistry(routes, new Map([['coingecko', adapter]]), cache);

    await expect(registry.resolve('token.price', CHAIN, args)).rejects.toThrow();

    // Plant an already-expired negative rather than moving the wall clock. Expiry is an
    // absolute-timestamp comparison on the entry itself, so rewriting the entry tests exactly the
    // branch under test — and avoids `vi.setSystemTime`, which leaked a shifted clock into a
    // sibling test FILE on first attempt (a 2s suite became a 9-minute one).
    const argsHash = deriveArgsHash('token.price', args);
    cache.poke('coingecko', 'token.price', argsHash, {
      __onchainNegative: true,
      reason: 'no matching row',
      expiresAtMs: Date.now() - 1,
    });
    normalizeShouldThrow = false;

    const resolution = await registry.resolve('token.price', CHAIN, args);
    expect(resolution).toMatchObject({ result: { priceUsd: 7 }, cache: 'miss' });
    expect(adapter.fetch).toHaveBeenCalledTimes(2);
  });

  it('a positive result is still a normal cache hit — the marker must not swallow real values', async () => {
    const adapter = makeAdapter({ id: 'coingecko', normalizeImpl: () => ({ priceUsd: 7 }) });
    const cache = new RoundTripCacheStore();
    const registry = new CapabilityRegistry(routes, new Map([['coingecko', adapter]]), cache);

    await registry.resolve('token.price', CHAIN, args);
    const second = await registry.resolve('token.price', CHAIN, args);

    expect(second).toMatchObject({ result: { priceUsd: 7 }, cache: 'hit' });
    expect(adapter.fetch).toHaveBeenCalledTimes(1);
  });
});

/**
 * TC-UNIT-04 (T-013, task 013-3, R-174d) — a compile-time proof that `sources`/`missingSources`/
 * `perSourceCache` are OPTIONAL: an object shaped like a pre-013-3 `CapabilityResolution`, carrying
 * none of the three, still satisfies the type. No `@ts-expect-error` here on purpose — this is the
 * POSITIVE control (mirrors `capability-manifest.test.ts`'s TC-UNIT-10): if any of the three lost
 * its `?`, this literal would fail `tsc --noEmit`, the gate this test exists to fail under, not a
 * `vitest` assertion. The runtime assertions below are the same construction 013-3's mcp-server
 * TC-UNIT-02 uses to prove genuine ABSENCE rather than an undefined-valued key.
 */
describe('CapabilityResolution — TC-UNIT-04 (T-013, task 013-3, type-test)', () => {
  it('assigns without sources/missingSources/perSourceCache — the three new fields are optional', () => {
    const resolution: CapabilityResolution = {
      result: { priceUsd: 7 },
      source: 'coingecko',
      cache: 'miss',
    };
    expect(resolution.source).toBe('coingecko');
    expect('sources' in resolution).toBe(false);
    expect('missingSources' in resolution).toBe(false);
    expect('perSourceCache' in resolution).toBe(false);
  });

  /**
   * Roast round 1, B-3: R-175(b) forbids widening `cache`'s two-literal type, and nothing gated
   * that until now. A runtime test comparing values against `['hit', 'miss']` cannot fail if the
   * TYPE is widened — nothing constructs a third-literal value at runtime. Demonstrated exploit: a
   * MATCHED widening of `perSourceCache[].cache` in both `registry.ts` (this file's own type) and
   * `resolve-capability.ts` (mcp-server's independently-declared `ResolveSuccess`) passes
   * `pnpm build`, `pnpm typecheck` and all 1564 tests, because `mcp-server` resolves
   * `@onchain-intel/core` through `dist/index.d.ts` — the last BUILT declarations, not this file's
   * source — so a single-file widening is the only shape the existing gates catch. This test and
   * its sibling in `resolve-capability-merge.test.ts` close it independently: each targets its OWN
   * file's OWN local type declaration, so EITHER widening alone breaks its OWN `tsc --noEmit`
   * regardless of whether the other file (or `dist/`) was touched at all.
   */
  it('type-test (roast round 1, B-3): CapabilityResolution.perSourceCache[].cache rejects a third literal', () => {
    const resolution: CapabilityResolution = {
      result: [],
      source: 'x',
      cache: 'miss',
      perSourceCache: [
        // @ts-expect-error roast round 1, B-3: 'stale' is not a member of 'hit' | 'miss' (R-175b).
        { adapterId: 'x', cache: 'stale' },
      ],
    };
    expect(resolution.perSourceCache?.[0]?.adapterId).toBe('x');
  });
});
