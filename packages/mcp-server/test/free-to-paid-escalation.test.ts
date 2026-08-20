import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  adapterRegistrations,
  loadChainRegistry,
  type CapabilityResolution,
  type CapabilityResolver,
  type CapabilityWalk,
} from '@onchain-intel/core';
import { STDIO_PRINCIPAL } from '../src/auth/principal.js';
import { createDiagnostics, type Diagnostics } from '../src/engine/diagnostics.js';
import { createDiagnosticsStore } from '../src/engine/diagnostics-store.js';
import { createRequestTraceStore } from '../src/engine/request-trace-store.js';
import { detectEscalation } from '../src/tools/escalation.js';
import { defineTool } from '../src/tools/registry.js';
import { resolveCapability } from '../src/tools/resolve-capability.js';
import { createSqliteEngine, type SqliteEngine } from './helpers/sqlite-engine.js';

/**
 * Task 014-28 — the free→paid escalation is observable (R-28, AC-43).
 *
 * **The condition, decided 2026-08-20 (`OQ-014-28-A`): a free source was ENTERED and a paid one was
 * entered after it.** The alternative reading — "the free source was EXHAUSTED" — cannot be observed
 * by this engine: `blockscout`'s PRO key meters credits at the vendor, we keep no counter, and
 * `ADR-003` assigns that counter to T-015. Shipping under it would have left the mechanism green and
 * silent forever.
 *
 * **Two carriers, one condition.** The column answers "did this request escalate", beside the spend
 * it escalated into; the event answers "which pair, at what cost", in a channel an operator reads.
 */

const PAID = adapterRegistrations.find((r) => r.tier === 'paid')?.id ?? 'nansen';
const FREE = adapterRegistrations.find((r) => r.tier === 'free')?.id ?? 'defillama';

const walk = (tried: string[], capability = 'entity.labels'): CapabilityWalk => ({
  capability,
  chain: 'ethereum',
  tried: tried.map((adapterId) => ({ adapterId })),
});

describe('the detector, on the walks alone', () => {
  it('TC-UNIT-04 input: a free source entered before a paid one IS an escalation', () => {
    expect(detectEscalation([walk([FREE, PAID])])).toStrictEqual({
      capability: 'entity.labels',
      chain: 'ethereum',
      from: FREE,
      to: PAID,
    });
  });

  it('TC-UNIT-05: a walk of free sources only is not', () => {
    expect(detectEscalation([walk(['rpc-evm', 'blockscout'], 'gas.price')])).toBeNull();
    expect(detectEscalation([])).toBeNull();
  });

  it('TC-UNIT-03: a paid source with NO free source ahead of it is not an escalation', () => {
    // Nothing was escalated FROM. The rewritten TC-UNIT-03: the original asked for "a transition
    // without exhaustion", which is not a state this engine can observe — see the file docstring.
    expect(detectEscalation([walk([PAID])])).toBeNull();
    expect(detectEscalation([walk([PAID, FREE])])).toBeNull();
  });

  it('reports the free source entered IMMEDIATELY before the paid one', () => {
    // `adapterIds` order encodes spend priority, so the adapter directly ahead of the paid one is
    // the last cheaper option tried — the one an operator asks about first.
    const found = detectEscalation([walk(['rpc-evm', 'blockscout', PAID])]);
    expect(found?.from).toBe('blockscout');
    expect(found?.to).toBe(PAID);
  });

  it('a paid source that was entered and FAILED still counts', () => {
    // Decided 2026-08-20. The rule is "entered", the same rule `paidProviderToReport` applies: a
    // source that was entered can have committed a reservation. Whether it answered is a different
    // column.
    expect(detectEscalation([walk([FREE, PAID])])?.to).toBe(PAID);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Wired: the column and the event, through the `defineTool` wrapper
// ════════════════════════════════════════════════════════════════════════════════════════════════

let harness: SqliteEngine;
let stderr: string[];

beforeEach(() => {
  harness = createSqliteEngine();
  stderr = [];
});

afterEach(() => {
  harness.close();
});

const rows = (): Record<string, unknown>[] =>
  harness.db.prepare('SELECT * FROM request_trace').all() as Record<string, unknown>[];

const events = (): Record<string, unknown>[] =>
  harness.db.prepare('SELECT * FROM diagnostics').all() as Record<string, unknown>[];

/** A resolver that answers with the traversal the case is about, and nothing else. */
function resolverEntering(attempted: string[]): CapabilityResolver {
  const chains = loadChainRegistry();
  return {
    getChainRegistry: () => chains,
    getCoverage: () => {
      throw new Error('not used');
    },
    resolve: (): Promise<CapabilityResolution> =>
      Promise.resolve({
        result: { labels: [] },
        source: attempted.at(-1) ?? FREE,
        cache: 'miss',
        attempted,
      }),
  };
}

/** Registers a tool that resolves `entity.labels`, and returns its wrapped callback. */
function handlerOver(registry: CapabilityResolver, diagnostics: Diagnostics) {
  let captured: ((input: unknown, extra: unknown) => Promise<unknown>) | undefined;
  const spec = defineTool({
    name: 'onchain_escalating',
    title: 'Escalating',
    description: 'resolves a capability that can escalate',
    inputSchema: z.object({}),
    outputSchema: z.object({ labels: z.array(z.string()) }),
    capability: 'entity.labels',
    needs: ['registry'],
    handler: async (_input, ctx) => {
      const outcome = await resolveCapability(ctx.registry, 'entity.labels', 'ethereum', {});
      if (!outcome.ok) return { ok: false as const, reason: outcome.reason };
      return { ok: true as const, output: { labels: [] } };
    },
  });
  const fakeServer = {
    registerTool: (
      _name: string,
      _config: unknown,
      callback: (input: unknown, extra: unknown) => Promise<unknown>,
    ) => {
      captured = callback;
    },
  } as unknown as McpServer;
  spec.register(fakeServer, {
    version: '0.0.0-test',
    registry,
    principal: STDIO_PRINCIPAL,
    diagnostics,
    requestTrace: createRequestTraceStore(harness.engine),
  });
  if (captured === undefined) throw new Error('the tool did not register');
  return captured;
}

const channel = (): Diagnostics =>
  createDiagnostics({
    store: createDiagnosticsStore(harness.engine),
    now: () => 1_770_000_000_000,
    writeStderr: (line) => stderr.push(line),
  });

describe('TC-UNIT-04 / 28.2: the escalation is recorded beside the spend', () => {
  it('sets `escalated_to_paid = 1` on the trace row of that request', async () => {
    const handler = handlerOver(resolverEntering([FREE, PAID]), channel());
    await handler({}, {});

    expect(rows()).toHaveLength(1);
    expect(rows()[0]?.['escalated_to_paid']).toBe(1);
  });
});

describe('TC-UNIT-05: a request served by a free source leaves the flag at 0', () => {
  it('and writes no event', async () => {
    const handler = handlerOver(resolverEntering([FREE]), channel());
    await handler({}, {});

    expect(rows()[0]?.['escalated_to_paid']).toBe(0);
    expect(events()).toStrictEqual([]);
  });
});

describe('TC-E2E-01 / AC-43 and TC-UNIT-02: the event names the pair and the cost', () => {
  it('reaches the diagnostics channel with capability, chain, both sources and the spend', async () => {
    const handler = handlerOver(resolverEntering([FREE, PAID]), channel());
    await handler({}, {});

    expect(events()).toHaveLength(1);
    const row = events()[0];
    expect(row?.['event']).toBe('source.escalated_to_paid');
    expect(row?.['provider']).toBe(PAID);
    expect(row?.['capability']).toBe('entity.labels');
    // The row is joinable to the request it describes — the whole point of recording both.
    expect(row?.['trace_id']).toBe(rows()[0]?.['id']);

    const detail = JSON.parse(String(row?.['detail_json'])) as Record<string, unknown>;
    expect(detail['capability']).toBe('entity.labels');
    expect(detail['chain']).toBe('ethereum');
    expect(detail['from']).toBe(FREE);
    expect(detail['to']).toBe(PAID);
    // The amount comes from the SAME receipts the row collapses; this fixture spends nothing, and
    // an escalation that spent nothing is still an escalation.
    expect(detail).toHaveProperty('vendorCredits');
    expect(detail).toHaveProperty('vendorCalls');
    expect(detail['vendorCredits']).toBe(rows()[0]?.['vendor_credits'] ?? null);
  });
});

describe('TC-UNIT-01: the paid source is not disabled', () => {
  it('the walk still reaches it and the request is answered', async () => {
    // The rejected alternative was to switch the paid source off once the free one is spent. On
    // `entity.labels` that would extinguish the capability for the rest of the day at exactly the
    // moment the free source ran out — the owner considered it and refused.
    const handler = handlerOver(resolverEntering([FREE, PAID]), channel());
    const result = (await handler({}, {})) as { isError?: boolean };

    expect(result.isError).not.toBe(true);
    expect(rows()[0]?.['outcome']).toBe('answer');
  });
});

describe('the prohibition: a receipt is not evidence of paidness', () => {
  it('a walk of two FREE sources leaves the flag at 0 however much it metered', () => {
    // `ADR-003` D6 extends the call counter to every provider, so `gas.price` —
    // `['rpc-evm', 'blockscout']`, both `tier: 'free'` — produces receipts with no paid participant.
    // Inferring paidness from spend would set the flag on a walk whose own `_meta.budget` is absent,
    // because `paidProviderToReport` found no `tier: 'paid'` among the entered.
    for (const id of ['rpc-evm', 'blockscout']) {
      expect(
        adapterRegistrations.find((r) => r.id === id)?.tier,
        `${id} must be free for this case to mean anything`,
      ).toBe('free');
    }
    expect(detectEscalation([walk(['rpc-evm', 'blockscout'], 'gas.price')])).toBeNull();
  });
});
