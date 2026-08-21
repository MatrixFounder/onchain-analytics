import { isValidAddress, normalizeAddress } from '../../chain/address.js';
import type { ChainInfo, ChainRegistry } from '../../chain/registry-core.js';
import { loadChainRegistry } from '../../chain/registry.js';
import { throttle as productionThrottle, type Throttle } from '../../net/rate-limit.js';
import { isPassThroughTransportError, safeFetch } from '../../net/safe-fetch.js';
import { adapterRegistrations } from '../../providers.config.js';
import { EntityLabelSchema, type EntityLabel } from '../../types/entity-label.js';
import {
  ChainTransactionsSchema,
  GasPriceSchema,
  type ChainTransactions,
  type GasPrice,
} from '../../types/chain-activity.js';
import { TokenHoldersSchema, type TokenHolders } from '../../types/token-holders.js';
import { MAX_VENDOR_NAME_LENGTH, truncateVendorText } from '../truncate-vendor-text.js';
import type { ProviderAdapter } from '../types.js';
import { BLOCKSCOUT_CHAIN_IDS } from './chains.js';
import {
  asPlain,
  extractTags,
  sanitizeBlockscoutBody,
  type SanitizedBlockscoutBody,
} from './sanitize.js';

/**
 * `blockscout` adapter (TASK-008, R-73…R-78) — free tier for `token.holders` and `entity.labels`.
 *
 * What this adapter is for: `token.holders` had been routed to the `dune` config-stub, which
 * covered zero chains — an advertised capability that answered nowhere — and `entity.labels` went
 * straight to paid Nansen. Blockscout serves both for free.
 *
 * **One host, and the reason it is not two.** An earlier revision split the capabilities across
 * `api.blockscout.com` (holders) and `mcp.blockscout.com` (labels), on the reasoning that the
 * direct host is cheaper and enforces auth so the key is verifiable there. Adversarial review
 * killed it: the direct host answers **402 without a key** and `token.holders` has no fallback
 * adapter, so on a stock install the capability was advertised on 39 chains and served on none.
 * Both capabilities now go through the facade, which answers keyless:
 *
 * - `token.holders` → `/v1/direct_api_call` proxying `/api/v2/tokens/<addr>/holders`.
 * - `entity.labels` → `/v1/get_address_info`. The labels exist **only** here — the direct
 *   `/api/v2/addresses/<addr>` returns `metadata: null` even for Binance Hot Wallet, because the
 *   facade's three-way fan-out is what buys the label enrichment. The expensive path and the
 *   useful path are the same path.
 *
 * Everything the facade returns must pass through `./sanitize.ts` first — it ships an
 * `instructions` array written at a language model. See that module for why the rule is enforced by
 * the type system rather than by convention.
 *
 * @module
 */

/** L-15: hoisted — this runs once per registry row while each coverage set is built. */
const CAIP2_EIP155_RE = /^eip155:(\d+)$/;

/** Numeric EVM chain id of a registry row, or `undefined` for anything not `eip155:<n>`. */
export function evmChainId(chain: ChainInfo): number | undefined {
  const matched = CAIP2_EIP155_RE.exec(chain.caip2);
  if (matched === null) return undefined;
  const id = Number(matched[1]);
  return Number.isSafeInteger(id) ? id : undefined;
}

const SERVED = new Set<number>(BLOCKSCOUT_CHAIN_IDS);

/**
 * Coverage is the intersection of "Blockscout runs a mainnet explorer for this chain id" and "our
 * registry models that chain at all".
 *
 * Keyed on the numeric chain id, deliberately: the vendor's own `ecosystem` field reads like a
 * chain family and is not one (`ecosystem: "Solana"` is Neon, an EVM chain; `"Bitcoin/BCH"` is
 * Rootstock, an EVM sidechain), so keying on it would advertise `svm`/`utxo` coverage that does not
 * exist. Measured today: 53 vendor mainnets, of which 39 correspond to a registry row.
 *
 * The `capability` argument is ignored — unlike `nansen`, both capabilities here reach exactly the
 * chains the explorer covers.
 */
export function servesChain(chain: ChainInfo): boolean {
  const id = evmChainId(chain);
  return id !== undefined && SERVED.has(id);
}

/**
 * M-8: looked up, NOT asserted at module scope.
 *
 * This used to `throw` here when the entry was missing. `packages/core/src/index.ts` re-exports this
 * module, so that throw fired during `import '@onchain-intel/core'` — before `main()` ran — and the
 * whole MCP server failed to boot. The scenario is not hypothetical: OQ-2's answer is that the owner
 * may disable this provider on the server, and deleting the config entry is the obvious way to do
 * it. "Degrade honestly" cannot mean "take the process down with you".
 *
 * The adapter therefore constructs, and declines everything with a reason naming the missing entry
 * (see `unregistered` below). It deliberately does NOT fall back to built-in host/rate-limit
 * defaults: `providers.config.ts` is the single source of egress truth, and an adapter that invents
 * its own allowlist when the config is absent is an adapter that cannot be turned off.
 */
const REGISTRATION = adapterRegistrations.find((entry) => entry.id === 'blockscout');
const RATE_LIMIT = REGISTRATION?.rateLimit;
const ALLOWLIST = REGISTRATION ? [...REGISTRATION.hosts] : [];

// L-4: `api.blockscout.com` was left in the SSRF allowlist on the argument that "keeping it costs
// nothing". It does cost something. `safeFetch` re-checks every REDIRECT hop against this list, so
// an allowlisted host we never call is still a host a misbehaving facade can bounce us to — and the
// allowlist is this adapter's only egress control. R-73(b) specifies exactly one host; the entry
// also contradicted that accepted Must. Removed from `providers.config.ts`; the door for a future
// key-gated direct path is reopened by adding it back in the same commit that calls it.
const FACADE_HOST = 'https://mcp.blockscout.com';

/**
 * Rows we keep from a holders response — the cap the canonical schema enforces, and the bound the
 * per-row work is done under.
 *
 * M-5: this used to be documented as "page size we ask the vendor for", which was never true — the
 * request sends `chain_id` and `endpoint_path` and nothing else, so 50 is the vendor's *undeclared
 * default*. Naming it as our contract made a vendor-side change look impossible, and per CLAUDE.md's
 * working discipline ("vendor counters drift — don't hardcode counts") it is the number most likely
 * to move. It is now what it always was: our cap, applied defensively to whatever arrives.
 */
const HOLDERS_PAGE = 50;

/**
 * Ceiling for a Blockscout response body.
 *
 * H-3: `safeFetch`'s 10 MB default was inherited unchanged. The recorded holders payload is ~40 KB,
 * so 10 MB is not a cap but a suggestion — and it is the only thing bounding `items`, which the
 * normalizer walks per row (regex + keccak-256) before keeping 50. Sized ~12× the largest observed
 * body: comfortably above anything real, far below "a GC pause per call".
 */
const MAX_RESPONSE_BYTES = 512 * 1024;

/**
 * H-5: an explicit per-request timeout instead of `safeFetch`'s 15 s default.
 *
 * `request()` awaits `throttle()` (up to `MAX_WAIT_MS = 30_000`) and then the fetch, and the route
 * walk is sequential — so putting this adapter in front of `nansen` lengthened `entity.labels`'
 * worst case on a single-threaded stdio server. A free explorer that has not answered in 5 s is not
 * about to, so failing fast is what keeps free-first from being expensive.
 *
 * **That last sentence is true of three of this adapter's four routes, and was measured false of
 * the fourth** (task 014-42). This is now the DEFAULT hop ceiling rather than the only one; the
 * holders route carries `HOLDERS_TIMEOUT_MS` below, with the measurement that moved it and the
 * reason the other three deliberately did not move.
 *
 * **What this constant does NOT do, and what does it instead.** `safeFetch` builds
 * `AbortSignal.timeout(timeoutMs)` INSIDE its redirect loop, so the bound is per HOP and
 * `MAX_REDIRECTS = 3` means four of them. This number is therefore one hop's ceiling and was never
 * the call's; the bound on the WALK is the call deadline, which — since task 012-8 — exists.
 *
 * **The historical envelope, kept as history because it is the derivation of the numbers the
 * manifest now reuses.** Before the deadline, the worst case of one `entity.labels` traversal was
 * `30 + 4×5` s here, plus `30 + 4×15` s of nansen's cold-start `/account` budget resync, plus
 * `3×(30 + 4×15)` s of nansen's own sub-calls — **≈ 410 s**, several hundred seconds rather than
 * the ~120 s an even earlier version of this comment asserted (that number was repeated, not
 * derived). Of that envelope, ~140 s is cancellable work and ~270 s is the paid leg; both halves
 * are cited by name in `capability-manifest.ts`'s `entity.labels` row, which reuses this derivation
 * instead of inventing its own.
 *
 * **The mechanism, and the split it turns on (ADR-002 D4 §2, OD-3).** `CapabilityRegistry.resolve()`
 * computes an ABSOLUTE `effectiveDeadlineAtMs = min(now + manifest.deadlineMs, requested)` once per
 * call and passes it to `fetch(cap, args, deadlineAtMs)`; this adapter forwards it unchanged to
 * `throttle()` (which refuses instead of sleeping past it) and to `safeFetch` (which refuses on hop
 * entry and aborts a hop in flight). Cancellation is real, not advisory — but it covers ONE of the
 * two halves:
 *
 * | Part                                  | Bound                | Cancellable | Measured | Applied |
 * | ------------------------------------- | -------------------- | ----------- | -------- | ------- |
 * | before any reservation commits        | `deadlineMs`         | YES         | ~140 s   | 60 s    |
 * | after `checkAndReserve()` (paid leg)  | `paidLegMs`          | NO          | ~270 s   | 270 s   |
 *
 * So `entity.labels`' worst case is ≈ 330 s, not 60 s: the deadline can abort this adapter's
 * attempt or nansen's pre-payment resync, and it stops at the moment a credit is spent, because
 * cancelling there would mean paying without receiving. **A reading of this comment that concludes
 * "the deadline bounds the whole call" is the error OD-3 found and is wrong in the expensive
 * direction** — the uncancellable tail is longer than the part the ceiling governs.
 */
const REQUEST_TIMEOUT_MS = 5_000;

/**
 * The holders route's own hop ceiling — task 014-42, closing L-12.
 *
 * **Why one route gets a different number.** `REQUEST_TIMEOUT_MS`'s reasoning above ("a free
 * explorer that has not answered in 5 s is not about to") was measured on the routes it was written
 * for and is false for this one. Measured 2026-08-21 over three rounds on all five chains this
 * adapter serves (`scripts/probe-blockscout-holders-latency.ts`, evidence
 * `docs/onchain-analytics/raw/blockscout-holders-latency-2026-08-21.json`): the holders aggregate
 * answered in 1.1–45.8 s while `/api/v2/stats` on the SAME chain, host and key answered in
 * 0.39–0.99 s in the same minute. Every chain answered at least once. The 5 s ceiling was refusing
 * calls the vendor was going to serve — `token.holders` was served on one chain of five, and that
 * one only when its entry was warm.
 *
 * **Why the other three routes keep 5 s, which is the load-bearing half of this decision.** Raising
 * the adapter-wide constant would buy the same latency for `gas.price`, `chain.transactions` and
 * `entity.labels` — routes measured at 0.3–0.8 s — and in doing so would ABSORB a future
 * vendor-wide slowdown into longer waits and green rows. Leaving them at 5 s means such a slowdown
 * arrives as failures in the live gate, which is the signal this project exists to keep. A ceiling
 * is a statement about one route's measured behaviour, and three routes have no such measurement
 * supporting a raise.
 *
 * **This is a hop bound, not the call's.** Same as `REQUEST_TIMEOUT_MS`: `safeFetch` arms
 * `AbortSignal.timeout` inside its redirect loop, so four hops can each spend it. The bound on the
 * walk is the call deadline — `capabilityManifests['token.holders'].deadlineMs`, moved to 60_000 by
 * the same task and against the same measurement. Raising this number without raising that one
 * would change nothing: the deadline is absolute and refuses first.
 */
const HOLDERS_TIMEOUT_MS = 60_000;

/**
 * A uint256 in decimal, with the 78-digit ceiling that makes it one (M-2). Hoisted for the same
 * reason as `CAIP2_EIP155_RE`: it is evaluated once per holder row.
 */
const UINT256_DECIMAL_RE = /^(0|[1-9][0-9]{0,77})$/;

/**
 * Throttle tokens burned by one `/v1/get_address_info` call.
 *
 * The bucket counts OUR requests; the vendor's quota counts UPSTREAM ones, and this endpoint fans
 * out to three of them server-side (20 + 120 + 20 ≈ 160 credits —
 * `docs/tasks/task-008-blockscout-free-tier.md` §1.2, measured). So one
 * call that looks like one call to the limiter is three to the thing being limited. `nansen` has
 * the same asymmetry and needs no weight, because its composite capabilities genuinely issue N
 * requests and therefore call `throttle()` N times; here the fan-out is invisible to us, so it has
 * to be declared.
 *
 * `/v1/direct_api_call` (the holders route) stays at the default weight of 1 — it proxies a single
 * upstream REST endpoint, which is exactly what makes it cheap.
 */
const WEIGHT_ADDRESS_INFO = 3;

/**
 * Cap on `tags`/`labels`, mirroring `EntityLabelSchema`'s `.max(64)`.
 *
 * L-2: the schema bound used to be enforced by the THROW that `parse()` raises, which on
 * `entity.labels` means an address with 65+ tags escalates to PAID Nansen every 60 seconds, forever.
 * The holders path already got this right (`slice`, not throw); labels now match it. A cap enforced
 * by failing is a cap that turns a data-shape surprise into an outage or a bill.
 */
const MAX_LABEL_TAGS = 64;

export interface BlockscoutAdapterDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** Injectable for tests; production reads `process.env` (D10 — never a literal in code). */
  env?: Record<string, string | undefined>;
  chains?: ChainRegistry;
  /**
   * Injectable throttle, same seam `nansen` already exposes. Production uses the shared singleton.
   *
   * Needed here for the same reason it was needed there: the per-capability token WEIGHT is a claim
   * about vendor cost that nothing else can check. `rate-limit.test.ts` proves the weight mechanism
   * works; only this seam can prove that `entity.labels` actually asks for three of them, which is
   * the part a refactor deletes without any test noticing.
   */
  throttle?: Throttle;
}

interface HoldersFetchResult {
  kind: 'holders';
  chain: string;
  tokenAddress: string;
  body: SanitizedBlockscoutBody;
}

interface LabelsFetchResult {
  kind: 'labels';
  chain: string;
  address: string;
  body: SanitizedBlockscoutBody;
}

/**
 * WI-51: `gas.price` and `chain.transactions` both read ONE document — `/api/v2/stats`.
 *
 * Kept as a single result kind rather than two, because the two capabilities differ only in which
 * fields they project. The registry still caches them separately (its key is
 * `(provider, capability, argsHash)`), which is the correct behaviour and not an accident worth
 * optimising away: the document is ~1 KB and costs one upstream endpoint, unlike `get_address_info`
 * whose three-way fan-out is what `WEIGHT_ADDRESS_INFO` exists for.
 */
interface StatsFetchResult {
  kind: 'stats';
  chain: string;
  nativeSymbol: string | null;
  body: SanitizedBlockscoutBody;
}

type BlockscoutFetchResult = HoldersFetchResult | LabelsFetchResult | StatsFetchResult;

/**
 * The header the facade reads the PRO key from — the vendor's own name for it, measured.
 *
 * L-6: it used to be the query parameter `apikey`, which the facade does not read AT ALL. The two
 * channels are distinguishable live and were measured against each other on 2026-08-11: a
 * deliberately bogus key in this HEADER answers `401 Unauthorized` (seen and rejected), while the
 * same bogus key in `?apikey=` answers the byte-identical **keyless** 403 (never seen). So a key
 * configured in `.env` bought exactly nothing until this constant existed.
 *
 * It also has to match `SENSITIVE_HEADER_RE` in `net/safe-fetch.ts` (`/authorization|api-?key/i`),
 * which strips headers across a redirect to a different host — `…-Pro-Api-Key` does. That is not a
 * coincidence to rely on silently: a future rename to something without "api key" in it would send
 * the key to whatever host the facade redirects to, so rename this and that regex together.
 */
const PRO_KEY_HEADER = 'Blockscout-MCP-Pro-Api-Key';

/**
 * HTTP statuses that mean "ask someone else", not "the answer is no".
 *
 * `401` — a rejected key. Reachable and measured since 2026-08-11 (bogus key in `PRO_KEY_HEADER`).
 * `402` — no key where one is now required. Kept: it is what the DIRECT host answers.
 * `403` — **the status the facade actually chose for "your keyless session is over"** (L-6). The
 * comment this list carried before predicted this branch would be needed "before it is observable —
 * the alternative is discovering it in production on the day the grace period ends". The prediction
 * was right and the list was still wrong, because it enumerated 401/402 and the vendor picked 403:
 * an anticipated branch keyed on the wrong number is an unanticipated branch. The consequence was
 * not cosmetic — `token.holders` routes through this adapter alone, so instead of degrading it
 * raised a hard error on every call for ~30 chains.
 * `429` — throttled. Ours is a client-side limiter with no server signal to read (the responses
 * carry no `RateLimit-*` and no credit-balance headers at all — re-measured 2026-08-11 WITH a valid
 * key), so a 429 is information we cannot anticipate, only yield to.
 */
const DEGRADE_STATUSES = new Set([401, 402, 403, 429]);

/**
 * Thrown for a status that should send the registry to the next adapter in the chain. Carries no
 * response body: the point of degrading is to move on, and a vendor body on this path would reach
 * the model through `tried[].reason` (the R-68e error-path lesson from TASK-007 cycle 3).
 */
export class BlockscoutDegradedError extends Error {
  constructor(
    readonly status: number,
    host: string,
  ) {
    super(`blockscout: HTTP ${status} from ${host} — falling through to the next adapter`);
    this.name = 'BlockscoutDegradedError';
  }
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`blockscout: "${key}" is required and must be a non-empty string`);
  }
  return value;
}

/** `https://host/...` → `host`; used so error text never carries a URL. */
function hostOf(url: string): string {
  return new URL(url).hostname;
}

export function createBlockscoutAdapter(deps: BlockscoutAdapterDeps = {}): ProviderAdapter {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const env = deps.env ?? process.env;
  const chains = deps.chains ?? loadChainRegistry();
  const throttle = deps.throttle ?? productionThrottle;

  // M-8: the disabled-by-config shape. Every entry point declines with the same reason, so the
  // registry records it in `tried[]` and walks on, `onchain_list_chains` stops advertising the two
  // capabilities (`chainSupport` is false everywhere), and the process boots. Compare the throw this
  // replaced, whose blast radius was the whole server.
  if (REGISTRATION === undefined || RATE_LIMIT === undefined) {
    const reason = 'blockscout: disabled — no entry in adapterRegistrations (providers.config.ts)';
    return {
      id: 'blockscout',
      chainSupport: () => false,
      capabilities: () => [],
      costOf: () => ({ credits: Number.POSITIVE_INFINITY }),
      fetch: () => Promise.reject(new Error(reason)),
      normalize: () => {
        throw new Error(reason);
      },
      isAvailable: () => ({ ok: false, reason: 'disabled in providers.config.ts' }),
    };
  }
  const rateLimit = RATE_LIMIT;

  /**
   * Performs the request and hands back a SANITIZED body — the raw one is never returned, so no
   * caller can accidentally read a field this adapter is supposed to have removed.
   *
   * **The key is applied HERE and nowhere else** — as the `PRO_KEY_HEADER` request header, which is
   * the only channel the facade reads (see that constant for the measurement). It is still read
   * inside `fetch()`, after `CapabilityRegistry` has derived the cache key from
   * `(provider, capability, normalizedArgs)` where it is not an argument, so it can never enter one.
   *
   * L-6 moved it out of the URL, which changes what the error-path wrapper below is FOR. This was
   * the one adapter in the repo that put a secret in a URL, and that fact is the entire justification
   * recorded at the `catch` for re-messaging `safeFetch`'s throws. It is no longer true: the query
   * string now carries `chain_id` and `endpoint_path` and nothing else. The wrapper stays anyway —
   * it costs one branch, it still bounds vendor- and network-supplied text on the path that reaches
   * the model, and a future key-in-URL route would otherwise re-open the hole silently — but it is
   * now defence in depth rather than the thing standing between a key and the transcript.
   */
  async function request(
    base: string,
    path: string,
    query: Record<string, string>,
    weight = 1,
    // Task 012-8: the registry's own `effectiveDeadlineAtMs`, forwarded VERBATIM. Never a duration
    // re-derived here — that is what would re-grant a full budget to each of the (up to four) hops
    // `safeFetch` can make. `undefined` (a direct caller that passes nothing) restores exactly the
    // pre-012-8 behaviour: `MAX_WAIT_MS` in the limiter and `REQUEST_TIMEOUT_MS` per hop.
    deadlineAtMs?: number,
    // Task 014-42: the hop ceiling, per ROUTE. Defaults to this adapter's own 5 s, so every call
    // site that does not name a number keeps exactly the bound it had — only the holders route
    // passes one, and only because it was measured. A parameter rather than a lookup table keyed on
    // `cap`: the table would be a second place stating which route is slow, and the call site
    // already is one.
    timeoutMs: number = REQUEST_TIMEOUT_MS,
  ) {
    const url = new URL(path, base);
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);

    const apiKey = env['BLOCKSCOUT_PRO_API_KEY'];
    // Built conditionally rather than always-with-an-empty-value: an empty `PRO_KEY_HEADER` is a
    // key the vendor would evaluate and reject (401), which reads as "your key is bad" instead of
    // "you have no key". `isAvailable()` already refuses the keyless case, so reaching here without
    // one means a direct call — and it should get the vendor's own keyless answer, not a fake one.
    const authHeaders: Record<string, string> =
      apiKey !== undefined && apiKey.length > 0 ? { [PRO_KEY_HEADER]: apiKey } : {};

    // The limiter gets it FIRST, and that ordering is the point: `entity.labels` costs three tokens
    // against a `{capacity: 5, refillPerSec: 2}` bucket, so a burst puts this call seconds behind a
    // deficit it can measure against the deadline before anything is sent. Refusing a wait we know
    // is longer than the time left is free; discovering it afterwards costs the whole wait.
    await throttle('blockscout', rateLimit, weight, deadlineAtMs);

    // M-7 (adversarial cycle 1). `safeFetch` interpolates the FULL URL into three of its own
    // errors — timeout, response-too-large, redirect cap — and this is the only adapter in the repo
    // that puts a secret in a URL, so those messages were never a secret channel before. They
    // travel verbatim into `tried[].reason` and from there into the tool's `isError` text, i.e. to
    // the model. The docstring above claimed "every error names a HOST, never a URL"; that was true
    // only of the errors THIS file constructs. Nothing but a wrapper can fix it here.
    let response: Response;
    try {
      response = await safeFetch(
        url.toString(),
        { method: 'GET', headers: authHeaders },
        ALLOWLIST,
        fetchImpl,
        // H-3/H-5: explicit bounds rather than `safeFetch`'s 10 MB / 15 s defaults. See the two
        // constants for why each default was wrong for this adapter specifically.
        //
        // `deadlineAtMs` is ADDITIVE to `timeoutMs`, never a replacement (task 012-8): the hop
        // timeout says "this vendor did not answer", the deadline says "we ran out of our own
        // time", and `safeFetch` keeps them as two separate signals so the classes it throws stay
        // distinguishable. Spread conditionally so a call without a deadline builds byte-for-byte
        // the options object it built before this task.
        {
          timeoutMs,
          maxResponseBytes: MAX_RESPONSE_BYTES,
          ...(deadlineAtMs === undefined ? {} : { deadlineAtMs }),
        },
      );
    } catch (error) {
      // WI-36 — the typed transport errors go back UNWRAPPED, everything else is still re-messaged.
      //
      // The wrapper below is not being weakened: it exists because `safeFetch` interpolates a full
      // URL into some of its errors and this is the one adapter that puts a secret in a URL, and it
      // still covers every throw whose text this adapter cannot vouch for. What it must not do is
      // destroy a CLASS the caller decides on. `CapabilityRegistry` reads
      // `error instanceof DeadlineExceededError` to tell "our own time is up" (which ends the walk
      // for every adapter) from "this source failed" (which does not) — and after a rewrap that test
      // was false for every call through this adapter, because the class survived only on `.cause`.
      //
      // Safety is a property of the LISTED CLASSES, not a judgement made here: each one redacts its
      // own context at construction, which is why the list lives beside them in `net/safe-fetch.ts`
      // and is gated there. This adapter asks the question, it does not answer it.
      if (isPassThroughTransportError(error)) throw error;
      // Name the failure CLASS, never the message — a vendor- or network-supplied string is exactly
      // what must not be echoed, and the URL that carries the key lives in some of them.
      const kind = error instanceof Error ? error.name : 'UnknownError';
      // `cause` preserves the original for a debugger while keeping the MESSAGE free of the URL —
      // only `.message` is interpolated into `tried[].reason`, never the cause chain.
      throw new Error(`blockscout: transport failure from ${hostOf(base)} (${kind})`, {
        cause: error,
      });
    }

    if (DEGRADE_STATUSES.has(response.status) || !response.ok) {
      // Iteration 2 (perf M-4): cancel the body before throwing. `safeFetch` has already taken
      // `body.getReader()` to wrap the stream in its size counter, so an early exit that neither
      // reads nor cancels leaves undici holding the connection until GC or a socket timeout
      // reclaims it — on precisely the status class this adapter is DESIGNED to hit (401/402/429
      // are its degrade path). `safeFetch` already does this for redirect hops; the adapter's own
      // early exits did not.
      void response.body?.cancel().catch(() => undefined);
      if (DEGRADE_STATUSES.has(response.status)) {
        throw new BlockscoutDegradedError(response.status, hostOf(base));
      }
      throw new Error(`blockscout: HTTP ${response.status} from ${hostOf(base)}`);
    }
    // m-11: `response.json()` on a non-JSON body throws a message that QUOTES the first ~10
    // characters of the vendor's response ("Unexpected token '<'…"), and that message travels into
    // `tried[].reason` → the model. Tiny, but it is vendor-controlled text on the error path —
    // the exact channel R-68e closes — so the parse failure is reported by class, not by content.
    try {
      return sanitizeBlockscoutBody(await response.json());
    } catch (error) {
      // M-9: report the CLASS, not one blanket message. Three different failures land here —
      // `SafeFetchResponseTooLargeError` (which by design surfaces at body-read time, not at
      // `safeFetch` return), a mid-body network abort, and a genuinely non-JSON payload. They have
      // different retryability and different operator responses, and collapsing them into
      // "unparseable response body" made the size cap in particular undiagnosable. Naming the class
      // leaks nothing: the class name is ours or the platform's, never vendor content — which is
      // exactly the rule the transport catch twelve lines above already follows.
      const kind = error instanceof Error ? error.name : 'UnknownError';
      throw new Error(`blockscout: unreadable response body from ${hostOf(base)} (${kind})`, {
        cause: error,
      });
    }
  }

  return {
    id: 'blockscout',
    chainSupport: servesChain,
    capabilities: () => [
      { id: 'token.holders' },
      { id: 'entity.labels' },
      // WI-51 — both projected from `/api/v2/stats`, see `StatsFetchResult`.
      { id: 'gas.price' },
      { id: 'chain.transactions' },
    ],
    // Free tier: no Nansen-style credit accounting. The vendor's own quota is bounded by the
    // per-adapter throttle and the capability TTL cache (PLAN §3).
    costOf: () => ({ credits: 0 }),

    // Task 012-8 — the ONE adapter that reads the deadline in that task. It is free, keyless and
    // first on the `entity.labels` route, so it is also the one whose lateness is most expensive:
    // every second it spends is a second the PAID source behind it does not get.
    fetch: async (
      cap: string,
      args: Record<string, unknown>,
      deadlineAtMs?: number,
    ): Promise<BlockscoutFetchResult> => {
      const chain = chains.resolve(requireString(args, 'chain'));
      const chainId = evmChainId(chain);
      if (chainId === undefined) {
        // Unreachable through the registry (chainSupport gates first); explicit so a direct call
        // cannot silently build a URL with `undefined` in the path.
        throw new Error(`blockscout: ${chain.slug} has no EVM chain id`);
      }

      if (cap === 'token.holders') {
        // M-10: validate BEFORE the value is interpolated into `endpoint_path`, which the VENDOR
        // then uses to build its own server-side request. Two facts make the unguarded version a
        // latent path-traversal: `normalizeAddress` canonicalizes only for `family: 'evm' | 'svm'`
        // and otherwise returns its input verbatim, and the guard above is an `evmChainId` (caip2)
        // check, never a family check — the two coincide today only through a generated registry
        // column whose own header permits hand-edited curated values. For `family: 'other'`,
        // `isValidAddress` accepts any 1–128-character string, i.e. `../../v2/…`. And
        // `token.holders` has no MCP tool yet, so no input schema bounds this string upstream.
        const requested = requireString(args, 'tokenAddress');
        if (chain.family !== 'evm' || !isValidAddress(chain, requested)) {
          throw new Error(`blockscout: "tokenAddress" is not a valid ${chain.slug} address`);
        }
        const tokenAddress = normalizeAddress(chain, requested);
        // B-3 (adversarial cycle 1): this used to call `api.blockscout.com` directly. That host
        // enforces auth — 402 with no key, 401 with a bad one — and `token.holders` routes to
        // `['blockscout']` ALONE, so there was no next adapter to degrade to. Meanwhile
        // `requiresEnv: []`, `costOf: 0` and `isAvailable: {ok:true}` all promised a free,
        // available capability, and the coverage matrix advertised it on 39 chains. On a stock
        // install (`.env.example` ships the key commented out) it answered on NONE of them: the
        // exact "advertised by the matrix, served nowhere" defect this task was written to remove,
        // with `dune` swapped for `blockscout`.
        //
        // The facade proxies the same REST endpoint and — measured 2026-07-28, keyless — returns
        // the identical `data.items` payload (50 rows, `value` as a string, 10 of them labelled),
        // which `normalizeHolders` already accepts. It wraps that in the model-directed
        // `instructions`/`notes` fields, which is precisely what `sanitize.ts` exists for, and the
        // transport-boundary test now proves the sanitizer is actually invoked on this path too.
        const body = await request(
          FACADE_HOST,
          '/v1/direct_api_call',
          {
            chain_id: String(chainId),
            endpoint_path: `/api/v2/tokens/${tokenAddress}/holders`,
          },
          // Default weight of 1 — one upstream REST endpoint behind this one (see
          // `WEIGHT_ADDRESS_INFO` for the other path). Stated positionally because the deadline
          // follows it.
          1,
          deadlineAtMs,
          // The ONE route in this adapter that does not use `REQUEST_TIMEOUT_MS` — see
          // `HOLDERS_TIMEOUT_MS` for the measurement, and for why the other three still do.
          HOLDERS_TIMEOUT_MS,
        );
        return { kind: 'holders', chain: chain.slug, tokenAddress, body };
      }

      if (cap === 'entity.labels') {
        // B-1 (adversarial cycle 1): this used to read `args.address`, a name NO caller can send.
        // `onchain_entity_label` builds `{chain, exhaustive, query?, tokenAddress?}` and its input
        // schema is `.strict()`, so `address` was unreachable — the adapter threw before the
        // network on 100% of real calls and every request fell through to PAID Nansen. The
        // capability's whole reason for existing produced exactly zero saving, and the unit tests
        // missed it because they hand-built args instead of driving the tool.
        // H-2: a `query` present alongside `tokenAddress` used to be SILENTLY DROPPED. The tool
        // contract accepts both (`onchain_entity_label` builds `{chain, exhaustive, query?,
        // tokenAddress?}`) and Nansen honours both; this adapter read only the address and then
        // reported `source: 'blockscout'`, so the caller got no signal that half the request had
        // been discarded — and `deriveArgsHash` includes `query`, so the wrong-scope answer was
        // cached per query string and replayed. Declining is the only honest option: silent
        // narrowing is worse than either answering fully or standing aside.
        const query = args['query'];
        if (typeof query === 'string' && query.length > 0) {
          throw new Error(
            'blockscout: entity.labels received a free-text query — this provider resolves an ' +
              'address only, and answering from the address alone would silently drop the query',
          );
        }
        const tokenAddress = args['tokenAddress'];
        if (typeof tokenAddress !== 'string' || tokenAddress.length === 0) {
          // Declines that name WHY, so the registry's fallback to Nansen is a deliberate handoff
          // rather than an accident. Blockscout resolves an ADDRESS; it has no free-text entity
          // search, so a `query`-only call is genuinely Nansen's to answer.
          throw new Error(
            'blockscout: entity.labels needs a tokenAddress — this provider resolves an address, ' +
              'not a free-text query',
          );
        }
        if (chain.family !== 'evm' || !isValidAddress(chain, tokenAddress)) {
          // M-10, same reasoning as the holders path — this one lands in a query parameter rather
          // than a path segment, which is milder, not safe.
          throw new Error(`blockscout: "tokenAddress" is not a valid ${chain.slug} address`);
        }
        if (args['exhaustive'] === true) {
          // The exhaustive tier is a paid Nansen escalation. Answering it from the free source
          // would silently downgrade what the caller explicitly paid to ask for.
          throw new Error(
            'blockscout: entity.labels exhaustive tier is not served by this provider',
          );
        }
        const address = normalizeAddress(chain, tokenAddress);
        const body = await request(
          FACADE_HOST,
          '/v1/get_address_info',
          { chain_id: String(chainId), address },
          // Three upstreams behind one request — see `WEIGHT_ADDRESS_INFO`.
          WEIGHT_ADDRESS_INFO,
          deadlineAtMs,
        );
        return { kind: 'labels', chain: chain.slug, address, body };
      }

      if (cap === 'gas.price' || cap === 'chain.transactions') {
        // WI-51. `endpoint_path` is a CONSTANT here — no caller-supplied segment reaches it, so the
        // path-traversal reasoning that guards the holders route (M-10) has nothing to guard. The
        // only variable is `chain_id`, which `evmChainId()` above already proved is an integer.
        const body = await request(
          FACADE_HOST,
          '/v1/direct_api_call',
          { chain_id: String(chainId), endpoint_path: '/api/v2/stats' },
          1,
          deadlineAtMs,
        );
        return {
          kind: 'stats',
          chain: chain.slug,
          // Read from OUR registry, never from the vendor: this is the label that stops "386 Gwei"
          // on polygon from being read as ETH, and the registry is where a human curated it.
          nativeSymbol: chain.nativeSymbol,
          body,
        };
      }

      throw new Error(`blockscout: unsupported capability ${cap}`);
    },

    normalize: (
      cap: string,
      raw: unknown,
    ): TokenHolders | EntityLabel[] | GasPrice | ChainTransactions => {
      if (
        cap !== 'token.holders' &&
        cap !== 'entity.labels' &&
        cap !== 'gas.price' &&
        cap !== 'chain.transactions'
      ) {
        throw new Error(`blockscout.normalize: unsupported capability ${cap}`);
      }
      // L-7: guard the cast. `raw as BlockscoutFetchResult` on a non-object produced a bare
      // `TypeError` from `result.kind`, and `CapabilityRegistry` turns a `normalize()` throw into a
      // NEGATIVE cache entry — so a malformed payload became a self-inflicted outage for the whole
      // negative TTL instead of a transient failure.
      if (raw === null || typeof raw !== 'object' || !('kind' in raw)) {
        throw new Error(`blockscout.normalize: malformed fetch result for ${cap}`);
      }
      const result = raw as BlockscoutFetchResult;
      if (cap === 'token.holders' && result.kind === 'holders') {
        return normalizeHolders(result, now(), chains.resolve(result.chain));
      }
      if (cap === 'entity.labels' && result.kind === 'labels') {
        return normalizeLabels(result, now());
      }
      if (cap === 'gas.price' && result.kind === 'stats') {
        return normalizeGasPrice(result, now());
      }
      if (cap === 'chain.transactions' && result.kind === 'stats') {
        return normalizeChainTransactions(result, now());
      }
      // L-7: the old message said "unsupported capability token.holders" for a capability this
      // adapter DOES support. The actual fault is a capability/payload mismatch; say that.
      throw new Error(
        `blockscout.normalize: ${cap} does not match a '${String(result.kind)}' fetch result`,
      );
    },

    /**
     * L-6: the key is now a PRECONDITION, because the facade stopped answering without one.
     *
     * This used to return `{ok: true}` unconditionally, on the reasoning that "the facade answers
     * without a key today, and demanding one would disable a working capability on a stock
     * install". Both halves were true when written and the first stopped being true on 2026-08-11:
     * every `/v1/*` data route now answers 403 keyless, with a body telling the caller to obtain a
     * PRO key. The second half was the one to re-read — an install with no key does not have "a
     * working capability" to disable, it has an advertisement. Left as-is, `chainSupport()` kept
     * `onchain_list_chains` promising `token.holders` on 39 chains that answer on none, which is
     * verbatim the "advertised by the matrix, served nowhere" defect this adapter was written to
     * REMOVE — reintroduced from the vendor's side rather than ours.
     *
     * So it declines by name. The registry records the reason in `tried[]` and walks on;
     * `entity.labels` falls through to Nansen exactly as it does for any other unavailable adapter;
     * and the coverage matrix stops claiming chains nobody can serve. Nothing here reads the key's
     * VALUE — only whether one is present — so this stays outside the cache key and out of logs
     * (D10).
     */
    isAvailable: () => {
      const apiKey = env['BLOCKSCOUT_PRO_API_KEY'];
      if (apiKey === undefined || apiKey.length === 0) {
        return {
          ok: false,
          reason:
            'BLOCKSCOUT_PRO_API_KEY is not set — the facade stopped serving keyless requests ' +
            '(HTTP 403) and cannot answer without one',
        };
      }
      return { ok: true };
    },
  };
}

/**
 * The `data` container of a stats response, or a refusal.
 *
 * Same rule `normalizeHolders` applies one level up and for the same reason: a facade that proxies a
 * REST call can render an upstream error as HTTP 200, and answering "gas price: unknown" from a body
 * we failed to read states a fact the vendor never gave us. Refusing sends the registry to the next
 * adapter, which on `gas.price` is a real node.
 */
function statsContainer(result: StatsFetchResult, cap: string): Record<string, unknown> {
  const plain = asPlain(result.body);
  if (plain === null || typeof plain !== 'object') {
    throw new Error(`blockscout.normalize(${cap}): response body is not an object`);
  }
  const container = readObject(plain, 'data');
  if (container === undefined) {
    throw new Error(`blockscout.normalize(${cap}): response carries no \`data\` object`);
  }
  return container;
}

/**
 * A finite non-negative number the vendor actually stated, or `null`.
 *
 * `null` is returned for absent, non-numeric AND non-finite input — never 0. The distinction is the
 * whole point: polygon's keyless `/api/v2/stats` publishes `gas_prices.average: null` (measured
 * 2026-08-11 before the key was wired), and a 0 there reads as "gas is free on polygon", which is
 * both false and actionable in the expensive direction.
 */
function finiteOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function normalizeGasPrice(result: StatsFetchResult, fetchedAt: number): GasPrice {
  const data = statsContainer(result, 'gas.price');
  const prices = readObject(data, 'gas_prices');
  const slow = finiteOrNull(prices?.['slow']);
  const average = finiteOrNull(prices?.['average']);
  const fast = finiteOrNull(prices?.['fast']);

  // All three or none. A partial tier set is not a cheaper answer, it is a shape a consumer has to
  // branch on to use at all — and `gasPriceGwei` below already carries the single-number answer.
  const tiers =
    slow !== null && average !== null && fast !== null
      ? { slowGwei: slow, averageGwei: average, fastGwei: fast }
      : null;

  // The vendor's own measurement stamp, when it parses. An unparseable date is null rather than
  // `NaN` or "now": claiming our fetch time as the vendor's measurement time would make a stale
  // price look fresh, which is the one lie this field exists to prevent.
  const stampedAt = data['gas_price_updated_at'];
  let measuredAt: number | null = null;
  if (typeof stampedAt === 'string') {
    const parsed = Date.parse(stampedAt);
    if (Number.isFinite(parsed)) measuredAt = parsed;
  }

  return GasPriceSchema.parse({
    chain: result.chain,
    // An indexer publishes rounded Gwei floats and no wei at all. Multiplying 0.31 by 1e9 and
    // presenting the product as exact wei would dress a rounded number up as a measured one.
    gasPriceWei: null,
    gasPriceGwei: average,
    tiers,
    nativeSymbol: result.nativeSymbol,
    measuredAt,
    source: 'blockscout',
    fetchedAt,
  });
}

/** A non-negative safe integer the vendor stated, or `null` — never 0 by default (see `finiteOrNull`). */
function intOrNull(value: unknown): number | null {
  if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  // The counters arrive as numbers today; a vendor that switches to strings should still be read
  // rather than silently zeroed, and `total_transactions` (3.67e9) is well inside the safe range.
  if (typeof value === 'string' && /^(0|[1-9][0-9]*)$/.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : null;
  }
  return null;
}

function normalizeChainTransactions(
  result: StatsFetchResult,
  fetchedAt: number,
): ChainTransactions {
  const data = statsContainer(result, 'chain.transactions');
  return ChainTransactionsSchema.parse({
    chain: result.chain,
    transactionsPerDay: intOrNull(data['transactions_today']),
    totalTransactions: intOrNull(data['total_transactions']),
    totalBlocks: intOrNull(data['total_blocks']),
    averageBlockTimeMs: finiteOrNull(data['average_block_time']),
    networkUtilizationPct: finiteOrNull(data['network_utilization_percentage']),
    // `total_addresses` is READ BY NOBODY here, deliberately — it is cumulative since genesis, and
    // WI-51 asked for ACTIVE addresses. See `ChainTransactionsSchema`'s docstring.
    source: 'blockscout',
    fetchedAt,
  });
}

function readObject(source: unknown, key: string): Record<string, unknown> | undefined {
  if (source === null || typeof source !== 'object') return undefined;
  const value = (source as Record<string, unknown>)[key];
  return value !== null && typeof value === 'object'
    ? (value as Record<string, unknown>)
    : undefined;
}

function normalizeHolders(
  result: HoldersFetchResult,
  fetchedAt: number,
  chain: ChainInfo,
): TokenHolders {
  const plain = asPlain(result.body);
  // The direct host answers `{items, next_page_params}`; the facade wraps the same under `data`.
  // Accepting either keeps the normalizer honest if a route is ever moved between hosts.
  // Iteration 2 (L-1): a literal `null` body passes through the sanitizer untouched, and the
  // `?? (plain as …)` fallback then hands `null` to the `items` read below as a bare `TypeError` —
  // bypassing M-3's typed refusal for exactly the class M-3 exists for (an error envelope or an
  // upstream 404 rendered as HTTP 200).
  if (plain === null || typeof plain !== 'object') {
    throw new Error(
      'blockscout.normalize(token.holders): response body is not an object — refusing to ' +
        'report an empty holder list the vendor did not assert',
    );
  }
  const container = readObject(plain, 'data') ?? (plain as Record<string, unknown>);

  // M-3: an ABSENT `items` is not "zero holders". This used to default to `[]`, and the
  // all-rows-unusable guard below only fires when rows were present — so an error envelope, a shape
  // change, or an upstream 404 rendered as HTTP 200 (routine for a facade that proxies a REST call)
  // produced an authoritative `{holders: [], truncated: false}`, cached for an hour, on a route
  // with NO fallback adapter to correct it. Same rule as the guard below, applied one level up.
  const rawItems = container['items'];
  if (!Array.isArray(rawItems)) {
    throw new Error(
      'blockscout.normalize(token.holders): response carries no `items` array — refusing to ' +
        'report an empty holder list the vendor did not assert',
    );
  }

  // H-3: bound FIRST, then do per-row work. This used to walk EVERY row the vendor sent — a regex
  // plus, for each survivor, a keccak-256 and a 40-element `Array.from().map().join()` — and slice
  // to 50 only afterwards. The sole bound on `rawItems` is the response-size cap, so at the old
  // 10 MB default that was ~12 000 rows of hashing to keep 50, on a single-threaded stdio server.
  const page = rawItems.slice(0, HOLDERS_PAGE);
  const overflow = rawItems.length - page.length;

  // M-4: counted, not silent. A shrinking list that still reports `truncated: false` claims to be
  // the exact tail while having holes in it — and concentration is the question this type exists
  // to answer.
  let droppedRows = 0;
  const holders = page.flatMap((item) => {
    const row = item as Record<string, unknown>;
    const address = readObject(row, 'address');
    const hash = address?.['hash'];
    const amount = row['value'];
    // Skip-and-drop rather than fail the batch (the `dexscreener` precedent): one malformed row
    // must not turn a useful holder list into no answer at all.
    if (
      typeof hash !== 'string' ||
      typeof amount !== 'string' ||
      // Iteration 2 (M-4): the SAME bounded pattern `token_id` uses. The unbounded twin let a
      // vendor publish arbitrary-length digit strings into the canonical type and the cache.
      !UINT256_DECIMAL_RE.test(amount)
    ) {
      droppedRows += 1;
      return [];
    }

    // R-80 — the vendor may cut a value server-side and say so. A truncated integer is not a
    // smaller number, it is a WRONG one, and `amountRaw` is contractually exact — so the row is
    // dropped rather than published with a plausible-looking balance. Not observed on any recorded
    // response (2026-07-28), which is precisely why it is handled here instead of relied upon to
    // stay absent: the failure mode is silent, and the cost of the guard is one condition.
    if (row['value_truncated'] === true || address?.['value_truncated'] === true) {
      droppedRows += 1;
      return [];
    }

    // M-6: canonicalize and validate, exactly as `nansen`'s mappers do for vendor-supplied
    // addresses and as this same adapter already does for `entity.labels` twelve lines away.
    // Coverage is EVM-only, so `normalizeAddress` genuinely canonicalizes (EIP-55) rather than
    // passing text through — and a row whose address is not an address is a row we cannot stand
    // behind, so it is dropped and counted rather than published.
    if (!isValidAddress(chain, hash)) {
      droppedRows += 1;
      return [];
    }

    // Labels are per-row here (each holder carries its own `metadata.tags`), unlike the
    // address-scoped block `entity.labels` reads — so they come from this row's own subtree.
    const label = readRowLabel(address);
    // M-5: `token_id` distinguishes ERC-1155 rows that share an address. Kept as the vendor's own
    // string — a uint256 id does not fit a JS number.
    //
    // M-2 (vdd-multi TASK-008): VALIDATED, not merely typeof-checked. This was the one unbounded,
    // unvalidated vendor string in the canonical type — every sibling is guarded (`amountRaw` by
    // regex twice, `address` by `isValidAddress`, `label` by `truncateVendorText`) — so a hostile
    // response could put arbitrary text at arbitrary length into `structuredContent`, the JSON-RPC
    // frame and the SQLite cache row. A row whose id is PRESENT but is not a uint256 is dropped
    // rather than published without it: omitting just the field would silently merge two distinct
    // ERC-1155 positions into look-alike rows, the same class of fabricated answer as a truncated
    // `amountRaw`. An absent or empty id still means "not an ERC-1155 row", as before.
    const rawTokenId = row['token_id'];
    const hasTokenId = rawTokenId !== undefined && rawTokenId !== null && rawTokenId !== '';
    if (hasTokenId && (typeof rawTokenId !== 'string' || !UINT256_DECIMAL_RE.test(rawTokenId))) {
      droppedRows += 1;
      return [];
    }
    const tokenId = hasTokenId ? (rawTokenId as string) : undefined;
    return [
      {
        address: normalizeAddress(chain, hash),
        ...(label === undefined ? {} : { label }),
        amountRaw: amount,
        ...(tokenId === undefined ? {} : { tokenId }),
        ...(typeof address?.['is_contract'] === 'boolean'
          ? { isContract: address['is_contract'] }
          : {}),
        ...(typeof address?.['is_scam'] === 'boolean' ? { isScam: address['is_scam'] } : {}),
      },
    ];
  });

  // A body whose every row is unusable is not "zero holders" — it is a response we failed to read,
  // and answering `{holders: [], truncated: false}` would state a fact the vendor never gave us.
  // Same rule `dexscreener` follows for its batch.
  if (page.length > 0 && holders.length === 0) {
    throw new Error(
      `blockscout.normalize(token.holders): all ${page.length} row(s) were unusable — refusing ` +
        'to report an empty holder list the vendor did not assert',
    );
  }
  if (droppedRows > 0) {
    // A diagnostic nobody reads is not a diagnostic: the count reaches the caller in the result,
    // and the operator on stderr.
    process.stderr.write(
      `blockscout: dropped ${droppedRows} unusable holder row(s) for ${result.tokenAddress}\n`,
    );
  }

  // M-4: the facade says "there is more" in TWO places — `data.next_page_params` and a root-level
  // `pagination.next_call` — and only the first was read. Both appear in the recorded response, so
  // if the facade ever normalizes to the second alone, `truncated` flips silently to false on a
  // paged list and "the first 50 of many" is presented as "50 holders". Preventing exactly that
  // confusion is the entire reason this flag exists.
  const pagination = readObject(plain, 'pagination');
  const hasMore = container['next_page_params'] != null || pagination?.['next_call'] != null;

  return TokenHoldersSchema.parse({
    chain: result.chain,
    tokenAddress: result.tokenAddress,
    // Already bounded to `HOLDERS_PAGE` before the per-row work — see the slice above.
    holders,
    truncated: overflow > 0 || hasMore || droppedRows > 0,
    droppedRows,
    source: 'blockscout',
    fetchedAt,
  });
}

/**
 * Display label of a holder row, bounded — or `undefined` when unlabelled.
 *
 * m-9: prefers `tagType: 'name'` (the display label, e.g. "Sky: PSM") over a `protocol` tag
 * ("Sky"), instead of taking whichever came first — the vendor lists both and their order is its
 * business, not ours. Bounded with `truncateVendorText`, the same helper the sanitizer and the
 * nansen path use, rather than a bare `String.slice`: they differ on multi-byte input, and a label
 * cut mid-surrogate is a mojibake string handed to a model.
 */
function readRowLabel(address: Record<string, unknown> | undefined): string | undefined {
  const metadata = readObject(address, 'metadata');
  const tags = metadata?.['tags'];
  if (!Array.isArray(tags)) return undefined;

  // L-1: rank by the vendor's OWN `ordinal` within each kind, instead of by array position. The
  // docstring above argues that tag order "is its business, not ours" — which is precisely why the
  // rank it publishes is the field to read rather than the order it happens to serialize in. Every
  // recorded row carries one (observed: 10 on a curated display label, 0 on an OLI-sourced
  // secondary); rows without one get -1 and therefore sort last, so a missing rank can never
  // outrank a stated one. Reordering the fixture's tags used to flip a holder's label from
  // "Binance: Hot Wallet 34" to "StrategyExecutor".
  //
  // L-12: reads the tag directly rather than wrapping each one in a throwaway `{t: tag}` object to
  // reuse `readObject` — that allocated one object per tag, ~200 per holders response.
  const candidates: { name: string; named: boolean; ordinal: number }[] = [];
  for (const tag of tags) {
    if (tag === null || typeof tag !== 'object') continue;
    const row = tag as Record<string, unknown>;
    const name = row['name'];
    if (typeof name !== 'string' || name.length === 0) continue;
    const ordinal = row['ordinal'];
    candidates.push({
      name,
      named: row['tagType'] === 'name',
      ordinal: typeof ordinal === 'number' && Number.isFinite(ordinal) ? ordinal : -1,
    });
  }
  // A display label still beats a protocol tag regardless of rank (m-9); rank only breaks ties
  // within a kind.
  candidates.sort((a, b) => Number(b.named) - Number(a.named) || b.ordinal - a.ordinal);
  const chosen = candidates[0];
  return chosen === undefined ? undefined : truncateVendorText(chosen.name, MAX_VENDOR_NAME_LENGTH);
}

/**
 * B-2 (adversarial cycle 1): returns an ARRAY, like `nansen.normalizeEntityLabels` does.
 *
 * This used to return a bare object. `EntityLabelOutputSchema.entities` is
 * `z.array(EntityLabelSchema)`, so the tool could never render it — but `normalize()` SUCCEEDED,
 * which is what made it dangerous: `CapabilityRegistry.resolve` takes the happy path on success,
 * writes the unusable shape into the POSITIVE cache under `ttlFor('entity.labels') = 3600`, and
 * never falls through to Nansen (fallback happens only on a throw). So the defect would have
 * turned into a one-hour outage per address the moment B-1 was fixed — which is why both are
 * fixed in the same commit.
 *
 * **H-1 (vdd-multi TASK-008): an empty tag set stays a truthful answer — the ROUTE decides what to
 * do about it.**
 *
 * The defect was real: returning `{tags: [], labels: []}` is structurally valid, so `normalize()`
 * returns, so `CapabilityRegistry.resolve` used to take the happy path — positive cache under
 * `ttlFor('entity.labels') = 3600`, return — and Nansen, the only provider before this commit and
 * the holder of the CEX/fund attributions, was never reached. That is verbatim UC-2's named failure
 * («Blockscout отвечает «нет меток» и цепочка на этом останавливается, хотя Nansen ответил бы»),
 * and it is the ORDINARY case: the recorded `get_address_info` probe is USDC with empty tags, and
 * 40 of 50 rows in the holders fixture carry `metadata: null`.
 *
 * The fix does NOT live here. Making this function throw would work, and was tried first, but it
 * writes knowledge of the successor into the provider: `blockscout` would report a failure it does
 * not have, and would keep reporting it when deployed with nothing behind it. Providers have to be
 * able to move independently — a provider whose correctness depends on who is standing behind it
 * cannot be.
 *
 * So this returns what Blockscout actually said, and `CapabilityRoute.isSatisfying` on the
 * `entity.labels` route carries the cross-provider policy ("an empty label set does not answer the
 * question — keep walking"). Same seam the aggregating router will use later.
 *
 * Contrast `normalizeHolders`, which DOES throw on an unusable body — because there the claim is
 * about the response ("we could not read what the vendor sent"), not about the route.
 */
function normalizeLabels(result: LabelsFetchResult, fetchedAt: number): EntityLabel[] {
  const tags = extractTags(result.body, ['data', 'metadata', 'tags']);
  // L-1: rank by the vendor's own `ordinal`, highest first, instead of by array position — see
  // `readRowLabel` for the full reasoning. `tagType: 'name'` is the display label; everything else
  // (observed: `protocol`) is a tag.
  const byOrdinal = (a: { ordinal: number }, b: { ordinal: number }): number =>
    b.ordinal - a.ordinal;
  const named = tags.filter((tag) => tag.tagType === 'name').sort(byOrdinal);
  const others = tags.filter((tag) => tag.tagType !== 'name').sort(byOrdinal);

  return [
    EntityLabelSchema.parse({
      chain: result.chain,
      address: result.address,
      ...(named[0] === undefined ? {} : { name: named[0].name }),
      // L-2: sliced to the schema cap, not thrown at it — see `MAX_LABEL_TAGS`.
      tags: others.slice(0, MAX_LABEL_TAGS).map((tag) => tag.name),
      labels: named.slice(0, MAX_LABEL_TAGS).map((tag) => tag.name),
      // Blockscout has no paid escalation tier — this flag exists for Nansen's `exhaustive: true`
      // path and is structurally false here, never merely defaulted.
      premiumRequested: false,
      source: 'blockscout',
      fetchedAt,
    }),
  ];
}
