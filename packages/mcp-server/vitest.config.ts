import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * WI-10 — make this package's tests read `@onchain-intel/core` from **source**, not from its built
 * `dist`.
 *
 * The trap this closes: `packages/mcp-server/node_modules/@onchain-intel/core` is a workspace
 * symlink to `packages/core`, whose `package.json` names `./dist/index.js` as `main`. So without
 * this alias every test here resolved the **built artifact**, and a change in `packages/core/src`
 * stayed invisible until someone ran `pnpm build`. Observed in TASK-007 task 007-6: five freshly
 * written `onchain_dex_volume` tests failed with `out.ok === false` and no diagnostic naming
 * staleness — the handler, the schemas and the adapter were all correct. What made it actively
 * misleading is that `packages/core`'s own suite imports from `../src/` and was green the whole
 * time: the same code, green in one package and red in another, for a reason neither failure
 * message mentioned.
 *
 * **Scope — deliberately tests only.** Production resolution still goes through `dist` (that is what
 * `pnpm build` and `smoke:dist` exist to verify); this alias exists so the two suites test the same
 * source. `test/core-resolves-to-src.test.ts` is the guard that keeps it in effect.
 *
 * **What this does NOT cover:** `test/e2e.stdio.test.ts` spawns `src/index.ts` as a **child
 * process** via `tsx`, which resolves modules through Node — the child never sees a Vite alias, by
 * construction. That suite passes `--tsconfig tsconfig.e2e.json`, whose `paths` mapping points
 * `@onchain-intel/core` at `../core/src/index.ts`, so the child resolves **source** as well;
 * `test/fixtures/core-resolution-probe.ts` runs under the identical invocation and asserts which
 * copy was resolved. The built artifact keeps its end-to-end coverage in `scripts/smoke-dist.mjs`,
 * which runs `dist/index.js` for real.
 *
 * (Corrected in adversarial cycle 2. This paragraph previously said that suite "still reads
 * `packages/core/dist`" and "guards its own freshness explicitly via `assertCoreDistFresh()`".
 * Neither is true: the WI-10 fix moved it to source, and `assertCoreDistFresh` exists nowhere in
 * the repository — an mtime freshness check was tried, found unsound, and is recorded as rejected
 * in `e2e.stdio.test.ts`, so naming it here invited exactly the repair that file warns against.)
 */
const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@onchain-intel/core': path.resolve(here, '../core/src/index.ts'),
    },
  },
});
