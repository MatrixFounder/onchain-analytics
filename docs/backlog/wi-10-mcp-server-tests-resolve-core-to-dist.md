---
id: WI-10
type: work-item
status: done
opened_at: 2026-07-27
slug: wi-10-mcp-server-tests-resolve-core-to-dist
effort: S
value: 'removes a silent stale-build trap that costs a debugging cycle per occurrence'
resolved_at: 2026-07-28
resolved_by: backlog closeout 2026-07-28
---

# mcp-server tests resolve @onchain-intel/core to dist, so core src changes are invisible until pnpm build

> **DONE 2026-07-28 — the acceptance is met in its strong form: the whole mcp-server suite now
> passes without building core at all.** Two mechanisms, because the package has two kinds of test.
>
> **In-process tests** — candidate fix 2: `packages/mcp-server/vitest.config.ts` aliases
> `@onchain-intel/core` to `../core/src/index.ts` for tests only, leaving `dist` as the production
> entry point. `test/core-resolves-to-src.test.ts` keeps it honest by throwing from a function
> inside core and asserting the stack frame lands in `core/src`, never `core/dist`; `packages/core`
> builds with `tsc` (mirrored tree, no source maps), so the frame discriminates exactly. Verified
> red with the alias removed, and its message names the cause the original failure did not.
>
> **The spawn suite** (`e2e.stdio.test.ts`) — a child process cannot receive a Vite alias, so it is
> launched as `tsx --tsconfig tsconfig.e2e.json`, whose `paths` map core to source. This restores
> the property that file's own header already claimed ("never `dist/` … must not depend on a build
> artifact that doesn't exist yet") and which was false transitively through core. Proven by making
> `dist` genuinely stale — a real source edit, no rebuild — and watching all five tests pass.
>
> **The residual risk is silent, so it is tested, not trusted.** If a future tsx stops honouring
> `--tsconfig`, resolution falls back to `dist` and the suite would pass against a stale build
> again. `test/fixtures/core-resolution-probe.ts` runs under the identical invocation and asserts
> which copy was resolved; verified red (`resolved:dist`) with the flag removed.
>
> **Rejected on the way, recorded so it is not re-tried:** an mtime freshness check ("is
> `dist/index.js` newer than the newest file under `core/src`? if not, tell the developer to
> rebuild"). It is unsound — `tsc` does not rewrite an output whose content did not change, so an
> edit that leaves `dist/index.js` byte-identical, or a bare `touch`, leaves the check permanently
> tripped and the suite red with a message telling you to run a build that cannot clear it.
> Observed exactly that, after a build. It was written, shipped into a gate run, and removed the
> same hour.
>
> Candidate fix 1 (a `pretest` build hook) was not needed: nothing here builds anything.

**mcp-server tests resolve `@onchain-intel/core` to its BUILT `dist`, not to `src`** — so a change in `packages/core/src` is invisible to them until `pnpm build` runs. Observed in TASK-007 task 007-6: five freshly written `onchain_dex_volume` tool tests failed with `out.ok === false` and no diagnostic pointing at staleness. The handler, the schemas and the adapter were all correct; `packages/core/dist` simply predated the new capability. Debugging went through a throwaway probe test before the cause was found. `packages/core`'s own tests import from `../src/` and were green the whole time, which actively misleads: the same code is green in one package and red in another for a reason neither failure message mentions. **Why it is a work-item and not a defect:** nothing is behaving incorrectly — the workspace link points at the package's published entry point, which is a legitimate setup. The cost is a silent trap, paid once per person who edits core and runs mcp-server tests without rebuilding. **Candidate fixes** (either suffices; the second is cheaper to keep honest): 1. a `pretest` script in `packages/mcp-server` that builds `@onchain-intel/core` first — correct, but slows every run; 2. a `resolve.alias` in `packages/mcp-server/vitest.config.ts` mapping `@onchain-intel/core` to `../core/src/index.ts` for TESTS only, leaving the built artifact for production resolution. This also makes the mcp-server suite test the same source the core suite does. Whichever is chosen, the acceptance is the same: edit a symbol in `packages/core/src`, run `pnpm --filter @onchain-intel/mcp-server test` **without** building, and observe the change take effect (or a failure that names the staleness).
