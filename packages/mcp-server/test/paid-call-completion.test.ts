import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { CapabilityRegistry, routes } from '@onchain-intel/core';
import { STDIO_PRINCIPAL } from '../src/auth/principal.js';
import { createRequestTraceStore } from '../src/engine/request-trace-store.js';
import { defineTool, type ToolContext } from '../src/tools/registry.js';
import { createSqliteEngine, type SqliteEngine } from './helpers/sqlite-engine.js';

/**
 * Task 014-24 — a paid call the vendor accepted runs to completion (R-17, AC-27).
 *
 * **The property already held, and that is precisely why it needs a test.** Measured before this
 * task: no `AbortSignal` was declared, forwarded or read anywhere between the tool boundary and
 * `safeFetch`, so a client that disconnected mid-call changed nothing — the handler finished, wrote
 * its cache entry, reconciled its spend and appended its trace row, and only the delivery failed.
 * It held by the ABSENCE of wiring. The first person to thread a signal through for a good-looking
 * reason would have taken it away with nothing going red, so the absence is pinned here as a rule.
 *
 * **Why cancelling would be wrong rather than merely different.** Credits are spent the moment the
 * vendor ACCEPTS the call. Cancelling on our side does not return them; it discards an answer that
 * was already paid for, and the next caller pays again for the same one.
 */

let harness: SqliteEngine;

beforeEach(() => {
  harness = createSqliteEngine();
});

afterEach(() => {
  harness.close();
});

const rows = (): Record<string, unknown>[] =>
  harness.db.prepare('SELECT * FROM request_trace').all() as Record<string, unknown>[];

/** A tool whose handler parks until the test releases it, recording that it finished. */
function gatedServer(
  gate: Promise<void>,
  finished: { value: boolean },
  extra: Partial<ToolContext> = {},
): McpServer {
  const spec = defineTool({
    name: 'onchain_gated',
    title: 'Gated',
    description: 'finishes when the test says so',
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
  const server = new McpServer({ name: 'paid-call-completion', version: '0.0.0-test' });
  spec.register(server, {
    version: '0.0.0-test',
    registry: new CapabilityRegistry(routes, new Map()),
    principal: STDIO_PRINCIPAL,
    ...extra,
  });
  return server;
}

describe('TC-E2E-01 / AC-27: a call in flight is not cancelled by a lost client', () => {
  it('finishes and leaves its trace row after the client is gone', async () => {
    let open = (): void => {};
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const finished = { value: false };

    const server = gatedServer(gate, finished, {
      requestTrace: createRequestTraceStore(harness.engine),
    });
    const client = new Client({ name: 'gone', version: '1.0.0' });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    // Not awaited: the client leaves while the handler is parked.
    const call = client.callTool({ name: 'onchain_gated', arguments: {} }).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(finished.value, 'the handler should still be parked').toBe(false);

    await client.close();
    open();
    await call;
    await new Promise((resolve) => setTimeout(resolve, 25));

    // The work finished — which is what makes the credits already spent worth something.
    expect(finished.value, 'the call was cancelled with the client').toBe(true);
    // And the ledger recorded it. T-015 charges from this table; a row lost because nobody was
    // listening would make the spend visible only as an anonymous `usage` counter.
    expect(rows()).toHaveLength(1);
    expect(rows()[0]?.['tool']).toBe('onchain_gated');
    expect(rows()[0]?.['outcome']).toBe('answer');

    await server.close();
  });
});

describe('TC-UNIT-01: a call not yet started at the abort is not started', () => {
  /**
   * **Driven through the registered callback, not through a client — and the first version of this
   * case was wrong for exactly that reason.** Handing `client.callTool` an already-aborted signal
   * makes the SDK reject CLIENT-side: the request never leaves, the handler never runs, and no row
   * is written — so the case went green with the boundary check disabled. It measured the SDK's
   * client, not this wrapper. Mutation is what said so.
   *
   * The other half — that a real transport close reaches `extra.signal` at all — is the SDK's own
   * behaviour (`protocol.js` aborts a request's controller on `_onclose`), and is asserted
   * structurally below rather than re-derived here.
   */
  function captureHandler(finished: {
    value: boolean;
  }): (input: Record<string, never>, extra: { signal?: AbortSignal }) => Promise<unknown> {
    let captured: ((input: Record<string, never>, extra: unknown) => Promise<unknown>) | undefined;
    const spec = defineTool({
      name: 'onchain_gated',
      title: 'Gated',
      description: 'records that it ran',
      inputSchema: z.object({}),
      outputSchema: z.object({ done: z.boolean() }),
      capability: null,
      needs: [],
      handler: () => {
        finished.value = true;
        return { ok: true as const, output: { done: true } };
      },
    });
    const fakeServer = {
      registerTool: (
        _name: string,
        _config: unknown,
        callback: (input: Record<string, never>, extra: unknown) => Promise<unknown>,
      ) => {
        captured = callback;
      },
    } as unknown as McpServer;
    spec.register(fakeServer, {
      version: '0.0.0-test',
      registry: new CapabilityRegistry(routes, new Map()),
      principal: STDIO_PRINCIPAL,
      requestTrace: createRequestTraceStore(harness.engine),
    });
    if (captured === undefined) throw new Error('the tool did not register');
    return captured as (
      input: Record<string, never>,
      extra: { signal?: AbortSignal },
    ) => Promise<unknown>;
  }

  it('refuses at the boundary and writes NO trace row', async () => {
    const finished = { value: false };
    const handler = captureHandler(finished);

    await handler({}, { signal: AbortSignal.abort() });

    expect(finished.value, 'a call nobody is waiting for was started anyway').toBe(false);
    // "A call not started leaves no completion and no trace row" — nothing is billed for work
    // nobody did.
    expect(rows()).toStrictEqual([]);
  });

  it('and an un-aborted signal changes nothing about the ordinary path', async () => {
    // The other direction, which is what keeps the guard from being "refuse everything": the same
    // wrapper with a live signal runs the handler and records the row.
    const finished = { value: false };
    const handler = captureHandler(finished);

    await handler({}, { signal: new AbortController().signal });

    expect(finished.value).toBe(true);
    expect(rows()).toHaveLength(1);
  });
});

describe('the completion is not tied to the connection, and that is a RULE now', () => {
  const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src');

  function sources(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) return sources(full);
      return full.endsWith('.ts') ? [full] : [];
    });
  }

  it('the abort is read at the tool boundary and forwarded nowhere', () => {
    // The measurement that produced this task: the property held by pure absence of wiring. A
    // future change that threads `extra.signal` into `ToolContext`, `registry.resolve()` or
    // `safeFetch` — each of which would look like an improvement — would silently reintroduce the
    // cancellation R-17 forbids, and nothing else in either package would notice.
    const readers: string[] = [];
    for (const file of sources(srcDir)) {
      const code = readFileSync(file, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/^\s*\/\/.*$/gm, '');
      if (/\bextra\.signal\b|\bsignal\s*:\s*extra\b/.test(code)) {
        readers.push(path.relative(srcDir, file));
      }
    }
    // Exactly one reader, and it is the boundary check.
    expect(readers).toStrictEqual(['tools/registry.ts']);

    const wrapper = readFileSync(path.join(srcDir, 'tools/registry.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
    // It is READ once — the guard — and never handed onward.
    expect([...wrapper.matchAll(/\bextra\.signal\b/g)]).toHaveLength(1);
    expect(wrapper).toMatch(/if \(extra\.signal\?\.aborted === true\)/);
    // And no `signal` is put into the context every handler receives.
    expect(wrapper).not.toMatch(/project\(\{[^}]*signal/);
  });

  it('a handler receives no way to observe the connection', () => {
    // `ToolContext`'s key set is the whole surface a handler can reach. A `signal` on it would let
    // any one of twenty tools decide to abandon a paid call on its own.
    const context = readFileSync(path.join(srcDir, 'tools/registry.ts'), 'utf8');
    const declaration = /export interface ToolContext \{[\s\S]*?\n\}/.exec(context)?.[0] ?? '';
    expect(declaration.length).toBeGreaterThan(0);
    expect(declaration).not.toMatch(/\bsignal\b/);
  });
});
