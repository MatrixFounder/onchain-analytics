import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import {
  CapabilityRegistry,
  routes,
  type CapabilityResolution,
  type CapabilityResolver,
  type VendorSpendRecord,
} from '@onchain-intel/core';
import { STDIO_PRINCIPAL } from '../src/auth/principal.js';
import { OUTPUT_CONTRACT_REFUSAL_CLASS } from '../src/tools/contract-violation.js';
import { createBillingStoreStub, type BillingStore } from '../src/engine/billing-store.js';
import { createDiagnostics } from '../src/engine/diagnostics.js';
import { createDiagnosticsStoreStub } from '../src/engine/diagnostics-store.js';
import { createRequestTraceStoreStub } from '../src/engine/request-trace-store.js';
import {
  defineTool,
  type ToolContext,
  type ToolOutcome,
  type ToolSpec,
} from '../src/tools/registry.js';

/**
 * Task 015-11 — the completion rule is TOTAL over `outcome`, and over `refusalClass`'s value
 * including a value that does not exist today (R-3, R-3.3, R-3.4, AC-35, `system-architecture.md`
 * §3.5.3 — "The rule does not branch on `refusalClass`'s value. A class that does not exist today
 * refunds by construction rather than by an added case.").
 *
 * **Ships no implementation.** `packages/mcp-server/src/tools/registry.ts`'s completion block
 * (task 015-10, MAJOR-B) already reads `outcome.ok` alone —
 * `outcome.ok ? await ctx.billing.settle(rowId) : await ctx.billing.refund(rowId, outcome.refusalClass
 * ?? 'unclassified')` — with no comparison against any class name anywhere in the selection. This
 * file is the LAST task of Stage 3 and its whole job is to lock that property down with a suite that
 * cannot be satisfied by a value-branching rewrite, not to add behaviour.
 *
 * **TC-UNIT-01..08 below map onto the task's own numbered table**, and reuse the same wrapper-level
 * pattern `billing-interception.test.ts`/`reservation-lifecycle.test.ts` already established:
 * `captureCallback` reaches the wrapped tool callback without an SDK server, `createBillingStoreStub`/
 * `createRequestTraceStoreStub`/`createDiagnosticsStoreStub` hold every side effect in memory so an
 * assertion never has to open a database.
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
 * without an SDK server (`billing-interception.test.ts`, `reservation-lifecycle.test.ts`, …). */
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

/** A tool whose handler answers a FIXED outcome, unconditionally — the whole point being that this
 * suite drives the WRAPPER's own rule, never a handler's own logic. */
function probeTool(
  outcome: ToolOutcome<{ note: string }>,
  overrides: { name?: string } = {},
): ToolSpec {
  return defineTool({
    name: overrides.name ?? 'onchain_probe',
    title: 'Probe',
    description: "answers a fixed outcome, for this task's own totality tests",
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
 * TC-UNIT-01 (AC-5) — the five R-3.3 classes that DO write a row all settle it as `refunded`.
 * --------------------------------------------------------------------------------------------- */

/**
 * The five names R-3.3 lists beside `ClientCreditsExhaustedError` (`docs/tasks/task-015-11-outcome-
 * total-function.md`'s own table) — read from the same declarations the rest of the codebase uses,
 * not retyped, so this table cannot silently drift from the class it names:
 * `CapabilityUnavailableError` (`packages/core/src/adapters/registry.ts`), the output-contract
 * violation (`OUTPUT_CONTRACT_REFUSAL_CLASS`, `contract-violation.ts`), `CapabilityDeadlineExceededError`
 * (`packages/core/src/adapters/registry.ts`), the existing token-bucket saturation
 * (`RateLimitRejectedError`, `packages/core/src/net/rate-limit.ts`) and the call-gate refusal R-11.4
 * introduces (`ProviderCallCeilingExceededError`, `system-architecture.md` §3.5.4, task 015-15).
 *
 * **These are DATA, not branches** (the task's own "Перечень классов R-3.3 — данные теста, не ветви
 * кода"). The wrapper never compares against any of these five literals — TC-UNIT-06 below proves
 * that structurally — so this table exists to demonstrate the RULE's OUTCOME for each, not to give
 * the implementation a case to switch on.
 */
const R_3_3_NAMED_REFUSAL_CLASSES = [
  'CapabilityUnavailableError',
  OUTPUT_CONTRACT_REFUSAL_CLASS,
  'CapabilityDeadlineExceededError',
  'RateLimitRejectedError',
  'ProviderCallCeilingExceededError',
] as const;

describe('TC-UNIT-01 (AC-5): each named R-3.3 refusal class settles the reserve as refunded', () => {
  it.each(R_3_3_NAMED_REFUSAL_CLASSES)(
    'refusalClass=%s -> refunded, refund_reason=%s',
    async (refusalClass) => {
      const stub = createBillingStoreStub();
      const spec = probeTool({ ok: false, reason: `refused: ${refusalClass}`, refusalClass });
      const handler = captureCallback(spec, contextOf(stub));

      await handler({}, {});

      expect(stub.rows).toHaveLength(1);
      expect(stub.rows[0]?.state).toBe('refunded');
      expect(stub.rows[0]?.refundReason).toBe(refusalClass);
    },
  );
});

/* --------------------------------------------------------------------------------------------- *
 * TC-UNIT-02 (AC-5) — the sixth R-3.3 member is different by construction: it never reaches a row.
 * --------------------------------------------------------------------------------------------- */

describe('TC-UNIT-02 (AC-5): ClientCreditsExhaustedError leaves no client_usage row', () => {
  it('reserve() itself refuses — no row exists, and neither settle() nor refund() is ever called', async () => {
    let settleCalls = 0;
    let refundCalls = 0;
    const billing: BillingStore = {
      reserve: async () => ({
        ok: false,
        reason: 'client credits exhausted',
        refusalClass: 'ClientCreditsExhaustedError',
      }),
      settle: async () => {
        settleCalls += 1;
        return { written: true };
      },
      refund: async () => {
        refundCalls += 1;
        return { written: true };
      },
      sumSettled: async () => '0',
    };
    const spec = probeTool({ ok: true, output: { note: 'never reached' } });
    const handler = captureCallback(spec, contextOf(billing));

    const result = (await handler({}, {})) as { isError?: boolean };

    expect(result.isError).toBe(true);
    expect(settleCalls).toBe(0);
    expect(refundCalls).toBe(0);
  });
});

/* --------------------------------------------------------------------------------------------- *
 * TC-UNIT-03 (AC-6) — a full answer past the deadline settles at the FULL reserved price.
 * --------------------------------------------------------------------------------------------- */

describe('TC-UNIT-03 (AC-6): a full answer past the ceiling settles at full price', () => {
  it("state='settled', charged amount = the reservation's own price_raw, request_trace.outcome='partial_deadline'", async () => {
    const stub = createBillingStoreStub();
    const traceStub = createRequestTraceStoreStub();
    const spec = probeTool({
      ok: true,
      output: { note: 'late but complete' },
      timing: { overrunMs: 1234 },
    });
    const handler = captureCallback(spec, contextOf(stub, { requestTrace: traceStub }));

    await handler({}, {});

    expect(stub.rows).toHaveLength(1);
    expect(stub.rows[0]?.state).toBe('settled');
    // `settle()` moves no value of its own — the charge IS `price_raw`, reserved up front
    // (`DEFAULT_PRICE_RAW`, PRICE_LIST is empty in phase 0).
    expect(stub.rows[0]?.priceRaw).toBe('1');
    expect(traceStub.appended).toHaveLength(1);
    expect(traceStub.appended[0]?.outcome).toBe('partial_deadline');
  });
});

/* --------------------------------------------------------------------------------------------- *
 * TC-UNIT-04 (AC-7) — a coalesced follower settles at full price too, with no special case.
 * --------------------------------------------------------------------------------------------- */

/** A fake `CapabilityResolver` whose `resolve()` reports exactly ONE vendor-spend record through the
 * observer it is handed — `bindCallObserver` (`registry.ts`'s own wrapper) always substitutes ITS
 * OWN `onVendorSpend` for the 5th positional argument, regardless of what a caller supplies, so this
 * is the one seam a wrapper-level test needs to make a leader/follower pair observable without
 * standing up a real vendor call or `packages/core`'s own singleflight machinery (out of this
 * task's scope — `packages/core/**` is explicitly untouched). */
function fakeResolvingRegistry(
  base: CapabilityRegistry,
  record: VendorSpendRecord,
): CapabilityResolver {
  return {
    getChainRegistry: () => base.getChainRegistry(),
    getCoverage: () => base.getCoverage(),
    resolve: async (
      _capability,
      _chain,
      _args,
      _requestedDeadlineAtMs,
      onVendorSpend,
    ): Promise<CapabilityResolution> => {
      onVendorSpend?.(record);
      return { result: 'ok', source: 'nansen', cache: 'miss' };
    },
  };
}

function resolvingProbeTool(name: string): ToolSpec {
  return defineTool({
    name,
    title: 'Probe (resolves)',
    description: 'resolves one capability through ctx.registry and reports what it got back',
    inputSchema: z.object({}),
    outputSchema: z.object({ note: z.string() }),
    capability: 'entity.labels',
    needs: ['registry'],
    handler: async (_input, ctx) => {
      const resolution = await ctx.registry.resolve('entity.labels', 'ethereum', {});
      return {
        ok: true as const,
        output: { note: String(resolution.result) },
        cache: {
          status: resolution.cache,
          provider: resolution.source,
          capability: 'entity.labels',
        },
      };
    },
  });
}

describe('TC-UNIT-04 (AC-7): a coalesced follower settles at the same full price as the leader', () => {
  it('one vendor call gives two settled rows; the follower carries served_from=coalesced', async () => {
    const stub = createBillingStoreStub();
    const traceStub = createRequestTraceStoreStub();
    const base = new CapabilityRegistry(routes, new Map());
    const at = { dayBucketMs: 1_700_000_000_000, windowStartMs: 1_700_000_060_000 };

    const chargeRecord: VendorSpendRecord = {
      v: 1,
      kind: 'charge',
      providerId: 'nansen',
      write: 'reservation',
      at,
      credits: 10,
      calls: 1,
    };
    const coalescedRecord: VendorSpendRecord = {
      v: 1,
      kind: 'coalesced',
      providerId: 'nansen',
      at,
      credits: null,
      calls: null,
    };

    // Two SEPARATE calls, exactly as the leader and the follower each reach the wrapper — R-3's own
    // "coalescing is invisible above resolve() by construction" (§3.5.3).
    await captureCallback(
      resolvingProbeTool('onchain_probe_leader'),
      contextOf(stub, {
        requestTrace: traceStub,
        registry: fakeResolvingRegistry(base, chargeRecord),
      }),
    )({}, {});
    await captureCallback(
      resolvingProbeTool('onchain_probe_follower'),
      contextOf(stub, {
        requestTrace: traceStub,
        registry: fakeResolvingRegistry(base, coalescedRecord),
      }),
    )({}, {});

    expect(stub.rows).toHaveLength(2);
    expect(stub.rows.map((row) => row.state)).toStrictEqual(['settled', 'settled']);
    expect(stub.rows[0]?.priceRaw).toBe(stub.rows[1]?.priceRaw);

    expect(traceStub.appended).toHaveLength(2);
    expect(traceStub.appended[0]?.servedFrom).toBe('vendor');
    expect(traceStub.appended[1]?.servedFrom).toBe('coalesced');
  });
});

/* --------------------------------------------------------------------------------------------- *
 * TC-UNIT-05 (AC-35) — the class this task exists to prove: one the codebase does not name today.
 * --------------------------------------------------------------------------------------------- */

describe("TC-UNIT-05 (AC-35): a refusal class outside R-3.3's named list is refunded too", () => {
  it('refunded, request_trace.refusal_class carries the synthetic name, tool.refused is emitted', async () => {
    const stub = createBillingStoreStub();
    const traceStub = createRequestTraceStoreStub();
    const diagStub = createDiagnosticsStoreStub();
    const diagnostics = createDiagnostics({
      store: diagStub,
      now: () => 1_770_000_000_000,
      writeStderr: () => undefined,
    });
    // A class name that is NOT one of the six R-3.3 members and does not appear anywhere else in
    // this codebase — deliberately, so this test cannot pass by accidentally coinciding with a real
    // class. `ToolOutcome.refusalClass` is typed `string` (registry.ts), NOT the closed
    // `BillingRefusalClass` union declared on `BillingStore.reserve()`'s own failure arm
    // (`billing-store.ts`). That union constrains only the THREE causes `reserve()` itself can
    // detect BEFORE a row exists (`ClientCreditsExhaustedError`, `BillingStoreUnavailableError`,
    // `ReplayWindowExpiredError`) — a HANDLER's own refusal, which is what this test drives, was
    // never a member of it. So no cast is needed here to make the type system accept a class it has
    // never seen: the field this rule actually reads is already open, by design, which is precisely
    // what R-3.4/AC-35 requires — a class need not be pre-declared anywhere to be refunded.
    const syntheticClass = 'ZzTotallyUnknownRefusalClassNeverDeclaredAnywhereInThisRepo';
    const spec = probeTool({
      ok: false,
      reason: 'synthetic refusal',
      refusalClass: syntheticClass,
    });
    const handler = captureCallback(
      spec,
      contextOf(stub, { requestTrace: traceStub, diagnostics }),
    );

    const result = (await handler({}, {})) as { isError?: boolean };

    expect(result.isError).toBe(true);

    // Follows the ledger.
    expect(stub.rows).toHaveLength(1);
    expect(stub.rows[0]?.state).toBe('refunded');
    expect(stub.rows[0]?.refundReason).toBe(syntheticClass);

    // Follows `request_trace.refusal_class` — `registry.ts`'s own coordinate for this
    // (`docs/tasks/task-015-11-outcome-total-function.md`'s table, "registry.ts:646").
    expect(traceStub.appended).toHaveLength(1);
    expect(traceStub.appended[0]?.refusalClass).toBe(syntheticClass);

    // Follows the `tool.refused` event — `registry.ts`'s own coordinate for this ("registry.ts:704").
    expect(diagStub.appended.filter((event) => event.event === 'tool.refused')).toHaveLength(1);
  });
});

/* --------------------------------------------------------------------------------------------- *
 * TC-UNIT-06 — the property that makes TC-UNIT-05 a consequence of construction, not a case: the
 * completion rule does not branch on `refusalClass`'s VALUE anywhere.
 * --------------------------------------------------------------------------------------------- */

describe("TC-UNIT-06: the completion rule does not branch on refusalClass's value", () => {
  it('two refusals with different, unrelated class names settle by the identical path', async () => {
    const stub = createBillingStoreStub();
    const specA = probeTool({ ok: false, reason: 'a', refusalClass: 'ClassNameA' });
    const specB = probeTool({ ok: false, reason: 'b', refusalClass: 'ClassNameB' });

    await captureCallback(specA, contextOf(stub))({}, {});
    await captureCallback(specB, contextOf(stub))({}, {});

    expect(stub.rows.map((row) => row.state)).toStrictEqual(['refunded', 'refunded']);
    expect(stub.rows.map((row) => row.refundReason)).toStrictEqual(['ClassNameA', 'ClassNameB']);
  });

  /**
   * The structural half, and the one that actually falls red under the mutation the task names
   * ("падает при внесении сравнения с именем класса в выражение выбора вызова"): a value-level
   * behavioural test above cannot distinguish "no branch" from "a branch that happens to treat both
   * chosen literals alike", so this reads the completion block's own source text — the same
   * technique `reservation-lifecycle.test.ts`'s own TC-UNIT-10 uses for its "one constant" gate.
   */
  it('the completion selector reads outcome.ok alone — no literal refusalClass comparison anywhere in it', () => {
    const file = path.resolve(fileURLToPath(import.meta.url), '../../src/tools/registry.ts');
    const text = readFileSync(file, 'utf8');
    const start = text.indexOf('if (reserved.ok) {');
    const end = text.indexOf('// `reserved.ok === false`', start);
    expect(start, 'the completion block start anchor was not found').toBeGreaterThan(0);
    expect(end, 'the completion block end anchor was not found').toBeGreaterThan(start);
    const block = text.slice(start, end);

    expect(block).not.toMatch(/refusalClass\s*(===|==|!==|!=)/);
    expect(block).not.toMatch(/\bcase\s+'/);
    expect(block).not.toMatch(/\bswitch\s*\(/);
    // The rule it DOES read — the one comparison the selector is built on.
    expect(block).toMatch(/outcome\.ok\s*\?/);
  });
});

/* --------------------------------------------------------------------------------------------- *
 * TC-UNIT-07 — a refusal with no class at all still gets a non-empty, DECLARED reason.
 * --------------------------------------------------------------------------------------------- */

describe('TC-UNIT-07: a refusal with no class gets the declared default reason', () => {
  it('refund_reason is non-empty even when outcome.refusalClass is absent, and matches the declared literal', async () => {
    const stub = createBillingStoreStub();
    const spec = probeTool({ ok: false, reason: 'refused, no class known' }); // refusalClass omitted
    const handler = captureCallback(spec, contextOf(stub));

    await handler({}, {});

    expect(stub.rows).toHaveLength(1);
    expect(stub.rows[0]?.state).toBe('refunded');
    expect(stub.rows[0]?.refundReason).not.toBeNull();
    expect(stub.rows[0]?.refundReason).not.toBe('');

    // Read from source rather than hardcoded a second time, so this assertion cannot silently agree
    // with a value the implementation has since changed — it proves "the declared default", not "the
    // string 'unclassified' specifically" (`data-model.md`'s CHECK ((state = 'refunded') = (refund_reason
    // IS NOT NULL)) — an empty value here would have been rejected by the engine).
    const source = readFileSync(
      path.resolve(fileURLToPath(import.meta.url), '../../src/tools/registry.ts'),
      'utf8',
    );
    const declaredDefault = source.match(/outcome\.refusalClass \?\? '([^']+)'/)?.[1];
    expect(
      declaredDefault,
      'no declared default literal was found beside outcome.refusalClass ?? ',
    ).not.toBeUndefined();
    expect(stub.rows[0]?.refundReason).toBe(declaredDefault);
  });
});

/* --------------------------------------------------------------------------------------------- *
 * TC-UNIT-08 — the success arm's OTHER member: no overrun at all, same settlement path.
 * --------------------------------------------------------------------------------------------- */

describe('TC-UNIT-08: a success without an overrun settles the same way as one with an overrun', () => {
  it("state='settled', request_trace.outcome='answer', the same charged amount as TC-UNIT-03", async () => {
    const stub = createBillingStoreStub();
    const traceStub = createRequestTraceStoreStub();
    const spec = probeTool({ ok: true, output: { note: 'on time' } }); // no `timing` at all
    const handler = captureCallback(spec, contextOf(stub, { requestTrace: traceStub }));

    await handler({}, {});

    expect(stub.rows).toHaveLength(1);
    expect(stub.rows[0]?.state).toBe('settled');
    expect(stub.rows[0]?.priceRaw).toBe('1'); // same DEFAULT_PRICE_RAW as TC-UNIT-03
    expect(traceStub.appended).toHaveLength(1);
    expect(traceStub.appended[0]?.outcome).toBe('answer');
  });
});
