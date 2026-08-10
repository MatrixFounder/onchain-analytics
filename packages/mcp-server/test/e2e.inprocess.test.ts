import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  CapabilityRegistry,
  createBudgetStore,
  createCacheStore,
  createCoingeckoAdapter,
  createDefillamaAdapter,
  createDexscreenerAdapter,
  createNansenAdapter,
  createRpcEvmAdapter,
  createRpcSolanaAdapter,
  PoolSchema,
  routes,
  SmartMoneyFlowSchema,
  TokenRiskScoreSchema,
  TokenSchema,
  WalletSchema,
  type BudgetStore,
  type ProviderAdapter,
} from '@onchain-intel/core';
import { loadEnv } from '../src/env.js';
import { createServer } from '../src/server.js';
import { EntityLabelOutputSchema } from '../src/tools/entity-label.js';
import { NewPairsOutputSchema } from '../src/tools/new-pairs.js';
import { ProtocolTvlOutputSchema } from '../src/tools/protocol-tvl.js';

/**
 * In-process E2E suite for the 4 new M1 MCP tools (task 003-7, R-16..R-19, F-1 fix — the
 * "e2e расширен на 4 tool" mechanism ARCHITECTURE.md §3.2 actually defines): `InMemoryTransport`
 * (part of `@modelcontextprotocol/sdk`, no new dependency) links a `Client` to a `McpServer` built
 * via `createServer({registry: fixtureRegistry})` **in one process** — never a spawned child
 * (that's `test/e2e.stdio.test.ts`'s job, ping-only, unchanged mechanism). This is the ONLY place
 * `registry` injection is exercisable: it is unreachable across a spawned process boundary.
 *
 * `fixtureRegistry` is a REAL `CapabilityRegistry` built from the REAL `routes` table
 * (`@onchain-intel/core`'s `providers.config.ts`) and the REAL adapter factories
 * (`createCoingeckoAdapter`/`createDexscreenerAdapter`/`createDefillamaAdapter`/
 * `createRpcEvmAdapter`/`createRpcSolanaAdapter` — batches A/B from tasks 003-4/003-5), each given
 * an INJECTED FAKE `fetchImpl` that returns the exact same fixture payloads
 * `packages/core/test/*.contract.test.ts` already golden-tests against (`packages/core/test/
 * fixtures/<adapter>/<name>.json`'s own `raw` field — this IS the adapter's own private
 * hand-off shape post-HTTP-step, so no separate "envelope" reconstruction is needed). Real
 * `safeFetch`/`assertAllowedHost`/`throttle`/`normalize()` logic all runs unmodified; only the
 * actual network call is replaced — never a mocked global `fetch` (ARCHITECTURE.md §3.2's own
 * "не мокать глобальный fetch" instruction). Zero real network calls (R-21).
 *
 * The cache is a REAL `TwoLevelStore` (`createCacheStore()`) pointed at a `mkdtempSync` temp
 * `DATA_DIR` (never the real `~/.onchain-intel`) — this is what lets this suite prove a genuine
 * miss→hit transition at the MCP-tool level (`_meta.cache`, R-15), not just at
 * `packages/core/test/cache.test.ts`'s lower level.
 */

const CONNECT_TIMEOUT_MS = 10_000;
const CALL_TIMEOUT_MS = 10_000;

const packageRoot = path.resolve(fileURLToPath(import.meta.url), '..', '..');
const coreFixturesRoot = path.resolve(packageRoot, '..', 'core', 'test', 'fixtures');

/** Reads `packages/core/test/fixtures/<adapter>/<name>.json` and returns its `raw` field — the
 * exact vendor wire body the real adapter's HTTP step would have received (see this file's own
 * docstring). */
function loadFixtureRaw(adapter: string, name: string): unknown {
  const envelope = JSON.parse(
    readFileSync(path.join(coreFixturesRoot, adapter, `${name}.json`), 'utf8'),
  ) as { raw: unknown };
  return envelope.raw;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

/** First parameter type of the global `fetch` — spelled this way (not the bare `RequestInfo`
 * name) because this package's tsconfig has no `dom` lib (only `@types/node`'s ambient fetch
 * globals, ES2023 base config); `Parameters<typeof fetch>[0]` resolves to whatever that ambient
 * global actually declares, without needing to name a possibly-absent global type directly. */
type FetchUrlInput = Parameters<typeof fetch>[0];

function urlOf(input: FetchUrlInput): string {
  return typeof input === 'string' ? input : input.toString();
}

const ETH_ADDRESS = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const SOL_ADDRESS = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

/** Routes on the request URL to the matching committed fixture — never a real network call. */
const coingeckoFixtureFetch = async (input: FetchUrlInput): Promise<Response> => {
  const url = urlOf(input);
  if (url.includes('/coins/ethereum/'))
    return jsonResponse(loadFixtureRaw('coingecko', 'ethereum'));
  if (url.includes('/coins/solana/')) return jsonResponse(loadFixtureRaw('coingecko', 'solana'));
  throw new Error(`fixture fetchImpl: no coingecko route for ${url}`);
};

const dexscreenerFixtureFetch = async (input: FetchUrlInput): Promise<Response> => {
  const url = urlOf(input);
  if (url.includes('q=ETH')) return jsonResponse(loadFixtureRaw('dexscreener', 'ethereum'));
  if (url.includes('q=SOL')) return jsonResponse(loadFixtureRaw('dexscreener', 'solana'));
  throw new Error(`fixture fetchImpl: no dexscreener route for ${url}`);
};

/** TASK-007 task 007-7: how many times the DEX-volume endpoint was actually hit. Counted here
 * rather than inside a test so the miss→hit assertion can prove ONE upstream request served two
 * tool calls — which is the whole claim `_meta.cache` makes. */
let dexVolumeFetchCount = 0;

const defillamaFixtureFetch = async (input: FetchUrlInput): Promise<Response> => {
  const url = urlOf(input);
  if (url.includes('/protocol/uniswap'))
    return jsonResponse(loadFixtureRaw('defillama', 'uniswap'));
  if (url.includes('/protocol/raydium'))
    return jsonResponse(loadFixtureRaw('defillama', 'raydium'));
  // TASK-007: the DEX-volume document. Unlike the two above, this fixture is the WHOLE recorded
  // vendor body (there is no `raw` envelope) — it is what the adapter's HTTP step receives.
  if (url.includes('/overview/dexs/')) {
    dexVolumeFetchCount += 1;
    return jsonResponse(
      JSON.parse(
        readFileSync(path.join(coreFixturesRoot, 'defillama', 'dexs-ethereum.json'), 'utf8'),
      ) as unknown,
    );
  }
  throw new Error(`fixture fetchImpl: no defillama route for ${url}`);
};

// rpc-evm/rpc-solana each serve exactly one chain, so their fixture fetchImpl never needs to
// branch on the request URL — always the one recorded fixture for that adapter.
const rpcEvmFixtureFetch = async (): Promise<Response> =>
  jsonResponse(loadFixtureRaw('rpc-evm', 'ethereum'));
const rpcSolanaFixtureFetch = async (): Promise<Response> =>
  jsonResponse(loadFixtureRaw('rpc-solana', 'solana'));

function buildFixtureAdapters(): Map<string, ProviderAdapter> {
  return new Map<string, ProviderAdapter>([
    ['coingecko', createCoingeckoAdapter({ fetchImpl: coingeckoFixtureFetch, env: {} })],
    ['dexscreener', createDexscreenerAdapter({ fetchImpl: dexscreenerFixtureFetch })],
    ['defillama', createDefillamaAdapter({ fetchImpl: defillamaFixtureFetch })],
    ['rpc-evm', createRpcEvmAdapter({ fetchImpl: rpcEvmFixtureFetch })],
    ['rpc-solana', createRpcSolanaAdapter({ fetchImpl: rpcSolanaFixtureFetch })],
  ]);
}

interface CacheMetaShape {
  status: 'hit' | 'miss';
  ageMs?: number;
  provider: string;
  capability: string;
}

interface BudgetMetaShape {
  provider: 'nansen';
  creditsUsedToday: number;
}

/** `_meta` is a loose/passthrough object per the SDK's own `CallToolResultSchema` (verified by
 * reading `types.d.ts` — `z.core.$loose`), so an extra `cache` key survives both the server's own
 * `structuredContent`/`_meta` round-trip and the client-side parse untouched; this cast is the
 * test-only, narrow shape this suite actually asserts against. */
function cacheMetaOf(result: CallToolResult): CacheMetaShape {
  const meta = (result as unknown as { _meta?: { cache?: CacheMetaShape } })._meta;
  if (!meta?.cache) {
    throw new Error(`expected _meta.cache on tool result, got: ${JSON.stringify(result)}`);
  }
  return meta.cache;
}

/** M2 (task 005-6) — `_meta.budget`'s own presence/absence check (interfaces.md §5.1.2): returns
 * `undefined` when the key is genuinely ABSENT from `_meta` (not merely `undefined`-valued) — the
 * distinction `budgetPresent()` below asserts against for the cache-hit case. */
function budgetMetaOf(result: CallToolResult): BudgetMetaShape | undefined {
  const meta = (result as unknown as { _meta?: { budget?: BudgetMetaShape } })._meta;
  return meta?.budget;
}

/** Asserts `_meta.budget` is ABSENT ENTIRELY — not just an `undefined` VALUE (interfaces.md §5.1.2:
 * "не коэрсится в 0/null", the same principle as `_meta.cache.ageMs` on a miss). */
function expectNoBudgetMeta(result: CallToolResult): void {
  const meta = (result as unknown as { _meta?: Record<string, unknown> })._meta;
  expect(meta && 'budget' in meta).toBe(false);
}

async function connectLinked(
  registry: CapabilityRegistry,
  budgetStore?: BudgetStore,
): Promise<{
  client: Client;
  close: () => Promise<void>;
}> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer({ env: loadEnv({}), version: '0.0.0-test', registry, budgetStore });
  await server.connect(serverTransport);

  const client = new Client({
    name: 'onchain-intel-e2e-inprocess-test-client',
    version: '0.0.0-test',
  });
  await client.connect(clientTransport, { timeout: CONNECT_TIMEOUT_MS });

  return { client, close: () => client.close() };
}

describe('4 new MCP tools — in-process E2E (InMemoryTransport, fixture-backed registry, 0 network)', () => {
  let tempDir: string;
  let client: Client;
  let close: () => Promise<void>;

  beforeAll(async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'onchain-intel-e2e-inprocess-'));
    const cache = createCacheStore({ dbPath: path.join(tempDir, 'cache.sqlite3') });
    const registry = new CapabilityRegistry(routes, buildFixtureAdapters(), cache);
    ({ client, close } = await connectLinked(registry));
  }, CONNECT_TIMEOUT_MS);

  afterAll(async () => {
    await close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  async function callToolTwice(
    name: string,
    args: Record<string, unknown>,
  ): Promise<{ first: CallToolResult; second: CallToolResult }> {
    const first = (await client.callTool({ name, arguments: args }, undefined, {
      timeout: CALL_TIMEOUT_MS,
    })) as CallToolResult;
    const second = (await client.callTool({ name, arguments: args }, undefined, {
      timeout: CALL_TIMEOUT_MS,
    })) as CallToolResult;
    return { first, second };
  }

  it.each([
    ['ethereum', ETH_ADDRESS],
    ['solana', SOL_ADDRESS],
  ])(
    'onchain_get_token — %s: structuredContent matches TokenSchema, _meta.cache miss→hit',
    async (chain, address) => {
      const { first, second } = await callToolTwice('onchain_get_token', { chain, address });

      expect(first.isError).not.toBe(true);
      const token = TokenSchema.parse(first.structuredContent);
      expect(token.chain).toBe(chain);
      const meta1 = cacheMetaOf(first);
      expect(meta1).toMatchObject({
        status: 'miss',
        provider: 'coingecko',
        capability: 'token.price',
      });

      expect(second.isError).not.toBe(true);
      TokenSchema.parse(second.structuredContent);
      const meta2 = cacheMetaOf(second);
      expect(meta2.status).toBe('hit');
      expect(typeof meta2.ageMs).toBe('number');
    },
    CALL_TIMEOUT_MS * 2,
  );

  it.each([
    ['ethereum', ETH_ADDRESS, 'rpc-evm'],
    ['solana', SOL_ADDRESS, 'rpc-solana'],
  ])(
    'onchain_wallet_balances — %s: structuredContent matches WalletSchema, _meta.cache miss→hit',
    async (chain, address, expectedProvider) => {
      const { first, second } = await callToolTwice('onchain_wallet_balances', { chain, address });

      expect(first.isError).not.toBe(true);
      const wallet = WalletSchema.parse(first.structuredContent);
      expect(wallet.chain).toBe(chain);
      expect(wallet.balances.every((b) => b.assetType === 'native')).toBe(true);
      const meta1 = cacheMetaOf(first);
      expect(meta1).toMatchObject({
        status: 'miss',
        provider: expectedProvider,
        capability: 'wallet.balances.native',
      });

      expect(second.isError).not.toBe(true);
      WalletSchema.parse(second.structuredContent);
      const meta2 = cacheMetaOf(second);
      expect(meta2.status).toBe('hit');
      expect(typeof meta2.ageMs).toBe('number');
    },
    CALL_TIMEOUT_MS * 2,
  );

  it.each([['ethereum'], ['solana']])(
    'onchain_new_pairs — %s: structuredContent matches the {chain,pairs,source,fetchedAt} contract, _meta.cache miss→hit',
    async (chain) => {
      const { first, second } = await callToolTwice('onchain_new_pairs', { chain });

      expect(first.isError).not.toBe(true);
      const parsed = NewPairsOutputSchema.parse(first.structuredContent);
      expect(parsed.chain).toBe(chain);
      expect(parsed.pairs.length).toBeGreaterThan(0);
      for (const pair of parsed.pairs) {
        PoolSchema.parse(pair);
        expect(pair.chain).toBe(chain);
      }
      const meta1 = cacheMetaOf(first);
      expect(meta1).toMatchObject({
        status: 'miss',
        provider: 'dexscreener',
        capability: 'pairs.new',
      });

      expect(second.isError).not.toBe(true);
      NewPairsOutputSchema.parse(second.structuredContent);
      const meta2 = cacheMetaOf(second);
      expect(meta2.status).toBe('hit');
      expect(typeof meta2.ageMs).toBe('number');
    },
    CALL_TIMEOUT_MS * 2,
  );

  it.each([
    ['ethereum', 'uniswap'],
    ['solana', 'raydium'],
  ])(
    'onchain_protocol_tvl — %s/%s: structuredContent matches the ProtocolTvlResult contract, _meta.cache miss→hit',
    async (chain, protocolSlug) => {
      const { first, second } = await callToolTwice('onchain_protocol_tvl', {
        chain,
        protocolSlug,
      });

      expect(first.isError).not.toBe(true);
      const parsed = ProtocolTvlOutputSchema.parse(first.structuredContent);
      expect(parsed.chain).toBe(chain);
      const meta1 = cacheMetaOf(first);
      expect(meta1).toMatchObject({
        status: 'miss',
        provider: 'defillama',
        capability: 'protocol.tvl',
      });

      expect(second.isError).not.toBe(true);
      ProtocolTvlOutputSchema.parse(second.structuredContent);
      const meta2 = cacheMetaOf(second);
      expect(meta2.status).toBe('hit');
      expect(typeof meta2.ageMs).toBe('number');
    },
    CALL_TIMEOUT_MS * 2,
  );

  it(
    'onchain_get_token rejects an unsupported chain (e.g. "bitcoin") — isError, not a crash (zod input validation)',
    async () => {
      const result = (await client.callTool(
        { name: 'onchain_get_token', arguments: { chain: 'bitcoin', address: ETH_ADDRESS } },
        undefined,
        { timeout: CALL_TIMEOUT_MS },
      )) as CallToolResult;
      expect(result.isError).toBe(true);
    },
    CALL_TIMEOUT_MS,
  );

  it(
    'onchain_wallet_balances rejects an invalid address for the given chain — isError, not a crash (superRefine)',
    async () => {
      const result = (await client.callTool(
        {
          name: 'onchain_wallet_balances',
          arguments: { chain: 'ethereum', address: 'not-an-address' },
        },
        undefined,
        { timeout: CALL_TIMEOUT_MS },
      )) as CallToolResult;
      expect(result.isError).toBe(true);
    },
    CALL_TIMEOUT_MS,
  );
});

/**
 * TASK-007 task 007-7 (R-72, AC-3/AC-6) — `onchain_dex_volume` end to end: the REAL registry, the
 * REAL two-level cache, the REAL adapter, and a fixture `fetchImpl`. What this proves that the
 * unit tests cannot: the coverage matrix, the gate and the cache agree with each other.
 */
describe('onchain_dex_volume (TASK-007) — in-process E2E (real cache, fixture fetchImpl, 0 network)', () => {
  let tempDir: string;
  let client: Client;
  let close: () => Promise<void>;

  beforeAll(async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'onchain-intel-e2e-dexvol-'));
    const cache = createCacheStore({ dbPath: path.join(tempDir, 'cache.sqlite3') });
    const registry = new CapabilityRegistry(routes, buildFixtureAdapters(), cache);
    dexVolumeFetchCount = 0;
    ({ client, close } = await connectLinked(registry));
  }, CONNECT_TIMEOUT_MS);

  afterAll(async () => {
    await close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it(
    'is listed among the server tools',
    async () => {
      const { tools } = await client.listTools(undefined, { timeout: CALL_TIMEOUT_MS });
      expect(tools.map((tool) => tool.name)).toContain('onchain_dex_volume');
    },
    CALL_TIMEOUT_MS,
  );

  it(
    'answers miss then hit, serving BOTH calls from one upstream request (AC-3)',
    async () => {
      const before = dexVolumeFetchCount;
      const args = { chain: 'ethereum', days: 30 };
      const first = (await client.callTool(
        { name: 'onchain_dex_volume', arguments: args },
        undefined,
        {
          timeout: CALL_TIMEOUT_MS,
        },
      )) as CallToolResult;
      const second = (await client.callTool(
        { name: 'onchain_dex_volume', arguments: args },
        undefined,
        {
          timeout: CALL_TIMEOUT_MS,
        },
      )) as CallToolResult;

      expect(first.isError).toBeFalsy();
      expect(cacheMetaOf(first).status).toBe('miss');
      expect(cacheMetaOf(first).provider).toBe('defillama');
      expect(cacheMetaOf(second).status).toBe('hit');
      expect(typeof cacheMetaOf(second).ageMs).toBe('number');
      // `ageMs` is omitted on a miss rather than coerced to 0 — there is no age to report yet.
      expect('ageMs' in cacheMetaOf(first)).toBe(false);
      expect(dexVolumeFetchCount - before).toBe(1);
    },
    CALL_TIMEOUT_MS,
  );

  it(
    'refuses an uncovered chain WITHOUT any upstream request, naming what is available (AC-6)',
    async () => {
      const before = dexVolumeFetchCount;
      const result = (await client.callTool(
        { name: 'onchain_dex_volume', arguments: { chain: 'zcash' } },
        undefined,
        { timeout: CALL_TIMEOUT_MS },
      )) as CallToolResult;

      expect(result.isError).toBe(true);
      const text = JSON.stringify(result.content);
      expect(text).toMatch(/dex\.volume\.history/);
      expect(text).toMatch(/zcash/);
      // A refusal that still paid for a round trip is not a gate.
      expect(dexVolumeFetchCount).toBe(before);
      // And the refusal must stay bounded — an error meant to save the caller a wasted call must
      // not dump 274 slugs into the model's context.
      expect(text.length).toBeLessThan(1200);
    },
    CALL_TIMEOUT_MS,
  );

  it(
    'rejects a window outside the schema bounds at the protocol boundary',
    async () => {
      const before = dexVolumeFetchCount;
      const result = (await client.callTool(
        { name: 'onchain_dex_volume', arguments: { chain: 'ethereum', days: 5000 } },
        undefined,
        { timeout: CALL_TIMEOUT_MS },
      )) as CallToolResult;
      expect(result.isError).toBe(true);
      expect(dexVolumeFetchCount).toBe(before);
    },
    CALL_TIMEOUT_MS,
  );
});

/**
 * Degradation/`isError` path (ARCHITECTURE.md §9.1/§3.2 reviewer note — "handler wraps
 * `registry.resolve()` in try/catch; on `CapabilityUnavailableError` → `isError: true`").
 *
 * **Superseded in part (T-013 task 013-8):** this said "M1 has no MCP tool wired to a
 * history/DSN-gated capability (`platform.metrics.history`/`pg-history` — OQ-2, no 5th tool)".
 * `onchain_dash_platform_history` is wired to both history capabilities now, so the gap is closed
 * and the sentence is kept only to explain why THIS case is built the way it is. It proves the
 * contract through a registry with NO adapters registered at all for `onchain_get_token`'s
 * capability, which is exactly `CapabilityRegistry`'s own documented "no adapter registered for
 * this id" `CapabilityUnavailableError` path (`packages/core`'s `registry.ts`).
 */
describe('capability unavailable — isError path (no adapter registered for the capability)', () => {
  let tempDir: string;
  let client: Client;
  let close: () => Promise<void>;

  beforeAll(async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'onchain-intel-e2e-inprocess-degraded-'));
    const cache = createCacheStore({ dbPath: path.join(tempDir, 'cache.sqlite3') });
    // Empty adapters Map — every one of the 4 tools' capabilities is unavailable by construction.
    const registry = new CapabilityRegistry(routes, new Map(), cache);
    ({ client, close } = await connectLinked(registry));
  }, CONNECT_TIMEOUT_MS);

  afterAll(async () => {
    await close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it(
    'onchain_get_token returns isError:true with a non-empty, non-secret-leaking reason',
    async () => {
      const result = (await client.callTool(
        { name: 'onchain_get_token', arguments: { chain: 'ethereum', address: ETH_ADDRESS } },
        undefined,
        { timeout: CALL_TIMEOUT_MS },
      )) as CallToolResult;

      expect(result.isError).toBe(true);
      const [block] = result.content;
      expect(block?.type).toBe('text');
      if (block?.type !== 'text') throw new Error('expected a text content block');
      expect(block.text.length).toBeGreaterThan(0);
      expect(block.text).toContain('token.price');
    },
    CALL_TIMEOUT_MS,
  );
});

// -------------------------------------------------------------------------------------------
// M2 (task 005-6, R-41/R-42/R-43) — the 3 new Nansen-backed tools, THROUGH THE REAL `nansen`
// adapter (never a fake `ProviderAdapter` — that's `test/tools/*.test.ts`'s job): singleflight,
// the budget gate, and post-call reconciliation all genuinely run, driven by an injected
// `fetchImpl` fixture (fake `/account` + fake sub-endpoint bodies carrying
// `x-nansen-credits-used`) — the SAME real-adapter-plus-fixture-fetchImpl mechanism the 4 M1
// scenarios above use, never a mocked global `fetch`, never a real `NANSEN_API_KEY`. Each `it()`
// below gets its OWN isolated `budgetStore`/registry/client (fresh `beforeEach`/`afterEach`, not
// a shared `beforeAll`) so the exact `_meta.budget.creditsUsedToday` figures this task's own Test
// Cases pin (10 / 0 / 5 / 6) are never polluted by another scenario's spend in the same bucket.
// -------------------------------------------------------------------------------------------

/**
 * Fixed instant for the nansen adapter — deliberately derived from TODAY's UTC day-bucket, never a
 * hardcoded calendar date.
 *
 * The tool handlers read `_meta.budget` via `budgetMeta(ctx.budgetStore, Date.now)` — the REAL
 * clock — while the adapter under test gets this injected `now`. `usage` is keyed on
 * `dayBucketMs(...)`, so the two must land in the SAME bucket or `getUsage()` reads a different row
 * and reports `creditsUsedToday: 0`. A hardcoded `Date.UTC(2026, 6, 24, …)` satisfied that only on
 * the day it was written: these three tests passed on 2026-07-24 and began failing the moment the
 * clock crossed midnight UTC into 2026-07-25 — a test that silently expires, which is the same
 * "green for the wrong reason" class as DF-1. Anchoring to today's bucket keeps the instant fixed
 * within a run (deterministic `fetchedAt`) while guaranteeing bucket agreement on any day.
 */
const NANSEN_FIXED_NOW = Math.floor(Date.now() / 86_400_000) * 86_400_000 + 12 * 60 * 60 * 1000;

function nansenJsonResponse(
  body: unknown,
  status = 200,
  headers?: Record<string, string>,
): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

async function readJsonBody(init: RequestInit | undefined): Promise<Record<string, unknown>> {
  if (!init?.body) return {};
  return JSON.parse(String(init.body)) as Record<string, unknown>;
}

/** Fixture `fetchImpl` for the REAL `nansen` adapter — routes every one of its 8 endpoints to a
 * fixed, `normalize()`-compatible body (see `@onchain-intel/core`'s `adapters/nansen/normalize.ts`
 * for the exact vendor field names each response must carry). `calls` records every request's
 * pathname, in order — the production-wiring proof this task's own CRITICAL note asks for reads
 * this array to assert exactly which/how-many network calls a given scenario made. A distinct
 * `tokenAddress`/`searchQuery` (`EMPTY_ADDRESS`) routes `/tgm/holders` and `/search/general` to
 * EMPTY results, for the "empty result is valid" scenario. */
function makeNansenFixtureFetch(calls: string[]): typeof fetch {
  return (async (input: FetchUrlInput, init?: RequestInit) => {
    const url = urlOf(input);
    const pathname = new URL(url).pathname;
    calls.push(pathname);
    const body = await readJsonBody(init);

    switch (pathname) {
      case '/api/v1/account':
        return nansenJsonResponse({ plan: 'free', credits_remaining: 100_000 });
      case '/api/v1/smart-money/netflow':
        return nansenJsonResponse(
          {
            data: [
              {
                token_symbol: 'UNI',
                net_flow_1h_usd: 1,
                net_flow_24h_usd: 2,
                net_flow_7d_usd: 3,
                net_flow_30d_usd: 4,
              },
            ],
          },
          200,
          { 'x-nansen-credits-used': '5' },
        );
      case '/api/v1/tgm/holders': {
        // Case-insensitive: `token_address` arrives EIP-55-checksummed (`normalizeAddress()` runs
        // twice before this — once in the tool handler, once inside the adapter's own
        // `performSubCalls()` — both idempotent, but this fixture must not assume it can hand-type
        // the exact keccak256-derived checksum casing of `EMPTY_TOKEN_ADDRESS` itself).
        const tokenAddress = body['token_address'];
        if (
          typeof tokenAddress === 'string' &&
          tokenAddress.toLowerCase() === EMPTY_TOKEN_ADDRESS.toLowerCase()
        ) {
          return nansenJsonResponse({ data: [] }, 200, { 'x-nansen-credits-used': '5' });
        }
        return nansenJsonResponse(
          {
            data: [
              {
                address: ETH_ADDRESS,
                address_label: 'Whale',
                token_amount: 1,
                value_usd: 2,
                ownership_percentage: 3,
              },
            ],
          },
          200,
          { 'x-nansen-credits-used': '5' },
        );
      }
      case '/api/v1/tgm/indicators':
        return nansenJsonResponse(
          {
            token_info: {
              market_cap_usd: 1_000_000,
              market_cap_group: 'mid',
              is_stablecoin: false,
            },
            risk_indicators: [{ indicator_type: 'rug_pull_risk', score: 'low' }],
            reward_indicators: [{ indicator_type: 'momentum', score: 'high' }],
          },
          200,
          { 'x-nansen-credits-used': '5' },
        );
      case '/api/v1/tgm/token-information':
        return nansenJsonResponse({}, 200, { 'x-nansen-credits-used': '1' });
      case '/api/v1/search/general': {
        const searchQuery = body['search_query'];
        if (
          typeof searchQuery === 'string' &&
          searchQuery.toLowerCase() === EMPTY_TOKEN_ADDRESS.toLowerCase()
        ) {
          return nansenJsonResponse({ tokens: [], entities: [] }, 200, {
            'x-nansen-credits-used': '0',
          });
        }
        return nansenJsonResponse(
          { tokens: [{ name: 'Uniswap', chain: 'ethereum', address: ETH_ADDRESS }], entities: [] },
          200,
          { 'x-nansen-credits-used': '0' },
        );
      }
      case '/api/v1/search/entity-name':
        return nansenJsonResponse([], 200, { 'x-nansen-credits-used': '0' });
      case '/api/v1/profiler/address/labels':
        return nansenJsonResponse({ data: [{ label: 'exchange' }] }, 200, {
          'x-nansen-credits-used': '100',
        });
      default:
        throw new Error(`fixture fetchImpl: no nansen route for ${pathname}`);
    }
  }) as typeof fetch;
}

const EMPTY_TOKEN_ADDRESS = '0x1f9840a85D5aF5bF1D1762f925bdadDc4201F984';

/** No-op `Throttle` (duck-typed against `@onchain-intel/core`'s internal `Throttle` shape,
 * `(providerId, config) => Promise<void>` — not itself publicly re-exported, so this is a
 * structurally-compatible plain function rather than an import) — avoids real-timer waits against
 * `nansen`'s 5-capacity/1-per-second production rate limit across this file's several real-adapter
 * scenarios, mirroring `packages/core`'s own `nansen.*.test.ts` fake-clock-throttle convention
 * (there via `createThrottle(fakeClock())`, unavailable here since it isn't part of the public
 * package surface `mcp-server` is allowed to import from). */
async function noOpThrottle(): Promise<void> {
  return undefined;
}

describe('3 new MCP tools (M2, task 005-6) — in-process E2E (real nansen adapter, fixture fetchImpl, 0 network)', () => {
  let tempDir: string;
  let client: Client;
  let close: () => Promise<void>;
  let budgetStore: BudgetStore;
  let calls: string[];

  beforeEach(async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'onchain-intel-e2e-inprocess-nansen-'));
    const cache = createCacheStore({ dbPath: path.join(tempDir, 'cache.sqlite3') });
    budgetStore = createBudgetStore({ dbPath: ':memory:' });
    calls = [];
    const nansenAdapter = createNansenAdapter({
      env: { NANSEN_API_KEY: 'test-key-not-real' },
      fetchImpl: makeNansenFixtureFetch(calls),
      now: () => NANSEN_FIXED_NOW,
      budgetStore,
      throttle: noOpThrottle,
    });
    const registry = new CapabilityRegistry(routes, new Map([['nansen', nansenAdapter]]), cache);
    ({ client, close } = await connectLinked(registry, budgetStore));
  }, CONNECT_TIMEOUT_MS);

  afterEach(async () => {
    await close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it(
    // TC-E2E-01/02 — the production-wiring proof this task's CRITICAL note asks for: `_meta.budget`
    // IS `budgetStore.getUsage()` read after `registry.resolve()` returns, so asserting
    // `creditsUsedToday === 10` here is the seam-level proof that the gate is live end-to-end.
    'onchain_smart_money_flows: valid SmartMoneyFlow, _meta.cache miss->hit, _meta.budget=10cr on miss then ABSENT on hit',
    async () => {
      const args = { chain: 'ethereum', tokenAddress: ETH_ADDRESS };

      const first = (await client.callTool(
        { name: 'onchain_smart_money_flows', arguments: args },
        undefined,
        { timeout: CALL_TIMEOUT_MS },
      )) as CallToolResult;
      expect(first.isError).not.toBe(true);
      SmartMoneyFlowSchema.parse(first.structuredContent);
      expect(cacheMetaOf(first)).toMatchObject({ status: 'miss', provider: 'nansen' });
      expect(budgetMetaOf(first)).toStrictEqual({ provider: 'nansen', creditsUsedToday: 10 });

      const second = (await client.callTool(
        { name: 'onchain_smart_money_flows', arguments: args },
        undefined,
        { timeout: CALL_TIMEOUT_MS },
      )) as CallToolResult;
      expect(second.isError).not.toBe(true);
      expect(cacheMetaOf(second).status).toBe('hit');
      expectNoBudgetMeta(second); // cache hit -> gate/costOf()/network never ran -> no budget key
    },
    CALL_TIMEOUT_MS * 2,
  );

  it(
    // TC-E2E-05 — the token-scoped 5cr tier.
    'onchain_entity_label (token-scoped, no exhaustive): entities[] shape, 5cr budget',
    async () => {
      const result = (await client.callTool(
        {
          name: 'onchain_entity_label',
          arguments: { chain: 'ethereum', tokenAddress: ETH_ADDRESS, exhaustive: false },
        },
        undefined,
        { timeout: CALL_TIMEOUT_MS },
      )) as CallToolResult;

      expect(result.isError).not.toBe(true);
      const parsed = EntityLabelOutputSchema.parse(result.structuredContent);
      expect(parsed.chain).toBe('ethereum');
      expect(parsed.entities.length).toBeGreaterThan(0);
      expect(cacheMetaOf(result)).toMatchObject({ status: 'miss', provider: 'nansen' });
      expect(budgetMetaOf(result)).toStrictEqual({ provider: 'nansen', creditsUsedToday: 5 });
      expect(calls).toContain('/api/v1/tgm/holders');
      expect(calls).not.toContain('/api/v1/profiler/address/labels'); // never the exhaustive tier
    },
    CALL_TIMEOUT_MS,
  );

  it(
    // TC-E2E-09 — the composite token.risk capability, 6cr, risk/reward kept as SEPARATE groups.
    'onchain_token_risk: TokenRiskScore with separate risk/reward groups, 6cr budget',
    async () => {
      const result = (await client.callTool(
        {
          name: 'onchain_token_risk',
          arguments: { chain: 'ethereum', tokenAddress: ETH_ADDRESS },
        },
        undefined,
        { timeout: CALL_TIMEOUT_MS },
      )) as CallToolResult;

      expect(result.isError).not.toBe(true);
      const parsed = TokenRiskScoreSchema.parse(result.structuredContent);
      expect(parsed.riskIndicators.length).toBeGreaterThan(0);
      expect(parsed.rewardIndicators.length).toBeGreaterThan(0);
      expect(parsed.riskIndicators).not.toBe(parsed.rewardIndicators);
      expect(cacheMetaOf(result)).toMatchObject({ status: 'miss', provider: 'nansen' });
      expect(budgetMetaOf(result)).toStrictEqual({ provider: 'nansen', creditsUsedToday: 6 });
    },
    CALL_TIMEOUT_MS,
  );

  it(
    // TC-E2E-04 — the default 0cr tier (query-only, no tokenAddress).
    'onchain_entity_label (default, query-only): entities[] shape, 0cr budget (no growth)',
    async () => {
      const result = (await client.callTool(
        {
          name: 'onchain_entity_label',
          arguments: { chain: 'ethereum', query: 'uniswap', exhaustive: false },
        },
        undefined,
        { timeout: CALL_TIMEOUT_MS },
      )) as CallToolResult;

      expect(result.isError).not.toBe(true);
      const parsed = EntityLabelOutputSchema.parse(result.structuredContent);
      expect(parsed.chain).toBe('ethereum');
      expect(budgetMetaOf(result)).toStrictEqual({ provider: 'nansen', creditsUsedToday: 0 });
      expect(calls).not.toContain('/api/v1/tgm/holders'); // no tokenAddress -> never called
    },
    CALL_TIMEOUT_MS,
  );

  it(
    // TC-E2E-08 — a token whose fixture returns an EMPTY holders/search result: a VALID success,
    // never an error.
    'onchain_entity_label: an empty entities[] result is a VALID success, not an error (R-32)',
    async () => {
      const result = (await client.callTool(
        {
          name: 'onchain_entity_label',
          arguments: { chain: 'ethereum', tokenAddress: EMPTY_TOKEN_ADDRESS, exhaustive: false },
        },
        undefined,
        { timeout: CALL_TIMEOUT_MS },
      )) as CallToolResult;

      expect(result.isError).not.toBe(true);
      const parsed = EntityLabelOutputSchema.parse(result.structuredContent);
      expect(parsed.entities).toStrictEqual([]);
    },
    CALL_TIMEOUT_MS,
  );
});

/**
 * TC-E2E-07 — exhaustive:true refused by a self-imposed `NANSEN_DAILY_CREDIT_CAP` — its own
 * ISOLATED describe block (a dedicated `dailyCreditCap: 50`, well below the 100cr escalation's
 * price, whereas the shared M2 block above deliberately has none set, so a request there would
 * succeed instead of refusing). isError:true, a budget-naming reason, and ZERO further network
 * calls: a warm-up call first establishes a same-bucket, already-reconciled snapshot — the SAME
 * pattern `nansen.singleflight.test.ts`'s own "TC-UNIT-12 layer order" test uses for the identical
 * "ZERO network calls" claim (packages/core).
 */
describe('onchain_entity_label (M2, task 005-6) — exhaustive:true refused by a self-imposed cap', () => {
  let tempDir: string;
  let client: Client;
  let close: () => Promise<void>;
  let calls: string[];

  beforeAll(async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'onchain-intel-e2e-inprocess-nansen-refused-'));
    const cache = createCacheStore({ dbPath: path.join(tempDir, 'cache.sqlite3') });
    const budgetStore = createBudgetStore({ dbPath: ':memory:' });
    calls = [];
    const nansenAdapter = createNansenAdapter({
      env: { NANSEN_API_KEY: 'test-key-not-real' },
      fetchImpl: makeNansenFixtureFetch(calls),
      now: () => NANSEN_FIXED_NOW,
      budgetStore,
      dailyCreditCap: 50, // < 100cr, the exhaustive escalation's own fixed price
      throttle: noOpThrottle,
    });
    const registry = new CapabilityRegistry(routes, new Map([['nansen', nansenAdapter]]), cache);
    ({ client, close } = await connectLinked(registry, budgetStore));
  }, CONNECT_TIMEOUT_MS);

  afterAll(async () => {
    await close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it(
    'onchain_entity_label (exhaustive:true, refused): isError:true, budget reason, 0 further network calls',
    async () => {
      // Warm-up: onchain_token_risk (6cr, well within the 50cr cap) resyncs /account and reserves
      // budget in this bucket, leaving the adapter's internal accountState reconciled and
      // same-bucket for the call below.
      const warmup = (await client.callTool(
        { name: 'onchain_token_risk', arguments: { chain: 'ethereum', tokenAddress: ETH_ADDRESS } },
        undefined,
        { timeout: CALL_TIMEOUT_MS },
      )) as CallToolResult;
      expect(warmup.isError).not.toBe(true);
      calls.length = 0; // only the REFUSED call's own network activity matters from here

      const result = (await client.callTool(
        {
          name: 'onchain_entity_label',
          arguments: { chain: 'ethereum', tokenAddress: ETH_ADDRESS, exhaustive: true },
        },
        undefined,
        { timeout: CALL_TIMEOUT_MS },
      )) as CallToolResult;

      expect(result.isError).toBe(true);
      const [block] = result.content;
      if (block?.type !== 'text') throw new Error('expected a text content block');
      expect(block.text.toLowerCase()).toContain('budget');
      expect(calls).toHaveLength(0); // fetchImpl never invoked at all for the refused call
    },
    CALL_TIMEOUT_MS * 2,
  );
});

/**
 * TC-E2E-11 — no `NANSEN_API_KEY`: all 3 M2 tools degrade to `isError:true` (naming the missing
 * key, never a value — there is none to leak here anyway), while an M1 tool on the SAME registry
 * still answers normally. Reuses `buildFixtureAdapters()` (the M1 fixture adapters) plus a
 * keyless `nansen` adapter — same "one registry, mixed availability" shape `CapabilityRegistry`
 * is designed for (never a second registry construction path).
 */
describe('M2 degradation — no NANSEN_API_KEY (R-41/R-42/R-43), M1 tools unaffected', () => {
  let tempDir: string;
  let client: Client;
  let close: () => Promise<void>;

  beforeAll(async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), 'onchain-intel-e2e-inprocess-nansen-nokey-'));
    const cache = createCacheStore({ dbPath: path.join(tempDir, 'cache.sqlite3') });
    const adapters = buildFixtureAdapters();
    // Deliberately NO NANSEN_API_KEY — isAvailable() must report {ok:false}, never crash.
    adapters.set('nansen', createNansenAdapter({ env: {}, fetchImpl: makeNansenFixtureFetch([]) }));
    const registry = new CapabilityRegistry(routes, adapters, cache);
    ({ client, close } = await connectLinked(registry));
  }, CONNECT_TIMEOUT_MS);

  afterAll(async () => {
    await close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it.each(['onchain_smart_money_flows', 'onchain_entity_label', 'onchain_token_risk'])(
    '%s without NANSEN_API_KEY -> isError:true, reason names the key, never a value',
    async (toolName) => {
      const args =
        toolName === 'onchain_entity_label'
          ? { chain: 'ethereum', query: 'uniswap' }
          : { chain: 'ethereum', tokenAddress: ETH_ADDRESS };
      const result = (await client.callTool({ name: toolName, arguments: args }, undefined, {
        timeout: CALL_TIMEOUT_MS,
      })) as CallToolResult;

      expect(result.isError).toBe(true);
      const [block] = result.content;
      if (block?.type !== 'text') throw new Error('expected a text content block');
      expect(block.text).toContain('NANSEN_API_KEY');
    },
    CALL_TIMEOUT_MS,
  );

  it(
    'onchain_get_token (M1) still answers normally on the SAME registry',
    async () => {
      const result = (await client.callTool(
        { name: 'onchain_get_token', arguments: { chain: 'ethereum', address: ETH_ADDRESS } },
        undefined,
        { timeout: CALL_TIMEOUT_MS },
      )) as CallToolResult;
      expect(result.isError).not.toBe(true);
      TokenSchema.parse(result.structuredContent);
    },
    CALL_TIMEOUT_MS,
  );
});
