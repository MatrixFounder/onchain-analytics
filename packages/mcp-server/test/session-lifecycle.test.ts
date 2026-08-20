import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { CapabilityManifest } from '@onchain-intel/core';
import { DEFAULT_SESSION_IDLE_MS, DEFAULT_SESSION_MAX } from '../src/env.js';
import { createDiagnostics } from '../src/engine/diagnostics.js';
import { createDiagnosticsStore } from '../src/engine/diagnostics-store.js';
import {
  DEFAULT_MCP_PATH,
  startHttpTransport,
  type RunningHttpTransport,
} from '../src/transport/http.js';
import {
  assertIdleTimeoutClearsManifest,
  createSessionManager,
  type SessionEntry,
} from '../src/transport/session-manager.js';
import { createSqliteEngine, type SqliteEngine } from './helpers/sqlite-engine.js';
import { TEST_PRINCIPAL, acceptsTestToken, bearerHeader } from './helpers/test-auth.js';

/**
 * Task 014-13 — the session ceiling, idle eviction, and two concurrent requests in one session
 * (R-24, R-25, AC-30, AC-31).
 *
 * **No test here waits for real time.** The clock is a variable this file moves; the sweep is
 * called, not awaited on a timer. A suite that slept for the idle timeout would take fifteen minutes
 * and would still be measuring `setTimeout` rather than the eviction rule.
 *
 * **What closes RISK-6.** Task 014-10 shipped the two removal causes a client can signal and left a
 * PASSING test recording that an abandoned session survives — the map growing is exactly the risk.
 * TC-E2E-02 below is the other side of that test: the same abandonment, now swept.
 */

const NOW_START = 1_770_000_000_000;
let clock = NOW_START;

let harness: SqliteEngine;
let stderr: string[];
let running: RunningHttpTransport;
let builtServers: McpServer[];

/** Releases a tool call by name, so a test decides the ORDER two concurrent answers come back in. */
let gates: Map<string, () => void>;

/**
 * A session server with one tool whose answer a test holds open.
 *
 * The registry is not involved on purpose: R-25 is a statement about the transport and the session
 * instance, and routing a real capability through it would measure an adapter instead.
 */
function createGatedServer(): McpServer {
  const server = new McpServer({ name: 'session-lifecycle', version: '0.0.0-test' });
  server.registerTool(
    'echo',
    {
      description: 'answers with its own argument, once released',
      inputSchema: { value: z.string() },
    },
    async ({ value }: { value: string }) => {
      await new Promise<void>((resolve) => gates.set(value, resolve));
      return { content: [{ type: 'text' as const, text: value }] };
    },
  );
  builtServers.push(server);
  return server;
}

/**
 * Every transport this file raises, so `afterEach` closes them without a test having to remember —
 * including the cases that raise none, where reaching for a stale handle answered "Server is not
 * running" and hid two real assertions behind it.
 */
let raised: RunningHttpTransport[];

async function start(
  overrides: Partial<Parameters<typeof startHttpTransport>[0]> = {},
): Promise<RunningHttpTransport> {
  const transport = await startHttpTransport({
    createSessionServer: createGatedServer,
    authenticate: acceptsTestToken(),
    bind: '127.0.0.1',
    port: 0,
    now: () => clock,
    diagnostics: createDiagnostics({
      store: createDiagnosticsStore(harness.engine),
      now: () => clock,
      writeStderr: (line) => stderr.push(line),
    }),
    ...overrides,
  });
  raised.push(transport);
  return transport;
}

const endpoint = (): URL =>
  new URL(`http://127.0.0.1:${String(running.address.port)}${DEFAULT_MCP_PATH}`);

/** The raw `initialize` a client sends — used where a full `Client` would only add a stream. */
const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'probe', version: '1.0.0' },
  },
};

async function initializeRaw(): Promise<Response> {
  const response = await fetch(endpoint(), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...bearerHeader(),
    },
    body: JSON.stringify(INITIALIZE),
  });
  // The body is drained whatever the status: an unread stream holds the socket, and `close()` then
  // waits for a client with no reason to leave.
  await response.text();
  return response;
}

async function openSession(): Promise<{ client: Client; abandon: () => Promise<void> }> {
  const client = new Client({ name: 'session', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(endpoint(), {
    requestInit: { headers: bearerHeader() },
  });
  await client.connect(transport);
  // `close()` sends NOTHING to the server — the abandonment measured in `per-session-server.test.ts`.
  return { client, abandon: () => client.close() };
}

const diagnosticRows = (event: string): Record<string, unknown>[] =>
  harness.db.prepare('SELECT * FROM diagnostics WHERE event = ? ORDER BY id').all(event) as Record<
    string,
    unknown
  >[];

beforeEach(() => {
  clock = NOW_START;
  harness = createSqliteEngine();
  stderr = [];
  builtServers = [];
  gates = new Map();
  raised = [];
});

afterEach(async () => {
  for (const release of gates.values()) release();
  for (const transport of raised) await transport.close();
  harness.close();
});

describe('TC-E2E-01 / AC-30: the ceiling refuses with a declared class, never a timeout', () => {
  it('answers 503 with Retry-After and JSON-RPC -32000 on the N+1st session', async () => {
    running = await start({ sessionMax: 1 });
    const first = await openSession();

    const refused = await initializeRaw();
    expect(refused.status).toBe(503);
    // `Retry-After` is what makes the refusal actionable — AC-30 asks for a declared class, and a
    // status with no way to act on it is a timeout with better manners.
    expect(refused.headers.get('retry-after')).toBe(String(DEFAULT_SESSION_IDLE_MS / 1000));
    expect(refused.headers.get('content-type')).toContain('application/json');

    // Not 429: that would assert THIS caller called too often. The measured cause is the capacity of
    // the process across every principal.
    expect(refused.status).not.toBe(429);
    expect(running.sessionCount(), 'the live session was not evicted to admit the newcomer').toBe(
      1,
    );
    expect(builtServers, 'and no McpServer was constructed for the refused session').toHaveLength(
      1,
    );
    // And the ESTABLISHED session is untouched by a ceiling it is not applying for: the check runs
    // only where a new session would be created, which is what keeps a full process from refusing
    // the clients it already admitted.
    await expect(first.client.listTools()).resolves.toBeDefined();

    await first.client.close();
  });

  it('carries the same -32000 shape the perimeter and the auth refusals use', async () => {
    running = await start({ sessionMax: 1 });
    const first = await openSession();

    const response = await fetch(endpoint(), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        ...bearerHeader(),
      },
      body: JSON.stringify(INITIALIZE),
    });
    const body = (await response.json()) as { error: { code: number; message: string } };
    expect(body.error.code).toBe(-32000);
    expect(body.error.message).toBe('Session limit reached');
    // The live/max numbers are the process's capacity across every principal; this caller is one of
    // them and learns neither (R-20).
    expect(JSON.stringify(body)).not.toContain('"live"');
    expect(JSON.stringify(body)).not.toContain('"max"');

    await first.client.close();
  });

  it('admits the newcomer once a slot frees — the refusal is a state, not a latch', async () => {
    running = await start({ sessionMax: 1 });
    const first = await openSession();
    expect((await initializeRaw()).status).toBe(503);

    await first.client.close();
    // A client `close()` sends nothing; the DELETE is what frees the slot.
    const second = new Client({ name: 'second', version: '1.0.0' });
    const transport = new StreamableHTTPClientTransport(endpoint(), {
      requestInit: { headers: bearerHeader() },
    });
    // Still at the ceiling, because the abandoned session is still live and NOT idle yet.
    await expect(second.connect(transport)).rejects.toThrow();

    // Now it is idle, and the sweep that runs inside `admit` is what makes room.
    clock += DEFAULT_SESSION_IDLE_MS + 1;
    expect((await initializeRaw()).status).toBe(200);
    expect(running.sessionCount()).toBe(1);
  });

  it('TC-UNIT-04: the applied ceiling with no key set is 64, measured end to end', async () => {
    running = await start();
    for (let index = 0; index < DEFAULT_SESSION_MAX; index += 1) {
      expect((await initializeRaw()).status, `session ${String(index + 1)}`).toBe(200);
    }
    expect(running.sessionCount()).toBe(DEFAULT_SESSION_MAX);
    expect((await initializeRaw()).status).toBe(503);
  });
});

describe('TC-E2E-02 / AC-30: an abandoned session is evicted on the idle timeout', () => {
  it('sweeps the session a client walked away from', async () => {
    running = await start();
    const session = await openSession();
    expect(running.sessionCount()).toBe(1);

    await session.abandon();
    // Task 014-10's recorded behaviour: nothing reaches the server, so it still holds the session.
    expect(running.sessionCount()).toBe(1);

    clock += DEFAULT_SESSION_IDLE_MS;
    expect(await running.sessions.sweep(), 'still inside the timeout, to the millisecond').toEqual(
      [],
    );
    clock += 1;
    expect(await running.sessions.sweep()).toHaveLength(1);
    expect(running.sessionCount()).toBe(0);
  });

  it('TC-UNIT-04: the applied idle timeout with no key set is 900_000 ms', async () => {
    // Measured on the RUNNING transport rather than read off the constant: a default that lived only
    // in `env.ts` would say nothing about the number this listener applies.
    running = await start();
    await openSession();
    clock += 899_999;
    expect(await running.sessions.sweep()).toEqual([]);
    clock += 2;
    expect(await running.sessions.sweep()).toHaveLength(1);
    expect(DEFAULT_SESSION_IDLE_MS).toBe(900_000);
  });

  it('does NOT evict a session that keeps talking — every inbound message counts as traffic', async () => {
    running = await start();
    const session = await openSession();

    // Four steps past the timeout, each preceded by a request. A sweeper that only counted
    // `tools/call` would evict this client mid-conversation (§3.4.2).
    for (let step = 0; step < 4; step += 1) {
      clock += DEFAULT_SESSION_IDLE_MS - 1;
      await session.client.listTools();
      expect(await running.sessions.sweep()).toEqual([]);
    }
    expect(running.sessionCount()).toBe(1);
    await session.client.close();
  });
});

describe('TC-E2E-03: both rows are readable from onchain.diagnostics', () => {
  it('writes session.limit_reached and session.evicted, each naming its principal', async () => {
    running = await start({ sessionMax: 1 });
    const session = await openSession();

    // Condition one: the ceiling.
    expect((await initializeRaw()).status).toBe(503);
    // Condition two: the abandoned session.
    await session.abandon();
    clock += DEFAULT_SESSION_IDLE_MS + 1;
    const [evictedId] = await running.sessions.sweep();

    const limit = diagnosticRows('session.limit_reached');
    expect(limit).toHaveLength(1);
    // **The refused session has no id, and the row does not invent one.** It was never created; a
    // value in `session_id` would name something that does not exist. The caller is identified by
    // the token that presented itself, which is both true and the more actionable of the two — a
    // stated deviation from TC-E2E-03's wording, recorded in `session-manager.ts`.
    expect(limit[0]?.['session_id']).toBeNull();
    expect(limit[0]?.['principal_id']).toBe(TEST_PRINCIPAL.tokenId);
    expect(JSON.parse(String(limit[0]?.['detail_json']))).toStrictEqual({
      live: 1,
      max: 1,
      retryAfterSeconds: DEFAULT_SESSION_IDLE_MS / 1000,
    });

    const evicted = diagnosticRows('session.evicted');
    expect(evicted).toHaveLength(1);
    expect(evicted[0]?.['session_id']).toBe(evictedId);
    expect(evicted[0]?.['principal_id']).toBe(TEST_PRINCIPAL.tokenId);
    expect(JSON.parse(String(evicted[0]?.['detail_json']))).toMatchObject({
      cause: 'idle',
      idleMs: DEFAULT_SESSION_IDLE_MS,
    });

    // AC-48's other half: an administrator finds both without shell access, and stderr carries the
    // ids without the principal (R-5.3).
    expect(stderr.filter((line) => line.includes('event=session.'))).toHaveLength(2);
    expect(stderr.join('\n')).not.toContain(TEST_PRINCIPAL.tokenId);
  });
});

describe('TC-UNIT-01 / TC-UNIT-02 / AC-31: two concurrent requests in one session', () => {
  it('both complete, and the response order does not change their content', async () => {
    running = await start();
    const session = await openSession();
    const call = (value: string): Promise<unknown> =>
      session.client.callTool({ name: 'echo', arguments: { value } });

    const release = async (value: string): Promise<void> => {
      // The handler registers its gate asynchronously; wait for it rather than guessing a delay.
      for (let attempt = 0; attempt < 200 && !gates.has(value); attempt += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      gates.get(value)?.();
    };

    // First ordering: the SECOND request is answered first.
    const forward = [call('alpha'), call('beta')];
    await release('beta');
    await release('alpha');
    const first = (await Promise.all(forward)) as { content: { text: string }[] }[];
    expect(first[0]?.content[0]?.text).toBe('alpha');
    expect(first[1]?.content[0]?.text).toBe('beta');

    // Reverse ordering, same session, same instance: content follows the request, not the clock.
    const reverse = [call('gamma'), call('delta')];
    await release('gamma');
    await release('delta');
    const second = (await Promise.all(reverse)) as { content: { text: string }[] }[];
    expect(second[0]?.content[0]?.text).toBe('gamma');
    expect(second[1]?.content[0]?.text).toBe('delta');

    // One session throughout — neither request opened a second one.
    expect(running.sessionCount()).toBe(1);
    await session.client.close();
  });
});

describe('the manager, without a listener', () => {
  const closed = { server: 0, transport: 0 };
  const entry = (): Pick<SessionEntry, 'server' | 'transport' | 'principalId'> => ({
    server: {
      close: () => {
        closed.server += 1;
        return Promise.resolve();
      },
    } as unknown as McpServer,
    transport: {
      close: () => {
        closed.transport += 1;
        return Promise.resolve();
      },
    } as unknown as StreamableHTTPServerTransport,
    principalId: TEST_PRINCIPAL.tokenId,
  });

  beforeEach(() => {
    closed.server = 0;
    closed.transport = 0;
  });

  const manager = (max = 4): ReturnType<typeof createSessionManager> =>
    createSessionManager({ max, idleMs: DEFAULT_SESSION_IDLE_MS, now: () => clock });

  it('TC-UNIT-03: eviction releases BOTH halves — the McpServer and the transport', async () => {
    const sessions = manager();
    sessions.register('s1', entry());
    clock += DEFAULT_SESSION_IDLE_MS + 1;
    expect(await sessions.sweep()).toEqual(['s1']);
    expect(closed).toStrictEqual({ server: 1, transport: 1 });
    expect(sessions.size()).toBe(0);
  });

  it('evicts only what is past the timeout, and the survivor keeps its own last-seen', async () => {
    const sessions = manager();
    sessions.register('old', entry());
    clock += DEFAULT_SESSION_IDLE_MS;
    sessions.register('new', entry());
    clock += 1;
    expect(await sessions.sweep()).toEqual(['old']);
    expect(sessions.get('new')).toBeDefined();
    expect(sessions.size()).toBe(1);
  });

  it('touch moves last-seen forward, and an unknown id is silent', () => {
    const sessions = manager();
    const registered = sessions.register('s1', entry());
    expect(registered.lastSeenAtMs).toBe(clock);
    clock += 5_000;
    sessions.touch('s1');
    expect(sessions.get('s1')?.lastSeenAtMs).toBe(clock);
    expect(sessions.get('s1')?.createdAtMs).toBe(clock - 5_000);
    // A request for an id this process never issued is a 404 upstream; touching it must not create
    // an entry a client chose the name of.
    sessions.touch('an-id-the-client-invented');
    expect(sessions.size()).toBe(1);
  });

  it('a failed close does not stop the sweep, and the failure is named on the row', async () => {
    const emitted: { event: string; detail: Record<string, unknown> }[] = [];
    const sessions = createSessionManager({
      max: 4,
      idleMs: DEFAULT_SESSION_IDLE_MS,
      now: () => clock,
      diagnostics: {
        emit: (event, detail) => {
          emitted.push({ event, detail: detail.detail });
          return Promise.resolve('01JEMITTED0000000000000000');
        },
      },
    });
    sessions.register('bad', {
      ...entry(),
      transport: {
        close: () => Promise.reject(new Error('socket already gone')),
      } as unknown as StreamableHTTPServerTransport,
    });
    sessions.register('good', entry());
    clock += DEFAULT_SESSION_IDLE_MS + 1;

    expect(await sessions.sweep()).toEqual(['bad', 'good']);
    expect(sessions.size()).toBe(0);
    expect(emitted[0]?.detail['closeError']).toBe('socket already gone');
    expect(emitted[1]?.detail).not.toHaveProperty('closeError');
  });

  it('admit sweeps BEFORE it counts — an abandoned session cannot deny service', async () => {
    const sessions = manager(1);
    sessions.register('abandoned', entry());
    expect((await sessions.admit(TEST_PRINCIPAL.tokenId)).ok).toBe(false);
    clock += DEFAULT_SESSION_IDLE_MS + 1;
    expect((await sessions.admit(TEST_PRINCIPAL.tokenId)).ok).toBe(true);
    expect(sessions.size()).toBe(0);
  });

  it('the sweeper timer is unref’d, and it sweeps when it fires', async () => {
    const handles: NodeJS.Timeout[] = [];
    let tick: (() => void) | undefined;
    const sessions = createSessionManager({
      max: 4,
      idleMs: DEFAULT_SESSION_IDLE_MS,
      now: () => clock,
      createTimer: (fire, intervalMs) => {
        tick = fire;
        const handle = setInterval(fire, intervalMs);
        handles.push(handle);
        return handle;
      },
    });
    // The `unref` is the MANAGER's line, not the injected factory's — a periodic sweep that held the
    // event loop would stop the process exiting after the listener closes (§3.4.2).
    expect(handles[0]?.hasRef()).toBe(false);
    sessions.register('s1', entry());
    clock += DEFAULT_SESSION_IDLE_MS + 1;
    tick?.();
    await new Promise((resolve) => setImmediate(resolve));
    expect(sessions.size()).toBe(0);
    await sessions.shutdown();
  });

  it('sweeps at a quarter of the idle timeout, so an entry outlives its deadline by at most that', () => {
    const intervals: number[] = [];
    createSessionManager({
      max: 4,
      idleMs: 900_000,
      now: () => clock,
      createTimer: (fire, intervalMs) => {
        intervals.push(intervalMs);
        return setInterval(fire, intervalMs);
      },
    });
    expect(intervals[0]).toBe(225_000);
  });

  it('forget releases the McpServer — the DELETE path, where the transport is already closing', async () => {
    const sessions = manager();
    sessions.register('s1', entry());
    sessions.forget('s1');
    expect(sessions.size()).toBe(0);
    await new Promise((resolve) => setImmediate(resolve));
    // Only the server: the SDK closed the stream, and this is the half that would otherwise be
    // leaked on every ordinary session end — RISK-6 arriving through the tidy door.
    expect(closed).toStrictEqual({ server: 1, transport: 0 });
  });

  it('shutdown closes every live session', async () => {
    const sessions = manager();
    sessions.register('s1', entry());
    sessions.register('s2', entry());
    await sessions.shutdown();
    expect(sessions.size()).toBe(0);
    expect(closed).toStrictEqual({ server: 2, transport: 2 });
  });

  it('shutdown stops the sweeper — no tick after it returns', async () => {
    // Real milliseconds, and deliberately: the claim is about a TIMER, and a fake clock would prove
    // it about something else. Fifteen of them, not fifteen minutes.
    let ticks = 0;
    const sessions = createSessionManager({
      max: 4,
      idleMs: DEFAULT_SESSION_IDLE_MS,
      now: () => clock,
      sweepIntervalMs: 1,
      createTimer: (fire, intervalMs) =>
        setInterval(() => {
          ticks += 1;
          fire();
        }, intervalMs),
    });
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(ticks, 'the sweeper was running before shutdown').toBeGreaterThan(0);

    await sessions.shutdown();
    const atShutdown = ticks;
    await new Promise((resolve) => setTimeout(resolve, 15));
    expect(ticks).toBe(atShutdown);
  });
});

describe('TC-UNIT-05 / TC-UNIT-06: the startup assertion against the manifest', () => {
  it('passes at the applied 900_000 and refuses at 60_000, naming both numbers', () => {
    // Measured 2026-08-12: `max(deadlineMs) = 60_000` over all 26 rows of the shipped manifest.
    expect(() => {
      assertIdleTimeoutClearsManifest(DEFAULT_SESSION_IDLE_MS);
    }).not.toThrow();
    expect(() => {
      assertIdleTimeoutClearsManifest(60_000);
    }).toThrow(/60000/);
    try {
      assertIdleTimeoutClearsManifest(60_000);
      expect.unreachable('the equal case is not a clearance');
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      expect(message).toContain('60000 ms');
      // Both numbers, and the capability that produced the larger one: an operator reading only
      // "too low" has to go and find which row moved.
      expect(message).toMatch(/\b60000\b.*\b60000\b/s);
      expect(message).toMatch(/\((?!\))[a-z_.]+\)/);
    }
  });

  it('TC-UNIT-06: it reads the MANIFEST, not a constant copied out of it', () => {
    const slow: Record<string, CapabilityManifest> = {
      'probe.slow': { shape: 'point', ttlSeconds: 60, deadlineMs: 1_800_000, shareable: true },
    };
    // The applied timeout clears every shipped row and still fails against this one — which is the
    // whole point: a row raised above the timeout has to fail the check, and it cannot if the number
    // was frozen when the check was written.
    expect(() => {
      assertIdleTimeoutClearsManifest(DEFAULT_SESSION_IDLE_MS, slow);
    }).toThrow(/1800000/);
    expect(() => {
      assertIdleTimeoutClearsManifest(1_800_001, slow);
    }).not.toThrow();
  });

  it('the transport refuses to bind on a violating timeout, before it builds anything', async () => {
    let built = 0;
    await expect(
      startHttpTransport({
        createSessionServer: () => {
          built += 1;
          return createGatedServer();
        },
        authenticate: acceptsTestToken(),
        bind: '127.0.0.1',
        port: 0,
        sessionIdleMs: 60_000,
      }),
    ).rejects.toThrow(/ONCHAIN_SESSION_IDLE_MS/);
    // Nothing was constructed, and nothing was bound: the assertion runs before both.
    expect(built).toBe(0);
    expect(raised).toHaveLength(0);
  });
});
