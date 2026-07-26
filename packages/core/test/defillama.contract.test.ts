import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createDefillamaAdapter, loadChainRegistry } from '../src/index.js';

// Golden fixture-based normalization tests (R-7, D11) — no network: fixtures were recorded ONCE
// via the manual fixture-recording dev script under packages/core/scripts/ (out of CI, R-22) and
// are committed under test/fixtures/defillama/. `normalize()` is exercised directly against
// them; `fetch()` is only exercised here with an injected fake `fetchImpl` (no real HTTP), never
// the real network.

const testDir = path.dirname(fileURLToPath(import.meta.url));
const FIXED_NOW = 1_700_000_000_000;

interface DefillamaFixture {
  chain: string;
  raw: {
    name: string;
    chainTvls: Record<string, { tvl: { date: number; totalLiquidityUSD: number }[] }>;
    tvl: { date: number; totalLiquidityUSD: number }[];
  };
}

const CHAINS = loadChainRegistry();

/**
 * The fixture stores the chain as a SLUG; `normalize()` consumes the adapter's private fetch
 * result, whose `chain` became a resolved `ChainInfo` in TASK-006 (task 006-5). Resolving here
 * keeps the fixtures as recorded vendor evidence and leaves every expected OUTPUT below untouched.
 */
function loadFixture(name: string): {
  chain: ReturnType<typeof CHAINS.resolve>;
  raw: DefillamaFixture['raw'];
} {
  const raw = readFileSync(path.join(testDir, 'fixtures', 'defillama', `${name}.json`), 'utf8');
  const fixture = JSON.parse(raw) as DefillamaFixture;
  return { chain: CHAINS.resolve(fixture.chain), raw: fixture.raw };
}

describe('defillama adapter (contract, R-7)', () => {
  const adapter = createDefillamaAdapter({ now: () => FIXED_NOW });

  it('normalizes the ethereum/uniswap fixture into the protocol.tvl result shape', () => {
    const fixture = loadFixture('uniswap');
    const chainSeries = fixture.raw.chainTvls['Ethereum']!.tvl;
    const totalSeries = fixture.raw.tvl;

    const result = adapter.normalize('protocol.tvl', fixture);

    expect(result).toEqual({
      protocol: fixture.raw.name,
      chain: 'ethereum',
      tvlUsd: chainSeries[chainSeries.length - 1]!.totalLiquidityUSD,
      totalTvlUsd: totalSeries[totalSeries.length - 1]!.totalLiquidityUSD,
      source: 'defillama',
      fetchedAt: FIXED_NOW,
    });
  });

  it('normalizes the solana/raydium fixture into the protocol.tvl result shape', () => {
    const fixture = loadFixture('raydium');
    const chainSeries = fixture.raw.chainTvls['Solana']!.tvl;
    const totalSeries = fixture.raw.tvl;

    const result = adapter.normalize('protocol.tvl', fixture);

    expect(result).toEqual({
      protocol: fixture.raw.name,
      chain: 'solana',
      tvlUsd: chainSeries[chainSeries.length - 1]!.totalLiquidityUSD,
      totalTvlUsd: totalSeries[totalSeries.length - 1]!.totalLiquidityUSD,
      source: 'defillama',
      fetchedAt: FIXED_NOW,
    });
  });

  // CHANGED EXPECTATION (task 006-5, R-54): `capabilities()` no longer carries a `chains` literal.
  // The chain dimension is the coverage matrix's job (§4.2.3) — a second list here could only
  // drift from it. What the adapter answers about chains now goes through `chainSupport()`.
  it('capabilities() declares protocol.tvl and chain.tvl without a hardcoded chain list', () => {
    const caps = adapter.capabilities();
    expect(caps.map((c) => c.id)).toEqual(['protocol.tvl', 'chain.tvl']);
    for (const cap of caps) expect(cap.chains).toBeUndefined();
  });

  // TASK-006 task 006-7 (R-53): chain TVL is a SEPARATE capability — different endpoint, different
  // contract. A chain has no `totalTvlUsd`, so folding it into `protocol.tvl` would need a
  // parameter that changes the meaning of the other fields.
  describe('chain.tvl (task 006-7)', () => {
    const CHAINS_FIXTURE = [
      { gecko_id: 'ethereum', tvl: 6.0e10, tokenSymbol: 'ETH', name: 'Ethereum', chainId: 1 },
      {
        gecko_id: 'berachain-bera',
        tvl: 50_579_539.42,
        tokenSymbol: 'BERA',
        name: 'Berachain',
        chainId: 80094,
      },
    ];

    it('normalizes the /v2/chains row for the requested chain', () => {
      const result = adapter.normalize('chain.tvl', {
        chain: CHAINS.resolve('berachain'),
        raw: CHAINS_FIXTURE,
      });
      expect(result).toEqual({
        chain: 'berachain',
        name: CHAINS.resolve('berachain').name,
        tvlUsd: 50_579_539.42,
        source: 'defillama',
        fetchedAt: FIXED_NOW,
      });
    });

    it('fails loudly when the chain is absent from the vendor list', () => {
      expect(() =>
        adapter.normalize('chain.tvl', { chain: CHAINS.resolve('ethereum'), raw: [] }),
      ).toThrow(/absent from \/v2\/chains/);
    });

    it.each([[-1], [Number.NaN], [Number.POSITIVE_INFINITY], ['nope']])(
      'rejects a bad tvl value (%s) BEFORE it can be cached',
      (bad) => {
        expect(() =>
          adapter.normalize('chain.tvl', {
            chain: CHAINS.resolve('ethereum'),
            raw: [{ name: 'Ethereum', tvl: bad }],
          }),
        ).toThrow(/invalid tvl/);
      },
    );

    it('fetch() hits /v2/chains, not the protocol endpoint', async () => {
      const calls: string[] = [];
      const testAdapter = createDefillamaAdapter({
        now: () => FIXED_NOW,
        fetchImpl: async (url) => {
          calls.push(String(url));
          return new Response(JSON.stringify(CHAINS_FIXTURE), { status: 200 });
        },
      });
      const result = await testAdapter.fetch('chain.tvl', { chain: 'berachain' });
      expect(calls).toEqual(['https://api.llama.fi/v2/chains']);
      expect(result).toEqual({ chain: CHAINS.resolve('berachain'), raw: CHAINS_FIXTURE });
    });
  });

  it('chainSupport() follows the registry rather than a private map (R-54)', () => {
    expect(adapter.chainSupport?.(CHAINS.resolve('ethereum'), 'protocol.tvl')).toBe(true);
    expect(adapter.chainSupport?.(CHAINS.resolve('solana'), 'protocol.tvl')).toBe(true);
    // A chain DeFiLlama does cover, that the pre-TASK-006 map could never have served:
    expect(adapter.chainSupport?.(CHAINS.resolve('berachain'), 'protocol.tvl')).toBe(true);
    // A chain the registry knows but DeFiLlama does not name:
    const uncovered = CHAINS.list().find((c) => c.vendors['defillama'] == null);
    if (uncovered) expect(adapter.chainSupport?.(uncovered, 'protocol.tvl')).toBe(false);
  });

  it('costOf() is free (0 credits) and isAvailable() is always ok (keyless)', () => {
    expect(adapter.costOf('protocol.tvl', {})).toEqual({ credits: 0 });
    expect(adapter.isAvailable?.()).toEqual({ ok: true });
  });

  it('fetch() builds the documented protocol endpoint through safeFetch (no real network)', async () => {
    const fixture = loadFixture('uniswap');
    const calls: string[] = [];
    const fakeFetchImpl: typeof fetch = async (url) => {
      calls.push(String(url));
      return new Response(JSON.stringify(fixture.raw), { status: 200 });
    };
    const testAdapter = createDefillamaAdapter({ fetchImpl: fakeFetchImpl, now: () => FIXED_NOW });

    const result = await testAdapter.fetch('protocol.tvl', {
      chain: 'ethereum',
      protocolSlug: 'uniswap',
    });

    expect(calls).toEqual(['https://api.llama.fi/protocol/uniswap']);
    expect(result).toEqual({ chain: CHAINS.resolve('ethereum'), raw: fixture.raw });
  });

  describe('tvl value validation (adversarial cycle 2, finding 1b)', () => {
    it('throws a clear error when the chain-scoped series’ last point is negative', () => {
      const fixture = loadFixture('uniswap');
      const corrupted = structuredClone(fixture);
      const series = corrupted.raw.chainTvls['Ethereum']!.tvl;
      series[series.length - 1]!.totalLiquidityUSD = -1;

      expect(() => adapter.normalize('protocol.tvl', corrupted)).toThrow(/invalid tvl value\(s\)/);
    });

    it('throws a clear error when the top-level series’ last point is negative', () => {
      const fixture = loadFixture('uniswap');
      const corrupted = structuredClone(fixture);
      const series = corrupted.raw.tvl;
      series[series.length - 1]!.totalLiquidityUSD = -1;

      expect(() => adapter.normalize('protocol.tvl', corrupted)).toThrow(/invalid tvl value\(s\)/);
    });
  });
});
