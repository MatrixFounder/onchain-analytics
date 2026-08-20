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
 * - **E-PG = 50_000 ms** — `pg-history`. **Not the HTTP template**: it speaks the Postgres wire
 *   protocol, so there are no redirect hops. Limiter wait up to `MAX_WAIT_MS = 30_000`
 *   (`net/rate-limit.ts`) + the in-process query bound of 20_000
 *   (`pg/read-client.ts`'s `DEFAULT_QUERY_TOTAL_TIMEOUT_MS`), which is itself the ceiling over
 *   `connectionTimeoutMillis = 10_000` for acquiring a connection and `statement_timeout = 5_000`
 *   for running the statement — the two bounds NESTED inside it, hence a sum and not an addend.
 *
 *   **This number replaced "≥10_000 with an unbounded tail" when WI-34 and WI-35 landed together
 *   (2026-08-05), and the previous version is worth keeping visible** because it is what a reader
 *   would otherwise re-derive from an old comment. Until then this adapter's `fetch()` never awaited
 *   `throttle()` at all — so `MAX_WAIT_MS` did not enter its envelope even though the registration
 *   declared `{capacity: 2, refillPerSec: 0.2}` — the pair shipped THEN; task 013-6 re-derived it to
 *   `{capacity: 10, refillPerSec: 5}` when merge activation made this adapter a hot path, which does
 *   NOT move the envelope above: that addend is `MAX_WAIT_MS`, a constant of the limiter, not a
 *   function of the bucket — (**WI-34**,
 *   `docs/backlog/wi-34-pg-history-ratelimit-declared-not-enforced.md`) — and no bound of any kind
 *   applied to the query, making it the only I/O path in the package that could wait forever
 *   (**WI-35**, `docs/backlog/wi-35-pg-read-path-has-no-query-timeout.md`). PLAN §0.2a had assumed
 *   the limiter bounded this leg; it now does, and the assumption and the code agree for the first
 *   time. Both `*.history` rows below carry the resulting derivation.
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
 * **Measured 2026-08-05, re-measured 2026-08-11** over the shipped registry (`providers.config.ts` — 24 routes, 23
 * capabilities, 12 adapters), and this section exists because the per-row records below read as
 * statements about running code. **The dated pair is kept as it was measured (R-23.6); the live
 * registry today holds 28 routes over 27 capabilities, still 12 adapters.**
 *
 * - **10 of 12 adapters read the third `fetch(cap, args, deadlineAtMs)` argument** — `blockscout`,
 *   `nansen`, `coingecko`, `dexscreener`, `defillama`, `rpc-evm`, `rpc-solana`, `platform-explorer`,
 *   `blockchain-info`, `pg-history`. Each forwards it to the limiter
 *   (`throttle(id, RATE_LIMIT, weight, deadlineAtMs)`) and to its transport — `safeFetch` for the
 *   nine HTTP ones, `read-client.ts`'s query bound for `pg-history` — **except at the two points
 *   where forwarding it would be wrong**: `nansen` stops at `checkAndReserve()`, because cancelling
 *   after payment means paying without receiving (ADR-002 D4 §2), and `defillama`'s two
 *   shared-document capabilities bound the CALLER'S WAIT instead of the download, because the
 *   document is shared and one caller's expiry must not abort a transfer another is still awaiting.
 *   "Unchanged" describes the value where it IS forwarded — never re-derived as a remainder.
 * - **The remaining two — `dune` and `dash-platform` — are EXEMPT because they cannot spend time.**
 *   Both are M1 stubs: `isAvailable()` is unconditionally `{ok:false}`, so the registry skips them
 *   before any transport exists to wait on, and `fetch()` throws `NotImplementedInM1Error`. That is
 *   the same fact as E-DASH = 0 above. The exemption is DERIVED — `capability-manifest.test.ts` puts
 *   an adapter in the population by whether it imports a transport module at all, so the day a live
 *   gRPC transport lands for `dash-platform` (ARCHITECTURE.md §11) it enters the population and the
 *   five rows it routes go red until it reads the deadline. It is not an id list somebody maintains.
 * - **27 of 27 capabilities are therefore actually bounded by their row below.** The three added
 *   earlier on 2026-08-11 (`chain.tvl.history`, `protocol.list`, `protocol.tvl.history`) enter on the
 *   same two `defillama` mechanisms already described: the first two are served from SHARED
 *   documents, so the ceiling bounds the caller's wait, and the third is the one per-call route left
 *   in this adapter, so it reaches `throttle()` and `safeFetch` directly. The two added later that
 *   day (WI-51's `gas.price` and `chain.transactions`) enter on the strongest form of all: neither
 *   has a shared-document path, so on every leg — `rpc-evm`'s endpoint loop and `blockscout`'s
 *   single request — the ceiling can abort work in flight rather than only refuse to start it.
 *   WI-52's `protocol.incidents` (2026-08-11) returns to the shared-document form: two documents,
 *   both awaited under the ceiling, neither download cancelled by it.
 *
 * **How this section read before WI-37, and why the distinction was worth writing down.** Until
 * 2026-08-05 the figures were 2 of 12 and 4 of 20: `blockscout` (012-8) and `nansen` (012-9) were the
 * only adapters that read the parameter, and for the other 16 capabilities the registry still refused
 * every source it had not yet REACHED (the pre-check in `adapters/registry.ts`) while no in-flight
 * attempt was cancelled and no limiter wait shortened. That staging was sanctioned — R-140e, "an
 * adapter that ignores the parameter is not broken by it". What was NOT sanctioned was a comment
 * saying a ceiling "cuts 75_000" of a capability nothing cancelled; adversarial cycle 2's F-5
 * replaced fourteen such claims with the per-row markers below, and
 * `docs/backlog/wi-37-call-deadline-declared-but-unenforced-on-ten-adapters.md` tracked the
 * behaviour until this commit closed it.
 *
 * **Every one of the 27 rows carries its own marker, and a test counts them.** The first version of
 * this section marked the tier BLOCKS and left 11 rows with no findable claim of their own — the
 * defect F-5 is about, one level down: an assertion true in one place and absent in the others,
 * reported as complete. `capability-manifest.test.ts`'s **TC-F5-GATE** requires exactly one marker
 * per routed capability AND checks each marker against a scan of the adapter sources, so the
 * 10-of-12 / 20-of-20 figures above are re-derived on every run instead of being transcribed. The
 * markers moved with the code in this commit because the gate would otherwise be red — which is what
 * writing the distinction down was for.
 *
 * **`**DECLARED, not enforced today**` is now unused, and stays spelled out here on purpose.** It is
 * still the marker TC-F5-GATE expects on any row whose adapters do not all read the deadline, so the
 * thirteenth adapter — or a stub that grows a transport — has a marker to move to.
 *
 * **Every number below is a STARTING assignment.** R-148(e) wants each one measured against ITS
 * capability's envelope rather than rounded to the nearest tier; a later change arrives with its own
 * two-number record, never as a bare edit.
 */

/**
 * The fields every manifest row carries, whatever its `shape`.
 *
 * `ttlSeconds`, `deadlineMs` and `shareable` are REQUIRED — a capability that builds and runs
 * without a deadline is exactly the failure UC-1 names, and an optional field "just in case" is how
 * that happens. `paidLegMs` is carried ONLY by a capability whose route reaches a `tier: 'paid'`
 * adapter (TC-UNIT-06 enforces both directions — a defensive `paidLegMs` on a free capability fails
 * the suite).
 */
interface CapabilityManifestBase {
  ttlSeconds: number;
  /** ONLY the cancellable part of the call (OD-3) — never the whole call, never the paid leg. */
  deadlineMs: number;
  /**
   * May one principal be served another's cached result? (ADR-003 D5; task 014-31 gives it values.)
   *
   * **The rule: a result is shareable when it does not depend on WHO asked.** A token's price is
   * shareable. An answer derived from a wallet belonging to the asker is not.
   *
   * **REQUIRED, not optional, and that is the change task 014-31 makes.** The default would have to
   * choose between a leak across principals and a lost cache, and both are expensive — so the choice
   * is made per row, in writing, or the build fails. `shareable?: boolean` had been declared by T-012
   * and read by nobody; a field with no reader drifts from reality silently.
   *
   * **Every row is `true` today, and the honest reading of that is stated rather than buried.** Not
   * one capability takes an implicit "the caller's own wallet" — `wallet.balances.native` takes the
   * address as an ARGUMENT, so two principals asking about the same address are asking the same
   * question and the answer turns on the argument. What this field buys is therefore not a rule that
   * fires today: it is that the FIRST capability whose answer depends on the asker has to say so
   * here, in a diff, instead of inheriting a default nobody chose. The enforcement (part 2) has no
   * reachable case on today's manifest, and `capability-manifest.test.ts` says so where a reader
   * looking for coverage would look.
   */
  shareable: boolean;
  /** Only where the route reaches a `tier: 'paid'` adapter. */
  paidLegMs?: number;
}

/**
 * One capability's manifest — a **discriminated union on `shape`**, deliberately, and with an exact
 * statement of what that buys TODAY.
 *
 * **The `set | series` branch now carries `mergeable?: boolean` (T-013, task 013-1, R-159/R-160) —
 * the obligation the paragraphs below used to describe as future is discharged.** Declaring
 * `mergeable` on the `point` branch is a compile error (excess property on a union member), proven
 * by `capability-manifest.test.ts`'s TC-UNIT-09 (negative, `@ts-expect-error`) alongside its
 * positive control TC-UNIT-10 (`series` + `mergeable: true` compiles) and TC-UNIT-11 (only the two
 * `.history` merge rows carry `mergeable: true` in the table below). The field is a FACT about a
 * capability's key identity, not an activation switch — `CapabilityRoute.merge` (013-2) and its
 * `providers.config.ts` setting (013-6) are what turns merging on, and neither has landed yet.
 *
 * **Why a discriminated union bought this, when a flat interface would have been legal too.** Both
 * branches differ **only** by the `shape` literal, so structurally the union was always
 * interchangeable with a flat interface: a field added to `CapabilityManifestBase` would have been
 * legal on `point` regardless of how many branches this type has. The union did not make the
 * restriction effective on its own — adding `mergeable` to the correct branch, and only that branch,
 * is what makes it effective; the union is what made doing so possible without widening `point` in
 * the same edit. (An earlier draft claimed the union "is the whole of R-136(d)'s
 * forward-compatibility mechanism"; that overstatement was withdrawn before this field existed, and
 * stays withdrawn — the union alone still proves nothing about any field not yet added.)
 *
 * **Rejected here, and why** (task file F-5): declaring `mergeKey?: never` on the `point` branch to
 * make the restriction effective immediately, before T-013. That would have pre-picked a NAME T-013
 * had not yet chosen — name the field anything else (as `mergeable` turned out to be) and the guard
 * would have protected a key nobody uses, with no input on which it fails. A guard without such an
 * input is barred by the same rule everywhere else in this task.
 *
 * `capability-manifest.test.ts`'s TC-UNIT-07 keeps this declaration a two-branch union going
 * forward, independently of `mergeable`'s existence: the DECLARATION guard and the field it enabled
 * are two different obligations. TC-UNIT-07 reads the declaration's TEXT, never types — it cannot
 * see which branch a field is declared on, only whether the union still HAS the two branches a
 * per-field test needs. That is why it stays in force: it is the standing PRECONDITION that lets a
 * future field get its own negative type-test the way `mergeable` got TC-UNIT-09. Catching that
 * future field on the wrong branch, or on `CapabilityManifestBase`, is that field's OWN
 * `@ts-expect-error` to write — TC-UNIT-07 does not and structurally cannot do it for them (see its
 * own "NOT reached" table, `capability-manifest.test.ts`'s `mergeKeyOnTheBase` case).
 */
export type CapabilityManifest =
  | (CapabilityManifestBase & { shape: 'point' })
  | (CapabilityManifestBase & {
      shape: 'set' | 'series';
      /**
       * Whether results from this capability's adapters are eligible to be walked/deduped/merged
       * into one answer instead of returned from a single winning adapter (R-159/R-160). A FACT
       * about the capability's key identity, not an activation switch: `CapabilityRoute.merge`
       * (013-2) turns it on per route, and `providers.config.ts` (013-6) is where that lands —
       * neither exists yet. Nothing in `packages/` reads this field yet, so `undefined`/`false`/
       * `true` all behave IDENTICALLY today — there is no behaviour to distinguish them. The
       * distinction arrives with `CapabilityRoute.merge` (013-2).
       */
      mergeable?: boolean;
    });

/**
 * All 27 routed capabilities (`providers.config.ts` — 28 routes, 27 distinct capabilities;
 * `wallet.balances.native` is routed twice). The pair read `23 / 24` until task 014-32b measured it:
 * it had been stale by three since before T-013, and the form `All <n> routed capabilities` matched
 * no gate at all — which is why it could drift silently. `TC-E2E-05` reads it now. TC-UNIT-01 enumerates the routes against this table and
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
  // banner, by name:** `token.price`, `token.metadata`, `pairs.active`, `pool.info`, `protocol.tvl`,
  // `chain.tvl`, `dex.volume.history`, `wallet.balances.native`. It covers no row outside that run
  // — `chain.supply` in particular belongs to the E-HTTP5 block below, not to this one. **And it is
  // not the enforcement record for any of them:** each of the 27 rows carries its OWN
  // `**ENFORCED TODAY**` / `**DECLARED, not enforced today**` marker, because a reader greps one
  // capability or reads one row in a diff, and a claim that lives only in a banner is invisible
  // there (adversarial cycle 2 review of F-5 — the first version of this section marked the block
  // and left 11 rows with nothing findable in them). `capability-manifest.test.ts`'s
  // TC-F5-GATE enforces one marker per row and checks each against the adapter sources.
  //
  // All eight are ENFORCED TODAY (see the ENFORCEMENT section above; measured 2026-08-05). An
  // earlier version of this banner said 15_000 is BELOW `MAX_WAIT_MS = 30_000`, so "on a saturated
  // token bucket these capabilities now refuse fast instead of sleeping up to 30 s", and called that
  // UC-7. That was true of the MECHANISM and false of these eight rows, because `coingecko`,
  // `dexscreener`, `defillama`, `rpc-evm` and `rpc-solana` all called `throttle(id, RATE_LIMIT)` with
  // two arguments and the limiter never saw this number. WI-37 threaded it into all five, so the
  // sentence is now true of the rows as well as of the mechanism — UC-7 is reachable on this tier
  // rather than being a property of `blockscout` and `nansen`.
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
    // shareable: the price of (chain, token) — public market data, identical for every caller.
    shareable: true,
    // measured envelope: 90_000 (E-HTTP15 — `coingecko`, one attempt). applied: 15_000 — the
    // OWNER's ~15 s tier (OD-2), a ceiling and not a measurement; it would cut 75_000 — the entire
    // redirect tail plus most of the limiter wait — on a route that read it.
    // **ENFORCED TODAY** — `coingecko` forwards the deadline to `throttle()` and to `safeFetch`
    // (WI-37; before it, this row's ceiling cancelled and shortened nothing).
    deadlineMs: 15_000,
  },
  'token.metadata': {
    // AUDIT (012-4, OQ-T012-1): hypothesis `point`, CONFIRMED. `coingecko/index.ts:156` —
    // `normalize(): Token`, one canonical token record about one contract address.
    shape: 'point',
    ttlSeconds: 3600,
    // shareable: the record of (chain, contract) — public chain state, identical for every caller.
    shareable: true,
    // measured envelope: 90_000 (E-HTTP15 — `coingecko`, one attempt). applied: 15_000 — owner
    // ceiling (OD-2), not a measurement; would cut 75_000.
    // **ENFORCED TODAY** — same adapter and same call path as `token.price` (WI-37).
    deadlineMs: 15_000,
  },
  'pairs.active': {
    // AUDIT: hypothesis `set`, CONFIRMED. `dexscreener/index.ts:125` — `normalize(): Pool[]`, a
    // chain-filtered, `limit`-sliced batch with no ordering imposed (no sort anywhere in the
    // method), so it is a collection and not a `ts`-ordered run.
    shape: 'set',
    ttlSeconds: 30,
    // shareable: the active pairs of (chain, limit) — a public listing, identical for every caller.
    shareable: true,
    // measured envelope: 90_000 (E-HTTP15 — `dexscreener`, one attempt). applied: 15_000 — owner
    // ceiling (OD-2), not a measurement; would cut 75_000.
    // **ENFORCED TODAY** — `dexscreener` forwards the deadline to `throttle()` and `safeFetch`
    // (WI-37).
    deadlineMs: 15_000,
  },
  'pool.info': {
    // AUDIT (012-4): hypothesis `set`, CONFIRMED AT THE TIME and RECLASSIFIED to `point` by task
    // 014-32b. The 012-4 reading was correct about the code it read — `dexscreener/index.ts:125`
    // ignored `_cap` entirely, so both capabilities ran one `normalize(): Pool[]` and this row
    // returned a collection. It was a measurement of an UNSERVED capability: no registered tool
    // resolved `pool.info` (L-15), so nothing ever asked this route for one pool.
    //
    // `onchain_pool_info` asks by POOL ADDRESS and the vendor answers with that one pool
    // (`interfaces.md` §5.1.7, `GET /latest/dex/pairs/{chainId}/{pairAddress}`), so the shape the
    // capability actually has is `point`. Recorded rather than silently corrected, because the
    // earlier value was a true reading of a route nobody called — not an error of care.
    shape: 'point',
    // Carried from `cache/ttl.ts`, with its rationale: "`pool.info` shares its adapter (dexscreener)
    // and its liquidity/volume-style volatility with `protocol.tvl`, not the
    // "new"-freshness-critical `pairs.active` — same 300s bucket."
    ttlSeconds: 300,
    // shareable: the pool at (chain, pair address) — public chain state, identical for every caller.
    shareable: true,
    // measured envelope: 90_000 (E-HTTP15 — `dexscreener`, one attempt). applied: 15_000 — owner
    // ceiling (OD-2), not a measurement; would cut 75_000.
    // **ENFORCED TODAY** — same adapter and same call path as `pairs.active` (WI-37).
    deadlineMs: 15_000,
  },
  'token.pools': {
    // AUDIT (014-32b): `set`. The tool answers with the pools ONE token trades in — a collection
    // with no ordering the contract claims: `interfaces.md` §5.1.8 states outright that no probe of
    // these two vendor routes has established whether row order is stable or size-ranked, so this
    // is a collection and not a `ts`-ordered run.
    shape: 'set',
    // Follows the `pool.info` row above, and `interfaces.md` §5.1.8 says why in one sentence: both
    // capabilities read the same vendor at the same freshness, and pool MEMBERSHIP does not move
    // faster than reserves do.
    ttlSeconds: 300,
    // shareable: the pools of (token address, optional chain, limit) — a public listing, identical
    // for every caller. The token address is an ARGUMENT, never "the caller's own token", so two
    // principals asking about one address ask one question.
    shareable: true,
    // measured envelope: 90_000 (E-HTTP15 — `dexscreener`, one attempt). applied: 15_000 — owner
    // ceiling (OD-2), not a measurement; would cut 75_000.
    // **ENFORCED TODAY** — same adapter and same call path as `pairs.active` (WI-37).
    deadlineMs: 15_000,
  },
  'protocol.tvl': {
    // AUDIT: hypothesis `point`, CONFIRMED. `defillama/index.ts:863` — the `protocol.tvl` branch
    // returns `ProtocolTvlResult`, one `tvlUsd`/`totalTvlUsd` pair for one protocol on one chain.
    shape: 'point',
    ttlSeconds: 300,
    // shareable: the TVL of (chain, protocol slug) — a published aggregate, identical for every caller.
    shareable: true,
    // measured envelope: 90_000 (E-HTTP15 — `defillama`, one attempt). applied: 15_000 — owner
    // ceiling (OD-2), not a measurement; would cut 75_000.
    // **ENFORCED TODAY** — and this is the one `defillama` path with no shared document, so the
    // deadline reaches `throttle()` and `safeFetch` directly and can cancel the request (WI-37).
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
    // shareable: the TVL of (chain) — a published aggregate, identical for every caller.
    shareable: true,
    // measured envelope: 90_000 (E-HTTP15 — `defillama`, one attempt). applied: 15_000 — owner
    // ceiling (OD-2), not a measurement; would cut 75_000.
    // **ENFORCED TODAY**, by the OTHER of `defillama`'s two mechanisms: `/v2/chains` is a document
    // SHARED between concurrent callers, so the ceiling bounds this caller's WAIT and deliberately
    // does not abort a download somebody else is also awaiting (WI-37, `awaitSharedDocument`).
    deadlineMs: 15_000,
  },
  'protocol.list': {
    // A collection with no time dimension — the population of protocols on a chain, ranked. `set`,
    // by the same reading that classified `pairs.active`: the return is a collection, not one row.
    // (It cited `pool.info` until task 014-32b reclassified that row to `point`; the reading is
    // unchanged, the example it points at had to move to one that still holds.)
    shape: 'set',
    // Read out of the SAME `/protocols` document `protocol.tvl` uses, plus the month-ago baseline.
    // The 300 s bucket is inherited rather than invented: serving a ranking from a fresher window
    // than the per-protocol figures it ranks would let the two disagree inside one conversation.
    ttlSeconds: 300,
    // shareable: the protocols of (chain, filters) — a published listing, identical for every caller.
    shareable: true,
    // measured envelope: 90_000 (E-HTTP15 — `defillama`, one attempt). applied: 15_000 — owner
    // ceiling (OD-2), not a measurement.
    // **ENFORCED TODAY** — shared-document path, both documents (WI-37).
    deadlineMs: 15_000,
  },
  'protocol.tvl.history': {
    // A `ts`-ordered daily run, same shaper as the other two histories.
    shape: 'series',
    // The vendor's step is one day, so a shorter TTL cannot buy a fresher number — and here it
    // would buy a second multi-megabyte download, which is the whole reason this route is narrow.
    ttlSeconds: 3600,
    // shareable: the TVL series of (chain, protocol slug, window) — published history, identical for every caller.
    shareable: true,
    // measured envelope: 90_000 (E-HTTP15 — `defillama`, one attempt). applied: 15_000 — owner
    // ceiling (OD-2), not a measurement.
    // **ENFORCED TODAY** — the one `defillama` path with no shared document, so the deadline reaches
    // `throttle()` and `safeFetch` directly and can cancel the request (WI-37).
    deadlineMs: 15_000,
  },
  'chain.tvl.history': {
    // A `ts`-ordered daily run with `window`/`gapDays` describing it — the same substance as
    // `dex.volume.history`, produced by the same shaper (`daily-series.ts`), so the same class.
    shape: 'series',
    // The vendor's own step for this dataset is ONE DAY (`/v2/historicalChainTvl/{chain}` is
    // `[{date: <unix seconds>, tvl}]`, measured 2026-08-11 over 3 240 points for Ethereum), so a TTL
    // shorter than a day cannot buy a fresher number — it can only buy a second identical download.
    // The same hour `dex.volume.history` uses, for the same reason.
    ttlSeconds: 3600,
    // shareable: the TVL series of (chain, window) — published history, identical for every caller.
    shareable: true,
    // measured envelope: 90_000 (E-HTTP15 — `defillama`, one attempt). applied: 15_000 — owner
    // ceiling (OD-2), not a measurement.
    // **ENFORCED TODAY** — shared-document path: the ceiling bounds this caller's WAIT and
    // deliberately does not abort a download another caller is awaiting (WI-37).
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
    // shareable: the DEX volume series of (chain, window) — published history, identical for every caller.
    shareable: true,
    // measured envelope: 90_000 (E-HTTP15 — `defillama`, one attempt). applied: 15_000 — owner
    // ceiling (OD-2), not a measurement; would cut 75_000.
    // **ENFORCED TODAY** — shared-document path, same as `chain.tvl`: the ceiling bounds the wait,
    // not the shared download (WI-37).
    deadlineMs: 15_000,
  },
  'wallet.balances.native': {
    // ADR-002 D3 names this one.
    shape: 'set',
    ttlSeconds: 60,
    // shareable: the balance of (chain, ADDRESS AS AN ARGUMENT) — never "the caller’s own wallet", so the answer turns on the argument and not on who asked. This is the row the rule was written for, and it comes out shareable.
    shareable: true,
    // measured envelope: 90_000 (E-HTTP15 — `rpc-evm`/`rpc-solana`, one attempt; the two routes are
    // per-chain alternatives, never a sequence: `chainSupport()` leaves exactly one of them
    // eligible for a given chain). applied: 15_000 — owner ceiling (OD-2), not a measurement;
    // would cut 75_000.
    // **ENFORCED TODAY** — both `rpc-evm` and `rpc-solana` forward it to `throttle()` and to every
    // hop of their endpoint fallback loop, and stop walking that loop once it is spent (WI-37).
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
    // shareable: the holders of (chain, token) — public chain state, identical for every caller.
    shareable: true,
    // measured envelope: 50_000 (E-HTTP5 — `blockscout`, one attempt: 30_000 + 4 × 5_000).
    // applied: 15_000 — owner ceiling (OD-2), not a measurement; cuts 35_000 — **ENFORCED TODAY**, the
    // route's only adapter `blockscout` forwards the deadline to `throttle()` and to `safeFetch`
    // (ENFORCEMENT above). Note the ceiling
    // does NOT follow the adapter's own faster timeout down: the tier is a property of the
    // capability, and `blockscout`'s 5 s is a property of one vendor.
    deadlineMs: 15_000,
  },
  'protocol.incidents': {
    // A collection with no time dimension of ours — the incidents recorded for one protocol. `set`,
    // by the same reading that classified `protocol.list`.
    shape: 'set',
    /**
     * 3600 s, and deliberately the SLOWEST clock among the protocol capabilities.
     *
     * This feed is editorial, not on-chain: measured 2026-08-11 its newest record was 2.5 days old,
     * and an incident is written up hours-to-days after it happens. A shorter TTL cannot buy a
     * fresher answer — it can only buy a second download of a document that changes a few times a
     * month. The result carries `feedThroughTs` so a caller reads the FEED's age rather than
     * inferring freshness from ours, which is the distinction WI-52 required for non-on-chain data.
     */
    ttlSeconds: 3600,
    // shareable: the incidents of (protocol slug) — an editorial record, identical for every caller.
    shareable: true,
    // measured envelope: 90_000 (E-HTTP15 — `defillama`, one attempt). applied: 15_000 — owner
    // ceiling (OD-2), not a measurement.
    // **ENFORCED TODAY** — shared-document path, both documents (WI-37): the ceiling bounds this
    // caller's wait and does not abort a download another caller is awaiting.
    deadlineMs: 15_000,
  },
  'gas.price': {
    // One reading of one number for one chain — `point`, by the same reading that classified
    // `chain.tvl`.
    shape: 'point',
    /**
     * 30 s, and this is the shortest TTL in the manifest on purpose.
     *
     * Gas is the most perishable number the engine serves: `blockscout` re-stamps
     * `gas_price_updated_at` roughly every minute (measured — two probes 45 s apart carried
     * different stamps), and a node's answer changes every block. Serving a five-minute-old gas
     * price to "should I transact now" is not a stale cache, it is a wrong answer.
     *
     * It is NOT shorter than that, because 30 s is already inside the vendor's own refresh interval:
     * below it the cache buys a second identical request and nothing else — the same reasoning
     * `chain.supply` uses to sit at 600 s against Bitcoin's block interval, applied to a much faster
     * clock. The PRO key's credit quota is the other bound: a 1 s TTL turns one impatient
     * conversation into hundreds of upstream calls.
     */
    ttlSeconds: 30,
    // shareable: the gas price of (chain) — public chain state, identical for every caller.
    shareable: true,
    // measured envelope: 50_000 on the `blockscout` leg (E-HTTP5 — one attempt: 30_000 + 4 × 5_000);
    // the `rpc-evm` leg walks that chain's curated endpoints with `safeFetch`'s 15 s default per hop.
    // applied: 15_000 — owner ceiling (OD-2), not a measurement.
    // **ENFORCED TODAY** on BOTH legs: `rpc-evm` forwards it to `throttle()` and to every hop of
    // `callRpc`'s endpoint loop (WI-37), and `blockscout` forwards it to `throttle()` and
    // `safeFetch`. Neither leg has a shared-document path, so cancellation is real, not advisory.
    deadlineMs: 15_000,
  },
  'chain.transactions': {
    // One reading of a small fixed set of counters for one chain.
    shape: 'point',
    /**
     * 600 s, twenty times `gas.price`'s, from the SAME document.
     *
     * Not an inconsistency — a measurement. `transactions_today` did not move across 45 s in which
     * `total_blocks` advanced by 10 and the gas stamp changed twice: it is a periodically
     * recomputed daily aggregate, so a shorter TTL cannot buy a fresher number, it can only buy a
     * second identical request. The two capabilities read one endpoint and have different clocks
     * because the FIELDS have different clocks, which is exactly what per-capability TTL is for.
     */
    ttlSeconds: 600,
    // shareable: the transaction count of (chain) — public chain state, identical for every caller.
    shareable: true,
    // measured envelope: 50_000 (E-HTTP5 — `blockscout`, one attempt: 30_000 + 4 × 5_000).
    // applied: 15_000 — owner ceiling (OD-2), not a measurement; cuts 35_000. **ENFORCED TODAY**.
    deadlineMs: 15_000,
  },
  'chain.supply': {
    // ADR-002 D3 names this one.
    shape: 'point',
    // Carried from `cache/ttl.ts`, with its rationale: "TASK-009 (R-82b). … 600s is the Bitcoin
    // target block interval: the value changes ONLY when a block is found, so a shorter TTL cannot
    // buy a fresher number, it can only buy a second identical pair of requests."
    ttlSeconds: 600,
    // shareable: the supply of (chain) — public chain state, identical for every caller.
    shareable: true,
    // measured envelope: 50_000 (E-HTTP5 — `blockchain-info`, one attempt: 30_000 + 4 × 5_000).
    // Its `fetch()` issues TWO readings, so the envelope of the whole call is twice that; the
    // cancellable unit the deadline governs is the attempt. applied: 15_000 — owner ceiling
    // (OD-2), not a measurement; would cut 35_000.
    // **ENFORCED TODAY** — `blockchain-info` forwards it to `throttle()` and `safeFetch` on BOTH
    // readings, so the ceiling is what stops the second being issued after the first spent the
    // budget (WI-37). NOTE it is NOT covered by the ~15 s block banner above: this row sits in the
    // E-HTTP5 block, which is why every row carries its own marker.
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
    // shareable: the shielded pool of (chain) — public chain state, identical for every caller.
    shareable: true,
    // measured envelope: 90_000 (E-HTTP15 — `platform-explorer` alone; `dash-platform` contributes
    // E-DASH = 0 and grows only when a live gRPC transport lands). applied: 15_000 — **OVERRIDE**
    // of the architecture's ~30_000, not an alignment: the route is single-live-adapter today (see
    // the banner). It is also the owner's ~15 s ceiling and not a measurement; it would cut 75_000.
    // **ENFORCED TODAY** — `platform-explorer` forwards the deadline (WI-37); `dash-platform` is
    // exempt because it spends no time at all, which is the same fact as E-DASH = 0.
    deadlineMs: 15_000,
  },
  'platform.identities': {
    // AUDIT: hypothesis `point`, CONFIRMED. `platform-explorer/index.ts` — single `Snapshot` from
    // `snapshotFromCurrentState({metric: identitiesTotal, …})`; one counter at one height.
    shape: 'point',
    ttlSeconds: 3600,
    // shareable: the identity count of (chain) — public platform state, identical for every caller.
    shareable: true,
    // measured envelope: 90_000 (E-HTTP15 — `platform-explorer` alone; `dash-platform` = E-DASH 0,
    // grows with a live gRPC transport). applied: 15_000 — **OVERRIDE** of the architecture's
    // ~30_000 (single-live-adapter route, see the banner) and the owner's ceiling, not a
    // measurement; would cut 75_000. **ENFORCED TODAY** — `platform-explorer` forwards the deadline
    // (WI-37); `dash-platform` is exempt, spending no time (E-DASH = 0).
    deadlineMs: 15_000,
  },
  'platform.contracts': {
    // AUDIT: hypothesis `point`, CONFIRMED — single `Snapshot` (`dataContractsTotal`).
    shape: 'point',
    ttlSeconds: 3600,
    // shareable: the contract count of (chain) — public platform state, identical for every caller.
    shareable: true,
    // measured envelope: 90_000 (E-HTTP15 — `platform-explorer` alone; `dash-platform` = E-DASH 0,
    // grows with a live gRPC transport). applied: 15_000 — **OVERRIDE** of the architecture's
    // ~30_000 (single-live-adapter route, see the banner) and the owner's ceiling, not a
    // measurement; would cut 75_000. **ENFORCED TODAY** — `platform-explorer` forwards the deadline
    // (WI-37); `dash-platform` is exempt, spending no time (E-DASH = 0).
    deadlineMs: 15_000,
  },
  'platform.documents': {
    // AUDIT: hypothesis `point`, CONFIRMED — single `Snapshot` (`documentsTotal`).
    shape: 'point',
    ttlSeconds: 3600,
    // shareable: the document count of (chain) — public platform state, identical for every caller.
    shareable: true,
    // measured envelope: 90_000 (E-HTTP15 — `platform-explorer` alone; `dash-platform` = E-DASH 0,
    // grows with a live gRPC transport). applied: 15_000 — **OVERRIDE** of the architecture's
    // ~30_000 (single-live-adapter route, see the banner) and the owner's ceiling, not a
    // measurement; would cut 75_000. **ENFORCED TODAY** — `platform-explorer` forwards the deadline
    // (WI-37); `dash-platform` is exempt, spending no time (E-DASH = 0).
    deadlineMs: 15_000,
  },
  'platform.credits': {
    // AUDIT: hypothesis `point`, CONFIRMED — single `Snapshot` (`platformTotalCredits`).
    shape: 'point',
    ttlSeconds: 3600,
    // shareable: the credit totals of (chain) — public platform state, identical for every caller.
    shareable: true,
    // measured envelope: 90_000 (E-HTTP15 — `platform-explorer` alone; `dash-platform` = E-DASH 0,
    // grows with a live gRPC transport). applied: 15_000 — **OVERRIDE** of the architecture's
    // ~30_000 (single-live-adapter route, see the banner) and the owner's ceiling, not a
    // measurement; would cut 75_000. **ENFORCED TODAY** — `platform-explorer` forwards the deadline
    // (WI-37); `dash-platform` is exempt, spending no time (E-DASH = 0).
    deadlineMs: 15_000,
  },

  // ===========================================================================================
  // TIER ~30 s (OD-2) — up to two free adapters walked SEQUENTIALLY.
  // `platform-explorer` (HTTP) then `pg-history` (Postgres wire protocol — E-PG, not the HTTP
  // template). This is the architecture row that is CORRECT and stays untouched.
  //
  // Both rows are ENFORCED TODAY. Their measured envelope changed on 2026-08-05 when WI-34/WI-35
  // gave the pg leg a rate limit and a time bound — see either row for why a LARGER envelope is the
  // sign of that, not of a regression.
  // ===========================================================================================
  'privacy.shielded_pool.history': {
    // ADR-002 D3 names this one.
    shape: 'series',
    // Carried from `cache/ttl.ts`, with its rationale: "The two `*.history` capabilities are
    // historical views of an already-3600s-bucketed live capability; the table's own stated
    // rationale for that 3600s row ("no point polling faster than the existing hourly snapshotter
    // cadence") applies identically to their history counterparts."
    ttlSeconds: 3600,
    // shareable: the shielded-pool series of (chain, window) — public history, identical for every caller.
    shareable: true,
    // measured envelope: 140_000 — 90_000 (E-HTTP15, `platform-explorer`) + 50_000 (E-PG,
    // `pg-history`: a limiter wait up to 30_000 plus the 20_000 in-process query bound; no redirect
    // hops). applied: 30_000 — owner ceiling (OD-2), not a measurement; it cuts 110_000.
    // **ENFORCED TODAY** — both adapters on this route read the deadline (WI-37).
    //
    // **The envelope moved twice in one commit, in opposite directions, and both halves are the
    // point.** It was recorded as "100_000 with an unbounded tail", and this row carried the
    // strongest version of the claim F-5 was about: an earlier record called this ceiling "the only
    // in-process bound the pg leg's tail has at all", when in fact `pg-history` was handed no
    // deadline and `platform-explorer` read none either, so the tail had NO in-process bound. WI-35
    // gave the query one (the tail became 20_000) and WI-34 made the declared limiter real (adding
    // up to 30_000 that had never been counted) — so the measured number GREW while the thing it
    // measures became bounded. A ceiling that cuts more than before is not a regression here; it is
    // the first version of this row where both numbers describe running code.
    deadlineMs: 30_000,
    // T-013 (013-1): eligible for merging. Not yet ACTIVE — `CapabilityRoute.merge` (013-2) and
    // its `providers.config.ts` setting (013-6) are separate tasks that have not landed.
    mergeable: true,
  },
  'platform.metrics.history': {
    // ADR-002 D3 names this one.
    shape: 'series',
    // Carried from `cache/ttl.ts` — same rationale as the row above (the two `*.history`
    // capabilities are historical views of an already-3600s-bucketed live capability).
    ttlSeconds: 3600,
    // shareable: the platform series of (chain, window) — public history, identical for every caller.
    shareable: true,
    // measured envelope: 140_000 — 90_000 (E-HTTP15, `platform-explorer`) + 50_000 (E-PG,
    // `pg-history`: limiter wait up to 30_000 + the 20_000 in-process query bound; not the HTTP
    // template — no hops). applied: 30_000 — owner ceiling (OD-2), not a measurement; it cuts
    // 110_000. **ENFORCED TODAY** — both adapters read the deadline (WI-37), and the pg leg's tail
    // is a number rather than "unbounded" for the first time (WI-35).
    deadlineMs: 30_000,
    // T-013 (013-1): eligible for merging. Not yet ACTIVE — `CapabilityRoute.merge` (013-2) and
    // its `providers.config.ts` setting (013-6) are separate tasks that have not landed.
    mergeable: true,
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
    // shareable: the labels of (chain, address or query) — a vendor-published attribution about a PUBLIC address, not about the asker.
    shareable: true,
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
    // shareable: the flows of (chain, window) — a vendor aggregate over public addresses, identical for every caller.
    shareable: true,
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
    // shareable: the risk record of (chain, token) — a vendor assessment of a public contract, identical for every caller.
    shareable: true,
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
