import { throttle as productionThrottle, type Throttle } from '../../net/rate-limit.js';
import type { ChainInfo, ChainRegistry } from '../../chain/registry-core.js';
import { loadChainRegistry } from '../../chain/registry.js';
import { DeadlineExceededError, safeFetch } from '../../net/safe-fetch.js';
import { CapabilityNotCoveredOnChainError } from '../../chain/errors.js';
import { DEFILLAMA_DEX_CHAINS } from './dex-chains.js';
import { ttlFor } from '../../cache/ttl.js';
import { stringifyTruncated } from '../stringify-truncated.js';
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

/**
 * `dex.volume.history` result (TASK-007, R-67). A third contract on this adapter, separate from the
 * two TVL ones for the same reason they are separate from each other: different endpoint
 * (`/overview/dexs/{chain}`), different subject (traded volume, not locked value) and a different
 * chain set (274 vs 458).
 *
 * Every string in here is OURS — `chain` and `name` come from the registry, `source` is a literal.
 * The vendor document carries 151 protocol cards with `name`/`category`/`methodology`/`logo`, which
 * are third-party-editable text; none of it is read, so none of it can reach a caller (R-68e).
 */
export interface DexVolumeResult {
  /** Canonical SLUG, ours. */
  chain: string;
  /** Display name from the registry, ours — never the vendor's echo field. */
  name: string;
  /** The window ACTUALLY covered, which is what was requested whenever the chain has that much
   * history and less when it does not (cycle 3, logic L-1). `days` shrinking below the requested
   * value is how a short history becomes visible instead of hiding as a phantom zero-gap answer. */
  window: { fromMs: number; toMs: number; days: number };
  /** Daily points, `ts` in epoch-ms UTC (DB-SCHEMA §1.2 — the vendor sends unix SECONDS), bucketed
   * to the day and unique per day. */
  series: { ts: number; volumeUsd: number }[];
  points: number;
  /** Daily steps MISSING inside the covered window. Counted, never stitched — an interpolated point
   * is a number nobody measured. Invariant: `points + gapDays === window.days` whenever a series was
   * requested — INCLUDING the case where the vendor published no day at all, which counts the whole
   * requested window as missing rather than reporting a clean zero (L-5). With
   * `includeSeries: false` the invariant does not apply: there is no series to judge and `points: 0`
   * is the honest signal. */
  gapDays: number;
  /** The vendor's own aggregates, passed through rather than recomputed. `null` means the key was
   * absent or explicitly null, never `0` — rendering a missing measurement as a zero one would
   * fabricate data.
   *
   * MEASURED, not defensive: the 274-chain echo probe (2026-07-28,
   * `raw/defillama-dex-echo-probe-2026-07-28.json`) found `doge` — a chain this capability
   * COVERS — answering HTTP 200 with `total24h: null`. The earlier justification cited `litecoin`,
   * which is not covered and whose recorded document actually contains all five keys we read; the
   * claim was right and its evidence was not (cycle 3, logic D-1). It now is. */
  totals: {
    h24: number | null;
    d7: number | null;
    d30: number | null;
    d1y: number | null;
    allTime: number | null;
  };
  /** Set when the returned series is not everything the vendor sent for the window — either a hard
   * cap cut it, or duplicate days were folded to one point each. Never set by ordinary windowing,
   * or the flag would decay into decoration that is always true; `reason` says which happened. */
  truncated: { series: boolean; reason: string };
  source: string;
  /** Age of the DOCUMENT, not of `normalize()` — see `fetchDexDocument`. */
  fetchedAt: number;
}

export interface ProtocolTvlResult {
  /** The vendor's display name for a row it names itself; the requested SLUG for a parent whose
   * total we summed (the catalog carries no parent display name, and inventing one from the
   * children's common prefix would be a guess — see `aggregatedFrom`). */
  protocol: string;
  /** The chain's canonical SLUG. Widened from the closed `Chain` enum in TASK-006 (task 006-5) —
   * the vocabulary lives in the registry now, not in a type literal. */
  chain: string;
  /**
   * Current TVL on `chain` — THREE states, because the vendor genuinely has three (L-9):
   *
   * - a **number** — the protocol is deployed here and publishes a plain-TVL figure;
   * - **`0`** with `deployed: false` — not deployed here. A negative ANSWER, not a failure: "Aave
   *   is not on Bitcoin" is correct, and nothing locked is genuinely zero;
   * - **`null`** with `deployed: true` — deployed here, but every figure the vendor publishes for
   *   this chain sits in a `-staking`/`-borrowed`/`-pool2` bucket and none in the plain one
   *   (measured 2026-08-11: 41 of the 6 917 catalog rows that list chains). Reporting `0` there
   *   would claim a measurement nobody made.
   */
  tvlUsd: number | null;
  totalTvlUsd: number;
  /** Whether the protocol is deployed on `chain` at all. Splits "no deployment" from "the provider
   * could not answer", which used to arrive as the same `capability unavailable` (L-9). */
  deployed: boolean;
  /** Every chain the protocol is deployed on, as OUR canonical slugs, TVL-descending (`null` last).
   * The chain-by-chain sweep L-9 recorded as undecidable is now one call. */
  deployments: { chain: string; tvlUsd: number | null }[];
  /** Deployment chains whose vendor name the registry does not carry. Counted rather than dropped,
   * so a caller can tell a COMPLETE `deployments` list from a partial one. */
  unmappedDeployments: number;
  /** Catalog slugs summed to produce this answer, when the requested slug is a parent with no row
   * of its own (`uniswap` → `uniswap-v1..v4`). Empty when one row answered — so an aggregate is
   * never mistaken for a measurement. */
  aggregatedFrom: string[];
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
  /** How many DEX-volume documents this instance may hold at once (TASK-007, adversarial cycle 1
   * H-2). A MEMORY bound, not a correctness one — evicting early costs one refetch of a free
   * endpoint. Defaults to 32, which is ~13MB of PARSED heap (250KB of wire text expands to roughly
   * 415KB of object graph — cycle 3 performance M-1 corrected the earlier "~8MB", which multiplied
   * wire bytes by a slot count). Must be a positive integer; injectable for the same reason
   * `now`/`fetchImpl`/`chains` are, so a test can prove eviction without issuing 33 real requests
   * through the shared rate limiter. */
  maxDocuments?: number;
  /** Injectable throttle, the same seam `blockscout`/`blockchain-info`/`nansen` expose (WI-26).
   * Production omits it and gets the shared singleton; a test passes `createThrottle()` so its
   * bucket is its own and the file's runtime stops depending on what else ran in the process. */
  throttle?: Throttle;
}

/** This adapter's own private hand-off shape from its HTTP step to `normalize()` — `raw` is the
 * untouched vendor body; `chain` is carried alongside it because no vendor response identifies
 * "which chain the caller asked for" — only `normalize()` slices for it (ARCHITECTURE.md §3.2). */
interface DefillamaFetchResult {
  chain: ChainInfo;
  raw: unknown;
  /** When the shared document this row came from was actually fetched. Present so `normalize()`
   * reports the DATA's age rather than its own (vdd-multi cycle 6, M-1) — true for all three
   * capabilities since `protocol.tvl` stopped fetching per call (L-7). */
  fetchedAt?: number;
  /** `dex.volume.history` only — the validated arguments, carried across to `normalize()` because
   * the vendor document has no notion of the window the caller asked for. */
  dex?: DexVolumeArgs;
  /** `protocol.tvl` only. The catalog has no notion of which slug was asked for, so it travels
   * beside it. `vendorDoc` is set ONLY on the narrow fall-back path — a parent whose children
   * declare `tokensExcludedFromParent`, where summing the catalog would double-count (see
   * `resolveProtocol`). */
  protocol?: { slug: string; vendorDoc?: unknown };
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

/**
 * One row of `/protocols` — only the fields this adapter reads, all `unknown` because every one of
 * them is third-party text or numbers that must be checked before use.
 *
 * `chainTvls` here is a map of CURRENT numbers (`{"Ethereum": 1.16e10, "Base-borrowed": 3.1e8}`),
 * which is a different shape from the same-named field in `/protocol/{slug}`, where each value is
 * an object holding a full daily series. That difference is the whole point of the move (L-7): the
 * point question "what is the TVL now" was being answered by downloading a decade of history.
 */
interface DefillamaCatalogRow {
  slug?: unknown;
  name?: unknown;
  tvl?: unknown;
  chains?: unknown;
  chainTvls?: unknown;
  /** The address a PARENT is reachable at — measured, not assumed: `/protocol/ether.fi` answers
   * 200 and `/protocol/ether-fi` answers 400, so the `parent#<id>` suffix is an internal id and
   * this field is the slug (probe 2026-08-11; the two disagree on 256 of 2 147 rows). */
  parentProtocolSlug?: unknown;
  /** Tokens the vendor SUBTRACTS when it totals this row into its parent, to undo double-counting.
   * Its presence is why a naive sum of children is not always the parent's own answer — measured
   * at +9.5 % on `ether.fi` (3.823 B summed vs the vendor's 3.491 B). */
  tokensExcludedFromParent?: unknown;
}

const CHAINS_URL = 'https://api.llama.fi/v2/chains';

/**
 * The protocol catalog — ONE shared document that answers `protocol.tvl` for every slug, replacing
 * a per-call `GET /protocol/{slug}` (L-7).
 *
 * The old route could not be kept at any cap. Measured 2026-08-11 against the live vendor: the
 * document for `aave-v3` is **27.57 MiB** decompressed, against a 10 MiB cap — and it grows with
 * every new chain and every further day of history, so raising the constant buys weeks. (L-7's own
 * table recorded overshoots of 2–16 KB. Those were `Content-Length` values read from a HEAD request,
 * i.e. GZIP-COMPRESSED sizes, compared against a cap that `capResponseStream` applies to DECODED
 * bytes; the real overshoot was ~18 MiB, not 2 KB.) This catalog is 8.14 MiB for all 8 009
 * protocols, it is fetched once per TTL rather than once per call, and it grows with the protocol
 * COUNT — ~1 066 bytes a row, so ~1 800 new protocols of headroom under the same cap.
 *
 * The size is deliberately still checked by the ordinary cap rather than exempted: if this document
 * ever does outgrow it, the live eval gate (`pnpm gate`) fails on `protocol.tvl` and says so, which
 * is exactly the signal the old route never gave us — it broke silently between tasks.
 */
const PROTOCOLS_URL = 'https://api.llama.fi/protocols';

/**
 * `DEFILLAMA_DEX_CHAINS` as a `Set`, built once at module load (TASK-007 task 007-2).
 *
 * A `Set` rather than `Array.includes` because `chainSupport()` is called once per registry row when
 * the coverage matrix is built. **Correcting this comment's own earlier claim** (cycle 3,
 * performance L-2): it said the scan happens "on every `onchain_list_chains` call, ~131k string
 * comparisons". It does not. `chain/coverage.ts` memoizes `coveredSet(capability)` per
 * `Coverage` instance, and there is one `Coverage` per `CapabilityRegistry` per process, so the
 * whole-process cost is ~1000 calls at ~100ns — about 100µs, once, ever. The `Set` is still the
 * right structure and costs nothing; the justification was simply invented rather than measured,
 * which is how the next person mis-sizes something that does matter.
 *
 * Module scope is sound here and is NOT the singleton state §8 forbids: the list is a compile-time
 * constant emitted by a generator, identical for the life of the process, and holds nothing
 * instance- or request-specific.
 */
const DEX_CHAIN_SET: ReadonlySet<string> = new Set(DEFILLAMA_DEX_CHAINS);

/** Does the vendor's DEX-volume dataset cover this chain? Shared by `chainSupport()` and the
 * adapter's own argument validation, so the gate and the transport cannot answer differently —
 * the single-predicate rule TASK-006's H-1 produced. */
function coversDexVolume(chain: ChainInfo): boolean {
  const vendorName = chain.vendors['defillama'];
  return vendorName != null && DEX_CHAIN_SET.has(vendorName);
}

/** One row of DeFiLlama's `/v2/chains` list — only the fields this adapter reads. */
interface DefillamaChainRow {
  name?: unknown;
  tvl?: unknown;
}

/** Default window. 90 days answers "how has this chain traded lately" without putting a decade of
 * daily points into a model's context. */
const DEFAULT_DEX_DAYS = 90;
/** Hard ceiling on the requested window (5 years). An input bound only — the per-answer point cap is
 * `args.days` itself, for the reason spelled out at the truncation step in `normalizeDexVolume`. */
const MAX_DEX_DAYS = 1825;
const DAY_MS = 86_400_000;

/**
 * Response-size cap for this endpoint specifically. The live per-chain document is ~250KB with the
 * chart included; 2MB leaves 8× headroom and turns "the vendor started serving the 18MB global
 * document here" into a loud refusal rather than a quiet download. The 10MB default would not.
 */
const DEX_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

interface DexVolumeArgs {
  chain: ChainInfo;
  days: number;
  includeSeries: boolean;
}

/**
 * Validates `dex.volume.history` arguments. The tool layer already validates with zod, and this
 * still re-checks: the adapter is reachable from anywhere inside the package, and "someone else
 * validated it" is not a property the code can see.
 *
 * Coverage is checked through `coversDexVolume` — the SAME predicate `chainSupport()` uses, not a
 * second copy of the rule. An adapter that answers one question in two places eventually answers it
 * two different ways (TASK-006, H-1).
 */
function extractDexVolumeArgs(args: Record<string, unknown>, chains: ChainRegistry): DexVolumeArgs {
  const rawChain = args['chain'];
  const chain = typeof rawChain === 'string' ? chains.tryResolve(rawChain) : null;
  if (!chain || !coversDexVolume(chain)) {
    // Bounded, for the same reason as the vendor values above: this message also reaches the model
    // (cycle 3, security L-8). Through the MCP tool `chain` is zod-bounded to 64 chars, but this
    // adapter is a package-public export reachable from anywhere.
    throw new Error(
      `defillama.fetch(dex.volume.history): invalid args ${stringifyTruncated(args, 200)} ` +
        `(expected {chain: <a chain DeFiLlama reports DEX volume for>})`,
    );
  }
  const rawDays = args['days'];
  const days = rawDays === undefined ? DEFAULT_DEX_DAYS : rawDays;
  if (typeof days !== 'number' || !Number.isInteger(days) || days < 1 || days > MAX_DEX_DAYS) {
    throw new Error(
      `defillama.fetch(dex.volume.history): days must be an integer in 1..${MAX_DEX_DAYS} (got ${String(days)})`,
    );
  }
  const rawIncludeSeries = args['includeSeries'];
  if (rawIncludeSeries !== undefined && typeof rawIncludeSeries !== 'boolean') {
    throw new Error(
      `defillama.fetch(dex.volume.history): includeSeries must be a boolean (got ${String(rawIncludeSeries)})`,
    );
  }
  return { chain, days, includeSeries: rawIncludeSeries ?? true };
}

function dexVolumeUrl(vendorName: string, includeSeries: boolean): string {
  // `excludeTotalDataChartBreakdown` is NOT optional: the per-protocol × per-chain breakdown is what
  // makes the global document 18MB against 1.6MB (11.2×), and nothing here reads it.
  const params = new URLSearchParams({ excludeTotalDataChartBreakdown: 'true' });
  if (!includeSeries) params.set('excludeTotalDataChart', 'true');
  return `https://api.llama.fi/overview/dexs/${encodeURIComponent(vendorName)}?${params.toString()}`;
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

/** Only the fields this adapter reads. `protocols` is deliberately absent — see R-68e. */
interface DefillamaDexResponse {
  chain?: unknown;
  totalDataChart?: unknown;
  total24h?: unknown;
  total7d?: unknown;
  total30d?: unknown;
  total1y?: unknown;
  totalAllTime?: unknown;
}

/** Earliest plausible daily point — the Bitcoin genesis day. Anything before it is a decoding
 * mistake (seconds read as milliseconds, or the reverse), not history. */
const EARLIEST_PLAUSIBLE_TS_MS = Date.UTC(2009, 0, 3);

/**
 * Renders an UNTRUSTED vendor value for an error message WITHOUT echoing it (cycle 3, security H-2).
 *
 * Every `normalize()` throw here ends up as `tried[].reason` inside `CapabilityUnavailableError`,
 * which the MCP tool returns as `isError: true` text — i.e. **straight into the model's context**.
 * A vendor-controlled string interpolated verbatim is therefore a prompt-injection channel bounded
 * only by the 2MB body cap, and `normalize()` failures ARE negative-cached, so the payload would be
 * replayed for the whole negative TTL with no further network traffic.
 *
 * This repo had already learned this twice — `stringifyTruncated` exists for exactly this, and
 * `UnknownChainError` truncates its echoed input with the same reasoning — and the first version of
 * this adapter used neither. So: describe the value's TYPE and SHAPE, never its content. A string
 * is reported only by length; numbers are safe to show because a number cannot carry instructions.
 */
function describeVendorValue(value: unknown): string {
  if (typeof value === 'string') return `string(length=${value.length})`;
  if (typeof value === 'number' || typeof value === 'boolean' || value == null) {
    return String(value);
  }
  if (Array.isArray(value)) return `array(length=${value.length})`;
  return typeof value;
}

/**
 * A vendor aggregate, or `null` when the key is genuinely ABSENT. Never `0` for "missing":
 * `litecoin` answers HTTP 200 with `change_1d: null` and no `change_7d` key at all, and a zero
 * there would be a fabricated measurement rather than an absent one.
 *
 * A key that is PRESENT but unusable (negative, `NaN`, `Infinity`, a string) is a different thing
 * and throws rather than collapsing to `null` — otherwise "the vendor sent garbage" and "the vendor
 * sent nothing" would arrive at the caller as the same value, and the corrupt document would be
 * cached as a success. This is the same rule the series path applies to a bad `volumeUsd`; applying
 * it in one place and not the other is how the two answers drift apart.
 */
function optionalUsd(value: unknown, field: string, chain: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new Error(
      `defillama.normalize(dex.volume.history): invalid ${field} for ${chain} (${describeVendorValue(value)})`,
    );
  }
  return value;
}

/**
 * Turns the vendor's DEX-volume document into `DexVolumeResult` (TASK-007 task 007-5, R-67/R-68).
 *
 * The order of the checks below is the order of their importance, and the first one is the one that
 * makes the rest meaningful.
 */
function normalizeDexVolume(
  chain: ChainInfo,
  raw: unknown,
  args: DexVolumeArgs,
  fetchedAt: number,
): DexVolumeResult {
  const vendorName = chain.vendors['defillama'];
  const body = (raw ?? {}) as DefillamaDexResponse;

  // 1. IDENTITY. The endpoint is name-tolerant (`op-mainnet`, `optimism` and `OP Mainnet` all
  //    return the same document), an unknown chain answers HTTP 500 rather than 404, and a chain
  //    outside the vendor's active set answers HTTP 200 with zeros. Without this check, "the vendor
  //    served a different chain than we asked for" and "this chain has no volume" are the same
  //    observation — and the wrong one gets cached under our slug.
  if (typeof body.chain !== 'string' || body.chain !== vendorName) {
    // The vendor's value is DESCRIBED, never echoed — this message reaches the model's context.
    // Our own expected name is safe to print: it comes from the committed registry, not the wire.
    throw new Error(
      `defillama.normalize(dex.volume.history): vendor answered for a different chain ` +
        `(${describeVendorValue(body.chain)}) than the requested '${String(vendorName)}' ` +
        `(chain=${chain.slug})`,
    );
  }

  const rawChart = Array.isArray(body.totalDataChart) ? body.totalDataChart : [];
  const points: { ts: number; volumeUsd: number }[] = [];
  for (const entry of rawChart) {
    if (!Array.isArray(entry) || entry.length < 2) continue;
    const [rawTs, rawVolume] = entry as [unknown, unknown];
    // 2. TIME. The vendor sends unix SECONDS; the canonical form is epoch-ms UTC (DB-SCHEMA §1.2).
    //    BUCKETED to the day (cycle 3, logic L-2), not merely converted: the window anchor below is
    //    floored to a day boundary while the points used to be compared raw, so the moment the
    //    vendor stops publishing exactly at midnight — an end-of-day convention, or a partial
    //    current-day point — the newest point (the one that DEFINED the window) failed `ts <= toMs`
    //    and silently vanished from its own window. At `days: 1` that returned an empty series.
    //    Bucketing both sides is also what the project's own `ts_bucket` convention prescribes.
    if (typeof rawTs !== 'number' || !Number.isInteger(rawTs)) continue;
    const exactTs = rawTs * 1000;
    if (exactTs < EARLIEST_PLAUSIBLE_TS_MS || exactTs > fetchedAt + DAY_MS) continue;
    const ts = Math.floor(exactTs / DAY_MS) * DAY_MS;
    // 3. VALUE. A non-finite or negative volume is rejected LOUDLY rather than dropped: unlike a
    //    malformed timestamp (a decoding question about one point), a negative traded volume means
    //    the document itself is not what we think it is. It must never be cached as a success —
    //    the tool's own `.nonnegative()` schema would otherwise meet an already-memoized bad value.
    if (typeof rawVolume !== 'number' || !Number.isFinite(rawVolume) || rawVolume < 0) {
      throw new Error(
        `defillama.normalize(dex.volume.history): invalid volume for ${chain.slug} at ts=${ts} ` +
          `(volumeUsd=${describeVendorValue(rawVolume)})`,
      );
    }
    points.push({ ts, volumeUsd: rawVolume });
  }
  points.sort((a, b) => a.ts - b.ts);

  // 2b. DEDUPE by day (cycle 3, logic L-4). Two points landing in the same day bucket — a vendor
  //     publishing glitch, or the sub-daily granularity the truncation guard below anticipates —
  //     used to inflate the point count while leaving `gapDays` at 0, so a duplicate MASKED exactly
  //     one genuine missing day. Last value for a day wins; the count of collisions is a drift
  //     signal, so it is surfaced rather than swallowed.
  let duplicateDays = 0;
  const deduped: { ts: number; volumeUsd: number }[] = [];
  for (const point of points) {
    const previous = deduped[deduped.length - 1];
    if (previous && previous.ts === point.ts) {
      deduped[deduped.length - 1] = point;
      duplicateDays += 1;
      continue;
    }
    deduped.push(point);
  }

  // 3b. A chart that the vendor SENT and we could read NOTHING from is a decoding failure, not an
  //     empty history — and it must be loud (the "a diagnostic nobody reads is not a diagnostic"
  //     lesson, L-2). A partial drop stays visible on its own: a discarded point inside the window
  //     shows up as a `gapDays` increment. A TOTAL wipeout does not — it produces an empty series
  //     with `gapDays: 0`, which reads exactly like "this chain has never traded". That is the shape
  //     a unit change (`date` in milliseconds instead of seconds) would produce for every point at
  //     once, so the one case with no other signal gets an explicit one.
  if (rawChart.length > 0 && deduped.length === 0) {
    throw new Error(
      `defillama.normalize(dex.volume.history): the vendor sent ${rawChart.length} chart points for ` +
        `${chain.slug} and none were readable — the point encoding has changed`,
    );
  }

  // 4. WINDOW. Anchored on the newest point the vendor actually has, not on "now": the series is
  //    daily and the current day is not published until it closes, so anchoring on the clock would
  //    report a phantom gap at the end of every window. Both sides are day-buckets now (step 2), so
  //    the anchoring point is always inside its own window.
  const lastTs = deduped.length > 0 ? deduped[deduped.length - 1]!.ts : fetchedAt;
  const toMs = Math.floor(lastTs / DAY_MS) * DAY_MS;
  const requestedFromMs = toMs - (args.days - 1) * DAY_MS;
  const windowed = deduped.filter((point) => point.ts >= requestedFromMs && point.ts <= toMs);

  // 5. TRUNCATION — a GRANULARITY-DRIFT guard, and worth stating precisely because the obvious
  //    version of this check is dead code. The window is `args.days` long and `args.days` is
  //    bounded, so a separate "max points" constant could never fire: a daily series inside an
  //    N-day window has at most N points by construction.
  //
  //    Day-bucketing (step 2b) now folds sub-daily points together, so this fires only if the
  //    vendor produces more DISTINCT days than the window holds — which day-bucketing makes
  //    impossible too. It is kept as a defence-in-depth invariant rather than a live branch, and
  //    `truncated` keeps its meaning: "you did not get what you asked for", never ordinary
  //    windowing, which is the tool doing its job.
  const cappedByWindow = windowed.length > args.days;
  const series = cappedByWindow ? windowed.slice(-args.days) : windowed;
  const returnedSeries = args.includeSeries ? series : [];
  // Folding duplicate days is also "you did not get everything the vendor sent", so it raises the
  // same flag rather than a second one — the reason string says which of the two happened. Reported
  // rather than swallowed: silently collapsing duplicates is how the masked-gap defect (L-4) hid.
  const foldedDuplicates = args.includeSeries && duplicateDays > 0;
  const truncatedSeries = cappedByWindow || foldedDuplicates;

  // 6. GAPS, counted against the WINDOW ACTUALLY COVERED — not against the span of the returned
  //    points (cycle 3, logic L-1, the critic's HIGH). The previous version derived the expected
  //    count from `series[0]`..`series[n-1]`, which makes any gap at the LEADING edge arithmetically
  //    unreachable: move the existing hole to the window's first day and `gapDays` reports 0, and a
  //    chain younger than the window (or any chain at `days: 1825`) reported a five-year window with
  //    "no missing steps". The trailing edge was safe only because `toMs` comes from the last point.
  //
  //    So the frame is the window. `fromMs` is clamped to the first point we actually have, and the
  //    clamp is REPORTED: a short history becomes visible in `window` (fromMs/days) instead of
  //    hiding inside a field nobody cross-checks. What remains in `gapDays` is then exactly what the
  //    name says — days missing INSIDE the covered range. Never stitched: an interpolated point is a
  //    number nobody measured.
  //
  //    With `includeSeries: false` there is no series to judge, so the covered window collapses to
  //    the request and `gapDays` is 0 — `points: 0` is the honest signal there, not a gap count.
  //    The clamp is conditioned on WHERE THE HISTORY STARTS, not on the first returned point — that
  //    distinction is the whole difficulty. "The window's first day is missing" and "the chain has
  //    no history that far back" produce an identical returned series; what separates them is
  //    whether the vendor has ANY point before the window. If it does, the window is fully within
  //    the chain's lifetime and a missing first day is a real gap. If it does not, the history
  //    simply begins later and there is nothing to report as missing. Clamping on the returned
  //    series alone would swallow exactly the leading-edge gap this fix exists to expose.
  //    A series that was REQUESTED and came back EMPTY is the one case the two rules above do not
  //    meet (L-5). `deduped` is empty only when the vendor published nothing at all for this chain —
  //    measured live 2026-07-28 on 5 of the 274 covered chains (`bchyper`, `bsquared`,
  //    `camp-network`, `doge`, `zigchain`), which answer HTTP 200 with `totalDataChart: []`. The
  //    covered window used to collapse to 0 there while `window.days` fell back to `args.days`, so
  //    the two halves of the invariant were computed in different frames and N unmeasured days
  //    reported `gapDays: 0` — "nothing is missing" over a window where nothing exists. The whole
  //    requested window is the honest count: the vendor claims to cover this chain (it is in the
  //    generated `DEFILLAMA_DEX_CHAINS` set) and published no day of it. The leading-edge clamp does
  //    NOT apply — it exists for a chain whose history starts later, and a chain with no point
  //    anywhere gives no evidence of when its history starts.
  const earliestKnown = deduped[0];
  const historyStartsInsideWindow =
    earliestKnown !== undefined && earliestKnown.ts > requestedFromMs;
  const fromMs =
    returnedSeries.length > 0 && historyStartsInsideWindow ? earliestKnown.ts : requestedFromMs;
  const coveredDays =
    returnedSeries.length > 0
      ? Math.round((toMs - fromMs) / DAY_MS) + 1
      : args.includeSeries
        ? args.days
        : 0;
  const gapDays = Math.max(0, coveredDays - returnedSeries.length);

  return {
    chain: chain.slug,
    name: chain.name,
    // `days` reports the window ACTUALLY covered, which is `args.days` whenever the chain has that
    // much history and less when it does not. A caller comparing `window.days` with what it asked
    // for learns the difference; a caller that does not still gets an internally consistent answer
    // where `points + gapDays === days`. With a requested series and no vendor points at all the
    // two expressions agree by construction (`coveredDays === args.days`, L-5); with
    // `includeSeries: false` the request is reported unchanged and the invariant does not apply.
    window: { fromMs, toMs, days: returnedSeries.length > 0 ? coveredDays : args.days },
    series: returnedSeries,
    points: returnedSeries.length,
    gapDays,
    totals: {
      h24: optionalUsd(body.total24h, 'total24h', chain.slug),
      d7: optionalUsd(body.total7d, 'total7d', chain.slug),
      d30: optionalUsd(body.total30d, 'total30d', chain.slug),
      d1y: optionalUsd(body.total1y, 'total1y', chain.slug),
      allTime: optionalUsd(body.totalAllTime, 'totalAllTime', chain.slug),
    },
    truncated: {
      series: truncatedSeries,
      reason: cappedByWindow
        ? `vendor returned ${windowed.length} distinct days inside a ${args.days}-day window — ` +
          `series capped at ${args.days} (the source is documented as daily; check for granularity drift)`
        : foldedDuplicates
          ? `vendor sent ${duplicateDays} extra point(s) for days already present — folded to one ` +
            `per day, last value wins (the source is documented as daily; check for granularity drift)`
          : '',
    },
    source: 'defillama',
    fetchedAt,
  };
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

/** `/protocols` as rows, or a loud refusal. A vendor that starts answering an object where it
 * answered an array is a contract break, not something to paper over with `[]`. */
function catalogRows(raw: unknown): DefillamaCatalogRow[] {
  if (!Array.isArray(raw)) {
    throw new Error(
      `defillama.normalize(protocol.tvl): ${PROTOCOLS_URL} did not return an array (got ${typeof raw})`,
    );
  }
  return raw as DefillamaCatalogRow[];
}

/**
 * How a slug resolves against the catalog. `direct` is one named row; `aggregate` sums a parent's
 * children; `vendor-aggregate` is a parent we refuse to sum ourselves.
 */
type ProtocolResolution =
  | { kind: 'direct'; rows: DefillamaCatalogRow[] }
  | { kind: 'aggregate'; rows: DefillamaCatalogRow[] }
  | { kind: 'vendor-aggregate'; rows: DefillamaCatalogRow[] };

/**
 * Resolve a caller's slug the way the VENDOR resolves it — measured against live answers on
 * 2026-08-11, not inferred from the field names:
 *
 * 1. **A row of its own wins.** `/protocol/beanstalk` answers `0`, the direct row's own figure,
 *    even though a `beanstalk` parent exists whose children total 3.2 M. Five slugs in the catalog
 *    are both a row and a parent; on all of them the vendor answers the row.
 * 2. **Otherwise sum the parent's children.** `uniswap` has no row; summing `uniswap-v1..v4` gives
 *    3.010 B against the vendor's own 3.014 B (−0.12 %, one refresh cycle apart, not a different
 *    quantity). Checked the same way on `aave`, `raydium`, `sky` and `beanstalk-farms`.
 * 3. **Except when the children declare `tokensExcludedFromParent`** — then the vendor subtracts a
 *    double-count we cannot reproduce from this document, and summing is simply wrong: `ether.fi`
 *    sums to 3.823 B against the vendor's 3.491 B, an error of +9.5 %. 38 of the 802 parent slugs
 *    are in this class (curve-finance, ethena, spark, jupiter…). For those we ask the vendor for
 *    its own aggregate rather than inventing one — a fall-back that is small in practice (9 of the
 *    10 largest are under 1.7 MiB) and, where it is not, fails visibly instead of quietly lying.
 */
function resolveProtocol(rows: DefillamaCatalogRow[], slug: string): ProtocolResolution | null {
  const direct = rows.find((r) => r.slug === slug);
  if (direct) return { kind: 'direct', rows: [direct] };
  const children = rows.filter((r) => r.parentProtocolSlug === slug);
  if (children.length === 0) return null;
  const excludes = children.some((r) => {
    const t = r.tokensExcludedFromParent;
    return typeof t === 'object' && t !== null && Object.keys(t).length > 0;
  });
  return { kind: excludes ? 'vendor-aggregate' : 'aggregate', rows: children };
}

/** A row's `chains` as vendor display names, ignoring anything that is not a string. */
function rowChains(row: DefillamaCatalogRow): string[] {
  return Array.isArray(row.chains)
    ? row.chains.filter((c): c is string => typeof c === 'string')
    : [];
}

/** A row's current TVL on one vendor chain name, or `null` when it publishes none there.
 * Reads ONLY the plain key: `Base-borrowed`/`Base-staking`/`Base-pool2` are different quantities,
 * and folding them in would inflate "locked value" with borrowed and staked positions. */
function rowChainTvl(row: DefillamaCatalogRow, vendorChain: string): number | null {
  const map = row.chainTvls;
  if (typeof map !== 'object' || map === null) return null;
  const value = (map as Record<string, unknown>)[vendorChain];
  return typeof value === 'number' ? value : null;
}

/** A row's `chainTvls` keys, or `[]`. */
function rowChainTvlKeys(row: DefillamaCatalogRow): string[] {
  const map = row.chainTvls;
  return typeof map === 'object' && map !== null ? Object.keys(map) : [];
}

/**
 * `protocol.tvl` out of the shared catalog (L-7, L-9).
 *
 * `vendorDoc` is consulted for the total on the `vendor-aggregate` path ONLY — everywhere else the
 * deployment set and every per-chain figure come from the catalog rows, including on that path,
 * because a PARENT's own document answers `chains: []` (measured on `uniswap`, `aave` and
 * `raydium`) and so cannot say where the protocol is deployed.
 */
function normalizeProtocolTvl(
  chain: ChainInfo,
  raw: unknown,
  slug: string,
  vendorDoc: unknown,
  vendorChainToSlug: ReadonlyMap<string, string>,
  fetchedAt: number,
): ProtocolTvlResult {
  const rows = catalogRows(raw);
  const resolved = resolveProtocol(rows, slug);
  if (!resolved) {
    throw new Error(
      `defillama.normalize: unknown protocol slug "${slug}" — neither a row nor a parent in the catalog`,
    );
  }

  // Vendor chain name → summed current TVL across the contributing rows. `null` records "listed as
  // a deployment, but no plain-TVL figure published", which is NOT the same as zero and must not
  // collapse into it (L-9).
  const perChain = new Map<string, number | null>();
  let unmappedDeployments = 0;
  const add = (vendorChain: string, value: number | null): void => {
    const prev = perChain.get(vendorChain);
    if (value === null) {
      if (prev === undefined) perChain.set(vendorChain, null);
      return;
    }
    perChain.set(vendorChain, (prev ?? 0) + value);
  };
  for (const row of resolved.rows) {
    // Collect this row's chains FIRST, then contribute each exactly once. The two vendor fields
    // overlap almost entirely, so adding straight from both loops double-counts every ordinary
    // chain — caught by the fixture, where `lido` on ethereum came back at exactly 2× its figure.
    const rowVendorChains = new Set<string>();
    // The declared deployment list is the authority on WHERE, so an unknown name here is a genuine
    // gap in our registry and gets counted. A `chainTvls` key cannot be counted the same way: the
    // bucket keys (`X-borrowed`) live in that same namespace, so an unrecognised one is far more
    // likely a bucket than a chain, and counting it would inflate the gap with noise.
    for (const vendorChain of rowChains(row)) {
      if (vendorChainToSlug.has(vendorChain)) rowVendorChains.add(vendorChain);
      else unmappedDeployments += 1;
    }
    // A figure published for a chain the row forgot to list still counts as a deployment — the
    // vendor's two fields are maintained separately and do drift.
    for (const key of rowChainTvlKeys(row)) {
      if (vendorChainToSlug.has(key)) rowVendorChains.add(key);
    }
    for (const vendorChain of rowVendorChains) add(vendorChain, rowChainTvl(row, vendorChain));
  }

  const deployments = [...perChain]
    .map(([vendorChain, tvlUsd]) => ({
      // Non-null by construction: only keys `vendorChainToSlug` knows ever reach `perChain`.
      chain: vendorChainToSlug.get(vendorChain) as string,
      tvlUsd,
    }))
    // TVL-descending, unknown last. `-1` rather than `0` so a genuine zero still outranks a
    // missing measurement — the two mean different things and the order should say so.
    .sort((a, b) => (b.tvlUsd ?? -1) - (a.tvlUsd ?? -1));

  const vendorChain = chain.vendors['defillama'] ?? chain.name;
  const deployed = perChain.has(vendorChain);
  // Not deployed → `0`, which is a true statement about the world. Deployed with no plain figure →
  // `null`, because we did not measure it. See `ProtocolTvlResult.tvlUsd`.
  const tvlUsd = deployed ? (perChain.get(vendorChain) ?? null) : 0;

  let totalTvlUsd: number | undefined;
  if (resolved.kind === 'vendor-aggregate') {
    totalTvlUsd = lastTotalLiquidityUsd((vendorDoc as DefillamaProtocolResponse | undefined)?.tvl);
  } else {
    let sum = 0;
    let measured = false;
    for (const row of resolved.rows) {
      if (typeof row.tvl === 'number') {
        sum += row.tvl;
        measured = true;
      }
    }
    totalTvlUsd = measured ? sum : undefined;
  }
  if (totalTvlUsd === undefined) {
    throw new Error(`defillama.normalize: protocol "${slug}" publishes no TVL total`);
  }

  const directName = resolved.kind === 'direct' ? resolved.rows[0]?.name : undefined;
  const vendorName =
    resolved.kind === 'vendor-aggregate'
      ? (vendorDoc as DefillamaProtocolResponse | undefined)?.name
      : undefined;
  const protocol =
    typeof directName === 'string'
      ? directName
      : typeof vendorName === 'string'
        ? vendorName
        : slug;

  // Adversarial cycle 2, finding 1b, unchanged in intent: a bad vendor value (negative, NaN,
  // ±Infinity) must never be cached as a "successful" result. Widened to the per-chain list, which
  // is new surface for the same class of garbage.
  const invalid = (v: number | null): boolean => v !== null && (!Number.isFinite(v) || v < 0);
  if (
    invalid(tvlUsd) ||
    !Number.isFinite(totalTvlUsd) ||
    totalTvlUsd < 0 ||
    deployments.some((d) => invalid(d.tvlUsd))
  ) {
    throw new Error(
      `defillama.normalize: invalid tvl value(s) for chain ${chain.slug} (tvlUsd=${String(tvlUsd)}, totalTvlUsd=${totalTvlUsd})`,
    );
  }

  return {
    protocol,
    chain: chain.slug,
    tvlUsd,
    totalTvlUsd,
    deployed,
    deployments,
    unmappedDeployments,
    aggregatedFrom:
      resolved.kind === 'direct'
        ? []
        : resolved.rows.map((r) => r.slug).filter((s): s is string => typeof s === 'string'),
    source: 'defillama',
    fetchedAt,
  };
}

/**
 * DeFiLlama adapter (ARCHITECTURE.md §3.2/§5.3, R-7): `protocol.tvl` out of the shared
 * `GET /protocols` catalog, sliced to `chainTvls[chain]` for the chain-specific TVL and summed (or
 * read from the vendor's own parent document) for the protocol-wide total — see `PROTOCOLS_URL`
 * and `resolveProtocol` for why it is that document and not `/protocol/{slug}` (L-7).
 */
export function createDefillamaAdapter(deps: DefillamaAdapterDeps = {}): ProviderAdapter {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const chains = deps.chains ?? loadChainRegistry();
  const throttle = deps.throttle ?? productionThrottle;

  /**
   * The caller's ceiling applied to waiting for a **shared, in-flight document** (WI-37).
   *
   * **This adapter is the one that cannot simply forward the deadline, and the reason is its own
   * document caches.** `chain.tvl` and `dex.volume.history` are served out of promises SHARED between
   * concurrent callers — that sharing is the point (cycle 5, L-9: ten chains used to download the
   * identical 458-row catalog ten times). Handing the first caller's `deadlineAtMs` to the `safeFetch`
   * inside that shared body would let its expiry ABORT a download a second caller is also awaiting,
   * one who may have a far larger budget. That is H-1's shape — one requester's limit cutting off
   * another's — and it is the same thing WI-12 closed for in-flight cache entries.
   *
   * So the download stays caller-independent and the WAIT is what the deadline bounds: an abandoning
   * caller leaves the transfer running, which is exactly what a document cache is for, and the next
   * caller (or its retry) finds it complete. The bytes already paid for are not thrown away.
   *
   * `Date.now()`, deliberately, and NOT this adapter's injectable `now()`: a deadline is an absolute
   * moment on the real clock, shared with `safeFetch`, the limiter and the registry. `deps.now` exists
   * so tests can drive TTL windows, and reading it here would let a fixed test clock silently disable
   * every deadline comparison in the file.
   */
  const awaitSharedDocument = async <T>(
    document: Promise<T>,
    deadlineAtMs: number | undefined,
    what: string,
  ): Promise<T> => {
    if (deadlineAtMs === undefined) return document;
    const remainingMs = deadlineAtMs - Date.now();
    // Already spent: the same entry check `safeFetch` performs, for the same reason — a bound can
    // only cut short a wait that was begun, and not beginning it is what a spent deadline means.
    if (remainingMs <= 0) throw new DeadlineExceededError(what, deadlineAtMs);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bound = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new DeadlineExceededError(what, deadlineAtMs)), remainingMs);
      timer.unref?.();
    });
    // `Promise.race` attaches handlers to `document`, so a shared download that fails AFTER this
    // caller walked away is handled rather than unhandled — the failure mode that ends a stdio
    // server on Node's default `--unhandled-rejections=throw`.
    return Promise.race([document, bound]).finally(() => {
      if (timer !== undefined) clearTimeout(timer);
    });
  };

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

  /**
   * One shared, short-lived copy of `/protocols` — the same single-slot shape as `chainsCatalog`
   * above, for the same reason and now with a much larger prize (L-7). Every `protocol.tvl` call
   * used to download that protocol's own multi-megabyte history; they now share one 8.14 MiB
   * document per TTL window, and a second slug inside the window costs no transfer at all.
   *
   * The window is read from the capability manifest rather than restated as a literal, so a TTL
   * edit cannot leave this serving data older than the engine's own cache would (the
   * two-windows-in-series defect, vdd-multi cycle 6 M-1).
   */
  let protocolsCatalog: { at: number; body: Promise<unknown> } | null = null;
  const PROTOCOLS_CATALOG_TTL_MS = ttlFor('protocol.tvl') * 1000;

  /**
   * Vendor chain display name → our canonical slug, built once per adapter instance.
   *
   * The catalog names chains the vendor's way (`Binance`, `xDai`, `zkSync Era`); every string this
   * adapter emits must be OURS (the anti-corruption rule the DEX contract states at length). A
   * `Map` because `deployments` does one lookup per deployment chain per call — 22 for `aave-v3`.
   */
  const vendorChainToSlug = new Map<string, string>();
  for (const info of chains.list()) {
    const vendorName = info.vendors['defillama'];
    if (vendorName != null) vendorChainToSlug.set(vendorName, info.slug);
  }

  /**
   * One shared, short-lived copy of each chain's DEX-volume document (TASK-007 task 007-4, R-70).
   *
   * The engine's own cache is keyed on `(provider, capability, argsHash)`, and `days` is part of
   * `args` — so asking for 30, 90 and 365 days of the same chain is three cache keys and, without
   * this, three downloads of the SAME 250KB document, since the vendor has no windowing parameter.
   * Here they share one.
   *
   * `includeSeries` is part of the key because it changes the REQUEST (`excludeTotalDataChart`), so
   * the two modes are genuinely different documents; a no-chart copy must never satisfy a caller
   * that asked for the series.
   *
   * Per adapter INSTANCE, never a module singleton (§8) — same shape as `chainsCatalog` above and
   * as `nansen`'s `accountState`. The promise is stored, not its value, so concurrent callers share
   * one in-flight request; a rejection is evicted so the next call retries rather than remembering
   * a blip for an hour.
   *
   * **BOUNDED, unlike `chainsCatalog` above — and that difference is the whole risk.**
   * `chainsCatalog` is a single slot, so it cannot grow. Generalizing the pattern to a MAP does:
   * every `(chain, mode)` pair asked for inside the window retains a parsed ~250KB document, and
   * nothing removed them. A sweep over the 274 covered chains in both modes would pin ~137MB in a
   * long-lived stdio process, and a chain queried once was held for the full hour regardless. Both
   * halves are fixed below: expired entries are dropped on every insert, and the map is capped at
   * `MAX_DEX_DOCUMENTS`, oldest evicted first (`Map` preserves insertion order). The cap is a
   * MEMORY bound, not a correctness one — evicting early costs one refetch of a free endpoint,
   * which is exactly the trade this cache is allowed to make.
   *
   * **An UNSETTLED entry is never evicted** (WI-12). Eviction runs before the outcome of a fetch is
   * known, so on a sweep wider than the cap it used to drop entries whose download was still in
   * flight. Those downloads completed anyway — the caller awaiting the promise still got its data —
   * but the map kept no record, so the next window on the same chain was a MISS. That silently
   * broke the single property this cache exists for. It is not theoretical at the scale the tools
   * steer a model into: `onchain_list_chains` pages 50 chains by default, and a 50-chain sweep lost
   * 18 documents (~4.5MB of duplicate transfer and ~3.6s of rate-limit budget). The previous
   * adversarial cycle looked straight at this eviction and pronounced it safe — correctly, because
   * it examined CORRECTNESS. Nothing returns a wrong answer here; the cost is pure waste, which is
   * why it survived a correctness review and needed a performance one.
   */
  const dexDocuments = new Map<string, { at: number; body: Promise<unknown>; settled: boolean }>();
  /** Window for a cached document, read from the SAME table the engine's own cache uses rather than
   * restated as a literal. If `ttlFor('dex.volume.history')` were lowered and this stayed at an
   * hour, a caller would get hour-old data under a shorter TTL while every freshness signal it can
   * read claimed otherwise — the two-windows-in-series defect recorded as vdd-multi cycle 6, M-1. */
  const DEX_DOCUMENT_TTL_MS = ttlFor('dex.volume.history') * 1000;
  /**
   * Slot count for the document cache. ~13MB of PARSED heap at 32 slots — the observed 250KB of
   * wire text expands to roughly 415KB of object graph, so the earlier "~8MB" comment multiplied
   * wire bytes by a slot count to describe a heap budget and came out ~1.6× low (cycle 3,
   * performance M-1). The number is stated in the unit it is actually spent in.
   *
   * VALIDATED, not merely defaulted (cycle 3, logic L-7): `maxDocuments: NaN` makes
   * `size >= NaN` false forever, which silently restores the unbounded map that the previous
   * adversarial cycle added this bound to remove. A knob that can turn off the safety mechanism it
   * configures, while looking configured, is worth one line to refuse.
   */
  const MAX_DEX_DOCUMENTS = deps.maxDocuments ?? 32;
  if (!Number.isInteger(MAX_DEX_DOCUMENTS) || MAX_DEX_DOCUMENTS < 1) {
    throw new Error(
      `createDefillamaAdapter: maxDocuments must be a positive integer (got ${String(deps.maxDocuments)})`,
    );
  }

  const fetchDexDocument = async (
    vendorName: string,
    includeSeries: boolean,
    deadlineAtMs?: number,
  ): Promise<{ body: unknown; fetchedAt: number }> => {
    const key = `${vendorName}::${String(includeSeries)}`;
    const cached = dexDocuments.get(key);
    if (cached && now() - cached.at < DEX_DOCUMENT_TTL_MS) {
      return {
        body: await awaitSharedDocument(cached.body, deadlineAtMs, 'defillama dex document'),
        fetchedAt: cached.at,
      };
    }
    // A no-chart request is served from a WITH-chart document when one is already cached (WI-15).
    // The `true` document is a strict superset — `normalizeDexVolume` returns `[]` for the series
    // whenever `includeSeries` is false, regardless of what the document holds — so this can only
    // save a download, never change an answer. Without it, the natural exploration order ("totals
    // first, then the series") downloads both documents for one chain: 185KB + 250KB where 250KB
    // alone answers both. Across a 50-chain sweep that is ~9MB and 50 throttle tokens.
    //
    // Deliberately one-directional: a with-chart request is NEVER served from a no-chart document,
    // because that one genuinely lacks the data (measured: the vendor keeps `totalDataChart` and
    // sets it to `[]`).
    if (!includeSeries) {
      const withChartKey = `${vendorName}::true`;
      const withChart = dexDocuments.get(withChartKey);
      if (withChart && now() - withChart.at < DEX_DOCUMENT_TTL_MS) {
        return {
          body: await awaitSharedDocument(withChart.body, deadlineAtMs, 'defillama dex document'),
          fetchedAt: withChart.at,
        };
      }
    }
    // An expired entry we just looked at is dropped HERE, on the read path (cycle 3, logic L-6 /
    // performance M-2). The sweep below runs only when a new document is fetched, so an adapter
    // that goes idle after filling the map used to retain up to `MAX_DEX_DOCUMENTS` EXPIRED
    // documents for the life of the process — the previous comment claimed the opposite ("an idle
    // adapter ends up holding nothing"), which is precisely the retention property it described
    // avoiding.
    if (cached) dexDocuments.delete(key);
    // Then drop everything else that has aged out, and bound what remains. Both passes skip
    // UNSETTLED entries (WI-12): an in-flight download is about to become a cache entry, and
    // evicting it throws away bytes already paid for while the caller still receives them.
    const sweepAt = now();
    for (const [existingKey, existing] of dexDocuments) {
      if (existing.settled && sweepAt - existing.at >= DEX_DOCUMENT_TTL_MS) {
        dexDocuments.delete(existingKey);
      }
    }
    while (dexDocuments.size >= MAX_DEX_DOCUMENTS) {
      const evictable = [...dexDocuments].find(([, entry]) => entry.settled);
      // Every entry still in flight: the cap yields rather than discarding a download in progress.
      // The map can exceed `MAX_DEX_DOCUMENTS` only by the number of CONCURRENT fetches, which is
      // bounded by the caller's own concurrency and by the provider rate limiter — and each of
      // those entries becomes evictable the moment it settles.
      if (!evictable) break;
      dexDocuments.delete(evictable[0]);
    }
    const url = dexVolumeUrl(vendorName, includeSeries);
    const body = (async (): Promise<unknown> => {
      await throttle('defillama', RATE_LIMIT);
      // No headers at all — this endpoint is keyless, and sending an empty auth header would be a
      // quiet way to start depending on one.
      const response = await safeFetch(url, {}, HOSTS, fetchImpl, {
        maxResponseBytes: DEX_MAX_RESPONSE_BYTES,
      });
      if (!response.ok) {
        // A chain the vendor does not know answers HTTP 500, not 404 (measured: /overview/dexs/dash).
        // The coverage gate should have refused it long before here, so reaching this is a signal
        // that our list and the vendor's have drifted — say the status out loud.
        throw new Error(`defillama: HTTP ${response.status} for ${url}`);
      }
      // PROJECTED to the seven fields we actually read, before the promise resolves (WI-13).
      // The parsed document is ~415KB of object graph, of which the daily chart is ~124KB; the
      // rest is 151 protocol cards (`name`/`category`/`methodology`/`logo`) plus `allChains[287]`.
      // Keeping the whole thing meant retaining ~13MB across 32 slots for an hour — three quarters
      // of it fields this adapter is contractually forbidden from reading.
      //
      // The peak during `.json()` is unchanged; what shrinks is the RETAINED set, which is the one
      // that lives for the TTL. And R-68e stops being a discipline and becomes a fact: the
      // third-party-editable text is not in memory to leak, so no future edit here can leak it.
      const parsed = (await response.json()) as DefillamaDexResponse;
      return {
        chain: parsed.chain,
        totalDataChart: parsed.totalDataChart,
        total24h: parsed.total24h,
        total7d: parsed.total7d,
        total30d: parsed.total30d,
        total1y: parsed.total1y,
        totalAllTime: parsed.totalAllTime,
      } satisfies DefillamaDexResponse;
    })();
    const entry = { at: now(), body, settled: false };
    dexDocuments.set(key, entry);
    body.then(
      () => {
        entry.settled = true;
      },
      () => {
        // A rejection settles the entry AND removes it: a blip must not be remembered for the TTL.
        // The identity check keeps a late rejection from evicting a newer entry for the same key.
        entry.settled = true;
        if (dexDocuments.get(key) === entry) dexDocuments.delete(key);
      },
    );
    // The caller that STARTED the download is bounded exactly like one that joined it: the entry is
    // already in `dexDocuments`, so from this line on the promise is shared and the argument in
    // `awaitSharedDocument` applies unchanged.
    return {
      body: await awaitSharedDocument(body, deadlineAtMs, 'defillama dex document'),
      fetchedAt: entry.at,
    };
  };

  const fetchChainsCatalog = async (
    deadlineAtMs?: number,
  ): Promise<{ body: unknown; fetchedAt: number }> => {
    const cached = chainsCatalog;
    if (cached && now() - cached.at < CHAINS_CATALOG_TTL_MS) {
      return {
        body: await awaitSharedDocument(cached.body, deadlineAtMs, 'defillama chains catalog'),
        fetchedAt: cached.at,
      };
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
    return {
      body: await awaitSharedDocument(body, deadlineAtMs, 'defillama chains catalog'),
      fetchedAt: entry.at,
    };
  };

  /** `/protocols`, shared and short-lived — the `fetchChainsCatalog` pattern above, verbatim,
   * including the rule that a failed fetch is evicted rather than remembered for the window. */
  const fetchProtocolsCatalog = async (
    deadlineAtMs?: number,
  ): Promise<{ body: unknown; fetchedAt: number }> => {
    const cached = protocolsCatalog;
    if (cached && now() - cached.at < PROTOCOLS_CATALOG_TTL_MS) {
      return {
        body: await awaitSharedDocument(cached.body, deadlineAtMs, 'defillama protocols catalog'),
        fetchedAt: cached.at,
      };
    }
    const body = (async (): Promise<unknown> => {
      await throttle('defillama', RATE_LIMIT);
      const response = await safeFetch(PROTOCOLS_URL, {}, HOSTS, fetchImpl);
      if (!response.ok) throw new Error(`defillama: HTTP ${response.status} for ${PROTOCOLS_URL}`);
      return (await response.json()) as unknown;
    })();
    const entry = { at: now(), body };
    protocolsCatalog = entry;
    body.catch(() => {
      if (protocolsCatalog === entry) protocolsCatalog = null;
    });
    return {
      body: await awaitSharedDocument(body, deadlineAtMs, 'defillama protocols catalog'),
      fetchedAt: entry.at,
    };
  };

  return {
    id: 'defillama',
    // TASK-006 (R-54): "does DeFiLlama know this chain" is a fact the registry already records —
    // reading it here means the answer cannot drift from the data, unlike a second hand-kept list.
    //
    // TASK-007 (task 007-1, R-63): the answer became CAPABILITY-DEPENDENT, and the reason is
    // measured rather than defensive. `vendors.defillama` was populated from the vendor's TVL
    // catalog (`/v2/chains`), so it is non-null for all 458 registry rows — but the vendor's
    // DEX-volume dataset covers 287 chains, of which 274 are ours. Reusing the TVL predicate for
    // `dex.volume.history` would advertise the capability on 184 chains that have no such data:
    // the exact defect TASK-006's review recorded as H-1 (coverage widened, transport not).
    chainSupport: (chain: ChainInfo, capability: string): boolean => {
      if (capability === 'dex.volume.history') return coversDexVolume(chain);
      return chain.vendors['defillama'] != null;
    },
    // No `chains` narrowing: the chain dimension is the coverage matrix's job now (§4.2.3).
    capabilities: () => [{ id: 'protocol.tvl' }, { id: 'chain.tvl' }, { id: 'dex.volume.history' }],
    // Zero for all three: this vendor is keyless and free on every endpoint we call. Unlike
    // `dune`'s `costOf: () => ({credits: 0})` — which is a sleeping fail-closed inversion on a
    // CREDIT-METERED vendor — there is no meter here to under-report.
    costOf: () => ({ credits: 0 }),
    fetch: async (
      cap: string,
      args: Record<string, unknown>,
      /**
       * WI-37. Two DIFFERENT mechanisms below, and the split is this adapter's own shape rather
       * than a preference: `protocol.tvl` issues a per-call request, so the deadline goes straight
       * into the limiter and `safeFetch` and can genuinely cancel it; the other two are served from
       * SHARED documents, where it bounds this caller's WAIT and leaves the download alone (see
       * `awaitSharedDocument`).
       */
      deadlineAtMs?: number,
    ): Promise<DefillamaFetchResult> => {
      if (cap === 'dex.volume.history') {
        const dexArgs = extractDexVolumeArgs(args, chains);
        const vendorName = dexArgs.chain.vendors['defillama'];
        // Unreachable: `coversDexVolume` in `extractDexVolumeArgs` already required a non-null
        // vendor name. Asserted rather than assumed, because the alternative is `undefined` reaching
        // a URL.
        if (vendorName == null) {
          throw new Error(
            `defillama.fetch(dex.volume.history): no vendor name for ${dexArgs.chain.slug}`,
          );
        }
        const document = await fetchDexDocument(vendorName, dexArgs.includeSeries, deadlineAtMs);
        return {
          chain: dexArgs.chain,
          raw: document.body,
          // The DOCUMENT's timestamp, not `normalize()`'s (the reasoning `chain.tvl` records below:
          // two TTL windows in series do not compose into one, and a caller reading `fetchedAt`
          // must see the age of the DATA).
          fetchedAt: document.fetchedAt,
          dex: dexArgs,
        };
      }
      if (cap === 'chain.tvl') {
        const chain = extractChainArg(args, chains);
        // `fetchedAt` is the CATALOG's timestamp, not `normalize()`'s (vdd-multi cycle 6, M-1).
        // Two windows in series do not compose into one: a catalog fetched at t=0 and served to a
        // new chain at t=299 s was then cached under `chain.tvl`'s own 300 s TTL, so a caller at
        // t=598 s received 598-second-old TVL while every freshness signal it can read — `ageMs`
        // and `fetchedAt` — claimed ≤300 s. Reporting the catalog's own age makes the staleness
        // visible rather than removing it.
        const catalog = await fetchChainsCatalog(deadlineAtMs);
        return { chain, raw: catalog.body, fetchedAt: catalog.fetchedAt };
      }
      const { chain, protocolSlug } = extractFetchArgs(args, chains);
      const catalog = await fetchProtocolsCatalog(deadlineAtMs);
      const resolved = resolveProtocol(catalogRows(catalog.body), protocolSlug);
      // An unknown slug is settled HERE, against the catalog, instead of costing a request that
      // would come back 400 or — worse — 200 with a body meaning something else.
      if (!resolved) {
        throw new Error(
          `defillama.fetch: unknown protocol slug "${protocolSlug}" — neither a row nor a parent in the catalog`,
        );
      }
      if (resolved.kind !== 'vendor-aggregate') {
        return {
          chain,
          raw: catalog.body,
          fetchedAt: catalog.fetchedAt,
          protocol: { slug: protocolSlug },
        };
      }
      // The narrow fall-back: this parent nets out double-counted tokens, so only the vendor's own
      // aggregate is right. A per-call request, so the deadline is forwarded the ordinary way —
      // limiter first, then the transport, spread conditionally so a call without a deadline builds
      // the options object it built before WI-37.
      const url = `https://api.llama.fi/protocol/${encodeURIComponent(protocolSlug)}`;
      await throttle('defillama', RATE_LIMIT, 1, deadlineAtMs);
      const response = await safeFetch(url, {}, HOSTS, fetchImpl, {
        ...(deadlineAtMs === undefined ? {} : { deadlineAtMs }),
      });
      if (!response.ok) {
        throw new Error(`defillama: HTTP ${response.status} for ${url}`);
      }
      const vendorDoc: unknown = await response.json();
      return {
        chain,
        raw: catalog.body,
        fetchedAt: catalog.fetchedAt,
        protocol: { slug: protocolSlug, vendorDoc },
      };
    },
    normalize: (
      cap: string,
      rawResult: unknown,
    ): ProtocolTvlResult | ChainTvlResult | DexVolumeResult => {
      const { chain, raw, fetchedAt, dex, protocol } = rawResult as DefillamaFetchResult;
      if (cap === 'dex.volume.history') {
        if (!dex) {
          throw new Error(
            'defillama.normalize(dex.volume.history): fetch result carries no validated args',
          );
        }
        return normalizeDexVolume(chain, raw, dex, fetchedAt ?? now());
      }
      if (cap === 'chain.tvl') return normalizeChainTvl(chain, raw, fetchedAt ?? now());
      if (!protocol) {
        throw new Error('defillama.normalize(protocol.tvl): fetch result carries no protocol slug');
      }
      return normalizeProtocolTvl(
        chain,
        raw,
        protocol.slug,
        protocol.vendorDoc,
        vendorChainToSlug,
        fetchedAt ?? now(),
      );
    },
    isAvailable: () => ({ ok: true }),
  };
}
