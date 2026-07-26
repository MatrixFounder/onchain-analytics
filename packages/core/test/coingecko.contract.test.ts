import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createCoingeckoAdapter, loadChainRegistry } from '../src/index.js';

// Golden fixture-based normalization tests (R-5, D11) — no network: fixtures were recorded ONCE
// via the manual fixture-recording dev script under packages/core/scripts/ (out of CI, R-22) and
// are committed under test/fixtures/coingecko/. `normalize()` is exercised directly against
// them; `fetch()` is only exercised here with an injected fake `fetchImpl` (no real HTTP), never
// the real network.

const testDir = path.dirname(fileURLToPath(import.meta.url));
const FIXED_NOW = 1_700_000_000_000;

interface CoingeckoFixture {
  chain: string;
  raw: {
    symbol: string;
    name: string;
    detail_platforms: Record<string, { contract_address: string; decimal_place: number }>;
    market_data: { current_price: { usd: number }; market_cap: { usd: number } };
  };
}

const CHAINS = loadChainRegistry();

/** The fixture stores the chain as a SLUG; the adapter's private fetch result carries a resolved
 * `ChainInfo` since TASK-006 (task 006-5). Resolving here keeps fixtures as recorded evidence and
 * leaves every expected OUTPUT untouched. */
function resolved(fixture: CoingeckoFixture): {
  chain: ReturnType<typeof CHAINS.resolve>;
  raw: CoingeckoFixture['raw'];
} {
  return { chain: CHAINS.resolve(fixture.chain), raw: fixture.raw };
}

function loadFixture(name: string): CoingeckoFixture {
  const raw = readFileSync(path.join(testDir, 'fixtures', 'coingecko', `${name}.json`), 'utf8');
  return JSON.parse(raw) as CoingeckoFixture;
}

describe('coingecko adapter (contract, R-5)', () => {
  const adapter = createCoingeckoAdapter({ now: () => FIXED_NOW });

  it('normalizes the ethereum/USDC fixture into a canonical Token', () => {
    const fixture = loadFixture('ethereum');
    const detail = fixture.raw.detail_platforms['ethereum']!;

    const result = adapter.normalize('token.price', resolved(fixture));

    expect(result).toEqual({
      chain: 'ethereum',
      // EIP-55 checksum, never the fixture's own lowercase contract_address (reviewer note).
      address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      symbol: 'USDC',
      name: 'USDC',
      decimals: detail.decimal_place,
      priceUsd: fixture.raw.market_data.current_price.usd,
      marketCapUsd: fixture.raw.market_data.market_cap.usd,
      source: 'coingecko',
      fetchedAt: FIXED_NOW,
    });
  });

  it('normalizes the solana/USDC fixture into a canonical Token (same shape for token.metadata)', () => {
    const fixture = loadFixture('solana');
    const detail = fixture.raw.detail_platforms['solana']!;

    const result = adapter.normalize('token.metadata', resolved(fixture));

    expect(result).toEqual({
      chain: 'solana',
      // base58, case-preserved as-is (unlike EVM) — matches the fixture's own contract_address.
      address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
      symbol: 'USDC',
      name: 'USDC',
      decimals: detail.decimal_place,
      priceUsd: fixture.raw.market_data.current_price.usd,
      marketCapUsd: fixture.raw.market_data.market_cap.usd,
      source: 'coingecko',
      fetchedAt: FIXED_NOW,
    });
  });

  // CHANGED EXPECTATION (task 006-5, R-54): no `chains` literal — the chain dimension belongs to
  // the coverage matrix (§4.2.3); a second list here could only drift from it.
  it('capabilities() declares token.price and token.metadata without a chain list', () => {
    const caps = adapter.capabilities();
    expect(caps.map((c) => c.id).sort()).toEqual(['token.metadata', 'token.price']);
    for (const cap of caps) {
      expect(cap.chains).toBeUndefined();
    }
  });

  it('chainSupport() follows the registry rather than a private literal (R-54)', () => {
    expect(adapter.chainSupport?.(CHAINS.resolve('ethereum'), 'token.price')).toBe(true);
    expect(adapter.chainSupport?.(CHAINS.resolve('solana'), 'token.price')).toBe(true);
    // Reachable only after TASK-006 — CoinGecko has an asset platform for it:
    expect(adapter.chainSupport?.(CHAINS.resolve('berachain'), 'token.price')).toBe(true);
    // The generator leaves `vendors.coingecko` null when the join was ambiguous, so a chain with
    // no platform id is honestly uncovered rather than optimistically claimed.
    const uncovered = CHAINS.list().find((c) => c.vendors['coingecko'] == null);
    if (uncovered) expect(adapter.chainSupport?.(uncovered, 'token.price')).toBe(false);
  });

  it('costOf() is free (0 credits) and isAvailable() is always ok (keyless/demo tier)', () => {
    expect(adapter.costOf('token.price', {})).toEqual({ credits: 0 });
    expect(adapter.isAvailable?.()).toEqual({ ok: true });
  });

  it('fetch() builds the documented contract endpoint through safeFetch (no real network)', async () => {
    const fixture = loadFixture('ethereum');
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const fakeFetchImpl: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
      return new Response(JSON.stringify(fixture.raw), { status: 200 });
    };
    const testAdapter = createCoingeckoAdapter({
      fetchImpl: fakeFetchImpl,
      now: () => FIXED_NOW,
      env: {},
    });

    const result = await testAdapter.fetch('token.price', {
      chain: 'ethereum',
      address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    });

    expect(calls.map((c) => c.url)).toEqual([
      'https://api.coingecko.com/api/v3/coins/ethereum/contract/0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    ]);
    // Keyless: no auth header of either contour leaks into the request.
    expect(calls[0]!.headers).not.toHaveProperty('x-cg-demo-api-key');
    expect(calls[0]!.headers).not.toHaveProperty('x-cg-pro-api-key');
    expect(result).toEqual({ chain: CHAINS.resolve('ethereum'), raw: fixture.raw });
  });

  // Two disjoint CoinGecko auth contours (live-probed 2026-07-23, see the adapter's fetch()
  // comment): demo key → free host + x-cg-demo-api-key; Pro key → pro host + x-cg-pro-api-key
  // (the pro host ignores the demo header entirely, so routing the wrong contour FAILS, it does
  // not merely degrade). The contour is declared by which env var is set; pro wins over demo.
  it.each([
    {
      label: 'COINGECKO_API_KEY (demo) → free host + x-cg-demo-api-key',
      env: { COINGECKO_API_KEY: 'CG-demo' },
      host: 'api.coingecko.com',
      headers: { 'x-cg-demo-api-key': 'CG-demo' },
    },
    {
      label: 'COINGECKO_PRO_API_KEY → pro host + x-cg-pro-api-key',
      env: { COINGECKO_PRO_API_KEY: 'CG-pro' },
      host: 'pro-api.coingecko.com',
      headers: { 'x-cg-pro-api-key': 'CG-pro' },
    },
    {
      label: 'both keys set → pro contour wins (paid key takes precedence)',
      env: { COINGECKO_API_KEY: 'CG-demo', COINGECKO_PRO_API_KEY: 'CG-pro' },
      host: 'pro-api.coingecko.com',
      headers: { 'x-cg-pro-api-key': 'CG-pro' },
    },
  ])('fetch() auth contour: $label', async ({ env, host, headers }) => {
    const fixture = loadFixture('ethereum');
    const calls: { url: string; headers: Record<string, string> }[] = [];
    const fakeFetchImpl: typeof fetch = async (url, init) => {
      calls.push({ url: String(url), headers: (init?.headers ?? {}) as Record<string, string> });
      return new Response(JSON.stringify(fixture.raw), { status: 200 });
    };
    const testAdapter = createCoingeckoAdapter({
      fetchImpl: fakeFetchImpl,
      now: () => FIXED_NOW,
      env,
    });

    await testAdapter.fetch('token.price', {
      chain: 'ethereum',
      address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
    });

    expect(calls).toEqual([
      {
        url: `https://${host}/api/v3/coins/ethereum/contract/0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`,
        headers,
      },
    ]);
  });
});
