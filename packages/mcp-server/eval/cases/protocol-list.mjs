import { num } from '../case-lib.mjs';

export default {
  capability: 'protocol.list',
  args: (chain) => ({ chain, limit: 5, sortedBy: 'tvl' }),
  catches:
    'the protocol catalog losing its chain lists or its slug column, and the chain filter silently ' +
    'matching nothing — which looks like "no protocols here" rather than like a failure',
  check: (r) => {
    const problems = [];
    if (!Array.isArray(r?.protocols)) return ['protocols is not an array'];
    if (num(r?.matched) === null) problems.push('matched is not a number');
    // The defect this is really here for: L-10 made a chain filter match nothing on 43 of 458
    // chains, and an empty list is the most plausible-looking wrong answer a listing can give. Every
    // chain the eval probes carries protocols; zero means the filter, not the world.
    if (r.protocols.length === 0) {
      problems.push('no protocols matched this chain — the chain filter is matching nothing');
    }
    if (r.matched < r.protocols.length) {
      problems.push(`matched=${r.matched} is smaller than the ${r.protocols.length} rows returned`);
    }
    for (const p of r.protocols) {
      if (typeof p?.slug !== 'string' || p.slug === '') {
        problems.push('a protocol row has no slug — the field the other protocol tools take');
        break;
      }
    }
    // Descending by the requested key, with unknowns last. A ranking that is not ordered is not a
    // ranking, and "top five" is the whole question this tool answers.
    const values = r.protocols.map((p) => num(p?.tvlUsd));
    for (let i = 1; i < values.length; i += 1) {
      if (values[i - 1] !== null && values[i] !== null && values[i] > values[i - 1]) {
        problems.push(`sortedBy=tvl but row ${i} outranks row ${i - 1}`);
        break;
      }
    }
    return problems;
  },
};
