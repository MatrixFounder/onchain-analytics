import { describe, expect, it } from 'vitest';
import { CapabilityRegistry } from '../src/adapters/registry.js';
import type { ProviderAdapter } from '../src/adapters/types.js';
import { routes } from '../src/providers.config.js';
import { createDashPlatformAdapter } from '../src/adapters/dash-platform/index.js';
import { createPlatformExplorerAdapter } from '../src/adapters/platform-explorer/index.js';

// R-11 proof, on the REAL M1 configuration (F-3 reviewer note) — NOT a hand-rolled route table
// and NOT a mocked "pretend dash-platform is down" adapter: this imports the actual `routes`
// array from providers.config.ts and constructs the actual dash-platform/platform-explorer
// adapter factories. dash-platform.isAvailable() is unconditionally false in M1 (a real, always-
// -active condition, not a simulated one), so CapabilityRegistry.resolve() genuinely walks past
// it to platform-explorer every time — this test proves that real mechanism runs end to end,
// with only the network boundary (platform-explorer's own fetchImpl) faked, per R-21.

const FIXED_NOW = 1_700_000_000_000;

function buildRegistry(fetchImpl: typeof fetch): CapabilityRegistry {
  const adapters = new Map<string, ProviderAdapter>([
    ['dash-platform', createDashPlatformAdapter({ now: () => FIXED_NOW })],
    ['platform-explorer', createPlatformExplorerAdapter({ fetchImpl, now: () => FIXED_NOW })],
  ]);
  return new CapabilityRegistry(routes, adapters);
}

describe('registry hot-swap on the real M1 configuration: dash-platform -> platform-explorer (R-11)', () => {
  it.each([
    ['privacy.shielded_pool', { poolBalance: '4611474006200' }],
    ['platform.identities', { identitiesCount: 3044, api: { block: { height: 403328 } } }],
    ['platform.contracts', { dataContractsCount: 59, api: { block: { height: 403328 } } }],
    ['platform.documents', { documentsCount: 17586, api: { block: { height: 403328 } } }],
    ['platform.credits', { totalCredits: '2802452583638438', api: { block: { height: 403328 } } }],
  ] as const)(
    'routes %s to platform-explorer because dash-platform.isAvailable() is unconditionally false',
    async (capability, body) => {
      const fakeFetchImpl: typeof fetch = async () =>
        new Response(JSON.stringify(body), { status: 200 });
      const registry = buildRegistry(fakeFetchImpl);

      const resolution = await registry.resolve(capability, 'dash', { chain: 'dash' });

      expect(resolution.source).toBe('platform-explorer');
      expect(resolution.cache).toBe('miss');
    },
  );

  it("never calls dash-platform's own HTTP/gRPC step at all — isAvailable() short-circuits before any attempt", async () => {
    let platformExplorerCalls = 0;
    const fakeFetchImpl: typeof fetch = async () => {
      platformExplorerCalls += 1;
      return new Response(JSON.stringify({ poolBalance: '1' }), { status: 200 });
    };
    const registry = buildRegistry(fakeFetchImpl);

    const resolution = await registry.resolve('privacy.shielded_pool', 'dash', { chain: 'dash' });

    expect(resolution.source).toBe('platform-explorer');
    expect(platformExplorerCalls).toBe(1);
    // dash-platform.fetch() would throw NotImplementedInM1Error if ever reached — the absence of
    // that throw here (resolve() didn't reject) is itself proof it was never called.
  });

  it('history routes (privacy.shielded_pool.history) resolve via platform-explorer alone on the real route table', async () => {
    const historyPoints = [
      { timestamp: '2026-07-22T20:55:00.000Z', data: { amount: 0, blockHeight: 1 } },
    ];
    const fakeFetchImpl: typeof fetch = async () =>
      new Response(JSON.stringify(historyPoints), { status: 200 });
    const registry = buildRegistry(fakeFetchImpl);

    const resolution = await registry.resolve('privacy.shielded_pool.history', 'dash', {
      chain: 'dash',
    });

    expect(resolution.source).toBe('platform-explorer');
  });
});
