import { describe, expect, it, vi } from 'vitest';
import { CapabilityRegistry, CapabilityUnavailableError } from '../src/adapters/registry.js';
import { createCoverage } from '../src/chain/coverage.js';
import { CapabilityNotCoveredOnChainError } from '../src/chain/errors.js';
import { loadChainRegistry } from '../src/chain/registry.js';
import type { ChainInfo } from '../src/chain/registry-core.js';
import type { CapabilityRoute, ProviderAdapter } from '../src/adapters/types.js';
import {
  createCoingeckoAdapter,
  createDefillamaAdapter,
  createDexscreenerAdapter,
  createNansenAdapter,
  createRpcEvmAdapter,
  createRpcSolanaAdapter,
  routes,
} from '../src/index.js';

/**
 * Task 006-4 — coverage matrix (R-51). The gate's whole reason for existing is that it sits ABOVE
 * the paid path, so the tests below assert on what was NOT called at least as much as on what was.
 */

function chainRow(caip2: string, slug: string, extra: Partial<ChainInfo> = {}): ChainInfo {
  return {
    caip2,
    slug,
    name: slug,
    family: 'evm',
    aliases: [slug],
    nativeSymbol: null,
    vendors: {},
    rpcHosts: null,
    tvlUsdAtSync: null,
    deprecated: false,
    ...extra,
  };
}

const CHAINS = loadChainRegistry({
  data: {
    syncedAt: 1_000,
    chains: [
      chainRow('eip155:1', 'ethereum'),
      chainRow('eip155:80094', 'berachain'),
      chainRow('eip155:8453', 'base'),
    ],
  },
});

/** An adapter that records whether it was ever asked to do real work. */
function spyAdapter(
  id: string,
  opts: { supports?: string[]; available?: boolean } = {},
): ProviderAdapter & { fetchCalls: number } {
  const adapter = {
    id,
    fetchCalls: 0,
    capabilities: () => [],
    costOf: () => ({ credits: 10 }),
    fetch: async (): Promise<unknown> => {
      adapter.fetchCalls += 1;
      return Promise.resolve({ ok: true });
    },
    normalize: (_cap: string, raw: unknown): unknown => raw,
    isAvailable: () =>
      opts.available === false
        ? ({ ok: false, reason: 'NANSEN_API_KEY not set' } as const)
        : ({ ok: true } as const),
    ...(opts.supports
      ? {
          chainSupport: (chain: ChainInfo): boolean => opts.supports!.includes(chain.slug),
        }
      : {}),
  };
  return adapter;
}

const ROUTES: CapabilityRoute[] = [
  { capability: 'smart-money.flows', adapterIds: ['paid'] },
  { capability: 'chain.tvl', adapterIds: ['free'] },
  { capability: 'legacy.thing', adapterIds: ['nopredicate'] },
];

function registryWith(adapters: Map<string, ProviderAdapter>): CapabilityRegistry {
  return new CapabilityRegistry(ROUTES, adapters, undefined, CHAINS);
}

describe('coverage gate — error type and content (R-51b/c)', () => {
  it('throws CapabilityNotCoveredOnChainError, NOT CapabilityUnavailableError', async () => {
    const paid = spyAdapter('paid', { supports: ['ethereum'] });
    const reg = registryWith(new Map([['paid', paid]]));

    await expect(reg.resolve('smart-money.flows', 'berachain', {})).rejects.toBeInstanceOf(
      CapabilityNotCoveredOnChainError,
    );
    await expect(reg.resolve('smart-money.flows', 'berachain', {})).rejects.not.toBeInstanceOf(
      CapabilityUnavailableError,
    );
  });

  it('names both lists, and neither is empty when alternatives exist', async () => {
    const adapters = new Map<string, ProviderAdapter>([
      ['paid', spyAdapter('paid', { supports: ['ethereum'] })],
      ['free', spyAdapter('free', { supports: ['ethereum', 'berachain', 'base'] })],
    ]);
    const reg = registryWith(adapters);

    let error!: CapabilityNotCoveredOnChainError;
    try {
      await reg.resolve('smart-money.flows', 'berachain', {});
      expect.unreachable('resolve must refuse an uncovered pair');
    } catch (thrown) {
      error = thrown as CapabilityNotCoveredOnChainError;
    }

    expect(error.availableChains).toEqual(['ethereum']);
    expect(error.availableCapabilities).toContain('chain.tvl');
    expect(error.message).toContain("not available on chain 'berachain'");
    expect(error.message).toContain('Available on: ethereum');
    expect(error.message).toContain('chain.tvl');
  });

  it('truncates long lists and says how many were withheld', () => {
    const many = Array.from({ length: 25 }, (_, i) => `chain-${i}`);
    const error = new CapabilityNotCoveredOnChainError({
      capability: 'x',
      chain: 'y',
      availableChains: many,
      availableCapabilities: many,
    });
    expect(error.message).toContain('+15 more');
    // An error meant to save a wasted call must not itself flood the model's context.
    expect(error.message.length).toBeLessThan(600);
  });

  it('reads sensibly when the capability exists nowhere', () => {
    const error = new CapabilityNotCoveredOnChainError({
      capability: 'x',
      chain: 'berachain',
      availableChains: [],
      availableCapabilities: [],
    });
    expect(error.message).toContain('not available on any known chain');
    expect(error.message).toContain("No capability is available on 'berachain'");
  });
});

describe('coverage gate — position in the gate order (R-51d)', () => {
  it('refuses BEFORE the adapter is touched, so no credits can be reserved', async () => {
    const paid = spyAdapter('paid', { supports: ['ethereum'] });
    const costOf = vi.spyOn(paid, 'costOf');
    const reg = registryWith(new Map([['paid', paid]]));

    await expect(reg.resolve('smart-money.flows', 'berachain', {})).rejects.toThrow(
      CapabilityNotCoveredOnChainError,
    );

    // The budget gate lives inside the paid adapter's own fetch() (ARCHITECTURE.md §3.2), so
    // "fetch was never entered" is exactly "no credit was ever reserved".
    expect(paid.fetchCalls).toBe(0);
    expect(costOf).not.toHaveBeenCalled();
  });

  it('refuses BEFORE the cache is consulted or written', async () => {
    const cache = {
      get: vi.fn(async () => Promise.resolve(undefined)),
      set: vi.fn(async () => Promise.resolve()),
    };
    const paid = spyAdapter('paid', { supports: ['ethereum'] });
    const reg = new CapabilityRegistry(ROUTES, new Map([['paid', paid]]), cache, CHAINS);

    await expect(reg.resolve('smart-money.flows', 'berachain', {})).rejects.toThrow(
      CapabilityNotCoveredOnChainError,
    );
    expect(cache.get).not.toHaveBeenCalled();
    expect(cache.set).not.toHaveBeenCalled();
  });

  it('makes no network call while refusing', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(() => {
      throw new Error('network call during a coverage refusal');
    });
    try {
      const reg = registryWith(new Map([['paid', spyAdapter('paid', { supports: ['ethereum'] })]]));
      await expect(reg.resolve('smart-money.flows', 'berachain', {})).rejects.toThrow(
        CapabilityNotCoveredOnChainError,
      );
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });
});

describe('coverage gate — what it must NOT change', () => {
  it('a covered chain with an unconfigured provider still yields CapabilityUnavailableError', async () => {
    // "not here" and "could work, fix your config" must stay distinguishable: collapsing them
    // would send an agent retrying where retrying is pointless, and giving up where a key would do.
    const paid = spyAdapter('paid', { supports: ['ethereum'], available: false });
    const reg = registryWith(new Map([['paid', paid]]));

    await expect(reg.resolve('smart-money.flows', 'ethereum', {})).rejects.toBeInstanceOf(
      CapabilityUnavailableError,
    );
  });

  it('an adapter without chainSupport behaves exactly as before (M1 regression)', async () => {
    const legacy = spyAdapter('nopredicate');
    const reg = registryWith(new Map([['nopredicate', legacy]]));

    const resolution = await reg.resolve('legacy.thing', 'berachain', {});
    expect(resolution.cache).toBe('miss');
    expect(legacy.fetchCalls).toBe(1);
  });

  it('an unresolvable chain leaves the gate inert (canonicalization is task 006-6 boundary work)', async () => {
    const legacy = spyAdapter('nopredicate');
    const reg = registryWith(new Map([['nopredicate', legacy]]));

    await expect(reg.resolve('legacy.thing', 'not-a-known-chain', {})).resolves.toMatchObject({
      cache: 'miss',
    });
  });
});

describe('coverage — the two list views agree with the predicate', () => {
  const adapters = new Map<string, ProviderAdapter>([
    ['paid', spyAdapter('paid', { supports: ['ethereum'] })],
    ['free', spyAdapter('free', { supports: ['ethereum', 'berachain'] })],
    ['nopredicate', spyAdapter('nopredicate')],
  ]);
  const coverage = createCoverage({ routes: ROUTES, adapters, chains: CHAINS });

  it('chainsFor(capability) lists exactly the chains isCovered() accepts', () => {
    for (const capability of ['smart-money.flows', 'chain.tvl', 'legacy.thing']) {
      const listed = new Set(coverage.chainsFor(capability).map((c) => c.slug));
      for (const chain of CHAINS.list()) {
        expect(listed.has(chain.slug)).toBe(coverage.isCovered(capability, chain));
      }
    }
  });

  it('capabilitiesFor(chain) lists exactly the capabilities isCovered() accepts', () => {
    for (const chain of CHAINS.list()) {
      const listed = new Set(coverage.capabilitiesFor(chain));
      for (const capability of ['smart-money.flows', 'chain.tvl', 'legacy.thing']) {
        expect(listed.has(capability)).toBe(coverage.isCovered(capability, chain));
      }
    }
  });

  it('an adapter id with no registered adapter covers nothing', () => {
    const orphaned = createCoverage({
      routes: [{ capability: 'ghost', adapterIds: ['missing'] }],
      adapters: new Map(),
      chains: CHAINS,
    });
    expect(orphaned.chainsFor('ghost')).toEqual([]);
    expect(orphaned.isCovered('ghost', CHAINS.resolve('ethereum'))).toBe(false);
  });
});

/**
 * Task 006-5 — the REAL M1/M2 configuration, not a synthetic one. This is where "the chain
 * dimension moved from route literals into adapter predicates" is either true or not.
 */
describe('coverage on the real providers.config (task 006-5)', () => {
  const realChains = loadChainRegistry();
  const realAdapters = new Map<string, ProviderAdapter>([
    ['coingecko', createCoingeckoAdapter()],
    ['dexscreener', createDexscreenerAdapter()],
    ['defillama', createDefillamaAdapter()],
    ['rpc-evm', createRpcEvmAdapter()],
    ['rpc-solana', createRpcSolanaAdapter()],
    ['nansen', createNansenAdapter()],
  ]);
  const real = createCoverage({ routes, adapters: realAdapters, chains: realChains });

  it('keeps wallet.balances.native routed per chain after the route `chains` literals were dropped', () => {
    // The two routes for this capability were distinguishable ONLY by their `chains` literal.
    // With it gone, `chainSupport()` has to do that work — otherwise Solana balances would be
    // answered by the EVM adapter.
    expect(
      realAdapters.get('rpc-evm')!.chainSupport!(
        realChains.resolve('ethereum'),
        'wallet.balances.native',
      ),
    ).toBe(true);
    expect(
      realAdapters.get('rpc-evm')!.chainSupport!(
        realChains.resolve('solana'),
        'wallet.balances.native',
      ),
    ).toBe(false);
    expect(
      realAdapters.get('rpc-solana')!.chainSupport!(
        realChains.resolve('solana'),
        'wallet.balances.native',
      ),
    ).toBe(true);
    expect(
      realAdapters.get('rpc-solana')!.chainSupport!(
        realChains.resolve('ethereum'),
        'wallet.balances.native',
      ),
    ).toBe(false);
  });

  it('no route carries a `chains` literal any more (R-54)', () => {
    expect(routes.filter((r) => r.chains !== undefined)).toEqual([]);
  });

  it('widens free capabilities far beyond the two original chains', () => {
    expect(real.chainsFor('protocol.tvl').length).toBeGreaterThan(100);
    expect(real.chainsFor('token.price').length).toBeGreaterThan(100);
    // and berachain — the chain that started this whole task — is among them
    expect(real.isCovered('protocol.tvl', realChains.resolve('berachain'))).toBe(true);
    expect(real.isCovered('token.price', realChains.resolve('berachain'))).toBe(true);
  });

  it('[R-57, Should] pairs.new reaches at least one chain outside ethereum/solana', () => {
    const covered = real.chainsFor('pairs.new').map((c) => c.slug);
    expect(covered).toContain('ethereum');
    expect(covered).toContain('solana');
    expect(covered.some((slug) => slug !== 'ethereum' && slug !== 'solana')).toBe(true);
  });

  it('widens the paid capabilities per capability, by INTERSECTION of sub-calls (task 006-9)', () => {
    const flows = real.chainsFor('smart-money.flows').map((c) => c.slug);
    const risk = real.chainsFor('token.risk').map((c) => c.slug);

    // Both grew past the M2 pair, but NOT to the same set: `smart-money.flows` issues two
    // sub-calls and is covered only where both are, so it is strictly narrower than `token.risk`.
    expect(flows.length).toBeGreaterThan(2);
    expect(risk.length).toBeGreaterThan(flows.length);
    for (const slug of flows) expect(risk, slug).toContain(slug);

    // The chains in the difference are precisely the ones that would half-succeed after credits
    // were spent: covered for `token.risk`, NOT for `smart-money.flows`.
    //
    // **7 here, not the 8 the plan quotes** — and the gap is instructive rather than a discrepancy.
    // 8 is the difference in NANSEN'S OWN chain tokens (`hyperliquid`, `injective`, `mantra`,
    // `near`, `starknet`, `sui`, `ton`, `tron`); `hyperevm` and `hyperliquid` are two vendor tokens
    // for ONE chain of ours, and that chain IS covered for flows via `hyperevm`. Counting in vendor
    // tokens overstates our exposure by one.
    const halfSucceeding = risk.filter((slug) => !flows.includes(slug));
    expect(halfSucceeding.sort()).toEqual([
      'injective',
      'mantra',
      'near',
      'starknet',
      'sui',
      'ton',
      'tron',
    ]);
    for (const slug of halfSucceeding) {
      expect(real.isCovered('smart-money.flows', realChains.resolve(slug)), slug).toBe(false);
      expect(real.isCovered('token.risk', realChains.resolve(slug)), slug).toBe(true);
    }

    // and berachain remains uncovered by the paid provider — it is simply not in Nansen's spec
    expect(real.isCovered('smart-money.flows', realChains.resolve('berachain'))).toBe(false);
  });

  it('wallet.balances.native follows curated rpcHosts, staying far narrower than chain.tvl', () => {
    // Honest asymmetry, now visible in numbers: chain.tvl on hundreds of chains, native balances
    // only where a human approved an RPC host (security.md §7.2.1). Asserted as a RELATION rather
    // than a fixed list, so curating one more chain later is not a test failure.
    const balances = real.chainsFor('wallet.balances.native').map((c) => c.slug);
    const tvl = real.chainsFor('chain.tvl');
    expect(balances).toContain('ethereum');
    expect(balances).toContain('solana');
    expect(balances.length).toBeGreaterThan(2);
    expect(balances.length).toBeLessThan(tvl.length / 10);
  });
});
