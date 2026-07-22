# Fixture evidence: dash-platform/current-state — HAND-BUILT, NOT RECORDED LIVE

- status: **hand-authored**, not produced by `scripts/record-fixture.mjs` and not a live capture.
  There is no live gRPC transport for `dash-platform` in M1 (F-3, ARCHITECTURE.md §3.2/§11) — the
  `NotImplementedInM1Error` its own HTTP step throws makes a real recording impossible by design.
- authored_at: 2026-07-22
- modeled on: the two DAPI RPC methods ARCHITECTURE.md §3.2's decision text names explicitly —
  `getShieldedPoolState` (current shielded-pool balance + `metadata.height`) and
  `getTotalCreditsInPlatform` (total Platform credits + `metadata.height`) — per
  `docs/onchain-analytics/raw/providers-addendum-2026-07-20.json` (the `providers-addendum`
  research artifact) and `raw/platform.proto` line references cited there (not fetched again
  here — this fixture only needs plausible field NAMES/shapes, not a byte-exact schema, since
  `dash-platform.fetch()` is unreachable through `CapabilityRegistry` in M1 regardless of this
  fixture's exact shape).
- `identitiesCount`/`dataContractsCount`/`documentsCount` are NOT named RPCs in the addendum —
  included as plain top-level counters (documented implementation choice, developer-guidelines
  §1.6) purely so this one fixture can golden-test `normalize()`'s other three `platform.*`
  capabilities too, reusing the same simple "count" shape `platform-explorer`'s own `/status`
  live fixture (`test/fixtures/platform-explorer/state.json`, recorded 2026-07-22) already
  returns for the equivalent fields — the numeric values here were copied from that SAME live
  `/status` recording (not invented) for internal consistency across the two adapters' fixtures,
  even though this file itself is not a live capture of `dash-platform`.
- capabilities exercised by `test/dash-platform.contract.test.ts` against this ONE fixture:
  `privacy.shielded_pool` (`getShieldedPoolState.poolBalance`), `platform.credits`
  (`getTotalCreditsInPlatform.credits`), `platform.identities`, `platform.contracts`,
  `platform.documents`.
