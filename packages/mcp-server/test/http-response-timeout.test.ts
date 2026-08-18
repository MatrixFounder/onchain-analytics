import { readFileSync } from 'node:fs';
import { request as httpRequest } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CapabilityRegistry, routes } from '@onchain-intel/core';
import { STDIO_PRINCIPAL } from '../src/auth/principal.js';
import { DEFAULT_HTTP_RESPONSE_TIMEOUT_MS, DEFAULT_SESSION_IDLE_MS } from '../src/env.js';
import { defineTool } from '../src/tools/registry.js';
import {
  DEFAULT_MCP_PATH,
  assertResponseTimeoutFitsIdle,
  startHttpTransport,
  type RunningHttpTransport,
} from '../src/transport/http.js';
import { TEST_TOKEN, TEST_PRINCIPAL, bearerHeader } from './helpers/test-auth.js';

/**
 * Task 014-23 — the server's own response clock (R-16.3, `ONCHAIN_HTTP_RESPONSE_TIMEOUT_MS`).
 *
 * **Two clocks for two cases.** `deadlineMs` bounds what a call may SPEND; this bounds how long one
 * response may stay open. A client that never closes its request would otherwise hold a session slot
 * until the idle sweeper takes it — and the sweeper is the bigger hammer, because it closes the
 * session's `McpServer` and every stream it owns.
 *
 * **The property that matters most is the one it does NOT do.** Closing the response does not cancel
 * the call (`interfaces.md` §5.4.5, R-17): a paid call the vendor accepted runs to completion, its
 * result is cached and `usage` records the spend. Cancelling would throw away an answer the credits
 * were already spent on, which is the trade task 014-24 exists to refuse. The case below holds the
 * handler open ACROSS the timeout and then measures that it still finished.
 */

let running: RunningHttpTransport | undefined;

afterEach(async () => {
  await running?.close();
  running = undefined;
});

/** A tool that answers only when the test lets it. */
function slowServer(gate: Promise<void>, finished: { value: boolean }): McpServer {
  const spec = defineTool({
    name: 'onchain_slow',
    title: 'Slow',
    description: 'answers when the test says so',
    inputSchema: z.object({}),
    outputSchema: z.object({ done: z.boolean() }),
    capability: null,
    needs: [],
    handler: async () => {
      await gate;
      finished.value = true;
      return { ok: true as const, output: { done: true } };
    },
  });
  const server = new McpServer({ name: 'response-timeout', version: '0.0.0-test' });
  spec.register(server, {
    version: '0.0.0-test',
    registry: new CapabilityRegistry(routes, new Map()),
    principal: STDIO_PRINCIPAL,
  });
  return server;
}

interface RawOutcome {
  readonly ended: boolean;
  readonly error?: string;
  readonly sessionId?: string;
}

/** Sends one request and reports how the SOCKET ended, which is what a closed response looks like. */
function raw(transport: RunningHttpTransport, body: string, headers: Record<string, string> = {}) {
  return new Promise<RawOutcome>((resolve) => {
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
          ...bearerHeader(),
          ...headers,
        },
      },
      (response) => {
        const issued = response.headers['mcp-session-id'];
        const sessionId = typeof issued === 'string' ? { sessionId: issued } : {};
        response.on('data', () => undefined);
        response.on('end', () => resolve({ ended: true, ...sessionId }));
        response.on('error', (error: Error) =>
          resolve({ ended: false, error: error.message, ...sessionId }),
        );
      },
    );
    req.on('error', (error: Error) => resolve({ ended: false, error: error.message }));
    req.end(body);
  });
}

const INITIALIZE = JSON.stringify({
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'probe', version: '1.0.0' },
  },
});

describe('TC-UNIT-03: a silent tool has its RESPONSE closed, and keeps running', () => {
  it('the connection ends on the server’s clock and the handler still completes', async () => {
    let open = (): void => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const finished = { value: false };

    running = await startHttpTransport({
      createSessionServer: () => slowServer(gate, finished),
      authenticate: (presented) =>
        Promise.resolve(
          presented === TEST_TOKEN
            ? { ok: true, principal: TEST_PRINCIPAL }
            : { ok: false, refusalClass: 'auth.unknown_token' },
        ),
      bind: '127.0.0.1',
      port: 0,
      // 60 ms against the shipped 900 000 ms idle: the ordering assertion is satisfied and no test
      // waits on a real production number.
      responseTimeoutMs: 60,
    });

    const opened = await raw(running, INITIALIZE);
    // Without the issued id the next POST is answered 404 and no handler runs — the case would then
    // measure a session lookup rather than a response clock. It went green that way once.
    expect(opened.sessionId, 'no session id was issued').toBeTypeOf('string');

    // The tool call: the handler parks on `gate`, so the only thing that can end this response is
    // the server's own clock.
    const call = raw(
      running,
      JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'onchain_slow', arguments: {} },
      }),
      { 'mcp-session-id': String(opened.sessionId) },
    );

    const outcome = await call;
    // The socket is gone — ended without a complete answer, or reset outright. Either is what a
    // destroyed response looks like from a client; asserting the exact one would be asserting
    // Node's socket teardown rather than our timeout.
    expect(outcome.ended || outcome.error !== undefined).toBe(true);
    // NOT cancelled: the handler was still parked when the response died.
    expect(finished.value, 'the call was cancelled with the response').toBe(false);

    open();
    // A real tick rather than a microtask: the handler resumes, the `defineTool` wrapper runs its
    // whole tail after it, and only then is `finished` observable.
    await new Promise((resolve) => setTimeout(resolve, 25));
    // R-17, and the whole reason this timeout closes a response rather than aborting a call: the
    // work the credits were spent on finished, and a retry would be served from what it left behind.
    expect(finished.value, 'the call did not run to completion').toBe(true);
  });
});

describe('the setting reaches the transport in PRODUCTION, not only in a test', () => {
  it('`index.ts` hands the resolved value to `startHttpTransport`', () => {
    // Found by mutation: deleting the argument from `index.ts` left every case above green, because
    // each of them raises its own transport and passes its own number. A setting parsed, floored,
    // defaulted and then dropped on the floor is the shape this task was written to remove — it is
    // literally what `void httpResponseTimeoutMs;` was before this task.
    const source = readFileSync(
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/index.ts'),
      'utf8',
    )
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');

    expect(source).toContain('responseTimeoutMs: httpResponseTimeoutMs');
    // And the placeholder that stood there is gone rather than commented out.
    expect(source).not.toMatch(/void\s+httpResponseTimeoutMs/);
  });
});

describe('the two operator clocks are ordered, or the weaker one never runs', () => {
  it('the shipped defaults are ordered', () => {
    // 900 000 idle against 360 000 response: the gentler mechanism fires first.
    expect(DEFAULT_SESSION_IDLE_MS).toBeGreaterThan(DEFAULT_HTTP_RESPONSE_TIMEOUT_MS);
    expect(() =>
      assertResponseTimeoutFitsIdle(DEFAULT_HTTP_RESPONSE_TIMEOUT_MS, DEFAULT_SESSION_IDLE_MS),
    ).not.toThrow();
  });

  it('an inverted pair refuses at start, naming both numbers', () => {
    // Configured the other way round the sweeper always wins: it closes the session — transport,
    // `McpServer` and every stream it owns — so the response timeout becomes a setting that never
    // runs, and the client's retry has to `initialize` again.
    const thrown = (): void => {
      assertResponseTimeoutFitsIdle(900_000, 360_000);
    };
    expect(thrown).toThrow(/never run/);
    expect(thrown).toThrow(/360000/);
    expect(thrown).toThrow(/900000/);
  });

  it('equality refuses too, because at equality the runtime picks the winner', () => {
    expect(() => assertResponseTimeoutFitsIdle(500_000, 500_000)).toThrow(/never run/);
  });

  it('and the transport cannot be raised on an inverted pair', async () => {
    // The assertion lives inside `startHttpTransport`, before anything is bound — the same
    // discipline task 014-13 applied to the idle timeout, and for the same reason: a check a caller
    // can skip is a check some caller will.
    await expect(
      startHttpTransport({
        createSessionServer: () => slowServer(Promise.resolve(), { value: false }),
        authenticate: () => Promise.resolve({ ok: false, refusalClass: 'auth.unknown_token' }),
        bind: '127.0.0.1',
        port: 0,
        sessionIdleMs: 100_000,
        responseTimeoutMs: 200_000,
      }),
    ).rejects.toThrow(/never run/);
  });
});
