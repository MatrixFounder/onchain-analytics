---
id: RF-17
type: known-issue
status: fixed
opened_at: 2026-09-04
resolved_at: 2026-09-04
resolved_by: `emit()` возвращает `string | null`; правки в `engine/diagnostics.ts` и `interfaces.md` §5.4.3
category: workflow-docs
severity: SEV-2
slug: rf-17-a-refusal-hands-out-an-event-id-after-the-diagnostics-write-failed-so-the-id-resolves-to-no-row
component: mcp-server/engine/diagnostics
evidence_paths:
  - packages/mcp-server/src/engine/diagnostics.ts
  - packages/mcp-server/src/tools/registry.ts
  - packages/mcp-server/eval/ledger.jsonl
  - docs/issues/l-30-four-failures-three-vendors-all-at-ten-seconds-points-at-our-side.md
---

# RF-17 — a refusal hands out an event id after the diagnostics write failed, so the id resolves to no row

**Symptom.** A refusal reaches the client as `capability unavailable: … (event <id>)`. For two of
the three refusals in the live-gate run of 2026-09-02 20:23 UTC, that id resolves to nothing:

| event id | what it names | in `diagnostics` | in `request_trace` |
| :-- | :-- | :-- | :-- |
| `01M1HWAZ3FV3GM7SKDH3AAW1A9` | `solana/chain.tvl.history`, 20:18:01 UTC | no | no |
| `01M1HWF65CJBNEXFN0W40BMJZ0` | `bsc/pairs.active`, 20:20:20 UTC | no | no |
| `01M1HWMGB6RJ09QVE3W4KA3HMH` | `wallet.balances.native`, 20:23:14 UTC | yes | — |

Timestamps decoded from the ULIDs themselves. Queried on 2026-09-04 against `onchain-engine-db`:
the table holds 96 rows spanning 2026-08-24 to 2026-09-04, so retention did not remove them, and
seven rows from the same run's later minutes are present.

**Mechanism.** `packages/mcp-server/src/engine/diagnostics.ts`. `emit()` writes a stderr line, then
appends to the store inside a `try`. The `catch` never rethrows: it writes a second stderr line
naming the store as unreachable, and the function RETURNS THE ID anyway. The caller cannot tell a
persisted event from a lost one, because both return a string.

**Why it matters where it does.** `packages/mcp-server/src/tools/registry.ts` awaits that emit and
says why in its own comment: "The row is written BEFORE the response goes out. An identifier
resolving to nothing is worse than no identifier, and the emit is awaited here precisely so the
ordering is causal rather than probable." The await makes the ordering causal. It does not make the
write succeed, and the layer below converts a failed write into a successful-looking id.

**What it cost.** L-30 records four failures at ~10 000 ms across three vendors and cannot name the
mechanism. Two candidates fit the number: the runtime's default connect bound (`UND_ERR_CONNECT_TIMEOUT`,
measured 2026-09-04) and a resolver stall (`EAI_AGAIN` / `ENOTFOUND`). The two are told apart by the
error's own `cause`, which is exactly what the missing rows carried. L-23 stayed open for the same
reason: the attribution could not be checked.

**Not established.** Why those two appends failed is unknown. The stderr lines that would say are
not persisted anywhere queryable, which is the same gap one level up.

**Fixed 2026-09-04 — option 1, decided by the owner the same day.** Three options were open.
(1) Return `null` when the append fails, and render the client text without an id. (2) Return the id
with a marker the renderer prints. (3) Keep the id and write the lost event to a second channel.
Option 1 shipped: it is the smallest change and the only one that cannot mislead.

`emit()` now returns `string | null`. Three cases are kept apart. A stored event yields its id. A
REFUSED append yields `null`, and `toClientText` then omits the `(event …)` suffix. A profile with
no store at all still yields the id, because there the single operator reads stderr and the id was
printed on it — a channel that does not exist is not a channel that refused a write.

**What did not change.** The catch still never rethrows: a diagnostics outage may not refuse a
request. Both stderr lines are untouched, and they still carry the generated id and the reason the
table did not take it.

**Two documents were disagreeing, and that was the defect.** `tools/registry.ts` said an identifier
resolving to nothing is worse than no identifier; `TC-UNIT-05` pinned the opposite for the failure
path. The test now pins `null` and says why it changed. `interfaces.md` §5.4.3 stated the
identifier's travel unconditionally and now names the refused-write case and the no-store case.

**Proven by mutation, not by a green run.** Restoring `return id` in the catch kills two tests.
Collapsing the no-store case into `null` kills two others. A blanket `null` kills nine, including
both AC-50 identifier cases. One defect surfaced inside the suite itself: a fixture pinned `newId`
to one constant, so a second refusal's append was a primary-key conflict that the old code absorbed
while still returning an id — the defect was reproducing in our own test and passing.

**Reproduction.** Point the diagnostics store at an unreachable DSN, drive one refusal, and compare
the id in the client text against `SELECT id FROM onchain.diagnostics`.
