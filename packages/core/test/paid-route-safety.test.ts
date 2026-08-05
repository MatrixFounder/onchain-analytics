import { describe, expect, it } from 'vitest';
import { createNansenAdapter } from '../src/adapters/nansen/index.js';
import { createRpcSolanaAdapter } from '../src/adapters/rpc-solana/index.js';
import { createDefillamaAdapter } from '../src/adapters/defillama/index.js';
import { buildChainRegistry } from '../src/chain/registry-core.js';
import { loadChainRegistry } from '../src/chain/registry.js';
import { ChainRegistryLoadError, CapabilityNotCoveredOnChainError } from '../src/chain/errors.js';
import { hasAddressValidator, isValidAddress } from '../src/chain/address.js';
import { truncateVendorText } from '../src/adapters/truncate-vendor-text.js';
import { createThrottle } from '../src/net/rate-limit.js';
import type { ChainInfo } from '../src/chain/registry-core.js';
import type { Wallet } from '../src/types/wallet.js';

/**
 * vdd-multi cycle 6 — the defects the SECOND review pass found, most of them created or left open
 * by the first pass's own fixes. No network anywhere: every adapter gets an injected `fetchImpl`,
 * and the refusal cases never reach a transport at all.
 */
const CHAINS = loadChainRegistry();
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';

function recordingNansen(calls: { url: string; body: unknown }[]) {
  const fetchImpl: typeof fetch = async (url, init) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body ?? '{}')) });
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  };
  return createNansenAdapter({
    env: { NANSEN_API_KEY: 'not-a-real-key' },
    fetchImpl,
    throttle: createThrottle(),
    __ungatedForTestsOnly: true,
  });
}

describe('C-1 — a PAID capability is never served on a family with no address validator', () => {
  /** Chains Nansen's spec covers that our registry files under a validator-less family. */
  const VALIDATOR_LESS = ['tron', 'ton', 'near', 'sui', 'starknet', 'sei', 'bitcoin'];

  it('the premise still holds in the shipped data (otherwise the tests below are vacuous)', () => {
    for (const slug of VALIDATOR_LESS) {
      const chain = CHAINS.resolve(slug);
      expect(chain.vendors['nansen'], slug).not.toBeNull(); // the vendor DOES cover it
      expect(hasAddressValidator(chain.family), slug).toBe(false); // we cannot check its addresses
    }
  });

  it('accepts ANY string as an address on those chains — which is why they are refused', () => {
    // This is the mechanism, asserted directly: `isValidAddress` is the tool boundary's only
    // address check, and for these families it is a length check and nothing more.
    for (const slug of VALIDATOR_LESS) {
      expect(isValidAddress(slug, 'this-is-not-an-address'), slug).toBe(true);
    }
  });

  it.each(VALIDATOR_LESS)(
    '%s: a paid call is refused before any request is built',
    async (slug) => {
      const calls: { url: string; body: unknown }[] = [];
      const adapter = recordingNansen(calls);

      // Every capability the spec covers for this chain, refused for the same reason.
      for (const capability of ['token.risk', 'entity.labels', 'smart-money.flows']) {
        await expect(
          adapter.fetch(capability, { chain: slug, tokenAddress: 'aaaa' }),
        ).rejects.toBeInstanceOf(CapabilityNotCoveredOnChainError);
      }
      // Not one HTTP call, therefore not one credit — the refusal is above the budget gate.
      expect(calls).toHaveLength(0);
    },
  );

  it('the coverage matrix advertises the same narrowed set the transport enforces', () => {
    const adapter = createNansenAdapter({ env: {} });
    for (const slug of VALIDATOR_LESS) {
      for (const capability of ['token.risk', 'entity.labels', 'smart-money.flows']) {
        expect(
          adapter.chainSupport!(CHAINS.resolve(slug), capability),
          `${slug}/${capability}`,
        ).toBe(false);
      }
    }
  });

  it('chains that DO have a validator are untouched', () => {
    const adapter = createNansenAdapter({ env: {} });
    for (const slug of ['ethereum', 'solana', 'bsc', 'arbitrum']) {
      expect(adapter.chainSupport!(CHAINS.resolve(slug), 'token.risk'), slug).toBe(true);
    }
  });
});

describe('H-1 — rpc-solana serves the requested chain, not the one in its module scope', () => {
  const balance = (): Response =>
    new Response(
      JSON.stringify({ jsonrpc: '2.0', id: 1, result: { context: { slot: 1 }, value: 42 } }),
      { status: 200 },
    );

  it('queries only hosts curated for THAT chain', async () => {
    const called: string[] = [];
    const adapter = createRpcSolanaAdapter({
      fetchImpl: async (url) => {
        called.push(String(url));
        return balance();
      },
    });
    await adapter.fetch('wallet.balances.native', {
      chain: 'solana',
      address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    });
    expect(called).toEqual(CHAINS.resolve('solana').rpcHosts);
  });

  it('labels the balance from the registry, not from a literal', async () => {
    const adapter = createRpcSolanaAdapter({ fetchImpl: async () => balance() });
    const raw = await adapter.fetch('wallet.balances.native', {
      chain: 'solana',
      address: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    });
    const wallet = adapter.normalize('wallet.balances.native', raw) as Wallet;
    expect(wallet.balances[0]!.symbol).toBe(CHAINS.resolve('solana').nativeSymbol);
    expect(wallet.balances[0]!.decimals).toBe(CHAINS.resolve('solana').nativeDecimals);
  });

  it('refuses an svm chain whose gas token the registry does not know', () => {
    // The condition `chainSupport` and the transport now share: without a symbol and decimals
    // there is no honest way to label the integer `getBalance` returns.
    const adapter = createRpcSolanaAdapter();
    const unlabelled: ChainInfo = {
      ...CHAINS.resolve('solana'),
      caip2: 'solana:other',
      slug: 'some-svm-chain',
      nativeSymbol: null,
      nativeDecimals: null,
    };
    expect(adapter.chainSupport!(unlabelled, 'wallet.balances.native')).toBe(false);
  });
});

describe('security M-1 — the SSRF allowlist column is shape-checked at LOAD', () => {
  const row = (rpcHosts: string[]): unknown => ({
    syncedAt: 1,
    chains: [
      {
        caip2: 'eip155:1',
        slug: 'eth',
        name: 'Eth',
        family: 'evm',
        aliases: [],
        nativeSymbol: 'ETH',
        nativeDecimals: 18,
        vendors: {},
        rpcHosts,
        tvlUsdAtSync: null,
        deprecated: false,
      },
    ],
  });

  it.each([
    ['userinfo hides the real host', 'https://rpc.legit.org@evil.example'],
    ['loopback IP literal', 'https://127.0.0.1:8545'],
    ['IPv6 literal', 'https://[::1]:8545'],
    ['no scheme (unusable as an endpoint, still an allowlist entry)', 'evil.example'],
    ['plain http', 'http://rpc.example.com'],
  ])('rejects %s', (_label, url) => {
    expect(() => buildChainRegistry(row([url]))).toThrow(ChainRegistryLoadError);
  });

  it('accepts an ordinary https host', () => {
    expect(() => buildChainRegistry(row(['https://ethereum-rpc.publicnode.com']))).not.toThrow();
  });

  it('the shipped snapshot satisfies it (the gate is not vacuous)', () => {
    for (const chain of CHAINS.list()) {
      for (const host of chain.rpcHosts ?? []) {
        expect(new URL(host).protocol, chain.slug).toBe('https:');
      }
    }
  });

  /**
   * Adversarial cycle 1 (security), closed in cycle 3 — the key-in-path endpoint.
   *
   * `net/safe-fetch.ts` publishes `origin + pathname` in its timeout/deadline errors: the query is
   * stripped (that is how blockscout authenticates), the path is kept as the only diagnostic, and
   * `rpc-evm` rethrows those errors untouched — its own `hostOf()` narrowing covers only the errors
   * it MAKES. The redactor's justification was "the path is ours, never a secret", which is exactly
   * false for the Alchemy/Infura convention, where the key IS a path segment. This column is where
   * such a URL would enter, so this is where it is refused.
   */
  it.each([
    [
      'an Alchemy-shaped key segment',
      'https://eth-mainnet.g.alchemy.com/v2/RtGh7yQ2kLpZx9WvB3nMeUa1',
    ],
    [
      'an Infura-shaped project id',
      'https://mainnet.infura.io/v3/0123456789abcdef0123456789abcdef',
    ],
    ['a key as the only segment', 'https://rpc.example.com/aaaaaaaaaaaaaaaaaaaaaaaa'],
  ])('rejects %s', (_label, url) => {
    expect(() => buildChainRegistry(row([url]))).toThrow(ChainRegistryLoadError);
  });

  it('still accepts the short routes real endpoints use — the rule is not "no path"', () => {
    // Over-rejecting would push a curator to drop the path and dial the wrong endpoint, so the
    // admitted side is asserted as explicitly as the refused one.
    expect(() =>
      buildChainRegistry(
        row(['https://rpc.example.com/eth', 'https://rpc.example.com/v1/mainnet']),
      ),
    ).not.toThrow();
  });

  it('the shipped snapshot carries no credential-shaped segment either', () => {
    // The gate protects future edits; this says the rule and today's data agree, so the case above
    // is not describing a repo that would fail its own check.
    for (const chain of CHAINS.list()) {
      for (const host of chain.rpcHosts ?? []) {
        const longest = Math.max(...new URL(host).pathname.split('/').map((s) => s.length));
        expect(longest, `${chain.slug} ${host}`).toBeLessThan(20);
      }
    }
  });
});

describe('M-6 — a refusal never denies a capability it did not check', () => {
  it('the exhaustive tier says so, instead of claiming the chain has nothing', async () => {
    // `chainSupport` cannot see `args.exhaustive`, so the narrower tier can only be enforced in
    // the transport — which knows nothing about the OTHER adapters' capabilities. Passing `[]`
    // for "I did not compute this" rendered as a flat denial that was simply false.
    const adapter = recordingNansen([]);
    // `injective` is served by the DEFAULT tier and not by the exhaustive one — asserted here so
    // the refusal below is genuinely about the tier and not about the chain.
    expect(
      createNansenAdapter({ env: {} }).chainSupport!(CHAINS.resolve('injective'), 'entity.labels'),
    ).toBe(true);

    const thrown = await adapter
      .fetch('entity.labels', { chain: 'injective', tokenAddress: USDC, exhaustive: true })
      .then(
        () => null,
        (error: unknown) => error as Error,
      );

    expect(thrown).toBeInstanceOf(CapabilityNotCoveredOnChainError);
    expect(thrown!.message).toContain('exhaustive');
    expect(thrown!.message).not.toContain('No capability is available');
  });
});

describe('M-1 — chain.tvl reports the age of the DATA, not of the normalize call', () => {
  it('a second chain served from the shared catalog inherits the catalog’s timestamp', async () => {
    let clock = 1_000_000;
    const catalog = [
      { name: 'Ethereum', tvl: 100 },
      { name: 'Arbitrum', tvl: 50 },
    ];
    const adapter = createDefillamaAdapter({
      chains: CHAINS,
      now: () => clock,
      fetchImpl: async () => new Response(JSON.stringify(catalog), { status: 200 }),
    });

    const first = await adapter.fetch('chain.tvl', { chain: 'ethereum' });
    const fetchedAt = (first as { fetchedAt: number }).fetchedAt;

    // 299 s later: inside the catalog memo's window, so no new download — and the result must
    // carry the ORIGINAL timestamp, or the engine cache stacks its own 300 s TTL on top of an
    // already-stale value while reporting it as fresh.
    clock += 299_000;
    const second = await adapter.fetch('chain.tvl', { chain: 'arbitrum' });
    expect((second as { fetchedAt: number }).fetchedAt).toBe(fetchedAt);

    const result = adapter.normalize('chain.tvl', second) as { fetchedAt: number };
    expect(result.fetchedAt).toBe(fetchedAt);
    expect(result.fetchedAt).not.toBe(clock);
  });
});

describe('L — truncation cuts on a code point, never through a surrogate pair', () => {
  it('never emits a lone surrogate', () => {
    // The cut offset is attacker-chosen: a token whose emoji straddles the bound is one line to
    // deploy on a permissionless DEX. A lone surrogate then travels into the JSON-RPC frame and
    // into a SQLite TEXT bind, where it is silently mangled.
    //
    // CHANGED EXPECTATION (vdd-multi TASK-008, H-6): this used to assert the emoji SURVIVES at
    // `'a'.repeat(63) + '😀'` — 65 UTF-16 units under a 64-unit cap. That encoded the defect
    // rather than guarding against it: the caps this helper claims to keep unreachable are zod
    // `.max()` bounds, and zod measures `input.length`, i.e. code units. The emoji does not fit,
    // so it is dropped; only whole code points are ever emitted, which is the property this test
    // is actually for.
    const value = `${'a'.repeat(63)}😀tail`;
    const cut = truncateVendorText(value, 64);
    expect(cut).toBe('a'.repeat(63));
    expect([...cut].every((ch) => ch.codePointAt(0)! < 0xd800 || ch.codePointAt(0)! > 0xdfff)).toBe(
      true,
    );
  });

  it('respects the bound in UTF-16 code units, the unit the schema caps count', () => {
    // The regression H-6 names: 300 astral characters are 600 code units; a code-point-counting
    // truncation returns 512 of them and `Schema.parse` then throws — on `token.holders` that is a
    // hard capability failure plus a negative-cache entry (the route is blockscout-only), and on
    // `entity.labels` it is an escalation to PAID Nansen. The party choosing the label chooses the
    // outcome, and Blockscout ingests user-submitted tags.
    const astral = truncateVendorText('😀'.repeat(300), 256);
    expect(astral.length).toBeLessThanOrEqual(256);
    expect(astral).toBe('😀'.repeat(128));
    // Mixed input must not overshoot either, whatever the boundary lands on.
    for (const value of [`${'a'.repeat(255)}😀`, `😀${'b'.repeat(300)}`, '😀'.repeat(129)]) {
      expect(truncateVendorText(value, 256).length).toBeLessThanOrEqual(256);
    }
  });

  it('is O(maxLength), not O(input) — a 1 MB vendor name costs 256 characters of work', () => {
    // `readString` in the sanitizer bounds nothing but "non-empty string", so the input size is the
    // vendor's choice. The old `Array.from(value)` materialized the whole string first: a 1 MB name
    // became a 1M-element array to yield 256 characters. Asserted as a time bound because the
    // allocation itself is not observable from here — a linear implementation takes ~100× longer.
    const huge = 'x'.repeat(1_000_000);
    const started = performance.now();
    expect(truncateVendorText(huge, 256)).toBe('x'.repeat(256));
    expect(performance.now() - started).toBeLessThan(50);
  });

  it('leaves a short string untouched', () => {
    expect(truncateVendorText('USDC', 64)).toBe('USDC');
  });
});
