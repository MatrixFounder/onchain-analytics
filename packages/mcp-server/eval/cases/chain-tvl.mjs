import { nonEmpty, positive } from '../case-lib.mjs';

export default {
  capability: 'chain.tvl',
  args: (chain) => ({ chain }),
  catches: 'DeFiLlama renaming a chain, or returning a chain row without its tvl field',
  check: (r) =>
    [
      nonEmpty(r?.chain, 'chain'),
      nonEmpty(r?.name, 'name'),
      positive(r?.tvlUsd, 'tvlUsd'),
      nonEmpty(r?.source, 'source'),
    ].filter(Boolean),
};
