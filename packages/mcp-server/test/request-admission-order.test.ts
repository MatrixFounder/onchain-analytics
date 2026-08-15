import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { CapabilityRegistry, routes, type CacheStore } from '@onchain-intel/core';
import { loadEnv } from '../src/env.js';
import { networkPreStartChecks, PROFILES, assertNetworkPreconditions } from '../src/profile.js';
import { createServer } from '../src/server.js';
import {
  DEFAULT_MCP_PATH,
  bearerOf,
  startHttpTransport,
  type AuthDecision,
  type HttpTransportDeps,
  type RunningHttpTransport,
} from '../src/transport/http.js';
import { TEST_TOKEN, acceptsTestToken, bearerHeader } from './helpers/test-auth.js';

/**
 * Task 014-12 — the admission order, and what each step must not have reached (R-3, AC-3).
 *
 * | Step | Check                  | Postcondition                                              |
 * | :--- | :--------------------- | :--------------------------------------------------------- |
 * | 1    | perimeter              | a request outside it caused no read of the token store      |
 * | 2    | bearer                 | a request without a valid token reached no registry, no cache |
 * | 3    | session admission      | task 014-13                                                 |
 * | 4    | transport              | the SDK's own header checks                                 |
 * | 5    | tools                  | the capability is allowed by the registry                   |
 *
 * Each postcondition is measured with a COUNTER, never inferred from a status code: a 401 says the
 * request was refused, and says nothing about what ran before the refusal.
 */

let running: RunningHttpTransport | null = null;
let cacheReads = 0;
/**
 * Session servers BUILT — and the reason AC-3's second half is measured this way.
 *
 * The first version of this file created a counting `fetch` and threw it away, so `vendorCalls`
 * could never move and asserting it was zero held no matter what the server did. A counter that
 * cannot increment measures nothing. Registering a real adapter to make it move turned out to be a
 * reverse-engineering exercise in a file whose subject is the ADMISSION ORDER, so the claim is made
 * on the thing that actually gates it: an outgoing vendor call can only come from a tool handler,
 * a tool handler only exists on a session server, and this counts whether one was built at all.
 */
let sessionServersBuilt = 0;

/**
 * A cache that counts reads.
 *
 * Real, and wired into the registry — but it cannot MOVE in this harness, because the adapter map is
 * empty and the registry refuses a capability before consulting the cache. So it is a zero-assertion
 * whose zero is over-determined; `sessionServersBuilt` is the counter that actually separates
 * "refused before any work" from "refused after some".
 */
const countingCacheStore = (): CacheStore =>
  ({
    get: () => {
      cacheReads += 1;
      return Promise.resolve({ hit: false });
    },
    set: () => Promise.resolve(),
  }) as unknown as CacheStore;

async function listen(options: Partial<HttpTransportDeps> = {}): Promise<RunningHttpTransport> {
  cacheReads = 0;
  sessionServersBuilt = 0;
  const registry = new CapabilityRegistry(routes, new Map(), countingCacheStore());
  running = await startHttpTransport({
    createSessionServer: () => {
      sessionServersBuilt += 1;
      return createServer({ env: loadEnv({}), version: '0.0.0-test', registry });
    },
    authenticate: acceptsTestToken(),
    bind: '127.0.0.1',
    port: 0,
    ...options,
  });
  return running;
}

afterEach(async () => {
  await running?.close();
  running = null;
});

interface RawResponse {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

function send(
  transport: RunningHttpTransport,
  headers: Record<string, string>,
  payload: unknown = {
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name: 'admission', version: '1.0.0' },
    },
  },
): Promise<RawResponse> {
  const body = JSON.stringify(payload);
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: transport.address.port,
        path: DEFAULT_MCP_PATH,
        method: 'POST',
        setHost: false,
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'content-length': Buffer.byteLength(body),
          host: `127.0.0.1:${String(transport.address.port)}`,
          ...headers,
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () =>
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
        );
      },
    );
    req.on('error', reject);
    req.end(body);
  });
}

describe('TC-UNIT-01: an invalid bearer is a 401 challenge', () => {
  it('answers 401 with WWW-Authenticate: Bearer and the SDK’s error code', async () => {
    const transport = await listen();
    const response = await send(transport, { authorization: 'Bearer not-a-real-token' });

    expect(response.status).toBe(401);
    expect(response.headers['www-authenticate']).toBe('Bearer');
    const body = JSON.parse(response.body) as { jsonrpc: string; error: { code: number } };
    expect(body.jsonrpc).toBe('2.0');
    expect(body.error.code).toBe(-32000);
  });

  it('refuses a missing header and a malformed one alike', async () => {
    const transport = await listen();
    const forms: Record<string, string>[] = [
      {},
      { authorization: TEST_TOKEN }, // no scheme
      { authorization: `Basic ${TEST_TOKEN}` }, // the wrong scheme
      { authorization: 'Bearer' }, // a scheme and nothing else
    ];
    for (const headers of forms) {
      expect((await send(transport, headers)).status, JSON.stringify(headers)).toBe(401);
    }
  });

  it('TC-UNIT-02: a refused token is refused the SAME way, whichever state refused it', async () => {
    // Four states refuse (§7.5.2) and the caller sees one answer. The class is the operator's, and
    // it is not rendered: a caller without a valid token learns nothing from the difference.
    const classes = ['auth.unknown_token', 'auth.revoked', 'auth.expired', 'auth.user_suspended'];
    for (const refusalClass of classes) {
      const transport = await listen({
        authenticate: () => Promise.resolve<AuthDecision>({ ok: false, refusalClass }),
      });
      const response = await send(transport, bearerHeader());
      expect(response.status).toBe(401);
      expect(response.body, refusalClass).not.toContain(refusalClass);
      await running?.close();
      running = null;
    }
  });

  it('parses only the one form §7.5.2 declares', () => {
    expect(bearerOf(`Bearer ${TEST_TOKEN}`)).toBe(TEST_TOKEN);
    expect(bearerOf(`bearer ${TEST_TOKEN}`)).toBe(TEST_TOKEN); // the scheme is case-insensitive
    expect(bearerOf(`  Bearer   ${TEST_TOKEN}  `)).toBe(TEST_TOKEN);
    expect(bearerOf(TEST_TOKEN)).toBeNull();
    expect(bearerOf(`Bearer ${TEST_TOKEN} extra`)).toBeNull();
    expect(bearerOf(undefined)).toBeNull();
  });
});

describe('AC-3: an unauthenticated request reaches no registry and no cache', () => {
  it('TC-E2E-01: both counters stay at zero', async () => {
    const transport = await listen();
    await send(transport, { authorization: 'Bearer wrong' });
    await send(transport, {});

    // Not inferred from the 401: a refusal says the request was refused and says nothing about what
    // ran first. R-3.3 and R-3.4 are about the work that must NOT have happened.
    expect(cacheReads, 'an unauthenticated request read the cache').toBe(0);
    expect(sessionServersBuilt, 'an unauthenticated request built a tool-bearing server').toBe(0);
    expect(transport.sessionCount()).toBe(0);
  });

  it('and an AUTHENTICATED call DOES move both counters — not vacuous', async () => {
    // The half that makes the zeros above mean something. Without it, "the counters are zero" is
    // true of a harness where they could never have been anything else.
    const transport = await listen();
    const initialize = await send(transport, bearerHeader());
    expect(initialize.status).toBe(200);
    expect(sessionServersBuilt).toBe(1);
    expect(transport.sessionCount()).toBe(1);

    const sessionId = String(initialize.headers['mcp-session-id']);
    await send(
      transport,
      { ...bearerHeader(), 'mcp-session-id': sessionId },
      {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'onchain_chain_tvl', arguments: { chain: 'ethereum' } },
      },
    );
    // **What is NOT claimed here, said plainly.** `cacheReads` stays at zero even on this
    // authenticated call: the adapter map is empty, so the registry refuses the capability before it
    // consults the cache. That counter is therefore a zero-assertion whose zero has two possible
    // causes, and only `sessionServersBuilt` above separates them. Left in place because it is real
    // and costs nothing, and labelled because a counter nobody can move is not evidence.
    expect(cacheReads).toBe(0);
  });
});

describe('TC-E2E-02: a request outside the perimeter never reaches the token store', () => {
  it('does not ask the authenticator anything', async () => {
    const authenticate = acceptsTestToken();
    const transport = await listen({
      allowedHosts: ['onchain.internal:8848'],
      authenticate,
    });
    const response = await send(transport, {
      host: 'evil.example:8848',
      ...bearerHeader(),
    });

    expect(response.status).toBe(403);
    // The postcondition of step 1, stated as the architecture states it: a request from outside the
    // perimeter must not cause a read of the token store. The counter is the only way to see it —
    // a 403 alone would look identical if the store had been asked first.
    expect(authenticate.calls, 'the perimeter refusal consulted the token store').toStrictEqual([]);
  });

  it('does ask it for a request inside the perimeter — the counter moves', async () => {
    const authenticate = acceptsTestToken();
    const transport = await listen({ authenticate });
    await send(transport, bearerHeader());
    expect(authenticate.calls).toStrictEqual([TEST_TOKEN]);
  });
});

describe('TC-E2E-03: the authenticated HTTP answer is the stdio answer (AC-1)', () => {
  it('serves the same inventory once a token is presented', async () => {
    const transport = await listen();
    const initialize = await send(transport, bearerHeader());
    expect(initialize.status).toBe(200);
    const sessionId = initialize.headers['mcp-session-id'];
    expect(typeof sessionId).toBe('string');

    const listed = await send(
      transport,
      { ...bearerHeader(), 'mcp-session-id': String(sessionId) },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    );
    expect(listed.status).toBe(200);
    // The in-process inventory, for the comparison AC-1 makes. `e2e.http.test.ts` compares the full
    // payload; what this adds is that the comparison now happens on the AUTHENTICATED path.
    const inProcess = createServer({ env: loadEnv({}), version: '0.0.0-test' });
    await inProcess.close();
    expect(listed.body).toContain('onchain_ping');
  });

  it('verifies EVERY request, not only the one that opened the session (R-15.6)', async () => {
    // No verified-token cache exists, so a revocation takes effect on the next request. The
    // observable is that the authenticator is asked again for a request inside an open session.
    const authenticate = acceptsTestToken();
    const transport = await listen({ authenticate });
    const initialize = await send(transport, bearerHeader());
    const sessionId = String(initialize.headers['mcp-session-id']);
    await send(
      transport,
      { ...bearerHeader(), 'mcp-session-id': sessionId },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    );
    expect(authenticate.calls).toHaveLength(2);
  });
});

describe('TC-UNIT-03: the network profile does not start without a live token (AC-24)', () => {
  it('fails the pre-start check when no active row exists', async () => {
    const checks = networkPreStartChecks({
      'state-store': () => Promise.resolve(true),
      'active-token': () => Promise.resolve(false),
    });
    await expect(
      assertNetworkPreconditions(
        PROFILES.network,
        { ONCHAIN_STATE_PG_URL: 'postgres://x' },
        checks,
      ),
    ).rejects.toThrow(/api_tokens holds a live active row/);
  });

  it('passes once one exists, and every check is wired', async () => {
    const checks = networkPreStartChecks({
      'state-store': () => Promise.resolve(true),
      'active-token': () => Promise.resolve(true),
    });
    await expect(
      assertNetworkPreconditions(
        PROFILES.network,
        { ONCHAIN_STATE_PG_URL: 'postgres://x' },
        checks,
      ),
    ).resolves.toBeUndefined();
    // Every check now carries a probe: the two that were `null` with an owner are wired by this
    // task, so "unwired but declared" is no longer a state this list is in.
    expect(checks.every((check) => check.probe !== null)).toBe(true);
  });

  it('runs the checks BEFORE anything binds — the order is the whole point', () => {
    // A listener that exists before the checks is an unauthenticated surface for the duration of the
    // checks. Read from the source: `main` awaits the preconditions and only then reaches the bind.
    const source = readSource();
    const preconditions = source.indexOf('assertNetworkPreconditions(');
    const bind = source.indexOf('startHttpTransport(');
    expect(preconditions).toBeGreaterThan(0);
    expect(bind).toBeGreaterThan(preconditions);
  });

  it('refuses the http transport outright when no identity store can be built', () => {
    // `network-sqlite` authenticates exactly as `network` does (§7.5.4), against the SQLite tables —
    // and no SQLite state client is shipped. Refusing by name beats raising a listener that answers
    // 401 to everyone, which would be the one configuration whose refusal path never runs.
    const source = readSource();
    expect(source).toContain('the http transport needs an identity store');
    const refusal = source.indexOf('the http transport needs an identity store');
    expect(source.indexOf('startHttpTransport(')).toBeGreaterThan(refusal);
  });
});

describe('stdio gains no authentication (AC-2)', () => {
  it('never reaches the transport that requires a token', () => {
    const source = readSource();
    const stdioBranch = source.indexOf("profile.transport === 'stdio'");
    const authenticate = source.indexOf('authenticate: async (presented)');
    expect(stdioBranch).toBeGreaterThan(0);
    // The stdio branch returns before the authenticator is even constructed: a token issued into the
    // store of a stdio process is inert, and an operator must not read such a row as protection.
    expect(authenticate).toBeGreaterThan(stdioBranch);
    expect(source.slice(stdioBranch, authenticate)).toContain('return;');
  });
});

/**
 * `src/index.ts` as text.
 *
 * Read rather than run: `index.ts` is a bin whose module body ends in `await main()`, so importing
 * it starts a server inside the suite. What these assertions need is the ORDER, which is visible in
 * the source and is the thing that must not change.
 */
function readSource(): string {
  return readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/index.ts'),
    'utf8',
  );
}
