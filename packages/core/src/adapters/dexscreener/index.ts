import { throttle } from '../../net/rate-limit.js';
import type { ChainInfo, ChainRegistry } from '../../chain/registry-core.js';
import { loadChainRegistry } from '../../chain/registry.js';
import { safeFetch } from '../../net/safe-fetch.js';
import { adapterRegistrations } from '../../providers.config.js';
import { PoolSchema, type Pool } from '../../types/pool.js';
import type { ProviderAdapter } from '../types.js';

const REGISTRATION = adapterRegistrations.find((r) => r.id === 'dexscreener');
if (!REGISTRATION) {
  throw new Error('dexscreener: no matching entry in adapterRegistrations (providers.config.ts)');
}
const HOSTS = REGISTRATION.hosts;
const RATE_LIMIT = REGISTRATION.rateLimit;

const DEFAULT_LIMIT = 10;

/**
 * There is no keyless DexScreener endpoint that lists "newest pairs for chain X" directly
 * (confirmed by a live probe of `/token-profiles/latest/v1` and `/token-boosts/latest/v1` —
 * neither carries liquidity/volume data, and neither accepts a chain filter). The confirmed,
 * reliable, keyless endpoint that DOES carry full `Pool`-shaped fields and can be scoped to one
 * chain client-side is `GET /latest/dex/search?q=<query>`; querying by the chain's own native
 * asset symbol reliably surfaces that chain's pairs (§11 open question, resolved by live probe
 * 2026-07-22 — not guessed). Documented implementation choice (developer-guidelines §1.6).
 */
// TASK-006 (R-57a): the native symbol comes from `chain.nativeSymbol` in the registry, replacing
// the two-entry `NATIVE_QUERY = {ethereum:'ETH', solana:'SOL'}` map. A chain whose symbol the
// registry does not know is honestly uncovered (see `chainSupport`) rather than searched for with
// a guessed query string.

/**
 * Optional constructor dependencies for the DexScreener adapter (injectable, same DI convention
 * as the CoinGecko adapter — see its own docstring). Keyless — no `env` dependency needed.
 */
export interface DexscreenerAdapterDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Chain registry supplying `nativeSymbol` + the observed DexScreener chainId (TASK-006 R-54). */
  chains?: ChainRegistry;
}

/** This adapter's own private hand-off shape from its HTTP step to `normalize()` — `raw` is the
 * untouched `/latest/dex/search` response body (may contain pairs from OTHER chains too, since
 * the search index isn't chain-scoped server-side); `chain`/`limit` are carried alongside it so
 * `normalize()` can do the actual chain-filtering + slicing (kept there, not in the HTTP step —
 * the "narrowing only inside normalize()" anti-corruption-layer contract, task 003-4 reviewer
 * note). */
interface DexscreenerFetchResult {
  chain: ChainInfo;
  limit: number;
  raw: unknown;
}

interface DexscreenerPair {
  chainId?: unknown;
  dexId?: unknown;
  pairAddress?: unknown;
  baseToken?: { symbol?: unknown };
  quoteToken?: { symbol?: unknown };
  liquidity?: { usd?: unknown };
  volume?: { h24?: unknown };
  pairCreatedAt?: unknown;
}

interface DexscreenerSearchResponse {
  pairs?: DexscreenerPair[];
}

function extractFetchArgs(
  args: Record<string, unknown>,
  chains: ChainRegistry,
): { chain: ChainInfo; limit: number } {
  const rawChain = args['chain'];
  const chain = typeof rawChain === 'string' ? chains.tryResolve(rawChain) : null;
  if (!chain || chain.vendors['dexscreener'] == null || chain.nativeSymbol == null) {
    throw new Error(
      `dexscreener.fetch: invalid args ${JSON.stringify(args)} (expected {chain: <a chain observed on DexScreener>, limit?: number})`,
    );
  }
  const rawLimit = args['limit'];
  const limit = typeof rawLimit === 'number' && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;
  return { chain, limit };
}

/**
 * DexScreener adapter (ARCHITECTURE.md §3.2/§5.3, R-6): `pairs.new` + `pool.info`, both backed by
 * the same search-based HTTP step (dexscreener has no tool consumer for `pool.info` yet in M1 —
 * cheap to declare the capability now regardless, per architecture review cycle 1).
 */
export function createDexscreenerAdapter(deps: DexscreenerAdapterDeps = {}): ProviderAdapter {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const chains = deps.chains ?? loadChainRegistry();

  return {
    id: 'dexscreener',
    // TASK-006 (R-54/R-57): DexScreener publishes no chain catalog, so `vendors.dexscreener` is an
    // OBSERVED value (task 006-2) — non-null means we have actually seen that chainId in a
    // response. `nativeSymbol` is required too because the keyless search endpoint is queried by
    // native symbol; without one there is no query to make.
    chainSupport: (chain: ChainInfo): boolean =>
      chain.vendors['dexscreener'] != null && chain.nativeSymbol != null,
    capabilities: () => [{ id: 'pairs.new' }, { id: 'pool.info' }],
    costOf: () => ({ credits: 0 }),
    fetch: async (_cap: string, args: Record<string, unknown>): Promise<DexscreenerFetchResult> => {
      const { chain, limit } = extractFetchArgs(args, chains);
      const query = chain.nativeSymbol ?? chain.slug;
      const url = `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(query)}`;

      await throttle('dexscreener', RATE_LIMIT);
      const response = await safeFetch(url, {}, HOSTS, fetchImpl);
      if (!response.ok) {
        throw new Error(`dexscreener: HTTP ${response.status} for ${url}`);
      }
      const raw: unknown = await response.json();
      return { chain, limit, raw };
    },
    normalize: (_cap: string, rawResult: unknown): Pool[] => {
      const { chain, limit, raw } = rawResult as DexscreenerFetchResult;
      const body = raw as DexscreenerSearchResponse;
      const candidates = (body.pairs ?? [])
        .filter((pair) => pair.chainId === (chain.vendors['dexscreener'] ?? chain.slug))
        .slice(0, limit);

      // Adversarial cycle 1, fix G — explicit degradation instead of an all-or-nothing throw:
      // one malformed pair in an otherwise-good batch used to fail the ENTIRE onchain_new_pairs
      // call. Each candidate is validated independently (a manual type-narrowing guard, since the
      // wire fields are `unknown`, followed by `PoolSchema.safeParse` as the canonical contract
      // check); a malformed one is DROPPED, not thrown, and counted. Only if EVERY candidate in
      // this batch turns out malformed does this still throw (an empty result would otherwise
      // look identical to "no new pairs right now" — a silent, misleading success).
      const pools: Pool[] = [];
      let malformedCount = 0;

      for (const pair of candidates) {
        const pairAddress = pair.pairAddress;
        const dexId = pair.dexId;
        const baseSymbol = pair.baseToken?.symbol;
        const quoteSymbol = pair.quoteToken?.symbol;
        if (
          typeof pairAddress !== 'string' ||
          typeof dexId !== 'string' ||
          typeof baseSymbol !== 'string' ||
          typeof quoteSymbol !== 'string'
        ) {
          malformedCount += 1;
          continue;
        }

        const pool: Pool = {
          id: `${chain.slug}:${pairAddress}`,
          chain: chain.slug,
          dexId,
          baseTokenSymbol: baseSymbol,
          quoteTokenSymbol: quoteSymbol,
          pairAddress,
          source: 'dexscreener',
          fetchedAt: now(),
          ...(typeof pair.pairCreatedAt === 'number' ? { createdAt: pair.pairCreatedAt } : {}),
          ...(typeof pair.liquidity?.usd === 'number' ? { liquidityUsd: pair.liquidity.usd } : {}),
          ...(typeof pair.volume?.h24 === 'number' ? { volume24hUsd: pair.volume.h24 } : {}),
        };
        const parsed = PoolSchema.safeParse(pool);
        if (!parsed.success) {
          malformedCount += 1;
          continue;
        }
        pools.push(parsed.data);
      }

      if (malformedCount > 0) {
        process.stderr.write(
          `dexscreener.normalize: skipped ${malformedCount} malformed pair(s) of ${candidates.length} for chain=${chain}\n`,
        );
      }

      if (candidates.length > 0 && pools.length === 0) {
        throw new Error(
          `dexscreener.normalize: all ${candidates.length} candidate pair(s) for chain=${chain} were malformed`,
        );
      }

      return pools;
    },
    isAvailable: () => ({ ok: true }),
  };
}
