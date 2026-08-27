#!/usr/bin/env node
import { createRequire } from 'node:module';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  routes,
  adapterRegistrations,
  assertValidAdapterRegistrations,
  assertMergeParticipantsAreFree,
  createStateClient,
  createSqliteStateClient,
  createStateStores,
  createThrottle,
  setCacheStatsDebug,
  type StateClient,
} from '@onchain-intel/core';
import { loadEnv, toProcessEnv, withDeclaredDefaults, type Env } from './env.js';
import {
  SHIPPED_TRANSPORTS,
  assertNetworkPreconditions,
  assertTransportAvailable,
  networkPreStartChecks,
  resolveProfile,
} from './profile.js';
import { classifyToken } from './auth/authenticate.js';
import { createDefaultAccessProfileReader } from './auth/default-access-profile.js';
import { createHttpPrincipalResolver } from './auth/principal.js';
import { createTokenStore } from './auth/token-store.js';
import { createEngineStore } from './engine/pg-engine-store.js';
import { createDiagnostics } from './engine/diagnostics.js';
import { createDiagnosticsStore } from './engine/diagnostics-store.js';
import { createRequestTraceStore } from './engine/request-trace-store.js';
import { createBillingStore, createSqliteBillingStore } from './engine/billing-store.js';
import { createSharedRuntime } from './runtime.js';
import { startHttpTransport } from './transport/http.js';

// Task 012-2 (ADR-002 D8/D9, R-153/R-154) — every adapter registration must DECLARE its `tier` and
// its `trust` rank. Deliberately at module scope, immediately after the imports and therefore
// before `createSharedRuntime()` builds the cache, the budget ledger and the registry (task 014-10
// moved that assembly into `runtime.ts`, so a test could measure "assembled once per process"):
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

  // **Task 014-12 — step 2's store, opened before any socket exists.** The `network` profile
  // authenticates against Postgres; the pre-start checks below run over this same client, which is
  // why they are wired here rather than inside `profile.ts`.
  // **One repository, two axes.** The identity stores are written once against `StateClient`; which
  // client backs it is the storage axis of the profile. `security.md` §7.5.4: `network-sqlite`
  // authenticates every request exactly as `network` does, and is explicitly "not an authentication
  // exception" — a debugging combination that skipped the token would be the one configuration whose
  // refusal path never runs.
  //
  // ONE write-capable client per process, on whichever engine the storage axis names. The identity
  // repositories and the three state stores below both take it, which is what `pg/stores.ts` means
  // by "the three stores of the Postgres axis must share ONE client": two clients would be two
  // pools, two roles' worth of connections, and a `providers` bootstrap the other pool cannot see.
  const pepper = env.ONCHAIN_TOKEN_HASH_SALT;
  let stateClient: StateClient | undefined;
  const engineClient = (): StateClient => {
    stateClient ??=
      profile.storage === 'postgres'
        ? createStateClient({ env: rawEnv })
        : createSqliteStateClient({ env: rawEnv });
    return stateClient;
  };
  const identity =
    profile.transport === 'http' && pepper !== undefined
      ? (() => {
          const engine = createEngineStore(engineClient());
          return {
            engine,
            tokens: createTokenStore({ engine, pepper, now: () => Date.now() }),
          };
        })()
      : null;

  // The network profile refuses to start rather than downgrading to the SQLite axis. A downgrade
  // with no refusal would put this server's tokens, traces and spend ledger in a local file while
  // every gate reported success — the L-10 defect. Nothing is bound until this resolves.
  try {
    await assertNetworkPreconditions(
      profile,
      rawEnv,
      networkPreStartChecks(
        identity === null
          ? {}
          : {
              // One statement over the connection, so "the store answers" is measured rather than
              // assumed from a DSN that merely parses.
              'state-store': async () => {
                await identity.engine.query('SELECT 1');
                return true;
              },
              // AC-24's second half: the process must not bind a port when no token can reach it.
              // A listener with no issuable credential is an unauthenticated surface that answers
              // 401 to everyone, including the operator who has no way to make one.
              'active-token': async () => {
                const rows = await identity.engine.query<{ one: number }>(
                  `SELECT 1 AS one FROM ${identity.engine.qualify('api_tokens')}
                    WHERE status = 'active' AND (expires_at IS NULL OR expires_at > $1)
                    LIMIT 1`,
                  [Date.now()],
                );
                return rows.length > 0;
              },
            },
      ),
    );
  } catch (error) {
    console.error(
      `onchain-intel-mcp-server: ${error instanceof Error ? error.message : String(error)}`,
    );
    process.exit(1);
  }

  // M2 (task 005-6) — constructed ONCE, threaded into BOTH the `nansen` adapter's own gate
  // (`buildRegistry`) and `createServer`'s read-only `_meta.budget` visibility (see
  // `buildRegistry`'s own docstring above for why those are the SAME instance in production).
  // R-19.2 — the one site that writes on every cache access is silent unless the operator asked for
  // it. Set from the VALIDATED value, never read from the environment at the call site (R-13.3a).
  setCacheStatsDebug(env.LOG_LEVEL === 'debug');

  // Both channels (task 014-27), built BEFORE the runtime because every session server renders its
  // refusals through this one (task 014-26). `store: null` is the local profile: stdio, one
  // operator, and that operator IS reading stderr — the event still reaches the one channel that
  // exists there, so a refusal always has an identifier and the full text always has a reader.
  const diagnostics = createDiagnostics({
    store: identity === null ? null : createDiagnosticsStore(identity.engine),
    now: () => Date.now(),
  });

  // The resolver is injected ONLY on the http axis (task 014-15). On stdio no resolver is passed and
  // the constant answers; on http an absent principal is refused rather than defaulted, because the
  // constant is `role: 'admin'` and a default there would be a privilege escalation wearing the
  // clothes of a fallback.
  // The storage axis, resolved once (task 014-39's factory, wired by task 014-19). Before this the
  // process took `createCacheStore`/`createBudgetStore` unconditionally — the SQLite ones — so a
  // `network` profile kept its cache, its credit ledger and its limiter in a local file while the
  // migration had created all three in Postgres and nothing wrote there. Two `network` processes
  // then each held the full daily Nansen cap and the full vendor rate (L-17).
  //
  // The Postgres arm shares the client built above; the SQLite arm builds its three stores over
  // `DATA_DIR/cache.sqlite3` and takes no client at all.
  const stores = createStateStores({
    storage: profile.storage,
    ...(profile.storage === 'postgres' ? { client: engineClient() } : {}),
  });

  // ONE limiter for the process, over the axis's bucket store (task 014-18) with task 014-19's
  // degradation port on top. `index.ts` is the only place that can build it: the module singleton
  // in `core` is constructed at import time and therefore cannot know the deployment profile.
  const throttle = createThrottle({
    store: stores.limiter,
    emit: (event, detail) => {
      // `void`, not `await` (`system-architecture.md` §3.4.4): degradation is already the slow path,
      // and awaiting a write here would add the store's latency to a call that just failed to reach
      // a store. `severity: 'warn'` — the process is still serving, at a narrower ceiling.
      void diagnostics
        .emit(event, {
          severity: 'warn',
          provider: typeof detail['providerId'] === 'string' ? detail['providerId'] : null,
          detail,
        })
        .catch(() => {
          // `createDiagnostics.emit` reports a store failure on stderr itself and never rethrows, so
          // the only way to land here is stderr failing too. There is no third channel to name it on,
          // and throwing out of a limiter's side effect would take down the request that triggered it.
        });
    },
  });

  // Task 015-09 (`system-architecture.md` §3.5.2, R-2.4) — built UNCONDITIONALLY, on the SAME
  // storage axis `stores` above already follows (`profile.storage`), never gated on `identity`.
  // `ToolContext.billing` carries no `?` (R-3.7): an unconfigured deployment must not serve a call
  // for free, silently. Postgres wraps the SAME shared client `engineClient()` already returns — a
  // second wrapper over one connection, not a second connection — so this construction cannot
  // depend on `identity`, which is `null` whenever the http pepper is unset and would otherwise
  // crash here before that misconfiguration's own clear exit further below ever runs.
  const billing =
    profile.storage === 'postgres'
      ? createBillingStore(createEngineStore(engineClient()), createDefaultAccessProfileReader())
      : createSqliteBillingStore({ env: rawEnv });

  const runtime = createSharedRuntime({
    env,
    version,
    diagnostics,
    throttle,
    budgetStoreFactory: () => stores.budget,
    cacheStoreFactory: () => stores.cache,
    // Task 014-30. Built on the SAME condition as the stored diagnostics channel: both tables live
    // in the engine, so the profile that has no engine has neither. On the local profile the row is
    // not written and nothing is lost — `request_trace` does not exist there either.
    ...(identity === null ? {} : { requestTrace: createRequestTraceStore(identity.engine) }),
    billing,
    ...(profile.transport === 'http'
      ? {
          principals: createHttpPrincipalResolver(),
          // Task 014-16's supplier. The phase-0 one until the table-backed reader is wired: it is
          // the one `createDefaultAccessProfileReader` was written for, and it had no production
          // caller before this line.
          accessProfiles: createDefaultAccessProfileReader(),
        }
      : {}),
  });

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
    await runtime.createSessionServer().connect(new StdioServerTransport());
    return;
  }

  // The `http` axis. `createServer` is called per request here — task 014-10 makes it per session —
  // and the process-wide dependencies assembled above are what every one of them receives.
  const { httpBind, httpResponseTimeoutMs, sessionMax, sessionIdleMs } = withDeclaredDefaults(env);
  const port = env.ONCHAIN_HTTP_PORT;
  if (port === undefined) {
    // §10.3 declares no default port. An unset value is not a port — it is a decision nobody made,
    // and guessing one would bind a surface the operator did not ask for.
    console.error('onchain-intel-mcp-server: ONCHAIN_HTTP_PORT is required by the http transport');
    process.exit(1);
  }

  if (identity === null) {
    // One way to arrive here now that both axes have a state client: no pepper. Without it a digest
    // cannot be verified, so every token would be refused — and a listener that answers 401 to
    // everyone, including the operator who has no way to mint a matching row, is worse than a
    // refusal at start.
    console.error(
      'onchain-intel-mcp-server: the http transport needs ONCHAIN_TOKEN_HASH_SALT — without a ' +
        'pepper no presented token can be verified against a stored digest (security.md §7.5.2)',
    );
    process.exit(1);
  }

  const running = await startHttpTransport({
    createSessionServer: () => runtime.createSessionServer(),
    diagnostics,
    // Step 2 of the admission order. Every request is verified, including one on an established
    // session: no verified-token cache exists, so a revocation takes effect on the next request
    // (R-15.6, AC-26).
    authenticate: async (presented) => {
      if (presented === null) return { ok: false, refusalClass: 'auth.unknown_token' };
      const outcome = classifyToken(await identity.tokens.lookup(presented), Date.now());
      return outcome.ok
        ? { ok: true, principal: outcome.row }
        : { ok: false, refusalClass: outcome.refusalClass };
    },
    bind: httpBind,
    port,
    // Task 014-13. `startHttpTransport` asserts the idle timeout against the manifest before it
    // binds, so an operator who sets a timeout below the longest declared deadline gets a refusal
    // at start rather than a session evicted mid-request.
    sessionMax,
    sessionIdleMs,
    // Task 014-23. The server's own response clock, independent of the client: a caller that never
    // closes its request otherwise holds a session slot until the idle sweeper takes it, and the
    // sweeper is the bigger hammer — it closes the session, not just the response.
    responseTimeoutMs: httpResponseTimeoutMs,
    // Both perimeter lists come from `EnvSchema`, already parsed into arrays there so that this
    // reader and the SDK's read one value rather than two splits of one string (R-12.1, R-12.2).
    ...(env.ONCHAIN_ALLOWED_HOSTS ? { allowedHosts: env.ONCHAIN_ALLOWED_HOSTS } : {}),
    ...(env.ONCHAIN_ALLOWED_ORIGINS ? { allowedOrigins: env.ONCHAIN_ALLOWED_ORIGINS } : {}),
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
