import { describe, expect, it, vi } from 'vitest';
import { createRpcEvmAdapter } from '../src/adapters/rpc-evm/index.js';
import { createCoingeckoAdapter } from '../src/adapters/coingecko/index.js';
import { createDexscreenerAdapter, type PoolPage } from '../src/adapters/dexscreener/index.js';
import { createDefillamaAdapter } from '../src/adapters/defillama/index.js';
import { createDuneAdapter } from '../src/adapters/dune/index.js';
import { loadChainRegistry } from '../src/chain/registry.js';
import type { Token } from '../src/types/token.js';
import type { Wallet } from '../src/types/wallet.js';

/**
 * vdd-multi cycle 5 — adapter-level defects that only became reachable once TASK-006 widened the
 * chain set. No network: every adapter is constructed with an injected `fetchImpl`.
 */
const CHAINS = loadChainRegistry();
const VITALIK = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045';

describe('M-1 — nativeSymbol is the GAS token, not the chain’s listed token', () => {
  // DeFiLlama's `tokenSymbol` is the chain's listed/governance asset. Taking it first labelled
  // every L2 with its governance token while it actually charges gas in ETH.
  it.each([
    ['arbitrum', 'ETH'],
    ['op-mainnet', 'ETH'],
    ['blast', 'ETH'],
    ['gnosis', 'XDAI'],
    ['bsc', 'BNB'],
    ['solana', 'SOL'],
  ])('%s pays gas in %s', (slug, symbol) => {
    expect(CHAINS.resolve(slug).nativeSymbol).toBe(symbol);
  });

  it('does not inherit identity from a TESTNET row of the EIP-155 catalog', () => {
    // chainId 999 is Hyperliquid for us and "Wanchain Testnet" in chainid.network. The generator
    // used to take that row's gas symbol (`WAN`) and its `shortName` as an alias (`twan`) — and
    // its RPC endpoint was the wrong-chain host rejected by hand during the 006-8 curation.
    const hyperliquid = CHAINS.resolve('hyperliquid-l1');
    expect(hyperliquid.nativeSymbol).toBe('HYPE');
    expect(hyperliquid.aliases).not.toContain('twan');
    expect(CHAINS.resolve('mantra').aliases).not.toContain('dukong');
  });

  it('every chain with a curated RPC host knows both its symbol and its decimals', () => {
    // This is what `rpc-evm.chainSupport()` requires, asserted against the shipped data so a
    // future curation cannot quietly add a chain the adapter would then mislabel.
    for (const chain of CHAINS.list()) {
      if (chain.rpcHosts === null || chain.family !== 'evm') continue;
      expect(chain.nativeSymbol, chain.slug).not.toBeNull();
      expect(chain.nativeDecimals, chain.slug).not.toBeNull();
    }
  });
});

describe('H-3 — rpc-evm labels the balance with THIS chain’s gas token', () => {
  const balanceResponse = (): Response =>
    new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x5c08c944ce900737' }), {
      status: 200,
    });

  it.each([
    ['ethereum', 'ETH'],
    ['bsc', 'BNB'],
    ['polygon', 'POL'],
    ['gnosis', 'XDAI'],
  ])('%s → %s', async (slug, symbol) => {
    // Before the fix `symbol: 'ETH', decimals: 18` were literals, so a BNB balance came back
    // labelled ETH — and a downstream agent multiplies it by the price of ETH.
    const adapter = createRpcEvmAdapter({ fetchImpl: async () => balanceResponse() });
    const raw = await adapter.fetch('wallet.balances.native', { chain: slug, address: VITALIK });
    const wallet = adapter.normalize('wallet.balances.native', raw) as Wallet;

    expect(wallet.chain).toBe(slug);
    expect(wallet.balances[0]!.symbol).toBe(symbol);
    expect(wallet.balances[0]!.decimals).toBe(CHAINS.resolve(slug).nativeDecimals);
  });

  it('the amount is still an exact decimal string, never a JS number', () => {
    const adapter = createRpcEvmAdapter({ fetchImpl: async () => balanceResponse() });
    const wallet = adapter.normalize('wallet.balances.native', {
      chain: 'bsc',
      address: VITALIK,
      nativeSymbol: 'BNB',
      nativeDecimals: 18,
      raw: { jsonrpc: '2.0', id: 1, result: '0xde0b6b3a7640000' },
    }) as Wallet;
    expect(wallet.balances[0]!.amountRaw).toBe('1000000000000000000');
  });
});

describe('M-3 — rpc-evm never falls back to another chain’s endpoints', () => {
  it('queries only hosts curated for the requested chain', async () => {
    const called: string[] = [];
    const adapter = createRpcEvmAdapter({
      fetchImpl: async (url) => {
        called.push(String(url));
        return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x1' }), {
          status: 200,
        });
      },
    });

    await adapter.fetch('wallet.balances.native', { chain: 'bsc', address: VITALIK });

    const approved = CHAINS.resolve('bsc').rpcHosts!;
    expect(called.length).toBeGreaterThan(0);
    for (const url of called) {
      expect(approved).toContain(url);
    }
    // The concrete symptom: ethereum's endpoints must not appear on a bsc request.
    for (const url of called) {
      expect(url).not.toContain('ethereum-rpc.publicnode.com');
    }
  });
});

describe('M-4 — coingecko encodes both path segments', () => {
  it('a traversal-shaped address cannot rewrite the request path', async () => {
    let requested = '';
    const adapter = createCoingeckoAdapter({
      env: {},
      chains: CHAINS,
      fetchImpl: async (url) => {
        requested = String(url);
        return new Response(JSON.stringify({}), { status: 200 });
      },
    });

    // `bitcoin` is `family: other` — no address validator, so `normalizeAddress` returns the input
    // verbatim and this string reaches the URL template unchanged.
    await adapter
      .fetch('token.price', { chain: 'bitcoin', address: '../../../simple/price?ids=x' })
      .catch(() => undefined);

    expect(requested).toContain('/contract/');
    expect(requested).not.toContain('/simple/price');
    expect(requested).toContain('%2F'); // the slashes are encoded, not structural
  });
});

describe('M-6 — vendor-authored text is truncated, not rejected', () => {
  it('coingecko: a 5000-character token name degrades instead of failing the call', () => {
    const adapter = createCoingeckoAdapter({ env: {}, chains: CHAINS });
    const token = adapter.normalize('token.price', {
      chain: CHAINS.resolve('ethereum'),
      raw: {
        symbol: 'x'.repeat(500),
        name: 'y'.repeat(5000),
        detail_platforms: { ethereum: { contract_address: VITALIK } },
      },
    }) as Token;

    // Truncation, not a throw: a parse throw would discard a response already in hand and make
    // that token permanently unreadable.
    expect(token.name.length).toBe(256);
    expect(token.symbol.length).toBe(64);
  });

  it('dexscreener: an adversarial pair symbol is bounded too', () => {
    const adapter = createDexscreenerAdapter({ chains: CHAINS });
    const pools = adapter.normalize('pairs.active', {
      chain: CHAINS.resolve('ethereum'),
      limit: 5,
      raw: {
        pairs: [
          {
            chainId: 'ethereum',
            dexId: 'uniswap',
            pairAddress: '0xabc',
            baseToken: { symbol: 'A'.repeat(3000) },
            quoteToken: { symbol: 'WETH' },
          },
        ],
      },
    }) as PoolPage;

    expect(pools.pools).toHaveLength(1);
    expect(pools.pools[0]!.baseTokenSymbol.length).toBe(64);
  });
});

describe('L-1 — dexscreener diagnostics name the chain, not [object Object]', () => {
  it('writes the slug when it skips a malformed pair', () => {
    const written: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk): boolean => {
      written.push(String(chunk));
      return true;
    });
    try {
      const adapter = createDexscreenerAdapter({ chains: CHAINS });
      adapter.normalize('pairs.active', {
        chain: CHAINS.resolve('ethereum'),
        limit: 5,
        raw: {
          pairs: [
            { chainId: 'ethereum', dexId: 'uniswap', pairAddress: '0xabc', baseToken: {} },
            {
              chainId: 'ethereum',
              dexId: 'uniswap',
              pairAddress: '0xdef',
              baseToken: { symbol: 'A' },
              quoteToken: { symbol: 'WETH' },
            },
          ],
        },
      });
    } finally {
      spy.mockRestore();
    }

    expect(written.join('')).toContain('chain=ethereum');
    expect(written.join('')).not.toContain('[object Object]');
  });
});

describe('L-9 — chain.tvl downloads the shared catalog once, not once per chain', () => {
  it('serves several chains from one /v2/chains fetch', async () => {
    let fetches = 0;
    const catalog = [
      { name: 'Ethereum', tvl: 100 },
      { name: 'Arbitrum', tvl: 50 },
      { name: 'Base', tvl: 25 },
    ];
    const adapter = createDefillamaAdapter({
      chains: CHAINS,
      now: () => 1_700_000_000_000,
      fetchImpl: async () => {
        fetches += 1;
        return new Response(JSON.stringify(catalog), { status: 200 });
      },
    });

    // The engine cache is keyed per chain, so it cannot deduplicate these three — the document
    // being sliced is identical every time.
    for (const slug of ['ethereum', 'arbitrum', 'base']) {
      await adapter.fetch('chain.tvl', { chain: slug });
    }

    expect(fetches).toBe(1);
  });

  it('does not remember a FAILED catalog fetch (one blip is not a five-minute outage)', async () => {
    let fetches = 0;
    const adapter = createDefillamaAdapter({
      chains: CHAINS,
      now: () => 1_700_000_000_000,
      fetchImpl: async () => {
        fetches += 1;
        return fetches === 1
          ? new Response('boom', { status: 500 })
          : new Response(JSON.stringify([{ name: 'Ethereum', tvl: 1 }]), { status: 200 });
      },
    });

    await expect(adapter.fetch('chain.tvl', { chain: 'ethereum' })).rejects.toThrow();
    await expect(adapter.fetch('chain.tvl', { chain: 'ethereum' })).resolves.toBeDefined();
    expect(fetches).toBe(2);
  });
});

describe('L-10 — an adapter that can never answer does not advertise a chain', () => {
  it('dune claims no coverage while its capability is deferred to M2', () => {
    // The coverage matrix does not consult `isAvailable()`, so a `true` here put `token.holders`
    // into `onchain_list_chains`' answer for ethereum — the one tool built to say what is actually
    // obtainable.
    const dune = createDuneAdapter();
    expect(dune.chainSupport!(CHAINS.resolve('ethereum'), 'token.holders')).toBe(false);
    expect(dune.isAvailable!().ok).toBe(false);
  });
});
