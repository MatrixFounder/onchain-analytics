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
- DB writes use the Postgres credential **"Supabase DB"** → schema `onchain` (DB-SCHEMA §8); Telegram
  alerts (verify report + error-alert) use **"Onchain bot"**; the `errorWorkflow` handler is
  **`onchain-error-alert`**. Credentials live in **n8n Credentials**, never in workflow JSON — and
  their **instance ids are not pinned in this doc** (they live in the workflow JSON on the live
  instance and drift per instance). Always reference credentials/workflows **by name** and remap by
  name on any other instance (see *Export / re-import* below + PROD-RUNBOOK §4).

## Build conventions
- Workflow-oriented names: `onchain-snapshotter`, `onchain-verify` (not `get_data`).
- **Validate before activation** (`validate_workflow` / `n8n-validation-expert`); export finished
  workflow JSON via **`./n8n-workflows/export.sh`** → `n8n-workflows/exported/<name>.json` (fetches
  over the public API, strips volatile metadata + the top-level id; secrets are never returned).
- **Normalize Input / param-node pattern (mandatory):** never hardcode field-mapping expressions
  **or config values** inside a target/presentation node (Telegram, Postgres, HTTP). Put a **Set node
  right after the trigger** that (1) maps the raw payload into clean, named fields **with `|| default`
  fallbacks** (so nothing renders `undefined`), and (2) carries the workflow's **config params** —
  e.g. the Telegram target `ChatID` — as named fields. Downstream nodes reference it insert-safe by
  name (`$('Normalize Input').first().json.field` or `$('Set Parameters').item.json.ChatID`). One node
  owns the input+config contract → to change the target chat/message, edit the Set node, **never** the
  Telegram node. **Non-secret config only** (a chat id is fine in a node param; a bot token stays in
  Credentials — see the secrets rule). Exemplars: `onchain-error-alert` → **Normalize Input** (payload
  map + `ChatID`); `onchain-verify` → **Set Parameters** (config-only, holds `ChatID`); external
  `TranscribeWorker` → **Normalize Input**.
- Code-node normalization honors the schema canon (DB-SCHEMA §1/§8): `value_raw` as a **string**
  (never parse credits to a JS number), `ts` epoch-ms UTC, `ts_bucket = floor(ts/3600000)*3600000`.
  **Two write modes (two-clock model):** immutable hourly observations append via
  `INSERT … ON CONFLICT DO NOTHING`; **recomputable daily aggregates** (the revisable `zec_*_supply`,
  keyed on the ZecHub `close` date) upsert via `INSERT … ON CONFLICT DO UPDATE`. One `Normalize` Code
  node emits both batches (`append_b64` + `upsert_b64`) and fans out to two Postgres writers.

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
- **Robust idempotent bulk insert (our pattern):** Code emits one item
  `{ rows_b64: Buffer.from(JSON.stringify(rows)).toString('base64') }`; the Postgres `executeQuery`
  node binds it as a **real `$1` parameter** via Query Parameters
  (`options.queryReplacement = {{ $json.rows_b64 }}`) and decodes it server-side. Base64 has no `,`
  (survives the positional-CSV binding as one value) and no `$`, and it's **driver-bound, not
  string-interpolated**:
  ```sql
  INSERT INTO onchain.snapshots (ts, ts_bucket, source, asset, metric, value_raw, value_num, height, raw_json, created_at)
  SELECT ts, ts_bucket, source, asset, metric, value_raw, value_num, height, raw_json, created_at
  FROM jsonb_to_recordset(convert_from(decode($1, 'base64'), 'utf8')::jsonb)
    AS x(ts bigint, ts_bucket bigint, source text, asset text, metric text,
         value_raw text, value_num double precision, height bigint, raw_json text, created_at bigint)
  ON CONFLICT (source, asset, metric, ts_bucket) DO NOTHING;
  ```
  ⚠️ **Do NOT dollar-quote-interpolate untrusted data** (`$tag$…{{ expr }}…$tag$::jsonb`):
  `JSON.stringify` does not escape `$`, so a `$tag$` token in a third-party response closes the quote
  early → SQLi / DoS (caught by vdd-multi, 2026-07-21; ZecHub is a community-editable source). Encode
  + bind instead.
- **Aggregate (recomputable) variant:** same base64-bound insert, but
  `ON CONFLICT (source, asset, metric, ts_bucket) DO UPDATE SET value_raw = EXCLUDED.value_raw,
  value_num = EXCLUDED.value_num, raw_json = EXCLUDED.raw_json, created_at = EXCLUDED.created_at` —
  update the **value columns only, never the conflict-key columns**. This is the two-clock upsert path
  for `zec_*_supply` (revised daily); a blanket `DO NOTHING` there would silently pin a **stale** value.
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

**Export / re-import (hard-won)**
- `export.sh` writes each workflow to `exported/<name>.json` — **keyed on workflow NAME, not id**. Two
  same-named workflows collide → the later export **silently clobbers** the earlier. This bit us: a
  soft-deleted (archived) duplicate `onchain-error-alert` overwrote the live export. `export.sh` now
  **skips `isArchived`** and **hard-errors on duplicate active names** (commit `e3a8817`) — keep those
  guards; on that error, dedup on the instance (one active per name) before re-exporting.
- **Re-import re-dangles ids + duplicates the workflow.** `export.sh` strips the top-level `id` but
  **not** node `credentials.id` nor `settings.errorWorkflow` — the JSON still carries the
  **source-instance** ids for `Supabase DB`, `Onchain bot`, and the `onchain-error-alert` handler.
  Re-importing corrected JSON (a) mints
  a **new** workflow id → a duplicate beside the old one, and (b) re-attaches those **stale
  credential/errorWorkflow ids** that dangle on the target instance. After **any** re-import: dedup
  (keep one active per name) and re-remap every PG/TG credential + `errorWorkflow` by name (prod
  procedure: PROD-RUNBOOK §4). The Set-node `ChatID` is a plain param, not an id → survives import.

**Docs**
- **Sticky notes:** every workflow carries an **Overview** sticker (mandatory); add a per-section
  sticker for any non-trivial branch. Our three onchain-* workflows each ship a single comprehensive
  Overview — acceptable at their size, provided it fully describes the sections (the snapshotter's does).
