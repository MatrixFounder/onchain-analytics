import { nonEmpty, num } from '../case-lib.mjs';

export default {
  capability: 'wallet.balances.native',
  args: (chain, probe) => (probe.wallet ? { chain, address: probe.wallet } : null),
  catches: 'an RPC endpoint answering without a balance entry, or returning it as a lossy number',
  check: (r) => {
    // Zero is a CORRECT answer for the probe address — assert shape, never magnitude.
    const balances = Array.isArray(r?.balances) ? r.balances : null;
    if (!balances) return ['balances is not an array — shape changed'];
    const native = balances.find((b) => b?.assetType === 'native');
    if (!native) return ['no assetType="native" entry — the one thing this tool exists to return'];
    const problems = [];
    if (typeof native.amountRaw !== 'string' || !/^\d+$/.test(native.amountRaw)) {
      problems.push(
        `amountRaw is not an integer string (${JSON.stringify(native.amountRaw)}) — ` +
          'native balances exceed 2^53 and must stay strings (§1.7)',
      );
    }
    if (num(native.decimals) === null) problems.push('decimals missing or not numeric');
    const sym = nonEmpty(native.symbol, 'balances[native].symbol');
    if (sym) problems.push(sym);
    return problems;
  },
};
