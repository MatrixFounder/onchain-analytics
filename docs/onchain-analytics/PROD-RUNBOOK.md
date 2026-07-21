# PROD-RUNBOOK — deploy the snapshotter to a prod instance

- **Status:** Deployed 2026-07-21 (prod = **Supabase**, DB applied via the SQL editor). Operationalizes
  [DB-SCHEMA-CONCEPT §8.5/§8.6](DB-SCHEMA-CONCEPT.md). Two DB profiles below: **A — Supabase** (what
  dev *and* prod actually use) and **B — dedicated standalone Postgres** (future; the only one that
  uses `00_bootstrap.sql`).
- **Scope:** stand up schema `onchain` + the 3 workflows on a prod instance where n8n + Postgres
  already run. Fresh start (no history) unless you take the *Alternative*. `ssh`/`vm-deploy`
  conventions; additive-only; destructive ops confirmed. **Instance ids are not pinned in this doc —
  reference credentials/workflows by name and remap by name (they drift per instance).**

## What exists (dev, source of truth)
- **DB:** schema `onchain` (`assets`/`metrics`/`snapshots`) via `001_init.sql` **then**
  `002_zec_block_height.sql`. Registry = **2 assets / 11 metrics**. Sources: `platform-explorer`,
  `zechub`, `blockchair`.
- **Workflows:** `onchain-snapshotter` (hourly, **two-clock**: `Write snapshots` append
  `ON CONFLICT DO NOTHING` for dash 8 metrics + `zec_block_height`; `Upsert zec supply`
  `ON CONFLICT DO UPDATE` for the daily `zec_*_supply` keyed on the ZecHub `close` date; keyless
  `Zcash tip` = blockchair `/zcash/stats` feeds the height clock) · `onchain-verify` (daily) ·
  `onchain-error-alert` (on error).
- **ChatID is a param, not a literal:** both Telegram nodes read the target from a `ChatID` field in a
  Set node — error-alert's `Normalize Input` and verify's dedicated `Set Parameters` each set
  `ChatID = 207209924`; the Telegram nodes reference `{{ $('…').json.ChatID }}`. Retarget alerts by
  editing the **Set node**, never the Telegram node.
- **Credentials** (in n8n, never git): **"Supabase DB"** (postgres), **"Onchain bot"** (telegram).

## Database — Profile A: Supabase via the SQL editor  *(what dev + prod use)*
Supabase reuses its own `postgres` superuser + db `postgres`; **`00_bootstrap.sql` is SKIPPED** —
schema `onchain` is created by `001` itself. No prereqs (the editor authenticates as `postgres`;
Supabase PG15 already satisfies the PG≥13 `gen_random_uuid()` requirement → no `pgcrypto`).

1. In the Supabase **SQL editor**: paste `001_init.sql`, Run; then `002_zec_block_height.sql`, Run —
   **in that order** (`002` only `SET search_path` and needs `001`'s `onchain.metrics`).
2. **Before pasting each file, delete the leading `\set ON_ERROR_STOP on` line** — it's a psql
   meta-command and a UI SQL editor errors on the backslash. (CLI alternative: pipe over stdin per
   `vm-deploy` — `docker exec -i … psql …` — which keeps `\set`.)
3. The editor runs as `postgres` (the object owner). **If the n8n "Supabase DB" cred also connects as
   `postgres`, no GRANT is needed.** If it connects as a *different* role, grant that role:
   ```sql
   GRANT USAGE ON SCHEMA onchain TO <role>;
   GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA onchain TO <role>;
   ALTER DEFAULT PRIVILEGES IN SCHEMA onchain GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO <role>;
   ```

**Verify gate** (as the connecting role): `SET search_path TO onchain;` → `assets=2 · metrics=11 ·
orphans=0`. (Achieved on prod 2026-07-21.)

## Database — Profile B: dedicated standalone Postgres  *(future)*
Here `00_bootstrap.sql` **is** used (role `onchain_app`, db `onchain_intel`, schema `onchain`, lock
`public`). **Prereqs (this profile only):** confirm PG≥13 (else the superuser must
`CREATE EXTENSION IF NOT EXISTS pgcrypto` in `onchain_intel` before `001`); stage `ONCHAIN_APP_PASSWORD`
(psql var consumed by bootstrap) **and** `PGPASSWORD`/`~/.pgpass` for `onchain_app` (the migration URI
carries no password). Apply over stdin (`vm-deploy`; never `-f` a path in-container): bootstrap as
**superuser** → `001` → `002` as `onchain_app`, numeric order. **Ownership check:** every object in
`onchain` owned by `onchain_app` (`SELECT count(*) FROM pg_tables WHERE schemaname='onchain' AND
tableowner<>'onchain_app'` → 0); if any DDL ran as admin, `REASSIGN OWNED BY <admin> TO onchain_app` +
`GRANT`.

## Credentials (create in prod n8n first — secrets never in JSON)
- **"Supabase DB"** (postgres) → **prod** host / db / schema `onchain`. ⚠️ the host lives *inside* the
  credential — cloning the dev cred silently writes to dev. Use the role that owns the schema
  (Profile A: `postgres` → no grant). Name it exactly `Supabase DB`.
- **"Onchain bot"** (telegram) → reuse the dev bot token (chat `207209924` already `/start`-ed it →
  works immediately) or a new bot (the target user/chat must `/start` it first, else every send `403`s
  **silently**). The alert chat is the **`ChatID` param** in the Set node — change it there, not the
  Telegram node.
- No other credential: `Zcash tip` is keyless; the Set nodes add none.

## Import workflows (order is load-bearing — errorWorkflow chicken-and-egg)
Exported JSON carries **source-instance ids** a fresh instance can't resolve (`export.sh` strips the
top-level id but **not** node `credentials.id` nor `settings.errorWorkflow`). Remap **by name**:

| Dangling ref (by name) | remap to |
|---|---|
| PG cred **"Supabase DB"** — snapshotter `Write snapshots` + `Upsert zec supply`, verify `Verify query` | new prod PG cred |
| TG cred **"Onchain bot"** — verify `Report`, error-alert `Telegram alert` | new prod TG cred |
| `settings.errorWorkflow` — snapshotter + verify | **new** `onchain-error-alert` |

1. Import **`onchain-error-alert` FIRST** (it's the errorWorkflow target the others reference) → set
   its `Telegram alert` credential → note its new id.
2. Import `onchain-snapshotter` + `onchain-verify` → re-select every PG/TG credential node (dangling
   ones show "credential not found").
3. Set *Settings → Error Workflow* = the new `onchain-error-alert` in **both**. Confirm no node shows
   "credential not found" and neither still points at the old error-alert.
   - *API-create caveat:* strip `settings.binaryMode` before `POST` (public API rejects it); `active:true`
     is ignored on create.

### Re-import (updating an already-deployed workflow) — hard-won
Import does **not** overwrite — n8n mints a **new** same-name workflow (you now have two), and the
JSON's source ids **re-dangle**. After **any** re-import: (1) **dedup** — keep exactly one *active*
workflow per name, archive/delete the stale copy (two active same-name breaks `export.sh` and may bind
the wrong `errorWorkflow`/executions); (2) **re-remap** every PG/TG credential + `errorWorkflow` by
name (this table again). The Set-node `ChatID` is a plain param, not an id → it survives import.

## Validate → activate → smoke test
- `validate_workflow` (LONG nodeType form) on all three, then eyeball `connections`.
- Activate **error-alert first** (make the handler live), then `onchain-snapshotter` (hourly) +
  `onchain-verify` (daily). Don't touch the other tenant workflows.
- Run the snapshotter once manually → rows across **all three sources**, zero orphans (prod: **11
  rows, `with_height=9`**) → force a node failure → a Telegram alert reaches the target chat via the
  prod bot (proves the errorWorkflow repoint + credential + `/start` reachability).

## Close-out
- Record the move (date, hosts, verify `2/11/0`) — nothing silently (§6).
- Backup from **day 1** (§8.6): `pg_dump -Fc --schema=onchain` on a schedule → off-site (R2/B2/minio).

## Alternative — transfer dev history (instead of a fresh start)
Only if you want the dev rows in prod. **Don't** hand-run `001`/`002` (they collide with the dump):
after bootstrap (Profile B) or on a fresh Supabase schema, `pg_dump -Fc --schema=onchain` (dev) →
`pg_restore --no-owner` **connected as the owning role** (dump embodies 001+002 + seeds + history).
**Tail reconciliation** respects the two conflict semantics: append rows (platform-explorer,
blockchair) docatch `ON CONFLICT DO NOTHING`; the two `zec_*_supply` aggregates are revisable → docatch
`ON CONFLICT DO UPDATE` (a blanket `DO NOTHING` silently keeps a **stale** supply), or note they
self-heal because prod re-reads ZecHub hourly and upserts.

## import.sh (optional automation)
For a one-time deploy the UI path above is simplest. To automate, mirror `export.sh` + a relink pass:
`POST /api/v1/workflows` each `exported/*.json` after rewriting node `credentials.id` (by name → new
prod ids) and `settings.errorWorkflow` (→ new error-alert id), stripping `settings.binaryMode`; then
`POST /workflows/{id}/activate`. It **must inherit `export.sh`'s discipline** (since `e3a8817`): skip
archived copies and refuse to deploy when two workflows share a name. Ref
`czlonkowski/n8n-lazy-loading scripts/import_with_relink.py`. Prod `N8N_URL`/API key from env — never
the dev `.mcp.json`.
