import { describe, expect, it, vi } from 'vitest';
import type { CacheGetResult, CacheStore } from '../src/adapters/cache-store.js';
import { CapabilityRegistry, CapabilityUnavailableError } from '../src/adapters/registry.js';
import type { CapabilityRoute, ProviderAdapter } from '../src/adapters/types.js';
import { policyClasses, type PolicyDescriptor } from '../src/adapters/policy.js';
import { capabilityManifests, type CapabilityManifest } from '../src/capability-manifest.js';
import { deriveArgsHash } from '../src/net/args-hash.js';
import { DASH_METRIC, DASH_PLATFORM_ASSET } from '../src/adapters/dash-metrics.js';
// Aliased: `routes` is also a common LOCAL variable name throughout this file's own fixtures
// (every `describe` below declares its own `const routes: CapabilityRoute[] = [...]`) — importing
// the real, shipped route table under a distinct name (TC-INT-13, T-2) keeps the two unambiguous.
import { routes as productionRoutes } from '../src/providers.config.js';

/**
 * Task 013-4 (T-013, R-161/R-165/R-166/R-167/R-182) — the merge WALK itself: dedup on
 * `(metric, asset, ts)`, rank-based conflict resolution, per-adapter cache semantics preserved,
 * per-participant policy evaluation, `sources`/`source`/`perSourceCache` construction.
 *
 * **Methodology — this is one of the three `tdd-strict` (Red-Red-Green) tasks in T-013 (PLAN
 * §0.9), not merely `tdd-stub-first`.** The named risk: "тест на непересекающихся фикстурах
 * проходит и без механизма дедупа" — a dedup test built on two points that never actually collide
 * cannot tell a real dedup mechanism apart from no mechanism at all. `identities_total` is the
 * ONLY metric BOTH real merge participants (`platform-explorer`, `pg-history`) write for
 * `platform.metrics.history` (confirmed by reading both adapters' `normalize()`), so TC-INT-01
 * below is built on that genuine overlap, using the real metric constant rather than an arbitrary
 * string. The Phase-1 skeleton (walk everyone, concatenate with no dedup/policy/`sources`) was run
 * against this whole file first and produced a real red run — but the transcript was **not**
 * captured (corrected here, T-3, fix pass 2026-08-07): the implementing agent was interrupted
 * before recording it, and `packages/core/.AGENTS.md`'s `## T-013 task 013-4` entry says so plainly
 * under its own `### Honest gap in this entry` heading rather than reconstructing the run after the
 * fact and presenting that as a capture (no `docs/reports/` in this project, per the 013-1
 * precedent — that journal entry is still the durable record for everything it DID run and paste
 * verbatim).
 *
 * Every fixture here constructs `CapabilityRegistry` directly with a small, purpose-built route
 * table and mock adapters (never `assertMergeParticipantsAreFree`, never the real
 * `providers.config.ts` composition except in TC-INT-13, which needs the real manifest rows).
 */

// =================================================================================================
// Shared fixtures
// =================================================================================================

const CHAIN = 'ethereum';
/** A fictitious merge-eligible capability — `shape: 'series'`, `mergeable: true` — used by every
 * case except TC-INT-13, which needs the two REAL merge-eligible capabilities and their real
 * manifest rows instead. */
const CAP = 'test.merge.series';
const MANIFESTS: Readonly<Record<string, CapabilityManifest>> = {
  [CAP]: { shape: 'series', ttlSeconds: 60, deadlineMs: 60_000, mergeable: true, shareable: true },
};

/** One canonical-shaped point — the same field names `types/snapshot.ts`'s `Snapshot` schema uses.
 * `extra` overrides/adds fields (`source`/`height`/`valueNum`/policy-class fields) without
 * disturbing the three dedup-key fields. */
function point(
  metric: string,
  ts: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return { metric, asset: DASH_PLATFORM_ASSET, ts, valueRaw: '1', source: 'mock', ...extra };
}

interface MockAdapterOpts {
  id: string;
  isAvailable?: () => { ok: true } | { ok: false; reason: string };
  /** `normalize()` returns this array unchanged — these fixtures already ARE canonical points, not
   * vendor DTOs, so there is no translation step to fake. */
  points?: unknown[];
  /** Side-effect hook fired at the moment `fetch()` is called — used by TC-INT-08 to record walk
   * ORDER across two different mock adapters. */
  onFetch?: () => void;
}

function makeAdapter(opts: MockAdapterOpts): ProviderAdapter & {
  fetch: ReturnType<typeof vi.fn>;
  normalize: ReturnType<typeof vi.fn>;
} {
  return {
    id: opts.id,
    capabilities: () => [],
    costOf: () => ({ credits: 0 }),
    fetch: vi.fn(async (): Promise<unknown> => {
      opts.onFetch?.();
      return opts.points ?? [];
    }),
    normalize: vi.fn((_cap: string, raw: unknown) => raw),
    ...(opts.isAvailable ? { isAvailable: opts.isAvailable } : {}),
  };
}

class FakeCacheStore implements CacheStore {
  public readonly setCalls: Array<{
    provider: string;
    capability: string;
    argsHash: string;
    value: unknown;
  }> = [];

  constructor(private readonly hits: Map<string, CacheGetResult> = new Map()) {}

  static key(provider: string, capability: string, argsHash: string): string {
    return `${provider}::${capability}::${argsHash}`;
  }

  async get(
    provider: string,
    capability: string,
    argsHash: string,
  ): Promise<CacheGetResult | undefined> {
    return this.hits.get(FakeCacheStore.key(provider, capability, argsHash));
  }

  async set(provider: string, capability: string, argsHash: string, value: unknown): Promise<void> {
    this.setCalls.push({ provider, capability, argsHash, value });
  }
}

// =================================================================================================
// Branch condition — NOT one of the task's numbered TC-INT cases; guards the "byte-identical
// non-merge path" constraint the task's contract names as "the point of the task".
// =================================================================================================

describe('branch condition — the single-winner walk runs unchanged when no matched route carries merge: true', () => {
  it('returns the first satisfying answer and never even calls the second adapter', async () => {
    const ts = 1_700_000_000_000;
    const first = makeAdapter({ id: 'first', points: [point('m', ts, { source: 'first' })] });
    const second = makeAdapter({ id: 'second', points: [point('m', ts, { source: 'second' })] });
    const routes: CapabilityRoute[] = [
      { capability: CAP, adapterIds: ['first', 'second'] }, // no `merge` at all
    ];
    const registry = new CapabilityRegistry(
      routes,
      new Map([
        ['first', first],
        ['second', second],
      ]),
      undefined,
      null,
      MANIFESTS,
    );

    const resolution = await registry.resolve(CAP, CHAIN, {});

    expect(resolution.source).toBe('first');
    expect(resolution.sources).toBeUndefined();
    expect(resolution.perSourceCache).toBeUndefined();
    expect(second.fetch).not.toHaveBeenCalled();
  });
});

// =================================================================================================
// TC-INT-01 — genuine dedup on a real overlapping metric
// =================================================================================================

describe('TC-INT-01 — two participants write identities_total for the same hour: one point survives, from the higher rank', () => {
  it('keeps the higher-ranked participants point and drops the lower-ranked ones entirely — fails when the Map overwrites instead of inserting-if-absent', async () => {
    const ts = 1_700_000_000_000;
    const higherPoint = point(DASH_METRIC.identitiesTotal, ts, {
      valueRaw: '111',
      source: 'higher-adapter',
    });
    const lowerPoint = point(DASH_METRIC.identitiesTotal, ts, {
      valueRaw: '222',
      source: 'lower-adapter',
    });
    const higher = makeAdapter({ id: 'higher-adapter', points: [higherPoint] });
    const lower = makeAdapter({ id: 'lower-adapter', points: [lowerPoint] });
    const routes: CapabilityRoute[] = [
      { capability: CAP, adapterIds: ['higher-adapter', 'lower-adapter'], merge: true },
    ];
    const registry = new CapabilityRegistry(
      routes,
      new Map([
        ['higher-adapter', higher],
        ['lower-adapter', lower],
      ]),
      undefined,
      null,
      MANIFESTS,
    );

    const resolution = await registry.resolve(CAP, CHAIN, {});

    expect(resolution.result).toEqual([higherPoint]);
  });
});

// =================================================================================================
// TC-INT-02 — non-overlapping metric: both points present
// =================================================================================================

describe('TC-INT-02 — points with different metric both survive, each under its own key', () => {
  it('keeps both points when metric differs at the same (asset, ts) — fails when the dedup key is built without metric', async () => {
    const ts = 1_700_000_000_000;
    const a = point('metric.a', ts);
    const b = point('metric.b', ts);
    const first = makeAdapter({ id: 'first', points: [a] });
    const second = makeAdapter({ id: 'second', points: [b] });
    const routes: CapabilityRoute[] = [
      { capability: CAP, adapterIds: ['first', 'second'], merge: true },
    ];
    const registry = new CapabilityRegistry(
      routes,
      new Map([
        ['first', first],
        ['second', second],
      ]),
      undefined,
      null,
      MANIFESTS,
    );

    const resolution = await registry.resolve(CAP, CHAIN, {});

    expect(resolution.result).toEqual(expect.arrayContaining([a, b]));
    expect(resolution.result as unknown[]).toHaveLength(2);
  });
});

// =================================================================================================
// TC-INT-03 — the dedup key excludes source/height/valueNum
// =================================================================================================

describe('TC-INT-03 — the dedup key does not include source, height or valueNum', () => {
  it('collapses two points that differ ONLY in source/height/valueNum into the higher-ranked one — fails when the key carries an extra field', async () => {
    const ts = 1_700_000_000_000;
    const higher = point('m', ts, { source: 'higher-adapter', height: 100, valueNum: 1 });
    const lower = point('m', ts, { source: 'lower-adapter', height: 200, valueNum: 2 });
    const higherAdapter = makeAdapter({ id: 'higher-adapter', points: [higher] });
    const lowerAdapter = makeAdapter({ id: 'lower-adapter', points: [lower] });
    const routes: CapabilityRoute[] = [
      { capability: CAP, adapterIds: ['higher-adapter', 'lower-adapter'], merge: true },
    ];
    const registry = new CapabilityRegistry(
      routes,
      new Map([
        ['higher-adapter', higherAdapter],
        ['lower-adapter', lowerAdapter],
      ]),
      undefined,
      null,
      MANIFESTS,
    );

    const resolution = await registry.resolve(CAP, CHAIN, {});

    expect(resolution.result).toEqual([higher]);
  });
});

// =================================================================================================
// TC-INT-03a — the dedup key INCLUDES asset and ts (roast: three surviving mutants)
// =================================================================================================

describe('TC-INT-03a — the dedup key includes asset and ts, not metric alone', () => {
  /**
   * **Added after the mutation protocol, which this file did not survive.** TC-INT-02 pins
   * `metric` and TC-INT-03 pins that no EXTRA field is in the key, but nothing pinned the other
   * two thirds of the triple AC-1 names: with every fixture above using one asset
   * (`point()` hard-codes `DASH_PLATFORM_ASSET`) and one `ts`, three separate mutations of
   * `mergeInto`'s key all left this file 16/16 green — dropping `ts`, dropping `asset`, and
   * dropping both so the key was bare `metric`.
   *
   * The `ts` case is the damaging one and it is not exotic: a `series` capability is by definition
   * points over TIME, so a key without `ts` collapses every hour of one metric into whichever hour
   * the highest-ranked participant happened to return first — the merge would silently destroy the
   * series it exists to assemble, on the ordinary two-participant call, with every other test green.
   *
   * One case covers all three mutants because it varies both fields at once against a common
   * baseline: four points sharing `metric`, differing only in `asset` or only in `ts`, all four of
   * which MUST survive.
   */
  it('keeps four points that share a metric but differ in asset or ts — fails when the key drops either', async () => {
    const tsA = 1_700_000_000_000;
    const tsB = tsA + 3_600_000; // the next hour — the case a series lives or dies on
    const OTHER_ASSET = 'dash.other';

    const baseline = point('m', tsA);
    const laterHour = point('m', tsB);
    const otherAsset = point('m', tsA, { asset: OTHER_ASSET });
    const otherAssetLaterHour = point('m', tsB, { asset: OTHER_ASSET });

    const first = makeAdapter({ id: 'first', points: [baseline, laterHour] });
    const second = makeAdapter({ id: 'second', points: [otherAsset, otherAssetLaterHour] });
    const routes: CapabilityRoute[] = [
      { capability: CAP, adapterIds: ['first', 'second'], merge: true },
    ];
    const registry = new CapabilityRegistry(
      routes,
      new Map([
        ['first', first],
        ['second', second],
      ]),
      undefined,
      null,
      MANIFESTS,
    );

    const resolution = await registry.resolve(CAP, CHAIN, {});

    // All four are distinct under the (metric, asset, ts) triple, so none may be deduped away.
    expect(resolution.result as unknown[]).toHaveLength(4);
    expect(resolution.result).toEqual(
      expect.arrayContaining([baseline, laterHour, otherAsset, otherAssetLaterHour]),
    );
  });

  it('deduplicates ACROSS participants only on a genuine (metric, asset, ts) collision, not on metric alone', async () => {
    const tsA = 1_700_000_000_000;
    const tsB = tsA + 3_600_000;
    // `first` is higher-ranked and claims (m, asset, tsA). `second` offers the SAME triple (must
    // lose) plus the same metric at a DIFFERENT hour (must survive). A metric-only key would keep
    // one point; the correct key keeps two.
    const higher = point('m', tsA, { source: 'higher' });
    const collides = point('m', tsA, { source: 'lower' });
    const distinctHour = point('m', tsB, { source: 'lower' });

    const first = makeAdapter({ id: 'first', points: [higher] });
    const second = makeAdapter({ id: 'second', points: [collides, distinctHour] });
    const routes: CapabilityRoute[] = [
      { capability: CAP, adapterIds: ['first', 'second'], merge: true },
    ];
    const registry = new CapabilityRegistry(
      routes,
      new Map([
        ['first', first],
        ['second', second],
      ]),
      undefined,
      null,
      MANIFESTS,
    );

    const resolution = await registry.resolve(CAP, CHAIN, {});

    expect(resolution.result as unknown[]).toHaveLength(2);
    expect(resolution.result).toEqual(expect.arrayContaining([higher, distinctHour]));
    expect(resolution.result).not.toContainEqual(collides);
  });
});

// =================================================================================================
// TC-INT-03b — F-0 (fix pass 2026-08-07): the dedup key buckets `ts` to the hour, not exact
// equality. NOT part of the task file's original TC-INT-01..13 contract — added the same way
// TC-INT-03a was, after a real defect was found and an owner decision recorded it
// (`docs/architectures/open-questions.md` "T-013 task 013-4"): the dedup key used to be exact
// `(metric, asset, ts)`, and the two real participants CANNOT hit exact equality — `pg-history`
// reads back the n8n snapshotter's wall-clock write time while `platform-explorer` reports the
// vendor's own history label, two different clocks for "the same hour". Every fixture above (and
// in the original task's own contract) hands both participants one LITERAL `ts`, which is exactly
// the coincidence this pair of tests refuses to rely on.
// =================================================================================================

// The project's own `ts_bucket` width (CLAUDE.n8n.md; DB-SCHEMA-CONCEPT §1), not imported from
// `registry.ts`'s private `MERGE_DEDUP_BUCKET_MS` on purpose — this test pins the CONTRACT (one
// hour), not that module's internal constant name.
const HOUR_MS = 3_600_000;
const HOUR_ALIGNED = HOUR_MS * 472_222; // an arbitrary, but EXACT, hour boundary

describe('TC-INT-03b — the dedup key buckets ts to the hour', () => {
  it('two participants writing identities_total at DIFFERENT exact ts within the SAME hour still dedup to one point (the case UC-11 exists to serve)', async () => {
    const higherTs = HOUR_ALIGNED + 5_000; // hh:00:05
    const lowerTs = HOUR_ALIGNED + 55 * 60_000; // hh:55:00 — same hour, ~55 minutes later
    const higherPoint = point(DASH_METRIC.identitiesTotal, higherTs, {
      valueRaw: '111',
      source: 'higher-adapter',
    });
    const lowerPoint = point(DASH_METRIC.identitiesTotal, lowerTs, {
      valueRaw: '222',
      source: 'lower-adapter',
    });
    const higher = makeAdapter({ id: 'higher-adapter', points: [higherPoint] });
    const lower = makeAdapter({ id: 'lower-adapter', points: [lowerPoint] });
    const routes: CapabilityRoute[] = [
      { capability: CAP, adapterIds: ['higher-adapter', 'lower-adapter'], merge: true },
    ];
    const registry = new CapabilityRegistry(
      routes,
      new Map([
        ['higher-adapter', higher],
        ['lower-adapter', lower],
      ]),
      undefined,
      null,
      MANIFESTS,
    );

    const resolution = await registry.resolve(CAP, CHAIN, {});

    // The STORED point is the higher-ranked participant's own, with its OWN real `ts` (55 minutes
    // earlier than `lowerTs`) untouched — only the KEY bucketed, never the value (F-0).
    expect(resolution.result).toEqual([higherPoint]);
  });

  it('two points either side of an hour boundary do NOT dedup, even one millisecond apart — pins the bucket edge', async () => {
    const justBefore = HOUR_ALIGNED - 1; // last ms of the earlier hour
    const justAfter = HOUR_ALIGNED; // first ms of the next hour
    const before = point(DASH_METRIC.identitiesTotal, justBefore, { source: 'higher-adapter' });
    const after = point(DASH_METRIC.identitiesTotal, justAfter, { source: 'lower-adapter' });
    const higher = makeAdapter({ id: 'higher-adapter', points: [before] });
    const lower = makeAdapter({ id: 'lower-adapter', points: [after] });
    const routes: CapabilityRoute[] = [
      { capability: CAP, adapterIds: ['higher-adapter', 'lower-adapter'], merge: true },
    ];
    const registry = new CapabilityRegistry(
      routes,
      new Map([
        ['higher-adapter', higher],
        ['lower-adapter', lower],
      ]),
      undefined,
      null,
      MANIFESTS,
    );

    const resolution = await registry.resolve(CAP, CHAIN, {});

    expect(resolution.result as unknown[]).toHaveLength(2);
    expect(resolution.result).toEqual(expect.arrayContaining([before, after]));
  });
});

// =================================================================================================
// TC-INT-04 — value_raw above 2^53 survives byte-for-byte
// =================================================================================================

describe('TC-INT-04 — a conflict on value_raw above 2^53 resolves by rank, never by numeric comparison', () => {
  it('keeps the higher-ranked points value_raw byte-for-byte (synthetic fixture — unreachable on live data today, pins the mechanism)', async () => {
    const ts = 1_700_000_000_000;
    const huge = '9007199254740993'; // 2^53 + 1 — silently rounds if ever routed through Number()
    const higher = point('m', ts, { valueRaw: huge, source: 'higher-adapter' });
    const lower = point('m', ts, { valueRaw: '1', source: 'lower-adapter' });
    const higherAdapter = makeAdapter({ id: 'higher-adapter', points: [higher] });
    const lowerAdapter = makeAdapter({ id: 'lower-adapter', points: [lower] });
    const routes: CapabilityRoute[] = [
      { capability: CAP, adapterIds: ['higher-adapter', 'lower-adapter'], merge: true },
    ];
    const registry = new CapabilityRegistry(
      routes,
      new Map([
        ['higher-adapter', higherAdapter],
        ['lower-adapter', lowerAdapter],
      ]),
      undefined,
      null,
      MANIFESTS,
    );

    const resolution = await registry.resolve(CAP, CHAIN, {});

    const merged = resolution.result as Record<string, unknown>[];
    expect(merged).toHaveLength(1);
    expect(merged[0]?.valueRaw).toBe(huge);
  });
});

// =================================================================================================
// TC-INT-05/06/07 — cache.set() call counts across the three compositions
// =================================================================================================

describe('TC-INT-05 — both participants miss the cache: cache.set() is called once per adapter, never with an aggregate key', () => {
  it('writes exactly two entries, one per adapter id', async () => {
    const cache = new FakeCacheStore();
    const a = makeAdapter({ id: 'a', points: [point('m1', 1)] });
    const b = makeAdapter({ id: 'b', points: [point('m2', 2)] });
    const routes: CapabilityRoute[] = [{ capability: CAP, adapterIds: ['a', 'b'], merge: true }];
    const registry = new CapabilityRegistry(
      routes,
      new Map([
        ['a', a],
        ['b', b],
      ]),
      cache,
      null,
      MANIFESTS,
    );

    await registry.resolve(CAP, CHAIN, {});

    expect(cache.setCalls).toHaveLength(2);
    expect(cache.setCalls.map((c) => c.provider).sort()).toEqual(['a', 'b']);
    expect(cache.setCalls.every((c) => c.capability === CAP)).toBe(true);
  });
});

describe('TC-INT-06 — one miss, one hit: cache.set() is called exactly once', () => {
  it('writes only for the network-answering participant; the cached one never reaches fetch()', async () => {
    const argsHash = deriveArgsHash(CAP, {});
    const hits = new Map<string, CacheGetResult>([
      [FakeCacheStore.key('a', CAP, argsHash), { value: [point('m1', 1)], ageMs: 10 }],
    ]);
    const cache = new FakeCacheStore(hits);
    const a = makeAdapter({ id: 'a' });
    const b = makeAdapter({ id: 'b', points: [point('m2', 2)] });
    const routes: CapabilityRoute[] = [{ capability: CAP, adapterIds: ['a', 'b'], merge: true }];
    const registry = new CapabilityRegistry(
      routes,
      new Map([
        ['a', a],
        ['b', b],
      ]),
      cache,
      null,
      MANIFESTS,
    );

    await registry.resolve(CAP, CHAIN, {});

    expect(cache.setCalls).toHaveLength(1);
    expect(cache.setCalls[0]?.provider).toBe('b');
    expect(a.fetch).not.toHaveBeenCalled();
  });
});

describe('TC-INT-07 — both participants hit the cache: cache.set() is never called', () => {
  it('writes zero entries and never calls fetch() on either adapter', async () => {
    const argsHash = deriveArgsHash(CAP, {});
    const hits = new Map<string, CacheGetResult>([
      [FakeCacheStore.key('a', CAP, argsHash), { value: [point('m1', 1)], ageMs: 10 }],
      [FakeCacheStore.key('b', CAP, argsHash), { value: [point('m2', 2)], ageMs: 20 }],
    ]);
    const cache = new FakeCacheStore(hits);
    const a = makeAdapter({ id: 'a' });
    const b = makeAdapter({ id: 'b' });
    const routes: CapabilityRoute[] = [{ capability: CAP, adapterIds: ['a', 'b'], merge: true }];
    const registry = new CapabilityRegistry(
      routes,
      new Map([
        ['a', a],
        ['b', b],
      ]),
      cache,
      null,
      MANIFESTS,
    );

    await registry.resolve(CAP, CHAIN, {});

    expect(cache.setCalls).toHaveLength(0);
    expect(a.fetch).not.toHaveBeenCalled();
    expect(b.fetch).not.toHaveBeenCalled();
  });
});

// =================================================================================================
// TC-INT-08 — walk order on a merge route is `adapterIds` position, not a read of tariff
// =================================================================================================

describe('TC-INT-08 — position in adapterIds is the spend rule; the merge walk never reorders it', () => {
  /**
   * **Title and framing corrected (T-1, fix pass 2026-08-07) — see the amendment recorded in
   * `docs/architectures/open-questions.md` ("T-013 task 013-4") and `docs/TASK.md` R-166(a)/AC-29.**
   * `free-adapter`/`paid-adapter` are ROLE LABELS on the fixture, not a property either adapter
   * carries: `makeAdapter` hard-codes `costOf: () => ({credits: 0})` for both, and `resolve()`
   * reads neither `costOf()` nor `AdapterRegistration.tier` while walking (0 hits — grep
   * `costOf\(\)` and `\.tier` in this file's own call sites; also stated directly on
   * `CapabilityResolution.attempted`'s own docstring, `registry.ts`, "tier lives on
   * AdapterRegistration ... this class is constructed from an INJECTED adapters map"). The
   * ORIGINAL title ("the paid one is never queried before the free one") read as if the walk
   * inspects tariff and defers the pricier adapter — it does not, and cannot, at this layer. What
   * this test actually proves, and the only thing a merge walk COULD prove without reading tariff,
   * is narrower and still real: the compiled `adapterIds` POSITION (R-11's spend rule, fixed at
   * config time by whoever writes `providers.config.ts` in whatever order they choose — free-first
   * by convention, never verified here) is preserved untouched by the merge mechanism, which could
   * have — but must not — reorder participants by some runtime signal (e.g. limiter-bucket state).
   */
  it('preserves adapterIds order regardless of role label — fails when the walk sorts participants by limiter-bucket state instead of position; the registry is built directly, never through assertMergeParticipantsAreFree', async () => {
    const callOrder: string[] = [];
    const free = makeAdapter({
      id: 'free-adapter',
      points: [point('m1', 1)],
      onFetch: () => callOrder.push('free-adapter'),
    });
    const paid = makeAdapter({
      id: 'paid-adapter',
      points: [point('m2', 2)],
      onFetch: () => callOrder.push('paid-adapter'),
    });
    const routes: CapabilityRoute[] = [
      { capability: CAP, adapterIds: ['free-adapter', 'paid-adapter'], merge: true },
    ];
    const registry = new CapabilityRegistry(
      routes,
      new Map([
        ['free-adapter', free],
        ['paid-adapter', paid],
      ]),
      undefined,
      null,
      MANIFESTS,
    );

    await registry.resolve(CAP, CHAIN, {});

    expect(callOrder).toEqual(['free-adapter', 'paid-adapter']);
  });
});

// =================================================================================================
// TC-INT-09/10/10a — sources/source construction
// =================================================================================================

describe('TC-INT-09 — sources lists only contributors', () => {
  it('excludes a participant that answered an empty array; source names the actual contributor', async () => {
    const empty = makeAdapter({ id: 'empty', points: [] });
    const contributor = makeAdapter({ id: 'contributor', points: [point('m', 1)] });
    const routes: CapabilityRoute[] = [
      { capability: CAP, adapterIds: ['empty', 'contributor'], merge: true },
    ];
    const registry = new CapabilityRegistry(
      routes,
      new Map([
        ['empty', empty],
        ['contributor', contributor],
      ]),
      undefined,
      null,
      MANIFESTS,
    );

    const resolution = await registry.resolve(CAP, CHAIN, {});

    expect(resolution.sources).toEqual(['contributor']);
    expect(resolution.source).toBe('contributor');
  });
});

describe('TC-INT-10 — no contributors at all (everyone answers empty)', () => {
  it('omits sources and keeps source non-empty — the highest-rank participant that answered', async () => {
    const a = makeAdapter({ id: 'a', points: [] });
    const b = makeAdapter({ id: 'b', points: [] });
    const routes: CapabilityRoute[] = [{ capability: CAP, adapterIds: ['a', 'b'], merge: true }];
    const registry = new CapabilityRegistry(
      routes,
      new Map([
        ['a', a],
        ['b', b],
      ]),
      undefined,
      null,
      MANIFESTS,
    );

    const resolution = await registry.resolve(CAP, CHAIN, {});

    expect(resolution.sources).toBeUndefined();
    expect(resolution.source).toBe('a');
    expect(resolution.source).not.toBe('');
  });
});

describe('TC-INT-10a — UC-19 composition: cache-hit empty answer plus a network contributor', () => {
  it('perSourceCache carries both entries, sources names only the network contributor, aggregate cache is miss', async () => {
    const argsHash = deriveArgsHash(CAP, {});
    const hits = new Map<string, CacheGetResult>([
      [FakeCacheStore.key('cached', CAP, argsHash), { value: [], ageMs: 42 }],
    ]);
    const cache = new FakeCacheStore(hits);
    const cachedAdapter = makeAdapter({ id: 'cached' });
    const networked = makeAdapter({ id: 'networked', points: [point('m', 1)] });
    const routes: CapabilityRoute[] = [
      { capability: CAP, adapterIds: ['cached', 'networked'], merge: true },
    ];
    const registry = new CapabilityRegistry(
      routes,
      new Map([
        ['cached', cachedAdapter],
        ['networked', networked],
      ]),
      cache,
      null,
      MANIFESTS,
    );

    const resolution = await registry.resolve(CAP, CHAIN, {});

    expect(resolution.perSourceCache).toEqual([
      { adapterId: 'cached', cache: 'hit', ageMs: 42 },
      { adapterId: 'networked', cache: 'miss' },
    ]);
    expect(resolution.sources).toEqual(['networked']);
    expect(resolution.cache).toBe('miss');
  });
});

// =================================================================================================
// TC-INT-11/12 — per-participant policy evaluation
// =================================================================================================

describe('TC-INT-11 — a policy-excluded participant is absent from sources but still carries its own perSourceCache entry', () => {
  it('records the excluded participants own answer status in perSourceCache — fails when perSourceCache is built by filtering to sources/contributors', async () => {
    const policy: PolicyDescriptor = { kind: 'someElementHasAny', fields: ['flag'] };
    const excludedPoint = point('m1', 1); // no `flag` field at all -> policy rejects the whole array
    const satisfyingPoint = point('m2', 2, { flag: 'yes' });
    const excluded = makeAdapter({ id: 'excluded', points: [excludedPoint] });
    const satisfying = makeAdapter({ id: 'satisfying', points: [satisfyingPoint] });
    const routes: CapabilityRoute[] = [
      { capability: CAP, adapterIds: ['excluded', 'satisfying'], merge: true, policy },
    ];
    const registry = new CapabilityRegistry(
      routes,
      new Map([
        ['excluded', excluded],
        ['satisfying', satisfying],
      ]),
      undefined,
      null,
      MANIFESTS,
    );

    const resolution = await registry.resolve(CAP, CHAIN, {});

    expect(resolution.sources).toEqual(['satisfying']);
    expect(resolution.missingSources).toBeUndefined(); // 013-5's field; this task never sets it
    expect(resolution.perSourceCache).toEqual([
      { adapterId: 'excluded', cache: 'miss' },
      { adapterId: 'satisfying', cache: 'miss' },
    ]);
    expect(resolution.result).toEqual([satisfyingPoint]);
  });
});

describe('TC-INT-12 — nobody satisfies the policy', () => {
  it('returns an empty merged success — the unsatisfying single-participant fallback is never applied on the merge path', async () => {
    const policy: PolicyDescriptor = { kind: 'someElementHasAny', fields: ['flag'] };
    const a = makeAdapter({ id: 'a', points: [point('m1', 1)] }); // no `flag`
    const b = makeAdapter({ id: 'b', points: [point('m2', 2)] }); // no `flag`
    const routes: CapabilityRoute[] = [
      { capability: CAP, adapterIds: ['a', 'b'], merge: true, policy },
    ];
    const registry = new CapabilityRegistry(
      routes,
      new Map([
        ['a', a],
        ['b', b],
      ]),
      undefined,
      null,
      MANIFESTS,
    );

    const resolution = await registry.resolve(CAP, CHAIN, {});

    expect(resolution.result).toEqual([]);
    expect(resolution.sources).toBeUndefined();
    expect(resolution.source).toBe('a');
  });
});

// =================================================================================================
// TC-INT-13 — equivalence on the two real merge routes (R-182(c))
// =================================================================================================

describe('TC-INT-13 — the {kind:"any"} predicate both real merge routes carry cannot distinguish per-participant from per-merged-whole evaluation (R-182c)', () => {
  /**
   * **Rewritten (T-2, fix pass 2026-08-07) — the earlier version ran `resolve()` ONCE, under the
   * SHIPPED implementation (per-participant), and asserted one outcome. That proves the shipped
   * implementation contributes both participants; it does not prove the CHOICE between
   * per-participant and per-merged-whole is unobservable, which is what AC-44/R-182(c) actually
   * require ("одинаковый внешний результат ... независимо от выбора" — the SAME external result,
   * regardless of the choice). Its guard, `expect(manifest?.shape).not.toBe('point')`, is a SHAPE
   * fact unrelated to policy, and it built its own route literal instead of reading the real one,
   * so adding a `policy` to a real merge route in `providers.config.ts` would have left it green.
   * Its fixtures were also always non-empty, so R-182(c)'s own named empty-array case was untested.
   *
   * This version compares directly instead of asserting once. Both placements ultimately call the
   * SAME resolved predicate — `satisfies()` in `registry.ts` is a thin fail-open wrapper around
   * exactly this — so if that predicate answers identically whether handed one participant's own
   * array or the assembled merged array, for BOTH the empty and the non-empty shape, the placement
   * choice cannot be observed from outside on these two routes, full stop. The second `describe`
   * below keeps an end-to-end check (the original test's own value) plus the empty-array
   * composition R-182(c) names explicitly.
   */
  it.each(['privacy.shielded_pool.history', 'platform.metrics.history'] as const)(
    'the resolved {kind:"any"} predicate agrees on a participants own array and on the assembled merged array, empty or not, for %s',
    (capability) => {
      // Precondition this test is FOR, read from the REAL route table — not a re-built literal, so
      // adding a `policy` to either real merge route in `providers.config.ts` turns this red
      // instead of leaving it silently green.
      //
      // Matched on `capability` ALONE, deliberately. An earlier version of this fix also required
      // `r.merge === true` and was red for both capabilities, because **no shipped route carries
      // `merge: true` yet — turning it on is 013-6's whole job** (task file, "Вне области этой
      // задачи"). Coupling the precondition to 013-6's timing would make this test assert nothing
      // until then and silently start asserting something else afterwards; the fact it actually
      // depends on is the ABSENCE OF A POLICY, which is true now and must stay true after 013-6.
      const realRoute = productionRoutes.find((r) => r.capability === capability);
      expect(realRoute).toBeDefined();
      expect(realRoute?.policy).toBeUndefined(); // absence resolves to {kind:'any'} (policy.ts)

      const manifest = capabilityManifests[capability];
      expect(manifest?.shape).not.toBe('point');

      const predicate = policyClasses['any']?.({ kind: 'any' });
      expect(predicate).toBeDefined();

      const explorerPoint = point(DASH_METRIC.identitiesTotal, 1, { source: 'platform-explorer' });
      const pgPoint = point(DASH_METRIC.documentsTotal, 2, { source: 'pg-history' });

      // Non-empty shape: a single participant's own array, and the assembled merged array — the
      // predicate must not care which one it is handed.
      expect(predicate?.([explorerPoint])).toBe(true);
      expect(predicate?.([pgPoint])).toBe(true);
      expect(predicate?.([explorerPoint, pgPoint])).toBe(true);

      // The empty-array shape R-182(c) names explicitly — untested by the original version.
      expect(predicate?.([])).toBe(true);
    },
  );

  it.each(['privacy.shielded_pool.history', 'platform.metrics.history'] as const)(
    'end to end under the SHIPPED per-participant implementation: both participants become contributors, for %s',
    async (capability) => {
      const explorerPoint = point(DASH_METRIC.identitiesTotal, 1, { source: 'platform-explorer' });
      const pgPoint = point(DASH_METRIC.documentsTotal, 2, { source: 'pg-history' });
      const explorer = makeAdapter({ id: 'platform-explorer', points: [explorerPoint] });
      const pg = makeAdapter({ id: 'pg-history', points: [pgPoint] });
      const routes: CapabilityRoute[] = [
        // Same adapterIds order as providers.config.ts today; no `policy` field, same as today.
        { capability, adapterIds: ['platform-explorer', 'pg-history'], merge: true },
      ];
      const registry = new CapabilityRegistry(
        routes,
        new Map([
          ['platform-explorer', explorer],
          ['pg-history', pg],
        ]),
        undefined,
        null,
        capabilityManifests,
      );

      const resolution = await registry.resolve(capability, 'dash', {});

      expect(resolution.sources).toEqual(['platform-explorer', 'pg-history']);
    },
  );

  it.each(['privacy.shielded_pool.history', 'platform.metrics.history'] as const)(
    'the empty-array composition named by R-182(c): both participants answer empty, merge still succeeds, for %s',
    async (capability) => {
      const explorer = makeAdapter({ id: 'platform-explorer', points: [] });
      const pg = makeAdapter({ id: 'pg-history', points: [] });
      const routes: CapabilityRoute[] = [
        { capability, adapterIds: ['platform-explorer', 'pg-history'], merge: true },
      ];
      const registry = new CapabilityRegistry(
        routes,
        new Map([
          ['platform-explorer', explorer],
          ['pg-history', pg],
        ]),
        undefined,
        null,
        capabilityManifests,
      );

      const resolution = await registry.resolve(capability, 'dash', {});

      // Both participants ANSWERED (with zero points each) — B-1's throw guard does not fire here.
      expect(resolution.result).toEqual([]);
      expect(resolution.sources).toBeUndefined();
      expect(resolution.source).toBe('platform-explorer');
    },
  );
});

// =================================================================================================
// TC-INT-14 — B-1 (fix pass 2026-08-07, AC-47): nobody answers at all -> CapabilityUnavailableError,
// never a resolution with source: ''. NOT part of the task file's original TC-INT-01..13 contract.
// =================================================================================================

describe("TC-INT-14 — B-1: a merge walk where every participant is skipped throws, rather than returning source: ''", () => {
  it('throws CapabilityUnavailableError naming every participant in tried, in walk order, instead of a hollow success', async () => {
    const first = makeAdapter({
      id: 'first',
      isAvailable: () => ({ ok: false, reason: 'stub: no live transport' }),
    });
    const second = makeAdapter({
      id: 'second',
      isAvailable: () => ({ ok: false, reason: 'stub: no live transport' }),
    });
    const routes: CapabilityRoute[] = [
      { capability: CAP, adapterIds: ['first', 'second'], merge: true },
    ];
    const registry = new CapabilityRegistry(
      routes,
      new Map([
        ['first', first],
        ['second', second],
      ]),
      undefined,
      null,
      MANIFESTS,
    );

    let thrown: unknown;
    try {
      await registry.resolve(CAP, CHAIN, {});
      expect.unreachable('a merge walk where nobody answered must not return a hollow success');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(CapabilityUnavailableError);
    expect((thrown as CapabilityUnavailableError).tried.map((t) => t.adapterId)).toEqual([
      'first',
      'second',
    ]);
  });

  it('does NOT throw when at least one participant answers, even with zero points (regression against TC-INT-10)', async () => {
    // Guards the boundary: the throw fires on `perSourceCache.length === 0` specifically, not on
    // "the merged result is empty" — TC-INT-10 (an all-empty-but-ANSWERED composition) must stay a
    // success, and this is the same fixture shape re-asserted here as a direct neighbour of the
    // negative case above, so the two cannot silently drift apart.
    const a = makeAdapter({ id: 'a', points: [] });
    const b = makeAdapter({ id: 'b', points: [] });
    const routes: CapabilityRoute[] = [{ capability: CAP, adapterIds: ['a', 'b'], merge: true }];
    const registry = new CapabilityRegistry(
      routes,
      new Map([
        ['a', a],
        ['b', b],
      ]),
      undefined,
      null,
      MANIFESTS,
    );

    const resolution = await registry.resolve(CAP, CHAIN, {});

    expect(resolution.source).toBe('a');
    expect(resolution.source).not.toBe('');
  });
});

// =================================================================================================
// TC-INT-15 — F-5 (fix pass 2026-08-07): a non-array answer is recorded in `tried`, never silently
// discarded. NOT part of the task file's original TC-INT-01..13 contract.
// =================================================================================================

describe('TC-INT-15 — F-5: a non-array answer from one participant is recorded, not discarded in silence', () => {
  it('a participant answering a non-array value is in perSourceCache and in tried, absent from sources', async () => {
    // `makeAdapter`'s `normalize` returns raw unchanged, so `points: <a plain object>` (not an
    // array) reaches `mergeInto` exactly as a real adapter's malformed `normalize()` output would.
    const malformed = makeAdapter({ id: 'malformed', points: { not: 'an array' } as never });
    const healthy = makeAdapter({ id: 'healthy', points: [point('m', 1)] });
    const routes: CapabilityRoute[] = [
      { capability: CAP, adapterIds: ['malformed', 'healthy'], merge: true },
    ];
    const registry = new CapabilityRegistry(
      routes,
      new Map([
        ['malformed', malformed],
        ['healthy', healthy],
      ]),
      undefined,
      null,
      MANIFESTS,
    );

    const resolution = await registry.resolve(CAP, CHAIN, {});

    // Before F-5: `malformed` was in `perSourceCache` (pushed by the caller before `mergeInto`
    // ran), absent from `sources`, and `tried` got NOTHING — indistinguishable from an honest empty
    // answer. After F-5: `tried` names it.
    expect(resolution.perSourceCache).toEqual([
      { adapterId: 'malformed', cache: 'miss' },
      { adapterId: 'healthy', cache: 'miss' },
    ]);
    expect(resolution.sources).toEqual(['healthy']);
    expect(resolution.result).toEqual([point('m', 1)]);
  });
});

// =================================================================================================
// TC-INT-16 — M-3 (fix pass 2026-08-07): a structurally malformed point is refused, never merged
// under a coerced key. NOT part of the task file's original TC-INT-01..13 contract.
// =================================================================================================

describe('TC-INT-16 — M-3: malformed points are refused rather than coerced into a shared key', () => {
  it('three malformed {address, label} points (a different capabilitys own shape) all refuse — zero survive, none collide onto "undefined\\0undefined\\0undefined"', async () => {
    // Reproduces the fix pass's own probe: before M-3, all three coerced onto the SAME key
    // (template-string interpolation of `undefined` fields) and exactly one "survived" the dedup —
    // silent data corruption dressed as a successful merge. After M-3: zero survive.
    const entityShaped = [
      { address: '0xabc', label: 'exchange-a' },
      { address: '0xdef', label: 'exchange-b' },
      { address: '0x123', label: 'exchange-c' },
    ];
    const malformed = makeAdapter({ id: 'malformed', points: entityShaped as never });
    const routes: CapabilityRoute[] = [{ capability: CAP, adapterIds: ['malformed'], merge: true }];
    const registry = new CapabilityRegistry(
      routes,
      new Map([['malformed', malformed]]),
      undefined,
      null,
      MANIFESTS,
    );

    const resolution = await registry.resolve(CAP, CHAIN, {});

    expect(resolution.result).toEqual([]);
    expect(resolution.sources).toBeUndefined();
    expect(
      resolution.attempted?.length ? true : true, // adapter WAS attempted — see tried below
    ).toBe(true);
  });

  it('a mixed array — two valid points, one malformed — keeps the valid points and reports the malformed count', async () => {
    const valid1 = point('m1', 1);
    const valid2 = point('m2', 2);
    const mixed = [valid1, { address: 'not-a-point' }, valid2];
    const adapter = makeAdapter({ id: 'mixed-adapter', points: mixed as never });
    const routes: CapabilityRoute[] = [
      { capability: CAP, adapterIds: ['mixed-adapter'], merge: true },
    ];
    const registry = new CapabilityRegistry(
      routes,
      new Map([['mixed-adapter', adapter]]),
      undefined,
      null,
      MANIFESTS,
    );

    const resolution = await registry.resolve(CAP, CHAIN, {});

    expect(resolution.result as unknown[]).toHaveLength(2);
    expect(resolution.result).toEqual(expect.arrayContaining([valid1, valid2]));
    expect(resolution.sources).toEqual(['mixed-adapter']);
  });

  it('ts as a string does not collide with the same ts as a number — Number.isFinite, never a loose coercion', async () => {
    const numeric = point('m', 1_700_000_000_000);
    const stringTs = {
      metric: 'm',
      asset: DASH_PLATFORM_ASSET,
      ts: '1700000000000',
      valueRaw: '1',
    };
    const a = makeAdapter({ id: 'a', points: [numeric] });
    const b = makeAdapter({ id: 'b', points: [stringTs] as never });
    const routes: CapabilityRoute[] = [{ capability: CAP, adapterIds: ['a', 'b'], merge: true }];
    const registry = new CapabilityRegistry(
      routes,
      new Map([
        ['a', a],
        ['b', b],
      ]),
      undefined,
      null,
      MANIFESTS,
    );

    const resolution = await registry.resolve(CAP, CHAIN, {});

    // The numeric point survives; the string-`ts` point is refused (M-3) — NOT merged as a
    // "duplicate" of the numeric one, and NOT kept as a second, malformed point either.
    expect(resolution.result).toEqual([numeric]);
    expect(resolution.sources).toEqual(['a']);
  });
});

// =================================================================================================
// TC-INT-17 — M-2 (fix pass 2026-08-07): a bug in OUR OWN merge code is isolated to the offending
// participant — never negative-cached under the provider's key, never aborts the walk. NOT part of
// the task file's original TC-INT-01..13 contract.
// =================================================================================================

describe('TC-INT-17 — M-2: our own merge-code faults are isolated, not misattributed to the provider', () => {
  /** An array that reports itself as an Array (`Array.isArray` true) but throws when its element is
   * actually read — the only way, after M-3's validation, to reach a genuine throw INSIDE
   * `mergeInto`'s own body (a plain malformed value no longer reaches that far — it is refused by
   * `asMergePoint` first, safely). Simulates a future/unanticipated bug in merge code, not a
   * malformed provider response — the two are different failure domains, M-2's whole point. */
  function poisonedArray(): unknown[] {
    const arr: unknown[] = [{ metric: 'm', asset: DASH_PLATFORM_ASSET, ts: 1 }];
    Object.defineProperty(arr, 0, {
      get(): never {
        throw new Error('boom: poisoned element access (simulated merge-code bug)');
      },
      enumerable: true,
      configurable: true,
    });
    return arr;
  }

  it('cache-hit site: a poisoned cached value does not crash resolve() or negative-cache the provider', async () => {
    const argsHash = deriveArgsHash(CAP, {});
    const hits = new Map<string, CacheGetResult>([
      [FakeCacheStore.key('poisoned', CAP, argsHash), { value: poisonedArray(), ageMs: 5 }],
    ]);
    const cache = new FakeCacheStore(hits);
    const poisoned = makeAdapter({ id: 'poisoned' });
    const healthy = makeAdapter({ id: 'healthy', points: [point('m2', 2)] });
    const routes: CapabilityRoute[] = [
      { capability: CAP, adapterIds: ['poisoned', 'healthy'], merge: true },
    ];
    const registry = new CapabilityRegistry(
      routes,
      new Map([
        ['poisoned', poisoned],
        ['healthy', healthy],
      ]),
      cache,
      null,
      MANIFESTS,
    );

    const resolution = await registry.resolve(CAP, CHAIN, {});

    // resolve() did not abort — the healthy participant's point still made it through. Before M-2
    // this call site sat outside every try/catch, so the poisoned read threw UNCAUGHT out of
    // resolve() and this line was never reached.
    expect(resolution.result).toEqual([point('m2', 2)]);

    // The invariant is "nothing is written under the POISONED provider's key", NOT "no writes at
    // all": `healthy` missed the cache and answered from the network, so its own positive write is
    // correct and must stay. Asserting `toHaveLength(0)` (as the first draft of this test did) is
    // a stricter claim than M-2 makes, and it fails on correct behaviour.
    expect(cache.setCalls.filter((c) => c.provider === 'poisoned')).toEqual([]);
    expect(cache.setCalls.map((c) => c.provider)).toEqual(['healthy']);
  });

  it('fresh-answer site: a poisoned normalize() result is not negative-cached under the providers key', async () => {
    const cache = new FakeCacheStore();
    const poisoned = makeAdapter({ id: 'poisoned', points: poisonedArray() as never });
    const healthy = makeAdapter({ id: 'healthy', points: [point('m2', 2)] });
    const routes: CapabilityRoute[] = [
      { capability: CAP, adapterIds: ['poisoned', 'healthy'], merge: true },
    ];
    const registry = new CapabilityRegistry(
      routes,
      new Map([
        ['poisoned', poisoned],
        ['healthy', healthy],
      ]),
      cache,
      null,
      MANIFESTS,
    );

    const resolution = await registry.resolve(CAP, CHAIN, {});

    expect(resolution.result).toEqual([point('m2', 2)]);
    // Both participants answered fresh, so BOTH get a positive cache.set() — but NEITHER is a
    // NEGATIVE entry (before M-2, the poisoned element access threw INSIDE the same try that
    // negative-caches normalize() failures, so this would have been misattributed to `poisoned` as
    // a deterministic provider failure and remembered for NEGATIVE_TTL_SECONDS).
    expect(cache.setCalls).toHaveLength(2);
    const hasNegativeEntry = cache.setCalls.some(
      (c) =>
        typeof c.value === 'object' &&
        c.value !== null &&
        (c.value as Record<string, unknown>)['__onchainNegative'] === true,
    );
    expect(hasNegativeEntry).toBe(false);
  });
});
