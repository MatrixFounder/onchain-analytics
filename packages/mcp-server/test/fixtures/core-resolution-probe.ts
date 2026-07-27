import { assertAllowedHost } from '@onchain-intel/core';

/**
 * WI-10 probe — run by `test/e2e.stdio.test.ts` under exactly the `tsx --tsconfig` invocation the
 * spawned MCP server uses, and prints which copy of `@onchain-intel/core` that invocation resolved.
 *
 * It exists because the alternative is a silent regression: if a future tsx stops honouring
 * `--tsconfig`, the server child would quietly fall back to `packages/core/dist` and the E2E suite
 * would keep passing against a stale build — the exact trap WI-10 closes, with nothing to notice
 * it. `packages/core` builds with `tsc`, which mirrors the source tree into `dist/` and emits no
 * source maps, so the stack frame discriminates the two exactly.
 */
try {
  assertAllowedHost('evil.example', ['api.llama.fi']);
  console.log('probe-failed: assertAllowedHost did not throw');
} catch (error) {
  const stack = error instanceof Error ? (error.stack ?? '') : '';
  const viaSrc = stack.includes('core/src') || stack.includes('core\\src');
  const viaDist = stack.includes('core/dist') || stack.includes('core\\dist');
  console.log(viaSrc ? 'resolved:src' : viaDist ? 'resolved:dist' : 'resolved:unknown');
}
