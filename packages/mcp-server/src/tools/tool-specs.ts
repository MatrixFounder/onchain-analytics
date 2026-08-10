import { chainSupplyToolSpec } from './chain-supply.js';
import { chainTvlToolSpec } from './chain-tvl.js';
import { dashPlatformHistoryToolSpec } from './dash-platform-history.js';
import { dexVolumeToolSpec } from './dex-volume.js';
import { entityLabelToolSpec } from './entity-label.js';
import { getTokenToolSpec } from './get-token.js';
import { listChainsToolSpec } from './list-chains.js';
import { newPairsToolSpec } from './new-pairs.js';
import { pingToolSpec } from './ping.js';
import { protocolTvlToolSpec } from './protocol-tvl.js';
import type { ToolSpec } from './registry.js';
import { smartMoneyFlowsToolSpec } from './smart-money-flows.js';
import { tokenHoldersToolSpec } from './token-holders.js';
import { tokenRiskToolSpec } from './token-risk.js';
import { walletBalancesToolSpec } from './wallet-balances.js';

/**
 * Every tool this server publishes — the single source of the MCP tool inventory (ADR-002 D7).
 *
 * **Why the list lives here and not in `registry.ts`.** The tool modules import `defineTool` from
 * `registry.ts`; if `registry.ts` also imported them back to build this array, the two would form
 * an import cycle. ESM would in fact resolve it — `defineTool` is a hoisted function declaration,
 * so it is initialised before any tool module body runs — but "works because of hoisting order" is
 * a property nobody should have to re-derive when adding the fourteenth tool. Splitting the
 * MECHANISM (`registry.ts`: types and `defineTool`) from the DATA (this file) removes the cycle
 * instead of relying on it resolving.
 *
 * **The order is part of the contract.** The SDK publishes tools in registration order, and this
 * array is that order. Every other observer sorts by name before comparing, so a reordering here
 * would change what a model receives without a single gate noticing — which is why
 * `test/tools-list-contract.test.ts` freezes the sequence unsorted. The order below is the one
 * `server.ts` used before TASK-011: free tools first, grouped by the milestone that added them,
 * with the three paid Nansen-backed tools last.
 *
 * Adding a tool: append its spec here, regenerate the identity artifact, then update the frozen
 * snapshot — in that order, and only after reading the snapshot diff.
 */
export const toolSpecs: readonly ToolSpec[] = [
  pingToolSpec,
  getTokenToolSpec,
  walletBalancesToolSpec,
  newPairsToolSpec,
  protocolTvlToolSpec,
  listChainsToolSpec,
  chainTvlToolSpec,
  dexVolumeToolSpec,
  tokenHoldersToolSpec,
  chainSupplyToolSpec,
  smartMoneyFlowsToolSpec,
  entityLabelToolSpec,
  tokenRiskToolSpec,
  dashPlatformHistoryToolSpec,
];
