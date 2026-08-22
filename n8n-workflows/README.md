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

## `proposed/` — built here, not yet on any instance

`exported/` mirrors what IS running. `proposed/` holds a workflow this repository has built and
validated but that no instance has ever had, because installing it needs something an author cannot
grant themselves.

| File | What | Blocked on |
|---|---|---|
| `proposed/onchain-retention.json` | daily retention: three jobs → `onchain.retention_runs`, one `retention.cleanup` row per pass (task 014-41, `deployment.md` §10.6) | migrations 002/003 on the target Postgres, a `Onchain engine state` credential, and the owner's explicit approval to create it on the shared instance |

**Why a separate directory rather than a file in `exported/`.** `import.sh` imports *everything* in
`exported/`, so a proposal parked there would be installed by the next prod re-import — with a
credential that does not exist on that instance. The split keeps `import.sh` unchanged and keeps
"what runs" readable as exactly that.

**Promotion, when the gates clear:** `cp proposed/onchain-retention.json exported/`, run `import.sh`,
verify on the instance, then `export.sh` — which overwrites the file with the instance's own form and
makes it a true export.

⚠️ **`import.sh` relinks exactly two credential names.** `import_with_relink.py` builds
`{"Supabase DB": …, "Onchain bot": …}`, so a node naming a THIRD credential keeps its dangling id and
imports broken. `onchain-retention` is the first workflow to need a second Postgres credential, so
installing it means teaching the importer that name — or creating this one workflow by hand.

## Prod re-import (Step 1d)

Credential ids are instance-specific — after importing to a new instance, re-link **Supabase DB**
and **Onchain bot**. See the dev→prod runbook (DB-SCHEMA-CONCEPT §8.5).
