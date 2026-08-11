# 10. Deployment

> Part of [docs/ARCHITECTURE.md](../ARCHITECTURE.md).

### 10.1. Environments

Dev only, local, under Claude Code — this package has no staging or prod. The read-only PG client
**connects** to the dev-VM Supabase installation that already exists (CLAUDE.n8n.md); it neither
provisions nor migrates it. The engine is a read-only consumer of someone else's database.

### 10.2. CI/CD pipeline

The CI step order (`.github/workflows/ci.yml`) covers both packages through repo-wide `pnpm -r`
scripts, plus one structural step: `pnpm --filter @onchain-intel/core build` runs **before**
`typecheck` and `test`. `@onchain-intel/core` is exposed to consumers only through `main`/`types` →
`dist/*`, and `dist/` is gitignored — on a clean checkout it does not exist, so `typecheck` fails
with TS2307 and most mcp-server suites cannot resolve the package. The step is idempotent (plain
`tsc`) and preserves the invariant that the **mcp-server build runs after test** (the stdio E2E
spawns `tsx` on `src/`, never on `dist/`).

```
checkout(SHA-pin) → corepack enable (pnpm) → setup-node@22 (pnpm store cache)
  → pnpm install --frozen-lockfile
  → pnpm lint            # repo-wide, covers packages/core too
  → pnpm format:check    # repo-wide
  → pnpm --filter @onchain-intel/core build   # prerequisite: core dist, so the package resolves
  → pnpm typecheck       # pnpm -r typecheck — core, then mcp-server (topological)
  → pnpm test            # pnpm -r test — core (contract + registry + coverage + cache + SSRF +
                          #                rate-limit + budget-gate, all on fixtures/mocks), then
                          #                mcp-server (env / ping / e2e.stdio [spawn, tools/list +
                          #                ping] / e2e.inprocess [InMemoryTransport, fixture registry])
  → pnpm build           # pnpm -r build — core (plain tsc) → mcp-server (tsup + tsc, as in M0)
  → smoke:dist           # ping-only (rationale in §3.2)
```

Fixtures and mocks (D11) keep the entire test volume **network-independent**: 12 adapters, the
chain registry and coverage matrix, the cache, the SSRF gate, rate limiting, the budget gate, and
the tools exercised through **two** E2E suites. No secret is needed in CI (R-21:
`DUNE_API_KEY` / `COINGECKO_API_KEY` / `ONCHAIN_PG_URL` / `NANSEN_API_KEY` are read only by the
development script `record-fixture.mjs`, which runs **outside** CI). No network call may happen
during `pnpm test` — the same R-15/R-21 invariant M0 established, now enforced over many times more
code.

### 10.3. Configuration

`EnvSchema` (`mcp-server/src/env.ts`) is the single source of process configuration. Every key is
**optional** (R-23): `EnvSchema.parse({})` succeeds, so an empty env — or no `.env` at all — is a
valid configuration (UC-1), and an empty value (`KEY=`) behaves exactly like an unset key. The keys
the server reads today:

| Key                               | Purpose                                                                                      |
| --------------------------------- | -------------------------------------------------------------------------------------------- |
| `LOG_LEVEL`                       | `debug`/`info`/`warn`/`error`; reserved since M0 for stderr diagnostics                      |
| `COINGECKO_API_KEY`               | CoinGecko Demo contour (`api.coingecko.com`, `x-cg-demo-api-key`)                            |
| `COINGECKO_PRO_API_KEY`           | CoinGecko Pro contour (`pro-api.coingecko.com`, `x-cg-pro-api-key`); wins when both are set  |
| `DUNE_API_KEY`                    | the `dune` adapter — an interface stub, so the key is unused even when set                   |
| `ONCHAIN_PG_URL`                  | read-only Postgres DSN for `pg-history`, validated as a URL                                  |
| `DATA_DIR`                        | cache directory override (default `~/.onchain-intel`, never cwd-relative)                    |
| `NANSEN_API_KEY`                  | the only paid adapter                                                                        |
| `NANSEN_DAILY_CREDIT_CAP`         | self-imposed daily ceiling: unset → derived, a positive integer, or `off`                    |
| `NANSEN_VELOCITY_CREDITS_PER_MIN` | SEC-1 velocity brake, credits per 60 s window: unset → derived, a positive integer, or `off` |
| `NANSEN_MAX_CALLS_PER_MIN`        | Q-3 call brake, calls per 60 s window: unset → 60 (fixed, not derived), an integer, or `off` |
| `NANSEN_BUDGET_WARN_RATIO`        | stderr warn threshold as a fraction of the effective ceiling (default 0.8)                   |

`0` is invalid on all three Nansen limits. On a money guard it is one typo away from silently
removing the protection, and it ought to mean "spend nothing" rather than "spend without bound" —
so the disabling value is the word `off`.

`providers.config.ts` (`packages/core`) is the single source of routing, SSRF allowlist and rate
limits: changing a provider's priority or adding a host to the allowlist edits one file, not code
(R-4).

### 10.4. Deployment instructions (dev)

1. `git clone` → `pnpm install` at the repo root (workspaces bring up both packages).
2. `pnpm build` (`pnpm -r build`: `core` — plain `tsc`, `mcp-server` — tsup + tsc, topological
   order).
3. `pnpm lint && pnpm typecheck && pnpm test` — all green with no network and no secrets (UC-1,
   R-21).
4. Optionally, a `.env` with any of the keys in §10.3 — none is required; capabilities without a
   key degrade explicitly (UC-1 alt, R-24).
5. Attach to Claude Code as a local stdio MCP server, unchanged since M0
   (`node packages/mcp-server/dist/index.js` or `tsx packages/mcp-server/src/index.ts`).
6. Call any of the 19 tools → a canonical response; a repeat call with the same normalized
   arguments within the TTL → `_meta.cache.status === 'hit'` (UC-3, ROADMAP exit criterion).
