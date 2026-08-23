# n8n-workflows

Git mirror of the `onchain-intel` n8n workflows. **Source of truth is the running n8n instance**;
these JSON snapshots are for review, diffing, and prod re-import.

## Export

```bash
./n8n-workflows/export.sh          # pulls onchain-* workflows into exported/
```

Adapted from `czlonkowski/n8n-lazy-loading`: fetches via the n8n public API and **strips volatile
metadata** (`updatedAt`/`versionId`/`triggerCount`/… and the instance `id`) so git diffs track
content, not clock drift. The API key is read from the gitignored `.mcp.json` (or `N8N_API_KEY`
env). Exports **credential references (id/name) only** — n8n never returns secret data via the API.

## Workflows

| File | What | Trigger |
|---|---|---|
| `exported/onchain-snapshotter.json` | 4 keyless sources → normalize (value_raw as string) → `onchain.snapshots` via `jsonb_to_recordset … ON CONFLICT DO NOTHING` | hourly |
| `exported/onchain-verify.json` | daily health check (freshness / orphans / counts) → Telegram report | daily 08:07 UTC |
| `exported/onchain-retention.json` | three retention jobs → one `onchain.retention_runs` row each, one `retention.cleanup` row per pass; a window outside its bounds REFUSES and writes `outcome='failed'` (task 014-41, `deployment.md` §10.6) | daily |
| `exported/onchain-error-alert.json` | Error Trigger → Telegram; set as `errorWorkflow` for the three above | on error |

Credentials referenced: **Supabase DB** (postgres → the snapshotter's three tables), **Onchain engine state** (postgres → the twelve engine tables; `onchain-retention` only) and **Onchain bot** (Telegram).

## ⚠️ `import.sh` relinks exactly two credential names

`import_with_relink.py` builds `{"Supabase DB": …, "Onchain bot": …}`, so a node naming a THIRD
credential keeps its dangling id and imports broken. **`onchain-retention` is the first workflow that
needs a second Postgres credential** (`Onchain engine state`), so installing it on another instance
means teaching the importer that name — or creating that one workflow by hand and relinking it there.

It was created by hand on the dev instance for exactly this reason (task 014-41, 2026-08-23).

## Prod re-import (Step 1d)

Credential ids are instance-specific — after importing to a new instance, re-link **Supabase DB**
and **Onchain bot**. See the dev→prod runbook (DB-SCHEMA-CONCEPT §8.5).
