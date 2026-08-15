import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  CapabilityRegistry,
  createBudgetStore,
  createCacheStore,
  createCoingeckoAdapter,
  createDashPlatformAdapter,
  createDefillamaAdapter,
  createDexscreenerAdapter,
  createBlockscoutAdapter,
  createBlockchainInfoAdapter,
  createDuneAdapter,
  createNansenAdapter,
  createPgHistoryAdapter,
  createPlatformExplorerAdapter,
  createRpcEvmAdapter,
  createRpcSolanaAdapter,
  routes,
  type BudgetStore,
  type CacheStore,
  type ProviderAdapter,
} from '@onchain-intel/core';
import { toProcessEnv, type Env } from './env.js';
import { createServer } from './server.js';

/**
 * The process-wide runtime: what is assembled ONCE, and what is built per session (task 014-10).
 *
 * **Why this is a module and not the body of `main()`.** "Assembled once per process" is a claim a
 * test has to be able to make, and nothing can call `index.ts`: it is a bin whose module body ends
 * in `await main()`, so importing it starts a server. Everything that decides the layout now lives
 * here, where a test injects counting factories and reads the answer.
 *
 * **The layout, and why it is drawn here** (R-2, confirmed by the probe of task 014-01):
 *
 * - PROCESS-WIDE: `CapabilityRegistry`, `CacheStore`, `BudgetStore`. Sharing a cache is what a cache
 *   IS, and sharing a budget is what a ceiling is — two sessions that each held their own would
 *   spend the vendor quota twice and neither would know.
 * - PER SESSION: the `McpServer` instance and its transport. That object carries one client's
 *   protocol state, and a shared one mixes two clients' — it is also what makes a per-session tool
 *   inventory possible at all (`system-architecture.md` §3.4.9).
 */

export interface SharedRuntimeDeps {
  readonly env: Env;
  readonly version: string;
  /**
   * Factories, injectable for one reason: a test must be able to COUNT constructions without
   * touching `DATA_DIR`. Production omits both and gets the real stores.
   */
  readonly budgetStoreFactory?: () => BudgetStore;
  readonly cacheStoreFactory?: () => CacheStore;
}

export interface SharedRuntime {
  readonly registry: CapabilityRegistry;
  readonly budgetStore: BudgetStore;
  /** A fresh `McpServer` over the SAME shared dependencies. One call per session. */
  createSessionServer(): McpServer;
}

/**
 * Constructs the production `nansen` adapter — the ONLY call site allowed to do so (task 005-6,
 * CRITICAL production-wiring-safety note carried forward from the 005-5 code review). `budgetStore`
 * here has NO `?` — a construction-site guard by TYPE, not just by convention: this function cannot
 * compile if `buildRegistry` below ever tries to omit it, unlike `NansenAdapterDeps.budgetStore`
 * (the general factory's own boundary), which stays optional so `packages/core`'s own tests may
 * construct an ungated adapter for isolated HTTP-contract testing (`createNansenAdapter`'s own
 * docstring). The adapter's own `fetch()` fail-closed guard (throws when neither `budgetStore` nor
 * `fetchImpl` is supplied) is a second, independent backstop — this guard is the first one, so a
 * missing `budgetStore` at the production construction site is a compile error, never a runtime
 * throw discovered only when a paid capability is first called.
 */
function createProductionNansenAdapter(env: Env, budgetStore: BudgetStore): ProviderAdapter {
  return createNansenAdapter({
    env: toProcessEnv(env),
    budgetStore,
    ...(env.NANSEN_VELOCITY_CREDITS_PER_MIN !== undefined
      ? { velocityCap: env.NANSEN_VELOCITY_CREDITS_PER_MIN }
      : {}),
    ...(env.NANSEN_MAX_CALLS_PER_MIN !== undefined
      ? { maxCallsPerWindow: env.NANSEN_MAX_CALLS_PER_MIN }
      : {}),
    ...(env.NANSEN_DAILY_CREDIT_CAP !== undefined
      ? { dailyCreditCap: env.NANSEN_DAILY_CREDIT_CAP }
      : {}),
    ...(env.NANSEN_BUDGET_WARN_RATIO !== undefined
      ? { budgetWarnRatio: env.NANSEN_BUDGET_WARN_RATIO }
      : {}),
  });
}

/**
 * Assembles the ONE real, network-capable `CapabilityRegistry` for production (task 003-7,
 * ARCHITECTURE.md §3.2/§5.2 — "registry по умолчанию... строится один раз в index.ts, передаётся
 * в createServer"): all 12 real `ProviderAdapter`s from `@onchain-intel/core` (`coingecko`/
 * `blockscout`/`nansen` are handed the VALIDATED `env` for their API keys; the other 9 take no key
 * — keyless, or DSN-gated through the same validated `env` in `pg-history`'s case) + the real
 * two-level cache (`createCacheStore()` — its `DATA_DIR` resolution already reads
 * `process.env.DATA_DIR`, which `loadEnv()` above has already synced via `process.loadEnvFile()`
 * by the time this runs). `server.ts`'s own `registry` default is a separate, deliberately INERT
 * fallback (see its docstring) — this function is the only place the real 12-adapter set is ever
 * constructed (single point, per this task's own instruction).
 *
 * **Counts corrected in task 012-2** (the same commit that edits all twelve registrations to add
 * `tier`/`trust`, so the stale arithmetic was in the blast radius anyway). This said "all 10 real
 * adapters ... the other 7" while the Map below held 12 — stale since TASK-008/TASK-009 — and the
 * parenthetical named `dune` as an env reader, which it is not: `createDuneAdapter()` takes no
 * argument at all. Both halves are fixed here, and 3 + 9 now equals the 12 entries actually
 * constructed below; the old 2 + 7 did not equal its own 10 either.
 *
 * **`budgetStore` (M2, task 005-6) is a required parameter here** — `main()` constructs ONE real
 * `SqliteBudgetStore` (`createBudgetStore()`) and passes the SAME instance both here (for the
 * `nansen` adapter's own gate, via `createProductionNansenAdapter` above) and into `createServer`
 * (for the 3 M2 tools' read-only `_meta.budget`) — see `server.ts`'s own `CreateServerDeps`
 * docstring for why those are conceptually two different injection points that happen to share one
 * instance in production.
 */
function buildRegistry(
  env: Env,
  budgetStore: BudgetStore,
  cacheStoreFactory: () => CacheStore,
): CapabilityRegistry {
  const adapters = new Map<string, ProviderAdapter>([
    ['coingecko', createCoingeckoAdapter({ env: toProcessEnv(env) })],
    ['dexscreener', createDexscreenerAdapter()],
    ['defillama', createDefillamaAdapter()],
    ['rpc-evm', createRpcEvmAdapter()],
    ['rpc-solana', createRpcSolanaAdapter()],
    ['dash-platform', createDashPlatformAdapter()],
    ['platform-explorer', createPlatformExplorerAdapter()],
    ['dune', createDuneAdapter()],
    // R-79(a): the VALIDATED env, like every other secret-bearing adapter. It used to be built with
    // no `env` at all, so `deps.env ?? process.env` fell back to the raw process environment and the
    // one secret TASK-008 introduced was the only one bypassing `EnvSchema` (vdd-multi i2, sec M-4).
    ['blockscout', createBlockscoutAdapter({ env: toProcessEnv(env) })],
    // TASK-009: no `env` argument, and that is the whole configuration story — this adapter has no
    // secret to validate, because the vendor offers no key for the surfaces it reads.
    ['blockchain-info', createBlockchainInfoAdapter()],
    ['pg-history', createPgHistoryAdapter({ env: toProcessEnv(env) })],
    ['nansen', createProductionNansenAdapter(env, budgetStore)],
  ]);
  return new CapabilityRegistry(routes, adapters, cacheStoreFactory());
}

/**
 * Assembles the process-wide dependencies once and returns the per-session factory over them.
 *
 * Every `McpServer` this returns receives the SAME `registry` and the SAME `budgetStore` reference —
 * that identity is the whole of R-2.2, and `runtime.test.ts` measures it rather than trusting the
 * closure below to keep doing it.
 */
export function createSharedRuntime(deps: SharedRuntimeDeps): SharedRuntime {
  const budgetStore = (deps.budgetStoreFactory ?? createBudgetStore)();
  const registry = buildRegistry(deps.env, budgetStore, deps.cacheStoreFactory ?? createCacheStore);
  return {
    registry,
    budgetStore,
    createSessionServer: (): McpServer =>
      createServer({ env: deps.env, version: deps.version, registry, budgetStore }),
  };
}
