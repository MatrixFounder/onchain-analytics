# ARCHITECTURE — `onchain-intel`

| Field             | Value                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Document type** | Living document — updated **in place**, never archived per task                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| **Delivered**     | M0 ✅ ([task-001](tasks/task-001-m0-discovery-skeleton.md)) · M1 ✅ ([task-003](tasks/task-003-m1-read-layer.md)) · M2 ✅ ([task-005](tasks/task-005-m2-alpha-paid.md)) · TASK-006 `universal-chain-registry` ✅ ([task-006](tasks/task-006-universal-chain-registry.md)) · TASK-007 `defillama-dex-volumes` ✅ ([task-007](tasks/task-007-defillama-dex-volumes.md)) · TASK-008 `blockscout-free-tier` ✅ ([task-008](tasks/task-008-blockscout-free-tier.md)) — 2026-07-29 · TASK-009 `btc-supply-independent-verification` ✅ ([task-009](tasks/task-009-btc-supply-independent-verification.md)) — 2026-07-29 · TASK-010 `adr-routing-and-transport` ✅ ([task-010](tasks/task-010-adr-routing-and-transport.md)) — 2026-07-31 · TASK-011 `single-tool-registry` ✅ ([task-011](tasks/task-011-single-tool-registry.md)) — 2026-08-02 |
| **ADR**           | [ADR-001-tech-stack.md](onchain-analytics/ADR-001-tech-stack.md) — **Accepted**, sign-off 2026-07-20, decisions D1–D12                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Data schema**   | [DB-SCHEMA-CONCEPT.md](onchain-analytics/DB-SCHEMA-CONCEPT.md) §1 — portable conventions, applied here to the cache DB and the `usage` ledger                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| **Roadmap**       | [ROADMAP.md](onchain-analytics/ROADMAP.md) — phases M0–M6                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| **Updated**       | 2026-08-02, **v4.7** — TASK-011: the tool inventory became data. One registry, every other list derived, and three deliberately NON-derived guards against a silent loss. Full changelog: [architectures/version-history.md](architectures/version-history.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| **Format**        | **Index mode** (skill `architecture-format-core`): section bodies live in [docs/architectures/](architectures/); this file holds the table of contents, one-line summaries, and the sections small enough to keep inline                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

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
provider, and thirteen workflow-oriented MCP tools served over local stdio.

### 1.1. Delivered scope

- **M0** — pnpm monorepo, TypeScript strict, `onchain_ping` over stdio, CI gate.
- **M1** — the read layer: canonical zod types, Adapter + Capability Registry, nine free adapters,
  the two-level cache (D6), SSRF gate, per-provider rate limit, and four tools
  (`onchain_get_token`, `onchain_wallet_balances`, `onchain_new_pairs`, `onchain_protocol_tvl`).
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
2. **The cache is two-level and engine-local:** `lru-cache` (hot) in front of `better-sqlite3`
   (persistent) in `DATA_DIR`, laid out per DB-SCHEMA-CONCEPT §1. The cache never lives in Postgres.
   > **Annotation to ADR-001 D6 (not an ADR edit):** the D6 addendum of 2026-07-20 ("dedicated
   > server deployment profile" → Postgres from day one for the cache) describes a **different**
   > profile — an always-on scheduler on a dedicated server. `onchain-intel` runs as a local stdio
   > MCP process under Claude Code, so the base D6 branch (SQLite + LRU) applies to it.
3. **`chain` is an open string plus `onchain_list_chains`, never a `z.enum`.** A closed enum over
   458 networks costs roughly 8.7k schema tokens in every model request (measured), which is the
   whole reason for the decision.
4. **Uncovered pairs are served by the coverage matrix and soft degradation**, never by a false
   promise of universality. There is no shared chain vocabulary between vendors — the live probe of
   2026-07-26 measured 461 ≠ 461, with 235 matches on the explicit cross-reference key and 255 on
   normalized names — so the canonical id has to be ours.
5. **The engine never writes to the snapshotter's Postgres.** `pg-history` is SELECT-only, and the
   database role it connects with should be SELECT-only server-side as well (§7).

## 2. Functional architecture

Functional components — Chain Registry, chain/address normalization by address family, Provider
Adapters + Capability Registry, canonicalization into zod types (D5), the two-level cache (D6),
the SSRF gate and rate limiter, `pg-history`, and the MCP server — with the component diagram and
the use cases. → [architectures/functional-architecture.md](architectures/functional-architecture.md)

## 3. System architecture

Two packages (`core` + `mcp-server`) and the detailed contracts of `@onchain-intel/core`: canonical
zod types, `ProviderAdapter` / `CapabilityRegistry` (cache faults are best-effort), the chain
registry and coverage modules, `providers.config.ts` (routes, allowlists, rate limits), the twelve
adapters and their input hardening, cache DDL + TTL table, the credit budget gate (ceiling formula
anchored on `usageAtObserve`, atomic check-and-reserve, singleflight, post-call reconciliation, the
velocity window), `safeFetch` / `throttle`, the read-only PG client, the MCP tool registry
(`ToolSpec` / `defineTool` — the inventory is data, and `needs` makes least privilege a runtime
fact), the test suite, and the component diagram.
→ [architectures/system-architecture.md](architectures/system-architecture.md)

## 4. Data Model (Conceptual)

Canonical entities (`Token`, `Wallet`/`Balance`, `Pool`, `OHLCV`, `Snapshot`, `SmartMoneyFlow`,
`EntityLabel`, `TokenRiskScore`), plus `ChainInfo` and `CoverageProbe` as **build artifacts rather
than tables** (offline gate, CI determinism, a reviewable security surface). The logical model of
the cache DB — `providers` ← `cache_entries`, `usage`, `usage_window` — with the ER diagram, the
coverage-matrix definition, and the two failure types that must never be merged.
→ [architectures/data-model.md](architectures/data-model.md)

## 5. Interfaces

Contracts for all thirteen MCP tools (input/output, `.max()` bounds, `_meta.cache`, `_meta.budget`), the
`ChainInputSchema` contract shared by every chain-accepting tool, the public API of
`packages/core`, and the provider integration table that is the source of the per-adapter SSRF
allowlist. → [architectures/interfaces.md](architectures/interfaces.md)

## 6. Technology stack

Dependencies with per-dependency justification, the monorepo layout, key `package.json` fields, and
the pnpm build topology. Neither the paid slice nor the chain registry added an npm dependency.
→ [architectures/technology-stack.md](architectures/technology-stack.md)

## 7. Security

Secrets (D10), a cache key that provably excludes env values, stdout discipline, the SSRF gate
including the curated `rpcHosts` column for multichain RPC — the one non-trivial risk in the chain
work, since a gate whose allowlist is set by an untrusted source is not a gate — rate limiting plus
the independent budget guard, PG SELECT-only, supply chain and licences, and the provenance manifest
that pins live-recorded fixtures. → [architectures/security.md](architectures/security.md)

## 8. Scalability and performance

The engine is single-process: `lru-cache` + SQLite, an in-memory rate limiter and registry. The
abstractions (`CacheStore`, `BudgetStore`, `ProviderAdapter`, `CapabilityRegistry`) are shaped so
that Redis / BullMQ / Postgres (M6, ADR-001 §Revisit) can be swapped in without rewriting calling
code — the same principle as D6/D7/D8.

Nothing introduces singleton state that would have to be unwound to scale out:
`CapabilityRegistry`, `SqliteCacheStore`, `SqliteBudgetStore` and the chain registry are all
factories, not module-level singletons. That keeps them testable today and multi-instance-capable
later.

The chain registry is the only large in-memory structure, and it is not a scaling concern: 458 rows
are tens of kilobytes, indexed once at load into three maps, and resolved in O(1) on an exact match.
The O(n) path exists only when building "did you mean" candidates for a miss.

Two concurrency contracts are load-bearing and documented where they are implemented (§3.2):
`throttle()` decides synchronously so concurrent callers cannot read the same pre-wait state, and
`checkAndReserve()` runs its read-compare-write inside `BEGIN IMMEDIATE`, which makes the budget
correct across the multiple stdio sessions that share one `cache.sqlite3`.

## 9. Reliability and fault tolerance

Hot-swap fallback along a route and explicit unavailability instead of a silent `undefined`; an
uncovered (capability, chain) pair raised as its own error type; a corrupt registry failing loudly
at startup; retry and circuit breakers deliberately absent; paid failures travelling the same
thread as any other unavailability; observability through stderr plus `_meta`.
→ [architectures/reliability.md](architectures/reliability.md)

## 10. Deployment

Environments (dev, under Claude Code), CI step order — `core` is built before typecheck and test
because the package is consumed through `dist/` — configuration (`EnvSchema`,
`providers.config.ts`), and the dev deployment instructions.
→ [architectures/deployment.md](architectures/deployment.md)

## 11. Open questions

What is genuinely open: the live DAPI gRPC transport (backlog), a second keyless Solana RPC
endpoint, the `dashpay/platform` licence check, ERC-20/SPL balances, who runs the registry sync and
how often (OQ-6), and how n8n will call engine capabilities at M3 (OQ-M3-1, to be settled by an ADR
at M3 kickoff). Everything else is recorded as resolved, with the reasoning that keeps it closed.
→ [architectures/open-questions.md](architectures/open-questions.md)
