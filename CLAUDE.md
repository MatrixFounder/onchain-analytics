# Project — onchain-intel

Project-specific agent instructions live in this file.
The agentic-development framework is imported via `CLAUDE.local.md` (→ `CLAUDE.agentic.md`).

> Written in English because this file is loaded as an agent system prompt. The source
> design docs it summarizes are in Russian; on any conflict, **the source docs win**.

## What this is

`onchain-intel` — an on-chain analytics engine: provider adapters (Nansen / Dune / CoinGecko /
DexScreener / Bitquery / DAPI / …) → normalization into a canonical schema → cache + credit
budget → snapshotter / signals → an aggregating MCP server of our own. Plus a thin
`onchain-analytics` skill in Universal-skills (thin client to the MCP server + playbooks).

**Sources of truth:** [ADR-001](docs/onchain-analytics/ADR-001-tech-stack.md) (stack, 12 decisions),
[DB-SCHEMA-CONCEPT](docs/onchain-analytics/DB-SCHEMA-CONCEPT.md) (data schema + migrations),
[ROADMAP](docs/onchain-analytics/ROADMAP.md), [REPORT](docs/onchain-analytics/REPORT.md).
The digest below is working guidance; **the documents themselves are authoritative**.

## Stack (ADR-001, brief)

- **Language/runtime:** TypeScript / Node 22 LTS (D1, **accepted 2026-07-20**). Heavy
  quant/execution is **not written in-house** — delegated to external Python/Rust engines
  (Hummingbot+MCP, NautilusTrader, Freqtrade) as black boxes called over MCP/REST.
- **Packages/build:** pnpm + tsup (esbuild) + tsx; TypeScript strict (`"strict": true`,
  `noUncheckedIndexedAccess`) (D2).
- **MCP:** official `@modelcontextprotocol/sdk` — transports **stdio + Streamable HTTP**;
  tool schemas from **zod** (one source of truth: validation ↔ MCP schema); tools are
  workflow-oriented (`onchain_smart_money_flows`, not `get_data`) (D3). The internal canonical
  domain schema (Token/Wallet/Flow/OHLCV/Pool/Signal/Snapshot) is also zod, versioned (D5).
  **Transport at start: local stdio under Claude Code (accepted 2026-07-20);** public HTTP is
  added later behind the transport abstraction.
- **Cache + budget:** `better-sqlite3` + `lru-cache`; key = `(provider, capability,
  normalizedArgs)`; a `usage` table enforces the daily credit ceiling **before** any paid call (D6).
- **State/DB:** SQLite (`better-sqlite3`) + `drizzle-orm` → Postgres at scale (D7).
- **Scheduler:** `croner` + a durable SQLite job-log → BullMQ/Redis at scale (D8).
- **Secrets:** skill/project-local `.env` (0600) + zod env validation; secrets are **never**
  logged and **never** enter cache keys (D10).
- **License:** Apache-2.0. GPL engines (Freqtrade/OctoBot) are used **only as an external
  process** (called over MCP/REST), never vendored/linked; no-license repos — read patterns
  only, don't copy code (D12).

## Data-schema conventions (DB-SCHEMA-CONCEPT §1 — mandatory)

The schema is designed so that both migrations — engine (**SQLite→Postgres**) and host
(**server→server**) — are **mechanical** operations, not projects:

- **Portable types only:** `TEXT` / `INTEGER` / `REAL`. No SQLite-specific features (virtual
  tables, reliance on `AUTOINCREMENT`) and no Postgres-specific ones (arrays, enum types) in v0/v1.
- **Time is `INTEGER` epoch-ms UTC only.** No string local dates and no DB time functions in
  application logic. (In Postgres — `BIGINT`; `timestamptz` only via a view, stage 4.)
- **The app generates IDs — ULID as `TEXT`.** Never rely on the engine's autoincrement; IDs are
  globally unique and survive any move/merge.
- **JSON stored as `TEXT`;** parsing happens app-side, no `json1` SQL in logic.
- **Append-only + idempotent** (`snapshots`, `events`): each table has a natural UNIQUE dedup
  key; writes go through `INSERT ... ON CONFLICT DO NOTHING`. Re-running the snapshotter is
  harmless. **Exception — `aggregates`:** they are recomputable and written via upsert
  `INSERT ... ON CONFLICT DO UPDATE` (or a transactional delete+recompute of the period).
- **Enforce FK explicitly:** SQLite does **not** check `REFERENCES` by default → the Repository
  opens every SQLite connection with `PRAGMA foreign_keys=ON`; the `assets`/`metrics` registries
  are upserted **before** writing observations (a verify script counts orphan rows — must be zero).
- **Exact values as strings:** the canonical form is `value_raw TEXT` (credits and wei-like
  integers exceed the safe 2^53 of a JS number / `REAL`); `value_num REAL` is a lossy projection
  for charts/comparisons.
- **One metrics vocabulary:** metric/source names come from the `metrics` registry, not
  free-form strings chosen ad hoc (this is the persistent form of the canonical `Snapshot` type, D5).
- **Access via the Repository interface** (the `CacheStore`/`BudgetStore` pattern from D6) — an
  engine swap does not touch logic.
- **All state in a single `DATA_DIR`** (db file + WAL + exports); secrets live separately in
  `.env` (D10) and never enter the DB; code is stateless. Moving an installation = moving one directory.
- **In Postgres — its own schema `onchain`, not `public`:** the app role owns it,
  `search_path = onchain`, nothing is created in `public`. This gives isolation on a shared
  Postgres server and an exact `pg_dump --schema=onchain`. (drizzle: `pgSchema('onchain')` in the
  pg dialect, plain names in the sqlite dialect; in SQLite the isolation is the separate DB file itself.)

## Anti-goals (DB-SCHEMA-CONCEPT §1)

**NOT** 50–100 tables · **NOT** partitioning / materialized views now · **NOT** TimescaleDB ·
**NOT** a table-per-chain. Scaling happens via `asset`/`metric` columns + the registry (the
confirmed volumes of the first target don't justify more: Dash Platform — hundreds of rows per day).

## Working discipline

- **Vendor counters drift** — don't hardcode counts of tools/networks/endpoints; before
  integrating, probe the **live tool-list** (verification already caught Dune 26≠29).
- **Measure, don't eyeball** (§7): don't carry rough volume estimates from dialogs as facts;
  before designing for larger volumes, index ~1000 real blocks and take the actual table+index size.
- **Nothing silently:** retention cleanup — a dedicated job with a log of "how many rows, which
  period" (§4); host moves — recorded as "date, hosts, verify result" (§6); backfill/migrations —
  through a mandatory verify gate (row counts, `min`/`max(ts)`, spot-check `value_raw`, zero
  orphans; §5.3).
- **Adapters are hot-swappable** behind a stable internal interface (providers are fragile: Dune
  Sim sunset 2026-08-01, GoldRush/Moralis MCP in churn). Provider DTOs never leak outward
  (anti-corruption layer).

## Infra & VM ops (dev/test)

@CLAUDE.n8n.md

Dev/test infra runs in a Parallels Ubuntu VM on the Mac — reach it with **`ssh vm`** (never
hardcode the IP). For any VM / Docker / psql operation follow the **`vm-deploy`** skill
(`.agent/skills/vm-deploy/SKILL.md`): additive-only on Supabase, destructive ops need explicit
confirmation, and run SQL by **piping over stdin** into `docker exec -i` (never `-f /tmp/…` — that
reads the container FS and runs a stale copy).

- **Business data → Supabase** (container `supabase-db`, PostgreSQL 15.8), db `postgres`, schema
  **`onchain`** (not `public`). Apply migrations:
  `ssh vm 'docker exec -i supabase-db psql -qU supabase_admin -d postgres -v ON_ERROR_STOP=1' < sql/migrations/001_init.sql`
- **n8n's own DB** (container `postgres-n8n`) is **off-limits** (DB-SCHEMA §8.1).
- **n8n** is built/managed via the `n8n-mcp` + `n8n-builtin` MCP servers (project `.mcp.json`,
  gitignored; loads at Claude Code startup — restart after edits). Snapshotter workflows export to
  `n8n-workflows/`; existing Postgres credential is "Supabase DB". Secrets stay in n8n Credentials,
  never in the repo.
