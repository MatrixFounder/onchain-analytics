# ARCHITECTURE — `onchain-intel`

| Field             | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Document type** | Living document — updated **in place**, never archived per task                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| **Delivered**     | M0 ✅ ([task-001](tasks/task-001-m0-discovery-skeleton.md)) · M1 ✅ ([task-003](tasks/task-003-m1-read-layer.md)) · M2 ✅ ([task-005](tasks/task-005-m2-alpha-paid.md)) · TASK-006 `universal-chain-registry` ✅ ([task-006](tasks/task-006-universal-chain-registry.md)) · TASK-007 `defillama-dex-volumes` ✅ ([task-007](tasks/task-007-defillama-dex-volumes.md)) · TASK-008 `blockscout-free-tier` ✅ ([task-008](tasks/task-008-blockscout-free-tier.md)) — 2026-07-29 · TASK-009 `btc-supply-independent-verification` ✅ ([task-009](tasks/task-009-btc-supply-independent-verification.md)) — 2026-07-29 · TASK-010 `adr-routing-and-transport` ✅ ([task-010](tasks/task-010-adr-routing-and-transport.md)) — 2026-07-31 · TASK-011 `single-tool-registry` ✅ ([task-011](tasks/task-011-single-tool-registry.md)) — 2026-08-02 · T-012 `capability-manifest-policy-tier-deadline` ✅ ([task-012](tasks/task-012-capability-manifest-and-call-deadline.md)) — 2026-08-04 · T-013 `series-merge-and-history-tool` ✅ ([task-013](tasks/task-013-series-merge-and-history-tool.md)) — 2026-08-10                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **ADR**           | [ADR-001-tech-stack.md](onchain-analytics/ADR-001-tech-stack.md) — **Accepted**, sign-off 2026-07-20, decisions D1–D12                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| **Data schema**   | [DB-SCHEMA-CONCEPT.md](onchain-analytics/DB-SCHEMA-CONCEPT.md) §1 — portable conventions, applied here to the cache DB and the `usage` ledger                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| **Roadmap**       | [ROADMAP.md](onchain-analytics/ROADMAP.md) — phases M0–M6                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Updated**       | 2026-08-12, **v4.11** — T-013 `series-merge-and-history-tool` **SHIPPED 2026-08-10**; the capability manifest carries **26** rows and the server publishes **20** tools (both measured, not quoted). Below that, v4.10 as written: the merge mechanism (ADR-002 D5/D6) gets its activation model (two independent gates — manifest `mergeable` eligibility plus a route-level `merge` flag), its compiled conflict rank (reuses `adapterIds` order, narrowly and provisionally), and its policy-evaluation point (per participant); `CapabilityResolution` gains three optional, merge-only fields; the 14th tool `onchain_dash_platform_history` is contracted. Three questions the task left open (`OQ-T013-2`/`3`/`4`) are closed in [architectures/open-questions.md](architectures/open-questions.md). Below that: T-012 BUILT 2026-08-04, hardened over three adversarial cycles plus a fix pass, and OQ-T012-6 resolved (ten tasks, suite 1195 → 1473, zero credits spent) — the answer-sufficiency policy is a serialisable descriptor resolved against a class registry and validated at construction (D2); capabilities carry a manifest of 26 rows, each deadline number recorded with its measured envelope and the applied ceiling (D3); an absolute call deadline threads resolve→fetch→throttle→safeFetch with real cancellation, and stops at the credit reservation (D4); `tier` collapsed four disagreeing classifications of paidness into one (D8); `trust` is declared with the validator as its only reader (D9 slice); `CapabilityRoute.chains` is deleted (OQ-C); expiry does not throw in every branch — a walk where every source was entered and every one answered returns that answer past the ceiling, marked with `_meta.timing.overrunMs` (OQ-T012-6: the ceiling bounds SPENDING, not the moment of delivery). Full changelog: [architectures/version-history.md](architectures/version-history.md) |
| **Format**        | **Index mode** (skill `architecture-format-core`): section bodies live in [docs/architectures/](architectures/); this file holds the table of contents, one-line summaries, and the sections small enough to keep inline                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

---

> This is a living INDEX. Section bodies live in `docs/architectures/`. Edit the section file; keep
> the one-line summary here in sync (`architecture-format-core` §After the Split). Section numbers
> are stable — a cross-reference like "§3.2" still means chapter 3 (`system-architecture.md`).

## Contents

| §   | Section                                                             | Location      |
| --- | ------------------------------------------------------------------- | ------------- |
| 1   | [Task description](#1-task-description)                             | inline        |
| 2   | [Functional architecture](architectures/functional-architecture.md) | separate file |
| 3   | [System architecture](architectures/system-architecture.md)         | separate file |
| 4   | [Data Model (Conceptual)](architectures/data-model.md)              | separate file |
| 5   | [Interfaces](architectures/interfaces.md)                           | separate file |
| 6   | [Technology stack](architectures/technology-stack.md)               | separate file |
| 7   | [Security](architectures/security.md)                               | separate file |
| 8   | [Scalability and performance](#8-scalability-and-performance)       | inline        |
| 9   | [Reliability and fault tolerance](architectures/reliability.md)     | separate file |
| 10  | [Deployment](architectures/deployment.md)                           | separate file |
| 11  | [Open questions](architectures/open-questions.md)                   | separate file |
| —   | [Version history (changelog)](architectures/version-history.md)     | separate file |

## 1. Task description

Requirements and the RTM live in [docs/TASK.md](TASK.md); the milestone exit criteria live in
[ROADMAP.md](onchain-analytics/ROADMAP.md). This section summarizes what the system is and which
decisions constrain it.

`onchain-intel` is an on-chain analytics engine: provider adapters (Nansen / Dune / CoinGecko /
DexScreener / DeFiLlama / RPC / Dash DAPI / …) → normalization into canonical zod types → cache +
credit budget → an aggregating MCP server of our own. The stack and its twelve decisions (D1–D12)
are **Accepted** in ADR-001; this document does not revisit them, it makes them concrete.

**What the engine is today** — twelve provider adapters behind one hot-swappable interface (eleven
of them serving something; `dune` is a config stub), a chain registry of 458 networks, a two-level
cache, an SSRF gate and per-provider rate limiting, a credit budget guard on the single paid
provider, and twenty workflow-oriented MCP tools served over local stdio. **T-013 (shipped 2026-08-10)** added a compiled multi-source merge to two `series` capabilities and
the tool publishing the merged history — see §3/§11. The server publishes twenty tools; the
capability manifest carries twenty-six rows.

### 1.1. Delivered scope

- **M0** — pnpm monorepo, TypeScript strict, `onchain_ping` over stdio, CI gate.
- **M1** — the read layer: canonical zod types, Adapter + Capability Registry, nine free adapters,
  the two-level cache (D6), SSRF gate, per-provider rate limit, and four tools
  (`onchain_get_token`, `onchain_wallet_balances`, `onchain_active_pairs`, `onchain_protocol_tvl`).
  `dash-platform` ships as an interface + fixture contract (live gRPC transport is backlog) and
  `platform-explorer` carries all real Dash traffic; `dune` is an interface/config stub.
- **M2** — the first paid slice: the tenth adapter `nansen` over REST `api.nansen.ai`, three paid
  capabilities with no free fallback (`smart-money.flows`, `entity.labels`, `token.risk`), three
  canonical types, three tools (`onchain_smart_money_flows`, `onchain_entity_label`,
  `onchain_token_risk`), and the credit budget guard (`usage` ledger + `BudgetStore`).
- **TASK-006** — chains stop being code. A network is a registry row: the canonical id is CAIP-2,
  vendor ids are mapping columns, and coverage of a (capability, chain) pair is **derived** from
  `routes × adapter.chainSupport()` rather than kept as a second catalogue. The `ethereum | solana`
  literal that used to be duplicated across five layers is gone; both names remain valid aliases
  indefinitely. Two free tools were added (`onchain_list_chains`, `onchain_chain_tvl`).
- **TASK-007** — the free DEX-volume tier: `dex.volume.history` on the existing keyless `defillama`
  adapter, one tool (`onchain_dex_volume`), and coverage derived from the vendor's own DEX chain
  list rather than from `vendors.defillama` — which covers 458 chains for TVL but only 274 for
  volume. `safeFetch`'s response-size cap became real for responses with no `Content-Length`
  (R-47(1)), because the host this tier talks to sends none.
- **TASK-008** — the free explorer tier: the eleventh adapter `blockscout` over the keyless REST
  facade, `token.holders` retargeted off the dead `dune` stub and `entity.labels` put in front of
  paid Nansen, plus `onchain_token_holders`. It is where the vendor free text addressed **at a
  language model** (`instructions`) had to be dropped rather than truncated, and where a route
  learned `isSatisfying` so a truthful "I have nothing" stops shadowing the provider behind it.
- **TASK-009** — independent verification of BTC numbers: the twelfth adapter `blockchain-info`
  (keyless), `chain.supply` on `bitcoin` with `onchain_chain_supply`, and a **reference-source axis
  in the eval** — a second, unrelated vendor declared as DATA in `probes.json`. Its finding shaped
  the design: checking supply against the halving formula is a tautology, because the vendor derives
  it the same way; only the block **height** can be independently contradicted.

### 1.2. Standing constraints

These are owner decisions, not architecture preferences. They bind every future change.

1. **The autonomous loop stays on n8n + Postgres — permanently.** The snapshotter
   (`onchain-snapshotter`, `onchain-verify`, `onchain-error-alert`; see `CLAUDE.n8n.md`) writes
   Dash Platform / ZEC snapshots independently of the engine, and rule scheduling plus alerting
   join it at M3. Cron jobs and push notifications cannot live in the MCP server, which exists only
   while a host session is open. The engine is the pull side: it calls DAPI and platform-explorer
   directly for live data, and reads accumulated history read-only through the `pg-history` adapter.
   The two paths never meet in code.
   > **Scope after T-014.** The premise "exists only while a host session is open" holds for the
   > **local** deployment profile. The **network** profile keeps running after a session ends, so
   > the retention job R-32.3 requires is schedulable inside it. It is not scheduled there:
   > `OQ-T014-DEP-2` was closed by the owner in favour of an n8n workflow beside the snapshotter,
   > and installation still needs explicit approval.
2. **The cache is two-level and engine-local:** `lru-cache` (hot) in front of `better-sqlite3`
   (persistent) in `DATA_DIR`, laid out per DB-SCHEMA-CONCEPT §1. **In the local deployment profile
   the cache never lives in Postgres.**
   > **Scope corrected by T-014, owner decision 2026-08-12.** This constraint is scoped to the
   > **local** profile. The **network** profile keeps runtime data in Postgres, schema `onchain` —
   > which is what the ADR-001 D6 addendum of 2026-07-20 already prescribes for a dedicated server.
   > The addendum is therefore the source, not a contradiction: T-014 introduces exactly the profile
   > it was written for. No ADR edit is required; the earlier annotation on this line read the
   > addendum as describing a different profile and is superseded.
3. **`chain` is an open string plus `onchain_list_chains`, never a `z.enum`.** A closed enum over
   458 networks costs roughly 8.7k schema tokens in every model request (measured), which is the
   whole reason for the decision.
4. **Uncovered pairs are served by the coverage matrix and soft degradation**, never by a false
   promise of universality. There is no shared chain vocabulary between vendors — the live probe of
   2026-07-26 measured 461 ≠ 461, with 235 matches on the explicit cross-reference key and 255 on
   normalized names — so the canonical id has to be ours.
5. **The engine never writes to the snapshotter's tables.** `pg-history` is SELECT-only, and the
   database role it connects with should be SELECT-only server-side as well (§7).
   > **Scope corrected by T-014.** The network profile writes its OWN eight tables into schema
   > `onchain` of the same database. The snapshotter's `assets`, `metrics` and `snapshots` stay
   > unwritable to the engine's role. The constraint is about those tables, not about the database
   > file — the wording "the snapshotter's Postgres" predates a shared instance. See §10.5.

## 2. Functional architecture

Functional components — Chain Registry, chain/address normalization by address family, Provider
Adapters + Capability Registry, canonicalization into zod types (D5), the two-level cache (D6),
the SSRF gate and rate limiter, `pg-history`, and the MCP server — with the component diagram and
the use cases. → [architectures/functional-architecture.md](architectures/functional-architecture.md)

## 3. System architecture

> **T-013 SHIPPED 2026-08-10.** The design below is what was built; the merge is live on both
> `*.history` routes and proven by a live call. The merge mechanism (ADR-002 D5/D6) gets its
> full design: activation needs two independent gates (manifest `mergeable` eligibility, R-159 —
> already decided — plus a new route-level `merge` flag, closing `OQ-T013-2`); the compiled conflict
> rank reuses the route's own `adapterIds` order rather than a new table (`OQ-T013-3`); `policy` is
> evaluated per participant (`OQ-T013-4`). `CapabilityResolution` gains three optional fields visible
> only on a merge walk; the tool `onchain_dash_platform_history` is contracted. It was the 14th when
> that sentence was written and the server publishes 20 today (R-23.3, AC-17b). See
> "Merge mechanism" in [architectures/system-architecture.md](architectures/system-architecture.md)
> and the three closed entries in
> [architectures/open-questions.md](architectures/open-questions.md).

> **T-012 is BUILT as of 2026-08-04.** The banner that stood here said "DECIDED, not built, as of
> 2026-08-03" and was true for one day. Ten tasks delivered the manifest, the policy descriptor,
> `tier`/`trust` and the call deadline; the suite went 1195 → 1473 (three adversarial cycles plus a
> fix pass are included in that figure). Individual `PLANNED` markers in
> the section files are stale wherever they name a T-012 item — the code is the authority, and
> `architectures/version-history.md` carries what landed.
>
> One T-012 claim is **narrower than this document once stated**: expiry does not throw in every
> branch. A walk in which every source was asked and every one answered returns that answer even
> past the ceiling, because H-1 reaches its return first. Measured, reproduced, and **resolved by the
> owner on 2026-08-05** (OQ-T012-6): that answer is returned rather than discarded — the time and, on
> a paid route, the credit are already spent, and only the caller can judge whether a late-but-complete
> answer is still useful. Two conditions came with it: the deadline is documented as a bound on
> SPENDING rather than on answering, and the overrun is reported as `_meta.timing.overrunMs` instead of
> being silent.

Two packages (`core` + `mcp-server`) and the detailed contracts of `@onchain-intel/core`: canonical
zod types, `ProviderAdapter` / `CapabilityRegistry` (cache faults are best-effort; construction
validates every route's policy descriptor and manifest entry, T-012), the chain registry and
coverage modules, `providers.config.ts` (routes, allowlists, rate limits, provider `tier`/`trust`),
the capability manifest (`shape`/`ttlSeconds`/`deadlineMs`/`shareable`) and its policy-class registry
(D2/D3), a real call deadline threaded resolve→fetch→throttle→safeFetch (D4), the twelve adapters and
their input hardening, cache DDL + TTL table (`ttlFor()` reads the manifest), the credit budget
gate (ceiling formula anchored on `usageAtObserve`, atomic check-and-reserve, singleflight, post-call
reconciliation, the velocity window), `safeFetch` / `throttle`, the read-only PG client, the MCP tool
registry (`ToolSpec` / `defineTool` — the inventory is data, and `needs` makes least privilege a
runtime fact), the test suite, and the component diagram.
→ [architectures/system-architecture.md](architectures/system-architecture.md)

## 4. Data Model (Conceptual)

Canonical entities (`Token`, `Wallet`/`Balance`, `Pool`, `OHLCV`, `Snapshot`, `SmartMoneyFlow`,
`EntityLabel`, `TokenRiskScore`), plus `ChainInfo`, `CoverageProbe`, and — since T-012 — the
`CapabilityManifest`/`PolicyDescriptor` pair, all as **compiled artifacts rather than tables**
(offline gate, CI determinism, a reviewable security surface). The logical model of the cache DB —
`providers` ← `cache_entries`, `usage`, `usage_window` — with the ER diagram, the coverage-matrix
definition, and the three failure types (a call-deadline expiry is the third) that must never be
merged. **Shipped (T-013, 2026-08-10):** the manifest's `set | series` arm carries a merge-eligibility
field, and `CapabilityResolution` carries three optional, merge-only fields.

**T-014 adds eight persistent tables** (§4.5): `users`, `access_profiles`, `api_tokens`,
`access_audit` for identity; `provider_buckets` for the shared vendor limiter; `request_trace`,
`diagnostics` and `retention_runs` as operational records. They are declared once and shipped to
both engines — SQLite in `DATA_DIR` for the local profile, Postgres schema `onchain` for the
network one. `request_trace` is the append-only record T-015 charges from; T-014 only writes it.
Where the reference identity model and DB-SCHEMA-CONCEPT §1 disagree, the canon wins in five
columns, and §4.5.2 says which.
→ [architectures/data-model.md](architectures/data-model.md)

## 5. Interfaces

Contracts for all twenty MCP tools that are registered today, plus one designed and not yet
registered — `onchain_pool_info`, which gives `pool.info` its first consumer and closes L-15
(R-21.1, §5.1.7). Input/output, `.max()` bounds, `_meta.cache`, `_meta.budget`, the
`ChainInputSchema` contract shared by every chain-accepting tool, the public API of
`packages/core`, and the provider integration table that is the source of the per-adapter SSRF
allowlist, including T-013's `onchain_dash_platform_history`. **Plus the three free tools added
2026-08-11 over documents the engine already loads (WI-49/WI-50): `onchain_list_protocols` — the
protocol POPULATION on a chain, ranked by TVL or by 1d/7d/30d growth, so a protocol question no
longer has to start from a slug the caller already knows — and `onchain_chain_tvl_history` /
`onchain_protocol_tvl_history`, daily TVL runs carrying the same `window`/`gapDays`/`truncated`
contract `onchain_dex_volume` publishes, produced by the same shaper.** **Plus WI-51's two network-
activity tools: `onchain_gas_price` — served by a NODE where one is curated and by Blockscout
otherwise, so the capability does not die with one vendor's auth decision (L-6) — and
`onchain_chain_transactions`. Active addresses remain unserved and are named as such in that tool's
own description rather than being answered with the cumulative all-time count that looks like them.**

**WI-52 — the risk layer, partially:** `onchain_protocol_incidents` attaches DeFiLlama's recorded
security incidents to a protocol. It is EDITORIAL data, not on-chain, so it carries its own age
(`feedThroughTs`) instead of inheriting a TVL number's freshness, and it distinguishes four
different meanings of "no incidents" so an empty list can never be read as "safe". Developer
activity and funding rounds stay unserved and are named in the tool's description.**
→ [architectures/interfaces.md](architectures/interfaces.md)

## 6. Technology stack

Dependencies with per-dependency justification, the monorepo layout, key `package.json` fields, and
the pnpm build topology. Neither the paid slice nor the chain registry added an npm dependency.
→ [architectures/technology-stack.md](architectures/technology-stack.md)

## 7. Security

Secrets (D10), a cache key that provably excludes env values, stdout discipline, the SSRF gate
including the curated `rpcHosts` column for multichain RPC — the one non-trivial risk in the chain
work, since a gate whose allowlist is set by an untrusted source is not a gate — rate limiting plus
the independent budget guard, PG SELECT-only, supply chain and licences, and the provenance manifest
that pins live-recorded fixtures.

**Everything above is the OUTBOUND half.** Until T-014 there was no inbound control at all, because
there was no remote caller. §7.5 designs the inbound trust boundary: bearer verification before
routing, the principal and its two roles (`admin` sees `_meta.budget`, `user` does not), the
perimeter (`allowedHosts`, `allowedOrigins`, inbound DNS-rebinding protection, loopback bind, CORS
denied, TLS at the proxy), the SSRF gate re-read under untrusted input, and two renderings of every
refusal — full to the server log, sanitised to the client.
→ [architectures/security.md](architectures/security.md)

## 8. Scalability and performance

**Read this section per deployment profile.** The local profile is one process serving one operator
over stdio. The network profile is T-014 — DESIGNED, not built as of 2026-08-12, designed in
[architectures/system-architecture.md](architectures/system-architecture.md) §3.4 — and serves many
clients from one process.

The engine is single-process: `lru-cache` + SQLite, an in-memory registry. The abstractions
(`CacheStore`, `BudgetStore`, `ProviderAdapter`, `CapabilityRegistry`) are shaped so that Redis /
BullMQ / Postgres (M6, ADR-001 §Revisit) can be swapped in without rewriting calling code — the same
principle as D6/D7/D8.

**The rate limiter stops being in-memory in the network profile (T-014, R-7).** This paragraph read
"an in-memory rate limiter" until 2026-08-12. Bucket state moves out of
`packages/core/src/net/rate-limit.ts:255` (`const buckets = new Map<string, BucketState>();`) into a
store keyed `(providerId, scopeKey)`. **Two processes of the same profile over one store** then hold
one shared vendor ceiling — two `network` processes on one Postgres, or two `local` processes on one
`DATA_DIR`. The store follows the storage axis, not the transport, so naming `DATA_DIR` alone would
describe the SQLite axis only. The default scope is one bucket per provider, and `rpc-evm` is the
only provider declaring a narrower one.

**Why.** A vendor ceiling is counted per vendor account, and a per-process bucket multiplies the
observed call rate by the number of processes.

**On a limiter-store failure each process falls back to its own bucket at the declared ceiling.**
The sum across processes may then exceed that ceiling. The design and the two rejected alternatives
are in [architectures/system-architecture.md](architectures/system-architecture.md) §3.4.4.

Nothing introduces singleton state that would have to be unwound to scale out:
`CapabilityRegistry`, `SqliteCacheStore`, `SqliteBudgetStore` and the chain registry are all
factories, not module-level singletons. That keeps them testable today and multi-instance-capable
later.

**One module-level singleton does exist.** `packages/core/src/net/rate-limit.ts:409`
(`export const throttle: Throttle = createThrottle();`) is the fallback ten adapters take when no
throttle is injected. The network profile stops taking it: `index.ts` injects a throttle built over
the limiter store instead.

The chain registry is the only large in-memory structure, and it is not a scaling concern: 458 rows
are tens of kilobytes, indexed once at load into three maps, and resolved in O(1) on an exact match.
The O(n) path exists only when building "did you mean" candidates for a miss.

**Per-session memory is bounded by a declared ceiling, not by demand.** The network profile holds
one `McpServer` and one transport per session, and everything else a tool touches is a process-level
reference. Applied ceiling: 64 concurrent sessions; measured: none — §3.4.2 records the number as an
assertion awaiting its first month of operation.

Two concurrency contracts are load-bearing and documented where they are implemented (§3.2). **T-014
restates BOTH**, because each was stated in terms of SQLite and the network profile has no SQLite.

- `throttle()` today decides synchronously, so concurrent callers cannot read the same pre-wait
  state. With a shared bucket the decision includes a round trip, and the atomicity moves into one
  `INSERT … ON CONFLICT DO UPDATE … RETURNING` statement
  ([architectures/data-model.md](architectures/data-model.md) §4.5.6).
- `checkAndReserve()` runs its read-compare-write inside `BEGIN IMMEDIATE` **on the SQLite storage
  axis**. That is the mechanism, not the guarantee. On the Postgres axis the same guarantee is
  restated as a conditional upsert per limit, inside one transaction on one checked-out connection,
  with an empty `RETURNING` as the refusal
  ([architectures/system-architecture.md](architectures/system-architecture.md) §3.4.8, the
  canonical statement).

**Read §8 per storage axis, not per transport.** Storage is an axis of its own: `local` is SQLite,
`network` is Postgres, and `network-sqlite` exists so the transport can be debugged without one.

**Singleflight coalesces two paying clients in the network profile.** The map is the `nansen`
adapter's, one instance per process (`packages/core/src/adapters/nansen/singleflight.ts:29`,
`const inFlight = new Map<string, Promise<unknown>>();`). Its key is `deriveArgsHash(cap, args)` and
the principal is not part of it, so two principals asking one question ask the vendor once. Both
clients are charged and the vendor is called once.

**Why.** The justification recorded in §3.2 was "two processes = two clients", which stops holding
when one process carries two clients' sessions. Client price and vendor spend are separate numbers
in ADR-003 D4, so coalescing changes the second without changing the first.

## 9. Reliability and fault tolerance

Hot-swap fallback along a route and explicit unavailability instead of a silent `undefined`; an
uncovered (capability, chain) pair raised as its own error type; since T-012, a call-deadline expiry
as a THIRD distinct type (reusing the existing `tried`-list diagnostics) and an unregistered policy
`kind`/missing manifest entry failing loudly at `CapabilityRegistry` construction, the same
discipline a corrupt chain registry already gets at startup; retry/circuit breakers deliberately
absent; paid failures travelling the same thread as any other unavailability; observability through
stderr plus `_meta`. **Shipped (T-013, 2026-08-10):** a merge-enabled route refines this into three
participant states, layered on top of the three failure types rather than merged with them.
→ [architectures/reliability.md](architectures/reliability.md)

## 10. Deployment

CI step order — `core` is built before typecheck and test because the package is consumed through
`dist/` — configuration (`EnvSchema`, `providers.config.ts`), and the deployment instructions.

**T-014 replaces "dev only, local" with two axes and their named combinations** (§10.1.1). Transport
is stdio or Streamable HTTP; storage is SQLite or Postgres. `local` is stdio plus SQLite, `network`
is HTTP plus Postgres, and `network-sqlite` exists so the transport can be debugged without standing
up Postgres. §10.3.1 classifies every setting by where it is ALLOWED to live: secrets and bootstrap
values stay in `.env` permanently — the second because a Postgres connection setting cannot be read
from Postgres — and only narrowing settings may move to a database later. §10.5 makes schema
qualification a correctness condition rather than a connection setting, because `search_path` did
not survive the pooler (WI-47). §10.6 routes diagnostics to the container log and a table whose
cleanup is a named job with a recorded row count.
→ [architectures/deployment.md](architectures/deployment.md)

## 11. Open questions

What is genuinely open: the live DAPI gRPC transport (backlog), a second keyless Solana RPC
endpoint, the `dashpay/platform` licence check, ERC-20/SPL balances, who runs the registry sync and
how often (OQ-6), how n8n will call engine capabilities at M3 (OQ-M3-1, settled by ADR-003 at M3
kickoff), and — new with T-012 — **one** item: the `shape` of 12 of 20 capabilities. **Resolved with
T-012:** `CapabilityRoute.chains` (OQ-C) is deleted; a self-contradiction in ADR-002's own staging of
D9 (`trust`) is recorded rather than silently patched; and three owner decisions of 2026-08-03 close
what the design had left open — **OD-4** (a deadline expiry always throws, naming answered and
never-asked sources, and never returns the surviving partial), **OD-5** (the two contested `trust`
values: `platform-explorer` = `authoritative`, `pg-history` = `community` as a declared placeholder
replaced in T-016), and **OD-6** (the `safeFetchImpl` seam is built, rather than the H3 guarantee
narrowed to the limiter path). **Resolved with T-013's design (2026-08-05):** `OQ-T013-2` (a route
needs its own `merge` activation flag, on top of manifest eligibility — two independent gates, not
one), `OQ-T013-3` (the compiled conflict rank reuses `adapterIds` order, not a new table), and
`OQ-T013-4` (route `policy` is evaluated per participant, preserving H-1's existing cache-hit
application). Everything else is recorded as resolved, with the reasoning that keeps it closed.
→ [architectures/open-questions.md](architectures/open-questions.md)
