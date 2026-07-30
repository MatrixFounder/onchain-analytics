# Version history (changelog)

> Part of [docs/ARCHITECTURE.md](../ARCHITECTURE.md).

- 2026-07-29, **v4.6** — documentation pass (`/update-docs` after TASK-009). No design decision
  changed; what changed is that the documents' own claims became checkable.

  - **Stale counts corrected in eight places across five files** — adapters (10 → 12), MCP tools
    (10/11 → 13) and test totals (796 → 1106) in `functional-architecture.md`, `deployment.md`,
    `interfaces.md`, `technology-stack.md`, `system-architecture.md` and the index. All of it had
    accumulated because TASK-007 and TASK-008 updated the section they were editing and no more.
  - **Two mechanical gates so it cannot rot again** (WI-21): `mcp-server/test/docs-counts.test.ts`
    compares the counts these documents state against `adapterRegistrations` and the real
    `tools/list`, and requires every registered tool to be NAMED in §5 — a count alone would pass if
    one tool were swapped for another, and TASK-008's actual failure was a tool with no entry at all.
    `core/test/ttl-coverage.test.ts` requires an EXPLICIT TTL row for every routed capability; the
    silent fall-through to `DEFAULT_TTL_SECONDS` has happened twice and was caught by review both
    times. Both were mutation-checked rather than assumed to work.
  - **Historical statements are deliberately out of scope.** The gates read only present-tense
    sentences: "M1 shipped nine adapters" is true forever, and `version-history.md` is a log of what
    past versions said. A gate that rewrote history to match today's counts would be worse than none.
  - `eval/README.md`'s "Free providers only" paragraph existed **twice**, in two wordings, and both
    copies still listed the five M1 providers after two free adapters had been added. Merged into one.
    A fact stated twice is a fact that gets updated once.

- 2026-07-29, **v4.5** — TASK-009 `btc-supply-independent-verification` (research track A-3): the
  twelfth adapter `blockchain-info`, capability `chain.supply` on `bitcoin`, the tool
  `onchain_chain_supply`, and a reference-source axis in the eval. Three findings from the live
  keyless probe of 2026-07-29, each of which changed the design:

  - **The vendor's two supply surfaces are two different quantities, both correct** (§3.2/§4.1).
    `/stats.totalbc` sits at an INTEGER number of block subsidies past the halving boundary — it is
    the formula; `/q/totalbc` sits at a FRACTIONAL one, so it cannot be a stale copy of the formula
    and is instead the actually-claimed supply. The gap is unclaimed coinbase subsidy (~29–32 BTC,
    0.00016%). The task text prescribed `/q/*` "for emission"; that would have served one quantity
    under the other's name, at an error no reader could see.
  - **🔴 Checking supply against the halving formula is a tautology** (§3.2). It matched bit-exactly
    at both probed heights and will keep matching while the vendor computes it the same way. The
    only independently refutable value is the block **height**, so the cross-check compares heights
    against a second unrelated vendor and lets the deterministic formula carry that into supply.
  - **The delta is counted in blocks of subsidy, never in percent** (§5.1.5). One block is
    0.000016%; a full day of vendor staleness is 0.0023%. On any percentage scale a human would
    choose, a real failure and a rounding error look identical.

  Also: `mempool.space` was deliberately NOT adopted as an adapter — a source the engine answers
  from cannot be the independent check on that answer, and its wider surface has no consumer. The
  index's own counts were corrected in the same pass (ten adapters → twelve, eleven tools →
  thirteen): TASK-008 had updated §3.2 but not the index or §5.

- 2026-07-27, **v4.4** — TASK-007 `defillama-dex-volumes`: the free DEX-volume tier (research track
  A-1). Three design decisions, each forced by a live keyless probe run the same day rather than by
  the research write-up:

  - **Coverage for `dex.volume.history` is a generated vendor list, not `vendors.defillama`**
    (§4.2.3). That column came from the vendor's TVL catalog and is non-null for all 458 registry
    chains; the DEX-volume dataset covers 287, of which 274 are ours. The naive predicate would have
    advertised the capability on 184 chains that have no such data — TASK-006's H-1 defect class,
    repeated verbatim. `DEFILLAMA_DEX_CHAINS` is generated from recorded raw evidence and committed,
    on the same doctrine as `gen-nansen-coverage.ts`.
  - **`normalize()` verifies the response's `chain` echo** (§3.2). The endpoint is name-tolerant, an
    unknown chain answers HTTP **500** rather than 404, and a chain outside the vendor's active set
    answers HTTP **200 with zeros and a narrower key set**. Without the echo check, "served a
    different chain" and "this chain has no volume" are indistinguishable.
  - **The response-size cap became real** (§7.3). `api.llama.fi` sends **no `Content-Length`**, and
    the old cap returned early in exactly that case — inert on the host the engine was about to send
    more traffic to. `safeFetch` now counts bytes off the stream and cancels the reader on overflow,
    closing item (1) of the R-47 carry-over. This is a deliberate scope extension beyond the A-1
    task text, recorded as such: without it the DoD's "large document is truncated" test would have
    asserted nothing.

  Also: `defillama`'s `rateLimit` was raised from the M1 placeholder (`capacity 5 / refillPerSec 1`)
  — our own brake, not the vendor's, and measured at 40/40 concurrent origin requests with zero 429s.

- 2026-07-27, **v4.3** — editorial pass over the whole document: index plus all ten section files
  translated to English and finalized. No design decision was changed; what changed is that the
  document now states the system rather than narrating how it got there.

  - **Removed:** review-cycle bookkeeping (`F-1`…`F-3`, cycle/finding numbers, "review found and
    fixed"), draft archaeology ("was … became", "the first version of this section"), prediction
    bookkeeping, and instructions addressed to pipeline roles. Every rule those notes produced
    survives as a rule, stated with the failure it prevents.
  - **Statuses finalized:** TASK-006 is delivered, not "the current task"; nothing is pending the
    Planning phase. `open-questions.md` was split into **Open** (DAPI gRPC transport, a second
    Solana RPC, the `dashpay/platform` licence, ERC-20/SPL balances, opportunistic hardening, OQ-6,
    OQ-M3-1, the wider-Nansen-scope candidate) and **Resolved** (M1, M2 OQ-1…OQ-5, TASK-006
    OQ-1…OQ-5), each kept with the reason that closed it.
  - **Facts corrected against the code:** our registry is **458** chains, not the vendors' 461;
    ten adapters and ten tools where the text still said nine and four/five; `tools/list` returns
    10; the optional env surface is 11 keys, not 4; the monorepo tree now matches the repository.
  - **`ChainSchema` documented as implemented:** the canonical value is the **slug**, not CAIP-2
    (R-59d forbids changing response shapes), and `ChainInputSchema` validates without transforming
    because a zod transform has no JSON Schema representation and breaks `tools/list`.
    Canonicalization happens in the handler, still before `deriveArgsHash`.
  - **Structure:** the mis-numbered `#### 4.1` inside chapter 3 became **§3.2.1**; §7.2.1's "three
    hard rules" now matches its five items; §7.4 gained a number; the broken
    `architectures/system-architecture.md` link inside `reliability.md` was fixed. The M0 appendix
    was dropped — it carried only pointers, which this changelog and `git log` already provide.

- 2026-07-27, **v4.2** — two adversarial review cycles over TASK-006, plus closure of the
  known-issues register. Test suite **687 → 796** (core 617 + mcp-server 179), offline run green,
  zero live credits spent. Review found and fixed 1 Critical, 6 High and ~30 others — reports
  [cycle 5](../reviews/task-006-vdd-multi.md),
  [cycle 6](../reviews/task-006-vdd-multi-cycle6.md). The through-line of both cycles: the task
  widened what the engine PROMISES without widening, in several places, what it can DO.

  - **Critical (C-1).** Nansen's paid routes opened on 7 chains of the `other` family, where
    `isValidAddress` accepts any string: a junk `tokenAddress` reserved credits (every string is
    its own `argsHash`, so the cache is no defence), and two case variants of one address were two
    paid records. The trigger had been named in `address.ts` in advance (OQ-1) and fired exactly
    there. **OQ-1 revised:** paid capabilities now refuse on a family with no validator. The price
    is named — `entity.labels` 25→18, `token.risk` 24→18, `smart-money.flows` 17→16.
  - **High.**
    - Nansen coverage over-promised what the transport could do (17/25/25 against two hardcoded
      chains); the transport was widened to the registry and refusal became a permanent error
      class.
    - `rpc-solana` never received the fix its twin `rpc-evm` got: it declared coverage from the
      registry, sent every request to one hardcoded endpoint, and labelled everything `SOL`/9.
    - `entity.labels` compared the vendor's echo against our slug and, on ~20 chains, silently
      dropped every token row from an already-paid response (a cycle-5 regression).
    - `rpc-evm` signed every EVM balance as `ETH`/18.
    - `.max(64)` does not short-circuit `superRefine` in zod 4 (measured: 416 ms on 20,000
      characters).
    - The 458-row registry was rebuilt on every tool call (×5500 overhead).
  - **Data.** `nativeSymbol` is the gas token, not the listing token (63 rows corrected); new
    `nativeDecimals` column; EIP-155 testnet rows excluded from the join — `hyperliquid-l1` had
    been taking its symbol, the alias `twan` and an RPC candidate from Wanchain Testnet.
  - **Closed** — every remaining register entry, each with a mechanism. **SEC-1:** a velocity
    brake (credits per 60 s window, checked in the same transaction as the daily reservation, state
    in `usage_window` next to the ledger). **Q-3:** a second denominator that counts CALLS — the
    only bound able to see a call priced at 0 credits (column `calls_made`, the repository's first
    additive column migration, via `PRAGMA table_info` + `ALTER TABLE`). **RF-2:** a provenance
    manifest `docs/provenance.json` plus a verifier and a pre-commit hook, replacing a handwritten
    `shasum` that broke structurally — you cannot test that a human remembered.
  - **Declared limits.** The window is fixed, not sliding (2× at the boundary); git hooks are
    local, so a bypass makes the skip loud rather than impossible; price drift is still caught only
    after the fact, in `reconcile()`.
  - **Deviations.** Both cycles' fixes landed as ONE commit: they touched the same lines across 17
    files, and `registry.data.json` was regenerated twice and exists in a single state. Splitting
    them afterwards would have meant reconstructing from memory a tree that never existed.

- 2026-07-26, **v4.1** — TASK-006 IMPLEMENTED (tasks 006-1…006-10). Test suite **687** (core 515 +
  mcp-server 172); the offline run with `fetch`/`http(s)` blocked is green.

  - **Coverage after the task.** Registry **458** chains; `chain.tvl`/`protocol.tvl` — 458;
    `token.price`/`token.metadata` — 316; `wallet.balances.native` — 19 (curated `rpcHosts`);
    `smart-money.flows` — 17; `entity.labels` — 25; `token.risk` — 24; `pairs.new` — 3 (observed
    DexScreener chainIds). Paid spend for the whole task — **5 Nansen credits** (budget ≤6).
  - **Deviations from plan and architecture, and why.**
    1. **Cold cache invalidation (OQ-3) did not happen.** The canonical value became the slug, and
       before TASK-006 the tools accepted exactly `ethereum`/`solana`, which are their own slugs —
       so `args_hash` never changed. §4.2.2 and the OQ table updated to match.
    2. **`ChainSchema` carries the slug, not CAIP-2** as §3.2 prescribed: R-59d forbids changing
       the shape of tool responses, and `onchain_get_token` always answered `chain:"ethereum"`.
       CAIP-2 remains the registry's primary key; the "an alias never reaches the cache key"
       requirement is met by canonicalizing in the handler (proven by test: `chain:'eth'` after
       `chain:'ethereum'` is a cache HIT).
    3. **R-58a was satisfied by the spec plus a spot check, not a live sweep.** Nansen's coverage is
       already enumerated per endpoint in the committed OpenAPI; sweeping 25 chains would have
       spent credits for the same conclusion.
    4. **There are 7 "half" chains, not 8.** Eight counts vendor tokens, where `hyperevm` and
       `hyperliquid` are one chain of ours.
  - **Defects found during implementation and fixed.**
    - (a) `deps.data ?? registryData` — `null ?? x` returns `x`, so an explicit `{data:null}` was
      silently replaced by the production registry: a test that believed it ran on synthetic data
      would have gone green on production data.
    - (b) The join key `gecko_id → native_coin_id` is **not unique** — 28 coins share 109 CoinGecko
      platforms (`ethereum` alone has 49 L2s on ETH gas). First-match gave `ethereum→alienx`,
      `bsc→opbnb`, `solana→sonic-svm`, i.e. token requests would have gone to another chain's
      platform. Fixed with a join ladder that puts the exact EVM chainId first; fuzzy merges 73→20.
    - (c) Alias assignment depended on processing order (`iota-evm` claimed `iota` before it became
      a slug) — the loader rejected the snapshot; fixed with a second pass.
    - (d) zod `.transform()` is **not representable in JSON Schema** — the MCP SDK renders schemas
      for `tools/list` and answered `-32603`, so tool DISCOVERY, and with it the whole server,
      broke. The schema now only validates; canonicalization happens in the handler.
    - (e) After `Chain` widened to `string`, the string `'berachain'` missed the legacy map in
      `address.ts` and silently lost EIP-55.
    - (f) While curating `rpcHosts`, `hyperliquid-l1` was rejected: its only live endpoint belongs
      to **Wanchain**, and both chains claim chainId 999 — `eth_chainId` returns the expected value
      and the automatic check passes, but Wanchain would have been serving Hyperliquid balances. An
      illustration of why the column is curated by hand.
  - **Schema saving, measured.** A tool's JSON Schema is 4729 characters (~1182 tokens) with a
    closed enum, against 261 characters (~65 tokens) without — ≈**7819 tokens per model request**
    across seven tools.

- 2026-07-26, **v4.0** — TASK-006 architecture phase (`universal-chain-registry`, R-48…R-60): a
  chain stops being code and becomes data.

  - **Chain Registry** (`src/chain/registry.ts` plus a separate `registry.data.json`, so a data
    diff never mixes with a logic diff): canonical id is CAIP-2, vendor ids are mapping columns,
    and `aliases` include the permanent `ethereum`/`solana` (R-59).
  - The registry is a **build artifact — not a DB table and not a network call at startup**. Three
    hard reasons: the "0 network calls" offline gate (M1/M2), CI determinism, and a security
    surface reviewable through a git diff. The consequence is named directly: registry freshness
    becomes the operator's duty, not the runtime's (this produced OQ-6).
  - The old `z.enum(['ethereum','solana','dash'])` splits into **two** schemas: `ChainSchema`
    (canonical caip2, inside domain types) and `ChainInputSchema` (tool input, resolves aliases).
    One schema cannot serve both ends — an alias would leak into the canonical object and from
    there into the cache key, producing two entries for one request, which on paid routes is a
    money defect.
  - The coverage matrix (`src/chain/coverage.ts`) is **derived** from `routes × adapter.chainSupport()`,
    where `chainSupport` is a predicate over `ChainInfo` rather than a list: a list would have to be
    kept in sync with the registry, a predicate cannot drift from it.
  - A separate `CapabilityNotCoveredOnChainError` is introduced, deliberately NOT merged with the
    existing `CapabilityUnavailableError` (R-24): merging would send an agent into an endless retry
    where repeating is pointless.
  - Gate order is fixed so the coverage check sits **above** credit reservation — otherwise growing
    the chain count from 2 to 461 would itself become a way to spend money (this removes part of the
    SEC-1 surface without replacing the velocity guard).
  - Address validation branches on `family`, not on chain name: the contents of the `evm`/`svm`
    branches do not change by a single line, their reach does (one branch for 270+ EVM chains). A
    family with no validator means acceptance without canonicalization, not refusal of service —
    with the price stated: cache splitting by address case, not loss of correctness.
  - Two new free tools: `onchain_list_chains` (discovery, zero network calls, mandatory `limit` +
    `total` — otherwise a tool built to save 8.7k schema tokens would spend more on its first call)
    and `onchain_chain_tvl` (separate from `onchain_protocol_tvl`: a chain is not a protocol, a
    different source and a different contract).
  - **The only non-trivial security risk of the task — §7.2.1:** multichain RPC needs a host per
    chain, and `chainid.network` serves `rpc[]` for 2660 chains. Any path in which network data
    influences the SSRF allowlist is forbidden; `rpcHosts` stays a curated column — the one registry
    field where autofill is banned — and a chain without `rpcHosts` is honestly uncovered rather
    than failing at runtime.
  - Live probing on 2026-07-26
    ([evidence](../onchain-analytics/raw/chain-registry-probe-2026-07-26.json)) established the fact
    that determined the whole design: **there is no shared chain vocabulary between vendors**
    (DeFiLlama 461 ≠ CoinGecko 461; the intersection on the explicit key `gecko_id`→`native_coin_id`
    is 235, on normalized names 255) — which is why fuzzy merges must land in a separate section of
    the diff report and be confirmed by a human.
  - No providers added, no DDL changed; the only migration event is a one-off cold cache
    invalidation from the change of `args_hash` contents (OQ-3). Implementation is the
    Planning/Development phases; test suite still **492** (unchanged).

- 2026-07-23, **v3.0** — TASK-005 architecture phase (`m2-alpha-paid`, R-29…R-47): the first paid
  slice.

  - A tenth adapter, `nansen` — the first paid one (`apiKey` header, POST JSON bodies, host
    `api.nansen.ai`); three new capabilities (`smart-money.flows`/`entity.labels`/`token.risk`, no
    free fallback); three new MCP tools (`onchain_smart_money_flows`/`onchain_entity_label`/
    `onchain_token_risk`); three new canonical zod types
    (`SmartMoneyFlow`/`EntityLabel`/`TokenRiskScore`, a D5 extension).
  - A `usage` table (portable types, epoch-ms day bucket, FK to `providers`, additive upsert) plus a
    `BudgetStore` repository — the same pattern as `CacheStore`.
  - The pre-call budget gate is implemented as a private layer of the `nansen` adapter's own
    `fetch()` — not an edit to `CapabilityRegistry.resolve()` and not a separate wrapper object, so
    it is structurally unbypassable. Atomic check+reserve through `db.transaction()` (the same
    device as `throttle()`), post-call signed-delta reconciliation, an `/account` resync on cold
    start or when unreconciled (transport failure OR 402), and singleflight coalescing at the
    outermost layer of `fetch()`.
  - The `costOf()` table is generated by a dev script from `x-credit-cost` in the committed
    `nansen-openapi-2026-07-23.json` into a committed `.ts` module; an unknown `(method, path)`
    yields `Infinity` — fail-closed, never `0`.
  - **OQ-1…OQ-5 resolutions:** the ceiling is the `credits_remaining` pinned at resync (never
    re-read live — double counting is forbidden) plus an optional `NANSEN_DAILY_CREDIT_CAP`; the
    gate lives inside the adapter, not in the Registry or the handler; chain scope is
    `ethereum` + `solana`, the same subset as M1; `entity.labels` escalation stays explicit opt-in
    on any plan; the self-imposed cap is introduced (optional).
  - M1 (4 tools, 9 adapters, 287 tests) is untouched — not one edit in
    `registry.ts`/`resolve-capability.ts`, the tool files, or the adapters. Existing code is touched
    only additively, in 6 files (`cache/sqlite-store.ts` `PAID_PROVIDER_IDS`, `cache/ddl.ts` usage
    table, `providers.config.ts`, `mcp-server/src/env.ts`, `.env.example`,
    `scripts/record-fixture.mjs` — the full list and the justification for each are in
    system-architecture.md §3.2).
  - Review found, and the architecture fixed, 2 critical defects in the first draft. **C-1:**
    reconciliation of composite capabilities (`smart-money.flows`/`token.risk`, 2 sub-calls each)
    was written per response and zeroed itself out (`(5-10)+(5-10)=0` instead of the 10 actually
    spent) — corrected to "exactly one reconciliation per `fetch()`, summed over all sub-responses;
    any unparseable header ⇒ delta=0 entirely, never partially". **C-2:** the bucket was recomputed
    from `Date.now()` at reconciliation instead of being pinned at reservation, so a cross-midnight
    response wrote a negative delta into someone else's day bucket — corrected to "`dayBucketMs` is
    pinned once on entry to the gate and passed down the whole call chain". Plus M-1 (the
    `BudgetStore` interface is now explicit, with the ceiling deliberately NOT in it — a documented
    deviation from the literal R-35, see §3.2), M-2 (`SqliteBudgetStore` upserts `providers` itself
    rather than relying on `SqliteCacheStore`'s bootstrap), and M-3 (the cross-process contract:
    `BEGIN IMMEDIATE` plus an explicit `timeout`, not the `DEFERRED` default).
  - Implementation is the Planning/Development phases; test suite still **287** (unchanged).

- 2026-07-23, **v2.2.1** — CoinGecko Pro contour fix: any key was previously sent as the
  `x-cg-demo-api-key` header to `api.coingecko.com`, so a Pro key effectively did not work (the pro
  host ignores the demo header — confirmed by a live probe of both hosts). An explicit
  `COINGECKO_PRO_API_KEY` is introduced (→ `pro-api.coingecko.com` + `x-cg-pro-api-key`; Pro wins
  when both keys are set; key formats are identical across tiers, so the contour is declared by a
  variable rather than sniffed) — adapter `coingecko`, `EnvSchema`, `.env.example`, +3 contour
  tests. Test suite — **287** (212 core + 75 mcp-server). Same date: the document's Index-Mode split
  (skill `architecture-format-core`) — sections 2–7 and 10–11 moved to `docs/architectures/`, the
  changelog into this file.

- 2026-07-23, **v2.2** — synchronization with the actual code after adversarial cycles 1–3 (14+8+1
  findings, commits 8d3ea79/066cce6/8a602cc) and a polish round (61f3ab2, 6 fixes + RF-1):
  `CapabilityRegistry.resolve()` — a cache failure is now **best-effort** and never produces
  `CapabilityUnavailableError`; `safeFetch` — timeout (`AbortSignal.timeout`, 15 s), Content-Length
  cap 10 MB, https check on the original URL **and** on redirects, `Authorization`/api-key headers
  stripped on a cross-host redirect; rate limiter — a concurrency-safe synchronous token bucket
  (negative backlog, no promise chains) plus a typed reject on `refillPerSec<=0` and a 30 s fairness
  cap (with a token refund); `pg-history` client — `pool.on('error')`,
  `connectionTimeoutMillis=10000`/`max=3`, sanitization of **all** failure paths including the
  `Pool` constructor; `onchain_get_token` — capability `token.metadata` → `token.price` (TTL 60 s,
  not 3600 s); `address`/`protocolSlug` — explicit `.max()` bounds; `onchain_new_pairs`
  materializes the default `limit` before the cache key; adapters hardened (rpc-evm hex regex,
  rpc-solana safe-integer lamports, dexscreener skip-and-log, defillama finite/non-negative tvl, a
  shared `stringify-truncated.ts`); cache DB — prepared statements, sweep every 50 writes,
  leak-safe constructor, honest `ageMs` on LRU promotion; the stale `isError` wording corrected (SDK
  1.29 intercepts any throw from a handler, not only zod validation). Test suite — **284** (209 core
  - 75 mcp-server).

- 2026-07-22, **v2.1** — adversarial review cycle 1 (CHANGES_REQUESTED → fixed): F-1 split the E2E
  suite into spawn and in-process; F-2 registered the `pg-history` adapter (plus history routing
  through `platform-explorer`); F-3 narrowed `dash-platform` to an interface + fixture contract in
  M1 (live gRPC transport is a separate backlog task, `@grpc/*` removed from M1 dependencies). Plus
  majors (dexscreener `pool.info`, `onchain_wallet_balances` chain enum narrowed) and minors
  (canonical key order in `deriveArgsHash`, an explicit decision on Dune R-8, the
  `Snapshot` camelCase↔snake_case note, the §2.2 diagram corrected).

- v2 — M1 read layer (TASK-003): canonical types, Adapter/Capability Registry, nine adapters, the
  two-level cache, 4 MCP tools.

- v1.1 (M0 sync) is kept as history below wherever it has not been revised.
