---
id: RF-4
type: known-issue
status: fixed
opened_at: 2026-07-28
category: workflow-docs
severity: SEV-2
slug: rf-4-smoke-dist-ci-gate-still-asserts-8-tools-so-it-has-been-red-on-main-since-task-006
component: repo-gates
evidence_paths:
  - packages/mcp-server/scripts/smoke-dist.mjs
  - .github/workflows/ci.yml
resolved_at: 2026-07-28
resolved_by: backlog closeout 2026-07-28
---

# RF-4 — the smoke:dist CI gate still asserts 8 tools, so it has been red on main since TASK-006

> **RESOLVED 2026-07-28.** `expectedNames` now lists all 11 tools, the count is **derived** from
> that list instead of written a second time as a literal, and the failure message names the
> missing/unexpected diff instead of dumping every tool's JSON Schema.

## Symptom

`pnpm --filter @onchain-intel/mcp-server smoke:dist` — a **CI gate**
(`.github/workflows/ci.yml`, the step after `pnpm build`) — fails:

```
smoke-dist: FAIL: tools/list did not return exactly the 8 expected tools [...]: got [<~20KB of tool schemas>]
```

The server is correct; the gate is stale. `scripts/smoke-dist.mjs` was written at M2 when there
were 8 tools. TASK-006 added `onchain_list_chains` + `onchain_chain_tvl` and TASK-007 added
`onchain_dex_volume`; each updated the in-process suites (`e2e.stdio`, `e2e.inprocess`) and none
updated this script. So `main` has carried a red CI gate for two tasks.

## Why it went unnoticed for two tasks

This is the only gate in the repo that **nothing local runs**. `pnpm test` does not invoke it; it
exists solely as a CI step, and it must run after `pnpm build` because it executes `dist/index.js`.
Both tasks defined their regression exit as "the five gates" — `test`, `typecheck`, `lint`,
`format:check`, `build` — a list that does not include `smoke:dist`. Every one of those five was
green the whole time.

Two further factors made it easy to miss even when it did fail:

1. **The count was written twice.** `expectedNames` (the list) and `tools.length !== 8` (a literal)
   had to be edited together, with nothing forcing that. Adding a name and forgetting the number
   would have produced the same failure from the opposite direction.
2. **The failure message hid the answer.** It interpolated the whole `tools` array — every tool's
   complete input and output JSON Schema — so the one piece of information a reader needs (*which*
   tool is unaccounted for) was buried in ~20KB of scrollback.

## Reproduction

```sh
git stash push packages/mcp-server/scripts/smoke-dist.mjs
pnpm --filter @onchain-intel/core build && pnpm --filter @onchain-intel/mcp-server build
pnpm --filter @onchain-intel/mcp-server smoke:dist   # -> FAIL, exit 1
git stash pop
```

## Fix path

`packages/mcp-server/scripts/smoke-dist.mjs`:

1. `expectedNames` extended to the real 11, kept sorted.
2. `tools.length !== expectedNames.length` — the count is derived, so the two can no longer drift.
3. The error names `Missing:` / `Unexpected:` by tool name, and says what to do when a tool was
   added deliberately.
4. The module docstring's "exactly 8 tools" trace updated to the current set.

## Related

- **RF-3** — the same family, one gate over: a gate left red on `main` by merged commits. RF-3 was
  about gates that *are* in the five-gate list; this one is about a gate that is **not**, which is
  why it survived longer.
- The five-gate regression exit used by TASK-006/TASK-007 acceptance.

## Do-not

- Do **not** re-introduce a literal tool count beside the list of names. One source, derived count.
- Do **not** "fix" a future failure of this gate by deleting the assertion. A tool silently
  vanishing from `tools/list` in the built artifact is exactly what it is for.
