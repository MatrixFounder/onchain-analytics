import { describe, expect, it } from 'vitest';
import {
  CapabilityRegistry,
  createBlockscoutAdapter,
  loadChainRegistry,
  routes,
  type ProviderAdapter,
} from '../src/index.js';
import { BLOCKSCOUT_CHAIN_IDS } from '../src/adapters/blockscout/chains.js';

/**
 * TASK-008 task 008-2 (R-73/R-74/R-75) — Stub-First phase 1.
 *
 * Everything asserted here holds while `fetch()`/`normalize()` are still stubs, which is the point:
 * routing, coverage and cost are decided by configuration, and configuration mistakes are exactly
 * the class this project has been bitten by (a capability advertised on 458 chains and served on
 * 274; a capability advertised everywhere and served nowhere). None of it needs a transport, so
 * none of it should wait for one.
 */
// L-6: an explicit env, never the ambient one. `createBlockscoutAdapter()` reads `process.env` by
// default, so a developer with a real key in their shell and CI without one would exercise DIFFERENT
// availability branches from the same file — the verdict has depended on the key since L-6.
const adapter = createBlockscoutAdapter({ env: { BLOCKSCOUT_PRO_API_KEY: 'proapi_test_value' } });
const registryChains = loadChainRegistry();
const allChains = registryChains.list();

const bySlug = (slug: string) => {
  // `resolve()`, not `get()` — the latter is keyed on caip2, not on a slug.
  const found = registryChains.tryResolve(slug);
  if (!found) throw new Error(`fixture chain missing from the registry: ${slug}`);
  return found;
};

describe('blockscout adapter (contract, R-73)', () => {
  it('declares its four capabilities and charges nothing for them', () => {
    // WI-51 added the last two, and both are projections of ONE `/api/v2/stats` document — listed
    // separately because the registry caches per capability and their clocks differ by 20×
    // (30 s vs 600 s, see the manifest: gas re-stamps every minute, the daily aggregate does not).
    expect(adapter.capabilities()).toEqual([
      { id: 'token.holders' },
      { id: 'entity.labels' },
      { id: 'gas.price' },
      { id: 'chain.transactions' },
    ]);
    for (const cap of ['token.holders', 'entity.labels', 'gas.price', 'chain.transactions']) {
      // `tier: 'free'` means no money at the vendor, never "unmetered" — the PRO key meters
      // credits (ADR-002 D8, and `assertMergeParticipantsAreFree`'s own note).
      expect(adapter.costOf(cap, {}), cap).toEqual({ credits: 0 });
    }
  });

  it('declines BY NAME without a key — the grace period ended, and an advertisement is not a capability', () => {
    // The inversion of what this test asserted until 2026-08-11, and the inversion is the point.
    //
    // It used to read "is available without any key — the grace period is a working state", on a
    // measurement that was true when taken (2026-07-28: the facade answered 200 keyless). L-6: the
    // facade now answers 403 to every `/v1/*` data route without a PRO key. Keeping `{ok: true}`
    // would have kept `onchain_list_chains` advertising `token.holders` on 39 chains that answer on
    // none — the exact "advertised by the matrix, served nowhere" defect this adapter was built to
    // remove, arriving from the vendor's side instead of ours.
    //
    // The reason string is asserted, not just the flag: it reaches the operator through the
    // registry's `tried[]`, and a refusal nobody can act on is the L-2 lesson one layer down.
    const keyless = createBlockscoutAdapter({ env: {} });
    const verdict = keyless.isAvailable?.();
    expect(verdict?.ok).toBe(false);
    expect((verdict as { reason: string }).reason).toContain('BLOCKSCOUT_PRO_API_KEY');
  });

  it('is available once the key is configured', () => {
    const keyed = createBlockscoutAdapter({ env: { BLOCKSCOUT_PRO_API_KEY: 'proapi_test_value' } });
    expect(keyed.isAvailable?.()).toEqual({ ok: true });
  });

  describe('coverage (R-77)', () => {
    it('serves ethereum and refuses a chain the vendor has no explorer for', () => {
      expect(adapter.chainSupport?.(bySlug('ethereum'), 'token.holders')).toBe(true);
      // In the registry, absent from Blockscout's mainnet list.
      expect(adapter.chainSupport?.(bySlug('zcash'), 'token.holders')).toBe(false);
    });

    it('refuses every non-EVM chain, whatever the vendor calls its ecosystem', () => {
      // The over-claim guard. The vendor's `ecosystem` field says "Solana" for Neon and
      // "Bitcoin/BCH" for Rootstock — both EVM chains — so a family answer derived from that field
      // would advertise svm/utxo coverage that does not exist (TASK-006 H-1).
      const nonEvm = allChains.filter((row) => row.family !== 'evm');
      expect(nonEvm.length).toBeGreaterThan(0);
      for (const row of nonEvm) {
        expect(adapter.chainSupport?.(row, 'token.holders'), row.slug).toBe(false);
      }
    });

    it('covers strictly fewer chains than the registry holds, and more than none', () => {
      // A relation, not a count: the vendor list and our registry both move, and a literal here
      // would be "fixed" by editing it on the next sync.
      const covered = allChains.filter((row) => adapter.chainSupport?.(row, 'token.holders'));
      expect(covered.length).toBeGreaterThan(0);
      expect(covered.length).toBeLessThan(allChains.length);
      // Every covered chain must be one the vendor actually lists — coverage cannot exceed the
      // generated evidence, only fall short of it where our registry lacks the row.
      expect(covered.length).toBeLessThanOrEqual(BLOCKSCOUT_CHAIN_IDS.length);
    });

    it('answers identically for both capabilities — coverage here does not vary by capability', () => {
      // Unlike `nansen`, whose composite capabilities reach different chain counts. Stated as a
      // test so that a future capability with narrower reach cannot be added silently.
      for (const row of allChains.slice(0, 100)) {
        expect(adapter.chainSupport?.(row, 'token.holders'), row.slug).toBe(
          adapter.chainSupport?.(row, 'entity.labels'),
        );
      }
    });
  });

  describe('routing (R-74/R-75)', () => {
    const registry = () =>
      new CapabilityRegistry(
        [...routes],
        new Map<string, ProviderAdapter>([['blockscout', adapter]]),
      );

    it('token.holders reaches blockscout instead of the dead dune stub', async () => {
      // The stub throws from fetch(); reaching that throw is the proof the route resolved here.
      await expect(registry().resolve('token.holders', 'ethereum', {})).rejects.toMatchObject({
        tried: [{ adapterId: 'blockscout' }],
      });
    });

    it('token.holders is refused on an uncovered chain BEFORE any transport is attempted', async () => {
      // Coverage is a gate, not a filter applied to a response: on an uncovered chain the call must
      // not reach fetch() at all, which is what keeps a wrong answer from being paid for.
      await expect(registry().resolve('token.holders', 'zcash', {})).rejects.toThrow(
        /token\.holders/,
      );
    });

    it('entity.labels tries blockscout first and nansen only after it', async () => {
      // M-8.4: the assertions used to live inside a bare `.catch()`, which makes them vacuous the
      // moment the promise RESOLVES — i.e. exactly when the adapter starts working. `rejects`
      // makes the rejection itself part of the contract.
      const error = await registry()
        .resolve('entity.labels', 'ethereum', {})
        .then(() => undefined)
        .catch((caught: unknown) => caught as { tried: { adapterId: string }[] });

      expect(
        error,
        'resolve() unexpectedly succeeded — the assertions below would be skipped',
      ).toBeDefined();
      const tried = error!.tried.map((e) => e.adapterId);
      expect(tried[0]).toBe('blockscout');
      expect(tried).toContain('nansen');
    });
  });

  it('refuses an unsupported capability instead of guessing what was meant', async () => {
    // Replaced the Stub-First "not implemented yet" assertion when 008-4 landed the transport. The
    // property worth keeping is the same one: an unknown request fails loudly rather than returning
    // something plausible-looking.
    await expect(adapter.fetch('token.price', { chain: 'ethereum' })).rejects.toThrow(
      /unsupported capability/,
    );
    expect(() => adapter.normalize('token.price', {})).toThrow(/unsupported capability/);
  });

  it('requires its arguments rather than building a URL with "undefined" in it', async () => {
    await expect(adapter.fetch('token.holders', { chain: 'ethereum' })).rejects.toThrow(
      /"tokenAddress" is required/,
    );
    await expect(adapter.fetch('entity.labels', { chain: 'ethereum' })).rejects.toThrow(
      /needs a tokenAddress/,
    );
  });
});

describe('L-4 — the SSRF allowlist is exactly the host this adapter calls', () => {
  it('declares one host, not two', async () => {
    // `api.blockscout.com` sat here after adversarial cycle 1 reverted the two-host design, on the
    // argument that "keeping it allowlisted costs nothing". `safeFetch` re-checks EVERY redirect
    // hop against this list, so an allowlisted host we never call is still a host a misbehaving
    // facade can bounce us to — and for this adapter the allowlist is the only egress control
    // there is. R-73(b) specifies one host, so the extra entry also contradicted an accepted Must.
    const { adapterRegistrations } = await import('../src/providers.config.js');
    const registration = adapterRegistrations.find((entry) => entry.id === 'blockscout');
    expect(registration?.hosts).toEqual(['mcp.blockscout.com']);
  });
});
