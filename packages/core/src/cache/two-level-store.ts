import type { CacheGetResult, CacheStore } from '../adapters/cache-store.js';
import type { AdapterRegistration } from '../adapters/types.js';
import { adapterRegistrations } from '../providers.config.js';
import { LruHotLayer } from './lru.js';
import { recordCacheAccess } from './stats.js';
import { SqliteCacheStore } from './sqlite-store.js';
import { ttlFor } from './ttl.js';

/** Options for the `createCacheStore` factory (ARCHITECTURE.md §3.2). */
export interface CreateCacheStoreOptions {
  /** Absolute path to the sqlite file, or `':memory:'` for tests. Defaults to `${DATA_DIR}/cache.sqlite3`. */
  dbPath?: string;
  /** Adapter registrations to bootstrap into `providers`. Defaults to the real `adapterRegistrations` (all 9). */
  providers?: AdapterRegistration[];
  /** Hot-layer entry cap, forwarded to `LruHotLayer`. */
  maxHotEntries?: number;
}

/**
 * Two-level cache (ARCHITECTURE.md §3.2, D6, R-13): `lru-cache` (hot, in-process) checked before
 * `better-sqlite3` (persistent, `DATA_DIR`) — `get()` walks hot → cold → miss; `set()` writes both
 * levels. A cold (persistent) hit is promoted into the hot layer with its REMAINING ttl (not a
 * fresh full ttl), so the promoted entry doesn't outlive what the persistent layer itself would
 * still consider fresh — and (adversarial cycle 2, fix 2) with its `createdAt` back-dated to the
 * value's ORIGINAL write time (`Date.now() - coldHit.ageMs`), so a hot hit served from a promoted
 * entry reports an `ageMs` anchored to when the value was actually fetched, never reset to ~0 at
 * promotion time.
 *
 * Hit/miss stats + the mandatory stderr line (R-15, ARCHITECTURE.md §3.2) are recorded HERE, not by
 * an edit to `CapabilityRegistry.resolve()` (implementation choice — see `stats.ts`'s docstring for
 * the full reasoning): every meaningful cache lookup the Registry performs already flows through
 * this class's `get()` (via the `CacheStore` seam from task 003-2), so recording at this single
 * seam captures the exact same `(provider, capability)` pairs `resolve()` would, with zero changes
 * to `registry.ts` itself.
 */
export class TwoLevelStore implements CacheStore {
  constructor(
    private readonly persistent: CacheStore,
    private readonly hot: LruHotLayer = new LruHotLayer(),
  ) {}

  async get(
    provider: string,
    capability: string,
    argsHash: string,
  ): Promise<CacheGetResult | undefined> {
    const hotHit = this.hot.get(provider, capability, argsHash);
    if (hotHit) {
      recordCacheAccess(provider, capability, 'hit', hotHit.ageMs);
      return hotHit;
    }

    const coldHit = await this.persistent.get(provider, capability, argsHash);
    if (coldHit) {
      const remainingMs = ttlFor(capability) * 1000 - coldHit.ageMs;
      // Adversarial cycle 2, fix 2: back-date the promoted hot entry's own `createdAt` to the
      // value's ORIGINAL persistent-layer write time (`Date.now() - coldHit.ageMs`), not the
      // promotion moment — otherwise every subsequent hot hit's `ageMs` resets to ~0 and
      // under-reports how old the underlying value actually is (`_meta.cache.ageMs`).
      this.hot.set(
        provider,
        capability,
        argsHash,
        coldHit.value,
        remainingMs,
        Date.now() - coldHit.ageMs,
      );
      recordCacheAccess(provider, capability, 'hit', coldHit.ageMs);
      return coldHit;
    }

    recordCacheAccess(provider, capability, 'miss');
    return undefined;
  }

  async set(provider: string, capability: string, argsHash: string, value: unknown): Promise<void> {
    await this.persistent.set(provider, capability, argsHash, value);
    this.hot.set(provider, capability, argsHash, value, ttlFor(capability) * 1000);
  }
}

/**
 * Assembles the production two-level `CacheStore` (ARCHITECTURE.md §3.2): a `SqliteCacheStore`
 * bootstrapped from every `adapterRegistrations` entry by default (all 9, including `pg-history` —
 * F-2), wrapped in a `TwoLevelStore`'s `lru-cache` hot layer. This is the factory a future caller
 * (mcp-server's real registry bootstrap, tasks 003-6/003-7) constructs and injects as
 * `CapabilityRegistry`'s third constructor argument in place of the default `PassthroughCacheStore`
 * — `registry.ts` itself doesn't change: it already accepts any `CacheStore` via constructor
 * injection (task 003-2), so wiring a real cache in is entirely the caller's responsibility.
 */
export function createCacheStore(options: CreateCacheStoreOptions = {}): CacheStore {
  const persistent = new SqliteCacheStore({
    dbPath: options.dbPath,
    providers: options.providers ?? adapterRegistrations,
  });
  return new TwoLevelStore(persistent, new LruHotLayer(options.maxHotEntries));
}
