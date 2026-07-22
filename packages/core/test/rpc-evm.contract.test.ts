import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createRpcEvmAdapter } from '../src/index.js';

// Golden fixture-based normalization tests (R-16/R-17 backend, D11) — no network: the fixture was
// recorded ONCE live via `scripts/record-fixture.mjs rpc-evm ethereum <vitalik.eth address>`
// (2026-07-22, host ethereum-rpc.publicnode.com, HTTP 200 — see the committed .evidence.md) and is
// committed under test/fixtures/rpc-evm/. `normalize()` is exercised directly against it;
// `fetch()` is only exercised here with an injected fake `fetchImpl` (no real HTTP).

const testDir = path.dirname(fileURLToPath(import.meta.url));
const FIXED_NOW = 1_700_000_000_000;
const ADDRESS = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';

interface RpcEvmFixture {
  chain: string;
  address: string;
  raw: { jsonrpc: string; result: string; id: number };
}

function loadFixture(name: string): RpcEvmFixture {
  const raw = readFileSync(path.join(testDir, 'fixtures', 'rpc-evm', `${name}.json`), 'utf8');
  return JSON.parse(raw) as RpcEvmFixture;
}

describe('rpc-evm adapter (contract, R-16/R-17 backend, OQ-1)', () => {
  const adapter = createRpcEvmAdapter({ now: () => FIXED_NOW });

  it('normalizes the ethereum fixture into a canonical Wallet with an exact decimal amountRaw', () => {
    const fixture = loadFixture('ethereum');
    // Re-derived from the SAME loaded fixture (never hand-copied) — exact decimal string via
    // BigInt, the same conversion normalize() itself performs (DB-SCHEMA-CONCEPT §1.7).
    const expectedAmountRaw = BigInt(fixture.raw.result).toString(10);

    const result = adapter.normalize('wallet.balances.native', fixture);

    expect(result).toEqual({
      chain: 'ethereum',
      address: fixture.address,
      balances: [
        {
          assetType: 'native',
          symbol: 'ETH',
          decimals: 18,
          amountRaw: expectedAmountRaw,
          amountNum: Number(expectedAmountRaw),
        },
      ],
      source: 'rpc-evm',
      fetchedAt: FIXED_NOW,
    });
    // amountRaw must survive as a string (>2^53 for real-world wei balances) — not a JS number.
    expect(
      typeof (result as { balances: Array<{ amountRaw: unknown }> }).balances[0]!.amountRaw,
    ).toBe('string');
  });

  it('capabilities() declares wallet.balances.native for ethereum only', () => {
    expect(adapter.capabilities()).toEqual([
      { id: 'wallet.balances.native', chains: ['ethereum'] },
    ]);
  });

  it('costOf() is free (0 credits) and isAvailable() is always ok (keyless JSON-RPC)', () => {
    expect(adapter.costOf('wallet.balances.native', {})).toEqual({ credits: 0 });
    expect(adapter.isAvailable?.()).toEqual({ ok: true });
  });

  it('fetch() calls the primary endpoint with the documented eth_getBalance JSON-RPC body', async () => {
    const fixture = loadFixture('ethereum');
    const calls: Array<{ url: string; body: string }> = [];
    const fakeFetchImpl: typeof fetch = async (url, opts) => {
      calls.push({ url: String(url), body: String(opts?.body) });
      return new Response(JSON.stringify(fixture.raw), { status: 200 });
    };
    const testAdapter = createRpcEvmAdapter({ fetchImpl: fakeFetchImpl, now: () => FIXED_NOW });

    const result = await testAdapter.fetch('wallet.balances.native', {
      chain: 'ethereum',
      address: ADDRESS,
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe('https://ethereum-rpc.publicnode.com');
    expect(JSON.parse(calls[0]!.body)).toEqual({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_getBalance',
      params: [ADDRESS, 'latest'],
    });
    expect(result).toEqual({ chain: 'ethereum', address: ADDRESS, raw: fixture.raw });
  });

  it('falls back to the secondary endpoint (within-adapter retry) when the primary one fails', async () => {
    const fixture = loadFixture('ethereum');
    const calls: string[] = [];
    const fakeFetchImpl: typeof fetch = async (url) => {
      calls.push(String(url));
      if (calls.length === 1) {
        return new Response('boom', { status: 500 });
      }
      return new Response(JSON.stringify(fixture.raw), { status: 200 });
    };
    const testAdapter = createRpcEvmAdapter({ fetchImpl: fakeFetchImpl, now: () => FIXED_NOW });

    const result = await testAdapter.fetch('wallet.balances.native', {
      chain: 'ethereum',
      address: ADDRESS,
    });

    expect(calls).toEqual(['https://ethereum-rpc.publicnode.com', 'https://eth.drpc.org']);
    expect(result).toEqual({ chain: 'ethereum', address: ADDRESS, raw: fixture.raw });
  });

  it('throws when both endpoints fail', async () => {
    const fakeFetchImpl: typeof fetch = async () => new Response('down', { status: 503 });
    const testAdapter = createRpcEvmAdapter({ fetchImpl: fakeFetchImpl });

    await expect(
      testAdapter.fetch('wallet.balances.native', { chain: 'ethereum', address: ADDRESS }),
    ).rejects.toThrow();
  });
});
