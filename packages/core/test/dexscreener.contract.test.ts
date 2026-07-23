import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { createDexscreenerAdapter } from '../src/index.js';
import type { Pool } from '../src/index.js';

// Golden fixture-based normalization tests (R-6, D11) — no network: fixtures were recorded ONCE
// via the manual fixture-recording dev script under packages/core/scripts/ (out of CI, R-22) and
// are committed under test/fixtures/dexscreener/. `normalize()` is exercised directly against
// them; `fetch()` is only exercised here with an injected fake `fetchImpl` (no real HTTP), never
// the real network.

const testDir = path.dirname(fileURLToPath(import.meta.url));
const FIXED_NOW = 1_700_000_000_000;

interface DexscreenerFixturePair {
  chainId: string;
  dexId: string;
  pairAddress: string;
  baseToken: { symbol: string };
  quoteToken: { symbol: string };
  liquidity?: { usd?: number };
  volume?: { h24?: number };
  pairCreatedAt?: number;
}

interface DexscreenerFixture {
  chain: string;
  limit: number;
  raw: { schemaVersion: string; pairs: DexscreenerFixturePair[] };
}

function loadFixture(name: string): DexscreenerFixture {
  const raw = readFileSync(path.join(testDir, 'fixtures', 'dexscreener', `${name}.json`), 'utf8');
  return JSON.parse(raw) as DexscreenerFixture;
}

function expectedPool(chain: string, pair: DexscreenerFixturePair) {
  return {
    id: `${chain}:${pair.pairAddress}`,
    chain,
    dexId: pair.dexId,
    baseTokenSymbol: pair.baseToken.symbol,
    quoteTokenSymbol: pair.quoteToken.symbol,
    pairAddress: pair.pairAddress,
    source: 'dexscreener',
    fetchedAt: FIXED_NOW,
    ...(typeof pair.pairCreatedAt === 'number' ? { createdAt: pair.pairCreatedAt } : {}),
    ...(typeof pair.liquidity?.usd === 'number' ? { liquidityUsd: pair.liquidity.usd } : {}),
    ...(typeof pair.volume?.h24 === 'number' ? { volume24hUsd: pair.volume.h24 } : {}),
  };
}

describe('dexscreener adapter (contract, R-6)', () => {
  const adapter = createDexscreenerAdapter({ now: () => FIXED_NOW });

  it('the recorded fixture is an OBJECT with a pairs[] property, not a top-level array (§11 shape-trap)', () => {
    const fixture = loadFixture('ethereum');
    expect(Array.isArray(fixture.raw)).toBe(false);
    expect(Array.isArray(fixture.raw.pairs)).toBe(true);
  });

  it('normalizes the ethereum search fixture into canonical Pool[], scoped to ethereum only', () => {
    const fixture = loadFixture('ethereum');
    const expected = fixture.raw.pairs
      .filter((pair) => pair.chainId === 'ethereum')
      .slice(0, fixture.limit)
      .map((pair) => expectedPool('ethereum', pair));

    const result = adapter.normalize('pairs.new', fixture);

    expect(expected.length).toBeGreaterThan(0);
    expect(result).toEqual(expected);
  });

  it('normalizes the solana search fixture into canonical Pool[], scoped to solana only', () => {
    const fixture = loadFixture('solana');
    const expected = fixture.raw.pairs
      .filter((pair) => pair.chainId === 'solana')
      .slice(0, fixture.limit)
      .map((pair) => expectedPool('solana', pair));

    const result = adapter.normalize('pool.info', fixture);

    expect(expected.length).toBeGreaterThan(0);
    expect(result).toEqual(expected);
  });

  it('capabilities() declares pairs.new and pool.info for ethereum+solana', () => {
    const caps = adapter.capabilities();
    expect(caps.map((c) => c.id).sort()).toEqual(['pairs.new', 'pool.info']);
    for (const cap of caps) {
      expect(cap.chains).toEqual(['ethereum', 'solana']);
    }
  });

  it('costOf() is free (0 credits) and isAvailable() is always ok (keyless)', () => {
    expect(adapter.costOf('pairs.new', {})).toEqual({ credits: 0 });
    expect(adapter.isAvailable?.()).toEqual({ ok: true });
  });

  it('fetch() builds the documented search endpoint through safeFetch (no real network)', async () => {
    const fixture = loadFixture('ethereum');
    const calls: string[] = [];
    const fakeFetchImpl: typeof fetch = async (url) => {
      calls.push(String(url));
      return new Response(JSON.stringify(fixture.raw), { status: 200 });
    };
    const testAdapter = createDexscreenerAdapter({
      fetchImpl: fakeFetchImpl,
      now: () => FIXED_NOW,
    });

    const result = await testAdapter.fetch('pairs.new', { chain: 'ethereum' });

    expect(calls).toEqual(['https://api.dexscreener.com/latest/dex/search?q=ETH']);
    expect(result).toEqual({ chain: 'ethereum', limit: 10, raw: fixture.raw });
  });

  describe('malformed pair handling (adversarial cycle 1, fix G)', () => {
    it('drops a malformed pair and returns the well-formed subset (N-1), with one stderr summary line', () => {
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const raw = {
        schemaVersion: '1.0.0',
        pairs: [
          {
            chainId: 'ethereum',
            dexId: 'uniswap',
            pairAddress: '0xgood',
            baseToken: { symbol: 'WETH' },
            quoteToken: { symbol: 'USDC' },
          },
          {
            chainId: 'ethereum',
            dexId: 'uniswap',
            // pairAddress missing — malformed.
            baseToken: { symbol: 'WETH' },
            quoteToken: { symbol: 'USDC' },
          },
        ],
      };

      const result = adapter.normalize('pairs.new', {
        chain: 'ethereum',
        limit: 10,
        raw,
      }) as Pool[];

      expect(result).toHaveLength(1);
      expect(result[0]!.pairAddress).toBe('0xgood');
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining('skipped 1 malformed pair(s) of 2'),
      );
      stderrSpy.mockRestore();
    });

    it('throws when every candidate pair in the batch is malformed (never a silent empty result)', () => {
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const raw = {
        schemaVersion: '1.0.0',
        pairs: [{ chainId: 'ethereum', dexId: 'uniswap', baseToken: {}, quoteToken: {} }],
      };

      expect(() => adapter.normalize('pairs.new', { chain: 'ethereum', limit: 10, raw })).toThrow(
        /all 1 candidate pair\(s\).*were malformed/,
      );
      stderrSpy.mockRestore();
    });
  });
});
