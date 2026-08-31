-- migrations/005_wi62_dedicated_container.sql — the engine's own dedicated Postgres container
-- (WI-62/T-015 task 015-21), created from nothing: schema, thirteen tables, one application role's
-- grants, and a verify block. Source of truth: docs/architectures/deployment.md §10.9.2 (the
-- migration) and §10.9.3 (the grants), docs/tasks/task-015-21-container-migration-grants.md (the
-- five stated differences from the pattern file below, plus schema creation — see the note ahead of
-- `CREATE SCHEMA`).
--
-- Pattern file: sql/migrations/002_t014_network_profile.sql. FIVE differences from it:
--   1. ONE role parameter, not two — `STATE_ROLE` only. This container never holds `assets`,
--      `metrics` or `snapshots`, so there is nothing for a read role to read (R-8.6, R-8.7).
--   2. A THIRTEENTH table, `onchain.client_usage` — the client billing ledger of T-015 (task 015-03),
--      MAJOR-F (architecture review round 2): the ledger lives ONLY on this container, never on
--      `supabase-db`.
--   3. Applied as the superuser the plain `postgres:16-alpine` image ships, `postgres` — not
--      `supabase_admin`, which is a Supabase-stack role this container does not carry.
--   4. `onchain.usage` carries a fourth column, `calls_made BIGINT NOT NULL DEFAULT 0`, with an
--      inline `CHECK (calls_made >= 0)` — absent from file 002, present on the SQLite axis's
--      `usage_window` pattern and required by the daily call gate of task 015-14. Without it, that
--      gate's operator fails on this container with `column "calls_made" does not exist`.
--   5. `onchain.access_profiles` carries a named format guard on `credits_balance_raw` — MINOR-7
--      (architecture review round 2): an unguarded 'NaN' makes the reservation's balance comparison
--      true for any price.
--
-- **Both new CHECK constraints of differences 4 and 5 are NAMED, and named IDENTICALLY to the guarded
-- `ALTER TABLE ... ADD CONSTRAINT` names `sql/migrations/004_t015_billing.sql` uses**
-- (`usage_calls_made_non_negative`, `client_usage_balance_is_integer`). TC-OPS-09's postcondition —
-- "applying 004 after 005 changes nothing" — holds only because 004's own `pg_constraint` guard finds
-- a constraint already registered under that exact name and skips its `ALTER TABLE`. An unnamed
-- (auto-named) constraint here would not match, and 004 would then add a SECOND, redundant
-- constraint on its second application — a real change 004's own header promises never happens on
-- this container.
--
-- **Why this file also creates the schema, unlike its pattern.** File 002's own header states it
-- deliberately does NOT run `CREATE SCHEMA` because `001_init.sql` already ran on its target
-- (`supabase-db`) and created `onchain` there. This file's target is different: a freshly provisioned
-- `postgres:16-alpine` container (task 015-20) that has never run any migration and carries no
-- `onchain` schema at all — measured on the dev VM ahead of writing this file (`SELECT nspname FROM
-- pg_namespace …` returned only `public`). Omitting `CREATE SCHEMA IF NOT EXISTS onchain;` here would
-- make every `CREATE TABLE onchain.…` below fail on its very first statement. This is not a sixth
-- difference from the grant/table shape of the pattern file — it is the file creating its OWN
-- precondition on a target that starts one migration earlier than 002's did, consistent with "the
-- file creates the target state whole, not the pattern plus a guess by the reader"
-- (task-015-21, "Форма файла миграции"). No snapshotter table (`assets`/`metrics`/`snapshots`) is
-- created in this schema — those stay `supabase-db`'s alone (R-8.3).
--
-- Idempotent: CREATE ... IF NOT EXISTS, seed via ON CONFLICT DO NOTHING, CREATE OR REPLACE for the
-- audit guard, guarded ADD CONSTRAINT-shaped inline declarations. Safe to re-run (TC-OPS-08).
--
-- Type map for this dialect (§4.5.1): TEXT → TEXT, INTEGER → BIGINT, REAL → DOUBLE PRECISION.
--
--   ssh vm 'docker exec -i <new-container> psql -qU postgres -d postgres -v ON_ERROR_STOP=1 \
--     -v STATE_ROLE=onchain_engine_state' < sql/migrations/005_wi62_dedicated_container.sql
--
-- PRECONDITION: STATE_ROLE already exists on the target container, created by the operator BEFORE
-- this file runs. A GRANT names its grantee, and a missing role aborts the whole file under
-- ON_ERROR_STOP=1 — after every table was created, leaving a half-applied schema to clean up by
-- hand. This file grants; it creates no role, so no password reaches the repository.

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

-- ── Pre-check: the one parameter, before the first DDL statement ─────────────
-- An unset psql variable leaves the reference unresolved and fails at the first GRANT — thirteen
-- tables later. This block is why the file either applies fully or creates nothing.
\if :{?STATE_ROLE}
\else
  \echo 'FATAL: -v STATE_ROLE=<role> is required (deployment.md §10.9.2)'
  DO $guard$ BEGIN
    RAISE EXCEPTION 'FATAL: -v STATE_ROLE=<role> is required (deployment.md §10.9.2)';
  END $guard$;
  \quit
\endif

BEGIN;

-- ── Schema — see the header note; absent from the pattern file, required on this fresh target ──
CREATE SCHEMA IF NOT EXISTS onchain;

-- ── §4.2.4 counters: the four tables the network profile's cache and budget need ──
-- OQ-8 puts the network profile's runtime state in Postgres only. Without these four the profile
-- has no cache and no budget gate.

CREATE TABLE IF NOT EXISTS onchain.providers (
  id    TEXT PRIMARY KEY NOT NULL,
  kind  TEXT NOT NULL,
  notes TEXT
);

CREATE TABLE IF NOT EXISTS onchain.cache_entries (
  id          TEXT PRIMARY KEY NOT NULL,
  provider    TEXT NOT NULL REFERENCES onchain.providers(id),
  capability  TEXT NOT NULL,
  args_hash   TEXT NOT NULL,
  value_json  TEXT NOT NULL,
  created_at  BIGINT NOT NULL,
  expires_at  BIGINT NOT NULL,
  UNIQUE (provider, capability, args_hash)
);

-- Difference 4: `calls_made` and its named CHECK, absent from file 002's `onchain.usage`. Named to
-- match `sql/migrations/004_t015_billing.sql`'s guarded `usage_calls_made_non_negative` exactly —
-- see the file header.
CREATE TABLE IF NOT EXISTS onchain.usage (
  provider     TEXT NOT NULL REFERENCES onchain.providers(id),
  day          BIGINT NOT NULL,
  credits_used BIGINT NOT NULL DEFAULT 0,
  calls_made   BIGINT NOT NULL DEFAULT 0,
  updated_at   BIGINT NOT NULL,
  PRIMARY KEY (provider, day),
  CHECK (credits_used >= 0),
  CONSTRAINT usage_calls_made_non_negative CHECK (calls_made >= 0)
);

CREATE TABLE IF NOT EXISTS onchain.usage_window (
  provider     TEXT NOT NULL REFERENCES onchain.providers(id),
  window_start BIGINT NOT NULL,
  credits_used BIGINT NOT NULL DEFAULT 0,
  calls_made   BIGINT NOT NULL DEFAULT 0,
  updated_at   BIGINT NOT NULL,
  PRIMARY KEY (provider, window_start),
  CHECK (credits_used >= 0),
  CHECK (calls_made >= 0)
);

-- ── §4.5 identity ───────────────────────────────────────────────────────────
-- `users` and `access_profiles` precede `api_tokens`, which references both.

CREATE TABLE IF NOT EXISTS onchain.users (
  id           TEXT PRIMARY KEY NOT NULL,
  email        TEXT NOT NULL,
  display_name TEXT,
  role         TEXT NOT NULL,
  status       TEXT NOT NULL,
  created_at   BIGINT NOT NULL,
  updated_at   BIGINT NOT NULL,
  UNIQUE (email),
  CHECK (role IN ('admin','user')),
  CHECK (status IN ('active','suspended'))
);

-- Difference 5: the named format guard on `credits_balance_raw`, absent from file 002. Named to
-- match `sql/migrations/004_t015_billing.sql`'s guarded `client_usage_balance_is_integer` exactly —
-- see the file header. MINOR-7 (architecture review round 2): an unguarded 'NaN' makes the
-- reservation's `credits_balance_raw::numeric >= $2::numeric` comparison true for any price.
CREATE TABLE IF NOT EXISTS onchain.access_profiles (
  id                    TEXT PRIMARY KEY NOT NULL,
  name                  TEXT NOT NULL,
  status                TEXT NOT NULL,
  credits_mode          TEXT NOT NULL,
  credits_balance_raw   TEXT,
  rate_limit_mode       TEXT NOT NULL,
  rate_limit_per_min    BIGINT,
  tool_allowlist_mode   TEXT NOT NULL,
  tool_allowlist_json   TEXT,
  route_disclosure_mode TEXT NOT NULL DEFAULT 'full',
  created_at            BIGINT NOT NULL,
  updated_at            BIGINT NOT NULL,
  UNIQUE (name),
  CHECK (status IN ('active','retired')),
  CHECK (credits_mode IN ('unlimited','metered')),
  CHECK (rate_limit_mode IN ('unlimited','metered')),
  CHECK (tool_allowlist_mode IN ('all','list')),
  CHECK (route_disclosure_mode IN ('full','none')),
  CHECK ((credits_mode = 'metered') = (credits_balance_raw IS NOT NULL)),
  CHECK ((rate_limit_mode = 'metered') = (rate_limit_per_min IS NOT NULL)),
  CHECK ((tool_allowlist_mode = 'list') = (tool_allowlist_json IS NOT NULL)),
  CONSTRAINT client_usage_balance_is_integer
    CHECK (credits_balance_raw IS NULL OR credits_balance_raw ~ '^-?[0-9]+$')
);

CREATE TABLE IF NOT EXISTS onchain.api_tokens (
  id                TEXT PRIMARY KEY NOT NULL,
  user_id           TEXT NOT NULL REFERENCES onchain.users(id),
  access_profile_id TEXT NOT NULL REFERENCES onchain.access_profiles(id),
  token_hash        TEXT NOT NULL,
  prefix            TEXT NOT NULL,
  name              TEXT,
  status            TEXT NOT NULL,
  expires_at        BIGINT,
  revoked_at        BIGINT,
  created_at        BIGINT NOT NULL,
  UNIQUE (token_hash),
  UNIQUE (prefix),
  CHECK (length(token_hash) = 64),
  CHECK (length(prefix) >= 8),
  CHECK (status IN ('active','revoked')),
  CHECK ((status = 'revoked') = (revoked_at IS NOT NULL)),
  CHECK (expires_at IS NULL OR expires_at > created_at)
);
CREATE INDEX IF NOT EXISTS idx_api_tokens_user ON onchain.api_tokens (user_id);

CREATE TABLE IF NOT EXISTS onchain.access_audit (
  id            TEXT PRIMARY KEY NOT NULL,
  ts            BIGINT NOT NULL,
  actor_user_id TEXT REFERENCES onchain.users(id),
  action        TEXT NOT NULL,
  target_type   TEXT NOT NULL,
  target_id     TEXT NOT NULL,
  before_json   TEXT,
  after_json    TEXT,
  created_at    BIGINT NOT NULL,
  CHECK (target_type IN ('user','api_token','access_profile'))
);
CREATE INDEX IF NOT EXISTS idx_access_audit_actor  ON onchain.access_audit (actor_user_id);
CREATE INDEX IF NOT EXISTS idx_access_audit_target ON onchain.access_audit (target_id);
CREATE INDEX IF NOT EXISTS idx_access_audit_ts     ON onchain.access_audit (ts);

-- ── §4.5 limiter ────────────────────────────────────────────────────────────
-- `providers` is created above precisely because of this reference: drop it and every limiter write
-- becomes a foreign-key refusal, and R-7.7 degrades the process to an in-process bucket forever.

CREATE TABLE IF NOT EXISTS onchain.provider_buckets (
  provider       TEXT NOT NULL REFERENCES onchain.providers(id),
  scope_key      TEXT NOT NULL DEFAULT '',
  tokens         DOUBLE PRECISION NOT NULL,
  last_refill_ms BIGINT NOT NULL,
  updated_at     BIGINT NOT NULL,
  PRIMARY KEY (provider, scope_key)
);

-- ── §4.5 operational ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS onchain.request_trace (
  id                  TEXT PRIMARY KEY NOT NULL,
  received_at         BIGINT NOT NULL,
  completed_at        BIGINT NOT NULL,
  principal_id        TEXT NOT NULL,
  user_id             TEXT,
  access_profile_id   TEXT,
  client_request_id   TEXT NOT NULL,
  session_id          TEXT,
  transport           TEXT NOT NULL,
  tool                TEXT NOT NULL,
  capability          TEXT,
  args_hash           TEXT,
  outcome             TEXT NOT NULL,
  refusal_class       TEXT,
  served_from         TEXT NOT NULL,
  cache_age_ms        BIGINT,
  vendor_provider     TEXT REFERENCES onchain.providers(id),
  vendor_credits      BIGINT,
  vendor_calls        BIGINT,
  vendor_day          BIGINT,
  vendor_window_start BIGINT,
  escalated_to_paid   BIGINT NOT NULL DEFAULT 0,
  tried_json          TEXT,
  created_at          BIGINT NOT NULL,
  UNIQUE (principal_id, client_request_id, received_at),
  CHECK (outcome IN ('answer','refusal','partial_deadline')),
  CHECK (served_from IN ('cache','coalesced','vendor','none')),
  CHECK ((outcome = 'refusal') = (refusal_class IS NOT NULL)),
  CHECK (escalated_to_paid IN (0,1))
);
CREATE INDEX IF NOT EXISTS idx_request_trace_principal ON onchain.request_trace (principal_id, received_at);
CREATE INDEX IF NOT EXISTS idx_request_trace_received  ON onchain.request_trace (received_at);
CREATE INDEX IF NOT EXISTS idx_request_trace_spend     ON onchain.request_trace (vendor_provider, vendor_day);

CREATE TABLE IF NOT EXISTS onchain.diagnostics (
  id           TEXT PRIMARY KEY NOT NULL,
  ts           BIGINT NOT NULL,
  severity     TEXT NOT NULL,
  event        TEXT NOT NULL,
  principal_id TEXT,
  session_id   TEXT,
  provider     TEXT,
  capability   TEXT,
  trace_id     TEXT,
  detail_json  TEXT NOT NULL,
  created_at   BIGINT NOT NULL,
  CHECK (severity IN ('info','warn','error'))
);
CREATE INDEX IF NOT EXISTS idx_diagnostics_ts       ON onchain.diagnostics (ts);
CREATE INDEX IF NOT EXISTS idx_diagnostics_event_ts ON onchain.diagnostics (event, ts);

CREATE TABLE IF NOT EXISTS onchain.retention_runs (
  id            TEXT PRIMARY KEY NOT NULL,
  job           TEXT NOT NULL,
  target_table  TEXT NOT NULL,
  period_from   BIGINT NOT NULL,
  period_to     BIGINT NOT NULL,
  rows_affected BIGINT NOT NULL,
  started_at    BIGINT NOT NULL,
  finished_at   BIGINT NOT NULL,
  outcome       TEXT NOT NULL,
  detail_json   TEXT,
  UNIQUE (job, period_from, period_to, started_at),
  CHECK (outcome IN ('ok','failed')),
  CHECK (period_to > period_from),
  CHECK (rows_affected >= 0)
);
CREATE INDEX IF NOT EXISTS idx_retention_runs_job ON onchain.retention_runs (job, started_at);

-- ── §4.6.1 the thirteenth table — the client billing ledger (T-015, task 015-03) ────────────────
-- Difference 2. Identical shape to `sql/migrations/004_t015_billing.sql`'s own `CREATE TABLE
-- IF NOT EXISTS onchain.client_usage` — created here directly rather than by applying that file,
-- because this container starts with zero of the twelve T-014 tables, and 004's own precondition is
-- that all twelve already exist (MAJOR-F). `principal_id`/`access_profile_id` are labels, not
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
  CHECK ((state = 'reserved') = (terminal_at IS NULL))
);
CREATE INDEX IF NOT EXISTS idx_client_usage_principal ON onchain.client_usage (principal_id, reserved_at);
CREATE INDEX IF NOT EXISTS idx_client_usage_terminal   ON onchain.client_usage (terminal_at);
CREATE INDEX IF NOT EXISTS idx_client_usage_reserved   ON onchain.client_usage (state, reserved_at);

-- ── Append-only guard on the audit log (§4.5.5) ──────────────────────────────
-- Not part of the portable form: removing it changes no column, so the engine move stays mechanical.

CREATE OR REPLACE RULE access_audit_no_delete AS
  ON DELETE TO onchain.access_audit DO INSTEAD NOTHING;

CREATE OR REPLACE FUNCTION onchain.access_audit_no_update() RETURNS trigger AS $fn$
BEGIN
  RAISE EXCEPTION 'onchain.access_audit is append-only (data-model.md §4.5.5)';
END;
$fn$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER access_audit_no_update
  BEFORE UPDATE ON onchain.access_audit
  FOR EACH ROW EXECUTE FUNCTION onchain.access_audit_no_update();

-- ── Seed: the phase 0 access profile (§4.5.3) ───────────────────────────────
-- The id is the literal task 014-36 seeds on the SQLite axis and file 002 seeds on the OLD
-- container. Two engines seeding independently would mint two ids for one entity, and a token's
-- access_profile_id would resolve on one host and dangle on the other.

INSERT INTO onchain.access_profiles (
  id, name, status,
  credits_mode, credits_balance_raw,
  rate_limit_mode, rate_limit_per_min,
  tool_allowlist_mode, tool_allowlist_json,
  route_disclosure_mode,
  created_at, updated_at
) VALUES (
  '01JPHASE00000000000000000A', 'phase0-unlimited', 'active',
  'unlimited', NULL,
  'unlimited', NULL,
  'all', NULL,
  'full',
  0, 0
) ON CONFLICT (name) DO NOTHING;

-- ── Grants (deployment.md §10.9.3) ───────────────────────────────────────────
-- Enumerated one table at a time, all thirteen, to STATE_ROLE alone — no READ_ROLE parameter exists
-- in this file (difference 1): this container never holds a snapshotter table, so there is nothing
-- for a read role to read (R-8.6, R-8.7). Neither role receives CREATE: migrations run as the
-- container's own superuser, so the running process adds no table to the schema.

GRANT USAGE ON SCHEMA onchain TO :"STATE_ROLE";
GRANT SELECT, INSERT, UPDATE, DELETE ON
  onchain.users, onchain.access_profiles, onchain.api_tokens, onchain.access_audit,
  onchain.provider_buckets, onchain.request_trace, onchain.diagnostics, onchain.retention_runs,
  onchain.providers, onchain.cache_entries, onchain.usage, onchain.usage_window,
  onchain.client_usage
  TO :"STATE_ROLE";

COMMIT;

-- ── Verify gate (task-015-21, "Verify-блок файла") ───────────────────────────
-- Four assertions, all on empty tables (this migration creates no row-transfer step — that is task
-- 015-23). Record date, host and this output before the profile serves its first request against
-- this container: an unrecorded run is indistinguishable from one that never happened.

\echo '── verify 1/4: the thirteen engine tables exist in onchain, nothing in public ──'
SELECT count(*) AS engine_tables_present, 13 AS expected
  FROM information_schema.tables
 WHERE table_schema = 'onchain'
   AND table_name IN ('users','access_profiles','api_tokens','access_audit','provider_buckets',
                      'request_trace','diagnostics','retention_runs','providers','cache_entries',
                      'usage','usage_window','client_usage');

SELECT count(*) AS objects_created_in_public
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public'
   AND c.relname IN ('users','access_profiles','api_tokens','access_audit','provider_buckets',
                     'request_trace','diagnostics','retention_runs','providers','cache_entries',
                     'usage','usage_window','client_usage');

\echo '── verify 2/4: may_select under the state role, true for exactly the thirteen ──'
-- has_table_privilege, never information_schema.role_table_grants: the catalogue view is blind to a
-- grant to PUBLIC, to a privilege inherited through a group role, and to any grant whose roles are
-- not enabled in the session. An empty result there means "not found", not "not granted" (L-10).
SELECT t.table_name,
       has_table_privilege(:'STATE_ROLE', 'onchain.' || t.table_name, 'SELECT') AS may_select
  FROM information_schema.tables t
 WHERE t.table_schema = 'onchain'
 ORDER BY 1;

\echo '── verify 3/4: the roles that exist on this container — measured, not assumed (R-8.6) ──'
SELECT rolname, rolsuper, rolcanlogin FROM pg_roles WHERE rolname NOT LIKE 'pg\_%' ORDER BY 1;

\echo '── verify 4/4: has_table_privilege per application role x per engine table (AC-17b) ──'
-- The superuser is excluded by construction (deployment.md §10.9.3): it holds every privilege
-- regardless of any grant, so it is not the property under test — the same qualification already
-- made for `authenticator` at deployment.md §10.4.2.
SELECT r.rolname, t.table_name,
       has_table_privilege(r.rolname, 'onchain.' || t.table_name, 'SELECT') AS may_select
  FROM pg_roles r
 CROSS JOIN (
       SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'onchain'
      ) t
 WHERE r.rolname NOT LIKE 'pg\_%'
   AND r.rolsuper = false
 ORDER BY 1, 2;
