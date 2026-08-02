# Known Issues & Tech Debt

**Purpose:** Track recurring bugs, architectural limitations, and sensitive areas to avoid
repeating mistakes.

This file is a **thin index**. Each issue lives in its own file under [`docs/issues/`](issues/);
the lines below are one-per-issue pointers grouped by category. Read the linked file for the full
symptom, workaround, and cross-links.

---

## Rules / Conventions

> The index below is **hand-maintained** — there is no generator. When you add, resolve, or
> re-categorize an issue you MUST edit **both** the per-issue file *and* the matching line here.
> These rules keep that hand-editing consistent.

<!-- contract:defects -->

**Per-issue file** — `docs/issues/<slug>.md`, YAML frontmatter then an H1 title and body:

```yaml
---
id: L-1                  # <PREFIX>-<n>, unique (see prefix→category table)
type: known-issue        # always this literal
status: open             # see status vocab below
opened_at: 2026-01-01    # ISO date first recorded (git-truthful)
category: logic          # see prefix→category table
severity: SEV-2          # OPTIONAL — omit when not meaningfully rankable
slug: l-1-short-kebab-title   # filename stem: a slugified, human-readable id+title (normalize symbols, e.g. ≠ → "not")
# component: transcript-fetcher   # OPTIONAL automation keys, appended AFTER slug —
# fingerprint: 614ee37f7fb28554   # see "Automation extension keys" below
# evidence_paths:
#   - path/to/artifact
# auto_fixable: true
# finding_ref: fnd-20260713-081500-614ee37f
# resolved_at: 2026-02-01   # add ONLY when status: fixed
# resolved_by: TASK 042     # add ONLY when status: fixed
---
```

**ID prefix → category.** Define prefixes as the project needs them; **add a row here** whenever you
introduce a new prefix. A common starter set (extend/replace freely):

| Prefix  | Category      | Scope |
|---------|---------------|-------|
| `L-N`   | `logic`       | Logic / correctness defects and edge cases. |
| `P-N`   | `performance` | Performance, algorithmic, or resource issues. |
| `SEC-N` | `security`    | Security / auth / injection / secrets. |
| `Q-N`   | `quality`     | Quality, UX, or robustness nits. |
| `DF-N`  | `dogfood`     | Found while dogfooding the product itself. |
| `RF-N`  | `workflow-docs` | Run-feedback filings: defects in workflow/task docs and pipeline tooling. |

**Status vocabulary:** `open` · `fixed` · `documented` (accepted; guidance written) ·
`by-design` (intended trade-off, not a defect) · `mitigated` · `wontfix`.

A `fixed` issue **keeps its file** and adds `resolved_at` / `resolved_by` + a resolution
blockquote; it is never deleted.

**Severity vocabulary (optional):** `SEV-2` (blocks a workflow / real impact) ·
`SEV-3` (degraded / annoying) · `SEV-4` (minor) · `LOW`. Omit for pure documented constraints.

**Index line format** (severity clause omitted when the file has no `severity`):

```
- **<ID>** [<title>](issues/<slug>.md) — severity `<SEV>`, status `<status>`, opened <YYYY-MM-DD>
```

**Automation extension keys (optional).** Automated tools append machine-oriented keys AFTER
`slug` — `component`, `fingerprint`, `evidence_paths`, `auto_fixable`, `finding_ref` (written by
the `run-feedback` skill's filing step; consumed by the `/heal-issues` harness, which selects
ONLY issues carrying an explicit `auto_fixable: true`). Automation STATE (attempt counters,
journals) lives outside the ledger under `.agent/feedback/`. Per-project ledgers may carry local
read-side extensions (e.g. `status: handled`, `severity: MED`); readers MUST tolerate them, while
new writes stick to the vocabularies above. Automated `resolved_by` values use the token
`heal-issues (verified-gone <ts>)` / `heal-issues run <ts>`.

**Adding a new issue:** ① pick the next `<PREFIX>-<n>`; ② create `docs/issues/<slug>.md` with the
frontmatter above (body preserved verbatim — never drop a clause); ③ add one line under the matching
`## <category>` heading below, in ID order. Add the category heading if it is the first of its kind.

---

## dogfood

- **DF-1** [Nansen `POST /api/v1/smart-money/netflow` silently returned zero rows for a real, well-known token — two request-construction defects, both fixed](issues/df-1-nansen-smart-money-netflow-empty-for-base-pair-tokens.md) — severity `SEV-3`, status `fixed`, opened 2026-07-24

## workflow-docs

- **RF-1** [task-001-3 acceptance snippets not runnable (pnpm 11 '--' forwarding; macOS lacks timeout)](issues/rf-1-task-001-3-acceptance-snippets-not-runnable-pnpm-11-forwarding-macos-lacks-timeout.md) — severity `SEV-4`, status `fixed`, opened 2026-07-22
- **RF-2** [M2's own evidence records describe an earlier tree than the one that shipped](issues/rf-2-m2-evidence-records-drifted-from-the-shipped-commit.md) — severity `SEV-3`, status `fixed`, opened 2026-07-25
- **RF-3** [pnpm lint and format:check were left red on main by two merged commits, blocking the next task's regression exit](issues/rf-3-pnpm-lint-and-format-check-were-left-red-on-main-by-two-merged-commits-blocking-the-next-task-s-regression-exit.md) — severity `SEV-3`, status `fixed`, opened 2026-07-27
- **RF-4** [the smoke:dist CI gate still asserts 8 tools, so it has been red on main since TASK-006](issues/rf-4-smoke-dist-ci-gate-still-asserts-8-tools-so-it-has-been-red-on-main-since-task-006.md) — severity `SEV-2`, status `fixed`, opened 2026-07-28
- **RF-5** [the live eval derives chains from the registry but capabilities from a hand-written list, so dex.volume.history ships untested](issues/rf-5-live-eval-capability-axis-is-hand-written-so-dex-volume-history-ships-untested.md) — severity `SEV-3`, status `fixed`, opened 2026-07-28

## logic

- **L-1** [a paid Nansen call whose result `normalize()` rejects is never cached, so every retry pays again](issues/l-1-nansen-no-negative-caching-paid-call-discarded-on-empty-result.md) — severity `SEV-2`, status `fixed`, opened 2026-07-25
- **L-2** [the snapshotter drops a metric silently: `dropped[]` is computed and then discarded](issues/l-2-snapshotter-drops-a-metric-silently-dropped-array-never-leaves-the-node.md) — severity `SEV-3`, status `fixed`, opened 2026-07-27
- **L-3** [`onchain-verify`'s staleness detector is permanently red by construction, and names no metric](issues/l-3-verify-staleness-detector-is-permanently-red-and-names-no-metric.md) — severity `SEV-2`, status `fixed`, opened 2026-07-27
- **L-4** [Telegram entity parsing 400s on snake_case metric names, so the alert is never delivered](issues/l-4-telegram-entity-parsing-400s-on-snake-case-metric-names-no-alert-delivered.md) — severity `SEV-2`, status `fixed`, opened 2026-07-27
- **L-5** [onchain_dex_volume reports gapDays: 0 for a window with no data at all — the empty-chart case breaks its own invariant](issues/l-5-dex-volume-empty-chart-reports-zero-gapdays-breaking-its-own-invariant.md) — severity `SEV-3`, status `fixed`, opened 2026-07-28

## security

- **SEC-1** [the daily credit cap bounds damage per day, not per minute: there is no velocity guard](issues/sec-1-nansen-daily-cap-does-not-bound-a-burst-no-velocity-guard.md) — severity `SEV-2`, status `fixed`, opened 2026-07-25

## quality

- **Q-1** [under a persistent reconcile degrade, the nansen stderr line repeats per call](issues/q-1-nansen-degrade-stderr-repeats-per-call.md) — severity `SEV-4`, status `by-design`, opened 2026-07-24
- **Q-2** [`NANSEN_DAILY_CREDIT_CAP` is optional with no default, so a stock install has no self-imposed ceiling](issues/q-2-nansen-daily-credit-cap-has-no-default.md) — severity `SEV-3`, status `fixed`, opened 2026-07-24
- **Q-3** [the 0-credit `entity.labels` query tier is structurally unrefusable by a credit-denominated gate](issues/q-3-nansen-zero-credit-entity-labels-tier-is-unrefusable-by-the-gate.md) — severity `SEV-3`, status `fixed`, opened 2026-07-25
- **Q-4** [`token.risk` pays 1cr per call for `/tgm/token-information`, whose body is never read](issues/q-4-nansen-token-information-subcall-paid-but-never-consumed.md) — severity `SEV-3`, status `fixed`, opened 2026-07-25
- **Q-5** [a literal NUL byte in registry-core.ts makes every repo-wide grep gate skip the SSRF-allowlist module silently](issues/q-5-a-literal-nul-byte-in-registry-core-ts-makes-every-repo-wide-grep-gate-skip-the-ssrf-allowlist-module-silently.md) — severity `SEV-2`, status `fixed`, opened 2026-07-27
