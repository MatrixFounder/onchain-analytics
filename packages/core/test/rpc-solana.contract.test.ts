import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createRpcSolanaAdapter, type Wallet } from '../src/index.js';

// Golden fixture-based normalization tests (R-16/R-17 backend, D11) — no network: the fixture was
// recorded ONCE live via `scripts/record-fixture.mjs rpc-solana solana <address>` (2026-07-22,
// host api.mainnet-beta.solana.com, HTTP 200 — see the committed .evidence.md).

const testDir = path.dirname(fileURLToPath(import.meta.url));
const FIXED_NOW = 1_700_000_000_000;
const ADDRESS = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

interface RpcSolanaFixture {
  chain: string;
  address: string;
  // vdd-multi cycle 6 (H-1): the hand-off from `fetch()` to `normalize()` now carries the chain's
  // own gas token, so `normalize()` cannot label a balance `SOL`/9 on a chain that pays in
  // something else. The fixture carries it because the fixture IS that hand-off shape.
  nativeSymbol: string;
  nativeDecimals: number;
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

  // CHANGED EXPECTATION (vdd-multi cycle 6, M-7) — see `dune.test.ts` for the rationale.
  it('capabilities() declares wallet.balances.native without re-declaring a chain set', () => {
    expect(adapter.capabilities()).toEqual([{ id: 'wallet.balances.native' }]);
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
    expect(result).toEqual({
      chain: 'solana',
      address: ADDRESS,
      nativeSymbol: 'SOL',
      nativeDecimals: 9,
      raw: fixture.raw,
      // WI-8: the hand-off now also carries `result.value`'s exact wire digits. For this
      // ordinary-sized fixture they are simply the decimal form of the parsed number — the field
      // earns its keep only past 2^53, which the WI-8 describe block below covers.
      lamportsRaw: String(fixture.raw.result.value),
    });
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
      // Still rejected, for a NARROWER reason since WI-8: `normalize()` is driven directly here, so
      // no exact wire digits accompany the number and a value past the safe range genuinely cannot
      // be recovered. Through `fetch()` the same magnitude now succeeds — see the WI-8 block below.
      ['a value past Number.MAX_SAFE_INTEGER with no wire digits', 1e21],
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

  /**
   * WI-8 — exact lamports past 2^53. The body is written as a STRING LITERAL on purpose: building
   * it with `JSON.stringify({ value: 12345678901234567 })` would round-trip the number through a
   * double in the test itself, so the fixture could never carry digits the production path is
   * asked to preserve. This is the one place where hand-writing JSON is the point, not laziness.
   */
  describe('exact lamports past Number.MAX_SAFE_INTEGER (WI-8)', () => {
    // 12345678901234567 has no exact double; the nearest is 12345678901234568.
    const BIG = '12345678901234567';
    const bodyWith = (lamports: string) =>
      `{"jsonrpc":"2.0","result":{"context":{"apiVersion":"2.0.15","slot":1},"value":${lamports}},"id":1}`;

    async function balanceFor(lamports: string) {
      const testAdapter = createRpcSolanaAdapter({
        fetchImpl: async () => new Response(bodyWith(lamports), { status: 200 }),
        now: () => FIXED_NOW,
      });
      const fetched = await testAdapter.fetch('wallet.balances.native', {
        chain: 'solana',
        address: ADDRESS,
      });
      const wallet = testAdapter.normalize('wallet.balances.native', fetched) as Wallet;
      return wallet.balances[0]!;
    }

    it('TC-UNIT-04: amountRaw is the exact wire digit sequence, compared as a STRING', async () => {
      const balance = await balanceFor(BIG);

      expect(balance.amountRaw).toBe(BIG);
      // The assertion that proves the fix rather than restating it: the double-valued projection
      // and the exact string DISAGREE here. Before WI-8 this balance was refused outright, and the
      // only value the adapter could have offered is the wrong one on the right-hand side.
      expect(String(balance.amountNum)).not.toBe(balance.amountRaw);
      expect(balance.amountNum).toBe(12345678901234568);
    });

    it('TC-UNIT-05: an ordinary balance is unchanged — amountRaw and amountNum still agree', async () => {
      const balance = await balanceFor('123456789');

      expect(balance.amountRaw).toBe('123456789');
      expect(balance.amountNum).toBe(123456789);
      expect(String(balance.amountNum)).toBe(balance.amountRaw);
    });

    it('refuses rather than guesses when the digits do not belong to the parsed number', async () => {
      // A hand-built DTO whose `lamportsRaw` contradicts `result.value`: the self-check rejects the
      // digits, and with the number past the safe range there is nothing left to fall back on.
      expect(() =>
        adapter.normalize('wallet.balances.native', {
          chain: 'solana',
          address: ADDRESS,
          nativeSymbol: 'SOL',
          nativeDecimals: 9,
          raw: { jsonrpc: '2.0', id: 1, result: { context: { slot: 1 }, value: 1e21 } },
          lamportsRaw: '42',
        }),
      ).toThrow(/invalid lamports value/);
    });
  });

  it('bounds an oversized raw response inside a normalize() error message to a truncated, fixed-size string (post-M1 polish, fix 5)', () => {
    const oversizedContext = { slot: 1, extra: 'y'.repeat(50_000) };
    let thrown: Error | undefined;
    try {
      adapter.normalize('wallet.balances.native', {
        chain: 'solana',
        address: ADDRESS,
        raw: { jsonrpc: '2.0', id: 1, result: { context: oversizedContext, value: -1 } },
      });
    } catch (error) {
      thrown = error as Error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown!.message).toContain(
      'rpc-solana.normalize: invalid lamports value in "result.value":',
    );
    expect(thrown!.message).toContain('…[truncated]');
    // The full raw payload is ~50KB — the message must stay bounded (well under 1KB), never
    // proportional to the (potentially up-to-10MB) response body.
    expect(thrown!.message.length).toBeLessThan(600);
  });
});
