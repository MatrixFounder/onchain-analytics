---
id: RF-1
type: known-issue
status: fixed
opened_at: 2026-07-22
resolved_at: 2026-07-23
resolved_by: developer round post-M1 (user-authorized), orchestrator ledger flip
category: workflow-docs
severity: SEV-4
slug: rf-1-task-001-3-acceptance-snippets-not-runnable-pnpm-11-forwarding-macos-lacks-timeout
component: docs-tasks
fingerprint: e94d805770bfc96a
auto_fixable: true
finding_ref: fnd-20260722-025104-e94d8057
---

# RF-1 — task-001-3 acceptance snippets not runnable (pnpm 11 '--' forwarding; macOS lacks timeout)

> **Resolution (2026-07-23).** Both defects fixed and verified live on the target machine:
> (1) `docs/tasks/task-001-3-tests-unit-e2e-stdio.md` — extra `--` dropped
> (`test --reporter=verbose`); the grep now shows real E2E lines. (2) The bare-`timeout` line
> actually lived in `docs/tasks/task-001-2-mcp-server-env-ping.md:74` — this issue's original
> Fix path mis-attributed it to task-001-3; fixed there with the prescribed portable equivalent
> (`pnpm --filter @onchain-intel/mcp-server dev </dev/null`, exits 0 on stdin EOF, verified
> EXIT=0). File-location correction noted here rather than rewriting the historical Fix path.

> Owning decision: docs/tasks/task-001-3-tests-unit-e2e-stdio.md (M0, TASK-001) — acceptance snippet authored by the Planner, flagged by Developer and Code Reviewer in the same run.

**Symptom.** Two acceptance commands in `docs/tasks/task-001-3-tests-unit-e2e-stdio.md` are not runnable as written on the target machine. (1) `pnpm --filter @onchain-intel/mcp-server test -- --reporter=verbose | grep -Ei 'e2e|stdio'` produces empty grep output under pnpm 11: pnpm forwards the extra `--` literally, so vitest receives `run -- --reporter=verbose` and treats `--reporter=verbose` as a positional filename filter (silently matching nothing, default reporter used). (2) another snippet uses `timeout 3`, which does not exist on stock macOS (no coreutils `timeout`/`gtimeout`).

**Reproduction.**

```sh
cd "$(git rev-parse --show-toplevel)"
# (1) broken form — grep finds nothing because vitest ate --reporter as a name filter:
pnpm --filter @onchain-intel/mcp-server test -- --reporter=verbose | grep -Ei 'e2e|stdio' || echo "EMPTY (bug)"
# working form — no extra `--`:
pnpm --filter @onchain-intel/mcp-server test --reporter=verbose | grep -Ei 'e2e|stdio'
# (2) macOS has no `timeout`:
command -v timeout || echo "timeout missing (bug premise)"
```

**Workaround.** Use the working form (drop the extra `--`); replace `timeout 3 <cmd>` with a portable pattern (background + `kill` after sleep, or just run the command — the dev-entry exits on stdin EOF anyway).

**Fix path.** Edit `docs/tasks/task-001-3-tests-unit-e2e-stdio.md`: in the acceptance-check block, change `test -- --reporter=verbose` → `test --reporter=verbose`, and replace the `timeout 3 pnpm … dev </dev/null` line with the portable equivalent (`pnpm --filter @onchain-intel/mcp-server dev </dev/null` — exits 0 on stdin EOF). Mechanical doc edit, verifiable by running both corrected commands.

**Related.** finding_ref fnd-20260722-025104-e94d8057; Developer report (task 001-3) and Code Reviewer non-blocking note №1 in the same run both flagged (1).

**Do-not.** Do not "fix" this by adding a vitest config that forces the verbose reporter globally — the defect is in the doc snippet, not the runner; CI intentionally uses the default reporter.
