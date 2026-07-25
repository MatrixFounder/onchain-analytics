# Fixture evidence: nansen/search-general.empty — PROVISIONAL, spec-derived, NOT LIVE

- provenance: spec-derived, NOT live. Not produced by `scripts/record-fixture.mjs` — task
  005-4 runs zero live Nansen calls. Replaced/complemented by a genuinely recorded live `POST
/api/v1/search/general` response in task 005-7 (that task records a `query`-only, 0cr call —
  this specific "0 results" shape may remain provisional even after 005-7, not this task's
  concern).
- authored_at: 2026-07-24
- modeled on: `docs/onchain-analytics/raw/nansen-openapi-2026-07-23.json`'s
  `components.schemas.GeneralSearchResponse` — `tokens`/`entities` both default to `[]` on the
  vendor schema itself when a search matches nothing; `total_results: 0` is the response's own
  ONLY required field, set consistently with the two empty arrays.
- consumed by: `packages/core/test/nansen.contract.test.ts` (TC-CONTRACT-03, R-32 "0 labels" case)
  — merged with `tgm-holders.empty-labels.json` into an `EntityLabel[]` proving an empty/no-label
  result is valid, never a thrown error.
