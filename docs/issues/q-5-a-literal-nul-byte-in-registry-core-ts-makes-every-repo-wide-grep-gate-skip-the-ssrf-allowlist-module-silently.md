---
id: Q-5
type: known-issue
status: fixed
opened_at: 2026-07-27
category: quality
severity: SEV-2
slug: q-5-a-literal-nul-byte-in-registry-core-ts-makes-every-repo-wide-grep-gate-skip-the-ssrf-allowlist-module-silently
component: packages/core/src/chain
fingerprint: 44f7600792c410a6
evidence_paths:
  - packages/core/src/chain/registry-core.ts
  - packages/core/test/source-is-greppable.test.ts
finding_ref: fnd-20260727-234025-44f76007
resolved_at: 2026-07-27
resolved_by: TASK-007
---

# Q-5 — a literal NUL byte in registry-core.ts makes every repo-wide grep gate skip the SSRF-allowlist module silently

> **RESOLVED 2026-07-27 by TASK-007 (adversarial cycle 1).** Both literal NULs replaced with the
> escape; `packages/core/test/source-is-greppable.test.ts` now fails the build if any source file
> under `src/`, `scripts/` or `test/` regains one, and names the offenders. The issue is kept
> because the CLASS outlived the fix: a raw NUL re-entered an authored file four more times during
> the same task, each time invisibly — which is the argument for the guard being a test rather
> than a habit.

## Symptom

`grep` and `ripgrep` classify any file containing a **literal NUL byte** as *binary* and skip it
**silently** unless `-a` / `--text` is passed. `packages/core/src/chain/registry-core.ts` has carried
one since TASK-006 — its search-key separator was written as a raw byte rather than the escape
`'\u0000'`.

The cost is not cosmetic. TASK-007's own acceptance criterion **AC-8** — "no loose zod schemas
(`z.record` / `passthrough()` / `z.unknown()` / `z.any()`) anywhere in `packages/*/src`" — ran, printed
zero hits, and was signed off. Re-run in text mode it reports **one hit: `registry-core.ts:139`**.
The gate had never read the file. That file is the one validating the **per-chain SSRF allowlist**
(`isApprovableRpcUrl`), i.e. the single module where a silent audit gap matters most.

A gate that cannot see the file it governs reports success for the wrong reason.

## Reproduction

```sh
# 1. Before the fix (any commit up to and including TASK-006), the audit lies:
rg -n 'z\.record|passthrough\(\)|z\.unknown\(\)|z\.any\(\)' packages/core/src packages/mcp-server/src
#    -> no hits, exit 1

# 2. The same audit, forced to read binary-looking files:
rg -n --text 'z\.record|passthrough\(\)|z\.unknown\(\)|z\.any\(\)' packages/core/src packages/mcp-server/src
#    -> packages/core/src/chain/registry-core.ts:139

# 3. The cause:
python3 -c "print(open('packages/core/src/chain/registry-core.ts','rb').read().count(bytes([0])))"

# 4. The standing guard (added by TASK-007) — fails if any source file regains a literal NUL:
pnpm --filter @onchain-intel/core exec vitest run test/source-is-greppable.test.ts
```

## Workaround

Pass `-a` / `--text` to every repo-wide `grep`/`rg` audit. Not a real workaround — it requires
remembering, which is exactly the property that failed here.

## Fix path

Fixed in TASK-007 (adversarial cycle 1):

1. both literal NULs (`chain/registry-core.ts`, and one introduced the same day in
   `adapters/defillama/index.ts`) replaced with the escape `'\u0000'` — byte-identical at runtime,
   fully visible to text tools;
2. `packages/core/test/source-is-greppable.test.ts` forbids a literal NUL under `src/`, `scripts/`
   and `test/`, and names offenders rather than counting them;
3. `registry-core.ts`'s comment corrected — it claimed "space-joined" while the code joined with NUL.

Note the recurrence rate: a raw NUL slipped into an authored file **four separate times** during
this one task (adapter source, the corrected comment, the guard test's own positive case, and the
review report), each time invisibly. That is why the fix is a test rather than a habit.

## Related

- TASK-007 adversarial report: `docs/reviews/task-007-adversarial.md` (H-1)
- The AC-8 correction: `docs/TASK.md` §4 note
- Same family as **L-2** (a diagnostic nobody reads) and **L-3** (a detector that cannot report a
  true negative): a check whose green is uninformative.

## Do-not

- Do **not** "fix" a future occurrence by adding `--text` to the audit command. The escape is the
  fix; the flag hides the class again.
- Do **not** widen the guard's extension list to cover generated binaries — it is scoped to text
  sources on purpose.
