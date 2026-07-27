---
id: WI-2
type: work-item
status: open
opened_at: 2026-07-22
slug: wi-2-typescript-pin-revisit-when-tsup-supports-ts7-dts
---

# Revisit typescript pin ^6.0.3 when tsup supports TS7 dts

tsup 8.5.1 dts pipeline breaks under typescript@7 (native API TypeError) AND emits TS5101 (baseUrl deprecated) under TS6 — M0 ships TS ^6.0.3 with two-step build (tsup dts:false + tsc --emitDeclarationOnly -p tsconfig.build.json). When tsup (or its dts successor) supports TS7, re-evaluate the pin and collapse the build back to one step. Error signatures documented in packages/mcp-server/.AGENTS.md.
