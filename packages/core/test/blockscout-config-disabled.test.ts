import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { ProviderAdapter } from '../src/adapters/types.js';
import type { EntityLabel } from '../src/types/entity-label.js';

/**
 * TASK-008 task 008-6, second form — `blockscout` removed from `providers.config.ts` entirely.
 *
 * `blockscout-disabled.test.ts` covers the other way to switch a provider off: omit it from the
 * adapter Map. That is the form a TEST reaches for. The form an OWNER reaches for is this one —
 * OQ-2's answer is that outward access "закрывается опцией на сервере", and deleting the
 * registration is the obvious way to do it, because the registration is what grants the provider its
 * SSRF allowlist and its rate limit in the first place.
 *
 * The two forms are not interchangeable, which is why this file exists. Until vdd-multi found it,
 * removing the config entry made `blockscout/index.ts` throw at MODULE SCOPE — and
 * `packages/core/src/index.ts` re-exports that module, so the throw fired during
 * `import '@onchain-intel/core'`, before `main()` ran. The whole MCP server failed to boot. The
 * owner's kill switch took the process down with it: the exact opposite of "degrade honestly", and
 * the failure mode is worst precisely when it is used, i.e. under pressure on an exposed system.
 *
 * The adapter now constructs and declines everything. It deliberately does NOT fall back to built-in
 * host/rate-limit defaults — `providers.config.ts` is the single source of egress truth, and an
 * adapter that invents its own allowlist when the config is absent is an adapter that cannot be
 * turned off at all.
 *
 * The config is replaced through `vi.doMock` + a fresh dynamic import, because `REGISTRATION` is
 * resolved once at module load. Loading the BARREL rather than the adapter module is deliberate:
 * the regression was in what `import '@onchain-intel/core'` does, so that is what gets imported.
 */
type Core = typeof import('../src/index.js');

let core: Core;

beforeAll(async () => {
  vi.resetModules();
  vi.doMock('../src/providers.config.js', async () => {
    const actual = await vi.importActual<typeof import('../src/providers.config.js')>(
      '../src/providers.config.js',
    );
    return {
      ...actual,
      // The owner's edit: the entry is gone. `routes` still names `blockscout`, exactly as it would
      // if someone deleted only the registration — the harder case, and the realistic one.
      adapterRegistrations: actual.adapterRegistrations.filter(
        (entry) => entry.id !== 'blockscout',
      ),
    };
  });
  // The assertion is the absence of a throw here: this import IS the boot path.
  core = await import('../src/index.js');
});

afterAll(() => {
  vi.doUnmock('../src/providers.config.js');
  vi.resetModules();
});

/** A stand-in for the paid provider that records whether it was reached. */
function nansenSpy(): { adapter: ProviderAdapter; calls: string[] } {
  const calls: string[] = [];
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
      normalize: (): EntityLabel[] => [
        {
          chain: 'ethereum',
          address: '0x28C6c06298d514Db089934071355E5743bf21d60',
          name: 'Binance: Hot Wallet',
          tags: [],
          labels: ['Binance: Hot Wallet'],
          premiumRequested: false,
          source: 'nansen',
          fetchedAt: 0,
        },
      ],
      isAvailable: () => ({ ok: true }),
    },
  };
}

describe('blockscout removed from providers.config.ts (008-6, OQ-2)', () => {
  it('importing the package still succeeds — the kill switch must not take the server down', () => {
    // `beforeAll` would have thrown if it did. Asserted explicitly so the guarantee is named rather
    // than implied by the file happening to run.
    expect(core.createBlockscoutAdapter).toBeTypeOf('function');
  });

  it('the adapter constructs and declines everything, naming the missing config entry', async () => {
    const adapter = core.createBlockscoutAdapter({ env: {} });

    expect(adapter.id).toBe('blockscout');
    expect(adapter.capabilities()).toEqual([]);
    expect(adapter.isAvailable?.()).toEqual({
      ok: false,
      reason: 'disabled in providers.config.ts',
    });
    // Fail-closed pricing: an unrecognised provider must never look free (R-37 MIN-3's rule).
    expect(adapter.costOf('entity.labels', {})).toEqual({ credits: Number.POSITIVE_INFINITY });

    await expect(adapter.fetch('entity.labels', { chain: 'ethereum' })).rejects.toThrow(
      /no entry in adapterRegistrations/,
    );
    expect(() => adapter.normalize('entity.labels', {})).toThrow(
      /no entry in adapterRegistrations/,
    );
  });

  it('serves no chain, so the coverage matrix stops advertising it', () => {
    const adapter = core.createBlockscoutAdapter({ env: {} });
    const rows = core.loadChainRegistry().list();
    expect(rows.length).toBeGreaterThan(0);
    const covered = rows.filter((row) => adapter.chainSupport?.(row, 'token.holders') === true);
    expect(covered.map((row) => row.slug)).toEqual([]);
  });

  it('entity.labels degrades to nansen — the requirement 008-6 exists for', async () => {
    const paid = nansenSpy();
    const registry = new core.CapabilityRegistry(
      [...core.routes],
      new Map<string, ProviderAdapter>([
        ['blockscout', core.createBlockscoutAdapter({ env: {} })],
        ['nansen', paid.adapter],
      ]),
    );

    const { result, source } = await registry.resolve('entity.labels', 'ethereum', {
      chain: 'ethereum',
      tokenAddress: '0x28C6c06298d514Db089934071355E5743bf21d60',
    });

    expect(source).toBe('nansen');
    expect((result as EntityLabel[])[0]!.labels).toContain('Binance: Hot Wallet');
    expect(paid.calls).toEqual(['entity.labels']);
  });

  it('token.holders answers "not covered on this chain", never a crash', async () => {
    // `token.holders` routes to `['blockscout']` alone, so switching the provider off leaves the
    // capability with no server. The honest answer is a coverage refusal — a PERMANENT verdict the
    // caller must not retry — and emphatically not a `TypeError` from a half-initialised adapter,
    // which is what the module-scope throw produced for every other capability in the same process.
    const registry = new core.CapabilityRegistry(
      [...core.routes],
      new Map<string, ProviderAdapter>([['blockscout', core.createBlockscoutAdapter({ env: {} })]]),
    );

    const error = await registry
      .resolve('token.holders', 'ethereum', {
        chain: 'ethereum',
        tokenAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      })
      .then(() => undefined)
      .catch((caught: unknown) => caught as Error);

    expect(error).toBeInstanceOf(Error);
    expect(error!.name).toBe('CapabilityNotCoveredOnChainError');
    expect(error!.name).not.toBe('TypeError');
  });
});
