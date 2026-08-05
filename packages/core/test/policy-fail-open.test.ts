import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { createBlockscoutAdapter } from '../src/adapters/blockscout/index.js';
import { CapabilityRegistry } from '../src/adapters/registry.js';
import type { CacheGetResult, CacheStore } from '../src/adapters/cache-store.js';
import type { CapabilityRoute, ProviderAdapter } from '../src/adapters/types.js';
import type { EntityLabel } from '../src/types/entity-label.js';
import { isolatedThrottle } from './helpers/isolated-throttle.js';

/**
 * TC-INT-06 (task 012-6) — **the fail-open guard M-1**, moved here out of
 * `blockscout-fallback.test.ts` because `vi.mock` is FILE-global.
 *
 * **Why it could not stay where it was.** That file imports the REAL `routes` and builds registries
 * over `[...routes]`. A `vi.mock('../src/adapters/policy.js')` inside it would make the policy throw
 * for EVERY test in the file, and fail-open would then turn each throw into "the answer is
 * satisfying" — so its four cases that need a genuine `false` verdict (including the H-1 regression)
 * would fail, and the pairing case would start passing VACUOUSLY, never having asked the policy at
 * all. One compile-time change would have become four runtime failures plus a tautology.
 *
 * **What produces a throwing predicate now that a route carries only `{ kind }`.** Neither shipped
 * class can throw; the class dictionary has no injection seam (the constructor's five parameters are
 * `routes, adapters, cache, chains, manifests`), and `satisfies()` is a closure inside `resolve()`.
 * The cheapest way to a green run was therefore to DELETE this guard — which is exactly the outcome
 * the task forbids. So the mechanism is named instead of improvised: the class dictionary is mocked,
 * and its `someElementHasAny` entry **resolves successfully** (the registry calls it at construction
 * and gets a predicate back) while **the predicate throws when CALLED**. Had the resolution thrown,
 * construction would have failed and there would be no fail-open left to observe.
 *
 * A sixth constructor parameter (an injectable class map) was considered and rejected:
 * `data-model.md` §M-6 decided that only the manifest map is injected. `vi.mock` adds nothing to the
 * production surface. The counter-example that finding represents is recorded for task 012-10.
 *
 * **This file builds its own small route table** rather than importing the real one — importing
 * `routes` would restore the very coupling the move exists to break.
 *
 * The five helpers below are DUPLICATED from `blockscout-fallback.test.ts`, not extracted: that file
 * is another task's radius (PLAN §0.4) and a shared module would let an edit here change its
 * verdict. `isolatedThrottle` is the exception — it is already a shared helper module.
 */

vi.mock('../src/adapters/policy.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/adapters/policy.js')>();
  return {
    ...actual,
    policyClasses: {
      ...actual.policyClasses,
      // The CLASS resolves — the registry receives a predicate and caches it, so construction is
      // unaffected. The PREDICATE is what throws, on every answer it is handed.
      someElementHasAny: () => () => {
        throw new Error('policy bug');
      },
    },
  };
});

const testDir = path.dirname(fileURLToPath(import.meta.url));
const fixture = (name: string): unknown =>
  JSON.parse(
    readFileSync(path.join(testDir, `../../../docs/onchain-analytics/raw/${name}`), 'utf8'),
  );

const LABELED = fixture('blockscout-labeled-2026-07-28.json');
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

/** Minimal real cache — without it the cache-HIT branch of the policy is never executed. */
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

/** This file's OWN route table — one route, the mocked class, both real adapters behind it. */
const EXPLODING_ROUTES: CapabilityRoute[] = [
  {
    capability: 'entity.labels',
    adapterIds: ['blockscout', 'nansen'],
    policy: { kind: 'someElementHasAny', fields: ['name', 'tags', 'labels'] },
  },
];

describe('TC-INT-06 — a route policy that throws fails OPEN, and never blames the provider', () => {
  it('answers from blockscout on both paths, spends nothing, and says so once on stderr', async () => {
    // A bug in the ROUTE's policy used to be recorded as a defect of the PROVIDER: the predicate ran
    // inside the try that negative-caches a `normalize()` failure, so the policy's own message was
    // written under the adapter's cache key for 60 s and travelled into the tool's isError text.
    // The cache-hit call site had the opposite flaw — outside every try, so the throw escaped
    // `resolve()` untyped. Both are asserted below, on the fresh path and on the cache-hit path.
    const blockscout = createBlockscoutAdapter({
      now: () => 1_700_000_000_000,
      env: {},
      throttle: isolatedThrottle(1_700_000_000_000),
      fetchImpl: () => Promise.resolve(new Response(JSON.stringify(LABELED), { status: 200 })),
    });
    const paid = nansenSpy(['Binance: Hot Wallet']);
    const registry = new CapabilityRegistry(
      EXPLODING_ROUTES,
      new Map<string, ProviderAdapter>([
        ['blockscout', blockscout],
        ['nansen', paid.adapter],
      ]),
      new MemoryCacheStore(),
    );
    const args = { chain: 'ethereum', tokenAddress: BINANCE };

    const written: string[] = [];
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation((chunk): boolean => {
      written.push(String(chunk));
      return true;
    });
    try {
      // Fresh path, then the cache-hit path — both must survive the same broken predicate.
      for (const expected of ['miss', 'hit']) {
        const outcome = await registry.resolve('entity.labels', 'ethereum', args);
        expect(outcome.source, 'a throwing policy suppressed a real answer').toBe('blockscout');
        expect(outcome.cache).toBe(expected);
      }
    } finally {
      stderr.mockRestore();
    }

    expect(paid.calls, 'a policy bug must not divert traffic to the paid provider').toStrictEqual(
      [],
    );
    // The predicate really was reached — otherwise this test would pass against a registry that
    // ignores policies entirely, which is the vacuous version of it.
    //
    // ONE line per throw, and there are two throws because there are two paths (fresh, then cache
    // hit): a single line, naming the capability, the adapter and the verdict — never a stack
    // trace, never a repeat per adapter in the route.
    const complaints = written.filter((line) => line.includes('route policy for entity.labels'));
    expect(complaints).toHaveLength(2);
    expect(complaints[0]).toContain('policy bug');
    expect(complaints[0]).toContain("threw on blockscout's answer");
    expect(complaints[0]).toContain('treating the answer as satisfying');
  });
});
