#!/usr/bin/env node
import { createRequire } from 'node:module';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  routes,
  adapterRegistrations,
  assertValidAdapterRegistrations,
  assertMergeParticipantsAreFree,
} from '@onchain-intel/core';
import { loadEnv, toProcessEnv, withDeclaredDefaults, type Env } from './env.js';
import {
  SHIPPED_TRANSPORTS,
  assertNetworkPreconditions,
  assertTransportAvailable,
  resolveProfile,
} from './profile.js';
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
  const runtime = createSharedRuntime({ env, version });

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
    createSessionServer: () => runtime.createSessionServer(),
    bind: httpBind,
    port,
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
