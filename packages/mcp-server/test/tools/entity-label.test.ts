import { describe, expect, it } from 'vitest';
import { CapabilityRegistry } from '@onchain-intel/core';
import type { BudgetStore, CapabilityRoute, ProviderAdapter } from '@onchain-intel/core';
import { EntityLabelInputSchema, entityLabelHandler } from '../../src/tools/entity-label.js';

/**
 * Unit tests for `src/tools/entity-label.ts` (task 005-6, R-42) — see `smart-money-flows.test.ts`'s
 * docstring for the shared testing convention (fake `ProviderAdapter`, no real `nansen`/network).
 * `onchain_entity_label` is the ONLY one of the 7 tools with a COMPOUND `superRefine` — the
 * dedicated `EntityLabelInputSchema` describe block below covers both structural rules.
 */

const ETH_ADDRESS = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const SOL_ADDRESS = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const ROUTES: CapabilityRoute[] = [
  { capability: 'entity.labels', chains: ['ethereum', 'solana'], adapterIds: ['nansen'] },
];

const FAKE_ENTITY = {
  chain: 'ethereum' as const,
  address: ETH_ADDRESS,
  name: 'Uniswap',
  tags: ['dex'],
  labels: ['whale'],
  premiumRequested: false,
  source: 'nansen',
  fetchedAt: 1_800_000_000_000,
};

function fakeNansenAdapter(overrides: Partial<ProviderAdapter> = {}): ProviderAdapter {
  return {
    id: 'nansen',
    capabilities: () => [{ id: 'entity.labels', chains: ['ethereum', 'solana'] }],
    costOf: () => ({ credits: 0 }),
    fetch: async () => ({}),
    normalize: () => [FAKE_ENTITY],
    isAvailable: () => ({ ok: true }),
    ...overrides,
  };
}

function fakeBudgetStore(overrides: Partial<BudgetStore> = {}): BudgetStore {
  return {
    checkAndReserve: async () => ({ ok: true }),
    recordDelta: async () => undefined,
    getUsage: async () => 0,
    getWindowUsage: async () => 0,
    getWindowCalls: async () => 0,
    ...overrides,
  };
}

describe('EntityLabelInputSchema', () => {
  it('accepts query-only (no tokenAddress) — the default 0cr tier', () => {
    expect(() =>
      EntityLabelInputSchema.parse({ chain: 'ethereum', query: 'uniswap' }),
    ).not.toThrow();
  });

  it('accepts tokenAddress-only (no query) — the token-scoped 5cr tier', () => {
    expect(() =>
      EntityLabelInputSchema.parse({ chain: 'ethereum', tokenAddress: ETH_ADDRESS }),
    ).not.toThrow();
  });

  it('accepts solana tokenAddress-only', () => {
    expect(() =>
      EntityLabelInputSchema.parse({ chain: 'solana', tokenAddress: SOL_ADDRESS }),
    ).not.toThrow();
  });

  it('accepts exhaustive:true WITH tokenAddress — the opt-in 100cr escalation', () => {
    expect(() =>
      EntityLabelInputSchema.parse({
        chain: 'ethereum',
        tokenAddress: ETH_ADDRESS,
        exhaustive: true,
      }),
    ).not.toThrow();
  });

  it('defaults exhaustive to false when omitted', () => {
    const parsed = EntityLabelInputSchema.parse({ chain: 'ethereum', query: 'uniswap' });
    expect(parsed.exhaustive).toBe(false);
  });

  // TC-UNIT-06 (R-42, compound superRefine rule 1) — at least one of query/tokenAddress required.
  it('rejects neither query nor tokenAddress (TC-UNIT-06)', () => {
    expect(() => EntityLabelInputSchema.parse({ chain: 'ethereum' })).toThrow();
  });

  // TC-UNIT-06 (R-42, compound superRefine rule 2) — exhaustive:true requires tokenAddress.
  it('rejects exhaustive:true WITHOUT tokenAddress, even with a query present (TC-UNIT-06)', () => {
    expect(() =>
      EntityLabelInputSchema.parse({ chain: 'ethereum', query: 'uniswap', exhaustive: true }),
    ).toThrow();
  });

  // CHANGED EXPECTATION (task 006-6, R-50). The schema used to reject anything outside a
  // two-value enum. It now accepts any chain the REGISTRY knows and rejects only what the registry
  // does not — because refusing at the schema is the wrong layer for "this capability is not
  // served there": that answer belongs to the coverage matrix, which can say WHERE it IS served
  // (§4.2.3). A schema-level refusal could only say "no".
  it('accepts any registry chain and rejects an unknown one (R-50c)', () => {
    expect(() => EntityLabelInputSchema.parse({ chain: 'ethereum', query: 'x' })).not.toThrow();
    const unknown = EntityLabelInputSchema.safeParse({ chain: 'not-a-real-chain', query: 'x' });
    expect(unknown.success).toBe(false);
    if (!unknown.success) {
      expect(unknown.error.issues.some((i) => i.message.includes('unknown chain'))).toBe(true);
    }
  });

  it('rejects an invalid tokenAddress for the given chain (superRefine)', () => {
    expect(() =>
      EntityLabelInputSchema.parse({ chain: 'ethereum', tokenAddress: 'not-an-address' }),
    ).toThrow();
  });

  it('rejects a query over the .max(200) bound', () => {
    expect(() =>
      EntityLabelInputSchema.parse({ chain: 'ethereum', query: 'x'.repeat(201) }),
    ).toThrow();
  });

  it('rejects an unexpected extra key (.strict())', () => {
    expect(() =>
      EntityLabelInputSchema.parse({ chain: 'ethereum', query: 'uniswap', unexpected: 'x' }),
    ).toThrow();
  });

  it('rejects a pathologically long tokenAddress FAST (length guard before isValidAddress)', () => {
    const hugeAddress = 'x'.repeat(100_000);
    const start = performance.now();
    const result = EntityLabelInputSchema.safeParse({ chain: 'solana', tokenAddress: hugeAddress });
    const elapsedMs = performance.now() - start;

    expect(result.success).toBe(false);
    expect(elapsedMs).toBeLessThan(100);
  });
});

describe('entityLabelHandler', () => {
  it('query-only: builds args WITHOUT a tokenAddress key, wraps output into {chain, entities, source, fetchedAt}', async () => {
    let capturedArgs: Record<string, unknown> | undefined;
    const adapter = fakeNansenAdapter({
      fetch: async (_cap, args) => {
        capturedArgs = args;
        return {};
      },
    });
    const registry = new CapabilityRegistry(ROUTES, new Map([['nansen', adapter]]));

    const outcome = await entityLabelHandler(
      { chain: 'ethereum', query: 'uniswap', exhaustive: false },
      { registry },
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('expected ok:true');
    expect(outcome.output).toStrictEqual({
      chain: 'ethereum',
      entities: [FAKE_ENTITY],
      source: 'nansen',
      fetchedAt: outcome.output.fetchedAt,
    });
    expect(capturedArgs).toStrictEqual({ chain: 'ethereum', exhaustive: false, query: 'uniswap' });
    expect(capturedArgs).not.toHaveProperty('tokenAddress');
  });

  it('tokenAddress-only: builds args WITHOUT a query key, tokenAddress is normalized', async () => {
    let capturedArgs: Record<string, unknown> | undefined;
    const adapter = fakeNansenAdapter({
      fetch: async (_cap, args) => {
        capturedArgs = args;
        return {};
      },
    });
    const registry = new CapabilityRegistry(ROUTES, new Map([['nansen', adapter]]));

    const outcome = await entityLabelHandler(
      { chain: 'ethereum', tokenAddress: ETH_ADDRESS.toLowerCase(), exhaustive: false },
      { registry },
    );

    expect(outcome.ok).toBe(true);
    expect(capturedArgs).toStrictEqual({
      chain: 'ethereum',
      exhaustive: false,
      tokenAddress: ETH_ADDRESS, // EIP-55 checksum form, not the lowercase input
    });
    expect(capturedArgs).not.toHaveProperty('query');
  });

  it('exhaustive:true carries BOTH tokenAddress and exhaustive:true through to args', async () => {
    let capturedArgs: Record<string, unknown> | undefined;
    const adapter = fakeNansenAdapter({
      fetch: async (_cap, args) => {
        capturedArgs = args;
        return {};
      },
      normalize: () => [{ ...FAKE_ENTITY, premiumRequested: true, labels: ['exchange'] }],
    });
    const registry = new CapabilityRegistry(ROUTES, new Map([['nansen', adapter]]));

    const outcome = await entityLabelHandler(
      { chain: 'ethereum', tokenAddress: ETH_ADDRESS, exhaustive: true },
      { registry },
    );

    expect(outcome.ok).toBe(true);
    expect(capturedArgs).toStrictEqual({
      chain: 'ethereum',
      exhaustive: true,
      tokenAddress: ETH_ADDRESS,
    });
  });

  // TC-E2E-08 equivalent at the unit level — an empty result is a VALID success, never an error.
  it('an empty entities[] result is a VALID success, not an error (R-32)', async () => {
    const registry = new CapabilityRegistry(
      ROUTES,
      new Map([['nansen', fakeNansenAdapter({ normalize: () => [] })]]),
    );

    const outcome = await entityLabelHandler(
      { chain: 'ethereum', tokenAddress: ETH_ADDRESS, exhaustive: false },
      { registry },
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('expected ok:true');
    expect(outcome.output.entities).toStrictEqual([]);
  });

  it('returns {ok:false, reason} (never throws) when no adapter is registered for the capability', async () => {
    const registry = new CapabilityRegistry(ROUTES, new Map());
    const outcome = await entityLabelHandler(
      { chain: 'ethereum', query: 'uniswap', exhaustive: false },
      { registry },
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('expected ok:false');
    expect(outcome.reason).toContain('entity.labels');
  });

  // TC-E2E-07 equivalent at the unit level — the adapter itself refuses (mirrors the real
  // NansenBudgetExceededError path, R-37(b)): resolveCapability's try/catch surfaces it as
  // {ok:false, reason}, never a thrown error escaping the handler, and the reason names budget.
  it('surfaces a budget-gate refusal as {ok:false, reason} (never throws)', async () => {
    const adapter = fakeNansenAdapter({
      fetch: async () => {
        throw new Error('nansen budget gate refused: self-imposed cap: need 100, allows 50');
      },
    });
    const registry = new CapabilityRegistry(ROUTES, new Map([['nansen', adapter]]));

    const outcome = await entityLabelHandler(
      { chain: 'ethereum', tokenAddress: ETH_ADDRESS, exhaustive: true },
      { registry },
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('expected ok:false');
    expect(outcome.reason.toLowerCase()).toContain('budget');
  });

  it('returns {ok:false, reason} (never throws) when the adapter returns data violating the output contract', async () => {
    const registry = new CapabilityRegistry(
      ROUTES,
      new Map([
        [
          'nansen',
          fakeNansenAdapter({ normalize: () => [{ ...FAKE_ENTITY, tags: 'not-an-array' }] }),
        ],
      ]),
    );

    const outcome = await entityLabelHandler(
      { chain: 'ethereum', query: 'uniswap', exhaustive: false },
      { registry },
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('expected ok:false');
    expect(outcome.reason).toContain('provider returned data violating the tool contract');
    expect(outcome.reason).not.toContain('ZodError');
  });

  it('budgetStore not injected -> ok:true, budget is undefined', async () => {
    const registry = new CapabilityRegistry(ROUTES, new Map([['nansen', fakeNansenAdapter()]]));
    const outcome = await entityLabelHandler(
      { chain: 'ethereum', query: 'uniswap', exhaustive: false },
      { registry },
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('expected ok:true');
    expect(outcome.budget).toBeUndefined();
  });

  // TC-E2E-04 equivalent at the unit level — the default 0cr tier: budget is present (cache miss)
  // but the credits figure itself did not grow.
  it('default 0cr tier: budget present on miss, creditsUsedToday reflects the (unchanged) 0cr baseline', async () => {
    const registry = new CapabilityRegistry(ROUTES, new Map([['nansen', fakeNansenAdapter()]]));
    const budgetStore = fakeBudgetStore({ getUsage: async () => 0 });
    const outcome = await entityLabelHandler(
      { chain: 'ethereum', query: 'uniswap', exhaustive: false },
      { registry, budgetStore },
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('expected ok:true');
    expect(outcome.budget).toStrictEqual({ provider: 'nansen', creditsUsedToday: 0 });
  });

  // TC-E2E-05 equivalent at the unit level — the token-scoped 5cr tier.
  it('token-scoped 5cr tier: budget reflects the increased usage', async () => {
    const registry = new CapabilityRegistry(ROUTES, new Map([['nansen', fakeNansenAdapter()]]));
    const budgetStore = fakeBudgetStore({ getUsage: async () => 5 });
    const outcome = await entityLabelHandler(
      { chain: 'ethereum', tokenAddress: ETH_ADDRESS, exhaustive: false },
      { registry, budgetStore },
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('expected ok:true');
    expect(outcome.budget).toStrictEqual({ provider: 'nansen', creditsUsedToday: 5 });
  });
});
