import { PassthroughCacheStore } from './cache-store.js';
import type { CacheGetResult, CacheStore } from './cache-store.js';
import type { CapabilityRoute, ProviderAdapter } from './types.js';
import { deriveArgsHash } from '../net/args-hash.js';
import { NEGATIVE_TTL_SECONDS } from '../cache/ttl.js';
import { createCoverage, type Coverage } from '../chain/coverage.js';
import { loadChainRegistry } from '../chain/registry.js';
import type { ChainRegistry } from '../chain/registry-core.js';
import { CapabilityNotCoveredOnChainError } from '../chain/errors.js';

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
  /** Widened from the closed `Chain` enum to `string` in TASK-006 (task 006-4): the engine's chain
   * vocabulary now lives in the registry, not in a type literal. */
  readonly chain: string;
  readonly tried: CapabilityAttempt[];

  constructor(details: { capability: string; chain: string; tried: CapabilityAttempt[] }) {
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

/**
 * Marker for a NEGATIVE cache entry (issue L-1): a record that this exact `(provider, capability,
 * argsHash)` produced a deterministic `normalize()` failure, so the next identical call can fail
 * the same way **without paying for the vendor response again**.
 *
 * Why this exists at all: `resolve()` caches only after `normalize()` returns, so every throw
 * there discarded an already-PAID response — nothing cached, the adapter recorded as failed, the
 * agent's retry paying full price for a response that will be rejected identically. On Nansen that
 * is 10cr per `smart-money.flows` attempt and 100cr for the exhaustive `entity.labels` tier, on a
 * loop with no exit. The mechanism cost 35 real credits to discover (see `docs/issues/df-1-*.md`).
 *
 * Only `normalize()` failures are cached, never `fetch()` failures — see `resolve()` for why that
 * line is where it is.
 *
 * `expiresAtMs` is carried IN the entry rather than left to the store. The two-level store promotes
 * a cold hit into its hot layer using `ttlFor(capability)`, which for a negative entry is the wrong
 * (much longer) number; checking the timestamp here makes the expiry correct regardless of what any
 * layer decides to do with it.
 */
interface NegativeCacheEntry {
  __onchainNegative: true;
  reason: string;
  expiresAtMs: number;
}

function isNegativeEntry(value: unknown): value is NegativeCacheEntry {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { __onchainNegative?: unknown }).__onchainNegative === true
  );
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
  /** Built lazily and memoized per instance (never a module singleton, §8): the shipped registry
   * is ~458 rows, and constructing one per `CapabilityRegistry` in a test suite would be pure
   * waste when most tests never reach the coverage gate. */
  private coverageCache: Coverage | null = null;
  private chainsCache: ChainRegistry | null = null;

  constructor(
    private readonly routes: CapabilityRoute[],
    private readonly adapters: Map<string, ProviderAdapter>,
    private readonly cache: CacheStore = new PassthroughCacheStore(),
    /** Chain registry used by the coverage gate (TASK-006 R-51). Defaults to the shipped snapshot
     * so production wiring cannot forget it; injectable so tests can use a synthetic registry. */
    private readonly chains: ChainRegistry | null = null,
  ) {}

  /**
   * The coverage matrix derived from THIS registry's routes and adapters (TASK-006 R-51/R-52).
   *
   * Public because `onchain_list_chains` answers "where is this capability available" and must do
   * so from the same two sources the gate uses — a tool building its own matrix could disagree
   * with the engine that will actually serve the call.
   */
  getCoverage(): Coverage {
    this.coverageCache ??= createCoverage({
      routes: this.routes,
      adapters: this.adapters,
      chains: this.getChainRegistry(),
    });
    return this.coverageCache;
  }

  /** The chain registry this instance resolves against (injected, or the shipped snapshot). */
  getChainRegistry(): ChainRegistry {
    this.chainsCache ??= this.chains ?? loadChainRegistry();
    return this.chainsCache;
  }

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
   *
   * **Cache-fault contract (adversarial cycle 1, findings A1/A2) — cache errors are ALWAYS
   * best-effort, never fatal:** a faulty/misbehaving `CacheStore` must never turn an otherwise
   * successful `fetch`/`normalize` into a `CapabilityUnavailableError`, and must never abort the
   * whole `resolve()` call. Concretely:
   * - A throw from `cache.get(...)` is caught, logged to stderr (one line, no args/secret values),
   *   and treated exactly like a cache MISS — `resolve()` falls straight through to `fetch`.
   * - A throw from `cache.set(...)` is caught in its OWN try/catch, nested inside the
   *   `fetch`/`normalize` try block (never sharing that block's catch) — it is logged to stderr and
   *   otherwise ignored; the already-fetched/normalized `result` is still returned as a `'miss'`.
   *
   * This is a DIFFERENT contract from the `fetch`/`normalize` catch above: a `fetch`/`normalize`
   * failure means "this adapter couldn't answer, try the next one" (recorded in `tried`); a cache
   * failure means "the cache itself is unwell, but the adapter it wraps answered fine" — the cache
   * is a pure side channel and is never allowed to fail the call it's merely trying to memoize.
   */
  async resolve(
    capability: string,
    chain: string,
    args: Record<string, unknown>,
  ): Promise<CapabilityResolution> {
    const tried: CapabilityAttempt[] = [];
    const chainInfo = this.getChainRegistry().tryResolve(chain);

    // TASK-006 (task 006-5): ALL routes for the capability contribute their adapters, in
    // declaration order. Before this, a single `find()` picked the first route and `chains` on the
    // route was what separated e.g. `wallet.balances.native` → `rpc-evm` from the same capability
    // → `rpc-solana`. With the chain dimension moved into `chainSupport()`, that separation now
    // happens per ADAPTER: an adapter that cannot serve the chain is skipped here, so removing the
    // route-level `chains` literal changes nothing about which adapter answers.
    //
    // A route that still carries `chains` keeps being narrowed by it — the two mechanisms agree,
    // and the literal is simply redundant where a predicate exists.
    const matching = this.routes.filter(
      (candidate) =>
        candidate.capability === capability &&
        (!candidate.chains || (candidate.chains as readonly string[]).includes(chain)),
    );

    if (matching.length === 0) {
      throw new CapabilityUnavailableError({ capability, chain, tried });
    }

    const adapterIds = [...new Set(matching.flatMap((candidate) => candidate.adapterIds))];

    // GATE 2 — coverage (TASK-006 R-51d). Positioned deliberately: after the route is known, but
    // BEFORE the cache read, before `isAvailable()`, before the budget gate and before any HTTP.
    //
    // Widening the chain set from 2 to 458 multiplies the ways a caller can miss coverage. If a
    // miss cost a credit reservation, the widening would itself become a way to spend money — so
    // this check has to sit above the paid path, not merely somewhere before the network call.
    //
    // A chain string that does not resolve leaves the gate inert: canonicalizing tool input is
    // task 006-6's job at the boundary, and this method must not start rejecting chains that the
    // pre-TASK-006 contract accepted.
    if (chainInfo && !this.getCoverage().isCovered(capability, chainInfo)) {
      const coverage = this.getCoverage();
      // BOUNDED (vdd-multi cycle 6, perf): `chainsFor(...).map(slug)` built a ~450-element array
      // so the constructor could render ten of them, which made the refusal path cost more than
      // the cache-HIT success path — on exactly the request a confused agent repeats.
      const served = coverage.servedSlugs(capability, 10);
      throw new CapabilityNotCoveredOnChainError({
        capability,
        chain: chainInfo.slug,
        availableChains: served.slugs,
        totalServedChains: served.total,
        availableCapabilities: coverage.capabilitiesFor(chainInfo),
      });
    }

    const argsHash = deriveArgsHash(capability, args);

    for (const adapterId of adapterIds) {
      const adapter = this.adapters.get(adapterId);
      if (!adapter) {
        tried.push({ adapterId, reason: 'no adapter registered for this id' });
        continue;
      }

      // Chain-scoped skip (TASK-006): this is what the route-level `chains` literal used to do.
      // Not recorded in `tried` — "this adapter does not serve this chain" is not an attempt that
      // failed, and listing it would make a coverage fact look like an outage.
      if (chainInfo && adapter.chainSupport && !adapter.chainSupport(chainInfo, capability)) {
        continue;
      }

      const availability = adapter.isAvailable?.() ?? { ok: true };
      if (!availability.ok) {
        tried.push({ adapterId, reason: availability.reason });
        continue;
      }

      // Cache-read fault (finding A2): never abort resolve() — log and treat as a plain miss,
      // falling through to fetch/normalize exactly as if nothing had ever been cached.
      let cached: CacheGetResult | undefined;
      try {
        cached = await this.cache.get(adapter.id, capability, argsHash);
      } catch (error) {
        process.stderr.write(
          `cache.get failed provider=${adapter.id} capability=${capability}: ${
            error instanceof Error ? error.message : String(error)
          } — treating as a miss\n`,
        );
        cached = undefined;
      }
      if (cached && isNegativeEntry(cached.value)) {
        // A remembered deterministic failure (L-1). Record it exactly as if the adapter had just
        // failed — the caller still gets a loud `CapabilityUnavailableError`, never a fabricated
        // empty result — but ZERO network calls and ZERO credits were spent to say so. Marked in
        // the reason text so an operator debugging a just-fixed request bug can tell a cached
        // verdict from a fresh one instead of concluding the fix did not work.
        if (Date.now() < cached.value.expiresAtMs) {
          tried.push({ adapterId, reason: `${cached.value.reason} [cached negative]` });
          continue;
        }
        // Expired negative: fall through and pay again, deliberately. The vendor may now have data.
      } else if (cached) {
        return { result: cached.value, source: adapter.id, cache: 'hit', ageMs: cached.ageMs };
      }

      let raw: unknown;
      try {
        raw = await adapter.fetch(capability, args);
      } catch (error) {
        // A PERMANENT refusal propagates as itself (vdd-multi cycle 5, H-1). Everything else in
        // this catch is treated as "this adapter could not answer right now, try the next one",
        // and the call ends as `CapabilityUnavailableError` — which tells the caller to RETRY.
        // For "this capability is not served on this chain" that advice is wrong in a way that
        // costs: the agent retries forever, and on a paid route each retry is a reservation
        // attempt. The gate above catches this for coverage it can see; an adapter can also
        // discover it deeper (Nansen's exhaustive `entity.labels` tier has a narrower chain list
        // than the default tier, and `chainSupport()` cannot see `args.exhaustive`).
        if (error instanceof CapabilityNotCoveredOnChainError) throw error;
        // FETCH failures are NOT negative-cached (L-1). A transport error, a 429, a 5xx or a budget
        // refusal is transient by nature: the same call a second later can legitimately succeed.
        // Caching that verdict would turn a blip into a self-inflicted outage lasting the whole
        // negative TTL — strictly worse than paying twice. Only the deterministic half is cached.
        tried.push({ adapterId, reason: error instanceof Error ? error.message : String(error) });
        continue;
      }

      try {
        const result = adapter.normalize(capability, raw);
        // Cache-write fault (finding A1): its OWN try/catch, deliberately NOT sharing the
        // fetch/normalize catch below — a cache.set() failure must never be recorded as a
        // "tried" failure for this adapter (it already answered successfully) and must never
        // fall through to the next adapterId; the result is still returned as a genuine 'miss'.
        try {
          await this.cache.set(adapter.id, capability, argsHash, result);
        } catch (error) {
          process.stderr.write(
            `cache.set failed provider=${adapter.id} capability=${capability}: ${
              error instanceof Error ? error.message : String(error)
            } — result still returned (best-effort cache write)\n`,
          );
        }
        return { result, source: adapter.id, cache: 'miss' };
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        // NORMALIZE failed on a response we already have in hand (and, for a paid provider, already
        // paid for). That verdict is DETERMINISTIC: the identical vendor body will be rejected the
        // identical way, so replaying the call can only spend money to reach the same conclusion.
        // Remember it briefly (L-1). Best-effort — the same reasoning as the positive-write catch
        // above: failing to record a negative must never change what the caller is told.
        try {
          const expiresAtMs = Date.now() + NEGATIVE_TTL_SECONDS * 1000;
          const entry: NegativeCacheEntry = { __onchainNegative: true, reason, expiresAtMs };
          await this.cache.set(adapter.id, capability, argsHash, entry, NEGATIVE_TTL_SECONDS);
        } catch (cacheError) {
          process.stderr.write(
            `cache.set (negative) failed provider=${adapter.id} capability=${capability}: ${
              cacheError instanceof Error ? cacheError.message : String(cacheError)
            } — the next identical call will pay again\n`,
          );
        }
        tried.push({ adapterId, reason });
      }
    }

    throw new CapabilityUnavailableError({ capability, chain, tried });
  }
}
