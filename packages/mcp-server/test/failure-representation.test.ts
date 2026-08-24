import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { request as httpRequest } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import {
  FAILURE_CLASSES,
  PROTOCOL_FAILURE_CLASSES,
  TOOL_FAILURE_CLASSES,
  TOOL_RESULT_KEYS,
  assertRefusalIsFlagged,
  isToolResultEnvelope,
  toClientText,
  type ProtocolFailureClass,
} from '../src/transport/failure-classes.js';
import { CapabilityRegistry, routes } from '@onchain-intel/core';
import { STDIO_PRINCIPAL } from '../src/auth/principal.js';
import { defineTool, toCallToolResult, type ToolOutcome } from '../src/tools/registry.js';
import {
  ALLOWED_METHODS,
  DEFAULT_MCP_PATH,
  startHttpTransport,
  type RunningHttpTransport,
} from '../src/transport/http.js';
import { bearerHeader, acceptsTestToken } from './helpers/test-auth.js';

/**
 * Task 014-25 — every refusal has a level, and the level decides its form (R-26, AC-32, AC-33).
 *
 * **The defect this gate exists for.** RISK-5: a protocol refusal rendered as a tool result. The
 * client reads `200` with `isError: true` inside and treats a rejected token as a tool that had a
 * bad day — retries it, reports it as a data problem, and never learns its credential was refused.
 *
 * **Why counting tool calls is not enough, and the task says so.** A listener can answer `200` with
 * `{ isError: true, content: [...] }` without ever calling a handler; the counter stays zero, the
 * criterion stays green, and precisely the mechanism RISK-5 names goes unmeasured. So every protocol
 * case below asserts TWO things: nothing ran, and the body is not a tool result.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

let running: RunningHttpTransport | undefined;
let toolCalls = 0;

afterEach(async () => {
  await running?.close();
  running = undefined;
  toolCalls = 0;
});

/** A session server whose one tool counts every entry into a handler. */
function countingServer(): McpServer {
  const server = new McpServer({ name: 'failure-representation', version: '0.0.0-test' });
  server.registerTool(
    'onchain_probe',
    { description: 'counts the times a handler was entered', inputSchema: {} },
    () => {
      toolCalls += 1;
      return { content: [{ type: 'text' as const, text: 'ok' }] };
    },
  );
  return server;
}

interface RawResponse {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

/**
 * A raw request over `node:http`, not `fetch`.
 *
 * `Host` is a forbidden header name in fetch, so undici drops an attempt to set it and sends the
 * URL's own authority — which made an earlier perimeter suite pass for the wrong reason
 * (`inbound-perimeter.test.ts` records the measurement). The same helper serves every class here so
 * that one of the five is not tested through a different door than the rest.
 */
function raw(
  transport: RunningHttpTransport,
  options: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<RawResponse> {
  const payload =
    options.body ??
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'probe', version: '1.0.0' },
      },
    });
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: '127.0.0.1',
        port: transport.address.port,
        path: DEFAULT_MCP_PATH,
        method: options.method ?? 'POST',
        setHost: false,
        headers: {
          'content-type': 'application/json',
          accept: 'application/json, text/event-stream',
          'content-length': Buffer.byteLength(payload),
          host: `127.0.0.1:${String(transport.address.port)}`,
          ...bearerHeader(),
          ...options.headers,
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
    req.end(payload);
  });
}

const classById = (id: string): ProtocolFailureClass => {
  const found = PROTOCOL_FAILURE_CLASSES.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`no protocol failure class named ${id}`);
  return found;
};

/** Drives the listener into one protocol class and returns what came back. */
async function provoke(id: string): Promise<RawResponse> {
  switch (id) {
    case 'auth':
      running = await start();
      return raw(running, { headers: { authorization: 'Bearer not-the-token' } });
    case 'perimeter':
      running = await start({ allowedHosts: ['onchain.internal:8848'] });
      return raw(running, { headers: { host: 'evil.example:8848' } });
    case 'session-limit': {
      running = await start({ sessionMax: 1 });
      const first = await raw(running, {});
      expect(first.status, 'the first session must be admitted').toBe(200);
      return raw(running, {});
    }
    case 'unknown-session':
      running = await start();
      return raw(running, { headers: { 'mcp-session-id': 'an-id-this-process-never-issued' } });
    case 'method-not-allowed':
      running = await start();
      return raw(running, { method: 'PUT' });
    default:
      throw new Error(`no producer for ${id}`);
  }
}

async function start(
  overrides: Partial<Parameters<typeof startHttpTransport>[0]> = {},
): Promise<RunningHttpTransport> {
  return startHttpTransport({
    createSessionServer: countingServer,
    authenticate: acceptsTestToken(),
    bind: '127.0.0.1',
    port: 0,
    ...overrides,
  });
}

describe('TC-E2E-01 / AC-32: a protocol refusal never reaches a tool and is never rendered as one', () => {
  for (const declared of PROTOCOL_FAILURE_CLASSES) {
    it(`${declared.id}: HTTP ${String(declared.httpStatus)}, JSON-RPC ${String(declared.jsonRpcCode)}, no tool envelope`, async () => {
      const response = await provoke(declared.id);

      expect(response.status).toBe(declared.httpStatus);
      for (const header of declared.requiredHeaders) {
        expect(response.headers[header], `${declared.id} must carry ${header}`).toBeDefined();
      }

      const body = JSON.parse(response.body) as Record<string, unknown>;
      expect(body['jsonrpc']).toBe('2.0');
      expect((body['error'] as { code: number }).code).toBe(declared.jsonRpcCode);

      // The second measurement, and the one a call counter cannot make: the body is not a tool
      // result. A client that unwrapped `content[0].text` here would read a refusal it never called
      // a tool for.
      expect(isToolResultEnvelope(body), `${declared.id} rendered a tool envelope`).toBe(false);
      // And nothing ran.
      expect(toolCalls, `${declared.id} reached a tool handler`).toBe(0);
      expect(declared.reachesTool).toBe(false);
    });
  }

  it('the session-limit case is the one that needed task 014-13 to exist', async () => {
    // Recorded because the dependency is easy to lose: before the ceiling there was no way to
    // provoke this class at all, and AC-32 would have been asserted on three classes out of four
    // while reading as complete.
    expect(classById('session-limit').httpStatus).toBe(503);
    expect(classById('session-limit').requiredHeaders).toContain('retry-after');
  });

  it('the allowed methods and the Allow header are one value', async () => {
    running = await start();
    const response = await raw(running, { method: 'PATCH' });
    expect(response.headers['allow']).toBe(ALLOWED_METHODS.join(', '));
  });
});

/** Runs one tool through the real registration path and hands back what a client received. */
async function callThrough(outcome: ToolOutcome<{ note: string }>): Promise<CallToolResult> {
  const spec = defineTool({
    name: 'onchain_probe',
    title: 'Probe',
    description: 'returns the outcome under test',
    // Full zod schemas, never a raw `.shape` — the SDK wraps a shape in a non-strict object and
    // silently discards `.strict()` (`registry.ts` says so where the field is declared).
    inputSchema: z.object({}),
    outputSchema: z.object({ note: z.string() }),
    capability: null,
    needs: [],
    handler: () => outcome,
  });
  const server = new McpServer({ name: 'failure-representation', version: '0.0.0-test' });
  // A real `ToolContext`, not `as never` — see the same note in `refusal-renderings.test.ts`.
  spec.register(server, {
    version: '0.0.0-test',
    registry: new CapabilityRegistry(routes, new Map()),
    principal: STDIO_PRINCIPAL,
  });
  const client = new Client({ name: 'probe', version: '1.0.0' });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    return (await client.callTool({ name: 'onchain_probe', arguments: {} })) as CallToolResult;
  } finally {
    await client.close();
    await server.close();
  }
}

/**
 * The text each tool-execution class reaches a client as — built from the producing constructors,
 * not invented. `registry.ts` embeds every attempt as `adapterId (reason)`, which is why the two
 * nested classes appear inside a `capability …` sentence.
 */
const REAL_TEXTS: Readonly<Record<string, string>> = {
  'limiter-saturated':
    'capability deadline exceeded: entity.labels on ethereum — tried: nansen (deadline exceeded in limiter (deadlineAtMs=1770000000000) at provider "nansen")',
  'budget-exhausted':
    'capability unavailable: entity.labels on ethereum — tried: nansen (nansen budget gate refused: budget exceeded for provider=nansen: need 10, used 25000, ceiling 25000)',
  'capability-unavailable':
    'capability unavailable: entity.labels on bitcoin — tried: no route registered for this capability/chain',
  'deadline-expired':
    'capability deadline exceeded: token.holders on ethereum — tried: no source was attempted — the requested deadline had already passed',
};

describe('TC-UNIT-01 / AC-33: no tool-execution failure is rendered with isError: false', () => {
  for (const declared of TOOL_FAILURE_CLASSES) {
    it(`${declared.id} arrives flagged, through the real registration path`, async () => {
      const text = REAL_TEXTS[declared.id];
      expect(text, `no measured text for ${declared.id}`).toBeDefined();
      expect(declared.marker.test(text ?? ''), 'the marker does not match its own class').toBe(
        true,
      );

      // **The renderer itself**, because the client cannot see it. `defineTool` requires an
      // `outputSchema`, and the SDK demands `structuredContent` on any result NOT flagged
      // `isError` — so a renderer that dropped the flag would make the SDK throw and substitute
      // its own flagged error, and the end-to-end assertion below would pass over the wreckage.
      // Measured: mutation N9 survived exactly that way before this line existed.
      const rendered = toCallToolResult({ ok: false, reason: text ?? '' });
      expect(rendered.isError).toBe(true);
      expect(() => {
        assertRefusalIsFlagged(rendered);
      }).not.toThrow();

      // And the same outcome through the whole registration path — what this half measures is that
      // nothing between `defineTool` and the client unflags it.
      const result = await callThrough({ ok: false, reason: text ?? '' });
      expect(result.isError).toBe(true);
      expect(() => {
        assertRefusalIsFlagged(result);
      }).not.toThrow();
    });
  }

  it('the marker is measured against the file that produces the text', () => {
    // A marker nobody re-derives is a string that drifts from its producer in silence. Each class
    // names WHERE its sentence is built; this reads that file and looks for the literal.
    const literals: Readonly<Record<string, string>> = {
      'limiter-saturated': 'provider "',
      'budget-exhausted': 'budget exceeded for provider=',
      'capability-unavailable': 'capability unavailable: ',
      // L-26: the producer names the PHASE, so the pin follows it. Kept as a substring that stops
      // BEFORE the interpolation, which is what makes it a pin on the sentence rather than on a value.
      'deadline-expired': 'deadline exceeded in ${phase} (deadlineAtMs=',
    };
    for (const declared of TOOL_FAILURE_CLASSES) {
      const source = readFileSync(path.join(repoRoot, declared.producedAt), 'utf8');
      expect(source, `${declared.id}: ${declared.producedAt}`).toContain(literals[declared.id]);
    }
  });

  it('a flagged failure clears the gate whatever its words are', () => {
    // The gate has no opinion about text; `isError: true` IS the correct rendering.
    expect(() => {
      assertRefusalIsFlagged({
        isError: true,
        content: [{ type: 'text', text: REAL_TEXTS['capability-unavailable'] ?? '' }],
      });
    }).not.toThrow();
  });
});

describe('TC-UNIT-02: a handler returning ok:true with a refusal inside drops the gate', () => {
  it('catches the exact shape a counter would report as a clean run', async () => {
    const result = await callThrough({
      ok: true,
      output: { note: REAL_TEXTS['capability-unavailable'] ?? '' },
    });
    // MCP's prescribed success form and its failure form differ only by the flag, which is why the
    // gate reads the FLAG and the text together — an outcome-level check would believe this handler.
    expect(result.isError).toBeUndefined();
    expect(() => {
      assertRefusalIsFlagged(result);
    }).toThrow(/rendered WITHOUT isError/);
  });

  it('says nothing about an ordinary success', async () => {
    const result = await callThrough({ ok: true, output: { note: 'seven pools, all live' } });
    expect(() => {
      assertRefusalIsFlagged(result);
    }).not.toThrow();
  });
});

describe('TC-UNIT-03: every class carries a declared level', () => {
  it('nine classes, each with a level, and the two levels partition them', () => {
    expect(FAILURE_CLASSES).toHaveLength(9);
    expect(PROTOCOL_FAILURE_CLASSES.length + TOOL_FAILURE_CLASSES.length).toBe(
      FAILURE_CLASSES.length,
    );
    for (const declared of FAILURE_CLASSES) {
      expect(['protocol', 'tool-execution'], declared.id).toContain(declared.level);
      // The level IS the answer to "does a handler run", so the two fields may not disagree.
      expect(declared.reachesTool, declared.id).toBe(declared.level === 'tool-execution');
    }
  });

  it('the tool-envelope check answers in BOTH directions', () => {
    // The positive control the E2E loop cannot supply for itself: emptying `TOOL_RESULT_KEYS` would
    // make that loop pass every body ever written, green because it stopped asking.
    expect(isToolResultEnvelope({ isError: true, content: [] })).toBe(true);
    expect(isToolResultEnvelope({ content: [{ type: 'text', text: 'x' }] })).toBe(true);
    expect(isToolResultEnvelope({ structuredContent: { note: 'x' } })).toBe(true);
    expect(isToolResultEnvelope({ jsonrpc: '2.0', error: { code: -32000 }, id: null })).toBe(false);
    expect(isToolResultEnvelope(null)).toBe(false);
    expect(TOOL_RESULT_KEYS).toContain('isError');
  });

  it('ids are unique — the list is addressed by them', () => {
    expect(new Set(FAILURE_CLASSES.map((entry) => entry.id)).size).toBe(FAILURE_CLASSES.length);
  });

  it('the two classes without a diagnostics event conceal nothing', () => {
    // Not a gap in the rule: an unknown session id and an unsupported method hide no fuller text, so
    // there is nothing for an identifier to resolve to. Task 014-26 reads this column.
    const withoutEvent = FAILURE_CLASSES.filter((entry) => entry.diagnosticEvent === null);
    expect(withoutEvent.map((entry) => entry.id)).toStrictEqual([
      'unknown-session',
      'method-not-allowed',
    ]);
  });
});

/**
 * L-26 fix-path item 1 — the phase reaches the CALLER, and nothing else does.
 *
 * The head of a deadline refusal says the call ran out of budget; the tail says where it went and
 * cannot be shown, because it names adapters. The phase is the one token in the tail that names
 * none — so it is lifted, and only from a closed set.
 */
describe('TC-UNIT-21: a deadline refusal tells the caller which phase spent the budget', () => {
  const LIMITER =
    'capability deadline exceeded: token.price on tron — tried: coingecko (deadline exceeded in limiter (deadlineAtMs=1770000000000) at provider "coingecko")';
  const WIRE =
    'capability deadline exceeded: dex.volume.history on bsc — tried: defillama (deadline exceeded in wire (deadlineAtMs=1770000000000) at https://api.llama.fi/overview)';

  it('renders the phase, and still cuts the traversal that names the adapter', () => {
    const text = toClientText(LIMITER, '01TESTEVENT');
    expect(text).toBe(
      'capability deadline exceeded: token.price on tron [phase: limiter] (event 01TESTEVENT)',
    );
    expect(text).not.toContain('coingecko');
    expect(text).not.toContain('tried');
  });

  it('distinguishes the two failures that used to read identically', () => {
    // This pair is the whole point of the record: same head, same class of refusal, opposite next
    // action — widen our own rate, or chase the vendor.
    expect(toClientText(LIMITER, null)).toContain('[phase: limiter]');
    expect(toClientText(WIRE, null)).toContain('[phase: wire]');
  });

  it('renders NO phase for a word outside the closed set — it fails closed', () => {
    const forged =
      'capability deadline exceeded: token.price on tron — tried: x (deadline exceeded in nansen-internal (deadlineAtMs=1) at y)';
    const text = toClientText(forged, null);
    expect(text).toBe('capability deadline exceeded: token.price on tron');
    expect(text).not.toContain('phase');
  });

  it('leaves a refusal that is not a deadline exactly as it was', () => {
    const unavailable = 'capability unavailable: entity.labels on bitcoin — tried: no route';
    expect(toClientText(unavailable, null)).toBe(
      'capability unavailable: entity.labels on bitcoin',
    );
  });
});

describe('TC-UNIT-22: the limiter’s SECOND refusal class also names its phase', () => {
  // `DeadlineWouldExceedError` — the wait that was never begun. It reaches the caller inside the
  // same `capability deadline exceeded:` sentence as the wait that ran out, and labelling only the
  // first class left this one silent: measured on `ethereum/protocol.incidents`, 2026-08-24, where
  // a 15 008 ms refusal named no phase at all while the document itself fetched in 0.46 s.
  const WOULD_EXCEED =
    'capability deadline exceeded: protocol.incidents on ethereum — tried: defillama (throttle: rejected for provider "defillama": computed wait 900ms would leave 40ms of the 940ms left before the call deadline — under the 250ms a request needs to be worth issuing)';

  it('renders [phase: limiter] for a refusal that never began its wait', () => {
    const text = toClientText(WOULD_EXCEED, null);
    expect(text).toBe(
      'capability deadline exceeded: protocol.incidents on ethereum [phase: limiter]',
    );
  });

  it('and still keeps the provider name on the operator’s side', () => {
    expect(toClientText(WOULD_EXCEED, '01EV')).not.toContain('defillama');
  });
});
