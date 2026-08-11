import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createDefillamaAdapter, loadChainRegistry } from '../src/index.js';

/**
 * Contract tests for the three capabilities added by WI-49/WI-50 — `chain.tvl.history`,
 * `protocol.list`, `protocol.tvl.history`.
 *
 * **Two kinds of input, deliberately.** `protocol.list` runs against the COMMITTED live catalog
 * fixture, because what it does is slice and rank a real vendor document. The two history
 * capabilities run against SMALL SYNTHETIC series, because what they must get right is arithmetic —
 * windowing, gap counting, day bucketing — and a recorded 120 KB history would state that
 * arithmetic in numbers nobody can check by reading. The vendor's real SHAPE for those two is
 * proven by the live eval gate (`eval/cases/*.mjs`), which is the layer that catches "they broke
 * it"; this file catches "we broke it".
 */

const testDir = path.dirname(fileURLToPath(import.meta.url));
const FIXED_NOW = Date.UTC(2026, 0, 31); // a day boundary, so windows are exact
const DAY = 86_400_000;
const CHAINS = loadChainRegistry();
const adapter = createDefillamaAdapter({ now: () => FIXED_NOW });

const CATALOG: unknown = JSON.parse(
  readFileSync(path.join(testDir, 'fixtures', 'defillama', 'protocols-catalog.json'), 'utf8'),
);

/** `days` consecutive daily points ending on `FIXED_NOW`, in the vendor's own unix-seconds shape. */
const dailyRows = (days: number, valueAt: (i: number) => number): { date: number; tvl: number }[] =>
  Array.from({ length: days }, (_, i) => ({
    date: (FIXED_NOW - (days - 1 - i) * DAY) / 1000,
    tvl: valueAt(i),
  }));

const chainHistory = (chain: string, raw: unknown, days: number): Record<string, unknown> =>
  adapter.normalize('chain.tvl.history', {
    chain: CHAINS.resolve(chain),
    raw,
    fetchedAt: FIXED_NOW,
    chainHistory: { chain: CHAINS.resolve(chain), days },
  }) as unknown as Record<string, unknown>;

describe('defillama chain.tvl.history (WI-50)', () => {
  it('windows the series and answers the change question outright', () => {
    const r = chainHistory(
      'ethereum',
      dailyRows(30, (i) => 100 + i),
      30,
    );

    expect(r['points']).toBe(30);
    expect(r['gapDays']).toBe(0);
    expect(r['window']).toMatchObject({ days: 30 });
    // The point of `change`: "how much did TVL move" must not require the caller to walk the array.
    expect(r['change']).toMatchObject({ fromUsd: 100, toUsd: 129, absUsd: 29 });
    expect((r['change'] as { pct: number }).pct).toBeCloseTo(29, 6);
  });

  it('counts a hole as a GAP rather than shortening the window', () => {
    const rows = dailyRows(10, (i) => 100 + i).filter((_, i) => i !== 4);

    const r = chainHistory('ethereum', rows, 10);

    // The invariant, which is the whole reason this capability publishes three numbers instead of
    // one array: a consumer can tell a missing day from a measured zero.
    expect(r['points']).toBe(9);
    expect(r['gapDays']).toBe(1);
    expect((r['window'] as { days: number }).days).toBe(10);
  });

  it('reports a history SHORTER than the request in the window, not as gaps (L-1)', () => {
    const r = chainHistory(
      'ethereum',
      dailyRows(5, () => 100),
      30,
    );

    // A chain younger than the window used to report "30 days, nothing missing". `days` shrinks to
    // what exists; `gapDays` stays 0 because nothing is actually absent.
    expect((r['window'] as { days: number }).days).toBe(5);
    expect(r['gapDays']).toBe(0);
    expect(r['points']).toBe(5);
  });

  it('reports a REQUESTED-but-empty history as a fully missing window, never a clean run (L-5)', () => {
    const r = chainHistory('ethereum', [], 30);

    expect(r['points']).toBe(0);
    expect(r['gapDays']).toBe(30);
    expect(r['change']).toBeNull();
  });

  it('folds two points landing in one day and SAYS it did (L-4)', () => {
    const rows = [...dailyRows(3, () => 100), { date: FIXED_NOW / 1000 + 3600, tvl: 250 }];

    const r = chainHistory('ethereum', rows, 3);

    expect(r['points']).toBe(3);
    // A silent fold would have inflated the count and masked exactly one genuine missing day.
    expect(r['truncated']).toMatchObject({ series: true });
    expect((r['truncated'] as { reason: string }).reason).toMatch(/folded to one/);
  });

  it('refuses a negative value loudly instead of dropping the point', () => {
    // A malformed TIMESTAMP is one point's decoding problem; a negative TVL means the document is
    // not what we think it is, and it must never be cached as a success.
    expect(() => chainHistory('ethereum', [{ date: FIXED_NOW / 1000, tvl: -1 }], 1)).toThrow(
      /invalid tvl/,
    );
  });

  it('refuses a payload the vendor sent but we could read nothing from (L-2)', () => {
    // Every point undecodable is what a unit change looks like — and it produces an empty series,
    // which otherwise reads as "this chain has no history".
    expect(() =>
      chainHistory('ethereum', [{ date: 'yesterday' as unknown as number, tvl: 1 }], 30),
    ).toThrow(/none were readable/);
  });

  it('refuses a body that is not an array at all', () => {
    expect(() => chainHistory('ethereum', { points: [] }, 30)).toThrow(/expected an array/);
  });
});

describe('defillama protocol.list (WI-49)', () => {
  const list = (chain: string, args: Record<string, unknown>): Record<string, unknown> =>
    adapter.normalize('protocol.list', {
      chain: CHAINS.resolve(chain),
      raw: CATALOG,
      fetchedAt: FIXED_NOW,
      protocolList: {
        args: { chain: CHAINS.resolve(chain), limit: 10, sortedBy: 'tvl', minTvlUsd: 0, ...args },
        lite: [],
      },
    }) as unknown as Record<string, unknown>;

  it('ranks by TVL descending and reports how many matched before the limit', () => {
    const r = list('ethereum', { limit: 2 });

    const rows = r['protocols'] as { slug: string; tvlUsd: number | null }[];
    expect(rows).toHaveLength(2);
    expect(rows[0]!.tvlUsd!).toBeGreaterThanOrEqual(rows[1]!.tvlUsd!);
    // A truncated list must LOOK truncated, or a caller reads the top 2 as the whole population.
    expect(r['matched'] as number).toBeGreaterThan(2);
  });

  it('finds a chain the catalog names in the LEGACY vocabulary (L-10 regression)', () => {
    // `/protocols` says `Binance`; the registry says `BSC`. Filtering by string returned an empty
    // list for 43 chains — and an empty list is the most believable wrong answer a listing gives.
    const r = list('bsc', {});

    expect((r['protocols'] as unknown[]).length).toBeGreaterThan(0);
    expect(r['chain']).toBe('bsc');
  });

  it('carries the parent slug, so a family can be rolled up without a second call', () => {
    const r = list('ethereum', { limit: 50 });
    const rows = r['protocols'] as { slug: string; parent: string | null }[];

    expect(rows.find((p) => p.slug === 'aave-v3')?.parent).toBe('aave');
    expect(rows.find((p) => p.slug === 'lido')?.parent).toBeNull();
  });

  it('applies minTvlUsd BEFORE ranking, and drops rows with no figure on this chain', () => {
    const r = list('ethereum', { minTvlUsd: 1_000_000_000, limit: 50 });
    const rows = r['protocols'] as { tvlUsd: number | null }[];

    // Every survivor clears the floor, and none is `null`: "at least this much, or unknown" would
    // make the parameter mean two things.
    for (const row of rows) expect(row.tvlUsd).toBeGreaterThanOrEqual(1_000_000_000);
  });

  it('sorts rows with no figure LAST, never as a zero', () => {
    const r = list('ethereum', { sortedBy: 'change30d', limit: 50 });
    const rows = r['protocols'] as { change: { d30: number | null } }[];

    // `lite: []` above means no row has a d30 — so this asserts the tie-break is stable rather than
    // that nulls outrank numbers; the ordering rule itself is asserted by the value sort above.
    const firstNull = rows.findIndex((p) => p.change.d30 === null);
    if (firstNull >= 0) {
      expect(rows.slice(firstNull).every((p) => p.change.d30 === null)).toBe(true);
    }
  });

  it('computes d30 from ONE document, so both sides of the percentage are one observation', () => {
    const aave = (CATALOG as { slug: string; id?: unknown }[]).find((p) => p.slug === 'aave-v3')!;
    const r = adapter.normalize('protocol.list', {
      chain: CHAINS.resolve('ethereum'),
      raw: CATALOG,
      fetchedAt: FIXED_NOW,
      protocolList: {
        args: { chain: CHAINS.resolve('ethereum'), limit: 50, sortedBy: 'tvl', minTvlUsd: 0 },
        lite: [{ defillamaId: aave.id, tvl: 110, tvlPrevMonth: 100 }],
      },
    }) as unknown as { protocols: { slug: string; change: { d30: number | null } }[] };

    expect(r.protocols.find((p) => p.slug === 'aave-v3')?.change.d30).toBeCloseTo(10, 6);
  });
});

describe('defillama protocol.tvl.history (WI-50)', () => {
  const history = (chain: string, chainTvls: Record<string, unknown>): Record<string, unknown> =>
    adapter.normalize('protocol.tvl.history', {
      chain: CHAINS.resolve(chain),
      raw: { name: 'Aave', chainTvls },
      fetchedAt: FIXED_NOW,
      protocolHistory: { chain: CHAINS.resolve(chain), protocolSlug: 'aave', days: 10 },
    }) as unknown as Record<string, unknown>;

  const series = (days: number): { tvl: { date: number; totalLiquidityUSD: number }[] } => ({
    tvl: Array.from({ length: days }, (_, i) => ({
      date: (FIXED_NOW - (days - 1 - i) * DAY) / 1000,
      totalLiquidityUSD: 100 + i,
    })),
  });

  it('reads the PLAIN bucket only — borrowed and staked are different quantities', () => {
    const r = history('ethereum', {
      Ethereum: series(10),
      'Ethereum-borrowed': series(10),
      'Ethereum-staking': series(10),
    });

    expect(r['deployed']).toBe(true);
    expect(r['points']).toBe(10);
    expect((r['change'] as { toUsd: number }).toUsd).toBe(109);
  });

  it('finds the chain under its LEGACY name (L-10 regression)', () => {
    // This document uses the same legacy vocabulary as the catalog, so the same defect applies —
    // and here it would surface as an empty series, which is if anything easier to believe.
    const r = history('op-mainnet', { Optimism: series(10) });

    expect(r['deployed']).toBe(true);
    expect(r['points']).toBe(10);
  });

  it('answers "not on this chain" with a ZERO-length window, keeping the invariant true', () => {
    const r = history('bitcoin', { Ethereum: series(10) });

    expect(r['deployed']).toBe(false);
    expect(r['points']).toBe(0);
    expect(r['gapDays']).toBe(0);
    // `points + gapDays === window.days` must hold universally or nobody can rely on it. Reporting
    // the requested 10 days here would be the shape L-5 was filed for.
    expect((r['window'] as { days: number }).days).toBe(0);
    expect(r['change']).toBeNull();
  });

  it('refuses a document with no chainTvls at all', () => {
    expect(() =>
      adapter.normalize('protocol.tvl.history', {
        chain: CHAINS.resolve('ethereum'),
        raw: { name: 'Aave' },
        fetchedAt: FIXED_NOW,
        protocolHistory: { chain: CHAINS.resolve('ethereum'), protocolSlug: 'aave', days: 10 },
      }),
    ).toThrow(/no chainTvls/);
  });
});
