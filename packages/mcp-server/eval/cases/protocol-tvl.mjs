import { nonEmpty, num, positive } from '../case-lib.mjs';

export default {
  capability: 'protocol.tvl',
  args: (chain, probe) => (probe.protocolSlug ? { chain, protocolSlug: probe.protocolSlug } : null),
  catches:
    'a protocol slug going away, the shared /protocols catalog outgrowing the response cap or ' +
    'changing shape, and "not deployed here" decaying back into an error',
  check: (r) => {
    const problems = [
      nonEmpty(r?.protocol, 'protocol'),
      positive(r?.totalTvlUsd, 'totalTvlUsd'),
    ].filter(Boolean);

    // L-9: the three states must stay distinguishable from the outside. Before this, a protocol
    // that simply is not on a chain arrived as `capability unavailable` — the same shape as a
    // provider outage — so a caller could not tell a fact about the world from a fault in ours.
    if (typeof r?.deployed !== 'boolean') {
      problems.push('deployed is not a boolean — the not-deployed answer is gone');
    } else if (r.deployed === false) {
      if (r.tvlUsd !== 0) problems.push(`not deployed but tvlUsd is ${String(r.tvlUsd)}, not 0`);
      if (num(r?.totalTvlUsd) === null) problems.push('not deployed on this chain, yet no total');
    } else {
      // Deployed: a number, or an explicit null meaning "the vendor publishes no plain-TVL bucket
      // here". `undefined` is neither and would mean the chain scope was lost.
      if (r.tvlUsd !== null && num(r?.tvlUsd) === null) {
        problems.push('tvlUsd is neither a finite number nor null — chain scope lost');
      }
      if (!Array.isArray(r?.deployments) || !r.deployments.some((d) => d?.chain === r?.chain)) {
        problems.push('deployed on this chain, but it is absent from deployments');
      }
    }

    if (!Array.isArray(r?.deployments)) problems.push('deployments is not an array');
    else if (r.deployments.some((d) => typeof d?.chain !== 'string')) {
      problems.push('a deployments row has no chain slug');
    }
    if (!Array.isArray(r?.aggregatedFrom)) problems.push('aggregatedFrom is not an array');

    // The two checks the FIRST version of this case lacked, added after it passed ✅ on `bsc` and
    // `gnosis` while the answer was `deployed: false, tvlUsd: 0` for chains holding hundreds of
    // millions. The three-state contract above made a wrong answer syntactically legal; these two
    // ask whether it is also ARITHMETICALLY possible.
    if (num(r?.unmappedDeployments) === null) {
      problems.push('unmappedDeployments is not a number');
    } else if (r.unmappedDeployments > 0) {
      // The vendor named a deployment chain our registry cannot. Either the registry has drifted or
      // the two vendor documents disagree on naming again — both need a human, and both are
      // invisible from any single answer.
      problems.push(
        `${r.unmappedDeployments} deployment chain(s) could not be named — registry drift, or the ` +
          'vendor changed chain naming again',
      );
    } else if (Array.isArray(r?.deployments) && num(r?.totalTvlUsd) !== null && r.totalTvlUsd > 0) {
      // With nothing unnameable, the per-chain figures must account for the whole protocol. Catches
      // BOTH failures seen in this area: chains silently dropped (the ratio falls under 1) and
      // chains counted twice (it hit exactly 2 during development).
      const summed = r.deployments.reduce((acc, d) => acc + (num(d?.tvlUsd) ?? 0), 0);
      const ratio = summed / r.totalTvlUsd;
      if (ratio < 0.97 || ratio > 1.03) {
        problems.push(
          `per-chain TVL sums to ${(100 * ratio).toFixed(1)}% of totalTvlUsd with no unmapped chains`,
        );
      }
    }

    return problems;
  },
};
