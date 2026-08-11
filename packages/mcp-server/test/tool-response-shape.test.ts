import { describe, expect, it } from 'vitest';
import { CapabilityRegistry } from '@onchain-intel/core';
import type { BudgetStore, CapabilityRoute, ProviderAdapter } from '@onchain-intel/core';
import { captureToolsList } from '../scripts/snapshot-tools.js';
import { smartMoneyFlowsHandler } from '../src/tools/smart-money-flows.js';

/**
 * Task 012-3 — none of `tier`, `trust` or `attempted` crosses the wire (R-152, AC-16).
 *
 * All three are INTERNAL: `tier` decides whether a call costs money at the vendor, `trust` ranks the
 * editability of a vendor's data (ADR-002 D8/D9 place both inside the engine), and `attempted` is the
 * list of adapters a traversal entered — the composition of our own routing, which no client contract
 * describes. The failure this file exists to prevent is the cheap one — a field leaking into a tool
 * response "because it is just one more field", after which it is a published contract and can no
 * longer be renamed or dropped.
 *
 * **`attempted` was added in adversarial cycle 3.** Cycle 2 introduced it on `ResolveSuccess` with a
 * docstring saying it "never reaches the wire, and no tool's zod output schema grows to carry it" —
 * and nothing checked that. The only thing keeping it off the wire was that all three M2 handlers
 * happen to build their return value field by field; the ordinary refactor to `return { ...outcome,
 * … }` would have published it with every test still green. The orchestrator then told the cycle-3
 * security critic that this gate covered it, which it did not: the claim and the constant below had
 * to be made to agree, and this is which way round.
 *
 * **Two surfaces, because they can leak independently:**
 *
 * 1. The published `tools/list` — every input and output schema of all 13 tools, captured LIVE from
 *    the real server (the same capture `tools-list-contract.test.ts` freezes byte-for-byte). Live,
 *    not the committed fixture: a zod schema gaining a `tier` field would show up here immediately,
 *    whereas the fixture only changes when someone regenerates it.
 * 2. The `_meta` a real tool handler actually returns — `_meta.cache` and `_meta.budget`, the two
 *    objects `e2e.inprocess.test.ts` pins by value (`:738`, `:770`, `:796`, `:817`).
 *
 * **KEYS are scanned, never text.** The word "tier" occurs legitimately in prose — `entity.labels`
 * describes its price tiers in its own description — so a substring scan would fire on correct
 * documentation, and the "fix" would be to reword a description: a gate editing the contract it is
 * supposed to guard. A key named `tier` is the leak; the word `tier` in a sentence is not.
 */

const FORBIDDEN_KEYS = ['tier', 'trust', 'attempted'];

/** Every object key in `value`, at any depth, arrays included. */
function collectKeys(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const element of value) collectKeys(element, into);
    return into;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, nested] of Object.entries(value)) {
      into.add(key);
      collectKeys(nested, into);
    }
  }
  return into;
}

/** Exactly the forbidden keys present in `value` — named, so a failure is actionable. */
const leaked = (value: unknown): string[] =>
  FORBIDDEN_KEYS.filter((key) => collectKeys(value).has(key));

const ETH_ADDRESS = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';

const ROUTES: CapabilityRoute[] = [{ capability: 'smart-money.flows', adapterIds: ['nansen'] }];

/** Stands in for the real `nansen` adapter — same convention as `test/tools/*.test.ts`. */
function fakeNansenAdapter(): ProviderAdapter {
  return {
    id: 'nansen',
    capabilities: () => [{ id: 'smart-money.flows', chains: ['ethereum'] }],
    costOf: () => ({ credits: 10 }),
    fetch: async () => ({}),
    normalize: () => ({
      chain: 'ethereum' as const,
      tokenAddress: ETH_ADDRESS,
      tokenSymbol: 'UNI',
      netflow1hUsd: 100,
      netflow24hUsd: 200,
      netflow7dUsd: 300,
      netflow30dUsd: 400,
      topHolders: [],
      source: 'nansen',
      fetchedAt: 1_800_000_000_000,
    }),
    isAvailable: () => ({ ok: true }),
  };
}

function fakeBudgetStore(): BudgetStore {
  return {
    checkAndReserve: async () => ({ ok: true }),
    recordDelta: async () => undefined,
    getUsage: async () => 10,
    getWindowUsage: async () => 0,
    getWindowCalls: async () => 0,
  };
}

describe('TC-GATE-03 — no internal key appears anywhere in the published contract (R-152)', () => {
  it('no input or output schema of any of the 17 tools carries any of them, at any depth', async () => {
    const tools = await captureToolsList();

    // Sign of work BEFORE the verdict: an empty capture, or one that stopped at the top level,
    // would report "nothing leaked" identically to a clean one.
    expect(tools).toHaveLength(17);
    const keys = collectKeys(tools);
    expect(keys.has('inputSchema')).toBe(true);
    expect(keys.has('outputSchema')).toBe(true);
    // Proof the walk DESCENDS: these live three and four levels down, inside `properties`.
    expect(keys.has('chain')).toBe(true);
    expect(keys.has('tokenAddress')).toBe(true);
    expect(keys.size).toBeGreaterThan(100);

    const offenders = tools
      .filter((tool) => leaked(tool).length > 0)
      .map((tool) => `${tool.name}: ${leaked(tool).join(', ')}`);
    expect(
      offenders,
      '`tier`/`trust` are internal classifications (ADR-002 D8/D9) and `attempted` is our own ' +
        'route composition. A tool schema publishing one turns an engine internal into a client contract.',
    ).toStrictEqual([]);
  });

  it('none of them appears in the `_meta` a real tool handler returns, nor in its payload', async () => {
    // The REAL handler over a fake adapter + fake budget store: `outcome.cache` and
    // `outcome.budget` are the exact objects the renderer publishes as `_meta.cache`/`_meta.budget`
    // (see `defineTool`), and `outcome.output` is the one it publishes as `structuredContent`.
    const registry = new CapabilityRegistry(ROUTES, new Map([['nansen', fakeNansenAdapter()]]));
    const outcome = await smartMoneyFlowsHandler(
      { chain: 'ethereum', tokenAddress: ETH_ADDRESS },
      { registry, budgetStore: fakeBudgetStore() },
    );

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) throw new Error('expected ok:true');

    // Sign of work: both `_meta` halves are actually present in what was scanned. Without this the
    // test would pass just as happily on a cache HIT, where `budget` is absent by design.
    expect(outcome.cache.status).toBe('miss');
    expect(outcome.budget).toBeDefined();
    const keys = collectKeys(outcome);
    expect(keys.has('creditsUsedToday')).toBe(true);
    expect(keys.has('provider')).toBe(true);

    expect(leaked(outcome), 'an internal rank reached a tool response').toStrictEqual([]);
  });

  it('the scan would SEE any of the keys — at the top level and nested', () => {
    // Without this control the two assertions above are indistinguishable from a walk that never
    // looked inside anything.
    expect(leaked({ tier: 'paid' })).toStrictEqual(['tier']);
    expect(leaked({ _meta: { budget: { provider: 'nansen', tier: 'paid' } } })).toStrictEqual([
      'tier',
    ]);
    expect(
      leaked({ outputSchema: { properties: { entities: [{ trust: 'community' }] } } }),
    ).toStrictEqual(['trust']);
    // ...and it is a KEY scan: the same word as prose, or as a VALUE, is not a leak.
    expect(leaked({ description: 'the exhaustive tier costs more' })).toStrictEqual([]);
    expect(leaked({ properties: { plan: { const: 'tier' } } })).toStrictEqual([]);
    // `attempted` is the cycle-3 addition, and the control is the shape the leak would actually
    // take: the handler spreading its resolve outcome instead of naming the fields it publishes.
    expect(leaked({ ok: true, cache: {}, attempted: ['blockscout', 'nansen'] })).toStrictEqual([
      'attempted',
    ]);
  });
});
