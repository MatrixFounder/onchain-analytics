import { describe, expect, it } from 'vitest';
import { CapabilityRegistry } from '@onchain-intel/core';
import type { BudgetStore, CapabilityRoute, ProviderAdapter } from '@onchain-intel/core';
import { TokenRiskInputSchema, tokenRiskHandler } from '../../src/tools/token-risk.js';

/**
 * Unit tests for `src/tools/token-risk.ts` (task 005-6, R-43) — see `smart-money-flows.test.ts`'s
 * docstring for the shared testing convention (fake `ProviderAdapter`, no real `nansen`/network).
 */

const ETH_ADDRESS = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const SOL_ADDRESS = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const ROUTES: CapabilityRoute[] = [
  { capability: 'token.risk', chains: ['ethereum', 'solana'], adapterIds: ['nansen'] },
];

const FAKE_RISK_SCORE = {
  chain: 'ethereum' as const,
  address: ETH_ADDRESS,
  marketCapUsd: 1_000_000,
  marketCapGroup: 'mid',
  isStablecoin: false,
  riskIndicators: [{ indicatorType: 'rug_pull_risk', score: 'low' }],
  rewardIndicators: [{ indicatorType: 'momentum', score: 'high' }],
  source: 'nansen',
  fetchedAt: 1_800_000_000_000,
};

function fakeNansenAdapter(overrides: Partial<ProviderAdapter> = {}): ProviderAdapter {
  return {
    id: 'nansen',
    capabilities: () => [{ id: 'token.risk', chains: ['ethereum', 'solana'] }],
    costOf: () => ({ credits: 6 }),
    fetch: async () => ({}),
    normalize: () => FAKE_RISK_SCORE,
    isAvailable: () => ({ ok: true }),
    ...overrides,
  };
}

function fakeBudgetStore(overrides: Partial<BudgetStore> = {}): BudgetStore {
  return {
    checkAndReserve: async () => ({ ok: true }),
    recordDelta: async () => undefined,
    getUsage: async () => 6,
    ...overrides,
  };
}

describe('TokenRiskInputSchema', () => {
  it('accepts a valid ethereum tokenAddress', () => {
    expect(() =>
      TokenRiskInputSchema.parse({ chain: 'ethereum', tokenAddress: ETH_ADDRESS }),
    ).not.toThrow();
  });

  it('accepts a valid solana tokenAddress', () => {
    expect(() =>
      TokenRiskInputSchema.parse({ chain: 'solana', tokenAddress: SOL_ADDRESS }),
    ).not.toThrow();
  });

  it('rejects a chain outside ethereum/solana (e.g. dash)', () => {
    expect(() =>
      TokenRiskInputSchema.parse({ chain: 'dash', tokenAddress: ETH_ADDRESS }),
    ).toThrow();
  });

  it('rejects an invalid tokenAddress for the given chain (superRefine)', () => {
    expect(() =>
      TokenRiskInputSchema.parse({ chain: 'ethereum', tokenAddress: 'not-an-address' }),
    ).toThrow();
  });

  it('rejects an unexpected extra key (.strict())', () => {
    expect(() =>
      TokenRiskInputSchema.parse({
        chain: 'ethereum',
        tokenAddress: ETH_ADDRESS,
        unexpected: 'x',
      }),
    ).toThrow();
  });

  it('rejects a pathologically long tokenAddress FAST', () => {
    const hugeAddress = 'x'.repeat(100_000);
    const start = performance.now();
    const result = TokenRiskInputSchema.safeParse({ chain: 'solana', tokenAddress: hugeAddress });
    const elapsedMs = performance.now() - start;

    expect(result.success).toBe(false);
    expect(elapsedMs).toBeLessThan(100);
  });
});

describe('tokenRiskHandler', () => {
  it('resolves via the registry and returns a TokenRiskScore-shaped output with SEPARATE risk/reward groups + cache meta', async () => {
    const registry = new CapabilityRegistry(ROUTES, new Map([['nansen', fakeNansenAdapter()]]));
    const outcome = await tokenRiskHandler(
      { chain: 'ethereum', tokenAddress: ETH_ADDRESS },
      { registry },
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('expected ok:true');
    expect(outcome.output).toStrictEqual(FAKE_RISK_SCORE);
    expect(outcome.output.riskIndicators).not.toBe(outcome.output.rewardIndicators);
    expect(outcome.cache).toStrictEqual({
      status: 'miss',
      provider: 'nansen',
      capability: 'token.risk',
    });
  });

  it('returns {ok:false, reason} (never throws) when no adapter is registered for the capability', async () => {
    const registry = new CapabilityRegistry(ROUTES, new Map());
    const outcome = await tokenRiskHandler(
      { chain: 'ethereum', tokenAddress: ETH_ADDRESS },
      { registry },
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('expected ok:false');
    expect(outcome.reason).toContain('token.risk');
    expect(outcome.reason).not.toContain(ETH_ADDRESS);
  });

  it('returns {ok:false, reason} (never throws) when the adapter returns data violating the output contract', async () => {
    const registry = new CapabilityRegistry(
      ROUTES,
      new Map([
        [
          'nansen',
          fakeNansenAdapter({
            normalize: () => ({ ...FAKE_RISK_SCORE, riskIndicators: [{ score: 'low' }] }), // missing indicatorType
          }),
        ],
      ]),
    );

    const outcome = await tokenRiskHandler(
      { chain: 'ethereum', tokenAddress: ETH_ADDRESS },
      { registry },
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('expected ok:false');
    expect(outcome.reason).toContain('provider returned data violating the tool contract');
    expect(outcome.reason).not.toContain('ZodError');
  });

  it('budgetStore not injected -> ok:true, budget is undefined', async () => {
    const registry = new CapabilityRegistry(ROUTES, new Map([['nansen', fakeNansenAdapter()]]));
    const outcome = await tokenRiskHandler(
      { chain: 'ethereum', tokenAddress: ETH_ADDRESS },
      { registry },
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('expected ok:true');
    expect(outcome.budget).toBeUndefined();
  });

  it('budgetStore injected + cache miss -> budget reflects getUsage() AFTER the call (6cr, R-43)', async () => {
    const registry = new CapabilityRegistry(ROUTES, new Map([['nansen', fakeNansenAdapter()]]));
    const budgetStore = fakeBudgetStore({ getUsage: async () => 6 });
    const outcome = await tokenRiskHandler(
      { chain: 'ethereum', tokenAddress: ETH_ADDRESS },
      { registry, budgetStore },
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('expected ok:true');
    expect(outcome.budget).toStrictEqual({ provider: 'nansen', creditsUsedToday: 6 });
  });
});

// TC-UNIT-10 (R-43, not Dune) — this file never imports the `dune` adapter (grep-checked at the
// Acceptance level too); `token.risk`'s only registered route/adapter is `nansen`
// (`providers.config.ts`), never `dune`.
