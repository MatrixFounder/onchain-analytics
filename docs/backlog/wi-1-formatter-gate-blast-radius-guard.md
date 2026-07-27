---
id: WI-1
type: work-item
status: open
opened_at: 2026-07-22
slug: wi-1-formatter-gate-blast-radius-guard
---

# Formatter-gate broadening needs a blast-radius guard

During the M0 adversarial fix round, a repo-wide `prettier --write .` reformatted 34 unrelated curated/generated files (SoT docs, n8n exports, reference dialogs); the orchestrator reverted and scoped .prettierignore after the fact. Process guard to adopt: any directive that broadens a formatter/linter gate must run the CHECK first, review the file list, extend ignore rules for curated/generated content, and only then write.
