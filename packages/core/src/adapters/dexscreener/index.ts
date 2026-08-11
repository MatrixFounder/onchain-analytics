import { throttle as productionThrottle, type Throttle } from '../../net/rate-limit.js';
import type { ChainInfo, ChainRegistry } from '../../chain/registry-core.js';
import { loadChainRegistry } from '../../chain/registry.js';
import { safeFetch } from '../../net/safe-fetch.js';
import { truncateVendorText, MAX_VENDOR_SYMBOL_LENGTH } from '../truncate-vendor-text.js';
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
  /** Injectable throttle, the same seam `blockscout`/`blockchain-info`/`nansen` expose (WI-26).
   * Production omits it and gets the shared singleton; a test passes `createThrottle()` so its
   * bucket is its own and the file's runtime stops depending on what else ran in the process. */
  throttle?: Throttle;
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
 * DexScreener adapter (ARCHITECTURE.md §3.2/§5.3, R-6): `pairs.active` + `pool.info`, both backed by
 * the same search-based HTTP step (dexscreener has no tool consumer for `pool.info` yet in M1 —
 * cheap to declare the capability now regardless, per architecture review cycle 1).
 */
export function createDexscreenerAdapter(deps: DexscreenerAdapterDeps = {}): ProviderAdapter {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const chains = deps.chains ?? loadChainRegistry();
  const throttle = deps.throttle ?? productionThrottle;

  return {
    id: 'dexscreener',
    // TASK-006 (R-54/R-57): DexScreener publishes no chain catalog, so `vendors.dexscreener` is an
    // OBSERVED value (task 006-2) — non-null means we have actually seen that chainId in a
    // response. `nativeSymbol` is required too because the keyless search endpoint is queried by
    // native symbol; without one there is no query to make.
    chainSupport: (chain: ChainInfo): boolean =>
      chain.vendors['dexscreener'] != null && chain.nativeSymbol != null,
    // Q-8: `pairs.active`, renamed from the id that claimed recency. The vendor route is
    // `GET /latest/dex/search`, which is a RELEVANCE search with no recency semantics — measured
    // 2026-08-11, the freshest row in a page was 155 days old, `pairCreatedAt` was absent on 6 of
    // 30 rows, and the route returned the byte-identical page for `sort=`, `sortBy=` and `rankBy=`
    // (it ignores unknown parameters). So no amount of over-fetching turns this into a new-pairs
    // feed, and a capability id claiming otherwise is the same wrong answer as the tool name was.
    capabilities: () => [{ id: 'pairs.active' }, { id: 'pool.info' }],
    costOf: () => ({ credits: 0 }),
    fetch: async (
      _cap: string,
      args: Record<string, unknown>,
      /** WI-37 — forwarded unchanged to the limiter and the transport, never re-derived. */
      deadlineAtMs?: number,
    ): Promise<DexscreenerFetchResult> => {
      const { chain, limit } = extractFetchArgs(args, chains);
      const query = chain.nativeSymbol ?? chain.slug;
      const url = `https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(query)}`;

      await throttle('dexscreener', RATE_LIMIT, 1, deadlineAtMs);
      const response = await safeFetch(url, {}, HOSTS, fetchImpl, {
        ...(deadlineAtMs === undefined ? {} : { deadlineAtMs }),
      });
      if (!response.ok) {
        throw new Error(`dexscreener: HTTP ${response.status} for ${url}`);
      }
      const raw: unknown = await response.json();
      return { chain, limit, raw };
    },
    normalize: (_cap: string, rawResult: unknown): PoolPage => {
      const { chain, limit, raw } = rawResult as DexscreenerFetchResult;
      const body = raw as DexscreenerSearchResponse;
      const vendorRows = body.pairs ?? [];
      const onThisChain = vendorRows.filter(
        (pair) => pair.chainId === (chain.vendors['dexscreener'] ?? chain.slug),
      );
      const candidates = onThisChain.slice(0, limit);
      // Q-10: counted BEFORE the slice, because "the vendor had more and we cut it" is one of the
      // two ways this page can be short, and it is invisible afterwards.
      const cutByLimit = onThisChain.length - candidates.length;

      // L-14: the two counters above measure only what WE lose. This route is a relevance search
      // over an index that is not chain-scoped server-side, so two losses happen before any of our
      // arithmetic runs, and `truncated` used to report `false` through both:
      //   1. the vendor page is capped — rows past `VENDOR_PAGE_SIZE` were never sent;
      //   2. rows for OTHER chains consume slots in that same capped page.
      // Measured on the repo's own fixture: `q=ETH` returns 30 rows of which **2** are ethereum,
      // so the busiest EVM chain answered with two pairs and a completeness claim.
      const vendorPageFull = vendorRows.length >= VENDOR_PAGE_SIZE;
      const otherChainRows = vendorRows.length - onThisChain.length;

      // Adversarial cycle 1, fix G — explicit degradation instead of an all-or-nothing throw:
      // one malformed pair in an otherwise-good batch used to fail the ENTIRE onchain_active_pairs
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
        cutByLimit > 0
          ? `${cutByLimit} further row(s) on this chain were cut by limit=${limit}`
          : '';
      // L-14: kept a SEPARATE note, never folded into `cutNote`. The two existing causes differ
      // because one can be widened by asking for more and the other cannot; the vendor cap is a
      // third kind that no argument of this route can widen. Folding it into `cutByLimit` would
      // tell the caller to retry with a bigger `limit` — advice that cannot work.
      const vendorNote = vendorPageFull
        ? `the vendor returned a FULL page of ${vendorRows.length} row(s) (cap ${VENDOR_PAGE_SIZE}) for q=${chain.nativeSymbol ?? chain.slug}, so rows beyond it were never sent and no argument of this route can request them (${otherChainRows} slot(s) of that page held OTHER chains)`
        : '';
      return {
        pools,
        truncated: {
          pairs: malformedCount > 0 || cutByLimit > 0 || vendorPageFull,
          reason: [dropNote, cutNote, vendorNote].filter(Boolean).join('; '),
        },
      };
    },
    isAvailable: () => ({ ok: true }),
  };
}
