// Shared flat ESLint config for the onchain-intel monorepo (root, per ARCHITECTURE.md §6.4).
// Workspace packages (currently only packages/mcp-server) have no local eslint.config.js of
// their own — ESLint's flat-config resolution walks up from the invoking package's cwd and
// finds this file. Kept intentionally minimal (M0 scaffold, no application source yet).
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    // Mirrors `.prettierignore` (ARCHITECTURE.md §6.4 — the two gates ignore the same things).
    // `docs/dune-query-discovery/**` is generated research output (a workflow writes the prose,
    // the JSON and `build-report.mjs` that assembles them), curated by hand afterwards — the same
    // class as `docs/onchain-analytics/`, which both gates already ignore. Added in TASK-007 after
    // running the CHECK first and reviewing the file list, per the blast-radius rule in
    // docs/BACKLOG.md: extend the ignore rules for curated/generated content, never reformat it.
    ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**', 'docs/dune-query-discovery/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts'],
    languageOptions: {
      parserOptions: {
        sourceType: 'module',
      },
    },
  },
  {
    // Plain Node/ESM utility scripts (no bundler, no TypeScript, no `@types/node`) — e.g.
    // `packages/mcp-server/scripts/smoke-dist.mjs` (task 001-5), `packages/core/scripts/
    // record-fixture.mjs` (task 003-4, added `fetch` — its instrumented fetchImpl wraps the
    // Node 22 built-in global to observe the URL/status of the ONE live call it makes; task 005-7
    // added `URL` — the nansen recording path parses each captured request's `url` argument via
    // `new URL(...)` to key its per-endpoint fixture map by pathname).
    // `js.configs.recommended`'s `no-undef` has no Node globals by default outside a TS file (TS
    // files get `process`/`console`/etc. from `@types/node` via the TS parser, not from ESLint's
    // own scope analysis) — declare exactly the Node globals these scripts use, scoped narrowly
    // here rather than pulling in the `globals` npm package for a handful of identifiers.
    // `**/eval/**/*.mjs` joins the same block in TASK-007: `packages/mcp-server/eval/run.mjs`
    // (commit e542bf8) is the identical kind of plain Node ESM script and had been failing
    // `no-undef` on `process`/`console`/`setTimeout` ever since it landed, because the pattern
    // below matched only `scripts/`. Same reasoning, one more directory — not a new exemption.
    files: ['**/scripts/**/*.mjs', '**/eval/**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        fetch: 'readonly',
        URL: 'readonly',
      },
    },
  },
);
