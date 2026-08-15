#!/usr/bin/env node
import { createRequire } from 'node:module';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
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
  adapterRegistrations,
  assertValidAdapterRegistrations,
  assertMergeParticipantsAreFree,
  type BudgetStore,
  type ProviderAdapter,
} from '@onchain-intel/core';
import { loadEnv, toProcessEnv, withDeclaredDefaults, type Env } from './env.js';
import {
  SHIPPED_TRANSPORTS,
  assertNetworkPreconditions,
  assertTransportAvailable,
  resolveProfile,
} from './profile.js';
import { createServer } from './server.js';
import { startHttpTransport } from './transport/http.js';

// Task 012-2 (ADR-002 D8/D9, R-153/R-154) — every adapter registration must DECLARE its `tier` and
// its `trust` rank. Deliberately at module scope, immediately after the imports and therefore
// before `createCacheStore()`, `createBudgetStore()` and `CapabilityRegistry` are ever constructed:
// an undeclared rank has to kill process START, not the first request that happens to route
// through the offending adapter. Failing later would additionally leave a half-declared adapter set
// bootstrapped into the `providers` table of an already-opened SQLite file.
//
// The compiler already rejects a literal missing either field; this is the same guarantee for
// values that arrive through a cast or a runtime-assembled array (see the function's own docstring).
assertValidAdapterRegistrations(adapterRegistrations);

// Task 013-2 (T-013, R-162/R-163) — every capability that ACTIVATES merging must have every
// reachable participant registered `tier: 'free'`, or the paid one silently loses every dedup
// conflict (the conflict rank is `adapterIds`' own compiled order, and last position is lowest
// rank — see `assertMergeParticipantsAreFree`'s own docstring). Same module-scope placement and
// same reasoning as `assertValidAdapterRegistrations` immediately above: this must fail PROCESS
// START, before any store or registry is constructed, never the first merged request. Covered by
// `test/merge-participants-startup.integration.test.ts`'s TC-INT-05 — deleting this line must make
// that test fail, or the check is declared but unenforced (the exact WI-34…WI-37 distinction).
assertMergeParticipantsAreFree(routes, adapterRegistrations);

/**
 * Minimal shape of `package.json` needed here — just enough to read `version` once, so it is
 * never hardcoded as a string literal anywhere in the source (reviewer note 1).
 */
interface PackageJson {
  readonly version: string;
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
function buildRegistry(env: Env, budgetStore: BudgetStore): CapabilityRegistry {
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
  return new CapabilityRegistry(routes, adapters, createCacheStore());
}

// `createRequire` + `require('../package.json')` works identically whether this file runs as
// `src/index.ts` under tsx (dev) or as the bundled `dist/index.js` (tsup build): both sit one
// directory below the package root, so the relative path resolves the same way in both cases.
// Chosen over a JSON import attribute (`with { type: 'json' }`) because that syntax is flaky
// under the pinned TypeScript 6 / NodeNext combination used in this package (see .AGENTS.md).
const require = createRequire(import.meta.url);
const { version } = require('../package.json') as PackageJson;

async function main(): Promise<void> {
  let env: Env;
  try {
    env = loadEnv();
  } catch {
    // loadEnv() already wrote a clear, key-names-only diagnostic to stderr (never values, D10);
    // exit here with no further logging (no stack trace) — a clean fail-fast exit (ARCHITECTURE
    // §7.2). `process.exit` is typed `never`, so TS knows `env` is assigned below.
    process.exit(1);
  }

  // T-014 (task 014-38) — the profile is resolved ONCE, before anything is constructed and long
  // before anything is bound. It carries two axes: who reaches the process, and where its state
  // lives. `createServer` does NOT receive it (R-1.2): a profile that reached a tool would let a
  // handler behave differently per deployment, which no requirement asks for and no test covers.
  // The VALIDATED environment, not the raw one. §10.3.2 fixes the startup order — `loadEnv` parses,
  // THEN the profile resolves — and reading `process.env` here skipped step 1 for the two keys that
  // decide the deployment: `ONCHAIN_PROFILE=remote` would have been refused by `resolveProfile`
  // rather than by the schema, and a malformed `ONCHAIN_STATE_PG_URL` would have passed the "is set"
  // pre-check and failed at connect time. Found by task 014-04's R-13.3a gate, which counts a direct
  // `process.env` read outside `env.ts` as a defect — this was one, introduced by task 014-38.
  const rawEnv = toProcessEnv(env);
  const profile = resolveProfile(rawEnv);

  // The network profile refuses to start rather than downgrading to the SQLite axis. A downgrade
  // with no refusal would put this server's tokens, traces and spend ledger in a local file while
  // every gate reported success — the L-10 defect. Nothing is bound until this resolves.
  try {
    await assertNetworkPreconditions(profile, rawEnv);
  } catch (error) {
    console.error(
      `onchain-intel-mcp-server: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }

  // M2 (task 005-6) — constructed ONCE, threaded into BOTH the `nansen` adapter's own gate
  // (`buildRegistry`) and `createServer`'s read-only `_meta.budget` visibility (see
  // `buildRegistry`'s own docstring above for why those are the SAME instance in production).
  const budgetStore = createBudgetStore();
  const registry = buildRegistry(env, budgetStore);
  const server = createServer({ env, version, registry, budgetStore });

  // The only place a transport is chosen (D3). Task 014-09 attaches the Streamable HTTP transport
  // for the `http` axis; until it lands, an `http` profile REFUSES rather than falling back to
  // stdio. Falling back would hand the operator a process that answers — on the wrong transport,
  // with no token check — while its configuration says otherwise.
  try {
    assertTransportAvailable(profile, SHIPPED_TRANSPORTS);
  } catch (error) {
    console.error(
      `onchain-intel-mcp-server: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }

  if (profile.transport === 'stdio') {
    // Unchanged since M0, and that is an acceptance criterion (AC-2): the local path raises no
    // listener, opens no port and reads no header.
    await server.connect(new StdioServerTransport());
    return;
  }

  // The `http` axis. `createServer` is called per request here — task 014-10 makes it per session —
  // and the process-wide dependencies assembled above are what every one of them receives.
  const { httpBind, httpResponseTimeoutMs } = withDeclaredDefaults(env);
  void httpResponseTimeoutMs; // task 014-23 applies it to the response window
  const port = env.ONCHAIN_HTTP_PORT;
  if (port === undefined) {
    // §10.3 declares no default port. An unset value is not a port — it is a decision nobody made,
    // and guessing one would bind a surface the operator did not ask for.
    console.error('onchain-intel-mcp-server: ONCHAIN_HTTP_PORT is required by the http transport');
    process.exit(1);
  }

  const running = await startHttpTransport({
    createSessionServer: () => createServer({ env, version, registry, budgetStore }),
    bind: httpBind,
    port,
  });
  console.error(
    `onchain-intel-mcp-server: listening on ${running.address.host}:${String(running.address.port)}`,
  );
}

main().catch((error: unknown) => {
  // Anything other than an env-validation failure (already handled above) — report and exit
  // clean. Diagnostics go to stderr only: stdout is reserved for the MCP protocol (§7.3).
  console.error(
    `onchain-intel-mcp-server: fatal error: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
