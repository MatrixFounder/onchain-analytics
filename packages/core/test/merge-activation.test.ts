import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CapabilityRegistry,
  CapabilityUnavailableError,
  MergeEligibilityNotDeclaredError,
  UnregisteredPolicyClassError,
} from '../src/adapters/registry.js';
import {
  assertMergeParticipantsAreFree,
  type AdapterRegistration,
  type AdapterTier,
  type CapabilityRoute,
  type ProviderAdapter,
} from '../src/adapters/types.js';
import type { PolicyDescriptor } from '../src/adapters/policy.js';
import type { CapabilityManifest } from '../src/capability-manifest.js';

/**
 * Task 013-2 (T-013, R-162/R-163/R-183) — the second activation gate (`CapabilityRoute.merge`) and
 * the two constructor/startup checks around it: `CapabilityRegistry`'s validation step 3
 * (`MergeEligibilityNotDeclaredError`) and the free-standing `assertMergeParticipantsAreFree`.
 *
 * **Methodology `tdd-stub-first` (PLAN §0.9 — 013-2 is not one of the three `tdd-strict` tasks).**
 * Every TC-INT/TC-UNIT case below was authored against Phase 1 stubs — step 3's loop that never
 * throws, `assertMergeParticipantsAreFree`'s body that never throws — and the red run against that
 * tree is captured verbatim in `packages/core/.AGENTS.md`'s `## T-013 task 013-2` entry (there is no
 * `docs/reports/` in this project; that entry is the durable record, per the 013-1 precedent).
 *
 * **Two independent mechanisms, two describe groups.** Step 3 (`CapabilityRegistry`'s constructor)
 * refuses to BUILD a registry when a route activates merging for a capability whose manifest never
 * declared eligibility. `assertMergeParticipantsAreFree` is a SEPARATE, free-standing function that
 * refuses PROCESS START when a merged capability's participants are not all `tier: 'free'` — kept
 * out of the constructor on purpose (PLAN §0.7) so `013-4`'s own merge-walk test can build a
 * registry around a route that pairs a free and a paid adapter, to observe walk ORDER.
 */

// =================================================================================================
// Shared fixtures
// =================================================================================================

interface MakeAdapterOpts {
  id: string;
  isAvailable?: () => { ok: true } | { ok: false; reason: string };
}

/** A minimal `ProviderAdapter` — no `chainSupport` declared, so every chain is covered (the
 * `registry.test.ts`/`registry.deadline.test.ts` precedent: an adapter that omits it is treated as
 * not chain-bound). */
function makeAdapter(opts: MakeAdapterOpts): ProviderAdapter {
  return {
    id: opts.id,
    capabilities: () => [],
    costOf: () => ({ credits: 0 }),
    fetch: async () => ({ raw: true, from: opts.id }),
    normalize: (_cap: string, raw: unknown) => raw,
    ...(opts.isAvailable ? { isAvailable: opts.isAvailable } : {}),
  };
}

function makeRegistration(id: string, tier: AdapterTier): AdapterRegistration {
  return {
    id,
    hosts: [],
    rateLimit: { capacity: 1, refillPerSec: 1 },
    requiresEnv: [],
    tier,
    trust: 'authoritative',
  };
}

const CHAIN = 'ethereum';

// =================================================================================================
// CapabilityRegistry constructor — validation step 3 (MergeEligibilityNotDeclaredError)
// =================================================================================================

describe('TC-INT-01 — merge activated on a point-shaped (ineligible) capability fails construction', () => {
  it('throws MergeEligibilityNotDeclaredError naming the capability and the missing eligibility', () => {
    const routes: CapabilityRoute[] = [{ capability: 'x', adapterIds: ['a'], merge: true }];
    // A decoy row ('aaa', alphabetically BEFORE 'x') that IS eligible — present so a step 3
    // implementation that reads the wrong manifest row (e.g. a hardcoded key, or the first key in
    // the object) would find eligibility and wrongly NOT throw. This is the "fails when step 3
    // reads the wrong manifest row" case the task file names.
    const manifests: Readonly<Record<string, CapabilityManifest>> = {
      aaa: { shape: 'series', ttlSeconds: 60, deadlineMs: 1_000, mergeable: true, shareable: true },
      x: { shape: 'point', ttlSeconds: 60, deadlineMs: 1_000, shareable: true },
    };
    const adapters = new Map<string, ProviderAdapter>([['a', makeAdapter({ id: 'a' })]]);

    let thrown: unknown;
    try {
      new CapabilityRegistry(routes, adapters, undefined, null, manifests);
      expect.unreachable('a route activating merge for an ineligible capability must not build');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(MergeEligibilityNotDeclaredError);
    expect((thrown as MergeEligibilityNotDeclaredError).capability).toBe('x');
    expect((thrown as Error).message).toContain('x');
    expect((thrown as Error).message).toMatch(/mergeable|eligib/i);
  });

  it('throws on the PRIMARY negative case: a series manifest that simply omits mergeable (kills the shape-only mutant)', () => {
    // R-183/UC-20's realistic instance, not an exotic one: `mergeable` is OPTIONAL on the `set |
    // series` branch (013-1), so "series row with no mergeable at all" is the DEFAULT state of
    // every new series capability — not the `point` case above, which a `manifest.shape !== 'point'`
    // check alone would already catch. A mutant that drops the `'mergeable' in manifest &&
    // manifest.mergeable === true` half of step 3's condition (keeping only the shape check) passes
    // every OTHER fixture in this file and is caught ONLY here.
    const routes: CapabilityRoute[] = [{ capability: 'x', adapterIds: ['a'], merge: true }];
    const manifests: Readonly<Record<string, CapabilityManifest>> = {
      x: { shape: 'series', ttlSeconds: 60, deadlineMs: 1_000, shareable: true }, // no `mergeable` field at all
    };
    const adapters = new Map<string, ProviderAdapter>([['a', makeAdapter({ id: 'a' })]]);

    let thrown: unknown;
    try {
      new CapabilityRegistry(routes, adapters, undefined, null, manifests);
      expect.unreachable('a series capability with no declared eligibility must not build');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(MergeEligibilityNotDeclaredError);
  });

  it('throws on a cast-borne point row carrying a stray mergeable: true (kills the mergeable-only mutant)', () => {
    // The mirror case: a mutant that drops `manifest.shape !== 'point'` (keeping only the
    // `'mergeable' in manifest && manifest.mergeable === true` half) passes every OTHER fixture and
    // is caught ONLY here — a manifest that arrives through a cast (L-2, review round 1) can carry
    // BOTH `shape: 'point'` and a stray `mergeable: true` at once, a combination the type system
    // forbids for a literal but not for a runtime-injected value.
    const routes: CapabilityRoute[] = [{ capability: 'x', adapterIds: ['a'], merge: true }];
    const manifests: Readonly<Record<string, CapabilityManifest>> = {
      x: {
        shape: 'point',
        ttlSeconds: 60,
        deadlineMs: 1_000,
        shareable: true,
        mergeable: true,
      } as unknown as CapabilityManifest,
    };
    const adapters = new Map<string, ProviderAdapter>([['a', makeAdapter({ id: 'a' })]]);

    let thrown: unknown;
    try {
      new CapabilityRegistry(routes, adapters, undefined, null, manifests);
      expect.unreachable('a cast-borne point row must not become eligible via a stray field');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(MergeEligibilityNotDeclaredError);
  });
});

describe('TC-INT-02 — merge activated on an eligible series capability constructs (positive control)', () => {
  it('does not throw when the manifest row declares mergeable: true', () => {
    const routes: CapabilityRoute[] = [{ capability: 'x', adapterIds: ['a'], merge: true }];
    const manifests: Readonly<Record<string, CapabilityManifest>> = {
      x: { shape: 'series', ttlSeconds: 60, deadlineMs: 1_000, mergeable: true, shareable: true },
    };
    const adapters = new Map<string, ProviderAdapter>([['a', makeAdapter({ id: 'a' })]]);

    expect(
      () => new CapabilityRegistry(routes, adapters, undefined, null, manifests),
    ).not.toThrow();
  });
});

describe('TC-INT-03 — no merge, no eligibility: step 3 is inert on an unactivated route', () => {
  it('constructs when the route never sets merge at all', () => {
    const routes: CapabilityRoute[] = [{ capability: 'x', adapterIds: ['a'] }];
    const manifests: Readonly<Record<string, CapabilityManifest>> = {
      x: { shape: 'point', ttlSeconds: 60, deadlineMs: 1_000, shareable: true },
    };
    const adapters = new Map<string, ProviderAdapter>([['a', makeAdapter({ id: 'a' })]]);

    expect(
      () => new CapabilityRegistry(routes, adapters, undefined, null, manifests),
    ).not.toThrow();
  });
});

describe('TC-INT-04 — step 2s loop precedes step 3s loop across ALL routes, not just within one', () => {
  /** A `kind` no class implements — the shape a cast, a JSON config or a hand edit can produce
   * (same idiom as `policy.test.ts`'s `BOGUS_POLICY`). */
  const BOGUS_POLICY = { kind: 'not-a-real-policy-class' } as unknown as PolicyDescriptor;

  it('throws UnregisteredPolicyClassError from route #2, even though route #1 (earlier, merge-broken only) never sets a policy at all', () => {
    // TWO routes, each broken on a DIFFERENT single axis — not one route broken on both. A single
    // route broken on both axes cannot tell "three separate loops over ALL routes" apart from "one
    // merged loop checking policy-then-merge PER ROUTE": either shape reaches the SAME route's
    // policy check before its merge check and reports the identical error. This fixture can: a
    // merged per-route implementation would reach route #1 first, find its policy fine (absent) but
    // its merge INELIGIBLE, and throw `MergeEligibilityNotDeclaredError` right there — never even
    // reaching route #2. The real two-loop implementation scans ALL routes for step 2 first, so it
    // reaches route #2's bogus policy before step 3's loop starts at all.
    const routes: CapabilityRoute[] = [
      { capability: 'p', adapterIds: ['a'], merge: true }, // broken ONLY on merge (no eligibility)
      { capability: 'q', adapterIds: ['b'], policy: BOGUS_POLICY }, // broken ONLY on policy
    ];
    const manifests: Readonly<Record<string, CapabilityManifest>> = {
      p: { shape: 'point', ttlSeconds: 60, deadlineMs: 1_000, shareable: true }, // no `mergeable` — ineligible
      q: { shape: 'point', ttlSeconds: 60, deadlineMs: 1_000, shareable: true }, // unrelated to route #2's failure
    };
    const adapters = new Map<string, ProviderAdapter>([
      ['a', makeAdapter({ id: 'a' })],
      ['b', makeAdapter({ id: 'b' })],
    ]);

    let thrown: unknown;
    try {
      new CapabilityRegistry(routes, adapters, undefined, null, manifests);
      expect.unreachable(
        'two routes, each broken on a different axis, must still fail construction',
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(UnregisteredPolicyClassError);
    expect(thrown).not.toBeInstanceOf(MergeEligibilityNotDeclaredError);
  });
});

// =================================================================================================
// assertMergeParticipantsAreFree — the startup-time free-participant gate
// =================================================================================================

describe('TC-UNIT-01 — a paid participant reachable through the union of a merging capabilitys routes throws', () => {
  it('names the capability and the paid adapter; fails when the check reads one routes adapterIds instead of the union', () => {
    // 'paid1' sits on a SIBLING route that does not itself carry `merge: true` — reachable only
    // through the UNION of capability 'y's routes. A naive per-route implementation (checking only
    // the merge-flagged route's own `adapterIds`) would see only 'free1' and never look at this
    // route at all, so it would wrongly NOT throw here.
    const routes: CapabilityRoute[] = [
      { capability: 'y', adapterIds: ['free1'], merge: true },
      { capability: 'y', adapterIds: ['paid1'] },
    ];
    const registrations: AdapterRegistration[] = [
      makeRegistration('free1', 'free'),
      makeRegistration('paid1', 'paid'),
    ];

    let thrown: unknown;
    try {
      assertMergeParticipantsAreFree(routes, registrations);
      expect.unreachable('a paid participant reachable via a sibling route must fail the gate');
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toContain('y');
    expect((thrown as Error).message).toContain('paid1');
  });

  it('a duplicate registration id is FAIL-CLOSED: any registration marking it paid makes it paid, regardless of order', () => {
    // Two registrations share id 'dup': one 'free', one 'paid'. Neither "first wins" nor "last
    // wins" is fail-closed (each lets the OTHER order through a paid participant unnoticed) — only
    // "sticky non-free" is order-independent. Both orderings are asserted so a regression to either
    // order-dependent variant is caught regardless of which one it reintroduces.
    //
    // `.toThrow(/participant 'dup'/)`, not `.toThrow(/dup/)` (review round 2, LOW-2): the error
    // message's own boilerplate contains the word "de**dup**", so a bare `/dup/` matches ANY throw
    // from this function, including one whose reason has nothing to do with the id 'dup' at all —
    // the assertion would have passed even if the function threw for a completely wrong cause.
    const routes: CapabilityRoute[] = [{ capability: 'z', adapterIds: ['dup'], merge: true }];

    expect(() =>
      assertMergeParticipantsAreFree(routes, [
        makeRegistration('dup', 'free'),
        makeRegistration('dup', 'paid'),
      ]),
    ).toThrow(/participant 'dup'/);

    expect(() =>
      assertMergeParticipantsAreFree(routes, [
        makeRegistration('dup', 'paid'),
        makeRegistration('dup', 'free'),
      ]),
    ).toThrow(/participant 'dup'/);
  });

  it('a duplicate registration id with a THIRD, cast-borne tier value is also sticky-non-free, in both orders (review round 2, LOW-1)', () => {
    // `AdapterTier` is `'free' | 'paid'` at the type level, but this function reads a
    // runtime-assembled array, so a stray third value can arrive via a cast. The rejected
    // `known === 'paid'` version let a `'trial'`-tagged copy be silently overwritten back to
    // `'free'` whenever the `'free'` copy sorted LAST; `known !== 'free'` does not, because it
    // never asks what the sticky value IS, only whether it has been confirmed `'free'`.
    const routes: CapabilityRoute[] = [{ capability: 'z', adapterIds: ['dup'], merge: true }];
    const trial = { ...makeRegistration('dup', 'free'), tier: 'trial' as AdapterTier };

    expect(() =>
      assertMergeParticipantsAreFree(routes, [trial, makeRegistration('dup', 'free')]),
    ).toThrow(/participant 'dup'/);

    expect(() =>
      assertMergeParticipantsAreFree(routes, [makeRegistration('dup', 'free'), trial]),
    ).toThrow(/participant 'dup'/);
  });

  it('a duplicate registration whose tier key is ABSENT is sticky-non-free in both orders (roast round 3)', () => {
    // The third arrival shape, and the one the cast/JSON threat model actually produces most often:
    // not a stray VALUE but a missing KEY. It stores `undefined`, which a guard phrased
    // `known !== undefined && known !== 'free'` reads as "nothing known yet" — so a later
    // genuinely-`'free'` copy un-stuck it and `[no-tier, free]` PASSED while `[free, no-tier]`
    // threw. Order decided the verdict, which is the exact property stickiness exists to remove.
    //
    // Fails when the normalisation at the point of storage (`registration.tier ?? 'undeclared'`)
    // is dropped — the first `expect` below is the one that goes green, i.e. the hole reopens
    // silently in one direction only. That asymmetry is why both orders are asserted here.
    const routes: CapabilityRoute[] = [{ capability: 'z', adapterIds: ['dup'], merge: true }];
    const withTier: Record<string, unknown> = { ...makeRegistration('dup', 'free') };
    delete withTier['tier'];
    const absent = withTier as unknown as AdapterRegistration;

    expect(() =>
      assertMergeParticipantsAreFree(routes, [absent, makeRegistration('dup', 'free')]),
    ).toThrow(/participant 'dup'/);

    expect(() =>
      assertMergeParticipantsAreFree(routes, [makeRegistration('dup', 'free'), absent]),
    ).toThrow(/participant 'dup'/);
  });
});

describe('TC-UNIT-02 — a test pair equivalent to production passes silently', () => {
  it('does not throw for a merged route whose two real-shaped participants are both tier: free', () => {
    // Mirrors what 013-6 ships for `platform.metrics.history`/`privacy.shielded_pool.history`:
    // ONE route, `adapterIds: ['platform-explorer', 'pg-history']`, both real registrations
    // `tier: 'free'` (providers.config.ts). Built as a local, minimal pair — not an import of
    // `providers.config.ts` — so this test does not depend on 013-6 having landed.
    const routes: CapabilityRoute[] = [
      {
        capability: 'platform.metrics.history',
        adapterIds: ['platform-explorer', 'pg-history'],
        merge: true,
      },
    ];
    const registrations: AdapterRegistration[] = [
      makeRegistration('platform-explorer', 'free'),
      makeRegistration('pg-history', 'free'),
    ];

    expect(() => assertMergeParticipantsAreFree(routes, registrations)).not.toThrow();
  });

  it('stays silent on the real, unmodified providers.config.ts (regression)', async () => {
    // No shipped route carries `merge: true` before 013-6, so this call is a no-op today — the
    // regression this case pins is that calling the real check against the real tables never
    // throws, not that it exercises the union logic (TC-UNIT-01 already does).
    const { routes: realRoutes, adapterRegistrations: realRegistrations } =
      await import('../src/providers.config.js');
    expect(() => assertMergeParticipantsAreFree(realRoutes, realRegistrations)).not.toThrow();
  });
});

describe('TC-UNIT-03 — rank: plan for a merging capability equals the routes adapterIds, in order', () => {
  it('walks adapters in adapterIds order — no separate rank table exists in the tree', async () => {
    const ids = ['first', 'second', 'third'];
    const routes: CapabilityRoute[] = [{ capability: 'x', adapterIds: ids, merge: true }];
    const manifests: Readonly<Record<string, CapabilityManifest>> = {
      x: { shape: 'series', ttlSeconds: 60, deadlineMs: 5_000, mergeable: true, shareable: true },
    };
    // Every adapter refuses availability — no network, no cache — so the ONLY thing under test is
    // the walk ORDER `resolve()` already builds into `plan` from `route.adapterIds` (unmodified by
    // this task; the merge WALK itself is 013-4). This is the un-modified pre-existing mechanism
    // `CapabilityRoute.merge`'s docstring says the merge conflict rank reuses.
    //
    // **Observed via `isAvailable()` CALL ORDER, independently of what the walk finally does with
    // the result (013-4 correction, then again in its roast fix pass).** Before 013-4, `resolve()`
    // did not read `route.merge` at all, so this all-unavailable fixture fell through the
    // single-winner walk and threw `CapabilityUnavailableError`, whose `tried[]` doubled as an
    // order probe. 013-4 first made a `merge: true` route return an empty merged SUCCESS here — and
    // the roast (B1/F-1) showed that success carried `source: ''`, violating AC-47 ("никогда не
    // пустая строка"), which `docs/PLAN.md` assigns to 013-4 and not to 013-5. The merge walk now
    // throws when NOBODY answered, so this fixture throws again — for a different reason than it
    // originally did, and from a different branch.
    //
    // Recording call order directly (the way `registry.merge.test.ts`'s TC-INT-08 does) is what
    // makes this test survive all three of those outcomes: the claim it exists to pin — plan order
    // equals `adapterIds` order — never depended on which of them was current. Reading order off a
    // thrown error's `tried[]` would have broken twice by now.
    const callOrder: string[] = [];
    const adapters = new Map<string, ProviderAdapter>(
      ids.map((id) => [
        id,
        makeAdapter({
          id,
          isAvailable: () => {
            callOrder.push(id);
            return { ok: false, reason: 'stub: no live transport' };
          },
        }),
      ]),
    );
    const registry = new CapabilityRegistry(routes, adapters, undefined, null, manifests);

    // Nobody answers, so the merge walk refuses rather than publishing `source: ''` (B1/AC-47).
    // Asserted as a THROW, not swallowed: a test that tolerated either outcome would go green
    // again the day the refusal is accidentally removed.
    await expect(registry.resolve('x', CHAIN, {})).rejects.toBeInstanceOf(
      CapabilityUnavailableError,
    );

    // The actual claim of this test, and the reason it is written against `callOrder` rather than
    // against the error: rank order is `adapterIds` order, whatever the walk decides afterwards.
    expect(callOrder).toEqual(ids);
  });
});

describe('an empty adapterIds on a merge-activated route is not rejected by any check — pinned, not assumed', () => {
  // R-163(b)'s constructive argument does NOT need — and this tree does not have — a check that
  // rejects an empty `adapterIds` (measured: no such check exists anywhere under `packages/`). The
  // argument holds without one: every PARTICIPANT is an element of `adapterIds`, so it has an
  // index, so it has a rank; zero participants is the case where that claim is vacuously true, not
  // a case a rejection needs to guard. This test pins the actual (permissive) behaviour of both
  // mechanisms rather than leaving it undocumented.
  it('CapabilityRegistry step 3 does not read adapterIds at all — an eligible manifest still constructs', () => {
    const routes: CapabilityRoute[] = [{ capability: 'x', adapterIds: [], merge: true }];
    const manifests: Readonly<Record<string, CapabilityManifest>> = {
      x: { shape: 'series', ttlSeconds: 60, deadlineMs: 1_000, mergeable: true, shareable: true },
    };
    expect(
      () => new CapabilityRegistry(routes, new Map(), undefined, null, manifests),
    ).not.toThrow();
  });

  it('assertMergeParticipantsAreFree passes vacuously — zero participants, zero iterations', () => {
    const routes: CapabilityRoute[] = [{ capability: 'x', adapterIds: [], merge: true }];
    expect(() => assertMergeParticipantsAreFree(routes, [])).not.toThrow();
  });
});

// =================================================================================================
// TC-GATE-01 — no source under packages/{core,mcp-server}/src ever reads `onchain.metrics.
// source_priority` (by grepping for the literal string itself, R-151(e)/R-155(d) precedent).
// =================================================================================================

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const GATE_ROOTS = ['packages/core/src', 'packages/mcp-server/src'];
const BANNED_STRING = 'source_priority';

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else {
      out.push(full);
    }
  }
  return out;
}

describe('TC-GATE-01 — `source_priority` does not appear in either src tree', () => {
  it('finds zero occurrences across packages/core/src and packages/mcp-server/src', () => {
    const offenders: string[] = [];
    for (const root of GATE_ROOTS) {
      for (const file of walk(path.join(repoRoot, root))) {
        if (readFileSync(file, 'utf8').includes(BANNED_STRING)) {
          offenders.push(path.relative(repoRoot, file));
        }
      }
    }
    // Naming the files matters: a gate that only counts is a gate a reader cannot act on.
    expect(offenders).toEqual([]);
  });

  it("the guard actually detects one (`tier-single-source.test.ts`'s own stated rule for a detector)", () => {
    // A PERMANENT positive control, not a one-off manual mutation — the same `walk()`, pointed at
    // `packages/core/test` instead of the two `src` roots. That directory holds the literal
    // `BANNED_STRING` right here in this file (its own `const` declaration, plus this sentence),
    // so the detector must find at least one hit — proving it can fire at all, the way
    // `source-is-greppable.test.ts`'s NUL-byte guard and `tier-single-source.test.ts`'s own scanner
    // each carry a positive case beside their negative one ("a detector without one can be added
    // dead"). Free: no injection, no revert, nothing to keep in sync by hand.
    const testRoot = path.join(repoRoot, 'packages/core/test');
    const offenders = walk(testRoot).filter((file) =>
      readFileSync(file, 'utf8').includes(BANNED_STRING),
    );
    expect(offenders.length).toBeGreaterThanOrEqual(1);
  });
});
