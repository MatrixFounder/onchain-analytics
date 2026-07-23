import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createRpcSolanaAdapter } from '../src/index.js';

// Golden fixture-based normalization tests (R-16/R-17 backend, D11) — no network: the fixture was
// recorded ONCE live via `scripts/record-fixture.mjs rpc-solana solana <address>` (2026-07-22,
// host api.mainnet-beta.solana.com, HTTP 200 — see the committed .evidence.md).

const testDir = path.dirname(fileURLToPath(import.meta.url));
const FIXED_NOW = 1_700_000_000_000;
const ADDRESS = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

interface RpcSolanaFixture {
  chain: string;
  address: string;
  raw: { jsonrpc: string; result: { context: { slot: number }; value: number }; id: number };
}

function loadFixture(name: string): RpcSolanaFixture {
  const raw = readFileSync(path.join(testDir, 'fixtures', 'rpc-solana', `${name}.json`), 'utf8');
  return JSON.parse(raw) as RpcSolanaFixture;
}

describe('rpc-solana adapter (contract, R-16/R-17 backend, OQ-1)', () => {
  const adapter = createRpcSolanaAdapter({ now: () => FIXED_NOW });

  it('normalizes the solana fixture into a canonical Wallet', () => {
    const fixture = loadFixture('solana');

    const result = adapter.normalize('wallet.balances.native', fixture);

    expect(result).toEqual({
      chain: 'solana',
      address: fixture.address,
      balances: [
        {
          assetType: 'native',
          symbol: 'SOL',
          decimals: 9,
          amountRaw: String(fixture.raw.result.value),
          amountNum: fixture.raw.result.value,
        },
      ],
      source: 'rpc-solana',
      fetchedAt: FIXED_NOW,
    });
  });

  it('capabilities() declares wallet.balances.native for solana only', () => {
    expect(adapter.capabilities()).toEqual([{ id: 'wallet.balances.native', chains: ['solana'] }]);
  });

  it('costOf() is free (0 credits) and isAvailable() is always ok (keyless JSON-RPC)', () => {
    expect(adapter.costOf('wallet.balances.native', {})).toEqual({ credits: 0 });
    expect(adapter.isAvailable?.()).toEqual({ ok: true });
  });

  it('fetch() calls the single confirmed endpoint with the documented getBalance JSON-RPC body', async () => {
    const fixture = loadFixture('solana');
    const calls: Array<{ url: string; body: string }> = [];
    const fakeFetchImpl: typeof fetch = async (url, opts) => {
      calls.push({ url: String(url), body: String(opts?.body) });
      return new Response(JSON.stringify(fixture.raw), { status: 200 });
    };
    const testAdapter = createRpcSolanaAdapter({ fetchImpl: fakeFetchImpl, now: () => FIXED_NOW });

    const result = await testAdapter.fetch('wallet.balances.native', {
      chain: 'solana',
      address: ADDRESS,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://api.mainnet-beta.solana.com');
    expect(JSON.parse(calls[0]!.body)).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'getBalance',
      params: [ADDRESS],
    });
    expect(result).toEqual({ chain: 'solana', address: ADDRESS, raw: fixture.raw });
  });

  it('throws when the endpoint fails (no fallback in M1 — a single confirmed host, §11)', async () => {
    const fakeFetchImpl: typeof fetch = async () => new Response('down', { status: 503 });
    const testAdapter = createRpcSolanaAdapter({ fetchImpl: fakeFetchImpl });

    await expect(
      testAdapter.fetch('wallet.balances.native', { chain: 'solana', address: ADDRESS }),
    ).rejects.toThrow();
  });

  describe('lamports validation (adversarial cycle 1, fix F)', () => {
    it.each([
      ['a fractional value', 1.5],
      ['a negative value', -1],
      ['a value past Number.MAX_SAFE_INTEGER', 1e21],
    ])('normalize() rejects %s with a clean, documented error', (_label, badLamports) => {
      expect(() =>
        adapter.normalize('wallet.balances.native', {
          chain: 'solana',
          address: ADDRESS,
          raw: { jsonrpc: '2.0', id: 1, result: { context: { slot: 1 }, value: badLamports } },
        }),
      ).toThrow(/invalid lamports value/);
    });
  });
});
