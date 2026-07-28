import { describe, expect, it } from 'vitest';
import {
  CapabilityRegistry,
  createBlockscoutAdapter,
  createNansenAdapter,
  routes,
  type ProviderAdapter,
} from '../src/index.js';

/**
 * TASK-008 task 008-6 — "the provider is switched off" must be indistinguishable from "the provider
 * is unreachable".
 *
 * This requirement does not come from the vendor's API; it comes from the owner's licence decision
 * (TASK.md OQ-2). The engine is for personal use, and if access is ever opened outward it will be
 * "closed with an option on the server". An option that does not exist yet is not a plan — the day
 * it is needed, removing a provider would mean editing routes under time pressure, on a system that
 * is already exposed. So the ability to drop `blockscout` out of the chain is exercised now, while
 * it costs a test instead of an incident.
 *
 * Nothing new was built for it: R-78 already requires the chain to survive a provider that answers
 * 401/429, and "not in the map at all" is the same walk with the same outcome. That is the point —
 * the test proves the existing mechanism covers the case, rather than adding a second one.
 */

/** The registry as `index.ts` builds it, minus whichever adapters a test wants gone. */
function registryWithout(...omit: string[]): CapabilityRegistry {
  const all: Array<[string, ProviderAdapter]> = [
    ['blockscout', createBlockscoutAdapter({ env: {} })],
    // No key in scope: this suite must not be able to reach Nansen even if something misroutes
    // (PLAN §0.1). `isAvailable()` reports the precondition instead of spending anything.
    ['nansen', createNansenAdapter({ env: {} })],
  ];
  return new CapabilityRegistry([...routes], new Map(all.filter(([id]) => !omit.includes(id))));
}

describe('blockscout switched off (008-6, OQ-2)', () => {
  it('entity.labels still reaches nansen when blockscout is absent from the map', async () => {
    const error = await registryWithout('blockscout')
      .resolve('entity.labels', 'ethereum', {
        chain: 'ethereum',
        tokenAddress: '0x28C6c06298d514Db089934071355E5743bf21d60',
      })
      .then(() => undefined)
      .catch((caught: unknown) => caught as { tried: { adapterId: string; reason: string }[] });

    const tried = error!.tried.map((entry) => entry.adapterId);
    // blockscout is still WALKED (the route names it) and reports a definite reason; nansen is
    // still reached behind it. The chain neither stops early nor crashes.
    expect(tried).toContain('nansen');
    expect(error!.tried.find((e) => e.adapterId === 'nansen')?.reason).toMatch(/NANSEN_API_KEY/);
  });

  it('token.holders degrades to "cannot answer" rather than throwing something unhandled', async () => {
    const error = await registryWithout('blockscout')
      .resolve('token.holders', 'ethereum', {
        chain: 'ethereum',
        tokenAddress: '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48',
      })
      .then(() => undefined)
      .catch((caught: unknown) => caught as Error);

    expect(error).toBeInstanceOf(Error);
    // A named capability failure, not a TypeError from a missing adapter.
    expect(error!.message).toMatch(/token\.holders/);
    expect(error!.name).not.toBe('TypeError');
  });

  it('the switched-off outcome matches the unreachable one for entity.labels', async () => {
    // The actual claim of this task: an operator flipping the provider off produces the SAME
    // observable behaviour as the provider failing. If these diverged, the "just switch it off"
    // plan would be untested in exactly the situation it exists for.
    const offline = createBlockscoutAdapter({
      env: {},
      fetchImpl: async () => new Response(JSON.stringify({ error: 'nope' }), { status: 401 }),
    });
    const withFailingProvider = new CapabilityRegistry(
      [...routes],
      new Map<string, ProviderAdapter>([
        ['blockscout', offline],
        ['nansen', createNansenAdapter({ env: {} })],
      ]),
    );

    const reachedNansen = async (registry: CapabilityRegistry) =>
      registry
        .resolve('entity.labels', 'ethereum', {
          chain: 'ethereum',
          tokenAddress: '0x28C6c06298d514Db089934071355E5743bf21d60',
        })
        .then(() => 'resolved')
        .catch((caught: unknown) =>
          (caught as { tried: { adapterId: string }[] }).tried.map((e) => e.adapterId).join(','),
        );

    // M-8.1 (adversarial cycle 1): this compared `withFailingProvider` against `registryWithout()`
    // — the FULL registry, no omission — while both sides died at the arg guard before the 401
    // `fetchImpl` was ever invoked. It compared a value with itself, and deleting the entire
    // degrade branch left it green. Both halves are now real: args carry `chain`, and the
    // right-hand side actually omits the provider.
    const failing = await reachedNansen(withFailingProvider);
    const omitted = await reachedNansen(registryWithout('blockscout'));
    expect(failing).toBe(omitted);

    // ...and prove the 401 path RAN, rather than being skipped by an earlier guard. Without this
    // the equality above would still hold if both sides failed for some third reason.
    const reason = await withFailingProvider
      .resolve('entity.labels', 'ethereum', {
        chain: 'ethereum',
        tokenAddress: '0x28C6c06298d514Db089934071355E5743bf21d60',
      })
      .then(() => '')
      .catch(
        (caught: unknown) =>
          (caught as { tried: { adapterId: string; reason: string }[] }).tried.find(
            (e) => e.adapterId === 'blockscout',
          )?.reason ?? '',
      );
    // NOT /HTTP 401/ — the generic `!response.ok` error says that too, so deleting the whole
    // degrade branch would leave this green (caught by mutating the branch away). Assert the
    // phrase only `BlockscoutDegradedError` produces.
    expect(reason).toMatch(/falling through to the next adapter/);
  });
});
