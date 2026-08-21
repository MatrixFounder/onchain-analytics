import { throttle as productionThrottle, type Throttle } from '../../net/rate-limit.js';
import { DEXSCREENER_CHAIN_COVERAGE } from './chain-coverage.js';
import type { ChainInfo, ChainRegistry } from '../../chain/registry-core.js';
import { loadChainRegistry } from '../../chain/registry.js';
import { safeFetch } from '../../net/safe-fetch.js';
import { truncateVendorText, MAX_VENDOR_SYMBOL_LENGTH } from '../truncate-vendor-text.js';
import { adapterRegistrations } from '../../providers.config.js';
import { PoolSchema, type Pool } from '../../types/pool.js';
import type { ProviderAdapter } from '../types.js';
import { createFeeTierReader, type FeeTierReading } from '../rpc-evm/fee-tier.js';

const REGISTRATION = adapterRegistrations.find((r) => r.id === 'dexscreener');
if (!REGISTRATION) {
  throw new Error('dexscreener: no matching entry in adapterRegistrations (providers.config.ts)');
}
const HOSTS = REGISTRATION.hosts;
const RATE_LIMIT = REGISTRATION.rateLimit;

const DEFAULT_LIMIT = 10;

/**
 * L-14 — the size of one `/latest/dex/search` page, **measured, not assumed**.
 *
 * The vendor publishes no page-size contract, and a constant guessed from a single sample is the
 * L-11 defect class (a number nobody probed, keyed into a branch that then never fires). Probe of
 * 2026-08-11: `q` in `{BERA, ETH, SOL, AVAX, MATIC, USDC, HOLD}` returned **exactly 30** rows every
 * time, and `q=zzzqqxunlikely9` returned **0** — so 30 is a CAP, not a fixed-size response padded
 * out. Evidence: `test/fixtures/dexscreener/page-size.evidence.md`.
 *
 * Used only as "the page came back full, therefore rows beyond it exist and were never sent". If
 * the vendor raises the cap, a full page still reads as full and the signal stays correct; if it
 * lowers the cap, the check goes quiet and the regression test that pins 30 fails loudly.
 */
const VENDOR_PAGE_SIZE = 30;

/**
 * The page cap of the two `token.pools` routes — MEASURED for them, task 014-32d.
 *
 * It equals `VENDOR_PAGE_SIZE` today and is a separate constant on purpose. That number was
 * measured on `/latest/dex/search`, a route that takes a `q` parameter these two do not have, and
 * reusing it would state a measurement that was never taken on this route — the substitution the
 * task forbids by name. If the vendor moves one cap and not the other, two constants report it and
 * one hides it.
 *
 * Evidence: `docs/onchain-analytics/raw/dexscreener-token-routes-2026-08-21.json`. WETH and USDC on
 * `ethereum` and WBNB on `bsc` return 30 rows on both routes; `osBGT` on `berachain` returns 6; and
 * the CONTROL — a well-formed address nothing deploys — returns 0 on both, which is what makes a
 * 30-row answer readable as a cap rather than as a fixed-size response.
 */
const TOKEN_ROUTE_PAGE_SIZE = 30;

/**
 * There is no keyless DexScreener endpoint that lists the pairs of a chain — re-confirmed by probe,
 * 2026-08-20/21 (task 014-32c, L-19).
 *
 * `/latest/dex/pairs/{chainId}`, `/token-pairs/v1/{chainId}`, `/latest/dex/chains/{chainId}` and
 * `/latest/dex/chains` all answer **HTTP 404**; the two per-chain routes that DO exist
 * (`/token-pairs/v1/{chainId}/{tokenAddress}`, `/latest/dex/pairs/{chainId}/{pairId}`) each need an
 * address the caller of this capability does not have. The promotion feeds (`/token-boosts/*`,
 * `/token-profiles/latest/v1`) carry a `chainId` but no liquidity and no volume, cap at 30 rows, and
 * are ranked by who paid.
 *
 * So this capability is served by SEARCHING one global relevance index and filtering the rows by
 * `chainId`. Every implementation of it is a query heuristic, and the only question that can be
 * settled is WHICH heuristic — which is what the probe settled.
 *
 * ## L-19 — why the query is no longer the native symbol
 *
 * It was `chain.nativeSymbol`, and on a chain whose ticker does not rank on itself the filter had
 * nothing left to keep: the tool answered an EMPTY page with HTTP 200, a false statement about the
 * chain. Measured over all 49 covered chains, 2026-08-21
 * (`docs/onchain-analytics/raw/dexscreener-pairs-strategy-2026-08-21.json`):
 *
 * | query | chains answering with ≥1 of their own rows | rows found |
 * | :---- | :---------------------------------------- | ---------: |
 * | `nativeSymbol` (the old strategy) | **27 / 49** | 239 |
 * | `slug` | 43 / 49 | 566 |
 * | `name` | 45 / 49 | 594 |
 * | **`vendors.dexscreener`** | **47 / 49** | 650 |
 * | `W` + `nativeSymbol` | 25 / 49 | 472 |
 *
 * The old strategy was empty on **22 of 49 chains**, not the four the live gate happened to probe.
 *
 * ## The strategy this ships
 *
 * `vendors.dexscreener` first — the vendor's own identifier for the chain, the most defensible
 * string we can send and the best single candidate at 47/49. Then, ONLY IF the first query returned
 * fewer distinct on-chain rows than the caller asked for, `W` + `nativeSymbol`. Together they answer
 * on **49 of 49**. At the default `limit` the second query fires on 19 of 49 chains, so the common
 * call still costs one request.
 *
 * **The wrapped ticker is a GUESS, and that is safe here in a way it would not be elsewhere.** It is
 * a search string, not data: the `chainId` filter below is unchanged, so a wrong guess can only make
 * the answer less complete, never wrong. `WETH` is the measured example — it is the wrapped native
 * of several chains at once and therefore ranks for none of them in particular.
 *
 * **Refused: querying more strings.** Adding `slug` and `name` reaches the same 49 chains and buys
 * ~7% more rows for 50% more vendor requests on a keyless endpoint. The chains they would help are
 * already answered by the pair above.
 */
const PAIRS_QUERY_NOTE =
  'no vendor route lists a chain’s pairs, so this is a filtered search of one global index';

/**
 * Optional constructor dependencies for the DexScreener adapter (injectable, same DI convention
 * as the CoinGecko adapter — see its own docstring). Keyless — no `env` dependency needed.
 */
export interface DexscreenerAdapterDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Chain registry supplying `nativeSymbol` + the observed DexScreener chainId (TASK-006 R-54). */
  chains?: ChainRegistry;
  /** Injectable throttle, the same seam `blockscout`/`blockchain-info`/`nansen` expose (WI-26).
   * Production omits it and gets the shared singleton; a test passes `createThrottle()` so its
   * bucket is its own and the file's runtime stops depending on what else ran in the process. */
  throttle?: Throttle;
}

/** This adapter's own private hand-off shape from its HTTP step to `normalize()` — `raw` bodies are
 * untouched (a search page may contain pairs from OTHER chains, since the index isn't chain-scoped
 * server-side); `chain`/`limit` are carried alongside so `normalize()` can do the actual
 * chain-filtering + slicing (kept there, not in the HTTP step — the "narrowing only inside
 * normalize()" anti-corruption-layer contract, task 003-4 reviewer note).
 *
 * **A discriminated union since task 014-32c**, because the adapter now has two vendor routes with
 * different shapes. `normalize()` branches on `kind` rather than on the capability string it is
 * handed: the fetch step already decided which route ran, and re-deciding from `cap` would let the
 * two disagree — a class this file has met before (`_cap` was ignored entirely, which is how
 * `pool.info` came to be classified `set`). */
interface DexscreenerSearchFetchResult {
  kind: 'search';
  chain: ChainInfo;
  limit: number;
  /** One entry per query actually issued — see the L-19 note above for why there can be two. */
  pages: { query: string; raw: unknown }[];
}

interface DexscreenerPoolFetchResult {
  kind: 'pool';
  chain: ChainInfo;
  pairAddress: string;
  raw: unknown;
  /** The `fee()` derivation's outcome. Never throws the call away — see `fee-tier.ts`. */
  fee: FeeTierReading;
}

/**
 * `token.pools` — task 014-32d. ONE result type for TWO vendor routes, and the discriminator is
 * `chain`, not a second `kind`.
 *
 * **Why one type.** The two routes answer the same question at two scopes: the pools a token trades
 * in, on one chain or across chains. Their rows are the same vendor `pairs` shape, and the only
 * behavioural difference downstream is which chain a row is attributed to. A second `kind` would
 * have duplicated the normalizer to change one line of it.
 *
 * **`chain: null` is the cross-chain form, and it is load-bearing rather than an absence.** It says
 * the answer is a SAMPLE and that each row states its own chain. Measured 2026-08-18 and again by
 * this task's probe: the USDC address of `ethereum` asked without a chain returns 30 rows of which
 * 29 are `pulsechain`, because a fork reproduces the addresses of the chain it forked. Attributing
 * those to the requested chain would be a wrong answer wearing the shape of a right one.
 */
interface DexscreenerTokenPoolsFetchResult {
  kind: 'token-pools';
  /** `null` on the cross-chain form — see the docstring. */
  chain: ChainInfo | null;
  token: string;
  limit: number;
  raw: unknown;
}

type DexscreenerFetchResult =
  DexscreenerSearchFetchResult | DexscreenerPoolFetchResult | DexscreenerTokenPoolsFetchResult;

interface DexscreenerPair {
  chainId?: unknown;
  dexId?: unknown;
  pairAddress?: unknown;
  baseToken?: { symbol?: unknown; address?: unknown };
  quoteToken?: { symbol?: unknown; address?: unknown };
  liquidity?: { usd?: unknown; base?: unknown; quote?: unknown };
  volume?: { h24?: unknown };
  pairCreatedAt?: unknown;
  /** The vendor's AMM version markers, e.g. `["v3"]`. NOT a fee — see `fee-tier.ts`. */
  labels?: unknown;
}

interface DexscreenerSearchResponse {
  pairs?: DexscreenerPair[];
}

/**
 * What `normalize()` hands back for `pool.info` — `interfaces.md` §5.1.7.
 *
 * `resolved: false` with `pool: null` is the vendor answering HTTP 200 and `"pairs": null` for an
 * address it knows no pool at. An empty `Pool` rendered as success would read as a pool holding no
 * tokens and no liquidity, which is the L-10 failure class.
 */
export interface PoolInfoResult {
  resolved: boolean;
  pool: Pool | null;
}

/**
 * What `normalize()` hands back — a PAGE of pools, not a bare array (Q-10).
 *
 * It used to return `Pool[]`, and the count of rows this adapter threw away went only to
 * `process.stderr`. On the stdio transport stderr is the ONLY place a diagnostic may go (stdout is
 * the JSON-RPC wire), so the caller could not see it at all: `{chain: 'ethereum', limit: 5}`
 * returning two pairs was indistinguishable from "this chain has two matching pools" and from
 * "three rows were discarded". That is L-2's shape — a health signal computed correctly with no
 * reader — and it is why the wrapper exists.
 *
 * The stderr line STAYS. It is the operator's channel; this adds the caller's. Q-10's fix path is
 * explicit that the point is adding a reader, not moving the signal.
 */
export interface PoolPage {
  pools: Pool[];
  /**
   * `pairs: true` when this page is not the whole answer — because rows were dropped, or because
   * the vendor page was cut to `limit`, or both. `reason` names which and with what counts; it is
   * the empty string when nothing was lost, mirroring the `truncated.series` idiom the DeFiLlama
   * series shaper already established.
   */
  truncated: { pairs: boolean; reason: string };
}

/**
 * The chain half of every capability's arguments, and the ONE place the coverage condition is
 * spelled out for the transport.
 *
 * **`nativeSymbol` is no longer required, and that is a consequence of the L-19 fix rather than a
 * relaxation of its own.** The old query was the native symbol, so a chain without one had no query
 * to make; the new first query is `vendors.dexscreener`, which the first clause already guarantees.
 * Measured 2026-08-21: all 49 covered chains carry a `nativeSymbol` anyway, so today this changes
 * coverage by exactly zero chains — it removes a precondition the code no longer has, rather than
 * widening what the adapter claims. Should a covered chain without one ever appear, the first query
 * still works and the second is skipped.
 */
function resolveChain(args: Record<string, unknown>, chains: ChainRegistry): ChainInfo {
  const rawChain = args['chain'];
  const chain = typeof rawChain === 'string' ? chains.tryResolve(rawChain) : null;
  if (!chain || chain.vendors['dexscreener'] == null) {
    throw new Error(
      `dexscreener.fetch: invalid args ${JSON.stringify(args)} (expected {chain: <a chain observed on DexScreener>})`,
    );
  }
  return chain;
}

function extractFetchArgs(
  args: Record<string, unknown>,
  chains: ChainRegistry,
): { chain: ChainInfo; limit: number } {
  const chain = resolveChain(args, chains);
  const rawLimit = args['limit'];
  const limit = typeof rawLimit === 'number' && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;
  return { chain, limit };
}

/** `pool.info` is addressed by a POOL ADDRESS, so its arguments are a different pair. */
function extractPoolArgs(
  args: Record<string, unknown>,
  chains: ChainRegistry,
): { chain: ChainInfo; pairAddress: string } {
  const chain = resolveChain(args, chains);
  const pairAddress = args['pairAddress'];
  if (typeof pairAddress !== 'string' || pairAddress.length === 0) {
    throw new Error(
      `dexscreener.fetch: invalid args ${JSON.stringify(args)} (expected {chain, pairAddress: <a pool address>})`,
    );
  }
  return { chain, pairAddress };
}

/**
 * `token.pools` is addressed by a TOKEN address and an OPTIONAL chain — a third argument shape.
 *
 * The chain is optional here and mandatory in the two extractors above, and that is the whole
 * difference between discovery and identification: a pool address is meaningless without the chain
 * that hosts it, while a token address is a question the vendor can answer globally.
 *
 * **The token is not format-checked against a chain**, deliberately, and the tool's input schema
 * says the same. `isValidAddress` needs a chain; on the cross-chain form there is none, and checking
 * against a chain the caller did not name would either reject valid non-EVM input or accept it by
 * guessing a family. The bound on length is still applied at the tool boundary.
 */
function extractTokenPoolsArgs(
  args: Record<string, unknown>,
  chains: ChainRegistry,
): { chain: ChainInfo | null; token: string; limit: number } {
  const token = args['token'];
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error(
      `dexscreener.fetch: invalid args ${JSON.stringify(args)} (expected {token: <a token address>, chain?})`,
    );
  }
  // ABSENT means cross-chain. A `chain` that is PRESENT and unresolvable is still an error — the
  // two states must not collapse, or a typo would silently widen the question to every chain.
  const chain = args['chain'] === undefined ? null : resolveChain(args, chains);
  const rawLimit = args['limit'];
  const limit = typeof rawLimit === 'number' && rawLimit > 0 ? rawLimit : DEFAULT_LIMIT;
  return { chain, token, limit };
}

/**
 * The query candidates for `pairs.active`, in the order the probe ranked them.
 *
 * Both are derived from the registry — no new curated column — and the second is omitted when the
 * chain declares no native symbol or when it would repeat the first string.
 */
function pairsQueriesFor(chain: ChainInfo): string[] {
  const vendorId = chain.vendors['dexscreener'];
  const queries = [typeof vendorId === 'string' ? vendorId : chain.slug];
  if (chain.nativeSymbol !== null && chain.nativeSymbol !== undefined) {
    const wrapped = `W${chain.nativeSymbol}`;
    if (!queries.includes(wrapped)) queries.push(wrapped);
  }
  return queries;
}

/**
 * DexScreener adapter (ARCHITECTURE.md §3.2/§5.3, R-6): `pairs.active` + `pool.info`, both backed by
 * the same search-based HTTP step (dexscreener has no tool consumer for `pool.info` yet in M1 —
 * cheap to declare the capability now regardless, per architecture review cycle 1).
 */
export function createDexscreenerAdapter(deps: DexscreenerAdapterDeps = {}): ProviderAdapter {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const chains = deps.chains ?? loadChainRegistry();
  const throttle = deps.throttle ?? productionThrottle;

  const readFeeTier = createFeeTierReader({
    fetchImpl,
    ...(deps.throttle === undefined ? {} : { throttle: deps.throttle }),
  });

  /** One search request, with the limiter and the transport bound the way every call here binds
   * them. Returns the untouched body — narrowing happens only in `normalize()`. */
  async function search(query: string, deadlineAtMs?: number): Promise<unknown> {
    const url = `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(query)}`;
    await throttle('dexscreener', RATE_LIMIT, 1, deadlineAtMs);
    const response = await safeFetch(url, {}, HOSTS, fetchImpl, {
      ...(deadlineAtMs === undefined ? {} : { deadlineAtMs }),
    });
    if (!response.ok) {
      throw new Error(`dexscreener: HTTP ${response.status} for ${url}`);
    }
    return response.json();
  }

  /** How many rows of a body belong to this chain — the same test `normalize()` applies, used here
   * only to decide whether the second query is worth issuing. */
  function onChainCount(raw: unknown, chain: ChainInfo): number {
    const rows = (raw as DexscreenerSearchResponse).pairs ?? [];
    const vendorId = chain.vendors['dexscreener'] ?? chain.slug;
    return rows.filter((pair) => pair.chainId === vendorId).length;
  }

  async function fetchPairs(
    args: Record<string, unknown>,
    deadlineAtMs?: number,
  ): Promise<DexscreenerSearchFetchResult> {
    const { chain, limit } = extractFetchArgs(args, chains);
    const queries = pairsQueriesFor(chain);
    const pages: { query: string; raw: unknown }[] = [];
    let found = 0;
    for (const query of queries) {
      const raw = await search(query, deadlineAtMs);
      pages.push({ query, raw });
      found += onChainCount(raw, chain);
      // The second query is issued only when the first did not already satisfy the caller. At the
      // default `limit` that is 19 of 49 chains (measured 2026-08-21), so the common call still
      // costs one request — see the L-19 note at the top of this file.
      if (found >= limit) break;
    }
    return { kind: 'search', chain, limit, pages };
  }

  async function fetchPool(
    args: Record<string, unknown>,
    deadlineAtMs?: number,
  ): Promise<DexscreenerPoolFetchResult> {
    const { chain, pairAddress } = extractPoolArgs(args, chains);
    const vendorId = chain.vendors['dexscreener'] ?? chain.slug;
    const url = `https://api.dexscreener.com/latest/dex/pairs/${encodeURIComponent(vendorId)}/${encodeURIComponent(pairAddress)}`;
    await throttle('dexscreener', RATE_LIMIT, 1, deadlineAtMs);
    const response = await safeFetch(url, {}, HOSTS, fetchImpl, {
      ...(deadlineAtMs === undefined ? {} : { deadlineAtMs }),
    });
    if (!response.ok) {
      throw new Error(`dexscreener: HTTP ${response.status} for ${url}`);
    }
    const raw: unknown = await response.json();

    // The fee derivation runs HERE, in the fetch step, because `normalize()` is synchronous by the
    // `ProviderAdapter` contract and this is an `eth_call`. It never throws (see `fee-tier.ts`): a
    // pool whose addresses and reserves were fetched successfully must not become a failed call
    // over an optional field the caller may not even have wanted.
    const knownPool = ((raw as DexscreenerSearchResponse).pairs ?? []).length > 0;
    const fee: FeeTierReading = knownPool
      ? await readFeeTier(chain, pairAddress, deadlineAtMs)
      : { bps: null, reason: 'no pool at that address, so there was nothing to ask fee() about' };
    return { kind: 'pool', chain, pairAddress, raw, fee };
  }

  /**
   * `token.pools` — one request, on whichever of the two routes the arguments select.
   *
   * **Measured caps, this task's own** (`scripts/probe-dexscreener-token-routes.ts`): both routes
   * cap at 30 rows, and the CONTROL — a well-formed address nothing deploys — returns 0 on both, so
   * a 30-row answer reads as "the vendor had more and stopped" rather than as a fixed-size
   * response. The number is NOT inherited from `VENDOR_PAGE_SIZE`, which was measured on
   * `/latest/dex/search`, a route these two do not share; carrying it across would have turned a
   * measurement into a guess.
   */
  async function fetchTokenPools(
    args: Record<string, unknown>,
    deadlineAtMs?: number,
  ): Promise<DexscreenerTokenPoolsFetchResult> {
    const { chain, token, limit } = extractTokenPoolsArgs(args, chains);
    const url =
      chain === null
        ? `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(token)}`
        : `https://api.dexscreener.com/token-pairs/v1/${encodeURIComponent(
            chain.vendors['dexscreener'] ?? chain.slug,
          )}/${encodeURIComponent(token)}`;
    await throttle('dexscreener', RATE_LIMIT, 1, deadlineAtMs);
    const response = await safeFetch(url, {}, HOSTS, fetchImpl, {
      ...(deadlineAtMs === undefined ? {} : { deadlineAtMs }),
    });
    if (!response.ok) {
      throw new Error(`dexscreener: HTTP ${response.status} for ${url}`);
    }
    const raw: unknown = await response.json();
    return { kind: 'token-pools', chain, token, limit, raw };
  }

  /**
   * One vendor row → one canonical `Pool`, or `null` when the row is malformed.
   *
   * Shared by both routes deliberately: the six fields task 014-32b added to `Pool` are published by
   * `onchain_active_pairs` as well, and two builders would have meant one of them quietly not
   * carrying them.
   */
  function toPool(pair: DexscreenerPair, chain: ChainInfo, feeBps: number | null): Pool | null {
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
      return null;
    }
    // The vendor's AMM version marker, first entry only. NOT a fee: mapping a version to a tier
    // would fabricate the number `fee-tier.ts` refuses to guess.
    const label = Array.isArray(pair.labels)
      ? (pair.labels as unknown[]).find((value): value is string => typeof value === 'string')
      : undefined;
    const pool: Pool = {
      id: `${chain.slug}:${pairAddress}`,
      chain: chain.slug,
      dexId,
      // Vendor-authored on a PERMISSIONLESS venue — anyone can deploy a pair and choose these
      // two strings, and they land verbatim in the model's context (vdd-multi cycle 5, M-6).
      baseTokenSymbol: truncateVendorText(baseSymbol, MAX_VENDOR_SYMBOL_LENGTH),
      quoteTokenSymbol: truncateVendorText(quoteSymbol, MAX_VENDOR_SYMBOL_LENGTH),
      pairAddress,
      source: 'dexscreener',
      fetchedAt: now(),
      ...(typeof pair.pairCreatedAt === 'number' ? { createdAt: pair.pairCreatedAt } : {}),
      ...(typeof pair.liquidity?.usd === 'number' ? { liquidityUsd: pair.liquidity.usd } : {}),
      ...(typeof pair.volume?.h24 === 'number' ? { volume24hUsd: pair.volume.h24 } : {}),
      // Task 014-32b's six fields. Each is spread only when the vendor actually sent it, so an
      // absent field stays ABSENT rather than becoming a null the caller has to interpret.
      ...(typeof pair.baseToken?.address === 'string'
        ? { baseTokenAddress: pair.baseToken.address }
        : {}),
      ...(typeof pair.quoteToken?.address === 'string'
        ? { quoteTokenAddress: pair.quoteToken.address }
        : {}),
      ...(typeof pair.liquidity?.base === 'number' ? { reserveBase: pair.liquidity.base } : {}),
      ...(typeof pair.liquidity?.quote === 'number' ? { reserveQuote: pair.liquidity.quote } : {}),
      ...(feeBps === null ? {} : { feeTierBps: feeBps }),
      ...(label === undefined ? {} : { versionLabel: truncateVendorText(label, 64) }),
    };
    const parsed = PoolSchema.safeParse(pool);
    return parsed.success ? parsed.data : null;
  }

  function normalizePool(result: DexscreenerPoolFetchResult): PoolInfoResult {
    const { chain, raw, fee, pairAddress } = result;
    const rows = (raw as DexscreenerSearchResponse).pairs ?? [];
    const vendorId = chain.vendors['dexscreener'] ?? chain.slug;
    // The chain is a PATH SEGMENT on this route, so the vendor already scoped the answer — but the
    // row is still checked against it. The single-pool route is the one place a vendor could hand
    // back a pool from another chain and have it cached under this one, which is exactly the
    // failure `rpc-evm`'s no-host-fallback rule exists to prevent one layer down.
    const row = rows.find((pair) => pair.chainId === vendorId);
    if (row === undefined) {
      // Measured 2026-08-18 on `0x0000000000000000000000000000000000000001` / `ethereum`: HTTP 200
      // with `"pairs": null`. Reported as `resolved: false`, never as an empty pool (L-10).
      return { resolved: false, pool: null };
    }
    const pool = toPool(row, chain, fee.bps);
    if (pool === null) {
      // A malformed single row is NOT `resolved: false` — the vendor claims a pool exists and sent
      // something we cannot read. Throwing makes it a loud failure that the registry negative-caches
      // briefly, instead of a confident "no such pool" the caller would act on.
      throw new Error(
        `dexscreener.normalize: the vendor's row for ${chain.slug}:${pairAddress} is malformed`,
      );
    }
    if (fee.bps === null && fee.reason !== '') {
      // The operator's channel. The caller learns only that `feeTierBps` is absent; an operator
      // deciding whether to curate an RPC host for a chain needs to know WHICH of the causes it was.
      process.stderr.write(
        `dexscreener.pool.info: no fee tier for ${chain.slug}:${pairAddress} — ${fee.reason}\n`,
      );
    }
    return { resolved: true, pool };
  }

  /**
   * The vendor's chain id → our chain, built once per adapter instance.
   *
   * The cross-chain route hands back rows from chains the caller never named, and a row can only
   * become a `Pool` once its vendor id is mapped back to OUR slug — the vendor vocabulary stops at
   * this layer (D4). A vendor chain our registry does not model has no slug to map to, so its rows
   * are DROPPED and counted rather than attributed to the requested chain or published under the
   * vendor's own string.
   */
  let vendorChains: Map<string, ChainInfo> | null = null;
  function chainByVendorId(vendorId: string): ChainInfo | null {
    vendorChains ??= new Map(
      chains.list().flatMap((chain) => {
        const id = chain.vendors['dexscreener'];
        return typeof id === 'string' ? [[id, chain] as [string, ChainInfo]] : [];
      }),
    );
    return vendorChains.get(vendorId) ?? null;
  }

  /**
   * `token.pools` — task 014-32d.
   *
   * **Two routes, one normalizer, and the branch is three lines of it.** On the per-chain form every
   * row belongs to the requested chain and the vendor scoped it server-side; the check is kept
   * anyway, because "the vendor scoped it" is an assumption and a mis-scoped row would otherwise be
   * published under a chain it does not live on. On the cross-chain form each row names its own
   * chain and gets it.
   *
   * **The order is stable and means nothing, measured 2026-08-21** (this task's probe, two samples
   * 300 s apart: same set, same order, and NOT sorted by liquidity — the second row of the USDC
   * sample held $9.9M behind a first row of $89k). So a `limit` cut takes an ARBITRARY subset, not
   * the largest pools, and `truncated.reason` says so whenever it cuts. Rows are NOT re-sorted here:
   * that would publish a ranking the vendor does not make, over a `liquidityUsd` the vendor omits on
   * some rows.
   */
  function normalizeTokenPools(result: DexscreenerTokenPoolsFetchResult): PoolPage {
    const { chain, limit, token, raw } = result;
    // `/latest/dex/tokens` answers `{pairs: [...]}`; `token-pairs/v1` answers a BARE ARRAY. Both are
    // handled rather than assumed: reading only the first shape would render the per-chain route's
    // answer as "this token trades nowhere", which is the L-10 failure this file keeps meeting.
    const rows: DexscreenerPair[] = Array.isArray(raw)
      ? (raw as DexscreenerPair[])
      : ((raw as DexscreenerSearchResponse).pairs ?? []);
    const vendorPageFull = rows.length >= TOKEN_ROUTE_PAGE_SIZE;

    const requestedVendorId = chain === null ? null : (chain.vendors['dexscreener'] ?? chain.slug);
    const candidates: { pair: DexscreenerPair; chain: ChainInfo }[] = [];
    let offChain = 0;
    let unmodelledChain = 0;
    for (const pair of rows) {
      const rowChainId = typeof pair.chainId === 'string' ? pair.chainId : null;
      if (requestedVendorId !== null) {
        if (rowChainId !== requestedVendorId) {
          offChain += 1;
          continue;
        }
        candidates.push({ pair, chain: chain as ChainInfo });
        continue;
      }
      const rowChain = rowChainId === null ? null : chainByVendorId(rowChainId);
      if (rowChain === null) {
        unmodelledChain += 1;
        continue;
      }
      candidates.push({ pair, chain: rowChain });
    }

    // Counted BEFORE the slice — "the vendor had more and we cut it" is invisible afterwards (Q-10).
    const kept = candidates.slice(0, limit);
    const cutByLimit = candidates.length - kept.length;

    const pools: Pool[] = [];
    let malformedCount = 0;
    for (const candidate of kept) {
      // `null` fee: neither route makes an `eth_call`, and one per row would turn a page of 30 into
      // 30 node calls. `onchain_pool_info` is where a caller asks one pool for its tier.
      const pool = toPool(candidate.pair, candidate.chain, null);
      if (pool === null) {
        malformedCount += 1;
        continue;
      }
      pools.push(pool);
    }
    if (malformedCount > 0) {
      process.stderr.write(
        `dexscreener.normalize: skipped ${malformedCount} malformed pair(s) of ${kept.length} for token.pools token=${token}\n`,
      );
    }
    if (kept.length > 0 && pools.length === 0) {
      throw new Error(
        `dexscreener.normalize: all ${kept.length} candidate pair(s) for token=${token} were malformed`,
      );
    }

    // L-14: every cause named separately, because they act on the caller differently. The vendor cap
    // is widened by no argument of either route; the `limit` cut is recovered by a larger `limit`;
    // dropped rows are recovered by nothing. The two DROP causes are also kept apart — a malformed
    // payload is a statement about the vendor, an unmodelled chain is a statement about OUR registry
    // and is fixed on our side.
    const notes = [
      malformedCount > 0
        ? `${malformedCount} of ${kept.length} vendor row(s) failed validation and were dropped`
        : '',
      unmodelledChain > 0
        ? `${unmodelledChain} row(s) were on chains this registry does not model and were dropped — they are NOT missing pools on the chains it does`
        : '',
      offChain > 0
        ? `${offChain} row(s) named a chain other than ${chain?.slug ?? '(none)'} and were dropped`
        : '',
      cutByLimit > 0
        ? `${cutByLimit} further row(s) were cut by limit=${limit}, and the vendor's row ORDER is not a size ranking (measured 2026-08-21: stable between samples, and not sorted by liquidity), so this is an arbitrary subset and NOT the largest ${limit}`
        : '',
      vendorPageFull
        ? `the vendor returned a FULL page of ${TOKEN_ROUTE_PAGE_SIZE} row(s), so rows beyond it were never sent and no argument of this route can request them`
        : '',
      chain === null && pools.length > 0
        ? 'this is the CROSS-CHAIN form: a token address is not unique across chains, so these rows are a SAMPLE and each states its own chain'
        : '',
    ].filter(Boolean);

    return {
      pools,
      // An EMPTY answer is not truncation here, and that is the difference from `pairs.active`.
      // There, empty meant the query strategy found nothing and said nothing about the chain. Here
      // the vendor was asked about one specific token and answered "no pools" — measured against a
      // well-formed address nothing deploys, which returns 0 rows on both routes. Reporting that as
      // truncated would tell a caller to retry for rows that do not exist.
      truncated: { pairs: notes.length > 0, reason: notes.join('; ') },
    };
  }

  function normalizeSearch(result: DexscreenerSearchFetchResult): PoolPage {
    const { chain, limit, pages } = result;
    const vendorId = chain.vendors['dexscreener'] ?? chain.slug;

    // Rows from every query that ran, deduplicated by pair address: two queries can surface the
    // same pool, and a caller asking for 10 must not receive the same pair twice.
    const seen = new Set<string>();
    const onThisChain: DexscreenerPair[] = [];
    let vendorRowsTotal = 0;
    let vendorPageFull = false;
    for (const page of pages) {
      const rows = (page.raw as DexscreenerSearchResponse).pairs ?? [];
      vendorRowsTotal += rows.length;
      if (rows.length >= VENDOR_PAGE_SIZE) vendorPageFull = true;
      for (const pair of rows) {
        if (pair.chainId !== vendorId) continue;
        const address = typeof pair.pairAddress === 'string' ? pair.pairAddress : null;
        if (address !== null) {
          if (seen.has(address)) continue;
          seen.add(address);
        }
        onThisChain.push(pair);
      }
    }
    const candidates = onThisChain.slice(0, limit);
    // Q-10: counted BEFORE the slice, because "the vendor had more and we cut it" is one of the
    // two ways this page can be short, and it is invisible afterwards.
    const cutByLimit = onThisChain.length - candidates.length;
    const otherChainRows = vendorRowsTotal - onThisChain.length;

    // Adversarial cycle 1, fix G — explicit degradation instead of an all-or-nothing throw: one
    // malformed pair in an otherwise-good batch used to fail the ENTIRE call. Each candidate is
    // validated independently and a malformed one is DROPPED, not thrown, and counted. Only if
    // EVERY candidate turns out malformed does this still throw (an empty result would otherwise
    // look identical to "no new pairs right now" — a silent, misleading success).
    const pools: Pool[] = [];
    let malformedCount = 0;
    for (const pair of candidates) {
      // `null` fee: this route makes no `eth_call`. One extra RPC round trip per row would turn a
      // page of 100 into 100 node calls, and the field is documented as absent where it is not
      // derived — `onchain_pool_info` is where a caller asks for one pool and its tier.
      const pool = toPool(pair, chain, null);
      if (pool === null) {
        malformedCount += 1;
        continue;
      }
      pools.push(pool);
    }

    if (malformedCount > 0) {
      process.stderr.write(
        // `chain.slug`, not `chain` (vdd-multi cycle 5, L-1): `chain` is a `ChainInfo` since
        // TASK-006, and interpolating an object renders `[object Object]` — a diagnostic that
        // names no chain at all, in the one line an operator reads to find out which one broke.
        `dexscreener.normalize: skipped ${malformedCount} malformed pair(s) of ${candidates.length} for chain=${chain.slug}\n`,
      );
    }

    if (candidates.length > 0 && pools.length === 0) {
      throw new Error(
        `dexscreener.normalize: all ${candidates.length} candidate pair(s) for chain=${chain.slug} were malformed`,
      );
    }

    // Q-10: the same two facts the stderr line above reports, now on the channel the CALLER can
    // read. Both causes are named separately because they mean different things to a consumer: a
    // page cut by `limit` can be widened by asking for more, whereas dropped rows cannot be
    // recovered by any argument and say something about the vendor's payload.
    const dropNote =
      malformedCount > 0
        ? `${malformedCount} of ${candidates.length} vendor row(s) failed validation and were dropped`
        : '';
    const cutNote =
      cutByLimit > 0 ? `${cutByLimit} further row(s) on this chain were cut by limit=${limit}` : '';
    // L-14: kept a SEPARATE note, never folded into `cutNote`. The two existing causes differ
    // because one can be widened by asking for more and the other cannot; the vendor cap is a
    // third kind that no argument of this route can widen. Folding it into `cutByLimit` would
    // tell the caller to retry with a bigger `limit` — advice that cannot work.
    const queried = pages.map((page) => page.query).join(', ');
    const vendorNote = vendorPageFull
      ? `the vendor returned a FULL page of ${VENDOR_PAGE_SIZE} row(s) for q=${queried}, so rows beyond it were never sent and no argument of this route can request them (${otherChainRows} of the ${vendorRowsTotal} row(s) returned held OTHER chains); ${PAIRS_QUERY_NOTE}`
      : '';
    // L-19: an empty answer names the strategy that produced it. Before this, an empty page was
    // indistinguishable from "this chain has no pairs" — a false statement delivered with a 200.
    const emptyNote =
      pools.length === 0
        ? `no pool on ${chain.slug} matched q=${queried} — ${PAIRS_QUERY_NOTE}, so this is a statement about the query, NOT about the chain`
        : '';
    return {
      pools,
      truncated: {
        pairs: malformedCount > 0 || cutByLimit > 0 || vendorPageFull || pools.length === 0,
        reason: [dropNote, cutNote, vendorNote, emptyNote].filter(Boolean).join('; '),
      },
    };
  }

  return {
    id: 'dexscreener',
    // TASK-006 (R-54/R-57): DexScreener publishes no chain catalog, so `vendors.dexscreener` is an
    // OBSERVED value (task 006-2) — non-null means we have actually seen that chainId in a
    // response.
    //
    // **One condition for all three capabilities, and task 014-32c is why it is not per-capability.**
    // The plan expected a per-capability predicate: `pairs.active` needed `nativeSymbol` for its
    // query while the address-addressed capabilities did not. Fixing L-19 removed that need — the
    // first query is now the vendor's own chain id — so the clause is gone for everyone and there is
    // nothing left to vary by capability. A predicate that varies where the code does not is a
    // second thing to keep in step (`servesChain`'s own docstring in `rpc-evm` names that failure).
    //
    // It stays in step with the transport by construction: `resolveChain` above enforces exactly
    // this condition, and every capability's argument extraction goes through it.
    chainSupport: (chain: ChainInfo): boolean => chain.vendors['dexscreener'] != null,
    /**
     * What the committed probe says about this chain — task 014-32a, R-33.5.
     *
     * **Not a predicate, and the line above is untouched.** This reports what the vendor was
     * WITNESSED doing; `chainSupport` decides coverage. `verified` here does not widen coverage by
     * one chain, which is why the two live side by side rather than one folding into the other:
     * `fetch` calls `extractFetchArgs` for every capability of this adapter, so a predicate relaxed
     * ahead of the route that needs it would advertise the capability on 62 chains where no request
     * can be built, and it would answer an empty page.
     *
     * A chain with no row answers `unverified` — the honest reading of "we have no witness".
     */
    chainProbeStatus: (chain: ChainInfo): 'verified' | 'excluded' | 'unverified' =>
      DEXSCREENER_CHAIN_COVERAGE[chain.caip2]?.status ?? 'unverified',
    // Q-8: `pairs.active`, renamed from the id that claimed recency. The vendor route is
    // `GET /latest/dex/search`, which is a RELEVANCE search with no recency semantics — measured
    // 2026-08-11, the freshest row in a page was 155 days old, `pairCreatedAt` was absent on 6 of
    // 30 rows, and the route returned the byte-identical page for `sort=`, `sortBy=` and `rankBy=`
    // (it ignores unknown parameters). So no amount of over-fetching turns this into a new-pairs
    // feed, and a capability id claiming otherwise is the same wrong answer as the tool name was.
    capabilities: () => [{ id: 'pairs.active' }, { id: 'pool.info' }, { id: 'token.pools' }],
    costOf: () => ({ credits: 0 }),
    fetch: async (
      cap: string,
      args: Record<string, unknown>,
      /** WI-37 — forwarded unchanged to the limiter and the transport, never re-derived. */
      deadlineAtMs?: number,
    ): Promise<DexscreenerFetchResult> => {
      if (cap === 'pool.info') return fetchPool(args, deadlineAtMs);
      if (cap === 'token.pools') return fetchTokenPools(args, deadlineAtMs);
      return fetchPairs(args, deadlineAtMs);
    },
    normalize: (cap: string, rawResult: unknown): PoolPage | PoolInfoResult => {
      const result = rawResult as DexscreenerFetchResult;
      // Branch on the FETCH RESULT, not on `cap` — see `DexscreenerFetchResult`'s docstring. `cap`
      // is still checked, so a route/capability mismatch is loud rather than silently reshaped.
      if (result.kind === 'pool') {
        if (cap !== 'pool.info') {
          throw new Error(`dexscreener.normalize: ${cap} was handed a pool.info fetch result`);
        }
        return normalizePool(result);
      }
      if (result.kind === 'token-pools') {
        if (cap !== 'token.pools') {
          throw new Error(`dexscreener.normalize: ${cap} was handed a token.pools fetch result`);
        }
        return normalizeTokenPools(result);
      }
      if (cap !== 'pairs.active') {
        throw new Error(`dexscreener.normalize: ${cap} was handed a pairs.active fetch result`);
      }
      return normalizeSearch(result);
    },
    isAvailable: () => ({ ok: true }),
  };
}
