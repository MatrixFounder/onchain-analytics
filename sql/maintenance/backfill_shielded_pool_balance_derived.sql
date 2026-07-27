-- maintenance/backfill_shielded_pool_balance_derived.sql
-- Repair hours where the vendor omitted `poolBalance`, by DERIVING the value and labelling it.
-- Source of truth: DB-SCHEMA-CONCEPT.md §1.5 (append-only + idempotent), §1.6 (registry before
-- observations), §1.7 (exact values as TEXT), §1.8 (source names come from the registry),
-- §5.3 (a backfill passes a mandatory verify gate).
--
-- WHEN TO RUN THIS. Only on an instance whose history predates the snapshotter's self-healing, or
-- one that received such history via a dump transfer. A current snapshotter derives this value
-- itself on every run, so no new hole can open — this file exists for hours recorded before that.
-- On an instance with nothing to repair it inserts zero rows and the gate still reports.
--
-- WHY IT IS SAFE. platform-explorer's `/transactions/shielded/statistic` can drop the `poolBalance`
-- field while still returning `totalShieldedIn` / `totalShieldedOut`. The balance is then recoverable
-- EXACTLY: poolBalance == totalShieldedIn − totalShieldedOut. Do not take that on faith — the gate
-- at the end recomputes EVERY stored balance row from its inputs, including the ones the vendor
-- reported itself, so a broken assumption shows up as a non-zero `mismatch` rather than as bad data.
--
-- WHY source='derived' AND NOT 'platform-explorer'. Writing these under the vendor's name would make
-- the journal assert that the vendor reported a value it never reported. The dedup key is
-- (source, asset, metric, ts_bucket), so a labelled derived row and a future real observation can
-- coexist for the same hour and stay distinguishable. Provenance also goes into raw_json — the
-- formula and both input values — so any row can be re-checked without this file.
--
-- NOT SILENT. `onchain-verify` reports derived metrics by name every day and counts them against the
-- report's OK state. Closing the data gap does not close the obligation to chase the vendor.
--
-- Idempotent: skips any bucket that already has a balance row from ANY source, plus
-- ON CONFLICT DO NOTHING. Safe to re-run; re-running after the vendor recovers adds nothing.
-- No psql backslash meta-commands — pastes into a GUI SQL editor unchanged.
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
         'reason',   'vendor field poolBalance absent from the platform-explorer payload',
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
-- unread — a verify gate nobody sees is the same failure class this file exists to close.
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
