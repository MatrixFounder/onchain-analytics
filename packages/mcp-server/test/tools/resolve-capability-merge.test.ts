import { describe, expect, it, vi } from 'vitest';
import { CapabilityRegistry } from '@onchain-intel/core';
import { resolveCapability } from '../../src/tools/resolve-capability.js';
import type { ResolveSuccess } from '../../src/tools/resolve-capability.js';

/**
 * `resolveCapability()`'s passthrough of the three merge-only `CapabilityResolution` fields —
 * `sources`/`missingSources`/`perSourceCache` (T-013, task 013-3, R-174/R-175). Phase 1 of the
 * task file's own two-phase split: the merge WALK that actually populates these fields on a real
 * traversal does not exist yet (013-4/013-5), so every test here injects its OWN `resolve()`
 * implementation via `vi.spyOn`, exactly as `docs/tasks/task-013-3-resolution-shape.md`'s
 * Test-кейсы section specifies ("подставной реестр возвращает `sources`/`missingSources`/
 * `perSourceCache`; `resolveCapability()` отдаёт все три без потери формы").
 *
 * **Why `vi.spyOn` on a real instance, not a plain object literal.** `resolveCapability`'s first
 * parameter is typed as the CONCRETE `CapabilityRegistry` class (private members), so a plain
 * object literal cannot satisfy it — the same constraint `packages/mcp-server/.AGENTS.md` records
 * for the 4 M1 tools' own tests ("a plain object literal can't satisfy it due to TS's
 * private-member typing"). Those tests work around it by giving a real registry a real (fake)
 * `ProviderAdapter`; that route is closed here because the merge fields cannot be produced by any
 * real adapter/route combination until 013-4/013-5 land. Spying on the instance's own `resolve`
 * method is the injection seam the task file names directly.
 */

/** A real, zero-route `CapabilityRegistry` — its three constructor-time validation loops each walk
 * zero routes and never throw. `resolve` is a public instance method (not readonly), so spying on
 * it after construction is exactly `vi.spyOn`'s ordinary use. */
function fakeRegistry(): CapabilityRegistry {
  return new CapabilityRegistry([], new Map());
}

describe('resolveCapability() — merge-only field passthrough (T-013, task 013-3)', () => {
  it('TC-UNIT-01: forwards sources/missingSources/perSourceCache verbatim, without losing shape', async () => {
    const registry = fakeRegistry();
    // Synthetic adapter ids (`adapter-a/b/c/d`), deliberately not borrowed from any real route:
    // this test is about the WRAPPER's forwarding fidelity, not about `platform.metrics.history`'s
    // real two-participant shape (TC-UNIT-05 below covers that composition with real names). EVERY
    // array here MUST have >=2 entries — a single-entry fixture cannot distinguish a correct
    // forward from a "keep only the first element" / "truncate to one" mutant, since both produce
    // the same one-element array. (Roast round 1, B-1: `missingSources` shipped with only ONE
    // entry, so `.slice(0, 1)` on it survived the full suite undetected — fixed here.)
    vi.spyOn(registry, 'resolve').mockResolvedValue({
      result: [
        { metric: 'm', asset: 'a', ts: 1 },
        { metric: 'm', asset: 'a', ts: 2 },
      ],
      source: 'adapter-a',
      cache: 'miss',
      sources: ['adapter-a', 'adapter-b'],
      missingSources: [
        { adapterId: 'adapter-c', reason: 'not asked: chain-scoped skip' },
        { adapterId: 'adapter-d', reason: 'asked, did not answer: HTTP 500' },
      ],
      perSourceCache: [
        { adapterId: 'adapter-a', cache: 'hit', ageMs: 120 },
        { adapterId: 'adapter-b', cache: 'miss' },
      ],
    });

    const outcome = await resolveCapability(registry, 'platform.metrics.history', 'dash', {});

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('expected ok:true');
    // `toStrictEqual` on the WHOLE array, not a `.length`/first-element check — this is exactly the
    // assertion a "take only the first element" mutant fails (see the mutation protocol in the
    // task report).
    expect(outcome.sources).toStrictEqual(['adapter-a', 'adapter-b']);
    expect(outcome.missingSources).toStrictEqual([
      { adapterId: 'adapter-c', reason: 'not asked: chain-scoped skip' },
      { adapterId: 'adapter-d', reason: 'asked, did not answer: HTTP 500' },
    ]);
    expect(outcome.perSourceCache).toStrictEqual([
      { adapterId: 'adapter-a', cache: 'hit', ageMs: 120 },
      { adapterId: 'adapter-b', cache: 'miss' },
    ]);
  });

  it('TC-UNIT-02: fields are ABSENT, not empty arrays, when the registry does not set them', async () => {
    const registry = fakeRegistry();
    vi.spyOn(registry, 'resolve').mockResolvedValue({
      result: { priceUsd: 7 },
      source: 'coingecko',
      cache: 'hit',
      ageMs: 12,
    });

    const outcome = await resolveCapability(registry, 'token.price', 'ethereum', {});

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('expected ok:true');
    // `exactOptionalPropertyTypes` is NOT enabled (tsconfig.base.json), so `{sources: undefined}`
    // typechecks and `expect(outcome.sources).toBeUndefined()` would pass for it too — that
    // assertion alone does not distinguish "absent" from "present as undefined". `in`/
    // `Object.hasOwn` is the only check that actually does.
    expect('sources' in outcome).toBe(false);
    expect(Object.hasOwn(outcome, 'sources')).toBe(false);
    expect('missingSources' in outcome).toBe(false);
    expect(Object.hasOwn(outcome, 'missingSources')).toBe(false);
    expect('perSourceCache' in outcome).toBe(false);
    expect(Object.hasOwn(outcome, 'perSourceCache')).toBe(false);
  });

  it('TC-UNIT-03: cache.status and every perSourceCache entry stay the two-literal hit|miss', async () => {
    const registry = fakeRegistry();
    vi.spyOn(registry, 'resolve').mockResolvedValue({
      result: [],
      source: 'pg-history',
      cache: 'hit',
      ageMs: 5,
      sources: [],
      perSourceCache: [{ adapterId: 'pg-history', cache: 'hit', ageMs: 5 }],
    });

    const outcome = await resolveCapability(registry, 'platform.metrics.history', 'dash', {});

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('expected ok:true');
    const literals: unknown[] = ['hit', 'miss'];
    expect(literals).toContain(outcome.cache.status);
    expect(outcome.perSourceCache).toHaveLength(1);
    for (const entry of outcome.perSourceCache ?? []) {
      expect(literals).toContain(entry.cache);
    }
  });

  it('TC-UNIT-05: a cache-answered non-contributor is in perSourceCache and absent from sources', async () => {
    const registry = fakeRegistry();
    // `platform-explorer` answered an empty array FROM CACHE — a real fact about the answer — and
    // contributed no point, so it is correctly absent from `sources` (contributors only, R-174(a))
    // while still present in `perSourceCache` (every ANSWERED participant, R-174(c) — the
    // deviation this proves is recorded in `docs/architectures/open-questions.md` "T-013 task 013-3").
    vi.spyOn(registry, 'resolve').mockResolvedValue({
      result: [{ metric: 'zec_shielded_supply', asset: 'zec', ts: 1_800_000_000_000 }],
      source: 'pg-history',
      cache: 'miss',
      sources: ['pg-history'],
      perSourceCache: [
        { adapterId: 'platform-explorer', cache: 'hit', ageMs: 30_000 },
        { adapterId: 'pg-history', cache: 'miss' },
      ],
    });

    const outcome = await resolveCapability(registry, 'platform.metrics.history', 'dash', {});

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('expected ok:true');
    expect(outcome.sources).toStrictEqual(['pg-history']);
    expect(outcome.sources).not.toContain('platform-explorer');
    // Fails when `perSourceCache` is (mis)built by walking `sources` instead of forwarded
    // verbatim — such a walk could only ever produce ONE entry (`pg-history`), never two.
    expect(outcome.perSourceCache?.map((entry) => entry.adapterId).sort()).toStrictEqual([
      'pg-history',
      'platform-explorer',
    ]);
    expect(
      outcome.perSourceCache?.find((entry) => entry.adapterId === 'platform-explorer'),
    ).toStrictEqual({ adapterId: 'platform-explorer', cache: 'hit', ageMs: 30_000 });
  });

  // ===========================================================================================
  // Roast round 1, B-2 — every fixture above set the three fields together or not at all, so a
  // mutant gating one field's forwarding on a DIFFERENT field's presence (e.g. `perSourceCache`
  // gated on `resolution.sources !== undefined`) survived the full suite undetected. Each test
  // below isolates exactly ONE field as present with the OTHER TWO genuinely absent, which is what
  // actually distinguishes "forwarded on its own `!== undefined` check" from "forwarded only when
  // a sibling field happens to be set too" — the over-claim this task's own `missingSources`
  // docstring made in prose (`registry.ts`, fixed alongside these tests).
  // ===========================================================================================

  it('cross-field independence (roast round 1, B-2): sources forwards when missingSources/perSourceCache are BOTH absent', async () => {
    const registry = fakeRegistry();
    // Kills a mutant gating `sources` on `resolution.missingSources !== undefined` or on
    // `resolution.perSourceCache !== undefined`. Not a claim this exact combination is reachable
    // from the real merge walk (a contributor implies someone answered, so `perSourceCache` would
    // realistically be non-empty too) — a wrapper-independence probe, same discipline TC-UNIT-01
    // already applies to its synthetic ids.
    vi.spyOn(registry, 'resolve').mockResolvedValue({
      result: [{ metric: 'm', asset: 'a', ts: 1 }],
      source: 'adapter-e',
      cache: 'miss',
      sources: ['adapter-e'],
    });

    const outcome = await resolveCapability(registry, 'platform.metrics.history', 'dash', {});

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('expected ok:true');
    expect(outcome.sources).toStrictEqual(['adapter-e']);
    expect(Object.hasOwn(outcome, 'missingSources')).toBe(false);
    expect(Object.hasOwn(outcome, 'perSourceCache')).toBe(false);
  });

  it('cross-field independence (roast round 1, B-2): missingSources forwards when sources/perSourceCache are BOTH absent', async () => {
    const registry = fakeRegistry();
    // Kills a mutant gating `missingSources` on `resolution.sources !== undefined` — the exact one
    // the roast ran and found surviving — or on `resolution.perSourceCache !== undefined`.
    // Grounded in R-164 branch (a): every ASKED participant answered with zero points (`sources`
    // omitted, R-174d) while a DIFFERENT participant was never asked at all (`missingSources`
    // populated) — a real, not merely synthetic, composition.
    vi.spyOn(registry, 'resolve').mockResolvedValue({
      result: [],
      source: 'adapter-f',
      cache: 'miss',
      missingSources: [{ adapterId: 'adapter-g', reason: 'not asked: chain-scoped skip' }],
    });

    const outcome = await resolveCapability(registry, 'platform.metrics.history', 'dash', {});

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('expected ok:true');
    expect(outcome.missingSources).toStrictEqual([
      { adapterId: 'adapter-g', reason: 'not asked: chain-scoped skip' },
    ]);
    expect(Object.hasOwn(outcome, 'sources')).toBe(false);
    expect(Object.hasOwn(outcome, 'perSourceCache')).toBe(false);
  });

  it('cross-field independence (roast round 1, B-2): perSourceCache forwards when sources/missingSources are BOTH absent', async () => {
    const registry = fakeRegistry();
    // Kills a mutant gating `perSourceCache` on `resolution.sources !== undefined` — the exact one
    // the roast ran and found surviving — or on `resolution.missingSources !== undefined`.
    // Grounded in R-164 branch (a), the same composition `system-architecture.md:947-949` now
    // names explicitly (roast B-4): every participant answered with zero points, so `sources` is
    // correctly omitted (R-174d) while `perSourceCache` still lists every participant that WAS
    // answered — the only surviving record that they were asked at all.
    vi.spyOn(registry, 'resolve').mockResolvedValue({
      result: [],
      source: 'adapter-h',
      cache: 'hit',
      perSourceCache: [
        { adapterId: 'adapter-h', cache: 'hit', ageMs: 60_000 },
        { adapterId: 'adapter-i', cache: 'miss' },
      ],
    });

    const outcome = await resolveCapability(registry, 'platform.metrics.history', 'dash', {});

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('expected ok:true');
    expect(outcome.perSourceCache).toStrictEqual([
      { adapterId: 'adapter-h', cache: 'hit', ageMs: 60_000 },
      { adapterId: 'adapter-i', cache: 'miss' },
    ]);
    expect(Object.hasOwn(outcome, 'sources')).toBe(false);
    expect(Object.hasOwn(outcome, 'missingSources')).toBe(false);
  });

  it('type-test (roast round 1, B-3): ResolveSuccess.perSourceCache[].cache rejects a third literal', () => {
    // R-175(b) forbids widening `cache`'s two-literal type. TC-UNIT-03 only compares RUNTIME values
    // against `['hit', 'miss']` — it cannot fail if the TYPE itself is widened, since nothing there
    // constructs a third-literal value. This is the compile-time proof, the same idiom
    // `capability-manifest.test.ts` uses at TC-UNIT-09: if the `@ts-expect-error` directive below
    // is ever reported "unused" (`tsc --noEmit`, the same command `pnpm typecheck` runs), the union
    // was widened and THIS test fails the gate — not a `vitest` assertion.
    const outcome: ResolveSuccess = {
      ok: true,
      output: null,
      cache: { status: 'miss', provider: 'x', capability: 'y' },
      perSourceCache: [
        // @ts-expect-error roast round 1, B-3: 'stale' is not a member of 'hit' | 'miss' (R-175b).
        { adapterId: 'x', cache: 'stale' },
      ],
    };
    expect(outcome.perSourceCache?.[0]?.adapterId).toBe('x');
  });
});
