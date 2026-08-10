import { nonEmpty, num, positive } from '../case-lib.mjs';

export default {
  capability: 'protocol.tvl',
  args: (chain, probe) => (probe.protocolSlug ? { chain, protocolSlug: probe.protocolSlug } : null),
  catches: 'a protocol slug going away, or chain-scoped TVL silently collapsing to the total',
  check: (r) => {
    const problems = [
      nonEmpty(r?.protocol, 'protocol'),
      positive(r?.totalTvlUsd, 'totalTvlUsd'),
    ].filter(Boolean);
    // chain-scoped TVL may legitimately be 0 (protocol not deployed there) but must be a number:
    // a missing field and a real zero mean opposite things and must not look alike.
    if (num(r?.tvlUsd) === null) problems.push('tvlUsd is not a finite number — chain scope lost');
    return problems;
  },
};
