import { describe, expect, it } from 'vitest';
import { CapabilityRegistry } from '@onchain-intel/core';
import type { BudgetStore, CapabilityRoute, ProviderAdapter } from '@onchain-intel/core';
import {
  SmartMoneyFlowsInputSchema,
  smartMoneyFlowsHandler,
} from '../../src/tools/smart-money-flows.js';

/**
 * Unit tests for `src/tools/smart-money-flows.ts` (task 005-6, R-41) — see `get-token.test.ts`'s
 * docstring for the shared testing convention (small purpose-built `CapabilityRegistry`, no
 * transport, no real `nansen` adapter/network — a FAKE `ProviderAdapter` stands in for it, exactly
 * like `fakeCoingeckoAdapter()` does for M1). The full-stack proof through the REAL `nansen`
 * adapter (singleflight/budget-gate/reconcile actually running) lives in
 * `test/e2e.inprocess.test.ts` and `test/nansen-production-wiring.integration.test.ts`.
 */

const ETH_ADDRESS = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const SOL_ADDRESS = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const ROUTES: CapabilityRoute[] = [
  { capability: 'smart-money.flows', chains: ['ethereum', 'solana'], adapterIds: ['nansen'] },
];

const FAKE_FLOW = {
  chain: 'ethereum' as const,
  tokenAddress: ETH_ADDRESS,
  tokenSymbol: 'UNI',
  netflow1hUsd: 100,
  netflow24hUsd: 200,
  netflow7dUsd: 300,
  netflow30dUsd: 400,
  topHolders: [],
  source: 'nansen',
  fetchedAt: 1_800_000_000_000,
};

function fakeNansenAdapter(overrides: Partial<ProviderAdapter> = {}): ProviderAdapter {
  return {
    id: 'nansen',
    capabilities: () => [{ id: 'smart-money.flows', chains: ['ethereum', 'solana'] }],
    costOf: () => ({ credits: 10 }),
    fetch: async () => ({}),
    normalize: () => FAKE_FLOW,
    isAvailable: () => ({ ok: true }),
    ...overrides,
  };
}

/** A `BudgetStore` whose `getUsage` always resolves to a fixed value — no real SQLite. */
function fakeBudgetStore(overrides: Partial<BudgetStore> = {}): BudgetStore {
  return {
    checkAndReserve: async () => ({ ok: true }),
    recordDelta: async () => undefined,
    getUsage: async () => 10,
    getWindowUsage: async () => 0,
    ...overrides,
  };
}

describe('SmartMoneyFlowsInputSchema', () => {
  it('accepts a valid ethereum tokenAddress', () => {
    expect(() =>
      SmartMoneyFlowsInputSchema.parse({ chain: 'ethereum', tokenAddress: ETH_ADDRESS }),
    ).not.toThrow();
  });

  it('accepts a valid solana tokenAddress', () => {
    expect(() =>
      SmartMoneyFlowsInputSchema.parse({ chain: 'solana', tokenAddress: SOL_ADDRESS }),
    ).not.toThrow();
  });

  // CHANGED EXPECTATION (task 006-6, R-50). The schema used to reject anything outside a
  // two-value enum. It now accepts any chain the REGISTRY knows and rejects only what the registry
  // does not — because refusing at the schema is the wrong layer for "this capability is not
  // served there": that answer belongs to the coverage matrix, which can say WHERE it IS served
  // (§4.2.3). A schema-level refusal could only say "no".
  it('accepts any registry chain and rejects an unknown one (R-50c)', () => {
    expect(() =>
      SmartMoneyFlowsInputSchema.parse({ chain: 'ethereum', tokenAddress: ETH_ADDRESS }),
    ).not.toThrow();
    const unknown = SmartMoneyFlowsInputSchema.safeParse({
      chain: 'not-a-real-chain',
      tokenAddress: ETH_ADDRESS,
    });
    expect(unknown.success).toBe(false);
    if (!unknown.success) {
      expect(unknown.error.issues.some((i) => i.message.includes('unknown chain'))).toBe(true);
    }
  });

  it('rejects an invalid tokenAddress for the given chain (superRefine)', () => {
    expect(() =>
      SmartMoneyFlowsInputSchema.parse({ chain: 'ethereum', tokenAddress: 'not-an-address' }),
    ).toThrow();
  });

  it('rejects an unexpected extra key (.strict())', () => {
    expect(() =>
      SmartMoneyFlowsInputSchema.parse({
        chain: 'ethereum',
        tokenAddress: ETH_ADDRESS,
        unexpected: 'x',
      }),
    ).toThrow();
  });

  it('rejects a pathologically long tokenAddress FAST (no bs58/hex quadratic work)', () => {
    const hugeAddress = 'x'.repeat(100_000);
    const start = performance.now();
    const result = SmartMoneyFlowsInputSchema.safeParse({
      chain: 'solana',
      tokenAddress: hugeAddress,
    });
    const elapsedMs = performance.now() - start;

    expect(result.success).toBe(false);
    expect(elapsedMs).toBeLessThan(100);
  });
});

describe('smartMoneyFlowsHandler', () => {
  it('resolves via the registry and returns a SmartMoneyFlow-shaped output + cache meta on success', async () => {
    const registry = new CapabilityRegistry(ROUTES, new Map([['nansen', fakeNansenAdapter()]]));
    const outcome = await smartMoneyFlowsHandler(
      { chain: 'ethereum', tokenAddress: ETH_ADDRESS },
      { registry },
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('expected ok:true');
    expect(outcome.output).toStrictEqual(FAKE_FLOW);
    expect(outcome.cache).toStrictEqual({
      status: 'miss',
      provider: 'nansen',
      capability: 'smart-money.flows',
    });
  });

  it('returns {ok:false, reason} (never throws) when no adapter is registered for the capability', async () => {
    const registry = new CapabilityRegistry(ROUTES, new Map());
    const outcome = await smartMoneyFlowsHandler(
      { chain: 'ethereum', tokenAddress: ETH_ADDRESS },
      { registry },
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('expected ok:false');
    expect(outcome.reason).toContain('smart-money.flows');
    expect(outcome.reason).not.toContain(ETH_ADDRESS);
  });

  it('returns {ok:false, reason} (never throws) when the adapter returns data violating the output contract', async () => {
    const registry = new CapabilityRegistry(
      ROUTES,
      new Map([
        ['nansen', fakeNansenAdapter({ normalize: () => ({ ...FAKE_FLOW, tokenSymbol: 5 }) })],
      ]),
    );

    const outcome = await smartMoneyFlowsHandler(
      { chain: 'ethereum', tokenAddress: ETH_ADDRESS },
      { registry },
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('expected ok:false');
    expect(outcome.reason).toContain('provider returned data violating the tool contract');
    expect(outcome.reason).toContain('tokenSymbol');
    expect(outcome.reason).not.toContain('ZodError');
  });

  // TC-UNIT-14 — budgetStore not injected into the tool context: works normally, `budget` is
  // simply absent — a visibility degradation, not a functional failure.
  it('TC-UNIT-14: budgetStore not injected -> ok:true, budget is undefined', async () => {
    const registry = new CapabilityRegistry(ROUTES, new Map([['nansen', fakeNansenAdapter()]]));
    const outcome = await smartMoneyFlowsHandler(
      { chain: 'ethereum', tokenAddress: ETH_ADDRESS },
      { registry }, // no budgetStore
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('expected ok:true');
    expect(outcome.budget).toBeUndefined();
  });

  it('budgetStore injected + cache miss -> budget reflects getUsage() AFTER the call', async () => {
    const registry = new CapabilityRegistry(ROUTES, new Map([['nansen', fakeNansenAdapter()]]));
    const budgetStore = fakeBudgetStore({ getUsage: async () => 10 });
    const outcome = await smartMoneyFlowsHandler(
      { chain: 'ethereum', tokenAddress: ETH_ADDRESS },
      { registry, budgetStore },
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('expected ok:true');
    expect(outcome.cache.status).toBe('miss');
    expect(outcome.budget).toStrictEqual({ provider: 'nansen', creditsUsedToday: 10 });
  });

  // Mirrors TC-E2E-02's contract at the unit level: on a cache HIT, the gate/costOf()/network
  // never ran — `_meta.budget` must be absent entirely, never a stale/misleading figure.
  it('budgetStore injected + cache HIT -> budget is absent entirely (never a stale figure)', async () => {
    const cacheEntries = new Map<string, unknown>();
    const cache = {
      get: async (provider: string, capability: string, argsHash: string) => {
        const key = `${provider}:${capability}:${argsHash}`;
        return cacheEntries.has(key) ? { value: cacheEntries.get(key), ageMs: 5 } : undefined;
      },
      set: async (provider: string, capability: string, argsHash: string, value: unknown) => {
        cacheEntries.set(`${provider}:${capability}:${argsHash}`, value);
      },
    };
    const registry = new CapabilityRegistry(
      ROUTES,
      new Map([['nansen', fakeNansenAdapter()]]),
      cache,
    );
    const budgetStore = fakeBudgetStore({ getUsage: async () => 10 });
    const input = { chain: 'ethereum' as const, tokenAddress: ETH_ADDRESS };

    const first = await smartMoneyFlowsHandler(input, { registry, budgetStore });
    expect(first.ok && first.cache.status).toBe('miss');

    const second = await smartMoneyFlowsHandler(input, { registry, budgetStore });
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('expected ok:true');
    expect(second.cache.status).toBe('hit');
    expect(second.budget).toBeUndefined();
  });

  it('a budgetStore.getUsage() failure degrades budget to undefined (visibility never fails the call)', async () => {
    const registry = new CapabilityRegistry(ROUTES, new Map([['nansen', fakeNansenAdapter()]]));
    const budgetStore = fakeBudgetStore({
      getUsage: async () => {
        throw new Error('simulated sqlite read failure');
      },
    });
    const outcome = await smartMoneyFlowsHandler(
      { chain: 'ethereum', tokenAddress: ETH_ADDRESS },
      { registry, budgetStore },
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('expected ok:true');
    expect(outcome.budget).toBeUndefined();
  });
});
