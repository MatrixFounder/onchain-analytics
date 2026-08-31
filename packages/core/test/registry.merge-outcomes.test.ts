import { describe, expect, it, vi } from 'vitest';
import type { CacheGetResult, CacheStore } from '../src/adapters/cache-store.js';
import {
  CapabilityDeadlineExceededError,
  CapabilityRegistry,
  CapabilityUnavailableError,
  type CapabilityResolution,
} from '../src/adapters/registry.js';
import type { CapabilityRoute, ProviderAdapter } from '../src/adapters/types.js';
import type { CapabilityManifest } from '../src/capability-manifest.js';
import { DASH_METRIC, DASH_PLATFORM_ASSET } from '../src/adapters/dash-metrics.js';
import { deriveArgsHash } from '../src/net/args-hash.js';
import { DeadlineExceededError } from '../src/net/safe-fetch.js';
import { DeadlineWouldExceedError } from '../src/net/rate-limit.js';

/**
 * Task 013-5 (T-013, R-164/R-176) — the merge walk's TERMINAL OUTCOME CONTRACT: three participant
 * states, four branches, and the deadline as a PRECONDITION on all four rather than a fifth branch.
 *
 * **Its own file, not an addition to `registry.merge.test.ts`** (PLAN §0.4's file-ownership rule
 * applied one level down): 013-4 owns the loop BODY and its test file; this task owns the code
 * AFTER the loop, so it owns a file after it.
 *
 * **Methodology `tdd-strict` (PLAN §0.9) — and this file's honest position in that cycle.** The
 * named risk for 013-5 is: "тест, зеленеющий из-за порядка адаптеров, а не из-за контракта исходов,
 * неотличим от рабочего". A branch-(b) case whose second participant simply happens to be walked
 * second proves nothing about the contract. Two things are done about that here, and neither is an
 * argument:
 *
 * 1. Every case below states the MUTATION that kills it (`KILLED_BY:`), naming the exact line of
 *    `registry.ts` to delete or invert. The mutation runs are recorded in `packages/core/.AGENTS.md`
 *    under `## T-013 task 013-5`.
 * 2. Where a case can be satisfied by walk order alone, the composition is chosen so that it cannot
 *    be: TC-INT-03 puts the FAILING participant FIRST (a walk that stops at the first failure
 *    returns the wrong outcome), and TC-INT-06/07 put the DEFEATED participant SECOND after a
 *    participant that already answered non-empty (a walk that published what it already had would
 *    return a success, which is exactly the OD-4 defect).
 *
 * **Honest gap, stated rather than reconstructed.** The implementation of the outcome contract
 * landed in the working tree BEFORE this file existed (the task was resumed from an interrupted
 * run; the code was already present at `681e372`'s tree + uncommitted changes). So these cases were
 * NOT run against a phase-1 skeleton, and no such red transcript exists. The substitute is stronger
 * than the missing one and is what was actually executed: each case was driven red by REMOVING the
 * production line it pins (the `KILLED_BY:` mutation), the failure was recorded, and the mutation
 * was reverted. A red-first run proves a test can fail; a targeted mutation proves it fails FOR THE
 * STATED REASON. `packages/core/.AGENTS.md` says the same thing in the same words.
 *
 * **Clocks.** Same mechanism as `registry.deadline.test.ts`, for the same reason (no injectable
 * clock in `CapabilityRegistry`; PLAN §0.3 fixes the seam count): a fake adapter that BURNS wall
 * clock synchronously against a manifest deadline of a few tens of milliseconds, with the two
 * numbers kept at least 2x apart and no yield inside the burn.
 */

/** Burns `ms` of wall clock WITHOUT yielding — the `registry.deadline.test.ts` precedent verbatim.
 * Yielding would make "the deadline passed during participant A" a scheduling coin flip. */
function blockFor(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    /* spin — see the docstring */
  }
}

const CHAIN = 'ethereum';
/** A synthetic merge-eligible capability. Synthetic because the manifest is INJECTED: the two real
 * merge rows carry `deadlineMs: 30_000`, and a case that has to wait 30 s to observe an expiry is a
 * case nobody runs. */
const CAP = 'test.merge.outcomes';

function manifestsFor(deadlineMs = 30_000): Readonly<Record<string, CapabilityManifest>> {
  return {
    [CAP]: { shape: 'series', ttlSeconds: 60, deadlineMs, mergeable: true, shareable: true },
  };
}

/** One canonical-shaped point — the same field names `types/snapshot.ts`'s `Snapshot` uses, and the
 * same helper shape `registry.merge.test.ts` uses, so the two files' fixtures stay comparable. */
function point(metric: string, ts: number, extra: Record<string, unknown> = {}): MergeFixturePoint {
  return { metric, asset: DASH_PLATFORM_ASSET, ts, valueRaw: '1', source: 'mock', ...extra };
}

interface MergeFixturePoint {
  metric: string;
  asset: string;
  ts: number;
  valueRaw: string;
  source: string;
  [key: string]: unknown;
}

const TS = 1_700_000_000_000;

interface MockAdapterOpts {
  id: string;
  isAvailable?: () => { ok: true } | { ok: false; reason: string };
  chainSupport?: ProviderAdapter['chainSupport'];
  /** Returned unchanged by `normalize()` — these fixtures already ARE canonical points. */
  points?: unknown[];
  /** Replaces `points` entirely: throws, burns clock, or returns something else. */
  fetchImpl?: () => Promise<unknown>;
}

function makeAdapter(opts: MockAdapterOpts): ProviderAdapter & { fetch: ReturnType<typeof vi.fn> } {
  return {
    id: opts.id,
    capabilities: () => [],
    costOf: () => ({ credits: 0 }),
    fetch: vi.fn(async (): Promise<unknown> => {
      if (opts.fetchImpl) return opts.fetchImpl();
      return opts.points ?? [];
    }),
    normalize: (_cap: string, raw: unknown) => raw,
    ...(opts.isAvailable ? { isAvailable: opts.isAvailable } : {}),
    ...(opts.chainSupport ? { chainSupport: opts.chainSupport } : {}),
  };
}

class FakeCacheStore implements CacheStore {
  readonly setCalls: string[] = [];

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

  async set(provider: string): Promise<void> {
    this.setCalls.push(provider);
  }
}

/** Builds a MERGE-enabled registry over `adapters`, in the order given — which is also rank order
 * (PLAN §0.5 item 2: rank = `adapterIds` order = spend order). */
function buildMergeRegistry(opts: {
  adapters: ProviderAdapter[];
  deadlineMs?: number;
  cache?: CacheStore;
}): CapabilityRegistry {
  const route: CapabilityRoute = {
    capability: CAP,
    adapterIds: opts.adapters.map((adapter) => adapter.id),
    merge: true,
  };
  return new CapabilityRegistry(
    [route],
    new Map(opts.adapters.map((adapter) => [adapter.id, adapter])),
    opts.cache,
    // `null` = the shipped chain registry, exactly as production wires it, so GATE 2 resolves
    // `ethereum` through the real coverage matrix rather than a bypass.
    null,
    manifestsFor(opts.deadlineMs),
  );
}

/**
 * Settles a `resolve()` into a shape that can distinguish a RETURN from a THROW — lifted verbatim
 * from `registry.deadline.test.ts` for the reason stated there, which is this task's reason too:
 * the defect R-164(c)/(e) exists to prevent is a truthful-but-partial answer being RETURNED where
 * the honest outcome is a throw. `.rejects` proves the promise rejected; it cannot state that no
 * `CapabilityResolution` was produced in any form.
 */
async function outcomeOf(
  pending: Promise<CapabilityResolution>,
): Promise<{ returned: CapabilityResolution } | { thrown: unknown }> {
  return pending.then(
    (returned) => ({ returned }),
    (thrown: unknown) => ({ thrown }),
  );
}

function thrownOf(outcome: { returned: CapabilityResolution } | { thrown: unknown }): unknown {
  expect('thrown' in outcome).toBe(true);
  return (outcome as { thrown: unknown }).thrown;
}

function returnedOf(
  outcome: { returned: CapabilityResolution } | { thrown: unknown },
): CapabilityResolution {
  expect('returned' in outcome).toBe(true);
  return (outcome as { returned: CapabilityResolution }).returned;
}

// =================================================================================================
// The four branches (R-164 a-d, AC-27, AC-41)
// =================================================================================================

describe('branch (a) — every participant answered', () => {
  /**
   * TC-INT-01 (UC-14, R-164(a)). Both participants were really asked and both really answered; the
   * window is genuinely empty. An empty array here is a FACT ABOUT THE DATA, and the caller must be
   * able to read it as one — the opposite failure from UC-19's.
   *
   * `missingSources` absent, not `[]`: the positive-only idiom every optional field on
   * `CapabilityResolution` follows. A reader must not have to distinguish "nobody was missing" from
   * "the field forgot to mention who".
   *
   * KILLED_BY: making the branch-(c) throw fire on `contributors.size === 0` alone (dropping the
   * `missing.length > 0` conjunct) — this empty-but-complete walk would then throw.
   */
  it('TC-INT-01: both answered, window empty → empty SUCCESS, no missingSources', async () => {
    const first = makeAdapter({ id: 'first', points: [] });
    const second = makeAdapter({ id: 'second', points: [] });
    const registry = buildMergeRegistry({ adapters: [first, second] });

    const outcome = await outcomeOf(registry.resolve(CAP, CHAIN, {}));

    const resolution = returnedOf(outcome);
    expect(resolution.result).toEqual([]);
    expect(resolution.missingSources).toBeUndefined();
    // Both were asked — the statement that makes the empty array a fact about the window rather
    // than about our own reach.
    expect(resolution.attempted).toEqual(['first', 'second']);
    // AC-47: `source` is never '' while anyone answered, even with zero points contributed.
    expect(resolution.source).toBe('first');
    expect(resolution.sources).toBeUndefined();
  });
});

describe('branch (b) — someone answered non-empty, someone is missing', () => {
  /**
   * TC-INT-02 (UC-12, R-164(b)). The shipped composition when `ONCHAIN_PG_URL` is unset:
   * `pg-history.isAvailable()` says `{ok:false}` and the participant is NEVER ASKED, while
   * `platform-explorer` answers a real series. Degrading to one source is the required behaviour —
   * and losing the fact that the other was never asked is the defect.
   *
   * KILLED_BY: deleting the `missingSources` construction (the field goes `undefined` and the
   * `toEqual` on it fails), or filtering `'unavailable'` out of `missing`.
   */
  it('TC-INT-02: an unavailable participant is named in missingSources, the answer still succeeds', async () => {
    const answered = point(DASH_METRIC.identitiesTotal, TS);
    const first = makeAdapter({ id: 'first', points: [answered] });
    const second = makeAdapter({
      id: 'second',
      isAvailable: () => ({ ok: false, reason: 'ONCHAIN_PG_URL is not configured' }),
    });
    const registry = buildMergeRegistry({ adapters: [first, second] });

    const outcome = await outcomeOf(registry.resolve(CAP, CHAIN, {}));

    const resolution = returnedOf(outcome);
    expect(resolution.result).toEqual([answered]);
    expect(resolution.sources).toEqual(['first']);
    expect(resolution.missingSources).toEqual([
      { adapterId: 'second', reason: 'ONCHAIN_PG_URL is not configured' },
    ]);
    // "Never asked" is the whole point of this composition: it must be absent from `attempted`.
    expect(resolution.attempted).toEqual(['first']);
  });

  /**
   * TC-INT-03 (UC-21, R-164(b)) — the most likely production composition, and the one a walk-order
   * accident cannot fake. `platform-explorer.pshenmic.dev` is a community host with no SLA, so the
   * realistic shape is "the FIRST participant was asked and blew up, the second answered".
   *
   * The failing participant is deliberately FIRST: a walk that ended at the first failure, or one
   * that classified only never-asked participants as missing, returns a different outcome here —
   * an error in the first case, a success with no `missingSources` in the second.
   *
   * KILLED_BY: removing `skipped.push({ adapterId, kind: 'failed' })` from the `fetch()` catch —
   * the participant then vanishes from `missingSources` and is published as if it never existed.
   */
  it('TC-INT-03: a participant that was ASKED and threw is named in missingSources', async () => {
    const answered = point(DASH_METRIC.identitiesTotal, TS);
    const first = makeAdapter({
      id: 'first',
      fetchImpl: async () => {
        throw new Error('500 Internal Server Error from platform-explorer');
      },
    });
    const second = makeAdapter({ id: 'second', points: [answered] });
    const registry = buildMergeRegistry({ adapters: [first, second] });

    const outcome = await outcomeOf(registry.resolve(CAP, CHAIN, {}));

    const resolution = returnedOf(outcome);
    expect(resolution.result).toEqual([answered]);
    expect(resolution.sources).toEqual(['second']);
    expect(resolution.missingSources).toEqual([
      { adapterId: 'first', reason: '500 Internal Server Error from platform-explorer' },
    ]);
    // R-176(b)/AC-37: "asked and did not answer" is in BOTH arrays at once — `attempted` is written
    // before `fetch()` is entered, `missingSources` after it failed.
    expect(resolution.attempted).toEqual(['first', 'second']);
  });
});

describe('branch (c)/(d) — nobody contributed and someone is missing', () => {
  /**
   * TC-INT-04 (UC-19, R-164(c), AC-41) — THE new decision of this task, and the one §1.5 of
   * `docs/TASK.md` records as a deviation from D5's literal text.
   *
   * The single participant that WAS asked answered honestly with nothing; the participant holding
   * OUR OWN ledger was never asked at all. Publishing `result: []` here says "there is no history".
   * That is a different statement from "the source that would know was not asked", and only the
   * throw tells them apart.
   *
   * `tried` names BOTH — the task file's own words. The never-asked one is named by the loop; the
   * answered-with-nothing one is named by the branch-(c) throw itself, which is where that fact
   * first becomes worth reporting (on branches (a)/(b) an empty answer is unremarkable).
   *
   * KILLED_BY: deleting the branch-(c) throw — the walk returns an empty success and
   * `'thrown' in outcome` fails.
   */
  it('TC-INT-04: the only asked participant answered empty, the other was never asked → UNAVAILABLE', async () => {
    const first = makeAdapter({ id: 'first', points: [] });
    const second = makeAdapter({
      id: 'second',
      isAvailable: () => ({ ok: false, reason: 'ONCHAIN_PG_URL is not configured' }),
    });
    const registry = buildMergeRegistry({ adapters: [first, second] });

    const outcome = await outcomeOf(registry.resolve(CAP, CHAIN, {}));

    const thrown = thrownOf(outcome);
    expect(thrown).toBeInstanceOf(CapabilityUnavailableError);
    // Not a deadline: nothing here ran out of OUR time, and the advice to the caller differs.
    expect(thrown).not.toBeInstanceOf(CapabilityDeadlineExceededError);
    const tried = (thrown as CapabilityUnavailableError).tried;
    expect(tried.map((entry) => entry.adapterId).sort()).toEqual(['first', 'second']);
    expect(tried.find((entry) => entry.adapterId === 'second')?.reason).toBe(
      'ONCHAIN_PG_URL is not configured',
    );
    expect(tried.find((entry) => entry.adapterId === 'first')?.reason).toContain('zero points');
  });

  /**
   * TC-INT-05 (UC-13, R-164(d)) — the named special case of (c): NOBODY answered at all. Split out
   * from (c) because the two reach the same class by different routes, and a single test covering
   * both would not notice if one of them started returning a hollow success with `source: ''`.
   *
   * KILLED_BY: **neither throw alone — only both together**, and that is a MEASURED fact, not the
   * claim this docstring originally made. Deleting the `perSourceCache.length === 0` throw (B-1)
   * left this case GREEN on the first mutation run, because "two unavailable participants" reaches
   * branch (c) as well (`missing.length > 0 && contributors.size === 0`); deleting branch (c) alone
   * leaves B-1 catching it, symmetrically. So this case pins the OUTCOME, not either mechanism —
   * which is why TC-INT-05b below exists to pin B-1 on its own composition.
   */
  it('TC-INT-05: nobody answered → UNAVAILABLE, never an empty success', async () => {
    const first = makeAdapter({
      id: 'first',
      isAvailable: () => ({ ok: false, reason: 'platform-explorer host unreachable' }),
    });
    const second = makeAdapter({
      id: 'second',
      isAvailable: () => ({ ok: false, reason: 'ONCHAIN_PG_URL is not configured' }),
    });
    const registry = buildMergeRegistry({ adapters: [first, second] });

    const outcome = await outcomeOf(registry.resolve(CAP, CHAIN, {}));

    const thrown = thrownOf(outcome);
    expect(thrown).toBeInstanceOf(CapabilityUnavailableError);
    expect((thrown as CapabilityUnavailableError).tried.map((entry) => entry.adapterId)).toEqual([
      'first',
      'second',
    ]);
  });

  /**
   * TC-INT-05b — a case that ISOLATES B-1 was attempted and does not exist. Recorded here rather
   * than silently dropped, because the search is the finding.
   *
   * The attempt: a merge route with an empty `adapterIds` — zero participants, so nobody answered
   * and nobody is missing, which is the one shape branch (c)'s `missing.length > 0` cannot catch.
   * PLAN §0.5 item 2 says this tree has no check rejecting an empty `adapterIds` (measured at the
   * 013-2 review), so the shape is constructible. It was constructed, and it never reaches the
   * merge walk at all: GATE 2 refuses it with `CapabilityNotCoveredOnChainError`, because a route
   * with no adapters covers no chain. Run, not reasoned — the assertion failure named that class.
   *
   * What follows, and is recorded in `registry.ts` at B-1 itself: after this task landed branch (c)
   * and the deadline precondition, **B-1 is unreachable**. Every participant that fails to answer
   * either pushes to `skipped` (→ branch (c)) or is the deadline pre-check (→ the precondition), so
   * `perSourceCache.length === 0` implies one of the two fired first. B-1 is kept as a second net
   * over `source: ''` (AC-47 is unconditional), not because a composition reaches it — and saying
   * so is the whole point of this entry, since the alternative is a future reader believing the
   * guard is load-bearing and building on it.
   */
});

// =================================================================================================
// The deadline PRECONDITION (R-164(e), AC-48) — three doors, one class, never a partial answer
// =================================================================================================

describe('the deadline is a precondition on all four branches, not a fifth branch', () => {
  /**
   * TC-INT-06 (UC-22 door 1, AC-48). The first participant answers NON-EMPTY and burns the budget
   * doing it; the second is refused by the per-adapter pre-check. Branch (b) would happily publish
   * the first participant's real series plus a `missingSources` entry — a partial merged success,
   * which is exactly what OD-4 (owner decision 2026-08-03) refused.
   *
   * The non-empty first answer is what makes this case able to fail: with an empty one it would
   * reach the error class through branch (c) instead and prove nothing about the precondition.
   *
   * KILLED_BY: deleting `deadlineHit = true` from the merge walk's pre-check — the walk ends in
   * branch (b) and returns a success.
   */
  it('TC-INT-06: door 1 (pre-check) cancels branch (b), even with a real answer in hand', async () => {
    const answered = point(DASH_METRIC.identitiesTotal, TS);
    const first = makeAdapter({
      id: 'first',
      fetchImpl: async () => {
        blockFor(40); // twice the 20 ms budget — the walk is out of time when `second` comes up
        return [answered];
      },
    });
    const second = makeAdapter({ id: 'second', points: [point('other', TS)] });
    const registry = buildMergeRegistry({ adapters: [first, second], deadlineMs: 20 });

    const outcome = await outcomeOf(registry.resolve(CAP, CHAIN, {}));

    const thrown = thrownOf(outcome);
    expect(thrown).toBeInstanceOf(CapabilityDeadlineExceededError);
    expect(thrown).not.toBeInstanceOf(CapabilityUnavailableError);
    // The second participant was never entered — "defeated by the deadline" and "asked and failed"
    // are different states and must not be conflated in the diagnostics either.
    expect(second.fetch).not.toHaveBeenCalled();
  });

  /**
   * TC-INT-07 (UC-22 door 2, AC-48) — the door the task file marks 🔴 as MISSING on the merge path.
   * The budget here is 30 s and nothing expires by the clock, so the ONLY thing that can produce
   * `CapabilityDeadlineExceededError` is the catch recognising the net-layer class and setting
   * `deadlineHit`. Door 1 cannot rescue this case, which is what makes it door 2's own test.
   *
   * KILLED_BY: deleting `if (error instanceof DeadlineExceededError) deadlineHit = true;` from the
   * merge walk's `fetch()` catch — the participant degrades to "asked, did not answer" and the walk
   * returns a branch-(b) success. (This is the mutation the task file predicts, and it was run.)
   */
  it('TC-INT-07: door 2 (a fetch cut by the ceiling) cancels branch (b) too', async () => {
    const answered = point(DASH_METRIC.identitiesTotal, TS);
    const first = makeAdapter({ id: 'first', points: [answered] });
    const second = makeAdapter({
      id: 'second',
      fetchImpl: async () => {
        throw new DeadlineExceededError('provider "second"', Date.now(), 'limiter');
      },
    });
    const registry = buildMergeRegistry({ adapters: [first, second], deadlineMs: 30_000 });

    const outcome = await outcomeOf(registry.resolve(CAP, CHAIN, {}));

    const thrown = thrownOf(outcome);
    expect(thrown).toBeInstanceOf(CapabilityDeadlineExceededError);
    expect(thrown).not.toBeInstanceOf(CapabilityUnavailableError);
    // Both doors report the SAME class — the caller's advice ("retry with more time") does not
    // depend on which of the two ways the deadline won.
    expect((thrown as CapabilityDeadlineExceededError).tried.map((e) => e.adapterId)).toContain(
      'second',
    );
  });

  /**
   * TC-INT-08 (door 3) — the deadline already spent at the ENTRANCE, before the merge branch is
   * even chosen. `tried: []` is the substance of "immediate": nothing was attempted, so nothing is
   * reported as attempted. Green by construction on the merge path (this throw predates T-013);
   * present because the task's contract names three points of the same class and a contract stated
   * only twice is a contract with a hole.
   *
   * KILLED_BY: making the entrance refusal fall through into the walk — `tried` stops being empty.
   */
  it('TC-INT-08: door 3 (an already-expired requested deadline) refuses before the walk', async () => {
    const first = makeAdapter({ id: 'first', points: [point('m', TS)] });
    const second = makeAdapter({ id: 'second', points: [point('m2', TS)] });
    const registry = buildMergeRegistry({ adapters: [first, second] });

    const outcome = await outcomeOf(registry.resolve(CAP, CHAIN, {}, Date.now() - 1));

    const thrown = thrownOf(outcome);
    expect(thrown).toBeInstanceOf(CapabilityDeadlineExceededError);
    expect((thrown as CapabilityDeadlineExceededError).tried).toEqual([]);
    expect(first.fetch).not.toHaveBeenCalled();
    expect(second.fetch).not.toHaveBeenCalled();
  });

  /**
   * TC-INT-09 (R-164(e), second half) — `DeadlineWouldExceedError` is NOT the precondition. A
   * saturated rate-limiter bucket is a per-PROVIDER fact; the deadline is global. Treating one
   * provider's backlog as the route's expiry would end the walk before a participant whose bucket
   * is idle, and would report "retry with more time" for a condition more time does not fix.
   *
   * Direction 1: the other participant answered non-empty → branch (b), not the precondition.
   *
   * KILLED_BY: adding `DeadlineWouldExceedError` to the `deadlineHit` catch — the outcome flips to
   * `CapabilityDeadlineExceededError`.
   */
  it('TC-INT-09: DeadlineWouldExceedError + a non-empty answer → branch (b), not the precondition', async () => {
    const answered = point(DASH_METRIC.identitiesTotal, TS);
    const first = makeAdapter({
      id: 'first',
      fetchImpl: async () => {
        throw new DeadlineWouldExceedError('first', 30_000, 20_000, 5_000);
      },
    });
    const second = makeAdapter({ id: 'second', points: [answered] });
    const registry = buildMergeRegistry({ adapters: [first, second], deadlineMs: 30_000 });

    const outcome = await outcomeOf(registry.resolve(CAP, CHAIN, {}));

    const resolution = returnedOf(outcome);
    expect(resolution.result).toEqual([answered]);
    expect(resolution.missingSources?.map((entry) => entry.adapterId)).toEqual(['first']);
  });

  /**
   * TC-INT-10 — the other direction of the same pair: a walk that only ever saw
   * `DeadlineWouldExceedError`, with every answering participant empty, ends as UNAVAILABLE
   * (branch (c)) and NOT as the deadline class. Both directions are asserted because a single one
   * of them is satisfied by an implementation that never distinguishes the two classes at all.
   *
   * KILLED_BY: the same mutation as TC-INT-09, from the opposite side.
   */
  it('TC-INT-10: DeadlineWouldExceedError + only empty answers → branch (c), still not a deadline', async () => {
    const first = makeAdapter({
      id: 'first',
      fetchImpl: async () => {
        throw new DeadlineWouldExceedError('first', 30_000, 20_000, 5_000);
      },
    });
    const second = makeAdapter({ id: 'second', points: [] });
    const registry = buildMergeRegistry({ adapters: [first, second], deadlineMs: 30_000 });

    const outcome = await outcomeOf(registry.resolve(CAP, CHAIN, {}));

    const thrown = thrownOf(outcome);
    expect(thrown).toBeInstanceOf(CapabilityUnavailableError);
    expect(thrown).not.toBeInstanceOf(CapabilityDeadlineExceededError);
  });

  /**
   * TC-INT-11 (R-164(e), last clause) — a LATE but COMPLETE answer is not a defeated one. Every
   * participant was entered before the ceiling and every one answered; the walk merely finished
   * after it. That is branch (a) plus `deadlineOverrunMs`, and it is deliberately a different
   * outcome from the precondition: `deadlineOverrunMs` reports a fact about delivery, the
   * precondition reports a fact about REACH.
   *
   * KILLED_BY: hoisting the terminal `Date.now() >= effectiveDeadlineAtMs` disjunct into the merge
   * walk's own precondition — this complete answer would start throwing.
   */
  it('TC-INT-11: a complete answer delivered past the ceiling is branch (a) with deadlineOverrunMs', async () => {
    const a = point('metric.a', TS);
    const b = point('metric.b', TS);
    const first = makeAdapter({ id: 'first', points: [a] });
    const second = makeAdapter({
      id: 'second',
      fetchImpl: async () => {
        blockFor(200); // the budget is 100 ms — spent INSIDE the last participant's own fetch
        return [b];
      },
    });
    // 100 ms, not the 30 ms this case was first written with. The margin here is the one number in
    // this file that has to be generous in BOTH directions: `second`'s pre-check must still pass
    // (so everything before it must fit inside the budget — on a loaded machine a "no-op" first
    // participant is not free), and the overrun must be unmistakable afterwards. 30 ms made the
    // first half a coin flip and would have turned this case into the flake that gets deleted.
    const registry = buildMergeRegistry({ adapters: [first, second], deadlineMs: 100 });

    const outcome = await outcomeOf(registry.resolve(CAP, CHAIN, {}));

    const resolution = returnedOf(outcome);
    expect(resolution.result).toEqual(expect.arrayContaining([a, b]));
    expect(resolution.missingSources).toBeUndefined();
    expect(resolution.deadlineOverrunMs).toBeGreaterThan(0);
  });
});

// =================================================================================================
// `attempted` / `missingSources` on three compositions, separately (R-176, AC-37)
// =================================================================================================

describe('attempted and missingSources name participants by their real state', () => {
  /**
   * TC-INT-12 (AC-37, R-176(a)) — both really asked: `attempted` is both ids IN WALK ORDER, which
   * is rank order, which is spend order. Asserted with `toEqual` on the array rather than
   * membership: order is the part a budget reading downstream depends on.
   *
   * KILLED_BY: moving `attempted.push(adapterId)` below the `await adapter.fetch(...)` — a `fetch`
   * that throws would stop being recorded, and TC-INT-14 would go with it.
   */
  it('TC-INT-12: two entered participants → attempted lists both, in walk order', async () => {
    const first = makeAdapter({ id: 'first', points: [point('metric.a', TS)] });
    const second = makeAdapter({ id: 'second', points: [point('metric.b', TS)] });
    const registry = buildMergeRegistry({ adapters: [first, second] });

    const resolution = returnedOf(await outcomeOf(registry.resolve(CAP, CHAIN, {})));

    expect(resolution.attempted).toEqual(['first', 'second']);
    expect(resolution.missingSources).toBeUndefined();
    expect(resolution.sources).toEqual(['first', 'second']);
  });

  /**
   * TC-INT-13 (R-164(f)) — a participant served FROM CACHE answered, so it is in neither array: not
   * in `attempted` (its `fetch()` was never entered — the array is about spending, not about
   * answering) and not in `missingSources` (it answered). Its only record is `perSourceCache`.
   *
   * KILLED_BY: appending to `attempted` at the top of the loop body instead of at the `fetch()`
   * call — the cache-hit participant would appear in it.
   */
  it('TC-INT-13: a cache-hit participant is in neither attempted nor missingSources', async () => {
    const cachedPoint = point('metric.cached', TS);
    const freshPoint = point('metric.fresh', TS);
    const argsHash = deriveArgsHash(CAP, {});
    const cache = new FakeCacheStore(
      new Map([
        [
          FakeCacheStore.key('first', CAP, argsHash),
          { value: [cachedPoint], ageMs: 1_000 } as CacheGetResult,
        ],
      ]),
    );
    const first = makeAdapter({ id: 'first', points: [cachedPoint] });
    const second = makeAdapter({ id: 'second', points: [freshPoint] });
    const registry = buildMergeRegistry({ adapters: [first, second], cache });

    const resolution = returnedOf(await outcomeOf(registry.resolve(CAP, CHAIN, {})));

    expect(first.fetch).not.toHaveBeenCalled();
    expect(resolution.attempted).toEqual(['second']);
    expect(resolution.missingSources).toBeUndefined();
    expect(resolution.perSourceCache).toEqual([
      { adapterId: 'first', cache: 'hit', ageMs: 1_000 },
      { adapterId: 'second', cache: 'miss' },
    ]);
  });

  /**
   * TC-INT-14 (R-176(b)) — "asked and did not answer" is the ONE state that belongs to both arrays
   * at once, and the composition is asserted on both in the same case: two separate cases could
   * each pass against an implementation that never puts the same participant in both.
   *
   * KILLED_BY: either of TC-INT-03's or TC-INT-12's mutations, from a third direction.
   */
  it('TC-INT-14: an asked-and-failed participant is in attempted AND missingSources', async () => {
    const answered = point(DASH_METRIC.identitiesTotal, TS);
    const first = makeAdapter({ id: 'first', points: [answered] });
    const second = makeAdapter({
      id: 'second',
      fetchImpl: async () => {
        throw new Error('pg-history: connection refused');
      },
    });
    const registry = buildMergeRegistry({ adapters: [first, second] });

    const resolution = returnedOf(await outcomeOf(registry.resolve(CAP, CHAIN, {})));

    expect(resolution.attempted).toEqual(['first', 'second']);
    expect(resolution.missingSources).toEqual([
      { adapterId: 'second', reason: 'pg-history: connection refused' },
    ]);
  });

  /**
   * TC-INT-15 (R-174(b)'s named exception) — the chain-scoped skip is the ONE missing state with
   * nothing to relay: `tried[]` deliberately carries no entry for it ("не выглядеть как отказ" — a
   * coverage fact is not an attempt that failed), so `missingSources` SYNTHESIZES its reason.
   *
   * Unreachable on both real merge routes (both `chainSupport`s are Dash-only and GATE 2 refuses a
   * non-Dash chain before the walk), and the form of the field still has to account for it — which
   * is precisely why it is tested on a synthetic route instead of being argued away.
   *
   * KILLED_BY: relaying the reason from `tried[]` for ALL kinds — `tried` has no entry for this
   * one, so the reason degrades to the `'no reason recorded'` fallback.
   */
  it('TC-INT-15: a chain-skipped participant carries a synthesized reason, and no tried entry', async () => {
    const answered = point(DASH_METRIC.identitiesTotal, TS);
    const first = makeAdapter({ id: 'first', points: [answered] });
    const second = makeAdapter({ id: 'second', points: [], chainSupport: () => false });
    const registry = buildMergeRegistry({ adapters: [first, second] });

    const resolution = returnedOf(await outcomeOf(registry.resolve(CAP, CHAIN, {})));

    expect(resolution.result).toEqual([answered]);
    expect(resolution.missingSources).toEqual([
      { adapterId: 'second', reason: 'this adapter does not serve this chain' },
    ]);
    expect(second.fetch).not.toHaveBeenCalled();
  });
});
