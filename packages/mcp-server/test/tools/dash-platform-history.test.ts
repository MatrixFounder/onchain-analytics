import { describe, expect, it, vi } from 'vitest';
import { CapabilityDeadlineExceededError, CapabilityRegistry } from '@onchain-intel/core';
import {
  DashPlatformHistoryInputSchema,
  DashPlatformHistoryOutputSchema,
  dashPlatformHistoryHandler,
  type DashPlatformHistoryInput,
} from '../../src/tools/dash-platform-history.js';

/**
 * Task 013-7 (T-013, R-170/R-171) — the 14th tool's MODULE: schemas, selector, grouping,
 * `limit`/`truncated`, `missingSources` forwarding, its own `_meta.cache`.
 *
 * **A STUB registry, not the real adapters** (PLAN point 3.3's precedent one task over). Everything
 * this file asserts is about what the TOOL does with a resolution — the merge walk that produces
 * one is 013-4/013-5's and is tested there, on `packages/core`'s own fixtures. Driving real
 * adapters here would re-test the walk and, worse, make `missingSources`/`perSourceCache`
 * compositions awkward to arrange, so the cases that matter most would be the ones least covered.
 *
 * `getChainRegistry()` is the REAL one (the registry is constructed with `null`, exactly as
 * production wires it) because `canonicalizeChain` runs against it in the handler — stubbing that
 * would stub away a real step.
 */

const CAP_SHIELDED = 'privacy.shielded_pool.history';
const CAP_METRICS = 'platform.metrics.history';
const TS = 1_700_000_000_000;

function snapshot(metric: string, ts: number, valueRaw = '1', source = 'platform-explorer') {
  return { metric, asset: 'dash-platform', ts, valueRaw, source };
}

interface StubOpts {
  result?: unknown;
  sources?: string[];
  missingSources?: { adapterId: string; reason: string }[];
  perSourceCache?: { adapterId: string; cache: 'hit' | 'miss'; ageMs?: number }[];
  cache?: 'hit' | 'miss';
  throws?: unknown;
}

/**
 * A real `CapabilityRegistry` (so `getChainRegistry()` is real) with `resolve()` spied out —
 * `vi.spyOn` on a real instance, the seam `resolve-capability-merge.test.ts` established one task
 * over, and for its reason: `resolveCapability`'s first parameter is the CONCRETE class, whose
 * private members a plain object literal cannot satisfy.
 *
 * Records which capability was asked for, which is the whole of TC-UNIT-01.
 */
function stubRegistry(opts: StubOpts = {}) {
  const asked: string[] = [];
  const registry = new CapabilityRegistry([], new Map(), undefined, null);
  vi.spyOn(registry, 'resolve').mockImplementation(async (capability: string) => {
    asked.push(capability);
    if (opts.throws) throw opts.throws;
    return {
      result: opts.result ?? [],
      source: opts.sources?.[0] ?? 'platform-explorer',
      cache: opts.cache ?? 'miss',
      ...(opts.sources ? { sources: opts.sources } : {}),
      ...(opts.missingSources ? { missingSources: opts.missingSources } : {}),
      ...(opts.perSourceCache ? { perSourceCache: opts.perSourceCache } : {}),
    };
  });
  return { ctx: { registry }, asked };
}

function input(over: Partial<DashPlatformHistoryInput> = {}): DashPlatformHistoryInput {
  return { chain: 'dash', series: 'platform_metrics', ...over } as DashPlatformHistoryInput;
}

// =================================================================================================
// TC-UNIT-01 — the selector picks ONE capability
// =================================================================================================

describe('TC-UNIT-01 — the series selector resolves exactly one capability', () => {
  it('platform_metrics asks for platform.metrics.history and never the other (AC-33)', async () => {
    const { ctx, asked } = stubRegistry({ result: [snapshot('identities_total', TS)] });

    const outcome = await dashPlatformHistoryHandler(input({ series: 'platform_metrics' }), ctx);

    expect(outcome.ok).toBe(true);
    expect(asked).toStrictEqual([CAP_METRICS]);
  });

  it('shielded_pool asks for privacy.shielded_pool.history and never the other (AC-33)', async () => {
    const { ctx, asked } = stubRegistry({
      result: [snapshot('shielded_pool_shield_amount', TS)],
    });

    const outcome = await dashPlatformHistoryHandler(input({ series: 'shielded_pool' }), ctx);

    expect(outcome.ok).toBe(true);
    // One call, one capability — never both for one request: their manifests carry different
    // ttlSeconds/deadlineMs, so a combined call would have to pick one budget for two questions.
    expect(asked).toStrictEqual([CAP_SHIELDED]);
  });
});

// =================================================================================================
// TC-UNIT-02 / 03 / 04 — grouping, on BOTH selectors (AC-49)
// =================================================================================================

describe('TC-UNIT-02 — shielded_pool groups the two genuinely different metrics apart', () => {
  it('returns two groups, one per metric, neither renamed nor collapsed (AC-49 first half, UC-18)', async () => {
    const { ctx } = stubRegistry({
      result: [
        snapshot('shielded_pool_shield_amount', TS, '5'),
        snapshot('shielded_pool_balance_credits', TS, '4611474006200', 'pg-history'),
      ],
      sources: ['platform-explorer', 'pg-history'],
    });

    const outcome = await dashPlatformHistoryHandler(input({ series: 'shielded_pool' }), ctx);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.groups.map((group) => group.metric)).toStrictEqual([
      'shielded_pool_shield_amount',
      'shielded_pool_balance_credits',
    ]);
    expect(outcome.value.groups.every((group) => group.points.length === 1)).toBe(true);
  });
});

describe('TC-UNIT-03 — platform_metrics groups every metric present', () => {
  it('returns one group per metric, including the three only pg-history writes (AC-49 second half, UC-11)', async () => {
    const { ctx } = stubRegistry({
      result: [
        snapshot('identities_total', TS),
        snapshot('documents_total', TS, '17586', 'pg-history'),
        snapshot('data_contracts_total', TS, '59', 'pg-history'),
        snapshot('platform_total_credits', TS, '2802452583638438', 'pg-history'),
      ],
      sources: ['platform-explorer', 'pg-history'],
    });

    const outcome = await dashPlatformHistoryHandler(input({ series: 'platform_metrics' }), ctx);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // Asserted as a SET on the second selector, because this is the half of AC-49 an
    // implementation tested only on `shielded_pool` would leave with no entry at all.
    expect(new Set(outcome.value.groups.map((group) => group.metric))).toStrictEqual(
      new Set([
        'identities_total',
        'documents_total',
        'data_contracts_total',
        'platform_total_credits',
      ]),
    );
  });
});

describe('TC-UNIT-04 — neither selector ever returns a flat array of points', () => {
  it.each([['shielded_pool'], ['platform_metrics']] as const)(
    'series=%s answers with groups, and `points` exists only inside a group',
    async (series) => {
      const { ctx } = stubRegistry({ result: [snapshot('any_metric', TS)] });

      const outcome = await dashPlatformHistoryHandler(input({ series }), ctx);

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      expect(Array.isArray(outcome.value.groups)).toBe(true);
      expect(outcome.value).not.toHaveProperty('points');
      for (const group of outcome.value.groups) {
        expect(group).toHaveProperty('metric');
        expect(Array.isArray(group.points)).toBe(true);
      }
    },
  );
});

// =================================================================================================
// TC-UNIT-05 — exactness
// =================================================================================================

describe('TC-UNIT-05 — valueRaw survives as an exact string', () => {
  it('carries a value past 2^53 byte for byte, never through Number', async () => {
    // 2^53 is 9007199254740992; this is larger and NOT representable — `Number(x)` would round it,
    // which is the whole reason `value_raw` is TEXT in the schema (DB-SCHEMA §1.7, lesson L-2).
    const huge = '9007199254740993123456';
    const { ctx } = stubRegistry({ result: [snapshot('platform_total_credits', TS, huge)] });

    const outcome = await dashPlatformHistoryHandler(input(), ctx);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    const value = outcome.value.groups[0]!.points[0]!.valueRaw;
    expect(value).toBe(huge);
    expect(typeof value).toBe('string');
    // The statement the equality above cannot make on its own: a round-trip through Number loses
    // it, so this asserts the tool did NOT do that.
    expect(String(Number(huge))).not.toBe(huge);
  });
});

// =================================================================================================
// TC-UNIT-06 — missingSources forwarding (AC-46)
// =================================================================================================

describe('TC-UNIT-06 — missingSources reaches the wire under the same name', () => {
  it('forwards the registry field verbatim and does not fold it into window (AC-46, UC-12)', async () => {
    const missing = [{ adapterId: 'pg-history', reason: 'ONCHAIN_PG_URL is not configured' }];
    const { ctx } = stubRegistry({
      result: [snapshot('identities_total', TS)],
      sources: ['platform-explorer'],
      missingSources: missing,
    });

    const outcome = await dashPlatformHistoryHandler(input(), ctx);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.missingSources).toStrictEqual(missing);
    // The name is the contract (R-171(e)): a rename at this boundary would make the tool's answer
    // and the registry's resolution describe the same fact in two vocabularies.
    expect(outcome.value.window).not.toHaveProperty('missingSources');
    expect(outcome.value.window).toStrictEqual({ fromMs: TS, toMs: TS });
  });

  it('omits the key entirely when nobody was missing — never an empty array', async () => {
    const { ctx } = stubRegistry({ result: [snapshot('identities_total', TS)] });

    const outcome = await dashPlatformHistoryHandler(input(), ctx);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value).not.toHaveProperty('missingSources');
  });
});

// =================================================================================================
// TC-UNIT-07 / 08 / 09 — truncated, both causes, both selectors
// =================================================================================================

describe('TC-UNIT-07 — an own slice sets truncated and says so', () => {
  it('limit:10 cuts each group and the reason names OUR slicing, not the source', async () => {
    const points = Array.from({ length: 25 }, (_, i) =>
      snapshot('identities_total', TS + i * 60_000),
    );
    const { ctx } = stubRegistry({ result: points, sources: ['platform-explorer'] });

    const outcome = await dashPlatformHistoryHandler(input({ limit: 10 }), ctx);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.groups[0]!.points).toHaveLength(10);
    expect(outcome.value.truncated.series).toBe(true);
    expect(outcome.value.truncated.reason).toContain('limit of 10');
    expect(outcome.value.truncated.reason).not.toContain('pg-history');
  });
});

describe("TC-UNIT-08 — pg-history's own ceiling sets truncated on BOTH selectors", () => {
  it.each([['shielded_pool'], ['platform_metrics']] as const)(
    'series=%s: limit above 100 with pg-history contributing reports the SOURCE ceiling',
    async (series) => {
      const { ctx } = stubRegistry({
        result: [snapshot('some_metric', TS, '1', 'pg-history')],
        sources: ['platform-explorer', 'pg-history'],
      });

      const outcome = await dashPlatformHistoryHandler(input({ series, limit: 300 }), ctx);

      expect(outcome.ok).toBe(true);
      if (!outcome.ok) return;
      // True even though this tool cut nothing: the ceiling is real and belongs to the answer, and
      // a caller that asked for 300 would otherwise read a 1-point group as "that is all there is".
      expect(outcome.value.truncated.series).toBe(true);
      expect(outcome.value.truncated.reason).toContain('pg-history');
      expect(outcome.value.truncated.reason).toContain('100');
    },
  );

  it('stays false when pg-history did NOT contribute, however large the limit', async () => {
    const { ctx } = stubRegistry({
      result: [snapshot('identities_total', TS)],
      sources: ['platform-explorer'],
    });

    const outcome = await dashPlatformHistoryHandler(input({ limit: 500 }), ctx);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.truncated.series).toBe(false);
  });
});

describe('TC-UNIT-09 — both causes at once are both named', () => {
  it('names our own slice AND the source ceiling in one reason', async () => {
    const points = Array.from({ length: 400 }, (_, i) =>
      snapshot('identities_total', TS + i * 60_000, '1', 'pg-history'),
    );
    const { ctx } = stubRegistry({
      result: points,
      sources: ['platform-explorer', 'pg-history'],
    });

    const outcome = await dashPlatformHistoryHandler(input({ limit: 300 }), ctx);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.value.truncated.series).toBe(true);
    // Both facts, because either one alone misleads: the caller would attribute the short group to
    // whichever cause the sentence happened to mention.
    expect(outcome.value.truncated.reason).toContain('limit of 300');
    expect(outcome.value.truncated.reason).toContain('pg-history');
  });
});

// =================================================================================================
// TC-UNIT-10 / 11 / 12 — schema strictness, own _meta.cache, shared error translation
// =================================================================================================

describe('TC-UNIT-10 — both schemas are strict', () => {
  it('rejects an unknown key on the input', () => {
    const parsed = DashPlatformHistoryInputSchema.safeParse({
      chain: 'dash',
      series: 'platform_metrics',
      unexpected: true,
    });
    expect(parsed.success).toBe(false);
  });

  it('rejects an unknown key on the output', () => {
    const parsed = DashPlatformHistoryOutputSchema.safeParse({
      chain: 'dash',
      series: 'platform_metrics',
      groups: [],
      truncated: { series: false, reason: 'nothing was cut' },
      source: 'platform-explorer',
      fetchedAt: TS,
      unexpected: true,
    });
    expect(parsed.success).toBe(false);
  });

  it('requires the series selector — there is no default between two different quantities', () => {
    const parsed = DashPlatformHistoryInputSchema.safeParse({ chain: 'dash' });
    expect(parsed.success).toBe(false);
  });
});

describe('TC-UNIT-11 — the tool builds its OWN _meta.cache', () => {
  it('carries perSource and neither provider nor capability (R-174(e))', async () => {
    const perSourceCache = [
      { adapterId: 'platform-explorer', cache: 'hit' as const, ageMs: 1_000 },
      { adapterId: 'pg-history', cache: 'miss' as const },
    ];
    const { ctx } = stubRegistry({
      result: [snapshot('identities_total', TS)],
      sources: ['platform-explorer', 'pg-history'],
      perSourceCache,
    });

    const outcome = await dashPlatformHistoryHandler(input(), ctx);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.cache.perSource).toStrictEqual(perSourceCache);
    // `provider` is a single string a merged answer has no honest value for; `capability` would
    // restate `series`. Their ABSENCE is the decision, so it is asserted rather than assumed.
    expect(outcome.cache).not.toHaveProperty('provider');
    expect(outcome.cache).not.toHaveProperty('capability');
  });
});

/**
 * **`CapabilityUnavailableError` is deliberately NOT exported from `@onchain-intel/core`.** The
 * index exports its sibling `CapabilityDeadlineExceededError` precisely so the two can be told
 * apart across the package boundary, and says so in place; the unavailable class is reachable only
 * inside `packages/core`. So the first row below stands in for it with a plain `Error` carrying the
 * same message shape, and this note exists instead of a widened package surface.
 *
 * What the case pins is unaffected: `resolveCapability` catches ANY throw and forwards
 * `error.message`, so the two rows are "a typed registry error" and "anything else" — which is the
 * real branch structure, and the thing that would break if this tool grew its own error handling.
 */
describe('TC-UNIT-12 — registry errors come back through the shared wrapper', () => {
  it.each([
    [
      'an untyped registry failure (the unavailable class is unexported — see above)',
      new Error(`capability ${CAP_METRICS} unavailable on dash: every source failed or declined`),
    ],
    [
      'CapabilityDeadlineExceededError',
      new CapabilityDeadlineExceededError({ capability: CAP_METRICS, chain: 'dash', tried: [] }),
    ],
  ])('translates %s into {ok:false, reason} without its own error code', async (_name, error) => {
    const { ctx } = stubRegistry({ throws: error });

    const outcome = await dashPlatformHistoryHandler(input(), ctx);

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    // The message is the registry's own, forwarded by `resolveCapability` — this tool never
    // rewrites or classifies it, which is what keeps 14 tools reporting failures one way.
    expect(outcome.reason).toBe((error as Error).message);
  });
});
