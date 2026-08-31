-- =====================================================================================
-- wi62_verify.sql — the verify gate for the WI-62 engine-table move (T-015 task 015-24).
--
-- Runs the four checks of DB-SCHEMA-CONCEPT §5.3 plus a fifth on the SHAPE of `onchain.usage`,
-- and prints a report that names the DIRECTION of any disagreement per table.
--
-- WHY DIRECTION AND NOT "differs". More rows on the new side is a materialised duplication threat
-- (`access_audit` carries no natural dedup key by design); fewer is an incomplete copy. The two have
-- different causes and different repairs, so a gate that only says "differs" hands the operator the
-- work it was built to do (MAJOR-1/MAJOR-2 of specification review round 3).
--
-- WHY THE SCRIPT LIVES IN THE REPO. DB-SCHEMA-CONCEPT §5.3 requires it: the same gate runs at the
-- next host move (§6). Container names arrive in the CALLING command, never in this file.
--
-- WHY ONE DATABASE DOES NOT READ THE OTHER. The two containers share no role that can read across
-- them. The old side's report travels as a VALUE — one base64 line the operator pastes into the new
-- side's invocation — not over a connection.
--
-- TWO MODES
--   old:  psql -v SIDE=old -v SAMPLE=20
--   new:  psql -v SIDE=new -v SAMPLE=20 -v OLD_REPORT=<the base64 line the old run printed>
--
-- THIS SCRIPT ONLY READS. It contains no INSERT, UPDATE, DELETE, TRUNCATE or DROP, and a test in
-- packages/core/test/pg-migration-guards.test.ts holds that property.
-- =====================================================================================

\set ON_ERROR_STOP on

-- -------------------------------------------------------------------------------------
-- Guards. A refusal must be visible in the process exit code — see L-28: `\quit 1` takes no
-- exit-status argument before PostgreSQL 17 and exits 0 on both psql clients this project targets
-- (15.8 and 16.13), so a caller reading `$?` saw SUCCESS on a refusal. A raise under
-- ON_ERROR_STOP exits 3. The `\set` above is this file's own, so the observability of a refusal
-- does not depend on the operator remembering `-v ON_ERROR_STOP=1`.
-- -------------------------------------------------------------------------------------

\if :{?SIDE}
\else
  \echo 'FATAL: -v SIDE=old|new is required'
  DO $guard$ BEGIN
    RAISE EXCEPTION 'FATAL: -v SIDE=old|new is required';
  END $guard$;
  \quit
\endif

\if :{?SAMPLE}
\else
  \echo 'FATAL: -v SAMPLE=<rows per table for the spot-check> is required'
  DO $guard$ BEGIN
    RAISE EXCEPTION 'FATAL: -v SAMPLE=<rows per table for the spot-check> is required';
  END $guard$;
  \quit
\endif

-- SIDE is validated through \gset, NOT inside the DO block. psql does not substitute `:'VAR'`
-- inside a dollar-quoted string (`003_seed_engine_admin.sql` records the same trap): the reference
-- would reach the server verbatim and fail as an undefined parameter, AFTER looking correct in
-- review. A guard that fails for the wrong reason is not a guard.
SELECT (:'SIDE' NOT IN ('old', 'new')) AS bad_side,
       (:'SIDE' = 'new') AS side_is_new
\gset

\if :bad_side
  \echo 'FATAL: SIDE must be exactly old or new'
  DO $guard$ BEGIN
    RAISE EXCEPTION 'FATAL: SIDE must be exactly old or new';
  END $guard$;
  \quit
\endif

-- The comparison mode cannot run without the other side's report. Refusing here rather than
-- printing a one-sided report matters: a report with nothing to compare against prints as a clean
-- run to a reader skimming for red.
\if :{?OLD_REPORT}
\else
  \if :side_is_new
    \echo 'FATAL: -v OLD_REPORT=<the base64 line the old side printed> is required when SIDE=new'
    DO $guard$ BEGIN
      RAISE EXCEPTION 'FATAL: OLD_REPORT is required when SIDE=new';
    END $guard$;
    \quit
  \endif
\endif

-- =====================================================================================
-- The report both sides build, in one shape.
--
-- Applicability is DATA in this script, not an omission. DB-SCHEMA-CONCEPT §5.3 asks for the
-- inapplicable entries to be MARKED; a table silently missing from the report is indistinguishable
-- from a table someone forgot.
-- =====================================================================================

CREATE TEMP VIEW v_applicability (tbl, count_applies, time_col, reason) AS
VALUES
  ('providers',        true,  NULL,            'no time column: the table is id/kind/notes'),
  ('users',            true,  'created_at',    NULL),
  ('access_profiles',  true,  'created_at',    NULL),
  ('api_tokens',       true,  'created_at',    NULL),
  ('access_audit',     true,  'ts',            NULL),
  ('cache_entries',    true,  'created_at',    NULL),
  ('usage',            true,  'day',           NULL),
  ('usage_window',     true,  'window_start',  NULL),
  ('request_trace',    true,  'received_at',   NULL),
  ('diagnostics',      true,  'ts',            NULL),
  ('retention_runs',   true,  'started_at',    NULL),
  ('client_usage',     false, NULL,            'no source on the old container: created empty, stays empty until the new container serves'),
  ('provider_buckets', false, NULL,            'rows are not transferred (R-8.11): limiter state is ephemeral and refills');

-- Check 1 + Check 2 in one pass: count, and both time bounds.
--
-- WHY BOTH BOUNDS AND NOT ONLY max. A matching max over a diverged min is an undercopied TAIL of
-- history — a loss the upper bound cannot see.
CREATE TEMP VIEW v_counts (tbl, n, mn, mx) AS
            SELECT 'providers',       count(*), NULL::bigint,     NULL::bigint     FROM onchain.providers
  UNION ALL SELECT 'users',           count(*), min(created_at),  max(created_at)  FROM onchain.users
  UNION ALL SELECT 'access_profiles', count(*), min(created_at),  max(created_at)  FROM onchain.access_profiles
  UNION ALL SELECT 'api_tokens',      count(*), min(created_at),  max(created_at)  FROM onchain.api_tokens
  UNION ALL SELECT 'access_audit',    count(*), min(ts),          max(ts)          FROM onchain.access_audit
  UNION ALL SELECT 'cache_entries',   count(*), min(created_at),  max(created_at)  FROM onchain.cache_entries
  UNION ALL SELECT 'usage',           count(*), min(day),         max(day)         FROM onchain.usage
  UNION ALL SELECT 'usage_window',    count(*), min(window_start),max(window_start) FROM onchain.usage_window
  UNION ALL SELECT 'request_trace',   count(*), min(received_at), max(received_at) FROM onchain.request_trace
  UNION ALL SELECT 'diagnostics',     count(*), min(ts),          max(ts)          FROM onchain.diagnostics
  UNION ALL SELECT 'retention_runs',  count(*), min(started_at),  max(started_at)  FROM onchain.retention_runs;

-- Check 3 — the spot-check of EXACT columns.
--
-- WHY ORDER BY md5(<key>) AND NOT random(). Both sides must select THE SAME rows or there is
-- nothing to compare. md5 of the key yields one order on both databases and does not depend on the
-- physical row order, which a fresh COPY does not preserve.
--
-- WHY VALUES ARE PRINTED RATHER THAN FOLDED INTO ONE CHECKSUM. A checksum that disagrees names no
-- row. These values point at the row and the column.
CREATE TEMP VIEW v_spot (tbl, k, v) AS
            (SELECT 'providers', id,
                    jsonb_build_object('kind', kind, 'notes', notes)
             FROM onchain.providers ORDER BY md5(id::text) LIMIT :SAMPLE)
  UNION ALL (SELECT 'users', id,
                    jsonb_build_object('email', email, 'role', role, 'status', status)
             FROM onchain.users ORDER BY md5(id::text) LIMIT :SAMPLE)
  UNION ALL (SELECT 'access_profiles', id,
                    jsonb_build_object('credits_balance_raw', credits_balance_raw,
                                       'tool_allowlist_json', tool_allowlist_json)
             FROM onchain.access_profiles ORDER BY md5(id::text) LIMIT :SAMPLE)
  UNION ALL (SELECT 'api_tokens', id,
                    jsonb_build_object('token_hash', token_hash, 'prefix', prefix, 'status', status)
             FROM onchain.api_tokens ORDER BY md5(id::text) LIMIT :SAMPLE)
  UNION ALL (SELECT 'access_audit', id,
                    jsonb_build_object('target_id', target_id, 'before_json', before_json,
                                       'after_json', after_json)
             FROM onchain.access_audit ORDER BY md5(id::text) LIMIT :SAMPLE)
  UNION ALL (SELECT 'cache_entries', id,
                    jsonb_build_object('value_json', value_json, 'args_hash', args_hash)
             FROM onchain.cache_entries ORDER BY md5(id::text) LIMIT :SAMPLE)
  UNION ALL (SELECT 'usage', provider || ':' || day,
                    jsonb_build_object('credits_used', credits_used)
             FROM onchain.usage ORDER BY md5((provider || ':' || day)::text) LIMIT :SAMPLE)
  UNION ALL (SELECT 'usage_window', provider || ':' || window_start,
                    jsonb_build_object('credits_used', credits_used, 'calls_made', calls_made)
             FROM onchain.usage_window
             ORDER BY md5((provider || ':' || window_start)::text) LIMIT :SAMPLE)
  UNION ALL (SELECT 'request_trace', id,
                    jsonb_build_object('args_hash', args_hash, 'tried_json', tried_json,
                                       'refusal_class', refusal_class)
             FROM onchain.request_trace ORDER BY md5(id::text) LIMIT :SAMPLE)
  UNION ALL (SELECT 'diagnostics', id,
                    jsonb_build_object('detail_json', detail_json, 'event', event)
             FROM onchain.diagnostics ORDER BY md5(id::text) LIMIT :SAMPLE)
  UNION ALL (SELECT 'retention_runs', id,
                    jsonb_build_object('detail_json', detail_json, 'job', job)
             FROM onchain.retention_runs ORDER BY md5(id::text) LIMIT :SAMPLE);

CREATE TEMP VIEW v_report AS
SELECT jsonb_build_object(
  'side', :'SIDE',
  'sample', (:SAMPLE)::int,
  'taken_at', (extract(epoch FROM now()) * 1000)::bigint,
  'counts', (SELECT jsonb_object_agg(tbl, jsonb_build_object('n', n, 'min', mn, 'max', mx))
             FROM v_counts),
  'spot', (SELECT coalesce(jsonb_object_agg(tbl, rows), '{}'::jsonb)
           FROM (SELECT tbl, jsonb_agg(jsonb_build_object('k', k, 'v', v) ORDER BY k) AS rows
                 FROM v_spot GROUP BY tbl) z)
) AS report;

\echo ''
\echo '================ WI-62 VERIFY GATE ================'
\echo 'side:'
\echo :SIDE

-- -------------------------------------------------------------------------------------
-- Printed on BOTH sides: this side's own numbers.
-- -------------------------------------------------------------------------------------
\echo ''
\echo '--- checks 1 and 2: rows and time bounds, this side ---'
SELECT a.tbl AS "table",
       CASE WHEN a.count_applies THEN c.n::text ELSE 'n/a' END AS "rows",
       CASE WHEN a.time_col IS NULL THEN 'n/a' ELSE coalesce(c.mn::text, '(empty)') END AS "min",
       CASE WHEN a.time_col IS NULL THEN 'n/a' ELSE coalesce(c.mx::text, '(empty)') END AS "max",
       coalesce(a.reason, '') AS "why n/a"
FROM v_applicability a
LEFT JOIN v_counts c ON c.tbl = a.tbl
ORDER BY a.count_applies DESC, a.tbl;

-- =====================================================================================
-- SIDE = old — print the handoff line and stop.
-- =====================================================================================
\if :{?OLD_REPORT}
\else

\echo ''
\echo '--- the old side ends here. Paste the base64 line below into the new side as -v OLD_REPORT=<line> ---'
\echo ''
-- encode() folds base64 at 76 characters; the newlines are stripped so the operator copies ONE
-- token. base64 carries no comma and no `$`, so it survives being passed as a psql variable and,
-- elsewhere in this project, as a positional query parameter.
SELECT replace(encode(convert_to(report::text, 'utf8'), 'base64'), E'\n', '') AS old_report_base64
FROM v_report;

\endif

-- =====================================================================================
-- SIDE = new — compare against the old side's report.
-- =====================================================================================
\if :{?OLD_REPORT}

CREATE TEMP VIEW v_old AS
SELECT convert_from(decode(:'OLD_REPORT', 'base64'), 'utf8')::jsonb AS report;

DO $guard$
DECLARE
  old_side text;
BEGIN
  SELECT report ->> 'side' INTO old_side FROM v_old;
  IF old_side IS DISTINCT FROM 'old' THEN
    RAISE EXCEPTION 'FATAL: OLD_REPORT was produced with side=% — compare against an old-side report, not another new-side one', coalesce(old_side, '(null)');
  END IF;
END $guard$;

\echo ''
\echo '--- check 1: row counts, old vs new, WITH DIRECTION ---'
SELECT a.tbl AS "table",
       CASE WHEN a.count_applies THEN (o.report -> 'counts' -> a.tbl ->> 'n') ELSE 'n/a' END AS "old",
       CASE WHEN a.count_applies THEN c.n::text ELSE 'n/a' END AS "new",
       CASE
         WHEN NOT a.count_applies THEN 'not_applicable'
         WHEN c.n = (o.report -> 'counts' -> a.tbl ->> 'n')::bigint THEN 'equal'
         WHEN c.n > (o.report -> 'counts' -> a.tbl ->> 'n')::bigint THEN 'more_on_new'
         ELSE 'less_on_new'
       END AS "verdict",
       coalesce(a.reason, '') AS "why n/a"
FROM v_applicability a
CROSS JOIN v_old o
LEFT JOIN v_counts c ON c.tbl = a.tbl
ORDER BY a.count_applies DESC, a.tbl;

\echo ''
\echo '--- check 2: time bounds, old vs new (both bounds) ---'
SELECT a.tbl AS "table",
       o.report -> 'counts' -> a.tbl ->> 'min' AS "old min",
       c.mn::text AS "new min",
       o.report -> 'counts' -> a.tbl ->> 'max' AS "old max",
       c.mx::text AS "new max",
       CASE
         WHEN a.time_col IS NULL THEN 'not_applicable'
         WHEN (o.report -> 'counts' -> a.tbl ->> 'min') IS NOT DISTINCT FROM c.mn::text
          AND (o.report -> 'counts' -> a.tbl ->> 'max') IS NOT DISTINCT FROM c.mx::text
           THEN 'equal'
         ELSE 'DIFFERS'
       END AS "verdict",
       coalesce(a.reason, '') AS "why n/a"
FROM v_applicability a
CROSS JOIN v_old o
LEFT JOIN v_counts c ON c.tbl = a.tbl
ORDER BY a.time_col IS NULL, a.tbl;

\echo ''
\echo '--- check 3: spot-check of exact columns (only disagreements are printed) ---'
WITH old_spot AS (
  SELECT t.tbl, e ->> 'k' AS k, e -> 'v' AS v
  FROM v_old o,
       jsonb_each(o.report -> 'spot') AS t(tbl, rows),
       jsonb_array_elements(t.rows) AS e
)
SELECT coalesce(n.tbl, x.tbl) AS "table",
       coalesce(n.k, x.k) AS "key",
       x.v::text AS "old value",
       n.v::text AS "new value",
       CASE
         WHEN x.k IS NULL THEN 'only_on_new'
         WHEN n.k IS NULL THEN 'only_on_old'
         ELSE 'value_differs'
       END AS "verdict"
FROM v_spot n
FULL OUTER JOIN old_spot x ON x.tbl = n.tbl AND x.k = n.k
WHERE n.k IS NULL OR x.k IS NULL OR n.v IS DISTINCT FROM x.v
ORDER BY 1, 2;

\echo '(no rows above = every sampled row matched byte for byte)'

\echo ''
\echo '--- check 3a: how many rows the spot-check actually compared, per table ---'
-- A spot-check over zero rows agrees with everything. The count is printed so an empty comparison
-- cannot be read as a passing one.
SELECT tbl AS "table", count(*) AS "rows compared"
FROM v_spot GROUP BY tbl ORDER BY 1;

\echo ''
\echo '--- check 4: orphans on the new side (zero on every row is the postcondition) ---'
-- Explicit SELECTs because NONE of these four references carries a foreign key: the local
-- principal has no token row, and a foreign key would refuse the write on a transport that needs
-- no token (data-model.md §4.6). The ledger is included per MINOR-12 of review round 1 — its two
-- columns are the same class as request_trace's.
SELECT 'request_trace.principal_id' AS "reference", count(*) AS "orphans"
  FROM onchain.request_trace rt
 WHERE rt.principal_id IS NOT NULL AND rt.principal_id <> 'local'
   AND NOT EXISTS (SELECT 1 FROM onchain.api_tokens t WHERE t.id = rt.principal_id)
UNION ALL
SELECT 'access_audit.target_id', count(*)
  FROM onchain.access_audit a
 WHERE a.target_type = 'api_token'
   AND NOT EXISTS (SELECT 1 FROM onchain.api_tokens t WHERE t.id = a.target_id)
UNION ALL
SELECT 'client_usage.principal_id', count(*)
  FROM onchain.client_usage c
 WHERE c.principal_id IS NOT NULL AND c.principal_id <> 'local'
   AND NOT EXISTS (SELECT 1 FROM onchain.api_tokens t WHERE t.id = c.principal_id)
UNION ALL
SELECT 'client_usage.access_profile_id', count(*)
  FROM onchain.client_usage c
 WHERE c.access_profile_id IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM onchain.access_profiles p WHERE p.id = c.access_profile_id)
ORDER BY 1;

\echo ''
\echo '--- check 5: onchain.usage carries calls_made on the new container ---'
-- Checks 1-3 compare DATA and are blind to the table SHAPE: the usage spot-check covers only
-- credits_used. A shape that diverged between the two containers surfaces as
-- `column "calls_made" does not exist` at the first call of the daily call gate (task 015-14),
-- long after this gate said the move was fine.
SELECT count(*) AS "has_calls_made (1 = pass)"
  FROM information_schema.columns
 WHERE table_schema = 'onchain' AND table_name = 'usage' AND column_name = 'calls_made';

\echo ''
\echo '--- VERDICT ---'
-- One line the operator can act on. Anything but PASS blocks UC-6 step 10 (the drop on the old
-- container), which is the only irreversible step of the move.
WITH old_spot AS (
  SELECT t.tbl, e ->> 'k' AS k, e -> 'v' AS v
  FROM v_old o,
       jsonb_each(o.report -> 'spot') AS t(tbl, rows),
       jsonb_array_elements(t.rows) AS e
), bad_counts AS (
  SELECT count(*) AS n FROM v_applicability a
  CROSS JOIN v_old o LEFT JOIN v_counts c ON c.tbl = a.tbl
  WHERE a.count_applies AND c.n IS DISTINCT FROM (o.report -> 'counts' -> a.tbl ->> 'n')::bigint
), bad_bounds AS (
  SELECT count(*) AS n FROM v_applicability a
  CROSS JOIN v_old o LEFT JOIN v_counts c ON c.tbl = a.tbl
  WHERE a.time_col IS NOT NULL
    AND ((o.report -> 'counts' -> a.tbl ->> 'min') IS DISTINCT FROM c.mn::text
      OR (o.report -> 'counts' -> a.tbl ->> 'max') IS DISTINCT FROM c.mx::text)
), bad_spot AS (
  SELECT count(*) AS n FROM v_spot n
  FULL OUTER JOIN old_spot x ON x.tbl = n.tbl AND x.k = n.k
  WHERE n.k IS NULL OR x.k IS NULL OR n.v IS DISTINCT FROM x.v
), orphans AS (
  SELECT (SELECT count(*) FROM onchain.request_trace rt
           WHERE rt.principal_id IS NOT NULL AND rt.principal_id <> 'local'
             AND NOT EXISTS (SELECT 1 FROM onchain.api_tokens t WHERE t.id = rt.principal_id))
       + (SELECT count(*) FROM onchain.access_audit a
           WHERE a.target_type = 'api_token'
             AND NOT EXISTS (SELECT 1 FROM onchain.api_tokens t WHERE t.id = a.target_id))
       + (SELECT count(*) FROM onchain.client_usage c
           WHERE c.principal_id IS NOT NULL AND c.principal_id <> 'local'
             AND NOT EXISTS (SELECT 1 FROM onchain.api_tokens t WHERE t.id = c.principal_id))
       + (SELECT count(*) FROM onchain.client_usage c
           WHERE c.access_profile_id IS NOT NULL
             AND NOT EXISTS (SELECT 1 FROM onchain.access_profiles p WHERE p.id = c.access_profile_id))
       AS n
), shape AS (
  SELECT count(*) AS n FROM information_schema.columns
   WHERE table_schema = 'onchain' AND table_name = 'usage' AND column_name = 'calls_made'
)
SELECT bad_counts.n AS "count mismatches",
       bad_bounds.n AS "bound mismatches",
       bad_spot.n AS "spot mismatches",
       orphans.n AS "orphans",
       shape.n AS "usage.calls_made",
       CASE WHEN bad_counts.n = 0 AND bad_bounds.n = 0 AND bad_spot.n = 0
             AND orphans.n = 0 AND shape.n = 1
            THEN 'PASS — UC-6 step 10 may proceed'
            ELSE 'BLOCKED — UC-6 step 10 must NOT run' END AS "verdict"
FROM bad_counts, bad_bounds, bad_spot, orphans, shape;

\echo ''
\echo '--- this side, as a report line (for the install log, task 015-28) ---'
SELECT replace(encode(convert_to(report::text, 'utf8'), 'base64'), E'\n', '') AS new_report_base64
FROM v_report;

\endif

\echo ''
\echo '=============== END WI-62 VERIFY GATE ==============='
