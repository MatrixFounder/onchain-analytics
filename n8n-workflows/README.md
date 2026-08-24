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
| `exported/onchain-error-alert.json` | Error Trigger → Telegram → one `alert.delivered` row in `onchain.diagnostics`; set as `errorWorkflow` for the three above | on error |

Credentials referenced: **Supabase DB** (postgres → the snapshotter's three tables), **Onchain engine state** (postgres → the twelve engine tables; `onchain-retention` and the WI-64 delivery heartbeat) and **Onchain bot** (Telegram).

## The importer maps every credential name, and REFUSES one it does not know

`import_with_relink.py` builds `{"Supabase DB": …, "Onchain bot": …, "Onchain engine state": …}` from
`--pg-cred-id` / `--tg-cred-id` / `--engine-cred-id`, and a node naming a credential outside that map
is now a **hard error** rather than a workflow that imports with the SOURCE instance's dangling id and
fails at the first node that needs it.

This used to be a caveat a human had to remember: `onchain-retention` needed `Onchain engine state`,
the map held two names, and the workaround was to build that one workflow by hand on the dev instance
(task 014-41, 2026-08-23). WI-64 put the heartbeat writer into `onchain-verify` and
`onchain-error-alert` too, which would have spread the same dangling id across three workflows — so
the name was taught to the importer and the caveat became a check.

## The alert-channel heartbeat (WI-64)

Every CONFIRMED Telegram delivery writes one `alert.delivered` row into `onchain.diagnostics`, and
`onchain-verify` reports the newest row's age against `AlertHeartbeatMaxAgeMs` in its **Set
Parameters** node (26 h). The daily report is the REGULAR pulse and `onchain-error-alert`'s sends are
the extra ones, which is what makes a missing row mean "the channel did not get out" rather than
"nothing happened" — the distinction L-21 had no way to make. The bound must stay above one daily
cycle: the verify query runs BEFORE that day's send and therefore reads the previous cycle's row.

`Report → Record delivery → Write delivery` is a chain, not a fan-out: the row exists only if
Telegram accepted the message.

## Prod re-import (Step 1d)

Credential ids are instance-specific — after importing to a new instance, re-link **Supabase DB**,
**Onchain bot** and **Onchain engine state**. See the dev→prod runbook (DB-SCHEMA-CONCEPT §8.5).
