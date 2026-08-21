import type { ChainInfo } from '../../chain/registry-core.js';
import type { Throttle } from '../../net/rate-limit.js';
import { createRpcCaller } from './call-rpc.js';

/**
 * The pool fee-tier derivation — task 014-32c, `interfaces.md` §5.1.7, closing `OQ-T014-IF-3`.
 *
 * **Why a derivation exists at all.** DexScreener publishes no fee field. Measured 2026-08-13: none
 * in the single-pool response, and none in any of the 60 rows of the two committed search fixtures.
 * Its `labels` array carries the AMM VERSION (`v2`, `v3`, `CLMM`), which is not a fee and must never
 * be mapped to one — a version-to-tier table would fabricate exactly the number this refuses to
 * guess.
 *
 * **The derivation is one `eth_call` of `fee()`, selector `0xddca3f43`.** A pool that does not
 * implement the method reverts, and a revert is distinguishable from a returned tier, so "this pool
 * declares no fee tier" never reaches a caller as a number. Owner decision, 2026-08-13: the field is
 * populated where the derivation answers, absent where it does not, and never guessed.
 *
 * **`eth_call` is the third method of `rpc-evm`**, which is where the architecture assigns it
 * (`interfaces.md` §5.1.7: "`eth_call` becomes a third method on `rpc-evm`"). It reuses that
 * adapter's own transport — one implementation, `call-rpc.ts` — so the SSRF allowlist is still built
 * from the requested chain's curated `rpcHosts` and from nothing else.
 */

/** `fee()` — the Uniswap-V3-style selector, `keccak256("fee()")[0..4]`. */
const FEE_SELECTOR = '0xddca3f43';

/** A single 32-byte word: `0x` plus 64 hex digits. Anything else is not a `uint24` return. */
const WORD_RE = /^0x[0-9a-fA-F]{64}$/;

/**
 * The vendor's own unit is hundredths of a basis point (1e-6), not basis points.
 *
 * Measured 2026-08-13 on three Kodiak V3 pools on `berachain`: `3000`, `3000`, `500` — reported by
 * the vendor's UI as 0.3%, 0.3% and 0.05%. In basis points those are 30, 30 and 5, so the raw value
 * is divided by this. Publishing the raw number under a field named `…Bps` would overstate every
 * fee by 100×, which is the kind of unit error that survives review precisely because both numbers
 * look plausible.
 */
const RAW_UNITS_PER_BP = 100;

/** The largest value a `uint24` can hold — the ABI type `fee()` returns. */
const UINT24_MAX = 16_777_215;

export interface FeeTierDeps {
  fetchImpl?: typeof fetch;
  throttle?: Throttle;
}

/**
 * What one derivation attempt learned.
 *
 * `bps` is `null` whenever the tier could not be derived, and `reason` says which of the several
 * causes applied. The reason NEVER reaches the caller as a value — the published contract expresses
 * absence by omitting `feeTierBps`, not by a sentinel — but it does reach the operator's stderr and
 * the adapter's own diagnostics, so "the node was down" and "this pool declares no fee" stay
 * distinguishable to whoever has to act on them.
 */
export interface FeeTierReading {
  bps: number | null;
  reason: string;
}

/**
 * Whether the fee tier is derivable on this chain at all, before any request is made.
 *
 * Two independent conditions, and both are ours rather than the vendor's: `fee()` is an EVM ABI
 * method, so a non-EVM chain cannot answer it whatever its liquidity looks like; and an `eth_call`
 * needs an endpoint, which exists only where a human has curated `rpcHosts` through a commit
 * (`security.md` §7.2.1 rule 1, R-56a).
 *
 * Measured 2026-08-18: 19 chains carry curated hosts, DexScreener serves 65, and the intersection
 * is 16 — of which 15 are `evm`. `berachain` is NOT among them: it carries no curated host, and
 * adding one needs the owner's consent, so pools there answer with the addresses and the reserves
 * and no fee tier.
 */
export function feeTierDerivable(chain: ChainInfo): boolean {
  return chain.family === 'evm' && chain.rpcHosts !== null && chain.rpcHosts.length > 0;
}

/**
 * Builds the reader bound to one set of injected dependencies — a factory, never a module
 * singleton (ARCHITECTURE.md §8).
 *
 * **It never throws.** A pool with no `fee()` method, an endpoint that is down, and a node that
 * answers something unparseable are all the same fact to the CALLER: no tier. Letting any of them
 * propagate would turn a pool lookup that succeeded — addresses, reserves, liquidity, all fetched —
 * into a failed call over an optional field, and the next retry would pay for the whole pool
 * request again.
 */
export function createFeeTierReader(
  deps: FeeTierDeps = {},
): (chain: ChainInfo, poolAddress: string, deadlineAtMs?: number) => Promise<FeeTierReading> {
  const callRpc = createRpcCaller(deps);

  return async function readFeeTier(
    chain: ChainInfo,
    poolAddress: string,
    deadlineAtMs?: number,
  ): Promise<FeeTierReading> {
    if (!feeTierDerivable(chain)) {
      return {
        bps: null,
        reason:
          chain.family === 'evm'
            ? `${chain.slug} carries no curated rpcHosts, so fee() cannot be called`
            : `${chain.slug} is not an evm chain, and fee() is an evm ABI method`,
      };
    }

    const body = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_call',
      // `latest`, matching `eth_getBalance`'s own block tag: a fee tier is immutable on every AMM
      // that implements this method, so a historical tag would buy nothing and add a parameter
      // whose value nobody could choose.
      params: [{ to: poolAddress, data: FEE_SELECTOR }, 'latest'],
    });

    let raw;
    try {
      raw = await callRpc(chain, body, deadlineAtMs);
    } catch (error) {
      // The measured shape of "this pool has no fee tier": the node answers a JSON-RPC error whose
      // message is `execution reverted`, which `callRpc` turns into a throw. It is caught here
      // together with a transport failure, and the two are kept apart in `reason` only — the
      // published contract cannot tell them apart and must not pretend to.
      const message = error instanceof Error ? error.message : String(error);
      return {
        bps: null,
        reason: /revert/i.test(message)
          ? 'the pool does not implement fee() — the call reverted'
          : `fee() could not be called: ${message}`,
      };
    }

    if (typeof raw.result !== 'string' || !WORD_RE.test(raw.result)) {
      return { bps: null, reason: 'fee() did not return a single 32-byte word' };
    }
    const rawFee = Number(BigInt(raw.result));
    if (!Number.isSafeInteger(rawFee) || rawFee < 0 || rawFee > UINT24_MAX) {
      return { bps: null, reason: `fee() returned ${raw.result}, which is not a uint24` };
    }
    if (rawFee % RAW_UNITS_PER_BP !== 0) {
      // REFUSE rather than round (L-2's rule, applied here). The published field is an integer
      // count of basis points; a pool charging 0.025% cannot be expressed in it, and rounding to
      // 3 bps would publish a fee the pool does not charge. Absent is the honest answer, and the
      // reason names the value so an operator can see it is a real tier we cannot render.
      return {
        bps: null,
        reason: `fee() returned ${String(rawFee)}, which is not a whole number of basis points`,
      };
    }
    return { bps: rawFee / RAW_UNITS_PER_BP, reason: '' };
  };
}
