# Fixture evidence: nansen/smart-money-netflow — LIVE (task 005-7, R-44, DF-1 root-cause-#2 confirmation)

- provenance: live, but recorded via a **direct diagnostic call** made by the coordinator during
  DF-1 root-cause-#2 confirmation (2026-07-24) — **NOT** through `scripts/record-fixture.mjs` /
  `createNansenAdapter`'s production path (unlike this fixture's sibling `tgm-holders.json`, which
  WAS recorded through the production path in an earlier session of this same task — see that
  file's own evidence). This call's sole purpose was to isolate root cause #2 (case-sensitive
  `token_address` matching on this one endpoint): the identical request was sent twice, differing
  ONLY in the `filters.token_address` casing — checksummed `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48`
  returned `data: []`; lowercase `0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48` (the body captured
  here) returned this real, populated row. `postSmartMoneyNetflow` (`endpoints.ts`) now sends
  `token_address` lowercased unconditionally, so this recorded body is exactly what the production
  path itself sends today — the fixture content is genuine and representative, only its _recording
  mechanism_ was a direct diagnostic call rather than a `record-fixture.mjs` invocation. TC-UNIT-07
  (`nansen.contract.test.ts`) is the unit assertion that closes this provenance gap for free: it
  asserts `postSmartMoneyNetflow` constructs exactly this request shape (lowercase `token_address`,
  `include_stablecoins`/`include_native_tokens: true`, `chains: [chain]`) against a fake
  `fetchImpl` — proving the production code genuinely builds the request this fixture's real
  response was recorded against, without spending a further live credit to re-record it through
  `record-fixture.mjs` itself.
- recorded_at: 2026-07-24 (diagnostic call, DF-1 root-cause-#2 confirmation)
- endpoint: POST /api/v1/smart-money/netflow
- http_status: 200
- capability: smart-money.flows (diagnostic call outside the normal capability dispatch — chain
  `ethereum`, `token_address` filter set to `0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48`)
- request_body: `{"chains":["ethereum"],"filters":{"token_address":"0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48","include_stablecoins":true,"include_native_tokens":true}}`
- response_fields: data, pagination
- x_nansen_credits_used: 5
- cost_table_expected_free: 5
- sanity_check: MATCH
