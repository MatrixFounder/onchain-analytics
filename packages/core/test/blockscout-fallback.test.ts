import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CapabilityRegistry, createBlockscoutAdapter, routes } from '../src/index.js';
import { CapabilityUnavailableError } from '../src/adapters/registry.js';
import type { CapabilityAttempt } from '../src/adapters/registry.js';
import type { CacheGetResult, CacheStore } from '../src/adapters/cache-store.js';
import type { ProviderAdapter } from '../src/adapters/types.js';
import type { EntityLabel } from '../src/types/entity-label.js';

/**
 * vdd-multi TASK-008, H-1 — the free-first handoff, asserted by RUNNING both adapters.
 *
 * Two tests already claimed to cover this and could not:
 * `blockscout.contract.test.ts` registers only `blockscout`, and `nansen.adapter.test.ts` registers
 * only `nansen`. In both, the absent id reaches `tried[]` through the registry's own
 * "no adapter registered for this id" branch — so they guard route ORDER (swapping the two ids in
 * `providers.config.ts` does turn them red, which is worth keeping) while proving nothing about
 * what happens when the free source actually answers. The defect they were meant to catch — an
 * empty Blockscout result terminating the route and shadowing Nansen for the whole 3600 s TTL —
 * lived underneath them for the whole of TASK-008.
 *
 * The fix under test is `CapabilityRoute.isSatisfying`, i.e. a ROUTER-level policy. It is asserted
 * here rather than in the adapter's own suite on purpose: the adapter is not supposed to know that
 * Nansen exists, so there is nothing about this behaviour that its unit tests could legitimately
 * see.
 */
const testDir = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): unknown =>
  JSON.parse(
    readFileSync(path.join(testDir, `../../../docs/onchain-analytics/raw/${name}`), 'utf8'),
  );

const LABELED = fixture('blockscout-labeled-2026-07-28.json');
const NO_TAGS = { data: { metadata: null } };
const BINANCE = '0x28C6c06298d514Db089934071355E5743bf21d60';

/** A stand-in for the PAID provider that records whether it was reached at all. */
function nansenSpy(labels: string[]): { adapter: ProviderAdapter; calls: string[] } {
  const calls: string[] = [];
  const answer: EntityLabel[] = [
    {
      chain: 'ethereum',
      address: BINANCE,
      ...(labels[0] === undefined ? {} : { name: labels[0] }),
      tags: [],
      labels,
      premiumRequested: false,
      source: 'nansen',
      fetchedAt: 0,
    },
  ];
  return {
    calls,
    adapter: {
      id: 'nansen',
      capabilities: () => [{ id: 'entity.labels' }],
      costOf: () => ({ credits: 0 }),
      chainSupport: () => true,
      fetch: (cap: string) => {
        calls.push(cap);
        return Promise.resolve({ kind: 'nansen' });
      },
      normalize: () => answer,
      isAvailable: () => ({ ok: true }),
    },
  };
}

/**
 * Minimal real cache. The registry's default is `PassthroughCacheStore` (always a miss), so without
 * this the cache-HIT branch of the route policy is never executed by any test — which a mutation
 * run proved: deleting the policy check on that branch left the whole suite green.
 */
class MemoryCacheStore implements CacheStore {
  private readonly entries = new Map<string, unknown>();
  private key(provider: string, capability: string, argsHash: string): string {
    return `${provider}|${capability}|${argsHash}`;
  }
  get(provider: string, capability: string, argsHash: string): Promise<CacheGetResult | undefined> {
    const value = this.entries.get(this.key(provider, capability, argsHash));
    return Promise.resolve(value === undefined ? undefined : { value, ageMs: 1 });
  }
  set(provider: string, capability: string, argsHash: string, value: unknown): Promise<void> {
    this.entries.set(this.key(provider, capability, argsHash), value);
    return Promise.resolve();
  }
}

function registryWith(
  vendorBody: unknown,
  paidLabels: string[] = ['Binance: Hot Wallet'],
  cache?: CacheStore,
): { registry: CapabilityRegistry; paidCalls: string[] } {
  const blockscout = createBlockscoutAdapter({
    now: () => 1_700_000_000_000,
    env: {},
    fetchImpl: () => Promise.resolve(new Response(JSON.stringify(vendorBody), { status: 200 })),
  });
  const paid = nansenSpy(paidLabels);
  return {
    paidCalls: paid.calls,
    registry: new CapabilityRegistry(
      [...routes],
      new Map<string, ProviderAdapter>([
        ['blockscout', blockscout],
        ['nansen', paid.adapter],
      ]),
      cache,
    ),
  };
}

describe('entity.labels — free source first, paid source only when it cannot answer (AC-2)', () => {
  it('spends nothing when Blockscout HAS labels — nansen is never invoked', async () => {
    const { registry, paidCalls } = registryWith(LABELED);

    const { result, source } = await registry.resolve('entity.labels', 'ethereum', {
      // `chain` travels in `args` as well as in the positional parameter: `resolve()` uses the
      // positional one for the coverage gate and passes `args` through to the adapter untouched.
      // Omitting it here made blockscout throw `"chain" is required` and handed the answer to
      // nansen for a reason that had nothing to do with what these tests assert.
      chain: 'ethereum',
      tokenAddress: BINANCE,
    });

    expect(source).toBe('blockscout');
    expect((result as EntityLabel[])[0]!.source).toBe('blockscout');
    expect(paidCalls, 'the paid provider was called despite a free answer').toEqual([]);
  });

  it('reaches nansen when Blockscout has NO labels — the UC-2 failure, now guarded', async () => {
    // Before the fix this returned blockscout's `{tags: [], labels: []}` with `paidCalls === []`:
    // a free non-answer published as the answer and cached for an hour. Delete `isSatisfying` from
    // the `entity.labels` route in `providers.config.ts` and this goes red — nothing else notices.
    const { registry, paidCalls } = registryWith(NO_TAGS);

    const { result, source } = await registry.resolve('entity.labels', 'ethereum', {
      chain: 'ethereum',
      tokenAddress: BINANCE,
    });

    expect(paidCalls, 'the route stopped at the free provider').toEqual(['entity.labels']);
    expect(source).toBe('nansen');
    expect((result as EntityLabel[])[0]!.labels).toContain('Binance: Hot Wallet');
  });

  it('reaches nansen when the caller sent a free-text query the free source cannot serve (H-2)', async () => {
    // The other silent-narrowing path: blockscout used to ignore `query` whenever `tokenAddress`
    // was also present and answer from the address alone, under its own `source` label. Here the
    // handoff is a provider-level decline — "I do not serve free-text queries" is a fact about
    // blockscout, unlike "someone else might know", which is the router's business.
    const { registry, paidCalls } = registryWith(LABELED);

    const { source } = await registry.resolve('entity.labels', 'ethereum', {
      chain: 'ethereum',
      tokenAddress: BINANCE,
      query: 'Wintermute',
    });

    expect(paidCalls).toEqual(['entity.labels']);
    expect(source).toBe('nansen');
  });

  it('returns the truthful empty answer when NOBODY has labels — not an outage', async () => {
    // The half that keeps `isSatisfying` from becoming a new failure mode. "No provider has labels
    // for this address" is a fact; `CapabilityUnavailableError` would tell the caller to retry
    // something that cannot change, and on a paid route each retry is a reservation attempt.
    const { registry, paidCalls } = registryWith(NO_TAGS, []);

    const { result, source } = await registry.resolve('entity.labels', 'ethereum', {
      chain: 'ethereum',
      tokenAddress: BINANCE,
    });

    expect(paidCalls, 'every provider must still be asked').toEqual(['entity.labels']);
    // The FIRST unsatisfying answer is the one returned — the free one, so an empty result costs
    // nothing to report and still names who was asked.
    expect(source).toBe('blockscout');
    expect((result as EntityLabel[])[0]!.labels).toEqual([]);
  });

  it('the policy applies to CACHE HITS too — shadowing must not return through the cache', async () => {
    // Found by mutation, not by reading: deleting the policy check on the cache-hit branch left all
    // 995 tests green, because the registry's default store is a passthrough and no test ever
    // produced a hit. That branch is the whole reason the fix survives a restart — stored answers
    // outlive the deploy that fixed the code, so a policy applied only to fresh results would let
    // the hour-long shadowing come back the moment the first empty answer was written.
    const { registry, paidCalls } = registryWith(
      NO_TAGS,
      ['Binance: Hot Wallet'],
      new MemoryCacheStore(),
    );
    const args = { chain: 'ethereum', tokenAddress: BINANCE };

    const first = await registry.resolve('entity.labels', 'ethereum', args);
    expect(first.source).toBe('nansen');
    expect(first.cache).toBe('miss');

    // Second identical call: blockscout's empty answer is now a cache HIT, and must still not win.
    const second = await registry.resolve('entity.labels', 'ethereum', args);
    expect(second.source, 'a cached empty answer terminated the route').toBe('nansen');
    expect(second.cache, 'nansen answered from cache, so nothing was re-fetched').toBe('hit');
    expect(paidCalls, 'the paid provider must not be called twice for the same question').toEqual([
      'entity.labels',
    ]);
  });

  it('does NOT publish an empty answer when the paid provider could not be asked (iteration 2, H-1)', async () => {
    // The regression the first version of this fix introduced, and the reason it matters more than
    // the defect it replaced. With no `NANSEN_API_KEY` the walk is: blockscout answers empty
    // (unsatisfying) → nansen is unavailable → and the first version RETURNED blockscout's empty
    // answer as a success, discarding `tried[]`. The tool then reported `isError: false` and
    // "this address has no entity labels" — for an address the paid source would have attributed.
    // On a mixer or a sanctioned address that is a false negative delivered with full authority,
    // and it silently voided R-40 (an explicit `isError` naming the missing key).
    const blockscout = createBlockscoutAdapter({
      now: () => 1_700_000_000_000,
      env: {},
      fetchImpl: () => Promise.resolve(new Response(JSON.stringify(NO_TAGS), { status: 200 })),
    });
    const unavailableNansen: ProviderAdapter = {
      id: 'nansen',
      capabilities: () => [{ id: 'entity.labels' }],
      costOf: () => ({ credits: 0 }),
      chainSupport: () => true,
      fetch: () => Promise.reject(new Error('unreachable')),
      normalize: () => [],
      isAvailable: () => ({ ok: false, reason: 'needs NANSEN_API_KEY' }),
    };
    const registry = new CapabilityRegistry(
      [...routes],
      new Map<string, ProviderAdapter>([
        ['blockscout', blockscout],
        ['nansen', unavailableNansen],
      ]),
    );

    const error = await registry
      .resolve('entity.labels', 'ethereum', { chain: 'ethereum', tokenAddress: BINANCE })
      .then(() => undefined)
      .catch((caught: unknown) => caught as CapabilityUnavailableError);

    expect(error, 'an unreachable paid provider was reported as "no labels"').toBeDefined();
    expect(error!.name).toBe('CapabilityUnavailableError');
    // Both halves must be visible: why the free source was not enough, and why the paid one failed.
    expect(error!.tried.map((entry: CapabilityAttempt) => entry.adapterId)).toEqual([
      'blockscout',
      'nansen',
    ]);
    expect(error!.message).toContain('needs NANSEN_API_KEY');
    expect(error!.message).toContain('answered, but not with what was asked for');
  });

  it('fails OPEN when the route policy itself throws, and never blames the provider (M-1)', async () => {
    // A bug in the ROUTE's policy used to be recorded as a defect of the PROVIDER: the predicate ran
    // inside the try that negative-caches a `normalize()` failure, so the policy's own message was
    // written under the adapter's cache key for 60 s and travelled into the tool's isError text.
    // The cache-hit call site had the opposite flaw — outside every try, so the throw escaped
    // `resolve()` untyped.
    const exploding = [
      {
        capability: 'entity.labels',
        adapterIds: ['blockscout', 'nansen'],
        isSatisfying: () => {
          throw new Error('policy bug');
        },
      },
    ];
    const blockscout = createBlockscoutAdapter({
      now: () => 1_700_000_000_000,
      env: {},
      fetchImpl: () => Promise.resolve(new Response(JSON.stringify(LABELED), { status: 200 })),
    });
    const paid = nansenSpy(['Binance: Hot Wallet']);
    const registry = new CapabilityRegistry(
      [...exploding],
      new Map<string, ProviderAdapter>([
        ['blockscout', blockscout],
        ['nansen', paid.adapter],
      ]),
      new MemoryCacheStore(),
    );
    const args = { chain: 'ethereum', tokenAddress: BINANCE };

    // Fresh path, then the cache-hit path — both must survive the same broken predicate.
    for (const expected of ['miss', 'hit']) {
      const outcome = await registry.resolve('entity.labels', 'ethereum', args);
      expect(outcome.source, 'a throwing policy suppressed a real answer').toBe('blockscout');
      expect(outcome.cache).toBe(expected);
    }
    expect(paid.calls, 'a policy bug must not divert traffic to the paid provider').toEqual([]);
  });

  it('judges each adapter by the policy of the route that contributed it (M-2)', async () => {
    // Adapters used to be unioned across every matching route while the policy was taken from
    // whichever route declared one first — so route B's policy silently judged route A's adapters.
    // `wallet.balances.native` already ships as two routes for one capability, so the shape is live.
    const twoRoutes = [
      // Route A contributes blockscout and declares NO policy: its answer must be accepted as-is,
      // empty or not.
      { capability: 'entity.labels', adapterIds: ['blockscout'] },
      // Route B contributes nansen and demands a non-empty answer.
      {
        capability: 'entity.labels',
        adapterIds: ['nansen'],
        // Must be a policy blockscout's EMPTY answer fails, or the mutation "apply route B's
        // policy to route A's adapter" cannot be detected: that answer is an array of ONE entry
        // carrying no labels, so a bare `length > 0` is true for it and the test passes either way.
        isSatisfying: (result: unknown) =>
          Array.isArray(result) &&
          result.some(
            (entry) =>
              typeof entry === 'object' &&
              entry !== null &&
              Array.isArray((entry as { labels?: unknown }).labels) &&
              (entry as { labels: unknown[] }).labels.length > 0,
          ),
      },
    ];
    const blockscout = createBlockscoutAdapter({
      now: () => 1_700_000_000_000,
      env: {},
      fetchImpl: () => Promise.resolve(new Response(JSON.stringify(NO_TAGS), { status: 200 })),
    });
    const paid = nansenSpy(['Binance: Hot Wallet']);
    const registry = new CapabilityRegistry(
      [...twoRoutes],
      new Map<string, ProviderAdapter>([
        ['blockscout', blockscout],
        ['nansen', paid.adapter],
      ]),
    );

    const { source } = await registry.resolve('entity.labels', 'ethereum', {
      chain: 'ethereum',
      tokenAddress: BINANCE,
    });

    expect(source, "route B's policy was applied to route A's adapter").toBe('blockscout');
    expect(paid.calls).toEqual([]);
  });
});
