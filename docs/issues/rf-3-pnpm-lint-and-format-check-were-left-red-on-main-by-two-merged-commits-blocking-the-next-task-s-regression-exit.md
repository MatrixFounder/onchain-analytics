---
id: RF-3
type: known-issue
status: fixed
opened_at: 2026-07-27
category: workflow-docs
severity: SEV-3
slug: rf-3-pnpm-lint-and-format-check-were-left-red-on-main-by-two-merged-commits-blocking-the-next-task-s-regression-exit
component: repo-gates
fingerprint: a103cc53eda7bdf7
evidence_paths:
  - eslint.config.js
  - .prettierignore
finding_ref: fnd-20260727-234025-a103cc53
resolved_at: 2026-07-27
resolved_by: TASK-007
---

# RF-3 — pnpm lint and format:check were left red on main by two merged commits, blocking the next task's regression exit

> **RESOLVED 2026-07-27 by TASK-007 (task 007-8).** `eslint.config.js` extends its Node-globals
> block to `**/eval/**/*.mjs`, and both gates now ignore `docs/dune-query-discovery/**` as
> generated research output — the same treatment `docs/onchain-analytics/` already had. Only files
> this task touched were reformatted. Kept as a record that two commits merged with a documented
> gate red, which is the part a config change does not prevent.

## Symptom

`pnpm lint` and `pnpm format:check` — two of the five gates TASK-007's regression exit is defined
against — were **already red on `main`** when this task started, in files unrelated to any current
work:

- `packages/mcp-server/eval/run.mjs` (landed in `e542bf8`) — 27 × `no-undef` on `process`,
  `console`, `setTimeout`, `clearTimeout`. `eslint.config.js` declares Node globals for
  `**/scripts/**/*.mjs` only, and this plain Node ESM script lives under `eval/`.
- `docs/dune-query-discovery/build-report.mjs` (landed in `a6c26ba`) — 2 × `no-undef` on `console`,
  same cause.
- 22 further files under `docs/dune-query-discovery/` fail `format:check` — generated research
  output (prose chunks, raw JSON, the assembling script), the same class as
  `docs/onchain-analytics/`, which both gates already ignore.

So two commits merged while leaving documented gates red, and the next task inherited them as its
own blocked acceptance criterion (TASK-007 AC-7 requires all five gates green).

## Reproduction

```sh
git stash --include-untracked           # or check out e542bf8 / a6c26ba directly
pnpm lint                               # -> 31 problems, exit 1
pnpm format:check                       # -> 41 files, exit 1
git stash pop
```

## Workaround

None that preserves the gate. Running the gates on a subset hides exactly what they exist to catch.

## Fix path

Fixed in TASK-007 task 007-8, following the repository's own documented order for this
(`docs/BACKLOG.md`, "Formatter-gate broadening needs a blast-radius guard": run the CHECK first,
review the file list, extend the ignore rules for curated/generated content, only then write):

1. `eslint.config.js` — the Node-globals block now matches `**/eval/**/*.mjs` as well as
   `**/scripts/**/*.mjs`. Same reasoning, one more directory; not a new exemption.
2. `eslint.config.js` + `.prettierignore` — `docs/dune-query-discovery/**` added to both, mirroring
   the treatment `docs/onchain-analytics/` already gets.
3. Only files this task actually touched were reformatted; the 22 generated files were **not**
   rewritten.

## Related

- `docs/BACKLOG.md` — "Formatter-gate broadening needs a blast-radius guard (2026-07-22)", the
  process this filing follows.
- **RF-1**, **RF-2** — same family: acceptance machinery that was not runnable / did not describe
  the shipped tree.

## Do-not

- Do **not** run a repo-wide `prettier --write .` to clear this class. That is precisely the
  incident the blast-radius note in BACKLOG was written after: it reformatted 34 curated/generated
  files and had to be reverted.
- Do **not** silence `no-undef` globally to cover a plain Node script — scope the globals to the
  directory, as the existing block does.
