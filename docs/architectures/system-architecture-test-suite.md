> Part of [docs/ARCHITECTURE.md](../ARCHITECTURE.md) → [system-architecture.md](system-architecture.md).
> Heading levels are the parent document's, unchanged: the section numbers are how
> every other document addresses this text.

#### Test suite

**1161 tests** — `packages/core` 876, `packages/mcp-server` 285 (D11, R-21/R-22).
_(measured 2026-08-02, TASK-011; ungated. No test can count both packages from inside one of them,
so this figure is a dated snapshot in the manner of ADR-002's counts, not a checked claim. It read
1106/230 until cycle 4 of TASK-011's adversarial review.)_

Two of them are **documentation** gates, added in TASK-009's doc pass because the drift they catch
had twice been caught by a human instead. The first is `core/test/ttl-coverage.test.ts` (every
routed capability has an EXPLICIT TTL row, never the fallback). The second is
`mcp-server/test/docs-counts.test.ts` (the counts these documents state, and the tool/adapter names
they must contain, compared against the code).

- **`packages/core/test/`:** one `*.contract.test.ts` per adapter that has a live/fixture/mock path
  — golden normalization from "raw fixture response" to "canonical object" (D11).
  `test/fixtures/<adapter>/*.json` are committed: `coingecko`, `dexscreener`, `defillama`,
  `rpc-evm`, `rpc-solana`, `platform-explorer` and `nansen` are real HTTP fixtures. `dash-platform`
  is a hand-built fixture shaped after the addendum. `pg-history` is not an HTTP fixture but a
  mocked pg client with fixed rows. `dune` has no fixture and no contract test.
  `registry.fallback.test.ts` covers R-11: `dash-platform.isAvailable()` is deterministically
  `false` (the real configuration, not a mocked unavailability), so the capability answers through
  `platform-explorer` — a run of a genuine, not simulated, fallback path. `cache.test.ts` covers
  hit/miss/TTL on both levels, including `pg-history` (the provider exists in the `providers`
  registry, so the FK holds). `safe-fetch.test.ts` covers the SSRF gate (allowlist + redirect
  chain), `rate-limit.test.ts` the throttle, `chain-address.test.ts` checksum/base58/invalid
  addresses, and the chain-registry, coverage and nansen budget/reconciliation suites the TASK-006
  and M2 surfaces.
- **`packages/core/scripts/record-fixture.mjs`** (R-22) — a manual dev script: one live provider
  call, saving both the fixture **and** the evidence (real fields/endpoint/date of recording, not an
  assumption) next to it in `test/fixtures/<adapter>/<name>.evidence.md`. **Not part of CI.**
- **`packages/mcp-server/test/e2e.stdio.test.ts`** (spawn; the mechanism is unchanged from M0) —
  spawns `src/index.ts` as a child process through `tsx`. It asserts that `tools/list` contains
  exactly the **twenty-two** tools **derived from `toolSpecs`** — `toHaveLength(expected.length)` at
  `packages/mcp-server/test/e2e.stdio.test.ts:162`, `expect(tools, ADD_A_TOOL).toHaveLength(expected.length);`, not a hand-written literal, since TASK-011 made the inventory data — and keeps running
  `onchain_ping` end to end. It deliberately does **not** call the other tools over this transport:
  the `registry` injection is in-process. Using the real registry inside a spawned process would
  mean live network calls under CI — a violation of R-21.
- **`packages/mcp-server/test/e2e.inprocess.test.ts`** — no process spawn: the SDK's
  `InMemoryTransport.createLinkedPair()` (part of `@modelcontextprotocol/sdk`, no new dependency)
  plus `Client` and `createServer({ env, version, registry: fixtureRegistry })` **in the test's own
  process**. `fixtureRegistry` implements the same public `CapabilityRegistry.resolve()` contract,
  assembled from `packages/core/test/fixtures/`. It exercises the M1 tools and the M2 paid tools
  fully through the MCP protocol (input validation, `structuredContent`, `_meta.cache`,
  `_meta.budget`, the `isError` path when a capability is unavailable) with **zero network calls**
  (R-21). That count is reachable because the injection is physically possible with no process
  boundary. This — not the
  spawn suite — is the actual "E2E extended to the tools with a fixture-backed registry".
- **`scripts/smoke-dist.mjs`** stays ping-only. Its job is to prove that the _built_
  `dist/index.js` starts at all and speaks the wire protocol (M0's post-build blind spot).
  Extending it to real network calls against live providers would reintroduce exactly the CI network
  dependency R-21 forbids, and `e2e.inprocess.test.ts` (running on `tsx`, not on `dist/`) already
  covers tool behaviour against fixtures.
