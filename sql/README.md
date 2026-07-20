# `sql/` — onchain-intel database (Postgres profile)

DDL and migrations for the **n8n + Postgres deploy profile** (see
[DB-SCHEMA-CONCEPT §8](../docs/onchain-analytics/DB-SCHEMA-CONCEPT.md)). Portable-by-design
conventions from §1 are mandatory: BIGINT epoch-ms UTC, `value_raw` as **string**, uuid id,
append-only `ON CONFLICT DO NOTHING`, schema `onchain` (not `public`).

## Topology (§8.1)

Isolation invariant: our tables live in schema **`onchain`**, never in `public`, and **never in
n8n's own DB**.

- **Dev/test (current): Supabase** — schema `onchain` inside the existing `supabase-db` cluster,
  db `postgres`. n8n's metadata is a *separate* container (`postgres-n8n`) we never touch.
- **Prod/standalone (later):** a dedicated Postgres — separate database `onchain_intel`, schema
  `onchain` owned by role `onchain_app`. This is what `00_bootstrap.sql` provisions.

## Apply order

**Dev/test (Supabase, current)** — reuse the existing `postgres` superuser + db `postgres`; only
`001_init.sql` is needed (it creates schema `onchain`). Stdin-pipe per the vm-deploy convention
(never `-f /tmp/…` — that reads the container FS):

```bash
ssh vm 'docker exec -i supabase-db psql -qU supabase_admin -d postgres -v ON_ERROR_STOP=1' \
  < sql/migrations/001_init.sql
```

**Prod/standalone (later)** — fresh dedicated cluster; run `00_bootstrap.sql` first (role + DB +
schema), then `001_init.sql` as `onchain_app`:

```bash
psql -U postgres -v ONCHAIN_APP_PASSWORD="$ONCHAIN_APP_PASSWORD" -f sql/00_bootstrap.sql
psql "postgresql://onchain_app@<host>:5432/onchain_intel" -f sql/migrations/001_init.sql
```

Every script is **idempotent** — re-running is safe (`IF NOT EXISTS` + guards + `ON CONFLICT DO
NOTHING`). That is the point: to resume anywhere, just re-run.

## Files

| File | What | When |
|---|---|---|
| `migrations/001_init.sql` | v0 tables (`assets`, `metrics`, `snapshots`) + registry seed (2 assets, 10 metrics) | **dev + prod** |
| `00_bootstrap.sql` | role `onchain_app`, DB `onchain_intel`, schema `onchain`, lock `public` | **prod/standalone only** |

## Verify after apply

```sql
SET search_path TO onchain;
SELECT count(*) FROM assets;   -- expect 2
SELECT count(*) FROM metrics;  -- expect 10
-- zero orphan observations (must always hold — §1.6):
SELECT count(*) FROM snapshots s LEFT JOIN assets a ON s.asset=a.id
  LEFT JOIN metrics m ON s.metric=m.id WHERE a.id IS NULL OR m.id IS NULL;  -- expect 0
```

## Next

`migrations/002_*.sql` will add v1 (`events`, `aggregates`, DB-SCHEMA §3) — only when an
event-granularity source appears. Not needed for the v0 snapshotter.
