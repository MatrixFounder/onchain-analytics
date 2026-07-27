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
 * construction. That suite therefore still reads `packages/core/dist`, and it is the one suite for
 * which that is the point (it proves the server a real client would spawn actually starts). It
 * guards its own freshness explicitly via `assertCoreDistFresh()` rather than failing mysteriously.
 */
const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@onchain-intel/core': path.resolve(here, '../core/src/index.ts'),
    },
  },
});
