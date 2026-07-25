import { describe, expect, it } from 'vitest';
import {
  CapabilityRegistry,
  createBudgetStore,
  createNansenAdapter,
  dayBucketMs,
  routes,
  type ProviderAdapter,
} from '@onchain-intel/core';

/**
 * Production-wiring integration test (task 005-6, CRITICAL note carried forward from the 005-5
 * code review) — the "seam-level proof that the gate is live in production wiring, not just in
 * adapter unit tests". `packages/core`'s own `nansen.*.test.ts` suite already proves the budget
 * gate/singleflight/reconcile pipeline works INSIDE `nansen.fetch()` in isolation; THIS file proves
 * the mcp-server-level SEAM those tests can't reach: a `CapabilityRegistry` built the SAME way
 * `index.ts`'s own `buildRegistry()`/`createProductionNansenAdapter()` build the real production
 * one (real `routes` table, the real `createNansenAdapter` factory, a real `SqliteBudgetStore`
 * from `createBudgetStore()`) drives a paid capability through `CapabilityRegistry.resolve()` —
 * the EXACT call every one of the 3 M2 tool handlers makes (`resolve-capability.ts`) — and proves
 * `budgetStore.getUsage('nansen', bucket)` genuinely INCREASED afterward.
 *
 * NO real `NANSEN_API_KEY` (a placeholder string, same convention as every `nansen.*.test.ts` file
 * in `packages/core`), NO live network — every HTTP call goes through an injected `fetchImpl`
 * fixture (`/account` + the two `smart-money.flows` sub-endpoints, each carrying
 * `x-nansen-credits-used`). Zero live credits (this task's own "Живые кредиты: 0").
 */

const NOW = Date.UTC(2026, 6, 24, 12, 0, 0);
const BUCKET = dayBucketMs(NOW);
const ETH_ADDRESS = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';

function jsonResponse(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

/** No-op `Throttle` — see `e2e.inprocess.test.ts`'s own `noOpThrottle` docstring for the full
 * rationale (avoids real-timer waits against `nansen`'s production rate limit). */
async function noOpThrottle(): Promise<void> {
  return undefined;
}

const nansenFixtureFetch: typeof fetch = (async (input: string | URL | Request) => {
  const pathname = new URL(String(input)).pathname;
  switch (pathname) {
    case '/api/v1/account':
      return jsonResponse({ plan: 'free', credits_remaining: 100_000 });
    case '/api/v1/smart-money/netflow':
      return jsonResponse(
        {
          data: [
            {
              token_symbol: 'UNI',
              net_flow_1h_usd: 1,
              net_flow_24h_usd: 2,
              net_flow_7d_usd: 3,
              net_flow_30d_usd: 4,
            },
          ],
        },
        200,
        { 'x-nansen-credits-used': '5' },
      );
    case '/api/v1/tgm/holders':
      return jsonResponse({ data: [] }, 200, { 'x-nansen-credits-used': '5' });
    default:
      throw new Error(`fixture fetchImpl: no nansen route for ${pathname}`);
  }
}) as typeof fetch;

/**
 * Mirrors `index.ts`'s own `createProductionNansenAdapter()` construction SHAPE (real
 * `createNansenAdapter`, `env`+`budgetStore` both supplied — never omitted, the exact
 * construction-site guard `index.ts` itself enforces by type) — the one difference from
 * production is the injected `fetchImpl`/`now`/`throttle`, this test's own "no live network, no
 * real timers" requirement.
 */
function buildProductionShapedRegistry(budgetStore: ReturnType<typeof createBudgetStore>) {
  const nansenAdapter = createNansenAdapter({
    env: { NANSEN_API_KEY: 'test-key-not-real' },
    budgetStore,
    fetchImpl: nansenFixtureFetch,
    now: () => NOW,
    throttle: noOpThrottle,
  });
  const adapters = new Map<string, ProviderAdapter>([['nansen', nansenAdapter]]);
  // The REAL `routes` table (`@onchain-intel/core`'s `providers.config.ts`) — never a hand-built
  // subset — so this test resolves through the SAME route `smart-money.flows` uses in production.
  return new CapabilityRegistry(routes, adapters);
}

describe('production-wiring seam — CapabilityRegistry.resolve() through a real nansen adapter + real BudgetStore', () => {
  it('proves budgetStore.getUsage(nansen, bucket) INCREASES end-to-end after a real registry.resolve() call', async () => {
    const budgetStore = createBudgetStore({ dbPath: ':memory:' });
    const registry = buildProductionShapedRegistry(budgetStore);

    const usageBefore = await budgetStore.getUsage('nansen', BUCKET);
    expect(usageBefore).toBe(0);

    const resolution = await registry.resolve('smart-money.flows', 'ethereum', {
      chain: 'ethereum',
      tokenAddress: ETH_ADDRESS,
    });

    expect(resolution.cache).toBe('miss');
    expect(resolution.source).toBe('nansen');

    const usageAfter = await budgetStore.getUsage('nansen', BUCKET);
    expect(usageAfter).toBe(10); // smart-money.flows = netflow(5cr) + tgm/holders(5cr), R-41
    expect(usageAfter).toBeGreaterThan(usageBefore);
  });

  // TC-E2E-11 equivalent, at the registry seam — no NANSEN_API_KEY: CapabilityRegistry.resolve()
  // rejects with a structured reason naming the missing key, never a crash, never a silent
  // unaccounted paid call.
  it('without NANSEN_API_KEY, resolve() rejects with a reason naming the key — never a value, never a crash', async () => {
    const budgetStore = createBudgetStore({ dbPath: ':memory:' });
    const nansenAdapter = createNansenAdapter({
      env: {}, // no NANSEN_API_KEY
      budgetStore,
      fetchImpl: nansenFixtureFetch,
      now: () => NOW,
      throttle: noOpThrottle,
    });
    const registry = new CapabilityRegistry(
      routes,
      new Map<string, ProviderAdapter>([['nansen', nansenAdapter]]),
    );

    let rejection: unknown;
    try {
      await registry.resolve('smart-money.flows', 'ethereum', {
        chain: 'ethereum',
        tokenAddress: ETH_ADDRESS,
      });
    } catch (error) {
      rejection = error;
    }

    expect(rejection).toBeInstanceOf(Error);
    const message = (rejection as Error).message;
    expect(message).toContain('NANSEN_API_KEY');
    expect(await budgetStore.getUsage('nansen', BUCKET)).toBe(0); // no unaccounted spend either
  });
});
