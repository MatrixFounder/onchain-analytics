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
    if (num(r?.unmappedDeployments) === null) problems.push('unmappedDeployments is not a number');

    return problems;
  },
};
