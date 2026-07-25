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

| #   | Record                        | Status                |
| --- | ----------------------------- | --------------------- |
| 1   | Golden-test SHA chain         | **open** — see 1 below |
| 2   | Offline-run proof             | closed 2026-07-25     |
| 3   | R-44's ≤30cr acceptance row   | closed 2026-07-25     |
| 4   | DoD checkboxes + status fields | closed 2026-07-25     |

**1 — Golden-test SHA chain.** `task-005-7-live-verification-evidence.md` logs a "Final SHA" of
`4f3a923d…`. The file actually committed in `4c51126` hashes to `7bc03cd8…`, so at least one
unlogged edit landed between the last recorded override and the commit. Annotated in place as a
provenance break rather than silently re-baselined. **Cannot be repaired retroactively** — see the
status section below.

**2 — Offline-run proof.** The same file recorded core 27/310 + mcp-server 13/143 = **453/453** and
called it "the final, committed state". The committed state was **505**: commit `15b8dfa` (Q-2)
landed twelve files' worth of tests afterwards with no offline re-run.

Closed by re-running against the shipped tree — **519/519, zero outgoing calls**, with two
hardenings that the original run lacked:

- the block now covers `node:http`/`node:https`, not only `fetch` (a direct `http.request` would
  have slipped past a fetch-only stub);
- its propagation into the vitest worker is probe-verified *before* the suite runs, so a green
  result cannot come from an inert block.

**3 — R-44's ≤30cr ceiling.** The requirement states a hard gate of ≤30 credits; actual spend was
**41cr**. Each tranche was owner-authorized and the figure was stated honestly in the evidence file
and the ROADMAP — but the requirement text itself was never amended, so the RTM row read as met.

Closed by recording the deviation at all three places where the constraint is stated: the R-44
acceptance row, `TC-VERIFY-01`, and TASK's status block. The ≤30 wording was **deliberately not
rewritten** — amending a constraint retroactively to match what happened erases the fact that it
was exceeded.

**4 — DoD checkboxes and status fields.** All 17 boxes were unchecked and `docs/TASK.md` still read
`Draft (готов к Architecture-фазе)` while `ROADMAP.md` declared M2 ✅ ВЫПОЛНЕН; neither file was
touched by any M2 commit.

Closed: 16 of 17 boxes checked (R-47 stays unchecked — deliberately deferred, ticking it would be
false), both status fields updated, and `PLAN.md` §7 now records the actual gate results plus every
deviation from the plan as written.

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
