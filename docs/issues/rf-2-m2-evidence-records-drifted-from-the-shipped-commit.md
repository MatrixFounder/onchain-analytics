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
| 3 | R-44's acceptance row + `docs/TASK.md` §1 п.4 | live verification is capped at **≤30 credits, hard gate** | actual spend was **41cr**. Owner-authorized tranche by tranche and stated honestly in the evidence file and the ROADMAP — but the requirement text was never amended, so the RTM row reads as met when it is not. |
| 4 | `docs/PLAN.md` / `docs/TASK.md` | all 17 DoD checkboxes unchecked; TASK status still `Draft (готов к Architecture-фазе)` | `ROADMAP.md` declares M2 ✅ ВЫПОЛНЕН. Neither file was touched by any M2 commit. |

**Why this is a workflow-docs issue and not a code defect.** None of it changes runtime behaviour;
the RTM completeness audit independently confirmed that R-29…R-46 all have real implementing code
and at least one executing test. What is damaged is the **traceability contract** — the thing that
lets a later reader (or a later agent) tell "verified" apart from "asserted". Item 1 is the sharpest:
a SHA chain whose purpose is to detect silent test-tuning has a window in which it cannot.

**Raised by:** `/vdd-multi` cycle 4 (2026-07-25), RTM completeness audit — items G-1, G-2, G-11 and
the PLAN/TASK status observation.

## What closing this looks like

- ~~Re-run the network-blocked suite against the shipped commit and record the real counts~~ —
  **done 2026-07-25** (item 2).
- Amend or formally waive R-44's ≤30cr row with the authorized figure, so the RTM stops asserting an
  unmet constraint (item 3).
- Close out `docs/PLAN.md`'s DoD checkboxes and move `docs/TASK.md` off `Draft` (item 4).
- Item 1 cannot be repaired retroactively — it is annotated in place and the assertions were
  re-derived from the vendor spec during cycle 4, which is corroboration, not proof. The forward fix
  is to hash the **committed blob**, not the working tree.

## Related

- `docs/onchain-analytics/raw/task-005-7-live-verification-evidence.md` — carries the in-place
  annotation for item 1 and the new post-cycle-4 SHA.
- `docs/tasks/task-005-7-fixtures-live-verification.md` — declares `TC-VERIFY-06/08/09`, whose
  acceptance is what drifted.
