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
    // L-14 — THIS ASSERTION USED TO READ `{pairs: false, reason: ''}`, on the reasoning that the
    // page was neither cut by `limit` nor carrying a malformed row, so it "IS the whole answer".
    // Both halves of that were true and the conclusion was still wrong: the recorded page is FULL
    // (30 rows, the vendor cap), and 28 of its 30 slots hold OTHER chains. The engine was
    // answering "ethereum has these 2 pairs, nothing was lost" — for ethereum. Derived from the
    // fixture, not written as a literal, so re-recording it cannot make the test silently wrong.
    const ethRows = fixture.raw.pairs.filter((pair) => pair.chainId === 'ethereum').length;
    expect(fixture.raw.pairs.length).toBe(30);
    expect(ethRows).toBeLessThan(fixture.limit); // nothing was cut by `limit` — the old premise
    expect(result.truncated.pairs).toBe(true);
    expect(result.truncated.reason).toContain(`FULL page of ${fixture.raw.pairs.length} row(s)`);
    expect(result.truncated.reason).toContain(
      `${fixture.raw.pairs.length - ethRows} slot(s) of that page held OTHER chains`,
    );
    expect(result.truncated.reason).not.toContain('cut by limit');
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
    const solRows = fixture.raw.pairs.filter((pair) => pair.chainId === 'solana').length;
    const cut = solRows - expected.length;
    expect(cut).toBeGreaterThan(0);
    expect(result.truncated.pairs).toBe(true);
    expect(result.truncated.reason).toContain(
      `${cut} further row(s) on this chain were cut by limit=${fixture.limit}`,
    );
    // L-14: this page is BOTH cut by us and capped by the vendor, and the two are reported
    // separately on purpose — the first can be widened by asking for more, the second cannot.
    expect(fixture.raw.pairs.length).toBe(30);
    expect(result.truncated.reason).toContain(`FULL page of ${fixture.raw.pairs.length} row(s)`);
    expect(result.truncated.reason).toContain(
      `${fixture.raw.pairs.length - solRows} slot(s) of that page held OTHER chains`,
    );
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

  describe('vendor page cap (L-14)', () => {
    /** A page of `n` well-formed ethereum rows — the only variable these cases care about. */
    const ethPage = (n: number): { schemaVersion: string; pairs: unknown[] } => ({
      schemaVersion: '1.0.0',
      pairs: Array.from({ length: n }, (_unused, i) => ({
        chainId: 'ethereum',
        dexId: 'uniswap',
        pairAddress: `0x${i}`,
        baseToken: { symbol: 'WETH' },
        quoteToken: { symbol: 'USDC' },
      })),
    });

    const normalizePage = (raw: unknown, limit = 100): PoolPage =>
      adapter.normalize('pairs.active', {
        chain: CHAINS.resolve('ethereum'),
        limit,
        raw,
      }) as PoolPage;

    // THE GUARD THAT MATTERS. The check added for L-14 answers "possibly incomplete" from a full
    // page, and a check that fires on every page is worth exactly as much as one that never fires
    // — which is the failure L-10 already cost this project once. This case is the one that fails
    // if the condition is ever loosened to always-true.
    it('a SHORT page is still reported as complete — the check is not always-true', () => {
      const result = normalizePage(ethPage(29));

      expect(result.pools).toHaveLength(29);
      expect(result.truncated).toEqual({ pairs: false, reason: '' });
    });

    // Brackets the pinned constant from the other side: 29 → complete, 30 → capped. Together these
    // two cases fail if `VENDOR_PAGE_SIZE` is edited without re-probing the vendor.
    it('a FULL page is reported as capped, naming the cap rather than our own limit', () => {
      const result = normalizePage(ethPage(30));

      expect(result.pools).toHaveLength(30);
      expect(result.truncated.pairs).toBe(true);
      expect(result.truncated.reason).toContain('FULL page of 30 row(s) (cap 30)');
      expect(result.truncated.reason).toContain('q=ETH');
      // Nothing of ours cut anything here, so neither of the two older causes may appear — the
      // vendor cap is a THIRD kind, and telling the caller to retry with a bigger `limit` would be
      // advice that cannot work.
      expect(result.truncated.reason).not.toContain('cut by limit');
      expect(result.truncated.reason).not.toContain('dropped');
      expect(result.truncated.reason).toContain('0 slot(s) of that page held OTHER chains');
    });

    it('counts the slots a capped page gave to other chains', () => {
      const mixed = ethPage(30);
      // Ten of the thirty slots go elsewhere — the shape that made `q=BERA` return 20 berachain
      // rows, and `q=ETH` return 2 ethereum ones.
      for (let i = 0; i < 10; i += 1) {
        (mixed.pairs[i] as { chainId: string }).chainId = 'solana';
      }

      const result = normalizePage(mixed);

      expect(result.pools).toHaveLength(20);
      expect(result.truncated.pairs).toBe(true);
      expect(result.truncated.reason).toContain('10 slot(s) of that page held OTHER chains');
    });

    it('reports the vendor cap ALONGSIDE our own cut, never folded into it', () => {
      const result = normalizePage(ethPage(30), 5);

      expect(result.pools).toHaveLength(5);
      expect(result.truncated.pairs).toBe(true);
      expect(result.truncated.reason).toContain(
        '25 further row(s) on this chain were cut by limit=5',
      );
      expect(result.truncated.reason).toContain('FULL page of 30 row(s)');
    });
  });
});
