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
| `exported/onchain-error-alert.json` | Error Trigger → Telegram; set as `errorWorkflow` for the two above | on error |

Credentials referenced: **Supabase DB** (postgres → schema `onchain`) and **Onchain bot** (Telegram).

## Prod re-import (Step 1d)

Credential ids are instance-specific — after importing to a new instance, re-link **Supabase DB**
and **Onchain bot**. See the dev→prod runbook (DB-SCHEMA-CONCEPT §8.5).
