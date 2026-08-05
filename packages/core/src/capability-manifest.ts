/**
 * Per-capability manifest (ADR-002 **D3**, R-136/R-137) — one declarative, committed literal
 * covering every routed capability, task 012-4.
 *
 * **Tier-1 configuration in the commit (D1).** These values live in a TypeScript literal, are
 * checked once when `CapabilityRegistry` is constructed (`adapters/registry.ts`, validation step 1)
 * and are held in process memory. Nothing here is in the cache DB or in Postgres.
 *
 * **The manifest describes the CALL, never the routing and never the price (R-137).** Which
 * adapters serve a capability is `providers.config.ts`; which chains they cover is
 * `chainSupport()`; what a call costs is `costOf()` plus the budget ledger. A `chains`/`providers`/
 * `price`/`cost` key here would be a second copy of a fact that already has an owner —
 * `capability-manifest.test.ts` rejects one both structurally and at compile time.
 *
 * **The cache stays PER-ADAPTER, including for `set`/`series`.** A manifest row does not create an
 * aggregate cache slot: an aggregate would have no owner to invalidate it and no TTL matching any
 * one source.
 *
 * ---------------------------------------------------------------------------------------------
 * ## How to read a `deadlineMs` / `paidLegMs` record (R-149, PLAN §0.2)
 *
 * A deadline here is a **ceiling the owner chose (OD-2/OD-3)**, not an envelope anyone measured.
 * The two numbers almost never coincide, so **every** record below names BOTH — the measured
 * envelope and the applied value — says which is which, and says what the ceiling cuts. A comment
 * carrying one number reads as a derivation while being a slice; that is how the number 410 s got
 * into a docstring by being repeated rather than derived. `capability-manifest.test.ts`'s
 * TC-UNIT-08 mechanises the two-number rule (and only that rule — it does not check the
 * arithmetic; the extended WI-28 gate in 012-5 does).
 *
 * The measured envelopes the rows cite, derived once here:
 *
 * - **E-HTTP15 = 90_000 ms** — ONE attempt of a free adapter that uses `safeFetch`'s
 *   `DEFAULT_TIMEOUT_MS = 15_000`: limiter wait up to `MAX_WAIT_MS = 30_000`
 *   (`net/rate-limit.ts`) + **4 hops × 15_000** (`net/safe-fetch.ts:26/32` arms
 *   `AbortSignal.timeout` INSIDE the redirect loop, and `MAX_REDIRECTS = 3` means four hops).
 * - **E-HTTP5 = 50_000 ms** — the same shape on an adapter that overrides
 *   `REQUEST_TIMEOUT_MS = 5_000` (`blockscout/index.ts`, `blockchain-info/index.ts`):
 *   30_000 + 4 × 5_000.
 * - **E-PG = ≥10_000 ms with an unbounded tail** — `pg-history`. **Not the HTTP template** and not
 *   the limiter one either: it speaks the Postgres wire protocol, so there are no redirect hops,
 *   and — measured, 2026-08-04 — its `fetch()` never awaits `throttle()` at all, so
 *   `MAX_WAIT_MS` does not enter its envelope even though the registration declares
 *   `{capacity: 2, refillPerSec: 0.2}`. What actually bounds it is
 *   `connectionTimeoutMillis = 10_000` (`pg/read-client.ts`'s `DEFAULT_CONNECTION_TIMEOUT_MS`) for acquiring a connection, plus
 *   the query itself, for which no `statement_timeout` is set anywhere — the tail is unbounded
 *   in-process. (PLAN §0.2a expected the limiter to bound this leg; reading the adapter says it is
 *   not called.)
 *
 *   **Both halves of that are TRACKED, and this comment is not their record** — a defect filed only
 *   inside a docstring about deadline numbers is findable by nobody looking for it:
 *   **WI-34** (`docs/backlog/wi-34-pg-history-ratelimit-declared-not-enforced.md`) — the declared
 *   `rateLimit` nothing enforces; **WI-35**
 *   (`docs/backlog/wi-35-pg-read-path-has-no-query-timeout.md`) — the missing query bound. Neither
 *   is fixed here (both are outside task 012-4, and the first changes adapter behaviour). If either
 *   lands, THIS envelope changes and both `*.history` rows below need a fresh derivation record in
 *   the same commit — a limiter wait would add up to `MAX_WAIT_MS`, a query bound would replace the
 *   unbounded tail with a number.
 * - **E-DASH = 0 ms** — `dash-platform` adds NOTHING to the five routes it shares with
 *   `platform-explorer`: `isAvailable()` is unconditionally `{ok:false}`
 *   (`dash-platform/index.ts`), so the registry skips it before any transport exists to wait on,
 *   and its `fetch()` throws `NotImplementedInM1Error`. **This number grows the day a live gRPC
 *   transport lands** (ARCHITECTURE.md §11) — a future reader must not inherit the 0 as a property
 *   of the adapter.
 *
 * `paidLegMs` is the **worst case over ARGUMENTS**, not a fixed sub-call count, and it is NOT
 * subject to the owner's cancellable-part tiers: after `checkAndReserve()` the credit is spent, so
 * cancelling would mean paying without receiving (ADR-002 D4 §2). Its applied value therefore
 * EQUALS its measured envelope — the record still names both, and says that nothing is cut.
 *
 * ---------------------------------------------------------------------------------------------
 * ## ENFORCEMENT — where a `deadlineMs` below is APPLIED, and where it is only DECLARED
 *
 * **Measured 2026-08-05 over the shipped registry** (`providers.config.ts` — 21 routes, 20
 * capabilities, 12 adapters), and this section exists because the per-row records below read as
 * statements about running code:
 *
 * - **2 of 12 adapters read the third `fetch(cap, args, deadlineAtMs)` argument at all** —
 *   `blockscout` (forwards it to `throttle()` and to `safeFetch`) and `nansen`. The other ten
 *   (`coingecko`, `dexscreener`, `defillama`, `rpc-evm`, `rpc-solana`, `platform-explorer`,
 *   `blockchain-info`, `dash-platform`, `pg-history`, `dune`) declare `fetch(cap, args)` and call
 *   `throttle(id, RATE_LIMIT)` with two arguments.
 * - **4 of 20 capabilities are therefore actually bounded by their row below** — `token.holders`,
 *   `entity.labels`, `smart-money.flows`, `token.risk`. For the other **16** the registry still
 *   refuses every source it has not yet REACHED (the pre-check in `adapters/registry.ts`), but no
 *   in-flight attempt is cancelled and no limiter wait is shortened: the ceiling is a declaration.
 *
 * **This is sanctioned, not a regression.** R-140e ("an adapter that ignores the parameter is not
 * broken by it") is the accepted staging, and task 012-8 wrote down that 11 of the 12 adapters were
 * in that state on the day it landed (ten, plus `nansen` which took it up in 012-9). What was NOT
 * sanctioned is a comment saying a ceiling "cuts 75_000" of a capability nothing cancels — so every
 * row below now says which of the two it is, and the gap is tracked as
 * `docs/backlog/wi-37-call-deadline-declared-but-unenforced-on-ten-adapters.md`.
 *
 * A row marked **ENFORCED TODAY** loses nothing when WI-37 lands. A row marked **DECLARED, not
 * enforced today** becomes enforced by that work item alone, with no edit here — which is the point
 * of writing the distinction down rather than adjusting the numbers.
 *
 * **Every one of the 20 rows carries its own marker, and a test counts them.** The first version of
 * this section marked the tier BLOCKS and left 11 rows with no findable claim of their own — the
 * defect F-5 is about, one level down: an assertion true in one place and absent in the others,
 * reported as complete. `capability-manifest.test.ts`'s **TC-F5-GATE** now requires exactly one
 * marker per routed capability AND checks each marker against a scan of the adapter sources, so the
 * 2-of-12 / 4-of-20 figures above are re-derived on every run instead of being transcribed. When
 * WI-37 lands, the markers must move with it or the gate goes red.
 *
 * **Every number below is a STARTING assignment.** R-148(e) wants each one measured against ITS
 * capability's envelope rather than rounded to the nearest tier; a later change arrives with its own
 * two-number record, never as a bare edit.
 */

/**
 * The fields every manifest row carries, whatever its `shape`.
 *
 * `ttlSeconds` and `deadlineMs` are REQUIRED — a capability that builds and runs without a deadline
 * is exactly the failure UC-1 names, and an optional field "just in case" is how that happens.
 * `shareable` (ADR-003 D5, first read in T-014) and `paidLegMs` are optional; `paidLegMs` is carried
 * ONLY by a capability whose route reaches a `tier: 'paid'` adapter (TC-UNIT-06 enforces both
 * directions — a defensive `paidLegMs` on a free capability fails the suite).
 */
interface CapabilityManifestBase {
  ttlSeconds: number;
  /** ONLY the cancellable part of the call (OD-3) — never the whole call, never the paid leg. */
  deadlineMs: number;
  /** First reader is ADR-003 D5 (T-014); no consumer exists in T-012. */
  shareable?: boolean;
  /** Only where the route reaches a `tier: 'paid'` adapter. */
  paidLegMs?: number;
}

/**
 * One capability's manifest — a **discriminated union on `shape`**, deliberately, and with an exact
 * statement of what that buys TODAY.
 *
 * Both branches currently differ **only** by the `shape` literal, so structurally the union is
 * interchangeable with a flat interface: a merge field added to `CapabilityManifestBase` would be
 * legal on `point` too. The union therefore does **not make the restriction effective** — it makes
 * it **expressible**. (An earlier draft claimed the union "is the whole of R-136(d)'s
 * forward-compatibility mechanism"; that overstatement is withdrawn.)
 *
 * **The obligation this shape hands to T-013.** T-013 adds the merge field to the `set | series`
 * branch ALONE, and in that same second "merging declared on a `point`" becomes a compile error —
 * with no rewrite of this type, and with the negative type-test that T-012 cannot write (there is no
 * field to name yet) becoming writable. Adding it to the BASE instead would silently give it back to
 * `point`.
 *
 * **Rejected here, and why** (task file F-5): declaring `mergeKey?: never` on the `point` branch to
 * make the restriction effective immediately. That pre-picks a NAME T-013 has not chosen — name the
 * field anything else and the guard protects a key nobody uses, with no input on which it fails. A
 * guard without such an input is barred by the same rule everywhere else in this task.
 *
 * `capability-manifest.test.ts`'s TC-UNIT-07 keeps this declaration a two-branch union until then.
 */
export type CapabilityManifest =
  | (CapabilityManifestBase & { shape: 'point' })
  | (CapabilityManifestBase & { shape: 'set' | 'series' });

/**
 * All 20 routed capabilities (`providers.config.ts` — 21 routes, 20 distinct capabilities;
 * `wallet.balances.native` is routed twice). TC-UNIT-01 enumerates the routes against this table and
 * TC-UNIT-02 the reverse, so neither a new route without a row nor a row for a retired capability can
 * survive a test run.
 *
 * **`shape`.** ADR-002 D3 classified eight by name. The other twelve were classified in task 012-4 by
 * READING the actual return type of each adapter's `normalize()`; the audit's result is recorded on
 * each row. The rule: one value about one subject → `point`; an unordered collection of homogeneous
 * elements → `set`; a `ts`-ordered run → `series`. The discriminator is the SUBSTANCE of the payload,
 * not whether the top-level return is an array — ADR-002 D3's own eight settle that, since
 * `wallet.balances.native` is `set` while `rpc-evm.normalize()` returns a single `Wallet` object
 * whose whole content is `balances[]`.
 *
 * **`ttlSeconds` are carried BYTE-FOR-BYTE from `cache/ttl.ts`'s `TTL_SECONDS`, with their
 * rationales.** Task 012-4 changes no TTL; TC-UNIT-05 pins every one of the 20 against a list frozen
 * before the move, so a TTL edit disguised as a migration fails. `ttlFor()` becomes a reader of this
 * table in 012-5 — until then `cache/ttl.ts` is still the live path and this is its copy.
 */
export const capabilityManifests: Readonly<Record<string, CapabilityManifest>> = {
  // ===========================================================================================
  // TIER ~15 s (OD-2) — one free adapter, one attempt, `DEFAULT_TIMEOUT_MS = 15_000`.
  //
  // **SCOPE OF THIS BANNER — the EIGHT capabilities declared between it and the next `=====`
  // banner, by name:** `token.price`, `token.metadata`, `pairs.new`, `pool.info`, `protocol.tvl`,
  // `chain.tvl`, `dex.volume.history`, `wallet.balances.native`. It covers no row outside that run
  // — `chain.supply` in particular belongs to the E-HTTP5 block below, not to this one. **And it is
  // not the enforcement record for any of them:** each of the 20 rows carries its OWN
  // `**ENFORCED TODAY**` / `**DECLARED, not enforced today**` marker, because a reader greps one
  // capability or reads one row in a diff, and a claim that lives only in a banner is invisible
  // there (adversarial cycle 2 review of F-5 — the first version of this section marked the block
  // and left 11 of the 20 rows with nothing findable in them). `capability-manifest.test.ts`'s
  // TC-F5-GATE enforces one marker per row and checks each against the adapter sources.
  //
  // All eight are DECLARED, not enforced today (see the ENFORCEMENT section above; measured
  // 2026-08-05). An earlier version of this banner said 15_000 is BELOW `MAX_WAIT_MS = 30_000`, so
  // "on a saturated token bucket these capabilities now refuse fast instead of sleeping up to 30 s",
  // and called that UC-7. That is true of the MECHANISM and false of these eight rows: `coingecko`,
  // `dexscreener`, `defillama`, `rpc-evm` and `rpc-solana` all call `throttle(id, RATE_LIMIT)` with
  // two arguments, so the limiter never sees this number and the wait is still capped only by
  // `MAX_WAIT_MS`. UC-7 is real where the deadline is threaded — `blockscout` (`token.holders`,
  // `entity.labels`) and `nansen` — and is what these rows will get from WI-37, with no edit here.
  //
  // The other side of the mechanism, unchanged and stated for the day it applies: a free vendor
  // that answers successfully but slower than 15 s starts being refused — the response to observing
  // that is to RAISE this capability's `deadlineMs` with a new two-number record, never to weaken
  // the mechanism.
  // ===========================================================================================
  'token.price': {
    // ADR-002 D3 names this one: one price for one token.
    shape: 'point',
    // Carried from `cache/ttl.ts` (ARCHITECTURE.md §3.2 row; no rationale comment there).
    ttlSeconds: 60,
    // measured envelope: 90_000 (E-HTTP15 — `coingecko`, one attempt). applied: 15_000 — the
    // OWNER's ~15 s tier (OD-2), a ceiling and not a measurement; it would cut 75_000 — the entire
    // redirect tail plus most of the limiter wait — on a route that read it.
    // **DECLARED, not enforced today** — `coingecko` calls `fetch(cap, args)` and
    // `throttle(id, RATE_LIMIT)`, so nothing here is cancelled or shortened (ENFORCEMENT; WI-37).
    deadlineMs: 15_000,
  },
  'token.metadata': {
    // AUDIT (012-4, OQ-T012-1): hypothesis `point`, CONFIRMED. `coingecko/index.ts:156` —
    // `normalize(): Token`, one canonical token record about one contract address.
    shape: 'point',
    ttlSeconds: 3600,
    // measured envelope: 90_000 (E-HTTP15 — `coingecko`, one attempt). applied: 15_000 — owner
    // ceiling (OD-2), not a measurement; would cut 75_000.
    // **DECLARED, not enforced today** — `coingecko` does not read the deadline (ENFORCEMENT; WI-37).
    deadlineMs: 15_000,
  },
  'pairs.new': {
    // AUDIT: hypothesis `set`, CONFIRMED. `dexscreener/index.ts:125` — `normalize(): Pool[]`, a
    // chain-filtered, `limit`-sliced batch with no ordering imposed (no sort anywhere in the
    // method), so it is a collection and not a `ts`-ordered run.
    shape: 'set',
    ttlSeconds: 30,
    // measured envelope: 90_000 (E-HTTP15 — `dexscreener`, one attempt). applied: 15_000 — owner
    // ceiling (OD-2), not a measurement; would cut 75_000.
    // **DECLARED, not enforced today** — `dexscreener` does not read the deadline (ENFORCEMENT; WI-37).
    deadlineMs: 15_000,
  },
  'pool.info': {
    // AUDIT: hypothesis `set`, CONFIRMED — and worth stating, because the NAME suggests otherwise.
    // `dexscreener/index.ts:125` ignores `_cap` entirely: both of this adapter's capabilities run
    // the same `normalize(): Pool[]`, so `pool.info` returns a collection, not one pool.
    shape: 'set',
    // Carried from `cache/ttl.ts`, with its rationale: "`pool.info` shares its adapter (dexscreener)
    // and its liquidity/volume-style volatility with `protocol.tvl`, not the
    // "new"-freshness-critical `pairs.new` — same 300s bucket."
    ttlSeconds: 300,
    // measured envelope: 90_000 (E-HTTP15 — `dexscreener`, one attempt). applied: 15_000 — owner
    // ceiling (OD-2), not a measurement; would cut 75_000.
    // **DECLARED, not enforced today** — `dexscreener` does not read the deadline (ENFORCEMENT; WI-37).
    deadlineMs: 15_000,
  },
  'protocol.tvl': {
    // AUDIT: hypothesis `point`, CONFIRMED. `defillama/index.ts:863` — the `protocol.tvl` branch
    // returns `ProtocolTvlResult`, one `tvlUsd`/`totalTvlUsd` pair for one protocol on one chain.
    shape: 'point',
    ttlSeconds: 300,
    // measured envelope: 90_000 (E-HTTP15 — `defillama`, one attempt). applied: 15_000 — owner
    // ceiling (OD-2), not a measurement; would cut 75_000.
    // **DECLARED, not enforced today** — `defillama` does not read the deadline (ENFORCEMENT; WI-37).
    deadlineMs: 15_000,
  },
  'chain.tvl': {
    // ADR-002 D3 names this one.
    shape: 'point',
    // Carried from `cache/ttl.ts`, with its rationale: "TASK-006 (task 006-7, R-53d): `/v2/chains`
    // is an aggregate DeFiLlama recomputes on its own cadence — a chain's total TVL does not move
    // meaningfully faster than a protocol's, so it gets the same 300s bucket as `protocol.tvl`
    // rather than a separately invented number."
    ttlSeconds: 300,
    // measured envelope: 90_000 (E-HTTP15 — `defillama`, one attempt). applied: 15_000 — owner
    // ceiling (OD-2), not a measurement; would cut 75_000.
    // **DECLARED, not enforced today** — `defillama` does not read the deadline (ENFORCEMENT; WI-37).
    deadlineMs: 15_000,
  },
  'dex.volume.history': {
    // AUDIT: hypothesis `series`, CONFIRMED — by substance, and the nuance is why the rule is
    // stated on the table above. `defillama/index.ts:338` returns ONE `DexVolumeResult` object, not
    // an array, so an "is the return an array?" test would have said `point`; its content is a
    // daily run explicitly sorted by `ts` (`points.sort((a, b) => a.ts - b.ts)`), day-bucketed and
    // de-duplicated, with `window`/`gapDays` describing that run. A `ts`-ordered run is `series`.
    shape: 'series',
    // Carried from `cache/ttl.ts`, with its rationale: "TASK-007 (task 007-1, R-64). The vendor's
    // own step for this dataset is ONE DAY (`totalDataChart` is `[[unix_ts, usd], …]` with an exact
    // 86400s stride — measured over 2825 points, 2824 of them exactly one day apart), so a TTL
    // shorter than a day cannot buy a fresher number. It can only buy a second identical 250KB
    // download."
    ttlSeconds: 3600,
    // measured envelope: 90_000 (E-HTTP15 — `defillama`, one attempt). applied: 15_000 — owner
    // ceiling (OD-2), not a measurement; would cut 75_000.
    // **DECLARED, not enforced today** — `defillama` does not read the deadline (ENFORCEMENT; WI-37).
    deadlineMs: 15_000,
  },
  'wallet.balances.native': {
    // ADR-002 D3 names this one.
    shape: 'set',
    ttlSeconds: 60,
    // measured envelope: 90_000 (E-HTTP15 — `rpc-evm`/`rpc-solana`, one attempt; the two routes are
    // per-chain alternatives, never a sequence: `chainSupport()` leaves exactly one of them
    // eligible for a given chain). applied: 15_000 — owner ceiling (OD-2), not a measurement;
    // would cut 75_000.
    // **DECLARED, not enforced today** — neither `rpc-evm` nor `rpc-solana` reads the deadline
    // (ENFORCEMENT; WI-37).
    deadlineMs: 15_000,
  },

  // ===========================================================================================
  // TIER ~15 s (OD-2) — one free adapter that overrides `REQUEST_TIMEOUT_MS = 5_000`.
  // Same applied ceiling, a different measured envelope: E-HTTP5 instead of E-HTTP15.
  // ===========================================================================================
  'token.holders': {
    // ADR-002 D3 names this one.
    shape: 'set',
    ttlSeconds: 3600,
    // measured envelope: 50_000 (E-HTTP5 — `blockscout`, one attempt: 30_000 + 4 × 5_000).
    // applied: 15_000 — owner ceiling (OD-2), not a measurement; cuts 35_000 — **ENFORCED TODAY**, the
    // route's only adapter `blockscout` forwards the deadline to `throttle()` and to `safeFetch`
    // (ENFORCEMENT above). Note the ceiling
    // does NOT follow the adapter's own faster timeout down: the tier is a property of the
    // capability, and `blockscout`'s 5 s is a property of one vendor.
    deadlineMs: 15_000,
  },
  'chain.supply': {
    // ADR-002 D3 names this one.
    shape: 'point',
    // Carried from `cache/ttl.ts`, with its rationale: "TASK-009 (R-82b). … 600s is the Bitcoin
    // target block interval: the value changes ONLY when a block is found, so a shorter TTL cannot
    // buy a fresher number, it can only buy a second identical pair of requests."
    ttlSeconds: 600,
    // measured envelope: 50_000 (E-HTTP5 — `blockchain-info`, one attempt: 30_000 + 4 × 5_000).
    // Its `fetch()` issues TWO readings, so the envelope of the whole call is twice that; the
    // cancellable unit the deadline governs is the attempt. applied: 15_000 — owner ceiling
    // (OD-2), not a measurement; would cut 35_000.
    // **DECLARED, not enforced today** — `blockchain-info` does not read the deadline
    // (ENFORCEMENT; WI-37). NOTE it is NOT covered by the ~15 s block banner above: this row sits
    // in the E-HTTP5 block, which is why every row carries its own marker.
    deadlineMs: 15_000,
  },

  // ===========================================================================================
  // TIER ~15 s — **OVERRIDE of an approved architecture number, declared as an override.**
  //
  // `system-architecture.md`'s "`deadlineMs`/`paidLegMs` by capability" table gives these five
  // ~30_000 under the "≤2 free adapters" tier. This file applies **~15_000**.
  //
  // **Why an override and not an alignment.** The second adapter of these five routes is
  // `dash-platform`, whose `isAvailable()` is unconditionally `{ok:false}` — it performs ZERO
  // network attempts (E-DASH = 0), so the route is single-LIVE-adapter and its measured envelope is
  // one E-HTTP15, not two. The architecture row's own derivation column already says
  // "`dash-platform` (unconditionally unavailable today)" while still counting it as an adapter of
  // the tier.
  //
  // **Condition for reverting.** The day a live gRPC transport lands for `dash-platform`
  // (ARCHITECTURE.md §11), E-DASH stops being 0, the route becomes genuinely two-adapter, and this
  // number goes back to the ~30_000 tier. That is a condition on the code, not a preference.
  //
  // **Hand-off, in order, so the number is not rewritten silently:** marked as an OVERRIDE here
  // (012-4) → the document edit in 012-5 lands **as an override with a one-line derivation**, never
  // as an alignment → the decision is closed in `open-questions.md` in 012-10. Skipping the first
  // step is defect form WI-24: the new WI-28 gate would accept the rewritten row as "matching".
  //
  // **Do NOT address the architecture row by line number.** Directly beneath it sits a VISUALLY
  // IDENTICAL ~30_000 row for `privacy.shielded_pool.history` + `platform.metrics.history`, which is
  // CORRECT (two live adapters in sequence, `platform-explorer` + `pg-history`) and is not touched.
  // The row this overrides is identified by its Capability list.
  // ===========================================================================================
  'privacy.shielded_pool': {
    // AUDIT: hypothesis `point`, CONFIRMED. `platform-explorer/index.ts:208` — the
    // `privacy.shielded_pool` branch returns a single `Snapshot` via `snapshotFromCurrentState()`
    // (one metric, one value, one instant); the `.history` sibling below is the array-returning one.
    // `dash-platform/index.ts:93` agrees: `normalize(): Snapshot`.
    shape: 'point',
    ttlSeconds: 3600,
    // measured envelope: 90_000 (E-HTTP15 — `platform-explorer` alone; `dash-platform` contributes
    // E-DASH = 0 and grows only when a live gRPC transport lands). applied: 15_000 — **OVERRIDE**
    // of the architecture's ~30_000, not an alignment: the route is single-live-adapter today (see
    // the banner). It is also the owner's ~15 s ceiling and not a measurement; it would cut 75_000.
    // **DECLARED, not enforced today** — `platform-explorer` does not read the deadline
    // (ENFORCEMENT above; WI-37).
    deadlineMs: 15_000,
  },
  'platform.identities': {
    // AUDIT: hypothesis `point`, CONFIRMED. `platform-explorer/index.ts` — single `Snapshot` from
    // `snapshotFromCurrentState({metric: identitiesTotal, …})`; one counter at one height.
    shape: 'point',
    ttlSeconds: 3600,
    // measured envelope: 90_000 (E-HTTP15 — `platform-explorer` alone; `dash-platform` = E-DASH 0,
    // grows with a live gRPC transport). applied: 15_000 — **OVERRIDE** of the architecture's
    // ~30_000 (single-live-adapter route, see the banner) and the owner's ceiling, not a
    // measurement; would cut 75_000. **DECLARED, not enforced today** — `platform-explorer` does not
    // read the deadline (ENFORCEMENT above; WI-37).
    deadlineMs: 15_000,
  },
  'platform.contracts': {
    // AUDIT: hypothesis `point`, CONFIRMED — single `Snapshot` (`dataContractsTotal`).
    shape: 'point',
    ttlSeconds: 3600,
    // measured envelope: 90_000 (E-HTTP15 — `platform-explorer` alone; `dash-platform` = E-DASH 0,
    // grows with a live gRPC transport). applied: 15_000 — **OVERRIDE** of the architecture's
    // ~30_000 (single-live-adapter route, see the banner) and the owner's ceiling, not a
    // measurement; would cut 75_000. **DECLARED, not enforced today** — `platform-explorer` does not
    // read the deadline (ENFORCEMENT above; WI-37).
    deadlineMs: 15_000,
  },
  'platform.documents': {
    // AUDIT: hypothesis `point`, CONFIRMED — single `Snapshot` (`documentsTotal`).
    shape: 'point',
    ttlSeconds: 3600,
    // measured envelope: 90_000 (E-HTTP15 — `platform-explorer` alone; `dash-platform` = E-DASH 0,
    // grows with a live gRPC transport). applied: 15_000 — **OVERRIDE** of the architecture's
    // ~30_000 (single-live-adapter route, see the banner) and the owner's ceiling, not a
    // measurement; would cut 75_000. **DECLARED, not enforced today** — `platform-explorer` does not
    // read the deadline (ENFORCEMENT above; WI-37).
    deadlineMs: 15_000,
  },
  'platform.credits': {
    // AUDIT: hypothesis `point`, CONFIRMED — single `Snapshot` (`platformTotalCredits`).
    shape: 'point',
    ttlSeconds: 3600,
    // measured envelope: 90_000 (E-HTTP15 — `platform-explorer` alone; `dash-platform` = E-DASH 0,
    // grows with a live gRPC transport). applied: 15_000 — **OVERRIDE** of the architecture's
    // ~30_000 (single-live-adapter route, see the banner) and the owner's ceiling, not a
    // measurement; would cut 75_000. **DECLARED, not enforced today** — `platform-explorer` does not
    // read the deadline (ENFORCEMENT above; WI-37).
    deadlineMs: 15_000,
  },

  // ===========================================================================================
  // TIER ~30 s (OD-2) — up to two free adapters walked SEQUENTIALLY.
  // `platform-explorer` (HTTP) then `pg-history` (Postgres wire protocol — E-PG, not the HTTP
  // template). This is the architecture row that is CORRECT and stays untouched.
  // ===========================================================================================
  'privacy.shielded_pool.history': {
    // ADR-002 D3 names this one.
    shape: 'series',
    // Carried from `cache/ttl.ts`, with its rationale: "The two `*.history` capabilities are
    // historical views of an already-3600s-bucketed live capability; the table's own stated
    // rationale for that 3600s row ("no point polling faster than the existing hourly snapshotter
    // cadence") applies identically to their history counterparts."
    ttlSeconds: 3600,
    // measured envelope: 100_000 with an unbounded tail — 90_000 (E-HTTP15, `platform-explorer`)
    // + E-PG (`pg-history`: ≥10_000 to acquire a connection, then a query nothing in-process
    // bounds; no redirect hops and no limiter wait, because that adapter never calls `throttle()`).
    // applied: 30_000 — owner ceiling (OD-2), not a measurement; it would cut ≥70_000.
    // **DECLARED, not enforced today** — and this row carried the strongest version of the false
    // claim: an earlier record called this ceiling "the only in-process bound the pg leg's tail
    // has at all". `pg-history` is handed no deadline (`fetch(cap, args)`) and `platform-explorer`
    // reads none either, so the tail has NO in-process bound — which is WI-35, not this number
    // (ENFORCEMENT above; WI-37).
    deadlineMs: 30_000,
  },
  'platform.metrics.history': {
    // ADR-002 D3 names this one.
    shape: 'series',
    // Carried from `cache/ttl.ts` — same rationale as the row above (the two `*.history`
    // capabilities are historical views of an already-3600s-bucketed live capability).
    ttlSeconds: 3600,
    // measured envelope: 100_000 with an unbounded tail — 90_000 (E-HTTP15, `platform-explorer`)
    // + E-PG (`pg-history`: ≥10_000 connection acquisition plus an unbounded query; not the HTTP
    // template — no hops, and no limiter wait, since that adapter never calls `throttle()`).
    // applied: 30_000 — owner ceiling (OD-2), not a measurement; it would cut ≥70_000.
    // **DECLARED, not enforced today** — neither `platform-explorer` nor `pg-history` reads the
    // deadline, so the pg tail has no in-process bound at all (that gap is WI-35; the unenforced
    // ceiling is WI-37, ENFORCEMENT above).
    deadlineMs: 30_000,
  },

  // ===========================================================================================
  // TIER ~60 s (OD-2) — paid composites. The tier bounds the **cancellable part only** (OD-3):
  // everything before `checkAndReserve()`. `paidLegMs` below it is a separate, uncut number.
  // ===========================================================================================
  'entity.labels': {
    // ADR-002 D3 names this one.
    shape: 'set',
    // Carried from `cache/ttl.ts`, with its rationale: "Entity/profiler labels change on a
    // timescale of DAYS (ENS, CEX, fund attributions). This is also the most expensive call in the
    // system — the `exhaustive: true` escalation is 100cr, the entire free-plan balance. At the old
    // 300s fallback, an agent revisiting one address four times across a 25-minute investigation
    // paid 400cr instead of 100cr. 1 hour is still conservative."
    ttlSeconds: 3600,
    // measured envelope: 140_000 of cancellable work — 50_000 (E-HTTP5, the free `blockscout`
    // attempt the route tries first) + 90_000 (E-HTTP15, nansen's cold-start `/account` budget
    // resync, which runs BEFORE any reservation and is therefore still cancellable).
    // applied: 60_000 — the OWNER's ~60 s tier (OD-2), a ceiling and not a measurement; it cuts
    // 80_000, i.e. it can abort the free attempt or the resync, and only those.
    // **ENFORCED TODAY** — both adapters on this route (`blockscout`, `nansen`) read the deadline.
    deadlineMs: 60_000,
    // measured envelope: 270_000 — worst case over ARGUMENTS, not a fixed count: the default /
    // token-scoped tier issues 2 OR 3 sub-calls under ONE reservation (`nansen/reconcile.ts:8`), so
    // the published bound is 3 × 90_000 (E-HTTP15 each). applied: 270_000 — EQUAL to the measured
    // envelope, and nothing is cut: OD-2/OD-3's tiers bound the cancellable part only, and after
    // `checkAndReserve()` the credit is already spent (ADR-002 D4 §2 — cancelling here would mean
    // paying and not receiving).
    paidLegMs: 270_000,
  },
  'smart-money.flows': {
    // AUDIT (012-4, OQ-T012-1): the plan left this one "to be confirmed". Read: `nansen/index.ts:745`
    // → `normalizeSmartMoneyFlow(): SmartMoneyFlow` — ONE record about ONE token (four netflow
    // scalars). It embeds a bounded `topHolders[]`, which is enrichment, not the subject: unlike
    // `Wallet`, whose entire substance IS its `balances[]`, dropping `topHolders` would still leave
    // the answer this capability exists to give. → `point`.
    shape: 'point',
    // Carried from `cache/ttl.ts`, with its rationale: "Genuinely volatile: `netflow1hUsd` is a
    // 1-hour rolling window, so a short TTL is correct here. (300s coincides with the old fallback
    // — but now by decision, not by omission.) 10cr/miss."
    ttlSeconds: 300,
    // measured envelope: 90_000 of cancellable work (E-HTTP15 — the cold-start `/account` resync;
    // the route has no free adapter in front of nansen, so there is nothing else before the
    // reservation). applied: 60_000 — owner ceiling (OD-2), not a measurement; it cuts 30_000 of
    // that resync — **ENFORCED TODAY** (`nansen` reads the deadline).
    deadlineMs: 60_000,
    // measured envelope: 180_000 — 2 × 90_000 (E-HTTP15 each), the two sub-calls this capability
    // always issues under one reservation (`/smart-money/netflow` + `/tgm/holders`, M-3 /
    // `nansen/reconcile.ts:8`). applied: 180_000 — EQUAL to the measurement, nothing cut: the paid
    // leg is outside the owner's cancellable-part tiers (ADR-002 D4 §2).
    paidLegMs: 180_000,
  },
  'token.risk': {
    // AUDIT: the plan left this one "to be confirmed". Read: `nansen/index.ts:749` →
    // `normalizeTokenRiskScore(): TokenRiskScore` — ONE verdict about ONE token address. Its two
    // indicator arrays are the detail OF that verdict (kept separate, never flattened), not a
    // collection of peer subjects. → `point`.
    shape: 'point',
    // Carried from `cache/ttl.ts`, with its rationale: "Nansen Score risk/reward indicators are
    // daily-ish quantitative scores, not tick data; caching for 30 minutes costs no meaningful
    // freshness. 6cr/miss."
    ttlSeconds: 1800,
    // measured envelope: 90_000 of cancellable work (E-HTTP15 — the cold-start `/account` resync;
    // nansen is the only adapter on this route). applied: 60_000 — owner ceiling (OD-2), not a
    // measurement; it cuts 30_000 of that
    // resync — **ENFORCED TODAY** (`nansen` reads the deadline).
    deadlineMs: 60_000,
    // measured envelope: 180_000 — 2 × 90_000 (E-HTTP15 each): `/tgm/indicators` +
    // `/tgm/token-information`, both paid under one reservation (`nansen/reconcile.ts:8`).
    // applied: 180_000 — EQUAL to the measurement, nothing cut (ADR-002 D4 §2).
    paidLegMs: 180_000,
  },
};
