import { request as httpRequest } from 'node:http';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  CapabilityRegistry,
  adapterRegistrations,
  renderBucketState,
  routes,
  type LimiterBucketState,
} from '@onchain-intel/core';
import { STDIO_PRINCIPAL } from '../src/auth/principal.js';
import { EnvSchema } from '../src/env.js';
import { createBillingStoreStub } from '../src/engine/billing-store.js';
import { createDiagnostics, type Diagnostics } from '../src/engine/diagnostics.js';
import { createDiagnosticsStore } from '../src/engine/diagnostics-store.js';
import { defineTool } from '../src/tools/registry.js';
import {
  GENERIC_REFUSAL,
  OPERATOR_TOKENS,
  TRAVERSAL_MARKER,
  toClientText,
} from '../src/transport/failure-classes.js';
import {
  DEFAULT_MCP_PATH,
  startHttpTransport,
  type AuthDecision,
  type RunningHttpTransport,
} from '../src/transport/http.js';
import { createSqliteEngine, type SqliteEngine } from './helpers/sqlite-engine.js';
import { TEST_PRINCIPAL, TEST_TOKEN, bearerHeader } from './helpers/test-auth.js';
import type { Role } from '../src/auth/identity-types.js';

/**
 * Task 014-26 — one refusal, two renderings, and an identifier joining them (R-20, AC-47, AC-50).
 *
 * **Why an identifier and not the full text under a role gate.** Owner decision 2026-08-13. A role
 * gate passes green having collected only the client case, and an operator rendering that travels on
 * the wire turns the leak of one admin token into a leak of our unit economics. So the wire carries
 * the same bounded text for every principal, and the row id is what an administrator resolves.
 *
 * **The two dictionaries are READ, never typed out.** `adapterRegistrations` and `EnvSchema` are
 * where those names are declared; a thirteenth adapter or a new key joins this gate at the moment it
 * is declared, which is the only version of this check that stays true.
 */

const OPERATOR_TEXT =
  'capability unavailable: entity.labels on ethereum' +
  `${TRAVERSAL_MARKER}blockscout (no labels for this address), ` +
  'nansen (nansen budget gate refused: budget exceeded for provider=nansen: ' +
  'need 100, used 24950, ceiling 25000; NANSEN_API_KEY was accepted)';

/**
 * A limiter refusal as it actually arrives — task 014-20's addition to this gate.
 *
 * R-9.4 makes the refusal name the bucket's remainder and its ceiling, and AC-47 forbids both on the
 * wire. The pair is only satisfiable by the split this file measures, which is why the limiter text
 * joins the budget one here rather than being asserted structurally somewhere else.
 *
 * **The numbers are deliberately unmistakable.** A real ceiling of `5` is unsearchable in a JSON
 * payload full of fives; `4242` and `777.7` appear nowhere else, so a substring that survives is
 * evidence rather than coincidence.
 */
const LIMITER_BUCKET: LimiterBucketState = {
  remaining: -777.7,
  ceiling: 4242,
  refillPerSec: 0.5,
};

const LIMITER_OPERATOR_TEXT =
  'capability deadline exceeded: entity.labels on ethereum' +
  `${TRAVERSAL_MARKER}blockscout (throttle: rejected for provider "blockscout": computed wait ` +
  '3000ms would leave 3000ms of the 6000ms left before the call deadline — under the 5000ms a ' +
  `request needs to be worth issuing; ${renderBucketState(LIMITER_BUCKET)})`;

/** The same shape with NO budget anywhere — the plain traversal case. */
const PLAIN_OPERATOR_TEXT =
  'capability unavailable: entity.labels on ethereum' +
  `${TRAVERSAL_MARKER}blockscout (no labels for this address), nansen (HTTP 503 from the vendor)`;

const FIXED_EVENT_ID = '01JEVENT0000000000000000AB';

const ADAPTER_IDS = adapterRegistrations.map((registration) => registration.id);
const ENV_KEYS = Object.keys(EnvSchema.shape);

let harness: SqliteEngine;
let stderr: string[];
let running: RunningHttpTransport | undefined;
/** Set by a test that wants to hold the diagnostics write open — TC-UNIT-02's lever. */
let holdEmit: Promise<void> | null;

beforeEach(() => {
  harness = createSqliteEngine();
  stderr = [];
  holdEmit = null;
});

afterEach(async () => {
  await running?.close();
  running = undefined;
  harness.close();
});

function channel(store = createDiagnosticsStore(harness.engine)): Diagnostics {
  const inner = createDiagnostics({
    store,
    now: () => 1_770_000_000_000,
    newId: () => FIXED_EVENT_ID,
    writeStderr: (line) => stderr.push(line),
  });
  return {
    emit: async (event, detail) => {
      if (holdEmit !== null) await holdEmit;
      return inner.emit(event, detail);
    },
  };
}

/** A session server whose one tool refuses with the full operator text, through `defineTool`. */
function refusingServer(diagnostics: Diagnostics, reason: string = OPERATOR_TEXT): McpServer {
  const spec = defineTool({
    name: 'onchain_probe',
    title: 'Probe',
    description: 'refuses with a full operator text',
    inputSchema: z.object({}),
    outputSchema: z.object({ note: z.string() }),
    capability: 'entity.labels',
    needs: [],
    handler: () => ({ ok: false, reason }),
  });
  const server = new McpServer({ name: 'refusal-renderings', version: '0.0.0-test' });
  // A real `ToolContext`, not `as never`: the cast used to hide exactly the key stage 6 makes
  // load-bearing — a context with no `principal` would have compiled and failed at runtime, or
  // worse, silently taken the `user` branch.
  spec.register(server, {
    version: '0.0.0-test',
    registry: new CapabilityRegistry(routes, new Map()),
    principal: STDIO_PRINCIPAL,
    diagnostics,
    billing: createBillingStoreStub(),
  });
  return server;
}

const acceptsRole =
  (role: Role) =>
  (presented: string | null): Promise<AuthDecision> =>
    Promise.resolve(
      presented === TEST_TOKEN
        ? { ok: true, principal: { ...TEST_PRINCIPAL, role } }
        : { ok: false, refusalClass: 'auth.unknown_token' },
    );

async function listen(
  overrides: Partial<Parameters<typeof startHttpTransport>[0]> = {},
  role: Role = 'user',
  reason: string = OPERATOR_TEXT,
): Promise<RunningHttpTransport> {
  const diagnostics = channel();
  running = await startHttpTransport({
    createSessionServer: () => refusingServer(diagnostics, reason),
    authenticate: acceptsRole(role),
    bind: '127.0.0.1',
    port: 0,
    diagnostics,
    ...overrides,
  });
  return running;
}

interface RawResponse {
  readonly status: number;
  readonly headers: Record<string, string | string[] | undefined>;
  readonly body: string;
}

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

/** Opens a session and calls the refusing tool, returning the raw SSE payload the client got. */
async function callRefusingTool(transport: RunningHttpTransport): Promise<string> {
  const opened = await raw(transport, {});
  const sessionId = opened.headers['mcp-session-id'];
  if (typeof sessionId !== 'string') throw new Error('no session id was issued');
  const called = await raw(transport, {
    headers: { 'mcp-session-id': sessionId },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 2,
      method: 'tools/call',
      params: { name: 'onchain_probe', arguments: {} },
    }),
  });
  return called.body;
}

const diagnosticRow = (event: string): Record<string, unknown> | undefined =>
  harness.db.prepare('SELECT * FROM diagnostics WHERE event = ?').get(event) as
    Record<string, unknown> | undefined;

/** Every operator token that appears in a payload — named, so a failure is actionable (L-3). */
function operatorTokensIn(payload: string): string[] {
  const lowered = payload.toLowerCase();
  return [...ADAPTER_IDS, ...ENV_KEYS].filter((token) => lowered.includes(token.toLowerCase()));
}

describe('TC-E2E-01 / AC-47: no operator detail on the wire, at any role', () => {
  for (const role of ['user', 'admin'] as const) {
    it(`${role}: neither a protocol refusal nor a tool refusal names an adapter or a key`, async () => {
      const transport = await listen({}, role);

      const unauthorized = await raw(transport, { headers: { authorization: 'Bearer wrong' } });
      const toolRefusal = await callRefusingTool(transport);

      for (const payload of [unauthorized.body, toolRefusal]) {
        expect(operatorTokensIn(payload), 'operator detail reached the client').toStrictEqual([]);
      }
      // The traversal separator is the other half of the same rule: its presence means an attempt
      // list survived even if every id in it happened to be spelled differently.
      expect(toolRefusal).not.toContain(TRAVERSAL_MARKER);
      // The numbers are gone with it — an operator's remaining credits and ceiling.
      expect(toolRefusal).not.toContain('24950');
      expect(toolRefusal).not.toContain('25000');
    });

    /**
     * TC-UNIT-05 of task 014-20, run end to end because that is where AC-47 is stated: "no response
     * on the network transport carries operator detail — regardless of role".
     *
     * The pair R-9.4 and AC-47 make is only satisfiable by the split: the refusal MUST name the
     * bucket's remainder and ceiling for the operator, and MUST NOT for the client. A limiter that
     * named neither would satisfy AC-47 and fail R-9.4; one that named both everywhere would do the
     * reverse. Both halves are asserted — here and in `core`'s `limiter-deadline-wait.test.ts`.
     */
    it(`${role}: a limiter refusal reaches the client without its bucket remainder or ceiling`, async () => {
      const transport = await listen({}, role, LIMITER_OPERATOR_TEXT);
      const toolRefusal = await callRefusingTool(transport);

      expect(toolRefusal).not.toContain(String(LIMITER_BUCKET.ceiling));
      expect(toolRefusal).not.toContain('777');
      // The rendered phrase as a whole, from the SAME renderer the refusal uses — so a change to
      // its format cannot slip past this by making the substrings above stop matching.
      expect(toolRefusal).not.toContain(renderBucketState(LIMITER_BUCKET));
      expect(operatorTokensIn(toolRefusal)).toStrictEqual([]);

      // And the client is still told something true and useful: what it asked for, and the id that
      // resolves to the full text. A refusal scrubbed into silence would satisfy AC-47 by saying
      // nothing, which is the failure mode this assertion exists to keep out.
      expect(toolRefusal).toContain('capability deadline exceeded: entity.labels on ethereum');
      expect(toolRefusal).toMatch(/\(event 01[0-9A-HJKMNP-TV-Z]{24}\)/);
    });
  }

  it('the rendering is byte-identical across the two roles, which is the decision itself', async () => {
    const asUser = await callRefusingTool(await listen({}, 'user'));
    await running?.close();
    running = undefined;
    const asAdmin = await callRefusingTool(await listen({}, 'admin'));
    expect(asUser).toBe(asAdmin);
  });

  it('the dictionaries are non-empty, or the gate above proves nothing', () => {
    // A list read from the repository can go empty and take the check with it, silently.
    expect(ADAPTER_IDS.length).toBeGreaterThanOrEqual(12);
    expect(ENV_KEYS).toContain('NANSEN_API_KEY');
    expect(operatorTokensIn(OPERATOR_TEXT).sort()).toStrictEqual([
      'NANSEN_API_KEY',
      'blockscout',
      'nansen',
    ]);
  });
});

describe('TC-E2E-02 / AC-50: the identifier is present and resolves in diagnostics', () => {
  it('a protocol refusal carries it in error.data.event', async () => {
    const transport = await listen();
    const response = await raw(transport, { headers: { authorization: 'Bearer wrong' } });

    const body = JSON.parse(response.body) as { error: { data?: { event?: string } } };
    expect(body.error.data?.event).toBe(FIXED_EVENT_ID);
    // It RESOLVES — the half that makes an identifier worth handing out.
    const row = diagnosticRow('auth.rejected');
    expect(row?.['id']).toBe(FIXED_EVENT_ID);
    expect(JSON.parse(String(row?.['detail_json']))).toStrictEqual({
      refusalClass: 'auth.unknown_token',
    });
  });

  it('a tool refusal carries it in the text, not in _meta', async () => {
    const transport = await listen();
    const payload = await callRefusingTool(transport);

    expect(payload).toContain(FIXED_EVENT_ID);
    // `_meta` visibility is a function of role, and the field would be absent for exactly the
    // principal who needs it most (task 014-26's own note).
    expect(payload).not.toContain('_meta');

    const row = diagnosticRow('tool.refused');
    expect(row?.['id']).toBe(FIXED_EVENT_ID);
    expect(row?.['capability']).toBe('entity.labels');
    expect(JSON.parse(String(row?.['detail_json']))).toStrictEqual({
      tool: 'onchain_probe',
      reason: OPERATOR_TEXT,
    });
  });
});

describe('TC-UNIT-01: the full text is in the server’s own channel', () => {
  it('the row holds it unedited, and stderr holds the id that finds it', async () => {
    const transport = await listen();
    await callRefusingTool(transport);

    const row = diagnosticRow('tool.refused');
    // Unedited — this is the half that must not be trimmed, or the identifier resolves to a
    // summary and the redaction becomes a deletion.
    expect(String(row?.['detail_json'])).toContain('24950');
    expect(String(row?.['detail_json'])).toContain('blockscout');
    expect(stderr.some((line) => line.includes(`id=${FIXED_EVENT_ID}`))).toBe(true);
    // And never the principal on stderr (R-5.3).
    expect(stderr.join('\n')).not.toContain(TEST_PRINCIPAL.tokenId);
  });
});

describe('TC-UNIT-02: the row is written BEFORE the response is sent', () => {
  it('holds the response for as long as the write is held', async () => {
    let release = (): void => undefined;
    holdEmit = new Promise<void>((resolve) => {
      release = resolve;
    });
    const transport = await listen();

    let answered = false;
    const pending = raw(transport, { headers: { authorization: 'Bearer wrong' } }).then((value) => {
      answered = true;
      return value;
    });
    // Long enough for a listener that did not wait to have answered several times over.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(answered, 'the refusal was sent before its row existed').toBe(false);

    release();
    const response = await pending;
    expect(response.status).toBe(401);
    // An identifier that resolves to nothing is worse than no identifier — which is why the order
    // is causal here rather than merely usual.
    expect(diagnosticRow('auth.rejected')?.['id']).toBe(FIXED_EVENT_ID);
  });
});

describe('TC-UNIT-03: the two classes that conceal nothing carry no identifier', () => {
  it('404 for an unknown session and 405 for an unsupported method', async () => {
    const transport = await listen();

    const unknownSession = await raw(transport, {
      headers: { 'mcp-session-id': 'an-id-this-process-never-issued' },
    });
    const badMethod = await raw(transport, { method: 'PUT' });

    for (const response of [unknownSession, badMethod]) {
      const body = JSON.parse(response.body) as { error: { data?: unknown } };
      expect(body.error.data).toBeUndefined();
    }
    // Not a gap in the rule but the rule holding: nothing was withheld, so nothing needs recovering.
    expect(diagnosticRow('session.evicted')).toBeUndefined();
  });
});

describe('TC-UNIT-04: what leaves the client rendering, and what survives it', () => {
  it('drops the traversal, keeps what the caller itself asked for', () => {
    expect(toClientText(PLAIN_OPERATOR_TEXT, FIXED_EVENT_ID)).toBe(
      `capability unavailable: entity.labels on ethereum (event ${FIXED_EVENT_ID})`,
    );
  });

  it('replaces a budget refusal outright — no prefix of it is safe', () => {
    const budget =
      'nansen budget gate refused: budget exceeded for provider=nansen: need 100, used 24950, ceiling 25000';
    const rendered = toClientText(budget, FIXED_EVENT_ID);
    expect(rendered).toBe(
      `the provider budget for this call is exhausted (event ${FIXED_EVENT_ID})`,
    );
    expect(operatorTokensIn(rendered)).toStrictEqual([]);
  });

  it('finds the budget fact even NESTED in a traversal, and says so', () => {
    // The head alone reads `capability unavailable`, which a caller cannot tell from "this chain is
    // not served" — the difference between "retry later" and "never". The budget FACT is on nobody's
    // forbidden list; the arithmetic behind it is, and that is what the replacement removes.
    const rendered = toClientText(OPERATOR_TEXT, FIXED_EVENT_ID);
    expect(rendered).toBe(
      `the provider budget for this call is exhausted (event ${FIXED_EVENT_ID})`,
    );
    expect(operatorTokensIn(rendered)).toStrictEqual([]);
  });

  it('falls back to the generic sentence when a token survives the cut', () => {
    // The sentence nobody classified: a surgical substitution would assume the REST of it is safe,
    // which is exactly what is not known here.
    expect(toClientText('NANSEN_API_KEY is required to resync /account', null)).toBe(
      GENERIC_REFUSAL,
    );
    expect(toClientText('blockscout returned HTTP 429', null)).toBe(GENERIC_REFUSAL);
    // **An env key that contains NO adapter id**, and the case is here because its absence let a
    // mutation deleting the whole `EnvSchema` half of the dictionary survive: `NANSEN_API_KEY`
    // above is caught by the adapter id `nansen` inside it, so both cases above passed on a
    // dictionary that had forgotten every environment key.
    expect(toClientText('DATA_DIR is not writable', null)).toBe(GENERIC_REFUSAL);
    expect(OPERATOR_TOKENS).toContain('DATA_DIR');
  });

  it('omits the identifier rather than inventing one when no channel exists', () => {
    expect(toClientText('capability unavailable: pool.info on dash', null)).toBe(
      'capability unavailable: pool.info on dash',
    );
  });
});

describe('regression: the local profile still gives its operator the full text', () => {
  it('stdio has no store, and stderr is the channel that operator is reading', async () => {
    // `store: null` is the local profile. The full reason still reaches the one channel that exists
    // there, so "the operator reads the detail from diagnostics" holds without a database.
    const local = createDiagnostics({
      store: null,
      now: () => 1_770_000_000_000,
      newId: () => FIXED_EVENT_ID,
      writeStderr: (line) => stderr.push(line),
    });
    const id = await local.emit('tool.refused', {
      severity: 'warn',
      detail: { tool: 'onchain_probe', reason: OPERATOR_TEXT },
    });
    expect(id).toBe(FIXED_EVENT_ID);
    expect(stderr[0]).toContain(`id=${FIXED_EVENT_ID}`);
    // And the client half is still bounded, on stdio exactly as on the wire — the redaction is not
    // a transport setting. A path that only ran on one transport would be the one whose refusal
    // rendering is never exercised (§7.5.4's reasoning about `network-sqlite`).
    expect(toClientText(OPERATOR_TEXT, id)).not.toContain('blockscout');
  });
});
