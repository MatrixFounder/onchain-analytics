import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createBlockchainInfoAdapter, loadChainRegistry, type ChainSupply } from '../src/index.js';

/**
 * TASK-009 (R-81…R-85) — the `blockchain-info` adapter against recorded fixtures.
 *
 * No network: every case injects `fetchImpl`. The live probe that produced these numbers is pinned
 * under `docs/onchain-analytics/raw/` and verified by `verify-provenance`, so a silent edit to the
 * evidence cannot quietly move what this suite asserts.
 */

const fixtureDir = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  'fixtures/blockchain-info',
);
const STATS = JSON.parse(readFileSync(path.join(fixtureDir, 'stats.json'), 'utf8')) as Record<
  string,
  unknown
>;

/** Live-recorded on 2026-07-29, alongside the `/stats` fixture. */
const CIRCULATING_BODY = '2006279000000000';

const chains = loadChainRegistry();

/** Serves `/stats` and `/q/totalbc` from data, and records what was requested. */
function stubFetch(
  overrides: { stats?: unknown; circulating?: string; statsStatus?: number } = {},
): { impl: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const impl = ((url: string) => {
    urls.push(url);
    if (url.includes('/q/totalbc')) {
      return Promise.resolve(
        new Response(overrides.circulating ?? CIRCULATING_BODY, {
          status: 200,
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        }),
      );
    }
    return Promise.resolve(
      new Response(JSON.stringify(overrides.stats ?? STATS), {
        status: overrides.statsStatus ?? 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      }),
    );
  }) as unknown as typeof fetch;
  return { impl, urls };
}

const build = (overrides?: Parameters<typeof stubFetch>[0]) => {
  const { impl, urls } = stubFetch(overrides);
  const adapter = createBlockchainInfoAdapter({
    fetchImpl: impl,
    chains,
    now: () => 1_700_000_000_000,
    // No real waiting in tests; the limiter itself is covered by `rate-limit.test.ts`.
    throttle: () => Promise.resolve(),
  });
  return { adapter, urls };
};

async function resolveSupply(
  overrides?: Parameters<typeof stubFetch>[0],
): Promise<{ value: ChainSupply; urls: string[] }> {
  const { adapter, urls } = build(overrides);
  const raw = await adapter.fetch('chain.supply', { chain: 'bitcoin' });
  return { value: adapter.normalize('chain.supply', raw) as ChainSupply, urls };
}

describe('blockchain-info adapter — configuration contract (R-81)', () => {
  const adapter = createBlockchainInfoAdapter({ chains });

  it('declares one capability and charges nothing for it', () => {
    expect(adapter.capabilities()).toEqual([{ id: 'chain.supply' }]);
    expect(adapter.costOf('chain.supply', {})).toEqual({ credits: 0 });
  });

  it('is available with no key, because the vendor offers none for these surfaces', () => {
    expect(adapter.isAvailable?.()).toEqual({ ok: true });
  });

  it('covers bitcoin and nothing else in the whole registry (R-87)', () => {
    const covered = chains
      .list()
      .filter((chain) => adapter.chainSupport?.(chain, 'chain.supply') === true);
    expect(covered.map((c) => c.slug)).toEqual(['bitcoin']);
  });

  it('does not cover any EVM or SVM chain — coverage is keyed on caip2, not on a name', () => {
    for (const slug of ['ethereum', 'solana', 'base', 'polygon', 'bsc']) {
      const chain = chains.resolve(slug);
      expect(adapter.chainSupport?.(chain, 'chain.supply')).toBe(false);
    }
  });
});

describe('blockchain-info adapter — the two supply figures (R-84)', () => {
  it('reads emission from /stats and circulating from /q/totalbc, never one for the other', async () => {
    const { value, urls } = await resolveSupply();

    expect(value.emissionRaw).toBe(String(STATS['totalbc']));
    expect(value.circulatingRaw).toBe(CIRCULATING_BODY);
    // The two ARE different values — the assertion that would have caught serving one under the
    // other's name, which is a 0.00016% error and invisible to any eyeball check.
    expect(value.emissionRaw).not.toBe(value.circulatingRaw);
    expect(urls.some((u) => u.includes('/stats'))).toBe(true);
    expect(urls.some((u) => u.includes('/q/totalbc'))).toBe(true);
  });

  it('publishes the block COUNT the emission figure is consistent with', async () => {
    const { value } = await resolveSupply();
    expect(value.blockCount).toBe(STATS['n_blocks_total']);
  });

  it('reports the difference as unclaimed subsidy in the range the live probe measured', async () => {
    const { value } = await resolveSupply();
    const gapSat = BigInt(value.emissionRaw) - BigInt(value.circulatingRaw);
    // 28.75 BTC on this snapshot. The corridor is wide because the exact figure depends on the
    // height `/q` is pinned to, which cannot be established from inside one vendor — but it must
    // stay small and positive, because it is unclaimed coinbase subsidy and nothing else.
    expect(gapSat).toBeGreaterThan(0n);
    expect(gapSat).toBeLessThan(100_00000000n); // < 100 BTC
  });

  it('carries decimals from consensus, since the registry has none for bitcoin', async () => {
    const { value } = await resolveSupply();
    expect(value.decimals).toBe(8);
    expect(chains.resolve('bitcoin').nativeDecimals).toBeNull();
    expect(value.symbol).toBe('BTC');
    expect(value.source).toBe('blockchain-info');
  });

  it('offers the lossy BTC projections beside the exact strings, not instead of them', async () => {
    const { value } = await resolveSupply();
    expect(value.emissionBtc).toBeCloseTo(20_062_818.75, 2);
    expect(typeof value.emissionRaw).toBe('string');
    // The exact value is the string; the projection is allowed to lose precision, the string is not.
    expect(BigInt(value.emissionRaw)).toBe(2006281875000000n);
  });

  it('does not leak vendor fields outside the contract', async () => {
    const { value } = await resolveSupply();
    // `/stats` also carries market_price_usd, trade_volume_usd and friends. None of them is part of
    // this capability, and a strict schema is what keeps them out.
    expect(Object.keys(value).sort()).toEqual(
      [
        'blockCount',
        'chain',
        'circulatingBtc',
        'circulatingRaw',
        'decimals',
        'emissionBtc',
        'emissionRaw',
        'fetchedAt',
        'source',
        'symbol',
      ].sort(),
    );
  });
});

describe('blockchain-info adapter — refuses what it cannot stand behind (R-84c, R-85c)', () => {
  it('refuses when circulating exceeds emission, which consensus forbids', async () => {
    // One satoshi over. The invariant is not a plausibility heuristic — you cannot claim more than
    // the subsidy — so even a minimal violation means one of the two numbers is wrong, and we do
    // not know which.
    const over = String(BigInt(STATS['totalbc'] as number) + 1n);
    await expect(resolveSupply({ circulating: over })).rejects.toThrow(/consensus forbids/);
  });

  it("refuses when the vendor's own totalbc disagrees with its own block count", async () => {
    const tampered = { ...STATS, totalbc: (STATS['totalbc'] as number) + 312_500_000 };
    await expect(resolveSupply({ stats: tampered })).rejects.toThrow(/halving schedule/);
  });

  it('names the disagreement in BLOCKS of subsidy, not as a percentage', async () => {
    const tampered = { ...STATS, totalbc: (STATS['totalbc'] as number) + 3 * 312_500_000 };
    // A percentage would render this as 0.000047% — indistinguishable from rounding, which is the
    // entire reason this unit was chosen.
    await expect(resolveSupply({ stats: tampered })).rejects.toThrow(/by 3 block subsidy/);
  });

  it.each([
    ['an empty body', ''],
    ['an HTML error page', '<html><body>error</body></html>'],
    ['a fractional value', '2006279000000000.5'],
    ['a signed value', '-2006279000000000'],
    ['a value with separators', '2,006,279,000,000,000'],
  ])('refuses %s from the text/plain surface', async (_label, body) => {
    // `text/plain` means an error page arrives looking exactly like data. Only ^\d+$ is data.
    await expect(resolveSupply({ circulating: body })).rejects.toThrow(/plain integer/);
  });

  it.each([
    ['a missing field', { ...STATS, totalbc: undefined }],
    ['a string where a number belongs', { ...STATS, totalbc: '2006281875000000' }],
    ['a fractional block count', { ...STATS, n_blocks_total: 960_102.5 }],
    ['a negative value', { ...STATS, totalbc: -1 }],
  ])('refuses %s in /stats', async (_label, stats) => {
    await expect(resolveSupply({ stats })).rejects.toThrow(/safe integer/);
  });

  it('refuses a /stats body that is not an object at all', async () => {
    await expect(resolveSupply({ stats: [1, 2, 3] })).rejects.toThrow(/expected an object/);
  });

  it('describes an offending value instead of quoting it back', async () => {
    // R-68e: this message travels into `tried[].reason`, then the tool's isError text, then model
    // context — and it is negative-cached, so it replays for the whole negative TTL.
    const hostile = 'x'.repeat(500);
    await expect(resolveSupply({ circulating: hostile })).rejects.toThrow(/string\(length=500\)/);
    await expect(resolveSupply({ circulating: hostile })).rejects.not.toThrow(/xxxx/);
  });
});

describe('blockchain-info adapter — transport (R-81b)', () => {
  it('refuses a chain it does not serve', async () => {
    const { adapter } = build();
    await expect(adapter.fetch('chain.supply', { chain: 'ethereum' })).rejects.toThrow(
      /serves bitcoin only/,
    );
  });

  it('refuses a capability it does not declare', async () => {
    const { adapter } = build();
    await expect(adapter.fetch('token.price', { chain: 'bitcoin' })).rejects.toThrow(
      /unsupported capability/,
    );
  });

  it('names the host, never a URL, when the transport fails', async () => {
    const failing = createBlockchainInfoAdapter({
      chains,
      throttle: () => Promise.resolve(),
      fetchImpl: (() => Promise.reject(new TypeError('socket hang up'))) as unknown as typeof fetch,
    });
    await expect(failing.fetch('chain.supply', { chain: 'bitcoin' })).rejects.toThrow(
      /transport failure from blockchain\.info \(TypeError\)/,
    );
  });

  it('surfaces an HTTP status without echoing the body', async () => {
    const { adapter } = build({ statsStatus: 503 });
    await expect(adapter.fetch('chain.supply', { chain: 'bitcoin' })).rejects.toThrow(
      /HTTP 503 from blockchain\.info/,
    );
  });

  it('sends no credential of any kind — there is none to send', async () => {
    const { urls } = await resolveSupply();
    for (const url of urls) {
      expect(url).not.toMatch(/apikey|api_key|key=|token=/i);
    }
  });
});
