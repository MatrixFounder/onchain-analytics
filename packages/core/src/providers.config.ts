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
  // R-74 (TASK-008) — retargeted off `dune`. The old route pointed at an interface/config stub
  // whose `chainSupport` covered ZERO chains, so `token.holders` was advertised by
  // `onchain_list_chains` and answered nowhere: strictly worse than not having the capability,
  // because the matrix an agent reads promised it.
  { capability: 'token.holders', adapterIds: ['blockscout'] },
  // M2 (TASK-005, R-29/R-30, task 005-1) — 3 new nansen routes, no fallback adapter: there is no
  // free equivalent for any of these three capabilities. chains scope is literally the same
  // subset as every M1 tool (OQ-3, ARCHITECTURE.md §3.2 "Десятый адаптер").
  { capability: 'smart-money.flows', adapterIds: ['nansen'] },
  // R-75 (TASK-008) — `blockscout` FIRST, `nansen` as the paid fallback behind it. The order is the
  // entire point of the change: a credit is spent only where the free source cannot answer. The
  // registry walks the list in order, so this is not a preference hint — it is the spend rule.
  //
  // H-1 (vdd-multi TASK-008) — `isSatisfying` is the other half of that spend rule. Order alone was
  // not enough: the registry falls through only on a THROW, so `blockscout` truthfully answering
  // "I have no tags for this address" terminated the route and shadowed nansen for the whole
  // `ttlFor('entity.labels') = 3600` window — which is the ordinary case, not the tail (the
  // recorded USDC probe has empty tags). Fixing it inside the adapter would have meant teaching
  // `blockscout` that nansen exists; the policy belongs here, as data, beside the order it refines.
  {
    capability: 'entity.labels',
    adapterIds: ['blockscout', 'nansen'],
    isSatisfying: (result) =>
      Array.isArray(result) &&
      result.some((entry) => {
        if (entry === null || typeof entry !== 'object') return false;
        const label = entry as { name?: unknown; tags?: unknown; labels?: unknown };
        return (
          typeof label.name === 'string' ||
          (Array.isArray(label.tags) && label.tags.length > 0) ||
          (Array.isArray(label.labels) && label.labels.length > 0)
        );
      }),
  },
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
  // R-73 (TASK-008). ONE host: `mcp.blockscout.com`, the facade, which serves BOTH capabilities.
  //
  // This comment used to describe a two-host design — `api.blockscout.com` for `token.holders`,
  // the facade for `entity.labels` — that adversarial cycle 1 had already reverted in the adapter
  // (B-3: the direct host enforces auth, so `token.holders` answered on NO chain of a stock
  // keyless install). The stale host stayed behind in this list on the argument that "keeping it
  // allowlisted costs nothing".
  //
  // L-4 (vdd-multi): it does cost something. `safeFetch` re-checks EVERY redirect hop against this
  // list, so an allowlisted host we never call is still a host a misbehaving or compromised facade
  // can bounce us to — and for this adapter the allowlist is the only egress control there is.
  // R-73(b) specifies exactly one host, so the extra entry also contradicted an accepted Must. A
  // future key-gated direct path adds it back in the same commit that calls it; that is the change
  // that should need justifying.
  //
  // `requiresEnv` is EMPTY on purpose. The facade answers without a key today, so demanding one
  // would disable a working capability on a stock install; the key is read inside `fetch()` —
  // AFTER the cache key is derived, like `COINGECKO_*` — so it can never enter a cache key.
  {
    id: 'blockscout',
    hosts: ['mcp.blockscout.com'],
    // **Recorded deviation from R-73(b), owner decision 2026-07-29: DEFENSIVE, not measured.**
    //
    // R-73(b) prescribes `{capacity: 5, refillPerSec: 5}`. That value has no measurement behind it,
    // and unlike `defillama` (a documented 40-concurrent live probe) or `nansen` (four named vendor
    // thresholds) it cannot get one from the vendor: TASK.md §1.2 records that these responses carry
    // **no `RateLimit-*` and no `Retry-After` headers at all**, so there is no server signal to
    // calibrate against. 5 RPS came from the vendor's published "5 RPS" tier line, which bounds
    // REQUESTS while the thing that actually runs out is CREDITS.
    //
    // The arithmetic the prescribed value misses: `get_address_info` fans out to three upstreams
    // (20 + 120 + 20 ≈ 160 credits) out of 100K credits/day, i.e. a ceiling of **≈625 calls/day**.
    // At 5 RPS the limiter permits 432 000/day — ~690× the ceiling, and the entire daily quota burns
    // in ~125 seconds. Worse, the two routes then fail in OPPOSITE directions: a saturated bucket on
    // `entity.labels` throws, the registry walks on, and the free provider's overload silently
    // starts spending Nansen credits; on `token.holders` (blockscout-only) the same condition is a
    // hard refusal.
    //
    // `refillPerSec: 2` is chosen defensively — it is NOT a measured ceiling and must not be cited
    // as one. It is 2.5× below the vendor's own published request rate and leaves the credit budget
    // reachable in hours rather than in two minutes. `capacity: 5` is unchanged: burst is not the
    // problem, sustained rate is, and 5 is also the floor that keeps a 3-token weighted call
    // satisfiable (see `WEIGHT_ADDRESS_INFO` in the adapter, and `throttle`'s own capacity guard).
    //
    // Still open and deliberately NOT solved here: nothing ACCOUNTS for the spend. `costOf` is 0,
    // there is no `usage` row and no budget gate — PLAN §3 ruled a Nansen-style gate out for a free
    // vendor as costing more than it buys. That stays true until the ceiling is actually reached,
    // at which point it becomes its own task with a measurement attached.
    rateLimit: { capacity: 5, refillPerSec: 2 },
    requiresEnv: [],
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
