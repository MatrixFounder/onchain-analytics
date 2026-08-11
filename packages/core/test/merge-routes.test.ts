import { describe, expect, it } from 'vitest';
import { CapabilityRegistry } from '../src/adapters/registry.js';
import type { CapabilityRoute, ProviderAdapter } from '../src/adapters/types.js';
import { routes } from '../src/providers.config.js';
import { createPlatformExplorerAdapter } from '../src/adapters/platform-explorer/index.js';
import { createPgHistoryAdapter } from '../src/adapters/pg-history/index.js';
import type { PgPoolLike } from '../src/pg/read-client.js';
import { isolatedThrottle } from './helpers/isolated-throttle.js';
import { DASH_METRIC, DASH_PLATFORM_ASSET } from '../src/adapters/dash-metrics.js';
import { capabilityManifests } from '../src/capability-manifest.js';
import type { Snapshot } from '../src/types/snapshot.js';
import identitiesHistoryFixture from './fixtures/platform-explorer/identities-history.json' with { type: 'json' };
import shieldHistoryFixture from './fixtures/platform-explorer/shield-history.json' with { type: 'json' };

/**
 * Task 013-6 (T-013, R-168/R-169) — merge ACTIVATED on the two real D6 routes, and the six other
 * multi-adapter routes proved untouched.
 *
 * **On the REAL configuration, not a hand-rolled route table** — the `registry.fallback.test.ts`
 * precedent, and for its reason: this task's whole claim is about `providers.config.ts`, so a test
 * that builds its own routes would be asserting about a table nobody ships. `routes` is imported
 * from the shipped module and the manifests are the shipped ones; only the two network boundaries
 * are faked (platform-explorer's `fetchImpl`, pg-history's `PoolCtor`), per R-21.
 *
 * **Methodology.** `tdd-stub-first` (PLAN §0.9 puts the strict cycle on 013-1/013-4/013-5, not
 * here) — and the Phase-1 red run was genuinely available for this task and was executed: with
 * `merge: true` absent from both routes, TC-INT-01 and TC-INT-02 fail on the shipped table, because
 * the single-winner walk returns `platform-explorer`'s answer alone and never asks `pg-history`.
 * The captured failure is in `packages/core/.AGENTS.md` under `## T-013 task 013-6`.
 */

const FIXED_NOW = 1_700_000_000_000;
const DASH_ARGS = { chain: 'dash' } as const;

/** The hour both participants really overlap on. `identities_total` is the ONLY metric BOTH write
 * for `platform.metrics.history` (`docs/TASK.md` §1.3), and the fixture's first three points all
 * land in this bucket. */
const OVERLAP_TS = Date.parse('2026-07-22T21:09:33.699Z');
/** A DIFFERENT millisecond inside the SAME hour — the composition R-161(e) exists for. The two
 * participants read two different clocks (the vendor's own history label vs. the snapshotter's
 * wall clock), so equality to the millisecond would be a coincidence; equality of the HOUR is the
 * property the key is built on. A row at the identical `ts` would prove nothing about bucketing. */
const OVERLAP_TS_OTHER_MS = OVERLAP_TS + 47_000;

interface FakeRow {
  ts: string;
  asset: string;
  metric: string;
  value_raw: string;
  value_num: number | null;
  source: string;
  height: string | null;
}

function pgRow(metric: string, ts: number, valueRaw: string): FakeRow {
  return {
    ts: String(ts),
    asset: DASH_PLATFORM_ASSET,
    metric,
    value_raw: valueRaw,
    value_num: null,
    source: 'pg-history-fixture',
    height: null,
  };
}

function makePoolCtor(rows: FakeRow[]): new (config: { connectionString: string }) => PgPoolLike {
  return class FakePool implements PgPoolLike {
    async query(): Promise<{ rows: unknown[] }> {
      return { rows };
    }
    on(): this {
      return this;
    }
  } as unknown as new (config: { connectionString: string }) => PgPoolLike;
}

function buildRegistry(opts: {
  explorerBody: unknown;
  pgRows: FakeRow[];
  routeTable?: CapabilityRoute[];
}): CapabilityRegistry {
  const adapters = new Map<string, ProviderAdapter>([
    [
      'platform-explorer',
      createPlatformExplorerAdapter({
        fetchImpl: async () => new Response(JSON.stringify(opts.explorerBody), { status: 200 }),
        now: () => FIXED_NOW,
        throttle: isolatedThrottle(FIXED_NOW),
      }),
    ],
    [
      'pg-history',
      createPgHistoryAdapter({
        env: { ONCHAIN_PG_URL: 'postgres://u:p@db.internal:5432/postgres' },
        poolCtor: makePoolCtor(opts.pgRows),
        throttle: isolatedThrottle(FIXED_NOW),
      }),
    ],
  ]);
  return new CapabilityRegistry(opts.routeTable ?? routes, adapters);
}

function metricsOf(result: unknown): string[] {
  return (result as Snapshot[]).map((snapshot) => snapshot.metric);
}

// =================================================================================================
// TC-INT-01 / TC-INT-02 — the two activated routes
// =================================================================================================

describe('TC-INT-01 — platform.metrics.history merges: three pg-history-only metrics beside a rank-resolved identities_total', () => {
  it('keeps every metric only pg-history writes, and resolves the overlapping one by rank (AC-43, UC-11)', async () => {
    const pgRows = [
      // The genuine overlap: same metric, same asset, same HOUR, different millisecond and a
      // different value — so a surviving duplicate or the wrong winner are both visible.
      pgRow(DASH_METRIC.identitiesTotal, OVERLAP_TS_OTHER_MS, '999999'),
      pgRow(DASH_METRIC.documentsTotal, OVERLAP_TS, '17586'),
      pgRow(DASH_METRIC.dataContractsTotal, OVERLAP_TS, '59'),
      pgRow(DASH_METRIC.platformTotalCredits, OVERLAP_TS, '2802452583638438'),
    ];
    const registry = buildRegistry({ explorerBody: identitiesHistoryFixture.raw, pgRows });

    const resolution = await registry.resolve('platform.metrics.history', 'dash', DASH_ARGS);

    const metrics = new Set(metricsOf(resolution.result));
    // The three that exist ONLY in our own ledger — the gap-filling argument of D6, and the thing
    // a merge that silently kept one participant's answer would drop.
    expect(metrics).toContain(DASH_METRIC.documentsTotal);
    expect(metrics).toContain(DASH_METRIC.dataContractsTotal);
    expect(metrics).toContain(DASH_METRIC.platformTotalCredits);
    expect(metrics).toContain(DASH_METRIC.identitiesTotal);

    // Both participants contributed — the statement that this is a MERGE and not a fallback.
    expect(resolution.sources).toEqual(['platform-explorer', 'pg-history']);

    // ---------------------------------------------------------------------------------------
    // POINT COUNTS — the assertions this file did NOT have, and whose absence let a 12 → 2
    // regression pass a green suite (owner decision 2026-08-09; see the file docstring).
    // ---------------------------------------------------------------------------------------

    // 1. platform-explorer keeps its OWN sampling resolution. Its history is one point every ~5
    //    minutes, so ELEVEN of these twelve share an hour with a sibling — under the previous
    //    within-participant collapse this number was 2, for the whole fixture.
    const explorerPoints = (resolution.result as Snapshot[]).filter(
      (snapshot) => snapshot.source === 'platform-explorer',
    );
    expect(explorerPoints).toHaveLength(identitiesHistoryFixture.raw.length);

    // 2. The conflict is still resolved across participants: pg-history's identities_total falls in
    //    an hour platform-explorer already filled, so it contributes NOTHING there. Asserted on the
    //    value, because that is what a wrong winner would change.
    const merged = resolution.result as Snapshot[];
    expect(merged.map((snapshot) => snapshot.valueRaw)).not.toContain('999999');

    // 3. …and pg-history still contributes the three metrics nobody else writes. Three, not four:
    //    its identities_total row was suppressed by (2).
    const fromPg = merged.filter((snapshot) => snapshot.source === 'pg-history-fixture');
    expect(fromPg.map((snapshot) => snapshot.metric).sort()).toStrictEqual(
      [
        DASH_METRIC.dataContractsTotal,
        DASH_METRIC.documentsTotal,
        DASH_METRIC.platformTotalCredits,
      ].sort(),
    );

    // 4. The whole series, stated as one number so a future change to any of the three rules above
    //    has to come here and say what it did.
    expect(merged).toHaveLength(identitiesHistoryFixture.raw.length + 3);
  });
});

describe('TC-INT-02 — privacy.shielded_pool.history merges: two different metrics, both present, neither renamed', () => {
  it('carries shield_amount and balance_credits side by side — the key never collides, so no dedup and no conflict (AC-32, UC-18)', async () => {
    const pgRows = [
      // Deliberately the SAME hour as the explorer's first point. Under a key that ignored `metric`
      // one of these two would disappear; under the real triple both survive, and that is the
      // difference between "partial coverage published as full" and the truth.
      pgRow(DASH_METRIC.shieldedPoolBalanceCredits, OVERLAP_TS_OTHER_MS, '4611474006200'),
    ];
    const registry = buildRegistry({ explorerBody: shieldHistoryFixture.raw, pgRows });

    const resolution = await registry.resolve('privacy.shielded_pool.history', 'dash', DASH_ARGS);

    const metrics = new Set(metricsOf(resolution.result));
    expect(metrics).toContain(DASH_METRIC.shieldedPoolShieldAmount);
    expect(metrics).toContain(DASH_METRIC.shieldedPoolBalanceCredits);
    // Exactly two distinct labels — not one collapsed into the other, and not a third invented.
    expect(metrics.size).toBe(2);
    expect(resolution.sources).toEqual(['platform-explorer', 'pg-history']);

    // Both survive at the same hour: the proof that dedup did NOT fire between them.
    const overlapHour = Math.floor(OVERLAP_TS / 3_600_000);
    const atOverlap = (resolution.result as Snapshot[]).filter(
      (snapshot) => Math.floor(snapshot.ts / 3_600_000) === overlapHour,
    );
    expect(new Set(atOverlap.map((snapshot) => snapshot.metric)).size).toBe(2);

    // POINT COUNTS (owner decision 2026-08-09) — this route is where the previous rule was purely
    // destructive: the two participants write DIFFERENT metrics, so no slot was ever contested and
    // every point the hour collapsed was one participant's own. Explorer's full series plus
    // pg-history's single row, with nothing suppressed anywhere.
    const merged = resolution.result as Snapshot[];
    expect(merged.filter((snapshot) => snapshot.source === 'platform-explorer')).toHaveLength(
      shieldHistoryFixture.raw.length,
    );
    expect(merged).toHaveLength(shieldHistoryFixture.raw.length + 1);
  });
});

// =================================================================================================
// TC-INT-03 / TC-INT-04 / TC-INT-05 — everything that must NOT change
// =================================================================================================

describe('TC-INT-03 — the seven other multi-adapter routes get neither eligibility nor activation', () => {
  /** The seven, named rather than computed, so that a route SILENTLY acquiring a second adapter does
   * not silently join the set this case vouches for. WI-51 added `gas.price` deliberately: a second
   * adapter there is the point (L-6's lesson), and it is NOT merge-eligible — a node's exact wei and
   * an indexer's rounded Gwei are two answers to one question, and merging them would have to pick
   * one or invent a third. */
  const OTHER_MULTI_ADAPTER = [
    'entity.labels',
    'gas.price',
    'privacy.shielded_pool',
    'platform.identities',
    'platform.contracts',
    'platform.documents',
    'platform.credits',
  ] as const;

  it('finds exactly seven other multi-adapter routes, and none of them carries merge', () => {
    const multi = routes.filter((route) => route.adapterIds.length > 1);
    const merged = multi.filter((route) => route.merge === true).map((route) => route.capability);
    const notMerged = multi
      .filter((route) => route.merge !== true)
      .map((route) => route.capability);

    expect(merged.sort()).toEqual(['platform.metrics.history', 'privacy.shielded_pool.history']);
    expect(notMerged.sort()).toEqual([...OTHER_MULTI_ADAPTER].sort());
  });

  it('the five point-shaped ones cannot even DECLARE eligibility — the manifest branch has no such field', () => {
    // R-168(a): the five `point` routes are protected by COMPILATION, not by vigilance. The
    // runtime half of that statement is asserted here; the compile-time half is `capability-
    // manifest.test.ts`'s negative type-test (013-1), which is where a type claim belongs.
    for (const capability of OTHER_MULTI_ADAPTER.slice(1)) {
      const manifest = capabilityManifests[capability];
      expect(manifest, capability).toBeDefined();
      expect(manifest!.shape, capability).toBe('point');
      expect('mergeable' in manifest!, capability).toBe(false);
    }
  });

  it('entity.labels is set-shaped — eligibility is TYPE-possible there, and deliberately not declared', () => {
    // The one route where R-168(a)'s protection is a DECISION rather than a compile error, so it
    // is the one worth asserting on its own: `set` branch, no `mergeable`, merge waits for T-016.
    const manifest = capabilityManifests['entity.labels'];
    expect(manifest?.shape).toBe('set');
    expect('mergeable' in manifest!).toBe(false);
  });
});

describe('TC-INT-04 — activating merge without declared eligibility drops the build (UC-20)', () => {
  it('rejects a route table that turns merge on for entity.labels, naming the capability', () => {
    const badTable: CapabilityRoute[] = [
      { capability: 'entity.labels', adapterIds: ['blockscout', 'nansen'], merge: true },
    ];

    expect(() => buildRegistry({ explorerBody: [], pgRows: [], routeTable: badTable })).toThrow(
      /entity\.labels/,
    );
  });
});

describe('TC-INT-05 — the single-adapter capabilities are untouched', () => {
  it('every single-adapter route goes through the non-merge walk, because none of them carries merge', () => {
    const single = routes.filter((route) => route.adapterIds.length === 1);
    expect(single.every((route) => route.merge === undefined)).toBe(true);
    // Named as a count so that ADDING a single-adapter route is a decision someone makes here,
    // rather than something this case absorbs silently. 26 routes, 2 merged, 7 other multi-adapter
    // (WI-51 added `gas.price` with two adapters and `chain.transactions` with one).
    expect(single).toHaveLength(routes.length - 9);
  });
});
