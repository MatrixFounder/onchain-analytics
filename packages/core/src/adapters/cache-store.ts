/**
 * Result of a cache hit (ARCHITECTURE.md §3.2 `cache_entries` table — `(provider, capability,
 * args_hash)` is its UNIQUE dedup key). `ageMs` is how long ago the entry was written; the
 * Registry surfaces it verbatim as `resolve()`'s own `ageMs` field (ARCHITECTURE.md §2.1/§5.2).
 */
export interface CacheGetResult {
  value: unknown;
  ageMs: number;
}

/**
 * Cache seam consumed by `CapabilityRegistry` (D6; task 003-2 reviewer note: "Registry принимает
 * CacheStore инъекцией (фабрика, не singleton)"). Keyed by `(provider, capability, argsHash)` —
 * the same triple as the `cache_entries` UNIQUE constraint (ARCHITECTURE.md §3.2).
 *
 * The real implementation (`lru-cache` hot layer + `better-sqlite3` persistent layer, TTL-per-
 * capability enforcement per ARCHITECTURE.md §3.2's TTL table) is task 003-3's scope, deliberately
 * NOT built here (guard R-27 — "кеш/registry/адаптеры здесь не создаются" for the concrete cache
 * engine). TTL/expiry is entirely the concrete store's own responsibility: `get()` returning
 * `undefined` means "no usable entry" — whether because nothing was ever written, or because the
 * store itself decided a written entry is stale. The Registry never inspects `ageMs` to decide
 * hit vs. miss, only forwards it for the caller's/tool's own visibility (ARCHITECTURE.md §3.2
 * `_meta.cache`).
 */
export interface CacheStore {
  get(provider: string, capability: string, argsHash: string): Promise<CacheGetResult | undefined>;
  set(provider: string, capability: string, argsHash: string, value: unknown): Promise<void>;
}

/**
 * No-op stand-in — always a miss, `set()` discards the value. Lets `CapabilityRegistry` compile
 * and be unit-tested against the `CacheStore` seam before task 003-3 lands a real implementation
 * (this is the Registry's default `cache` constructor argument). A `new PassthroughCacheStore()`
 * default satisfies "factory, not global singleton" (ARCHITECTURE.md §8) — each `CapabilityRegistry`
 * instance that doesn't explicitly inject a `CacheStore` gets its own (inert) instance.
 */
export class PassthroughCacheStore implements CacheStore {
  async get(): Promise<CacheGetResult | undefined> {
    return undefined;
  }

  async set(): Promise<void> {
    // Intentionally discards — real persistence lands in 003-3's SqliteCacheStore.
  }
}
