---
id: WI-8
type: work-item
status: open
opened_at: 2026-07-24
slug: wi-8-r47-carryover-rpc-solana-exact-lamports
---

# [R-47] carry-over M1-hardening — deferred at TASK-005 (M2) acceptance

Optional (Should), explicitly non-gating for M2's exit criteria (TASK.md R-47 row, PLAN.md §2 Step 9). Two items. **Item (1) is CLOSED by TASK-007 task 007-3 (2026-07-27):** `safeFetch` now bounds a no-`Content-Length` response with a streaming byte counter over `response.body` and cancels the upstream reader on overflow, throwing the same `SafeFetchResponseTooLargeError`. It stopped being opportunistic when a live probe showed `api.llama.fi` sends **no `Content-Length` at all**, i.e. the cap was inert on a host the engine calls on three capabilities and was about to call more. Item **(2) remains open**: `rpc-solana` (`packages/core/src/adapters/rpc-solana/index.ts`) still parses the lamports balance via `JSON.parse` into a `number` — a wallet balance above `Number.MAX_SAFE_INTEGER` (~9.007M SOL) throws instead of preserving the exact on-chain value as a raw-text-extracted string (`amountRaw`, DB-SCHEMA-CONCEPT §1 canon). Full spec + acceptance tests: `docs/tasks/task-005-9-optional-carryover-hardening.md` (kept in `docs/tasks/`, not archived, per its own acceptance note — pick up opportunistically when there's slack, not gating any future milestone's acceptance either).
