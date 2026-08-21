import { nonEmpty } from '../case-lib.mjs';

export default {
  capability: 'pool.info',
  // Needs a curated `pool` per chain: this capability is addressed BY POOL ADDRESS, and there is no
  // vendor route that would hand us one. Each probe row's pool is the highest-liquidity pool of that
  // row's own `token`, measured — see `poolNote`. A chain with none reports `no-probe` rather than
  // silently vanishing, which is the whole point of deriving the axis from the case files (RF-5).
  args: (chain, probe) => (probe.pool ? { chain, pairAddress: probe.pool } : null),
  catches:
    'the vendor dropping the token ADDRESSES from its single-pool route (the field WI-56 needs and ' +
    'the reason this tool exists), `resolved` collapsing so an unknown address reads as a real pool ' +
    'with nothing in it, and the fee derivation going quiet — `feeTierBps` absent everywhere is ' +
    'indistinguishable from "no pool declares a tier" unless something asks a pool that does',
  check: (r, { chain, probe } = {}) => {
    const problems = [nonEmpty(r?.chain, 'chain'), nonEmpty(r?.source, 'source')].filter(Boolean);

    if (typeof r?.resolved !== 'boolean') {
      return [...problems, 'resolved is missing or not a boolean — the unknown-pool case is gone'];
    }
    if (r.resolved === false) {
      // The curated pool exists: it was measured as the deepest pool of a curated token. `false`
      // here is the vendor having lost it, not an argument problem — and it must never be read as
      // "this pool is empty", which is why the pair below is checked in both directions.
      problems.push('resolved is false for a pool curated because it holds real liquidity');
      if (r.pool !== null) {
        problems.push('resolved is false and `pool` is not null — the two disagree');
      }
      return problems;
    }
    if (r.pool === null || typeof r.pool !== 'object') {
      return [...problems, 'resolved is true and `pool` is null — the two disagree'];
    }

    const pool = r.pool;
    problems.push(
      ...[
        nonEmpty(pool.pairAddress, 'pool.pairAddress'),
        nonEmpty(pool.dexId, 'pool.dexId'),
        nonEmpty(pool.baseTokenSymbol, 'pool.baseTokenSymbol'),
        nonEmpty(pool.quoteTokenSymbol, 'pool.quoteTokenSymbol'),
        // THE FIELD THIS TOOL EXISTS FOR. `onchain_active_pairs` answers with symbols and never an
        // address, so symbol → contract address was served by nothing (WI-56). If the vendor drops
        // these two, the tool still returns a schema-valid pool and buys the caller nothing.
        nonEmpty(pool.baseTokenAddress, 'pool.baseTokenAddress'),
        nonEmpty(pool.quoteTokenAddress, 'pool.quoteTokenAddress'),
      ].filter(Boolean),
    );

    // The pool the vendor returned must be the one that was asked for. The chain is a path segment
    // on this route, so the vendor already scoped it — this checks the scoping actually held.
    if (
      probe?.pool &&
      typeof pool.pairAddress === 'string' &&
      pool.pairAddress.toLowerCase() !== String(probe.pool).toLowerCase()
    ) {
      problems.push(
        `pool.pairAddress is ${pool.pairAddress}, not the ${probe.pool} that was asked for`,
      );
    }
    if (typeof pool.chain === 'string' && chain && pool.chain !== chain) {
      problems.push(`pool.chain is ${pool.chain} on a ${chain} request`);
    }

    // Reserves are the vendor's own rounded numbers and the contract says so — but they must be
    // NUMBERS when present, never strings, or the projection role is a lie about the type.
    for (const field of ['reserveBase', 'reserveQuote', 'liquidityUsd']) {
      if (pool[field] !== undefined && typeof pool[field] !== 'number') {
        problems.push(`pool.${field} is ${typeof pool[field]}, not a number`);
      }
    }

    // **The fee derivation, checked where it is supposed to answer and where it is not.** A field
    // that is absent everywhere passes a bare presence check and also passes when the derivation
    // was never built — the exact "unconditional refusal satisfies the criterion" hole the task
    // named. So the assertion is keyed on the probe row: ethereum's curated pool is a Uniswap v3
    // pool on a chain with curated RPC hosts, so a tier is DUE there.
    const tierIsDue = chain === 'ethereum' || chain === 'base';
    if (tierIsDue) {
      if (!Number.isInteger(pool.feeTierBps)) {
        problems.push(
          `feeTierBps is ${String(pool.feeTierBps)} on ${chain}, whose curated pool is a v3 pool ` +
            'on a chain with curated RPC hosts — the eth_call derivation is not answering',
        );
      } else if (pool.feeTierBps <= 0 || pool.feeTierBps > 10_000) {
        problems.push(`feeTierBps=${pool.feeTierBps} is outside any real fee tier`);
      }
    } else if (pool.feeTierBps !== undefined && !Number.isInteger(pool.feeTierBps)) {
      problems.push(`feeTierBps is present but not an integer: ${String(pool.feeTierBps)}`);
    }

    return problems;
  },
};
