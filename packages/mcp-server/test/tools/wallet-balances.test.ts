import { describe, expect, it } from 'vitest';
import { CapabilityRegistry } from '@onchain-intel/core';
import type { CapabilityRoute, ProviderAdapter } from '@onchain-intel/core';
import {
  WalletBalancesInputSchema,
  walletBalancesHandler,
} from '../../src/tools/wallet-balances.js';

/**
 * Unit tests for `src/tools/wallet-balances.ts` (task 003-7, R-17) — see `get-token.test.ts`'s
 * docstring for the shared testing convention (small purpose-built `CapabilityRegistry`, no
 * transport).
 */

const ETH_ADDRESS = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const SOL_ADDRESS = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const ROUTES: CapabilityRoute[] = [
  { capability: 'wallet.balances.native', chains: ['ethereum'], adapterIds: ['rpc-evm'] },
];

const FAKE_WALLET = {
  chain: 'ethereum' as const,
  address: ETH_ADDRESS,
  balances: [
    { assetType: 'native' as const, symbol: 'ETH', decimals: 18, amountRaw: '1000000000000000000' },
  ],
  source: 'rpc-evm',
  fetchedAt: 1_800_000_000_000,
};

function fakeRpcEvmAdapter(): ProviderAdapter {
  return {
    id: 'rpc-evm',
    capabilities: () => [{ id: 'wallet.balances.native', chains: ['ethereum'] }],
    costOf: () => ({ credits: 0 }),
    fetch: async () => ({}),
    normalize: () => FAKE_WALLET,
    isAvailable: () => ({ ok: true }),
  };
}

describe('WalletBalancesInputSchema', () => {
  it('accepts a valid ethereum address', () => {
    expect(() =>
      WalletBalancesInputSchema.parse({ chain: 'ethereum', address: ETH_ADDRESS }),
    ).not.toThrow();
  });

  it('accepts a valid solana address', () => {
    expect(() =>
      WalletBalancesInputSchema.parse({ chain: 'solana', address: SOL_ADDRESS }),
    ).not.toThrow();
  });

  it('rejects a chain outside ethereum/solana (e.g. dash)', () => {
    expect(() =>
      WalletBalancesInputSchema.parse({ chain: 'dash', address: ETH_ADDRESS }),
    ).toThrow();
  });

  it('rejects an invalid address for the given chain (superRefine)', () => {
    expect(() =>
      WalletBalancesInputSchema.parse({ chain: 'ethereum', address: 'not-an-address' }),
    ).toThrow();
  });

  it('rejects an unexpected extra key (.strict())', () => {
    expect(() =>
      WalletBalancesInputSchema.parse({ chain: 'ethereum', address: ETH_ADDRESS, unexpected: 'x' }),
    ).toThrow();
  });
});

describe('walletBalancesHandler', () => {
  it('resolves via the registry and returns a Wallet-shaped output + cache meta on success', async () => {
    const registry = new CapabilityRegistry(ROUTES, new Map([['rpc-evm', fakeRpcEvmAdapter()]]));
    const outcome = await walletBalancesHandler(
      { chain: 'ethereum', address: ETH_ADDRESS },
      { registry },
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('expected ok:true');
    expect(outcome.output).toStrictEqual(FAKE_WALLET);
    expect(outcome.cache).toStrictEqual({
      status: 'miss',
      provider: 'rpc-evm',
      capability: 'wallet.balances.native',
    });
  });

  it('returns {ok:false, reason} (never throws) when no adapter is registered for the capability', async () => {
    const registry = new CapabilityRegistry(ROUTES, new Map());
    const outcome = await walletBalancesHandler(
      { chain: 'ethereum', address: ETH_ADDRESS },
      { registry },
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) throw new Error('expected ok:false');
    expect(outcome.reason).toContain('wallet.balances.native');
    expect(outcome.reason).not.toContain(ETH_ADDRESS);
  });
});
