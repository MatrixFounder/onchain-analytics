import { normalizeAddress } from '../../chain/address.js';
import { throttle } from '../../net/rate-limit.js';
import { safeFetch } from '../../net/safe-fetch.js';
import { adapterRegistrations } from '../../providers.config.js';
import { TokenSchema, type Token } from '../../types/token.js';
import type { Chain } from '../../types/chain.js';
import type { ProviderAdapter } from '../types.js';

const REGISTRATION = adapterRegistrations.find((r) => r.id === 'coingecko');
if (!REGISTRATION) {
  throw new Error('coingecko: no matching entry in adapterRegistrations (providers.config.ts)');
}
const HOSTS = REGISTRATION.hosts;
const RATE_LIMIT = REGISTRATION.rateLimit;

/**
 * Optional constructor dependencies for the CoinGecko adapter (injectable — mirrors the
 * `fetchImpl`/`now`/`env` DI convention already established in this package: `safeFetch`'s
 * `fetchImpl` param, `createThrottle`'s `deps.now`, `resolveDataDir`'s `env` param, tasks 003-2/
 * 003-3). `env` is read only inside the adapter's own HTTP-call step (never at module load,
 * never logged, never folded into a cache key — ARCHITECTURE.md §7.2/§3.2); `now` lets
 * fixture-based golden tests assert an exact, deterministic `fetchedAt` instead of the real
 * wall clock.
 */
export interface CoingeckoAdapterDeps {
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** This adapter's own private hand-off shape from its HTTP step to `normalize()` (never seen by
 * `CapabilityRegistry`, which only ever sees `unknown` — anti-corruption layer, D4). `chain` is
 * carried alongside the untouched response body because the CoinGecko wire response's own
 * `asset_platform_id` field is the token's PRIMARY platform, not necessarily the platform that
 * was actually queried (confirmed live: querying USDC's Solana contract still returns
 * `asset_platform_id: "ethereum"`, since Ethereum is USDC's primary platform) — so the target
 * chain cannot be recovered reliably from the response body alone. */
interface CoingeckoFetchResult {
  chain: Chain;
  raw: unknown;
}

/** The handful of CoinGecko `/coins/{platform}/contract/{address}` response fields this adapter
 * actually reads (the real response carries dozens more — community_data, tickers, etc. — none
 * of which this adapter's canonical Token needs). */
interface CoingeckoContractResponse {
  symbol?: unknown;
  name?: unknown;
  detail_platforms?: Record<string, { contract_address?: unknown; decimal_place?: unknown }>;
  market_data?: {
    current_price?: { usd?: unknown };
    market_cap?: { usd?: unknown };
  };
}

function extractFetchArgs(args: Record<string, unknown>): { chain: Chain; address: string } {
  const chain = args['chain'];
  const address = args['address'];
  if ((chain !== 'ethereum' && chain !== 'solana') || typeof address !== 'string') {
    throw new Error(
      `coingecko.fetch: invalid args ${JSON.stringify(args)} (expected {chain: 'ethereum'|'solana', address: string})`,
    );
  }
  return { chain, address };
}

/**
 * CoinGecko adapter (ARCHITECTURE.md §3.2/§5.3, R-5): `token.price` + `token.metadata` via
 * `GET /coins/{platform}/contract/{address}` (platform id === our `Chain` value literally for
 * both `ethereum` and `solana` — confirmed by a live probe, not assumed, 2026-07-22). Both
 * capabilities are backed by the exact same endpoint (CoinGecko's contract lookup returns price
 * and metadata together), so `normalize()` doesn't branch on `cap` — both ids produce the same
 * canonical `Token`.
 */
export function createCoingeckoAdapter(deps: CoingeckoAdapterDeps = {}): ProviderAdapter {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const env = deps.env ?? process.env;

  return {
    id: 'coingecko',
    capabilities: () => [
      { id: 'token.price', chains: ['ethereum', 'solana'] },
      { id: 'token.metadata', chains: ['ethereum', 'solana'] },
    ],
    // Keyless/demo tier is free — 0 credits regardless of args.
    costOf: () => ({ credits: 0 }),
    fetch: async (_cap: string, args: Record<string, unknown>): Promise<CoingeckoFetchResult> => {
      const { chain, address } = extractFetchArgs(args);
      // Defensive re-normalization (task 003-4 reviewer note): the caller is expected to have
      // already normalized the address before it ever reaches here, but this adapter's own
      // cache-key-adjacent HTTP step re-normalizes anyway rather than trusting caller discipline.
      const normalizedAddress = normalizeAddress(chain, address);

      // CoinGecko has TWO disjoint auth contours (live-probed 2026-07-23: the pro host ignores
      // `x-cg-demo-api-key` entirely — still "API Key Missing" — and only recognizes
      // `x-cg-pro-api-key`): keyless/demo → api.coingecko.com (+ demo header when a key is set),
      // Pro subscription → pro-api.coingecko.com + pro header. Both hosts are in this adapter's
      // SSRF allowlist (providers.config.ts). Which contour applies is declared by WHICH env var
      // is set — never sniffed from the key's format (both tiers issue `CG-…`-shaped keys, so a
      // format heuristic cannot distinguish them; vendor-drift discipline). When both are set,
      // the paid pro key wins. Keys are optional, read here inside the HTTP step, never at
      // module load and never part of a cache key (ARCHITECTURE.md §7.2).
      const proApiKey = env['COINGECKO_PRO_API_KEY'];
      const demoApiKey = env['COINGECKO_API_KEY'];
      const host = proApiKey ? 'pro-api.coingecko.com' : 'api.coingecko.com';
      const url = `https://${host}/api/v3/coins/${chain}/contract/${normalizedAddress}`;
      const headers: Record<string, string> = proApiKey
        ? { 'x-cg-pro-api-key': proApiKey }
        : demoApiKey
          ? { 'x-cg-demo-api-key': demoApiKey }
          : {};

      await throttle('coingecko', RATE_LIMIT);
      const response = await safeFetch(url, { headers }, HOSTS, fetchImpl);
      if (!response.ok) {
        throw new Error(`coingecko: HTTP ${response.status} for ${url}`);
      }
      const raw: unknown = await response.json();
      return { chain, raw };
    },
    normalize: (_cap: string, rawResult: unknown): Token => {
      const { chain, raw } = rawResult as CoingeckoFetchResult;
      const body = raw as CoingeckoContractResponse;
      const detail = body.detail_platforms?.[chain];
      if (!detail || typeof detail.contract_address !== 'string') {
        throw new Error(`coingecko.normalize: missing detail_platforms.${chain} in response`);
      }

      const token: Token = {
        chain,
        address: normalizeAddress(chain, detail.contract_address),
        symbol: typeof body.symbol === 'string' ? body.symbol.toUpperCase() : '',
        name: typeof body.name === 'string' ? body.name : '',
        source: 'coingecko',
        fetchedAt: now(),
        ...(typeof detail.decimal_place === 'number' ? { decimals: detail.decimal_place } : {}),
        ...(typeof body.market_data?.current_price?.usd === 'number'
          ? { priceUsd: body.market_data.current_price.usd }
          : {}),
        ...(typeof body.market_data?.market_cap?.usd === 'number'
          ? { marketCapUsd: body.market_data.market_cap.usd }
          : {}),
      };
      return TokenSchema.parse(token);
    },
    // Keyless/demo tier always works — no env precondition to check.
    isAvailable: () => ({ ok: true }),
  };
}
