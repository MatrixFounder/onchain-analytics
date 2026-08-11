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
 * what the literal used to do for `wallet.balances.native` (`rpc-evm` vs `rpc-solana`).
 *
 * **task 012-1 (OQ-C): the `chains?: Chain[]` field itself is gone from `CapabilityRoute`.** An
 * audit of all 21 routes below found none setting it — TASK-006 removed the only mechanism that
 * READ it here, but left the field declared and still honoured by `CapabilityRegistry.resolve()`'s
 * filter, which meant two agreeing-by-coincidence mechanisms could still silently drift apart on a
 * future route. There is now exactly one place chain coverage is decided: `chainSupport()`.
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
  { capability: 'chain.tvl.history', adapterIds: ['defillama'] },
  { capability: 'protocol.list', adapterIds: ['defillama'] },
  { capability: 'protocol.tvl.history', adapterIds: ['defillama'] },
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
  //
  // **T-013 task 013-6 (ADR-002 D6): merge ACTIVATED here, and on these two routes alone.**
  // `merge: true` is the ACTIVATION half; the eligibility half is `mergeable: true` on the
  // capability's manifest row (013-1), and `CapabilityRegistry`'s constructor refuses a route that
  // has one without the other (validation step 3, 013-2, R-183). `adapterIds` order is UNCHANGED
  // and must stay so: it is simultaneously the spend rule (free-first, D5) and the conflict rank —
  // when both participants hold a point for the same `(metric, asset, hour)`, `platform-explorer`
  // wins because it is first here, not because of anything the merge code decides.
  //
  // The two routes are commented SEPARATELY, because D6's three reasons do NOT apply equally to
  // them, and one comment covering both would state something false about one of them.
  {
    // D6 reason 1 (a shared identity key): mechanically yes, factually never exercised — the key
    // works, and it never collides, because the two participants write DIFFERENT metrics.
    // D6 reason 2 (both participants free): YES, same as above.
    // 🔴 D6 reason 3 (gap filling): **NOT APPLICABLE, and saying so is the point of this comment.**
    // `platform-explorer` writes `shielded_pool_shield_amount` (inflow INTO the pool, per
    // transaction, from `/transactions/shield/history`); `pg-history` reads back
    // `shielded_pool_balance_credits` (the BALANCE, written hourly by the n8n snapshotter). Those
    // are two different quantities under one capability name, deliberately kept under distinct
    // metric ids (`packages/core/.AGENTS.md`, "under a DISTINCT metric id … to avoid implying it's
    // the same quantity"). Merging them does not produce a fuller history of one series — it
    // produces both series, side by side, each under its own true label.
    //
    // That is not a defect and it is not a fix waiting to happen: the owner closed `OQ-T013-1` on
    // 2026-08-05 by choosing to merge anyway and GROUP THE TOOL'S ANSWER BY `metric` (013-7,
    // R-171(b)), rather than by rewriting either adapter's metric vocabulary. The n8n snapshotter
    // has never written `shielded_pool_shield_amount`, so there is nothing for `pg-history` to read
    // even if the schema were changed — which is why the schema change was rejected, not deferred.
    capability: 'privacy.shielded_pool.history',
    adapterIds: ['platform-explorer', 'pg-history'],
    merge: true,
  },
  {
    // D6 reason 1 (a shared identity key): YES — `identities_total` is genuinely the same series
    // over time from both participants, so the dedup key does real work.
    // D6 reason 2 (both participants free): YES — `platform-explorer` is keyless, `pg-history` is
    // our own Postgres. No merged call can spend a credit.
    // D6 reason 3 (gap filling): YES, and this is the route where it is the point —
    // `documents_total`, `data_contracts_total` and `platform_total_credits` exist ONLY in
    // `pg-history`; `platform-explorer`'s history endpoint writes `identities_total` and nothing
    // else. Before merge, those three were unreachable through this capability.
    capability: 'platform.metrics.history',
    adapterIds: ['platform-explorer', 'pg-history'],
    merge: true,
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
  // H-1 (vdd-multi TASK-008) — `policy` is the other half of that spend rule. Order alone was
  // not enough: the registry falls through only on a THROW, so `blockscout` truthfully answering
  // "I have no tags for this address" terminated the route and shadowed nansen for the whole
  // `ttlFor('entity.labels') = 3600` window — which is the ordinary case, not the tail (the
  // recorded USDC probe has empty tags). Fixing it inside the adapter would have meant teaching
  // `blockscout` that nansen exists; the policy belongs here, as data, beside the order it refines.
  //
  // task 012-6 (ADR-002 D2): was a literal predicate, is now a descriptor resolved against the
  // class dictionary in `adapters/policy.ts` when the registry is constructed. Same verdict on
  // every TASK-008 fixture, with ONE deliberate tightening: the retired literal tested
  // `typeof name === 'string'`, so an entry whose `name` was the EMPTY STRING satisfied it —
  // exactly the contentless record H-1 is about. `test/policy.test.ts` pins both the equivalence
  // and the divergence.
  {
    capability: 'entity.labels',
    adapterIds: ['blockscout', 'nansen'],
    policy: { kind: 'someElementHasAny', fields: ['name', 'tags', 'labels'] },
  },
  { capability: 'token.risk', adapterIds: ['nansen'] },
  // R-82 (TASK-009) — BTC supply, keyless and free. The narrowest route in this table: one adapter,
  // one chain.
  //
  // `mempool.space` serves the same subject and is deliberately ABSENT — from this route, from
  // `adapterRegistrations` below, and from every allowlist. It is the eval's independent reference,
  // and a source the engine answers from cannot be the check on that answer. Adding it here would
  // quietly delete the only thing that makes the cross-check mean anything.
  { capability: 'chain.supply', adapterIds: ['blockchain-info'] },
];

/**
 * Declarative per-adapter registration (D4/R-4/R-25/R-26, ARCHITECTURE.md §3.2/§5.3 — values
 * copied literally from there). `hosts` is the SSRF allowlist source-of-truth for THAT adapter
 * only (§7.2); `rateLimit` feeds the per-provider token-bucket limiter (R-26) — conservative
 * starting values, not documented vendor limits (except Dune's credit budget), tunable here
 * without touching call-site code; `requiresEnv` is informational only (the adapter's own
 * `isAvailable()` is the actual availability decision).
 *
 * **12 entries** (ARCHITECTURE.md §3.2/§5.3), every one now backed by a real adapter. This comment
 * used to read "exactly 9 entries — no real adapter implementation exists for any of them yet",
 * which described the M1 config-only state and stopped being true across tasks 003-4/003-5
 * (M1 adapters) and 005-1 (`nansen`, the 10th and the first PAID one). It then read "10 entries"
 * for a whole two tasks after TASK-008 (`blockscout`) and TASK-009 (`blockchain-info`) had made it
 * twelve — corrected in task 012-2, the task that edits all twelve entries anyway.
 * `dune` is the one entry whose adapter is deliberately still an interface stub — its
 * `isAvailable()` is unconditionally `{ok:false}` until a query is authored.
 *
 * **`tier` and `trust` (task 012-2, ADR-002 D8 + the D9 slice) are REQUIRED on every entry.**
 * `tier` is the ONE classification of paidness in the codebase and is a static property of the
 * VENDOR RELATIONSHIP — never derived from `costOf()`, which varies with the arguments and the live
 * account plan. `trust` ranks how editable the returned CONTENT is; in T-012 it is declare-only,
 * read by nothing but `assertValidAdapterRegistrations()` (R-155), and the two non-obvious
 * assignments — `platform-explorer` and `pg-history` — are owner decision **OD-5 (2026-08-03)**,
 * with the reasoning recorded inline at each. Both fields' full contracts live on
 * `AdapterRegistration` in `adapters/types.ts`; the assignments are pinned by name in
 * `test/adapter-registrations.test.ts` rather than restated here, so this docstring cannot drift
 * away from the literals below it.
 */
export const adapterRegistrations: AdapterRegistration[] = [
  {
    id: 'coingecko',
    hosts: ['api.coingecko.com', 'pro-api.coingecko.com'],
    rateLimit: { capacity: 10, refillPerSec: 0.5 },
    requiresEnv: [],
    tier: 'free',
    // Named `authoritative` by ADR-002 D9 itself.
    trust: 'authoritative',
  },
  {
    id: 'dexscreener',
    hosts: ['api.dexscreener.com'],
    rateLimit: { capacity: 5, refillPerSec: 1 },
    requiresEnv: [],
    tier: 'free',
    // Not named by D9; ranked by the scale's own question (is the CONTENT editable by outsiders?) —
    // vendor-observed DEX pair/pool data, nobody submits it.
    trust: 'authoritative',
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
    tier: 'free',
    // Named `authoritative` by ADR-002 D9 itself.
    trust: 'authoritative',
  },
  // interface/config-stub in M1 — isAvailable() unconditionally returns false (§3.2 decision):
  {
    id: 'dune',
    hosts: ['api.dune.com'],
    rateLimit: { capacity: 2, refillPerSec: 0.1 },
    requiresEnv: ['DUNE_API_KEY'],
    // PAID. `tier` describes the VENDOR RELATIONSHIP, not today's implementation: the adapter is
    // still an interface stub whose `costOf()` returns 0 and whose `isAvailable()` is
    // unconditionally false, but Dune's Query API is credit-metered and the registration is what
    // the paid-boundary machinery reads. Deriving this from `costOf()` would have read `free`.
    tier: 'paid',
    trust: 'authoritative',
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
    // thresholds) it cannot get one from the vendor: `docs/tasks/task-008-blockscout-free-tier.md`
    // §1.2 records that these responses carry
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
    tier: 'free',
    // ADR-002 D9's own worked example, quoted: "everything it hands back is edited by outsiders".
    // The token/address metadata behind `entity.labels` is user-submitted, so the rank is a fact
    // about the CONTENT — it says nothing about the vendor's competence or the API's reliability.
    trust: 'community',
  },
  {
    id: 'rpc-evm',
    hosts: ['ethereum-rpc.publicnode.com', 'eth.drpc.org'],
    rateLimit: { capacity: 5, refillPerSec: 1 },
    requiresEnv: [],
    tier: 'free',
    // Consensus data read straight off a node — the chain itself is the origin.
    trust: 'authoritative',
  },
  {
    id: 'rpc-solana',
    hosts: ['api.mainnet-beta.solana.com'],
    rateLimit: { capacity: 5, refillPerSec: 1 },
    requiresEnv: [],
    tier: 'free',
    // Consensus data read straight off a node — the chain itself is the origin.
    trust: 'authoritative',
  },
  // F-3: no live host in M1 — interface + fixture-contract only; hosts get filled in whenever the
  // deferred backlog task for a live gRPC transport lands (§11):
  {
    id: 'dash-platform',
    hosts: [],
    rateLimit: { capacity: 5, refillPerSec: 1 },
    requiresEnv: [],
    tier: 'free',
    // Consensus data (Platform's own state) — the chain itself is the origin.
    trust: 'authoritative',
  },
  {
    id: 'platform-explorer',
    hosts: ['platform-explorer.pshenmic.dev'],
    rateLimit: { capacity: 5, refillPerSec: 1 },
    requiresEnv: [],
    tier: 'free',
    // **Owner decision OD-5 (2026-08-03), closing OQ-T012-2 — NOT a default.** The operator is a
    // community one, and the first instinct was to read that as `community`. D9's scale asks about
    // the EDITABILITY OF THE CONTENT, not the officialness of the operator: these are counters
    // machine-aggregated from the chain, which no outsider can edit, so `community` would describe
    // them incorrectly. The mislabel would also have been expensive rather than cosmetic — this is
    // the very source ADR-002 D6 turns merging on FIRST (routes `privacy.shielded_pool.history`
    // and `platform.metrics.history`), so a wrong rank would ship inside the first merge we deliver.
    trust: 'authoritative',
  },
  // NEW (F-2) — not an HTTP host: Postgres wire protocol; the DSN itself is the access control,
  // not a hostname allowlist, so `hosts: []` is empty by nature rather than by omission.
  //
  // **`rateLimit` is APPLIED since WI-34.** This comment used to end "registered here purely for the
  // providers-FK reason (§4.2)", which read the whole row as decoration — true of the rate limit for
  // as long as no code called the limiter, and the reason PLAN §0.2a derived a call envelope through
  // a control that did not exist. `pg-history.fetch()` now awaits
  // `throttle('pg-history', RATE_LIMIT, 1, deadlineAtMs)`, and that wait is 30_000 of the E-PG
  // envelope the two `*.history` deadlines come from. The pool's `max: 3` bounds CONCURRENCY, a
  // different quantity, and never was this limit.
  //
  // **T-013 task 013-6: RE-DERIVED from `{capacity: 2, refillPerSec: 0.2}` at the moment merge was
  // activated, because activation is what invalidated the old number's premise.**
  //
  // One token per five seconds was sized for a SPARE LEG. Before merge, this adapter was asked only
  // when `platform-explorer` threw — the route's default `{kind: 'any'}` policy is satisfied by the
  // first answer, so in practice `pg-history` was almost never reached. The merge walk removes that
  // early return: from now on EVERY merged cache-miss takes a token, and the bucket is per PROVIDER,
  // so both merged capabilities draw from the same one.
  //
  // The arithmetic on the old number (`createThrottle`, found by 013-4's performance critic as
  // HIGH-1 and deliberately left for this task): on a cold bucket, eight consecutive cache-miss
  // calls wait 0, 0, 5 000, 10 000, 15 000, 20 000, 25 000 ms, and the eighth exceeds the 30 000 ms
  // ceiling with `DeadlineWouldExceedError`. That is ~12 merged calls per minute for BOTH
  // capabilities together — a ceiling the 3 600 s TTL hides until an agent varies its arguments,
  // which is precisely what the 013-7 tool invites it to do.
  //
  // **Why re-derive rather than document the old number as intentional** (the task file offered
  // both): a limiter exists to protect a VENDOR from us and us from a vendor's ban. `pg-history` is
  // not a vendor — it is our own Postgres, reached over our own network, with no quota and no terms
  // of service. Writing "12 calls/minute is deliberate" would be dressing a known bottleneck as a
  // decision, and the task file predicts exactly where it would surface as a defect instead.
  //
  // `{capacity: 10, refillPerSec: 5}` — the same pair `defillama` carries, the most generous free
  // entry in this table. Still a real runaway guard (a loop cannot exceed 5 queries/s sustained),
  // but no longer a ceiling on ordinary use. The pool's `max: 3` continues to bound CONCURRENCY,
  // which this number never governed.
  {
    id: 'pg-history',
    hosts: [],
    rateLimit: { capacity: 10, refillPerSec: 5 },
    requiresEnv: ['ONCHAIN_PG_URL'],
    tier: 'free',
    // **PLACEHOLDER with an assigned replacement — do NOT "correct" this to `authoritative`.**
    // Owner decision OD-5 (2026-08-03), closing OQ-T012-3. This is deliberately the LOWEST rank on
    // the scale, and it is NOT a judgement about our own ledger: trust in this adapter is a
    // property of the individual ROW (its `source` column — `derived` rows are computed by us,
    // vendor rows carry the vendor's own rank), and `AdapterRegistration` has no per-row
    // expressiveness at all. Until the real per-row mechanism exists — the `source → trust`
    // dictionary in **T-016** — the conservative rank is the one that over-values nothing.
    // Replacing it before T-016 lands would be an upgrade with no mechanism behind it.
    trust: 'community',
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
    // PAID — named as such by ADR-002 D9, and the only registration whose adapter actually spends
    // credits today. Note what `tier` does NOT come from: `nansen`'s `costOf()` prices per endpoint
    // off a real table under the live account plan, so it varies per call while this does not.
    tier: 'paid',
    trust: 'authoritative',
  },
  // 12th entry — TASK-009 (R-81), keyless and secret-free. `requiresEnv` is empty not by grace (as
  // with `blockscout`, where a key exists but is not yet enforced) but because the vendor offers no
  // key for these surfaces at all.
  //
  // ONE host: `blockchain.info` and `api.blockchain.info` were measured serving both `/q/*` and
  // `/stats` identically (2026-07-29, HTTP 200 each). A second entry would widen the set of hosts a
  // misbehaving endpoint can redirect us to — `safeFetch` re-checks every hop against this list —
  // and buy nothing, which is the L-4 lesson TASK-008 recorded the hard way.
  //
  // The limiter is DEFENSIVE and must not be cited as a measured ceiling: the vendor publishes no
  // rate limit and sends no `RateLimit-*` or `Retry-After` header, so there is nothing to calibrate
  // against. Five rapid probes returned 200 and that is the whole of what we know. One call per
  // second is far under anything plausible and still far above what this capability needs — the
  // value it serves changes once per ten minutes, which is also its TTL.
  {
    id: 'blockchain-info',
    hosts: ['blockchain.info'],
    rateLimit: { capacity: 5, refillPerSec: 1 },
    requiresEnv: [],
    // FREE — keyless, no account, nothing metered. This is the registration that makes the
    // "`tier` is never derived from `costOf()`" rule concrete rather than theoretical: this
    // adapter's `costOf()` returns `Number.POSITIVE_INFINITY` when it is switched off by
    // configuration (a fail-closed toggle, see its own docstring), and a `costOf() > 0 ⇒ paid`
    // reading would therefore classify a free vendor as paid the moment someone disables it.
    tier: 'free',
    // Objective chain aggregates published by the vendor; no user submissions in this surface.
    trust: 'authoritative',
  },
];
