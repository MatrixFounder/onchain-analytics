import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createBlockscoutAdapter } from '@onchain-intel/core';
import { EnvSchema, toProcessEnv } from '../src/env.js';

/**
 * TASK-008 task 008-8 (R-79a) — the validated env must actually reach the adapter.
 *
 * `EnvSchema` rejecting a bad key is only half the guarantee, and not the half that broke. `loadEnv`
 * parses `process.env` regardless of what any adapter is given, so a whitespace-only value already
 * stops the server from booting either way. What the wiring changes is the value the adapter USES:
 * `toProcessEnv(env)` hands over the TRIMMED string, while `deps.env ?? process.env` falls back to
 * the raw one. `echo key >> .env` leaves a trailing newline, which becomes `apikey=key%0A` — a
 * silent total auth failure the day the vendor's grace period ends, on a key the operator can see
 * is "set correctly" in their `.env`.
 *
 * Two assertions, because they cover different things and only one of them is strong.
 */
const here = path.dirname(fileURLToPath(import.meta.url));

describe('blockscout production wiring — the validated env reaches the adapter (R-79a)', () => {
  it('an adapter built from the validated env sends the TRIMMED key', async () => {
    // The strong half: behaviour, end to end, through the same two functions `main()` composes.
    const env = EnvSchema.parse({ BLOCKSCOUT_PRO_API_KEY: 'proapi_real_value\n' });
    const urls: string[] = [];
    const adapter = createBlockscoutAdapter({
      env: toProcessEnv(env),
      fetchImpl: ((url: string | URL) => {
        urls.push(String(url));
        return Promise.resolve(
          new Response(JSON.stringify({ data: { items: [] } }), { status: 200 }),
        );
      }) as unknown as typeof fetch,
    });

    await adapter
      .fetch('token.holders', {
        chain: 'ethereum',
        tokenAddress: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
      })
      .catch(() => undefined);

    expect(urls[0]).toContain('apikey=proapi_real_value');
    // The failure this exists for: a raw `process.env` read would emit the percent-encoded newline.
    expect(urls[0]).not.toContain('%0A');
  });

  it('`src/index.ts` constructs the adapter WITH an env, not with none', () => {
    // The weak half, and stated as such. `buildRegistry` is not exported and the nansen wiring test
    // reconstructs the composition rather than importing it — exporting a seam purely for a test
    // would be a production change made for a test's convenience. So this asserts the source line
    // instead. It cannot prove the value is correct; it can only prove the argument was not dropped,
    // which is exactly the regression it guards: the adapter shipped with `createBlockscoutAdapter()`
    // and no env at all, making the one secret TASK-008 introduced the only one reading raw
    // `process.env`. If `buildRegistry` ever gains a proper seam, replace this with a real one.
    const source = readFileSync(path.join(here, '../src/index.ts'), 'utf8');
    const registration = /\[\s*'blockscout'\s*,\s*createBlockscoutAdapter\(([^)]*)\)/.exec(source);

    expect(registration, 'the blockscout registration moved or was renamed').not.toBeNull();
    expect(
      registration![1],
      'blockscout is built with no env — it will read raw process.env',
    ).toContain('env:');
  });
});
