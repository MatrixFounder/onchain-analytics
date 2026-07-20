-- migrations/001_init.sql — onchain-intel v0 snapshotter schema (Postgres profile).
-- Source of truth: DB-SCHEMA-CONCEPT.md §2 (v0 DDL) + §5 (SQLite→PG type map) + §8 (deploy profile).
-- Run against onchain_intel as onchain_app (after 00_bootstrap.sql):
--
--   psql "postgresql://onchain_app@<host>:5432/onchain_intel" -f migrations/001_init.sql
--
-- Idempotent: CREATE ... IF NOT EXISTS + seed via ON CONFLICT DO NOTHING. Safe to re-run.
--
-- Conventions (mandatory, do not violate):
--   * time is BIGINT epoch-ms UTC (§1.2)                       — no timestamptz, no DB time funcs in logic
--   * value_raw is TEXT — the EXACT value as a string (§1.7)   — credits exceed 2^53; never store as float
--   * value_num is DOUBLE PRECISION — lossy projection only (§1.7)
--   * id is server-generated uuid (§8.2)                       — dedup key is natural-UNIQUE, not id
--   * append-only + ON CONFLICT DO NOTHING dedup (§1.5)        — re-running the snapshotter is harmless
--   * FK enforced (§1.6, always on in PG)                      — registries seeded before observations

\set ON_ERROR_STOP on

CREATE SCHEMA IF NOT EXISTS onchain;
SET search_path TO onchain;

-- ── Registry: assets (справочник, десятки строк) ────────────────────────────
CREATE TABLE IF NOT EXISTS onchain.assets (
  id            TEXT PRIMARY KEY,   -- 'dash-platform' | 'zec' | ...
  chain_family  TEXT,               -- 'dash' | 'zcash' | 'evm' | ...
  layer         TEXT,               -- 'l1' | 'l2'
  coingecko_id  TEXT,
  notes         TEXT
);

-- ── Registry: metrics (persistent vocabulary of canonical Snapshot type, D5) ─
CREATE TABLE IF NOT EXISTS onchain.metrics (
  id               TEXT PRIMARY KEY, -- 'shielded_pool_balance_credits' | ...
  unit             TEXT NOT NULL,    -- 'credits' | 'zec' | 'count' | 'pct'
  kind             TEXT NOT NULL,    -- 'state' | 'flow' | 'derived'
  description      TEXT,
  gameability      TEXT,             -- how it's gamed + which derived signal hedges it (§4 standards)
  source_priority  TEXT              -- JSON array as TEXT, e.g. ["platform-explorer","dapi"]
);

-- ── Time-series points (append-only; main v0 table) ─────────────────────────
CREATE TABLE IF NOT EXISTS onchain.snapshots (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),  -- server-generated (PG13+ core)
  ts          BIGINT NOT NULL,          -- epoch-ms UTC, measurement moment
  ts_bucket   BIGINT NOT NULL,          -- floor(ts/3600000)*3600000 — hourly bucket (dedup key part)
  source      TEXT   NOT NULL,          -- 'platform-explorer' | 'zechub' | 'dapi'
  asset       TEXT   NOT NULL REFERENCES onchain.assets(id),
  metric      TEXT   NOT NULL REFERENCES onchain.metrics(id),
  value_raw   TEXT   NOT NULL,          -- EXACT value as string (canon; never float)
  value_num   DOUBLE PRECISION,         -- lossy projection for charts/comparisons
  height      BIGINT,                   -- source block height, if provided
  raw_json    TEXT,                     -- full source response (RAW layer; retention §4)
  created_at  BIGINT NOT NULL,          -- epoch-ms UTC, row insert moment
  CONSTRAINT uq_snapshots_dedup UNIQUE (source, asset, metric, ts_bucket)
);
CREATE INDEX IF NOT EXISTS idx_snapshots_series ON onchain.snapshots (asset, metric, ts);

-- ── Seed: assets ────────────────────────────────────────────────────────────
INSERT INTO onchain.assets (id, chain_family, layer, coingecko_id, notes) VALUES
  ('dash-platform', 'dash',  'l2', 'dash',
     'Dash Platform (Evolution) L2 — credits, identities, documents, shielded pool (Orchard, mainnet 2026-07-17)'),
  ('zec',           'zcash', 'l1', 'zcash',
     'Zcash L1 — privacy-adoption calibration base (shielded / total supply)')
ON CONFLICT (id) DO NOTHING;

-- ── Seed: metrics (grounded in live endpoint fields, probed 2026-07-20) ──────
-- dash-platform ← platform-explorer /transactions/shielded/statistic
INSERT INTO onchain.metrics (id, unit, kind, description, gameability, source_priority) VALUES
  ('shielded_pool_balance_credits','credits','state',
     'Dash Platform shielded pool balance (Orchard), credits — field poolBalance',
     'Self shield→unshield churn inflates gross flows but nets ~0 → hedge with net=(in-out) and distinct identities',
     '["platform-explorer","dapi"]'),
  ('shielded_total_in_credits','credits','state',
     'Cumulative shielded-in, credits — field totalShieldedIn',
     'Wash-shielding by one entity → hedge with identities_total growth',
     '["platform-explorer","dapi"]'),
  ('shielded_total_out_credits','credits','state',
     'Cumulative shielded-out, credits — field totalShieldedOut',
     NULL,
     '["platform-explorer","dapi"]'),
  ('shielded_transitions_total','count','state',
     'Cumulative shielded state-transitions (6 types) — field transitionsCount',
     'Cheap-transition spam → weight by SHIELD/UNSHIELD amount, not raw count',
     '["platform-explorer","dapi"]'),
-- dash-platform ← platform-explorer /status
  ('identities_total','count','state',
     'Dash Platform identities — field identitiesCount',
     'Sybil identity creation is cheap → context, not adoption proof',
     '["platform-explorer","dapi"]'),
  ('documents_total','count','state',
     'Dash Platform documents — field documentsCount',
     'Bulk document spam → context only',
     '["platform-explorer","dapi"]'),
  ('data_contracts_total','count','state',
     'Dash Platform data contracts — field dataContractsCount',
     NULL,
     '["platform-explorer","dapi"]'),
  ('platform_total_credits','credits','state',
     'Total credits in circulation on Platform — field totalCredits',
     NULL,
     '["platform-explorer","dapi"]'),
-- zec ← ZecHub raw JSON (latest close element)
  ('zec_shielded_supply','zec','state',
     'Zcash shielded supply, ZEC — ZecHub shielded_supply.json, latest close',
     'ZecHub is a community wiki with unaudited cadence → cross-check tail vs zkp.baby / zcashexplorer',
     '["zechub"]'),
  ('zec_total_supply','zec','state',
     'Zcash total supply, ZEC — ZecHub total_supply.json, latest close',
     NULL,
     '["zechub"]')
ON CONFLICT (id) DO NOTHING;
