-- 00_bootstrap.sql — PROD / standalone dedicated-Postgres profile ONLY.
--
-- NOT used for the Supabase dev path. On Supabase we reuse the existing `postgres` superuser
-- and db `postgres`, and only create schema `onchain` (which migrations/001_init.sql already
-- does). Dev apply (from repo root):
--   ssh vm 'docker exec -i supabase-db psql -qU supabase_admin -d postgres -v ON_ERROR_STOP=1' \
--     < sql/migrations/001_init.sql
--
-- This script is for a FRESH dedicated cluster (prod, §8): run ONCE by an admin/superuser.
-- Creates the app role, the onchain_intel database, and the onchain schema (§8.1, §8.4).
-- The password is passed as a psql variable, NEVER hardcoded (ADR-001 D10):
--
--   psql -h <host> -U postgres -v ONCHAIN_APP_PASSWORD="$ONCHAIN_APP_PASSWORD" -f 00_bootstrap.sql
--
-- Idempotent: safe to re-run.

\set ON_ERROR_STOP on

-- 1) App role (LOGIN). Guarded so re-runs don't error.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'onchain_app') THEN
    EXECUTE format('CREATE ROLE onchain_app LOGIN PASSWORD %L', :'ONCHAIN_APP_PASSWORD');
  END IF;
END$$;

-- 2) Database owned by the app role. CREATE DATABASE cannot run in a transaction/DO block,
--    so emit it conditionally and execute via \gexec.
SELECT 'CREATE DATABASE onchain_intel OWNER onchain_app'
 WHERE NOT EXISTS (SELECT 1 FROM pg_database WHERE datname = 'onchain_intel')\gexec

-- 3) Schema owned by the app role; role defaults its search_path to it (§1.11).
\connect onchain_intel
CREATE SCHEMA IF NOT EXISTS onchain AUTHORIZATION onchain_app;
ALTER ROLE onchain_app SET search_path = onchain;

-- 4) Optional hardening (§1.11): nothing should be created in public.
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
