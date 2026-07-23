import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CacheGetResult, CacheStore } from '../src/adapters/cache-store.js';
import { cacheDbPath, resolveDataDir } from '../src/cache/data-dir.js';
import { LruHotLayer } from '../src/cache/lru.js';
import { SqliteCacheStore } from '../src/cache/sqlite-store.js';
import { ttlFor } from '../src/cache/ttl.js';
import { createCacheStore, TwoLevelStore } from '../src/cache/two-level-store.js';
import { deriveArgsHash } from '../src/net/args-hash.js';
import { adapterRegistrations } from '../src/providers.config.js';

function tempDbPath(): { dir: string; dbPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'onchain-cache-test-'));
  return { dir, dbPath: join(dir, 'cache.sqlite3') };
}

describe('data-dir (R-13: DATA_DIR not cwd-relative)', () => {
  it('resolves DATA_DIR from env when set', () => {
    expect(resolveDataDir({ DATA_DIR: '/custom/data-dir' } as NodeJS.ProcessEnv)).toBe(
      '/custom/data-dir',
    );
  });

  it('defaults to homedir()/.onchain-intel, not process.cwd()-relative', () => {
    const resolved = resolveDataDir({} as NodeJS.ProcessEnv);
    expect(resolved).toContain('.onchain-intel');
    expect(resolved.startsWith(process.cwd())).toBe(false);
  });

  it('cacheDbPath joins DATA_DIR + cache.sqlite3', () => {
    expect(cacheDbPath('/x/y')).toBe(join('/x/y', 'cache.sqlite3'));
  });
});

describe('ttlFor (R-13/R-14: TTL by capability, ARCHITECTURE.md §3.2 table)', () => {
  it.each([
    ['token.price', 60],
    ['token.metadata', 3600],
    ['wallet.balances.native', 60],
    ['pairs.new', 30],
    ['protocol.tvl', 300],
    ['privacy.shielded_pool', 3600],
    ['platform.identities', 3600],
    ['platform.contracts', 3600],
    ['platform.documents', 3600],
    ['platform.credits', 3600],
    ['token.holders', 3600],
  ])('%s -> %i seconds', (capability, seconds) => {
    expect(ttlFor(capability)).toBe(seconds);
  });

  it('falls back to a documented default for a capability not in the explicit table', () => {
    expect(ttlFor('totally.unmapped.capability')).toBeGreaterThan(0);
  });
});

describe('SqliteCacheStore (R-13/R-14)', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    ({ dir, dbPath } = tempDbPath());
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('bootstraps all 9 adapterRegistrations into providers before any cache_entries write', () => {
    const store = new SqliteCacheStore({ dbPath, providers: adapterRegistrations });
    const raw = new Database(dbPath, { readonly: true });
    const rows = raw.prepare('SELECT id FROM providers ORDER BY id').all() as { id: string }[];
    raw.close();
    store.close();

    expect(rows).toHaveLength(9);
    expect(rows.map((r) => r.id).sort()).toEqual([...adapterRegistrations.map((a) => a.id)].sort());
  });

  it('reports a miss when nothing was ever written', async () => {
    const store = new SqliteCacheStore({ dbPath, providers: adapterRegistrations });
    const result = await store.get('coingecko', 'token.price', 'hash-1');
    store.close();
    expect(result).toBeUndefined();
  });

  it('set() then get() is a hit with a non-negative ageMs', async () => {
    const store = new SqliteCacheStore({ dbPath, providers: adapterRegistrations });
    await store.set('coingecko', 'token.price', 'hash-1', { priceUsd: 1.23 });
    const result = (await store.get('coingecko', 'token.price', 'hash-1')) as CacheGetResult;
    store.close();

    expect(result).toBeDefined();
    expect(result.value).toEqual({ priceUsd: 1.23 });
    expect(result.ageMs).toBeGreaterThanOrEqual(0);
  });

  it('a second set() upserts the value (updates in place, never appends a duplicate row)', async () => {
    const store = new SqliteCacheStore({ dbPath, providers: adapterRegistrations });
    await store.set('coingecko', 'token.price', 'hash-1', { priceUsd: 1.23 });

    const raw1 = new Database(dbPath, { readonly: true });
    const row1 = raw1
      .prepare('SELECT value_json, created_at, expires_at FROM cache_entries')
      .get() as { value_json: string; created_at: number; expires_at: number };
    raw1.close();

    await new Promise((resolve) => setTimeout(resolve, 5));
    await store.set('coingecko', 'token.price', 'hash-1', { priceUsd: 4.56 });

    const raw2 = new Database(dbPath, { readonly: true });
    const count = (raw2.prepare('SELECT COUNT(*) as n FROM cache_entries').get() as { n: number })
      .n;
    const row2 = raw2
      .prepare('SELECT value_json, created_at, expires_at FROM cache_entries')
      .get() as { value_json: string; created_at: number; expires_at: number };
    raw2.close();

    const result = (await store.get('coingecko', 'token.price', 'hash-1')) as CacheGetResult;
    store.close();

    expect(count).toBe(1); // upsert, not append (DB-SCHEMA-CONCEPT §1.5 "aggregates" branch)
    expect(JSON.parse(row2.value_json)).toEqual({ priceUsd: 4.56 }); // value column actually updated
    expect(row2.created_at).toBeGreaterThan(row1.created_at);
    expect(row2.expires_at).toBeGreaterThan(row1.expires_at);
    expect(result.value).toEqual({ priceUsd: 4.56 }); // never pins the stale first value
  });

  it('an expired entry (expires_at in the past) is a miss and is deleted on read', async () => {
    const store = new SqliteCacheStore({ dbPath, providers: adapterRegistrations });
    await store.set('coingecko', 'token.price', 'hash-1', { priceUsd: 1.23 });

    // Force expiry deterministically via a second raw connection to the SAME file, instead of
    // waiting out token.price's real 60s TTL — a legitimate white-box manipulation of `expires_at`
    // (a plain data column) only, not of any connection-scoped pragma.
    const raw = new Database(dbPath);
    raw.prepare('UPDATE cache_entries SET expires_at = ?').run(Date.now() - 1000);
    raw.close();

    const result = await store.get('coingecko', 'token.price', 'hash-1');

    const raw2 = new Database(dbPath, { readonly: true });
    const count = (raw2.prepare('SELECT COUNT(*) as n FROM cache_entries').get() as { n: number })
      .n;
    raw2.close();
    store.close();

    expect(result).toBeUndefined();
    expect(count).toBe(0); // stale row removed on read, not left to shadow a later write
  });

  it('enforces PRAGMA foreign_keys=ON on its own connection (set() for an unregistered provider throws)', async () => {
    const store = new SqliteCacheStore({ dbPath, providers: adapterRegistrations });
    await expect(
      store.set('not-a-real-provider', 'token.price', 'hash-1', { priceUsd: 1 }),
    ).rejects.toThrow();
    store.close();
  });

  it('cache key is stable across args key order (via deriveArgsHash from 003-2)', async () => {
    const store = new SqliteCacheStore({ dbPath, providers: adapterRegistrations });
    const hashA = deriveArgsHash('token.price', { chain: 'ethereum', address: '0xabc' });
    const hashB = deriveArgsHash('token.price', { address: '0xabc', chain: 'ethereum' });
    expect(hashA).toBe(hashB);

    await store.set('coingecko', 'token.price', hashA, { priceUsd: 9 });
    const hit = (await store.get('coingecko', 'token.price', hashB)) as CacheGetResult;
    store.close();

    expect(hit.value).toEqual({ priceUsd: 9 });
  });

  it('opportunistically sweeps already-expired rows every Nth write (adversarial cycle 1, fix H — counter forced small for the test)', async () => {
    const store = new SqliteCacheStore({
      dbPath,
      providers: adapterRegistrations,
      sweepEveryNWrites: 2,
    });

    // Write an entry, then force it into the past directly (same white-box technique the
    // TTL-expiry test above uses) — this row must NOT be read again, so it can only ever be
    // removed by the sweep itself, never by get()'s own on-read deletion.
    await store.set('coingecko', 'token.price', 'hash-expired', { priceUsd: 1 });
    const raw = new Database(dbPath);
    raw
      .prepare('UPDATE cache_entries SET expires_at = ? WHERE args_hash = ?')
      .run(Date.now() - 1000, 'hash-expired');
    raw.close();

    // A 2nd write on the SAME store (sweepEveryNWrites: 2) crosses the sweep threshold.
    await store.set('coingecko', 'token.price', 'hash-fresh', { priceUsd: 2 });
    store.close();

    const raw2 = new Database(dbPath, { readonly: true });
    const rows = raw2.prepare('SELECT args_hash FROM cache_entries').all() as {
      args_hash: string;
    }[];
    raw2.close();

    expect(rows.map((r) => r.args_hash)).toEqual(['hash-fresh']);
  });

  it('closes the already-opened db handle before rethrowing when a post-open step fails (post-M1 polish, fix 4)', () => {
    const closeSpy = vi.spyOn(Database.prototype, 'close');

    let thrown: unknown;
    try {
      new SqliteCacheStore({
        dbPath,
        providers: adapterRegistrations,
        postOpenTestHook: () => {
          throw new Error('simulated post-open failure (fix 4 test-only seam)');
        },
      });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe('simulated post-open failure (fix 4 test-only seam)');
    // Proves the leak-safety fix actually ran: the already-opened handle was closed as part of
    // handling the post-open failure, not merely left open with the error propagating past it.
    expect(closeSpy).toHaveBeenCalledTimes(1);

    closeSpy.mockRestore();
  });
});

describe('LruHotLayer (R-13: hot layer, TTL built into set())', () => {
  it('is a miss before any set()', () => {
    const hot = new LruHotLayer();
    expect(hot.get('coingecko', 'token.price', 'h')).toBeUndefined();
  });

  it('set() then get() is a hit within ttl', () => {
    const hot = new LruHotLayer();
    hot.set('coingecko', 'token.price', 'h', { priceUsd: 1 }, 10_000);
    const result = hot.get('coingecko', 'token.price', 'h');
    expect(result).toBeDefined();
    expect(result?.value).toEqual({ priceUsd: 1 });
    expect(result?.ageMs).toBeGreaterThanOrEqual(0);
  });

  it('expires after its ttl elapses (short real ttl + short real wait, not a ttlFor()-scale delay)', async () => {
    const hot = new LruHotLayer();
    hot.set('coingecko', 'token.price', 'h', { priceUsd: 1 }, 20);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(hot.get('coingecko', 'token.price', 'h')).toBeUndefined();
  });

  it('an entry with ttlMs <= 0 is not stored (used when a promoted cold hit has no time left)', () => {
    const hot = new LruHotLayer();
    hot.set('coingecko', 'token.price', 'h', { priceUsd: 1 }, 0);
    expect(hot.get('coingecko', 'token.price', 'h')).toBeUndefined();
  });
});

class FakeCacheStore implements CacheStore {
  calls: { method: 'get' | 'set'; provider: string; capability: string; argsHash: string }[] = [];
  private readonly map = new Map<string, { value: unknown; createdAt: number }>();

  private key(provider: string, capability: string, argsHash: string): string {
    return `${provider}:${capability}:${argsHash}`;
  }

  async get(
    provider: string,
    capability: string,
    argsHash: string,
  ): Promise<CacheGetResult | undefined> {
    this.calls.push({ method: 'get', provider, capability, argsHash });
    const entry = this.map.get(this.key(provider, capability, argsHash));
    if (!entry) return undefined;
    return { value: entry.value, ageMs: Date.now() - entry.createdAt };
  }

  async set(provider: string, capability: string, argsHash: string, value: unknown): Promise<void> {
    this.calls.push({ method: 'set', provider, capability, argsHash });
    this.map.set(this.key(provider, capability, argsHash), { value, createdAt: Date.now() });
  }
}

describe('TwoLevelStore (R-13: composition — hot -> cold -> miss, set() writes both)', () => {
  it('get() is a miss when both levels miss (persistent WAS consulted)', async () => {
    const fake = new FakeCacheStore();
    const store = new TwoLevelStore(fake);
    const result = await store.get('coingecko', 'token.price', 'h');
    expect(result).toBeUndefined();
    expect(fake.calls).toHaveLength(1);
  });

  it('set() writes both levels; the next get() is served hot, without re-touching persistent', async () => {
    const fake = new FakeCacheStore();
    const store = new TwoLevelStore(fake);
    await store.set('coingecko', 'token.price', 'h', { priceUsd: 1 });
    expect(fake.calls.some((c) => c.method === 'set')).toBe(true);

    const result = await store.get('coingecko', 'token.price', 'h');
    expect(result?.value).toEqual({ priceUsd: 1 });
    expect(fake.calls.filter((c) => c.method === 'get')).toHaveLength(0);
  });

  it('promotes a cold (persistent) hit into the hot layer, so the next get() avoids persistent', async () => {
    const fake = new FakeCacheStore();
    // Seed the persistent layer directly, simulating a value written by a previous process.
    await fake.set('coingecko', 'token.price', 'h', { priceUsd: 2 });
    const store = new TwoLevelStore(fake);

    const first = await store.get('coingecko', 'token.price', 'h');
    expect(first?.value).toEqual({ priceUsd: 2 });
    expect(fake.calls.filter((c) => c.method === 'get')).toHaveLength(1);

    const second = await store.get('coingecko', 'token.price', 'h');
    expect(second?.value).toEqual({ priceUsd: 2 });
    expect(fake.calls.filter((c) => c.method === 'get')).toHaveLength(1); // still 1 -> hot this time
  });

  it('promotes a cold hit with its createdAt anchored to the ORIGINAL write time, not the promotion moment (adversarial cycle 2, fix 2)', async () => {
    const KNOWN_COLD_AGE_MS = 5_000;
    class FixedAgeCacheStore implements CacheStore {
      async get(): Promise<CacheGetResult | undefined> {
        // Simulates a persistent-layer entry that was already 5s old at the moment it's read —
        // e.g. written by a previous process, or simply not the very first read since it was set.
        return { value: { priceUsd: 3 }, ageMs: KNOWN_COLD_AGE_MS };
      }
      async set(): Promise<void> {
        // Not exercised by this test.
      }
    }
    const store = new TwoLevelStore(new FixedAgeCacheStore());

    const first = await store.get('coingecko', 'token.price', 'h'); // cold hit -> promotes into hot
    expect(first?.ageMs).toBe(KNOWN_COLD_AGE_MS);

    const second = await store.get('coingecko', 'token.price', 'h'); // served from hot now
    expect(second).toBeDefined();
    // Anchored to the value's ORIGINAL write time (5s ago) — never reset to ~0 at promotion. The
    // previous (buggy) behavior would report an ageMs close to 0 here (time since promotion only),
    // under-reporting how old the value actually is.
    expect(second!.ageMs).toBeGreaterThanOrEqual(KNOWN_COLD_AGE_MS);
  });
});

describe('createCacheStore factory', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    ({ dir, dbPath } = tempDbPath());
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('assembles a working two-level store, bootstrapped with all 9 real providers by default', async () => {
    const store = createCacheStore({ dbPath });
    await store.set('coingecko', 'token.price', 'h', { priceUsd: 5 });
    const result = await store.get('coingecko', 'token.price', 'h');
    expect(result?.value).toEqual({ priceUsd: 5 });
  });
});
