---
id: RF-2
type: known-issue
status: open
opened_at: 2026-07-25
category: workflow-docs
severity: SEV-3
slug: rf-2-m2-evidence-records-drifted-from-the-shipped-commit
---

# RF-2 — M2's own evidence records describe an earlier tree than the one that shipped

**Symptom.** TASK-005 built several mechanisms specifically to make the milestone auditable after the
fact. Four of them now describe a state that is not what was committed, so the audit they exist to
support cannot be performed against the shipped code.

| # | Record | What it says | What is true |
| --- | --- | --- | --- |
| 1 | `task-005-7-live-verification-evidence.md` "Final SHA" | `4f3a923d…` | the file in `4c51126` hashes to `7bc03cd8…` — an unlogged edit landed between the last recorded override and the commit. Now annotated in place as a **provenance break**, not re-baselined silently. |
| 2 | same file, offline (network-blocked) proof | core 27/310 + mcp-server 13/143 = **453/453**, claimed to be "the final, committed state" | the committed state was **505**; commit `15b8dfa` (Q-2) landed 12 files' worth of tests afterwards with no offline re-run. **CLOSED 2026-07-25** — re-run against the shipped tree: **515/515**, zero outgoing calls, with the block hardened to cover `node:http`/`node:https` as well as `fetch` and its propagation re-verified by a probe test first. |
| 3 | R-44's acceptance row + `docs/TASK.md` §1 п.4 | live verification is capped at **≤30 credits, hard gate** | actual spend was **41cr**. Owner-authorized tranche by tranche and stated honestly in the evidence file and the ROADMAP — but the requirement text was never amended, so the RTM row read as met when it is not. **CLOSED 2026-07-25** — the R-44 acceptance row, `TC-VERIFY-01`, and TASK's status block now all carry the deviation explicitly. The ≤30 wording itself was deliberately NOT rewritten: amending a constraint retroactively to match what happened erases the fact that it was exceeded. |
| 4 | `docs/PLAN.md` / `docs/TASK.md` | all 17 DoD checkboxes unchecked; TASK status still `Draft (готов к Architecture-фазе)` | `ROADMAP.md` declares M2 ✅ ВЫПОЛНЕН. Neither file was touched by any M2 commit. **CLOSED 2026-07-25** — 16 of 17 boxes checked (R-47 stays open: deliberately deferred), both status fields now read ВЫПОЛНЕН, and `PLAN.md` §7 records the actual gate results plus every deviation from the plan as written. |

**Why this is a workflow-docs issue and not a code defect.** None of it changes runtime behaviour;
the RTM completeness audit independently confirmed that R-29…R-46 all have real implementing code
and at least one executing test. What is damaged is the **traceability contract** — the thing that
lets a later reader (or a later agent) tell "verified" apart from "asserted". Item 1 is the sharpest:
a SHA chain whose purpose is to detect silent test-tuning has a window in which it cannot.

**Raised by:** `/vdd-multi` cycle 4 (2026-07-25), RTM completeness audit — items G-1, G-2, G-11 and
the PLAN/TASK status observation.

## Status — three of four closed 2026-07-25

- ~~Re-run the network-blocked suite against the shipped commit and record the real counts~~ — **done**
  (item 2): 519/519, zero outgoing calls, block hardened and probe-verified.
- ~~Record R-44's overrun where the requirement is stated~~ — **done** (item 3): the acceptance row,
  `TC-VERIFY-01` and TASK's status block all carry it. The ≤30 wording stays as written on purpose.
- ~~Close out the DoD checkboxes and the two status fields~~ — **done** (item 4), plus `PLAN.md` §7
  now records actual gate results and every deviation from the plan.
- **Item 1 stays open and cannot be repaired retroactively.** The SHA chain is annotated in place;
  the assertions were independently re-derived from the vendor spec during cycle 4, which is
  corroboration, not proof. Going forward the recorded hash is taken from the **committed blob**
  (`git show <sha>:<path> | shasum -a 256`), not the working tree — which is what made the original
  break invisible. Verified for `403441c`: recorded `e24d077a…` equals the committed blob.

This issue stays `open` on the strength of item 1 alone. Closing it would require a provenance
mechanism that cannot silently skip an edit — e.g. hashing in a pre-commit hook rather than by hand.

## Related

- `docs/onchain-analytics/raw/task-005-7-live-verification-evidence.md` — carries the in-place
  annotation for item 1 and the new post-cycle-4 SHA.
- `docs/tasks/task-005-7-fixtures-live-verification.md` — declares `TC-VERIFY-06/08/09`, whose
  acceptance is what drifted.
