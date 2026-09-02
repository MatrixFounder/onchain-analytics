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
  Credentials — see the secrets rule). **Not-secret is not the same as publishable:** a chat id
  identifies a real person, so `export.sh` scrubs every `ChatID` to `0` on the way out and
  `CHAT_ID=<id> ./n8n-workflows/import.sh` puts each instance's own value back. Scrub at export, not
  by hand — export re-reads the live instance and would undo a manual edit on the next run. Exemplars: `onchain-error-alert` → **Normalize Input** (payload
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
- **A vanished vendor field should self-heal when it can be derived EXACTLY** (L-2, 2026-07-27).
  `poolBalance` disappeared from platform-explorer and 70 hours were lost. `Normalize` now prefers the
  vendor field and derives `totalShieldedIn − totalShieldedOut` when it is absent. Non-negotiables:
  **BigInt, never Number** (credits are exact integers; `Number` loses precision past 2^53 — that is
  the whole reason `value_raw` is TEXT); **refuse rather than guess** (non-integer, signed, or
  negative result → route to `dropped` and fail, because a fallback that always yields something is a
  fabrication engine); and write under **`source='derived'`, registered in `metrics.source_priority`
  first** (§1.6/§1.8) with formula + inputs in `raw_json`, never under the vendor's name. **Healed is
  not hidden:** `onchain-verify` names derived metrics daily and counts them against `ok`, so closing
  the data gap does not close the obligation to chase the vendor or retire the metric.
- **The alert channel needs a pulse of its own** (WI-64, 2026-08-24). `onchain-error-alert` is the
  terminal reader for every health signal here, and it is the one workflow whose own failure it
  cannot report — L-21 is what that costs: nine alerts failed over five days and the silence was
  found by accident. Every CONFIRMED Telegram send now writes an `alert.delivered` row into
  `onchain.diagnostics` (**chained after** the Telegram node, so only a delivery Telegram accepted
  counts), and `onchain-verify` reports the newest row's age daily against `AlertHeartbeatMaxAgeMs`
  in its Set node. The DAILY report is the regular pulse and the handler's sends are the extra ones —
  writing only from the handler would not distinguish "no incidents" from "channel dead", because the
  handler runs only when something failed. The checker must not be the channel: the DB is on the same
  VM and needs no egress, so it stays reachable exactly when the outbound path does not.
- **A diagnostic nobody reads is not a diagnostic** (L-2, 2026-07-27). The snapshotter's `Normalize`
  collected skipped metrics into a `dropped` array that no downstream node consumed, and only threw
  when *every* source was empty — so losing 1 metric of 11 looked exactly like a clean run for four
  days. If a Code node computes a health signal, wire a **reader** for it. Our pattern: a terminal
  `Check dropped` Code node that throws with the names, reaching Telegram via `errorWorkflow`.
- **"After X" needs an edge, not a canvas position.** With `executionOrder: v1` the relative order of
  parallel branches follows node geometry. When a gate must observe completed side effects, **chain
  it** (`Normalize → Write → Upsert → Check`) rather than fanning it out beside them, and set
  `alwaysOutputData: true` on the upstream nodes so an empty result can't silently skip the gate.
- **Telegram: set `parse_mode` explicitly and escape the text** (L-4, 2026-07-27). Unset →
  n8n applies its own default and Telegram parses entities; our metric ids are **snake_case**, and a
  lone `_` opens an italic that never closes → `400 can't parse entities` and **no message at all**.
  Both our Telegram nodes now send `parse_mode: HTML` and escape `& < >` (`&` first) in the node that
  owns the message contract (`Format report` / `Normalize Input`), cap interpolated error text at
  1500 chars, and truncate **after** escaping while stripping a severed `&am` at the cut. Use
  `split().join()` rather than `replaceAll()` in Set-node expressions — on the alert path, "almost
  certainly supported" is the wrong confidence level.
- **Verify the delivery layer, not just the data layer** (L-4). L-2 and L-3 were both checked against
  live SQL, real payloads and read-back wiring — and both were correct there while being undeliverable.
  A monitoring change is proven by the message **arriving**, never by the query returning right rows.
- **Per-metric thresholds live in the DB, not in the query** (L-3, 2026-07-27). One hardcoded "stale
  if older than 2h" in `onchain-verify` was applied to daily close-date aggregates, which are *never*
  younger than 2h — the report was permanently ⚠️, its ✅ branch unreachable, and a real gap moved a
  counter 2→3 unseen. Thresholds belong in `onchain.metrics.max_staleness_ms`; a NULL bound is
  reported as a defect so a new metric can't arrive unmonitored. **And name the offenders** — an alert
  that prints a count can be neither acted on nor distinguished from its own background noise.
- `retryOnFail` **multiplies blocking time**: a node can block up to `maxTries × timeout` — budget
  timeouts/liveness with that, not `timeout` alone.
- Secrets **never** in data flow / node params / Set nodes — credential system only. If a workflow's
  nodes render a secret, set `settings.saveDataSuccessExecution` **and** `saveDataErrorExecution` to
  `"none"` (else the rendered value lands in execution history).

**Executing a workflow from an agent**
- `mcp__n8n-mcp__n8n_test_workflow` only drives **webhook / form / chat** triggers; our `onchain-*`
  workflows are Schedule-triggered, so it cannot run them. `mcp__n8n-builtin__execute_workflow` can
  (Schedule / Webhook / Form / Chat / **Manual**) — but **not Error Trigger**, so `onchain-error-alert`
  is unreachable this way by design; prove its expressions with a throwaway Manual-trigger probe
  instead (create → run → **delete**), which is also the only way to exercise them without
  manufacturing a failure in a production workflow.
- **`errorWorkflow` does NOT fire for a MANUAL execution** (measured 2026-08-24, WI-64). A probe run
  with `executionMode: manual` fails visibly and the error workflow is never invoked, so a manual run
  proves nothing about the alert path. To exercise it: a throwaway workflow with a Schedule trigger
  set to a date that never comes, `settings.errorWorkflow` pointing at `onchain-error-alert`, one
  node that fails on purpose (`http://127.0.0.1:9/` refuses instantly, and needs no Code node) —
  **activate it**, run it with `executionMode: production`, then **delete it**.
- **Manual executions and scheduled ones use DIFFERENT task runners.** This instance runs n8n in
  queue mode (`n8n-main` + `n8n-worker`, `task-runners-main` + `task-runners-worker`). On 2026-08-24
  two manual executions of `onchain-verify` died with "Task request timed out after 60 seconds — your
  Code node task was not matched to a runner", while the same workflow in `production` mode ran in
  1.1 s: `task-runners-main` had logged nothing since a failed handshake on 2026-08-13. Read that
  error as "the MAIN runner is wedged", not as a defect in the Code node — and do not restart the
  container, it is shared with 20+ other workflows.
- **The public API's workflow schema is NARROWER than the workflow's own settings.** `POST` and
  `PUT /api/v1/workflows` reject `settings.binaryMode` outright (`request/body/settings must NOT have
  additional properties`) while accepting `availableInMCP`; `PATCH` is `405`. Measured 2026-08-31 by
  bisecting on a throwaway workflow, because the error names no key. Send the settings WITHOUT
  `binaryMode` — n8n MERGES the settings object rather than replacing it, so a value already stored
  survives the write (also measured: `binaryMode: "separate"` was still there on read-back).
  `import_with_relink.py:33-35` already whitelists settings and says so in a comment; note that its
  whitelist also omits `availableInMCP`, which the API WOULD accept — so a re-import drops a setting
  that did not have to be dropped.
- **"Workflow is not available in MCP" is a plain setting, not a UI-only toggle:**
  `settings.availableInMCP: true`. Set it with `n8n_update_partial_workflow` → `updateSettings`
  (pass the whole settings object; new workflows are created without it). Don't ask the operator to
  click through the UI for this.

**Import path — two defects that made it unusable, both measured 2026-09-02**
- **`active` is READ-ONLY on the public API, and every exported file carries it.** A POST or PUT
  whose body contains `active` is refused outright: `400 {"message":"request/body/active is
  read-only"}`. `export.sh` writes `active` into all five files, and `import_with_relink.py`'s
  `META_KEYS` stripped everything except that one word — so the documented recovery path could not
  create or update ANY workflow. Fixed by adding `active` to `META_KEYS`; activation was always a
  separate call (`activate()`), so nothing is lost by dropping the field.
- **`ubuntu-linux-2404.local` resolves to BOTH families from the Mac, and Python takes the IPv6
  answer.** `getaddrinfo` returns two IPv4 and four IPv6 records; the IPv6 ones are the unroutable
  addresses this file already warns about for container-to-container traffic. `curl` has Happy
  Eyeballs and silently falls back to IPv4, `urllib` does not — it connects to IPv6 and dies with
  `http.client.RemoteDisconnected: Remote end closed connection without response`, which reads like
  the API rejecting the request rather than a name resolving to the wrong family. Point any Python
  client at the VM's IPv4 literal — the address the `vm` ssh alias resolves to, `getent hosts` it or
  read `~/.ssh/config` — rather than at the `.local` name. Testing the same URL with `curl` proves
  nothing: it falls back and succeeds where the client will not.
- **`import.sh` ACTIVATES everything it writes**, unconditionally — `activate()` is called on every
  created or updated workflow regardless of the file's own `active` flag. It also takes a whole
  DIRECTORY, so it re-imports every `onchain-*` workflow at once. Neither is what you want when
  adding ONE workflow to an instance that is already running the others: it would overwrite them
  from possibly-stale exports and activate the new one before its wiring was ever inspected. For a
  single workflow, prepare the body with `prepare()` and POST/PUT it yourself, then validate, then
  activate.

**Export / re-import (hard-won)**
- **`export.sh` can move the repo BACKWARDS when the file is ahead of the instance.** The script
  re-reads the live instance and overwrites `exported/<name>.json` with whatever is there. If a
  workflow was authored in the repo but not yet installed — which is the normal state between
  writing one and getting approval to install it — a routine export after editing some OTHER
  workflow silently reverts it. Caught 2026-08-31: `onchain-retention.json` in the repo is task
  015-19's FOUR-job version (19 nodes, 9 Postgres, adds `client_usage.purge`); the instance still
  runs task 014-41's THREE-job version (16 nodes, 7 Postgres). One `./export.sh` run for
  `onchain-verify` deleted 119 lines from the retention file. **Always read `git diff
  n8n-workflows/exported/` after an export and `git checkout --` the files you did not intend to
  change** — the diff is the only thing that tells "the instance changed" apart from "the instance
  is behind".
- `export.sh` writes each workflow to `exported/<name>.json` — **keyed on workflow NAME, not id**. Two
  same-named workflows collide → the later export **silently clobbers** the earlier. This bit us: a
  soft-deleted (archived) duplicate `onchain-error-alert` overwrote the live export. `export.sh` now
  **skips `isArchived`** and **hard-errors on duplicate active names** (commit `e3a8817`) — keep those
  guards; on that error, dedup on the instance (one active per name) before re-exporting.
- **Re-import re-dangles ids + duplicates the workflow.** `export.sh` strips the top-level `id` but
  **not** node `credentials.id` nor `settings.errorWorkflow` — the JSON still carries the
  **source-instance** ids for `Supabase DB`, `Onchain bot`, and the `onchain-error-alert` handler.
  Re-importing corrected JSON **via the UI** (a) mints
  a **new** workflow id → a duplicate beside the old one, and (b) re-attaches those **stale
  credential/errorWorkflow ids** that dangle on the target instance. Prefer
  **`./n8n-workflows/import.sh`** (wrapper over `import_with_relink.py`): it **updates in place** by id
  (idempotent — no duplicate), relinks credentials + `errorWorkflow` by name, and imports error-alert
  first. After a UI re-import instead: dedup (keep one active per name) and re-remap every PG/TG
  credential + `errorWorkflow` by name (PROD-RUNBOOK §4). The Set-node `ChatID` is a plain param → survives.

**Docs**
- **Sticky notes:** every workflow carries an **Overview** sticker (mandatory); add a per-section
  sticker for any non-trivial branch. Our three onchain-* workflows each ship a single comprehensive
  Overview — acceptable at their size, provided it fully describes the sections (the snapshotter's does).
