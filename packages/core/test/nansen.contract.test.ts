import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { CapabilityRegistry, CapabilityUnavailableError } from '../src/adapters/registry.js';
import { NansenPaymentRequiredError } from '../src/adapters/nansen/endpoints.js';
import { createThrottle } from '../src/net/rate-limit.js';
import { SsrfBlockedError } from '../src/net/safe-fetch.js';
import { createNansenAdapter, normalizeAddress, routes } from '../src/index.js';

// Golden fixture-based normalization tests (R-31/R-32/R-33, task 005-4) + HTTP-contract tests
// (R-29). Fixtures under test/fixtures/nansen/ WERE provisional/spec-derived — task 005-7
// (2026-07-24) replaced 6 of them (account.free, search-general, smart-money-netflow, tgm-holders,
// tgm-indicators, tgm-token-information) with GENUINELY RECORDED live responses (single sanctioned
// token: USDC `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`, ethereum — WETH was tried first per the
// task's own token choice, but returned the exact same 0-row `/smart-money/netflow` result, so the
// sanctioned USDC fallback was used for the final recording; 3 fixtures — account.pro,
// search-general.empty, tgm-holders.empty-labels — remain intentionally provisional, out of this
// task's own documented scope: no live Pro subscription / no reproducible-live "0 results" shape).
//
// **Known-expected M-2 override (task 005-7, logged per its own reviewer note — scalar VALUES
// changed to match the real recorded response, never the SHAPE normalize.ts produces):**
// - TC-CONTRACT-01: the LIVE `smart-money/netflow` response for USDC returned ZERO matching rows
//   (`data: []`) on the first THREE independent live attempts (30cr) — traced to TWO real, now
//   FIXED code defects in `postSmartMoneyNetflow` (`endpoints.ts`), not a vendor-coverage gap (see
//   `docs/issues/df-1-nansen-smart-money-netflow-empty-for-base-pair-tokens.md`, `status: fixed`):
//   (#1) `filters.include_stablecoins`/`include_native_tokens` both default to `false`
//   server-side, silently excluding a stablecoin/wrapped-native token even when it's the ONE token
//   the caller named; (#2) `filters.token_address` matches CASE-SENSITIVELY against a
//   lowercase-stored column on this one endpoint (unlike its `/tgm/*` siblings) —
//   `normalizeAddress()`'s EIP-55 checksummed form silently matched nothing. A 4th diagnostic call
//   (5cr, lowercase `token_address`, all other fields unchanged) confirmed #2 and returned this
//   fixture's real, populated row. TC-CONTRACT-01 is restored to a POPULATED-result assertion
//   against that real data — the `toThrow(...)` form is gone entirely, since it was accidentally
//   codifying our own defect as expected behavior (a worse failure mode than a scalar mismatch).
// - TC-CONTRACT-02: `search-general`'s live "wintermute" query (this task's own suggested query)
//   returned ZERO results under the `chain` filter; re-recorded against the exact USDC contract
//   address instead (one precise token match, no entity match) — the stale "Wintermute" entity
//   expectation is removed; the USDC token entry's expected fields are UNCHANGED (same real,
//   well-known token the original spec-derived guess already used).
// - TC-CONTRACT-04: full literal update — real recorded `tgm/indicators` risk/reward indicator
//   values for USDC (different token than the original AAVE-modeled guess; SAME canonical shape:
//   `indicatorType`/`score`/`signal`/`signalPercentile`/`lastTriggerOn`, still two disjoint arrays).
// - TC-UNIT-07: request body now also asserts `include_stablecoins`/`include_native_tokens: true`
//   AND lowercased `token_address` on the `/smart-money/netflow` sub-call (both confirmed, applied
//   bug fixes above; `/tgm/holders`' own `token_address` stays checksummed, unaffected) — a
//   legitimate change to what this test asserts is SENT, not a fixture/response-content override;
//   this describes intentionally corrected production behavior, not a golden-fixture tuning. This
//   IS the "unit assertion that the production code builds exactly this request" DF-1's resolution
//   calls for — it closes the provenance gap on `smart-money-netflow.json` (recorded via a direct
//   diagnostic call, not `record-fixture.mjs` — see that fixture's own evidence file) for free,
//   with zero further live spend: it proves the SAME request shape the fixture's real response was
//   recorded against is what `postSmartMoneyNetflow` genuinely builds today.
// `GOLDEN_TEST_SHA` in docs/tasks/task-005-7-fixtures-live-verification.md's header records the
// PRE-edit baseline (005-4); this file's own post-edit SHA is recorded in this task's own evidence
// file. NO NANSEN_API_KEY in this test's process env — every `createNansenAdapter()` call below is
// given an explicit `env`, never falling back to ambient `process.env`; every network call goes
// through an injected `fetchImpl`, never the real network (0 live credits, this task's own header).

const testDir = path.dirname(fileURLToPath(import.meta.url));
const FIXED_NOW = 1_700_000_000_000;

const UNI_ADDRESS = '0x1f9840a85d5af5bf1d1762f925bdaddc4201f984';
const AAVE_ADDRESS = '0x7fc66500c84a76ad7e9c93437bfc5ac33e2ddae9';
const DUST_HOLDER_ADDRESS = '0x1234567890123456789012345678901234567890';
// The ONE token task 005-7 actually recorded live data against (see this file's header comment).
const USDC_ADDRESS = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';

function loadFixture(name: string): unknown {
  const raw = readFileSync(path.join(testDir, 'fixtures', 'nansen', `${name}.json`), 'utf8');
  return JSON.parse(raw);
}

function endpointResult(
  body: unknown,
  creditsUsedHeader: string | null = null,
): {
  body: unknown;
  creditsUsedHeader: string | null;
} {
  return { body, creditsUsedHeader };
}

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

/** Routes an injected `fetchImpl` by request pathname to a canned `{body, status?, headers?}` —
 * every call is recorded into `calls` (URL, method, lower-cased header names, parsed JSON body)
 * before the canned response is returned. Throws (a clear test-authoring error, not a silent
 * `undefined`) for an unrouted path. */
function makeRoutedFetchImpl(
  routesByPath: Record<
    string,
    { body: unknown; status?: number; headers?: Record<string, string> }
  >,
  calls: RecordedCall[],
): typeof fetch {
  return async (url, init) => {
    const urlStr = String(url);
    const pathname = new URL(urlStr).pathname;
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const body =
      typeof init?.body === 'string' && init.body.length > 0 ? JSON.parse(init.body) : undefined;
    calls.push({ url: urlStr, method: init?.method ?? 'GET', headers, body });

    const route = routesByPath[pathname];
    if (!route) {
      throw new Error(`makeRoutedFetchImpl: unrouted test call to ${pathname}`);
    }
    return new Response(JSON.stringify(route.body), {
      status: route.status ?? 200,
      headers: route.headers,
    });
  };
}

describe('nansen adapter (contract — golden normalization, R-31/R-32/R-33)', () => {
  const adapter = createNansenAdapter({ now: () => FIXED_NOW, env: {} });

  it('TC-CONTRACT-01 (R-31, live-verified 2026-07-24, DF-1 fixed): merges the real live netflow + tgm/holders fixtures into a canonical SmartMoneyFlow', () => {
    const netflowFixture = loadFixture('smart-money-netflow') as { data: { address?: string }[] };
    const holdersFixture = loadFixture('tgm-holders') as {
      data: {
        address: string;
        address_label: string;
        token_amount: number;
        value_usd: number;
        ownership_percentage: number;
      }[];
    };
    const normalizedTokenAddress = normalizeAddress('ethereum', USDC_ADDRESS);

    const raw = {
      chain: 'ethereum' as const,
      // vdd-multi cycle 6 (L-3): the hand-off carries the address FAMILY, so case-folding a
      // vendor address is decided by the encoding rather than by one chain's name.
      family: 'evm' as const,
      tokenAddress: normalizedTokenAddress,
      netflow: endpointResult(netflowFixture, '5'),
      holders: endpointResult(holdersFixture, '5'),
    };

    const result = adapter.normalize('smart-money.flows', raw);

    // Real recorded values (task 005-7, DF-1 root-cause-#2 confirmation, live USDC — see
    // smart-money-netflow.evidence.md for the exact request that produced this response). SAME
    // shape as the original spec-derived guess this fixture replaced.
    expect(result).toEqual({
      chain: 'ethereum',
      tokenAddress: normalizedTokenAddress,
      tokenSymbol: 'USDC',
      netflow1hUsd: 0.0,
      netflow24hUsd: -325939.1223102985,
      netflow7dUsd: -4545283.010605299,
      netflow30dUsd: -10796443.662655927,
      traderCount: 142,
      tokenAgeDays: 2912,
      tokenSectors: ['Stablecoin'],
      topHolders: holdersFixture.data.map((row) => ({
        address: normalizeAddress('ethereum', row.address),
        addressLabel: row.address_label,
        tokenAmount: row.token_amount,
        valueUsd: row.value_usd,
        ownershipPercentage: row.ownership_percentage,
      })),
      source: 'nansen',
      fetchedAt: FIXED_NOW,
    });
  });

  it('TC-CONTRACT-02 (R-32, >=1 label, live-verified 2026-07-24): search/general + tgm/holders -> EntityLabel[] with non-empty labels[]', () => {
    const searchFixture = loadFixture('search-general');
    const holdersFixture = loadFixture('tgm-holders') as {
      data: { address: string; address_label: string }[];
    };

    const raw = {
      chain: 'ethereum' as const,
      // vdd-multi cycle 6 (H-2): the vendor echoes its OWN chain token, so the row filter
      // must compare against that, never against our slug.
      vendorChain: 'ethereum',
      tokenAddress: normalizeAddress('ethereum', USDC_ADDRESS),
      premiumRequested: false,
      search: endpointResult(searchFixture, '0'),
      entityName: endpointResult({ data: [] }, '0'),
      holders: endpointResult(holdersFixture, '5'),
      profilerLabels: undefined,
    };

    const result = adapter.normalize('entity.labels', raw) as Array<Record<string, unknown>>;

    expect(result).toEqual([
      {
        chain: 'ethereum',
        address: normalizeAddress('ethereum', '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48'),
        name: 'USD Coin',
        tags: [],
        labels: [],
        premiumRequested: false,
        source: 'nansen',
        fetchedAt: FIXED_NOW,
      },
      // NOTE (task 005-7, M-2 override): the live "wintermute" query returned ZERO entity matches
      // (search-general.json's own `entities: []`) — the spec-derived "Wintermute" entity entry is
      // REMOVED here, not replaced; there is no live substitute (see this file's own header
      // comment). `entities[]` being empty is itself a valid result (R-32), never an error.
      ...holdersFixture.data.map((row) => ({
        chain: 'ethereum',
        address: normalizeAddress('ethereum', row.address),
        tags: [],
        labels: [row.address_label],
        premiumRequested: false,
        source: 'nansen',
        fetchedAt: FIXED_NOW,
      })),
    ]);
    expect(result.some((entry) => (entry['labels'] as unknown[]).length > 0)).toBe(true);
    for (const entry of result) {
      expect(entry['premiumRequested']).toBe(false);
    }
  });

  it('TC-CONTRACT-03 (R-32, 0 labels): search/general.empty + tgm/holders.empty-labels -> valid result, not throw', () => {
    const searchEmptyFixture = loadFixture('search-general.empty');
    const holdersEmptyFixture = loadFixture('tgm-holders.empty-labels');

    const raw = {
      chain: 'ethereum' as const,
      // vdd-multi cycle 6 (H-2): the vendor echoes its OWN chain token, so the row filter
      // must compare against that, never against our slug.
      vendorChain: 'ethereum',
      tokenAddress: normalizeAddress('ethereum', DUST_HOLDER_ADDRESS),
      premiumRequested: false,
      search: endpointResult(searchEmptyFixture, '0'),
      entityName: endpointResult({ data: [] }, '0'),
      holders: endpointResult(holdersEmptyFixture, '5'),
      profilerLabels: undefined,
    };

    let result: unknown;
    expect(() => {
      result = adapter.normalize('entity.labels', raw);
    }).not.toThrow();

    expect(result).toEqual([
      {
        chain: 'ethereum',
        address: normalizeAddress('ethereum', DUST_HOLDER_ADDRESS),
        tags: [],
        labels: [],
        premiumRequested: false,
        source: 'nansen',
        fetchedAt: FIXED_NOW,
      },
    ]);
  });

  it('TC-CONTRACT-04 (R-33, live-verified 2026-07-24): tgm/indicators + tgm/token-information -> TokenRiskScore, separate arrays, numbers as number', () => {
    const indicatorsFixture = loadFixture('tgm-indicators');
    const tokenInformationFixture = loadFixture('tgm-token-information');
    const normalizedAddress = normalizeAddress('ethereum', USDC_ADDRESS);

    const raw = {
      chain: 'ethereum' as const,
      address: normalizedAddress,
      indicators: endpointResult(indicatorsFixture, '5'),
      tokenInformation: endpointResult(tokenInformationFixture, '1'),
    };

    const result = adapter.normalize('token.risk', raw) as {
      riskIndicators: Array<{ signal?: number; signalPercentile?: number }>;
      rewardIndicators: Array<{ signal?: number; signalPercentile?: number }>;
    };

    // Real recorded values (task 005-7, live USDC — M-2 scalar override, see this file's own
    // header comment; SAME shape as the original spec-derived guess: indicatorType/score/signal/
    // signalPercentile/lastTriggerOn, two disjoint arrays).
    //
    // **Assertion widened 2026-07-25 (issue Q-4) — logged, not silent.** The eight metadata fields
    // below come from `/tgm/token-information`, the sub-call this capability has always PAID 1cr
    // for and never read. Every value here is read straight from the already-recorded fixture, so
    // this costs zero further credits — it asserts data we had bought and were discarding.
    expect(result).toEqual({
      chain: 'ethereum',
      address: normalizedAddress,
      marketCapUsd: 72_947_689_222,
      marketCapGroup: 'largecap',
      isStablecoin: true,
      // --- from /tgm/token-information (Q-4) ---
      name: 'USD Coin',
      symbol: 'USDC',
      deploymentDate: '2018-08-03 19:28:24',
      fdvUsd: 72_949_375_871,
      circulatingSupply: 72_993_578_820.9766,
      totalSupply: 72_995_577_672.29245,
      liquidityUsd: 536_369_088.28717536,
      totalHolders: 3_105_691,
      riskIndicators: [
        {
          indicatorType: 'btc-reflexivity',
          score: 'low',
          signal: 0.01,
          signalPercentile: 21.47147147147147,
          lastTriggerOn: '2026-04-12',
        },
        {
          indicatorType: 'token-supply-inflation',
          score: 'low',
          signal: -0.03703940569184633,
          signalPercentile: 16.22641509433962,
          lastTriggerOn: '2026-07-23',
        },
      ],
      rewardIndicators: [
        {
          indicatorType: 'funding-rate',
          score: 'bullish',
          signal: 1,
          signalPercentile: 5,
          lastTriggerOn: '2026-07-23',
        },
        {
          indicatorType: 'trading-range',
          score: 'bullish',
          signal: 0,
          signalPercentile: 0,
          lastTriggerOn: '2026-07-20',
        },
      ],
      source: 'nansen',
      fetchedAt: FIXED_NOW,
    });
    // riskIndicators/rewardIndicators are SEPARATE arrays (R-33 "not flattened").
    expect(result.riskIndicators).not.toEqual(result.rewardIndicators);
    for (const indicator of [...result.riskIndicators, ...result.rewardIndicators]) {
      expect(typeof indicator.signal).toBe('number');
      expect(typeof indicator.signalPercentile).toBe('number');
    }
  });

  describe('TC-CONTRACT-05: malformed/truncated response -> clear normalization error, never a crash', () => {
    it('smart-money.flows: netflow.data is not an array', () => {
      const raw = {
        chain: 'ethereum' as const,
        // vdd-multi cycle 6 (L-3): the hand-off carries the address FAMILY, so case-folding a
        // vendor address is decided by the encoding rather than by one chain's name.
        family: 'evm' as const,
        tokenAddress: normalizeAddress('ethereum', UNI_ADDRESS),
        netflow: endpointResult({ data: 'not-an-array' }),
        holders: endpointResult({ data: [] }),
      };
      expect(() => adapter.normalize('smart-money.flows', raw)).toThrow(
        /smart-money\/netflow response has no matching row/,
      );
    });

    it('token.risk: risk_indicators missing entirely', () => {
      const raw = {
        chain: 'ethereum' as const,
        address: normalizeAddress('ethereum', AAVE_ADDRESS),
        indicators: endpointResult({ token_info: {}, reward_indicators: [] }),
        tokenInformation: endpointResult({}),
      };
      expect(() => adapter.normalize('token.risk', raw)).toThrow(
        /malformed tgm\/indicators response/,
      );
    });

    it('entity.labels exhaustive: profiler/address/labels response missing "data"', () => {
      const raw = {
        chain: 'ethereum' as const,
        // vdd-multi cycle 6 (H-2): the vendor echoes its OWN chain token, so the row filter
        // must compare against that, never against our slug.
        vendorChain: 'ethereum',
        tokenAddress: normalizeAddress('ethereum', AAVE_ADDRESS),
        premiumRequested: true,
        search: undefined,
        entityName: undefined,
        holders: undefined,
        profilerLabels: endpointResult({ notData: [] }),
      };
      expect(() => adapter.normalize('entity.labels', raw)).toThrow(
        /malformed profiler\/address\/labels response/,
      );
    });
  });
});

describe('nansen adapter (contract — HTTP contract, R-29)', () => {
  const netflowFixture = loadFixture('smart-money-netflow');
  const holdersFixture = loadFixture('tgm-holders');

  function smartMoneyFlowsAdapter(fetchImpl: typeof fetch): ReturnType<typeof createNansenAdapter> {
    return createNansenAdapter({
      env: { NANSEN_API_KEY: 'live-key-not-real' },
      fetchImpl,
      now: () => FIXED_NOW,
      throttle: createThrottle(), // fresh, full-capacity bucket per test — no real-timer waits
      // M-6 (adversarial review cycle 1): the ungated (no budgetStore) HTTP-contract-test escape
      // hatch now requires this EXPLICIT opt-in — `fetchImpl` presence alone is no longer read as
      // consent (`adapters/nansen/index.ts`'s own `NansenAdapterDeps` docstring explains why).
      __ungatedForTestsOnly: true,
    });
  }

  it('TC-UNIT-06: outgoing request headers carry apiKey, never authorization', async () => {
    const calls: RecordedCall[] = [];
    const fetchImpl = makeRoutedFetchImpl(
      {
        '/api/v1/smart-money/netflow': { body: netflowFixture },
        '/api/v1/tgm/holders': { body: holdersFixture },
      },
      calls,
    );
    const adapter = smartMoneyFlowsAdapter(fetchImpl);

    await adapter.fetch('smart-money.flows', { chain: 'ethereum', tokenAddress: UNI_ADDRESS });

    expect(calls).toHaveLength(2);
    for (const call of calls) {
      // `Headers` lower-cases names on iteration — the literal `apiKey` name still round-trips
      // through `.get('apiKey')` (case-insensitive), asserted here via the lower-cased key.
      expect(call.headers['apikey']).toBe('live-key-not-real');
      expect(call.headers).not.toHaveProperty('authorization');
    }
  });

  it('TC-UNIT-07: method POST, content-type application/json, body is valid JSON with expected fields', async () => {
    const calls: RecordedCall[] = [];
    const fetchImpl = makeRoutedFetchImpl(
      {
        '/api/v1/smart-money/netflow': { body: netflowFixture },
        '/api/v1/tgm/holders': { body: holdersFixture },
      },
      calls,
    );
    const adapter = smartMoneyFlowsAdapter(fetchImpl);
    const normalizedAddress = normalizeAddress('ethereum', UNI_ADDRESS);

    await adapter.fetch('smart-money.flows', { chain: 'ethereum', tokenAddress: UNI_ADDRESS });

    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.headers['content-type']).toBe('application/json');
    // This IS "the unit assertion that postSmartMoneyNetflow constructs exactly the request body"
    // DF-1's resolution calls for — every field asserted below matches the confirmed, live-proven
    // fix, both root causes (task 005-7, DF-1, `status: fixed`):
    // - `include_stablecoins`/`include_native_tokens: true` (root cause #1): both default to
    //   `false` server-side (`SmartMoneyNetflowFilters`), so a token-scoped query naming a
    //   stablecoin/wrapped-native token was being silently dropped without them.
    // - `token_address` sent LOWERCASE, not the EIP-55 checksummed `normalizedAddress` (root cause
    //   #2): this endpoint's `token_address` filter matches case-sensitively against a
    //   lowercase-stored column — proven live 2026-07-24 (identical request, only casing differed:
    //   checksummed -> 0 rows, lowercase -> 1 real row). The canonical checksummed form is still
    //   what this package stores/returns/cache-keys on — see `postSmartMoneyNetflow`'s own
    //   docstring in endpoints.ts for the full live proof.
    // `/tgm/holders` (calls[1], below) is UNAFFECTED — it accepts the checksummed form fine, so its
    // own `token_address` stays as `normalizedAddress`, unchanged.
    expect(calls[0]!.body).toEqual({
      chains: ['ethereum'],
      filters: {
        token_address: normalizedAddress.toLowerCase(),
        include_stablecoins: true,
        include_native_tokens: true,
      },
    });
    expect(calls[1]!.method).toBe('POST');
    expect(calls[1]!.headers['content-type']).toBe('application/json');
    expect(calls[1]!.body).toEqual({ chain: 'ethereum', token_address: normalizedAddress });
  });

  // vdd-multi cycle 4, logic L-1 — the DF-1 fix was live-verified on EVM only and applied to every
  // chain. Solana addresses are base58, which is CASE-SENSITIVE as an encoding (`chain/address.ts`'s
  // `normalizeSolanaAddress()` returns its input unchanged for exactly that reason), so the blanket
  // fold corrupted the mint rather than re-casing it — recreating the DF-1 tarpit (empty `data: []`
  // -> post-payment normalize throw -> nothing cached -> 10cr per retry) on the one advertised chain
  // nobody probed live.
  it('does NOT case-fold a Solana token address — base58 is case-sensitive (cycle-4 L-1)', async () => {
    const calls: RecordedCall[] = [];
    const fetchImpl = makeRoutedFetchImpl(
      {
        '/api/v1/smart-money/netflow': { body: netflowFixture },
        '/api/v1/tgm/holders': { body: holdersFixture },
      },
      calls,
    );
    const adapter = smartMoneyFlowsAdapter(fetchImpl);
    // Wrapped SOL. The mixed case IS the address; lowercasing it yields a different (invalid) key.
    const SOL_MINT = 'So11111111111111111111111111111111111111112';

    // The fixtures echo an ETHEREUM address, so normalize() finds no matching row and rejects —
    // irrelevant here: this asserts the REQUEST shape, which is what the fix got wrong.
    await adapter
      .fetch('smart-money.flows', { chain: 'solana', tokenAddress: SOL_MINT })
      .catch(() => undefined);

    expect(calls[0]!.body).toEqual({
      chains: ['solana'],
      filters: {
        token_address: SOL_MINT, // verbatim — NOT `.toLowerCase()`
        include_stablecoins: true,
        include_native_tokens: true,
      },
    });
    // Guard the regression precisely: the EVM fold must still be in force on its own chain.
    expect(calls[0]!.body).not.toEqual(
      expect.objectContaining({
        filters: expect.objectContaining({ token_address: SOL_MINT.toLowerCase() }),
      }),
    );
  });

  it('TC-UNIT-08 (SSRF): a redirect to a host outside the api.nansen.ai allowlist is rejected before following it', async () => {
    let callCount = 0;
    const fetchImpl: typeof fetch = async () => {
      callCount += 1;
      return new Response(null, {
        status: 302,
        headers: { location: 'https://evil.example.com/steal' },
      });
    };
    const adapter = smartMoneyFlowsAdapter(fetchImpl);

    await expect(
      adapter.fetch('smart-money.flows', { chain: 'ethereum', tokenAddress: UNI_ADDRESS }),
    ).rejects.toBeInstanceOf(SsrfBlockedError);
    // The malicious redirect hop is never actually followed — only the first (allowed) hop hit the
    // injected transport.
    expect(callCount).toBe(1);
  });

  it('TC-UNIT-09 (429): explicit "retry after" error, exactly one network call, no silent retry', async () => {
    let callCount = 0;
    const fetchImpl: typeof fetch = async () => {
      callCount += 1;
      return new Response(null, { status: 429, headers: { 'retry-after': '30' } });
    };
    const adapter = smartMoneyFlowsAdapter(fetchImpl);

    await expect(
      adapter.fetch('smart-money.flows', { chain: 'ethereum', tokenAddress: UNI_ADDRESS }),
    ).rejects.toThrow(/retry after 30/);
    expect(callCount).toBe(1);
  });

  it('TC-UNIT-10 (402): typed NansenPaymentRequiredError', async () => {
    const fetchImpl: typeof fetch = async () => new Response(null, { status: 402 });
    const adapter = smartMoneyFlowsAdapter(fetchImpl);

    await expect(
      adapter.fetch('smart-money.flows', { chain: 'ethereum', tokenAddress: UNI_ADDRESS }),
    ).rejects.toBeInstanceOf(NansenPaymentRequiredError);
  });

  it('TC-UNIT-11 (partial failure): first sub-call OK, second throws -> fetch() rejects entirely, no partial result', async () => {
    let callCount = 0;
    const fetchImpl: typeof fetch = async () => {
      callCount += 1;
      if (callCount === 1) {
        return new Response(JSON.stringify(netflowFixture), { status: 200 });
      }
      return new Response('server error', { status: 500 });
    };
    const adapter = smartMoneyFlowsAdapter(fetchImpl);

    await expect(
      adapter.fetch('smart-money.flows', { chain: 'ethereum', tokenAddress: UNI_ADDRESS }),
    ).rejects.toThrow(/HTTP 500/);
    expect(callCount).toBe(2);
  });

  it('TC-UNIT-12 (R-29, isAvailable): without NANSEN_API_KEY, CapabilityRegistry never reaches fetch() — zero network calls', async () => {
    const fetchSpy = vi.fn();
    const adapter = createNansenAdapter({ env: {}, fetchImpl: fetchSpy, now: () => FIXED_NOW });

    expect(adapter.isAvailable?.()).toEqual({ ok: false, reason: 'needs NANSEN_API_KEY' });

    const registry = new CapabilityRegistry(routes, new Map([['nansen', adapter]]));
    await expect(
      registry.resolve('smart-money.flows', 'ethereum', {
        chain: 'ethereum',
        tokenAddress: UNI_ADDRESS,
      }),
    ).rejects.toBeInstanceOf(CapabilityUnavailableError);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
