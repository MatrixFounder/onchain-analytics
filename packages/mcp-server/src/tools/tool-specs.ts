import { chainSupplyToolSpec } from './chain-supply.js';
import { chainTvlToolSpec } from './chain-tvl.js';
import { dashPlatformHistoryToolSpec } from './dash-platform-history.js';
import { dexVolumeToolSpec } from './dex-volume.js';
import { chainTvlHistoryToolSpec } from './chain-tvl-history.js';
import { listProtocolsToolSpec } from './list-protocols.js';
import { gasPriceToolSpec } from './gas-price.js';
import { protocolIncidentsToolSpec } from './protocol-incidents.js';
import { chainTransactionsToolSpec } from './chain-transactions.js';
import { protocolTvlHistoryToolSpec } from './protocol-tvl-history.js';
import { entityLabelToolSpec } from './entity-label.js';
import { getTokenToolSpec } from './get-token.js';
import { listChainsToolSpec } from './list-chains.js';
import { activePairsToolSpec } from './active-pairs.js';
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
  activePairsToolSpec,
  protocolTvlToolSpec,
  listChainsToolSpec,
  chainTvlToolSpec,
  dexVolumeToolSpec,
  chainTvlHistoryToolSpec,
  listProtocolsToolSpec,
  // WI-51 — network activity. Two tools rather than one `onchain_chain_activity`: they have
  // different clocks (30 s vs 600 s TTL) and different provider sets, and merging them would make
  // a gas query pay for a transactions fetch it did not ask for.
  // WI-52 option 1 — the security-incident layer. Its own tool, never a field on
  // `onchain_protocol_tvl`: editorial data with a different update cycle must not inherit the
  // freshness of an on-chain metric standing beside it.
  protocolIncidentsToolSpec,
  gasPriceToolSpec,
  chainTransactionsToolSpec,
  protocolTvlHistoryToolSpec,
  tokenHoldersToolSpec,
  chainSupplyToolSpec,
  smartMoneyFlowsToolSpec,
  entityLabelToolSpec,
  tokenRiskToolSpec,
  dashPlatformHistoryToolSpec,
];
