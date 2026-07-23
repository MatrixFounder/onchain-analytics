import { throttle } from '../../net/rate-limit.js';
import { safeFetch } from '../../net/safe-fetch.js';
import { adapterRegistrations } from '../../providers.config.js';
import type { Chain } from '../../types/chain.js';
import type { ProviderAdapter } from '../types.js';

const REGISTRATION = adapterRegistrations.find((r) => r.id === 'defillama');
if (!REGISTRATION) {
  throw new Error('defillama: no matching entry in adapterRegistrations (providers.config.ts)');
}
const HOSTS = REGISTRATION.hosts;
const RATE_LIMIT = REGISTRATION.rateLimit;

/** Only these two `Chain` values are supported by this adapter (§3.2 routes) — kept as its own
 * narrower union so `CHAIN_TVL_KEY`'s lookup stays exhaustive/index-safe without a `'dash'` entry
 * that would never be reachable in practice. */
type SupportedChain = 'ethereum' | 'solana';

/** DeFiLlama's `chainTvls` keys are display names ("Ethereum"/"Solana"), not our lowercase
 * `Chain` values — confirmed by a live probe of `/protocol/uniswap` and `/protocol/raydium`
 * (2026-07-22), not assumed. */
const CHAIN_TVL_KEY: Record<SupportedChain, string> = {
  ethereum: 'Ethereum',
  solana: 'Solana',
};

/**
 * Not one of the six canonical zod types (`types/*`) — a plain object shape, copied literally
 * from ARCHITECTURE.md §3.2/§5.1's `onchain_protocol_tvl` contract. Introducing a new zod schema
 * for it isn't in this task's scope (architecture doesn't define one; adding one would be an
 * unrequested architectural addition, developer-guidelines §1.6).
 */
export interface ProtocolTvlResult {
  protocol: string;
  chain: Chain;
  tvlUsd: number;
  totalTvlUsd: number;
  source: string;
  fetchedAt: number;
}

/**
 * Optional constructor dependencies for the DeFiLlama adapter (injectable, same DI convention as
 * the CoinGecko adapter — see its own docstring). Keyless — no `env` dependency needed.
 */
export interface DefillamaAdapterDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** This adapter's own private hand-off shape from its HTTP step to `normalize()` — `raw` is the
 * untouched `/protocol/{slug}` response body (the FULL multi-chain payload); `chain` is carried
 * alongside it because the response has no field identifying "which chain the caller asked
 * for" — only `normalize()` does the `chainTvls[chain]` slice (ARCHITECTURE.md §3.2). */
interface DefillamaFetchResult {
  chain: SupportedChain;
  raw: unknown;
}

interface DefillamaTvlPoint {
  date?: unknown;
  totalLiquidityUSD?: unknown;
}

interface DefillamaProtocolResponse {
  name?: unknown;
  chainTvls?: Record<string, { tvl?: DefillamaTvlPoint[] }>;
  tvl?: DefillamaTvlPoint[];
}

function extractFetchArgs(args: Record<string, unknown>): {
  chain: SupportedChain;
  protocolSlug: string;
} {
  const chain = args['chain'];
  const protocolSlug = args['protocolSlug'];
  if ((chain !== 'ethereum' && chain !== 'solana') || typeof protocolSlug !== 'string') {
    throw new Error(
      `defillama.fetch: invalid args ${JSON.stringify(args)} (expected {chain: 'ethereum'|'solana', protocolSlug: string})`,
    );
  }
  return { chain, protocolSlug };
}

function lastTotalLiquidityUsd(series: DefillamaTvlPoint[] | undefined): number | undefined {
  const lastPoint = series?.[series.length - 1];
  return typeof lastPoint?.totalLiquidityUSD === 'number' ? lastPoint.totalLiquidityUSD : undefined;
}

/**
 * DeFiLlama adapter (ARCHITECTURE.md §3.2/§5.3, R-7): `protocol.tvl` via
 * `GET /protocol/{slug}`, sliced to `chainTvls[chain]` for the chain-specific TVL and the
 * top-level `tvl` series for the protocol-wide total.
 */
export function createDefillamaAdapter(deps: DefillamaAdapterDeps = {}): ProviderAdapter {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;

  return {
    id: 'defillama',
    capabilities: () => [{ id: 'protocol.tvl', chains: ['ethereum', 'solana'] }],
    costOf: () => ({ credits: 0 }),
    fetch: async (_cap: string, args: Record<string, unknown>): Promise<DefillamaFetchResult> => {
      const { chain, protocolSlug } = extractFetchArgs(args);
      const url = `https://api.llama.fi/protocol/${encodeURIComponent(protocolSlug)}`;

      await throttle('defillama', RATE_LIMIT);
      const response = await safeFetch(url, {}, HOSTS, fetchImpl);
      if (!response.ok) {
        throw new Error(`defillama: HTTP ${response.status} for ${url}`);
      }
      const raw: unknown = await response.json();
      return { chain, raw };
    },
    normalize: (_cap: string, rawResult: unknown): ProtocolTvlResult => {
      const { chain, raw } = rawResult as DefillamaFetchResult;
      const body = raw as DefillamaProtocolResponse;

      const chainKey = CHAIN_TVL_KEY[chain];
      const tvlUsd = lastTotalLiquidityUsd(body.chainTvls?.[chainKey]?.tvl);
      const totalTvlUsd = lastTotalLiquidityUsd(body.tvl);
      if (tvlUsd === undefined || totalTvlUsd === undefined || typeof body.name !== 'string') {
        throw new Error(`defillama.normalize: missing tvl series for chain ${chain}`);
      }
      // Adversarial cycle 2, finding 1b: a bad vendor value (negative, NaN, +/-Infinity) must
      // never be cached as a "successful" ProtocolTvlResult — `onchain_protocol_tvl`'s own output
      // schema already rejects a negative tvlUsd/totalTvlUsd (`.nonnegative()`), but by then it
      // would already have been written to the cache as this adapter's "normalized" result. Loudly
      // reject it HERE instead, before it's ever cached.
      if (
        !Number.isFinite(tvlUsd) ||
        tvlUsd < 0 ||
        !Number.isFinite(totalTvlUsd) ||
        totalTvlUsd < 0
      ) {
        throw new Error(
          `defillama.normalize: invalid tvl value(s) for chain ${chain} (tvlUsd=${tvlUsd}, totalTvlUsd=${totalTvlUsd})`,
        );
      }

      return {
        protocol: body.name,
        chain,
        tvlUsd,
        totalTvlUsd,
        source: 'defillama',
        fetchedAt: now(),
      };
    },
    isAvailable: () => ({ ok: true }),
  };
}
