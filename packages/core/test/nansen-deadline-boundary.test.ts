import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { createDuneAdapter } from '../src/adapters/dune/index.js';
import { createNansenAdapter } from '../src/adapters/nansen/index.js';
import { CapabilityDeadlineExceededError, CapabilityRegistry } from '../src/adapters/registry.js';
import type {
  AdapterRegistration,
  CapabilityRoute,
  ProviderAdapter,
} from '../src/adapters/types.js';
import type { BudgetStore } from '../src/cache/budget-store.js';
import { createBudgetStore } from '../src/cache/budget-store.js';
import { dayBucketMs } from '../src/cache/day-bucket.js';
import type { CapabilityManifest } from '../src/capability-manifest.js';
import { createThrottle, type Throttle } from '../src/net/rate-limit.js';
import { DeadlineExceededError, safeFetch } from '../src/net/safe-fetch.js';
import { adapterRegistrations } from '../src/providers.config.js';

/**
 * Task 012-9 — the PAID boundary: after `checkAndReserve()` has committed, the call deadline is
 * handed to NOTHING (ADR-002 D4 п.2, R-141, AC-10).
 *
 * **Why the boundary is `checkAndReserve()` and not the entry to `ensureBudget()`.** The free
 * `/account` resync runs INSIDE `ensureBudget()`, before the reservation, and it is half of the
 * measured cancellable part of a Nansen call. Cutting the deadline off at the gate's front door
 * would take it away from exactly the step the cancellable window exists for. So: everything up to
 * and including the resync is told the deadline; everything from the committed reservation onward is
 * not — sub-call 1, sub-calls 2..N, and the limiter waits BETWEEN them. The reservation is made for
 * the SUM of the sub-calls' prices, so abandoning sub-call 2 after paying for both is the same
 * "paid and did not receive" one step later.
 *
 * **Its own file, not an addition to `nansen.contract.test.ts`** (task file, §"Новые файлы"): that
 * file is sha256-pinned in `docs/provenance.json` alongside the nine `test/fixtures/nansen/*`
 * fixtures, and the hashes are re-checked on every run. Appending to it would redden the provenance
 * gate until a re-baseline — i.e. this task would "break" the fixture-authenticity check to make
 * room for its own test. A separate file does not touch it.
 *
 * **Methodology `tdd-strict` (PLAN §0.9).** Every case carries an `EXPECTED_FAIL_REASON` and was run
 * RED against phase 1 (`safeFetchImpl` declared on the deps types but not plumbed, `deadlineAtMs`
 * declared on `nansen.fetch()` and ignored) before any of the logic existed. Cases that are green by
 * construction say so in place and name the mutation that kills them, the form tasks 012-7 and 012-8
 * used.
 *
 * **Zero live credits (TC-REG-02).** Every budget store here is `dbPath: ':memory:'`, every adapter
 * gets an explicit `env` (never ambient `process.env`), every network call goes through an injected
 * `fetchImpl` serving RECORDED fixtures, and no fixture is recorded by this file. The real ledger
 * (`~/.onchain-intel/cache.sqlite3`) is never opened.
 */

const testDir = path.dirname(fileURLToPath(import.meta.url));

/** Fixed wall clock for `dayBucketMs`/`fetchedAt` only. Deadlines below are REAL `Date.now()`
 * values, because `safeFetch`'s own deadline arithmetic reads the real clock and cannot be injected
 * (PLAN §0.3 fixes the number of seams this milestone builds; a clock seam is not among them). */
const NOW = Date.UTC(2026, 6, 24, 12, 0, 0);
const BUCKET = dayBucketMs(NOW);
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const ENV = { NANSEN_API_KEY: 'test-key-not-real' };

/** Real-timer-free token-bucket clock — the `nansen.singleflight.test.ts` precedent. It bounds only
 * the LIMITER's waits; it is deliberately NOT the clock the deadline is measured against. */
function fakeClock(startMs = 0): { now: () => number; wait: (ms: number) => Promise<void> } {
  let current = startMs;
  return {
    now: () => current,
    wait: (ms: number): Promise<void> => {
      current += ms;
      return Promise.resolve();
    },
  };
}

/** Burns `ms` of wall clock WITHOUT yielding — the `registry.deadline.test.ts` / `safe-fetch.test.ts`
 * precedent. `await setTimeout()` would hand the event loop back and turn "the deadline passed
 * during the paid leg" into a scheduling coin flip. */
function blockUntil(atMs: number, capMs: number): void {
  const until = Math.min(atMs, Date.now() + capMs);
  while (Date.now() < until) {
    /* spin — see the docstring */
  }
}

function fixtureBody(name: string): unknown {
  return JSON.parse(
    readFileSync(path.join(testDir, 'fixtures', 'nansen', `${name}.json`), 'utf8'),
  ) as unknown;
}

/**
 * Vendor path → the RECORDED fixture that answers it, and the `X-Nansen-Credits-Used` value the
 * response carries.
 *
 * The two `search/*` entries are the one place this table does not reproduce the recording verbatim,
 * and it is deliberate: `search-general.evidence.md` records `x_nansen_credits_used: (absent)`, and
 * an absent header makes `reconcile()` degrade the WHOLE adjustment to zero (its documented
 * fail-safe). That degrade path is `nansen.reconcile.test.ts`'s subject; here it would mask the
 * question this file asks — whether the reservation was settled or refunded — behind a third
 * outcome. `0` is also this endpoint's real price (`cost-table.ts`), so the sum still equals what
 * the gate reserved. `search/entity-name` has no recorded fixture at all (none of the nine is one),
 * and its body is consumed by nobody (`normalize.ts` never reads it), so it answers with the empty
 * envelope rather than with a fixture this task is forbidden to record.
 */
const VENDOR_RESPONSES: Record<string, { body: unknown; credits: string | null }> = {
  '/api/v1/account': { body: fixtureBody('account.free'), credits: null },
  '/api/v1/smart-money/netflow': { body: fixtureBody('smart-money-netflow'), credits: '5' },
  '/api/v1/tgm/holders': { body: fixtureBody('tgm-holders'), credits: '5' },
  '/api/v1/tgm/indicators': { body: fixtureBody('tgm-indicators'), credits: '5' },
  '/api/v1/tgm/token-information': { body: fixtureBody('tgm-token-information'), credits: '1' },
  '/api/v1/search/general': { body: fixtureBody('search-general'), credits: '0' },
  '/api/v1/search/entity-name': { body: { data: [] }, credits: '0' },
};

/** One observed call to a seam, with the ONE argument this file is about. `undefined` is recorded
 * rather than dropped — "no deadline was passed" is the assertion, so it has to be a value. */
interface Observation {
  kind: 'limiter' | 'transport';
  /** Provider id for the limiter, URL pathname for the transport. */
  target: string;
  deadlineAtMs: number | undefined;
}

interface Probe {
  adapter: ProviderAdapter;
  budgetStore: BudgetStore;
  /** Every limiter/transport call, in order. */
  observations: Observation[];
  /** Vendor pathnames as the injected `fetchImpl` saw them, in order. */
  calls: string[];
  /** `observations.length` at the moment `checkAndReserve()` returned `{ok:true}` — the boundary
   * itself, captured as an index so "before" and "after" are a slice and not a guess. */
  reserveIndex: () => number | undefined;
  recordDeltaCalls: () => number;
}

/**
 * Builds a fully-instrumented `nansen` adapter: recorded fixtures behind an injected `fetchImpl`,
 * an injected limiter on a virtual clock, an injected transport (`safeFetchImpl`, the seam OD-6
 * ordered built), and an in-memory budget ledger whose `checkAndReserve` marks the boundary.
 *
 * `onVendorCall` runs INSIDE the fake transport, per vendor path — that is what lets a test burn the
 * deadline in the middle of the paid leg, or hold a sub-call open while a second caller arrives.
 */
function makeNansenProbe(
  opts: { onVendorCall?: (pathname: string) => Promise<void> | void } = {},
): Probe {
  const observations: Observation[] = [];
  const calls: string[] = [];
  let reserveIndex: number | undefined;

  const fetchImpl: typeof fetch = async (url) => {
    const pathname = new URL(String(url)).pathname;
    calls.push(pathname);
    if (opts.onVendorCall) await opts.onVendorCall(pathname);
    const canned = VENDOR_RESPONSES[pathname];
    if (!canned) throw new Error(`unrouted test call to ${pathname}`);
    return new Response(JSON.stringify(canned.body), {
      status: 200,
      headers: canned.credits === null ? {} : { 'x-nansen-credits-used': canned.credits },
    });
  };

  const realThrottle = createThrottle(fakeClock());
  const throttle: Throttle = async (providerId, config, weight, deadlineAtMs) => {
    observations.push({ kind: 'limiter', target: providerId, deadlineAtMs });
    return realThrottle(providerId, config, weight, deadlineAtMs);
  };

  // Delegates to the REAL `safeFetch` — the seam is for OBSERVING the production path, never for
  // replacing it. A stub here would make the assertions statements about the stub.
  const safeFetchImpl: typeof safeFetch = async (url, requestInit, allowlist, impl, options) => {
    observations.push({
      kind: 'transport',
      target: new URL(String(url)).pathname,
      deadlineAtMs: options?.deadlineAtMs,
    });
    return safeFetch(url, requestInit, allowlist, impl, options);
  };

  const budgetStore = createBudgetStore({ dbPath: ':memory:' });
  const reserve = budgetStore.checkAndReserve.bind(budgetStore);
  vi.spyOn(budgetStore, 'checkAndReserve').mockImplementation(
    async (...args: Parameters<BudgetStore['checkAndReserve']>) => {
      const result = await reserve(...args);
      // ONLY on success: a refused reservation commits nothing, so it is not the boundary.
      if (result.ok) reserveIndex = observations.length;
      return result;
    },
  );
  const recordDeltaSpy = vi.spyOn(budgetStore, 'recordDelta');

  const adapter = createNansenAdapter({
    env: ENV,
    fetchImpl,
    throttle,
    safeFetchImpl,
    budgetStore,
    now: () => NOW,
  });

  return {
    adapter,
    budgetStore,
    observations,
    calls,
    reserveIndex: () => reserveIndex,
    recordDeltaCalls: () => recordDeltaSpy.mock.calls.length,
  };
}

/**
 * How to exercise ONE paid adapter's boundary.
 *
 * **The parameterisation is by registration property (`tier === 'paid'`), but the SPYING is
 * nansen-shaped, and that is said out loud here rather than discovered by the next reader.** A
 * future second paid adapter would fail the contract case below on the ABSENCE of a dependency seam,
 * not on a violated invariant — and "the test is broken" is the wrong lesson to draw from that. So
 * the map is explicit: an entry is "we know how to watch this adapter's transport and limiter". A
 * paid registration with no entry fails with a message naming the missing seam, per OD-6.
 */
interface PaidAdapterEntry {
  /**
   * Constructs the adapter with EVERY environment variable its registration declares already
   * present, so an `isAvailable()` that still answers `false` is a property of the ADAPTER and not
   * of the environment this suite happens to run in.
   */
  create: (env: NodeJS.ProcessEnv) => ProviderAdapter;
  /** Absent = no injectable transport seam, i.e. the boundary cannot be observed at all. */
  probe?: () => Probe;
}

const PAID_ADAPTERS: Record<string, PaidAdapterEntry> = {
  nansen: {
    create: (env) => createNansenAdapter({ env }),
    probe: () => makeNansenProbe(),
  },
  // `dune` takes no `env` at all (its factory has no parameters) — the saturated environment below
  // is therefore vacuous for it, which is itself the point: nothing an operator can configure makes
  // this adapter answer `isAvailable(): {ok:true}`, so it can never reach `checkAndReserve()`. It is
  // excluded by THAT property, asserted below, and never by its id.
  dune: { create: () => createDuneAdapter() },
};

/** Every declared secret present, with an obviously-fake value — never a real key, and never read
 * from the ambient environment. */
function saturatedEnv(registration: AdapterRegistration): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of registration.requiresEnv) env[key] = 'test-key-not-real';
  return env;
}

const PAID = adapterRegistrations.filter((r) => r.tier === 'paid');
const UNKNOWN_PAID = PAID.filter((r) => !(r.id in PAID_ADAPTERS));
const KNOWN_PAID = PAID.filter((r) => r.id in PAID_ADAPTERS);
/** Reaches the reservation ⇒ has a boundary to check. `isAvailable` is optional on the interface;
 * an adapter that declares none is available by definition. */
const REACHES_RESERVE = KNOWN_PAID.filter((r) => {
  const adapter = PAID_ADAPTERS[r.id]!.create(saturatedEnv(r));
  return (adapter.isAvailable?.() ?? { ok: true }).ok;
});
const NEVER_REACHES_RESERVE = KNOWN_PAID.filter((r) => !REACHES_RESERVE.includes(r));

describe('H3 — the paid boundary, over every `tier: paid` registration (R-141/AC-10)', () => {
  /**
   * The premise every case below stands on. Without it a filter that silently matched nothing would
   * leave this file green while checking no adapter at all.
   *
   * GREEN AT PHASE 1 BY CONSTRUCTION: it reads `providers.config.ts` and constructs adapters, none
   * of which this task changes. Its killing mutation: drop the `tier === 'paid'` filter's subject
   * (e.g. filter on `trust`), and `REACHES_RESERVE` no longer holds a paid adapter.
   */
  it('premise: the paid tier is non-empty, every member is known here, and one reaches the reserve', () => {
    expect(PAID.length).toBeGreaterThan(0);
    if (UNKNOWN_PAID.length > 0) {
      throw new Error(
        `paid adapter ${UNKNOWN_PAID.map((r) => `"${r.id}"`).join(', ')} has no injectable ` +
          `transport seam — build it, per OD-6 (PLAN §0.3 seam #1), then add an entry to ` +
          `PAID_ADAPTERS in this file. This suite spies through nansen-shaped deps ` +
          `(safeFetchImpl + throttle); a new paid adapter needs the same two seams before its ` +
          `"nothing after checkAndReserve() carries a deadline" invariant can be checked at all.`,
      );
    }
    expect(REACHES_RESERVE.length).toBeGreaterThan(0);
  });

  /**
   * The exclusion, stated as the PROPERTY that justifies it (task file: "`dune` исключается по
   * СВОЙСТВУ, а не по имени"). Today the set is exactly `dune`; the day it starts answering
   * `{ok:true}` it moves into `REACHES_RESERVE` on its own and is held to the boundary contract,
   * with no edit here.
   *
   * GREEN AT PHASE 1 BY CONSTRUCTION (nothing in this task touches `dune`). Its killing mutation:
   * make `createDuneAdapter().isAvailable()` return `{ok:true}` — the excluded set empties, this
   * case's own assertion fails, and the registration is pulled into the contract case above.
   */
  it('a paid registration is excluded only by an unconditionally unavailable adapter', () => {
    for (const registration of NEVER_REACHES_RESERVE) {
      const adapter = PAID_ADAPTERS[registration.id]!.create(saturatedEnv(registration));
      const availability = adapter.isAvailable?.() ?? { ok: true };
      expect(availability.ok, registration.id).toBe(false);
      // Not merely unavailable HERE: unavailable with every declared secret present, which is what
      // makes "never reaches checkAndReserve()" a property and not an accident of this environment.
      expect(
        registration.requiresEnv.every((k) => saturatedEnv(registration)[k]),
        registration.id,
      ).toBe(true);
    }
  });

  /**
   * TC-CONTRACT-01 — NOTHING after the committed reservation carries a deadline.
   *
   * Asserted on BOTH seams, and the "both" is load-bearing: the limiter alone would look like a
   * check of the invariant while checking the half of the path that never issues a request. The
   * transport is where the money is spent.
   *
   * EXPECTED_FAIL_REASON (phase 1): `safeFetchImpl` is declared on the deps types but never
   * consulted, so no transport observation is ever recorded — "expected +0 to be greater than 0" on
   * the non-vacuity assertion, before any deadline is even compared.
   */
  it.each(REACHES_RESERVE.map((r) => r.id))(
    '%s: no limiter wait and no transport call after checkAndReserve() is handed a deadline',
    async (id) => {
      const probe = PAID_ADAPTERS[id]!.probe!();
      const deadlineAtMs = Date.now() + 60_000;

      await probe.adapter.fetch(
        'smart-money.flows',
        { chain: 'ethereum', tokenAddress: USDC },
        deadlineAtMs,
      );

      const boundary = probe.reserveIndex();
      expect(boundary, 'the reservation must have been committed').toBeDefined();
      const after = probe.observations.slice(boundary!);

      // Non-vacuity FIRST: an invariant asserted over an empty set is not asserted.
      expect(after.filter((o) => o.kind === 'transport').length).toBeGreaterThan(0);
      expect(after.filter((o) => o.kind === 'limiter').length).toBeGreaterThan(0);
      // Both paid sub-calls of this composite ran under the ONE reservation (R-41 "always both"):
      // the deadline may not cut sub-call 2 either, and this is what proves sub-call 2 happened.
      expect(probe.calls.filter((p) => p === '/api/v1/smart-money/netflow')).toHaveLength(1);
      expect(probe.calls.filter((p) => p === '/api/v1/tgm/holders')).toHaveLength(1);

      for (const observation of after) {
        expect(
          observation.deadlineAtMs,
          `${observation.kind} ${observation.target} was handed a deadline AFTER the reserve`,
        ).toBeUndefined();
      }
    },
  );

  /**
   * TC-CONTRACT-02 — the mirror half: BEFORE the reservation the deadline is genuinely passed.
   *
   * Without it the case above cannot tell "the boundary is respected" from "the deadline is not
   * threaded anywhere at all", which is a state the tree was in five minutes ago and which passes
   * the first case perfectly.
   *
   * EXPECTED_FAIL_REASON (phase 1): the deadline reaches neither seam, so the free `/account`
   * resync's transport observation is absent entirely — "expected undefined to be defined" on the
   * resync lookup.
   */
  it.each(REACHES_RESERVE.map((r) => r.id))(
    '%s: the FREE /account resync before the reserve IS handed the deadline',
    async (id) => {
      const probe = PAID_ADAPTERS[id]!.probe!();
      const deadlineAtMs = Date.now() + 60_000;

      await probe.adapter.fetch(
        'smart-money.flows',
        { chain: 'ethereum', tokenAddress: USDC },
        deadlineAtMs,
      );

      const boundary = probe.reserveIndex();
      expect(boundary).toBeDefined();
      const before = probe.observations.slice(0, boundary!);

      const resyncTransport = before.find(
        (o) => o.kind === 'transport' && o.target === '/api/v1/account',
      );
      expect(resyncTransport, 'the free /account resync must run before the reserve').toBeDefined();
      // Verbatim, not "some deadline": the value is threaded, never re-derived.
      expect(resyncTransport!.deadlineAtMs).toBe(deadlineAtMs);

      const resyncLimiter = before.find((o) => o.kind === 'limiter');
      expect(resyncLimiter).toBeDefined();
      expect(resyncLimiter!.deadlineAtMs).toBe(deadlineAtMs);
    },
  );
});

describe('the free leg IS cancellable, and its typed error survives this adapter (WI-36)', () => {
  /**
   * The WI-36 question, answered mechanically for `nansen` instead of by inspection.
   *
   * [WI-36](docs/backlog/wi-36-adapter-wrappers-flatten-typed-errors.md) measured that two of the
   * twelve adapters re-wrap every transport throw in `new Error(..., { cause })`, which makes
   * `error instanceof DeadlineExceededError` FALSE in the registry: `blockscout` does it because it
   * authenticates with `?apikey=` in the URL and the message must not carry it (D10), and
   * `blockchain-info` inherited the shape. Task 012-9 owns a paid route, so inheriting that
   * behaviour silently would mean the paid route's deadline is recognised only by the terminal
   * branch's duplicate clock re-read rather than by the C-1 catch — and a singleflight follower
   * (TC-INT-04) MUST translate as a deadline.
   *
   * **The finding for `nansen`: it does NOT flatten.** Its cause is absent by construction, not by
   * luck — the vendor takes its key in an `apiKey` HEADER, never in the URL, so there is no
   * secret in the URL for a wrapper to hide and `endpoints.ts`/`index.ts` re-throw transport errors
   * unchanged (`index.ts`'s catch ends in a bare `throw error`). This case pins that, so a future
   * "let's be consistent with blockscout" edit fails here rather than silently downgrading a paid
   * deadline. `error.cause` is asserted `undefined` for the same reason: a wrapper that preserved
   * the class but nested the original would be a different, equally silent regression.
   *
   * GREEN BY CONSTRUCTION (nansen has never wrapped). Its killing mutation, run and reverted:
   * replace `throw error` in `index.ts`'s catch with
   * `throw new Error('nansen: transport failure', { cause: error })` — the class assertion fails
   * with "expected Error to be an instance of DeadlineExceededError".
   */
  it('WI-36: an expired deadline ends the FREE leg with the un-wrapped net class, before any reserve', async () => {
    const probe = makeNansenProbe();

    const thrown = await probe.adapter
      .fetch('token.risk', { chain: 'ethereum', tokenAddress: USDC }, Date.now() - 1)
      .then(
        () => null,
        (error: unknown) => error,
      );

    // The typed class reaches the registry intact — this is what sets `deadlineHit` in the C-1 catch.
    expect(thrown).toBeInstanceOf(DeadlineExceededError);
    expect((thrown as Error).name).toBe('DeadlineExceededError');
    expect((thrown as Error).cause).toBeUndefined();
    // Cancelled where cancelling is free: nothing was reserved, nothing was spent, no vendor call.
    expect(probe.reserveIndex()).toBeUndefined();
    expect(probe.calls).toEqual([]);
    expect(await probe.budgetStore.getUsage('nansen', BUCKET)).toBe(0);
  });
});

describe('the paid leg runs to completion once it is paid for (R-141c/AC-10)', () => {
  /**
   * TC-INT-01 — a paid sub-call that started while the deadline was still alive finishes, and its
   * reservation stays SETTLED rather than being refunded.
   *
   * The deadline expires inside the first paid sub-call, driven by the fake transport itself
   * (`blockUntil`) rather than by a fixed sleep, so "it expired during the paid leg" is a fact of
   * the run and not a hope about scheduling. 200 ms of pre-reserve headroom against a ~1 ms canned
   * resync is the two-orders-of-magnitude margin `registry.deadline.test.ts` uses.
   *
   * EXPECTED_FAIL_REASON (phase 1): none of the deadline plumbing exists, so this case passes for
   * the WRONG reason — it is green by construction at phase 1 and says so below.
   *
   * GREEN AT PHASE 1 BY CONSTRUCTION: with the deadline ignored everywhere, the paid leg trivially
   * runs to completion. It is here because it pins the outcome the boundary EXISTS to protect, and
   * because it is the case whose killing mutation is the cheapest to state: pass `deadlineAtMs` into
   * `postSmartMoneyNetflow`'s `safeFetch` options and the sub-call throws `DeadlineExceededError`,
   * `reconcile()` refunds the unspent 5, and `usage` lands at 5 instead of 10.
   */
  it('TC-INT-01: the deadline expires mid-sub-call; the call completes and usage stays at the full reserve', async () => {
    const deadlineAtMs = Date.now() + 200;
    const probe = makeNansenProbe({
      onVendorCall: (pathname) => {
        // Burn past the deadline inside the FIRST paid sub-call — the free resync is untouched.
        if (pathname === '/api/v1/smart-money/netflow') blockUntil(deadlineAtMs + 1, 1_000);
      },
    });

    const result = await probe.adapter.fetch(
      'smart-money.flows',
      { chain: 'ethereum', tokenAddress: USDC },
      deadlineAtMs,
    );

    // The scenario genuinely happened: the call outlived its own deadline.
    expect(Date.now()).toBeGreaterThan(deadlineAtMs);
    expect(result).toBeDefined();
    expect(probe.calls.filter((p) => p === '/api/v1/tgm/holders')).toHaveLength(1);
    // SETTLED: 5 + 5 reserved, 5 + 5 reported, delta 0 — not a refund.
    expect(await probe.budgetStore.getUsage('nansen', BUCKET)).toBe(10);
    expect(probe.recordDeltaCalls()).toBe(1);
  });

  /**
   * TC-INT-02 — three sub-calls under ONE reservation: expiry between sub-call 1 and sub-call 2 cuts
   * nothing, and reconciliation still runs exactly once over all three responses.
   *
   * `entity.labels` with a `tokenAddress` is the three-sub-call shape (`search/general` +
   * `search/entity-name` + `tgm/holders`, 0 + 0 + 5 credits — `cost-of.ts`'s own routing).
   *
   * GREEN AT PHASE 1 BY CONSTRUCTION, for the same reason as TC-INT-01. Killing mutation: hand the
   * deadline to `performSubCalls`' endpoint deps — sub-calls 2 and 3 then never happen, `calls` holds
   * one path instead of three, and the partial-set refund writes usage 0 instead of 5.
   */
  it('TC-INT-02: expiry between sub-call 1 and 2 does not interrupt sub-call 2 or 3', async () => {
    const deadlineAtMs = Date.now() + 200;
    const probe = makeNansenProbe({
      onVendorCall: (pathname) => {
        if (pathname === '/api/v1/search/general') blockUntil(deadlineAtMs + 1, 1_000);
      },
    });

    await probe.adapter.fetch(
      'entity.labels',
      { chain: 'ethereum', tokenAddress: USDC },
      deadlineAtMs,
    );

    expect(Date.now()).toBeGreaterThan(deadlineAtMs);
    expect(probe.calls.filter((p) => p.startsWith('/api/v1/'))).toEqual([
      '/api/v1/account',
      '/api/v1/search/general',
      '/api/v1/search/entity-name',
      '/api/v1/tgm/holders',
    ]);
    expect(await probe.budgetStore.getUsage('nansen', BUCKET)).toBe(5);
    expect(probe.recordDeltaCalls()).toBe(1);
  });
});

describe('singleflight: a follower may expire, the leader may not be cancelled (PLAN §0.3 seam #3)', () => {
  /** A promise the test resolves by hand — the leader's paid sub-call hangs on it, so "the leader is
   * still in flight when the follower's deadline expires" is controlled, not timed. */
  function deferred(): { promise: Promise<void>; release: () => void } {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => {
      release = resolve;
    });
    return { promise, release };
  }

  /**
   * TC-INT-03 — the follower whose OWN deadline expires while the leader is unsettled gets the
   * NETWORK-layer `DeadlineExceededError`; the leader is untouched and still answers everyone else.
   *
   * The three callers share one `deriveArgsHash(cap, args)` key — `deadlineAtMs` is deliberately not
   * part of it: two calls with the same `(capability, args)` and different deadlines are one
   * unfinished request, not two.
   *
   * EXPECTED_FAIL_REASON (phase 1): `singleflight()` hands the leader's promise to the follower
   * unchanged, so the follower never rejects and the case blocks on `rejects` while the leader is
   * still held — observed as "Error: Test timed out in 5000ms" (the leader is released only AFTER
   * the follower's rejection, so "the follower waits out the leader" surfaces as the timeout rather
   * than as a resolved promise).
   */
  it('TC-INT-03: the follower rejects with the net class; the leader resolves for the others', async () => {
    const held = deferred();
    const probe = makeNansenProbe({
      onVendorCall: async (pathname) => {
        if (pathname === '/api/v1/tgm/indicators') await held.promise;
      },
    });
    const args = { chain: 'ethereum', tokenAddress: USDC };
    const wide = Date.now() + 60_000;

    // The leader registers its singleflight entry synchronously, so both followers below coalesce.
    const leader = probe.adapter.fetch('token.risk', args, wide);
    const narrowFollower = probe.adapter.fetch('token.risk', args, Date.now() + 60);
    const wideFollower = probe.adapter.fetch('token.risk', args, wide);

    await expect(narrowFollower).rejects.toBeInstanceOf(DeadlineExceededError);

    // The leader was NOT cancelled by that: it is still running, and releasing its sub-call now
    // produces one shared result for every caller that still had time.
    held.release();
    const leaderResult = await leader;
    expect(await wideFollower).toBe(leaderResult);

    // ONE reservation, one HTTP set, one reconciliation — the follower's expiry changed none of it.
    expect(probe.calls.filter((p) => p === '/api/v1/tgm/indicators')).toHaveLength(1);
    expect(probe.calls.filter((p) => p === '/api/v1/tgm/token-information')).toHaveLength(1);
    expect(await probe.budgetStore.getUsage('nansen', BUCKET)).toBe(6);
  });

  /**
   * TC-INT-04 — the registry translates that follower's network class into
   * `CapabilityDeadlineExceededError` (the C-1 translation task 012-8 built), rather than letting the
   * net class escape to the caller.
   *
   * `CapabilityDeadlineExceededError` is not constructible inside `singleflight()` — it has no
   * `capability`, no `chain`, no `tried[]` — which is exactly why the follower throws the net class
   * and the registry does the translating.
   *
   * EXPECTED_FAIL_REASON (phase 1): the follower never rejects at all (see TC-INT-03), so
   * `resolve()` stays pending behind the held leader — observed as "Error: Test timed out in
   * 5000ms".
   */
  it('TC-INT-04: the registry reports the follower expiry as CapabilityDeadlineExceededError', async () => {
    const held = deferred();
    const probe = makeNansenProbe({
      onVendorCall: async (pathname) => {
        if (pathname === '/api/v1/tgm/indicators') await held.promise;
      },
    });
    const args = { chain: 'ethereum', tokenAddress: USDC };
    const route: CapabilityRoute = { capability: 'token.risk', adapterIds: ['nansen'] };
    const manifests: Readonly<Record<string, CapabilityManifest>> = {
      'token.risk': { shape: 'point', ttlSeconds: 60, deadlineMs: 30_000, shareable: true },
    };
    const registry = new CapabilityRegistry(
      [route],
      new Map([['nansen', probe.adapter]]),
      undefined,
      null,
      manifests,
    );

    const leader = probe.adapter.fetch('token.risk', args, Date.now() + 60_000);
    const thrown = await registry.resolve('token.risk', 'ethereum', args, Date.now() + 60).then(
      () => null,
      (error: unknown) => error,
    );

    expect(thrown).toBeInstanceOf(CapabilityDeadlineExceededError);
    // The NET class never reaches a capability caller — that is the whole reason there are two.
    expect(thrown).not.toBeInstanceOf(DeadlineExceededError);

    held.release();
    await expect(leader).resolves.toBeDefined();
  });
});
