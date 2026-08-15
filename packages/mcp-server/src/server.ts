import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { CapabilityRegistry, routes, type BudgetStore } from '@onchain-intel/core';
import type { AccessProfile } from './auth/access-profile.js';
import type { Env } from './env.js';
import { type ToolContext } from './tools/registry.js';
import type { Diagnostics } from './engine/diagnostics.js';
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
  /**
   * The access profile of the session being built (task 014-04, `system-architecture.md` §3.4.9).
   *
   * **Why the profile and not the reader.** Reading is asynchronous and this factory is not. §3.4.2
   * creates one `McpServer` per session, and §3.4.3 resolves the principal in middleware BEFORE
   * `transport.handleRequest` — so by the time a session is constructed, the profile has already
   * been read and awaited. Handing this factory a reader would move an `await` into a synchronous
   * constructor for no gain, and would let a failed read produce a server with a partial inventory
   * instead of refusing the session.
   *
   * **Why optional.** The stdio principal carries `accessProfileId: null` (§3.4.3) and reaches no
   * profile at all, so the local path stays exactly as it is: absent means the process inventory,
   * unnarrowed. That is also what keeps AC-2's frozen `tools/list` snapshot meaningful — the spawn
   * suite reaches no profile.
   *
   * **Who fills it.** Task 014-10, together with the session manager. This task declares the seam
   * and applies the narrowing; how the read profile travels to the factory is §3.4.3's open point.
   */
  accessProfile?: AccessProfile;
  /**
   * The diagnostics channel (task 014-26), forwarded into the tool context so a refusal is rendered
   * twice: fully into the channel, and bounded plus an identifier to the client. Optional here for
   * the same reason as `budgetStore` — a test builds a server without one and gets a refusal with
   * no identifier, which is the honest degradation.
   */
  diagnostics?: Diagnostics;
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
    ...(deps.diagnostics ? { diagnostics: deps.diagnostics } : {}),
  };

  // **The access profile narrows HERE, once per session** (task 014-04, `security.md` §7.5.3a,
  // `system-architecture.md` §3.4.9). This loop is the one place the tool list is applied, and it is
  // one of the two reads of a profile field that R-13.3a's gate names by file.
  //
  // **Why registration time and not per request.** One `McpServer` per session is what makes a
  // per-session inventory possible at all. With a single shared instance, `tools/list` would be a
  // process-level fact and narrowing would need a second mechanism the SDK does not offer.
  //
  // **Why an intersection and not a substitution.** The applied set is
  // `profile.toolAllowlist ∩ toolSpecs`, so a name in the profile that no spec carries selects
  // nothing, and `tools/list` is always a subset of what the process serves (R-14.1). Titles and
  // descriptions are never read from the profile — `spec.register` reads them from the tool
  // definition, unchanged (R-14.3), which is the other half of AC-25.
  //
  // **Mode `'all'` computes no intersection**, so phase 0 narrows nothing (R-14.4) and AC-2's frozen
  // snapshot keeps one expected value.
  //
  // **An empty list under mode `'list'` allows NOTHING, and this is the line that decides it.** An
  // empty list is a profile permitting no tool, not a profile with no narrowing; read the second
  // way, "empty" becomes "safe", which is the defect this project has already paid for twice (L-10,
  // and again as the new legal negative answer of memory M6). `?? []` says the same about a `null`
  // list under mode `'list'` — a state the engine's own `CHECK` pair forbids, so if one ever reaches
  // this process the answer is to register nothing rather than to guess which meaning was intended.
  const profile = deps.accessProfile;
  const narrows = profile !== undefined && profile.toolAllowlistMode === 'list';
  const allowed = narrows ? new Set(profile.toolAllowlist ?? []) : null;

  let registered = 0;
  for (const spec of toolSpecs) {
    if (allowed !== null && !allowed.has(spec.name)) continue;
    spec.register(server, context);
    registered += 1;
  }

  if (registered === 0) keepToolListAnswerable(server);

  return server;
}

/**
 * Makes `tools/list` answer `[]` for a session that registered nothing.
 *
 * **Why this is needed at all.** The SDK installs its `tools/list` and `tools/call` handlers lazily,
 * on the first `registerTool` call (`dist/esm/server/mcp.js`, `setToolRequestHandlers`). A session
 * whose profile allows no tool therefore never declares the `tools` capability, and `tools/list`
 * answers `-32601 Method not found` — measured, not assumed: it is what task 014-04's TC-UNIT-05
 * hit on its first run.
 *
 * **Why that answer is wrong for us.** An empty allowlist is a LEGAL profile — `data-model.md`
 * §4.5.3's `CHECK` pair exists precisely to hold "permits no tool" apart from "narrows nothing" — and
 * `-32601` cannot be told apart from "this server serves no tools at all". A client would report the
 * server as toolless when the truth is that this token is. That ambiguity is the shape this project
 * keeps paying for: a confident negative answer read as something else (L-10, and memory M6).
 *
 * **Why a placeholder and not a capability declaration.** `registerCapabilities({tools: …})`
 * advertises the capability without installing the handler, which turns a clear error into a hang of
 * a different kind. Registering and immediately removing one tool is the only route through the
 * SDK's public surface that initializes the handlers, and `remove()` deletes the entry before any
 * transport exists — no client can observe it, which `access-profile-reader.test.ts` asserts.
 *
 * **Why not register everything and disable the disallowed ones instead.** `disable()` would also
 * make `tools/list` answer, and it would leave every tool registered: a `tools/call` on a narrowed
 * tool then returns `Tool X disabled` where a skip returns `Tool X not found`. The first tells a
 * narrowed principal that the tool exists on this server. Skipping keeps the inventory unobservable,
 * which is what §3.4.9's "the loop skips a spec" buys.
 */
function keepToolListAnswerable(server: McpServer): void {
  server
    .registerTool(
      'onchain_none',
      { description: 'placeholder, removed before this server is reachable' },
      () => ({ content: [] }),
    )
    .remove();
}
