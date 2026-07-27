---
id: WI-1
type: work-item
status: done
opened_at: 2026-07-22
slug: wi-1-formatter-gate-blast-radius-guard
resolved_at: 2026-07-28
resolved_by: framework edit (agentic-development)
---

# Formatter-gate broadening needs a blast-radius guard

> **DONE 2026-07-28.** Encoded as `developer-guidelines` §5.1 _Safety Boundaries — Widening a
> Repo-Wide Gate_: check form first, classify the file list, extend the ignore rules, only then
> write; plus a rationalization-table row for "I'll just run the formatter, it's idempotent".
> The lesson had been sitting only in `.agent/feedback/filed/*.json` and this file — neither of
> which an agent reads while working, which is why RF-3 had to re-derive the same order by hand.

During the M0 adversarial fix round, a repo-wide `prettier --write .` reformatted 34 unrelated curated/generated files (SoT docs, n8n exports, reference dialogs); the orchestrator reverted and scoped .prettierignore after the fact. Process guard to adopt: any directive that broadens a formatter/linter gate must run the CHECK first, review the file list, extend ignore rules for curated/generated content, and only then write.
