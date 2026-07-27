# PROD-RUNBOOK — deploy the snapshotter to a prod instance

- **Status:** Deployed 2026-07-21 (prod = **Supabase**, DB applied via the SQL editor). **An instance
  stood up before 2026-07-27 is running three known defects (L-2 / L-3 / L-4) and must be upgraded —
  see [Upgrading an already-running installation](#upgrading-an-already-running-installation--the-2026-07-27-fixes-l-2--l-3--l-4).** Operationalizes
  [DB-SCHEMA-CONCEPT §8.5/§8.6](DB-SCHEMA-CONCEPT.md). Two DB profiles below: **A — Supabase** (what
  dev *and* prod actually use) and **B — dedicated standalone Postgres** (future; the only one that
  uses `00_bootstrap.sql`).
- **Scope:** stand up schema `onchain` + the 3 workflows on a prod instance where n8n + Postgres
  already run. Fresh start (no history) unless you take the *Alternative*. `ssh`/`vm-deploy`
  conventions; additive-only; destructive ops confirmed. **Instance ids are not pinned in this doc —
  reference credentials/workflows by name and remap by name (they drift per instance).**

## What exists (dev, source of truth)
- **DB:** schema `onchain` (`assets`/`metrics`/`snapshots`) via `001_init.sql` **then**
  `002_zec_block_height.sql` **then** `003_metric_staleness_bounds.sql`. Registry = **2 assets /
  11 metrics**, each carrying a `max_staleness_ms` bound. Sources: `platform-explorer`, `zechub`,
  `blockchair`.
- **Workflows:** `onchain-snapshotter` (hourly, **two-clock**: `Write snapshots` append
  `ON CONFLICT DO NOTHING` for dash 8 metrics + `zec_block_height`; `Upsert zec supply`
  `ON CONFLICT DO UPDATE` for the daily `zec_*_supply` keyed on the ZecHub `close` date; keyless
  `Zcash tip` = blockchair `/zcash/stats` feeds the height clock; ends in **`Check dropped`**, which
  fails the run by name when a source omits a field — L-2) · `onchain-verify` (daily; staleness judged
  per metric from `onchain.metrics.max_staleness_ms`, every failing check names its metrics — L-3) ·
  `onchain-error-alert` (on error).
- **ChatID is a param, not a literal — and it is not in git:** both Telegram nodes read the target
  from a `ChatID` field in a Set node (error-alert's `Normalize Input`, verify's `Set Parameters`);
  the Telegram nodes reference `{{ $('…').json.ChatID }}`. Retarget alerts by editing the **Set
  node**, never the Telegram node. A chat id identifies a real person, so **`export.sh` scrubs it to
  `0`** on the way out and `import.sh` puts the instance's own value back from `CHAT_ID` — see
  *Alert target*. Each instance's live value lives only on that instance.
- **Credentials** (in n8n, never git): **"Supabase DB"** (postgres), **"Onchain bot"** (telegram).

## Database — Profile A: Supabase via the SQL editor  *(what dev + prod use)*
Supabase reuses its own `postgres` superuser + db `postgres`; **`00_bootstrap.sql` is SKIPPED** —
schema `onchain` is created by `001` itself. No prereqs (the editor authenticates as `postgres`;
Supabase PG15 already satisfies the PG≥13 `gen_random_uuid()` requirement → no `pgcrypto`).

1. In the Supabase **SQL editor**: paste `001_init.sql`, Run; then `002_zec_block_height.sql`, Run;
   then `003_metric_staleness_bounds.sql`, Run — **in that order** (`002`/`003` only `SET search_path`
   and need `001`'s `onchain.metrics`; `003` must follow `002`, since it sets a bound for the
   `zec_block_height` row `002` inserts).
   - **`004_backfill_shielded_pool_balance_derived.sql` repairs history, so it depends on whether any
     exists.** It derives `shielded_pool_balance_credits` for every hour where the vendor omitted
     `poolBalance` but `totalShieldedIn`/`Out` were captured. On a **fresh** install `snapshots` is
     empty and it inserts nothing — harmless but pointless. **On an already-running install, or after
     a dev→prod dump transfer, RUN IT**: that instance accumulated its own copy of the hole from the
     same vendor. It is data-driven, so the gap does not have to match dev's in size or dates. See
     *Upgrading an existing installation* below. Going forward the snapshotter derives the value itself.
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
- **"Onchain bot"** (telegram) → reuse the dev bot token (its existing chat has already `/start`-ed it
  → works immediately) or a new bot (the target user/chat must `/start` it first, else every send
  `403`s **silently**). The alert chat is the **`ChatID` param** in the Set node — supply it as
  `CHAT_ID` at import, or change it there afterwards; never in the Telegram node.

### Alert target — `ChatID` is scrubbed on export
A Telegram chat id identifies a real person. It is not a *secret* (so it stays a plain node param
rather than moving into Credentials — see the secrets rule in `CLAUDE.n8n.md`), but it has no place
in a git repo. `export.sh` therefore rewrites every `ChatID` assignment to **`0`** as it writes the
JSON. Scrubbing at export is the only version that holds: `export.sh` re-reads the live instance, so
editing the JSON by hand would be silently undone by the next export.

```bash
CHAT_ID=<this instance's chat id> N8N_URL=… N8N_API_KEY=… \
PROD_PG_CRED_ID=… PROD_TG_CRED_ID=… ./n8n-workflows/import.sh
```

Omit `CHAT_ID` and the import prints a warning and lands `ChatID=0`, so the first Telegram send fails
**loudly**. That is the deliberate choice: the alternative default — carrying whatever chat the
exporting environment used — means prod alerts quietly arriving in someone's dev chat, which is a
misroute nothing reports. The live value exists only on each instance, never in the repo.
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
The **UI "Import from File"** does **not** overwrite — n8n mints a **new** same-name workflow (you now
have two), and the JSON's source ids **re-dangle**. After a UI re-import: (1) **dedup** — keep exactly
one *active* workflow per name, archive/delete the stale copy (two active same-name breaks `export.sh`
and may bind the wrong `errorWorkflow`/executions); (2) **re-remap** every PG/TG credential +
`errorWorkflow` by name (this table again). The Set-node `ChatID` is a plain param, not an id → it
survives import. **Prefer `./n8n-workflows/import.sh` for re-syncs** — it **updates in place** by id
(idempotent, no duplicate, relink included) — see below.

## Validate → activate → smoke test
- `validate_workflow` (LONG nodeType form) on all three, then eyeball `connections`.
- Activate **error-alert first** (make the handler live), then `onchain-snapshotter` (hourly) +
  `onchain-verify` (daily). Don't touch the other tenant workflows.
- Run the snapshotter once manually → rows across **all three sources**, zero orphans (prod: **11
  rows, `with_height=9`**) → force a node failure → a Telegram alert reaches the target chat via the
  prod bot (proves the errorWorkflow repoint + credential + `/start` reachability).
  > **Expect a red run if a source is incomplete.** The chain ends in `Check dropped`, which fails the
  > execution when any metric was missing from its source payload — *after* the writers, so the rows
  > that did arrive are still committed. A failed smoke test whose error names metrics is the gate
  > working, not the deploy being broken: fix the mapping or retire the metric, then re-run.

## Close-out
- Record the move (date, hosts, verify **`0/11/0`** — stale / seen / orphans) — nothing silently (§6).
  > Until 2026-07-27 this line read `2/11/0`, because the old verify counted the two ZecHub daily
  > aggregates as permanently stale (L-3) and the runbook had normalized that floor as "healthy". With
  > per-metric bounds a healthy install is **0 stale**. A non-zero count now names its metrics; treat
  > any of them as a real gap, never as the expected background.
- Backup from **day 1** (§8.6): `pg_dump -Fc --schema=onchain` on a schedule → off-site (R2/B2/minio).

## Upgrading an already-running installation — the 2026-07-27 fixes (L-2 / L-3 / L-4)

For an instance deployed **before 2026-07-27** (prod was stood up 2026-07-21). It is running three
real defects — see [KNOWN_ISSUES](../KNOWN_ISSUES.md): a permanently-⚠️ verify that names nothing
(L-3), a metric that stopped writing on **2026-07-23 09:00 UTC** and said nothing (L-2), and a
Telegram path that **400s on any message containing `_` or `<`**, so alerts about all of it were
never delivered (L-4). Changed artifacts: migrations `003` + `004`, and all three workflows.

### Order is load-bearing: migrations FIRST, workflows second
The new `Verify query` selects `onchain.metrics.max_staleness_ms`. Land the workflows first and the
nightly verify dies with `column "max_staleness_ms" does not exist` — and since that message contains
underscores, the **pre-fix** error-alert still on the instance would 400 trying to report it. A broken
monitor announcing itself into a channel that cannot deliver is silence: the exact failure mode all
three defects share. Migrations are additive and safe to apply while the old workflows keep running.

### 1. Measure before changing anything (§6 — nothing silently)
```sql
SET search_path TO onchain;
SELECT metric, count(DISTINCT ts_bucket) AS buckets,
       to_timestamp(max(ts)/1000) AT TIME ZONE 'UTC' AS last_seen
  FROM onchain.snapshots GROUP BY metric ORDER BY metric;
```
Expect `shielded_pool_balance_credits` to trail the other dash metrics — same vendor, same endpoint,
so the same hole. **Record the numbers**; the close-out compares before/after.

### 2. Apply `003` then `004`
Profile A: paste each into the SQL editor as-is — `003`/`004` contain **no psql backslash
meta-commands**, unlike `001`/`002`. `004` ends in a single-statement verify gate (one statement
because a GUI editor renders only the last result set). Both are idempotent and additive; `004`
skips any bucket that already holds a balance row from any source, so re-running never double-writes.

### 2a. Re-run `004` after step 4 — the gap keeps growing until the workflows land
The **old** snapshotter is still running during the upgrade and still writes nothing for this metric,
so every hour between applying `004` and importing the new workflows re-opens the hole by one bucket.
The new snapshotter derives the *current* hour; it does not backfill. So the sequence is:

**`003` → `004` → import workflows (step 4) → `004` again.**

The second run costs nothing if nothing was lost, and closes the deployment window if anything was.
This is exactly what the migration's idempotency is for; verified on dev by re-running it with no
effect other than the rows the snapshotter had legitimately added meanwhile.

### 3. DB gate — pass this before importing any workflow
```sql
SELECT count(*) AS metrics, count(max_staleness_ms) AS bounded,
       count(*) - count(max_staleness_ms) AS unbounded FROM onchain.metrics;   -- 11 / 11 / 0
```
plus `004`'s own output: `mismatch = 0`, `duplicate_buckets = 0`, `orphans = 0`, and
`balance_buckets = in_buckets`. A non-zero `unbounded` means the instance carries a metric this
migration does not know — bound it before continuing, or verify will (correctly) report it forever.

### 4. Import the workflows — `./n8n-workflows/import.sh`, never the UI
`DRY_RUN=1` first. The script updates in place by id, relinks credentials by name, points
`errorWorkflow` at the new error-alert, and imports error-alert first.

> ⚠️ **Pass `CHAT_ID`, or this instance imports with no alert target.** The exported Set nodes carry
> the scrubbed sentinel `ChatID = 0` (see *Alert target*), so `CHAT_ID=<id> ./n8n-workflows/import.sh`
> is what gives the instance its own chat. Forget it and Telegram sends fail at the first alert —
> visibly, which is the intended failure. Alternatively set `ChatID` by hand in verify's **Set
> Parameters** and error-alert's **Normalize Input** right after import.

### 5. Smoke test — and note that it only works now
Force a node failure and confirm the Telegram alert arrives. Before L-4 this step could pass a visual
inspection while delivering nothing: if the error text happened to contain `_`, the send 400'd. Both
delivery paths were confirmed against the live Telegram API on 2026-07-27 (`message_id` 11 and 12),
including `<b>` arriving as literal text rather than markup.

### 6. Expected steady state — read it correctly
- **verify: `0 stale`, but still ⚠️**, carrying
  `🧮 derived — vendor field missing, value computed: shielded_pool_balance_credits (N rows/24h)`.
  This is **correct, not a failed deploy**: the series has no gap because the snapshotter derives the
  value, and the line stays until platform-explorer restores `poolBalance` or the metric is retired.
- **snapshotter: succeeds hourly**, writing one `source='derived'` row per hour. It no longer fails on
  this metric — `Check dropped` still fails the run for anything with no exact fallback.
- Close-out record: **`0/11/0`**.

### Rollback, per artifact
| Artifact | Revert |
|---|---|
| Workflows | `import.sh` with the previous `exported/*.json` from git — updates in place, no duplicates |
| `004` | `DELETE FROM onchain.snapshots WHERE metric='shielded_pool_balance_credits' AND source='derived';` |
| `003` | Additive; leaving the column costs nothing. Full revert is `ALTER TABLE onchain.metrics DROP COLUMN max_staleness_ms;` — but the old verify then returns to being permanently ⚠️ (L-3) |

## Alternative — transfer dev history (instead of a fresh start)
Only if you want the dev rows in prod. **Don't** hand-run `001`/`002` (they collide with the dump):
after bootstrap (Profile B) or on a fresh Supabase schema, `pg_dump -Fc --schema=onchain` (dev) →
`pg_restore --no-owner` **connected as the owning role** (dump embodies 001+002 + seeds + history).
**Tail reconciliation** respects the two conflict semantics: append rows (platform-explorer,
blockchair) docatch `ON CONFLICT DO NOTHING`; the two `zec_*_supply` aggregates are revisable → docatch
`ON CONFLICT DO UPDATE` (a blanket `DO NOTHING` silently keeps a **stale** supply), or note they
self-heal because prod re-reads ZecHub hourly and upserts.

## import.sh — bulk / repeatable import
`./n8n-workflows/import.sh` (thin wrapper over `import_with_relink.py`; structure mirrors
czlonkowski/n8n-lazy-loading) imports every `exported/*.json` — relinks node `credentials.id` **by
name** to the prod ids you pass, points `settings.errorWorkflow` at the (new) `onchain-error-alert`
(imported first), strips `settings.binaryMode`, and activates each.

- **Idempotent — the safe re-sync:** a same-name workflow already on the target is **UPDATED in place**
  (PUT by id), *not* duplicated (unlike the UI import — see §Re-import).
- **Env (prod — never the dev `.mcp.json`):** `N8N_URL`, `N8N_API_KEY`, `PROD_PG_CRED_ID` (prod
  "Supabase DB" credential id), `PROD_TG_CRED_ID` (prod "Onchain bot" id). **First run `DRY_RUN=1`** to
  preview the plan.
- *Dual-stack / `.local` hosts:* Python may resolve to IPv6 and get a proxy `503` where curl (IPv4)
  works — point `N8N_URL` at the resolvable IPv4 if so (prod DNS is usually single-stack).
