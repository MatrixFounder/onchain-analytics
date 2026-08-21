import { describe, expect, it, vi } from 'vitest';
import {
  CapabilityRegistry,
  createDexscreenerAdapter,
  loadChainRegistry,
  type CapabilityRoute,
} from '@onchain-intel/core';
import { poolInfoHandler, PoolInfoInputSchema } from '../src/tools/pool-info.js';

/**
 * Task 014-32c — `onchain_pool_info`'s logic, the L-19 query strategy's other half, and the fee
 * derivation.
 *
 * **Everything here is fixture-driven and reaches no network** (R-21). The live half — that the
 * vendor still sends token addresses, and that `fee()` still answers on a v3 pool — is the eval
 * case's job, because it is the only instrument that can catch "they broke it" (L-6).
 */

const CHAINS = loadChainRegistry();
const FIXED_NOW = 1_700_000_000_000;
/** The Uniswap v3 WETH/USDC pool the eval curates on ethereum — measured, not invented. */
const POOL = '0x88e6A0c2dDD26FEEb64F039a2c41296FcB3f5640';
const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';
const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';

/** The vendor's single-pool body, in the shape measured 2026-08-21. */
function vendorPool(overrides: Record<string, unknown> = {}): unknown {
  return {
    schemaVersion: '1.0.0',
    pairs: [
      {
        chainId: 'ethereum',
        dexId: 'uniswap',
        labels: ['v3'],
        pairAddress: POOL,
        baseToken: { address: WETH, symbol: 'WETH' },
        quoteToken: { address: USDC, symbol: 'USDC' },
        liquidity: { usd: 105_452_090, base: 12_345.5, quote: 52_000_000 },
        volume: { h24: 1_000_000 },
        ...overrides,
      },
    ],
  };
}

/** `eth_call` of `fee()` → a 32-byte word. `0x1f4` is 500 raw = 5 bps, the real WETH/USDC tier. */
function feeWord(raw: number): string {
  return `0x${raw.toString(16).padStart(64, '0')}`;
}

interface Wiring {
  handler: ReturnType<typeof buildHandler>;
  calls: string[];
}

function buildHandler(opts: {
  vendorBody?: unknown;
  /** `null` → the node reverts, which is the measured "this pool declares no fee" case. */
  feeRaw?: number | null;
  calls?: string[];
}): (input: Parameters<typeof poolInfoHandler>[0]) => ReturnType<typeof poolInfoHandler> {
  const calls = opts.calls ?? [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    calls.push(url);
    if (url.includes('api.dexscreener.com')) {
      return new Response(JSON.stringify(opts.vendorBody ?? vendorPool()), { status: 200 });
    }
    // A JSON-RPC endpoint: the only other host any of this reaches.
    const body = JSON.parse(String(init?.body ?? '{}')) as { method?: string };
    expect(body.method).toBe('eth_call');
    if (opts.feeRaw === null || opts.feeRaw === undefined) {
      return new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          error: { code: 3, message: 'execution reverted' },
        }),
        { status: 200 },
      );
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: feeWord(opts.feeRaw) }), {
      status: 200,
    });
  };

  const adapter = createDexscreenerAdapter({ fetchImpl, now: () => FIXED_NOW, chains: CHAINS });
  const routes: CapabilityRoute[] = [{ capability: 'pool.info', adapterIds: ['dexscreener'] }];
  const registry = new CapabilityRegistry(
    routes,
    new Map([['dexscreener', adapter]]),
    undefined,
    CHAINS,
  );
  return (input) => poolInfoHandler(input, { registry });
}

function wire(opts: Parameters<typeof buildHandler>[0] = {}): Wiring {
  const calls: string[] = [];
  return { handler: buildHandler({ ...opts, calls }), calls };
}

describe('TC-E2E-01 — a known pool answers with both token ADDRESSES and its reserves', () => {
  it('returns the addresses `onchain_active_pairs` never carries', async () => {
    const { handler, calls } = wire({ feeRaw: 500 });

    const outcome = await handler({ chain: 'ethereum', pairAddress: POOL });

    expect(outcome.ok, outcome.ok ? '' : outcome.reason).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.output.resolved).toBe(true);
    const pool = outcome.output.pool;
    expect(pool).not.toBeNull();
    // The whole reason this tool exists (WI-56): symbol → contract address was served by nothing.
    expect(pool?.baseTokenAddress).toBe(WETH);
    expect(pool?.quoteTokenAddress).toBe(USDC);
    expect(pool?.reserveBase).toBe(12_345.5);
    expect(pool?.reserveQuote).toBe(52_000_000);
    expect(pool?.versionLabel).toBe('v3');
    expect(pool?.chain).toBe('ethereum');

    // The vendor route is the PER-CHAIN one — the chain is a path segment, not a filter applied
    // to a global search. That is what makes this answer about the pool that was asked for.
    expect(calls[0]).toBe(
      `https://api.dexscreener.com/latest/dex/pairs/ethereum/${encodeURIComponent(POOL)}`,
    );
  });
});

describe('TC-E2E-02 — the fee tier is derived, and its absence is never a number', () => {
  it('TC-E2E-02a: a pool that implements fee() answers with a real tier, in BASIS POINTS', async () => {
    // The case the task calls out by name: an implementation that refuses unconditionally would
    // satisfy "absence is a typed refusal" while deriving nothing, so the criterion is only closed
    // by a case that gets a NUMBER out.
    const { handler } = wire({ feeRaw: 500 });

    const outcome = await handler({ chain: 'ethereum', pairAddress: POOL });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // 500 raw is hundredths of a basis point — 0.05%, the real WETH/USDC tier, measured against
    // ethereum-rpc.publicnode.com on 2026-08-21. Publishing 500 under a `…Bps` name would
    // overstate the fee 100×, and both numbers look plausible, which is why this is pinned.
    expect(outcome.output.pool?.feeTierBps).toBe(5);
  });

  it('a pool whose fee() REVERTS omits the field rather than reporting a zero', async () => {
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { handler } = wire({ feeRaw: null });

    const outcome = await handler({ chain: 'ethereum', pairAddress: POOL });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    // ABSENT, never `0` and never `null`: a zero fee is a real tier some pools charge, so a
    // sentinel here would be indistinguishable from a measurement.
    expect(outcome.output.pool).not.toBeNull();
    expect('feeTierBps' in (outcome.output.pool ?? {})).toBe(false);
    // The rest of the answer survives — a missing optional field must not fail a call that
    // already fetched the addresses and the reserves.
    expect(outcome.output.pool?.baseTokenAddress).toBe(WETH);
    // The operator's channel says WHICH cause, which the caller's contract cannot.
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('does not implement fee()'));
    stderr.mockRestore();
  });

  it('a fee that is not a whole number of basis points is REFUSED, not rounded', async () => {
    // 250 raw is 0.025% — a real tier on some AMMs and not expressible in whole basis points.
    // Rounding to 3 would publish a fee the pool does not charge (L-2: refuse rather than guess).
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { handler } = wire({ feeRaw: 250 });

    const outcome = await handler({ chain: 'ethereum', pairAddress: POOL });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect('feeTierBps' in (outcome.output.pool ?? {})).toBe(false);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('not a whole number of basis'));
    stderr.mockRestore();
  });

  it('a chain with NO curated rpcHosts answers without a tier and without an eth_call', async () => {
    // `berachain` carries `rpcHosts: null` and the owner has not approved one. The pool still
    // answers; only the derived field is absent, and no request is made to find that out.
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const calls: string[] = [];
    const handler = buildHandler({
      calls,
      vendorBody: {
        schemaVersion: '1.0.0',
        pairs: [
          {
            chainId: 'berachain',
            dexId: 'kodiak',
            labels: ['v3'],
            pairAddress: '0xCda0ca7C3a609773067261D86E817bf777a2870d',
            baseToken: { address: '0x1', symbol: 'WBERA' },
            quoteToken: { address: '0x2', symbol: 'WETH' },
          },
        ],
      },
    });

    const outcome = await handler({
      chain: 'berachain',
      pairAddress: '0xCda0ca7C3a609773067261D86E817bf777a2870d',
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect('feeTierBps' in (outcome.output.pool ?? {})).toBe(false);
    expect(calls.filter((url) => !url.includes('dexscreener'))).toStrictEqual([]);
    expect(stderr).toHaveBeenCalledWith(expect.stringContaining('no curated rpcHosts'));
    stderr.mockRestore();
  });
});

describe('TC-E2E-03 — an address with no pool on that chain is `resolved: false`', () => {
  it('answers with a null pool, never an empty one', async () => {
    // Measured 2026-08-18: the vendor answers HTTP 200 with `"pairs": null` for an address it
    // knows no pool at. An empty `Pool` rendered as success would read as a pool holding no tokens
    // and no liquidity — the L-10 class this contract exists to keep out.
    const { handler, calls } = wire({ vendorBody: { schemaVersion: '1.0.0', pairs: null } });

    const outcome = await handler({
      chain: 'ethereum',
      pairAddress: '0x0000000000000000000000000000000000000001',
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.output.resolved).toBe(false);
    expect(outcome.output.pool).toBeNull();
    // And no `eth_call` was made: there was no pool to ask about.
    expect(calls.filter((url) => !url.includes('dexscreener'))).toStrictEqual([]);
  });
});

describe('TC-UNIT-05 — a malformed address is refused before any outgoing call', () => {
  it('the schema rejects it, so the handler is never reached', () => {
    const bad = PoolInfoInputSchema.safeParse({ chain: 'ethereum', pairAddress: 'not-an-address' });
    expect(bad.success).toBe(false);

    // …and the same value on a chain whose format it DOES match is accepted, or the case above
    // would pass for a schema that rejects everything.
    const good = PoolInfoInputSchema.safeParse({ chain: 'ethereum', pairAddress: POOL });
    expect(good.success).toBe(true);
  });

  it('an over-length value is refused without reaching the address decoder', () => {
    const bad = PoolInfoInputSchema.safeParse({
      chain: 'ethereum',
      pairAddress: '0x' + 'a'.repeat(200),
    });
    expect(bad.success).toBe(false);
  });
});

describe('the vendor must not hand back a pool from another chain', () => {
  it('a row whose chainId is not the requested chain is not published as that chain’s pool', async () => {
    // The chain is a path segment on this route, so the vendor has already scoped it — this is the
    // check that the scoping HELD. A pool from another chain, cached under this one, is
    // schema-valid and about something else: the failure `rpc-evm`'s no-host-fallback rule exists
    // to prevent one layer down.
    const { handler } = wire({
      vendorBody: {
        schemaVersion: '1.0.0',
        pairs: [
          {
            chainId: 'base',
            dexId: 'uniswap',
            pairAddress: POOL,
            baseToken: { address: WETH, symbol: 'WETH' },
            quoteToken: { address: USDC, symbol: 'USDC' },
          },
        ],
      },
    });

    const outcome = await handler({ chain: 'ethereum', pairAddress: POOL });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.output.resolved).toBe(false);
    expect(outcome.output.pool).toBeNull();
  });
});
