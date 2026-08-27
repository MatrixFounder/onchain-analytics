import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CapabilityRegistry, routes } from '@onchain-intel/core';
import { z } from 'zod';
import { STDIO_PRINCIPAL } from '../src/auth/principal.js';
import {
  REPLAY_AND_RECONCILE_CEILING_MS,
  createBillingStoreStub,
  createSqliteBillingStore,
  createBillingStore,
  type BillingCompletionResult,
  type BillingReserveResult,
  type BillingStore,
} from '../src/engine/billing-store.js';
import { defineTool, type ToolContext, type ToolSpec } from '../src/tools/registry.js';
import { BillingPgHarness, meteredProfile, profileReaderOf } from './helpers/billing-pg-harness.js';

/**
 * Task 015-10 — the reservation's own lifecycle: completion runs in the wrapper's body (MAJOR-B),
 * `refund()` credits a balance back only on a non-empty `RETURNING` (MAJOR-C), a late outcome after
 * reconciliation already closed a row does not reopen it (MAJOR-9), and the background-reconcile
 * path returns credits rather than only marking a row (MAJOR-A). All four are one transactional
 * boundary — the task's own "Why одна задача, а не четыре" — and this file is that boundary's suite.
 *
 * TC-UNIT-01..03 exercise the WRAPPER (`registry.ts`) directly, the same `captureCallback` pattern
 * `billing-interception.test.ts`/`paid-call-completion.test.ts` already use. TC-UNIT-04..08 exercise
 * `BillingStore` on the Postgres axis against `BillingPgHarness` (`billing-store-pg.test.ts`'s own
 * mechanism, R-21 — no live Postgres in CI). TC-UNIT-09 exercises the SQLite axis's own closer
 * against a REAL file. TC-UNIT-10 is the same "one constant" gate `replay-window.test.ts`'s own
 * TC-UNIT-08 already runs, scoped here to `billing-store.ts` by name for this task's own traceability.
 */

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
 * without an SDK server (`billing-interception.test.ts`, `principal-interception.test.ts`, …). */
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

function probeTool(
  outcome:
    | { ok: true; output: { note: string } }
    | { ok: false; reason: string; refusalClass?: string } = {
    ok: true,
    output: { note: 'ok' },
  },
): ToolSpec {
  return defineTool({
    name: 'onchain_probe',
    title: 'Probe',
    description: 'answers a fixed outcome',
    inputSchema: z.object({}),
    outputSchema: z.object({ note: z.string() }),
    capability: null,
    needs: [],
    handler: () => outcome,
  });
}

const contextOf = (billing: BillingStore, extra: Partial<ToolContext> = {}): ToolContext => ({
  version: '0.0.0-test',
  registry: new CapabilityRegistry(routes, new Map()),
  principal: STDIO_PRINCIPAL,
  billing,
  ...extra,
});

/* --------------------------------------------------------------------------------------------- *
 * TC-UNIT-01..03 — MAJOR-B: completion runs in the wrapper body, both branches, both without and
 * with a throwing store.
 * --------------------------------------------------------------------------------------------- */

describe('TC-UNIT-01 (MAJOR-B): completion runs when ctx.requestTrace is absent', () => {
  it("settles the reservation on the 'local' profile's own shape — no requestTrace at all", async () => {
    const stub = createBillingStoreStub();
    const spec = probeTool({ ok: true, output: { note: 'ok' } });
    // No `requestTrace` key in the context at all — the exact shape `index.ts` builds for stdio
    // (`identity === null ? {} : { requestTrace: … }`).
    const handler = captureCallback(spec, contextOf(stub));

    const result = await handler({}, {});

    expect(stub.rows).toHaveLength(1);
    expect(stub.rows[0]?.state).toBe('settled');
    expect(stub.rows[0]?.terminalAt).not.toBeNull();
    // The client still gets its answer — completion is a side effect, not a gate.
    expect((result as { isError?: boolean }).isError).not.toBe(true);
  });
});

describe('TC-UNIT-02 (MAJOR-B): a thrown settle() does not cancel the answer', () => {
  it('serves the response and names the row id on stderr', async () => {
    const stub = createBillingStoreStub();
    const billing: BillingStore = {
      reserve: (input) => stub.reserve(input),
      settle: () => {
        throw new Error('ledger connection lost');
      },
      refund: (rowId, reason) => stub.refund(rowId, reason),
      sumSettled: (a, b) => stub.sumSettled(a, b),
    };
    const spec = probeTool({ ok: true, output: { note: 'ok' } });
    const handler = captureCallback(spec, contextOf(billing));
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const result = (await handler({}, {})) as { isError?: boolean; structuredContent?: unknown };

      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toStrictEqual({ note: 'ok' });
      const rowId = stub.rows[0]?.id;
      expect(rowId).toBeTruthy();
      const lines = stderr.mock.calls.map((call) => String(call[0]));
      expect(
        lines.some((line) => line.includes('FAILED to settle') && line.includes(rowId ?? '')),
      ).toBe(true);
      // The row itself stays 'reserved' — the throw happened before any transition committed.
      expect(stub.rows[0]?.state).toBe('reserved');
    } finally {
      stderr.mockRestore();
    }
  });
});

describe('TC-UNIT-03 (MAJOR-B): a thrown refund() does not cancel the refusal', () => {
  it('serves the refusal and names the row id on stderr', async () => {
    const stub = createBillingStoreStub();
    const billing: BillingStore = {
      reserve: (input) => stub.reserve(input),
      settle: (rowId) => stub.settle(rowId),
      refund: () => {
        throw new Error('ledger connection lost');
      },
      sumSettled: (a, b) => stub.sumSettled(a, b),
    };
    const spec = probeTool({ ok: false, reason: 'handler refused', refusalClass: 'ProbeRefused' });
    const handler = captureCallback(spec, contextOf(billing));
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const result = (await handler({}, {})) as { isError?: boolean };

      expect(result.isError).toBe(true);
      const rowId = stub.rows[0]?.id;
      expect(rowId).toBeTruthy();
      const lines = stderr.mock.calls.map((call) => String(call[0]));
      expect(
        lines.some((line) => line.includes('FAILED to refund') && line.includes(rowId ?? '')),
      ).toBe(true);
      expect(stub.rows[0]?.state).toBe('reserved');
    } finally {
      stderr.mockRestore();
    }
  });
});

/* --------------------------------------------------------------------------------------------- *
 * TC-UNIT-04..08 — MAJOR-C / MAJOR-A / MAJOR-9, on the Postgres axis (`BillingPgHarness`, the SAME
 * mechanism `billing-store-pg.test.ts` runs its own suite against — R-21).
 * --------------------------------------------------------------------------------------------- */

function reserveInput(
  overrides: Partial<{
    principalId: string;
    accessProfileId: string | null;
    clientRequestId: string;
    tool: string;
    capability: string | null;
    priceRaw: string;
  }> = {},
) {
  return {
    principalId: overrides.principalId ?? 'local',
    accessProfileId: overrides.accessProfileId ?? null,
    clientRequestId: overrides.clientRequestId ?? 'req-1',
    tool: overrides.tool ?? 'onchain_token_price',
    capability: overrides.capability ?? 'token.price',
    priceRaw: overrides.priceRaw ?? '1',
  };
}

function unwrapOk(result: BillingReserveResult): { rowId: string; existing: boolean } {
  if (!result.ok) throw new Error(`unreachable — reserve() refused: ${JSON.stringify(result)}`);
  return result.reservation;
}

let harness: BillingPgHarness | undefined;
afterEach(() => {
  harness?.close();
  harness = undefined;
});

describe('TC-UNIT-04 (MAJOR-C): a repeated refund on one row moves the balance once', () => {
  it('the second refund is a no-op — written:false, balance unchanged', async () => {
    harness = new BillingPgHarness();
    harness.seedAccessProfile('ap1', 'metered', '100');
    const store = createBillingStore(
      harness.engine(),
      profileReaderOf({ ap1: meteredProfile('100') }),
    );
    const { rowId } = unwrapOk(
      await store.reserve(reserveInput({ accessProfileId: 'ap1', priceRaw: '5' })),
    );
    expect(harness.balanceOf('ap1')).toBe('95');

    const first: BillingCompletionResult = await store.refund(rowId, 'ClientCreditsExhaustedError');
    expect(first.written).toBe(true);
    expect(harness.balanceOf('ap1')).toBe('100');

    const second: BillingCompletionResult = await store.refund(
      rowId,
      'ClientCreditsExhaustedError',
    );
    expect(second.written).toBe(false);
    expect(harness.balanceOf('ap1')).toBe('100');

    expect(harness.rows('client_usage')).toHaveLength(1);
    expect(harness.rows('client_usage')[0]?.['state']).toBe('refunded');
  });
});

describe('TC-UNIT-05: settle() never moves the balance', () => {
  it('the balance after settle equals the balance right after reserve', async () => {
    harness = new BillingPgHarness();
    harness.seedAccessProfile('ap1', 'metered', '100');
    const store = createBillingStore(
      harness.engine(),
      profileReaderOf({ ap1: meteredProfile('100') }),
    );
    const { rowId } = unwrapOk(
      await store.reserve(reserveInput({ accessProfileId: 'ap1', priceRaw: '5' })),
    );
    expect(harness.balanceOf('ap1')).toBe('95');

    const result = await store.settle(rowId);

    expect(result.written).toBe(true);
    expect(harness.balanceOf('ap1')).toBe('95');
  });
});

describe('TC-UNIT-06 (MAJOR-A): refunding two stuck reservations returns both credits, atomically each', () => {
  it('both rows close refunded/expired and the balance grows by the sum of their prices', async () => {
    harness = new BillingPgHarness();
    harness.seedAccessProfile('ap1', 'metered', '100');
    const store = createBillingStore(
      harness.engine(),
      profileReaderOf({ ap1: meteredProfile('100') }),
    );
    const { rowId: row1 } = unwrapOk(
      await store.reserve(
        reserveInput({ accessProfileId: 'ap1', priceRaw: '3', clientRequestId: 'req-stuck-1' }),
      ),
    );
    const { rowId: row2 } = unwrapOk(
      await store.reserve(
        reserveInput({ accessProfileId: 'ap1', priceRaw: '7', clientRequestId: 'req-stuck-2' }),
      ),
    );
    expect(harness.balanceOf('ap1')).toBe('90'); // 100 - 3 - 7

    // Simulates what a per-row background reconcile does: close each stuck 'reserved' row as
    // refunded/expired, through the SAME `refund()` operator every ordinary refusal uses.
    const first = await store.refund(row1, 'expired');
    const second = await store.refund(row2, 'expired');

    expect(first.written).toBe(true);
    expect(second.written).toBe(true);
    expect(harness.balanceOf('ap1')).toBe('100'); // grew by 10 = 3 + 7

    const rows = harness.rows('client_usage');
    expect(rows.find((r) => r['id'] === row1)).toMatchObject({
      state: 'refunded',
      refund_reason: 'expired',
    });
    expect(rows.find((r) => r['id'] === row2)).toMatchObject({
      state: 'refunded',
      refund_reason: 'expired',
    });

    // "One operator": the transition and the credit run inside ONE `engine.transaction(...)` per
    // refund() call — observable as a `BEGIN` on the connection this harness's fake pool records.
    // Falls red the moment a mutation splits the two statements outside that wrapper (the harness
    // then records no `BEGIN` at all for either call).
    expect(harness.statements.some((s) => s.text.trim() === 'BEGIN')).toBe(true);
  });
});

describe('TC-UNIT-07 (MAJOR-A): a stuck row with NULL access_profile_id credits nobody', () => {
  it('the row closes refunded/expired and no UPDATE ever touches access_profiles', async () => {
    harness = new BillingPgHarness();
    const store = createBillingStore(harness.engine(), profileReaderOf({}));
    // accessProfileId: null — the local principal's own shape (R-7.5); reserveUnlimited's path.
    const { rowId } = unwrapOk(await store.reserve(reserveInput({ accessProfileId: null })));

    const result = await store.refund(rowId, 'expired');

    expect(result.written).toBe(true);
    const row = harness.rows('client_usage')[0];
    expect(row?.['state']).toBe('refunded');
    expect(row?.['refund_reason']).toBe('expired');
    expect(
      harness.statements.some((s) => /UPDATE\s+onchain\.access_profiles/i.test(s.text)),
      'no credit statement was ever sent for a row with no access profile',
    ).toBe(false);
  });
});

describe('TC-UNIT-08 (MAJOR-9): a late outcome after reconciliation does not reopen a closed row', () => {
  it('settle() after refund() changes nothing and names the row on stderr', async () => {
    const inner = createBillingStoreStub();
    const pre = unwrapOk(
      await inner.reserve({
        principalId: 'local',
        accessProfileId: null,
        clientRequestId: 'req-late',
        tool: 'onchain_probe',
        capability: null,
        priceRaw: '1',
      }),
    );
    const rowId = pre.rowId;
    // Simulates the background reconciliation scan (`data-model.md` §4.6.5) closing this row BEFORE
    // the original call's own late outcome arrives.
    await inner.refund(rowId, 'expired');
    expect(inner.rows[0]?.state).toBe('refunded');

    // The wrapper's OWN reserve() call is stood in for — it returns THIS already-closed row, exactly
    // as a real store's replay/dedup path would for a retried client_request_id — so the wrapper
    // proceeds to the handler and then to ITS OWN completion call below, unaware the row is already
    // terminal.
    const billing: BillingStore = {
      reserve: async () => ({
        ok: true,
        reservation: { rowId, state: 'refunded', existing: true },
      }),
      settle: (id) => inner.settle(id),
      refund: (id, reason) => inner.refund(id, reason),
      sumSettled: (a, b) => inner.sumSettled(a, b),
    };
    const spec = probeTool({ ok: true, output: { note: 'ok' } });
    const handler = captureCallback(spec, contextOf(billing));
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const result = (await handler({}, {})) as { isError?: boolean };
      expect(result.isError).not.toBe(true);

      // MAJOR-9's own guard: the late settle() found nothing to close (WHERE state = 'reserved'
      // matched zero rows) — state and reason stay exactly as reconciliation left them.
      expect(inner.rows[0]?.state).toBe('refunded');
      expect(inner.rows[0]?.refundReason).toBe('expired');

      const lines = stderr.mock.calls.map((call) => String(call[0]));
      expect(
        lines.some((line) => line.includes('already terminal') && line.includes(rowId)),
        'the late outcome is named on stderr with the row id',
      ).toBe(true);
    } finally {
      stderr.mockRestore();
    }
  });
});

/* --------------------------------------------------------------------------------------------- *
 * TC-UNIT-09 (MINOR-9) — the SQLite axis's own closer, at store open, on a real file.
 * --------------------------------------------------------------------------------------------- */

/** The same capturing `DatabaseCtor` `billing-store-sqlite.test.ts` uses, so a row can be read back
 * after the closer runs — `createSqliteBillingStore` exposes no handle of its own. */
function capturingCtor(): { readonly Ctor: unknown; db(): Database.Database } {
  let opened: Database.Database | undefined;
  const Ctor = function (
    dbPath: string,
    options?: { readonly timeout?: number },
  ): Database.Database {
    opened = new Database(dbPath, options);
    return opened;
  };
  return {
    Ctor,
    db(): Database.Database {
      if (opened === undefined) throw new Error('the database was never opened');
      return opened;
    },
  };
}

describe('TC-UNIT-09 (MINOR-9): a stuck reserved row on the SQLite axis is closed at store open', () => {
  let dataDir: string | undefined;
  afterEach(() => {
    if (dataDir !== undefined) rmSync(dataDir, { recursive: true, force: true });
    dataDir = undefined;
  });

  it('a row aged past the ceiling is refunded/expired once a LATER store opens the same file', async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), 'billing-closer-'));
    const filePath = path.join(dataDir, 'cache.sqlite3');
    let clock = 1_000_000;
    const now = (): number => clock;

    const store1 = createSqliteBillingStore({ path: filePath, now });
    const { rowId } = unwrapOk(
      await store1.reserve(reserveInput({ clientRequestId: 'req-stuck' })),
    );

    // 120 001 ms later — one past the shared ceiling (TC-UNIT-10 below proves this reads the SAME
    // constant, never a second literal).
    clock += REPLAY_AND_RECONCILE_CEILING_MS + 1;

    const { Ctor, db } = capturingCtor();
    const store2 = createSqliteBillingStore({
      path: filePath,
      now,
      DatabaseCtor: Ctor as never,
    });
    // Waits behind the closer's own sweep, enqueued through the SAME serialization queue at store2's
    // construction — an unrelated reserve() only resolves once everything queued ahead of it has.
    await store2.reserve(reserveInput({ clientRequestId: 'req-unrelated' }));

    const row = db()
      .prepare('SELECT state, refund_reason, terminal_at FROM client_usage WHERE id = ?')
      .get(rowId) as { state: string; refund_reason: string | null; terminal_at: number | null };
    expect(row.state).toBe('refunded');
    expect(row.refund_reason).toBe('expired');
    expect(row.terminal_at).not.toBeNull();
  });

  it('a fresh reservation on a NEW store is left alone — the closer touches only stale rows', async () => {
    dataDir = mkdtempSync(path.join(tmpdir(), 'billing-closer-'));
    const filePath = path.join(dataDir, 'cache.sqlite3');
    const { Ctor, db } = capturingCtor();
    const store = createSqliteBillingStore({ path: filePath, DatabaseCtor: Ctor as never });

    const { rowId } = unwrapOk(await store.reserve(reserveInput()));

    const row = db().prepare('SELECT state FROM client_usage WHERE id = ?').get(rowId) as {
      state: string;
    };
    expect(row.state).toBe('reserved');
  });
});

/* --------------------------------------------------------------------------------------------- *
 * TC-UNIT-10 — the closer's threshold and the replay window read ONE constant.
 * --------------------------------------------------------------------------------------------- */

describe('TC-UNIT-10: the closer threshold and the replay window share one constant', () => {
  it('no literal millisecond value for the ceiling appears in billing-store.ts outside its declaration', () => {
    const file = path.resolve(__dirname, '../src/engine/billing-store.ts');
    const text = readFileSync(file, 'utf8');
    const codeOnly = text
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//'))
      .join('\n');

    const occurrences = (codeOnly.match(/\b120_?000\b/g) ?? []).length;
    // Exactly one — the constant's own declaration (`export const REPLAY_AND_RECONCILE_CEILING_MS
    // = 120_000;`). A second, hand-typed literal inside the closer's own threshold arithmetic would
    // move this to 2.
    expect(occurrences).toBe(1);

    // And the closer's own threshold arithmetic reads the constant by name, not a re-typed number.
    expect(text).toMatch(/ts - REPLAY_AND_RECONCILE_CEILING_MS/);
  });

  it('lists every read of REPLAY_AND_RECONCILE_CEILING_MS under packages/mcp-server/src/engine/', () => {
    const engineDir = path.resolve(__dirname, '../src/engine');
    const files = readdirSync(engineDir).filter((name) => name.endsWith('.ts'));
    const readers = files.filter((name) => {
      const text = readFileSync(path.join(engineDir, name), 'utf8');
      return text.includes('REPLAY_AND_RECONCILE_CEILING_MS');
    });
    // The declaring/consuming file itself — the replay window derivation and the closer both live
    // here, reading the SAME identifier rather than a second one.
    expect(readers).toContain('billing-store.ts');
  });
});
