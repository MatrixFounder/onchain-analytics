import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CapabilityRegistry, routes, type BudgetStore } from '@onchain-intel/core';
import type { Env } from './env.js';
import { type ToolContext } from './tools/registry.js';
import { toolSpecs } from './tools/tool-specs.js';

/**
 * Dependencies passed explicitly into the server factory (reviewer note 1: version is never
 * hardcoded — it is threaded through from `index.ts`, which reads it once from `package.json`).
 * `env` is accepted per ARCHITECTURE.md §5.2's factory signature — no tool reads it directly
 * (each tool reads `registry` instead; `@onchain-intel/core` adapters read env keys themselves,
 * task 003-6/003-7).
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
 * reaching ONLY the three tools that declare it, for read-only `_meta.budget` visibility
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
 * future alternative HTTP-based transport (ADR-003 D1), so this factory can be reused unchanged
 * either way.
 *
 * **Registration is a loop over `toolSpecs` (TASK-011, ADR-002 D7).** It used to be thirteen
 * `registerXTool` calls grouped by cost, with comments explaining the grouping — and that grouping
 * was the last hand-maintained restatement of the inventory inside `src`. The order of the loop is
 * the order clients see in `tools/list`, which is why `toolSpecs` is ordered deliberately rather
 * than alphabetically and why `test/tools-list-contract.test.ts` freezes the unsorted sequence.
 *
 * **Each tool receives only the context keys it declared** (`needs` on its spec). That is not a
 * style choice: before the loop, `server.ts` handed each tool a fresh literal, so a free tool held
 * no reference to the budget store at all. Passing one wide object to all thirteen would have
 * traded that guarantee for the author's self-restraint — weak, since `budgetStore` is optional
 * everywhere. `defineTool` projects the object instead, so least privilege survives as a runtime
 * fact rather than a convention.
 *
 * `deps.registry`'s fallback (`new CapabilityRegistry(routes, new Map())`) is a deliberately INERT
 * default — the real `routes` table (`@onchain-intel/core`'s `providers.config.ts`) but an EMPTY
 * adapter `Map`, so every capability degrades gracefully (`CapabilityUnavailableError`, "no adapter
 * registered for this id") rather than crashing. It is NEVER the real, network-capable registry:
 * assembling all real adapters + the real two-level cache is `index.ts`'s single, explicit
 * responsibility (ARCHITECTURE.md §3.2 "строится один раз в index.ts") — `index.ts` always
 * constructs one and passes it in explicitly; this fallback exists purely so `createServer` stays
 * type-safe and harmless if a future caller ever omits `registry` outside that documented
 * production path (implementation choice, developer-guidelines §1.5).
 */
export function createServer(deps: CreateServerDeps): McpServer {
  const server = new McpServer({ name: 'onchain-intel-mcp-server', version: deps.version });
  const context: ToolContext = {
    version: deps.version,
    registry: deps.registry ?? new CapabilityRegistry(routes, new Map()),
    ...(deps.budgetStore ? { budgetStore: deps.budgetStore } : {}),
  };

  for (const spec of toolSpecs) {
    spec.register(server, context);
  }

  return server;
}
