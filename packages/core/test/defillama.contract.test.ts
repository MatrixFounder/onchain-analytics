import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createDefillamaAdapter } from '../src/index.js';

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

function loadFixture(name: string): DefillamaFixture {
  const raw = readFileSync(path.join(testDir, 'fixtures', 'defillama', `${name}.json`), 'utf8');
  return JSON.parse(raw) as DefillamaFixture;
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

  it('capabilities() declares protocol.tvl for ethereum+solana', () => {
    const caps = adapter.capabilities();
    expect(caps.map((c) => c.id)).toEqual(['protocol.tvl']);
    expect(caps[0]!.chains).toEqual(['ethereum', 'solana']);
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
    expect(result).toEqual({ chain: 'ethereum', raw: fixture.raw });
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
