import { nonEmpty } from '../case-lib.mjs';

// Bootstrap row: not per-chain and not a capability. It answers the question every other case
// assumes — did the server start and reply at all.
export default {
  kind: 'bootstrap',
  tool: 'onchain_ping',
  catches: 'the server failing to start or answer at all',
  check: (r) => [nonEmpty(r?.version, 'version')].filter(Boolean),
};
