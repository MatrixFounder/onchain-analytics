-- migrations/004_t015_billing.sql — T-015 billing ledger: `client_usage`, `usage.calls_made`, and
-- the state-role grant that reaches the new table.
-- Source of truth: data-model.md §4.6 (T-015 — the client billing ledger and the daily call gate),
-- deployment.md §10.9.4/§10.9.7 (where the ledger is allowed to live), task 015-03.
--
-- ── MAJOR-F (architecture review round 2) — the ONLY legitimate target of this file ─────────────
-- This file's precondition is a Postgres database that ALREADY carries the twelve T-014 engine
-- tables of the `002_t014_network_profile.sql` pattern (`onchain.providers` .. `onchain.retention_runs`).
-- The one database meeting that precondition today is `supabase-db` (`deployment.md`:706, "live on
-- the dev VM"), and applying THIS file there is FORBIDDEN: `deployment.md` §10.9.4 states the client
-- billing ledger lives ONLY on the new, dedicated container WI-62/015-20 stands up, never on
-- `supabase-db` — that container's twelve T-014 tables are DROPPED WHOLESALE by task 015-27 in one
-- irreversible step (§10.9.7), and a `client_usage` row written before that step would vanish with
-- them. §10.9.4's own verify gate already marks `client_usage` "NOT APPLICABLE" for that container,
-- for the same reason.
--
-- Concretely: in T-015 this file does NOT reach the rollout path. The new container is created by
-- file `005_wi62_dedicated_container.sql` (task 015-21) with all THIRTEEN tables already present in
-- one shot, the same way `CACHE_DDL` gives the SQLite axis a fresh table in one string rather than a
-- separate ALTER. This file's own use in T-015 is limited to proving TC-OPS-09 (re-apply
-- idempotency) against that SAME new container, applied a second time AFTER file 005 — never against
-- `supabase-db`. The command below is shown for the file's own shape only:
--
--   ssh vm 'docker exec -i <new-container> psql -qU postgres -d postgres -v ON_ERROR_STOP=1 \
--     -v STATE_ROLE=onchain_engine_state' < sql/migrations/004_t015_billing.sql
--
-- DO NOT RUN THIS AGAINST supabase-db. Its target is the new container's own DSN once task 015-20
-- provisions it — never the container this file's own header just named as the one existing database
-- old enough to satisfy the precondition below.
--
-- PRECONDITION: the twelve T-014 tables already exist in schema `onchain` on the target host, and
-- STATE_ROLE already exists (deployment.md §10.4.2 step 1 / §10.9.1). No READ_ROLE parameter here:
-- the new container carries no snapshotter table, so it grants no read role at all (§10.9.2).
--
-- Idempotent: `CREATE TABLE IF NOT EXISTS`, `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, and both new
-- CHECK constraints are added under an explicit `pg_constraint` guard — Postgres 16 has no
-- `ADD CONSTRAINT IF NOT EXISTS` form, and this file must survive being applied twice (TC-OPS-09).
--
-- Type map for this dialect (§4.5.1, DB-SCHEMA-CONCEPT §5): TEXT → TEXT, INTEGER → BIGINT.

-- ── L-28: how these guards report their refusal ──────────────────────────────
-- `\quit 1` does NOT return 1. The exit-status argument to `\quit` arrived in PostgreSQL 17;
-- measured 2026-08-28 on both targets — psql 15.8 (`supabase-db`) and 16.13 (`onchain-engine-db`)
-- — it prints `\quit: extra argument "1" ignored` and the process exits 0. A caller reading `$?`
-- therefore saw SUCCESS on a refusal and went on believing the file had applied.
--
-- Each guard below now raises instead. `RAISE EXCEPTION` exits 3, and the `\set` on the next line
-- makes that independent of whether the caller passed `-v ON_ERROR_STOP=1` — the guard must not
-- rely on the operator remembering a flag in order to be observable. `\quit` is kept after the
-- raise as the belt to that brace; under ON_ERROR_STOP the script never reaches it.
--
-- The `\echo` above each raise is kept deliberately: it prints without a server round trip, so the
-- reason survives even a connection that cannot execute `DO`.
\set ON_ERROR_STOP on

\if :{?STATE_ROLE}
\else
  \echo 'FATAL: -v STATE_ROLE=<role> is required (deployment.md §10.4.2 step 2)'
  DO $guard$ BEGIN
    RAISE EXCEPTION 'FATAL: -v STATE_ROLE=<role> is required (deployment.md §10.4.2 step 2)';
  END $guard$;
  \quit
\endif

BEGIN;

-- ── data-model.md §4.6.1 — the ledger T-015 charges into ────────────────────────────────────────
-- Package boundary (the same note `cache/ddl.ts:320-327` carries on the SQLite axis): only the DDL
-- is declared here. The STORE over this table is designed and written in packages/mcp-server (task
-- 015-06/015-07), never in packages/core (security.md §7.5.1, "packages/core gains no knowledge of
-- tokens, roles or headers").
--
-- The dedup key `UNIQUE (principal_id, client_request_id)` carries NO time component, unlike
-- `request_trace`'s own `(principal_id, client_request_id, received_at)` — time there is deliberate,
-- a retry writes a SECOND trace row. A billing key of that shape would let a retry charge twice
-- (R-5.1, AC-12; closes ADR-003 OQ-F).
--
-- `price_raw` is TEXT for the same reason `access_profiles.credits_balance_raw` below is (§1.7):
-- credits exceed the safe 2^53 of a JS number. `principal_id`/`access_profile_id` are labels, not
-- foreign keys, mirroring `request_trace.principal_id` — the local profile's principal has no token
-- row, and a REFERENCES clause would refuse every stdio-profile write.

CREATE TABLE IF NOT EXISTS onchain.client_usage (
  id                 TEXT PRIMARY KEY NOT NULL,
  principal_id       TEXT NOT NULL,
  access_profile_id  TEXT,
  client_request_id  TEXT NOT NULL,
  tool               TEXT NOT NULL,
  capability         TEXT,
  price_raw          TEXT NOT NULL,
  state              TEXT NOT NULL,
  refund_reason      TEXT,
  reserved_at        BIGINT NOT NULL,
  terminal_at        BIGINT,
  created_at         BIGINT NOT NULL,
  updated_at         BIGINT NOT NULL,
  UNIQUE (principal_id, client_request_id),
  CHECK (state IN ('reserved','settled','refunded')),
  CHECK ((state = 'refunded') = (refund_reason IS NOT NULL)),
  -- The retention job filters on terminal_at alone, with no separate branch on state (§4.6.1) — this
  -- tie is what lets it do that.
  CHECK ((state = 'reserved') = (terminal_at IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_client_usage_principal ON onchain.client_usage (principal_id, reserved_at);
CREATE INDEX IF NOT EXISTS idx_client_usage_terminal   ON onchain.client_usage (terminal_at);
CREATE INDEX IF NOT EXISTS idx_client_usage_reserved   ON onchain.client_usage (state, reserved_at);

-- ── data-model.md §4.6.3 — the daily call gate, extending `usage` ───────────────────────────────
-- Same provider, same day bucket, same row, same transaction as `usage.credits_used` — one column
-- rather than a second table (§4.6.3). `DEFAULT 0` needs no backfill: a `usage` row that predates
-- this column has, by construction, no counted calls yet — the same reasoning already applied to
-- `usage_window.calls_made` (`002_t014_network_profile.sql:72-81`).

ALTER TABLE onchain.usage ADD COLUMN IF NOT EXISTS calls_made BIGINT NOT NULL DEFAULT 0;

-- Named table CHECK, guarded: Postgres 16 has no `ADD CONSTRAINT IF NOT EXISTS`, and this statement
-- must be a no-op the second time this file runs (TC-OPS-09).
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'usage_calls_made_non_negative'
       AND conrelid = 'onchain.usage'::regclass
  ) THEN
    ALTER TABLE onchain.usage
      ADD CONSTRAINT usage_calls_made_non_negative CHECK (calls_made >= 0);
  END IF;
END
$$;

-- ── MINOR-7 (architecture review round 2) — `access_profiles.credits_balance_raw` must be an
-- integer-shaped string ─────────────────────────────────────────────────────────────────────────
-- The reservation compares `credits_balance_raw::numeric >= $2::numeric`. A value of 'NaN' makes
-- that comparison true for ANY price, and the subtraction that follows produces 'NaN' again: every
-- call would be served and none would ever be charged.
--
-- Declared on the Postgres axis ONLY, and that asymmetry is deliberate (asserted by
-- `packages/core/test/ddl-dialect-parity.test.ts`, TC-UNIT-09, not left silent): the predicate needs
-- `~`, which SQLite has no equivalent operator for, but SQLite needs none either — its arithmetic
-- already runs in `BigInt` (`data-model.md` §4.6.1), and `BigInt('NaN')` throws by construction, so
-- the refusal exists there without an added constraint.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conname = 'client_usage_balance_is_integer'
       AND conrelid = 'onchain.access_profiles'::regclass
  ) THEN
    ALTER TABLE onchain.access_profiles
      ADD CONSTRAINT client_usage_balance_is_integer
      CHECK (credits_balance_raw IS NULL OR credits_balance_raw ~ '^-?[0-9]+$');
  END IF;
END
$$;

-- ── Grant (deployment.md §10.5.1, §10.9.3) — named, never `ALL TABLES IN SCHEMA` ────────────────
-- `onchain.usage`/`onchain.access_profiles` are already granted to the state role by migration 002;
-- only the NEW table needs a grant here.

GRANT SELECT, INSERT, UPDATE, DELETE ON onchain.client_usage TO :"STATE_ROLE";

COMMIT;

-- ── Verify gate ───────────────────────────────────────────────────────────────────────────────
-- Record date, host and this output before the ledger serves its first reservation — an unrecorded
-- run is indistinguishable from one that never happened (CLAUDE.md, "Nothing silently").

\echo '── verify 1/3: client_usage exists — the thirteenth table alongside the twelve of migration 002 ──'
SELECT count(*) AS client_usage_present, 1 AS expected
  FROM information_schema.tables
 WHERE table_schema = 'onchain' AND table_name = 'client_usage';

\echo '── verify 2/3: usage.calls_made exists, and the state role may write client_usage ──'
SELECT count(*) AS calls_made_present, 1 AS expected
  FROM information_schema.columns
 WHERE table_schema = 'onchain' AND table_name = 'usage' AND column_name = 'calls_made';
SELECT has_table_privilege(:'STATE_ROLE', 'onchain.client_usage', 'INSERT') AS state_role_may_insert;

\echo '── verify 3/3: zero rows violate either guarded CHECK — fail-closed measured, not assumed ──'
SELECT
  (SELECT count(*) FROM onchain.usage WHERE calls_made < 0)           AS negative_calls_made,
  (SELECT count(*) FROM onchain.access_profiles
     WHERE credits_balance_raw IS NOT NULL
       AND credits_balance_raw !~ '^-?[0-9]+$')                       AS non_integer_balance;
