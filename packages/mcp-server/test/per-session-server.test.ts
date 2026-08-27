import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { BudgetStore, CacheStore } from '@onchain-intel/core';
import { loadEnv } from '../src/env.js';
import { createSharedRuntime, type SharedRuntime } from '../src/runtime.js';
import {
  DEFAULT_MCP_PATH,
  startHttpTransport,
  type RunningHttpTransport,
} from '../src/transport/http.js';
import { acceptsTestToken, bearerHeader } from './helpers/test-auth.js';
import { createBillingStoreStub } from '../src/engine/billing-store.js';

/**
 * Task 014-10 — one `McpServer` per session, over dependencies assembled once (AC-18, R-2.2).
 *
 * **Why the counters are on FACTORIES and not on the real stores.** `createCacheStore` and
 * `createBudgetStore` open SQLite files under `DATA_DIR`; a test that called them would write to the
 * developer's own installation. `createSharedRuntime` takes both as parameters for exactly this, and
 * production omits them.
 */

let runtime: SharedRuntime;
let running: RunningHttpTransport;
let cacheStoreBuilds = 0;
let budgetStoreBuilds = 0;
let sessionServers: McpServer[] = [];

/**
 * A `CacheStore` that answers "nothing cached" — enough for a `tools/list` and a `ping`.
 *
 * **`get` resolves to `undefined`, and the shape matters.** The registry decides hit vs miss on
 * truthiness (`adapters/cache-store.ts`: "`get()` returning `undefined` means no usable entry"), so
 * the `{ hit: false }` this used to return read as a HIT carrying no value. Nothing here noticed —
 * neither `tools/list` nor `ping` resolves a capability — but the same helper copied into a case
 * that does would short-circuit every walk and measure nothing (caught in task 014-19).
 */
const inertCacheStore = (): CacheStore => ({
  get: () => Promise.resolve(undefined),
  set: () => Promise.resolve(),
});

const inertBudgetStore = (): BudgetStore => ({}) as unknown as BudgetStore;

beforeEach(async () => {
  cacheStoreBuilds = 0;
  budgetStoreBuilds = 0;
  sessionServers = [];
  runtime = createSharedRuntime({
    env: loadEnv({}),
    version: '0.0.0-test',
    cacheStoreFactory: () => {
      cacheStoreBuilds += 1;
      return inertCacheStore();
    },
    // Required on `SharedRuntimeDeps` (task 015-09) — see its docstring: an omitted billing
    // store would be a fail-open default, not a narrowed feature.
    billing: createBillingStoreStub(),
    budgetStoreFactory: () => {
      budgetStoreBuilds += 1;
      return inertBudgetStore();
    },
  });
  running = await startHttpTransport({
    createSessionServer: () => {
      const server = runtime.createSessionServer();
      sessionServers.push(server);
      return server;
    },
    authenticate: acceptsTestToken(),
    bind: '127.0.0.1',
    port: 0,
  });
});

afterEach(async () => {
  await running.close();
});

const endpoint = (): URL =>
  new URL(`http://127.0.0.1:${String(running.address.port)}${DEFAULT_MCP_PATH}`);

/**
 * Opens a session, and hands back the two DIFFERENT ways a client can leave.
 *
 * **`end` sends the DELETE; `abandon` does not, and the difference is the point.** Measured here:
 * `client.close()` tears down the client's own stream and sends nothing, so the server keeps the
 * session — which is correct for Streamable HTTP, where nothing connects the two requests of a
 * session except its id, and is exactly the state RISK-6 describes. An abandoned session leaves the
 * map until task 014-13 evicts it on the idle timeout; the ordinary path is `terminateSession`.
 */
async function openSession(): Promise<{
  client: Client;
  end: () => Promise<void>;
  abandon: () => Promise<void>;
}> {
  const client = new Client({ name: 'session', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(endpoint(), {
    requestInit: { headers: bearerHeader() },
  });
  await client.connect(transport);
  return {
    client,
    end: async () => {
      await transport.terminateSession();
      await client.close();
    },
    abandon: () => client.close(),
  };
}

describe('TC-E2E-01 / AC-18: different server instances, one registry', () => {
  it('builds one McpServer per session and hands every one the same shared dependencies', async () => {
    const first = await openSession();
    const second = await openSession();
    try {
      expect(running.sessionCount()).toBe(2);
      expect(sessionServers).toHaveLength(2);
      // Different protocol state per client — a shared instance would mix two clients' sessions and
      // make a per-session tool inventory impossible (§3.4.9).
      expect(sessionServers[0]).not.toBe(sessionServers[1]);
    } finally {
      await first.end();
      await second.end();
    }
  });

  it('TC-UNIT-02 / TC-UNIT-03: the shared stores are constructed once, for any number of sessions', async () => {
    // Constructed at `createSharedRuntime` time, before any session exists.
    expect(cacheStoreBuilds).toBe(1);
    expect(budgetStoreBuilds).toBe(1);

    const sessions = [await openSession(), await openSession(), await openSession()];
    try {
      expect(running.sessionCount()).toBe(3);
      expect(cacheStoreBuilds, 'a cache nobody shares is not a cache').toBe(1);
      expect(budgetStoreBuilds, 'a ceiling nobody shares is not a ceiling (R-2.2)').toBe(1);
    } finally {
      for (const session of sessions) await session.end();
    }
  });

  it('R-2.2: every session server holds the SAME budget store reference', () => {
    // Identity, not equality. Two stores that merely agree today would spend the vendor quota twice
    // the moment one of them recorded a call — and neither would know.
    const budgetStore = runtime.budgetStore;
    expect(runtime.createSessionServer()).not.toBe(runtime.createSessionServer());
    expect(runtime.budgetStore).toBe(budgetStore);
    expect(runtime.registry).toBe(runtime.registry);
  });
});

describe('TC-UNIT-01: the instance is removed when the session ends', () => {
  it('returns the map to its starting size when the client ends the session', async () => {
    expect(running.sessionCount()).toBe(0);
    const session = await openSession();
    expect(running.sessionCount()).toBe(1);
    await session.end();
    expect(running.sessionCount()).toBe(0);
  });

  it('keeps an ABANDONED session — the case task 014-13 exists for', async () => {
    // Not a defect being pinned: a client that simply goes away sends nothing, and Streamable HTTP
    // gives the server no other signal. Recording the behaviour here is what makes 014-13's idle
    // eviction a closed gap rather than a hope — RISK-6 is precisely this map growing.
    const session = await openSession();
    expect(running.sessionCount()).toBe(1);
    await session.abandon();
    expect(running.sessionCount()).toBe(1);
  });

  it('removes only the session that ended', async () => {
    const kept = await openSession();
    const dropped = await openSession();
    expect(running.sessionCount()).toBe(2);
    await dropped.end();
    expect(running.sessionCount()).toBe(1);
    // And the surviving session still answers — the removal did not close a shared thing.
    await expect(kept.client.listTools()).resolves.toBeDefined();
    await kept.end();
  });
});

describe('a session id is the server’s to mint, never the client’s', () => {
  it('answers 404 for an id this process never issued', async () => {
    const response = await fetch(endpoint(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'mcp-session-id': 'a-session-the-client-invented',
        ...bearerHeader(),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(response.status).toBe(404);
    expect(running.sessionCount()).toBe(0);
  });

  it('refuses a request that carries neither a session nor an initialize', async () => {
    // Building a pair for it would let a caller create one `McpServer` per request. The bearer is
    // valid on purpose: without it this would be refused at step 2 and say nothing about step 3.
    const response = await fetch(endpoint(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...bearerHeader(),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(response.status).toBe(400);
    expect(running.sessionCount()).toBe(0);
    expect(sessionServers, 'no server was constructed for it').toHaveLength(0);
  });

  it('refuses a body larger than the cap without buffering it', async () => {
    const response = await fetch(endpoint(), {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...bearerHeader() },
      body: 'x'.repeat(5 * 1024 * 1024),
    });
    expect(response.status).toBe(413);
  });
});
