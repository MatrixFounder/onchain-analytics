import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  CapabilityRegistry,
  createBlockscoutAdapter,
  routes,
  type ProviderAdapter,
} from '@onchain-intel/core';
import {
  TokenHoldersInputSchema,
  TokenHoldersOutputSchema,
  tokenHoldersHandler,
} from '../../src/tools/token-holders.js';

/**
 * `onchain_token_holders` — the MCP surface for the capability TASK-008 revived.
 *
 * Driven through the REAL `blockscout` adapter against the REAL pinned vendor response, with only
 * `fetchImpl` faked. Hand-built fixtures were what let the original `entity.labels` argument bug
 * survive a whole cycle: the unit tests constructed `args` themselves, so they could not notice
 * that no caller could ever produce those args. A tool test that fakes the adapter tests the test.
 */
const here = path.dirname(fileURLToPath(import.meta.url));
const HOLDERS_FIXTURE = JSON.parse(
  readFileSync(
    path.join(here, '../../../../docs/onchain-analytics/raw/blockscout-holders-2026-07-28.json'),
    'utf8',
  ),
) as Record<string, unknown>;

const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';

/**
 * The smallest real cache: enough to observe whether two spellings of one request produce one key
 * or two. `PassthroughCacheStore` (the registry's default) cannot show that, because it stores
 * nothing — which is exactly why the first version of the canonicalization test below was vacuous.
 *
 * Typed STRUCTURALLY off the registry's own constructor rather than by importing a `CacheStore`
 * interface: `@onchain-intel/core` exports only the `createCacheStore` factory, and widening a
 * package's public surface to make one test compile is the wrong trade.
 */
type RegistryCacheStore = NonNullable<ConstructorParameters<typeof CapabilityRegistry>[2]>;

class MemoryCacheStore {
  private readonly entries = new Map<string, unknown>();
  get(provider: string, capability: string, argsHash: string): Promise<unknown> {
    const key = `${provider}|${capability}|${argsHash}`;
    if (!this.entries.has(key)) return Promise.resolve(undefined);
    return Promise.resolve({ value: this.entries.get(key), ageMs: 0 });
  }
  set(provider: string, capability: string, argsHash: string, value: unknown): Promise<void> {
    this.entries.set(`${provider}|${capability}|${argsHash}`, value);
    return Promise.resolve();
  }
}

function ctx(body: unknown = HOLDERS_FIXTURE, calls: string[] = [], cache?: RegistryCacheStore) {
  const adapters = new Map<string, ProviderAdapter>([
    [
      'blockscout',
      createBlockscoutAdapter({
        env: {},
        fetchImpl: ((url: string | URL) => {
          calls.push(String(url));
          return Promise.resolve(new Response(JSON.stringify(body), { status: 200 }));
        }) as unknown as typeof fetch,
      }),
    ],
  ]);
  return {
    registry: cache
      ? new CapabilityRegistry([...routes], adapters, cache)
      : new CapabilityRegistry([...routes], adapters),
  };
}

describe('onchain_token_holders — input contract', () => {
  it('requires a tokenAddress and rejects one that is not an address for the chain', () => {
    expect(TokenHoldersInputSchema.safeParse({ chain: 'ethereum' }).success).toBe(false);
    expect(
      TokenHoldersInputSchema.safeParse({ chain: 'ethereum', tokenAddress: 'not-an-address' })
        .success,
    ).toBe(false);
    expect(
      TokenHoldersInputSchema.safeParse({ chain: 'ethereum', tokenAddress: USDC }).success,
    ).toBe(true);
  });

  it('is `.strict()` — an unknown field is rejected, never silently ignored', () => {
    // The failure this prevents is the `entity.labels` one in reverse: a caller passing `limit`
    // (which this tool deliberately does not have) must be told so, not quietly served a different
    // question than the one asked.
    const parsed = TokenHoldersInputSchema.safeParse({
      chain: 'ethereum',
      tokenAddress: USDC,
      limit: 10,
    });
    expect(parsed.success).toBe(false);
  });
});

describe('onchain_token_holders — handler over the real adapter and the pinned response', () => {
  it('answers from the recorded vendor payload and satisfies its own output schema', async () => {
    const outcome = await tokenHoldersHandler({ chain: 'ethereum', tokenAddress: USDC }, ctx());

    expect(outcome.ok, outcome.ok ? '' : outcome.reason).toBe(true);
    if (!outcome.ok) return;

    expect(TokenHoldersOutputSchema.safeParse(outcome.output).success).toBe(true);
    expect(outcome.output.holders.length).toBeGreaterThan(0);
    expect(outcome.output.source).toBe('blockscout');
    expect(outcome.cache.status).toBe('miss');
    // Exact base units, as a string, never a number — DB-SCHEMA §1.7. A `number` here would be
    // wrong for realistic 18-decimal supplies, not exotic ones.
    expect(typeof outcome.output.holders[0]!.amountRaw).toBe('string');
    expect(outcome.output.holders[0]!.amountRaw).toMatch(/^(0|[1-9][0-9]*)$/);
  });

  it('canonicalizes the chain alias and the address BEFORE the cache key is derived', async () => {
    // Two spellings of one logical request must hit ONE cache entry. The adapter normalizes inside
    // `fetch()` — i.e. after `deriveArgsHash` already ran — so without the handler doing it too,
    // `0xA0b8…` and `0xa0b8…` become two entries and two upstream fan-outs (vdd-multi i1, perf M-5).
    //
    // ASSERTED ON THE UPSTREAM CALL COUNT, not on the output. The first version of this test
    // compared `second.output.tokenAddress` to the first — which passes either way, because the
    // adapter canonicalizes the address on its own before emitting it. Caught by the mutation
    // battery: deleting `normalizeAddress` from the handler left the whole suite green. The cache
    // key is the only place the difference is observable, so the cache is what the test must use.
    const calls: string[] = [];
    const c = ctx(HOLDERS_FIXTURE, calls, new MemoryCacheStore() as RegistryCacheStore);

    const first = await tokenHoldersHandler({ chain: 'ethereum', tokenAddress: USDC }, c);
    const second = await tokenHoldersHandler({ chain: 'eth', tokenAddress: USDC.toLowerCase() }, c);

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(first.cache.status).toBe('miss');
    expect(second.cache.status).toBe('hit');
    expect(calls).toHaveLength(1);
  });

  it('reports truncation honestly — "50 holders" must not look like "the first 50 of many"', async () => {
    const outcome = await tokenHoldersHandler({ chain: 'ethereum', tokenAddress: USDC }, ctx());
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;

    // The pinned response carries a pagination cursor, so this page is NOT the whole holder set.
    // A model answering a concentration question off a `truncated: false` list would state a share
    // of supply the vendor never asserted.
    expect(outcome.output.truncated).toBe(true);
    expect(outcome.output.droppedRows).toBeGreaterThanOrEqual(0);
  });

  it('refuses an uncovered chain BEFORE any network attempt', async () => {
    const calls: string[] = [];
    const outcome = await tokenHoldersHandler(
      // Blockscout runs EVM explorers only; zcash is in our registry and not in its list.
      { chain: 'zcash', tokenAddress: USDC },
      ctx(HOLDERS_FIXTURE, calls),
    );

    expect(outcome.ok).toBe(false);
    // Coverage is a GATE, not a filter over a response: an uncovered chain must cost nothing.
    expect(calls).toEqual([]);
  });

  it('reports a contract violation as a reason, never as a throw or a plausible empty list', async () => {
    // A body whose `items` is absent used to become an authoritative `{holders: [], truncated:
    // false}` — on a route with no fallback adapter, cached for an hour (vdd-multi i1, M-3).
    const outcome = await tokenHoldersHandler(
      { chain: 'ethereum', tokenAddress: USDC },
      ctx({ data: { next_page_params: null } }),
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason.length).toBeGreaterThan(0);
    // R-68e: the refusal must not carry vendor free text into the model's context.
    expect(outcome.reason).not.toMatch(/instructions|You MUST/i);
  });
});

describe('onchain_token_holders — the advertisement is now backed by a tool', () => {
  it('resolves the capability the coverage matrix advertises', async () => {
    // The defect this tool closes: `onchain_list_chains` listed `token.holders` on 39 chains while
    // nothing in `src/` resolved it — "advertised by the matrix, served nowhere", one layer up from
    // where TASK-008 removed it. If this tool is ever unregistered without also narrowing the
    // matrix, that state returns.
    const outcome = await tokenHoldersHandler({ chain: 'ethereum', tokenAddress: USDC }, ctx());
    expect(outcome.ok).toBe(true);
  });
});
