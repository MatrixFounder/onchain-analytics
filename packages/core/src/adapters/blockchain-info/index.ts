import {
  bitcoinEmissionSat,
  bitcoinSubsidyAtHeightSat,
  BITCOIN_DECIMALS,
  SATOSHI_PER_BTC,
} from '../../chain/bitcoin-emission.js';
import type { ChainInfo, ChainRegistry } from '../../chain/registry-core.js';
import { loadChainRegistry } from '../../chain/registry.js';
import { throttle as productionThrottle, type Throttle } from '../../net/rate-limit.js';
import { isPassThroughTransportError, safeFetch } from '../../net/safe-fetch.js';
import { adapterRegistrations } from '../../providers.config.js';
import { ChainSupplySchema, type ChainSupply } from '../../types/chain-supply.js';
import type { ProviderAdapter } from '../types.js';

/**
 * `blockchain-info` adapter (TASK-009, R-81…R-85) — free BTC supply for `chain.supply`.
 *
 * **What it serves and why two calls.** The vendor exposes two supply surfaces that a live keyless
 * probe (2026-07-29, evidence pinned in `docs/provenance.json`) proved are **different quantities**,
 * by a test that admits no interpretation — how many WHOLE block subsidies fit between the value and
 * the halving boundary at block 840 000:
 *
 * | surface          | subsidies past the boundary | therefore                              |
 * | ---------------- | --------------------------- | -------------------------------------- |
 * | `/stats.totalbc` | `120102` — integer          | the halving formula ⇒ EMISSION         |
 * | `/q/totalbc`     | `120092.8` — fractional     | cannot be the formula ⇒ CIRCULATING    |
 *
 * A stale copy of the formula would sit at an INTEGER offset; a fractional one cannot be a copy at
 * all. The gap (28.75–31.88 BTC, ~0.00016%) is coinbase subsidy miners never claimed. The task text
 * this adapter came from prescribed `/q/*` "for emission" — that would have served one quantity
 * under the other's name at an error no reader could see, which is why both are fetched and named.
 *
 * **Keyless, and not by grace.** Unlike `blockscout`, there is no key to hold: the vendor offers
 * none for these surfaces. So this adapter has no secret handling at all, and none should be added
 * without a measurement showing the vendor started requiring one.
 *
 * @module
 */

/** CAIP-2 of the one chain this vendor serves. Bitcoin's registry row, matched exactly. */
const BITCOIN_CAIP2 = 'other:bitcoin';

const CAPABILITY = 'chain.supply';

/**
 * Ceiling for a response body. `/stats` measured 572 B and `/q/totalbc` 16 B, so `safeFetch`'s
 * 10 MB default is not a cap here but a formality — the same H-3 lesson `blockscout` recorded.
 * 64 KB is ~100x the largest observed body and still far below "a GC pause per call".
 */
const MAX_RESPONSE_BYTES = 64 * 1024;

/**
 * Explicit per-request timeout instead of `safeFetch`'s 15 s default. Two sequential requests make
 * up one `fetch()`, so the default would have put 30 s of worst case behind a single-threaded stdio
 * server for a value that changes once per ten minutes.
 */
const REQUEST_TIMEOUT_MS = 5_000;

/** A plain-text integer body, and nothing else. Bounded so a runaway body cannot be a bignum bomb. */
const PLAIN_INTEGER_RE = /^(0|[1-9][0-9]{0,31})$/;

/**
 * M-8 (the lesson `blockscout` paid for): looked up, never asserted at module scope. A `throw` here
 * would fire during `import '@onchain-intel/core'` — before `main()` — so deleting the config entry
 * to disable the provider would take the whole MCP server down with it. "Degrade honestly" cannot
 * mean "refuse to boot".
 */
const REGISTRATION = adapterRegistrations.find((entry) => entry.id === 'blockchain-info');
const RATE_LIMIT = REGISTRATION?.rateLimit;
const ALLOWLIST = REGISTRATION ? [...REGISTRATION.hosts] : [];

const BASE = 'https://blockchain.info';

/**
 * "Can I serve this chain?" — exactly one, matched on CAIP-2.
 *
 * Keyed on the canonical id rather than on the slug or the display name for the reason TASK-008
 * recorded on `blockscout`: a vendor-facing or human-facing name is a string that can drift, while
 * `caip2` is the registry's own primary key. The `capability` argument is ignored — this adapter has
 * one capability, so coverage cannot vary by it.
 */
export function servesChain(chain: ChainInfo): boolean {
  return chain.caip2 === BITCOIN_CAIP2;
}

export interface BlockchainInfoAdapterDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
  chains?: ChainRegistry;
  /** Injectable throttle, the same seam `nansen`/`blockscout` expose, so tests need no real waits. */
  throttle?: Throttle;
}

/** What `fetch()` hands to `normalize()` — deliberately the two raw readings and nothing else. */
interface SupplyFetchResult {
  chain: string;
  symbol: string;
  /** `/stats` — the whole document; only numeric fields are ever read from it. */
  stats: Record<string, unknown>;
  /** `/q/totalbc` — the raw plain-text body, unparsed. */
  circulatingBody: string;
}

/** `https://host/...` → `host`, so error text never carries a full URL. */
function hostOf(url: string): string {
  return new URL(url).hostname;
}

/**
 * Describes a value instead of quoting it.
 *
 * The R-68e error-path discipline: a `normalize()` throw becomes `tried[].reason`, then the tool's
 * `isError` text, then model context — and it is negative-cached, so it replays for the whole
 * negative TTL with no further network traffic. A number cannot carry instructions and is printed;
 * anything else is described by shape and length.
 */
function describe(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'string') return `string(length=${value.length})`;
  if (Array.isArray(value)) return `array(length=${value.length})`;
  if (value === null) return 'null';
  return typeof value;
}

export function createBlockchainInfoAdapter(deps: BlockchainInfoAdapterDeps = {}): ProviderAdapter {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;
  const chains = deps.chains ?? loadChainRegistry();
  const throttle = deps.throttle ?? productionThrottle;

  // Disabled-by-config shape (M-8). Every entry point declines with the same reason: the registry
  // records it in `tried[]` and walks on, `onchain_list_chains` stops advertising the capability
  // because `chainSupport` is false everywhere, and the process boots.
  //
  // `costOf` returns Infinity rather than 0 — FAIL-CLOSED. "This provider is switched off" must not
  // read as "this provider is free", which is what a 0 would say to any future budget gate.
  if (REGISTRATION === undefined || RATE_LIMIT === undefined) {
    const reason =
      'blockchain-info: disabled — no entry in adapterRegistrations (providers.config.ts)';
    return {
      id: 'blockchain-info',
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

  async function request(path: string, deadlineAtMs?: number): Promise<Response> {
    const url = new URL(path, BASE);
    // The limiter first, then the transport (WI-37) — refusing a wait already known to be longer
    // than the time left is free, discovering it afterwards costs the whole wait.
    await throttle('blockchain-info', rateLimit, 1, deadlineAtMs);

    let response: Response;
    try {
      response = await safeFetch(url.toString(), { method: 'GET' }, ALLOWLIST, fetchImpl, {
        timeoutMs: REQUEST_TIMEOUT_MS,
        maxResponseBytes: MAX_RESPONSE_BYTES,
        // ADDITIVE to `timeoutMs`, never a replacement: the hop timeout says "this vendor did not
        // answer", the deadline says "we ran out of our own time", and `safeFetch` keeps them as
        // two signals so the classes stay distinguishable. Spread conditionally so a call with no
        // deadline builds byte-for-byte the options object it built before WI-37.
        ...(deadlineAtMs === undefined ? {} : { deadlineAtMs }),
      });
    } catch (error) {
      // WI-36, same rule as `blockscout`'s catch — and this adapter is why the record called the
      // defect a LATENT second instance rather than one: it carried the identical wrapper while not
      // yet reading the deadline, so the flattening cost nothing and would have started costing on
      // the day it took the parameter up. That day is this commit (WI-37), and the two arrived
      // together on purpose: a fix that waits for its own symptom is a fix that ships after it.
      if (isPassThroughTransportError(error)) throw error;
      // Name the failure CLASS, never the vendor's or the network's message.
      const kind = error instanceof Error ? error.name : 'UnknownError';
      throw new Error(`blockchain-info: transport failure from ${hostOf(BASE)} (${kind})`, {
        cause: error,
      });
    }
    if (!response.ok) {
      void response.body?.cancel().catch(() => undefined);
      throw new Error(`blockchain-info: HTTP ${response.status} from ${hostOf(BASE)}`);
    }
    return response;
  }

  return {
    id: 'blockchain-info',

    capabilities: () => [{ id: CAPABILITY }],

    chainSupport: (chain: ChainInfo) => servesChain(chain),

    /** Keyless and unmetered: the vendor bills nothing and offers no key to bill against. */
    costOf: () => ({ credits: 0 }),

    /**
     * Always available. There is no env precondition to check — stated explicitly rather than
     * omitted, so "no key needed" is a recorded fact instead of an oversight.
     */
    isAvailable: () => ({ ok: true }),

    async fetch(
      cap: string,
      args: Record<string, unknown>,
      /**
       * WI-37. This adapter issues TWO readings per call, so the ceiling is what stops the second
       * from being issued when the first has already spent the budget — the manifest's row records
       * the envelope as twice E-HTTP5 for exactly that reason, and until now nothing cut it.
       */
      deadlineAtMs?: number,
    ): Promise<SupplyFetchResult> {
      if (cap !== CAPABILITY) {
        throw new Error(`blockchain-info: unsupported capability '${cap}'`);
      }
      const requested = args['chain'];
      if (typeof requested !== 'string' || requested.length === 0) {
        throw new Error('blockchain-info: "chain" is required and must be a non-empty string');
      }
      // The coverage gate upstream already refused every other chain; this is the adapter stating
      // its own precondition rather than trusting a caller it does not control. `resolve` throws
      // `UnknownChainError` for a name the registry does not know — the same failure every other
      // adapter surfaces, so it is left to propagate rather than reworded here.
      const info = chains.resolve(requested);
      if (!servesChain(info)) {
        throw new Error(`blockchain-info: serves bitcoin only, not '${info.slug}'`);
      }

      // Two surfaces, two requests, sequential on purpose: they are throttled through one bucket,
      // and issuing them concurrently would only move the wait, not remove it.
      const statsResponse = await request('/stats?format=json', deadlineAtMs);
      const stats: unknown = await statsResponse.json();
      if (stats === null || typeof stats !== 'object' || Array.isArray(stats)) {
        throw new Error(`blockchain-info: /stats returned ${describe(stats)}, expected an object`);
      }

      const circulatingResponse = await request('/q/totalbc', deadlineAtMs);
      const circulatingBody = (await circulatingResponse.text()).trim();

      return {
        chain: info.slug,
        symbol: info.nativeSymbol ?? 'BTC',
        stats: stats as Record<string, unknown>,
        circulatingBody,
      };
    },

    normalize(cap: string, raw: unknown): ChainSupply {
      if (cap !== CAPABILITY) {
        throw new Error(`blockchain-info: unsupported capability '${cap}'`);
      }
      return normalizeSupply(raw as SupplyFetchResult, now());
    },
  };
}

/**
 * Turns the two raw readings into the canonical type — and refuses anything it cannot stand behind.
 *
 * Three checks, each one guarding a failure that would otherwise be invisible:
 *
 * 1. **Strict parsing of the plain-text body.** `/q/totalbc` is `text/plain`, so an error page, an
 *    empty body or a fractional value all arrive looking like data. Only `^\d+$` is accepted.
 * 2. **The consensus cross-check.** `bitcoinEmissionSat(n_blocks_total)` must reproduce `totalbc`.
 *    This pins the SEMANTICS of the block count (a count, not a tip height — off by one is 3.125 BTC
 *    = 0.000016% of supply, invisible to any plausibility check). It is deliberately NOT presented
 *    as proof the vendor is honest: the vendor derives the field the same way we do, so agreement
 *    is close to a tautology. The value a second source can genuinely contradict is the block count,
 *    which is why it is published and why the eval compares it against an unrelated vendor.
 * 3. **`circulating <= emission`.** A consensus invariant, not a heuristic: nobody can claim more
 *    than the subsidy. Violation means one of the two numbers is wrong, and we do not know which —
 *    so the response is refused rather than served, and never quietly reconciled.
 */
export function normalizeSupply(result: SupplyFetchResult, fetchedAt: number): ChainSupply {
  const emissionRaw = requireStatsInteger(result.stats, 'totalbc');
  const blockCount = requireStatsInteger(result.stats, 'n_blocks_total');

  if (!PLAIN_INTEGER_RE.test(result.circulatingBody)) {
    throw new Error(
      `blockchain-info: /q/totalbc did not return a plain integer — got ` +
        `${describe(result.circulatingBody)}`,
    );
  }
  const circulatingRaw = BigInt(result.circulatingBody);

  const expected = bitcoinEmissionSat(blockCount);
  if (expected !== emissionRaw) {
    // Reported in blocks of subsidy, never as a percentage: one block is 0.000016% of supply, so a
    // percentage would render every real disagreement as a rounding artefact. `blockCount` is a
    // count, so the tip it describes is one lower — that is the height whose subsidy applies.
    const subsidy = bitcoinSubsidyAtHeightSat(blockCount === 0n ? 0n : blockCount - 1n);
    const deltaBlocks = subsidy === 0n ? 'n/a' : String((emissionRaw - expected) / subsidy);
    throw new Error(
      `blockchain-info: totalbc disagrees with the halving schedule at block count ${blockCount} ` +
        `by ${deltaBlocks} block subsidy(-ies) — the vendor's own two fields are inconsistent`,
    );
  }

  if (circulatingRaw > emissionRaw) {
    throw new Error(
      'blockchain-info: circulating supply exceeds released emission, which consensus forbids — ' +
        'refusing a response we cannot attribute to either field',
    );
  }

  return ChainSupplySchema.parse({
    chain: result.chain,
    symbol: result.symbol,
    decimals: BITCOIN_DECIMALS,
    emissionRaw: emissionRaw.toString(),
    emissionBtc: toBtc(emissionRaw),
    circulatingRaw: circulatingRaw.toString(),
    circulatingBtc: toBtc(circulatingRaw),
    blockCount: Number(blockCount),
    source: 'blockchain-info',
    fetchedAt,
  });
}

/**
 * Reads one numeric field of `/stats` as an exact `bigint`, or refuses.
 *
 * The vendor sends JSON numbers, so precision is already spent by the time `response.json()`
 * returns — which is why the field must be a SAFE integer to be usable at all. A value past 2^53
 * would have been silently rounded upstream of us, and converting it here would launder that
 * rounding into an exact-looking `bigint`.
 *
 * Only numeric fields of the document are ever read: `/stats` also carries `market_price_usd` and
 * other vendor-authored values that are not part of this contract and must not leak into the output.
 */
function requireStatsInteger(stats: Record<string, unknown>, key: string): bigint {
  const value = stats[key];
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `blockchain-info: /stats.${key} is not a non-negative safe integer — got ${describe(value)}`,
    );
  }
  return BigInt(value);
}

/**
 * Lossy projection into BTC, for charts and comparisons only.
 *
 * Done through integer division plus a remainder rather than `Number(sat) / 1e8`, so the result is
 * built from two values that were exact when they were computed. The exact figure is always the
 * `…Raw` string beside it — this is the convenience field, and it says so in the schema.
 */
function toBtc(sat: bigint): number {
  const whole = sat / SATOSHI_PER_BTC;
  const remainder = sat % SATOSHI_PER_BTC;
  return Number(whole) + Number(remainder) / Number(SATOSHI_PER_BTC);
}
