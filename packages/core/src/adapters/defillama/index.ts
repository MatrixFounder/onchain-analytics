import { throttle } from '../../net/rate-limit.js';
import type { ChainInfo, ChainRegistry } from '../../chain/registry-core.js';
import { loadChainRegistry } from '../../chain/registry.js';
import { safeFetch } from '../../net/safe-fetch.js';
import { CapabilityNotCoveredOnChainError } from '../../chain/errors.js';
import { adapterRegistrations } from '../../providers.config.js';
import type { ProviderAdapter } from '../types.js';

const REGISTRATION = adapterRegistrations.find((r) => r.id === 'defillama');
if (!REGISTRATION) {
  throw new Error('defillama: no matching entry in adapterRegistrations (providers.config.ts)');
}
const HOSTS = REGISTRATION.hosts;
const RATE_LIMIT = REGISTRATION.rateLimit;

/** DeFiLlama's `chainTvls` keys are display names ("Ethereum"/"Solana"), not our lowercase slugs —
 * confirmed by a live probe of `/protocol/uniswap` and `/protocol/raydium` (2026-07-22), not
 * assumed. TASK-006 (task 006-5) replaced the two-entry `CHAIN_TVL_KEY` map with
 * `chain.vendors.defillama`, which carries the same display name for all 458 registry chains
 * instead of two. */

/**
 * Not one of the six canonical zod types (`types/*`) — a plain object shape, copied literally
 * from ARCHITECTURE.md §3.2/§5.1's `onchain_protocol_tvl` contract. Introducing a new zod schema
 * for it isn't in this task's scope (architecture doesn't define one; adding one would be an
 * unrequested architectural addition, developer-guidelines §1.6).
 */
/**
 * `chain.tvl` result (TASK-006 task 006-7, R-53). A SEPARATE contract from `ProtocolTvlResult`,
 * not a variant of it: a chain has no notion of `totalTvlUsd` (there is nothing to total across),
 * and the source endpoint differs (`/v2/chains` vs `/protocol/{slug}`). Folding them into one
 * shape would need a parameter that changes the meaning of every other field.
 */
export interface ChainTvlResult {
  chain: string;
  name: string;
  tvlUsd: number;
  source: string;
  fetchedAt: number;
}

export interface ProtocolTvlResult {
  protocol: string;
  /** The chain's canonical SLUG. Widened from the closed `Chain` enum in TASK-006 (task 006-5) —
   * the vocabulary lives in the registry now, not in a type literal. */
  chain: string;
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
  /** Chain registry this adapter reads vendor naming from (TASK-006 R-54). Defaults to the shipped
   * snapshot; injectable so tests can drive a synthetic registry. */
  chains?: ChainRegistry;
}

/** This adapter's own private hand-off shape from its HTTP step to `normalize()` — `raw` is the
 * untouched `/protocol/{slug}` response body (the FULL multi-chain payload); `chain` is carried
 * alongside it because the response has no field identifying "which chain the caller asked
 * for" — only `normalize()` does the `chainTvls[chain]` slice (ARCHITECTURE.md §3.2). */
interface DefillamaFetchResult {
  chain: ChainInfo;
  raw: unknown;
  /** `chain.tvl` only: when the shared `/v2/chains` catalog this row came from was actually
   * fetched. Present so `normalize()` reports the DATA's age rather than its own (vdd-multi
   * cycle 6, M-1). Absent for `protocol.tvl`, which fetches per call. */
  fetchedAt?: number;
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

const CHAINS_URL = 'https://api.llama.fi/v2/chains';

/** One row of DeFiLlama's `/v2/chains` list — only the fields this adapter reads. */
interface DefillamaChainRow {
  name?: unknown;
  tvl?: unknown;
}

function extractChainArg(args: Record<string, unknown>, chains: ChainRegistry): ChainInfo {
  const rawChain = args['chain'];
  const chain = typeof rawChain === 'string' ? chains.tryResolve(rawChain) : null;
  if (!chain || chain.vendors['defillama'] == null) {
    throw new Error(
      `defillama.fetch(chain.tvl): invalid args ${JSON.stringify(args)} (expected {chain: <a chain DeFiLlama covers>})`,
    );
  }
  return chain;
}

function normalizeChainTvl(chain: ChainInfo, raw: unknown, fetchedAt: number): ChainTvlResult {
  const vendorName = chain.vendors['defillama'] ?? chain.name;
  const rows = Array.isArray(raw) ? (raw as DefillamaChainRow[]) : [];
  const row = rows.find((candidate) => candidate.name === vendorName);
  if (!row) {
    // NOT a retryable failure (vdd-multi cycle 6, logic L-9). The registry is DELIBERATELY stale
    // (it is a build artifact), so a row the vendor no longer lists is a normal consequence of
    // that design, not an outage — and reporting it as `CapabilityUnavailableError` tells the
    // agent to retry a call that will fail identically until the next registry sync, and
    // negative-caches that verdict on the way.
    throw new CapabilityNotCoveredOnChainError({
      capability: 'chain.tvl',
      chain: chain.slug,
      availableChains: [],
      hint: `DeFiLlama no longer lists '${vendorName}'; the chain registry snapshot is older than the vendor's catalog.`,
    });
  }
  const tvlUsd = row.tvl;
  // Same guard as `protocol.tvl` (adversarial cycle 2, finding 1b): a bad vendor value must be
  // rejected HERE, before it can be written to the cache as a "successful" result — otherwise the
  // output schema rejects it later, after it is already memoized.
  if (typeof tvlUsd !== 'number' || !Number.isFinite(tvlUsd) || tvlUsd < 0) {
    throw new Error(
      `defillama.normalize(chain.tvl): invalid tvl for '${vendorName}' (tvlUsd=${String(tvlUsd)})`,
    );
  }
  return { chain: chain.slug, name: chain.name, tvlUsd, source: 'defillama', fetchedAt };
}

function extractFetchArgs(
  args: Record<string, unknown>,
  chains: ChainRegistry,
): { chain: ChainInfo; protocolSlug: string } {
  const rawChain = args['chain'];
  const protocolSlug = args['protocolSlug'];
  const chain = typeof rawChain === 'string' ? chains.tryResolve(rawChain) : null;
  // `vendors.defillama === null` means this vendor has no such chain at all — a fact of the
  // registry, not of this call. It is the same condition `chainSupport()` reports, so reaching
  // here with it set can only mean the coverage gate was bypassed.
  if (!chain || chain.vendors['defillama'] == null || typeof protocolSlug !== 'string') {
    throw new Error(
      `defillama.fetch: invalid args ${JSON.stringify(args)} (expected {chain: <a chain DeFiLlama covers>, protocolSlug: string})`,
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
  const chains = deps.chains ?? loadChainRegistry();

  /**
   * One shared, short-lived copy of `/v2/chains` (vdd-multi cycle 5, L-9).
   *
   * `chain.tvl` reads ONE row out of a catalog that carries all 458, but the `CapabilityRegistry`
   * cache is keyed per chain — so the engine's own cache cannot deduplicate this, and asking for
   * the TVL of ten chains downloaded the identical document ten times. TASK-006 turned that from a
   * two-chain curiosity into a 458-chain one.
   *
   * Per adapter INSTANCE, never a module singleton (ARCHITECTURE.md §8) — the same shape as
   * `nansen`'s `accountState`/`singleflight`. The window matches `chain.tvl`'s own cache TTL
   * (`cache/ttl.ts`: 300 s), so this can never serve data staler than what the cache would have
   * returned anyway. The promise is stored, not just its value, so concurrent callers share one
   * in-flight request instead of racing; a rejection is cleared so the next call retries.
   */
  let chainsCatalog: { at: number; body: Promise<unknown> } | null = null;
  const CHAINS_CATALOG_TTL_MS = 300_000;

  const fetchChainsCatalog = async (): Promise<{ body: unknown; fetchedAt: number }> => {
    const cached = chainsCatalog;
    if (cached && now() - cached.at < CHAINS_CATALOG_TTL_MS) {
      return { body: await cached.body, fetchedAt: cached.at };
    }
    const body = (async (): Promise<unknown> => {
      await throttle('defillama', RATE_LIMIT);
      const response = await safeFetch(CHAINS_URL, {}, HOSTS, fetchImpl);
      if (!response.ok) throw new Error(`defillama: HTTP ${response.status} for ${CHAINS_URL}`);
      return (await response.json()) as unknown;
    })();
    const entry = { at: now(), body };
    chainsCatalog = entry;
    // A failed fetch must not be remembered for 5 minutes — that would turn one blip into a
    // self-inflicted outage, the same reasoning `registry.ts` uses for never negative-caching a
    // `fetch()` failure. Only evict if this entry is still the current one.
    body.catch(() => {
      if (chainsCatalog === entry) chainsCatalog = null;
    });
    return { body: await body, fetchedAt: entry.at };
  };

  return {
    id: 'defillama',
    // TASK-006 (R-54): "does DeFiLlama know this chain" is a fact the registry already records —
    // reading it here means the answer cannot drift from the data, unlike a second hand-kept list.
    chainSupport: (chain: ChainInfo): boolean => chain.vendors['defillama'] != null,
    // No `chains` narrowing: the chain dimension is the coverage matrix's job now (§4.2.3).
    capabilities: () => [{ id: 'protocol.tvl' }, { id: 'chain.tvl' }],
    costOf: () => ({ credits: 0 }),
    fetch: async (cap: string, args: Record<string, unknown>): Promise<DefillamaFetchResult> => {
      if (cap === 'chain.tvl') {
        const chain = extractChainArg(args, chains);
        // `fetchedAt` is the CATALOG's timestamp, not `normalize()`'s (vdd-multi cycle 6, M-1).
        // Two windows in series do not compose into one: a catalog fetched at t=0 and served to a
        // new chain at t=299 s was then cached under `chain.tvl`'s own 300 s TTL, so a caller at
        // t=598 s received 598-second-old TVL while every freshness signal it can read — `ageMs`
        // and `fetchedAt` — claimed ≤300 s. Reporting the catalog's own age makes the staleness
        // visible rather than removing it.
        const catalog = await fetchChainsCatalog();
        return { chain, raw: catalog.body, fetchedAt: catalog.fetchedAt };
      }
      const { chain, protocolSlug } = extractFetchArgs(args, chains);
      const url = `https://api.llama.fi/protocol/${encodeURIComponent(protocolSlug)}`;

      await throttle('defillama', RATE_LIMIT);
      const response = await safeFetch(url, {}, HOSTS, fetchImpl);
      if (!response.ok) {
        throw new Error(`defillama: HTTP ${response.status} for ${url}`);
      }
      const raw: unknown = await response.json();
      return { chain, raw };
    },
    normalize: (cap: string, rawResult: unknown): ProtocolTvlResult | ChainTvlResult => {
      const { chain, raw, fetchedAt } = rawResult as DefillamaFetchResult;
      if (cap === 'chain.tvl') return normalizeChainTvl(chain, raw, fetchedAt ?? now());
      const body = raw as DefillamaProtocolResponse;

      const chainKey = chain.vendors['defillama'] ?? chain.name;
      const tvlUsd = lastTotalLiquidityUsd(body.chainTvls?.[chainKey]?.tvl);
      const totalTvlUsd = lastTotalLiquidityUsd(body.tvl);
      if (tvlUsd === undefined || totalTvlUsd === undefined || typeof body.name !== 'string') {
        throw new Error(`defillama.normalize: missing tvl series for chain ${chain.slug}`);
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
          `defillama.normalize: invalid tvl value(s) for chain ${chain.slug} (tvlUsd=${tvlUsd}, totalTvlUsd=${totalTvlUsd})`,
        );
      }

      return {
        protocol: body.name,
        chain: chain.slug,
        tvlUsd,
        totalTvlUsd,
        source: 'defillama',
        fetchedAt: now(),
      };
    },
    isAvailable: () => ({ ok: true }),
  };
}
