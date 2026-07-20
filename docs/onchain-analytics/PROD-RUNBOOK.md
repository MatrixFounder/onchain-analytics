# PROD-RUNBOOK — dev (Supabase) → prod deploy of the snapshotter

- **Status:** Draft (Step 1d — write now, execute after the ≥24h dev soak). Operationalizes
  [DB-SCHEMA-CONCEPT §8.5/§8.6](DB-SCHEMA-CONCEPT.md) for the concrete artifacts we built.
- **Scope:** move `onchain` schema + the 3 n8n workflows from the dev VM (Supabase `supabase-db`)
  to a prod host. NOT re-designing anything — same schema, same workflows, same conventions.

## What exists (dev, source of truth)

- **DB:** `supabase-db` (PostgreSQL 15.8) → db `postgres`, schema `onchain` (`assets`/`metrics`/`snapshots`),
  applied via [`sql/migrations/001_init.sql`](../../sql/migrations/001_init.sql). Writer role: `postgres`.
- **Workflows** (n8n, exported to [`n8n-workflows/exported/`](../../n8n-workflows/)):
  `onchain-snapshotter` (hourly), `onchain-verify` (daily), `onchain-error-alert` (on error).
- **Credentials** (in n8n, never in git): **Supabase DB** (postgres), **Onchain bot** (telegram).

## Prod topology (DB-SCHEMA §8)

Dedicated host, `docker compose`: `postgres:16` + `n8n` (per the `n8n-self-hosting` skill), behind a
reverse proxy w/ TLS. Prod db `onchain_intel`, schema `onchain`, owner role `onchain_app` — here
`00_bootstrap.sql` **is** used (unlike the Supabase dev path). All ops via `ssh` per the `vm-deploy`
skill; additive-only; destructive ops need confirmation.

## Runbook (order is mandatory — §8.5)

1. **Prod DB up + schema.** Bring up the prod compose. Apply, as admin:
   `psql -v ONCHAIN_APP_PASSWORD=… -f sql/00_bootstrap.sql` (role + db + schema `onchain`), then
   `psql "postgresql://onchain_app@PROD/onchain_intel" -f sql/migrations/001_init.sql` (tables + seed).
2. **Transfer history FIRST, before starting the prod writer.** From dev Supabase:
   `pg_dump -Fc --schema=onchain -d postgres | pg_restore --no-owner -d onchain_intel` (or CSV per §5.2).
   The dedicated `onchain` schema makes the dump exact — nothing else from the shared cluster.
3. **Import workflows.** `n8n-workflows/exported/*.json` → prod n8n via the public API
   (`import.sh`, below). Then **re-link credentials by hand** in prod n8n Credentials: create
   **Supabase DB** (→ prod `onchain_intel`, user `onchain_app`) and **Onchain bot** (same bot token,
   chat `207209924`); the exported JSON carries only credential *names/ids*, no secrets.
4. **Verify gate (§5.3).** Row counts match; `min`/`max(ts)` match; N random `value_raw` byte-identical;
   **zero orphans** (`snapshots` with no `assets`/`metrics` row). Run the `onchain-verify` query.
5. **Cutover.** Activate prod `onchain-snapshotter` + `onchain-verify`; set each `errorWorkflow` =
   prod `onchain-error-alert`. **Then** deactivate the dev snapshotter. Tail rows written after step 2
   reconcile via a second `pg_dump … | psql` with `INSERT … ON CONFLICT DO NOTHING` (two separate PG
   instances — UNIQUE dedups only within one DB; idempotency §1.5 makes docatch safe).
6. **Record the move** — date, hosts, verify result — in the install log. Nothing silently (§6).
   Freeze the dev dump as a rollback path for N days.

## Backup (from day 1 — §8.6)

`pg_dump -Fc --schema=onchain onchain_intel` on a schedule (a dedicated n8n workflow or cron) →
S3-compatible storage (R2/B2/minio), generational retention. Off-site copy exists **independently**
of moves. On confirmed volumes (hundreds of rows/day) `pg_dump`/`pg_restore` is sufficient; logical
replication (`FOR TABLES IN SCHEMA onchain`) only if volume grows.

## import.sh (to author when prod exists)

Mirror of `n8n-workflows/export.sh`: `POST /api/v1/workflows` each `exported/*.json` with volatile
fields already stripped; then re-link credentials + activate. (The `czlonkowski/n8n-lazy-loading`
`scripts/import_with_relink.py` is the reference for credential/id relinking.)
