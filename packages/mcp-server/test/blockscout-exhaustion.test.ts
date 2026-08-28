import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  CapabilityRegistry,
  ProviderCallCeilingExceededError,
  adapterRegistrations,
  bindCallObserver,
  createBlockscoutAdapter,
  createThrottle,
  routes,
  type CapabilityResolver,
  type CapabilityWalk,
  type EntityLabel,
  type ProviderAdapter,
  type Throttle,
} from '@onchain-intel/core';
import { STDIO_PRINCIPAL } from '../src/auth/principal.js';
import { createBillingStoreStub } from '../src/engine/billing-store.js';
import { createDiagnostics, type Diagnostics } from '../src/engine/diagnostics.js';
import { createDiagnosticsStore, DIAGNOSTIC_EVENTS } from '../src/engine/diagnostics-store.js';
import { createRequestTraceStore } from '../src/engine/request-trace-store.js';
import { isPaidProvider } from '../src/tools/budget-meta.js';
import { detectEscalation } from '../src/tools/escalation.js';
import { defineTool } from '../src/tools/registry.js';
import { resolveCapability } from '../src/tools/resolve-capability.js';
import { createSqliteEngine, type SqliteEngine } from './helpers/sqlite-engine.js';

/**
 * Task 015-17 — daily call-ceiling exhaustion is observable on all four `blockscout` routes, through
 * the channels T-014 already built (`request_trace.escalated_to_paid`, `source.escalated_to_paid`,
 * `tool.refused`). 015-12..015-16 built the gate itself; this file is about what each ROUTE does
 * once it refuses, not the gate's own contract (`packages/core/test/blockscout-call-gate.test.ts`
 * owns that, at the adapter/registry seam).
 *
 * **Why this drives a REAL `CapabilityRegistry` traversal rather than a hand-built `CapabilityWalk`
 * (task's own instruction — "убедись измерением, а не прими на веру").**
 * `free-to-paid-escalation.test.ts`'s own `resolverEntering()` fabricates `attempted: [FREE, PAID]`
 * directly and never runs a single adapter — so it proves `detectEscalation`'s CONDITION, never that
 * a real gate refusal actually reaches `bindCallObserver`'s `onWalk` in the shape that condition
 * expects. Every registry here is `new CapabilityRegistry([...routes], adapters)` over a REAL
 * `createBlockscoutAdapter` whose injected `callGate` throws `ProviderCallCeilingExceededError` —
 * the same class `packages/core/src/adapters/blockscout/call-gate.ts` throws in production — and the
 * walk is read back through the SAME `bindCallObserver` wrapper `tools/registry.ts:531` installs per
 * request, not reconstructed by hand.
 */

const NOW = 1_700_000_000_000;
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const BINANCE = '0x28C6c06298d514Db089934071355E5743bf21d60';

const CEILING_DETAIL =
  'daily calls spent for provider=blockscout: 625 of 625 calls already made today ' +
  `(day starts ${NOW})`;

/** A virtual-clock throttle (same construction `packages/core/test/helpers/isolated-throttle.ts`
 * uses) so no test here spends a real millisecond waiting on the per-second limiter — only the
 * DAILY gate is under test. Not reused from that helper: it is a `packages/core`-internal test
 * fixture, unreachable from `packages/mcp-server` through the public barrel. */
function virtualThrottle(startMs: number): Throttle {
  let clock = startMs;
  return createThrottle({
    now: () => clock,
    wait: (ms) => {
      clock += ms;
      return Promise.resolve();
    },
  });
}

/** Never reached unless the gate fails to refuse before the network attempt — a bug this fixture
 * turns into a loud rejection instead of a silent pass. */
const NEVER_FETCH = ((): Promise<Response> =>
  Promise.reject(
    new Error(
      'blockscout: fetchImpl reached — the call gate should have refused before any network attempt',
    ),
  )) as unknown as typeof fetch;

/** A `blockscout` adapter whose daily call gate is ALREADY at the declared ceiling — the state
 * task 015-13/015-14's counter reaches after 625 admitted calls (task's own `providers.config.ts`
 * ceiling), reproduced here without actually making 625 calls. */
function exhaustedBlockscout(): ProviderAdapter {
  return createBlockscoutAdapter({
    now: () => NOW,
    env: { BLOCKSCOUT_PRO_API_KEY: 'proapi_test_placeholder_not_a_secret' },
    callGate: {
      ensureCallBudget: async () => {
        throw new ProviderCallCeilingExceededError(CEILING_DETAIL);
      },
    },
    throttle: virtualThrottle(NOW),
    fetchImpl: NEVER_FETCH,
  });
}

/** A stand-in paid `nansen` — same shape `packages/core/test/blockscout-fallback.test.ts`'s own
 * `nansenSpy` uses, narrowed to what `entity.labels`'s `someElementHasAny` policy needs to be
 * satisfied. */
function nansenSpy(): ProviderAdapter {
  const answer: EntityLabel[] = [
    {
      chain: 'ethereum',
      address: BINANCE,
      name: 'Binance: Hot Wallet',
      tags: [],
      labels: ['Binance: Hot Wallet'],
      premiumRequested: false,
      source: 'nansen',
      fetchedAt: 0,
    },
  ];
  return {
    id: 'nansen',
    capabilities: () => [{ id: 'entity.labels' }],
    costOf: () => ({ credits: 0 }),
    chainSupport: () => true,
    fetch: () => Promise.resolve({ kind: 'nansen' }),
    normalize: () => answer,
    isAvailable: () => ({ ok: true }),
  };
}

/**
 * Stands in for `rpc-evm` on a chain with NO curated RPC host. The real adapter's own
 * `chainSupport()` (`packages/core/src/adapters/rpc-evm/index.ts`) answers `false` in exactly that
 * state — "any EVM chain, but ONLY if the registry carries a curated RPC host" — and the registry's
 * chain-scoped skip does not record a `false` `chainSupport()` in `tried` at all (silent, by
 * design: `adapters/registry.ts`'s own comment beside that branch, "this adapter does not serve
 * this chain" is not an attempt that failed").
 */
function rpcEvmWithNoCuratedRpc(): ProviderAdapter {
  return {
    id: 'rpc-evm',
    capabilities: () => [{ id: 'gas.price' }],
    costOf: () => ({ credits: 0 }),
    chainSupport: () => false,
    fetch: () =>
      Promise.reject(new Error('rpc-evm: fetch reached despite chainSupport() === false')),
    normalize: () => {
      throw new Error('rpc-evm: normalize reached despite chainSupport() === false');
    },
    isAvailable: () => ({ ok: true }),
  };
}

function registryOver(
  adapters: readonly (readonly [string, ProviderAdapter])[],
): CapabilityResolver {
  return new CapabilityRegistry([...routes], new Map(adapters));
}

/**
 * Resolves through the SAME per-request observer `tools/registry.ts:531` installs in production
 * (`bindCallObserver`), and hands back the `CapabilityWalk[]` it collected alongside the outcome —
 * so a test can feed the walk straight to `detectEscalation` exactly as the tool wrapper does,
 * without reconstructing one by hand.
 */
async function observedResolve(
  raw: CapabilityResolver,
  capability: string,
  chain: string,
  args: Record<string, unknown>,
): Promise<{ outcome: Awaited<ReturnType<typeof resolveCapability>>; walks: CapabilityWalk[] }> {
  const walks: CapabilityWalk[] = [];
  const observed = bindCallObserver(raw, {
    onCall: () => undefined,
    onWalk: (walk) => walks.push(walk),
    onVendorSpend: () => undefined,
  });
  const outcome = await resolveCapability(observed, capability, chain, args);
  return { outcome, walks };
}

describe('the routing table this task documents (config-drift guard)', () => {
  it('the four routes still name the adapters and order the task table asserts', () => {
    expect(routes.find((r) => r.capability === 'entity.labels')?.adapterIds).toEqual([
      'blockscout',
      'nansen',
    ]);
    expect(routes.find((r) => r.capability === 'token.holders')?.adapterIds).toEqual([
      'blockscout',
    ]);
    expect(routes.find((r) => r.capability === 'chain.transactions')?.adapterIds).toEqual([
      'blockscout',
    ]);
    expect(routes.find((r) => r.capability === 'gas.price')?.adapterIds).toEqual([
      'rpc-evm',
      'blockscout',
    ]);
    expect(adapterRegistrations.find((r) => r.id === 'nansen')?.tier).toBe('paid');
    expect(adapterRegistrations.find((r) => r.id === 'rpc-evm')?.tier).toBe('free');
    expect(adapterRegistrations.find((r) => r.id === 'blockscout')?.tier).toBe('free');
  });
});

describe('TC-UNIT-01: entity.labels exhaustion escalates to nansen, through a real registry traversal', () => {
  it('blockscout is entered and refused by the gate; nansen is entered and answers', async () => {
    const registry = registryOver([
      ['blockscout', exhaustedBlockscout()],
      ['nansen', nansenSpy()],
    ]);
    const { outcome, walks } = await observedResolve(registry, 'entity.labels', 'ethereum', {
      chain: 'ethereum',
      tokenAddress: BINANCE,
    });

    expect(outcome.ok, outcome.ok ? '' : outcome.reason).toBe(true);
    expect(walks).toHaveLength(1);
    expect(walks[0]?.tried.map((t) => t.adapterId)).toEqual(['blockscout', 'nansen']);

    // The measurement the task asks for by name: does `detectEscalation` actually see the walk a
    // REAL gate refusal produced. `free-to-paid-escalation.test.ts`'s own `resolverEntering()`
    // fabricates `attempted` directly and never exercises this path.
    expect(detectEscalation(walks)).toStrictEqual({
      capability: 'entity.labels',
      chain: 'ethereum',
      from: 'blockscout',
      to: 'nansen',
    });
  });
});

describe('TC-UNIT-03/04: exhaustion on a single-adapter route ends the route in refusal', () => {
  const cases: readonly [string, Record<string, unknown>][] = [
    ['token.holders', { chain: 'ethereum', tokenAddress: USDC }],
    ['chain.transactions', { chain: 'ethereum' }],
  ];

  for (const [capability, args] of cases) {
    it(`${capability}: CapabilityUnavailableError, no next adapter`, async () => {
      const registry = registryOver([['blockscout', exhaustedBlockscout()]]);
      const { outcome, walks } = await observedResolve(registry, capability, 'ethereum', args);

      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.refusalClass).toBe('CapabilityUnavailableError');
        expect(outcome.reason).toContain('daily call ceiling reached');
      }
      expect(walks).toHaveLength(1);
      expect(walks[0]?.tried).toHaveLength(1);
      expect(walks[0]?.tried[0]?.adapterId).toBe('blockscout');
    });
  }
});

describe('TC-UNIT-05: the ceiling refusal text does not overlap the bucket refusal text, at this layer', () => {
  it('the two owner substrings partition the reasons resolveCapability actually returns', async () => {
    const ceilingRegistry = registryOver([['blockscout', exhaustedBlockscout()]]);
    const ceiling = await resolveCapability(ceilingRegistry, 'token.holders', 'ethereum', {
      chain: 'ethereum',
      tokenAddress: USDC,
    });

    // A bucket-saturation refusal, mirrored — not imported — from its real wire format:
    // `RateLimitRejectedError` (`packages/core/src/net/rate-limit.ts:261-277`,
    // `throttle: rejected for provider "${providerId}": ${reason}`) is an internal `packages/core`
    // class, not on `@onchain-intel/core`'s public barrel this package can reach. The BYTE-IDENTICAL
    // property against the real class is `packages/core/test/blockscout-call-gate.test.ts`'s own
    // TC-UNIT-07; this proves the same partition survives to the text `resolveCapability` hands this
    // package's own callers, which is the fact this layer can observe.
    const saturatingThrottle: Throttle = () =>
      Promise.reject(
        new Error(
          'throttle: rejected for provider "blockscout": computed wait 900ms exceeds the ' +
            '30000ms fairness cap (saturated bucket)',
        ),
      );
    const bucketRegistry = registryOver([
      [
        'blockscout',
        createBlockscoutAdapter({
          now: () => NOW,
          env: { BLOCKSCOUT_PRO_API_KEY: 'proapi_test_placeholder_not_a_secret' },
          callGate: { ensureCallBudget: async () => undefined },
          throttle: saturatingThrottle,
          fetchImpl: NEVER_FETCH,
        }),
      ],
    ]);
    const bucket = await resolveCapability(bucketRegistry, 'token.holders', 'ethereum', {
      chain: 'ethereum',
      tokenAddress: USDC,
    });

    expect(ceiling.ok).toBe(false);
    expect(bucket.ok).toBe(false);
    const ceilingText = !ceiling.ok ? ceiling.reason : '';
    const bucketText = !bucket.ok ? bucket.reason : '';

    expect(ceilingText).toContain('daily call ceiling reached');
    expect(bucketText).not.toContain('daily call ceiling reached');
    expect(bucketText).toContain('throttle: rejected');
    expect(ceilingText).not.toContain('throttle: rejected');
    expect(ceilingText).not.toContain('rate limit');
    expect(ceilingText).not.toContain('bucket');
  });
});

describe('TC-UNIT-06/07: gas.price exhaustion removes the free fallback and never escalates', () => {
  it('refuses the route; rpc-evm is silently chain-skipped; no paid adapter is ever entered', async () => {
    const registry = registryOver([
      ['rpc-evm', rpcEvmWithNoCuratedRpc()],
      ['blockscout', exhaustedBlockscout()],
    ]);
    const { outcome, walks } = await observedResolve(registry, 'gas.price', 'ethereum', {
      chain: 'ethereum',
    });

    expect(outcome.ok).toBe(false);
    if (!outcome.ok) {
      expect(outcome.refusalClass).toBe('CapabilityUnavailableError');
      expect(outcome.reason).toContain('daily call ceiling reached');
    }
    expect(walks).toHaveLength(1);
    // rpc-evm never appears: the chain-scoped skip is silent by design. Only the adapter actually
    // entered (blockscout) is recorded.
    expect(walks[0]?.tried.map((t) => t.adapterId)).toEqual(['blockscout']);
    for (const attempt of walks[0]?.tried ?? []) {
      expect(isPaidProvider(attempt.adapterId)).toBe(false);
    }
    expect(detectEscalation(walks)).toBeNull();
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Wired: request_trace + diagnostics, through the SAME `defineTool` wrapper production registers
// tools with — mirrors `free-to-paid-escalation.test.ts`'s own "Wired" section, generalised over
// the capability under test instead of being fixed to `entity.labels`.
// ════════════════════════════════════════════════════════════════════════════════════════════════

function freshHarness(): SqliteEngine {
  return createSqliteEngine();
}

function channelOver(harness: SqliteEngine, stderr: string[]): Diagnostics {
  return createDiagnostics({
    store: createDiagnosticsStore(harness.engine),
    now: () => NOW,
    writeStderr: (line) => stderr.push(line),
  });
}

/** Registers a probe tool over one capability/chain/args and returns its captured callback — the
 * same scaffold `free-to-paid-escalation.test.ts`'s own `handlerOver` uses, generalised over the
 * capability under test rather than fixed to `entity.labels`. */
function probeToolOver(
  harness: SqliteEngine,
  capability: string,
  chain: string,
  args: Record<string, unknown>,
  registry: CapabilityResolver,
  diagnostics: Diagnostics,
): (input: unknown, extra: unknown) => Promise<unknown> {
  let captured: ((input: unknown, extra: unknown) => Promise<unknown>) | undefined;
  const spec = defineTool({
    name: 'onchain_exhaustion_probe',
    title: 'Exhaustion probe',
    description: 'resolves one capability unmodified, so the exhaustion channel can be measured',
    inputSchema: z.object({}),
    outputSchema: z.object({ probed: z.boolean() }),
    capability,
    needs: ['registry'],
    handler: async (_input, ctx) => {
      const outcome = await resolveCapability(ctx.registry, capability, chain, args);
      if (!outcome.ok) {
        return { ok: false as const, reason: outcome.reason, refusalClass: outcome.refusalClass };
      }
      return { ok: true as const, output: { probed: true } };
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
    billing: createBillingStoreStub(),
    now: () => NOW,
  });
  if (captured === undefined) throw new Error('the probe tool did not register');
  return captured;
}

describe('TC-UNIT-02: the escalation is recorded beside the spend, produced by a real gate refusal', () => {
  it('sets request_trace.escalated_to_paid=1 and writes one source.escalated_to_paid event', async () => {
    const harness = freshHarness();
    try {
      const registry = registryOver([
        ['blockscout', exhaustedBlockscout()],
        ['nansen', nansenSpy()],
      ]);
      const diagnostics = channelOver(harness, []);
      const handler = probeToolOver(
        harness,
        'entity.labels',
        'ethereum',
        { chain: 'ethereum', tokenAddress: BINANCE },
        registry,
        diagnostics,
      );
      const result = (await handler({}, {})) as { isError?: boolean };

      expect(result.isError).not.toBe(true);
      const rows = harness.db.prepare('SELECT * FROM request_trace').all() as Record<
        string,
        unknown
      >[];
      expect(rows).toHaveLength(1);
      expect(rows[0]?.['escalated_to_paid']).toBe(1);

      const events = harness.db.prepare('SELECT * FROM diagnostics').all() as Record<
        string,
        unknown
      >[];
      expect(events).toHaveLength(1);
      expect(events[0]?.['event']).toBe('source.escalated_to_paid');
      expect(events[0]?.['trace_id']).toBe(rows[0]?.['id']);
      const detail = JSON.parse(String(events[0]?.['detail_json'])) as Record<string, unknown>;
      expect(detail['from']).toBe('blockscout');
      expect(detail['to']).toBe('nansen');
    } finally {
      harness.close();
    }
  });
});

describe('TC-UNIT-08: the diagnostics vocabulary is not widened by this task', () => {
  const refusingCases: readonly [string, Record<string, unknown>][] = [
    ['token.holders', { chain: 'ethereum', tokenAddress: USDC }],
    ['chain.transactions', { chain: 'ethereum' }],
    ['gas.price', { chain: 'ethereum' }],
  ];

  for (const [capability, args] of refusingCases) {
    it(`${capability}: refusal writes exactly one tool.refused row`, async () => {
      const harness = freshHarness();
      try {
        const adapters: [string, ProviderAdapter][] =
          capability === 'gas.price'
            ? [
                ['rpc-evm', rpcEvmWithNoCuratedRpc()],
                ['blockscout', exhaustedBlockscout()],
              ]
            : [['blockscout', exhaustedBlockscout()]];
        const registry = registryOver(adapters);
        const diagnostics = channelOver(harness, []);
        const handler = probeToolOver(harness, capability, 'ethereum', args, registry, diagnostics);
        await handler({}, {});

        const events = harness.db.prepare('SELECT * FROM diagnostics').all() as Record<
          string,
          unknown
        >[];
        expect(events).toHaveLength(1);
        expect(events[0]?.['event']).toBe('tool.refused');
      } finally {
        harness.close();
      }
    });
  }

  it('entity.labels escalation writes exactly one source.escalated_to_paid row (reaffirms TC-UNIT-02)', async () => {
    const harness = freshHarness();
    try {
      const registry = registryOver([
        ['blockscout', exhaustedBlockscout()],
        ['nansen', nansenSpy()],
      ]);
      const diagnostics = channelOver(harness, []);
      const handler = probeToolOver(
        harness,
        'entity.labels',
        'ethereum',
        { chain: 'ethereum', tokenAddress: BINANCE },
        registry,
        diagnostics,
      );
      await handler({}, {});

      const events = harness.db.prepare('SELECT * FROM diagnostics').all() as Record<
        string,
        unknown
      >[];
      expect(events).toHaveLength(1);
      expect(events[0]?.['event']).toBe('source.escalated_to_paid');
    } finally {
      harness.close();
    }
  });

  it('every event name used above belongs to the closed 8-event vocabulary', () => {
    expect(DIAGNOSTIC_EVENTS).toContain('tool.refused');
    expect(DIAGNOSTIC_EVENTS).toContain('source.escalated_to_paid');
    expect(DIAGNOSTIC_EVENTS).toHaveLength(8);
  });
});
