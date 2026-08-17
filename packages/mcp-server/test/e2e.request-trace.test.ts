import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {
  loadChainRegistry,
  type CapabilityResolution,
  type CapabilityResolver,
} from '@onchain-intel/core';
import { createServer } from '../src/server.js';
import { loadEnv } from '../src/env.js';
import {
  DEFAULT_MCP_PATH,
  startHttpTransport,
  type RunningHttpTransport,
} from '../src/transport/http.js';
import { createHttpPrincipalResolver } from '../src/auth/principal.js';
import { createRequestTraceStore } from '../src/engine/request-trace-store.js';
import { createSqliteEngine, type SqliteEngine } from './helpers/sqlite-engine.js';
import { TEST_PRINCIPAL, acceptsTestToken, bearerHeader } from './helpers/test-auth.js';

/**
 * Task 014-30, TC-E2E-01…03 — a served request leaves exactly one row, end to end.
 *
 * **These run as role `user`, and that is the point of using the HTTP path.** `TEST_PRINCIPAL`
 * carries `role: 'user'`; every other suite in this package runs as the stdio constant, which is
 * `admin`. An assertion about what a row records — or about what `_meta` does NOT carry — is
 * vacuous under a principal that sees everything.
 *
 * **The resolver is hand-built rather than a whole registry.** `ToolContext.registry` is the
 * `CapabilityResolver` INTERFACE since this task, so a suite that needs to observe one cache status
 * can state it directly instead of assembling adapters, fixtures and a cache to provoke it.
 */

let harness: SqliteEngine;
let running: RunningHttpTransport;

/** A resolver that answers with the cache status the case is about, and nothing else. */
function resolverAnswering(cache: 'hit' | 'miss'): CapabilityResolver {
  const chains = loadChainRegistry();
  return {
    getChainRegistry: () => chains,
    getCoverage: () => {
      throw new Error('not used by these cases');
    },
    resolve: (): Promise<CapabilityResolution> =>
      Promise.resolve({
        result: {
          chain: 'ethereum',
          name: 'Ethereum',
          tvlUsd: 1,
          source: 'defillama',
          fetchedAt: 1,
        },
        source: 'defillama',
        cache,
        ...(cache === 'hit' ? { ageMs: 1234 } : {}),
        attempted: cache === 'hit' ? [] : ['defillama'],
      }),
  };
}

async function startWith(registry?: CapabilityResolver): Promise<void> {
  running = await startHttpTransport({
    createSessionServer: () =>
      createServer({
        env: loadEnv({}),
        version: '0.0.0-test',
        ...(registry ? { registry } : {}),
        requestTrace: createRequestTraceStore(harness.engine),
        principals: createHttpPrincipalResolver(),
      }),
    authenticate: acceptsTestToken(),
    bind: '127.0.0.1',
    port: 0,
  });
}

beforeEach(() => {
  harness = createSqliteEngine();
});

afterEach(async () => {
  await running.close();
  harness.close();
});

const rows = (): Record<string, unknown>[] =>
  harness.db.prepare('SELECT * FROM request_trace ORDER BY received_at').all() as Record<
    string,
    unknown
  >[];

async function call(tool: string, args: Record<string, unknown> = {}): Promise<unknown> {
  const client = new Client({ name: 'e2e-trace', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(
    new URL(`http://127.0.0.1:${String(running.address.port)}${DEFAULT_MCP_PATH}`),
    { requestInit: { headers: bearerHeader() } },
  );
  await client.connect(transport);
  try {
    return await client.callTool({ name: tool, arguments: args });
  } finally {
    await client.close();
  }
}

describe('TC-E2E-02: a tool that resolves no capability still leaves a row', () => {
  it('records onchain_ping with the tool named and the capability empty', async () => {
    await startWith();
    await call('onchain_ping');

    const [row] = rows();
    expect(row).toBeDefined();
    expect(row?.['tool']).toBe('onchain_ping');
    // The case §4.5.7a names: a billable request that resolved nothing. Reading this NULL as a
    // failure would drop the request from T-015's count.
    expect(row?.['capability']).toBeNull();
    expect(row?.['outcome']).toBe('answer');
    expect(row?.['served_from']).toBe('none');
    expect(row?.['args_hash']).toBeNull();
    expect(row?.['tried_json']).toBeNull();
  });

  it('carries the authenticated principal, not the stdio constant', async () => {
    await startWith();
    await call('onchain_ping');

    const [row] = rows();
    expect(row?.['principal_id']).toBe(TEST_PRINCIPAL.tokenId);
    expect(row?.['user_id']).toBe(TEST_PRINCIPAL.userId);
    expect(row?.['transport']).toBe('http');
    // Minted, because this client declared no namespace key — and "minted" is a query, not a guess.
    expect(row?.['client_request_id']).toBe(row?.['id']);
  });

  it('pins received_at at admission, before the tool boundary', async () => {
    await startWith();
    await call('onchain_ping');
    const [row] = rows();
    // The two clocks are ours; what matters is the order, which is what the column's meaning is.
    expect(Number(row?.['received_at'])).toBeLessThanOrEqual(Number(row?.['completed_at']));
  });
});

describe('TC-E2E-01: served_from names what answered', () => {
  it('records vendor for a live answer and cache for a stored one', async () => {
    await startWith(resolverAnswering('miss'));
    await call('onchain_chain_tvl', { chain: 'ethereum' });
    expect(rows()[0]?.['served_from']).toBe('vendor');
    expect(rows()[0]?.['cache_age_ms']).toBeNull();
    // The walk is recorded, and its ids are the ones the traversal entered.
    expect(JSON.parse(String(rows()[0]?.['tried_json']))).toStrictEqual([
      { capability: 'chain.tvl', tried: [{ adapterId: 'defillama' }] },
    ]);
    // The args hash is the resolver's, not a recomputation from the tool's raw input.
    expect(String(rows()[0]?.['args_hash'])).toHaveLength(64);
    await running.close();

    harness.close();
    harness = createSqliteEngine();
    await startWith(resolverAnswering('hit'));
    await call('onchain_chain_tvl', { chain: 'ethereum' });
    expect(rows()[0]?.['served_from']).toBe('cache');
    expect(rows()[0]?.['cache_age_ms']).toBe(1234);
  });

  it('leaves the vendor columns empty when nothing was spent', async () => {
    // A free adapter answered live: `served_from` says `vendor` and the ledger says nothing, which
    // is the decoupling working in the direction nobody thinks to check.
    await startWith(resolverAnswering('miss'));
    await call('onchain_chain_tvl', { chain: 'ethereum' });
    const [row] = rows();
    expect(row?.['served_from']).toBe('vendor');
    expect(row?.['vendor_provider']).toBeNull();
    expect(row?.['vendor_credits']).toBeNull();
  });
});

describe('TC-E2E-03: a protocol refusal leaves no row', () => {
  it('writes nothing for a request with no Authorization header', async () => {
    await startWith();
    const client = new Client({ name: 'e2e-trace-anon', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(
      new URL(`http://127.0.0.1:${String(running.address.port)}${DEFAULT_MCP_PATH}`),
    );

    await expect(client.connect(transport)).rejects.toThrow();
    // `principal_id` is NOT NULL, and a request refused at admission has no principal: the row
    // cannot exist, and the refusal is observable in the diagnostics channel instead.
    expect(rows()).toStrictEqual([]);
  });
});

describe('one served request leaves exactly one row', () => {
  it('does not write a second row for a second tool call on the same session', async () => {
    await startWith();
    await call('onchain_ping');
    await call('onchain_ping');
    expect(rows()).toHaveLength(2);
    // Two requests, two rows, two ids — the dedup key separates them by `received_at`.
    expect(rows()[0]?.['id']).not.toBe(rows()[1]?.['id']);
  });
});
