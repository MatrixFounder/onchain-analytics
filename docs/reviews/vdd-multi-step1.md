# VDD Multi-Adversarial Report — Step 1 (onchain-intel snapshotter)

- **Date:** 2026-07-21 · **Scope:** all 3 critics (logic, security, performance) · `--fail-on=none`
- **Target:** `sql/`, `n8n-workflows/` (snapshotter/verify/error-alert + export.sh), Step-1 docs
- **Evidence:** tests NOT RUN (no suite; verified live) · scan `run_audit.py sql` = 1 medium, secrets/deps/code clean
- **Verdict:** the committee correctly found real defects (not bikeshedding). Load-bearing items **fixed**; the rest triaged below.

## Findings & disposition

| # | Sev | Finding | Status |
|---|---|---|---|
| 1 | CRITICAL | **SQLi** — snapshotter built the INSERT via dollar-quoted `jsonb_to_recordset($onchain$…{{expr}}…$onchain$)`; `JSON.stringify` doesn't escape `$`, and ZecHub is community-editable → `$onchain$` token breaks the quote (DoS/SQLi). | **FIXED** — payload base64-encoded (no `$`/`,`) and passed as a **bound `$1` parameter** (`decode($1,'base64')`); `CLAUDE.n8n.md` claim corrected. |
| 2 | HIGH | **Silent `"undefined"`** — unguarded dash `push()`es coerce a missing field to the string `"undefined"` into `NOT NULL`, sticky via `ON CONFLICT`. (We hit this with zec during the build.) | **FIXED** — every `push()` guards `undefined/null` (skips + records `dropped[]`); `rows.length===0` still throws → alert. |
| 3 | HIGH | Writes as Supabase `postgres` (tenant-admin) role → blast-radius multiplier for #1. | **DEFERRED (hardening)** — mitigated by #1. Recommend a dedicated `onchain_writer` (INSERT on snapshots, SELECT on registries) even on the Supabase dev path; prod already uses `onchain_app` (00_bootstrap). |
| 4 | MED | `saveDataSuccessExecution:"all"` persists ~750KB/run (~6.6GB/yr) in n8n's exec store. | **FIXED** — set to `"none"` (kept `saveDataErrorExecution:"all"`); `saveManualExecutions:false`. |
| 5 | MED | value_raw exactness relies on providers sending credits as JSON **strings** (true today: platform-explorer does) — not enforced; if a provider emits a JSON number >2^53 it's pre-rounded before the Code node. | **DEFERRED (latent)** — safe today; full fix = fetch PE as `responseFormat:text` + regex-extract. Tracked. |
| 6 | MED | Verify checks freshness/orphans/counts but not `value_raw` **content**; the §4 raw_json retention job is missing; verify uses `now()` (DB-time). | **DEFERRED** — add a `value_raw` sanity check + the §4 retention job (with a "rows/period" log) in M0+. |
| 7 | MED | n8n API key / MCP bearer sent over cleartext HTTP to `.local`; JWTs are non-expiring. | **DEFERRED (dev)** — prod runbook already mandates TLS; for dev, tunnel via `ssh vm` or reverse-proxy TLS; consider key expiry. |
| — | LOW | ZecHub (daily source) polled hourly → 24 dup rows/day + 750KB/hr fetch; `export.sh` keeps `errorWorkflow`/cred ids (not fully portable), no pagination >200, truncate-before-curl can leave 0-byte on failure; `raw_json` stored 4× per source/hour; orphans anti-join is dead work under PG FK; `00_bootstrap` `CREATE ROLE … PASSWORD %L` can hit the statement log. | **DEFERRED** — batch of low-sev improvements. Highest-leverage: **split ZecHub onto a daily schedule** (collapses the dup-rows + bandwidth + parse findings at once). |

Cleared by critics (no action): `.mcp.json` never entered git history (verified — no rotation needed); verify query SQL is static (no injection); no SSRF (fixed URLs); `.gitignore` covers `.env*`/`.mcp.json`; Telegram token in credential (not repo), plain-text mode (no format injection).

## Notes

- The critics' shared-model corroboration is a **weak** signal (same base model ~60% shared-error); #1 was found by two critics via **different mechanisms** (security: injection; logic: query-breakage) → genuine, not just corroboration.
- Deferred items are tracked here; none block Step-1's DoD (the snapshotter is correct + idempotent for the current, string-typed provider payloads). They feed M0+ hardening.

**VDD Multi-Adversarial complete: Logic ✓ Security ✓ Performance ✓ — load-bearing fixes applied (SQLi bind, undefined-guard, exec-data), remainder triaged. Verdict: PASS (--fail-on=none).**

---

## Follow-up (2026-07-21): data-correctness pass (post-soak audit)

Triggered by a user finding (zec rows had no `height`) → a full audit of the landed data, then a
"maximally-correct, can't-backfill-later" hardening of the zec path.

**Audit of existing rows (measured, not eyeballed):** `value_raw` = exact integer strings for all
metrics (live probe confirmed platform-explorer sends big credits as JSON **strings** → exactness is
robust, not luck — closes the latent risk in finding #5); cumulative counters **strictly
non-decreasing** (0 decreases); shielded `pool = in − out` **every** bucket (0 mismatches); full
metric coverage per bucket; `height` (dash) monotonic; `created_at ≥ ts`. **`raw_json` stores the
COMPLETE source response** (all 13 `/status` keys incl. `api.block.timestamp`, shielded `types`) →
un-parsed fields are recoverable later without a backfill. `value_num` reads back ~3 low on
`platform_total_credits` — confirmed the **documented lossy projection** (double ≈15 sig-digits on a
16-digit integer); `value_raw` is canonical/exact. **No correctness flaws found.**

**Resolved — the LOW "ZecHub polled hourly" item and the missing zec `height`:**
- New metric **`zec_block_height`** (migration `002`, source **blockchair** `/zcash/stats`) — real
  chain-tip height + `best_block_time`, coherent (height column filled). ZecHub's broken negative
  `circulation` ruled it out for supply → height/time only.
- **Two-clock snapshotter** (rebuilt): dash + `zec_block_height` → `Write snapshots`
  (`DO NOTHING`, hourly); zec **supply** → `Upsert zec supply` (`DO UPDATE`) keyed to the datum's
  **`close` date UTC-midnight** → 1 faithful row/day, converges to ZecHub's revised value (the value
  drifts intraday — `DO NOTHING` would have frozen a partial figure). Collapses the 24×/day dup.
- Backfill: the transitional fetch-time zec rows collapsed to the daily form (final values kept).

**Still deferred (M0+):** `raw_json` de-duplication (stored per-metric — storage only, not
correctness); verify `value_raw` content-check + §4 retention job (finding #6); dedicated
`onchain_writer` least-priv role (#3); dev-API TLS (#7).
