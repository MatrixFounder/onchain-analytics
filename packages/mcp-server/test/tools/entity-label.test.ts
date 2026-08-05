import { describe, expect, it } from 'vitest';
import { CapabilityRegistry } from '@onchain-intel/core';
import type {
  BudgetStore,
  CacheGetResult,
  CacheStore,
  CapabilityRoute,
  ProviderAdapter,
} from '@onchain-intel/core';
import { EntityLabelInputSchema, entityLabelHandler } from '../../src/tools/entity-label.js';

/**
 * Unit tests for `src/tools/entity-label.ts` (task 005-6, R-42) — see `smart-money-flows.test.ts`'s
 * docstring for the shared testing convention (fake `ProviderAdapter`, no real `nansen`/network).
 * `onchain_entity_label` is the ONLY one of the 7 tools with a COMPOUND `superRefine` — the
 * dedicated `EntityLabelInputSchema` describe block below covers both structural rules.
 */

const ETH_ADDRESS = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const SOL_ADDRESS = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const ROUTES: CapabilityRoute[] = [{ capability: 'entity.labels', adapterIds: ['nansen'] }];

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

/**
 * Adversarial cycle 2, F-4 — the free-first route, end to end through the handler.
 *
 * Every budget case above routes `nansen` ALONE, so the answering provider is always the paid one
 * and `_meta.budget` could be derived from it. Production routes `blockscout` first
 * (`providers.config.ts`, R-75) precisely so a credit is spent only where the free source cannot
 * answer — and on the ordinary miss NEITHER has labels: the walk enters `nansen`, `nansen` pays, its
 * answer is unsatisfying too, and the registry returns blockscout's (`unsatisfying ??=`). The tool
 * then reported no budget at all for a call that had just spent credits.
 *
 * The route below carries the PRODUCTION policy descriptor rather than a literal of this file's own:
 * without `someElementHasAny` the first empty answer would satisfy the walk, `nansen` would never be
 * entered, and the case would be asserting a different situation.
 */
describe('cycle 2 F-4 — blockscout answers, nansen pays, and _meta.budget says so', () => {
  const FREE_FIRST: CapabilityRoute[] = [
    {
      capability: 'entity.labels',
      adapterIds: ['blockscout', 'nansen'],
      policy: { kind: 'someElementHasAny', fields: ['name', 'tags', 'labels'] },
    },
  ];

  /** A contentless-but-truthful label record — the exact shape H-1 is about: an entry exists, and it
   * says nothing. Both fake adapters answer with it, which is what makes the walk reach the end. */
  const NO_CONTENT = {
    chain: 'ethereum' as const,
    address: ETH_ADDRESS,
    name: '',
    tags: [],
    labels: [],
    premiumRequested: false,
    source: 'blockscout',
    fetchedAt: 1_800_000_000_000,
  };

  function fakeAdapter(id: string, onFetch?: () => void): ProviderAdapter {
    return {
      id,
      capabilities: () => [{ id: 'entity.labels', chains: ['ethereum'] }],
      costOf: () => ({ credits: id === 'nansen' ? 5 : 0 }),
      fetch: async () => {
        onFetch?.();
        return {};
      },
      normalize: () => [{ ...NO_CONTENT, source: id }],
      isAvailable: () => ({ ok: true }),
    };
  }

  it('reports nansen’s ledger even though the returned source is blockscout', async () => {
    // A ledger that only moves when the PAID adapter's `fetch()` actually runs, so the number below
    // is produced by the traversal rather than declared by the fixture.
    let creditsUsedToday = 0;
    const registry = new CapabilityRegistry(
      FREE_FIRST,
      new Map<string, ProviderAdapter>([
        ['blockscout', fakeAdapter('blockscout')],
        [
          'nansen',
          fakeAdapter('nansen', () => {
            creditsUsedToday += 5;
          }),
        ],
      ]),
    );
    const budgetStore = fakeBudgetStore({ getUsage: async () => creditsUsedToday });

    const outcome = await entityLabelHandler(
      { chain: 'ethereum', tokenAddress: ETH_ADDRESS, exhaustive: false },
      { registry, budgetStore },
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('expected ok:true');
    // The premise of the case, asserted rather than assumed: the FREE adapter is what answered.
    expect(outcome.cache.provider).toBe('blockscout');
    expect(outcome.cache.status).toBe('miss');
    // And the spend is visible anyway — the whole finding.
    expect(outcome.budget).toStrictEqual({ provider: 'nansen', creditsUsedToday: 5 });
  });

  it('does NOT invent a budget when the free source answers satisfyingly', async () => {
    // The other direction: `nansen` is never entered, so nothing may be reported — otherwise the fix
    // would resurrect the false positive task 012-3 removed.
    let nansenCalls = 0;
    const registry = new CapabilityRegistry(
      FREE_FIRST,
      new Map<string, ProviderAdapter>([
        [
          'blockscout',
          {
            ...fakeAdapter('blockscout'),
            normalize: () => [{ ...NO_CONTENT, source: 'blockscout', tags: ['cex'] }],
          },
        ],
        [
          'nansen',
          fakeAdapter('nansen', () => {
            nansenCalls += 1;
          }),
        ],
      ]),
    );
    const budgetStore = fakeBudgetStore({ getUsage: async () => 5 });

    const outcome = await entityLabelHandler(
      { chain: 'ethereum', tokenAddress: ETH_ADDRESS, exhaustive: false },
      { registry, budgetStore },
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('expected ok:true');
    expect(nansenCalls).toBe(0);
    expect(outcome.cache.provider).toBe('blockscout');
    expect(outcome.budget).toBeUndefined();
  });
});

/**
 * Adversarial cycle 3, F-A — the same route as cycle 2's F-4, with blockscout answering from CACHE.
 *
 * F-4 taught `budgetMeta()` to read the traversal, and left the handlers gating the call on
 * `outcome.cache.status === 'miss'`. The registry's H-1 return does not respect that gate: the
 * `unsatisfying` resolution it hands back is whichever came FIRST, and on a warm cache that is the
 * `cache: 'hit'` object built for blockscout (`adapters/registry.ts`, the `else if (cached)` branch)
 * — while the walk behind it entered and PAID nansen. So the response said `'hit'`, carried no
 * `_meta.budget` at all, and the credit was invisible: F-4's own defect, one branch over, on the one
 * route it was written for.
 *
 * Both cases below run the REAL `CapabilityRegistry` against a cache that hits for exactly one
 * provider — the state is produced by the traversal, not declared by a fixture.
 */
describe('cycle 3 F-A — a cache HIT for the free source, a paid entry behind it', () => {
  const FREE_FIRST: CapabilityRoute[] = [
    {
      capability: 'entity.labels',
      adapterIds: ['blockscout', 'nansen'],
      policy: { kind: 'someElementHasAny', fields: ['name', 'tags', 'labels'] },
    },
  ];

  const NO_CONTENT = {
    chain: 'ethereum' as const,
    address: ETH_ADDRESS,
    name: '',
    tags: [] as string[],
    labels: [] as string[],
    premiumRequested: false,
    source: 'blockscout',
    fetchedAt: 1_800_000_000_000,
  };

  /** Hits for ONE provider and misses for every other — the warm-blockscout/cold-nansen state. */
  function oneProviderHitCache(hitProvider: string, value: unknown): CacheStore {
    return {
      get: async (provider: string): Promise<CacheGetResult | undefined> =>
        provider === hitProvider ? { value, ageMs: 4_242 } : undefined,
      set: async (): Promise<void> => undefined,
    };
  }

  function fakeAdapter(id: string, entities: unknown[], onFetch?: () => void): ProviderAdapter {
    return {
      id,
      capabilities: () => [{ id: 'entity.labels', chains: ['ethereum'] }],
      costOf: () => ({ credits: id === 'nansen' ? 5 : 0 }),
      fetch: async () => {
        onFetch?.();
        return {};
      },
      normalize: () => entities,
      isAvailable: () => ({ ok: true }),
    };
  }

  it('reports nansen’s ledger even though the answer came from blockscout’s CACHE', async () => {
    let creditsUsedToday = 0;
    const registry = new CapabilityRegistry(
      FREE_FIRST,
      new Map<string, ProviderAdapter>([
        // Its `fetch` would throw: the case is only what it claims to be if blockscout is never
        // entered at all, so the cache is the ONLY way its answer can appear below.
        [
          'blockscout',
          {
            ...fakeAdapter('blockscout', [NO_CONTENT]),
            fetch: async () => {
              throw new Error('blockscout must be served from cache in this case');
            },
          },
        ],
        [
          'nansen',
          fakeAdapter('nansen', [{ ...NO_CONTENT, source: 'nansen' }], () => {
            creditsUsedToday += 5;
          }),
        ],
      ]),
      oneProviderHitCache('blockscout', [NO_CONTENT]),
    );
    const budgetStore = fakeBudgetStore({ getUsage: async () => creditsUsedToday });

    const outcome = await entityLabelHandler(
      { chain: 'ethereum', tokenAddress: ETH_ADDRESS, exhaustive: false },
      { registry, budgetStore },
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('expected ok:true');
    // The premises, asserted rather than assumed — without both, the case tests something else.
    expect(outcome.cache.status).toBe('hit');
    expect(outcome.cache.provider).toBe('blockscout');
    // …and the paid source WAS entered, which is the fact the old gate discarded.
    expect(creditsUsedToday).toBe(5);
    expect(outcome.budget).toStrictEqual({ provider: 'nansen', creditsUsedToday: 5 });
  });

  it('a cache hit that SATISFIES enters nobody, and still reports no budget', async () => {
    // The other direction. A pure hit must stay silent — otherwise the fix trades F-4's false
    // negative for the false POSITIVE task 012-3 removed, on the cheapest call the server serves.
    let nansenCalls = 0;
    const WITH_CONTENT = { ...NO_CONTENT, tags: ['cex'] };
    const registry = new CapabilityRegistry(
      FREE_FIRST,
      new Map<string, ProviderAdapter>([
        ['blockscout', fakeAdapter('blockscout', [WITH_CONTENT])],
        [
          'nansen',
          fakeAdapter('nansen', [{ ...NO_CONTENT, source: 'nansen' }], () => {
            nansenCalls += 1;
          }),
        ],
      ]),
      oneProviderHitCache('blockscout', [WITH_CONTENT]),
    );
    const budgetStore = fakeBudgetStore({ getUsage: async () => 5 });

    const outcome = await entityLabelHandler(
      { chain: 'ethereum', tokenAddress: ETH_ADDRESS, exhaustive: false },
      { registry, budgetStore },
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('expected ok:true');
    expect(nansenCalls).toBe(0);
    expect(outcome.cache.status).toBe('hit');
    expect(outcome.budget).toBeUndefined();
  });
});
