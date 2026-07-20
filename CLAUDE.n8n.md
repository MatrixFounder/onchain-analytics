# n8n conventions (onchain-intel)

This project builds n8n workflows (self-hosted, in the dev VM) for the snapshotter and future
signal/alert flows. Two MCP servers are wired via project `.mcp.json`: **`n8n-mcp`** + **`n8n-builtin`**.

## Use the skills
The `n8n-mcp-skills` are symlinked into `.claude/skills/` (source `/Users/sergey/ExternalTools/n8n-skills`
— referenced, not vendored). **Consult `using-n8n-mcp-skills` (the router) first** on any n8n / workflow /
node task, then the specialist it routes to (`n8n-workflow-patterns`, `n8n-node-configuration`,
`n8n-expression-syntax`, `n8n-code-javascript`, `n8n-error-handling`, `n8n-validation-expert`,
`n8n-self-hosting`, `n8n-multi-instance`). n8n's surface drifts between versions — **don't guess node
params**; discover via `search_nodes` → `get_node`, and `validate_workflow` before activating.

Regenerate the (gitignored) symlinks if missing, from repo root:
```bash
ln -sfn ../../ExternalTools/n8n-skills .n8n-skills
for s in $(ls .n8n-skills/skills); do ln -sfn ../../.n8n-skills/skills/$s .claude/skills/$s; done
```

## Our n8n context
- Instance `http://ubuntu-linux-2404.local:5678` — reach the box with `ssh vm` (see the `vm-deploy` skill).
- **Busy shared instance** (20+ active workflows): only **CREATE** our `onchain-*` workflows — never
  edit / activate / delete anyone else's.
- DB writes use the existing Postgres credential **"Supabase DB"** (id `cxLk68mkh5BMWchQ`) → schema
  `onchain` (DB-SCHEMA §8). Credentials live in **n8n Credentials**, never in workflow JSON.

## Build conventions
- Workflow-oriented names: `onchain-snapshotter`, `onchain-verify` (not `get_data`).
- **Validate before activation** (`validate_workflow` / `n8n-validation-expert`); export finished
  workflow JSON to `n8n-workflows/` in this repo (secrets stripped).
- Code-node normalization honors the schema canon (DB-SCHEMA §1/§8): `value_raw` as a **string**
  (never parse credits to a JS number), `ts` epoch-ms UTC, `ts_bucket = floor(ts/3600000)*3600000`,
  write via `INSERT … ON CONFLICT DO NOTHING`.
