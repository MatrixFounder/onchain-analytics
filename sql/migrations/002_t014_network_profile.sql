-- migrations/002_t014_network_profile.sql — T-014 engine tables in the shared schema `onchain`.
-- Source of truth: data-model.md §4.4 (the five migration obligations), §4.5 (eight engine tables),
-- §4.2.4 (the four counter tables), deployment.md §10.5.1 (grants) and §10.4.2 (apply order).
--
-- UNLIKE 001_init.sql THIS FILE USES psql META-COMMANDS and does not paste into a GUI SQL editor.
-- The two role names are installation-local, so they arrive as parameters rather than literals:
--
--   ssh vm 'docker exec -i supabase-db psql -qU supabase_admin -d postgres -v ON_ERROR_STOP=1 \
--     -v STATE_ROLE=onchain_engine_state -v READ_ROLE=readonly_user' \
--     < sql/migrations/002_t014_network_profile.sql
--
-- PRECONDITION: STATE_ROLE already exists (deployment.md §10.4.2 step 1). A GRANT names its grantee,
-- and a missing role aborts the whole file under ON_ERROR_STOP=1 — after the tables were created,
-- leaving a half-applied schema to clean up by hand. This file grants; it creates no role, so no
-- password reaches the repository.
--
-- Idempotent: CREATE ... IF NOT EXISTS, seed via ON CONFLICT DO NOTHING, CREATE OR REPLACE for the
-- audit guard. Safe to re-run.
--
-- Type map for this dialect (§4.5.1): TEXT → TEXT, INTEGER → BIGINT, REAL → DOUBLE PRECISION.
--
-- This file does NOT create the schema. 001_init.sql:18 already did, and the dev VM holds it today.
-- On a host without it, CREATE SCHEMA here would succeed and hide the fact that 001 never ran; the
-- failure on a missing schema is what names that state (§4.4).

-- ── Pre-check: both parameters, before the first DDL statement ───────────────
-- An unset psql variable leaves the reference unresolved and fails at the first GRANT — twelve
-- tables later. This block is why the file either applies fully or creates nothing.
\if :{?STATE_ROLE}
\else
  \echo 'FATAL: -v STATE_ROLE=<role> is required (deployment.md §10.4.2 step 2)'
  \quit 1
\endif
\if :{?READ_ROLE}
\else
  \echo 'FATAL: -v READ_ROLE=<role> is required (deployment.md §10.4.2 step 2)'
  \quit 1
\endif

BEGIN;

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

CREATE TABLE IF NOT EXISTS onchain.usage (
  provider     TEXT NOT NULL REFERENCES onchain.providers(id),
  day          BIGINT NOT NULL,
  credits_used BIGINT NOT NULL DEFAULT 0,
  updated_at   BIGINT NOT NULL,
  PRIMARY KEY (provider, day),
  CHECK (credits_used >= 0)
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
  CHECK ((tool_allowlist_mode = 'list') = (tool_allowlist_json IS NOT NULL))
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
-- The id is a literal, identical to the one task 014-36 seeds on the SQLite axis. Two engines
-- seeding independently would mint two ids for one entity, and a token's access_profile_id would
-- resolve on one host and dangle on the other.

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

-- ── Grants (deployment.md §10.5.1) ──────────────────────────────────────────
-- Enumerated one table at a time. `ALL TABLES IN SCHEMA onchain` would cover the three snapshotter
-- tables, and that boundary is the whole reason these grants exist.
-- Neither role receives CREATE: migrations run as supabase_admin, so the running process adds no
-- table to the shared schema.

GRANT USAGE ON SCHEMA onchain TO :"STATE_ROLE";
GRANT SELECT, INSERT, UPDATE, DELETE ON
  onchain.users, onchain.access_profiles, onchain.api_tokens, onchain.access_audit,
  onchain.provider_buckets, onchain.request_trace, onchain.diagnostics, onchain.retention_runs,
  onchain.providers, onchain.cache_entries, onchain.usage, onchain.usage_window
  TO :"STATE_ROLE";

GRANT USAGE ON SCHEMA onchain TO :"READ_ROLE";
GRANT SELECT ON onchain.assets, onchain.metrics, onchain.snapshots TO :"READ_ROLE";

COMMIT;

-- ── Verify gate (§4.4 item 4) ───────────────────────────────────────────────
-- Four assertions, all on empty tables. Row counts and min/max(ts) from DB-SCHEMA §5.3 have nothing
-- to compare against — nothing is being moved — but the orphan check holds on an empty table, so it
-- stays. Record date, host and this output before the profile serves its first request: an
-- unrecorded run is indistinguishable from one that never happened.

\echo '── verify 1/4: the twelve engine tables exist in onchain, nothing in public ──'
SELECT count(*) AS engine_tables_present, 12 AS expected
  FROM information_schema.tables
 WHERE table_schema = 'onchain'
   AND table_name IN ('users','access_profiles','api_tokens','access_audit','provider_buckets',
                      'request_trace','diagnostics','retention_runs','providers','cache_entries',
                      'usage','usage_window');

SELECT count(*) AS objects_created_in_public
  FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
 WHERE n.nspname = 'public'
   AND c.relname IN ('users','access_profiles','api_tokens','access_audit','provider_buckets',
                     'request_trace','diagnostics','retention_runs','providers','cache_entries',
                     'usage','usage_window');

\echo '── verify 2/4: the seeded foreign-key target is present ──'
-- `providers` rows arrive from the process bootstrap upsert before the limiter first writes (§4.5.6).
SELECT count(*) AS phase0_profile_rows FROM onchain.access_profiles WHERE name = 'phase0-unlimited';

\echo '── verify 3/4: zero orphans on every table carrying REFERENCES ──'
SELECT
  (SELECT count(*) FROM onchain.cache_entries c
     WHERE NOT EXISTS (SELECT 1 FROM onchain.providers p WHERE p.id = c.provider))      AS cache_entries,
  (SELECT count(*) FROM onchain.usage u
     WHERE NOT EXISTS (SELECT 1 FROM onchain.providers p WHERE p.id = u.provider))      AS usage,
  (SELECT count(*) FROM onchain.usage_window w
     WHERE NOT EXISTS (SELECT 1 FROM onchain.providers p WHERE p.id = w.provider))      AS usage_window,
  (SELECT count(*) FROM onchain.provider_buckets b
     WHERE NOT EXISTS (SELECT 1 FROM onchain.providers p WHERE p.id = b.provider))      AS provider_buckets,
  (SELECT count(*) FROM onchain.api_tokens t
     WHERE NOT EXISTS (SELECT 1 FROM onchain.users u2 WHERE u2.id = t.user_id))         AS api_tokens_user,
  (SELECT count(*) FROM onchain.api_tokens t
     WHERE NOT EXISTS (SELECT 1 FROM onchain.access_profiles a WHERE a.id = t.access_profile_id))
                                                                                        AS api_tokens_profile,
  (SELECT count(*) FROM onchain.access_audit a
     WHERE a.actor_user_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM onchain.users u3 WHERE u3.id = a.actor_user_id))   AS access_audit,
  (SELECT count(*) FROM onchain.request_trace r
     WHERE r.vendor_provider IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM onchain.providers p WHERE p.id = r.vendor_provider))
                                                                                        AS request_trace;

\echo '── verify 4/4: the state role reaches no snapshotter row (deployment.md §10.4.2 step 2) ──'
-- has_table_privilege, never information_schema.role_table_grants: the catalogue view is blind to a
-- grant to PUBLIC, to a privilege inherited through a group role, and to any grant whose roles are
-- not enabled in the session. An empty result there means "not found", not "not granted" (L-10).
SELECT t.table_name,
       has_table_privilege(:'STATE_ROLE', 'onchain.' || t.table_name, 'SELECT') AS may_select
  FROM information_schema.tables t
 WHERE t.table_schema = 'onchain'
   AND t.table_name IN ('assets', 'metrics', 'snapshots')
 ORDER BY 1;
