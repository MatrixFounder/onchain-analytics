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

## Gotchas (hard-won — harvested from the n8n-lazy-loading project)

**MCP / build loop**
- Two MCP servers are wired: `n8n-mcp` (community, `mcp__n8n-mcp__*`, JSON node-graph) and
  `n8n-builtin` (first-party, `mcp__n8n-builtin__*`, SDK). `search_nodes` / `validate_workflow`
  exist in **both** with different semantics — pick one and stay consistent (**we use `n8n-mcp`**).
- **nodeType form trap:** tools (`get_node` / `validate_node`) take SHORT form (`nodes-base.postgres`);
  workflow JSON (`n8n_create_workflow` / `validate_workflow`) takes LONG form
  (`n8n-nodes-base.postgres`). Wrong form → "Node not found".
- Edit incrementally with `n8n_update_partial_workflow` (not full replace); `validate_workflow`
  after every edit; then `n8n_get_workflow` to eyeball `connections` — validation ≠ correct wiring.

**Expressions & Code nodes**
- Reference nodes **insert-safe**: `$('Node Name').item.json.field` — **never bare `$json.field`**
  (breaks when a node is inserted upstream).
- **Expression fields** wrap in `{{ }}`; **Code nodes never use `{{ }}`** — access vars directly.
- Webhook payload is under `$json.body`, not `$json`.
- `$env` is **blocked** in node expressions on this instance (`N8N_BLOCK_ENV_ACCESS_IN_NODE=true`) →
  `{{ $env.* }}` throws. Config comes from the DB / node params, never env.
- Code JS: input `$input.all()` / `$input.item.json`; helpers `$helpers.httpRequest()`, `DateTime`
  (Luxon), `$jmespath()`; **return `[{ json: {…} }]`**; preserve binary with
  `return [{ json, binary: $input.first().binary }]`. Default mode **"Run Once for All Items"**.
- Code Python is `pythonNative` (not `python`); input `_items[0]` is a plain dict (no `.json`);
  `_input.all()` **doesn't exist → silent hang**; stdlib only.

**HTTP responses (hard-won on the snapshotter)**
- A JSON body served as `Content-Type: text/plain` (e.g. `raw.githubusercontent.com` for `.json`
  files) is **NOT auto-parsed** — the HTTP node yields one item `{ data: "<raw JSON string>" }`;
  `JSON.parse($('Node').first().json.data)` in the Code node. (`application/json` bodies ARE
  parsed → `json` is the object directly.)
- A **top-level JSON array** response gets split into one item per element by default; `executeOnce`
  changes the output shape again. **Don't guess the shape** — when a field is unexpectedly
  `undefined`, inspect the real output: `n8n_executions get <id> mode=filtered nodeNames=[…] itemsLimit=0`.

**Postgres (critical for our snapshotter)**
- `queryReplacement` (`$1..$N`) is **positional CSV**: a value containing a **comma breaks it**, and
  an **empty value silently shifts every later `$N`**. Unsafe for `raw_json` (commas) and nullables
  (`value_num` / `height`).
- **Robust idempotent bulk insert (our pattern):** Code emits one item `{ rows_json: JSON.stringify(rows) }`;
  Postgres `executeQuery` with a **dollar-quoted `jsonb_to_recordset`** — no `queryReplacement`,
  comma/quote/null-safe:
  ```sql
  INSERT INTO onchain.snapshots (ts, ts_bucket, source, asset, metric, value_raw, value_num, height, raw_json, created_at)
  SELECT ts, ts_bucket, source, asset, metric, value_raw, value_num, height, raw_json, created_at
  FROM jsonb_to_recordset($onchain${{ $json.rows_json }}$onchain$::jsonb)
    AS x(ts bigint, ts_bucket bigint, source text, asset text, metric text,
         value_raw text, value_num double precision, height bigint, raw_json text, created_at bigint)
  ON CONFLICT (source, asset, metric, ts_bucket) DO NOTHING;
  ```
  (`jsonb` `null` → SQL `NULL`; the `$onchain$` tag can't appear in JSON output, so it's injection-safe.)
- If you must use `queryReplacement`: nullable → `__EMPTY__` sentinel + `NULLIF($N,'__EMPTY__')::type`
  (n8n drops empty strings between nodes).
- **Postgres node eats binary** — never place it between a binary producer and its consumer; attach
  DB side-effects as a fan-out sibling branch with `onError: continueRegularOutput`.

**Error handling & runtime**
- Choose deliberately: `onError: continueRegularOutput` makes a node's error flow on as data (keeps
  the workflow alive) — good for partial results, **bad when you want a loud alert**. For
  loud-fail-and-notify use `retryOnFail` + default stop → an **Error Trigger** workflow.
- `retryOnFail` **multiplies blocking time**: a node can block up to `maxTries × timeout` — budget
  timeouts/liveness with that, not `timeout` alone.
- Secrets **never** in data flow / node params / Set nodes — credential system only. If a workflow's
  nodes render a secret, set `settings.saveDataSuccessExecution` **and** `saveDataErrorExecution` to
  `"none"` (else the rendered value lands in execution history).

**Docs**
- **Sticky notes are mandatory:** every workflow carries an Overview sticker + one per section — a
  workflow isn't "done" without them.
