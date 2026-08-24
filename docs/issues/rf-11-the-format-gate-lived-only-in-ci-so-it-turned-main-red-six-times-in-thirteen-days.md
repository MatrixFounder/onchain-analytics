---
id: RF-11
type: known-issue
status: fixed
opened_at: 2026-08-24
category: workflow-docs
severity: SEV-3
slug: rf-11-the-format-gate-lived-only-in-ci-so-it-turned-main-red-six-times-in-thirteen-days
component: repo-gates
evidence_paths:
  - .github/workflows/ci.yml
  - .githooks/pre-commit
  - scripts/check-format-staged.mjs
resolved_at: 2026-08-24
resolved_by: pre-commit format gate (scripts/check-format-staged.mjs) + packages/core/test/format-gate.test.ts
---

# RF-11 — the format gate lived only in CI, so it turned main red six times in thirteen days

> **RESOLVED 2026-08-24.** `prettier --check` now runs against the STAGED blobs before every
> commit, alongside the RF-2 provenance check in the same hook, and eight cases pin it. Filed even
> though the fix landed the same hour, because the interesting part is not the seven files: it is
> that **RF-3 named this exact remainder on 2026-07-27 and closed without it** — "kept as a record
> that two commits merged with a documented gate red, which is the part a config change does not
> prevent". Thirteen days is what that sentence cost once it was written down and not acted on.

## Symptom

Every CI failure on this repository since 2026-08-11 is the same step, `pnpm format:check`, and
each is a single file. Seven runs, six distinct files, two branches:

| Run | Branch | File Prettier rejected |
|---|---|---|
| 31492283932 | `main` | `packages/core/test/fixtures/defillama/hacks-and-catalog.evidence.md` |
| 32532666040 | `feat/t-014-…` | `docs/architectures/system-architecture.md` |
| 32555308228 | `feat/t-014-…` | `docs/architectures/system-architecture.md` |
| 32655083395 | `feat/t-014-…` | `docs/architectures/system-architecture.md` |
| 32749677135 | `feat/t-014-…` | `packages/mcp-server/eval/cases/http-shared-limiter-rate.mjs` |
| 32768932475 | `main` | `packages/mcp-server/eval/probes.json` |
| 32775342129 | `main` | `packages/mcp-server/eval/probes.json` |

Six different files across two weeks is not six careless authors. It is a loop with no local end:
`prettier --check .` existed in `.github/workflows/ci.yml` and **nowhere else** that anybody ran.
`pnpm test`, `pnpm lint`, `pnpm typecheck` and the live eval gate all pass on unformatted content
by design, and the pre-commit hook checked provenance only.

## What it cost beyond its own red

`format:check` is **CI step two of eight**. Every one of those seven runs stopped before
`typecheck`, `test`, `build` and `smoke:dist`, so for thirteen days the repository had no CI
evidence about its code at all — a red tick that meant "a JSON array was wrapped over four lines"
and a green tick that was unavailable. The last genuinely full CI run before this filing was
32729568042 (2026-08-24 12:53). Verified afterwards: with the formatting fixed, the remaining six
steps pass unchanged (1629 + 918 tests, `smoke:dist` PASS), so nothing was hiding behind the wall.

That is the same shape as **L-2** — a signal computed and never read — one level up: here the
signal was read, by a machine, in a place where its verdict arrived after the only moment anyone
could have acted on it cheaply.

## Reproduction

```sh
git checkout 433d83b
pnpm format:check     # -> packages/mcp-server/eval/probes.json, exit 1
```

## Fix

1. **`scripts/check-format-staged.mjs`** — reads `git diff --cached` and checks each staged blob
   through Prettier's Node API. `--source=index` in spirit and in fact, for the reason RF-2
   established for provenance: a clean working tree says nothing about the staged content, and
   `git add -p` followed by an edit makes the two differ routinely. It names the offending files,
   which `prettier --check` over stdin cannot — that reports `(stdin)`.
2. **`.githooks/pre-commit`** — runs it after the provenance check, `set -e`.
3. **Scope is the CI step's scope, deliberately.** The same root `.prettierignore`, the same config
   resolution, and files with no inferred parser are skipped. A gate stricter than the one it
   stands in for would refuse commits CI would have passed, and a gate that refuses correct work is
   how gates get bypassed.
4. **It reports and never rewrites.** `--update` is part of no provenance gate for the same reason;
   here auto-formatting would also restage bytes under a `git add -p` the author chose on purpose.
5. **`packages/core/test/format-gate.test.ts`** — eight cases against a scratch repository, because
   staging a deliberately broken file in THIS one to observe the refusal would rewrite the
   developer's index mid-run. The two that matter: index unformatted while the worktree is clean
   must REFUSE, and worktree unformatted while nothing is staged must PASS.

## The boundary of the guarantee

Unchanged from what security.md already says about the provenance half: git hooks are local, so
`--no-verify` or a clone that never ran `git config core.hooksPath .githooks` bypasses this. CI
still checks. The mechanism makes the failure arrive before the push instead of after it; it cannot
make it impossible.

## Do-not

- Do **not** delete the CI step now that a hook exists. The hook is the fast path, not the
  authority — see the boundary above.
- Do **not** widen `.prettierignore` to make a red go away. That is the blast-radius rule RF-3
  followed, and this filing changes nothing about it: run the check, read the file list, exempt
  only genuinely curated or generated content.
- Do **not** run a repo-wide `prettier --write .` to clear a red. RF-3's Do-not, still live: it
  reformatted 34 curated files once and had to be reverted.

## Related

- **RF-3** — the same class on 2026-07-27, fixed at the config layer, whose closing note named this
  remainder exactly and left it open.
- **RF-2** — the index-versus-worktree argument this gate reuses, and the hook it now shares.
- **RF-4** — a CI gate that stayed red on `main` across tasks; the failure mode where a red tick
  stops carrying information.
