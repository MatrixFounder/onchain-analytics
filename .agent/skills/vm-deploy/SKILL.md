---
name: vm-deploy
description: DevOps on the dev/test Parallels VM (ssh vm) for onchain-intel — apply SQL to the Supabase Postgres, inspect/manage Docker services, operate n8n. Adapted for this project from czlonkowski/n8n-lazy-loading vm-deploy.
metadata:
  tier: 2
  version: 2.0-onchain
---
# VM Deploy (onchain-intel)

**Purpose**: Standardize DevOps on the dev/test VM — apply SQL migrations to the Supabase
Postgres, inspect/manage Docker services, operate n8n. **Source of truth is this git repo**;
the VM is a runtime, not a place to edit.

## 1. Red Flags (Anti-Rationalization)
STOP if you are thinking:
- "I'll run docker/psql locally" → the Mac has no docker/psql. Docker + both Postgres run on the
  VM. Always `ssh vm`.
- "I'll `docker exec … -f /tmp/x.sql`" → that reads the **container's** filesystem, not the host —
  silently executes a stale copy. **Always pipe the script over stdin** (§4).
- "I'll edit files on the VM" → source of truth is this repo (`sql/`, `n8n-workflows/`, `docs/`).
  Edit locally, apply to the VM.
- "I'll rm/prune/reboot via ssh" → destructive commands are PROHIBITED without explicit user
  confirmation (§5).
- "I'll touch another schema / n8n's DB" → out of scope; additive-only on our own `onchain`
  schema (§5).

## 2. Connection
- **SSH alias `vm`** (in `~/.ssh/config` → 10.211.55.3, user `parallels`, key
  `id_ed25519_parallels`). **Never hardcode the IP.**
- Smoke test: `ssh vm 'echo ok && docker ps --format "{{.Names}}"'`

## 3. What lives on the VM
| Container | Role | Our access |
|---|---|---|
| `supabase-db` (supabase/postgres 15.8) | **business data** — db `postgres`, schema **`onchain`** | read/write **our schema only** |
| `postgres-n8n` (postgres:16) | n8n's own metadata DB | **DO NOT TOUCH** (§8.1) |
| `n8n-main` / `n8n-worker` | n8n runtime (also at `:5678`) | via `n8n-mcp`, not the shell |
| `n8n-mcp`, `n8n-builtin` | the MCP servers this session uses | — |

## 4. Running SQL (the important part)
**Always pipe the local `.sql` over stdin into `docker exec -i`.** Never `-f /tmp/file` (container
FS → stale copy).

Apply a migration (from repo root):
```bash
ssh vm 'docker exec -i supabase-db psql -qU supabase_admin -d postgres -v ON_ERROR_STOP=1' \
  < sql/migrations/001_init.sql
```
Ad-hoc read-only query:
```bash
ssh vm 'docker exec -i supabase-db psql -qtAU supabase_admin -d postgres' <<< "select count(*) from onchain.snapshots;"
```
Superuser role `supabase_admin` (or `postgres`) — local-trust inside the container, no password.
Migrations create schema `onchain`; the snapshotter writes via the n8n **"Supabase DB"**
credential (id `cxLk68mkh5BMWchQ`).

## 5. Safety Boundaries
- **Allowed scope**: our schema `onchain` in `supabase-db` (additive — CREATE/INSERT/UPDATE our
  own tables); n8n workflows via `n8n-mcp`.
- **NEVER without explicit user confirmation**: `DROP`/`TRUNCATE` on our tables; ANY write to
  other schemas (`public`, `cvj`, `auth`, `storage`, …) or to `postgres-n8n`; `rm`/`rmdir`;
  `docker system prune`, `docker volume rm`, `docker compose down -v`; `reboot`/`shutdown`;
  `systemctl stop/disable`.
- Rollback of our own schema (confirm first): `DROP SCHEMA onchain CASCADE`.
- MUST single-quote remote commands containing templates:
  `ssh vm 'docker ps --format "{{.Names}}"'`.

## 6. Docker status / logs
```bash
ssh vm 'docker ps --format "table {{.Names}}\t{{.Status}}"'
ssh vm 'docker logs <container> --tail 50 2>&1'
```

## 7. n8n
Build / inspect / validate / activate workflows through the `n8n-mcp` + `n8n-builtin` MCP tools —
**not** by editing files on the VM. Export finished workflow JSON to `n8n-workflows/` in this repo
(credentials stay in n8n Credentials, never in the exported JSON).

## 8. Prod deploy (Step 1d — TBD)
Prod is a separate dedicated host (own `postgres:16` + n8n; DB-SCHEMA §8). The compose layout,
`docker compose up`, backups, and the dev→prod `pg_dump --schema=onchain` runbook are authored on
Step 1d — not covered here yet.
