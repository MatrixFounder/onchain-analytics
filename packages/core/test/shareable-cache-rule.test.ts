import { describe, expect, it, vi } from 'vitest';
import type { CacheGetResult, CacheStore } from '../src/adapters/cache-store.js';
import { CapabilityRegistry } from '../src/adapters/registry.js';
import type { CapabilityRoute, ProviderAdapter } from '../src/adapters/types.js';
import type { CapabilityManifest } from '../src/capability-manifest.js';
import { createNansenAdapter } from '../src/adapters/nansen/index.js';
import { deriveArgsHash } from '../src/net/args-hash.js';
import { createThrottle } from '../src/net/rate-limit.js';

/**
 * Task 014-31 part 2 (R-18.2, AC-13's second half, ADR-003 D5) — the `shareable` rule gets a
 * reader.
 *
 * **What the rule is.** A result is shareable when it does not depend on WHO asked. A row that
 * declares `shareable: false` says the opposite, and its answer must not reach a second principal.
 *
 * **How it is implemented, and why the tests are phrased structurally.** ADR-003 D5 offers two
 * arms — "кеш в пределах принципала либо не кешируется вовсе". The owner took the second
 * (`interfaces.md` §5.4.6): a non-shareable capability is neither read from nor written to the
 * cache. The first arm is closed by R-5.1, which keeps the principal out of the cache key. So
 * `CapabilityRegistry` never receives a principal at all, and "not served to ANOTHER principal" is
 * proved here by the stronger, identity-free property: nothing is served from the cache, and
 * nothing is left in it for anyone. A test that tried to name two principals would have to invent
 * a parameter the engine does not have.
 *
 * **Every case ships with its shareable CONTROL.** The rule is "no cache traffic", and a broken
 * cache produces exactly the same observation. Each `false` assertion below is paired with the
 * identical scenario at `shareable: true`, which fails if the cache stopped working for everyone —
 * so the negative case cannot pass for the wrong reason.
 *
 * **No shipped capability reaches this.** All 26 manifest rows are `true` (OD-014-31-1), which is
 * why every fixture here declares its own synthetic row through the registry's fifth constructor
 * parameter and the nansen adapter's `manifests` dep. `capability-manifest.test.ts` holds the
 * standing assertion that the shipped table still has no `false` row.
 */

const CHAIN = 'ethereum';
const CAP = 'test.shareable.point';
const MERGE_CAP = 'test.shareable.series';

function manifest(shareable: boolean, extra: Partial<CapabilityManifest> = {}): CapabilityManifest {
  return { shape: 'point', ttlSeconds: 60, deadlineMs: 60_000, shareable, ...extra };
}

/** Records every leg so a case can assert on the ABSENCE of traffic, not merely on the answer. */
class RecordingCacheStore implements CacheStore {
  readonly gets: string[] = [];
  readonly sets: { capability: string; value: unknown; ttl?: number }[] = [];
  private readonly entries = new Map<string, CacheGetResult>();

  async get(
    provider: string,
    capability: string,
    argsHash: string,
  ): Promise<CacheGetResult | undefined> {
    this.gets.push(`${provider}::${capability}::${argsHash}`);
    return this.entries.get(`${provider}::${capability}::${argsHash}`);
  }

  async set(
    provider: string,
    capability: string,
    argsHash: string,
    value: unknown,
    ttlSecondsOverride?: number,
  ): Promise<void> {
    this.sets.push({
      capability,
      value,
      ...(ttlSecondsOverride === undefined ? {} : { ttl: ttlSecondsOverride }),
    });
    this.entries.set(`${provider}::${capability}::${argsHash}`, { value, ageMs: 0 });
  }
}

function adapter(
  id: string,
  opts: { normalizeThrows?: boolean; result?: unknown } = {},
): ProviderAdapter & { fetch: ReturnType<typeof vi.fn> } {
  return {
    id,
    capabilities: () => [],
    costOf: () => ({ credits: 0 }),
    fetch: vi.fn(async (): Promise<unknown> => opts.result ?? { ok: true }),
    normalize: (_cap: string, raw: unknown): unknown => {
      if (opts.normalizeThrows === true) throw new Error('vendor shape changed');
      return raw;
    },
    isAvailable: () => ({ ok: true }),
  };
}

function registryFor(
  capability: string,
  manifests: Readonly<Record<string, CapabilityManifest>>,
  cache: CacheStore,
  served: ProviderAdapter,
  route: Partial<CapabilityRoute> = {},
): CapabilityRegistry {
  const routes: CapabilityRoute[] = [{ capability, adapterIds: [served.id], ...route }];
  return new CapabilityRegistry(routes, new Map([[served.id, served]]), cache, null, manifests);
}

describe('TC-UNIT-03 — a NON-shareable result is never taken from the cache and never left in it', () => {
  it('two identical calls both reach the adapter; the store sees no get and no set', async () => {
    const cache = new RecordingCacheStore();
    const served = adapter('stub');
    const registry = registryFor(CAP, { [CAP]: manifest(false) }, cache, served);

    const first = await registry.resolve(CAP, CHAIN, { token: 'x' });
    const second = await registry.resolve(CAP, CHAIN, { token: 'x' });

    // The load-bearing pair: no entry was consulted, and none was written for the next caller to
    // consult. Whoever the second caller is, there is nothing of the first one's for them to get.
    expect(cache.gets).toStrictEqual([]);
    expect(cache.sets).toStrictEqual([]);
    expect(served.fetch).toHaveBeenCalledTimes(2);
    expect(first.cache).toBe('miss');
    // `'miss'` on every call, including this one, where nothing was even consulted. The wire keeps
    // two states in one value (`interfaces.md` §5.4.6): adding a third would widen `CacheMeta` —
    // a type eleven tools depend on — for a case no shipped capability reaches.
    expect(second.cache).toBe('miss');
  });

  it('CONTROL: the same scenario at `shareable: true` caches, so the case above is not a dead cache', async () => {
    const cache = new RecordingCacheStore();
    const served = adapter('stub');
    const registry = registryFor(CAP, { [CAP]: manifest(true) }, cache, served);

    await registry.resolve(CAP, CHAIN, { token: 'x' });
    const second = await registry.resolve(CAP, CHAIN, { token: 'x' });

    expect(cache.gets).toHaveLength(2);
    expect(cache.sets).toHaveLength(1);
    expect(served.fetch).toHaveBeenCalledTimes(1);
    expect(second.cache).toBe('hit');
  });
});

describe('the rule reaches the NEGATIVE cache too', () => {
  /**
   * A negative entry carries no vendor data, so reading the rule narrowly would leave it in place.
   * It is still an artefact of one caller's call that decides what a LATER caller is told, and
   * §5.4.6's wording is "neither read from nor written to the cache" without a carve-out. The
   * price is named rather than hidden: a broken non-shareable capability re-enters the vendor on
   * every call instead of failing fast for `NEGATIVE_TTL_SECONDS`.
   */
  it('a non-shareable capability whose normalize() throws writes no negative entry', async () => {
    const cache = new RecordingCacheStore();
    const served = adapter('stub', { normalizeThrows: true });
    const registry = registryFor(CAP, { [CAP]: manifest(false) }, cache, served);

    await expect(registry.resolve(CAP, CHAIN, {})).rejects.toThrow();
    await expect(registry.resolve(CAP, CHAIN, {})).rejects.toThrow();

    expect(cache.sets).toStrictEqual([]);
    // Re-entered, which is the cost this decision accepts.
    expect(served.fetch).toHaveBeenCalledTimes(2);
  });

  it('CONTROL: at `shareable: true` the negative entry IS written, with its own short TTL', async () => {
    const cache = new RecordingCacheStore();
    const served = adapter('stub', { normalizeThrows: true });
    const registry = registryFor(CAP, { [CAP]: manifest(true) }, cache, served);

    await expect(registry.resolve(CAP, CHAIN, {})).rejects.toThrow();

    expect(cache.sets).toHaveLength(1);
    expect(cache.sets[0]?.ttl).toBeGreaterThan(0);
  });
});

describe('the rule reaches the MERGE walk, not only the single-winner walk', () => {
  /**
   * The two walks each carry their own `get`/`set`/negative-`set` triad — six call sites in one
   * method. The rule binds ONE store for the whole call, so a walk cannot be covered by accident
   * and cannot be missed by accident either. This case is what would fail if a future seventh site
   * reached for `this.cache` directly.
   */
  const MERGE_MANIFEST = (shareable: boolean): Readonly<Record<string, CapabilityManifest>> => ({
    [MERGE_CAP]: {
      shape: 'series',
      ttlSeconds: 60,
      deadlineMs: 60_000,
      mergeable: true,
      shareable,
    },
  });

  it('a non-shareable merge capability produces no cache traffic on either participant', async () => {
    const cache = new RecordingCacheStore();
    const a = adapter('a', { result: [] });
    const b = adapter('b', { result: [] });
    const registry = new CapabilityRegistry(
      [{ capability: MERGE_CAP, adapterIds: ['a', 'b'], merge: true }],
      new Map([
        ['a', a],
        ['b', b],
      ]),
      cache,
      null,
      MERGE_MANIFEST(false),
    );

    await registry.resolve(MERGE_CAP, CHAIN, {});

    expect(cache.gets).toStrictEqual([]);
    expect(cache.sets).toStrictEqual([]);
    expect(a.fetch).toHaveBeenCalledTimes(1);
    expect(b.fetch).toHaveBeenCalledTimes(1);
  });

  it('CONTROL: the same merge at `shareable: true` reads and writes both participants', async () => {
    const cache = new RecordingCacheStore();
    const a = adapter('a', { result: [] });
    const b = adapter('b', { result: [] });
    const registry = new CapabilityRegistry(
      [{ capability: MERGE_CAP, adapterIds: ['a', 'b'], merge: true }],
      new Map([
        ['a', a],
        ['b', b],
      ]),
      cache,
      null,
      MERGE_MANIFEST(true),
    );

    await registry.resolve(MERGE_CAP, CHAIN, {});

    expect(cache.gets).toHaveLength(2);
    expect(cache.sets).toHaveLength(2);
  });
});

describe('the rule reaches SINGLEFLIGHT — the second path to the same cross-principal serving', () => {
  /**
   * Skipping the cache alone would have left this open. `singleflight` coalesces on
   * `deriveArgsHash(capability, args)`, which carries no principal BY DESIGN (R-5.1) — so two
   * principals asking the identical question at the identical moment would share one vendor call
   * and be handed one value, which is precisely what `shareable: false` forbids, reached without
   * the cache being involved.
   *
   * The paid adapter is the one that coalesces, so the assertion is: two concurrent identical
   * calls enter the transport twice. The price — two vendor calls, two charges — is the point:
   * their answers differ.
   */
  const KEY_ENV = { NANSEN_API_KEY: 'test-key' } as NodeJS.ProcessEnv;
  const CAPABILITY = 'token.risk';
  /** The address every nansen test in this package uses — checksummed, so `normalizeAddress` keeps
   * it verbatim and the two callers below really do produce one identical args hash. */
  const ARGS = { chain: CHAIN, tokenAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' };
  /** `token.risk` issues TWO sub-calls per logical call, so the first one is the honest counter of
   * how many times the coalesced body was entered. */
  const FIRST_SUB_CALL = '/api/v1/tgm/indicators';

  function nansenWith(shareable: boolean): {
    adapter: ProviderAdapter;
    entries: () => number;
    release: () => void;
  } {
    const paths: string[] = [];
    let release!: () => void;
    // The leader hangs until the test releases it, so "the second caller arrives while the first is
    // unsettled" is controlled rather than timed — the same device the deadline suite uses.
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const fetchImpl: typeof fetch = async (url) => {
      const pathname = new URL(String(url)).pathname;
      paths.push(pathname);
      if (pathname === FIRST_SUB_CALL) await held;
      return new Response(JSON.stringify({ data: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    return {
      adapter: createNansenAdapter({
        env: KEY_ENV,
        fetchImpl,
        throttle: createThrottle(),
        __ungatedForTestsOnly: true,
        manifests: { [CAPABILITY]: manifest(shareable) },
      }),
      entries: () => paths.filter((p) => p === FIRST_SUB_CALL).length,
      release: () => {
        release();
      },
    };
  }

  it('two concurrent identical NON-shareable calls are not coalesced', async () => {
    const probe = nansenWith(false);

    const first = probe.adapter.fetch(CAPABILITY, ARGS);
    const second = probe.adapter.fetch(CAPABILITY, ARGS);
    // Both are inside their own `fetch()` body before either can settle. With coalescing they
    // would be one; without it they are two.
    await new Promise((resolve) => setTimeout(resolve, 5));
    probe.release();
    await Promise.allSettled([first, second]);

    expect(probe.entries()).toBe(2);
  });

  it('CONTROL: the same two calls at `shareable: true` are coalesced into one', async () => {
    const probe = nansenWith(true);

    const first = probe.adapter.fetch(CAPABILITY, ARGS);
    const second = probe.adapter.fetch(CAPABILITY, ARGS);
    await new Promise((resolve) => setTimeout(resolve, 5));
    probe.release();
    await Promise.allSettled([first, second]);

    expect(probe.entries()).toBe(1);
  });

  it('a SETTLED shareable call is not coalesced either — the narrowing changed one branch', async () => {
    // R-39's own rule: a call arriving after the previous one settled is a genuinely new request.
    // Asserted so the `shareable: true` control above cannot be read as "coalescing is unbounded",
    // and so a future edit that widened coalescing past its settlement boundary would be seen here.
    const probe = nansenWith(true);
    probe.release();
    await probe.adapter.fetch(CAPABILITY, ARGS).catch(() => undefined);
    await probe.adapter.fetch(CAPABILITY, ARGS).catch(() => undefined);

    expect(probe.entries()).toBe(2);
    expect(deriveArgsHash(CAPABILITY, ARGS)).toMatch(/^[0-9a-f]{64}$/);
  });
});
