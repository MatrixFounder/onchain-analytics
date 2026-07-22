import { throttle } from '../../net/rate-limit.js';
import { safeFetch } from '../../net/safe-fetch.js';
import { adapterRegistrations } from '../../providers.config.js';
import { PoolSchema, type Pool } from '../../types/pool.js';
import type { ProviderAdapter } from '../types.js';

/** Only these two `Chain` values are supported by this adapter (§3.2 routes) — kept as its own
 * narrower union so `NATIVE_QUERY`'s lookup stays exhaustive/index-safe without a `'dash'` entry
 * that would never be reachable in practice. */
type SupportedChain = 'ethereum' | 'solana';

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
const NATIVE_QUERY: Record<SupportedChain, string> = { ethereum: 'ETH', solana: 'SOL' };

/**
 * Optional constructor dependencies for the DexScreener adapter (injectable, same DI convention
 * as the CoinGecko adapter — see its own docstring). Keyless — no `env` dependency needed.
 */
export interface DexscreenerAdapterDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** This adapter's own private hand-off shape from its HTTP step to `normalize()` — `raw` is the
 * untouched `/latest/dex/search` response body (may contain pairs from OTHER chains too, since
 * the search index isn't chain-scoped server-side); `chain`/`limit` are carried alongside it so
 * `normalize()` can do the actual chain-filtering + slicing (kept there, not in the HTTP step —
 * the "narrowing only inside normalize()" anti-corruption-layer contract, task 003-4 reviewer
 * note). */
interface DexscreenerFetchResult {
  chain: SupportedChain;
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

function extractFetchArgs(args: Record<string, unknown>): { chain: SupportedChain; limit: number } {
  const chain = args['chain'];
  if (chain !== 'ethereum' && chain !== 'solana') {
    throw new Error(
      `dexscreener.fetch: invalid args ${JSON.stringify(args)} (expected {chain: 'ethereum'|'solana', limit?: number})`,
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

  return {
    id: 'dexscreener',
    capabilities: () => [
      { id: 'pairs.new', chains: ['ethereum', 'solana'] },
      { id: 'pool.info', chains: ['ethereum', 'solana'] },
    ],
    costOf: () => ({ credits: 0 }),
    fetch: async (_cap: string, args: Record<string, unknown>): Promise<DexscreenerFetchResult> => {
      const { chain, limit } = extractFetchArgs(args);
      const query = NATIVE_QUERY[chain];
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
      const pairs = (body.pairs ?? []).filter((pair) => pair.chainId === chain).slice(0, limit);

      return pairs.map((pair) => {
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
          throw new Error(`dexscreener.normalize: malformed pair entry ${JSON.stringify(pair)}`);
        }

        const pool: Pool = {
          id: `${chain}:${pairAddress}`,
          chain,
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
        return PoolSchema.parse(pool);
      });
    },
    isAvailable: () => ({ ok: true }),
  };
}
