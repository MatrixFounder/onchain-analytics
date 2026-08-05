import type { ChainFamily } from '../../chain/registry-core.js';
import { throttle as productionThrottle } from '../../net/rate-limit.js';
import type { Throttle } from '../../net/rate-limit.js';
import { safeFetch } from '../../net/safe-fetch.js';
import { adapterRegistrations } from '../../providers.config.js';
import { stringifyTruncated } from '../stringify-truncated.js';

const REGISTRATION = adapterRegistrations.find((r) => r.id === 'nansen');
if (!REGISTRATION) {
  throw new Error('nansen: no matching entry in adapterRegistrations (providers.config.ts)');
}
const HOSTS = REGISTRATION.hosts;
const RATE_LIMIT = REGISTRATION.rateLimit;
const BASE_URL = `https://${HOSTS[0]}`;

/**
 * A chain as these request builders need it (vdd-multi cycle 5, H-1).
 *
 * **Was `type NansenChain = 'ethereum' | 'solana'`.** That literal union was correct while the
 * adapter served two chains, and became a silent lie in task 006-9, which widened
 * `chainSupport()` to Nansen's full per-capability coverage (17/25/25 chains from the committed
 * OpenAPI spec) without touching this transport. The coverage gate then advertised — and admitted —
 * chains whose request could never be built, so `token.risk({chain:'bsc'})` passed every gate and
 * died in `fetch()` as a RETRYABLE `CapabilityUnavailableError`, i.e. an agent retrying forever
 * against a permanent condition.
 *
 * Two fields, because the transport genuinely needs two different things and conflating them is
 * how the old code went wrong:
 *   - `token` — NANSEN's own chain name (`bnb`, not our slug `bsc`; `optimism`, not `op-mainnet`).
 *     This is what goes on the wire. It comes from `registry.data.json`'s `vendors.nansen` column,
 *     which is exactly what that column is for.
 *   - `family` — OUR address family, which decides how `token_address` must be cased below. A
 *     vendor chain token says nothing about address encoding.
 */
export interface NansenChainRef {
  readonly token: string;
  readonly family: ChainFamily;
}

/**
 * Thrown on `429 Too Many Requests` (task-005-4, R-29 UC-7). YAGNI-scoped: an explicit, immediate
 * error — NEVER a silent retry inside this adapter (system-architecture.md §3.2 "429 Too Many
 * Requests" — retry would interact with the budget reservation already made before this HTTP call,
 * out of scope by design). `retryAfter` is the raw `retry-after` response header value, folded
 * into the message text so a caller reading just `error.message` still sees it.
 */
export class NansenRateLimitedError extends Error {
  constructor(public readonly retryAfter: string | null) {
    super(`nansen: HTTP 429 Too Many Requests, retry after ${retryAfter ?? '(unknown)'}`);
    this.name = 'NansenRateLimitedError';
  }
}

/**
 * Thrown on `402 Payment Required` (task-005-4, UC-6) — system-architecture.md §3.2 treats this as
 * an AUTHORITATIVE "no vendor budget right now" signal, the same family as a transport
 * failure/timeout on a reserved-but-unconfirmed call. This task only needs a typed, distinguishable
 * error for it; turning it into `accountState.markUnreconciled()` is task 005-5's own wiring
 * (`fetch()`'s docstring below and this directory's `.AGENTS.md` both name that boundary).
 */
export class NansenPaymentRequiredError extends Error {
  constructor(public readonly endpoint: string) {
    super(`nansen: HTTP 402 Payment Required for ${endpoint}`);
    this.name = 'NansenPaymentRequiredError';
  }
}

/**
 * Optional per-call dependencies every endpoint function below shares (task 005-4). `apiKey` is
 * always the caller's (`adapters/nansen/index.ts`'s `fetch()`) own env read, done INSIDE that
 * method body, never at module load — this module never touches `process.env` itself
 * (ARCHITECTURE.md §7.2/§3.2, R-45). `throttle` mirrors `budget-gate.ts`'s own
 * `NansenBudgetGateDeps.throttle` precedent: defaults to the package's real production singleton,
 * but this module's own test files construct a FRESH `createThrottle()` per test so many
 * independent scenarios in one file never share a real, process-lifetime token bucket (which would
 * otherwise incur genuine multi-second real-timer waits purely as an artifact of test ordering,
 * `net/rate-limit.ts`'s capacity 5 / refillPerSec 1 for this provider).
 */
export interface NansenEndpointDeps {
  apiKey: string;
  fetchImpl: typeof fetch;
  throttle?: Throttle;
  /**
   * The transport seam (task 012-9, PLAN §0.3 seam #1, owner decision OD-6 of 2026-08-03).
   *
   * **Why it exists at all.** `safeFetch` was a STATIC import here, and `fetchImpl` cannot stand in
   * for it: `fetchImpl` receives a `RequestInit`, which carries no `deadlineAtMs`, so the one thing
   * D4 п.2 makes a correctness condition — "nothing that runs after `checkAndReserve()` was handed a
   * deadline" — was observable only on the limiter's half of the path. A contract test that checks
   * the limiter and not the transport LOOKS like a check of the invariant while checking half of it;
   * AC-8 was amended to forbid exactly that. The seam is what makes the whole statement testable.
   *
   * **Optional, mirroring `throttle?` above and NOT the mandatory `fetchImpl`** — a required key
   * would be a breaking change for every existing construction of this interface. Defaulted at the
   * ONE call site (`callEndpoint`) via `deps.safeFetchImpl ?? safeFetch`, so production behaviour is
   * byte-identical when it is omitted.
   */
  safeFetchImpl?: typeof safeFetch;
}

/**
 * One endpoint call's result, handed UP to the caller unopened (task-005-4 task-file wording,
 * verbatim): `body` is the untouched, `response.json()`-parsed vendor payload (anti-corruption —
 * NOTHING here inspects vendor field names, that's `normalize.ts`'s job exclusively);
 * `creditsUsedHeader` is the raw `X-Nansen-Credits-Used` response header value (or `null` if
 * absent) — **parsed/summed by post-call reconciliation, task 005-5's own scope, never by the
 * endpoint function itself** (system-architecture.md §3.2 "Post-call reconciliation").
 */
export interface NansenEndpointResult {
  body: unknown;
  creditsUsedHeader: string | null;
}

/**
 * The single low-level HTTP step every one of the seven exported endpoint functions below funnels
 * through (task 005-4, R-29): `throttle('nansen', RATE_LIMIT)` → `safeFetch(url, opts, HOSTS,
 * fetchImpl)` (`HOSTS` sourced from THIS adapter's own `adapterRegistrations` entry, never a
 * literal in this file — SSRF allowlist stays declarative, ARCHITECTURE.md §7.2) → status
 * handling → `response.json()`.
 *
 * **`429`/`402` are recognized HERE, uniformly, for every endpoint** (never duplicated per call
 * site) — `429` throws `NansenRateLimitedError` immediately, no retry; `402` throws
 * `NansenPaymentRequiredError`. Any other non-`ok` status throws a plain `Error` naming the HTTP
 * status and endpoint, with the response body bounded via `stringifyTruncated()` (same
 * unbounded-error-message guard already established by `rpc-evm`'s own HTTP step).
 */
async function callEndpoint(
  method: 'GET' | 'POST',
  urlPath: string,
  requestBody: unknown,
  deps: NansenEndpointDeps,
): Promise<NansenEndpointResult> {
  const throttleFn = deps.throttle ?? productionThrottle;
  await throttleFn('nansen', RATE_LIMIT);

  const url = `${BASE_URL}${urlPath}`;
  // Literal `apiKey` header — NOT the generic Web credentials-header + token-prefix scheme some
  // other Nansen surfaces use (that one belongs to Nansen's separate MCP endpoint, out of scope
  // here; see this directory's own .AGENTS.md for why this distinction matters and the live-probed
  // source: auth.scheme:'apiKey', in:'header', name:'apiKey', nansen-probe-2026-07-23.json). This
  // whole directory is grepped for that wrong scheme's two literal words in every task's
  // acceptance — deliberately not spelled out here either, same convention as `budget-gate.ts`.
  const opts: RequestInit =
    method === 'POST'
      ? {
          method: 'POST',
          headers: { 'content-type': 'application/json', apiKey: deps.apiKey },
          body: JSON.stringify(requestBody),
        }
      : { method: 'GET', headers: { apiKey: deps.apiKey } };

  // **NO fifth argument, and its absence is the contract** (task 012-9, ADR-002 D4 п.2). Every
  // endpoint below runs strictly AFTER `budget-gate.ts` committed the credit reservation for the
  // SUM of this capability's sub-calls, so none of them may be handed a `deadlineAtMs`: cancelling
  // work that is already paid for is "paid and did not receive", strictly worse than waiting for it.
  // `test/nansen-deadline-boundary.test.ts` (TC-CONTRACT-01) asserts this directly on the seam
  // rather than inferring it from an outcome.
  const safeFetchFn = deps.safeFetchImpl ?? safeFetch;
  const response = await safeFetchFn(url, opts, HOSTS, deps.fetchImpl);

  if (response.status === 429) {
    throw new NansenRateLimitedError(response.headers.get('retry-after'));
  }
  if (response.status === 402) {
    throw new NansenPaymentRequiredError(urlPath);
  }
  if (!response.ok) {
    const bodyText = await response.text().catch(() => '');
    // REDACT the key out of the vendor's body before it enters an Error message (adversarial
    // cycle 1, security F-2). This message is forwarded verbatim by the tool layer as `isError`
    // text → into the model's context → into transcripts and MCP client logs. Echoing request
    // headers back in a 4xx debug body is common gateway/WAF behavior, and `nansen.secrets.test.ts`
    // explicitly disclaims covering it ("asserts on OUR OWN code never embedding the key, not on
    // defending against a vendor response that pathologically echoes back request headers").
    // This adapter is the only layer that holds the key, so it is the only layer that CAN redact —
    // nothing downstream knows what to look for.
    // Order matters: REDACT FIRST, THEN truncate (cycle-2 review R-2 — the first version of this
    // line did it backwards). `stringifyTruncated` slices to 500 chars, so redacting afterwards
    // leaves an unredacted key PREFIX whenever the echoed key straddles the boundary — and an
    // attacker who can influence the echoed body's length picks where that boundary falls, so two
    // responses with different padding leak two fragments that concatenate to the whole key.
    // Splitting the RAW text also fixes the second half of R-2: `JSON.stringify` escapes `"`, `\`
    // and control/non-ASCII characters, so a key containing any of them would never have matched
    // `deps.apiKey` after stringification and would not have been redacted at all.
    const safeBody = stringifyTruncated(bodyText.split(deps.apiKey).join('***'));
    throw new Error(`nansen: HTTP ${response.status} for ${urlPath}: ${safeBody}`);
  }

  const body: unknown = await response.json();
  const creditsUsedHeader = response.headers.get('x-nansen-credits-used');
  return { body, creditsUsedHeader };
}

/**
 * How this ONE vendor filter wants a token address cased.
 *
 * **Keyed on FAMILY, not on chain name** (vdd-multi cycle 5, H-1). The old exhaustive switch over
 * `'ethereum' | 'solana'` was written to make adding a chain a COMPILE error — a good instinct that
 * became unmaintainable the moment coverage went to 25 chains, since the rule was never per-chain
 * in the first place. It is per ENCODING: a hex address is case-insensitive by definition, so
 * folding it is safe (and required — DF-1 root cause #2, live-proven 2026-07-24: this endpoint
 * matches case-sensitively against a lowercase-stored column). Everything else — base58 for
 * `svm`/tron, bech32 for `cosmos`, and the `other` bucket that holds `ton`/`near`/`starknet` — is
 * case-sensitive as an ENCODING, so folding corrupts the address rather than re-casing it (L-1).
 *
 * The `never` guard survives, now on `ChainFamily`: a NEW family still forces this decision to be
 * made explicitly instead of defaulting into the EVM fold.
 */
function netflowTokenAddressFilter(family: ChainFamily, tokenAddress: string): string {
  switch (family) {
    case 'evm':
      return tokenAddress.toLowerCase();
    case 'svm':
    case 'move':
    case 'cosmos':
    case 'utxo':
    case 'other':
      return tokenAddress;
    default: {
      const unhandled: never = family;
      throw new Error(
        `nansen.postSmartMoneyNetflow: no token_address casing rule for family ${String(unhandled)}`,
      );
    }
  }
}

/**
 * `POST /api/v1/smart-money/netflow` (`SmartMoneyNetflowRequest`, `x-credit-cost` 5cr both plans) —
 * filtered to exactly one token via `filters.token_address` (the request's own documented "token
 * address or symbol filter", `nansen-openapi-2026-07-23.json`'s `SmartMoneyNetflowFilters`). Body
 * intentionally minimal — only the properties this capability actually needs, `additionalProperties:
 * false` on the vendor schema means nothing beyond `chains`/`filters` is accepted anyway.
 *
 * **`include_stablecoins`/`include_native_tokens` MUST be sent explicitly as `true`** (live-run
 * finding, task 005-7): both default to **`false`** server-side
 * (`SmartMoneyNetflowFilters.include_stablecoins.default === false`, same for native tokens). This
 * capability is *token-scoped* — the caller named one specific `tokenAddress` — so silently
 * dropping that token because it happens to be a stablecoin or a wrapped-native asset is never the
 * intent, it just returns a well-formed empty `data: []` that looks like "smart money isn't
 * trading this token". That empty result cost 20 live credits to diagnose (USDC and WETH, both
 * excluded by these defaults) before the cause was traced to the request body rather than to
 * vendor coverage. The vendor's own `token_address` example is USDC, which is unreachable unless
 * `include_stablecoins` is true. These flags are category filters for the *screener* use of this
 * endpoint; for a token-scoped query they must not narrow the result.
 */
export function postSmartMoneyNetflow(
  params: { chain: NansenChainRef; tokenAddress: string },
  deps: NansenEndpointDeps,
): Promise<NansenEndpointResult> {
  return callEndpoint(
    'POST',
    '/api/v1/smart-money/netflow',
    {
      chains: [params.chain.token],
      filters: {
        // **EVM ONLY: lowercase, not the EIP-55 checksummed form** (live-confirmed 2026-07-24,
        // DF-1 root cause #2): this endpoint's `token_address` filter matches CASE-SENSITIVELY
        // against a lowercase-stored column, unlike the sibling `/tgm/*` endpoints, which accept
        // the checksummed form happily. `normalizeAddress()` canonicalizes to EIP-55, so passing
        // it through verbatim silently yields a well-formed empty `data: []` — indistinguishable
        // from "smart money isn't trading this token". Proven live: the identical request with
        // the checksummed address returns 0 rows, with the lowercase address returns the real
        // USDC row (net_flow_24h_usd ≈ -325_939, trader_count 142). Every `token_address`
        // example in the vendor spec is lowercase. The canonical EIP-55 form is still what we
        // store/return and what feeds the cache key — only this vendor filter gets lowercased.
        //
        // **The case fold MUST NOT apply to Solana** (vdd-multi cycle 4, logic L-1). Base58 is
        // case-sensitive as an ENCODING — `chain/address.ts`'s `normalizeSolanaAddress()` returns
        // the input unchanged for exactly that reason — so lowercasing a Solana mint corrupts the
        // address itself rather than merely re-casing it. `solana` is an advertised chain for
        // `smart-money.flows` (adapter `capabilities()`, the tool's `chain` enum), and the DF-1
        // live verification covered EVM only, so the blanket fold would have re-created the DF-1
        // tarpit on the one chain nobody probed: empty `data: []` → post-payment normalize throw →
        // nothing cached → 10cr per retry, forever.
        token_address: netflowTokenAddressFilter(params.chain.family, params.tokenAddress),
        include_stablecoins: true,
        include_native_tokens: true,
      },
    },
    deps,
  );
}

/**
 * `POST /api/v1/tgm/holders` (`TGMHoldersRequest`, 5cr both plans; 150cr flat surcharge when
 * `premiumLabels` is set — mirrors `cost-of.ts`'s own `NANSEN_PREMIUM_LABELS_COST` handling,
 * **not exercised by this task's routing** — `entity.labels`' `exhaustive: true` tier uses
 * `postProfilerAddressLabels` instead, per system-architecture.md §3.2's capability table).
 * `chain`+`token_address` are the only two required properties.
 */
export function postTgmHolders(
  params: { chain: NansenChainRef; tokenAddress: string; premiumLabels?: boolean },
  deps: NansenEndpointDeps,
): Promise<NansenEndpointResult> {
  return callEndpoint(
    'POST',
    '/api/v1/tgm/holders',
    {
      chain: params.chain.token,
      token_address: params.tokenAddress,
      // Forwarded so PRICE AND REQUEST AGREE (cycle-2 review L-2). `cost-of.ts` charges the flat
      // 150cr `NANSEN_PREMIUM_LABELS_COST` whenever `premium_labels === true`; previously this
      // transport never sent the flag, so the gate could reserve 150 for a call the vendor would
      // have billed at 5 — refusing, on a 100cr free plan, a call that would have succeeded.
      // Only emitted when explicitly requested, so the default body is byte-identical to before
      // and no production path can reach the paid tier: no tool input schema exposes this flag and
      // all three are `.strict()`.
      ...(params.premiumLabels === true ? { premium_labels: true } : {}),
    },
    deps,
  );
}

/**
 * `POST /api/v1/tgm/indicators` (`TGMIndicatorsRequest`, 5cr both plans) — `chain`+`token_address`
 * are its only two (required) properties.
 */
export function postTgmIndicators(
  params: { chain: NansenChainRef; tokenAddress: string },
  deps: NansenEndpointDeps,
): Promise<NansenEndpointResult> {
  return callEndpoint(
    'POST',
    '/api/v1/tgm/indicators',
    { chain: params.chain.token, token_address: params.tokenAddress },
    deps,
  );
}

/**
 * `POST /api/v1/tgm/token-information` (`TGMTokenInformationRequest`, 1cr both plans) —
 * `timeframe` is REQUIRED by the vendor schema (`TGMFlowIntelligenceTimeframe` enum:
 * `5m|1h|6h|12h|1d|7d`); `'1d'` (the schema's own documented example value) is the only sensible
 * fixed choice here — `token.risk`'s canonical output (data-model.md §4.1) doesn't expose a
 * timeframe knob, so there is no caller-supplied value to thread through.
 */
export function postTgmTokenInformation(
  params: { chain: NansenChainRef; tokenAddress: string },
  deps: NansenEndpointDeps,
): Promise<NansenEndpointResult> {
  return callEndpoint(
    'POST',
    '/api/v1/tgm/token-information',
    { chain: params.chain.token, token_address: params.tokenAddress, timeframe: '1d' },
    deps,
  );
}

/**
 * `POST /api/v1/search/general` (`GeneralSearchRequest`, 0cr both plans) — `chain` is passed as
 * the request's own optional "narrow down token results" filter (`searchQuery` alone is required
 * by the vendor schema). Narrowing by chain keeps `TokenSearchResult.chain` values scoped to the
 * one chain the caller asked about, so `normalize.ts` never has to reconcile an arbitrary vendor
 * chain string against a canonical one.
 */
export function postSearchGeneral(
  params: { chain: NansenChainRef; searchQuery: string },
  deps: NansenEndpointDeps,
): Promise<NansenEndpointResult> {
  return callEndpoint(
    'POST',
    '/api/v1/search/general',
    { search_query: params.searchQuery, chain: params.chain.token },
    deps,
  );
}

/**
 * `POST /api/v1/search/entity-name` (`EntityNameSearchRequest`, 0cr both plans) — always called
 * alongside `postSearchGeneral` on the non-exhaustive `entity.labels` path (`cost-of.ts`'s own
 * `endpointsFor()`, system-architecture.md §3.2's capability table: "search/general [+
 * entity-name]"). Its response (`EntityNameSearchItem[]`, bare `entity_name` strings only) is NOT
 * consumed by `normalize.ts` — data-model.md §4.1 traces `EntityLabel`'s fields only to
 * `GeneralSearchResponse`/`TGMHolder.address_label` — this call exists purely for HTTP-call/cost
 * parity with `cost-of.ts`'s already-real pricing (`adapters/nansen/index.ts`'s docstring notes
 * this explicitly).
 */
export function postSearchEntityName(
  params: { searchQuery: string },
  deps: NansenEndpointDeps,
): Promise<NansenEndpointResult> {
  return callEndpoint(
    'POST',
    '/api/v1/search/entity-name',
    { search_query: params.searchQuery },
    deps,
  );
}

/**
 * `POST /api/v1/profiler/address/labels` (`ProfilerAddressLabelsRequest`, 100cr both plans) — the
 * `entity.labels` `exhaustive: true` escalation, called ALONE on that path (never alongside
 * `postSearchGeneral`/`postTgmHolders` — system-architecture.md §3.2's capability table: "только
 * /profiler/address/labels"). `chain`+`address` are its only two required properties.
 */
export function postProfilerAddressLabels(
  params: { chain: NansenChainRef; address: string },
  deps: NansenEndpointDeps,
): Promise<NansenEndpointResult> {
  return callEndpoint(
    'POST',
    '/api/v1/profiler/address/labels',
    { address: params.address, chain: params.chain.token },
    deps,
  );
}
