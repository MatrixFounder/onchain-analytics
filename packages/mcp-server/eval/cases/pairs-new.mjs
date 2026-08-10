import { nonEmpty } from '../case-lib.mjs';

export default {
  capability: 'pairs.new',
  args: (chain) => ({ chain, limit: 5 }),
  catches: 'DexScreener returning an empty page for a chain that demonstrably has DEX activity',
  check: (r) => {
    const pairs = Array.isArray(r?.pairs) ? r.pairs : null;
    if (!pairs) return ['pairs is not an array — shape changed'];
    if (pairs.length === 0)
      return ['pairs is empty — no new pairs at all is implausible for a live DEX chain'];
    const first = pairs[0];
    return [nonEmpty(first?.pairAddress ?? first?.address, 'pairs[0].pairAddress')].filter(Boolean);
  },
};
