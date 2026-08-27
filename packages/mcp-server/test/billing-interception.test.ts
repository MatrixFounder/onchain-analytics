import Database from 'better-sqlite3';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  CACHE_DDL,
  CapabilityRegistry,
  createStateClient,
  routes,
  toSqliteDialect,
  type PgStateConnectionLike,
  type PgStatePoolLike,
} from '@onchain-intel/core';
import { createDefaultAccessProfileReader } from '../src/auth/default-access-profile.js';
import { STDIO_PRINCIPAL } from '../src/auth/principal.js';
import {
  createBillingStore,
  createBillingStoreStub,
  createSqliteBillingStore,
  type BillingReserveResult,
  type BillingStore,
} from '../src/engine/billing-store.js';
import { createDiagnostics, type Diagnostics } from '../src/engine/diagnostics.js';
import { createDiagnosticsStore } from '../src/engine/diagnostics-store.js';
import { createEngineStore } from '../src/engine/pg-engine-store.js';
import { createRequestTraceStore } from '../src/engine/request-trace-store.js';
import { createServer } from '../src/server.js';
import { defineTool, type ToolContext, type ToolSpec } from '../src/tools/registry.js';
import { ulid } from '../src/ulid.js';
import { createSqliteEngine, type SqliteEngine } from './helpers/sqlite-engine.js';

/**
 * Task 015-09 — the reserve sits in the tool wrapper, after the abort check and before
 * `definition.handler(...)` (`system-architecture.md` §3.5.2).
 *
 * **Why `priceFor` is mocked here, and only for TC-UNIT-08's purposes.** `PRICE_LIST` (task 015-05)
 * is empty in phase 0, so every real lookup collapses to `DEFAULT_PRICE_RAW` regardless of which key
 * was used — a value-level assertion on `priceRaw` could not tell "keyed by capability" from "keyed
 * by tool name" without a non-empty list to distinguish them. The mock returns a NUMERIC string
 * derived from the key (its length), so `priceRaw` still identifies which key was used AND stays an
 * unsigned decimal integer — the Postgres axis's own `reserve()` refuses anything else BEFORE the
 * insert (`UNSIGNED_INTEGER_RE`), which TC-E2E-01's fake-Postgres case below would otherwise trip on
 * every call, mocked or not, since the mock applies file-wide.
 */
const { mockPriceFor } = vi.hoisted(() => ({
  mockPriceFor: (capability: string | null, tool: string): string =>
    String((capability ?? tool).length + 1000),
}));
vi.mock('../src/billing/price-list.js', () => ({ priceFor: mockPriceFor }));

type ToolCallback = (
  input: unknown,
  extra: {
    authInfo?: AuthInfo;
    _meta?: Record<string, unknown>;
    sessionId?: string;
    signal?: AbortSignal;
  },
) => Promise<unknown>;

/** The same local pattern every other suite in this package uses to reach the wrapped callback
 * without an SDK server (`principal-interception.test.ts`, `principal-in-context.test.ts`, …). */
function captureCallback(spec: ToolSpec, ctx: ToolContext): ToolCallback {
  let captured: ToolCallback | undefined;
  const fake = {
    registerTool: (_name: string, _config: unknown, callback: ToolCallback) => {
      captured = callback;
      return { remove: () => undefined, disable: () => undefined };
    },
  } as unknown as McpServer;
  spec.register(fake, ctx);
  if (captured === undefined) throw new Error(`${spec.name} registered no callback`);
  return captured;
}

/** A tool whose handler counts its own calls and answers a fixed outcome. */
function counterTool(
  onCall: () => void,
  outcome: { ok: true; output: { note: string } } | { ok: false; reason: string } = {
    ok: true,
    output: { note: 'ok' },
  },
  overrides: { name?: string; capability?: string | null } = {},
): ToolSpec {
  return defineTool({
    name: overrides.name ?? 'onchain_probe',
    title: 'Probe',
    description: 'counts its own calls',
    inputSchema: z.object({}),
    outputSchema: z.object({ note: z.string() }),
    capability: overrides.capability ?? null,
    needs: [],
    handler: () => {
      onCall();
      return outcome;
    },
  });
}

interface ReserveCall {
  readonly principalId: string;
  readonly accessProfileId: string | null;
  readonly clientRequestId: string;
  readonly tool: string;
  readonly capability: string | null;
  readonly priceRaw: string;
}

/** A `BillingStore` whose `reserve()` records every input it was called with and answers however
 * the case needs — accepting, refusing, or throwing. `settle`/`refund`/`sumSettled` are inert:
 * task 015-10 owns their wiring, not this one. */
function recordingBilling(
  answer: (input: ReserveCall) => BillingReserveResult | Promise<BillingReserveResult>,
): { billing: BillingStore; calls: ReserveCall[] } {
  const calls: ReserveCall[] = [];
  const billing: BillingStore = {
    reserve: async (input) => {
      calls.push(input);
      return answer(input);
    },
    settle: async () => ({ written: true }),
    refund: async () => ({ written: true }),
    sumSettled: async () => '0',
  };
  return { billing, calls };
}

const accept = (): BillingReserveResult => ({
  ok: true,
  reservation: { rowId: ulid(Date.now()), state: 'reserved', existing: false },
});

const contextOf = (billing: BillingStore, extra: Partial<ToolContext> = {}): ToolContext => ({
  version: '0.0.0-test',
  registry: new CapabilityRegistry(routes, new Map()),
  principal: STDIO_PRINCIPAL,
  billing,
  ...extra,
});

describe('TC-UNIT-01 / AC-2: a served request leaves a ledger row, including a cache hit', () => {
  it('three calls, the last two answering a cache hit, leave three rows', async () => {
    const stub = createBillingStoreStub();
    let calls = 0;
    const spec = counterTool(
      () => {
        calls += 1;
      },
      { ok: true, output: { note: 'ok' } },
    );
    // The handler's own OUTCOME carries `cache` on the success arm — the reserve does not read it,
    // so what it answers is irrelevant to whether a row is written. What matters is that THREE
    // separate admitted calls happened.
    const handler = captureCallback(spec, contextOf(stub));
    await handler({}, {});
    await handler({}, {});
    await handler({}, {});
    expect(calls).toBe(3);
    expect(stub.rows).toHaveLength(3);
  });
});

describe('TC-UNIT-02: the reserve completes before the handler is entered', () => {
  it('records reserve before handler in the order array', async () => {
    const order: string[] = [];
    const { billing } = recordingBilling(() => {
      order.push('reserve');
      return accept();
    });
    const spec = counterTool(() => order.push('handler'));
    const handler = captureCallback(spec, contextOf(billing));
    await handler({}, {});
    expect(order).toStrictEqual(['reserve', 'handler']);
  });
});

describe('TC-UNIT-03: an aborted-before-start call reserves nothing', () => {
  it('zero ledger calls, zero trace rows', async () => {
    const harness: SqliteEngine = createSqliteEngine();
    try {
      const { billing, calls } = recordingBilling(accept);
      const spec = counterTool(() => undefined);
      const handler = captureCallback(
        spec,
        contextOf(billing, { requestTrace: createRequestTraceStore(harness.engine) }),
      );
      await handler({}, { signal: AbortSignal.abort() });
      expect(calls).toStrictEqual([]);
      expect(harness.db.prepare('SELECT * FROM request_trace').all()).toStrictEqual([]);
    } finally {
      harness.close();
    }
  });
});

describe('TC-UNIT-04: a refused reserve never calls the handler', () => {
  it('the handler call counter stays at zero', async () => {
    let calls = 0;
    const { billing } = recordingBilling(() => ({
      ok: false,
      reason: 'billing store unavailable',
      refusalClass: 'BillingStoreUnavailableError',
    }));
    const spec = counterTool(() => {
      calls += 1;
    });
    const handler = captureCallback(spec, contextOf(billing));
    await handler({}, {});
    expect(calls).toBe(0);
  });
});

describe('TC-UNIT-05 / AC-38: a refused reserve writes a trace row and a tool.refused event', () => {
  it('outcome=refusal, refusal_class set, served_from=none, one event', async () => {
    const harness: SqliteEngine = createSqliteEngine();
    try {
      const stderr: string[] = [];
      const diagnostics: Diagnostics = createDiagnostics({
        store: createDiagnosticsStore(harness.engine),
        now: () => 1_770_000_000_000,
        writeStderr: (line) => stderr.push(line),
      });
      const { billing } = recordingBilling(() => ({
        ok: false,
        reason: 'billing store unreachable',
        refusalClass: 'BillingStoreUnavailableError',
      }));
      const spec = counterTool(() => undefined);
      const handler = captureCallback(
        spec,
        contextOf(billing, {
          requestTrace: createRequestTraceStore(harness.engine),
          diagnostics,
        }),
      );
      await handler({}, {});

      const rows = harness.db.prepare('SELECT * FROM request_trace').all() as Record<
        string,
        unknown
      >[];
      expect(rows).toHaveLength(1);
      expect(rows[0]?.['outcome']).toBe('refusal');
      expect(rows[0]?.['refusal_class']).toBe('BillingStoreUnavailableError');
      expect(rows[0]?.['served_from']).toBe('none');

      const events = harness.db.prepare('SELECT * FROM diagnostics').all() as Record<
        string,
        unknown
      >[];
      expect(events.filter((e) => e['event'] === 'tool.refused')).toHaveLength(1);
    } finally {
      harness.close();
    }
  });
});

describe('TC-UNIT-06: a thrown reserve() refuses the SAME way a returned ok:false does', () => {
  it('writes the same trace row and event, and the promise never rejects', async () => {
    const harness: SqliteEngine = createSqliteEngine();
    try {
      const diagnostics: Diagnostics = createDiagnostics({
        store: createDiagnosticsStore(harness.engine),
        now: () => 1_770_000_000_000,
        writeStderr: () => undefined,
      });
      const billing: BillingStore = {
        reserve: () => {
          throw new Error('connection lost');
        },
        settle: async () => ({ written: true }),
        refund: async () => ({ written: true }),
        sumSettled: async () => '0',
      };
      const spec = counterTool(() => undefined);
      const handler = captureCallback(
        spec,
        contextOf(billing, {
          requestTrace: createRequestTraceStore(harness.engine),
          diagnostics,
        }),
      );

      await expect(handler({}, {})).resolves.toBeDefined();

      const rows = harness.db.prepare('SELECT * FROM request_trace').all() as Record<
        string,
        unknown
      >[];
      expect(rows).toHaveLength(1);
      expect(rows[0]?.['outcome']).toBe('refusal');
      expect(rows[0]?.['refusal_class']).toBe('BillingStoreUnavailableError');
      expect(rows[0]?.['served_from']).toBe('none');
      const events = harness.db.prepare('SELECT * FROM diagnostics').all() as Record<
        string,
        unknown
      >[];
      expect(events.filter((e) => e['event'] === 'tool.refused')).toHaveLength(1);
    } finally {
      harness.close();
    }
  });
});

describe('TC-UNIT-07: the refusal class is read under the name refusalClass', () => {
  it('request_trace.refusal_class carries ClientCreditsExhaustedError, never null', async () => {
    const harness: SqliteEngine = createSqliteEngine();
    try {
      const { billing } = recordingBilling(() => ({
        ok: false,
        reason: 'client credits exhausted',
        refusalClass: 'ClientCreditsExhaustedError',
      }));
      const spec = counterTool(() => undefined);
      const handler = captureCallback(
        spec,
        contextOf(billing, { requestTrace: createRequestTraceStore(harness.engine) }),
      );
      await handler({}, {});
      const rows = harness.db.prepare('SELECT * FROM request_trace').all() as Record<
        string,
        unknown
      >[];
      expect(rows[0]?.['refusal_class']).not.toBeNull();
      expect(rows[0]?.['refusal_class']).toBe('ClientCreditsExhaustedError');
    } finally {
      harness.close();
    }
  });
});

describe('TC-UNIT-08: the price-list key is the STATIC capability, or the tool name without one', () => {
  it('a tool with a static capability reserves by it; one without falls back to its name', async () => {
    const { billing, calls } = recordingBilling(accept);
    const withCapability = counterTool(() => undefined, undefined, {
      name: 'onchain_probe_capability',
      capability: 'entity.labels',
    });
    const withoutCapability = counterTool(() => undefined, undefined, {
      name: 'onchain_probe_none',
      capability: null,
    });
    await captureCallback(withCapability, contextOf(billing))({}, {});
    await captureCallback(withoutCapability, contextOf(billing))({}, {});

    expect(calls).toHaveLength(2);
    expect(calls[0]?.capability).toBe('entity.labels');
    // The mocked `priceFor` derives a numeric price FROM the key it was handed — so a distinct
    // `priceRaw` identifies which key the wrapper actually used.
    expect(calls[0]?.priceRaw).toBe(mockPriceFor('entity.labels', 'onchain_probe_capability'));

    expect(calls[1]?.capability).toBeNull();
    expect(calls[1]?.tool).toBe('onchain_probe_none');
    expect(calls[1]?.priceRaw).toBe(mockPriceFor(null, 'onchain_probe_none'));
  });
});

describe('TC-UNIT-09: the server-minted client_request_id matches the trace row', () => {
  it('billing.reserve() and request_trace agree on one server-minted id', async () => {
    const harness: SqliteEngine = createSqliteEngine();
    try {
      const { billing, calls } = recordingBilling(accept);
      const spec = counterTool(() => undefined);
      const handler = captureCallback(
        spec,
        contextOf(billing, { requestTrace: createRequestTraceStore(harness.engine) }),
      );
      // No `_meta` key at all — the client supplied no id, so both ledgers mint.
      await handler({}, {});

      const rows = harness.db.prepare('SELECT * FROM request_trace').all() as Record<
        string,
        unknown
      >[];
      expect(rows).toHaveLength(1);
      const row = rows[0];
      expect(row?.['id']).toBe(row?.['client_request_id']);
      expect(calls[0]?.clientRequestId).toBe(row?.['id']);
    } finally {
      harness.close();
    }
  });
});

describe('TC-UNIT-10: ctx.billing is required, not optional', () => {
  it('rejects a context literal missing it, and the directive proves the check still works', () => {
    // If the requirement ever stopped being enforced, the directive below would become unused and
    // THIS FILE would fail to compile — the same self-correcting shape `tool-spec.test.ts` and
    // `principal-in-context.test.ts` already use for their own required-field checks.
    // @ts-expect-error `billing` is required (R-3.7): an unconfigured deployment must not serve a
    // call for free, silently.
    const incomplete: ToolContext = {
      version: '0.0.0-test',
      registry: new CapabilityRegistry(routes, new Map()),
      principal: STDIO_PRINCIPAL,
    };
    expect(incomplete.version).toBe('0.0.0-test');
  });
});

/* --------------------------------------------------------------------------------------------- *
 * TC-E2E-01 — a served call leaves a ledger row on every one of the three deployment profiles.
 * `local`/`network-sqlite` share the SQLite axis (`createSqliteBillingStore`); `network` is the
 * Postgres axis (`createBillingStore`), exercised here the same way `billing-store-pg.test.ts`
 * exercises it: a real `createStateClient` over a fake `pg.Pool` that runs the SHIPPED statement
 * text against a real in-memory `better-sqlite3` database (R-21 — no live Postgres in CI). Which
 * axis `index.ts` picks per profile — and that it is unconditional, unlike `requestTrace` right
 * beside it — is checked structurally below, the same way `request-admission-order.test.ts`'s own
 * TC-UNIT-03 already checks "both storage axes get an identity store".
 * --------------------------------------------------------------------------------------------- */

/** A capturing `DatabaseCtor`, the same technique `helpers/sqlite-engine.ts` uses, so the row this
 * case writes can be read back after the call — `createSqliteBillingStore` opens its own dedicated
 * connection and exposes no handle of its own. */
function sqliteBillingWithHandle(): { billing: BillingStore; db: () => Database.Database } {
  let opened: Database.Database | undefined;
  const DatabaseCtor = function (path: string, options?: { timeout?: number }): Database.Database {
    opened = new Database(path, options);
    return opened;
  } as unknown as new (path: string, options?: { timeout?: number }) => Database.Database;
  const billing = createSqliteBillingStore({
    path: ':memory:',
    DatabaseCtor: DatabaseCtor as never,
  });
  return {
    billing,
    db: () => {
      if (opened === undefined)
        throw new Error('the sqlite billing store never opened a connection');
      return opened;
    },
  };
}

const FAKE_DSN = 'postgres://engine_state:sup3r-secret-pw@db.internal:5432/postgres';

/** A trimmed `BillingPgHarness` — just enough to run `createBillingStore`'s statements against an
 * in-memory database with no live Postgres, mirroring `billing-store-pg.test.ts`'s own harness. */
function pgBillingWithHandle(): { billing: BillingStore; db: Database.Database } {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(CACHE_DDL);
  function run(text: string, values: unknown[]): { rows: unknown[] } {
    const statement = db.prepare(toSqliteDialect(text));
    const bound =
      values.length === 0 ? undefined : Object.fromEntries(values.map((v, i) => [`p${i + 1}`, v]));
    if (!statement.reader) {
      if (bound === undefined) statement.run();
      else statement.run(bound as never);
      return { rows: [] };
    }
    return { rows: bound === undefined ? statement.all() : statement.all(bound as never) };
  }
  class FakePool implements PgStatePoolLike {
    async query(text: string, values: unknown[] = []): Promise<{ rows: unknown[] }> {
      return run(text, values);
    }
    async connect(): Promise<PgStateConnectionLike> {
      return {
        query: async (text: string, values: unknown[] = []) => run(text, values),
        release: () => undefined,
      };
    }
  }
  const client = createStateClient({
    env: { ONCHAIN_STATE_PG_URL: FAKE_DSN } as NodeJS.ProcessEnv,
    PoolCtor: FakePool,
  });
  const billing = createBillingStore(createEngineStore(client), createDefaultAccessProfileReader());
  return { billing, db };
}

describe('TC-E2E-01: createServer leaves a ledger row on every deployment axis', () => {
  it('the SQLite axis — local and network-sqlite — writes one row', async () => {
    const { billing, db } = sqliteBillingWithHandle();
    const server = createServer({
      env: { LOG_LEVEL: 'info' } as never,
      version: '0.0.0-test',
      billing,
    });
    void server;
    const spec = counterTool(() => undefined);
    await captureCallback(spec, contextOf(billing))({}, {});
    expect(db().prepare('SELECT * FROM client_usage').all()).toHaveLength(1);
  });

  it('the Postgres axis — network — writes one row', async () => {
    const { billing, db } = pgBillingWithHandle();
    const spec = counterTool(() => undefined);
    await captureCallback(spec, contextOf(billing))({}, {});
    expect(db.prepare('SELECT * FROM client_usage').all()).toHaveLength(1);
  });

  it('index.ts builds the store unconditionally, on the profile.storage axis, and forwards it', async () => {
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const source = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/index.ts'),
      'utf8',
    );
    const billingConst = source.indexOf('const billing =');
    const runtimeCall = source.indexOf('createSharedRuntime({');
    expect(billingConst).toBeGreaterThan(0);
    expect(runtimeCall).toBeGreaterThan(billingConst);
    expect(source).toContain("profile.storage === 'postgres'");
    expect(source).toContain('createBillingStore(');
    expect(source).toContain('createSqliteBillingStore(');
    // Unconditional, unlike `requestTrace` right beside it in the same call — a bare `billing,`
    // line in the call block, never wrapped in a conditional spread gated on `identity`.
    const callEnd = source.indexOf('});', runtimeCall);
    const callBlock = source.slice(runtimeCall, callEnd);
    expect(callBlock.split('\n').map((line) => line.trim())).toContain('billing,');
  });

  /**
   * The SECOND half of the same wiring, and it had no assertion at all.
   *
   * **What the test above does NOT cover.** It reads `index.ts` and stops there. The store still has
   * to travel `createSharedRuntime` → `createServer` → `ToolContext`, and `CreateServerDeps.billing`
   * is optional with a `?? createBillingStoreStub()` default. Deleting the forward in `runtime.ts`
   * therefore compiles, leaves `index.ts` textually correct, and hands every session server a stub
   * that admits every call for free — while the test above stays green. Measured by doing it: the
   * line was removed and `pnpm typecheck` returned 0.
   *
   * Making `SharedRuntimeDeps.billing` required (same commit) closes the half above this one — no
   * caller of `createSharedRuntime` can omit the store. This closes the half below it. Together the
   * chain has no droppable link, and neither assertion is redundant: the first dies if `index.ts`
   * stops building the store, this one dies if `runtime.ts` stops passing it on.
   *
   * Structural rather than behavioural for the reason `request-admission-order.test.ts` already
   * established: reaching `ToolContext` from outside means standing up a transport and a session,
   * and the failure being guarded is a deleted line, not a wrong value.
   */
  it('runtime.ts forwards the store to createServer, unconditionally', async () => {
    const { readFileSync } = await import('node:fs');
    const path = await import('node:path');
    const { fileURLToPath } = await import('node:url');
    const source = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), '../src/runtime.ts'),
      'utf8',
    );
    const serverCall = source.indexOf('createServer({');
    expect(serverCall).toBeGreaterThan(0);
    // The close is matched on `\n      }),` — the call's own indentation — and NOT on a bare
    // `}),`. The first draft used the bare form and the slice ended early on the `: {}),` inside
    // `...(deps.requestTrace ? … : {})` one line above, so the assertion never saw the line it
    // exists to check and was red before any mutation. A brace inside the block is not the block's
    // brace, and a substring search cannot tell them apart without the indentation.
    const callEnd = source.indexOf('\n      }),', serverCall);
    expect(callEnd, 'the createServer call block was not delimited').toBeGreaterThan(serverCall);
    const callBlock = source.slice(serverCall, callEnd);
    const lines = callBlock.split('\n').map((line) => line.trim());
    // A bare `billing: deps.billing,` — never `...(deps.billing ? … : {})`, which is what an
    // optional field invites and what would restore the fail-open default.
    expect(lines, 'runtime.ts stopped passing the ledger to createServer').toContain(
      'billing: deps.billing,',
    );
    expect(callBlock).not.toMatch(/\.\.\.\(\s*deps\.billing/);
  });
});
