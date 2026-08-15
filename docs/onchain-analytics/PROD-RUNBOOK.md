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
| TG cred **"Onchain bot"** — verify `Report`, error-alert `Telegram alert` | new prod TG cred |
| `settings.errorWorkflow` — snapshotter + verify | **new** `onchain-error-alert` |
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
CHAT_ID=<chat id> \
./n8n-workflows/import.sh
```
Run `DRY_RUN=1` first and read the plan; then the same command without it. Credential ids come from
the n8n UI (Credentials → open → id in the URL); the public API has no list-credentials endpoint.

*Dual-stack / `.local` hosts:* Python may resolve to IPv6 and get a proxy `503` where curl (IPv4)
works — point `N8N_URL` at the resolvable IPv4 if so.

### By hand in the UI, if you prefer
Open the **existing** workflow → its menu → *Import from File* → Save. That replaces nodes in place
and keeps the id. **"Import from File" from the workflow *list* creates a NEW same-name workflow** —
two active workflows with one name break `export.sh` and can bind the wrong `errorWorkflow`. Then set
by hand everything the script would have done: both credentials, `Settings → Error Workflow`, and the
two `ChatID` params (they arrive as `0`).

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
  otherwise it stays silent exactly when it is needed.

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
2. Apply the seed migration with the printed command. It carries the digest, the prefix and the two
   row ids — never the token:
   ```bash
   ssh vm 'docker exec -i supabase-db psql -qU supabase_admin -d postgres -v ON_ERROR_STOP=1 \
     -v ADMIN_EMAIL=you@example.com -v ADMIN_TOKEN_SHA256=<64-hex> \
     -v ADMIN_TOKEN_PREFIX=<11-chars> -v ADMIN_USER_ID=<ULID> -v ADMIN_TOKEN_ID=<ULID>' \
     < sql/migrations/003_seed_engine_admin.sql
   ```
   The file checks every parameter before its first write, so a missing one stops it with the
   parameter named and nothing written. It refuses rather than promoting if the address already
   belongs to a non-admin user, and it is idempotent: re-running after fixing a neighbouring step
   adds no row.
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
