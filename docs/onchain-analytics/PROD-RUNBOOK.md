# PROD-RUNBOOK — deploy the snapshotter to a prod instance

- **Scope:** stand up schema `onchain` + the 3 workflows on an instance where n8n + Postgres already
  run. Fresh start (no history) unless you take the *Alternative* at the end. Operationalizes
  [DB-SCHEMA-CONCEPT §8.5/§8.6](DB-SCHEMA-CONCEPT.md). `ssh`/`vm-deploy` conventions; additive-only;
  destructive ops confirmed.
- **Instance ids are not pinned in this doc** — reference credentials and workflows **by name** and
  remap by name; ids drift per instance.
- Two DB profiles: **A — Supabase** (what dev and prod use) and **B — dedicated standalone Postgres**
  (the only one that uses `00_bootstrap.sql`).

## What you are deploying

- **DB:** schema `onchain` (`assets` / `metrics` / `snapshots`) from a single
  [`001_init.sql`](../../sql/migrations/001_init.sql). Registry = **2 assets / 11 metrics**, each
  metric carrying `max_staleness_ms` — the age at which `onchain-verify` calls it stale, judged on
  that metric's own clock. Sources: `platform-explorer`, `zechub`, `blockchair`, `derived`.
- **Workflows:**
  - **`onchain-snapshotter`** (hourly) — **two clocks** (DB-SCHEMA §1/§8): the 8 dash-platform
    metrics and `zec_block_height` are immutable hourly observations appended with
    `ON CONFLICT DO NOTHING`; the two `zec_*_supply` values are a **daily** aggregate keyed on the
    ZecHub `close` date and revised in place with `ON CONFLICT DO UPDATE` (a blanket `DO NOTHING`
    there would pin a stale supply). Ends in **`Check dropped`**, which fails the run by name if a
    source omitted a field that has no exact fallback.
  - **`onchain-verify`** (daily 08:07 UTC) — health report to Telegram. Every check names the
    metrics it is complaining about.
  - **`onchain-error-alert`** — Error Trigger; the `errorWorkflow` target of the other two.
- **Credentials** (in n8n, never in git): **"Supabase DB"** (postgres), **"Onchain bot"** (telegram).

### Self-healing: `shielded_pool_balance_credits`
platform-explorer sometimes stops returning the `poolBalance` field. When it does, `Normalize`
derives the value exactly as `totalShieldedIn − totalShieldedOut` (BigInt — credits are exact
integers and must never pass through a JS number) and writes it under **`source='derived'`** with the
formula and both inputs in `raw_json`. If the inputs cannot support an exact derivation it refuses
and the run fails instead of inventing a number.

The series therefore has no gap, but the substitution is **not** silent: `onchain-verify` names every
derived metric daily and counts it against the report's OK state. A ⚠️ report reading
`🧮 derived — vendor field missing, value computed: …` is the **expected** steady state while the
vendor stays quiet — it clears when the field returns or the metric is retired.

## Database — Profile A: Supabase via the SQL editor  *(what dev + prod use)*
Supabase reuses its own `postgres` superuser + db `postgres`; **`00_bootstrap.sql` is SKIPPED** —
schema `onchain` is created by `001` itself. No prereqs (the editor authenticates as `postgres`;
Supabase PG15 satisfies the PG≥13 `gen_random_uuid()` requirement → no `pgcrypto`).

1. Paste [`sql/migrations/001_init.sql`](../../sql/migrations/001_init.sql) into the **SQL editor**
   and Run. It contains no psql backslash meta-commands, so it needs no editing first.
2. The editor runs as `postgres` (the object owner). **If the n8n "Supabase DB" credential also
   connects as `postgres`, no GRANT is needed.** If it connects as a *different* role, grant it:
   ```sql
   GRANT USAGE ON SCHEMA onchain TO <role>;
   GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA onchain TO <role>;
   ALTER DEFAULT PRIVILEGES IN SCHEMA onchain GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO <role>;
   ```

**Verify gate** (as the connecting role):
```sql
SELECT (SELECT count(*) FROM onchain.assets)                                   AS assets,      -- 2
       (SELECT count(*) FROM onchain.metrics)                                  AS metrics,     -- 11
       (SELECT count(*) FROM onchain.metrics WHERE max_staleness_ms IS NULL)   AS unbounded,   -- 0
       (SELECT count(*) FROM onchain.snapshots s
          LEFT JOIN onchain.assets  a ON s.asset  = a.id
          LEFT JOIN onchain.metrics m ON s.metric = m.id
         WHERE a.id IS NULL OR m.id IS NULL)                                   AS orphans;     -- 0
```
`unbounded` must be 0: a metric with no cadence is one `onchain-verify` cannot monitor.

## Database — Profile B: dedicated standalone Postgres  *(future)*
Here `00_bootstrap.sql` **is** used (role `onchain_app`, db `onchain_intel`, schema `onchain`, lock
`public`). **Prereqs (this profile only):** confirm PG≥13 (else the superuser must
`CREATE EXTENSION IF NOT EXISTS pgcrypto` in `onchain_intel` before `001`); stage
`ONCHAIN_APP_PASSWORD` (psql var consumed by bootstrap) **and** `PGPASSWORD`/`~/.pgpass` for
`onchain_app` (the migration URI carries no password). Apply over stdin (`vm-deploy`; never `-f` a
path in-container): bootstrap as **superuser**, then `001` as `onchain_app`. **Ownership check:**
every object in `onchain` owned by `onchain_app` (`SELECT count(*) FROM pg_tables WHERE
schemaname='onchain' AND tableowner<>'onchain_app'` → 0); if any DDL ran as admin,
`REASSIGN OWNED BY <admin> TO onchain_app` + `GRANT`.

## Credentials (create in prod n8n first — secrets never in JSON)
- **"Supabase DB"** (postgres) → **prod** host / db / schema `onchain`. ⚠️ the host lives *inside*
  the credential — cloning the dev credential silently writes to dev. Use the role that owns the
  schema (Profile A: `postgres` → no grant). Name it exactly `Supabase DB`.
- **"Onchain bot"** (telegram) → reuse an existing bot token, or a new bot. Either way **the target
  chat must `/start` the bot first**, else every send `403`s **silently**.
- No other credential: `Zcash tip` is keyless; the Set nodes add none.

### Alert target — `ChatID` is scrubbed on export
A Telegram chat id identifies a real person. It is not a *secret* (so it stays a plain node param
rather than moving into Credentials — see the secrets rule in `CLAUDE.n8n.md`), but it has no place
in a git repo. `export.sh` rewrites every `ChatID` assignment to **`0`** as it writes the JSON.
Scrubbing at export is the only version that holds: `export.sh` re-reads the live instance, so
editing the JSON by hand would be undone by the next export.

Supply the instance's own target at import:
```bash
CHAT_ID=<this instance's chat id> …  ./n8n-workflows/import.sh
```
Omit it and the import warns and lands `ChatID=0`, so the first Telegram send fails **loudly** —
deliberately, because the alternative default (carrying whatever chat the exporting environment used)
means prod alerts quietly arriving in someone else's chat, a misroute nothing reports.

## Import workflows (order is load-bearing — errorWorkflow chicken-and-egg)
Exported JSON carries **source-instance ids** a fresh instance cannot resolve (`export.sh` strips the
top-level id but **not** node `credentials.id` nor `settings.errorWorkflow`). Remap **by name**:

| Dangling ref (by name) | remap to |
|---|---|
| PG cred **"Supabase DB"** — snapshotter `Write snapshots` + `Upsert zec supply`, verify `Verify query` | new prod PG cred |
| PG cred **"Onchain engine state"** — retention's seven nodes, and `Write delivery` in verify + error-alert (WI-64) | new prod engine-state PG cred |
| TG cred **"Onchain bot"** — verify `Report`, error-alert `Telegram alert` | new prod TG cred |
| `settings.errorWorkflow` — snapshotter + verify + retention | **new** `onchain-error-alert` |
| `ChatID` param — verify `Set Parameters`, error-alert `Normalize Input` | this instance's chat (arrives as `0`) |

**Preferred — `./n8n-workflows/import.sh`** (wrapper over `import_with_relink.py`). Idempotent: a
same-name workflow already on the target is **UPDATED in place** (PUT by id), never duplicated. It
imports `onchain-error-alert` first, relinks credentials by name, points `settings.errorWorkflow` at
the new error-alert, fills `ChatID` from `CHAT_ID`, and strips `settings.binaryMode` (the public API
rejects it).

```bash
DRY_RUN=1 \
N8N_URL=… N8N_API_KEY=… \
PROD_PG_CRED_ID=<"Supabase DB" id> PROD_TG_CRED_ID=<"Onchain bot" id> \
PROD_ENGINE_CRED_ID=<"Onchain engine state" id> \
CHAT_ID=<chat id> \
./n8n-workflows/import.sh
```
Run `DRY_RUN=1` first and read the plan; then the same command without it. Credential ids come from
the n8n UI (Credentials → open → id in the URL); the public API has no list-credentials endpoint.

All three ids are **required**, and a credential name outside that map makes the importer **exit
rather than import** (WI-64). It used to warn and continue, which produced a workflow carrying the
source instance's credential id — one that looks installed and fails at the first node that needs it.

*Dual-stack / `.local` hosts:* Python may resolve to IPv6 and get a proxy `503` where curl (IPv4)
works — point `N8N_URL` at the resolvable IPv4 if so.

### By hand in the UI, if you prefer
Open the **existing** workflow → its menu → *Import from File* → Save. That replaces nodes in place
and keeps the id. **"Import from File" from the workflow *list* creates a NEW same-name workflow** —
two active workflows with one name break `export.sh` and can bind the wrong `errorWorkflow`. Then set
by hand everything the script would have done: **all three** credentials, `Settings → Error Workflow`,
and the two `ChatID` params (they arrive as `0`).

### Take a rollback snapshot first
Importing overwrites nodes wholesale, so capture the target's current state before you do:
```bash
OUT_DIR=/tmp/prod-before N8N_URL=<prod> N8N_API_KEY=<prod-key> ./n8n-workflows/export.sh
```
`OUT_DIR` is required here — without it the export would overwrite the repo's own tracked JSON with
the target's current workflows.

## Validate → activate → smoke test
- `validate_workflow` (LONG nodeType form) on all three, then eyeball `connections` — validation
  passing means well-formed JSON, not correct wiring.
- Activate **error-alert first** (make the handler live), then `onchain-snapshotter` (hourly) +
  `onchain-verify` (daily). Don't touch other tenants' workflows.
- **Snapshotter:** let one hourly run land (or run it once manually) → rows across all three sources,
  zero orphans. Note that a *successful* run leaves **no execution record** —
  `saveDataSuccessExecution` is `none` while errors are saved in full. Success is therefore proven by
  *no new error execution* plus the rows being present:
  ```sql
  SELECT to_char(to_timestamp(ts_bucket/1000) AT TIME ZONE 'UTC','MM-DD HH24:MI') AS bucket,
         source, value_raw,
         round((created_at - ts_bucket)/60000.0, 1)                                AS lag_min
    FROM onchain.snapshots
   WHERE metric = 'shielded_pool_balance_credits'
   ORDER BY ts_bucket DESC LIMIT 3;
  ```
  A row written by the snapshotter has `lag_min` under ~1; anything larger came from a maintenance
  script, not from a live run.
- **Verify + Telegram:** run `onchain-verify` manually. The message that arrives proves three things
  at once — the TG credential is bound, `ChatID` is not `0`, and the text renders. Failure modes read
  directly: `400 can't parse entities` → `parse_mode` did not survive import; `chat not found` →
  `ChatID` is still `0`; `credential not found` → credential not re-picked.
- **Error path:** an Error Trigger cannot be executed manually, so it is only exercised by a real
  failure. At minimum confirm `ChatID` in `onchain-error-alert` → `Normalize Input` is not `0` —
  otherwise it stays silent exactly when it is needed. To exercise it properly, create a throwaway
  `onchain-probe-*` workflow whose `settings.errorWorkflow` points at `onchain-error-alert` and whose
  one node fails on purpose (an HTTP request to `http://127.0.0.1:9/` refuses instantly), **activate
  it and run it in PRODUCTION mode** — n8n does not invoke `errorWorkflow` for a manual execution, so
  a manual run proves nothing — then delete it. Measured 2026-08-24 (WI-64).
- **Alert-channel heartbeat (WI-64):** every confirmed Telegram delivery writes one row, so after the
  two steps above there must be two:
  ```sql
  SELECT to_char(to_timestamp(ts/1000) AT TIME ZONE 'UTC','MM-DD HH24:MI:SS') AS ts_utc, detail_json
    FROM onchain.diagnostics WHERE event = 'alert.delivered' ORDER BY ts DESC LIMIT 5;
  ```
  No rows after a message visibly arrived means `Write delivery` did not run — check that the
  **Onchain engine state** credential was re-picked, and that `Report`/`Telegram alert` is CHAINED to
  `Record delivery` rather than fanned out beside it. From the next day on, `onchain-verify`'s report
  carries the age itself (`📡 alert channel: …`), and `📵` is the alarm.

## Engine network profile — the two database roles  *(T-014, §10.4.2 steps 1–2)*

Before the migration, not after. The migration carries the grants of §10.5.1, and a `GRANT` names its
grantee — a role that does not exist yet aborts the whole file under `ON_ERROR_STOP=1`, **after** the
tables are created, leaving a half-applied schema to clean up by hand.

**Split the creation from the password.** The grant needs the role to EXIST; it does not need the
role to be able to log in. So the half with no secret in it can be done by anyone, scripted, and
reviewed — and the half that carries a secret stays with the person who chooses it.

```sql
-- no secret: safe to script, safe to paste in a review, safe for an agent to run
CREATE ROLE onchain_engine_state NOLOGIN;
CREATE ROLE onchain_engine_read  NOLOGIN;
```

```sql
-- the operator, and only the operator. The password reaches no transcript and no file.
ALTER ROLE onchain_engine_state LOGIN PASSWORD '<chosen by you>';
ALTER ROLE onchain_engine_read  LOGIN PASSWORD '<chosen by you>';
```

⚠️ A role left `NOLOGIN` is inert but not harmless bookkeeping: it will pass the migration and then
fail every connection with a message about authentication rather than about the missing step. Do the
second block in the same sitting.

**Neither name is fixed by the documents.** `deployment.md` §10.5.1 spells `onchain_engine_state`
only as a suggestion, and the read role's name is installation-local. Both arrive at the migration as
`psql` parameters, so a host that already holds a role of that name takes different values and the
same file.

**Do not point `READ_ROLE` at a stock Supabase role.** Measured on the dev VM 2026-08-22:
`supabase_read_only_user` is a member of `pg_read_all_data`, so it already reads every table in the
cluster and would gain the twelve engine tables for free — see
[SEC-2](../issues/sec-2-a-stock-supabase-role-holds-pg-read-all-data-so-the-engine-tables-are-readable-by-it.md).
A dedicated read role is what makes the grant list mean anything.

Then apply the migration, piping over stdin per the `vm-deploy` skill:

```bash
ssh vm 'docker exec -i supabase-db psql -qU supabase_admin -d postgres -v ON_ERROR_STOP=1 \
  -v STATE_ROLE=onchain_engine_state -v READ_ROLE=onchain_engine_read' \
  < sql/migrations/002_t014_network_profile.sql
```

**Postconditions, all four checked by the migration itself** (dev VM, 2026-08-22): 0 objects created
in `public`; the seeded foreign-key target present; zero orphans on all eight tables carrying
`REFERENCES`; and the state role reaching **none** of `assets`, `metrics`, `snapshots`.

**Then run step 2a's own measurement**, which the migration does not do for you:

```sql
SELECT t.table_name,
       has_table_privilege('onchain_engine_read', 'onchain.'||t.table_name,'SELECT')  AS engine_read,
       has_table_privilege('onchain_engine_state','onchain.'||t.table_name,'SELECT')  AS engine_state
  FROM information_schema.tables t WHERE t.table_schema='onchain' ORDER BY 1;
```

Expected, and measured on the dev VM: `engine_read` true for exactly `assets`, `metrics`,
`snapshots`; `engine_state` true for exactly the other twelve; no row true in both columns.

**Why `has_table_privilege` and not `information_schema.role_table_grants`.** The catalogue view is
blind to a grant to `PUBLIC`, to a privilege inherited through a group role, and to any grant whose
roles are not enabled in the session. SEC-2 is an instance of the second: the privilege appears in no
table ACL and is real.

## Engine dedicated Postgres container — dev VM  *(T-015 task 015-20, §10.9.1, R-8.1/R-8.10, AC-16)*

Separate from `## Database — Profile B` above: that section is the SNAPSHOTTER's database. This one
is the engine's own state, which task 015-27 will make the only copy of `api_tokens.token_hash`,
`access_profiles.credits_balance_raw` and the billing ledger.

**Provisioned 2026-08-28 on the dev VM.** Actual values of the run, not a plan:

| Element         | Value                                                        |
| :-------------- | :----------------------------------------------------------- |
| Container       | `onchain-engine-db`                                          |
| Image           | `postgres:16-alpine` — server reports PostgreSQL 16.13        |
| Published port  | `5433` on the VM host (Supabase keeps `5432`)                |
| Named volume    | `onchain-engine-pgdata` → `/var/lib/postgresql/data`         |
| `PGDATA`        | `/var/lib/postgresql/data/pgdata`                            |
| Restart policy  | `unless-stopped`                                             |
| Superuser       | `postgres`, password from `/home/parallels/.onchain-engine-pg.env` (mode 0600, VM-local) |

The password was generated ON the VM and never entered this repository, a terminal transcript, or a
container image layer; the file is passed to `docker run` as `--env-file`. Regenerating it means
recreating the container against the same named volume.

```bash
docker volume create onchain-engine-pgdata
docker run -d --name onchain-engine-db --restart unless-stopped \
  --env-file /home/parallels/.onchain-engine-pg.env \
  -e PGDATA=/var/lib/postgresql/data/pgdata \
  -v onchain-engine-pgdata:/var/lib/postgresql/data \
  -p 5433:5432 postgres:16-alpine
```

**Postconditions measured 2026-08-28, all six.**

| Check     | Command                                                     | Result                                                     |
| :-------- | :---------------------------------------------------------- | :--------------------------------------------------------- |
| TC-OPS-01 | `docker ps`                                                 | `onchain-engine-db` on `5433`, `supabase-db` on `5432`     |
| TC-OPS-02 | `pg_isready -h 10.211.55.3 -p 5432` and `-p 5433`           | both `accepting connections`                                |
| TC-OPS-03 | image tag of the new row                                    | `postgres:16-alpine` — no Supabase stack name in the tag   |
| TC-OPS-04 | `docker inspect supabase-db` id and `StartedAt`, before/after | `af7c4bab1297…`, `2026-08-28T12:58:54.345261211Z` — equal |
| TC-OPS-05 | row counts of `assets`, `metrics`, `snapshots`, before/after | `2 / 11 / 5281` — equal                                    |
| TC-OPS-06 | `docker restart`, then port and row count                   | port answers; probe table kept 7 of 7 rows                 |

`pg_isready` is not installed on the VM host, so both port checks are run from INSIDE a container
against the host address `10.211.55.3`. Checking `127.0.0.1` inside the new container would have
proven only that the server is up, not that the published port is reachable — which is the property
`ONCHAIN_STATE_PG_URL` will depend on.

**No regular backup of this container is provisioned by this task.** Until one exists, the move
leaves a single copy of the money data. The obligation is recorded in `docs/PLAN.md`.

### The migration — thirteen tables, the state role, grants  *(task 015-21, §10.9.2/§10.9.3, UC-6 step 2)*

**The state role, split the same way `## Engine network profile — the two database roles` above
splits it — no secret in the first half:**

```sql
-- no secret: safe to script, safe to paste in a review
CREATE ROLE onchain_engine_state NOLOGIN;
```

```bash
# the password, generated ON the VM and never entered this repository, a terminal transcript, or a
# container image layer — the second half of PROD-RUNBOOK.md:201's split
ssh vm 'bash -s' <<'REMOTE'
PW=$(openssl rand -base64 32 | tr -d '\n')
umask 177
printf 'POSTGRES_STATE_PASSWORD=%s\n' "$PW" > /home/parallels/.onchain-engine-state-pg.env
chmod 0600 /home/parallels/.onchain-engine-state-pg.env
docker exec -i onchain-engine-db psql -qU postgres -d postgres -v ON_ERROR_STOP=1 <<SQL
ALTER ROLE onchain_engine_state LOGIN PASSWORD '$PW';
SQL
REMOTE
```

Role name: **`onchain_engine_state`** — the same name already occupied on `supabase-db`, per
task-015-21's own precondition that the two must match. Password file: VM-local,
`/home/parallels/.onchain-engine-state-pg.env`, mode 0600, alongside the container superuser's own
`.onchain-engine-pg.env` from the section above.

**Applied 2026-08-28**, over stdin per the `vm-deploy` skill (never `-f /tmp/…`):

```bash
ssh vm 'docker exec -i onchain-engine-db psql -qU postgres -d postgres -v ON_ERROR_STOP=1 \
  -v STATE_ROLE=onchain_engine_state' < sql/migrations/005_wi62_dedicated_container.sql
```

**Verify-block output, this run, verbatim:**

```
── verify 1/4: the thirteen engine tables exist in onchain, nothing in public ──
 engine_tables_present | expected
-----------------------+----------
                    13 |       13
(1 row)

 objects_created_in_public
---------------------------
                         0
(1 row)

── verify 2/4: may_select under the state role, true for exactly the thirteen ──
    table_name    | may_select
------------------+------------
 access_audit     | t
 access_profiles  | t
 api_tokens       | t
 cache_entries    | t
 client_usage     | t
 diagnostics      | t
 provider_buckets | t
 providers        | t
 request_trace    | t
 retention_runs   | t
 usage            | t
 usage_window     | t
 users            | t
(13 rows)

── verify 3/4: the roles that exist on this container — measured, not assumed (R-8.6) ──
       rolname        | rolsuper | rolcanlogin
----------------------+----------+-------------
 onchain_engine_state | f        | t
 postgres             | t        | t
(2 rows)

── verify 4/4: has_table_privilege per application role x per engine table (AC-17b) ──
       rolname        |    table_name    | may_select
----------------------+------------------+------------
 onchain_engine_state | access_audit     | t
 onchain_engine_state | access_profiles  | t
 onchain_engine_state | api_tokens       | t
 onchain_engine_state | cache_entries    | t
 onchain_engine_state | client_usage     | t
 onchain_engine_state | diagnostics      | t
 onchain_engine_state | provider_buckets | t
 onchain_engine_state | providers        | t
 onchain_engine_state | request_trace    | t
 onchain_engine_state | retention_runs   | t
 onchain_engine_state | usage            | t
 onchain_engine_state | usage_window     | t
 onchain_engine_state | users            | t
(13 rows)
```

**Roles measured on this container after the migration: two, exactly as §10.9.2 predicts.**
`postgres` is the image's own superuser (`rolsuper=t`) — excluded from the AC-17b postcondition, the
same exclusion §10.4.2 already makes for `authenticator`. `onchain_engine_state` is the one
application role (`rolsuper=f`, `rolcanlogin=t`). No third role exists to measure.

**Row counts after the migration:** all thirteen tables are empty except `access_profiles`, which
carries the one seeded `phase0-unlimited` row — TC-OPS-04's own expected result, and the row-transfer
of task 015-23 has not run yet.

**TC-OPS-08 (re-apply) and TC-OPS-09 (004 after 005), both run this session.** Re-applying
`005_wi62_dedicated_container.sql` a second time reproduced the verify-block output above
byte-for-byte — only `NOTICE: … already exists, skipping` lines were added, one per object. Applying
`004_t015_billing.sql` afterward, with the same `-v STATE_ROLE=onchain_engine_state`, changed
nothing: not `onchain.usage`'s column list, not `onchain.client_usage`'s column list, not
`onchain.access_profiles`'s constraint list — all measured before and after via `pg_constraint`. The
guarded `ALTER TABLE … ADD CONSTRAINT` blocks in 004 found `usage_calls_made_non_negative` and
`client_usage_balance_is_integer` already registered under those exact names, and skipped both. That
is the property TC-OPS-09 exists to prove, and the reason the two names were kept identical between
files 004 and 005.

**Two things measured this session that the task's own text did not anticipate, recorded here rather
than silently worked around:**

- **TC-OPS-12's literal input exercises a different, pre-existing constraint, not the new one.**
  `UPDATE onchain.access_profiles SET credits_balance_raw = 'NaN' WHERE name = 'phase0-unlimited'` is
  refused — but by `access_profiles_check` (the unnamed `(credits_mode = 'metered') = (credits_balance_raw
  IS NOT NULL)` tie already shipped in file 002), not by the new `client_usage_balance_is_integer`
  guard. `phase0-unlimited` is `credits_mode='unlimited'`, which requires `credits_balance_raw IS
  NULL` — so ANY non-null value on that one seeded row trips the mode tie before the format check is
  ever reached in a way visible to the caller. Verified separately, in a rolled-back probe insert
  against a `credits_mode='metered'` row: `client_usage_balance_is_integer` does refuse `'NaN'` on its
  own. The migration's guard is correct; the task's test-case input names the wrong row to observe it
  in isolation.
- **`\quit 1`'s exit code is not observed on either psql client this project targets.** psql's
  `\quit`/`\q` gained an exit-status argument only in PostgreSQL 17. `supabase-db` ships psql 15.8;
  `onchain-engine-db` ships psql 16.13 — both measured this session. On both, `\quit 1` prints
  `\quit: extra argument "1" ignored` and the process still exits `0`. This is the SAME pre-check
  pattern task-015-21 directs this file to copy from `002_t014_network_profile.sql`, so it is not new
  to this file. TC-OPS-07's substantive property still holds: the script halts before `BEGIN;` and no
  DDL runs. But an operator or CI step gating on `$?` after a missing-`STATE_ROLE` run would see
  success, not the failure the comment beside `\quit 1` implies.

### Row transfer — stopping every writer, then twelve tables  *(task 015-23, §10.9.4, UC-6 steps 3-4)*

**Step 3 — the window. FOUR writers, not three.** Idempotency deduplicates two writers only inside
ONE database (`DB-SCHEMA-CONCEPT` §6). Here there are two, so a row written to the old container
after the snapshot never reaches the new one. Every writer stops before the first copy command.

| Writer | Writes | How it is stopped |
| :----- | :----- | :---------------- |
| engine network profile | all eleven tables | the process is stopped |
| `onchain-verify` | `onchain.diagnostics` | workflow deactivated |
| `onchain-error-alert` | `onchain.diagnostics` | workflow deactivated |
| `onchain-retention` | `retention_runs`, `diagnostics`, `request_trace` — INSERT **and DELETE** | workflow deactivated |

All three workflows share ONE credential, `Onchain engine state` (n8n id `MjsP4aIFWZd25tik`), so
task 015-22 retargets one record and all three move together. `onchain-snapshotter` stays active: it
writes `assets`/`metrics`/`snapshots` on the old container and does not move (R-8.3).

**The postcondition is TWO measurements, both taken before the first copy.** A stopped process and a
closed connection are different events, and an n8n node's connections are transient — a zero count
alone does not forbid a write a minute later.

```bash
# 1. no state-role connection on the old container
ssh vm 'docker exec -i supabase-db psql -qtA -U supabase_admin -d postgres' <<'SQL'
SELECT count(*) FROM pg_stat_activity WHERE usename = 'onchain_engine_state';
SQL
# 2. none of the three workflows is active (the n8n MCP servers may be down; the REST API is not)
curl -s -H "X-N8N-API-KEY: $KEY" "$N8N_URL/api/v1/workflows?limit=250" \
  | python3 -c "import json,sys;[print(w['name'],w['active']) for w in json.load(sys.stdin)['data'] if w['name'].startswith('onchain-')]"
```

**Measured 2026-08-31, window open `11:55:48Z`, declared bound `+24h`:** zero connections under
`onchain_engine_state` (and none under any `onchain%` role); `onchain-error-alert`,
`onchain-verify`, `onchain-retention` inactive; `onchain-snapshotter` active; the other 38 active
workflows on the instance untouched.

**PR-9 — deactivation DOES stop an `errorWorkflow` call. Measured, both directions.**
`onchain-error-alert` runs by reference from other workflows' failures, not by its own trigger, so
the lever had never been measured. A throwaway probe settles it: a Webhook trigger (an activated
workflow's production URL, so a plain `GET` yields a **`webhook`**-mode execution, not `manual` —
`errorWorkflow` does not fire for `manual`, WI-64) into one node that fails on `http://127.0.0.1:9/`,
with `settings.errorWorkflow` pointing at `onchain-error-alert`. Create, activate, fire, read, delete.

| Run | `onchain-error-alert` | Probe execution | Handler execution | `alert.delivered` |
| :-- | :-------------------- | :-------------- | :---------------- | :---------------- |
| control | ACTIVE | `46804` `error` `webhook` | `46805` `success` | 5 → **6** |
| main | inactive | `46810` `error` `webhook` | none | 6 → **6** |

**Run the control FIRST, and never skip it.** "No new row appeared" has two explanations — the lever
worked, or the probe never reached the handler at all (a typo in `settings.errorWorkflow`, the wrong
execution mode, a node that does not actually fail). One run cannot tell them apart. The control also
sends one real Telegram message, necessarily: the delivery row is written AFTER the Telegram node
(WI-64), so a measurement of delivery cannot avoid delivering.

**Step 4 — order, and the pipeline.** Copy one table at a time, through stdin, in foreign-key order.
Never `-f /tmp/…` inside the container: that reads the container's filesystem and runs a stale copy
(skill `vm-deploy` §4). Never `--schema=onchain` as one dump: it would sweep in the three snapshotter
tables that stay (R-8.3).

```bash
ssh vm "docker exec -i supabase-db pg_dump -U supabase_admin -d postgres \
  --schema=onchain --table=onchain.<name> --data-only --format=plain --no-owner --no-acl" \
| ssh vm "docker exec -i onchain-engine-db psql -qU postgres -d postgres -v ON_ERROR_STOP=1"
```

Order: `providers` → `users` → [`access_profiles`: verify, do not copy] → `api_tokens` →
`access_audit` (see below) → `cache_entries` → `usage` → `usage_window` → `request_trace` →
`diagnostics` → `retention_runs` → `client_usage` (no source, the step is empty).
`provider_buckets` is excluded (R-8.11).

**`access_profiles` is verified, never copied.** Its single row `01JPHASE00000000000000000A` is
seeded by the DDL on BOTH sides (`002_t014_network_profile.sql:287` and
`005_wi62_dedicated_container.sql:357`), so a `COPY` would hit the primary key and, under
`ON_ERROR_STOP=1`, abort the transfer on the third table of twelve. Compare by VALUE, not by count —
a row count of `1` and `1` matches whatever the rows contain:

```bash
# same md5 on both containers = the seeds are identical
… psql -qtA … <<'SQL'
SELECT md5(string_agg(x::text, chr(10) ORDER BY x::text)) FROM onchain.access_profiles x;
SQL
```

**`access_audit` — one-shot, and the repeat branch needs the owner's word.** A plain repeat of the
pipeline is REFUSED, not doubled: the table carries `PRIMARY KEY (id)`, so the second `COPY` dies
with `duplicate key value violates unique constraint "access_audit_pkey"` and exit `3`, leaving row
count and content untouched (`COPY` is one statement — all or nothing). Measured 2026-08-31. What
the repeat branch is actually FOR is rows already sitting in the target before the copy:

```bash
{ echo "BEGIN;"; echo "TRUNCATE onchain.access_audit;"
  ssh vm "docker exec -i supabase-db pg_dump … --table=onchain.access_audit --data-only"
  echo "COMMIT;"
} | ssh vm "docker exec -i onchain-engine-db psql -qU postgres -d postgres -v ON_ERROR_STOP=1"
```

`TRUNCATE` is on skill `vm-deploy` §5's list and needs the owner's explicit confirmation every time.
The rule `access_audit_no_delete` does not block it (rules do not apply to `TRUNCATE`) and
`access_audit_no_update` is not a `TRUNCATE` trigger — checked before running it. Apply it ONLY on
the new container: on the old one these rows are the source until §10.9.7.

**What was measured after the transfer, 2026-08-31.**

| Check | Result |
| :---- | :----- |
| row counts, 13 tables, old vs new | all match; `provider_buckets` `0` by exclusion |
| `min`/`max` of each time column | identical on both sides |
| full-row content `md5`, 12 tables | identical on both sides — stronger than spot-checking ids |
| `token_hash` | same id, `length` 64, same `md5` |
| orphans, five relations | zero |
| `provider_buckets`, `client_usage` on new | table exists, zero rows |
| foreign keys are live | a bogus `user_id` is refused by `api_tokens_user_id_fkey`; the SAME row with a real one inserts — both in rolled-back transactions |

**Rows transferred: 25** — `users` 1, `api_tokens` 1, `access_audit` 2, `diagnostics` 9,
`retention_runs` 12; the other seven tables are empty on both sides. `access_profiles` 1 is present
on both by DDL and is not counted as transferred.

**Prove a negative check with a control too.** The first foreign-key probe was refused by
`api_tokens_prefix_check` (`length(prefix) >= 8`) — the row never reached the foreign key at all. A
check that fails for the wrong reason has measured nothing. The pair above — bogus id refused, real
id accepted, both rolled back — is what the assertion needs.


### The verify gate — five checks, run BEFORE anything is dropped  *(task 015-24, §10.9.4, UC-6 step 5)*

`sql/verify/wi62_verify.sql`. It runs on EACH container and only READS — a test in
`packages/core/test/pg-migration-guards.test.ts` holds that property, because this gate runs against
the old container while it is still the only copy of the data.

**Why the script lives in the repo and not on the VM.** `DB-SCHEMA-CONCEPT` §5.3 requires it: the
same gate runs at the next host move (§6). Container names are arguments of the calling command,
never text inside the file.

**Why one database does not read the other.** The containers share no role that can read across
them. The old side's report travels as a VALUE — one base64 line — not over a connection.

```bash
# 1. the OLD side: prints its numbers and one base64 line
ssh vm 'docker exec -i supabase-db psql -qX -U supabase_admin -d postgres \
  -v SIDE=old -v SAMPLE=20' < sql/verify/wi62_verify.sql

# 2. the NEW side: same script, plus the line the old side printed
ssh vm "docker exec -i onchain-engine-db psql -qX -U postgres -d postgres \
  -v SIDE=new -v SAMPLE=20 -v OLD_REPORT=$B64" < sql/verify/wi62_verify.sql
```

**The blocking rule.** Anything but `equal`/`not_applicable` in check 1; any bound mismatch in
check 2; any row printed by check 3; any non-zero in check 4; anything but `1` in check 5 — **UC-6
step 10 does not run**. The script prints this as one line: `PASS — UC-6 step 10 may proceed` or
`BLOCKED — UC-6 step 10 must NOT run`. The report names the fact; this rule is what to do with it.

**Every guard exits 3, measured 2026-08-31.** Missing `SIDE`, missing `SAMPLE`, `SIDE` that is
neither `old` nor `new`, `SIDE=new` without `OLD_REPORT`, and an `OLD_REPORT` that is itself a
new-side report — all five refuse with exit `3`; the correct invocation exits `0`. `SIDE` is checked
through `\gset` rather than inside the `DO` block: psql does not substitute `:'VAR'` inside a
dollar-quoted string, so a guard written that way would fail as an undefined parameter — for the
wrong reason, after looking correct in review.

**Measured on the live move, 2026-08-31.** Eleven applicable tables `equal`; both time bounds equal
on all ten with a time column; spot-check compared 26 rows across six non-empty tables with zero
disagreements; four orphan checks zero; `usage.calls_made` present. Verdict **PASS**.

**The gate was proven against defects, not only against clean data.** Five synthetic defects were
injected into the live new container inside transactions that were ROLLED BACK, and the real script
was run against each:

| Injected defect | What the gate said |
| :-------------- | :----------------- |
| an extra `access_audit` row | `more_on_new`, bounds `DIFFERS`, spot-check names the row `only_on_new` |
| one `diagnostics` row missing | `less_on_new`, spot-check names the missing row `only_on_old` |
| one byte changed in `token_hash` | counts and bounds still `equal` — **only** the spot-check catches it, printing both values |
| a `client_usage` row whose `principal_id` has no token | orphans `1` on `client_usage.principal_id` |
| an in-window `alert.delivered` row AND a duplicated `access_audit` row together | both `more_on_new`, told apart by table AND by bounds |

All five produced `BLOCKED`. After the runs, the container's row counts, time bounds and
`token_hash` were re-measured and matched the post-transfer snapshot exactly.

**Read the last row carefully — it is the one the gate was argued about.** A write that lands during
the move window and a duplicated row both raise `more_on_new`, and the task feared they would be
indistinguishable. They are not: a late write pushes the table's `max` bound PAST the old side's,
while a duplicate reuses an existing timestamp and leaves both bounds `equal`. The direction plus
the bounds separate the two causes before anyone reads the row's `event`.

**And the third row is why counts alone are not a gate.** A single flipped byte in `token_hash`
leaves every count and every bound identical. Without the spot-check the move would have passed
review and failed at the first authenticated request, after the old container was already dropped.


### Retargeting the `Onchain engine state` credential  *(task 015-22, §10.9, UC-6 step 6, part)*

This is the ONLY step of the move that edits live configuration rather than adding to it. It changes
where three workflows write. The rollback marker therefore goes in this file BEFORE the edit, not
after.

**The state BEFORE the edit, measured 2026-08-31 — not read from a document.**

| Field | Value |
| :---- | :---- |
| credential name / id | `Onchain engine state` / `MjsP4aIFWZd25tik` |
| host, port | `supabase-db`, `5432` |
| database, user | `postgres`, `onchain_engine_state` |
| server it reached | PostgreSQL **15.8** — the old container |
| password | not in this repo; the DSN carrying it is `.env:248` on the operator's machine |
| workflows using it | `onchain-verify`, `onchain-error-alert`, `onchain-retention` — those three and nothing else |

**AFTER the edit:** host `10.211.55.3`, port `5433`, same database and user. Nothing else changes —
the name stays, because `import_with_relink.py` maps credentials by NAME and refuses a name absent
from its map.

**The host is `10.211.55.3`, and this is not interchangeable with the name used elsewhere.** From
INSIDE the n8n container, `ubuntu-linux-2404.local` resolves to an IPv6 address that is not routable
(`connect ENETUNREACH fdb2:2c26:…`) — so the host string that works from the Mac does NOT work from
n8n. Published port `5432` on the VM is the Supabase POOLER, not `supabase-db`: it answers
`Tenant or user not found`, which is a pooler error and not a Postgres one. Three vantage points,
three different correct answers:

| From | To the old container | To the new container |
| :--- | :------------------- | :------------------- |
| the n8n container | `supabase-db:5432` (docker alias) | `10.211.55.3:5433` |
| the VM host | `docker exec -i supabase-db psql` | `docker exec -i onchain-engine-db psql` |
| the operator's Mac | `ubuntu-linux-2404.local:5432` → the pooler | `ubuntu-linux-2404.local:5433` |

**How reachability was established without ever handling the password.** A deliberately wrong
password distinguishes the two failures that matter: an unreachable host answers `Connection
refused` / `Host not found` / `ENETUNREACH`, while a reachable one carrying the role answers
`password authentication failed for user "onchain_engine_state"`. The second message is the
positive result. It proves host, port, database and role in one request, and it proves the ROLE
EXISTS on the target — all without the secret.

**The edit runs ON the VM, so the secret never leaves it.** The password lives in
`/home/parallels/.onchain-engine-state-pg.env` (mode 0600). The request body is assembled there and
sent to `localhost:5678`; the value never enters this repository, a terminal transcript on the
operator's machine, or a command line.

```bash
# the API key is piped in, so it is not visible in `ps`; the password is read on the VM
printf '%s' "$N8N_API_KEY" | ssh vm 'KEY=$(cat); PW=$(. /home/parallels/.onchain-engine-state-pg.env;   printf %s "$POSTGRES_STATE_PASSWORD");   python3 -c "
import json,os,urllib.request
body=json.dumps({"name":"Onchain engine state","type":"postgres","data":{
  "host":"10.211.55.3","port":5433,"database":"postgres",
  "user":"onchain_engine_state","password":os.environ["PW"],
  "ssl":"disable","maxConnections":10,"allowUnauthorizedCerts":False,"sshTunnel":False}}).encode()
r=urllib.request.Request("http://localhost:5678/api/v1/credentials/MjsP4aIFWZd25tik",
  data=body, method="PATCH",
  headers={"X-N8N-API-KEY":os.environ["KEY"],"Content-Type":"application/json"})
print(urllib.request.urlopen(r).status)" '
```

**`PATCH /api/v1/credentials/:id` is not in n8n's documented public API, so it was proven on a
throwaway credential first.** A disposable `postgres` credential was created, PATCHed to a host with
a distinctive name, and probed: the error came back naming the NEW host, so the write takes effect.
A `PATCH` with an empty body returns `200` and bumps `updatedAt` WITHOUT changing the data — checked
against the live credential, which kept working afterward. Do not read a `200` here as proof that
anything changed; probe.

**Verification after the edit** — a throwaway workflow with a Webhook trigger set to
`responseMode: lastNode` and one Postgres node on this credential running
`SELECT current_setting('server_version')`. The HTTP response carries the answer directly, so there
is no execution list to poll and no stale read to misinterpret. `16.13` is the new container;
`15.8` is the old one. Delete the probe afterward.


## Engine network profile — the first admin token  *(T-014; designed, not built)*

The MCP server in the **network** profile refuses to start with zero active tokens, and tokens are
issued by an admin. The first admin is therefore seeded, not issued. **You generate the token; the
database receives only its digest.** The plaintext reaches neither the repository nor any file.

1. Mint the token and derive the five parameters, on your own machine, with the pepper the server
   will run with already in the environment. The script calls the same functions the server does, so
   the token it mints is one the server parses and the digest it prints is one `lookup` finds:
   ```bash
   ONCHAIN_TOKEN_HASH_SALT='<the value from the server .env>' \
     pnpm --filter @onchain-intel/mcp-server exec tsx scripts/mint-admin-token.ts you@example.com
   ```
   It prints the token **once** — copy it into your password manager before anything else — and then
   the ready `psql` invocation for step 2. Do not redirect the output to a file: that puts a working
   credential on disk, which is the one thing this whole procedure exists to avoid.

   **Why a script rather than five shell commands.** The seed takes five values: an address, the
   digest, the token's leading 11 characters, and two ULIDs. SQL has no ULID generator and a shell
   has no reason to grow one, so assembling them by hand is five chances to mis-copy a value whose
   only failure mode is a seeded row the running server can never match — no error, no log line, just
   a token that is never found.

   **Why not a bare `openssl rand -base64 32`.** That output carries `+`, `/` and `=`, is 44
   characters, and has no `oi_` label — so it is not the shape §7.5.2 defines, and its leading 11
   characters are not the prefix the server would compute.

   **The pepper must be the same value the server runs with.** It enters the digest here and again on
   every verification (R-29.1). A different pepper on the server makes the seeded row unmatchable,
   silently.
2. **Run the command step 1 printed. Do not retype it, and do not copy one from this page — there is
   none here on purpose.**

   The second block of the script's output is a complete `ssh vm 'docker exec … psql …' <
   sql/migrations/003_seed_engine_admin.sql` with all five values already substituted. Select that
   block and run it unchanged.

   **Why this page shows no example of it.** A command shown with `<placeholders>` is a command
   somebody will paste. It happened on 2026-08-22: a template was copied with its placeholders
   intact, `psql` passed them through as literal values, and the seed failed on
   `api_tokens_prefix_check` because `…` is shorter than eight characters. Nothing was written — see
   the transaction note below — but the failure was caused by the instruction, not by the operator.

   **The five flags it carries, and the shape of each value.** This is a reference for checking what
   you were given — deliberately a table and not a command line, so there is nothing here to paste:

   | flag | what follows it |
   | :-- | :-- |
   | `-v ADMIN_EMAIL=` | the address you passed to the script, lowercased |
   | `-v ADMIN_TOKEN_SHA256=` | 64 lowercase hex characters — the digest, never the token |
   | `-v ADMIN_TOKEN_PREFIX=` | `oi_` and eight more characters |
   | `-v ADMIN_USER_ID=` | a ULID, 26 characters |
   | `-v ADMIN_TOKEN_ID=` | a ULID, 26 characters |

   Anything in angle brackets, and any `…`, means you are holding a template rather than the output.

   **Two guards, and they catch different things.** A MISSING parameter is refused by the file's own
   `\if :{?VAR}` checks before the first write, with the parameter named. A parameter that is present
   but malformed is not: it reaches the tables and is caught by a column constraint. The whole seed
   runs inside one transaction under `ON_ERROR_STOP=1`, so that case rolls back whole — three empty
   tables, not a half-applied admin.

   It refuses rather than promoting if the address already belongs to a non-admin user.

   **Re-running is idempotent only for an IDENTICAL re-run.** The same five values a second time
   write nothing: the user conflicts on `email` and the token on `token_hash`, both `DO NOTHING`. But
   re-running after a fresh mint carries a NEW digest, which conflicts with nothing — the user row is
   skipped and a SECOND active token is added for the same admin. That is a rotation, not a repair;
   revoke the first one deliberately if that is what you meant.
3. Verify without revealing anything: one row, the prefix you copied, no plaintext column. The
   migration prints this itself; run it again any time.
   ```sql
   SELECT prefix, role, status FROM onchain.api_tokens t JOIN onchain.users u ON u.id = t.user_id;
   ```
4. Start the server. It binds only after it finds at least one active token (§10.3.2 of
   ARCHITECTURE).

**Why the digest and not the token.** A token in a migration file is a token in git history. The
seed takes the digest for the same reason the identity model stores one: the server compares
digests and never needs the secret back. Rotation is re-running step 1 and issuing a new row; the
old row is revoked, not edited.

**If you lose the token.** There is no recovery — the digest is one-way. Seed a second admin by
repeating steps 1–2 with a new email, then revoke the lost row.

### Everything after the first admin — the CLI, not the migration

The seed exists because the first admin cannot be created by an admin. Every user and token after it
is an admin operation (R-15.4), and each one writes its own `access_audit` row (R-15.7):

```bash
# add a person
pnpm --filter @onchain-intel/mcp-server exec tsx src/admin/bin.ts \
  user:add --email analyst@example.com --role user --actor <your-user-id>

# issue them a token — the value is printed ONCE and stored nowhere
… token:issue --user analyst@example.com --actor <your-user-id>

# or store a value you minted yourself, in the form of §7.5.2
… token:issue --user analyst@example.com --actor <your-user-id> --token oi_XXXXXXXX_<43 chars>

# list — prefixes, owners, dates and status; never a value and never a digest
… token:list [--user analyst@example.com]

# revoke; the row is kept, not deleted, and refuses from the next request onward
… token:revoke --token-id <id> --actor <your-user-id>
```

**A revoked row stays and still appears in the listing.** Withdrawal of access is a state, not an
absence: `request_trace` rows reference the principal that held the token, and deleting it would
strand the record of what it did.

**`token:list` never prints a digest.** The prefix is what identifies a token to a reader; the digest
is a verifier, and this listing has more readers than the authentication path.

## Close-out
- Record the move (date, hosts, verify **`0/11/0`** — stale / metrics seen / orphans) — nothing
  silently (§6).
- Backup from **day 1** (§8.6): `pg_dump -Fc --schema=onchain` on a schedule → off-site (R2/B2/minio).

## Alternative — transfer existing history (instead of a fresh start)
Only if you want existing rows in the new instance. **Don't** hand-run `001` (it collides with the
dump): after bootstrap (Profile B) or on a fresh Supabase schema, `pg_dump -Fc --schema=onchain` →
`pg_restore --no-owner` **connected as the owning role** (the dump embodies the schema, seeds and
history). **Tail reconciliation** respects the two conflict semantics: append rows
(platform-explorer, blockchair, derived) tolerate `ON CONFLICT DO NOTHING`; the two `zec_*_supply`
aggregates are revisable and need `ON CONFLICT DO UPDATE`, or note that they self-heal because the
snapshotter re-reads ZecHub hourly and upserts.

If the transferred history predates the snapshotter's self-healing, it may contain hours where
`shielded_pool_balance_credits` is missing while `shielded_total_in/out` are present. Close those
with [`sql/maintenance/backfill_shielded_pool_balance_derived.sql`](../../sql/maintenance/backfill_shielded_pool_balance_derived.sql)
— same formula, same `source='derived'` label, with its own verify gate. It is data-driven and
idempotent: on an instance with nothing to repair it inserts zero rows.
