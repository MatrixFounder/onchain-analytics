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
  createCacheStore,
  createCoingeckoAdapter,
  createDefillamaAdapter,
  createDexscreenerAdapter,
  createRpcEvmAdapter,
  createRpcSolanaAdapter,
  PoolSchema,
  routes,
  TokenSchema,
  WalletSchema,
  type ProviderAdapter,
} from '@onchain-intel/core';
import { loadEnv } from '../src/env.js';
import { createServer } from '../src/server.js';
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

const defillamaFixtureFetch = async (input: FetchUrlInput): Promise<Response> => {
  const url = urlOf(input);
  if (url.includes('/protocol/uniswap'))
    return jsonResponse(loadFixtureRaw('defillama', 'uniswap'));
  if (url.includes('/protocol/raydium'))
    return jsonResponse(loadFixtureRaw('defillama', 'raydium'));
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

async function connectLinked(registry: CapabilityRegistry): Promise<{
  client: Client;
  close: () => Promise<void>;
}> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const server = createServer({ env: loadEnv({}), version: '0.0.0-test', registry });
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
        capability: 'token.metadata',
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
 * Degradation/`isError` path (ARCHITECTURE.md §9.1/§3.2 reviewer note — "handler wraps
 * `registry.resolve()` in try/catch; on `CapabilityUnavailableError` → `isError: true`"). M1 has
 * no MCP tool wired to a history/DSN-gated capability (`platform.metrics.history`/`pg-history` —
 * OQ-2, no 5th tool), so this proves the identical contract the only way one of the 4 REAL M1
 * tools can exercise it: a registry with NO adapters registered at all for `onchain_get_token`'s
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
      expect(block.text).toContain('token.metadata');
    },
    CALL_TIMEOUT_MS,
  );
});
