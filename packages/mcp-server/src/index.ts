#!/usr/bin/env node
import { createRequire } from 'node:module';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CapabilityRegistry,
  createCacheStore,
  createCoingeckoAdapter,
  createDashPlatformAdapter,
  createDefillamaAdapter,
  createDexscreenerAdapter,
  createDuneAdapter,
  createPgHistoryAdapter,
  createPlatformExplorerAdapter,
  createRpcEvmAdapter,
  createRpcSolanaAdapter,
  routes,
  type ProviderAdapter,
} from '@onchain-intel/core';
import { loadEnv, type Env } from './env.js';
import { createServer } from './server.js';

/**
 * Minimal shape of `package.json` needed here — just enough to read `version` once, so it is
 * never hardcoded as a string literal anywhere in the source (reviewer note 1).
 */
interface PackageJson {
  readonly version: string;
}

/**
 * Assembles the ONE real, network-capable `CapabilityRegistry` for production (task 003-7,
 * ARCHITECTURE.md §3.2/§5.2 — "registry по умолчанию... строится один раз в index.ts, передаётся
 * в createServer"): all 9 real `ProviderAdapter`s from `@onchain-intel/core` (`coingecko`/
 * `dune` read `env` for their optional API keys; the other 7 are keyless or DSN-gated the same
 * way) + the real two-level cache (`createCacheStore()` — its `DATA_DIR` resolution already reads
 * `process.env.DATA_DIR`, which `loadEnv()` above has already synced via `process.loadEnvFile()`
 * by the time this runs). `server.ts`'s own `registry` default is a separate, deliberately INERT
 * fallback (see its docstring) — this function is the only place the real 9-adapter set is ever
 * constructed (single point, per this task's own instruction).
 */
function buildRegistry(env: Env): CapabilityRegistry {
  const adapters = new Map<string, ProviderAdapter>([
    ['coingecko', createCoingeckoAdapter({ env })],
    ['dexscreener', createDexscreenerAdapter()],
    ['defillama', createDefillamaAdapter()],
    ['rpc-evm', createRpcEvmAdapter()],
    ['rpc-solana', createRpcSolanaAdapter()],
    ['dash-platform', createDashPlatformAdapter()],
    ['platform-explorer', createPlatformExplorerAdapter()],
    ['dune', createDuneAdapter()],
    ['pg-history', createPgHistoryAdapter({ env })],
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

  const registry = buildRegistry(env);
  const server = createServer({ env, version, registry });
  // The only place a transport is chosen (D3) — stdio only in M0 (R-9); a future (M6)
  // alternative HTTP-based transport would be attached here too, `createServer` stays unchanged.
  await server.connect(new StdioServerTransport());
}

main().catch((error: unknown) => {
  // Anything other than an env-validation failure (already handled above) — report and exit
  // clean. Diagnostics go to stderr only: stdout is reserved for the MCP protocol (§7.3).
  console.error(
    `onchain-intel-mcp-server: fatal error: ${error instanceof Error ? error.message : String(error)}`,
  );
  process.exit(1);
});
