import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CacheGetResult, CacheStore } from '../src/adapters/cache-store.js';
import { getCacheStats, recordCacheAccess, resetCacheStats } from '../src/cache/stats.js';
import { TwoLevelStore } from '../src/cache/two-level-store.js';

describe('cache stats (R-15)', () => {
  beforeEach(() => {
    resetCacheStats();
  });

  it('getCacheStats() is empty before any access is recorded', () => {
    expect(getCacheStats()).toEqual({});
  });

  it('recordCacheAccess increments the per-capability hit/miss counters', () => {
    recordCacheAccess('coingecko', 'token.price', 'miss');
    recordCacheAccess('coingecko', 'token.price', 'hit', 12);
    recordCacheAccess('coingecko', 'token.price', 'hit', 34);
    recordCacheAccess('dexscreener', 'pairs.new', 'miss');

    expect(getCacheStats()).toEqual({
      'token.price': { hit: 2, miss: 1 },
      'pairs.new': { hit: 0, miss: 1 },
    });
  });

  it('never writes to stdout (M0 stdout-discipline invariant, ARCHITECTURE.md §7.3) and writes a greppable stderr line', () => {
    const stdoutSpy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

    recordCacheAccess('coingecko', 'token.price', 'hit', 42);

    expect(stdoutSpy).not.toHaveBeenCalled();
    expect(stderrSpy).toHaveBeenCalledTimes(1);
    const line = stderrSpy.mock.calls[0]?.[0] as string;
    expect(line).toContain('cache=hit');
    expect(line).toContain('provider=coingecko');
    expect(line).toContain('capability=token.price');
    expect(line).toContain('ageMs=42');

    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  });

  it('records a miss with ageMs=0 in the stderr line (nothing was ever cached)', () => {
    const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    recordCacheAccess('coingecko', 'token.price', 'miss');
    const line = stderrSpy.mock.calls[0]?.[0] as string;
    expect(line).toContain('cache=miss');
    expect(line).toContain('ageMs=0');
    stderrSpy.mockRestore();
  });
});

class FakeCacheStore implements CacheStore {
  private readonly map = new Map<string, { value: unknown; createdAt: number }>();

  private key(provider: string, capability: string, argsHash: string): string {
    return `${provider}:${capability}:${argsHash}`;
  }

  async get(
    provider: string,
    capability: string,
    argsHash: string,
  ): Promise<CacheGetResult | undefined> {
    const entry = this.map.get(this.key(provider, capability, argsHash));
    if (!entry) return undefined;
    return { value: entry.value, ageMs: Date.now() - entry.createdAt };
  }

  async set(provider: string, capability: string, argsHash: string, value: unknown): Promise<void> {
    this.map.set(this.key(provider, capability, argsHash), { value, createdAt: Date.now() });
  }
}

describe('TwoLevelStore -> stats integration (R-15 acceptance: first call miss, repeat call hit)', () => {
  beforeEach(() => {
    resetCacheStats();
  });

  it('first lookup is a miss; the lookup after set() is a hit — both visible in getCacheStats()', async () => {
    const store = new TwoLevelStore(new FakeCacheStore());

    const first = await store.get('coingecko', 'token.price', 'h');
    expect(first).toBeUndefined();
    expect(getCacheStats()['token.price']).toEqual({ hit: 0, miss: 1 });

    await store.set('coingecko', 'token.price', 'h', { priceUsd: 1 });
    const second = await store.get('coingecko', 'token.price', 'h');
    expect(second?.value).toEqual({ priceUsd: 1 });
    expect(getCacheStats()['token.price']).toEqual({ hit: 1, miss: 1 });
  });
});
