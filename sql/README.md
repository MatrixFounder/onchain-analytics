# `sql/` — onchain-intel database (Postgres profile)

DDL for the **n8n + Postgres deploy profile** (see
[DB-SCHEMA-CONCEPT §8](../docs/onchain-analytics/DB-SCHEMA-CONCEPT.md)). Portable-by-design
conventions from §1 are mandatory: BIGINT epoch-ms UTC, `value_raw` as **string**, uuid id,
append-only `ON CONFLICT DO NOTHING`, schema `onchain` (not `public`), and metric **and source**
names taken from the registry rather than written free-form.

## Topology (§8.1)

Isolation invariant: our tables live in schema **`onchain`**, never in `public`, and **never in
n8n's own DB**.

- **Supabase (dev + prod today)** — schema `onchain` inside the existing `supabase-db` cluster,
  db `postgres`. n8n's metadata is a *separate* container (`postgres-n8n`) we never touch.
- **Dedicated standalone (later)** — separate database `onchain_intel`, schema `onchain` owned by
  role `onchain_app`. This is what `00_bootstrap.sql` provisions.

## Apply

The whole schema is **one file**. It contains no psql backslash meta-commands, so the same file
pastes into a GUI SQL editor and pipes into `psql` unchanged.

**Supabase** — reuse the existing superuser + db `postgres`; `001` creates schema `onchain` itself.
Stdin-pipe per the vm-deploy convention (never `-f /tmp/…` — that reads the container FS):

```bash
ssh vm 'docker exec -i supabase-db psql -qU supabase_admin -d postgres -v ON_ERROR_STOP=1' \
  < sql/migrations/001_init.sql
```

**Dedicated standalone** — run `00_bootstrap.sql` first (role + DB + schema), then `001` as
`onchain_app`:

```bash
psql -U postgres -v ONCHAIN_APP_PASSWORD="$ONCHAIN_APP_PASSWORD" -f sql/00_bootstrap.sql
psql "postgresql://onchain_app@<host>:5432/onchain_intel" -f sql/migrations/001_init.sql
```

> **PG version:** `001` defaults `snapshots.id` to `gen_random_uuid()` — core in **PG ≥ 13** (no
> extension). On an older cluster the **superuser** must `CREATE EXTENSION IF NOT EXISTS pgcrypto`
> in `onchain_intel` before `001` (the `onchain_app` role can't create extensions).

Every script is **idempotent** — re-running is safe (`IF NOT EXISTS` + `ON CONFLICT DO NOTHING` +
guarded updates), including against an instance that already holds history. That is the point: to
resume anywhere, just re-run.

## Files

| File | What | When |
|---|---|---|
| `migrations/001_init.sql` | Schema (`assets`, `metrics`, `snapshots`) + registry seed: **2 assets / 11 metrics**, each with its `max_staleness_ms` bound and `source_priority` | **always** |
| `00_bootstrap.sql` | role `onchain_app`, DB `onchain_intel`, schema `onchain`, lock `public` | dedicated standalone only |
| `maintenance/backfill_shielded_pool_balance_derived.sql` | Repairs hours where the vendor omitted `poolBalance`, deriving `totalShieldedIn − totalShieldedOut` under `source='derived'`. Ships its own verify gate | only on an instance whose history predates the snapshotter's self-healing |

`maintenance/` is deliberately outside `migrations/`: it is a repair tool for existing data, not part
of standing a new instance up. On a fresh install it would insert nothing.

## Verify after apply

```sql
SELECT (SELECT count(*) FROM onchain.assets)                                 AS assets,     -- 2
       (SELECT count(*) FROM onchain.metrics)                                AS metrics,    -- 11
       (SELECT count(*) FROM onchain.metrics WHERE max_staleness_ms IS NULL) AS unbounded,  -- 0
       (SELECT count(*) FROM onchain.snapshots s
          LEFT JOIN onchain.assets  a ON s.asset  = a.id
          LEFT JOIN onchain.metrics m ON s.metric = m.id
         WHERE a.id IS NULL OR m.id IS NULL)                                 AS orphans;    -- 0
```

`unbounded` must be **0**. A metric with no `max_staleness_ms` is one `onchain-verify` cannot judge,
so it reports the NULL as a registry defect rather than treating it as healthy — which is what keeps
a newly added metric from silently arriving unmonitored.

Sources in use across `snapshots`: `platform-explorer`, `zechub`, `blockchair`, `derived`.

## Next

`002_*.sql` will add v1 (`events`, `aggregates`, DB-SCHEMA §3) — only when an event-granularity
source appears. Not needed for the v0 snapshotter.
