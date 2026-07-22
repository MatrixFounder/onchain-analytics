// Shared flat ESLint config for the onchain-intel monorepo (root, per ARCHITECTURE.md §6.4).
// Workspace packages (currently only packages/mcp-server) have no local eslint.config.js of
// their own — ESLint's flat-config resolution walks up from the invoking package's cwd and
// finds this file. Kept intentionally minimal (M0 scaffold, no application source yet).
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: ['**/dist/**', '**/node_modules/**', '**/coverage/**'],
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
    // Node 22 built-in global to observe the URL/status of the ONE live call it makes).
    // `js.configs.recommended`'s `no-undef` has no Node globals by default outside a TS file (TS
    // files get `process`/`console`/etc. from `@types/node` via the TS parser, not from ESLint's
    // own scope analysis) — declare exactly the Node globals these scripts use, scoped narrowly
    // here rather than pulling in the `globals` npm package for a handful of identifiers.
    files: ['**/scripts/**/*.mjs'],
    languageOptions: {
      globals: {
        process: 'readonly',
        console: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        fetch: 'readonly',
      },
    },
  },
);
