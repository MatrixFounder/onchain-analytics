import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { assertAllowedHost } from '@onchain-intel/core';

/**
 * WI-10 guard — proves the `vitest.config.ts` alias is actually IN EFFECT, so this package's tests
 * read `@onchain-intel/core` from source and a stale `packages/core/dist` can never again make a
 * correct change look broken.
 *
 * **Why a stack frame and not a config assertion.** Reading the alias back out of the config only
 * proves the config says what it says; it does not prove Vite applied it. Throwing from a function
 * that lives in core and reading where the frame points proves the module the test actually
 * imported. The discriminator is exact rather than heuristic: `packages/core` builds with `tsc`,
 * which mirrors the source tree into `dist/` (`dist/net/safe-fetch.js`) and — verified — emits **no
 * source maps**, so nothing can remap a `dist` frame back onto a `src` path. Aliased, the frame is
 * `core/src/net/safe-fetch.ts`; unaliased, `core/dist/net/safe-fetch.js`.
 *
 * Delete the alias and this test goes red with a message naming the cause — which is the whole
 * point, since the failure it replaces named nothing.
 */
/** Runs `fn`, expecting it to throw, and returns the thrown error's stack. */
function stackOfThrow(fn: () => void): string {
  try {
    fn();
  } catch (error) {
    return error instanceof Error ? (error.stack ?? '') : '';
  }
  throw new Error('the probe did not throw — pick another probe for this guard');
}

describe('@onchain-intel/core resolution (WI-10)', () => {
  it('resolves to core/src, never to the built core/dist', () => {
    // `SsrfBlockedError` is constructed inside `packages/core/src/net/safe-fetch.ts`, so the top
    // frames of its stack name the file the test actually imported.
    const stack = stackOfThrow(() => assertAllowedHost('evil.example', ['api.llama.fi']));

    expect(stack, 'the probe error carried no stack to inspect').not.toBe('');
    expect(
      stack.includes(`core${path.sep}src`) || stack.includes('core/src'),
      'mcp-server tests are reading @onchain-intel/core from its BUILT dist, not from src — the ' +
        'resolve.alias in packages/mcp-server/vitest.config.ts is missing or ineffective (WI-10). ' +
        'Symptom to expect if left unfixed: correct changes in packages/core/src appear as ' +
        'unexplained failures here until someone runs `pnpm build`.',
    ).toBe(true);
    expect(
      stack.includes(`core${path.sep}dist`) || stack.includes('core/dist'),
      'the probe resolved into core/dist',
    ).toBe(false);
  });
});
