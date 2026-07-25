# Fixture evidence: nansen/tgm-holders.empty-labels — PROVISIONAL, spec-derived, NOT LIVE

- provenance: spec-derived, NOT live. Not produced by `scripts/record-fixture.mjs` — task
  005-4 runs zero live Nansen calls. Replaced/complemented by a genuinely recorded live `POST
/api/v1/tgm/holders` response in task 005-7 (that task's own budget table only records ONE
  live `tgm/holders` call, grouped under `smart-money.flows` — this specific "0 labels" shape may
  remain provisional even after 005-7, per that task's own scope; not this task's concern).
- authored_at: 2026-07-24
- modeled on: the SAME `TGMHoldersResponse`/`TGMHolder` schema as `tgm-holders.json` (see that
  fixture's own evidence for the schema reference), but the ONE holder row here deliberately
  OMITS `address_label` entirely — a structurally valid `TGMHolder` (the field is optional per the
  vendor schema) representing "this holder has no smart-money/exchange/etc. label" (R-32 "0
  labels is a valid result, not an error"). `warnings[]` (also optional on
  `TGMHoldersResponse`) is populated here to additionally exercise that this adapter's own
  normalization never chokes on that extra top-level field (anti-corruption — dropped, not
  forwarded).
- consumed by: `packages/core/test/nansen.contract.test.ts` (TC-CONTRACT-03, R-32 "0 labels" case)
  — merged with `search-general.empty.json` into an `EntityLabel[]` proving an empty/no-label
  result is valid, never a thrown error.
