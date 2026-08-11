import { num, nonEmpty } from '../case-lib.mjs';

export default {
  capability: 'protocol.tvl.history',
  args: (chain, probe) =>
    probe.protocolSlug ? { chain, protocolSlug: probe.protocolSlug, days: 30 } : null,
  catches:
    'the per-protocol document outgrowing its raised cap, changing series shape, or losing the ' +
    'chain key — which would report a deployed protocol as absent',
  check: (r) => {
    const problems = [nonEmpty(r?.protocol, 'protocol')].filter(Boolean);
    if (typeof r?.deployed !== 'boolean') return [...problems, 'deployed is not a boolean'];
    if (num(r?.points) === null || num(r?.gapDays) === null || num(r?.window?.days) === null) {
      return [...problems, 'points/gapDays/window.days are not all numbers'];
    }
    // Holds UNIVERSALLY, including the not-deployed answer — that case reports days 0, because
    // "missing" describes days the vendor claims to cover, and a protocol that is not here has none.
    if (r.points + r.gapDays !== r.window.days) {
      problems.push(`points+gapDays=${r.points + r.gapDays} but window.days=${r.window.days}`);
    }
    if (!Array.isArray(r?.series)) problems.push('series is not an array');
    else if (r.series.length !== r.points) problems.push('points disagrees with the series length');
    if (r.deployed && r.points === 0) {
      problems.push('deployed here, yet a 30-day window returned nothing');
    }
    if (!r.deployed && r.window.days !== 0) {
      problems.push(
        'not deployed, yet the window claims days — the invariant is being papered over',
      );
    }
    return problems;
  },
};
