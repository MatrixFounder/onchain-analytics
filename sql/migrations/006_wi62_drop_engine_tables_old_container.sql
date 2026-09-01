-- migrations/006_wi62_drop_engine_tables_old_container.sql — the one irreversible step of the
-- WI-62 move (T-015 task 015-27, `deployment.md` §10.9.7, R-8.8, AC-29, UC-6 step 10).
--
-- Drops the THIRTEEN engine tables from the OLD container (`supabase-db`), leaving it with the
-- snapshotter's three. After this file runs, SEC-2's exception on that container has no subject:
-- the tables its platform-wide-SELECT roles could read are gone.
--
--   ssh vm 'docker exec -i supabase-db psql -qU supabase_admin -d postgres \
--     -v ON_ERROR_STOP=1 -v READ_ROLE=onchain_engine_read' \
--     < sql/migrations/006_wi62_drop_engine_tables_old_container.sql
--
-- WHY stdin AND NOT `-f /tmp/…`. That form reads the CONTAINER's filesystem and would run whatever
-- stale copy lives there (CLAUDE.md, skill `vm-deploy` §4).
--
-- WHY THIS FILE IS NOT RUN WITHOUT THE OWNER'S EXPLICIT WORD. It is the only operation of stage 6
-- that cannot be undone by repeating a step. The path back is task 015-26's dump PLUS its
-- `*.guards.sql` companion — measured 2026-08-31: the dump alone restores every row and NOT the
-- append-only trigger, and `pg_restore` exits 0 while saying so.
--
-- PRECONDITIONS, each one somebody else's measurement:
--   1. verify gate passed with no divergence               (task 015-24 — PASS)
--   2. an already-issued token authenticated on the new     (task 015-25 — AC-44, 21:33:55Z)
--   3. the rollback artifact exists outside both containers (task 015-26 — dump + guards)
--   4. onchain-verify's report was DELIVERED on the new topology (task 015-33 — 21:33 UTC)
--   5. the owner said so, explicitly, with a date            (skill `vm-deploy` §5)

\set ON_ERROR_STOP on

-- L-28: `\quit 1` takes no exit-status argument before PostgreSQL 17 and exits 0 on both psql
-- clients this project targets, so a refusal must RAISE. The `\set` above is this file's own, so
-- observability does not depend on the caller remembering the flag.

\if :{?READ_ROLE}
\else
  \echo 'FATAL: -v READ_ROLE=<snapshotter read role> is required (task 015-27, postcondition re-measure)'
  DO $guard$ BEGIN
    RAISE EXCEPTION 'FATAL: -v READ_ROLE=<snapshotter read role> is required';
  END $guard$;
  \quit
\endif

-- ---------------------------------------------------------------------------------------------
-- GUARD 1 — this must be the OLD container.
--
-- NOT in the task's own list, added on execution. The file names thirteen tables that exist on BOTH
-- containers; pointed at `onchain-engine-db` it would destroy the very copy the move was made to
-- create, and every `DROP` would succeed. The two containers are told apart by something only the
-- old one has: the snapshotter's three tables, which stay behind by R-8.3.
--
-- A positive discriminator, deliberately: "the tables I am about to drop are present" is true on
-- both sides and identifies nothing.
-- ---------------------------------------------------------------------------------------------
DO $guard$
DECLARE
  snapshotter_tables int;
BEGIN
  SELECT count(*) INTO snapshotter_tables
    FROM information_schema.tables
   WHERE table_schema = 'onchain' AND table_name IN ('assets', 'metrics', 'snapshots');
  IF snapshotter_tables <> 3 THEN
    RAISE EXCEPTION
      'FATAL: this is not the old container — expected the snapshotter''s 3 tables in schema onchain, found %. Running this file against the engine container would destroy the copy the move created.',
      snapshotter_tables;
  END IF;
END $guard$;

-- ---------------------------------------------------------------------------------------------
-- GUARD 2 — `client_usage` must be EMPTY here.
--
-- The task's own rule: a non-zero count stops the work and sends it back to 015-26, because the
-- rollback artifact would then have to carry those rows.
--
-- The premise around it was WRONG and the guard is what makes that survivable. MAJOR-F recorded
-- that `004_t015_billing.sql` is never applied to this container, so `DROP IF EXISTS` for
-- `client_usage` was expected to be a no-op. Measured 2026-08-31: the migration WAS applied here —
-- both its named constraints are present, `onchain.usage` carries `calls_made`, and the table's oid
-- (53502) sits above the whole `002` set. The table is real. It is also empty, so the guard passes
-- and the drop is legitimate — but it is now a REAL drop, not an empty one.
-- ---------------------------------------------------------------------------------------------
DO $guard$
DECLARE
  ledger_rows bigint := 0;
BEGIN
  IF to_regclass('onchain.client_usage') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM onchain.client_usage' INTO ledger_rows;
  END IF;
  IF ledger_rows <> 0 THEN
    RAISE EXCEPTION
      'FATAL: onchain.client_usage holds % row(s) on this container. Task 015-26''s artifact must carry them before anything is dropped.',
      ledger_rows;
  END IF;
END $guard$;

-- ---------------------------------------------------------------------------------------------
-- GUARD 3 — no writer came back after the snapshot.
--
-- `request_trace` is written by the tool-call wrapper, and the writer moved to the new container in
-- task 015-25. A row here means a profile pointed at THIS container after task 015-23's snapshot,
-- so the artifact of 015-26 does not carry it and the drop would lose it silently.
--
-- Refuse rather than guess: this file cannot tell a legitimate old row from a late write, and the
-- verify gate recorded zero at the time of the move.
-- ---------------------------------------------------------------------------------------------
DO $guard$
DECLARE
  trace_rows bigint := 0;
BEGIN
  IF to_regclass('onchain.request_trace') IS NOT NULL THEN
    EXECUTE 'SELECT count(*) FROM onchain.request_trace' INTO trace_rows;
  END IF;
  IF trace_rows <> 0 THEN
    RAISE EXCEPTION
      'FATAL: onchain.request_trace holds % row(s) here; the verify gate recorded 0. A writer reached this container after the move — establish which before dropping.',
      trace_rows;
  END IF;
END $guard$;

\echo '-- the thirteen engine tables, as they stand BEFORE the drop --'
SELECT table_name FROM information_schema.tables
 WHERE table_schema = 'onchain'
   AND table_name IN ('cache_entries','usage','usage_window','provider_buckets','request_trace',
                      'diagnostics','retention_runs','access_audit','api_tokens','client_usage',
                      'access_profiles','users','providers')
 ORDER BY 1;

-- ---------------------------------------------------------------------------------------------
-- The drop. ONE transaction, thirteen statements, dependants first.
--
-- WHY ONE TRANSACTION. Postgres runs DDL transactionally. A half-dropped schema is a state the dump
-- takes longer to restore from than a whole one.
--
-- WHY NO `CASCADE`. It would remove a dependent object without naming it, and the dependency list on
-- this container has not been re-checked since migration 002. A failure on an unexpected dependency
-- is the RIGHT outcome: under ON_ERROR_STOP it halts the file and names the object.
--
-- WHY THIS ORDER. `cache_entries`, `usage`, `usage_window`, `provider_buckets` and `request_trace`
-- reference `providers`; `api_tokens` references `users` and `access_profiles`. The reverse order
-- would need the `CASCADE` this file refuses.
-- ---------------------------------------------------------------------------------------------
BEGIN;

DROP TABLE IF EXISTS onchain.cache_entries;
DROP TABLE IF EXISTS onchain.usage;
DROP TABLE IF EXISTS onchain.usage_window;
DROP TABLE IF EXISTS onchain.provider_buckets;
DROP TABLE IF EXISTS onchain.request_trace;
DROP TABLE IF EXISTS onchain.diagnostics;
DROP TABLE IF EXISTS onchain.retention_runs;
DROP TABLE IF EXISTS onchain.access_audit;
DROP TABLE IF EXISTS onchain.api_tokens;
DROP TABLE IF EXISTS onchain.client_usage;
DROP TABLE IF EXISTS onchain.access_profiles;
DROP TABLE IF EXISTS onchain.users;
DROP TABLE IF EXISTS onchain.providers;

COMMIT;

-- ---------------------------------------------------------------------------------------------
-- Postcondition, re-measured HERE rather than newly invented (R-8.8). This is step 2a's own query
-- (`deployment.md` §10.4.2), retargeted at the read role and at the whole schema.
--
-- WHY `has_table_privilege` AND NOT `information_schema.role_table_grants`. The catalogue view is
-- blind to a grant to PUBLIC, to a privilege inherited through a group role, and to grants whose
-- roles are not enabled in the session — an empty result there means "not found", not "not granted"
-- (precedent L-10).
-- ---------------------------------------------------------------------------------------------
\echo ''
\echo '-- POSTCONDITION: what remains in schema onchain, and what the read role may select --'
SELECT t.table_name,
       has_table_privilege(:'READ_ROLE', 'onchain.' || t.table_name, 'SELECT') AS may_select
  FROM information_schema.tables t
 WHERE t.table_schema = 'onchain'
 ORDER BY 2 DESC, 1;

\echo ''
\echo '-- expected: exactly three rows — assets, metrics, snapshots — all true.'
\echo '-- A fourth row is an engine table left behind; a false is a grant that outlived its table.'

-- BOTH halves of that sentence are CHECKED, not merely printed. The first draft of this file
-- asserted only the COUNT, and a rehearsal on a disposable copy passed with every `may_select`
-- false — the file printed "postcondition holds" over a table it had just shown to be unreadable.
-- A printed expectation with no reader is the defect this project keeps finding (L-2, RF-14).
--
-- The comparison uses \gset rather than a DO block on purpose: psql does not substitute `:'VAR'`
-- inside a dollar-quoted string, so `:'READ_ROLE'` written there would reach the server verbatim
-- and fail as an undefined parameter — a guard failing for the wrong reason.
SELECT
  (count(*) <> 3) AS wrong_table_count,
  (count(*) FILTER (
     WHERE table_name NOT IN ('assets', 'metrics', 'snapshots')) > 0) AS engine_table_left,
  (count(*) FILTER (
     WHERE table_name IN ('assets', 'metrics', 'snapshots')
       AND NOT has_table_privilege(:'READ_ROLE', 'onchain.' || table_name, 'SELECT')) > 0)
     AS read_role_cannot_read_all
  FROM information_schema.tables WHERE table_schema = 'onchain'
\gset

\if :engine_table_left
  \echo 'POSTCONDITION FAILED: an engine table is still present in schema onchain'
  DO $verify$ BEGIN
    RAISE EXCEPTION 'POSTCONDITION FAILED: an engine table is still present in schema onchain';
  END $verify$;
  \quit
\endif

\if :wrong_table_count
  \echo 'POSTCONDITION FAILED: schema onchain does not hold exactly three tables'
  DO $verify$ BEGIN
    RAISE EXCEPTION 'POSTCONDITION FAILED: schema onchain does not hold exactly three tables';
  END $verify$;
  \quit
\endif

\if :read_role_cannot_read_all
  \echo 'POSTCONDITION FAILED: the read role cannot SELECT one of the three snapshotter tables'
  DO $verify$ BEGIN
    RAISE EXCEPTION 'POSTCONDITION FAILED: the read role cannot SELECT one of the three snapshotter tables — a grant did not survive, or the wrong READ_ROLE was passed';
  END $verify$;
  \quit
\endif

\echo 'POSTCONDITION HOLDS: three tables remain, all readable by the read role.'
