import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { createDexscreenerAdapter, loadChainRegistry } from '../src/index.js';
import type { PoolPage } from '../src/adapters/dexscreener/index.js';

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

const CHAINS = loadChainRegistry();

/** The fixture stores the chain as a SLUG; the adapter's private fetch result carries a
 * resolved `ChainInfo` since TASK-006 (task 006-5). Expected OUTPUTS below are unchanged. */
function resolved<T extends { chain: string }>(
  f: T,
): { chain: ReturnType<typeof CHAINS.resolve> } & Omit<T, 'chain'> {
  const { chain, ...rest } = f;
  return { chain: CHAINS.resolve(chain), ...rest } as {
    chain: ReturnType<typeof CHAINS.resolve>;
  } & Omit<T, 'chain'>;
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

    const result = adapter.normalize('pairs.active', resolved(fixture)) as PoolPage;

    expect(expected.length).toBeGreaterThan(0);
    expect(result.pools).toEqual(expected);
    // Q-10: the fixture page is not cut and carries no malformed row, so the caller must be told
    // the page IS the whole answer. An always-true `truncated` would be as useless as no field.
    expect(result.truncated).toEqual({ pairs: false, reason: '' });
  });

  it('normalizes the solana search fixture into canonical Pool[], scoped to solana only', () => {
    const fixture = loadFixture('solana');
    const expected = fixture.raw.pairs
      .filter((pair) => pair.chainId === 'solana')
      .slice(0, fixture.limit)
      .map((pair) => expectedPool('solana', pair));

    const result = adapter.normalize('pool.info', resolved(fixture)) as PoolPage;

    expect(expected.length).toBeGreaterThan(0);
    expect(result.pools).toEqual(expected);
    // Q-10, found by the field the moment it existed: this recorded fixture has MORE solana rows
    // than `limit` allows, so the page has always been a cut one — and until now nothing in the
    // response said so. The assertion is written against the vendor page rather than as a literal,
    // so re-recording the fixture cannot make it silently wrong.
    const cut =
      fixture.raw.pairs.filter((pair) => pair.chainId === 'solana').length - expected.length;
    expect(cut).toBeGreaterThan(0);
    expect(result.truncated).toEqual({
      pairs: true,
      reason: `${cut} further row(s) on this chain were cut by limit=${fixture.limit}`,
    });
  });

  // CHANGED EXPECTATION (task 006-5, R-54): the `chains` literal is gone — coverage is the
  // matrix's job (§4.2.3).
  it('capabilities() declares pairs.active and pool.info without a chain list', () => {
    const caps = adapter.capabilities();
    expect(caps.map((c) => c.id).sort()).toEqual(['pairs.active', 'pool.info']);
    for (const cap of caps) {
      expect(cap.chains).toBeUndefined();
    }
  });

  it('costOf() is free (0 credits) and isAvailable() is always ok (keyless)', () => {
    expect(adapter.costOf('pairs.active', {})).toEqual({ credits: 0 });
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

    const result = await testAdapter.fetch('pairs.active', { chain: 'ethereum' });

    expect(calls).toEqual(['https://api.dexscreener.com/latest/dex/search?q=ETH']);
    expect(result).toEqual({ chain: CHAINS.resolve('ethereum'), limit: 10, raw: fixture.raw });
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

      const result = adapter.normalize('pairs.active', {
        chain: CHAINS.resolve('ethereum'),
        limit: 10,
        raw,
      }) as PoolPage;

      expect(result.pools).toHaveLength(1);
      expect(result.pools[0]!.pairAddress).toBe('0xgood');
      expect(stderrSpy).toHaveBeenCalledWith(
        expect.stringContaining('skipped 1 malformed pair(s) of 2'),
      );
      // Q-10, the whole point of the record: the operator's channel AND the caller's must both
      // carry the drop. Asserting only the stderr line is what left the caller blind for a month.
      expect(result.truncated.pairs).toBe(true);
      expect(result.truncated.reason).toContain('1 of 2');
      expect(result.truncated.reason).toContain('dropped');
      stderrSpy.mockRestore();
    });

    it('reports a page cut by `limit` separately from a dropped row (Q-10)', () => {
      // The two causes are NOT interchangeable to a consumer: rows cut by `limit` come back if you
      // ask for more, dropped rows never do. A single boolean would collapse them; the reason must
      // keep them apart, and this is the case that proves it does.
      const raw = {
        schemaVersion: '1.0.0',
        pairs: [0, 1, 2].map((i) => ({
          chainId: 'ethereum',
          dexId: 'uniswap',
          pairAddress: `0x${i}`,
          baseToken: { symbol: 'WETH' },
          quoteToken: { symbol: 'USDC' },
        })),
      };

      const result = adapter.normalize('pairs.active', {
        chain: CHAINS.resolve('ethereum'),
        limit: 2,
        raw,
      }) as PoolPage;

      expect(result.pools).toHaveLength(2);
      expect(result.truncated.pairs).toBe(true);
      expect(result.truncated.reason).toContain('cut by limit=2');
      // …and says nothing about dropped rows, because none were dropped.
      expect(result.truncated.reason).not.toContain('dropped');
    });

    it('throws when every candidate pair in the batch is malformed (never a silent empty result)', () => {
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const raw = {
        schemaVersion: '1.0.0',
        pairs: [{ chainId: 'ethereum', dexId: 'uniswap', baseToken: {}, quoteToken: {} }],
      };

      expect(() =>
        adapter.normalize('pairs.active', { chain: CHAINS.resolve('ethereum'), limit: 10, raw }),
      ).toThrow(/all 1 candidate pair\(s\).*were malformed/);
      stderrSpy.mockRestore();
    });
  });
});
