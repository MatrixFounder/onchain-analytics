---
id: WI-10
type: work-item
status: open
opened_at: 2026-07-27
slug: wi-10-mcp-server-tests-resolve-core-to-dist
effort: S
value: 'removes a silent stale-build trap that costs a debugging cycle per occurrence'
---

# mcp-server tests resolve @onchain-intel/core to dist, so core src changes are invisible until pnpm build

**mcp-server tests resolve `@onchain-intel/core` to its BUILT `dist`, not to `src`** — so a change in `packages/core/src` is invisible to them until `pnpm build` runs. Observed in TASK-007 task 007-6: five freshly written `onchain_dex_volume` tool tests failed with `out.ok === false` and no diagnostic pointing at staleness. The handler, the schemas and the adapter were all correct; `packages/core/dist` simply predated the new capability. Debugging went through a throwaway probe test before the cause was found. `packages/core`'s own tests import from `../src/` and were green the whole time, which actively misleads: the same code is green in one package and red in another for a reason neither failure message mentions. **Why it is a work-item and not a defect:** nothing is behaving incorrectly — the workspace link points at the package's published entry point, which is a legitimate setup. The cost is a silent trap, paid once per person who edits core and runs mcp-server tests without rebuilding. **Candidate fixes** (either suffices; the second is cheaper to keep honest): 1. a `pretest` script in `packages/mcp-server` that builds `@onchain-intel/core` first — correct, but slows every run; 2. a `resolve.alias` in `packages/mcp-server/vitest.config.ts` mapping `@onchain-intel/core` to `../core/src/index.ts` for TESTS only, leaving the built artifact for production resolution. This also makes the mcp-server suite test the same source the core suite does. Whichever is chosen, the acceptance is the same: edit a symbol in `packages/core/src`, run `pnpm --filter @onchain-intel/mcp-server test` **without** building, and observe the change take effect (or a failure that names the staleness).
