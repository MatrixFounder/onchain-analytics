import { describe, expect, it, vi } from 'vitest';
import { bindCallObserver } from '../src/adapters/registry.js';
import type { CapabilityCall, CapabilityResolution, CapabilityResolver } from '../src/index.js';
import { deriveArgsHash } from '../src/net/args-hash.js';
import type { VendorSpendRecord } from '../src/cache/vendor-spend.js';

/**
 * Task 014-30, `OD-014-30-10` — the per-request observation seam.
 *
 * Two facts leave a `resolve()` call through this wrapper: the capability and the args hash (at the
 * CALL, so a throwing walk still reports them), and the vendor spend receipts (at each committed
 * ledger write). Both end up on one row of `request_trace`.
 */

const RESOLUTION: CapabilityResolution = { result: { ok: 1 }, source: 'stub', cache: 'miss' };

function stubResolver(
  impl?: (...args: unknown[]) => Promise<CapabilityResolution>,
): CapabilityResolver & { resolve: ReturnType<typeof vi.fn> } {
  const resolve = vi.fn(impl ?? (() => Promise.resolve(RESOLUTION)));
  return { resolve } as unknown as CapabilityResolver & { resolve: ReturnType<typeof vi.fn> };
}

function collector(): {
  calls: CapabilityCall[];
  receipts: VendorSpendRecord[];
  observer: { onCall: (c: CapabilityCall) => void; onVendorSpend: (r: VendorSpendRecord) => void };
} {
  const calls: CapabilityCall[] = [];
  const receipts: VendorSpendRecord[] = [];
  return {
    calls,
    receipts,
    observer: {
      onCall: (c) => calls.push(c),
      onVendorSpend: (r) => receipts.push(r),
    },
  };
}

describe('bindCallObserver', () => {
  it('reports the hash the registry itself would compute, from the same two arguments', async () => {
    // The assertion that matters: the expected value comes from `deriveArgsHash` applied to what the
    // caller passed, which is verbatim what `CapabilityRegistry.resolve` hashes internally. A test
    // pinning a literal digest would keep passing if the binder started hashing something else.
    const inner = stubResolver();
    const { calls, observer } = collector();
    const args = { chain: 'ethereum', address: '0xabc' };

    await bindCallObserver(inner, observer).resolve('token.price', 'ethereum', args);

    expect(calls).toStrictEqual([
      { capability: 'token.price', argsHash: deriveArgsHash('token.price', args) },
    ]);
  });

  it('reports the call BEFORE delegating, so a throwing walk still leaves the two facts', async () => {
    // The reason the hash is taken here rather than carried out of `resolve()`: four of its nine
    // throws happen before it computes one, and two of those can follow a committed vendor charge.
    const boom = new Error('CapabilityUnavailableError');
    const inner = stubResolver(() => Promise.reject(boom));
    const { calls, observer } = collector();

    await expect(
      bindCallObserver(inner, observer).resolve('entity.labels', 'ethereum', { address: '0xa' }),
    ).rejects.toThrow('CapabilityUnavailableError');

    expect(calls).toHaveLength(1);
    expect(calls[0]!.capability).toBe('entity.labels');
    expect(calls[0]!.argsHash).toHaveLength(64);
  });

  it('installs the observer s reporter as the resolver s fourth argument', async () => {
    const inner = stubResolver();
    const { observer } = collector();

    await bindCallObserver(inner, observer).resolve('token.risk', 'ethereum', { a: 1 }, 12_345);

    expect(inner.resolve).toHaveBeenCalledWith(
      'token.risk',
      'ethereum',
      { a: 1 },
      12_345,
      observer.onVendorSpend,
    );
  });

  it('ignores a reporter the caller of the BOUND resolver passes', async () => {
    // The binding exists so the per-request sink receives the receipts. A handler that supplied its
    // own reporter would divert this request's spend away from its own trace row.
    const inner = stubResolver();
    const { observer } = collector();
    const rogue = vi.fn();

    await bindCallObserver(inner, observer).resolve(
      'token.risk',
      'ethereum',
      { a: 1 },
      undefined,
      rogue as never,
    );

    const forwarded = inner.resolve.mock.calls[0]![4];
    expect(forwarded).toBe(observer.onVendorSpend);
    expect(forwarded).not.toBe(rogue);
  });

  it('delegates arguments and the resolution verbatim', async () => {
    const inner = stubResolver();
    const { observer } = collector();

    const resolution = await bindCallObserver(inner, observer).resolve('token.price', 'base', {
      address: '0xabc',
    });

    expect(resolution).toBe(RESOLUTION);
    expect(inner.resolve.mock.calls[0]!.slice(0, 3)).toStrictEqual([
      'token.price',
      'base',
      { address: '0xabc' },
    ]);
  });

  it('a throwing observer never stops the call', async () => {
    // Same contract as `reportVendorSpend`: observation is a side channel, and a broken consumer
    // must cost a diagnostic rather than a capability.
    const inner = stubResolver();
    const stderr = vi.spyOn(process.stderr, 'write').mockReturnValue(true);

    const resolution = await bindCallObserver(inner, {
      onCall: () => {
        throw new Error('sink is broken');
      },
      onVendorSpend: () => {},
    }).resolve('token.price', 'ethereum', { address: '0xabc' });

    expect(resolution).toBe(RESOLUTION);
    expect(
      stderr.mock.calls.some(([line]) => String(line).includes('capability call observer threw')),
    ).toBe(true);
    stderr.mockRestore();
  });

  it('reports once per resolve, so a tool resolving twice leaves two calls', async () => {
    // Not hypothetical: `onchain_dash_platform_history` picks one of two capabilities per call, and
    // a future tool composing two would produce two hashes for one row.
    const inner = stubResolver();
    const { calls, observer } = collector();
    const bound = bindCallObserver(inner, observer);

    await bound.resolve('platform.metrics.history', 'dash', { days: 7 });
    await bound.resolve('privacy.shielded_pool.history', 'zcash', { days: 7 });

    expect(calls.map((c) => c.capability)).toStrictEqual([
      'platform.metrics.history',
      'privacy.shielded_pool.history',
    ]);
    expect(calls[0]!.argsHash).not.toBe(calls[1]!.argsHash);
  });
});
