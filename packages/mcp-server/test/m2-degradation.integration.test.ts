import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  CapabilityRegistry,
  createBlockscoutAdapter,
  createBudgetStore,
  createCacheStore,
  createCoingeckoAdapter,
  createDefillamaAdapter,
  createDexscreenerAdapter,
  createNansenAdapter,
  createRpcEvmAdapter,
  dayBucketMs,
  routes,
  TokenSchema,
  WalletSchema,
  type BudgetStore,
  type ProviderAdapter,
} from '@onchain-intel/core';
import { loadEnv } from '../src/env.js';
import { createServer } from '../src/server.js';
import { PingOutputSchema } from '../src/tools/ping.js';
import { ActivePairsOutputSchema } from '../src/tools/active-pairs.js';
import { ProtocolTvlOutputSchema } from '../src/tools/protocol-tvl.js';

/**
 * Task 005-8 — [R-40] explicit M2 degradation + M1 non-regression, BOTH paths, IN ONE SESSION.
 *
 * This is a DEDICATED, standalone file (task's own "Новые" scope — the only new file this task
 * adds) — deliberately separate from `test/e2e.inprocess.test.ts`'s own M2-degradation coverage
 * (its "no NANSEN_API_KEY" describe block at the bottom of that file, task 005-6): that block
 * proves the missing-key path against exactly ONE M1 tool (`onchain_get_token`) and never exercises
 * the budget-exhausted path at all. THIS file is what task 005-8 / the plan review (M-1b) actually
 * requires: BOTH degradation scenarios, each proven against ALL FIVE M1 paths (`onchain_ping` + the
 * 4 M1 tools) in the very same session/server/client — not just "the suite is green".
 *
 * **Two scenarios, both mandatory (task's own Reviewer-заметки):**
 * 1. **TC-INT-01 — no key at all.** `nansen` constructed with `env: {}` — `isAvailable()` reports
 *    `{ok:false}`, so `CapabilityRegistry.resolve()` never even reaches `fetch()` (proven by the
 *    fixture `fetchImpl` below unconditionally throwing if it's ever invoked).
 * 2. **TC-INT-02 (M-1b) — key present, budget exhausted.** This is NOT a duplicate of (1): it goes
 *    through the budget GATE (`nansen.fetch()`'s own `ensureBudget()`), not `isAvailable()`. `usage`
 *    is pre-filled to the ceiling via a DIRECT `budgetStore.recordDelta()` write (reviewer note (c))
 *    — never inferred from a live remote balance.
 *
 * **Reinterpretation of ROADMAP §M2's "деградация на free-провайдера"
 * (`docs/tasks/task-005-m2-alpha-paid.md` §4, documented, not
 * a silent divergence):** ROADMAP's literal text implies a registry-level fallback to a different,
 * free adapter (M1's `dash-platform` ⇄ `platform-explorer` hot-swap, R-11). None of the three M2
 * capabilities (`smart-money.flows`/`entity.labels`/`token.risk`) has a free equivalent with the
 * same data semantics — a silent substitution with semantically different free data would be worse
 * than a loud, explicit error. "Degradation" here means: an explicit `isError` when the key is
 * absent OR the budget is exhausted, while the rest of the engine (`onchain_ping` + 4 M1 tools)
 * keeps working unchanged — the same R-24 pattern M1 already established, not a registry hot-swap.
 *
 * **Ambient-key isolation (M-1 review — critical in this file specifically):** the developer's real
 * `.env` carries a LIVE `NANSEN_API_KEY` (post task 005-7), and `pnpm test` inherits `process.env`.
 * This file NEVER reads that ambient key off `process.env` directly and NEVER calls the bare
 * `loadEnv()` (which would call `process.loadEnvFile()` and pull the real `.env` into
 * `process.env`) — every adapter
 * below is constructed with an EXPLICIT, literal `env` object (`{}` for TC-INT-01, a fixture
 * `'test-key-not-real'` string for TC-INT-02), and `connectLinked()` always calls `loadEnv({})`
 * (explicit empty object — `createServer`'s own `env` param isn't read by any tool anyway, see
 * `server.ts`'s docstring; this is purely to satisfy its type signature the same inert way
 * `e2e.inprocess.test.ts` already does). The acceptance-level machine gate for this is the
 * repo's ambient-key grep across every package's test directory (task acceptance) — expected empty.
 *
 * **TC-INT-02's "0 network calls" — what that concretely means here, stated explicitly rather than
 * silently:** the adapter's `NansenAccountState` is private, constructed fresh per adapter instance
 * — there is no way to inject an already-reconciled snapshot from outside (unlike
 * `nansen.budget-gate.test.ts`'s own lower-level gate-only tests, which construct the gate directly
 * and CAN pre-seed `accountState.set(...)`, skipping resync entirely). So the FIRST of the three
 * refused M2 calls necessarily makes exactly ONE resync call to `/api/v1/account` (free — the
 * budget-gate's own documented "free in credits, not in rate-limit slot" GET) before the gate
 * refuses; the fixture `fetchImpl` below asserts that pathname is the ONLY one ever reached by
 * throwing loudly for any other path. Because a refusal thrown from `ensureBudget()` never marks
 * `accountState` unreconciled (it throws before `fetch()`'s own try/catch that does so —
 * `adapters/nansen/index.ts`), the 2nd and 3rd refused calls make ZERO further network calls of any
 * kind — this is asserted directly below. "0 network calls" in the task's own Test Cases table reads
 * as "0 calls to any PAID Nansen data endpoint" under this necessary cold-start constraint — the
 * same interpretation `e2e.inprocess.test.ts`'s own TC-E2E-07 (cap-refusal) test already uses (a
 * warm-up call first, then asserting zero further calls for the refused call itself).
 */

const CONNECT_TIMEOUT_MS = 10_000;
const CALL_TIMEOUT_MS = 10_000;

const packageRoot = path.resolve(fileURLToPath(import.meta.url), '..', '..');
const coreFixturesRoot = path.resolve(packageRoot, '..', 'core', 'test', 'fixtures');

/** Reads `packages/core/test/fixtures/<adapter>/<name>.json` and returns its `raw` field — same
 * helper as `e2e.inprocess.test.ts` (duplicated here deliberately: this task's own scope adds
 * exactly one new file, not a shared test-utils module). */
function loadFixtureRaw(adapter: string, name: string): unknown {
  const envelope = JSON.parse(
    readFileSync(path.join(coreFixturesRoot, adapter, `${name}.json`), 'utf8'),
  ) as { raw: unknown };
  return envelope.raw;
}

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

type FetchUrlInput = Parameters<typeof fetch>[0];

function urlOf(input: FetchUrlInput): string {
  return typeof input === 'string' ? input : input.toString();
}

const ETH_ADDRESS = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';

// M1 fixture adapters (ethereum-only — this file's own point is session composition across BOTH
// degradation scenarios, not re-proving multi-chain coverage, which the M1/M2 suites already own).
const coingeckoFixtureFetch = async (input: FetchUrlInput): Promise<Response> => {
  const url = urlOf(input);
  if (url.includes('/coins/ethereum/'))
    return jsonResponse(loadFixtureRaw('coingecko', 'ethereum'));
  throw new Error(`fixture fetchImpl: no coingecko route for ${url}`);
};

const dexscreenerFixtureFetch = async (input: FetchUrlInput): Promise<Response> => {
  const url = urlOf(input);
  if (url.includes('q=ETH')) return jsonResponse(loadFixtureRaw('dexscreener', 'ethereum'));
  throw new Error(`fixture fetchImpl: no dexscreener route for ${url}`);
};

const defillamaFixtureFetch = async (input: FetchUrlInput): Promise<Response> => {
  const url = urlOf(input);
  // L-7: one shared catalog, and it is the whole recorded vendor body (no `raw` envelope).
  if (url.endsWith('/protocols'))
    return jsonResponse(
      JSON.parse(
        readFileSync(path.join(coreFixturesRoot, 'defillama', 'protocols-catalog.json'), 'utf8'),
      ) as unknown,
    );
  throw new Error(`fixture fetchImpl: no defillama route for ${url}`);
};

const rpcEvmFixtureFetch = async (): Promise<Response> =>
  jsonResponse(loadFixtureRaw('rpc-evm', 'ethereum'));

function buildM1FixtureAdapters(): Map<string, ProviderAdapter> {
  return new Map<string, ProviderAdapter>([
    ['coingecko', createCoingeckoAdapter({ fetchImpl: coingeckoFixtureFetch, env: {} })],
    ['dexscreener', createDexscreenerAdapter({ fetchImpl: dexscreenerFixtureFetch })],
    ['defillama', createDefillamaAdapter({ fetchImpl: defillamaFixtureFetch })],
    ['rpc-evm', createRpcEvmAdapter({ fetchImpl: rpcEvmFixtureFetch })],
  ]);
}

/** No-op `Throttle` (same duck-typed convention as every other `mcp-server` integration test that
 * drives a real `nansen` adapter — avoids real-timer waits against its production rate limit). */
async function noOpThrottle(): Promise<void> {
  return undefined;
}

interface CacheMetaShape {
  status: 'hit' | 'miss';
  ageMs?: number;
  provider: string;
  capability: string;
}

function cacheMetaOf(result: CallToolResult): CacheMetaShape {
  const meta = (result as unknown as { _meta?: { cache?: CacheMetaShape } })._meta;
  if (!meta?.cache) {
    throw new Error(`expected _meta.cache on tool result, got: ${JSON.stringify(result)}`);
  }
  return meta.cache;
}

/** TC-INT-03 — `_meta.cache`'s field set on a MISS is asserted to be EXACTLY
 * `{status, provider, capability}`, byte-for-bit the same shape the pre-M2 M1 tools already had
 * (`ageMs` absent, never coerced to `undefined`/`0` — same principle as `e2e.inprocess.test.ts`'s
 * own `expectNoBudgetMeta`). This is the in-file equivalent of "diffing against the M1 snapshot
 * assert" (task's own Test Cases wording) — the M1 test files' own assertions are never imported
 * (not exported), so this reproduces the identical shape check directly. */
function assertMissCacheMetaUnchanged(
  result: CallToolResult,
  provider: string,
  capability: string,
): void {
  const meta = cacheMetaOf(result);
  expect(meta).toMatchObject({ status: 'miss', provider, capability });
  expect(Object.keys(meta).sort()).toStrictEqual(['capability', 'provider', 'status']);
}

/** Every refusal these servers rendered in full, keyed by the tool that produced it. */
const refusals: { event: string; detail: Record<string, unknown> }[] = [];

const REFUSAL_EVENT_ID = '01JREFUSAL0000000000000000';

const operatorTextFor = (tool: string): string =>
  refusals
    .filter((entry) => entry.detail['tool'] === tool)
    .map((entry) => String(entry.detail['reason']))
    .join('\n');

async function connectLinked(
  registry: CapabilityRegistry,
  budgetStore?: BudgetStore,
): Promise<{ client: Client; close: () => Promise<void> }> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer({
    env: loadEnv({}),
    version: '0.0.0-test',
    registry,
    budgetStore,
    // Task 014-26: the operator half of every refusal. R-40's substance — an operator learns WHICH
    // key is missing — is unchanged; what moved is that the CLIENT is no longer the one told, and
    // the assertions below now read the key here and its absence on the wire.
    diagnostics: {
      emit: (event, detail) => {
        refusals.push({ event, detail: detail.detail });
        return Promise.resolve(REFUSAL_EVENT_ID);
      },
    },
  });
  await server.connect(serverTransport);

  const client = new Client({
    name: 'onchain-intel-m2-degradation-test-client',
    version: '0.0.0-test',
  });
  await client.connect(clientTransport, { timeout: CONNECT_TIMEOUT_MS });

  return { client, close: () => client.close() };
}

/** The "M1 not degraded" half of R-40, shared verbatim by both scenarios below (DRY —
 * developer-guidelines §1.6 internal helper, not a new architectural surface): `onchain_ping` + the
 * 4 M1 tools, on the SAME `client`/session the 3 M2 tools were just refused on, all answer normally
 * — and each M1 tool's `_meta.cache` miss-shape is unchanged (TC-INT-03). */
async function assertFiveM1PathsAnswerNormally(client: Client): Promise<void> {
  const ping = (await client.callTool({ name: 'onchain_ping', arguments: {} }, undefined, {
    timeout: CALL_TIMEOUT_MS,
  })) as CallToolResult;
  expect(ping.isError).not.toBe(true);
  PingOutputSchema.parse(ping.structuredContent);

  const token = (await client.callTool(
    { name: 'onchain_get_token', arguments: { chain: 'ethereum', address: ETH_ADDRESS } },
    undefined,
    { timeout: CALL_TIMEOUT_MS },
  )) as CallToolResult;
  expect(token.isError).not.toBe(true);
  TokenSchema.parse(token.structuredContent);
  assertMissCacheMetaUnchanged(token, 'coingecko', 'token.price');

  const wallet = (await client.callTool(
    { name: 'onchain_wallet_balances', arguments: { chain: 'ethereum', address: ETH_ADDRESS } },
    undefined,
    { timeout: CALL_TIMEOUT_MS },
  )) as CallToolResult;
  expect(wallet.isError).not.toBe(true);
  WalletSchema.parse(wallet.structuredContent);
  assertMissCacheMetaUnchanged(wallet, 'rpc-evm', 'wallet.balances.native');

  const pairs = (await client.callTool(
    { name: 'onchain_active_pairs', arguments: { chain: 'ethereum' } },
    undefined,
    { timeout: CALL_TIMEOUT_MS },
  )) as CallToolResult;
  expect(pairs.isError).not.toBe(true);
  ActivePairsOutputSchema.parse(pairs.structuredContent);
  assertMissCacheMetaUnchanged(pairs, 'dexscreener', 'pairs.active');

  const tvl = (await client.callTool(
    { name: 'onchain_protocol_tvl', arguments: { chain: 'ethereum', protocolSlug: 'uniswap' } },
    undefined,
    { timeout: CALL_TIMEOUT_MS },
  )) as CallToolResult;
  expect(tvl.isError).not.toBe(true);
  ProtocolTvlOutputSchema.parse(tvl.structuredContent);
  assertMissCacheMetaUnchanged(tvl, 'defillama', 'protocol.tvl');
}

// -------------------------------------------------------------------------------------------
// TC-INT-01 — no NANSEN_API_KEY at all.
// -------------------------------------------------------------------------------------------
describe('TC-INT-01 (R-40): no NANSEN_API_KEY — 3 M2 tools isError, 5 M1 paths unaffected, same session', () => {
  let tempDir: string;
  let client: Client;
  let close: () => Promise<void>;

  beforeAll(async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'onchain-intel-m2-degradation-nokey-'));
    const cache = createCacheStore({ dbPath: path.join(tempDir, 'cache.sqlite3') });
    const adapters = buildM1FixtureAdapters();
    // isAvailable() must report {ok:false} and CapabilityRegistry must never reach fetch() at all
    // — proven structurally by this fetchImpl throwing unconditionally if it's ever invoked.
    adapters.set(
      'nansen',
      createNansenAdapter({
        env: {},
        fetchImpl: (async () => {
          throw new Error(
            'TC-INT-01: nansen fetchImpl must never be called without NANSEN_API_KEY',
          );
        }) as unknown as typeof fetch,
      }),
    );
    const registry = new CapabilityRegistry(routes, adapters, cache);
    ({ client, close } = await connectLinked(registry));
  }, CONNECT_TIMEOUT_MS);

  afterAll(async () => {
    await close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it(
    'all 3 M2 tools -> isError naming NANSEN_API_KEY (no value); onchain_ping + 4 M1 tools answer normally, same session',
    async () => {
      const smartMoney = (await client.callTool(
        {
          name: 'onchain_smart_money_flows',
          arguments: { chain: 'ethereum', tokenAddress: ETH_ADDRESS },
        },
        undefined,
        { timeout: CALL_TIMEOUT_MS },
      )) as CallToolResult;
      expect(smartMoney.isError).toBe(true);
      const [smartMoneyBlock] = smartMoney.content;
      if (smartMoneyBlock?.type !== 'text') throw new Error('expected a text content block');
      expect(smartMoneyBlock.text).not.toContain('NANSEN_API_KEY');
      expect(smartMoneyBlock.text).toContain(REFUSAL_EVENT_ID);
      expect(operatorTextFor('onchain_smart_money_flows')).toContain('NANSEN_API_KEY');

      const entityLabel = (await client.callTool(
        { name: 'onchain_entity_label', arguments: { chain: 'ethereum', query: 'uniswap' } },
        undefined,
        { timeout: CALL_TIMEOUT_MS },
      )) as CallToolResult;
      expect(entityLabel.isError).toBe(true);
      const [entityLabelBlock] = entityLabel.content;
      if (entityLabelBlock?.type !== 'text') throw new Error('expected a text content block');
      expect(entityLabelBlock.text).not.toContain('NANSEN_API_KEY');
      expect(entityLabelBlock.text).toContain(REFUSAL_EVENT_ID);
      expect(operatorTextFor('onchain_entity_label')).toContain('NANSEN_API_KEY');

      const tokenRisk = (await client.callTool(
        { name: 'onchain_token_risk', arguments: { chain: 'ethereum', tokenAddress: ETH_ADDRESS } },
        undefined,
        { timeout: CALL_TIMEOUT_MS },
      )) as CallToolResult;
      expect(tokenRisk.isError).toBe(true);
      const [tokenRiskBlock] = tokenRisk.content;
      if (tokenRiskBlock?.type !== 'text') throw new Error('expected a text content block');
      expect(tokenRiskBlock.text).not.toContain('NANSEN_API_KEY');
      expect(tokenRiskBlock.text).toContain(REFUSAL_EVENT_ID);
      expect(operatorTextFor('onchain_token_risk')).toContain('NANSEN_API_KEY');

      // "той же сессии" — the SAME client/server the 3 refusals above just ran on.
      await assertFiveM1PathsAnswerNormally(client);
    },
    CALL_TIMEOUT_MS * 4,
  );
});

// -------------------------------------------------------------------------------------------
// TC-INT-02 (M-1b) — key present, budget exhausted (goes through the gate, not isAvailable()).
// -------------------------------------------------------------------------------------------

const NOW = Date.UTC(2026, 6, 24, 12, 0, 0);
const BUCKET = dayBucketMs(NOW);
/** Prefilled `usage` — chosen arbitrarily high; what matters is that it equals the fixture
 * `/account`'s `credits_remaining: 0`-derived vendor ceiling exactly (see `effectiveCeilingFor()`,
 * `usageAtObserve + creditsRemainingAtObserve`), so ANY capability's cost (5/6/10cr, whichever gets
 * called first) overflows it — never dependent on knowing the exact live-plan price in advance. */
const PREFILLED_USAGE = 1000;

describe('TC-INT-02 (R-40, M-1b): NANSEN_API_KEY set, budget exhausted — 3 M2 tools isError, 5 M1 paths unaffected, same session', () => {
  let tempDir: string;
  let client: Client;
  let close: () => Promise<void>;
  let budgetStore: BudgetStore;
  let calls: string[];

  beforeAll(async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'onchain-intel-m2-degradation-budget-'));
    const cache = createCacheStore({ dbPath: path.join(tempDir, 'cache.sqlite3') });
    budgetStore = createBudgetStore({ dbPath: ':memory:' });
    // Reviewer note (c): usage is pre-filled by a DIRECT recordDelta write — never inferred from a
    // live remote balance, never from the fixture /account response alone.
    await budgetStore.recordDelta('nansen', BUCKET, PREFILLED_USAGE);

    calls = [];
    const nansenFetchImpl: typeof fetch = (async (input: FetchUrlInput) => {
      const pathname = new URL(urlOf(input)).pathname;
      calls.push(pathname);
      if (pathname === '/api/v1/account') {
        // credits_remaining: 0 -> vendorCeiling = usageAtObserve(PREFILLED_USAGE, read fresh from
        // budgetStore at resync time) + 0 = PREFILLED_USAGE = current usage -> any positive cost
        // overflows it.
        return jsonResponse({ plan: 'free', credits_remaining: 0 });
      }
      throw new Error(
        `TC-INT-02: unexpected nansen network call to ${pathname} — the budget gate should have ` +
          'refused before any paid data endpoint was ever reached',
      );
    }) as typeof fetch;

    const nansenAdapter = createNansenAdapter({
      env: { NANSEN_API_KEY: 'test-key-not-real' },
      budgetStore,
      fetchImpl: nansenFetchImpl,
      now: () => NOW,
      throttle: noOpThrottle,
    });
    const adapters = buildM1FixtureAdapters();
    adapters.set('nansen', nansenAdapter);
    const registry = new CapabilityRegistry(routes, adapters, cache);
    ({ client, close } = await connectLinked(registry, budgetStore));
  }, CONNECT_TIMEOUT_MS);

  afterAll(async () => {
    await close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it(
    'all 3 M2 tools -> isError with a budget reason, 0 calls to any paid data endpoint, usage unchanged; onchain_ping + 4 M1 tools answer normally, same session',
    async () => {
      const usageBefore = await budgetStore.getUsage('nansen', BUCKET);
      expect(usageBefore).toBe(PREFILLED_USAGE);

      const smartMoney = (await client.callTool(
        {
          name: 'onchain_smart_money_flows',
          arguments: { chain: 'ethereum', tokenAddress: ETH_ADDRESS },
        },
        undefined,
        { timeout: CALL_TIMEOUT_MS },
      )) as CallToolResult;
      expect(smartMoney.isError).toBe(true);
      const [smartMoneyBlock] = smartMoney.content;
      if (smartMoneyBlock?.type !== 'text') throw new Error('expected a text content block');
      expect(smartMoneyBlock.text.toLowerCase()).toContain('budget');

      const entityLabel = (await client.callTool(
        {
          name: 'onchain_entity_label',
          arguments: { chain: 'ethereum', tokenAddress: ETH_ADDRESS, exhaustive: false },
        },
        undefined,
        { timeout: CALL_TIMEOUT_MS },
      )) as CallToolResult;
      expect(entityLabel.isError).toBe(true);
      const [entityLabelBlock] = entityLabel.content;
      if (entityLabelBlock?.type !== 'text') throw new Error('expected a text content block');
      expect(entityLabelBlock.text.toLowerCase()).toContain('budget');

      const tokenRisk = (await client.callTool(
        { name: 'onchain_token_risk', arguments: { chain: 'ethereum', tokenAddress: ETH_ADDRESS } },
        undefined,
        { timeout: CALL_TIMEOUT_MS },
      )) as CallToolResult;
      expect(tokenRisk.isError).toBe(true);
      const [tokenRiskBlock] = tokenRisk.content;
      if (tokenRiskBlock?.type !== 'text') throw new Error('expected a text content block');
      expect(tokenRiskBlock.text.toLowerCase()).toContain('budget');

      // Exactly ONE call total across all 3 refused tools — the unavoidable cold-start /account
      // resync for the FIRST call (free; see this file's own docstring) — and ZERO calls to any
      // paid data endpoint (never even a 2nd/3rd /account call, since a refusal thrown from
      // ensureBudget() never marks accountState unreconciled).
      expect(calls).toStrictEqual(['/api/v1/account']);

      // R-37-style proof: a refusal writes NOTHING — usage is bit-for-bit unchanged.
      const usageAfter = await budgetStore.getUsage('nansen', BUCKET);
      expect(usageAfter).toBe(PREFILLED_USAGE);

      // "той же сессии" — the SAME client/server the 3 refusals above just ran on.
      await assertFiveM1PathsAnswerNormally(client);
    },
    CALL_TIMEOUT_MS * 4,
  );
});

/**
 * TC-INT-05 (vdd-multi TASK-008, iteration 2) — the free-tier provider must not mask the paid one's
 * absence.
 *
 * **Why this exists, and why every suite in this package was blind to it.** No mcp-server test
 * registered `blockscout` at all: `buildM1FixtureAdapters()` builds the five M1 adapters, and the
 * TC-INT-01/02 blocks add only `nansen`. Production wiring (`src/index.ts`) registers blockscout
 * FIRST on the `entity.labels` route. So the composition the server actually ships had zero
 * integration coverage — deleting the blockscout registration from `src/index.ts` left this whole
 * package green.
 *
 * That gap hid a real regression. TASK-008 taught the registry that an EMPTY answer does not satisfy
 * an `entity.labels` request, so the route walks past blockscout to nansen. The first version of
 * that change then returned blockscout's empty answer whenever nansen could not be reached —
 * discarding `tried[]` — so R-40's explicit `isError` became a confident "this address has no entity
 * labels". TC-INT-01 stayed green only because it asks with `query`, which blockscout declines
 * outright; the ADDRESS-scoped form, which is the common one, was unguarded.
 *
 * The distinction this pins: **asked everyone and nobody had it** is a success (R-32), **somebody
 * could not be asked** is an error (R-40). Both, in one session, with the real route table.
 */
describe('TC-INT-05: blockscout registered ahead of nansen — an empty free answer must not mask a missing key', () => {
  let tempDir: string;
  let client: Client;
  let close: () => Promise<void>;

  beforeAll(async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'onchain-intel-m2-blockscout-'));
    const cache = createCacheStore({ dbPath: path.join(tempDir, 'cache.sqlite3') });
    const adapters = buildM1FixtureAdapters();
    // The free provider answers 200 with no tags — the ORDINARY case (the recorded `get_address_info`
    // probe is USDC, tags empty).
    adapters.set(
      'blockscout',
      createBlockscoutAdapter({
        env: {},
        fetchImpl: (() =>
          Promise.resolve(
            new Response(JSON.stringify({ data: { metadata: null } }), { status: 200 }),
          )) as unknown as typeof fetch,
      }),
    );
    // The paid provider has no key, exactly as on a stock install.
    adapters.set(
      'nansen',
      createNansenAdapter({
        env: {},
        fetchImpl: (() => {
          throw new Error('TC-INT-05: nansen fetchImpl must never be called without a key');
        }) as unknown as typeof fetch,
      }),
    );
    const registry = new CapabilityRegistry(routes, adapters, cache);
    ({ client, close } = await connectLinked(registry));
  }, CONNECT_TIMEOUT_MS);

  afterAll(async () => {
    await close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it(
    'an ADDRESS-scoped entity.labels call still reports isError naming NANSEN_API_KEY (R-40)',
    async () => {
      const result = (await client.callTool(
        {
          name: 'onchain_entity_label',
          arguments: { chain: 'ethereum', tokenAddress: ETH_ADDRESS, exhaustive: false },
        },
        undefined,
        { timeout: CALL_TIMEOUT_MS },
      )) as CallToolResult;

      expect(result.isError, 'an unreachable paid provider was published as "no labels"').toBe(
        true,
      );
      const [block] = result.content;
      if (block?.type !== 'text') throw new Error('expected a text content block');
      expect(block.text).not.toContain('NANSEN_API_KEY');
      expect(operatorTextFor('onchain_entity_label')).toContain('NANSEN_API_KEY');
      // The free provider's own reason must be visible too — otherwise an operator reading this
      // cannot tell "blockscout was skipped" from "blockscout had nothing". Task 014-26 moved WHERE
      // it is visible: the attempt list names the traversal ORDER, which says indirectly which
      // provider is free, so it is the operator's to read and not the caller's.
      expect(operatorTextFor('onchain_entity_label')).toContain('blockscout');
      expect(block.text, 'the traversal order is not the caller’s business').not.toContain(
        'blockscout',
      );
    },
    CALL_TIMEOUT_MS,
  );
});
