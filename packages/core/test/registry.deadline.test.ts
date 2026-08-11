import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CacheGetResult, CacheStore } from '../src/adapters/cache-store.js';
import type { PolicyDescriptor } from '../src/adapters/policy.js';
import {
  CapabilityDeadlineExceededError,
  CapabilityRegistry,
  CapabilityUnavailableError,
  type CapabilityResolution,
} from '../src/adapters/registry.js';
import type { CapabilityRoute, ProviderAdapter } from '../src/adapters/types.js';
import type { CapabilityManifest } from '../src/capability-manifest.js';
import { CapabilityNotCoveredOnChainError } from '../src/chain/errors.js';
import { deriveArgsHash } from '../src/net/args-hash.js';
import { DeadlineExceededError, SafeFetchTimeoutError } from '../src/net/safe-fetch.js';
import {
  createThrottle,
  DeadlineWouldExceedError,
  RateLimitRejectedError,
} from '../src/net/rate-limit.js';
import { createBlockscoutAdapter } from '../src/adapters/blockscout/index.js';
import { createBlockchainInfoAdapter } from '../src/adapters/blockchain-info/index.js';
import { adapterRegistrations, routes } from '../src/providers.config.js';
import { BLOCKSCOUT_TEST_ENV } from './helpers/blockscout-env.js';

/**
 * Task 012-8 — the call deadline at the REGISTRY layer (ADR-002 D4, R-140/R-144/R-145/R-157).
 *
 * **Its own file, not an addition to `registry.test.ts`** (PLAN §0.4): task 012-1 rewrote that one,
 * and two tasks editing the same test file is the conflict the plan's file-ownership table exists to
 * prevent.
 *
 * **Methodology `tdd-strict` (PLAN §0.9).** Every case below carries an `EXPECTED_FAIL_REASON` and
 * was run RED against phase 1 (the fourth parameter of `resolve()` and the third of `fetch()`
 * declared and ignored, `CapabilityDeadlineExceededError` declared and never thrown) before any of
 * the logic existed. OD-4 requires that a deadline NEVER returns a partial answer, and "never
 * returns" can only be proved by a test that can tell a return from a throw — hence `outcomeOf`
 * below, and hence the strict cycle for this task in particular.
 *
 * **Cases that are green by construction say so in place** (TC-INT-04, TC-INT-05, TC-INT-07,
 * TC-INT-10): they pin behaviour that must SURVIVE the change, so no state of the tree makes them
 * red, and their power is shown by the mutation that kills them instead. That is the same form task
 * 012-7 used for TC-UNIT-05/07/12 in `safe-fetch.test.ts` / `rate-limit.test.ts`.
 *
 * **Clocks.** `CapabilityRegistry` has no injectable clock — it reads `Date.now()` directly, and
 * PLAN §0.3 fixes the number of dependency seams this milestone builds (three, none of them here).
 * So the mechanism is the one `safe-fetch.test.ts` already uses: a fake adapter that BURNS wall
 * clock synchronously (`blockFor`) against a manifest deadline of a few tens of milliseconds. Every
 * timing case keeps its two numbers at least 2x apart, and the burn never yields to the event loop,
 * so no scheduler decision can flip a verdict.
 */

/** Burns `ms` of wall clock WITHOUT yielding — the `safe-fetch.test.ts` precedent.
 *
 * `await setTimeout(...)` would work too and is worse here: it hands the event loop back, so on a
 * loaded machine "the deadline passed during adapter A" becomes a scheduling coin flip. Spinning
 * makes the adapter's own duration the only variable. Every use below burns ≤ 60 ms. */
function blockFor(ms: number): void {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    /* spin — see the docstring: yielding here would reintroduce the race */
  }
}

/** The one synthetic capability every registry case routes.
 *
 * Synthetic rather than a real one (`entity.labels`, say) because the manifest is INJECTED: a real
 * name would tie these cases to a production `deadlineMs` of 15-60 s, and a test that has to wait
 * 15 s to observe an expiry is a test nobody runs. `blockscout`'s two cases at the bottom use the
 * real capability, because there the adapter is real too. */
const CAP = 'test.deadline';
const CHAIN = 'ethereum';

function manifestsFor(deadlineMs: number): Readonly<Record<string, CapabilityManifest>> {
  return { [CAP]: { shape: 'point', ttlSeconds: 60, deadlineMs } };
}

interface FakeAdapter extends ProviderAdapter {
  /** One entry per `fetch()` call, holding the third argument exactly as received — so `length` is
   * also the call count, and `undefined` is recorded rather than lost. */
  readonly deadlines: (number | undefined)[];
}

function makeAdapter(opts: {
  id: string;
  fetchImpl?: (
    cap: string,
    args: Record<string, unknown>,
    deadlineAtMs?: number,
  ) => Promise<unknown>;
  normalizeImpl?: (cap: string, raw: unknown) => unknown;
  isAvailable?: () => { ok: true } | { ok: false; reason: string };
}): FakeAdapter {
  const deadlines: (number | undefined)[] = [];
  return {
    id: opts.id,
    capabilities: () => [],
    costOf: () => ({ credits: 0 }),
    deadlines,
    fetch: async (cap, args, deadlineAtMs) => {
      deadlines.push(deadlineAtMs);
      return opts.fetchImpl
        ? await opts.fetchImpl(cap, args, deadlineAtMs)
        : { raw: true, from: opts.id };
    },
    normalize: (cap, raw) => (opts.normalizeImpl ? opts.normalizeImpl(cap, raw) : raw),
    ...(opts.isAvailable ? { isAvailable: opts.isAvailable } : {}),
  };
}

/** Records WHICH provider slots were read and written — TC-INT-09 and TC-INT-06 assert on the
 * calls themselves, by name, rather than inferring them from an outcome. */
class RecordingCacheStore implements CacheStore {
  readonly getCalls: string[] = [];
  readonly setCalls: { provider: string; value: unknown; ttlSecondsOverride?: number }[] = [];

  constructor(private readonly hits: Map<string, CacheGetResult> = new Map()) {}

  static key(provider: string, capability: string, argsHash: string): string {
    return `${provider}::${capability}::${argsHash}`;
  }

  async get(
    provider: string,
    capability: string,
    argsHash: string,
  ): Promise<CacheGetResult | undefined> {
    this.getCalls.push(provider);
    return this.hits.get(RecordingCacheStore.key(provider, capability, argsHash));
  }

  async set(
    provider: string,
    _capability: string,
    _argsHash: string,
    value: unknown,
    ttlSecondsOverride?: number,
  ): Promise<void> {
    this.setCalls.push({ provider, value, ...(ttlSecondsOverride ? { ttlSecondsOverride } : {}) });
  }
}

function buildRegistry(opts: {
  adapters: ProviderAdapter[];
  deadlineMs: number;
  cache?: CacheStore;
  policy?: PolicyDescriptor;
}): CapabilityRegistry {
  const route: CapabilityRoute = {
    capability: CAP,
    adapterIds: opts.adapters.map((adapter) => adapter.id),
    ...(opts.policy ? { policy: opts.policy } : {}),
  };
  return new CapabilityRegistry(
    [route],
    new Map(opts.adapters.map((adapter) => [adapter.id, adapter])),
    opts.cache,
    // `null` = the shipped chain registry, exactly as production wires it. The coverage gate then
    // resolves `ethereum` and passes: an adapter declaring no `chainSupport` covers whatever its
    // route covers (`chain/coverage.ts`).
    null,
    manifestsFor(opts.deadlineMs),
  );
}

/**
 * Settles a `resolve()` into a shape that can distinguish a RETURN from a THROW.
 *
 * `expect(...).rejects` proves the promise rejected; it cannot state the other half of OD-4 — that
 * no `CapabilityResolution` was produced in any form. The whole defect this task exists to prevent
 * is a truthful-but-partial answer being RETURNED where the honest outcome is a throw, so the
 * discrimination has to be an assertion and not an inference.
 */
async function outcomeOf(
  pending: Promise<CapabilityResolution>,
): Promise<{ returned: CapabilityResolution } | { thrown: unknown }> {
  return pending.then(
    (returned) => ({ returned }),
    (thrown: unknown) => ({ thrown }),
  );
}

describe('resolve() computes the effective deadline (task 012-8, R-144/AC-11)', () => {
  /** TC-UNIT-01 (R-144b/AC-11) — the caller may not WIDEN the manifest's own budget.
   *
   * Asserted on the VALUE that reached the adapter, not merely on the outcome: a registry that
   * ignored the request entirely would produce the same successful outcome, so the outcome alone
   * proves nothing about narrowing.
   *
   * EXPECTED_FAIL_REASON (phase 1, the 4th parameter declared and ignored): the adapter receives
   * `undefined`, so `expect(received).toBeDefined()` fails — "expected undefined to be defined". */
  it('TC-UNIT-01: a request WIDER than the manifest is capped at the manifest', async () => {
    const adapter = makeAdapter({ id: 'a' });
    const registry = buildRegistry({ adapters: [adapter], deadlineMs: 30_000 });

    const before = Date.now();
    const requested = before + 3_600_000; // an hour — two orders of magnitude past the manifest
    await registry.resolve(CAP, CHAIN, {}, requested);
    const after = Date.now();

    const received = adapter.deadlines[0];
    expect(received).toBeDefined();
    expect(received!).toBeGreaterThanOrEqual(before + 30_000);
    expect(received!).toBeLessThanOrEqual(after + 30_000);
    // The point of the case, stated as its own assertion: the caller asked for more and got less.
    expect(received!).toBeLessThan(requested);
  });

  /** TC-UNIT-02 (R-144c/AC-11) — a NARROWER request is honoured verbatim.
   * EXPECTED_FAIL_REASON (phase 1): the adapter receives `undefined` — "expected undefined to be
   * <requested>". */
  it('TC-UNIT-02: a request NARROWER than the manifest becomes the effective deadline', async () => {
    const adapter = makeAdapter({ id: 'a' });
    const registry = buildRegistry({ adapters: [adapter], deadlineMs: 30_000 });

    const requested = Date.now() + 1_000;
    await registry.resolve(CAP, CHAIN, {}, requested);

    // Exact equality, not a range: `Math.min` picks the caller's number unchanged, and rounding or
    // re-deriving it would be a different implementation with the same outcome.
    expect(adapter.deadlines[0]).toBe(requested);
  });

  /** TC-UNIT-03 (L-1, first form) — a value that is not a safe integer is treated as ABSENCE.
   *
   * `NaN` is the one that matters and the reason the two forms are split: `Math.min(a, NaN)` is
   * `NaN`, `NaN <= 0` is `false`, and an unguarded `NaN` therefore makes every LATER comparison
   * silently never fire — a deadline that exists in the type system and nowhere else.
   *
   * EXPECTED_FAIL_REASON (phase 1): the adapter receives `undefined` for all three inputs — "expected
   * undefined to be defined". */
  it('TC-UNIT-03: NaN / a string / Infinity are read as "no deadline requested"', async () => {
    for (const requested of [Number.NaN, 'soon' as unknown as number, Number.POSITIVE_INFINITY]) {
      const adapter = makeAdapter({ id: 'a' });
      const registry = buildRegistry({ adapters: [adapter], deadlineMs: 30_000 });

      const before = Date.now();
      await registry.resolve(CAP, CHAIN, {}, requested);

      const received = adapter.deadlines[0];
      expect(received).toBeDefined();
      // Named separately from the range below: the harm of the unguarded form is not a wrong
      // number, it is a number no comparison can act on.
      expect(Number.isSafeInteger(received)).toBe(true);
      expect(received!).toBeGreaterThanOrEqual(before + 30_000);
      expect(received!).toBeLessThanOrEqual(Date.now() + 30_000);
    }
  });

  /** TC-UNIT-04 (L-1, second form) — a PAST safe integer is an immediate typed refusal.
   *
   * Not "absence", which is the tempting fold and the wrong one: absence means the FULL manifest
   * budget, i.e. strictly MORE time than the caller asked for, and R-144 forbids widening in either
   * direction. (Clamping to `now()` was considered and rejected upstream: it makes an expired
   * deadline indistinguishable from an absent one for one tick.)
   *
   * EXPECTED_FAIL_REASON (phase 1): the deadline is ignored, the adapter answers and `resolve()`
   * RESOLVES — `'thrown' in outcome` is false, "expected false to be true". */
  it('TC-UNIT-04: a deadline already in the past is refused immediately, with an empty tried[]', async () => {
    const adapter = makeAdapter({ id: 'a' });
    const cache = new RecordingCacheStore();
    const registry = buildRegistry({ adapters: [adapter], deadlineMs: 30_000, cache });

    const outcome = await outcomeOf(registry.resolve(CAP, CHAIN, {}, Date.now() - 1));

    expect('thrown' in outcome).toBe(true);
    const thrown = (outcome as { thrown: unknown }).thrown;
    expect(thrown).toBeInstanceOf(CapabilityDeadlineExceededError);
    // `tried: []` is the substance of "immediate": nothing was attempted, so nothing is reported as
    // having been attempted.
    expect((thrown as CapabilityDeadlineExceededError).tried).toEqual([]);
    expect(adapter.deadlines).toHaveLength(0);
    expect(cache.getCalls).toEqual([]);
  });

  /** TC-UNIT-05 (R-144d) — ONE moment, computed once, threaded unchanged.
   *
   * The first adapter burns 20 ms before failing, so a deadline RE-DERIVED per adapter would differ
   * by at least that much; strict equality is what makes the case able to fail.
   *
   * EXPECTED_FAIL_REASON (phase 1): both adapters receive `undefined`, so `toBeDefined()` fails on
   * the first — "expected undefined to be defined". (Strict equality alone would not: `undefined ===
   * undefined` passes, which is exactly why the definedness assertion comes first.) */
  it('TC-UNIT-05: every adapter of the walk receives the SAME moment, not a fresh one', async () => {
    const first = makeAdapter({
      id: 'a',
      fetchImpl: async () => {
        blockFor(20);
        throw new Error('a: upstream said no');
      },
    });
    const second = makeAdapter({ id: 'b' });
    const registry = buildRegistry({ adapters: [first, second], deadlineMs: 30_000 });

    await registry.resolve(CAP, CHAIN, {});

    expect(first.deadlines[0]).toBeDefined();
    expect(second.deadlines[0]).toBeDefined();
    expect(second.deadlines[0]).toBe(first.deadlines[0]);
  });
});

describe('resolve() ends a spent walk with the THIRD outcome (task 012-8, R-145/AC-18)', () => {
  /** TC-INT-01 (R-145a/UC-4) — the deadline expires before ANY source has answered.
   *
   * EXPECTED_FAIL_REASON (phase 1): the deadline is ignored, so adapter `b` is asked and answers,
   * and `resolve()` RESOLVES — "expected false to be true" on `'thrown' in outcome`. */
  it('TC-INT-01: throws CapabilityDeadlineExceededError, distinguishable from both older outcomes', async () => {
    const first = makeAdapter({
      id: 'a',
      fetchImpl: async () => {
        blockFor(40); // twice the 20 ms budget — the walk is out of time when `b` comes up
        throw new Error('a: 503 from upstream');
      },
    });
    const second = makeAdapter({ id: 'b' });
    const registry = buildRegistry({ adapters: [first, second], deadlineMs: 20 });

    const outcome = await outcomeOf(registry.resolve(CAP, CHAIN, {}));

    expect('thrown' in outcome).toBe(true);
    const thrown = (outcome as { thrown: unknown }).thrown;
    expect(thrown).toBeInstanceOf(CapabilityDeadlineExceededError);
    // The three outcomes are three different pieces of advice to the caller (retry with more time /
    // retry later / stop asking), so `instanceof` must separate them — a subclass would not.
    expect(thrown).not.toBeInstanceOf(CapabilityUnavailableError);
    expect(thrown).not.toBeInstanceOf(CapabilityNotCoveredOnChainError);
    expect(second.deadlines).toHaveLength(0);
  });

  /**
   * TC-INT-02 (R-145b/UC-5) — THE case of this task.
   *
   * One source answered truthfully but not with what was asked for; the deadline then expired before
   * the source that would have known could be asked. H-1's doctrine (`registry.ts`, "nobody
   * satisfied the route's policy") returns that first answer when every adapter was ASKED; OD-4 says
   * a deadline is a failure of OUR availability, exactly like a missing key, so `hadFailure` is set
   * and the return path does not fire. "Nansen was not asked" and "Nansen answered: no labels" are
   * different statements about a sanctioned address.
   *
   * EXPECTED_FAIL_REASON (phase 1): the deadline is ignored, `b` is asked, answers satisfyingly, and
   * `resolve()` RESOLVES with it — "expected false to be true" on `'thrown' in outcome`.
   */
  it('TC-INT-02: a truthful-but-unsatisfying answer is NOT published when the deadline ended the walk', async () => {
    const first = makeAdapter({
      id: 'a',
      fetchImpl: async () => {
        blockFor(40);
        return [{ name: '' }]; // truthful: "I have no name for this address"
      },
    });
    const second = makeAdapter({
      id: 'b',
      fetchImpl: async () => [{ name: 'Binance: Hot Wallet' }],
    });
    const registry = buildRegistry({
      adapters: [first, second],
      deadlineMs: 20,
      policy: { kind: 'someElementHasAny', fields: ['name'] },
    });

    const outcome = await outcomeOf(registry.resolve(CAP, CHAIN, {}));

    // (c) — no `CapabilityResolution` in any form. `rejects` alone would leave this unstated.
    expect('returned' in outcome).toBe(false);
    const thrown = (outcome as { thrown: unknown }).thrown;
    // (a) — the type of the refusal.
    expect(thrown).toBeInstanceOf(CapabilityDeadlineExceededError);
    // (b) — BOTH groups named: who answered and with what, and who was never asked at all.
    const tried = (thrown as CapabilityDeadlineExceededError).tried;
    expect(tried.map((entry) => entry.adapterId)).toEqual(['a', 'b']);
    expect(tried[0]!.reason).toContain('answered, but not with what was asked for');
    expect(tried[1]!.reason).toContain('deadline exceeded before this source could be attempted');
  });

  /** TC-INT-03 — the pre-check is FREE: no `fetch()` for a source the clock ruled out, and yet a
   * `tried[]` entry for it. A silent skip would make the error text claim less than happened.
   *
   * EXPECTED_FAIL_REASON (phase 1): the deadline is ignored, so `b` IS fetched — "expected [
   * undefined ] to have a length of 0 but got 1". */
  it('TC-INT-03: a source ruled out by the clock is never called, but is still reported', async () => {
    const first = makeAdapter({
      id: 'a',
      fetchImpl: async () => {
        blockFor(40);
        throw new Error('a: 503 from upstream');
      },
    });
    const second = makeAdapter({ id: 'b' });
    const registry = buildRegistry({ adapters: [first, second], deadlineMs: 20 });

    const thrown = await registry.resolve(CAP, CHAIN, {}).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(second.deadlines).toHaveLength(0);
    const tried = (thrown as CapabilityDeadlineExceededError).tried;
    expect(tried.find((entry) => entry.adapterId === 'b')?.reason).toBe(
      'deadline exceeded before this source could be attempted',
    );
  });

  /**
   * TC-INT-04 (H-A) — a saturated bucket is not a spent deadline.
   *
   * GREEN AT PHASE 1 BY CONSTRUCTION: `DeadlineWouldExceedError` is already caught by the generic
   * "this adapter could not answer, try the next one" branch, so the walk already continues. The
   * case is here because task 012-8 introduces the one thing that could break it — a `deadlineHit`
   * flag whose author is tempted to set it from anything deadline-flavoured. Its power is the
   * mutation: make the per-adapter catch treat `DeadlineWouldExceedError` like its sibling and this
   * case still passes (the walk continues either way) — but TC-INT-05, its other half, dies. The two
   * cases are therefore written as a pair and only the pair is meaningful.
   */
  it('TC-INT-04: DeadlineWouldExceedError from a saturated bucket does not end the walk', async () => {
    const first = makeAdapter({
      id: 'a',
      fetchImpl: async () => {
        throw new DeadlineWouldExceedError('a', 30_000, 20_000, 5_000);
      },
    });
    const second = makeAdapter({ id: 'b', fetchImpl: async () => ({ answered: true }) });
    const registry = buildRegistry({ adapters: [first, second], deadlineMs: 30_000 });

    const resolution = await registry.resolve(CAP, CHAIN, {});

    expect(resolution.source).toBe('b');
    expect(resolution.cache).toBe('miss');
  });

  /**
   * TC-INT-05 — the other half of the pair: `DeadlineWouldExceedError` must not set `deadlineHit`.
   *
   * GREEN AT PHASE 1 BY CONSTRUCTION (with nothing setting `deadlineHit`, the walk already ends as
   * `CapabilityUnavailableError`). The mutation that kills it is the exact defect it guards: set
   * `deadlineHit = true` in the catch for `DeadlineWouldExceedError` too, and the outcome flips to
   * `CapabilityDeadlineExceededError` — a free provider's saturation reported as the whole route's
   * time being up, which is H-1 one floor down.
   *
   * The manifest budget is 30 s here on purpose: the terminal branch's SECOND disjunct
   * (`Date.now() >= effectiveDeadlineAtMs`) must be false, or it would answer for the flag.
   */
  it('TC-INT-05: a walk that only ever saw DeadlineWouldExceedError ends as UNAVAILABLE', async () => {
    const first = makeAdapter({
      id: 'a',
      fetchImpl: async () => {
        throw new DeadlineWouldExceedError('a', 30_000, 20_000, 5_000);
      },
    });
    const second = makeAdapter({
      id: 'b',
      fetchImpl: async () => {
        throw new Error('b: 500 from upstream');
      },
    });
    const registry = buildRegistry({ adapters: [first, second], deadlineMs: 30_000 });

    const thrown = await registry.resolve(CAP, CHAIN, {}).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(thrown).toBeInstanceOf(CapabilityUnavailableError);
    expect(thrown).not.toBeInstanceOf(CapabilityDeadlineExceededError);
  });

  /**
   * TC-INT-06 — a deadline does not poison a provider's cache slot.
   *
   * Two properties in one case, because separating them would let either half pass alone: nothing is
   * written to the cache when the network layer reports expiry, AND the next call reaches the vendor
   * in full. Only `normalize()` failures are negative-cached (L-1) — a deadline is transient by
   * definition, and remembering it would turn one slow moment into a self-inflicted outage lasting
   * the whole negative TTL.
   *
   * It also pins the C-1 TRANSLATION on its own: the budget here is 30 s and nothing has expired, so
   * the only thing that can produce `CapabilityDeadlineExceededError` is the per-adapter catch
   * recognising the NET-layer class and setting `deadlineHit`.
   *
   * EXPECTED_FAIL_REASON (phase 1): nothing translates `DeadlineExceededError`, so the walk ends as
   * `CapabilityUnavailableError` — "expected CapabilityUnavailableError to be an instance of
   * CapabilityDeadlineExceededError". */
  it('TC-INT-06: expiry writes NOTHING to the cache, and the next call pays the vendor in full', async () => {
    let attempt = 0;
    const adapter = makeAdapter({
      id: 'a',
      fetchImpl: async (_cap, _args, deadlineAtMs) => {
        attempt += 1;
        if (attempt === 1) throw new DeadlineExceededError('provider "a"', deadlineAtMs ?? 0);
        return { fresh: true };
      },
    });
    const cache = new RecordingCacheStore();
    const registry = buildRegistry({ adapters: [adapter], deadlineMs: 30_000, cache });

    const first = await outcomeOf(registry.resolve(CAP, CHAIN, {}));
    expect('thrown' in first).toBe(true);
    expect((first as { thrown: unknown }).thrown).toBeInstanceOf(CapabilityDeadlineExceededError);
    // Not "no NEGATIVE entry" — no entry at all. A negative write is the only thing this path could
    // have produced, so the empty list is the exact statement.
    expect(cache.setCalls).toEqual([]);

    const second = await registry.resolve(CAP, CHAIN, {});
    // `attempted` (cycle 2, F-4): the walk entered `a`'s `fetch()`, which is what a budget reading
    // downstream needs to know — `source` alone cannot say it on a route with more than one source.
    expect(second).toEqual({
      result: { fresh: true },
      source: 'a',
      cache: 'miss',
      attempted: ['a'],
    });
    expect(adapter.deadlines).toHaveLength(2);
    expect(cache.setCalls).toHaveLength(1);
  });

  /**
   * TC-INT-07 (R-140e) — an adapter that IGNORES the parameter is not broken by it.
   *
   * GREEN AT PHASE 1 BY CONSTRUCTION, and deliberately so: 11 of the 12 production adapters were in
   * exactly this shape after task 012-8, then 10 once `nansen` took the parameter up in 012-9 (count
   * corrected in adversarial cycle 2, F-7) — and the requirement is that they keep working, which is
   * a statement about what must NOT change. Its power is a compile-level mutation: make
   * `deadlineAtMs` a REQUIRED parameter of `ProviderAdapter.fetch` and the two-parameter fake below
   * stops type-checking.
   *
   * **WI-37 removed the population this case was standing in for, and the case stays.** No shipped
   * adapter ignores the parameter any more (the two that do not read it are stubs that never run).
   * That does not retire R-140e: the guarantee is what makes the parameter OPTIONAL, which is what
   * lets a thirteenth adapter be added, or an existing one be temporarily reverted, without the
   * registry changing. Deleting this case because nothing currently exercises it would be deleting
   * the only statement of that contract — and would make `deadlineAtMs` de-facto required with no
   * decision recorded anywhere.
   */
  it('TC-INT-07: a two-parameter fetch() still resolves normally under a deadline', async () => {
    const oblivious: ProviderAdapter = {
      id: 'legacy',
      capabilities: () => [],
      costOf: () => ({ credits: 0 }),
      // Two parameters, exactly like `coingecko`/`defillama`/`rpc-evm`/… after this task.
      fetch: async (cap: string, args: Record<string, unknown>) => ({ cap, args }),
      normalize: (_cap, raw) => raw,
    };
    const registry = buildRegistry({ adapters: [oblivious], deadlineMs: 30_000 });

    const resolution = await registry.resolve(CAP, CHAIN, { a: 1 }, Date.now() + 5_000);

    expect(resolution).toEqual({
      result: { cap: CAP, args: { a: 1 } },
      source: 'legacy',
      cache: 'miss',
      // Cycle 2, F-4 — recorded for the adapter that was ENTERED, whether or not it read the
      // deadline: the field is a fact about the walk, not about the adapter's signature.
      attempted: ['legacy'],
    });
  });
});

/**
 * The `blockscout` uptake — proved BEHAVIOURALLY, in two cases (task 012-8, AC).
 *
 * **Why not a spy on the wiring.** `BlockscoutAdapterDeps` offers `fetchImpl`/`now`/`env`/`chains`/
 * `throttle`; `safeFetch` is a STATIC import (`blockscout/index.ts:5`, called at `:312`) and OD-6
 * builds the `safeFetchImpl` seam in a different file (`NansenEndpointDeps`) one task later. A spy
 * on `fetchImpl` cannot see `deadlineAtMs` at all — it is not part of `RequestInit`, which is the
 * same argument PLAN §0.3 uses to justify building that seam for `nansen`.
 *
 * **Why TWO cases.** Together they separate "threaded into the limiter" from "threaded into the
 * transport", which one case cannot do:
 * - (a) an already-spent deadline against a SATURATED bucket — the limiter's own refusal;
 * - (b) a live deadline against a request that never completes — the transport's cancellation.
 */
describe('blockscout takes the deadline (task 012-8, the only adapter that does in this task)', () => {
  const BLOCKSCOUT_RATE_LIMIT = adapterRegistrations.find(
    (registration) => registration.id === 'blockscout',
  )!.rateLimit;
  /** A real EVM address — since M-6 the adapter validates before building a URL. */
  const BINANCE = '0x28C6c06298d514Db089934071355E5743bf21d60';
  const LABEL_ARGS = { chain: CHAIN, tokenAddress: BINANCE };

  /**
   * TC-INT-08a — an already-spent deadline, WITH THE BUCKET SATURATED.
   *
   * **The saturation is the case.** On a fresh bucket `throttle()` returns SYNCHRONOUSLY
   * (`rate-limit.ts`, `if (bucket.tokens >= 0) return;`), the deadline branches live on the deficit
   * path only, and the whole outcome would then be produced by `safeFetch`'s own entry pre-check —
   * so the case would be green even if `blockscout` never passed the deadline to the limiter at all.
   * Driven into deficit first, the limiter is the only thing that can answer.
   *
   * `at === 'provider "blockscout"'` is what pins it there: the transport path builds the same class
   * from a URL, so the context string is the discriminator between the two producers.
   *
   * EXPECTED_FAIL_REASON (phase 1, `blockscout` ignores the third argument): the limiter is called
   * without a deadline, waits out its 2 000 ms deficit on the injected no-op `wait`, and the request
   * goes out — `fetchImpl` answers 200 and the call RESOLVES, so "promise resolved instead of
   * rejecting".
   */
  it('TC-INT-08a: a spent deadline is refused BY THE LIMITER, with no request at all', async () => {
    // A real bucket on the real clock (the deadline is an epoch-ms moment, so a virtual clock at
    // some other epoch would make every comparison meaningless), with `wait` neutered so the test
    // never actually sleeps.
    const throttle = createThrottle({ now: Date.now, wait: () => Promise.resolve() });
    // Two `entity.labels`-weighted calls (WEIGHT_ADDRESS_INFO = 3) against `{capacity: 5,
    // refillPerSec: 2}`: 5 → 2 → -1. The bucket is now in deficit and the adapter's own call takes
    // it to -4, i.e. a 2 000 ms wait — under `MAX_WAIT_MS`, so the fairness cap keeps its silence
    // and the deadline branch is what speaks.
    await throttle('blockscout', BLOCKSCOUT_RATE_LIMIT, 3);
    await throttle('blockscout', BLOCKSCOUT_RATE_LIMIT, 3);

    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('{}', { status: 200 }));
    const adapter = createBlockscoutAdapter({ env: BLOCKSCOUT_TEST_ENV, throttle, fetchImpl });

    const thrown = await adapter.fetch('entity.labels', LABEL_ARGS, Date.now() - 1).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(thrown).toBeInstanceOf(DeadlineExceededError);
    expect(thrown).not.toBeInstanceOf(RateLimitRejectedError);
    expect((thrown as DeadlineExceededError).at).toBe('provider "blockscout"');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  /**
   * TC-INT-08b — a live deadline on a request that never completes.
   *
   * The GAP is the proof: this adapter overrides `REQUEST_TIMEOUT_MS = 5_000`, so a deadline that
   * did not reach `safeFetch` would surface ~100x later and as `SafeFetchTimeoutError` — "the vendor
   * did not answer", a statement about them — instead of `DeadlineExceededError` — "we ran out of
   * our own time", a statement about us. Only the two together (class AND elapsed) tell the paths
   * apart.
   *
   * **Where the class is asserted moved with WI-36.** It used to be read off `.cause`, because
   * `blockscout` re-messaged every transport throw by CLASS NAME (M-7 — `safeFetch` interpolates the
   * full URL into three of its own errors, and this is the one adapter that puts a secret in a URL),
   * so the identity survived only on the cause chain. That flattening is what WI-36 removed: the
   * listed transport classes now come back as themselves and the wrapper covers everything else. The
   * assertion is therefore on the thrown error directly — the SAME property, read where it now lives,
   * with the message-safety half kept because that is what the wrapper was buying.
   *
   * EXPECTED_FAIL_REASON (phase 1): with the deadline ignored, nothing rejects until the adapter's
   * own 5 000 ms hop timeout, which vitest's own 5 000 ms `testTimeout` reaches first — "Test timed
   * out in 5000ms".
   */
  it('TC-INT-08b: a deadline expiring mid-flight beats the 5 000 ms hop timeout, and says so', async () => {
    const throttle = createThrottle({ now: Date.now, wait: () => Promise.resolve() });
    const fetchImpl = vi.fn<typeof fetch>(() => new Promise<Response>(() => {}));
    const adapter = createBlockscoutAdapter({ env: BLOCKSCOUT_TEST_ENV, throttle, fetchImpl });

    const startedAt = Date.now();
    const thrown = await adapter.fetch('entity.labels', LABEL_ARGS, Date.now() + 50).then(
      () => undefined,
      (error: unknown) => error,
    );
    const elapsedMs = Date.now() - startedAt;

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(thrown).toBeInstanceOf(DeadlineExceededError);
    // Stated separately because this is the confusion the two classes exist to prevent.
    expect(thrown).not.toBeInstanceOf(SafeFetchTimeoutError);
    // The wrapper's own job, unchanged: no URL, hence no query string, hence no key.
    expect((thrown as Error).message).not.toContain('?');
    // 2 000 ms is 40x the deadline and 2.5x below `REQUEST_TIMEOUT_MS` — a margin wide enough that a
    // loaded machine cannot flip the verdict, and narrow enough that the hop timeout cannot satisfy
    // it.
    expect(elapsedMs).toBeLessThan(2_000);
  });
});

/**
 * TC-INT-11 — **ADDED BEYOND THE TASK'S ENUMERATED LIST, and here is the measurement that earned
 * it.**
 *
 * **The next three paragraphs describe the tree as it stood at task 012-8** — they are the reason
 * this case exists, and WI-36 has since changed the fact they rest on. The correction is below, not
 * folded in: the original argument is what makes the disjunct's retention defensible.
 *
 * The task's mandated mutation runs asked whether removing the terminal branch's SECOND disjunct
 * (`|| Date.now() >= effectiveDeadlineAtMs`) is caught by any test. Measured on the full tree:
 * **1404 tests, zero of them died.** The disjunct's own comment in `registry.ts` calls it a guard
 * for "a future adapter whose error handling swallows the typed error" — but that adapter is not
 * future. It is `blockscout`, in this commit: M-7 makes it wrap every transport throw and re-message
 * it by CLASS NAME, because `safeFetch` interpolates a full URL into three of its own errors and
 * this is the one adapter that authenticates with `?apikey=` in that URL. So the net-layer
 * `DeadlineExceededError` reaches the registry as a plain `Error` with the typed one only on
 * `cause`, `deadlineHit` is never set, and the SECOND disjunct is the only thing standing between a
 * spent deadline and a `CapabilityUnavailableError` that tells the caller to retry.
 *
 * A load-bearing branch that no test holds down is one refactor away from deletion, so it gets one.
 * Deliberately driven through the REAL adapter rather than a fake that mimics the wrapper: the fake
 * would encode my reading of `blockscout`'s catch, and it is the adapter's real behaviour that makes
 * the branch necessary.
 *
 * The unwrapping alternative — teach `blockscout` to rethrow `DeadlineExceededError` as itself — was
 * NOT taken in 012-8: it is behaviour change outside that task's stated scope (its uptake is "pass
 * the deadline to `throttle()` and `safeFetch()`"), and it trades a guard that works for every
 * adapter for a fix that works for one. **Filed instead as
 * `docs/backlog/wi-36-adapter-wrappers-flatten-typed-errors.md` (WI-36)**, which also recorded the
 * latent second instance (`blockchain-info` carried the identical wrapper and did not read the
 * deadline yet).
 *
 * ---------------------------------------------------------------------------------------------
 * **WI-36 HAS NOW LANDED, and this case's instrument changed with it — the case's own rule, applied
 * to itself.** The paragraph above ends: "if it ever goes green by itself, the disjunct's coverage
 * has narrowed and the case must be re-pointed at an adapter that still flattens." It went green by
 * itself, and there is no such adapter left: `blockscout` and `blockchain-info` were the only two,
 * and both now rethrow the listed transport classes unwrapped
 * (`net/safe-fetch.ts`'s `PASS_THROUGH_TRANSPORT_ERRORS`).
 *
 * So the case splits in two, because it was proving two things at once:
 *
 * - **TC-INT-11a — what the REAL adapter does now.** Same setup, and the assertion moved from the
 *   walk's verdict to the fact underneath it: the typed class reaches the registry, so `tried[]`
 *   records a deadline instead of "transport failure (DeadlineExceededError)". Driven through the
 *   real `blockscout` for the reason the original case gives — a fake would encode a reading of its
 *   `catch` rather than exercise it.
 * - **TC-INT-11b — what the DISJUNCT still guards.** Its subject was never one adapter; it is the
 *   registry's behaviour when SOME adapter swallows the class, and WI-36 explicitly keeps it
 *   ("`|| Date.now() >= …` covers all twelve adapters including the ones that do not exist yet;
 *   unwrapping fixes two"). With no adapter in that shape, a fake IS the correct instrument — it is
 *   now the only way to construct the input the branch exists for, and using one is not a weakening
 *   of the case but the consequence of the defect being gone.
 */
describe('the terminal branch catches a SWALLOWED typed error (task 012-8, C-1 belt-and-braces)', () => {
  it('TC-INT-11a: blockscout now delivers DeadlineExceededError as itself, so `tried` says deadline', async () => {
    const throttle = createThrottle({ now: Date.now, wait: () => Promise.resolve() });
    const adapter = createBlockscoutAdapter({
      env: BLOCKSCOUT_TEST_ENV,
      throttle,
      fetchImpl: () => new Promise<Response>(() => {}),
    });
    const registry = new CapabilityRegistry(
      [{ capability: 'entity.labels', adapterIds: ['blockscout'] }],
      new Map([['blockscout', adapter]]),
      undefined,
      null,
      { 'entity.labels': { shape: 'set', ttlSeconds: 3600, deadlineMs: 50 } },
    );

    const outcome = await outcomeOf(
      registry.resolve('entity.labels', CHAIN, {
        chain: CHAIN,
        tokenAddress: '0x28C6c06298d514Db089934071355E5743bf21d60',
      }),
    );

    expect('returned' in outcome).toBe(false);
    const thrown = (outcome as { thrown: unknown }).thrown;
    expect(thrown).toBeInstanceOf(CapabilityDeadlineExceededError);
    expect(thrown).not.toBeInstanceOf(CapabilityUnavailableError);
    // WI-36's acceptance 2, stated as the thing an operator or a downstream reader actually sees.
    // Before the fix this read `blockscout: transport failure from mcp.blockscout.com
    // (DeadlineExceededError)` — the class named in prose, invisible to `instanceof`, and
    // `deadlineHit` never set. `tried[]` is the only public window onto that flag, so it is the
    // assertion; restoring the wrapper turns this red while every other assertion here stays green,
    // which is exactly the coverage gap the record is about.
    const reason = (thrown as CapabilityDeadlineExceededError).message;
    expect(reason).toContain('deadline exceeded');
    expect(reason).not.toContain('transport failure');
    // …and the credential channel the wrapper existed to close is still closed (M-7).
    expect(reason).not.toContain('apikey');
    expect(reason).not.toContain('?');
  });

  it('TC-INT-11b: an adapter that DOES swallow the class still ends the walk as deadline-exceeded', async () => {
    // The fake reproduces exactly what both real adapters did until WI-36, and nothing else — so
    // the branch under test is fed its input without any adapter being in that shape any more.
    const swallowing: ProviderAdapter = {
      id: 'swallows',
      capabilities: () => [],
      costOf: () => ({ credits: 0 }),
      fetch: async (_cap, _args, deadlineAtMs) => {
        blockFor(60);
        throw new Error('swallows: transport failure from example.test (DeadlineExceededError)', {
          cause: new DeadlineExceededError('https://example.test/x', deadlineAtMs ?? 0),
        });
      },
      normalize: (_cap, raw) => raw,
    };
    const registry = buildRegistry({ adapters: [swallowing], deadlineMs: 40 });

    const outcome = await outcomeOf(registry.resolve(CAP, CHAIN, {}));

    expect('returned' in outcome).toBe(false);
    const thrown = (outcome as { thrown: unknown }).thrown;
    // `deadlineHit` is false here — the class is on `.cause`, where `instanceof` cannot see it — so
    // the SECOND disjunct is the only thing producing this verdict. Delete it and this goes
    // `CapabilityUnavailableError`: "every source failed, retry later", for a walk that failed
    // because our own clock ran out.
    expect(thrown).toBeInstanceOf(CapabilityDeadlineExceededError);
    expect(thrown).not.toBeInstanceOf(CapabilityUnavailableError);
  });
});

/**
 * WI-36 acceptance 1 — the typed class survives BOTH wrappers, with no secret in the message.
 *
 * Two adapters, one case each, because the record's own count is what made the fix worth doing: the
 * cost was real on `blockscout` (it read the deadline) and LATENT on `blockchain-info` (identical
 * wrapper, no deadline yet). WI-37 removed the latency in the same commit, so both are live now and
 * both are asserted the same way.
 *
 * The assertion is deliberately in two halves that pull in opposite directions — `instanceof` must
 * be TRUE (the wrapper is not allowed to destroy the class) and the message must carry no credential
 * (the wrapper's own reason for existing must survive the change). One without the other is how this
 * fix could go wrong in either direction.
 */
describe('WI-36 — the two wrapping adapters no longer flatten typed transport errors', () => {
  const BINANCE = '0x28C6c06298d514Db089934071355E5743bf21d60';
  const SECRET = 'proapi_secretvalue0123456789';

  it('blockscout: a mid-flight deadline arrives as DeadlineExceededError, not as a plain Error', async () => {
    const throttle = createThrottle({ now: Date.now, wait: () => Promise.resolve() });
    const adapter = createBlockscoutAdapter({
      // A key is what puts `?apikey=<secret>` into the URL `safeFetch` interpolates — this is the
      // one adapter in the tree that authenticates that way, and the whole reason the wrapper
      // existed. Without the key set, the message-safety half of this test would be vacuous.
      env: { BLOCKSCOUT_PRO_API_KEY: SECRET },
      throttle,
      fetchImpl: () => new Promise<Response>(() => {}),
    });

    const thrown = await adapter
      .fetch('entity.labels', { chain: CHAIN, tokenAddress: BINANCE }, Date.now() + 40)
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(thrown).toBeInstanceOf(DeadlineExceededError);
    // Stated separately: this is the confusion the two classes exist to prevent, and a hop timeout
    // here would mean the deadline never reached the transport.
    expect(thrown).not.toBeInstanceOf(SafeFetchTimeoutError);
    expect((thrown as Error).message).not.toContain(SECRET);
    expect((thrown as Error).message).not.toContain('apikey');
    expect((thrown as Error).message).not.toContain('?');
  });

  it('blockchain-info: the same, on the adapter that carried the wrapper latently', async () => {
    const throttle = createThrottle({ now: Date.now, wait: () => Promise.resolve() });
    const adapter = createBlockchainInfoAdapter({
      throttle,
      fetchImpl: () => new Promise<Response>(() => {}),
    });

    const thrown = await adapter.fetch('chain.supply', { chain: 'bitcoin' }, Date.now() + 40).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(thrown).toBeInstanceOf(DeadlineExceededError);
    expect(thrown).not.toBeInstanceOf(SafeFetchTimeoutError);
    // This vendor is keyless, so there is no secret to leak — the URL is still kept out of the
    // message by the class's own redaction, which is the property the pass-through list rests on.
    expect((thrown as Error).message).not.toContain('?');
  });

  it('a NON-listed transport failure is still wrapped — the fix did not open the channel', async () => {
    // The other direction, and the one that would be a security regression rather than a defect:
    // `isPassThroughTransportError` must not become "rethrow anything the transport threw".
    // `safeFetch` raises a plain `Error` for a redirect chain that exceeds the cap, and its message
    // is built from the URL — redacted there, but the class is untyped, so the adapter's wrapper is
    // what the caller must still get.
    const throttle = createThrottle({ now: Date.now, wait: () => Promise.resolve() });
    const adapter = createBlockscoutAdapter({
      env: { BLOCKSCOUT_PRO_API_KEY: SECRET },
      throttle,
      fetchImpl: () =>
        Promise.resolve(
          new Response(null, {
            status: 302,
            headers: { location: 'https://mcp.blockscout.com/v1/loop' },
          }),
        ),
    });

    const thrown = await adapter
      .fetch('entity.labels', { chain: CHAIN, tokenAddress: BINANCE })
      .then(
        () => undefined,
        (error: unknown) => error,
      );

    expect(thrown).toBeInstanceOf(Error);
    expect(thrown).not.toBeInstanceOf(DeadlineExceededError);
    expect((thrown as Error).message).toContain('blockscout: transport failure');
    expect((thrown as Error).message).not.toContain(SECRET);
  });
});

describe('the pre-check sits ABOVE the cache read (task 012-8, Med-2)', () => {
  /** Builds the shared fixture: `b` has an entry in the cache, `a` burns the walk's budget on its
   * first call only (so a second `resolve()` can reach `b` with a whole budget). */
  function fixture(): { registry: CapabilityRegistry; cache: RecordingCacheStore; b: FakeAdapter } {
    let attempt = 0;
    const a = makeAdapter({
      id: 'a',
      fetchImpl: async () => {
        attempt += 1;
        if (attempt === 1) blockFor(40);
        throw new Error('a: 503 from upstream');
      },
    });
    const b = makeAdapter({ id: 'b' });
    const cache = new RecordingCacheStore(
      new Map([
        [
          RecordingCacheStore.key('b', CAP, deriveArgsHash(CAP, {})),
          { value: { cached: true }, ageMs: 1_234 },
        ],
      ]),
    );
    // 5 s manifest budget, narrowed to 20 ms by the CALLER on the first call — so the second call,
    // which passes nothing, has the full budget and cannot be starved by a slow machine.
    const registry = buildRegistry({ adapters: [a, b], deadlineMs: 5_000, cache });
    return { registry, cache, b };
  }

  /**
   * TC-INT-09 (Med-2) — the position is a PRODUCT decision, so it is asserted BY NAME.
   *
   * A deadline means "after this moment we do not answer", not "after this moment we do not go to
   * the network": the second is a distinction the caller cannot predict. So an expired walk refuses
   * even an answer that is already sitting locally and costs nothing.
   *
   * EXPECTED_FAIL_REASON (phase 1): the deadline is ignored, `b`'s cached entry is read and returned
   * — "expected false to be true" on `'thrown' in outcome`.
   */
  it('TC-INT-09: an expired walk refuses a LOCAL hit — cache.get is never called for that source', async () => {
    const { registry, cache, b } = fixture();

    const outcome = await outcomeOf(registry.resolve(CAP, CHAIN, {}, Date.now() + 20));

    expect('returned' in outcome).toBe(false);
    expect((outcome as { thrown: unknown }).thrown).toBeInstanceOf(CapabilityDeadlineExceededError);
    // By NAME, not by inference from the outcome: this is what places the pre-check above the read.
    expect(cache.getCalls).toContain('a');
    expect(cache.getCalls).not.toContain('b');
    expect(b.deadlines).toHaveLength(0);
  });

  /**
   * TC-INT-10 — the other side of the same property: refusing to SERVE an entry is not deleting it.
   *
   * GREEN AT PHASE 1 BY CONSTRUCTION (nothing has ever touched the cache on this path). It is here
   * because the pre-check's placement makes "the deadline poisons the cache" a plausible next
   * defect, and because the two directions are separately assertable. Its killing mutation: have the
   * pre-check evict or negative-write `b`'s slot on the way past — the second call below then misses
   * and reports `cache: 'miss'`.
   */
  it('TC-INT-10: the entry survives untouched — the next call with a whole budget gets it as a hit', async () => {
    const { registry, cache } = fixture();

    await outcomeOf(registry.resolve(CAP, CHAIN, {}, Date.now() + 20));
    const second = await registry.resolve(CAP, CHAIN, {});

    expect(second).toEqual({
      result: { cached: true },
      source: 'b',
      cache: 'hit',
      ageMs: 1_234,
      // A HIT can still name an entry (cycle 2, F-4): `a` was walked first and its `fetch()` threw,
      // so the walk DID enter a source before `b`'s stored answer was served. That is precisely the
      // case a reading derived from `source` alone cannot see.
      attempted: ['a'],
    });
    expect(cache.setCalls).toEqual([]);
  });
});

/**
 * Adversarial cycle 2, finding F-2 — the limiter must not sleep away a budget the NEXT adapter
 * could still use.
 *
 * The production shape, with production's own numbers: `entity.labels` routes the free `blockscout`
 * first and the paid `nansen` behind it, `blockscout`'s bucket is `{capacity: 5, refillPerSec: 2}`
 * and one `entity.labels` call weighs 3 tokens. A burst leaves a 30 000 ms backlog; the walk arrives
 * with 31 000 ms of ceiling left.
 *
 * **What the tree did before the fix, measured by running this case against it:** `waitMs (30 000)
 * > remainingMs (31 000)` is false, so the limiter served the full 30 000 ms wait; the request then
 * went out with 1 000 ms left and consumed 5 000; the registry's pre-check found the ceiling gone and
 * refused `nansen` — whose bucket was idle and for whom all 31 000 ms had been real — with "deadline
 * exceeded before this source could be attempted". A free provider's saturated bucket cancelled the
 * paid provider. That is H-1, produced by the branch `DeadlineWouldExceedError` exists to prevent it
 * with, which is why the case belongs here and not only in `rate-limit.test.ts`.
 *
 * **Virtual clock, and the one thing it cannot do** — same mechanism and same caveat as
 * `entity-labels-deadline-arithmetic.test.ts`: `Date` is faked, so the limiter's wait and the hop's
 * duration are advances this file makes by hand, while `AbortSignal.timeout` (a native timer) cannot
 * fire. Production would cut the hop mid-flight; here it runs to completion and the verdict lands on
 * the next `Date.now()`-based check. Both directions of the case are read from that same clock, so
 * the comparison is unaffected.
 */
describe('cycle 2 F-2 — a saturated free bucket does not cancel the paid adapter behind it', () => {
  const LABELS = 'entity.labels';
  /** A real EVM address — since M-6 the adapter validates before building a URL. */
  const BINANCE = '0x28C6c06298d514Db089934071355E5743bf21d60';
  const BLOCKSCOUT_RATE_LIMIT = adapterRegistrations.find((r) => r.id === 'blockscout')!.rateLimit;
  /** `blockscout/index.ts`'s `WEIGHT_ADDRESS_INFO` — not exported, mirrored like the other constants
   * these deadline suites mirror. */
  const LABELS_WEIGHT = 3;
  /** `MAX_WAIT_MS`, the deepest backlog the limiter will still serve. */
  const BACKLOG_MS = 30_000;
  /** One `blockscout` hop — `REQUEST_TIMEOUT_MS`. The fixture answers on the first hop. */
  const HOP_MS = 5_000;
  /** 31 000: one second more than the backlog, so the OLD comparison admitted the wait. */
  const CEILING_MS = BACKLOG_MS + 1_000;
  const T0 = Date.UTC(2026, 7, 5, 12, 0, 0);

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('TC-F2-INT: with 31 s left and a 30 s backlog, nansen is ASKED instead of being timed out', async () => {
    const limiterWaits: number[] = [];
    /** While true a wait belongs to the OTHER callers whose backlog is being staged, not to the call
     * under test, so it must not move the clock — moving it would refill the bucket being drained. */
    let staging = true;
    const throttle = createThrottle({
      now: () => Date.now(),
      wait: (ms) => {
        if (!staging) {
          limiterWaits.push(ms);
          vi.setSystemTime(new Date(Date.now() + ms));
        }
        return Promise.resolve();
      },
    });

    // The backlog a burst of concurrent callers leaves behind: drive the bucket to the deficit at
    // which the next weight-3 call computes exactly `BACKLOG_MS`.
    const deficitBefore = (BACKLOG_MS / 1000) * BLOCKSCOUT_RATE_LIMIT.refillPerSec - LABELS_WEIGHT;
    for (let i = 0; i < BLOCKSCOUT_RATE_LIMIT.capacity + deficitBefore; i += 1) {
      await throttle('blockscout', BLOCKSCOUT_RATE_LIMIT, 1);
    }
    staging = false;

    // The free source: it would answer truthfully and unsatisfyingly (no metadata) if it were asked.
    const blockscoutHops: string[] = [];
    const blockscout = createBlockscoutAdapter({
      env: {},
      now: () => Date.now(),
      throttle,
      fetchImpl: async (input) => {
        blockscoutHops.push(new URL(String(input)).pathname);
        vi.setSystemTime(new Date(Date.now() + HOP_MS));
        return new Response(JSON.stringify({ data: { metadata: null } }), { status: 200 });
      },
    });

    // The paid source, as a stand-in that only has to record whether it was reached and answer
    // satisfyingly. Driving the real `nansen` here would add a budget ledger and four fixtures to a
    // case whose entire subject is the limiter's arithmetic one adapter earlier.
    const nansen = makeAdapter({
      id: 'nansen',
      normalizeImpl: () => [
        { chain: CHAIN, address: BINANCE, name: 'Binance', tags: ['cex'], labels: ['exchange'] },
      ],
    });

    // The PRODUCTION route object — its order and its answer policy are `providers.config.ts`'s,
    // not this file's. Only the ceiling is injected, because production's 60 000 would need a
    // proportionally larger backlog to say the same thing.
    const route = routes.find((candidate) => candidate.capability === LABELS);
    if (!route) throw new Error('no production route for entity.labels');
    expect(route.adapterIds).toEqual(['blockscout', 'nansen']);
    const registry = new CapabilityRegistry(
      [route],
      new Map<string, ProviderAdapter>([
        ['blockscout', blockscout],
        ['nansen', nansen],
      ]),
      undefined,
      null,
      { [LABELS]: { shape: 'set', ttlSeconds: 3600, deadlineMs: CEILING_MS } },
    );

    const outcome = await outcomeOf(
      registry.resolve(LABELS, CHAIN, { chain: CHAIN, tokenAddress: BINANCE }),
    );

    // (a) The paid source was ASKED — the whole finding. Before the fix this was zero.
    expect(nansen.deadlines).toHaveLength(1);
    // (b) ... and with a budget that was still worth something: the walk never slept.
    expect(limiterWaits).toEqual([]);
    expect(Date.now() - T0).toBe(0);
    // (c) The free source refused up front, so not a single request went to the vendor either.
    expect(blockscoutHops).toEqual([]);
    // (d) The outcome is nansen's answer, not the third outcome. Stated as a RETURN (not merely
    //     "did not throw"), which is the discriminator OD-4 made this file introduce.
    expect('returned' in outcome).toBe(true);
    expect((outcome as { returned: CapabilityResolution }).returned.source).toBe('nansen');
  });
});

/**
 * TC-REG-01 / TC-REG-02 are gates, not cases in this file, and are recorded here so a reader looking
 * for them finds where they live:
 *
 * - **TC-REG-01** — `resolve()` without a fourth argument behaves exactly as before: the other 61
 *   test files of this package plus all 35 of `mcp-server`'s call it that way, and task 012-8 edits
 *   none of them (`git diff --numstat` over `test/` shows zero deletions outside this new file).
 * - **TC-REG-02** — `test/fixtures/tools-list.snapshot.json` diffs to zero hunks (PLAN §0.8).
 */

/**
 * OQ-T012-6 — a walk in which EVERY source was entered and every one answered, and the clock ran
 * out on the last of them. Owner decision, 2026-08-05: **Reading A, with two conditions.**
 *
 * The record stood open because two accepted decisions disagreed about this one branch. H-1 says
 * `!hadFailure` means everyone was asked and everyone answered — a fact about the DATA, and turning
 * it into an error tells the caller to retry something that cannot change. Task 012-8's placement of
 * the pre-check said the opposite in its own justification: "a deadline means we do not answer after
 * this moment".
 *
 * **What was decided.** The answer is returned. Nothing was prevented and nothing was aborted; the
 * time — and on a paid route the credit — is already spent, and throwing it away does not give
 * either back, it only converts complete data into "retry later". Whether a late-but-complete answer
 * is still worth anything is a judgement only the caller can make, and the caller is the one who set
 * the deadline.
 *
 * **What was NOT decided is that it may be returned silently.** So the second condition: the overrun
 * travels with the resolution (`deadlineOverrunMs`) and `mcp-server` publishes it as `_meta.timing`.
 * The pre-check's own rationale was rewritten at the same time — the deadline bounds SPENDING, not
 * the moment of answering — because leaving that sentence in place would have closed the question in
 * the text while the code went the other way.
 *
 * These cases exist because the record said they should: "no test covers this branch today, and that
 * is deliberate — the test is written together with the decision, not before it."
 */
describe('OQ-T012-6 — every source answered, the last one ran long (owner: return it, and say so)', () => {
  /** Rejects the contentless answer both adapters give, so the walk reaches its end. */
  const NEEDS_CONTENT: PolicyDescriptor = { kind: 'someElementHasAny', fields: ['name'] };
  /** The record's own numbers: a 20 ms ceiling and a final source that spends 120 ms. */
  const CEILING_MS = 20;
  const SLOW_MS = 120;

  const contentless = (): unknown => [{ name: '' }];

  it('TC-OQ6-a: the complete answer is RETURNED, not thrown', async () => {
    const fast = makeAdapter({ id: 'fast', normalizeImpl: contentless });
    const slow = makeAdapter({
      id: 'slow',
      fetchImpl: async () => {
        blockFor(SLOW_MS);
        return { raw: true };
      },
      normalizeImpl: contentless,
    });
    const registry = buildRegistry({
      adapters: [fast, slow],
      deadlineMs: CEILING_MS,
      policy: NEEDS_CONTENT,
    });

    const outcome = await outcomeOf(registry.resolve(CAP, CHAIN, {}));

    // The premise: BOTH were entered, so `hadFailure` is false and this is genuinely the H-1 branch
    // rather than a walk that failed its way to the end.
    expect(fast.deadlines).toHaveLength(1);
    expect(slow.deadlines).toHaveLength(1);
    expect('returned' in outcome, JSON.stringify(outcome)).toBe(true);
    if (!('returned' in outcome)) throw new Error('expected a returned resolution');
    expect(outcome.returned.source).toBe('fast');
  });

  it('TC-OQ6-b: and it is MARKED late — the overrun rides along with it', async () => {
    const fast = makeAdapter({ id: 'fast', normalizeImpl: contentless });
    const slow = makeAdapter({
      id: 'slow',
      fetchImpl: async () => {
        blockFor(SLOW_MS);
        return { raw: true };
      },
      normalizeImpl: contentless,
    });
    const registry = buildRegistry({
      adapters: [fast, slow],
      deadlineMs: CEILING_MS,
      policy: NEEDS_CONTENT,
    });

    const resolution = await registry.resolve(CAP, CHAIN, {});

    expect(resolution.deadlineOverrunMs).toBeDefined();
    // At least the slow leg minus the whole ceiling — a bound, not an exact wall-clock number, so a
    // loaded machine cannot flip the verdict. `blockFor` never yields, so it cannot be shorter.
    expect(resolution.deadlineOverrunMs!).toBeGreaterThanOrEqual(SLOW_MS - CEILING_MS);
  });

  it('TC-OQ6-c: a walk INSIDE its ceiling carries no timing field at all — absent, not zero', async () => {
    // The other direction, and the reason the field is optional: if every answer carried
    // `deadlineOverrunMs: 0`, the mark would stop meaning anything and `_meta.timing` would appear on
    // every response — the "diagnostic nobody reads" shape, arrived at from the opposite side.
    const fast = makeAdapter({ id: 'fast', normalizeImpl: contentless });
    const alsoFast = makeAdapter({ id: 'also-fast', normalizeImpl: contentless });
    const registry = buildRegistry({
      adapters: [fast, alsoFast],
      deadlineMs: 5_000,
      policy: NEEDS_CONTENT,
    });

    const resolution = await registry.resolve(CAP, CHAIN, {});

    expect(resolution.source).toBe('fast');
    expect(resolution.deadlineOverrunMs).toBeUndefined();
    expect(Object.hasOwn(resolution, 'deadlineOverrunMs')).toBe(false);
  });

  it('TC-OQ6-d: a walk where a source FAILED still throws — the decision did not touch that', async () => {
    // H-1's own precondition is `!hadFailure`. "Everyone was asked and nobody has data" is the fact
    // being returned; "one source could not be asked" is an outage wearing its clothes, and it must
    // still reach the caller as an error rather than as a marked-late answer.
    const failing = makeAdapter({
      id: 'failing',
      fetchImpl: async () => {
        throw new Error('provider is down');
      },
    });
    const slow = makeAdapter({
      id: 'slow',
      fetchImpl: async () => {
        blockFor(SLOW_MS);
        return { raw: true };
      },
      normalizeImpl: contentless,
    });
    const registry = buildRegistry({
      adapters: [failing, slow],
      deadlineMs: CEILING_MS,
      policy: NEEDS_CONTENT,
    });

    const outcome = await outcomeOf(registry.resolve(CAP, CHAIN, {}));

    expect('thrown' in outcome).toBe(true);
    if (!('thrown' in outcome)) throw new Error('expected a throw');
    expect(outcome.thrown).toBeInstanceOf(CapabilityDeadlineExceededError);
  });
});
