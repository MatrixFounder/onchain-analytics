# PROD-RUNBOOK — dev (Supabase) → prod deploy of the snapshotter

- **Status:** Ready. Operationalizes [DB-SCHEMA-CONCEPT §8.5/§8.6](DB-SCHEMA-CONCEPT.md) for the
  concrete artifacts we built. **Two paths:** *fresh* (prod starts empty — the default below) or
  *history-transfer* (§ "Alternative"). NOT re-designing anything — same schema, same workflows.
- **Scope:** stand up the `onchain` schema + the 3 n8n workflows on a prod host where n8n + Postgres
  already run. All ops via `ssh` per the `vm-deploy` skill; additive-only; destructive ops confirmed.

## What exists (dev, source of truth)

- **DB:** schema `onchain` (`assets`/`metrics`/`snapshots`), applied via
  [`001_init.sql`](../../sql/migrations/001_init.sql) **then**
  [`002_zec_block_height.sql`](../../sql/migrations/002_zec_block_height.sql). Registry =
  **2 assets / 11 metrics**. Sources in use: `platform-explorer`, `zechub`, `blockchair`.
- **Workflows** (n8n, exported to [`n8n-workflows/exported/`](../../n8n-workflows/)):
  - `onchain-snapshotter` (hourly) — **two-clock model**: one `Normalize` node fans into **two**
    Postgres writers — `Write snapshots` (append, `ON CONFLICT DO NOTHING`) for hourly observations
    (dash-platform 8 metrics + `zec_block_height` from blockchair), and `Upsert zec supply`
    (`ON CONFLICT DO UPDATE`) for the daily revisable `zec_*_supply` aggregate keyed on the ZecHub
    `close` date. A keyless HTTP node `Zcash tip` (blockchair `/zcash/stats`) feeds the height clock.
  - `onchain-verify` (daily) · `onchain-error-alert` (on error; has a `Normalize Input` Set node).
- **Credentials** (in n8n, never in git): **Supabase DB** (postgres), **Onchain bot** (telegram).

## Prod topology (DB-SCHEMA §8)

Prod db `onchain_intel`, schema `onchain`, owner role `onchain_app` — here `00_bootstrap.sql` **is**
used (unlike the Supabase dev path). Prod Postgres is a **dedicated DB on the same cluster as n8n but
NOT n8n's own DB** (`postgres-n8n` is off-limits). Keep n8n `GENERIC_TIMEZONE=UTC` and PG server
`timezone=UTC`, and `N8N_BLOCK_ENV_ACCESS_IN_NODE=true` (parity with dev).

## Runbook — FRESH deploy (order is mandatory)

### 0. Prereqs
- Confirm **PG ≥ 13** (`SHOW server_version`) — `001` defaults `snapshots.id` to `gen_random_uuid()`
  (core in 13+). If older, the **superuser** must `CREATE EXTENSION IF NOT EXISTS pgcrypto` in
  `onchain_intel` before `001` (`onchain_app` can't).
- Stage secrets out-of-band (never inline / shell history): `ONCHAIN_APP_PASSWORD` (consumed by
  `00_bootstrap.sql` as psql var `:ONCHAIN_APP_PASSWORD`) **and** `PGPASSWORD`/`~/.pgpass` for
  `onchain_app` (the migration URI carries no password → psql would hang in automation).
- Know the real **admin/superuser role** (may not literally be `postgres` on managed PG; needs
  SUPERUSER / CREATEROLE+CREATEDB).

### 1. Database (containerized prod → pipe over stdin per `vm-deploy`; never `-f` a path in-container)
```bash
# bootstrap as SUPERUSER (role onchain_app + db onchain_intel + schema onchain + lock public)
ssh prod 'docker exec -i -e PGPW="$ONCHAIN_APP_PASSWORD" <pg-container> \
  psql -qU postgres -v ON_ERROR_STOP=1 -v ONCHAIN_APP_PASSWORD="$PGPW"' < sql/00_bootstrap.sql
# migrations as onchain_app, numeric order (001 THEN 002)
ssh prod 'docker exec -i -e PGPASSWORD="$ONCHAIN_APP_PASSWORD" <pg-container> \
  psql -qU onchain_app -d onchain_intel -v ON_ERROR_STOP=1' < sql/migrations/001_init.sql
ssh prod 'docker exec -i -e PGPASSWORD="$ONCHAIN_APP_PASSWORD" <pg-container> \
  psql -qU onchain_app -d onchain_intel -v ON_ERROR_STOP=1' < sql/migrations/002_zec_block_height.sql
```
- **Ownership check (the Supabase-grant analog we hit in dev):** every object in `onchain` must be
  owned by `onchain_app`, else writes fail with "permission denied". After bootstrap-as-superuser +
  migrations-as-`onchain_app` this holds; verify:
  `SELECT count(*) FROM pg_tables WHERE schemaname='onchain' AND tableowner<>'onchain_app';` → **0**.
  (If any DDL ran as admin: `REASSIGN OWNED BY <admin> TO onchain_app;` + `GRANT USAGE,ALL …`.)

### 2. Verify gate (as `onchain_app`)
```sql
SET search_path TO onchain;
SELECT count(*) FROM assets;   -- expect 2
SELECT count(*) FROM metrics;  -- expect 11   (NOT 10 — 002 adds zec_block_height)
SELECT count(*) FROM snapshots s LEFT JOIN assets a ON s.asset=a.id
  LEFT JOIN metrics m ON s.metric=m.id WHERE a.id IS NULL OR m.id IS NULL;  -- expect 0
```

### 3. Credentials (create in prod n8n Credentials FIRST — secrets are never in the JSON)
- **Supabase DB** (postgres) → **prod** host / db `onchain_intel` / user `onchain_app` / schema
  `onchain`. ⚠️ The host lives *inside* the credential — cloning the dev cred silently writes to dev
  (`ubuntu-linux-2404.local`). Name it exactly `Supabase DB`. **Record the new credential id.**
- **Onchain bot** (telegram). Reuse the dev bot token → chat `207209924` already `/start`-ed it, works
  immediately. New bot → user `207209924` must `/start` it first, else every send `403`s **silently**.
  **Record the new credential id.**
- No other credential: `Zcash tip` is keyless HTTP; error-alert's `Normalize Input` adds none. Do
  **not** invent a blockchair credential.

### 4. Import workflows (order is load-bearing — errorWorkflow chicken-and-egg)
Exported JSON carries **stale dev ids** that a fresh instance can't resolve (`export.sh` strips
top-level ids but NOT node `credentials.id` nor `settings.errorWorkflow`). Remap **by name**:

| Ref in JSON | dev id (dangling on prod) | remap to |
|---|---|---|
| PG cred `Supabase DB` (3 nodes: snapshotter `Write snapshots` + `Upsert zec supply`, verify `Verify query`) | `cxLk68mkh5BMWchQ` | new prod PG cred id |
| TG cred `Onchain bot` (2 nodes: verify `Report`, error-alert `Telegram alert`) | `cMrsUr48jl2JVEUi` | new prod TG cred id |
| `settings.errorWorkflow` (snapshotter + verify) | `WapVxU2SneMiNNyM` | **new** error-alert workflow id |

1. Import **`onchain-error-alert.json` FIRST** (UI: *Workflows → Import from File*, or `POST
   /api/v1/workflows`). Re-select its `Telegram alert` credential → prod **Onchain bot**. **Record
   its new workflow id.**
2. Import `onchain-snapshotter.json` + `onchain-verify.json`. Re-select every PG/TG credential node
   to the prod creds (dev ids show as "credential not found" until remapped).
3. In **both** snapshotter + verify: *Workflow Settings → Error Workflow* → the new
   `onchain-error-alert`. Then confirm none still reference `cxLk68mkh5BMWchQ` /
   `cMrsUr48jl2JVEUi` / `WapVxU2SneMiNNyM`.
   - *API-create caveat:* strip `settings.binaryMode` before `POST` (the public API rejects it —
     "settings must NOT have additional properties"); and `active:true` is ignored on create.

### 5. Validate + activate
- `validate_workflow` (LONG nodeType form) on all three, then eyeball `connections`.
- Activate **error-alert first** (make the handler live), then `onchain-snapshotter` (hourly) and
  `onchain-verify` (daily) via the activate call. **Do not touch the 20+ other tenant workflows.**

### 6. Smoke test (proves the whole path)
- Run `onchain-snapshotter` once manually → rows land in `onchain.snapshots` across **all three
  sources** (platform-explorer, zechub, blockchair), zero orphans; confirm the two-clock split
  (append `DO NOTHING` vs supply `DO UPDATE`).
- Force a node failure → a Telegram alert reaches chat `207209924` via the prod bot (proves the
  errorWorkflow repoint + credential + `/start` reachability). No alert → re-check those three.

### 7. Record + back up
- Record the move (date, hosts, verify result, row counts) in the install log — nothing silently (§6).
- Backup from **day 1** (§8.6): `pg_dump -Fc --schema=onchain onchain_intel` on a schedule → off-site
  (R2/B2/minio), generational retention.

## Alternative — transfer dev history (Path A, instead of §1–§2)
Only if you want the dev rows in prod. **Don't** hand-run `001`/`002` (they collide with the dump):
after bootstrap, `DROP SCHEMA IF EXISTS onchain CASCADE` (empty), then
`pg_dump -Fc --schema=onchain -d postgres` (dev) → `pg_restore --no-owner -d onchain_intel`
**connected as `onchain_app`** (dump embodies 001+002 + seeds + history). Re-run the ownership check.
**Tail reconciliation** respects the two conflict semantics: append rows (platform-explorer,
blockchair) docatch `ON CONFLICT DO NOTHING`; the two `zec_*_supply` aggregates are revisable →
docatch `ON CONFLICT DO UPDATE` (a blanket `DO NOTHING` silently keeps a **stale** supply), or note
they self-heal because prod re-reads ZecHub each hour and upserts.

## import.sh (optional automation)
For a one-time 3-workflow deploy the UI path in §4 is simplest. To automate/repeat, mirror
`export.sh` but add a relink pass: `POST /api/v1/workflows` each `exported/*.json` **after** rewriting
node `credentials.id` (by name → new prod ids) and `settings.errorWorkflow` (→ new error-alert id),
stripping `settings.binaryMode`; then `POST /workflows/{id}/activate`. Ref
`czlonkowski/n8n-lazy-loading scripts/import_with_relink.py`. Prod `N8N_URL`/API key from env — never
the dev `.mcp.json`.
