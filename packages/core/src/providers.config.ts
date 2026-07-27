import type { AdapterRegistration, CapabilityRoute } from './adapters/types.js';

/**
 * Declarative capability → adapter routing table (D4/R-4, ARCHITECTURE.md §3.2 — values copied
 * literally from there). Order within `adapterIds` is priority + fallback chain (R-11) — changing
 * priority is a config edit here, never a code change at the call site.
 *
 * **TASK-006 (task 006-5): the per-route `chains` literals are gone.** Which chains a route serves
 * is now derived from `adapter.chainSupport()` (the coverage matrix, §4.2.3) instead of being
 * restated here — one fact, one place. `CapabilityRegistry.resolve()` collects the adapters of
 * every route matching the capability and skips those whose predicate says no, which is exactly
 * what the literal used to do for `wallet.balances.native` (`rpc-evm` vs `rpc-solana`). The field
 * remains part of `CapabilityRoute` and is still honoured if set — nothing forces a caller with
 * its own route table to migrate.
 *
 * No real adapter registers any of these ids yet (tasks 003-4/003-5 build the actual adapters);
 * `CapabilityRegistry.resolve()` looks adapters up in a caller-supplied `Map<id, ProviderAdapter>`
 * (never this file directly), so an id referenced here with no matching Map entry is treated the
 * same as an unavailable adapter (skip-to-next) — not a compile-time or runtime error in THIS
 * package. `mcp-server`'s real registry construction (003-6/003-7) is what will actually need a
 * `Map` entry for every id these routes reference.
 */
export const routes: CapabilityRoute[] = [
  { capability: 'token.price', adapterIds: ['coingecko'] },
  { capability: 'token.metadata', adapterIds: ['coingecko'] },
  { capability: 'pairs.new', adapterIds: ['dexscreener'] },
  // R-6 Must requires both pairs.new and pool.info — pool.info has no tool consumer yet in M1
  // (cheap to declare now; major fix from architecture review cycle 1):
  { capability: 'pool.info', adapterIds: ['dexscreener'] },
  { capability: 'protocol.tvl', adapterIds: ['defillama'] },
  // TASK-006 (task 006-7, R-53): TVL of a CHAIN, not a protocol — a different endpoint
  // (`/v2/chains`) and a different output contract, hence a separate capability.
  { capability: 'chain.tvl', adapterIds: ['defillama'] },
  // TASK-007 (task 007-1, R-61): daily DEX volume of a chain — `/overview/dexs/{chain}`, keyless
  // and free. A third capability on the SAME adapter, and a separate one for the same reason
  // `chain.tvl` is separate from `protocol.tvl`: different endpoint, different output contract,
  // and — measured — a different chain set (274 vs 458, see the adapter's `chainSupport`).
  { capability: 'dex.volume.history', adapterIds: ['defillama'] },
  { capability: 'wallet.balances.native', adapterIds: ['rpc-evm'] },
  { capability: 'wallet.balances.native', adapterIds: ['rpc-solana'] },
  {
    capability: 'privacy.shielded_pool',
    adapterIds: ['dash-platform', 'platform-explorer'],
  },
  {
    capability: 'platform.identities',
    adapterIds: ['dash-platform', 'platform-explorer'],
  },
  {
    capability: 'platform.contracts',
    adapterIds: ['dash-platform', 'platform-explorer'],
  },
  {
    capability: 'platform.documents',
    adapterIds: ['dash-platform', 'platform-explorer'],
  },
  {
    capability: 'platform.credits',
    adapterIds: ['dash-platform', 'platform-explorer'],
  },
  // R-10 (platform-explorer's own history, always live/keyless) + R-12 (opt. PG-backed history) —
  // fix F-2, review cycle 1: platform-explorer first (needs no DSN, always available), pg-history
  // second (an additional/alternative history view, only when ONCHAIN_PG_URL is configured):
  {
    capability: 'privacy.shielded_pool.history',
    adapterIds: ['platform-explorer', 'pg-history'],
  },
  {
    capability: 'platform.metrics.history',
    adapterIds: ['platform-explorer', 'pg-history'],
  },
  // R-8 — Dune, Should, interface/config-stub in M1 (see §3.2's dune decision, F-2/minor):
  // registered, not consumed by any of the 4 M1 tools; live fetch/fixture is out of M1's scope.
  { capability: 'token.holders', adapterIds: ['dune'] },
  // M2 (TASK-005, R-29/R-30, task 005-1) — 3 new nansen routes, no fallback adapter: there is no
  // free equivalent for any of these three capabilities. chains scope is literally the same
  // subset as every M1 tool (OQ-3, ARCHITECTURE.md §3.2 "Десятый адаптер").
  { capability: 'smart-money.flows', adapterIds: ['nansen'] },
  { capability: 'entity.labels', adapterIds: ['nansen'] },
  { capability: 'token.risk', adapterIds: ['nansen'] },
];

/**
 * Declarative per-adapter registration (D4/R-4/R-25/R-26, ARCHITECTURE.md §3.2/§5.3 — values
 * copied literally from there). `hosts` is the SSRF allowlist source-of-truth for THAT adapter
 * only (§7.2); `rateLimit` feeds the per-provider token-bucket limiter (R-26) — conservative
 * starting values, not documented vendor limits (except Dune's credit budget), tunable here
 * without touching call-site code; `requiresEnv` is informational only (the adapter's own
 * `isAvailable()` is the actual availability decision).
 *
 * **10 entries** (ARCHITECTURE.md §3.2/§5.3), every one now backed by a real adapter. This comment
 * used to read "exactly 9 entries — no real adapter implementation exists for any of them yet",
 * which described the M1 config-only state and stopped being true across tasks 003-4/003-5
 * (M1 adapters) and 005-1 (`nansen`, the 10th and the first PAID one). Corrected vdd-multi cycle 4.
 * `dune` is the one entry whose adapter is deliberately still an interface stub — its
 * `isAvailable()` is unconditionally `{ok:false}` until a query is authored.
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
    // Raised from the M1 placeholder `{capacity: 5, refillPerSec: 1}` in TASK-007 (task 007-1,
    // R-66). That value was OUR brake, not the vendor's: the vendor publishes no numeric rate
    // limit at all (`api-docs.defillama.com` states only a qualitative "Standard | Higher"), and a
    // live cache-busted probe took 40 CONCURRENT origin requests — 40/40 HTTP 200,
    // `cf-cache-status: MISS` on every one, zero 429s.
    //
    // The old value was actively harmful for the capability this task adds: at 1 token/s a
    // ten-chain sweep — the DoD `dex.volume.history` was built against — spent ~5s asleep in our
    // own limiter, and a wider sweep crosses `MAX_WAIT_MS = 30_000` (`net/rate-limit.ts`) and
    // starts THROWING `RateLimitRejectedError`. At 10/5 a 20-call batch's last caller waits 2s
    // instead of 15s.
    //
    // **The real ceiling, stated correctly** (cycle 3, performance M-7 — the earlier wording here
    // was wrong twice over). The limiter rejects when the computed wait exceeds 30s, i.e. when the
    // BACKLOG passes 150 outstanding reservations (`200ms × (k-10) > 30_000`). That is a backlog,
    // not a concurrency level: it accumulates over time, so a sustained 10 calls/s reaches it in
    // ~30s without 160 of anything ever being in flight at once. And a full-coverage sweep is above
    // the line by construction — 274 covered chains issued in parallel means calls 161-274 are
    // refused outright.
    //
    // One bucket serves all three defillama capabilities (`protocol.tvl`, `chain.tvl`,
    // `dex.volume.history`) — the limit is per PROVIDER, not per capability. So the earlier claim
    // that raising it "cannot change their behaviour" was also wrong: `chain.tvl` costs ONE upstream
    // call for all 458 chains (a shared catalog), while `dex.volume.history` costs one PER CHAIN, so
    // a wide sweep can now park a backlog deep enough to make a concurrent `protocol.tvl` call wait
    // tens of seconds or be refused. Nothing on this bucket could produce that before TASK-007.
    // Bounding a wide sweep belongs at the tool layer, not here.
    rateLimit: { capacity: 10, refillPerSec: 5 },
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
  // 10th entry — M2 (TASK-005, R-29, task 005-1), first PAID adapter. Values copied literally
  // from ARCHITECTURE.md §3.2 "Десятый адаптер": the same conservative start already used by 5 of
  // the 9 M1 adapters — well below all four documented vendor thresholds.
  {
    id: 'nansen',
    hosts: ['api.nansen.ai'],
    // Raised from {capacity:5, refillPerSec:1} in adversarial cycle 1 (performance). The live probe
    // documents FOUR vendor limits: 150/s, 3000/min, burst 15, 10 credit-fails/min. The old value
    // was ~0.7% of the per-second allowance — "well below the thresholds" to the point of being
    // self-harm, because EVERY M2 capability is composite: smart-money.flows/token.risk burn 2
    // throttle tokens each, token-scoped entity.labels burns 3, plus 1 for a cold-start /account
    // resync. A 10-token agent turn spent ~7.6s asleep in our own limiter, not the vendor's.
    // 15/10 is still 15x under the per-second and 5x under the per-minute vendor limit.
    //
    // **Recorded deviation from R-29 (vdd-multi cycle 4, G-6):** R-29 asks the config to sit under
    // ALL FOUR documented thresholds, naming burst 15 as the strictest. `capacity: 15` is EQUAL to
    // that burst limit, not under it — so on a cold bucket a 15-token burst is exactly at the
    // vendor's ceiling rather than inside it. Deliberate: `capacity` is the burst allowance and
    // `refillPerSec: 10` is what bounds sustained rate, so the steady state stays well clear; the
    // alternative (capacity 14) buys nothing measurable and costs one call of headroom on the
    // composite capabilities this value exists to unblock. Named here rather than left implicit,
    // because "under all four" is what the requirement says and this is not that.
    rateLimit: { capacity: 15, refillPerSec: 10 },
    requiresEnv: ['NANSEN_API_KEY'],
  },
];
