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
);
