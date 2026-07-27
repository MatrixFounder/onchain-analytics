import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { createDefillamaAdapter, loadChainRegistry } from '../src/index.js';
import { DEFILLAMA_DEX_CHAINS } from '../src/adapters/defillama/dex-chains.js';
import { CapabilityRegistry } from '../src/adapters/registry.js';
import { CapabilityNotCoveredOnChainError } from '../src/chain/errors.js';
import type { ProviderAdapter } from '../src/adapters/types.js';

/**
 * TASK-007 task 007-2 (R-63) — coverage for `dex.volume.history` comes from the VENDOR's own DEX
 * chain list, not from `vendors.defillama`.
 *
 * The whole point of this file is one asymmetry: `vendors.defillama` is non-null for all 458
 * registry rows because it was populated from the vendor's TVL catalog, while the DEX-volume
 * dataset covers 287 vendor chains (274 of ours). Reusing the TVL predicate would advertise the
 * capability on 184 chains that have no such data — TASK-006's H-1 defect class, verbatim.
 */

const CHAINS = loadChainRegistry();
const adapter = createDefillamaAdapter();

/** Every expectation below is DERIVED from the two live sources, never a literal like 274. A
 * literal breaks on the next registry sync for a reason unrelated to any defect, and the cheapest
 * "fix" is to edit the number — at which point the test stops checking anything. */
const dexNames = new Set(DEFILLAMA_DEX_CHAINS);
const coveredChains = CHAINS.list().filter((chain) => {
  const vendorName = chain.vendors['defillama'];
  return vendorName != null && dexNames.has(vendorName);
});
const tvlOnlyChains = CHAINS.list().filter((chain) => {
  const vendorName = chain.vendors['defillama'];
  return vendorName != null && !dexNames.has(vendorName);
});

describe('defillama dex.volume.history coverage (task 007-2, R-63)', () => {
  it('covers a chain the vendor lists for DEX volume', () => {
    expect(adapter.chainSupport?.(CHAINS.resolve('ethereum'), 'dex.volume.history')).toBe(true);
  });

  it('gives ONE chain two different answers: covered for chain.tvl, uncovered for dex volume', () => {
    const [uncovered] = tvlOnlyChains;
    expect(uncovered, 'the registry must contain at least one TVL-only chain').toBeDefined();
    expect(adapter.chainSupport?.(uncovered!, 'chain.tvl')).toBe(true);
    expect(adapter.chainSupport?.(uncovered!, 'dex.volume.history')).toBe(false);
  });

  it('covers strictly FEWER chains than the TVL capabilities does', () => {
    // The load-bearing assertion of this task, and deliberately a RELATION rather than a number:
    // it survives a registry sync and vendor drift, whereas `toBe(274)` would not. Anyone
    // restoring the naive `vendors.defillama != null` predicate makes these two counts equal.
    const tvlCovered = CHAINS.list().filter((c) => adapter.chainSupport?.(c, 'chain.tvl')).length;
    const dexCovered = CHAINS.list().filter((c) =>
      adapter.chainSupport?.(c, 'dex.volume.history'),
    ).length;
    expect(dexCovered).toBeGreaterThan(0);
    expect(dexCovered).toBeLessThan(tvlCovered);
    expect(dexCovered).toBe(coveredChains.length);
  });

  it('names the vendor chains our registry cannot map, rather than hiding them', () => {
    const known = new Set(
      CHAINS.list({ includeDeprecated: true })
        .map((chain) => chain.vendors['defillama'])
        .filter((name): name is string => name != null),
    );
    const unmapped = DEFILLAMA_DEX_CHAINS.filter((name) => !known.has(name));
    // Not an assertion on the COUNT (that would break on the next registry sync) but on the
    // invariant that matters. (`for (name of unmapped) expect(dexNames.has(name))` used to stand
    // here and was a TAUTOLOGY — `unmapped` is filtered FROM `dexNames`. Removed in cycle 3, T-3.)
    //
    // What this line actually proves, and why it is worth a comment: every vendor chain is either
    // covered or unmapped, never both and never neither. That in turn means no two covered chains
    // share a `vendors.defillama` value — a duplicate would make the two sets overlap and the sum
    // exceed the total. When it breaks, the message is inscrutable, so: read this note first.
    expect(coveredChains.length + unmapped.length).toBe(DEFILLAMA_DEX_CHAINS.length);
    for (const name of unmapped) expect(known.has(name)).toBe(false);
  });
});

/**
 * Backlog item 6, discharged 2026-07-28 — the recorded 274-chain echo probe.
 *
 * `normalizeDexVolume` refuses a document whose `chain` field differs from the `vendors.defillama`
 * name we sent, and until this probe that assumption rested on TWO chains. The risk was concrete:
 * the vendor's list carries near-duplicate display names (`Plume`/`Plume Mainnet`,
 * `SX Network`/`SX Rollup`, `DefiChain`/`DeFiChain EVM`, `Doge`/`Dogechain`), and if the DEX
 * endpoint canonicalised either half onto the other, that chain would be permanently broken —
 * refused by `normalize()`, reported as `CapabilityUnavailableError` (documented meaning: "retry"),
 * with an agent varying `days` bypassing the negative cache entirely. I.e. a silent infinite retry.
 *
 * These tests read the COMMITTED evidence rather than the network, so they keep the offline gate
 * while making the probe's result a standing invariant instead of a one-off run.
 */
describe('the vendor chain echo, verified live for every covered chain (backlog item 6)', () => {
  const probe = JSON.parse(
    readFileSync(
      '../../docs/onchain-analytics/raw/defillama-dex-echo-probe-2026-07-28.json',
      'utf8',
    ),
  ) as {
    chainsProbed: number;
    mismatchCount: number;
    mismatches: unknown[];
    results: {
      slug: string;
      requested: string;
      echo: string;
      match: boolean;
      httpStatus: number;
    }[];
  };

  it('found zero mismatches across every chain the predicate admits', () => {
    expect(probe.mismatchCount).toBe(0);
    expect(probe.mismatches).toEqual([]);
    expect(probe.results.every((r) => r.httpStatus === 200)).toBe(true);
  });

  it('covered EXACTLY the chains the predicate admits today — no more, no fewer', () => {
    // If the registry or the vendor list changes, this fails and the probe has to be re-run. That
    // is the point: evidence that silently stops describing the current coverage is not evidence.
    const probed = new Set(probe.results.map((r) => r.slug));
    const covered = new Set(coveredChains.map((c) => c.slug));
    expect(probed).toEqual(covered);
    expect(probe.chainsProbed).toBe(covered.size);
  });

  it('resolves each near-duplicate display name to its OWN chain', () => {
    // The specific failure the probe was run to exclude.
    for (const pair of [
      ['Plume', 'Plume Mainnet'],
      ['SX Network', 'SX Rollup'],
      ['DefiChain', 'DeFiChain EVM'],
      ['Doge', 'Dogechain'],
    ]) {
      const rows = pair.map((name) => probe.results.find((r) => r.requested === name));
      for (const [i, row] of rows.entries()) {
        expect(row, `${pair[i]} must have been probed`).toBeDefined();
        expect(row!.echo).toBe(pair[i]);
      }
      expect(rows[0]!.slug).not.toBe(rows[1]!.slug);
    }
  });
});

describe('the coverage gate runs BEFORE the network (task 007-2, AC-6)', () => {
  function registryWithCountingFetch(): { registry: CapabilityRegistry; calls: () => number } {
    let calls = 0;
    const fetchImpl: typeof fetch = async (url) => {
      calls += 1;
      return new Response(JSON.stringify({ url: String(url) }), { status: 200 });
    };
    const adapters = new Map<string, ProviderAdapter>([
      ['defillama', createDefillamaAdapter({ fetchImpl })],
    ]);
    return {
      registry: new CapabilityRegistry(
        [{ capability: 'dex.volume.history', adapterIds: ['defillama'] }],
        adapters,
      ),
      calls: () => calls,
    };
  }

  it('refuses an uncovered chain with CapabilityNotCoveredOnChainError and zero fetches', async () => {
    const [uncovered] = tvlOnlyChains;
    expect(uncovered).toBeDefined();
    const { registry, calls } = registryWithCountingFetch();

    await expect(
      registry.resolve('dex.volume.history', uncovered!.slug, { chain: uncovered!.slug }),
    ).rejects.toThrow(CapabilityNotCoveredOnChainError);

    // The assertion that gives the test its value: a refusal that still paid for a round trip is
    // not a gate. On a keyless route the cost is only latency — but this is the same code path a
    // credit-metered route would take, and the ordering is what makes it safe there.
    expect(calls()).toBe(0);
  });

  it('lets a covered chain through the gate and out to the network', async () => {
    const { registry, calls } = registryWithCountingFetch();
    // CHANGED EXPECTATION (task 007-4): the transport exists now, so a covered chain reaches the
    // network. The counting `fetchImpl` returns a stub body rather than a real document, so
    // `normalize()` refuses it — the assertion that matters is WHICH refusal, and that a request
    // was actually made. Compare with the case above: identical call shape, zero requests.
    await expect(
      registry.resolve('dex.volume.history', 'ethereum', { chain: 'ethereum' }),
    ).rejects.not.toThrow(CapabilityNotCoveredOnChainError);
    expect(calls()).toBe(1);
  });
});
