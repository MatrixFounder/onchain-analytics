// Bootstrap row: the chain registry is what the whole chain axis is derived from, so if it fails to
// load or shrinks, every other row is measuring a matrix that no longer describes the engine.
export default {
  kind: 'bootstrap',
  tool: 'onchain_list_chains',
  catches: 'the chain registry failing to load, or shrinking unexpectedly',
  check: (r) => {
    const chains = Array.isArray(r?.chains) ? r.chains : null;
    if (!chains) return ['chains is not an array'];
    if (chains.length === 0) return ['registry is empty'];
    const bad = chains.find((c) => !c?.slug || !Array.isArray(c?.capabilities));
    return bad ? [`a chain row lacks slug/capabilities: ${JSON.stringify(bad).slice(0, 120)}`] : [];
  },
};
