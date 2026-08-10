import { nonEmpty, num, positive } from '../case-lib.mjs';

export default {
  capability: 'token.price',
  args: (chain, probe) => (probe.token ? { chain, address: probe.token } : null),
  catches: 'CoinGecko dropping price for a listed contract, or losing symbol/decimals',
  check: (r) => {
    const problems = [nonEmpty(r?.symbol, 'symbol')].filter(Boolean);
    // priceUsd is the whole point of the call; absent is a defect, zero is implausible for a
    // token the provider claims to know.
    const price = positive(r?.priceUsd, 'priceUsd');
    if (price) problems.push(price);
    if (r?.decimals !== undefined && num(r.decimals) === null)
      problems.push('decimals present but not numeric');
    return problems;
  },
};
