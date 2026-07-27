import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CapabilityNotCoveredOnChainError } from '../src/chain/errors.js';
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
  // CHANGED EXPECTATION (TASK-007 task 007-1, R-61): a third capability on the same adapter.
  it('capabilities() declares all three capabilities without a hardcoded chain list', () => {
    const caps = adapter.capabilities();
    expect(caps.map((c) => c.id)).toEqual(['protocol.tvl', 'chain.tvl', 'dex.volume.history']);
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

    // CHANGED EXPECTATION (vdd-multi cycle 6, L-9): still loud, but with the PERMANENT error
    // class. The registry is deliberately stale (it is a build artifact), so a row the vendor no
    // longer lists is a normal consequence of that design — not an outage. Reported as
    // `CapabilityUnavailableError` it told the agent to retry a call that fails identically until
    // the next sync, and negative-cached that verdict on the way.
    it('reports a chain the vendor no longer lists as PERMANENTLY uncovered, not retryable', () => {
      expect(() =>
        adapter.normalize('chain.tvl', { chain: CHAINS.resolve('ethereum'), raw: [] }),
      ).toThrow(CapabilityNotCoveredOnChainError);
      expect(() =>
        adapter.normalize('chain.tvl', { chain: CHAINS.resolve('ethereum'), raw: [] }),
      ).toThrow(/no longer lists/);
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
      // `fetchedAt` rides along from the shared catalog memo (vdd-multi cycle 6, M-1) so
      // `normalize()` reports the DATA's age rather than its own — see the adapter for why two
      // TTL windows in series do not compose into one.
      expect(result).toEqual({
        chain: CHAINS.resolve('berachain'),
        raw: CHAINS_FIXTURE,
        fetchedAt: FIXED_NOW,
      });
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
    expect(adapter.costOf('dex.volume.history', {})).toEqual({ credits: 0 });
    expect(adapter.isAvailable?.()).toEqual({ ok: true });
  });

  // TASK-007 task 007-1 (R-61) — the capability is declared and routed. Two CHANGED EXPECTATIONS
  // since: task 007-2 (R-63) replaced the flat `false` with the real vendor list, and tasks
  // 007-4/007-5 replaced the `NotImplemented` throws with the transport and normalizer. What
  // belongs HERE is only the adapter-level surface; coverage lives in
  // `defillama-dex-coverage.test.ts` and behaviour in `defillama-dex-volume.test.ts`.
  describe('dex.volume.history — adapter surface (task 007-1)', () => {
    it('chainSupport() is capability-aware, not one answer for the whole adapter', () => {
      const ethereum = CHAINS.resolve('ethereum');
      expect(adapter.chainSupport?.(ethereum, 'chain.tvl')).toBe(true);
      expect(adapter.chainSupport?.(ethereum, 'dex.volume.history')).toBe(true);
      // A chain the vendor names for TVL but not for DEX volume answers differently per capability.
      const tvlOnly = CHAINS.list().find(
        (c) =>
          adapter.chainSupport?.(c, 'chain.tvl') === true &&
          adapter.chainSupport?.(c, 'dex.volume.history') === false,
      );
      expect(tvlOnly, 'the registry must contain at least one TVL-only chain').toBeDefined();
    });

    it('normalize() refuses a fetch result that carries no validated args', () => {
      // Reachable only by calling the adapter out of band — `fetch()` always attaches them. Loud
      // rather than silent, because the alternative is normalizing against an invented window.
      expect(() => adapter.normalize('dex.volume.history', {})).toThrow(/no validated args/);
    });
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
