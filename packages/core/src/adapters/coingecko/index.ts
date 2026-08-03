import { normalizeAddress } from '../../chain/address.js';
import type { ChainInfo, ChainRegistry } from '../../chain/registry-core.js';
import { loadChainRegistry } from '../../chain/registry.js';
import { throttle as productionThrottle, type Throttle } from '../../net/rate-limit.js';
import { safeFetch } from '../../net/safe-fetch.js';
import {
  truncateVendorText,
  MAX_VENDOR_NAME_LENGTH,
  MAX_VENDOR_SYMBOL_LENGTH,
} from '../truncate-vendor-text.js';
import { adapterRegistrations } from '../../providers.config.js';
import { TokenSchema, type Token } from '../../types/token.js';
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
  /** Chain registry supplying the asset-platform id (TASK-006 R-54). Defaults to the shipped
   * snapshot; injectable for tests. */
  chains?: ChainRegistry;
  /** Injectable throttle, the same seam `blockscout`/`blockchain-info`/`nansen` expose (WI-26).
   * Production omits it and gets the shared singleton; a test passes `createThrottle()` so its
   * bucket is its own and the file's runtime stops depending on what else ran in the process. */
  throttle?: Throttle;
}

/** This adapter's own private hand-off shape from its HTTP step to `normalize()` (never seen by
 * `CapabilityRegistry`, which only ever sees `unknown` — anti-corruption layer, D4). `chain` is
 * carried alongside the untouched response body because the CoinGecko wire response's own
 * `asset_platform_id` field is the token's PRIMARY platform, not necessarily the platform that
 * was actually queried (confirmed live: querying USDC's Solana contract still returns
 * `asset_platform_id: "ethereum"`, since Ethereum is USDC's primary platform) — so the target
 * chain cannot be recovered reliably from the response body alone. */
interface CoingeckoFetchResult {
  chain: ChainInfo;
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

function extractFetchArgs(
  args: Record<string, unknown>,
  chains: ChainRegistry,
): { chain: ChainInfo; address: string } {
  const rawChain = args['chain'];
  const address = args['address'];
  const chain = typeof rawChain === 'string' ? chains.tryResolve(rawChain) : null;
  if (!chain || chain.vendors['coingecko'] == null || typeof address !== 'string') {
    throw new Error(
      `coingecko.fetch: invalid args ${JSON.stringify(args)} (expected {chain: <a chain CoinGecko covers>, address: string})`,
    );
  }
  return { chain, address };
}

/**
 * CoinGecko adapter (ARCHITECTURE.md §3.2/§5.3, R-5): `token.price` + `token.metadata` via
 * `GET /coins/{platform}/contract/{address}` (the platform id comes from `chain.vendors.coingecko`
 * since TASK-006 — it happens to equal our slug for `ethereum`/`solana`, which is what the original
 * live probe confirmed, but not for e.g. `arbitrum` → `arbitrum-one`). Both
 * capabilities are backed by the exact same endpoint (CoinGecko's contract lookup returns price
 * and metadata together), so `normalize()` doesn't branch on `cap` — both ids produce the same
 * canonical `Token`.
 */
export function createCoingeckoAdapter(deps: CoingeckoAdapterDeps = {}): ProviderAdapter {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const env = deps.env ?? process.env;
  const chains = deps.chains ?? loadChainRegistry();
  const throttle = deps.throttle ?? productionThrottle;

  return {
    id: 'coingecko',
    // TASK-006 (R-54): the asset-platform id IS the coverage answer — CoinGecko cannot serve a
    // chain it has no platform for. Reading the registry column keeps the two in step by
    // construction. NOTE: the generator (task 006-2) only fills this column via an exact join key;
    // an ambiguous `native_coin_id` leaves it null rather than guessing, so a false "supported"
    // cannot originate here.
    chainSupport: (chain: ChainInfo): boolean => chain.vendors['coingecko'] != null,
    capabilities: () => [{ id: 'token.price' }, { id: 'token.metadata' }],
    // Keyless/demo tier is free — 0 credits regardless of args.
    costOf: () => ({ credits: 0 }),
    fetch: async (_cap: string, args: Record<string, unknown>): Promise<CoingeckoFetchResult> => {
      const { chain, address } = extractFetchArgs(args, chains);
      // Defensive re-normalization (task 003-4 reviewer note): the caller is expected to have
      // already normalized the address before it ever reaches here, but this adapter's own
      // cache-key-adjacent HTTP step re-normalizes anyway rather than trusting caller discipline.
      const normalizedAddress = normalizeAddress(chain, address);
      // The vendor's asset-platform id, from the registry — not our slug. They coincide for
      // `ethereum`/`solana` (live-probed 2026-07-22) but diverge elsewhere: `arbitrum` is
      // `arbitrum-one` at CoinGecko, `bsc` is `binance-smart-chain`.
      const platformId = chain.vendors['coingecko'] ?? chain.slug;

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
      // **Both path segments are percent-encoded** (vdd-multi cycle 5, M-4) — the sibling adapters
      // `defillama`/`dexscreener` already do this and this one did not. `normalizeAddress` returns
      // its input VERBATIM for a family with no validator (`bitcoin` is `family: other` and carries
      // `vendors.coingecko: "ordinals"`), and `isValidAddress` accepts any 1–128 characters there,
      // so `address: '../../../simple/price?ids=x'` rewrote the path and sent the request — with
      // our API key attached — to a different endpoint of the vendor's API. Not SSRF (the host is
      // fixed in the template), but request forgery inside the vendor's own surface.
      const url = `https://${host}/api/v3/coins/${encodeURIComponent(platformId)}/contract/${encodeURIComponent(normalizedAddress)}`;
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
      const platformId = chain.vendors['coingecko'] ?? chain.slug;
      const detail = body.detail_platforms?.[platformId];
      if (!detail || typeof detail.contract_address !== 'string') {
        throw new Error(`coingecko.normalize: missing detail_platforms.${platformId} in response`);
      }

      const token: Token = {
        chain: chain.slug,
        address: normalizeAddress(chain, detail.contract_address),
        // Vendor-authored, therefore bounded here rather than at `TokenSchema.parse` below
        // (vdd-multi cycle 5, M-6) — see `truncate-vendor-text.ts` for why truncating beats
        // rejecting on a value the token's deployer chose.
        symbol:
          typeof body.symbol === 'string'
            ? // Truncate FIRST, then upper-case (vdd-multi cycle 6, perf): `.toUpperCase()` on the
              // full vendor string is work proportional to attacker-chosen input, performed
              // immediately below the guard that exists to bound exactly that. `safeFetch`'s size
              // cap is `Content-Length`-based and its own docstring concedes chunked bodies are
              // uncapped mid-stream.
              truncateVendorText(body.symbol, MAX_VENDOR_SYMBOL_LENGTH).toUpperCase()
            : '',
        name:
          typeof body.name === 'string'
            ? truncateVendorText(body.name, MAX_VENDOR_NAME_LENGTH)
            : '',
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
