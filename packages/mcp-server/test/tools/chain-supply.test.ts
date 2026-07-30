import { describe, expect, it } from 'vitest';
import {
  CapabilityRegistry,
  createBlockchainInfoAdapter,
  routes,
  type ProviderAdapter,
} from '@onchain-intel/core';
import {
  ChainSupplyInputSchema,
  ChainSupplyOutputSchema,
  chainSupplyHandler,
} from '../../src/tools/chain-supply.js';

/**
 * TASK-009 task 009-5 (R-86) — the `onchain_chain_supply` handler, no network.
 *
 * The adapter's own contract is covered in `packages/core`; what is asserted here is the part only
 * the tool layer owns: the handler never throws, a broken provider result becomes `{ok:false}`, and
 * the second identical call is served from cache rather than from a second pair of vendor requests.
 */

/** Live-recorded 2026-07-29 (`docs/onchain-analytics/raw/blockchain-info-stats-2026-07-29.json`). */
const STATS = { totalbc: 2006281875000000, n_blocks_total: 960102 };
const CIRCULATING = '2006279000000000';

/** Minimal in-memory CacheStore — the registry defaults to a passthrough, so cache behaviour is
 * only observable when one is injected. */
function memoryCache() {
  const entries = new Map<string, unknown>();
  return {
    get: (provider: string, capability: string, argsHash: string) =>
      Promise.resolve(
        entries.has(`${provider}|${capability}|${argsHash}`)
          ? { value: entries.get(`${provider}|${capability}|${argsHash}`), ageMs: 0 }
          : undefined,
      ),
    set: (provider: string, capability: string, argsHash: string, value: unknown) => {
      entries.set(`${provider}|${capability}|${argsHash}`, value);
      return Promise.resolve();
    },
  };
}

function ctx(overrides: { stats?: unknown; circulating?: string } = {}) {
  const calls: string[] = [];
  const adapters = new Map<string, ProviderAdapter>([
    [
      'blockchain-info',
      createBlockchainInfoAdapter({
        throttle: () => Promise.resolve(),
        fetchImpl: ((url: string) => {
          calls.push(String(url));
          if (String(url).includes('/q/totalbc')) {
            return Promise.resolve(
              new Response(overrides.circulating ?? CIRCULATING, { status: 200 }),
            );
          }
          return Promise.resolve(
            new Response(JSON.stringify(overrides.stats ?? STATS), { status: 200 }),
          );
        }) as unknown as typeof fetch,
      }),
    ],
  ]);
  return { ctx: { registry: new CapabilityRegistry([...routes], adapters, memoryCache()) }, calls };
}

describe('onchain_chain_supply handler (R-86)', () => {
  it('answers for bitcoin with both supply figures and a parseable contract', async () => {
    const { ctx: context } = ctx();
    const outcome = await chainSupplyHandler({ chain: 'bitcoin' }, context);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(ChainSupplyOutputSchema.safeParse(outcome.value).success).toBe(true);
    expect(outcome.value.emissionRaw).toBe('2006281875000000');
    expect(outcome.value.circulatingRaw).toBe(CIRCULATING);
    expect(outcome.value.chain).toBe('bitcoin');
    expect(outcome.value.decimals).toBe(8);
  });

  it('serves the second identical call from cache, not from a second vendor round trip (AC-5)', async () => {
    const { ctx: context, calls } = ctx();

    const first = await chainSupplyHandler({ chain: 'bitcoin' }, context);
    expect(first.ok && first.cache.status).toBe('miss');
    // Two upstream requests for one answer: /stats and /q/totalbc.
    expect(calls).toHaveLength(2);

    const second = await chainSupplyHandler({ chain: 'bitcoin' }, context);
    expect(second.ok && second.cache.status).toBe('hit');
    // The point of the assertion: still 2, so the hit cost the vendor nothing.
    expect(calls).toHaveLength(2);
  });

  it('reports an uncovered chain as {ok:false}, never as a throw', async () => {
    const { ctx: context, calls } = ctx();
    const outcome = await chainSupplyHandler({ chain: 'ethereum' }, context);
    expect(outcome.ok).toBe(false);
    // Refused by the coverage matrix before any network call — the refusal is free.
    expect(calls).toHaveLength(0);
  });

  it('turns a provider that violates the consensus invariant into {ok:false}, not an exception', async () => {
    // `circulating > emission` — the adapter refuses it, and the handler's job is to carry that out
    // as a tool error rather than letting it escape as a thrown exception.
    const { ctx: context } = ctx({ circulating: '2999999999999999' });
    const outcome = await chainSupplyHandler({ chain: 'bitcoin' }, context);
    expect(outcome.ok).toBe(false);
  });

  it('rejects unknown input keys at the schema boundary', () => {
    expect(ChainSupplyInputSchema.safeParse({ chain: 'bitcoin' }).success).toBe(true);
    expect(ChainSupplyInputSchema.safeParse({ chain: 'bitcoin', extra: 1 }).success).toBe(false);
  });
});
