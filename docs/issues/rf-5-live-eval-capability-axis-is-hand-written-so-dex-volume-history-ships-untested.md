---
id: RF-5
type: known-issue
status: fixed
opened_at: 2026-07-28
category: workflow-docs
severity: SEV-3
slug: rf-5-live-eval-capability-axis-is-hand-written-so-dex-volume-history-ships-untested
component: eval-harness
fingerprint: 318bf93cebe8900e
evidence_paths:
  - packages/mcp-server/eval/capabilities.mjs
  - packages/mcp-server/eval/run.mjs
  - packages/mcp-server/eval/checks.mjs
  - packages/mcp-server/test/eval-capability-coverage.test.ts
  - packages/mcp-server/eval/README.md
auto_fixable: true
finding_ref: fnd-20260728-012149-318bf93c
resolved_at: 2026-07-28
resolved_by: dex.volume.history wired + an unwired-capability reporter at run time and an offline CI guard
---

> **RESOLVED 2026-07-28**, both parts of the fix path, plus a third the fix path did not ask for.
>
> 1. `dex.volume.history` is wired into `CAPABILITY_TOOLS` (`days: 7`, no probe data needed, so every
>    curated chain is exercised), and `checks.mjs` grades it: the tool's own
>    `points + gapDays === window.days` invariant, zero points, a hole inside the window, a
>    non-numeric newest point, a lost aggregates block, and the `truncated` drift flag. Fed the
>    pre-fix [L-5](l-5-dex-volume-empty-chart-reports-zero-gapdays-breaking-its-own-invariant.md)
>    payload it returns `degraded` naming both problems — the check is verified against the defect it
>    exists for, not just against a healthy answer.
> 2. An unmapped capability is now VISIBLE: `unwiredCapabilities()` walks what the selected chains
>    declare, subtracts what is exercised and what is excluded on the record, and prints each leftover
>    as its own `no-probe` row with the chains that declare it. The paid exclusions are printed every
>    run too — an exclusion nobody is reminded of is indistinguishable from an oversight.
> 3. **The part that actually prevents recurrence:** `test/eval-capability-coverage.test.ts` runs in
>    `pnpm test`, offline, and fails when a tool serves a capability that is neither wired nor
>    excluded. The tool side is DERIVED by scanning `src/tools/*.ts` for the `CAPABILITY` constant,
>    so it cannot drift the way the two hand-written lists did. Verified by mutation: removing the
>    `dex.volume.history` entry turns it red with `dex.volume.history (dex-volume.ts)`. This half
>    matters most — the eval is deliberately not in CI, so a run-time reporter alone speaks only when
>    someone remembers to run it, which is not the path a new tool travels.
>
> The capability axis is now data in `eval/capabilities.mjs` (importing it starts no server, which is
> what lets the test read it). Live run after the fix: **0 error, 0 degraded, exit 0** — 57 ok, 15
> unsupported, 4 no-probe (two missing probe rows, two named holes: `token.metadata`, `pool.info`).

# RF-5 — the live eval derives chains from the registry but capabilities from a hand-written list, so dex.volume.history ships untested

**Symptom.** `pnpm eval` — the only harness in this repo that asks a real provider a real question —
never exercises `dex.volume.history`. Not as a failure, not as `no-probe`: the capability produces
**no row at all**. A full run on 2026-07-28 printed 60 rows (44 ok / 14 unsupported / 2
rate-limited / 2 no-probe) and none of them was the DEX-volume tool, although 11 of the 12 curated
chains declare that capability.

The cause is that `CAPABILITY_TOOLS` (`packages/mcp-server/eval/run.mjs:47`) is a hand-written list
of five capabilities, and the per-chain loop iterates **that list**, not the capabilities the
registry declares. Only the CHAIN axis is derived from the live registry. The harness's own README
says otherwise:

> The matrix is **derived from the live registry**, not hand-written: for each chain the eval asks
> `onchain_list_chains` which capabilities that chain declares, and exercises exactly those. A chain
> or capability added later is covered automatically.
> — `packages/mcp-server/eval/README.md`

So the file that exists to catch a vendor silently changing a payload shipped a new provider surface
with zero live coverage, and the report gives no hint of the hole — a green eval reads as "the free
contour is verified" when one eleventh of it was never called.

**Reproduction.**

```sh
cd "$(git rev-parse --show-toplevel)"
# 1. offline: the capability axis is a literal list, and the newest capability is not in it
grep -n "capability: '" packages/mcp-server/eval/run.mjs
grep -n "dex.volume.history" packages/mcp-server/eval/run.mjs \
  && echo "COVERED — this issue is fixed" \
  || echo "NOT COVERED: the eval has no dex.volume.history case"
# 2. live (network, ~40s): the registry declares it for the eval's own chains, yet no row appears
ONCHAIN_EVAL_CHAINS=ethereum,solana pnpm eval | grep "dex.volume.history" \
  && echo "COVERED" \
  || echo "NOT COVERED: no dex.volume.history row in the report"
```

**Workaround.** Probe the capability by hand — a `days: 30` sweep over the covered chains through
the adapter takes ~40s keyless and is what surfaced this. That is not a gate, and nobody will run it
on a schedule.

**Fix path.** Two parts, and the second is the one that keeps this from recurring:

1. add a `dex.volume.history` entry to `CAPABILITY_TOOLS` (`onchain_dex_volume`,
   `args: (c) => ({ chain: c, days: 7 })` — no per-chain probe data needed, so every covered chain
   is exercised for free) plus a `checks.mjs` verdict: `degraded` when `points === 0` with a series
   requested, or when `points + gapDays !== window.days`;
2. make an unmapped capability **visible** instead of absent. Iterate the union of what the chains
   declare and report a capability with no `CAPABILITY_TOOLS` entry as `no-probe` with
   "no eval case wired". That is the same rule `onchain-verify` applies to a metric with no declared
   cadence (a defect, not an absence), and it is what the README already promises.

Mechanical and gate-verifiable (the eval's own exit code), hence `auto_fixable`.

**Related.** The README's `poolBalance` precedent is this exact failure mode one level down: a
provider returning 200 while a field vanished. Sibling of the `defillama-dex-volume` invariant defect
filed from the same run — the empty-series/`gapDays` disagreement is precisely what check (1) above
would have caught. See also
[RF-3](rf-3-pnpm-lint-and-format-check-were-left-red-on-main-by-two-merged-commits-blocking-the-next-task-s-regression-exit.md)
and [RF-4](rf-4-smoke-dist-ci-gate-still-asserts-8-tools-so-it-has-been-red-on-main-since-task-006.md)
— the same family: a gate whose scope silently fell behind the code it guards.

**Do-not.** Do not add per-chain probe rows to `probes.json` for this — the tool needs only a chain
slug, and curated data that is not needed rots. Do not let the new case bill anything: the eval is
free-providers-only by contract, and `dex.volume.history` is keyless, which is why it belongs there.
Do not "fix" the mismatch by editing the README's claim down to what the code does — the automatic
capability axis is the property worth having.
