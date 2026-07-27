import { isValidAddress, normalizeAddress } from '../../chain/address.js';

import { EntityLabelSchema, type EntityLabel } from '../../types/entity-label.js';
import { SmartMoneyFlowSchema, type SmartMoneyFlow } from '../../types/smart-money-flow.js';
import { TokenRiskScoreSchema, type TokenRiskScore } from '../../types/token-risk-score.js';
import type { Chain } from '../../types/chain.js';
import type { ChainFamily } from '../../chain/registry-core.js';
import type { NansenEndpointResult } from './endpoints.js';

/**
 * Upper bound on vendor rows mapped per response (adversarial cycle 1, performance + security).
 * None of these endpoints are sent a pagination/limit parameter, so the response size — and hence
 * the size of the `cache_entries.value_json` row, the JSON-RPC payload, and ultimately the model's
 * context window — is entirely the vendor's choice. Each row also costs a keccak256/base58 decode
 * in `normalizeAddress`. Slicing happens BEFORE the per-row work and before `Schema.parse`, so an
 * unexpectedly large-but-valid response degrades (truncates) instead of failing normalization.
 */
const MAX_VENDOR_ROWS = 200;

/** Element cap for vendor-authored string arrays — mirrors the `.max(64)` schema backstops. */
const MAX_VENDOR_STRING_ITEMS = 64;
/** Length cap for a single vendor-authored string — mirrors the `.max(256)` schema backstops. */
const MAX_VENDOR_STRING_LENGTH = 256;

/**
 * TRUNCATE vendor-authored text rather than letting the schema cap reject it (cycle-2 review M-1).
 *
 * The `.max(256)`/`.max(64)` caps added in cycle 1 were the right call for context and
 * prompt-injection surface, but enforcing them *only* through `Schema.parse` was the wrong
 * mechanism: a parse throw happens AFTER the credits are spent, and `registry.ts` caches only on a
 * successful normalize — so nothing is cached, the adapter is recorded as `tried`, the tool returns
 * `CapabilityUnavailableError`, and the agent's retry PAYS AGAIN. That converted "an attacker can
 * author a long token name" into "an attacker can drain credits", which is strictly worse than the
 * problem the caps solved: a 300-character token symbol would make `smart-money.flows` permanently
 * un-normalizable for that token at 10cr per attempt, and a heavily-labeled address (a CEX hot
 * wallet, a fund) with 65+ profiler labels would burn 100cr — the whole free-plan balance — every
 * time. Truncating here keeps the bound while degrading gracefully; the schema caps stay as
 * backstops that can now never be reached from this path.
 */
function truncateString(value: string): string {
  return value.length > MAX_VENDOR_STRING_LENGTH ? value.slice(0, MAX_VENDOR_STRING_LENGTH) : value;
}

/**
 * Matches the `.int().nonnegative()` refinement the canonical schemas apply to optional numeric
 * enrichment fields, so a value that would fail validation is DROPPED here rather than thrown at
 * `Schema.parse` — see the cycle-3 3.2 note at the call sites for why a post-payment throw on an
 * optional field is the worst possible failure mode.
 */
function isNonNegativeInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

/**
 * Is this vendor array element safe to property-access? (vdd-multi cycle 4, logic L-5.)
 *
 * Every row guard in this file is shaped `typeof row.field !== 'string'` — which is itself a throw
 * when `row` is `null`, because reading a property off `null` raises a raw TypeError BEFORE the
 * `typeof` can help. `null` is legal JSON and a routine serialisation artifact, so a single null
 * element in an otherwise-good response destroyed the whole ALREADY-PAID result: nothing cached,
 * the retry pays again. That is the same post-payment-throw class the truncation work above closed
 * for oversized strings, left open one level up at the element itself.
 *
 * **It downgrades the failure to dropping the one bad row on the four DROP-LOOP paths only** —
 * `mapTopHolders`, `mapSearchGeneral`'s tokens[] and entities[], `mapHolderLabels` — plus the
 * profiler map. On `mapIndicator` it converts a raw TypeError into this module's typed error and
 * nothing more: `token.risk` still loses the paid 6cr response, because that path ALREADY throws by
 * design on a missing `indicator_type` (TC-CONTRACT-05), and turning it into a drop is a change to
 * a documented contract rather than a bug fix. That residual is tracked as the wider
 * negative-caching issue, `docs/issues/l-1-nansen-no-negative-caching-*.md` — stated here so this
 * docstring does not claim a bound it does not deliver on every call site.
 */
function isRecord(row: unknown): row is Record<string, unknown> {
  return typeof row === 'object' && row !== null;
}

/** Element-wise filter + per-item truncation + cardinality cap for a vendor string array. */
function truncateStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .slice(0, MAX_VENDOR_STRING_ITEMS)
    .map(truncateString);
}

const SOURCE = 'nansen';

/**
 * `adapters/nansen/index.ts`'s `fetch()` own private hand-off shape for `smart-money.flows` (never
 * seen by `CapabilityRegistry`, which only ever sees `unknown` — anti-corruption layer, D4, same
 * convention as `coingecko`'s `CoingeckoFetchResult`). `tokenAddress` is already normalized
 * (`normalizeAddress`, done once in `fetch()`); `netflow`/`holders` carry the FULL
 * `{body, creditsUsedHeader}` tuple from `endpoints.ts` (not just `body`) — `creditsUsedHeader` is
 * unused by `normalizeSmartMoneyFlow` below, kept here so a future reconciliation step (task 005-5)
 * has both sub-calls' headers available without a second fetch.
 */
export interface SmartMoneyFlowsFetchResult {
  chain: Chain;
  /** The chain's address FAMILY, used to decide whether case-folding a vendor address is safe.
   * Keyed on family rather than on the chain name (vdd-multi cycle 6, L-3) for the same reason
   * `endpoints.ts`'s `netflowTokenAddressFilter` is: the rule is about the ENCODING, not the
   * chain, and `smart-money.flows` already covers a non-EVM chain beyond `solana`. */
  family: ChainFamily;
  tokenAddress: string;
  netflow: NansenEndpointResult;
  holders: NansenEndpointResult;
}

/**
 * `entity.labels`' hand-off shape — the exact set of populated optional fields depends on which
 * tier `fetch()` routed through (system-architecture.md §3.2 capability table):
 * - default/token-scoped (`premiumRequested: false`): `search`+`entityName` always populated,
 *   `holders` populated only when `tokenAddress` was given.
 * - `exhaustive: true` (`premiumRequested: true`): ONLY `profilerLabels` populated — `search`/
 *   `entityName`/`holders` are `undefined` (that tier never calls those endpoints, per
 *   system-architecture.md §3.2: "только /profiler/address/labels").
 *
 * `entityName`'s response is carried but never read by `normalizeEntityLabels` (see
 * `endpoints.ts`'s `postSearchEntityName` docstring for why).
 */
export interface EntityLabelsFetchResult {
  chain: Chain;
  /**
   * NANSEN's own chain token for `chain` (`bnb` for our `bsc`), i.e. exactly what the request sent
   * and therefore exactly what the vendor echoes back in `GeneralSearchResponse.tokens[].chain`.
   *
   * **Carried because comparing the echo against OUR slug silently emptied the token half of a
   * PAID response** (vdd-multi cycle 6, H-2). Cycle 5 widened the transport to send the vendor's
   * token while `mapSearchGeneral` kept comparing against the slug — identical for `ethereum` and
   * `solana`, different for every one of the ~20 chains where the two vocabularies diverge, so on
   * those chains EVERY token row was dropped from a response we had already paid for. Non-empty,
   * schema-valid, plausible, and missing half its data: the exact failure class this file's own
   * comments describe as having cost 20 live credits to diagnose.
   */
  vendorChain: string;
  tokenAddress: string | undefined;
  premiumRequested: boolean;
  search: NansenEndpointResult | undefined;
  entityName: NansenEndpointResult | undefined;
  holders: NansenEndpointResult | undefined;
  profilerLabels: NansenEndpointResult | undefined;
}

/**
 * `token.risk`'s hand-off shape. BOTH sub-responses are consumed (R-43 "always both").
 *
 * `tokenInformation` used to be fetched, paid for (1cr of the capability's 6) and then discarded —
 * this docstring previously said so outright, calling it "a future extension without a second live
 * call". Issue Q-4 closed that: the recorded fixtures show `/tgm/indicators`' own `token_info`
 * carries exactly three fields (`market_cap_usd`, `market_cap_group`, `is_stablecoin`) while
 * `/tgm/token-information` carries roughly twenty, including deployment date, FDV, supply figures,
 * liquidity and holder count — all first-order risk inputs. So R-43's "(метаданные)" was right and
 * the implementation was the part that was wrong; `normalizeTokenRiskScore` now reads both.
 */
export interface TokenRiskFetchResult {
  chain: Chain;
  address: string;
  indicators: NansenEndpointResult;
  tokenInformation: NansenEndpointResult;
}

// ---------------------------------------------------------------------------------------------
// smart-money.flows (R-31)
// ---------------------------------------------------------------------------------------------

interface SmartMoneyNetflowRow {
  token_address?: unknown;
  token_symbol?: unknown;
  net_flow_1h_usd?: unknown;
  net_flow_24h_usd?: unknown;
  net_flow_7d_usd?: unknown;
  net_flow_30d_usd?: unknown;
  trader_count?: unknown;
  token_age_days?: unknown;
  token_sectors?: unknown;
}

interface SmartMoneyNetflowResponseBody {
  data?: unknown;
}

interface TgmHolderRow {
  address?: unknown;
  address_label?: unknown;
  token_amount?: unknown;
  value_usd?: unknown;
  ownership_percentage?: unknown;
}

interface TgmHoldersResponseBody {
  data?: unknown;
}

function requireFiniteNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`nansen.normalize(smart-money.flows): missing/invalid "${field}" in response`);
  }
  return value;
}

/** Maps `TGMHoldersResponse.data[]` into `SmartMoneyFlow.topHolders[]` — a deliberate SUBSET of
 * `TGMHolder`'s fields (`SmartMoneyTopHolderSchema`, `types/smart-money-flow.ts`). Vendor holder
 * rows with no string `address` are skipped (defensive — every field of `TGMHolder` is optional
 * per the vendor schema, but this canonical schema's `address` is required); this never throws for
 * a token with zero holders in the response (`topHolders: []` is a valid result, same "empty array
 * is not an error" spirit as R-32). */
function mapTopHolders(holdersBody: unknown, chain: Chain): SmartMoneyFlow['topHolders'] {
  const body = holdersBody as TgmHoldersResponseBody;
  if (!Array.isArray(body.data)) return [];

  const topHolders: SmartMoneyFlow['topHolders'] = [];
  let dropped = 0;
  // `.slice()` caps BEFORE the per-row work (adversarial cycle 1): response size is entirely the
  // vendor's choice — no pagination is sent — and every row costs a keccak256 in normalizeAddress
  // plus a slot in the cached row and in the model's context.
  for (const row of (body.data as TgmHolderRow[]).slice(0, MAX_VENDOR_ROWS)) {
    // `isValidAddress` (non-throwing), NOT a bare typeof + normalizeAddress. The docstring above
    // promises this loop is defensive and "never throws", but normalizeAddress DOES throw on any
    // non-address string — so one malformed vendor row ("0x0", an ENS-style label) destroyed an
    // already-PAID response, nothing was cached, and the retry paid again: a deterministic,
    // repeatable credit drain (adversarial cycle 1, logic F3).
    if (!isRecord(row) || typeof row.address !== 'string' || !isValidAddress(chain, row.address)) {
      dropped += 1;
      continue;
    }
    topHolders.push({
      address: normalizeAddress(chain, row.address),
      ...(typeof row.address_label === 'string'
        ? { addressLabel: truncateString(row.address_label) }
        : {}),
      ...(typeof row.token_amount === 'number' ? { tokenAmount: row.token_amount } : {}),
      ...(typeof row.value_usd === 'number' ? { valueUsd: row.value_usd } : {}),
      ...(typeof row.ownership_percentage === 'number'
        ? { ownershipPercentage: row.ownership_percentage }
        : {}),
    });
  }
  if (dropped > 0) {
    // Silent shrinkage is exactly what made the netflow bug expensive to find — make it observable.
    process.stderr.write(
      `nansen normalize: dropped ${dropped} holder row(s) with a missing/invalid address\n`,
    );
  }
  return topHolders;
}

/**
 * `smart-money.flows` normalization (R-31, TC-CONTRACT-01): merges
 * `SmartMoneyNetflowResponse.data[0]` (the row matching the filtered `tokenAddress` — this
 * capability queries exactly one token, ARCHITECTURE.md §3.2) with `TGMHoldersResponse.data[]` into
 * one canonical `SmartMoneyFlow`. `chain`/`tokenAddress` come from `fetch()`'s own hand-off (already
 * normalized), never re-derived from the vendor body — the same "carry chain, don't trust the
 * response to say which one was asked for" pattern as `coingecko`/`defillama`'s adapters.
 *
 * @throws when `netflow.data` is missing/empty (nothing to build a result from) or any required
 * netflow field is missing/non-numeric — a clear normalization error, never a process crash
 * (TC-CONTRACT-05).
 */
export function normalizeSmartMoneyFlow(
  raw: SmartMoneyFlowsFetchResult,
  now: () => number,
): SmartMoneyFlow {
  const netflowBody = raw.netflow.body as SmartMoneyNetflowResponseBody;
  if (!Array.isArray(netflowBody.data) || netflowBody.data.length === 0) {
    throw new Error(
      'nansen.normalize(smart-money.flows): smart-money/netflow response has no matching row',
    );
  }
  // Select the row that ECHOES the requested token address — never blindly `data[0]` (cycle-2
  // review C-1). The vendor documents this filter as "token address OR SYMBOL", so a >1-row
  // response is possible (symbol-ish match, filter drift, a future `include_*` flag widening the
  // set). Taking `data[0]` would stamp ANOTHER token's netflow figures onto the requested address:
  // schema-valid, non-empty, no error — a silently wrong paid financial signal, cached for 300s and
  // handed to the model. This endpoint has already surprised us once (the DF-1 case-sensitivity
  // story in endpoints.ts), which is exactly why the row is now verified rather than assumed.
  const rows = netflowBody.data as SmartMoneyNetflowRow[];
  // Case-fold BOTH sides only where case is not part of the address (cycle-4 verification pass).
  // On EVM the vendor echoes lowercase while our canonical form is EIP-55, so folding is required.
  // On Solana base58 is case-SENSITIVE, so folding here would accept a row for a *different* mint
  // that differs only in case and then stamp OUR address onto its figures — schema-valid,
  // non-empty, cached 300s: a silently wrong paid financial signal, which is the precise failure
  // this whole row-matching block exists to prevent. Mirror of the `endpoints.ts` L-1 fix.
  const fold = (value: string): string => (raw.family === 'evm' ? value.toLowerCase() : value);
  const wanted = fold(raw.tokenAddress);
  const matched = rows.find(
    (r) => isRecord(r) && typeof r.token_address === 'string' && fold(r.token_address) === wanted,
  );
  // Fall back to the sole row only when the vendor omits `token_address` entirely AND there is
  // exactly one candidate — an unambiguous response we can still trust.
  const row =
    matched ??
    (rows.length === 1 && isRecord(rows[0]) && typeof rows[0]?.token_address !== 'string'
      ? rows[0]
      : undefined);
  if (row === undefined) {
    throw new Error(
      'nansen.normalize(smart-money.flows): smart-money/netflow response has no matching row',
    );
  }
  if (typeof row.token_symbol !== 'string') {
    throw new Error(
      'nansen.normalize(smart-money.flows): missing/invalid "token_symbol" in response',
    );
  }

  const flow: SmartMoneyFlow = {
    chain: raw.chain,
    tokenAddress: raw.tokenAddress,
    tokenSymbol: truncateString(row.token_symbol),
    netflow1hUsd: requireFiniteNumber(row.net_flow_1h_usd, 'net_flow_1h_usd'),
    netflow24hUsd: requireFiniteNumber(row.net_flow_24h_usd, 'net_flow_24h_usd'),
    netflow7dUsd: requireFiniteNumber(row.net_flow_7d_usd, 'net_flow_7d_usd'),
    netflow30dUsd: requireFiniteNumber(row.net_flow_30d_usd, 'net_flow_30d_usd'),
    topHolders: mapTopHolders(raw.holders.body, raw.chain),
    source: SOURCE,
    fetchedAt: now(),
    // OPTIONAL enrichment fields must never fail an already-PAID required result (cycle-3 3.2).
    // The schemas refine these as `.int().nonnegative()`, but the guards only checked `typeof ===
    // 'number'` — so a 12-hour-old token reporting `token_age_days: 0.5` threw at parse AFTER the
    // 10cr pair was spent, nothing was cached, and every retry paid 10cr again: a permanent tarpit
    // for exactly the newly-deployed tokens smart-money tooling is pointed at. Same shape for a
    // `-1` sentinel in `trader_count`. Drop the field instead of losing the whole response.
    ...(isNonNegativeInt(row.trader_count) ? { traderCount: row.trader_count } : {}),
    ...(isNonNegativeInt(row.token_age_days) ? { tokenAgeDays: row.token_age_days } : {}),
    // Truncate + element-wise filter, never a bare cast (cycle-2 M-1): `token_sectors:
    // [{name:"DeFi"}]` or 65 sectors would otherwise throw at parse time — after paying 10cr.
    ...(Array.isArray(row.token_sectors)
      ? { tokenSectors: truncateStringArray(row.token_sectors) }
      : {}),
  };
  return SmartMoneyFlowSchema.parse(flow);
}

// ---------------------------------------------------------------------------------------------
// entity.labels (R-32)
// ---------------------------------------------------------------------------------------------

interface TokenSearchResultRow {
  name?: unknown;
  chain?: unknown;
  address?: unknown;
}

interface EntitySearchResultRow {
  name?: unknown;
  tags?: unknown;
}

interface GeneralSearchResponseBody {
  tokens?: unknown;
  entities?: unknown;
}

interface ProfilerAddressLabelRow {
  label?: unknown;
}

interface ProfilerAddressLabelsResponseBody {
  data?: unknown;
}

/** Builds the default/token-scoped tier's entries from `GeneralSearchResponse.{tokens[],
 * entities[]}` (data-model.md §4.1). Token results are kept ONLY when the vendor's own echoed
 * `chain` matches the requested `chain` — defensive: `postSearchGeneral` already sends `chain` as
 * a narrowing filter, but this never blindly trusts a vendor string against the strict canonical
 * `ChainSchema` enum. Entity results never carry `chain`/`address` at all (the real
 * `EntitySearchResult` shape, not a modeling shortcut). */
function mapSearchGeneral(
  searchBody: unknown,
  chain: Chain,
  vendorChain: string,
  now: () => number,
): EntityLabel[] {
  const body = searchBody as GeneralSearchResponseBody;
  const entries: EntityLabel[] = [];

  if (Array.isArray(body.tokens)) {
    const tokenRows = (body.tokens as TokenSearchResultRow[]).slice(0, MAX_VENDOR_ROWS);
    for (const row of tokenRows) {
      // Case-INSENSITIVE chain compare (adversarial cycle 1, logic F6). A strict `!==` meant that
      // if Nansen ever echoed "Ethereum"/"ETH"/"eth-mainnet", EVERY token row was dropped and the
      // tool returned a plausible-looking, non-empty, silently-truncated result. This is not
      // hypothetical for this vendor: the very same API matched `token_address` case-sensitively
      // and returned a well-formed empty `data: []` that cost 20 live credits to diagnose
      // (see the DF-1 history in endpoints.ts's postSmartMoneyNetflow docstring).
      if (
        !isRecord(row) ||
        // Compared against the VENDOR's token, which is what we sent and what it echoes — never
        // against our slug (vdd-multi cycle 6, H-2; see `EntityLabelsFetchResult.vendorChain`).
        String(row.chain).toLowerCase() !== vendorChain.toLowerCase() ||
        typeof row.address !== 'string' ||
        !isValidAddress(chain, row.address)
      ) {
        continue;
      }
      entries.push({
        chain,
        address: normalizeAddress(chain, row.address),
        tags: [],
        labels: [],
        premiumRequested: false,
        source: SOURCE,
        fetchedAt: now(),
        ...(typeof row.name === 'string' ? { name: truncateString(row.name) } : {}),
      });
    }
  }

  if (Array.isArray(body.entities)) {
    for (const row of (body.entities as EntitySearchResultRow[]).slice(0, MAX_VENDOR_ROWS)) {
      // `isRecord` (cycle-4 verification pass): the first cycle-4 sweep guarded the `tokens[]` loop
      // twenty lines above and MISSED this sibling — three independent verifiers flagged the same
      // omission. A `null` here raised a raw TypeError on `row.tags`, destroying an already-paid
      // 5cr token-scoped `entity.labels` response. Skip the row, matching every other mapper.
      if (!isRecord(row)) continue;
      entries.push({
        // Filter + TRUNCATE (cycle-1 F3 + cycle-2 M-1): a bare cast let `tags: [1,2]` through to
        // fail the whole parse; unbounded length/count then made the parse throw AFTER payment.
        tags: truncateStringArray(row.tags),
        labels: [],
        premiumRequested: false,
        source: SOURCE,
        fetchedAt: now(),
        ...(typeof row.name === 'string' ? { name: truncateString(row.name) } : {}),
      });
    }
  }

  return entries;
}

/** Builds the token-scoped tier's holder-derived entries from `TGMHoldersResponse.data[]`
 * (data-model.md §4.1: "token-scoped обогащение через `TGMHolder.address_label`"). Each holder row
 * becomes ONE `EntityLabel` entry — `labels: []` (never omitted/undefined) when the row carries no
 * `address_label`, which is a VALID result (R-32 "0 labels is not an error"), not filtered out. */
function mapHolderLabels(holdersBody: unknown, chain: Chain, now: () => number): EntityLabel[] {
  const body = holdersBody as TgmHoldersResponseBody;
  if (!Array.isArray(body.data)) return [];

  const entries: EntityLabel[] = [];
  for (const row of (body.data as TgmHolderRow[]).slice(0, MAX_VENDOR_ROWS)) {
    // Non-throwing guard — same reasoning as mapTopHolders (adversarial cycle 1, logic F3).
    if (!isRecord(row) || typeof row.address !== 'string' || !isValidAddress(chain, row.address))
      continue;
    entries.push({
      chain,
      address: normalizeAddress(chain, row.address),
      tags: [],
      labels: typeof row.address_label === 'string' ? [truncateString(row.address_label)] : [],
      premiumRequested: false,
      source: SOURCE,
      fetchedAt: now(),
    });
  }
  return entries;
}

/**
 * `entity.labels` normalization (R-32, TC-CONTRACT-02/03) — returns an `EntityLabel[]` (the tool
 * handler, task 005-6, wraps it into `{chain, entities, source, fetchedAt}`, interfaces.md §5.1.2).
 * Three disjoint tiers (system-architecture.md §3.2 capability table), branched on `raw`'s own
 * populated-field shape (set by `fetch()`'s routing, never re-derived here):
 *
 * - **exhaustive** (`raw.profilerLabels` set): `ProfilerAddressLabelsResponse.data[].label` →
 *   ONE entry's `labels[]`, `premiumRequested: true`.
 * - **token-scoped** (`raw.holders` set): search results (tokens/entities) + one entry per holder
 *   row (`mapHolderLabels`), `premiumRequested: false`.
 * - **default** (neither set): search results only.
 *
 * An EMPTY resulting array (or empty per-entry `labels[]`) is a VALID result, never an error
 * (R-32) — `normalizeEntityLabels` never throws for "found nothing".
 */
export function normalizeEntityLabels(
  raw: EntityLabelsFetchResult,
  now: () => number,
): EntityLabel[] {
  if (raw.profilerLabels) {
    const body = raw.profilerLabels.body as ProfilerAddressLabelsResponseBody;
    if (!Array.isArray(body.data)) {
      throw new Error(
        'nansen.normalize(entity.labels): malformed profiler/address/labels response (missing "data")',
      );
    }
    // Truncate + cap (cycle-2 M-1): this is the 100cr exhaustive tier — a heavily-labeled address
    // (CEX hot wallet, fund) with 65+ profiler labels would blow `.max(64)` at parse time, i.e.
    // AFTER spending the entire free-plan balance, and the retry would pay it again.
    //
    // `.slice()` BEFORE `.map()`, and `isRecord` per element (vdd-multi cycle 4, perf M-7 + logic
    // L-5). Cycle 2 applied the slice-before-map rule to `token.risk` and missed this path — the
    // dearest call in the system — so the whole vendor array was materialised before anything
    // capped it, and a single `null` element threw a TypeError on the same 100cr response.
    const labels = truncateStringArray(
      (body.data as ProfilerAddressLabelRow[])
        .slice(0, MAX_VENDOR_ROWS)
        .map((r) => (isRecord(r) ? r.label : undefined)),
    );
    const address = raw.tokenAddress as string; // always present on the exhaustive path (fetch()'s own precondition)
    const entry: EntityLabel = {
      chain: raw.chain,
      address: normalizeAddress(raw.chain, address),
      tags: [],
      labels,
      premiumRequested: true,
      source: SOURCE,
      fetchedAt: now(),
    };
    return [EntityLabelSchema.parse(entry)];
  }

  if (!raw.search) {
    throw new Error('nansen.normalize(entity.labels): missing search/general response');
  }
  const entries = mapSearchGeneral(raw.search.body, raw.chain, raw.vendorChain, now);
  if (raw.holders) {
    entries.push(...mapHolderLabels(raw.holders.body, raw.chain, now));
  }
  return entries.map((entry) => EntityLabelSchema.parse(entry));
}

// ---------------------------------------------------------------------------------------------
// token.risk (R-33)
// ---------------------------------------------------------------------------------------------

interface TgmIndicatorRow {
  indicator_type?: unknown;
  score?: unknown;
  signal?: unknown;
  signal_percentile?: unknown;
  last_trigger_on?: unknown;
}

interface TgmIndicatorTokenInfo {
  market_cap_usd?: unknown;
  market_cap_group?: unknown;
  is_stablecoin?: unknown;
}

/**
 * `POST /tgm/token-information` response (issue Q-4). Only the fields `TokenRiskScore` actually
 * surfaces are declared — `logo`/`website`/`x`/`telegram` are deliberately not read (vendor-authored
 * URLs, no risk signal, needless prompt-injection surface into the model's context).
 */
interface TgmTokenInformationBody {
  data?: unknown;
}
interface TgmTokenInformationData {
  name?: unknown;
  symbol?: unknown;
  token_details?: unknown;
  spot_metrics?: unknown;
}
interface TgmTokenDetails {
  token_deployment_date?: unknown;
  fdv_usd?: unknown;
  circulating_supply?: unknown;
  total_supply?: unknown;
}
interface TgmSpotMetrics {
  liquidity_usd?: unknown;
  total_holders?: unknown;
}

/**
 * Non-negative finite number, else `undefined` — the degrade-don't-throw rule (cycle-3 3.2) applied
 * to `token-information`'s optional numeric fields. Every one of them is `.nonnegative()` in the
 * canonical schema, so a negative sentinel or a `null` must DROP the field rather than throw at
 * parse time and destroy an already-paid 6cr response.
 */
function nonNegativeFinite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

interface TgmIndicatorsResponseBody {
  token_info?: unknown;
  risk_indicators?: unknown;
  reward_indicators?: unknown;
}

function mapIndicator(row: unknown): TokenRiskScore['riskIndicators'][number] {
  // `isRecord` first (vdd-multi cycle 4, logic L-5): a `null` element would otherwise raise a raw
  // TypeError on the property read instead of this module's clear, typed normalization error.
  // DELIBERATELY still fatal, unlike the drop-loops — this path already throws by design when
  // `indicator_type` is missing (TC-CONTRACT-05), so the paid response is lost either way. That is
  // the negative-caching gap (docs/issues/l-1-*), not something a per-element guard can fix.
  if (!isRecord(row)) {
    throw new Error('nansen.normalize(token.risk): indicator entry is not an object');
  }
  const indicator = row as TgmIndicatorRow;
  if (typeof indicator.indicator_type !== 'string') {
    throw new Error('nansen.normalize(token.risk): indicator missing "indicator_type"');
  }
  return {
    // Truncate, never let the schema cap throw (cycle-3 3.1): this was the third canonical type,
    // left out of the cycle-2 sweep — an oversized `indicator_type` would have thrown at parse
    // AFTER both token.risk sub-calls were paid, with nothing cached, so every retry paid again.
    indicatorType: truncateString(indicator.indicator_type),
    ...(typeof indicator.score === 'string' ? { score: truncateString(indicator.score) } : {}),
    ...(typeof indicator.signal === 'number' ? { signal: indicator.signal } : {}),
    ...(typeof indicator.signal_percentile === 'number'
      ? { signalPercentile: indicator.signal_percentile }
      : {}),
    ...(typeof indicator.last_trigger_on === 'string'
      ? { lastTriggerOn: truncateString(indicator.last_trigger_on) }
      : {}),
  };
}

/**
 * `token.risk` normalization (R-33, TC-CONTRACT-04) — merges BOTH paid sub-responses:
 * `TGMIndicatorsResponse` (indicators + the three `token_info` fields) and
 * `TGMTokenInformationResponse` (the metadata R-43 promises — issue Q-4).
 * `riskIndicators`/`rewardIndicators` stay two SEPARATE arrays (never flattened, R-33).
 *
 * **The two sub-responses are not equal in weight.** A malformed `indicators` body is fatal — it is
 * the substance of a risk score. A malformed `token-information` body is NOT: every field it
 * contributes is optional enrichment, so it degrades to "those fields absent" rather than throwing
 * away an already-paid 6cr response and sending the retry to pay again (the L-1 class this project
 * has now been bitten by three times).
 *
 * @throws when either indicator array is missing/malformed, or an indicator entry lacks
 * `indicator_type` — a clear normalization error, never a process crash (TC-CONTRACT-05).
 */
export function normalizeTokenRiskScore(
  raw: TokenRiskFetchResult,
  now: () => number,
): TokenRiskScore {
  const body = raw.indicators.body as TgmIndicatorsResponseBody;
  if (!Array.isArray(body.risk_indicators) || !Array.isArray(body.reward_indicators)) {
    throw new Error(
      'nansen.normalize(token.risk): malformed tgm/indicators response (missing risk/reward indicators)',
    );
  }
  const tokenInfo = (body.token_info ?? {}) as TgmIndicatorTokenInfo;

  // `/tgm/token-information` (Q-4) — enrichment only, so every access is guarded and a malformed
  // body simply contributes nothing. `isRecord` at each level: the vendor is free to send `null`.
  const infoBody = raw.tokenInformation.body as TgmTokenInformationBody;
  const info: TgmTokenInformationData = isRecord(infoBody?.data)
    ? (infoBody.data as TgmTokenInformationData)
    : {};
  const details: TgmTokenDetails = isRecord(info.token_details)
    ? (info.token_details as TgmTokenDetails)
    : {};
  const spot: TgmSpotMetrics = isRecord(info.spot_metrics)
    ? (info.spot_metrics as TgmSpotMetrics)
    : {};

  const fdvUsd = nonNegativeFinite(details.fdv_usd);
  const circulatingSupply = nonNegativeFinite(details.circulating_supply);
  const totalSupply = nonNegativeFinite(details.total_supply);
  const liquidityUsd = nonNegativeFinite(spot.liquidity_usd);

  const score: TokenRiskScore = {
    chain: raw.chain,
    address: raw.address,
    // `.slice()` BEFORE `.map()` — cycle-2 R-3: this was the one M2 normalization path left
    // uncapped, so an oversized vendor body was mapped and parsed in full, stored in the cache row,
    // and (given `token.risk`'s 1800s TTL) re-served from cache repeatedly.
    riskIndicators: body.risk_indicators.slice(0, MAX_VENDOR_ROWS).map(mapIndicator),
    rewardIndicators: body.reward_indicators.slice(0, MAX_VENDOR_ROWS).map(mapIndicator),
    source: SOURCE,
    fetchedAt: now(),
    // Same degrade-don't-throw rule as above (cycle-3 3.2): `marketCapUsd` is `.nonnegative()`.
    ...(typeof tokenInfo.market_cap_usd === 'number' &&
    Number.isFinite(tokenInfo.market_cap_usd) &&
    tokenInfo.market_cap_usd >= 0
      ? { marketCapUsd: tokenInfo.market_cap_usd }
      : {}),
    ...(typeof tokenInfo.market_cap_group === 'string'
      ? { marketCapGroup: truncateString(tokenInfo.market_cap_group) }
      : {}),
    ...(typeof tokenInfo.is_stablecoin === 'boolean'
      ? { isStablecoin: tokenInfo.is_stablecoin }
      : {}),

    // --- `/tgm/token-information` metadata (Q-4) — all optional, all degrade-don't-throw ---
    ...(typeof info.name === 'string' ? { name: truncateString(info.name) } : {}),
    ...(typeof info.symbol === 'string' ? { symbol: truncateString(info.symbol) } : {}),
    // Raw vendor string, never parsed to epoch-ms — the format carries no timezone (see the field's
    // own docstring in `types/token-risk-score.ts`).
    ...(typeof details.token_deployment_date === 'string'
      ? { deploymentDate: truncateString(details.token_deployment_date) }
      : {}),
    ...(fdvUsd !== undefined ? { fdvUsd } : {}),
    ...(circulatingSupply !== undefined ? { circulatingSupply } : {}),
    ...(totalSupply !== undefined ? { totalSupply } : {}),
    ...(liquidityUsd !== undefined ? { liquidityUsd } : {}),
    // `.int()` in the schema — a fractional holder count is malformed, so reuse the existing
    // integer guard rather than `nonNegativeFinite` (which would let 3105691.5 through to throw).
    ...(isNonNegativeInt(spot.total_holders) ? { totalHolders: spot.total_holders } : {}),
  };
  return TokenRiskScoreSchema.parse(score);
}
