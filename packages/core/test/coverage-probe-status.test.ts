import { describe, expect, it } from 'vitest';
import { createCoverage, type CoverageStatus } from '../src/chain/coverage.js';
import { loadChainRegistry } from '../src/chain/registry.js';
import type { ChainInfo } from '../src/chain/registry-core.js';
import type { CapabilityRoute, ProviderAdapter } from '../src/adapters/types.js';

/**
 * Task 014-32a, R-33.5 — three probe outcomes, three distinguishable refusals.
 *
 * **What this file measures, and what it deliberately does not.** It measures the WORDING of a
 * refusal the predicate has already produced. It does not measure coverage: the probe never widens
 * or narrows what is covered, and a case that let it would be testing the defect this task exists
 * to avoid introducing.
 *
 * **Why the third wording exists at all.** `verified` does not imply coverage — the adapter's
 * predicate asks for two conditions where the probe establishes one, and 23 registry rows carry
 * `nativeSymbol: null`. Without a third sentence such a chain would be refused with "no probe was
 * run" about a chain the probe confirmed: a false statement inside text added for honesty.
 */

const CAPABILITY = 'pairs.active';

function chainRow(caip2: string, slug: string, extra: Partial<ChainInfo> = {}): ChainInfo {
  return {
    caip2,
    slug,
    name: slug,
    family: 'evm',
    aliases: [slug],
    nativeSymbol: 'ETH',
    nativeDecimals: 18,
    vendors: {},
    rpcHosts: null,
    tvlUsdAtSync: null,
    deprecated: false,
    ...extra,
  };
}

/** `covered` — the predicate says yes. */
const COVERED = chainRow('eip155:1', 'covered-chain', { vendors: { probe: 'covered-chain' } });
/** The vendor answered and its echo confirmed the identifier, but the predicate still refuses. */
const CONFIRMED = chainRow('eip155:2', 'confirmed-chain', {
  vendors: { probe: 'confirmed-chain' },
  // The second condition the predicate wants, withheld — this is the pair (probe confirmed, not
  // covered) that the third wording exists for, and it is 23 rows of the real registry.
  nativeSymbol: null,
});
/** The vendor refused this chain segment. */
const REFUSED = chainRow('eip155:3', 'refused-chain');
/** No probe covered it. */
const UNPROBED = chainRow('eip155:4', 'unprobed-chain');

const PROBE_STATUS: Record<string, 'verified' | 'excluded' | 'unverified'> = {
  'eip155:1': 'verified',
  'eip155:2': 'verified',
  'eip155:3': 'excluded',
  'eip155:4': 'unverified',
};

/** An adapter that both narrows coverage AND reports a probe — the shape `dexscreener` will have. */
const probingAdapter: ProviderAdapter = {
  id: 'probe',
  capabilities: [CAPABILITY],
  chainSupport: (chain: ChainInfo): boolean =>
    chain.vendors['probe'] != null && chain.nativeSymbol != null,
  chainProbeStatus: (chain: ChainInfo): 'verified' | 'excluded' | 'unverified' =>
    PROBE_STATUS[chain.caip2] ?? 'unverified',
  fetch: async () => {
    throw new Error('not called');
  },
} as unknown as ProviderAdapter;

/** The eleven adapters that declare a predicate and no probe. */
const silentAdapter: ProviderAdapter = {
  id: 'silent',
  capabilities: [CAPABILITY],
  chainSupport: () => false,
  fetch: async () => {
    throw new Error('not called');
  },
} as unknown as ProviderAdapter;

const ROWS = [COVERED, CONFIRMED, REFUSED, UNPROBED];

function coverageOver(adapterIds: string[]) {
  const routes: CapabilityRoute[] = [{ capability: CAPABILITY, adapterIds }];
  const adapters = new Map<string, ProviderAdapter>([
    ['probe', probingAdapter],
    ['silent', silentAdapter],
  ]);
  return createCoverage({
    routes,
    adapters,
    // `{ data: … }`, never `{ chains: … }`: absence of the `data` key means "use the SHIPPED
    // registry", so the wrong spelling silently runs these cases against 458 production rows in
    // which none of the four fixtures exists — every one of them then reads as not covered, for a
    // reason that has nothing to do with the probe.
    chains: loadChainRegistry({ data: { syncedAt: 1_000, chains: ROWS } }),
  });
}

describe('TC-UNIT-08 / R-33.5: three outcomes, three distinguishable statuses', () => {
  const coverage = coverageOver(['probe']);

  it('the predicate decides coverage, and the probe is not asked when it answers yes', () => {
    expect(coverage.isCovered(CAPABILITY, COVERED)).toBe(true);
    expect(coverage.coverageStatus(CAPABILITY, COVERED)).toBe('covered');
  });

  it('a probe-CONFIRMED chain the predicate refuses gets the third status, not “unverified”', () => {
    // The case the wording exists for. Saying "no probe was run" about a chain the probe confirmed
    // would be a false statement inside the sentence added for honesty.
    expect(coverage.isCovered(CAPABILITY, CONFIRMED)).toBe(false);
    expect(coverage.coverageStatus(CAPABILITY, CONFIRMED)).toBe(
      'vendor-serves-chain-capability-absent',
    );
  });

  it('a vendor-refused chain says the vendor does not serve it', () => {
    expect(coverage.coverageStatus(CAPABILITY, REFUSED)).toBe('excluded');
  });

  it('an unprobed chain says nothing more than that', () => {
    expect(coverage.coverageStatus(CAPABILITY, UNPROBED)).toBe('unverified');
  });

  it('the four statuses are pairwise distinct — the criterion is “none coincides with another”', () => {
    const produced: CoverageStatus[] = [COVERED, CONFIRMED, REFUSED, UNPROBED].map((chain) =>
      coverage.coverageStatus(CAPABILITY, chain),
    );
    expect(new Set(produced).size).toBe(produced.length);
  });
});

describe('TC-UNIT-11: an adapter with no probe hook answers `unverified`, never `excluded`', () => {
  it('so eleven adapters do not begin asserting a vendor exclusion they never measured', () => {
    // `rpc-evm` refuses on OUR missing `rpcHosts`; `dune` refuses every chain outright. Reading
    // either as "the vendor does not have this chain" is L-18 with a different vendor's name on it,
    // and R-58d says a false narrowing is as wrong as a false widening.
    const coverage = coverageOver(['silent']);
    for (const chain of ROWS) {
      expect(coverage.isCovered(CAPABILITY, chain), chain.slug).toBe(false);
      expect(coverage.coverageStatus(CAPABILITY, chain), chain.slug).toBe('unverified');
    }
  });

  it('and a probing adapter beside a silent one still speaks for the chains it measured', () => {
    // Route order must not decide the sentence: the strongest statement any candidate can make is
    // the one that survives, because "the vendor does not serve it" is false the moment one
    // adapter has watched the vendor serve it.
    const coverage = coverageOver(['silent', 'probe']);
    expect(coverage.coverageStatus(CAPABILITY, CONFIRMED)).toBe(
      'vendor-serves-chain-capability-absent',
    );
    expect(coverage.coverageStatus(CAPABILITY, REFUSED)).toBe('excluded');
  });
});
