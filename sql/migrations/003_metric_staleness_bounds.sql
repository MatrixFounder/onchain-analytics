-- migrations/003_metric_staleness_bounds.sql — per-metric staleness bound in the registry.
-- Source of truth: DB-SCHEMA-CONCEPT.md §1 (the metrics registry IS the vocabulary) + §8 (two clocks).
-- Closes L-3 (docs/issues/l-3-verify-staleness-detector-is-permanently-red-and-names-no-metric.md).
--
-- Why: onchain-verify judged staleness with ONE hardcoded 2h threshold over max(ts). But this
-- schema runs TWO clocks (§8): hourly observations stamped with fetch/block time, and DAILY
-- aggregates stamped with the ZecHub close date at UTC midnight. A close-date ts is *always*
-- more than 2h old, so zec_shielded_supply / zec_total_supply were counted stale on every run —
-- stale_metrics had a permanent floor of 2, the ✅ branch of the report was unreachable, and a
-- REAL four-day gap (L-2: shielded_pool_balance_credits) just moved the counter 2→3 unnoticed.
--
-- Staleness is a property OF THE METRIC, so it belongs with the metric — not as a literal in
-- one workflow's SQL. A metric added without a bound is itself reported (unbounded_metrics in
-- the verify query), so this cannot silently regress when metric #12 arrives.
--
-- Idempotent: ADD COLUMN IF NOT EXISTS + unconditional UPDATE to the declared values. Safe to
-- re-run; re-running RESETS live tuning back to what this file declares (the file is the contract).
-- Additive-only: no drop, no type change, no data loss.

\set ON_ERROR_STOP on
SET search_path TO onchain;

-- BIGINT, not INTEGER: epoch-ms durations follow the same type as ts/ts_bucket (§1.2), and
-- INTEGER would cap a bound at ~24.8 days.
ALTER TABLE onchain.metrics ADD COLUMN IF NOT EXISTS max_staleness_ms BIGINT;

COMMENT ON COLUMN onchain.metrics.max_staleness_ms IS
  'Max age of max(ts) before the metric counts as stale, epoch-ms. Measured on the metric''s OWN '
  'clock: fetch-time for hourly observations, close-date for daily aggregates. NULL = unmonitored, '
  'and onchain-verify reports NULL as a defect of the registry, not as "fine".';

-- ── Bounds ──────────────────────────────────────────────────────────────────
-- Hourly clock (ts = fetch time / block time), written every hour by onchain-snapshotter.
--   2h = one missed run plus margin.
-- Daily close-date clock (ts = UTC midnight of the ZecHub close date).
--   A day-D datum is published during D+1, so at any check the freshest is ~32h old in steady
--   state and ~56h after a one-day publication lag — ZecHub's cadence is a community wiki's and
--   is explicitly unaudited (see the gameability note on those two rows). 72h therefore catches a
--   genuine multi-day stall without re-creating the permanently-red alarm this migration exists
--   to remove. It is deliberately NOT 2h; that mistake is the whole of L-3.
UPDATE onchain.metrics m
   SET max_staleness_ms = v.bound
  FROM (VALUES
          ('shielded_pool_balance_credits',   7200000::bigint),
          ('shielded_total_in_credits',       7200000::bigint),
          ('shielded_total_out_credits',      7200000::bigint),
          ('shielded_transitions_total',      7200000::bigint),
          ('identities_total',                7200000::bigint),
          ('documents_total',                 7200000::bigint),
          ('data_contracts_total',            7200000::bigint),
          ('platform_total_credits',          7200000::bigint),
          ('zec_block_height',                7200000::bigint),
          ('zec_shielded_supply',           259200000::bigint),
          ('zec_total_supply',              259200000::bigint)
       ) AS v(id, bound)
 WHERE m.id = v.id;
