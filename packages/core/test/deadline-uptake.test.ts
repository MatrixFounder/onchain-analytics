import { describe, expect, it, vi } from 'vitest';
import { createBlockchainInfoAdapter } from '../src/adapters/blockchain-info/index.js';
import { createBlockscoutAdapter } from '../src/adapters/blockscout/index.js';
import { createCoingeckoAdapter } from '../src/adapters/coingecko/index.js';
import { createDefillamaAdapter } from '../src/adapters/defillama/index.js';
import { createDexscreenerAdapter } from '../src/adapters/dexscreener/index.js';
import { createPgHistoryAdapter } from '../src/adapters/pg-history/index.js';
import { createPlatformExplorerAdapter } from '../src/adapters/platform-explorer/index.js';
import { createRpcEvmAdapter } from '../src/adapters/rpc-evm/index.js';
import { createRpcSolanaAdapter } from '../src/adapters/rpc-solana/index.js';
import type { ProviderAdapter } from '../src/adapters/types.js';
import type { PgPoolCtor, PgPoolLike } from '../src/pg/read-client.js';
import { createThrottle, type Throttle, type TokenBucketConfig } from '../src/net/rate-limit.js';
import { DeadlineExceededError, SafeFetchTimeoutError } from '../src/net/safe-fetch.js';
import { adapterRegistrations } from '../src/providers.config.js';

/**
 * WI-37 — the call ceiling reaches the adapters, proved once per adapter.
 *
 * **What was wrong.** `capability-manifest.ts` declared a `deadlineMs` for all 20 capabilities and
 * two of the twelve adapters read the third `fetch(cap, args, deadlineAtMs)` argument, so on 16 of
 * them the ceiling bounded the NUMBER OF ATTEMPTS (the registry refuses sources it has not yet
 * reached) and not the DURATION of the one in flight: a request already issued ran out its own hop
 * timeout in full, and a limiter wait was still capped only by `MAX_WAIT_MS = 30_000` — twice the
 * ceiling of the eight capabilities on the ~15 s tier.
 *
 * **Why one case per adapter and not one gate.** The gate at the bottom of this file proves the
 * deadline REACHES the limiter, which is cheap and total: it constructs every adapter from
 * `adapterRegistrations` and would catch a thirteenth added without the parameter. What it cannot
 * prove is that the value does anything, and "the seam exists" has been mistaken for "the seam
 * works" twice in this repo already (WI-26's `bypasses` check, WI-34's declared-but-unapplied
 * limiter). So each adapter also gets the two behavioural cases task 012-8 wrote for `blockscout`,
 * because together they separate the two places the ceiling has to arrive:
 *
 * - **(a), the TC-INT-08a form** — a spent deadline against a SATURATED bucket refuses with no
 *   network call at all. The saturation is what makes the case load-bearing: on a fresh bucket
 *   `throttle()` returns synchronously, the deadline branches live on the deficit path, and the
 *   refusal would come from `safeFetch`'s own entry check instead — so the case would pass even if
 *   the adapter never handed the limiter anything.
 * - **(b), the TC-INT-08b form** — a live deadline against a request that never completes rejects
 *   long before the hop timeout, and with `DeadlineExceededError` ("we ran out of OUR time") rather
 *   than `SafeFetchTimeoutError` ("the vendor did not answer"). Class AND elapsed time together are
 *   what tell the two paths apart.
 *
 * **Not here:** `nansen` (its uptake is 012-9 and its own budget/reservation boundary makes it a
 * different case — `nansen-deadline-boundary.test.ts` owns it), `pg-history` (case (a) lives beside
 * its pool fakes in `pg-history.contract.test.ts`, and case (b) has no analogue: a Postgres statement
 * cannot be recalled, so its bound is `read-client.ts`'s, asserted there), and `blockscout` (TC-INT-08a/08b
 * in `registry.deadline.test.ts`, where they were written). The gate below covers all four regardless
 * — that is the point of deriving its population from the registration table.
 */

/** A real bucket on the real clock with `wait` neutered — the deadline is an absolute epoch-ms
 * moment, so a virtual clock at some other epoch would make every comparison meaningless. */
function realClockThrottle(): Throttle {
  return createThrottle({ now: Date.now, wait: () => Promise.resolve() });
}

function rateLimitOf(id: string): TokenBucketConfig {
  const registration = adapterRegistrations.find((entry) => entry.id === id);
  if (!registration) throw new Error(`no registration for ${id}`);
  return registration.rateLimit;
}

/** Drives `id`'s bucket into deficit, so the limiter — not the transport — is what answers next. */
async function saturate(throttle: Throttle, id: string): Promise<void> {
  const config = rateLimitOf(id);
  for (let spent = 0; spent < config.capacity; spent += 1) {
    await throttle(id, config);
  }
}

/** One adapter, and the smallest real call that reaches its transport. */
interface Subject {
  id: string;
  create: (deps: { throttle: Throttle; fetchImpl: typeof fetch }) => ProviderAdapter;
  capability: string;
  args: Record<string, unknown>;
}

const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
const VITALIK = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';
const SOLANA_ADDRESS = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';

const SUBJECTS: Subject[] = [
  {
    id: 'coingecko',
    create: (deps) => createCoingeckoAdapter({ ...deps, env: {} }),
    capability: 'token.price',
    args: { chain: 'ethereum', address: USDC },
  },
  {
    id: 'dexscreener',
    create: (deps) => createDexscreenerAdapter(deps),
    capability: 'pairs.new',
    args: { chain: 'ethereum' },
  },
  // `defillama` used to sit here on `protocol.tvl`, "the one path with no shared document". L-7
  // moved that capability onto the shared `/protocols` catalog, so ALL THREE of its capabilities now
  // bound the caller's WAIT (`awaitSharedDocument`) instead of the limiter — deliberately, so one
  // caller's ceiling cannot abort a download another caller is awaiting. Both halves of that are
  // proved by the dedicated describe block below, and the one path that still forwards a deadline to
  // the limiter — the per-call `vendor-aggregate` fall-back — has its own gate case. Driving it from
  // this table would assert a property the adapter is designed NOT to have.
  {
    id: 'rpc-evm',
    create: (deps) => createRpcEvmAdapter(deps),
    capability: 'wallet.balances.native',
    args: { chain: 'ethereum', address: VITALIK },
  },
  {
    id: 'rpc-solana',
    create: (deps) => createRpcSolanaAdapter(deps),
    capability: 'wallet.balances.native',
    args: { chain: 'solana', address: SOLANA_ADDRESS },
  },
  {
    id: 'platform-explorer',
    create: (deps) => createPlatformExplorerAdapter(deps),
    capability: 'privacy.shielded_pool',
    args: { chain: 'dash' },
  },
  {
    id: 'blockchain-info',
    create: (deps) => createBlockchainInfoAdapter(deps),
    capability: 'chain.supply',
    args: { chain: 'bitcoin' },
  },
];

describe('WI-37 — a spent deadline is refused BY THE LIMITER, with no request at all', () => {
  it.each(SUBJECTS)('$id', async ({ id, create, capability, args }) => {
    const throttle = realClockThrottle();
    await saturate(throttle, id);

    const fetchImpl = vi.fn<typeof fetch>(async () => new Response('{}', { status: 200 }));
    const adapter = create({ throttle, fetchImpl });

    const thrown = await adapter.fetch(capability, args, Date.now() - 1).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(thrown).toBeInstanceOf(DeadlineExceededError);
    // The context string is the discriminator: the transport path builds the same class from a URL,
    // so `provider "<id>"` is what pins the refusal to the limiter rather than to `safeFetch`'s own
    // entry check one layer down.
    expect((thrown as DeadlineExceededError).at).toBe(`provider "${id}"`);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe('WI-37 — a deadline expiring mid-flight beats the hop timeout, and says which fired', () => {
  it.each(SUBJECTS)('$id', async ({ create, capability, args }) => {
    const throttle = realClockThrottle();
    const fetchImpl = vi.fn<typeof fetch>(() => new Promise<Response>(() => {}));
    const adapter = create({ throttle, fetchImpl });

    const startedAt = Date.now();
    const thrown = await adapter.fetch(capability, args, Date.now() + 50).then(
      () => undefined,
      (error: unknown) => error,
    );
    const elapsedMs = Date.now() - startedAt;

    expect(fetchImpl).toHaveBeenCalled();
    expect(thrown).toBeInstanceOf(DeadlineExceededError);
    // Stated separately because this is the confusion the two classes exist to prevent — and
    // because a `SafeFetchTimeoutError` here would mean the deadline never reached the transport.
    expect(thrown).not.toBeInstanceOf(SafeFetchTimeoutError);
    // The shortest hop timeout any of these adapters configures is 5 000 ms and most use
    // `DEFAULT_TIMEOUT_MS = 15_000`. 2 000 ms is 40× the deadline and 2.5× below the smallest hop
    // timeout: wide enough that a loaded machine cannot flip the verdict, narrow enough that no hop
    // timeout can satisfy it.
    expect(elapsedMs).toBeLessThan(2_000);
  });
});

/**
 * `defillama`'s OTHER mechanism, which the two cases above deliberately do not exercise.
 *
 * `chain.tvl` and `dex.volume.history` are served out of documents SHARED between concurrent
 * callers. Handing the first caller's deadline to the `safeFetch` inside that shared body would let
 * its expiry abort a download a second caller is also awaiting — H-1's shape, and the thing WI-12
 * closed for in-flight cache entries. So the ceiling bounds the WAIT and leaves the transfer alone,
 * and both halves of that need saying out loud: the caller IS cut off, and the download is NOT.
 */
describe('WI-37 — defillama bounds the WAIT for a shared document, not the download', () => {
  it('the caller is cut off at its own deadline', async () => {
    const throttle = realClockThrottle();
    const adapter = createDefillamaAdapter({
      throttle,
      fetchImpl: () => new Promise<Response>(() => {}),
    });

    const startedAt = Date.now();
    const thrown = await adapter.fetch('chain.tvl', { chain: 'ethereum' }, Date.now() + 50).then(
      () => undefined,
      (error: unknown) => error,
    );

    expect(thrown).toBeInstanceOf(DeadlineExceededError);
    expect((thrown as DeadlineExceededError).at).toBe('defillama chains catalog');
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  });

  it('a SECOND caller with more budget still receives the document the first abandoned', async () => {
    // The property the design is for. Without it the fix would trade one defect for a worse one: a
    // 15 s caller could cancel a download a 60 s caller was relying on, and the second caller would
    // be told the vendor failed when nothing about the vendor failed.
    let release: ((response: Response) => void) | undefined;
    const throttle = realClockThrottle();
    const adapter = createDefillamaAdapter({
      throttle,
      fetchImpl: vi.fn<typeof fetch>(
        () =>
          new Promise<Response>((resolve) => {
            release = resolve;
          }),
      ),
    });

    // Caller one starts the download and walks away 50 ms later.
    const impatient = adapter.fetch('chain.tvl', { chain: 'ethereum' }, Date.now() + 50).then(
      () => undefined,
      (error: unknown) => error,
    );
    // Caller two joins the SAME in-flight document with a budget that is not about to expire.
    const patient = adapter.fetch('chain.tvl', { chain: 'ethereum' }, Date.now() + 60_000);

    expect(await impatient).toBeInstanceOf(DeadlineExceededError);
    release?.(new Response(JSON.stringify([{ name: 'Ethereum', tvl: 1 }]), { status: 200 }));

    await expect(patient).resolves.toMatchObject({ raw: [{ name: 'Ethereum', tvl: 1 }] });
  });
});

/**
 * The GATE — "the deadline this caller passed reached the limiter", asked of every registration.
 *
 * WI-37's recommendation, verbatim: *"the test takes `adapterRegistrations`, constructs each adapter
 * with an injected `throttle`/`fetchImpl`, and requires that the `deadlineAtMs` it passed arrives at
 * the limiter"* — because *"without such a test the thirteenth adapter is added without reading the
 * deadline, exactly like these ten were"*.
 *
 * The population is the registration table, and the two exemptions are DERIVED rather than listed:
 * an adapter is excused only by declining before it can wait on anything, which is what
 * `isAvailable(): {ok:false}` plus a throwing `fetch()` means. `capability-manifest.ts`'s ENFORCEMENT
 * section counts the same split from the source side; this one counts it from the behaviour side,
 * and a disagreement between them is a red suite rather than a discrepancy nobody reads.
 */
describe('WI-37 gate — every adapter that can wait forwards the deadline to the limiter', () => {
  /** A recording limiter: never waits, remembers the fourth argument of every call. */
  function recordingThrottle(): { throttle: Throttle; deadlines: (number | undefined)[] } {
    const deadlines: (number | undefined)[] = [];
    const throttle: Throttle = (_id, _config, _weight, deadlineAtMs) => {
      deadlines.push(deadlineAtMs);
      return Promise.resolve();
    };
    return { throttle, deadlines };
  }

  /** Adapters whose `fetch()` is reached through this file's subject table, plus the four proved
   * elsewhere — assembled here so the gate can cover all twelve registrations. */
  const GATE_SUBJECTS: Subject[] = [
    ...SUBJECTS,
    {
      id: 'blockscout',
      create: (deps) => createBlockscoutAdapter({ ...deps, env: {} }),
      capability: 'entity.labels',
      args: { chain: 'ethereum', tokenAddress: USDC },
    },
    {
      id: 'pg-history',
      create: (deps) =>
        createPgHistoryAdapter({
          throttle: deps.throttle,
          env: { ONCHAIN_PG_URL: 'postgres://u:p@h:5432/d' },
          poolCtor: class {
            query(): Promise<{ rows: unknown[] }> {
              return new Promise<{ rows: unknown[] }>(() => {});
            }
          } as unknown as PgPoolCtor satisfies new (config: never) => PgPoolLike,
        }),
      capability: 'platform.metrics.history',
      args: { chain: 'dash' },
    },
  ];

  it('the population is the registration table, split into "can wait" and "cannot"', () => {
    // `nansen` is the one adapter that can wait and is not driven here: reaching its `fetch()`
    // requires a key, a budget store and a reservation, and `nansen-deadline-boundary.test.ts` owns
    // that. Named rather than silently missing — an omission with no name is how a gate's coverage
    // shrinks without anyone deciding it should.
    // `defillama` is covered by the two cases immediately below rather than by the table: its
    // ordinary paths bound the WAIT and not the limiter (see the comment where it left `SUBJECTS`),
    // so the table's assertion would be the wrong one to make about it.
    const covered = new Set([...GATE_SUBJECTS.map((s) => s.id), 'nansen', 'defillama']);
    const cannotWait = ['dash-platform', 'dune'];
    expect(
      adapterRegistrations
        .map((r) => r.id)
        .filter((id) => !covered.has(id) && !cannotWait.includes(id)),
      'A registration that is neither driven by this gate nor a declared no-op stub has no proof ' +
        'that the call ceiling reaches it at all — which is the state WI-37 found ten adapters in.',
    ).toStrictEqual([]);
    expect(adapterRegistrations).toHaveLength(covered.size + cannotWait.length);
  });

  it.each(GATE_SUBJECTS)(
    '$id forwards the caller deadline to throttle()',
    async ({ create, capability, args }) => {
      const { throttle, deadlines } = recordingThrottle();
      const deadlineAtMs = Date.now() + 30_000;
      const adapter = create({
        throttle,
        // Never settles: the assertion is about what the limiter SAW, and letting the transport
        // answer would only add a second thing that can fail.
        fetchImpl: () => new Promise<Response>(() => {}),
      });

      // The call is abandoned on purpose — `deadlines` is already written by the time the transport is
      // reached, and awaiting a request that never completes would just spend the suite's timeout.
      void adapter.fetch(capability, args, deadlineAtMs).catch(() => undefined);
      await new Promise((resolve) => setImmediate(resolve));

      expect(deadlines.length).toBeGreaterThan(0);
      expect(
        deadlines,
        'The limiter was called without the caller deadline, so a saturated bucket can still sleep ' +
          'up to MAX_WAIT_MS = 30 000 ms under a 15 000 ms ceiling.',
      ).not.toContain(undefined);
      // Forwarded UNCHANGED — never a remainder re-derived from it, which is the whole reason
      // `deadlineAtMs` is an absolute moment (see `SafeFetchOptions.deadlineAtMs`).
      expect(new Set(deadlines)).toStrictEqual(new Set([deadlineAtMs]));
    },
  );

  /** The catalog shape `protocol.tvl` reads, trimmed to the one case that still issues a per-call
   * request: a parent whose child nets out double-counted tokens, so summing the catalog would be
   * wrong and only the vendor's own aggregate will do (`resolveProtocol`). */
  const EXCLUDING_PARENT_CATALOG = JSON.stringify([
    {
      slug: 'child-of-parent',
      name: 'Child',
      parentProtocolSlug: 'excluding-parent',
      tokensExcludedFromParent: { Ethereum: ['SOMETOKEN'] },
      tvl: 1,
      chains: ['Ethereum'],
      chainTvls: { Ethereum: 1 },
    },
  ]);

  it('defillama forwards the caller deadline on its per-call fall-back path', async () => {
    const { throttle, deadlines } = recordingThrottle();
    const deadlineAtMs = Date.now() + 30_000;
    let call = 0;
    const adapter = createDefillamaAdapter({
      throttle,
      fetchImpl: () => {
        call += 1;
        // First the shared catalog, which must SETTLE for the fall-back to be reached at all; then
        // the per-call `/protocol/{slug}` request, left hanging like every other gate case.
        return call === 1
          ? Promise.resolve(new Response(EXCLUDING_PARENT_CATALOG, { status: 200 }))
          : new Promise<Response>(() => {});
      },
    });

    void adapter
      .fetch('protocol.tvl', { chain: 'ethereum', protocolSlug: 'excluding-parent' }, deadlineAtMs)
      .catch(() => undefined);
    // Two ticks: one for the catalog request, one for the fall-back it unblocks.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    // `toContain`, NOT the table's `not.toContain(undefined)`: the catalog's own limiter call is
    // deliberately deadline-free (a shared download is caller-independent), so `undefined` is
    // present here BY DESIGN and asserting its absence would forbid the design.
    expect(deadlines).toContain(deadlineAtMs);
  });

  it('the gate DETECTS an adapter that drops the deadline on the floor', () => {
    // Positive control, run against a literal rather than by editing a real adapter: the check must
    // fail on the shape all ten adapters were in before WI-37 — the limiter called with two
    // arguments, so `deadlineAtMs` arrives as `undefined`.
    const { throttle, deadlines } = recordingThrottle();
    void throttle('legacy', { capacity: 1, refillPerSec: 1 });
    expect(deadlines).toContain(undefined);
  });
});
