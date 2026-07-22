import { PassthroughCacheStore } from './cache-store.js';
import type { CacheStore } from './cache-store.js';
import type { CapabilityRoute, ProviderAdapter } from './types.js';
import { deriveArgsHash } from '../net/args-hash.js';
import type { Chain } from '../types/chain.js';

/** One failed/unavailable attempt recorded while walking a route's `adapterIds` (R-24). */
export interface CapabilityAttempt {
  adapterId: string;
  reason: string;
}

/**
 * Thrown when every adapter in a route's `adapterIds` was unavailable or failed (R-24/R-11) — or
 * when no route exists at all for `(capability, chain)`. Callers (future MCP tool handlers, tasks
 * 003-6/003-7) turn this into an explicit `isError: true` tool response — never a silent empty
 * result (ARCHITECTURE.md §9.1).
 */
export class CapabilityUnavailableError extends Error {
  readonly capability: string;
  readonly chain: Chain;
  readonly tried: CapabilityAttempt[];

  constructor(details: { capability: string; chain: Chain; tried: CapabilityAttempt[] }) {
    const triedText = details.tried.length
      ? details.tried.map((t) => `${t.adapterId} (${t.reason})`).join(', ')
      : 'no route registered for this capability/chain';
    super(
      `capability unavailable: ${details.capability} on ${details.chain} — tried: ${triedText}`,
    );
    this.name = 'CapabilityUnavailableError';
    this.capability = details.capability;
    this.chain = details.chain;
    this.tried = details.tried;
  }
}

/** `CapabilityRegistry.resolve()`'s return shape (ARCHITECTURE.md §2.1/§5.2/§9.1). */
export interface CapabilityResolution {
  result: unknown;
  source: string;
  cache: 'hit' | 'miss';
  ageMs?: number;
}

/**
 * Routes `(capability, chain)` to an ordered list of adapters (D4/R-4/R-11) and returns only the
 * `normalize()`d canonical result — a raw provider DTO never reaches the caller (anti-corruption
 * layer, ARCHITECTURE.md §2.1).
 *
 * A factory, not a module singleton (ARCHITECTURE.md §8; task 003-2 reviewer note): callers
 * construct their own instance from their own `routes`/`adapters`/`cache`. `routes` and `adapters`
 * are both constructor parameters — not read from an internal import of `providers.config.ts` —
 * so tests can exercise routing/fallback with small, purpose-built route tables and mock adapters
 * instead of the full real 9-adapter M1 configuration (which future tasks 003-4/003-5/003-6 will
 * assemble once real adapters exist). This also keeps the door open for future multi-instance use
 * (§8) without a refactor.
 */
export class CapabilityRegistry {
  constructor(
    private readonly routes: CapabilityRoute[],
    private readonly adapters: Map<string, ProviderAdapter>,
    private readonly cache: CacheStore = new PassthroughCacheStore(),
  ) {}

  /**
   * Routes `(capability, chain)` to an ordered adapter list and returns only the `normalize()`d
   * canonical result (ARCHITECTURE.md §3.2/§9.1 + task 003-2 reviewer note — the exact contract):
   *
   * 1. Find the route matching `capability` where `chains` is unset or contains `chain`. No match
   *    → `CapabilityUnavailableError` with an empty `tried` list (no route registered).
   * 2. Walk `route.adapterIds` in order (priority + fallback, R-11):
   *    - No `ProviderAdapter` registered for that id in the constructor-injected `adapters` Map →
   *      treated exactly like an unavailable adapter (skip-to-next, `providers.config.ts`'s own
   *      documented contract for ids with no real adapter yet, tasks 003-4/003-5).
   *    - `adapter.isAvailable?.()` reports `{ok: false}` → record the reason, skip-to-next.
   *    - Otherwise check `cache.get(adapter.id, capability, argsHash)` (keyed the same way as the
   *      `cache_entries` UNIQUE constraint, §4.2) — a hit returns immediately with `cache: 'hit'`
   *      and the stored `ageMs`, without calling `fetch`/`normalize` at all.
   *    - Cache miss → `fetch(capability, args)` → `normalize(capability, raw)` → `cache.set(...)`
   *      → return `{cache: 'miss'}`. A throw from either `fetch` or `normalize` is caught, recorded
   *      as a `tried` entry, and moves on to the next `adapterId` — never fails the whole call.
   * 3. Every adapter in the route unavailable/failed → `CapabilityUnavailableError` with the full
   *    `tried` list (R-24 explicit degradation, never a silent empty result).
   *
   * Anti-corruption layer: only the `normalize()` result is ever returned — the raw provider DTO
   * from `fetch()` never leaves this method.
   */
  async resolve(
    capability: string,
    chain: Chain,
    args: Record<string, unknown>,
  ): Promise<CapabilityResolution> {
    const route = this.routes.find(
      (candidate) =>
        candidate.capability === capability &&
        (!candidate.chains || candidate.chains.includes(chain)),
    );

    const tried: CapabilityAttempt[] = [];

    if (!route) {
      throw new CapabilityUnavailableError({ capability, chain, tried });
    }

    const argsHash = deriveArgsHash(capability, args);

    for (const adapterId of route.adapterIds) {
      const adapter = this.adapters.get(adapterId);
      if (!adapter) {
        tried.push({ adapterId, reason: 'no adapter registered for this id' });
        continue;
      }

      const availability = adapter.isAvailable?.() ?? { ok: true };
      if (!availability.ok) {
        tried.push({ adapterId, reason: availability.reason });
        continue;
      }

      const cached = await this.cache.get(adapter.id, capability, argsHash);
      if (cached) {
        return { result: cached.value, source: adapter.id, cache: 'hit', ageMs: cached.ageMs };
      }

      try {
        const raw = await adapter.fetch(capability, args);
        const result = adapter.normalize(capability, raw);
        await this.cache.set(adapter.id, capability, argsHash, result);
        return { result, source: adapter.id, cache: 'miss' };
      } catch (error) {
        tried.push({ adapterId, reason: error instanceof Error ? error.message : String(error) });
      }
    }

    throw new CapabilityUnavailableError({ capability, chain, tried });
  }
}
