-- migrations/004_backfill_shielded_pool_balance_derived.sql
-- Backfill the shielded_pool_balance_credits hole with DERIVED values, explicitly labelled.
-- Source of truth: DB-SCHEMA-CONCEPT.md §1.5 (append-only + idempotent), §1.6 (registry before
-- observations), §1.7 (exact values as TEXT), §1.8 (source names come from the registry),
-- §5.3 (backfill passes a mandatory verify gate).
-- Context: docs/issues/l-2-snapshotter-drops-a-metric-silently-dropped-array-never-leaves-the-node.md
--
-- WHY. platform-explorer stopped returning the `poolBalance` field after 2026-07-23 09:00 UTC, so
-- from the next hour on nothing was written for this metric. The value is recoverable exactly:
-- poolBalance == totalShieldedIn − totalShieldedOut, and `shielded_total_in/out` kept arriving
-- throughout, so nothing is lost — only underived.
--
-- The gap size is INSTANCE-SPECIFIC and this file is data-driven, so it adapts: it repairs whatever
-- hours that instance is missing. Observed 2026-07-27 — dev: 70 hours (its snapshotter had its own
-- downtime, 130 buckets over a 155-hour span); prod: 96 hours (unbroken hourly coverage, 142/142).
-- Both broke at the same wall-clock minute, which is what identifies this as the vendor rather than
-- an instance fault. The identity was validated on dev against every bucket where all three values
-- were observed — 60 of 60, zero exceptions — before any derived row was written anywhere.
--
-- WHY source='derived' AND NOT 'platform-explorer'. Writing these under the vendor's name would make
-- the journal assert that the vendor reported a value it never reported. The dedup key is
-- (source, asset, metric, ts_bucket), so a labelled derived row and a future real observation can
-- coexist for the same hour and stay distinguishable. Provenance is also written into raw_json:
-- the formula and both input values, so any row can be re-checked without this file.
--
-- SCOPE: HISTORY ONLY. This file repairs the 70 hours that were already lost. Going FORWARD the
-- same derivation runs inside the snapshotter's `Normalize` node on every hourly execution, using
-- the identical formula and the identical source label, so no new hole can open while the vendor
-- stays silent. The two must agree — that is asserted by the verify gate below, which recomputes
-- every stored value from its inputs rather than trusting this INSERT.
--
-- THE SUBSTITUTION IS NOT SILENT. Each derived row carries source='derived' plus its formula and
-- inputs, and onchain-verify reports derived metrics by name every day. Self-healing removes the
-- data gap, not the operator's obligation to chase the vendor or retire the metric.
--
-- Idempotent: skips any bucket that already has a balance row from ANY source, plus
-- ON CONFLICT DO NOTHING. Safe to re-run; re-running after the vendor recovers adds nothing.
-- Rollback: DELETE FROM onchain.snapshots WHERE metric='shielded_pool_balance_credits' AND source='derived';

SET search_path TO onchain;

BEGIN;

-- ── 1. Register the source BEFORE writing observations (§1.6, §1.8) ──────────
-- 'derived' goes LAST in source_priority: a real vendor observation always outranks a computed one.
UPDATE onchain.metrics
   SET source_priority = '["platform-explorer","dapi","derived"]'
 WHERE id = 'shielded_pool_balance_credits';

-- ── 2. Backfill ─────────────────────────────────────────────────────────────
INSERT INTO onchain.snapshots
       (ts, ts_bucket, source, asset, metric, value_raw, value_num, height, raw_json, created_at)
SELECT i.ts,
       i.ts_bucket,
       'derived',
       'dash-platform',
       'shielded_pool_balance_credits',
       -- numeric, not float: credits exceed the safe range of a double (§1.7)
       (i.value_raw::numeric - o.value_raw::numeric)::text,
       (i.value_raw::numeric - o.value_raw::numeric)::double precision,
       i.height,
       json_build_object(
         'derived',  true,
         'formula',  'shielded_total_in_credits - shielded_total_out_credits',
         'inputs',   json_build_object('shielded_total_in_credits',  i.value_raw,
                                       'shielded_total_out_credits', o.value_raw),
         'reason',   'vendor field poolBalance absent from platform-explorer '
                     '/transactions/shielded/statistic since 2026-07-23T10:00Z',
         'issue',    'L-2'
       )::text,
       (extract(epoch from now())*1000)::bigint
  FROM onchain.snapshots i
  JOIN onchain.snapshots o
    ON o.asset = 'dash-platform'
   AND o.metric = 'shielded_total_out_credits'
   AND o.ts_bucket = i.ts_bucket
  LEFT JOIN onchain.snapshots b
    ON b.asset = 'dash-platform'
   AND b.metric = 'shielded_pool_balance_credits'
   AND b.ts_bucket = i.ts_bucket          -- ANY source: never shadow an existing balance
 WHERE i.asset = 'dash-platform'
   AND i.metric = 'shielded_total_in_credits'
   AND b.id IS NULL
ON CONFLICT (source, asset, metric, ts_bucket) DO NOTHING;

COMMIT;

-- ── 3. Verify gate (§5.3) — row counts, ts range, byte-exact spot check, zero orphans ────────
-- ONE statement on purpose. A GUI SQL editor (Supabase) renders only the LAST result set, so a
-- gate split across four queries would show only its last line and the other three would pass
-- unread — a verify gate nobody sees is the same failure class this migration exists to close.
-- Also: no psql backslash meta-commands anywhere in this file, so it pastes into a GUI editor
-- unmodified. The CLI path already passes -v ON_ERROR_STOP=1 on the command line.
--
-- PASS means: mismatch = 0, duplicate_buckets = 0, orphans = 0, and balance_buckets = in_buckets.
WITH chk AS (
  SELECT s.value_raw AS stored,
         (i.value_raw::numeric - o.value_raw::numeric)::text AS recomputed
    FROM onchain.snapshots s
    JOIN onchain.snapshots i ON i.metric='shielded_total_in_credits'  AND i.ts_bucket=s.ts_bucket
    JOIN onchain.snapshots o ON o.metric='shielded_total_out_credits' AND o.ts_bucket=s.ts_bucket
   WHERE s.metric='shielded_pool_balance_credits'
), dup AS (
  SELECT ts_bucket FROM onchain.snapshots
   WHERE metric='shielded_pool_balance_credits'
   GROUP BY ts_bucket HAVING count(*) > 1
)
SELECT
  (SELECT count(*) FROM onchain.snapshots
    WHERE metric='shielded_pool_balance_credits' AND source='derived')          AS derived_rows,
  (SELECT to_char(to_timestamp(min(ts_bucket)/1000) AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI')
     FROM onchain.snapshots
    WHERE metric='shielded_pool_balance_credits' AND source='derived')          AS first_bucket,
  (SELECT to_char(to_timestamp(max(ts_bucket)/1000) AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI')
     FROM onchain.snapshots
    WHERE metric='shielded_pool_balance_credits' AND source='derived')          AS last_bucket,
  (SELECT count(DISTINCT ts_bucket) FROM onchain.snapshots
    WHERE metric='shielded_pool_balance_credits')                               AS balance_buckets,
  (SELECT count(DISTINCT ts_bucket) FROM onchain.snapshots
    WHERE metric='shielded_total_in_credits')                                   AS in_buckets,
  (SELECT count(*) FROM dup)                                                    AS duplicate_buckets,
  (SELECT count(*) FROM chk)                                                    AS checked,
  (SELECT count(*) FROM chk WHERE stored = recomputed)                          AS exact_match,
  (SELECT count(*) FROM chk WHERE stored <> recomputed)                         AS mismatch,
  (SELECT count(*) FROM onchain.snapshots s
     LEFT JOIN onchain.assets  a ON s.asset  = a.id
     LEFT JOIN onchain.metrics m ON s.metric = m.id
    WHERE a.id IS NULL OR m.id IS NULL)                                         AS orphans;
