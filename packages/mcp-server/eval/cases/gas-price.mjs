import { nonEmpty, positive } from '../case-lib.mjs';

export default {
  capability: 'gas.price',
  args: (chain) => ({ chain }),
  catches:
    'Blockscout closing keyless access again (L-6), a node dropping eth_gasPrice, or either ' +
    'source publishing a gas price with no unit — the failure that makes 386 Gwei on polygon ' +
    'look a thousand times worse than 0.3 Gwei on ethereum',
  check: (r) => {
    const defects = [
      // The whole point of the capability: SOMETHING priced the gas. Both source shapes fill this
      // one, so it is the field that must never be null on a served chain.
      positive(r?.gasPriceGwei, 'gasPriceGwei'),
      nonEmpty(r?.source, 'source'),
      // Without the symbol the number is uncomparable across chains — see the tool description.
      nonEmpty(r?.nativeSymbol, 'nativeSymbol'),
    ];

    // The per-source contract, checked against the source that actually answered rather than
    // against whichever one we expected. This is what would catch a future adapter quietly
    // publishing invented tiers, or a node path that stopped carrying exact wei.
    if (r?.source === 'rpc-evm') {
      if (typeof r?.gasPriceWei !== 'string' || !/^(0|[1-9][0-9]*)$/.test(r.gasPriceWei)) {
        defects.push(`rpc-evm answered without an exact decimal gasPriceWei (${r?.gasPriceWei})`);
      }
      if (r?.tiers !== null) {
        defects.push('rpc-evm published tiers — a node states one price, so these were invented');
      }
      // Cross-check the two representations against each other: the Gwei figure is DERIVED from
      // the wei one, so a mismatch means the derivation broke, which no single-field check sees.
      const fromWei = Number(r.gasPriceWei) / 1e9;
      if (Number.isFinite(fromWei) && Math.abs(fromWei - r.gasPriceGwei) > fromWei * 1e-9) {
        defects.push(`gasPriceGwei ${r.gasPriceGwei} does not match gasPriceWei ${r.gasPriceWei}`);
      }
    }

    if (r?.source === 'blockscout') {
      if (r?.gasPriceWei !== null) {
        defects.push('blockscout published exact wei it cannot know — it serves rounded Gwei');
      }
      const t = r?.tiers;
      if (t && !(t.slowGwei <= t.averageGwei && t.averageGwei <= t.fastGwei)) {
        defects.push(`tiers are not ordered slow<=average<=fast (${JSON.stringify(t)})`);
      }
    }

    return defects.filter(Boolean);
  },
};
