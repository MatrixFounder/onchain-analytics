import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createBlockscoutAdapter } from '../src/adapters/blockscout/index.js';
import { createNansenAdapter } from '../src/adapters/nansen/index.js';
import {
  CapabilityDeadlineExceededError,
  CapabilityRegistry,
  CapabilityUnavailableError,
  type CapabilityResolution,
} from '../src/adapters/registry.js';
import type { CapabilityRoute, ProviderAdapter } from '../src/adapters/types.js';
import type { BudgetStore } from '../src/cache/budget-store.js';
import { createBudgetStore } from '../src/cache/budget-store.js';
import { dayBucketMs } from '../src/cache/day-bucket.js';
import { capabilityManifests } from '../src/capability-manifest.js';
import { CapabilityNotCoveredOnChainError } from '../src/chain/errors.js';
import { createThrottle, type TokenBucketConfig, type Throttle } from '../src/net/rate-limit.js';
import { adapterRegistrations, routes } from '../src/providers.config.js';
import { BLOCKSCOUT_TEST_ENV } from './helpers/blockscout-env.js';

/**
 * Task 012-10 — AC-8: the arithmetic of ONE `entity.labels` call, end to end, on a VIRTUAL clock.
 *
 * The chain is the production one: the free `blockscout` attempt, then `nansen` — whose own call
 * splits into a CANCELLABLE free `/account` resync and an UNCANCELLABLE paid leg behind the
 * committed reservation. Three legs, two of which the ceiling governs and one of which it must not.
 *
 * **Why this file exists at all — the tautology it is written against.** The first plan for AC-8
 * said "assert `deadlineMs + paidLegMs ≈ 330 s`". That reads two constants out of the manifest and
 * adds them: green on an engine with a perfect deadline, and equally green on an engine with no
 * deadline at all. Every assertion below is therefore made on the **observed elapsed virtual time**
 * at the moment of the outcome (`elapsedMs()`), and **never** on
 * `manifest.deadlineMs + manifest.paidLegMs`. The manifest is read only to state what the ceiling
 * IS; it is never the measurement.
 *
 * **Non-vacuity: the fixtures WANT longer than the ceiling allows.** The cancellable script asks for
 * `CANCELLABLE_WANT_MS` of virtual time — every component of it a measured per-hop or per-limiter
 * ceiling of the adapter it belongs to (see the table below), never a number chosen to make an
 * assertion land. A ceiling is only observable as a ceiling if it is seen cutting something that
 * wanted more, so TC-INT-01a also asserts how many of the scripted hops actually ran.
 *
 * **The virtual clock, and the one thing it cannot do.** `vi.useFakeTimers({ toFake: ['Date'] })`
 * makes `Date.now()` — the clock `CapabilityRegistry`, `safeFetch` and `createThrottle` all read —
 * a value this file moves by hand; real timers keep working, so nothing hangs. What it deliberately
 * cannot do is fire `AbortSignal.timeout`, which is a native timer: production cuts a hop MID-FLIGHT
 * with that signal, and a virtual jump cannot. So the cut observed here always lands on the next
 * `Date.now()`-based check production makes — `safeFetch`'s per-hop entry check
 * (`safe-fetch.ts`, the per-hop `deadlineAtMs - Date.now() <= 0` check) or the limiter's
 * `remainingMs` branches (`rate-limit.ts`, `if (deadlineAtMs !== undefined)`). The
 * elapsed time this file observes at the cut is therefore an **upper bound** on production's, which
 * is the safe direction for a ceiling: a defect that let the walk run longer still fails here.
 *
 * **Zero live credits.** Every budget store is `dbPath: ':memory:'`, every adapter is constructed
 * with an explicit `env` (never ambient `process.env`), every byte of transport comes from an
 * injected `fetchImpl` serving RECORDED fixtures, and no fixture is recorded here. The real ledger
 * (`~/.onchain-intel/cache.sqlite3`) is never opened.
 */

const testDir = path.dirname(fileURLToPath(import.meta.url));

/** Virtual epoch — mid-day UTC, so 305 s of virtual time cannot cross a `dayBucketMs` boundary. */
const T0 = Date.UTC(2026, 6, 24, 12, 0, 0);
const BUCKET = dayBucketMs(T0);
const ENV = { NANSEN_API_KEY: 'test-key-not-real' };
const CHAIN = 'ethereum';
/** The address the two "no labels" fixtures were recorded against (`nansen.contract.test.ts`). */
const DUST_HOLDER = '0x1234567890123456789012345678901234567890';

/**
 * The fixture SCRIPT, in measured components. Nothing here is tuned to an expected answer:
 *
 * | Constant             | Value    | Source                                                        |
 * | -------------------- | -------- | ------------------------------------------------------------- |
 * | `HOP_MS.blockscout`  | 5 000    | `REQUEST_TIMEOUT_MS`, `adapters/blockscout/index.ts:164`      |
 * | `HOP_MS.nansen`      | 15 000   | `DEFAULT_TIMEOUT_MS`, `net/safe-fetch.ts` (E-HTTP15)          |
 * | `HOPS_PER_CALL`      | 4        | `MAX_REDIRECTS = 3` ⇒ three redirects plus the final response |
 * | `LIMITER_CAP_MS`     | 30 000   | `MAX_WAIT_MS`, `net/rate-limit.ts:57`                          |
 *
 * They are mirrored rather than imported because none of the four is exported; PLAN §0.2 states the
 * same four numbers when it derives the envelopes.
 */
const HOP_MS = { blockscout: 5_000, nansen: 15_000 } as const;
const HOPS_PER_CALL = 4;
const LIMITER_CAP_MS = 30_000;

/** `30 + 4×5` = 50 000 — PLAN §0.2's envelope for the free `blockscout` attempt (E-HTTP5). */
const BLOCKSCOUT_LEG_WANT_MS = LIMITER_CAP_MS + HOPS_PER_CALL * HOP_MS.blockscout;
/**
 * The `/account` resync's transport script: four hops of E-HTTP15 = 60 000.
 *
 * PLAN §0.2 publishes this leg's envelope as `30 + 4×15` = 90 000, and the missing 30 000 is the
 * limiter's own fairness cap. It is ABSENT here, and that is a finding rather than an omission: with
 * 10 000 ms left on the ceiling, a bucket backlog of 30 000 ms is refused up front by
 * `DeadlineWouldExceedError` (`rate-limit.ts`, the `MIN_POST_WAIT_REMAINDER_MS` branch — cycle 2's
 * F-2 widened that refusal from "the wait does not fit" to "the wait leaves nothing usable", which
 * makes this leg's absence MORE certain, never less) — which by design is NOT a deadline hit, so the
 * walk would end as `CapabilityUnavailableError` and the case would be asserting a different
 * outcome. The two worst cases (50 000 + 90 000 = 140 000) are therefore not jointly realisable
 * under a 60 000 ms ceiling: the limiter refuses rather than partially waits. Recorded in
 * `docs/architectures/open-questions.md` (task 012-10).
 */
const RESYNC_LEG_WANT_MS = HOPS_PER_CALL * HOP_MS.nansen;
/** What the cancellable part of ONE call asks for, in total, before anything cuts it. */
const CANCELLABLE_WANT_MS = BLOCKSCOUT_LEG_WANT_MS + RESYNC_LEG_WANT_MS;

/** `entity.labels` with a `tokenAddress`: search/general + search/entity-name + tgm/holders. */
const PAID_SUBCALLS = 3;
/** One paid sub-call at its published envelope: `30 + 4×15` = 90 000 (E-HTTP15). */
const PAID_SUBCALL_WANT_MS = LIMITER_CAP_MS + HOPS_PER_CALL * HOP_MS.nansen;
/** `3 × 90 000` = 270 000 — the uncancellable leg, which the ceiling may not touch (R-141). */
const PAID_LEG_WANT_MS = PAID_SUBCALLS * PAID_SUBCALL_WANT_MS;

/**
 * The SHIPPED manifest row — the ceiling under test is production's, never a literal typed here.
 *
 * Stated rather than asserted away with a `!` (`noUncheckedIndexedAccess` is on): if the row ever
 * disappears, this file must say so by name instead of failing six assertions later on `undefined`.
 */
const MANIFEST = capabilityManifests['entity.labels'];
if (MANIFEST === undefined) throw new Error('no capability manifest row for entity.labels');

function fixtureBody(name: string): unknown {
  return JSON.parse(
    readFileSync(path.join(testDir, 'fixtures', 'nansen', `${name}.json`), 'utf8'),
  ) as unknown;
}

/**
 * Vendor path → the RECORDED fixture that answers it, plus the `X-Nansen-Credits-Used` it carries.
 *
 * The two "no labels" fixtures are the ones this file needs: `entity.labels` must come back
 * TRUTHFUL BUT UNSATISFYING, because a satisfying paid answer ends the walk with a return and the
 * case has nothing left to observe. Both were recorded for exactly that shape
 * (`nansen.contract.test.ts` TC-CONTRACT-03). `search/entity-name` has no recorded fixture in the
 * repo and its body is read by nobody (`normalize.ts` never touches it), so it answers with the
 * empty envelope — the same choice, for the same reason, that
 * `nansen-deadline-boundary.test.ts` documents.
 */
const VENDOR_RESPONSES: Record<string, { body: unknown; credits: string | null }> = {
  '/api/v1/account': { body: fixtureBody('account.free'), credits: null },
  '/api/v1/search/general': { body: fixtureBody('search-general.empty'), credits: '0' },
  '/api/v1/search/entity-name': { body: { data: [] }, credits: '0' },
  '/api/v1/tgm/holders': { body: fixtureBody('tgm-holders.empty-labels'), credits: '5' },
};

/** Blockscout's "I have no metadata for this address" body — `blockscout-fallback.test.ts`'s own
 * `NO_TAGS`, which is what makes the free source's answer truthful and unsatisfying. */
const BLOCKSCOUT_NO_TAGS = { data: { metadata: null } };

function rateLimitOf(id: string): TokenBucketConfig {
  const registration = adapterRegistrations.find((entry) => entry.id === id);
  if (!registration) throw new Error(`no registration for ${id}`);
  return registration.rateLimit;
}

/** Observed elapsed VIRTUAL time since the walk's own start — the only quantity this file asserts
 * a duration on. */
function elapsedMs(): number {
  return Date.now() - T0;
}

function advance(ms: number): void {
  if (ms > 0) vi.setSystemTime(new Date(Date.now() + ms));
}

interface Harness {
  registry: CapabilityRegistry;
  budgetStore: BudgetStore;
  /** Vendor pathname per `fetchImpl` invocation, in order — one entry per HOP, not per sub-call. */
  vendorHops: string[];
  /** Limiter waits actually served during the walk (staging excluded), in order. */
  limiterWaits: number[];
  lateSourceCalls: () => number;
  reserveElapsedMs: () => number | undefined;
  /** Saturates `blockscout`'s bucket so its next weight-3 call waits the full fairness cap. */
  saturateBlockscout: () => Promise<void>;
}

/**
 * Builds the production three-leg chain behind one injected transport and one injected limiter.
 *
 * `accountRedirects` scripts the free resync: `3` makes it the full four-hop worst case (the shape
 * PLAN §0.2's `4×15` envelope is derived from), `0` makes it a single hop that answers.
 * `instant` collapses every nansen hop to zero virtual time — the CONTROL negative, TC-INT-02.
 * `stagePaidBacklog` puts a fairness-cap backlog in front of each paid sub-call, which is the
 * limiter half of the `3 × 90 000` envelope.
 */
function buildHarness(opts: {
  accountRedirects: number;
  instant?: boolean;
  stagePaidBacklog?: boolean;
}): Harness {
  const instant = opts.instant === true;
  const vendorHops: string[] = [];
  const limiterWaits: number[] = [];
  let lateCalls = 0;
  let reserveElapsed: number | undefined;
  let reserveSeen = false;
  /** While true, a limiter wait does NOT move the clock: it belongs to the OTHER, concurrent callers
   * whose backlog is being staged, not to the call under test. Without it the staging would refill
   * the very bucket it is draining. */
  let staging = false;

  const redirect = (url: URL, nextHop: number): Response => {
    const next = new URL(url.toString());
    next.searchParams.set('hop', String(nextHop));
    return new Response(null, { status: 302, headers: { location: next.toString() } });
  };

  const fetchImpl: typeof fetch = async (input) => {
    const url = new URL(String(input));
    const hop = Number(url.searchParams.get('hop') ?? '1');
    vendorHops.push(url.pathname);

    if (url.hostname === 'mcp.blockscout.com') {
      advance(HOP_MS.blockscout);
      if (hop < HOPS_PER_CALL) return redirect(url, hop + 1);
      return new Response(JSON.stringify(BLOCKSCOUT_NO_TAGS), { status: 200 });
    }

    advance(instant ? 0 : HOP_MS.nansen);
    const redirectsFor =
      url.pathname === '/api/v1/account' ? opts.accountRedirects : instant ? 0 : HOPS_PER_CALL - 1;
    if (hop <= redirectsFor) return redirect(url, hop + 1);

    const canned = VENDOR_RESPONSES[url.pathname];
    if (!canned) throw new Error(`unrouted test call to ${url.pathname}`);
    return new Response(JSON.stringify(canned.body), {
      status: 200,
      headers: canned.credits === null ? {} : { 'x-nansen-credits-used': canned.credits },
    });
  };

  // ONE limiter instance for both providers, exactly as production shares one singleton; the
  // buckets are per `providerId` inside it. Its clock IS the virtual clock, so the limiter's
  // `remainingMs` arithmetic and the registry's deadline cannot disagree about what "now" was.
  const realThrottle = createThrottle({
    now: () => Date.now(),
    wait: (ms) => {
      if (!staging) {
        limiterWaits.push(ms);
        advance(ms);
      }
      return Promise.resolve();
    },
  });

  /**
   * Puts a backlog in `providerId`'s bucket so that the NEXT call of `weight` waits exactly
   * `targetWaitMs`. The backlog is what a burst of concurrent callers leaves behind — the only
   * situation in which `MAX_WAIT_MS` is reachable at all (`rate-limit.ts`'s own docstring), and
   * therefore the only honest way to put the limiter half of a measured envelope on the clock.
   */
  async function stageBacklog(
    providerId: string,
    config: TokenBucketConfig,
    targetWaitMs: number,
    weight: number,
  ): Promise<void> {
    staging = true;
    const deficitBefore = (targetWaitMs / 1000) * config.refillPerSec - weight;
    for (let i = 0; i < config.capacity + deficitBefore; i += 1) {
      await realThrottle(providerId, config, 1);
    }
    staging = false;
  }

  const throttle: Throttle = async (providerId, config, weight, deadlineAtMs) => {
    if (opts.stagePaidBacklog === true && reserveSeen && providerId === 'nansen') {
      await stageBacklog(providerId, config, LIMITER_CAP_MS, weight ?? 1);
    }
    return realThrottle(providerId, config, weight, deadlineAtMs);
  };

  const budgetStore = createBudgetStore({ dbPath: ':memory:' });
  const reserve = budgetStore.checkAndReserve.bind(budgetStore);
  vi.spyOn(budgetStore, 'checkAndReserve').mockImplementation(
    async (...args: Parameters<BudgetStore['checkAndReserve']>) => {
      const result = await reserve(...args);
      // ONLY on success: a refused reservation commits nothing, so it is not the boundary.
      if (result.ok) {
        reserveSeen = true;
        reserveElapsed = elapsedMs();
      }
      return result;
    },
  );

  const blockscout = createBlockscoutAdapter({
    now: () => Date.now(),
    env: BLOCKSCOUT_TEST_ENV,
    throttle,
    fetchImpl,
  });
  const nansen = createNansenAdapter({
    env: ENV,
    fetchImpl,
    throttle,
    budgetStore,
    now: () => Date.now(),
  });

  /**
   * A third source on the route, and the reason it is here rather than in `providers.config.ts`:
   * `CapabilityDeadlineExceededError`'s contract is that `tried[]` names BOTH groups — who answered
   * before the clock ran out, and who was never asked at all. Today's production route has exactly
   * two adapters with the paid one LAST, so the second group can never be non-empty on it. The
   * production composition is asserted below, so this stand-in cannot quietly become a claim about
   * a route that does not exist.
   *
   * It answers UNSATISFYINGLY (no name, no tags, no labels) so that, in the control negative where
   * it IS reached, the walk has one deterministic outcome instead of two.
   */
  const lateSource: ProviderAdapter = {
    id: 'late-source',
    capabilities: () => [{ id: 'entity.labels' }],
    costOf: () => ({ credits: 0 }),
    fetch: () => {
      lateCalls += 1;
      return Promise.resolve({ kind: 'late' });
    },
    normalize: () => [
      { chain: CHAIN, address: DUST_HOLDER, tags: [], labels: [], source: 'late-source' },
    ],
  };

  const production = routes.find((route) => route.capability === 'entity.labels');
  if (!production) throw new Error('no production route for entity.labels');
  // The stand-in is APPENDED to the production route object, so the capability, the policy
  // descriptor and the order of the two real adapters all come from `providers.config.ts`.
  expect(production.adapterIds).toEqual(['blockscout', 'nansen']);
  const route: CapabilityRoute = {
    ...production,
    adapterIds: [...production.adapterIds, 'late-source'],
  };

  return {
    registry: new CapabilityRegistry(
      [route],
      new Map<string, ProviderAdapter>([
        ['blockscout', blockscout],
        ['nansen', nansen],
        ['late-source', lateSource],
      ]),
      // No cache store: the default `PassthroughCacheStore` is always a miss, so every leg of every
      // case below is genuinely walked.
      undefined,
      // `null` = the shipped chain registry, exactly as production wires it.
      null,
      // The manifest is the SHIPPED one (default) — the ceiling under test is production's 60 000.
    ),
    budgetStore,
    vendorHops,
    limiterWaits,
    lateSourceCalls: () => lateCalls,
    reserveElapsedMs: () => reserveElapsed,
    saturateBlockscout: () =>
      stageBacklog('blockscout', rateLimitOf('blockscout'), LIMITER_CAP_MS, 3),
  };
}

/**
 * Settles a `resolve()` into a shape that can tell a RETURN from a THROW — the discriminator
 * `registry.deadline.test.ts` introduced. OD-4's "never a partial answer" is a statement about what
 * was NOT returned, and `rejects` alone cannot make it.
 */
async function outcomeOf(
  pending: Promise<CapabilityResolution>,
): Promise<{ returned: CapabilityResolution } | { thrown: unknown }> {
  return pending.then(
    (returned) => ({ returned }),
    (thrown: unknown) => ({ thrown }),
  );
}

const ARGS = { chain: CHAIN, tokenAddress: DUST_HOLDER };

describe('AC-8 — one entity.labels call, cancellable and uncancellable parts (task 012-10)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(T0);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  /**
   * TC-INT-01a — the CANCELLABLE part is CUT.
   *
   * Script: the free `blockscout` attempt asks for its whole 50 000 ms envelope (a fairness-cap
   * backlog plus four hops) and gets it; the free `/account` resync then asks for four more hops of
   * 15 000 ms and gets ONE, because the ceiling is spent inside it.
   *
   * The assertion is the OBSERVED elapsed virtual time at the throw — 65 000 ms: the 60 000 ms
   * ceiling plus the tail of the single hop that was in flight when it passed (see this file's
   * header for why a virtual clock cannot fire the mid-flight abort that would end it at exactly
   * 60 000). Against a script that wanted 110 000 ms, that is the ceiling cutting 45 000 ms of work
   * — and `vendorHops` says which work, by name.
   */
  it('TC-INT-01a: the ceiling cuts the cancellable part; nothing paid is ever started', async () => {
    const harness = buildHarness({ accountRedirects: HOPS_PER_CALL - 1 });
    await harness.saturateBlockscout();

    const outcome = await outcomeOf(harness.registry.resolve('entity.labels', CHAIN, ARGS));
    const elapsedAtOutcome = elapsedMs();

    // (a) The outcome is a THROW, of the class that says whose fault the failure was.
    expect('returned' in outcome).toBe(false);
    const thrown = (outcome as { thrown: unknown }).thrown;
    expect(thrown).toBeInstanceOf(CapabilityDeadlineExceededError);
    expect(thrown).not.toBeInstanceOf(CapabilityUnavailableError);
    expect(thrown).not.toBeInstanceOf(CapabilityNotCoveredOnChainError);

    // (b) BOTH groups named: who answered and with what, and who was never asked at all.
    const tried = (thrown as CapabilityDeadlineExceededError).tried;
    expect(tried.map((entry) => entry.adapterId)).toEqual(['blockscout', 'nansen', 'late-source']);
    expect(tried[0]!.reason).toContain('answered, but not with what was asked for');
    expect(tried[1]!.reason).toContain('deadline exceeded');
    expect(tried[2]!.reason).toBe('deadline exceeded before this source could be attempted');
    expect(harness.lateSourceCalls()).toBe(0);

    // (c) The measurement. Observed elapsed virtual time — NEVER `deadlineMs + paidLegMs`.
    expect(elapsedAtOutcome).toBe(65_000);
    // The ceiling was reached (the walk did not stop early for some other reason) ...
    expect(elapsedAtOutcome).toBeGreaterThanOrEqual(MANIFEST.deadlineMs);
    // ... and it cut a script that wanted longer. This is the whole non-tautology: a run that
    // finished inside what the fixtures asked for has not demonstrated a ceiling.
    expect(CANCELLABLE_WANT_MS).toBeGreaterThan(MANIFEST.deadlineMs);
    expect(elapsedAtOutcome).toBeLessThan(CANCELLABLE_WANT_MS);
    // Named, not inferred: blockscout ran all four of its scripted hops, the resync ran ONE of its
    // four, and the three that never ran are the 45 000 ms the ceiling removed.
    expect(harness.vendorHops.filter((p) => p === '/v1/get_address_info')).toHaveLength(
      HOPS_PER_CALL,
    );
    expect(harness.vendorHops.filter((p) => p === '/api/v1/account')).toHaveLength(1);
    // The limiter served the fairness cap once, to the free attempt, while the deadline was alive.
    expect(harness.limiterWaits).toEqual([LIMITER_CAP_MS]);

    // (d) Nothing paid was started: no reservation, no paid vendor path, an untouched ledger.
    expect(harness.reserveElapsedMs()).toBeUndefined();
    expect(harness.vendorHops.some((p) => p.startsWith('/api/v1/search'))).toBe(false);
    expect(harness.vendorHops.some((p) => p === '/api/v1/tgm/holders')).toBe(false);
    expect(await harness.budgetStore.getUsage('nansen', BUCKET)).toBe(0);
  });

  /**
   * TC-INT-01b — the cancellable part FITS, and the uncancellable one plays out in full.
   *
   * Script: `blockscout` answers in 20 000 ms (no backlog this time) and the resync answers in one
   * 15 000 ms hop, so the reservation is committed at 35 000 ms — inside the 60 000 ms ceiling. The
   * paid leg then runs its own measured 270 000 ms (three sub-calls, each a fairness-cap wait plus
   * four hops) and the ceiling may not touch a second of it (R-141): the credit is already spent, so
   * cancelling would mean paying and not receiving.
   *
   * The assertion is again the OBSERVED elapsed time — and the load-bearing one is a DIFFERENCE
   * between two observations (`throw` minus `reserve`), which no arithmetic on manifest constants
   * can produce.
   */
  it('TC-INT-01b: the paid leg runs past the ceiling in full, and the credit is not refunded', async () => {
    const harness = buildHarness({ accountRedirects: 0, stagePaidBacklog: true });

    const outcome = await outcomeOf(harness.registry.resolve('entity.labels', CHAIN, ARGS));
    const elapsedAtOutcome = elapsedMs();
    const elapsedAtReserve = harness.reserveElapsedMs();

    // (a) A throw, of the same typed class, for a different reason: the walk outlived its ceiling.
    expect('returned' in outcome).toBe(false);
    const thrown = (outcome as { thrown: unknown }).thrown;
    expect(thrown).toBeInstanceOf(CapabilityDeadlineExceededError);
    expect(thrown).not.toBeInstanceOf(CapabilityUnavailableError);

    // (b) BOTH groups again — and this time the source that answered "no labels" is the PAID one,
    // which is the H-1 distinction the third outcome exists to keep honest.
    const tried = (thrown as CapabilityDeadlineExceededError).tried;
    expect(tried.map((entry) => entry.adapterId)).toEqual(['blockscout', 'nansen', 'late-source']);
    expect(tried[0]!.reason).toContain('answered, but not with what was asked for');
    expect(tried[1]!.reason).toContain('answered, but not with what was asked for');
    expect(tried[2]!.reason).toBe('deadline exceeded before this source could be attempted');
    expect(harness.lateSourceCalls()).toBe(0);

    // (c) The cancellable part genuinely FIT — this is what separates 01b from 01a.
    expect(elapsedAtReserve).toBeDefined();
    expect(elapsedAtReserve!).toBe(35_000);
    expect(elapsedAtReserve!).toBeLessThan(MANIFEST.deadlineMs);

    // (d) The measurement: the uncancellable leg ran its REAL duration, observed as the difference
    // between two moments this run produced. Not `manifest.paidLegMs`, and not a sum of constants.
    expect(elapsedAtOutcome - elapsedAtReserve!).toBe(PAID_LEG_WANT_MS);
    expect(elapsedAtOutcome).toBe(305_000);
    // The walk therefore outlived its own ceiling by a factor of five, deliberately.
    expect(elapsedAtOutcome).toBeGreaterThan(MANIFEST.deadlineMs);
    // Fixture fidelity, stated separately from the measurement above: the script this file wrote is
    // the envelope the manifest publishes for the paid leg.
    expect(PAID_LEG_WANT_MS).toBe(MANIFEST.paidLegMs);

    // (e) Nothing was cut: all three sub-calls, all four hops each, and three fairness-cap waits
    // BETWEEN them — the waits are the half a limiter-only reading of R-141 would have lost.
    for (const paidPath of [
      '/api/v1/search/general',
      '/api/v1/search/entity-name',
      '/api/v1/tgm/holders',
    ]) {
      expect(
        harness.vendorHops.filter((p) => p === paidPath),
        paidPath,
      ).toHaveLength(HOPS_PER_CALL);
    }
    expect(harness.limiterWaits).toEqual([LIMITER_CAP_MS, LIMITER_CAP_MS, LIMITER_CAP_MS]);

    // (f) The credit stays SPENT: 0 + 0 + 5 reserved, 0 + 0 + 5 reported, delta 0 — not a refund.
    expect(await harness.budgetStore.getUsage('nansen', BUCKET)).toBe(5);
  });

  /**
   * TC-INT-02 — the CONTROL NEGATIVE, recorded as insufficient rather than left to look like proof.
   *
   * The same three legs with an INSTANT nansen fixture: no hop costs virtual time, no backlog is
   * staged, nothing ever expires. Every assertion below then holds under an engine that honours the
   * paid boundary AND under one that does not. Measured, not asserted: this case was re-run under
   * task 012-10's MUTATION 3 (the boundary after `checkAndReserve()` removed — TC-INT-01b died with
   * "expected CapabilityUnavailableError … to be an instance of CapabilityDeadlineExceededError")
   * and under MUTATION 1 (the registry's pre-check and terminal branch removed — TC-INT-01a and
   * TC-INT-01b both died), and it stayed GREEN under both. It is therefore evidence of nothing about
   * AC-8, and it is kept only to make that fact reproducible: a fixture with no duration gives a
   * deadline test no input on which it can fail.
   */
  it('TC-INT-02 (control negative — proves nothing): an instant fixture completes under any engine', async () => {
    const harness = buildHarness({ accountRedirects: 0, instant: true });

    const outcome = await outcomeOf(harness.registry.resolve('entity.labels', CHAIN, ARGS));
    const elapsedAtOutcome = elapsedMs();

    // Nothing expired, so the walk reaches its last source and H-1 returns the first truthful
    // answer — a RETURN, not the third outcome.
    expect('returned' in outcome).toBe(true);
    expect((outcome as { returned: CapabilityResolution }).returned.source).toBe('blockscout');
    expect(harness.lateSourceCalls()).toBe(1);
    // The paid leg completed and the credit is not refunded — the same two facts TC-INT-01b
    // asserts, reached here without a clock at all. Only `blockscout`'s four hops cost time.
    expect(await harness.budgetStore.getUsage('nansen', BUCKET)).toBe(5);
    expect(harness.vendorHops.filter((p) => p === '/api/v1/tgm/holders')).toHaveLength(1);
    expect(elapsedAtOutcome).toBe(HOPS_PER_CALL * HOP_MS.blockscout);
    // The point, as an assertion: the whole call finished INSIDE the ceiling, so no implementation
    // of the ceiling could have been observed by it.
    expect(elapsedAtOutcome).toBeLessThan(MANIFEST.deadlineMs);
  });
});
