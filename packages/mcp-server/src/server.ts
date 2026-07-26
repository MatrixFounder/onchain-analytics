import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CapabilityRegistry, routes, type BudgetStore } from '@onchain-intel/core';
import type { Env } from './env.js';
import { registerPingTool } from './tools/ping.js';
import { registerGetTokenTool } from './tools/get-token.js';
import { registerWalletBalancesTool } from './tools/wallet-balances.js';
import { registerNewPairsTool } from './tools/new-pairs.js';
import { registerProtocolTvlTool } from './tools/protocol-tvl.js';
import { registerSmartMoneyFlowsTool } from './tools/smart-money-flows.js';
import { registerEntityLabelTool } from './tools/entity-label.js';
import { registerTokenRiskTool } from './tools/token-risk.js';
// TASK-006 (task 006-7): discovery + chain-level TVL. Both keyless; `onchain_list_chains` makes
// no network call at all.
import { registerListChainsTool } from './tools/list-chains.js';
import { registerChainTvlTool } from './tools/chain-tvl.js';

/**
 * Dependencies passed explicitly into the server factory (reviewer note 1: version is never
 * hardcoded — it is threaded through from `index.ts`, which reads it once from `package.json`).
 * `env` is accepted per ARCHITECTURE.md §5.2's factory signature — no tool reads it directly
 * (each of the 4 new M1 tools reads `registry` instead; `@onchain-intel/core` adapters read env
 * keys themselves, task 003-6/003-7).
 *
 * **`registry` is injectable (task 003-7, ARCHITECTURE.md §3.2/§5.2, F-1):** this is the ONLY
 * mechanism "MCP E2E without network" (R-21) relies on — no global `fetch` mock, a different
 * implementation of the same public `CapabilityRegistry.resolve()` contract is injected at this
 * boundary. This injection is in-process only — unreachable across a spawned child process
 * boundary (`test/e2e.stdio.test.ts` spawns `src/index.ts` via `tsx`, which has no way to receive
 * the calling test's `registry` object) — the new `test/e2e.inprocess.test.ts`
 * (`InMemoryTransport`) is what actually exercises this seam; the spawn suite stays ping-only.
 *
 * **`budgetStore` (M2, task 005-6, interfaces.md §5.2):** injectable the SAME way as `registry` —
 * threaded into the 3 new M2 tools' contexts ONLY for read-only `_meta.budget` visibility
 * (`budget-meta.ts`'s own `budgetMeta()`). This is a DIFFERENT `BudgetStore` reference than the one
 * `index.ts` wires into `createNansenAdapter({budgetStore})` (that one performs the actual gate
 * decision inside `nansen.fetch()`) — in production both point at the SAME `SqliteBudgetStore`
 * instance (`index.ts` constructs it once and passes it to both call sites), but this factory
 * itself doesn't assume that; it only ever reads from whatever `BudgetStore` it's given.
 */
export interface CreateServerDeps {
  env: Env;
  version: string;
  registry?: CapabilityRegistry;
  budgetStore?: BudgetStore;
}

/**
 * Transport-agnostic `McpServer` factory (D3): builds the server and registers every tool, but
 * never creates or attaches a transport — `index.ts` is the only place that decides stdio vs. a
 * future (M6) alternative HTTP-based transport, so this factory can be reused unchanged either way.
 *
 * `deps.registry`'s fallback (`new CapabilityRegistry(routes, new Map())`) is a deliberately INERT
 * default — the real `routes` table (`@onchain-intel/core`'s `providers.config.ts`) but an EMPTY
 * adapter `Map`, so every capability degrades gracefully (`CapabilityUnavailableError`, "no adapter
 * registered for this id") rather than crashing. It is NEVER the real, network-capable registry:
 * assembling all 9 real adapters + the real two-level cache is `index.ts`'s single, explicit
 * responsibility (this task's own instruction, ARCHITECTURE.md §3.2 "строится один раз в
 * index.ts") — `index.ts` always constructs one and passes it in explicitly; this fallback exists
 * purely so `createServer` stays type-safe and harmless if a future caller ever omits `registry`
 * outside that documented production path (implementation choice, developer-guidelines §1.5).
 */
export function createServer(deps: CreateServerDeps): McpServer {
  const server = new McpServer({ name: 'onchain-intel-mcp-server', version: deps.version });
  const registry = deps.registry ?? new CapabilityRegistry(routes, new Map());
  const budgetStore = deps.budgetStore;

  registerPingTool(server, { version: deps.version });
  registerGetTokenTool(server, { registry });
  registerWalletBalancesTool(server, { registry });
  registerNewPairsTool(server, { registry });
  registerProtocolTvlTool(server, { registry });
  registerListChainsTool(server, { registry });
  registerChainTvlTool(server, { registry });
  // M2 (task 005-6) — `budgetStore` threaded into each context ONLY for read-only `_meta.budget`
  // visibility (this factory's own docstring above); an omitted `budgetStore` degrades the tool to
  // "works, just without `_meta.budget`" (`budget-meta.ts`'s own contract), never an error.
  registerSmartMoneyFlowsTool(server, { registry, budgetStore });
  registerEntityLabelTool(server, { registry, budgetStore });
  registerTokenRiskTool(server, { registry, budgetStore });

  return server;
}
