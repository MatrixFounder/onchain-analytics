import { nonEmpty, num } from '../case-lib.mjs';

export default {
  capability: 'chain.supply',
  // TASK-009 — free and keyless. Needs no curated probe data: the tool takes a chain and nothing
  // else, so every chain declaring the capability is exercised automatically. Today that is
  // `bitcoin` alone, which is also the point of the coverage assertions around it.
  args: (chain) => ({ chain }),
  catches:
    'the two supply figures collapsing into one, an exact value arriving as a lossy number, ' +
    'and a response that violates the consensus invariant it cannot violate',
  check: (r) => {
    const problems = [
      nonEmpty(r?.chain, 'chain'),
      nonEmpty(r?.symbol, 'symbol'),
      nonEmpty(r?.source, 'source'),
      nonEmpty(r?.emissionRaw, 'emissionRaw'),
      nonEmpty(r?.circulatingRaw, 'circulatingRaw'),
    ].filter(Boolean);
    if (problems.length) return problems;

    // Exactness is the contract: these are integers in the smallest unit and must arrive as
    // strings. A JSON number here would mean the exact value was spent before it reached us.
    for (const field of ['emissionRaw', 'circulatingRaw']) {
      if (!/^\d+$/.test(r[field])) {
        problems.push(`${field} is not an integer string — exactness lost in transport`);
      }
    }
    if (problems.length) return problems;

    const emission = BigInt(r.emissionRaw);
    const circulating = BigInt(r.circulatingRaw);
    // Consensus forbids claiming more than the subsidy. If this ever trips, one of the two
    // numbers is wrong and the answer cannot be attributed to either.
    if (circulating > emission) {
      problems.push('circulating exceeds emission — consensus forbids it, so a figure is wrong');
    }
    // The two ARE distinct quantities (unclaimed coinbase subsidy). Equal values mean the vendor
    // started serving one under both names, which is a 0.00016% error and invisible by eye.
    if (circulating === emission) {
      problems.push(
        'circulating equals emission exactly — the ~29-32 BTC of unclaimed subsidy vanished, ' +
          'so one figure is now being served under both names',
      );
    }
    if (num(r?.blockCount) === null || r.blockCount <= 0) {
      problems.push('blockCount missing or implausible — the field the cross-check depends on');
    }
    if (r?.decimals !== 8) problems.push(`decimals is ${r?.decimals}, expected 8 for BTC`);
    return problems;
  },
};
