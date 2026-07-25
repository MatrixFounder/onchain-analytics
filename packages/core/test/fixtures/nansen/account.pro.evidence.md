# Fixture evidence: nansen/account.pro — PROVISIONAL, spec-derived, NOT LIVE

- provenance: spec-derived, NOT live — hand-authored, not a real Pro-plan account response (no
  live Pro subscription exists to record from in M2's Development phase). Not produced by
  `scripts/record-fixture.mjs`.
- authored_at: 2026-07-23
- purpose: TC-UNIT-05 (system-architecture.md §3.2 UC-9 — "plan upgrade without a code change").
  `credits_remaining: 100000` is an arbitrary, clearly-not-a-real-balance round number, chosen only
  to be comfortably larger than the 150cr `premium_labels=true` refusal case's price — the exact
  value carries no other meaning.
- consumed by: `packages/core/test/nansen.budget-gate.test.ts` — swapping ONLY this fixture in for
  `account.free.json` (zero production code changes) must flip the SAME 150cr request from a
  refusal to a success.
