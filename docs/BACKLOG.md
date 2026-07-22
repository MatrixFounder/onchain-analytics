# Backlog — onchain-intel

Тонкий бэклог для work-item'ов из retro/run-feedback (см. `.agent/skills/run-feedback`).
Крупные фазы живут в [ROADMAP](onchain-analytics/ROADMAP.md); сюда попадают
инженерные улучшения и полировка, не тянущие на roadmap-строку.

## Discovered issues / work-items

<!-- feedback:discovered-issues -->
- **Formatter-gate broadening needs a blast-radius guard (2026-07-22)** — During the M0 adversarial fix round, a repo-wide `prettier --write .` reformatted 34 unrelated curated/generated files (SoT docs, n8n exports, reference dialogs); the orchestrator reverted and scoped .prettierignore after the fact. Process guard to adopt: any directive that broadens a formatter/linter gate must run the CHECK first, review the file list, extend ignore rules for curated/generated content, and only then write.
- **Revisit typescript pin ^6.0.3 when tsup supports TS7 dts (2026-07-22)** — tsup 8.5.1 dts pipeline breaks under typescript@7 (native API TypeError) AND emits TS5101 (baseUrl deprecated) under TS6 — M0 ships TS ^6.0.3 with two-step build (tsup dts:false + tsc --emitDeclarationOnly -p tsconfig.build.json). When tsup (or its dts successor) supports TS7, re-evaluate the pin and collapse the build back to one step. Error signatures documented in packages/mcp-server/.AGENTS.md.
