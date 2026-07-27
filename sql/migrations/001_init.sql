-- migrations/001_init.sql — onchain-intel v0 snapshotter schema (Postgres profile).
-- Source of truth: DB-SCHEMA-CONCEPT.md §2 (v0 DDL) + §5 (SQLite→PG type map) + §8 (deploy profile).
--
-- Apply per sql/README.md. Contains NO psql backslash meta-commands, so it pastes into a GUI SQL
-- editor (Supabase) unmodified; the CLI path passes -v ON_ERROR_STOP=1 on the command line.
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
--   * metric AND source names come from the registry (§1.8)    — not free-form strings

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
  source_priority  TEXT,             -- JSON array as TEXT, e.g. ["platform-explorer","dapi"]
  -- Max age of max(ts) before onchain-verify calls the metric stale, epoch-ms. Judged on the
  -- metric's OWN clock — the two-clock model of §8 means one global threshold is always wrong for
  -- one of them. BIGINT (not INTEGER) so it shares the type of ts/ts_bucket (§1.2) and cannot cap
  -- at ~24.8 days. NULL means UNMONITORED, and onchain-verify reports NULL as a registry defect
  -- rather than as healthy — so a metric cannot be added without declaring its cadence.
  max_staleness_ms BIGINT
);

-- Older installs created `metrics` before this column existed; additive and idempotent.
ALTER TABLE onchain.metrics ADD COLUMN IF NOT EXISTS max_staleness_ms BIGINT;

COMMENT ON COLUMN onchain.metrics.max_staleness_ms IS
  'Max age of max(ts) before the metric counts as stale, epoch-ms. Measured on the metric''s OWN '
  'clock: fetch-time for hourly observations, close-date for daily aggregates. NULL = unmonitored, '
  'and onchain-verify reports NULL as a defect of the registry, not as "fine".';

-- ── Time-series points (append-only; main v0 table) ─────────────────────────
CREATE TABLE IF NOT EXISTS onchain.snapshots (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),  -- server-generated (PG13+ core)
  ts          BIGINT NOT NULL,          -- epoch-ms UTC, measurement moment
  ts_bucket   BIGINT NOT NULL,          -- floor(ts/3600000)*3600000 — hourly bucket (dedup key part)
  source      TEXT   NOT NULL,          -- 'platform-explorer' | 'zechub' | 'blockchair' | 'derived'
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

-- ── Seed: metrics ───────────────────────────────────────────────────────────
-- max_staleness_ms follows the metric's own clock (§8):
--   7 200 000 ms  (2h)  — hourly observations (ts = fetch time, or block time for the chain tip);
--                         one missed run plus margin.
-- 259 200 000 ms (72h)  — ZecHub DAILY aggregates (ts = UTC midnight of the close date). A day-D
--                         datum publishes during D+1, so the freshest is ~32h old in steady state
--                         and ~56h after a one-day publication lag, and ZecHub's cadence is a
--                         community wiki's. A 2h bound here would mark them stale forever.
INSERT INTO onchain.metrics (id, unit, kind, description, gameability, source_priority, max_staleness_ms) VALUES
-- dash-platform ← platform-explorer /transactions/shielded/statistic
  ('shielded_pool_balance_credits','credits','state',
     'Dash Platform shielded pool balance (Orchard), credits — field poolBalance. When the vendor '
     'omits the field the snapshotter derives it EXACTLY as totalShieldedIn - totalShieldedOut and '
     'writes it under source ''derived'' with the formula and inputs in raw_json.',
     'Self shield→unshield churn inflates gross flows but nets ~0 → hedge with net=(in-out) and distinct identities',
     '["platform-explorer","dapi","derived"]', 7200000),
  ('shielded_total_in_credits','credits','state',
     'Cumulative shielded-in, credits — field totalShieldedIn',
     'Wash-shielding by one entity → hedge with identities_total growth',
     '["platform-explorer","dapi"]', 7200000),
  ('shielded_total_out_credits','credits','state',
     'Cumulative shielded-out, credits — field totalShieldedOut',
     NULL,
     '["platform-explorer","dapi"]', 7200000),
  ('shielded_transitions_total','count','state',
     'Cumulative shielded state-transitions (6 types) — field transitionsCount',
     'Cheap-transition spam → weight by SHIELD/UNSHIELD amount, not raw count',
     '["platform-explorer","dapi"]', 7200000),
-- dash-platform ← platform-explorer /status
  ('identities_total','count','state',
     'Dash Platform identities — field identitiesCount',
     'Sybil identity creation is cheap → context, not adoption proof',
     '["platform-explorer","dapi"]', 7200000),
  ('documents_total','count','state',
     'Dash Platform documents — field documentsCount',
     'Bulk document spam → context only',
     '["platform-explorer","dapi"]', 7200000),
  ('data_contracts_total','count','state',
     'Dash Platform data contracts — field dataContractsCount',
     NULL,
     '["platform-explorer","dapi"]', 7200000),
  ('platform_total_credits','credits','state',
     'Total credits in circulation on Platform — field totalCredits',
     NULL,
     '["platform-explorer","dapi"]', 7200000),
-- zec ← blockchair /zcash/stats (the coherent block reference ZecHub's daily supply lacks)
  ('zec_block_height','block','state',
     'Zcash mainnet chain-tip block height — blockchair /zcash/stats best_block_height, stamped '
     'with the block''s UTC time (best_block_time). The value_raw/height both carry the height; '
     'this is the coherent block reference ZecHub''s daily supply lacks.',
     NULL,
     '["blockchair"]', 7200000),
-- zec ← ZecHub raw JSON (latest close element) — DAILY, revisable, written via upsert
  ('zec_shielded_supply','zec','state',
     'Zcash shielded supply, ZEC — ZecHub shielded_supply.json, latest close',
     'ZecHub is a community wiki with unaudited cadence → cross-check tail vs zkp.baby / zcashexplorer',
     '["zechub"]', 259200000),
  ('zec_total_supply','zec','state',
     'Zcash total supply, ZEC — ZecHub total_supply.json, latest close',
     NULL,
     '["zechub"]', 259200000)
ON CONFLICT (id) DO NOTHING;

-- Re-running on an install seeded before these columns existed: ON CONFLICT DO NOTHING leaves
-- existing rows untouched, so bring the two registry columns that the workflows READ up to the
-- values declared above. Descriptions/gameability are operator-editable and deliberately not reset.
UPDATE onchain.metrics m
   SET max_staleness_ms = v.bound,
       source_priority  = v.sources
  FROM (VALUES
          ('shielded_pool_balance_credits',   7200000::bigint, '["platform-explorer","dapi","derived"]'),
          ('shielded_total_in_credits',       7200000::bigint, '["platform-explorer","dapi"]'),
          ('shielded_total_out_credits',      7200000::bigint, '["platform-explorer","dapi"]'),
          ('shielded_transitions_total',      7200000::bigint, '["platform-explorer","dapi"]'),
          ('identities_total',                7200000::bigint, '["platform-explorer","dapi"]'),
          ('documents_total',                 7200000::bigint, '["platform-explorer","dapi"]'),
          ('data_contracts_total',            7200000::bigint, '["platform-explorer","dapi"]'),
          ('platform_total_credits',          7200000::bigint, '["platform-explorer","dapi"]'),
          ('zec_block_height',                7200000::bigint, '["blockchair"]'),
          ('zec_shielded_supply',           259200000::bigint, '["zechub"]'),
          ('zec_total_supply',              259200000::bigint, '["zechub"]')
       ) AS v(id, bound, sources)
 WHERE m.id = v.id
   AND (m.max_staleness_ms IS DISTINCT FROM v.bound OR m.source_priority IS DISTINCT FROM v.sources);
