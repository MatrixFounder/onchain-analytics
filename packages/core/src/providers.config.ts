import type { AdapterRegistration, CapabilityRoute } from './adapters/types.js';

/**
 * Declarative capability → adapter routing table (D4/R-4, ARCHITECTURE.md §3.2 — values copied
 * literally from there). Order within `adapterIds` is priority + fallback chain (R-11) — changing
 * priority is a config edit here, never a code change at the call site.
 *
 * No real adapter registers any of these ids yet (tasks 003-4/003-5 build the actual adapters);
 * `CapabilityRegistry.resolve()` looks adapters up in a caller-supplied `Map<id, ProviderAdapter>`
 * (never this file directly), so an id referenced here with no matching Map entry is treated the
 * same as an unavailable adapter (skip-to-next) — not a compile-time or runtime error in THIS
 * package. `mcp-server`'s real registry construction (003-6/003-7) is what will actually need a
 * `Map` entry for every id these routes reference.
 */
export const routes: CapabilityRoute[] = [
  { capability: 'token.price', chains: ['ethereum', 'solana'], adapterIds: ['coingecko'] },
  { capability: 'token.metadata', chains: ['ethereum', 'solana'], adapterIds: ['coingecko'] },
  { capability: 'pairs.new', chains: ['ethereum', 'solana'], adapterIds: ['dexscreener'] },
  // R-6 Must requires both pairs.new and pool.info — pool.info has no tool consumer yet in M1
  // (cheap to declare now; major fix from architecture review cycle 1):
  { capability: 'pool.info', chains: ['ethereum', 'solana'], adapterIds: ['dexscreener'] },
  { capability: 'protocol.tvl', chains: ['ethereum', 'solana'], adapterIds: ['defillama'] },
  { capability: 'wallet.balances.native', chains: ['ethereum'], adapterIds: ['rpc-evm'] },
  { capability: 'wallet.balances.native', chains: ['solana'], adapterIds: ['rpc-solana'] },
  {
    capability: 'privacy.shielded_pool',
    chains: ['dash'],
    adapterIds: ['dash-platform', 'platform-explorer'],
  },
  {
    capability: 'platform.identities',
    chains: ['dash'],
    adapterIds: ['dash-platform', 'platform-explorer'],
  },
  {
    capability: 'platform.contracts',
    chains: ['dash'],
    adapterIds: ['dash-platform', 'platform-explorer'],
  },
  {
    capability: 'platform.documents',
    chains: ['dash'],
    adapterIds: ['dash-platform', 'platform-explorer'],
  },
  {
    capability: 'platform.credits',
    chains: ['dash'],
    adapterIds: ['dash-platform', 'platform-explorer'],
  },
  // R-10 (platform-explorer's own history, always live/keyless) + R-12 (opt. PG-backed history) —
  // fix F-2, review cycle 1: platform-explorer first (needs no DSN, always available), pg-history
  // second (an additional/alternative history view, only when ONCHAIN_PG_URL is configured):
  {
    capability: 'privacy.shielded_pool.history',
    chains: ['dash'],
    adapterIds: ['platform-explorer', 'pg-history'],
  },
  {
    capability: 'platform.metrics.history',
    chains: ['dash'],
    adapterIds: ['platform-explorer', 'pg-history'],
  },
  // R-8 — Dune, Should, interface/config-stub in M1 (see §3.2's dune decision, F-2/minor):
  // registered, not consumed by any of the 4 M1 tools; live fetch/fixture is out of M1's scope.
  { capability: 'token.holders', chains: ['ethereum'], adapterIds: ['dune'] },
];

/**
 * Declarative per-adapter registration (D4/R-4/R-25/R-26, ARCHITECTURE.md §3.2/§5.3 — values
 * copied literally from there). `hosts` is the SSRF allowlist source-of-truth for THAT adapter
 * only (§7.2); `rateLimit` feeds the per-provider token-bucket limiter (R-26) — conservative
 * starting values, not documented vendor limits (except Dune's credit budget), tunable here
 * without touching call-site code; `requiresEnv` is informational only (the adapter's own
 * `isAvailable()` is the actual availability decision).
 *
 * Exactly 9 entries (ARCHITECTURE.md §3.2/§5.3) — no real adapter implementation exists for any
 * of them yet (tasks 003-4/003-5 build the actual adapters); this task only declares the config
 * surface + values.
 */
export const adapterRegistrations: AdapterRegistration[] = [
  {
    id: 'coingecko',
    hosts: ['api.coingecko.com', 'pro-api.coingecko.com'],
    rateLimit: { capacity: 10, refillPerSec: 0.5 },
    requiresEnv: [],
  },
  {
    id: 'dexscreener',
    hosts: ['api.dexscreener.com'],
    rateLimit: { capacity: 5, refillPerSec: 1 },
    requiresEnv: [],
  },
  {
    id: 'defillama',
    hosts: ['api.llama.fi'],
    rateLimit: { capacity: 5, refillPerSec: 1 },
    requiresEnv: [],
  },
  // interface/config-stub in M1 — isAvailable() unconditionally returns false (§3.2 decision):
  {
    id: 'dune',
    hosts: ['api.dune.com'],
    rateLimit: { capacity: 2, refillPerSec: 0.1 },
    requiresEnv: ['DUNE_API_KEY'],
  },
  {
    id: 'rpc-evm',
    hosts: ['ethereum-rpc.publicnode.com', 'eth.drpc.org'],
    rateLimit: { capacity: 5, refillPerSec: 1 },
    requiresEnv: [],
  },
  {
    id: 'rpc-solana',
    hosts: ['api.mainnet-beta.solana.com'],
    rateLimit: { capacity: 5, refillPerSec: 1 },
    requiresEnv: [],
  },
  // F-3: no live host in M1 — interface + fixture-contract only; hosts get filled in whenever the
  // deferred backlog task for a live gRPC transport lands (§11):
  { id: 'dash-platform', hosts: [], rateLimit: { capacity: 5, refillPerSec: 1 }, requiresEnv: [] },
  {
    id: 'platform-explorer',
    hosts: ['platform-explorer.pshenmic.dev'],
    rateLimit: { capacity: 5, refillPerSec: 1 },
    requiresEnv: [],
  },
  // NEW (F-2) — not an HTTP host: Postgres wire protocol; the DSN itself is the access control,
  // not a hostname allowlist. Registered here purely for the providers-FK reason (§4.2).
  {
    id: 'pg-history',
    hosts: [],
    rateLimit: { capacity: 2, refillPerSec: 0.2 },
    requiresEnv: ['ONCHAIN_PG_URL'],
  },
];
