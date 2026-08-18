import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { BudgetStore, CacheStore } from '@onchain-intel/core';
import { loadEnv } from '../src/env.js';
import { createSharedRuntime } from '../src/runtime.js';

/**
 * Task 014-19 — production stops taking the module singleton (R-7, R-8, `system-architecture.md`
 * §3.4.4, "What changes at the production call site").
 *
 * **Why this is a gate and not a review item.** An adapter constructed without the injected limiter
 * falls back to `core`'s module-level `throttle`, which is built at import time and therefore holds
 * a bucket private to this process — the exact state R-7 exists to end. The failure is silent: the
 * adapter works, the suite is green, and the vendor sees N times the declared rate where N is the
 * number of processes. Nothing else in the repository would notice.
 *
 * **Membership is derived from the source, never from a list here.** An eleventh adapter that starts
 * throttling fails this on the day it is written, rather than after someone thinks to update a
 * constant — the same discipline `packages/core/test/throttle-seam.test.ts` applies one layer down,
 * where it requires the seam to EXIST. This file requires production to USE it.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const adaptersDir = path.join(repoRoot, 'packages/core/src/adapters');

const codeOnly = (text: string): string =>
  text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** Adapters that declare the injection seam — i.e. every adapter that throttles. */
function throttlingAdapters(): string[] {
  return readdirSync(adaptersDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => {
      const entry = path.join(adaptersDir, name, 'index.ts');
      try {
        return /throttle\?:\s*Throttle/.test(codeOnly(readFileSync(entry, 'utf8')));
      } catch {
        return false;
      }
    })
    .sort();
}

const runtimeSource = codeOnly(
  readFileSync(path.join(repoRoot, 'packages/mcp-server/src/runtime.ts'), 'utf8'),
);
const indexSource = codeOnly(
  readFileSync(path.join(repoRoot, 'packages/mcp-server/src/index.ts'), 'utf8'),
);

describe('every throttling adapter is constructed over the process limiter', () => {
  it('there are adapters to check at all', () => {
    // A gate whose input is empty passes forever. This is what stops a rename of the seam's
    // declaration from turning every check below into a no-op.
    expect(throttlingAdapters().length).toBeGreaterThanOrEqual(10);
  });

  it('the production registry passes the injected limiter to each of them', () => {
    // The registry's Map keys ARE the adapter ids, so the construction line for each is found by its
    // key rather than by the factory's name — a factory rename cannot drop an adapter out of the
    // checked set.
    const missing = throttlingAdapters().filter((id) => {
      const line =
        new RegExp(`\\['${id}',\\s*([\\s\\S]*?)\\][,\\n]`).exec(runtimeSource)?.[1] ?? '';
      // Either the spread every keyless factory takes, or the explicit third argument `nansen`'s
      // production constructor takes — both resolve to the same instance.
      return !/\.\.\.limiter|throttle/.test(line);
    });
    expect(missing, 'these adapters silently fall back to the per-process bucket').toEqual([]);
  });

  it('and the limiter itself is built over the storage axis, with the degradation port', () => {
    // `index.ts` is the only place that CAN build it: `core`'s singleton is constructed at import
    // time and cannot know the deployment profile.
    expect(indexSource).toMatch(/createThrottle\(\{/);
    expect(indexSource).toMatch(/store:\s*stores\.limiter/);
    expect(indexSource).toMatch(/emit:\s*\(event, detail\)/);
    // Task 014-19's whole point: the port is a real writer, not a stub. `stores` is the axis, so the
    // cache and the credit ledger travel with it rather than staying on whichever engine was
    // hardcoded.
    expect(indexSource).toMatch(/createStateStores\(\{/);
    expect(indexSource).toMatch(/budgetStoreFactory:\s*\(\)\s*=>\s*stores\.budget/);
    expect(indexSource).toMatch(/cacheStoreFactory:\s*\(\)\s*=>\s*stores\.cache/);
  });
});

describe('the injected limiter is the one a resolve actually reaches', () => {
  /**
   * A store that always MISSES. `get` must resolve to `undefined` — the registry decides hit/miss on
   * truthiness (`adapters/cache-store.ts`), so an object like `{ hit: false }` reads as a HIT with
   * no value, the walk short-circuits and no adapter is ever asked. That is how the first version of
   * this case went green while measuring nothing.
   */
  const inertCache = (): CacheStore => ({
    get: () => Promise.resolve(undefined),
    set: () => Promise.resolve(),
  });

  it('a capability walk calls it, and no network is reached because it refuses first', async () => {
    // The structural gate above proves every adapter is HANDED the limiter. This proves the handed
    // one is the one that runs — a construction that passed it and then resolved the singleton
    // anyway would satisfy the text and not this.
    const asked: string[] = [];
    const runtime = createSharedRuntime({
      env: loadEnv({}),
      version: '0.0.0-test',
      cacheStoreFactory: inertCache,
      budgetStoreFactory: () => ({}) as unknown as BudgetStore,
      throttle: (providerId) => {
        asked.push(providerId);
        // Refusing here is what keeps this test offline: every adapter awaits the limiter BEFORE it
        // reaches `safeFetch`, so a rejection ends the attempt with no socket opened (R-21).
        return Promise.reject(new Error('limiter-wiring probe'));
      },
    });

    // `(capability, chain, args)` — the chain is its OWN argument AND a key the adapter validates,
    // because the adapter refuses invalid args BEFORE it reaches the limiter. Omit it and this case
    // measures argument validation instead of wiring.
    const outcome = await runtime.registry
      .resolve('chain.tvl', 'ethereum', { chain: 'ethereum' })
      .catch((error: unknown) => error);

    // `chain.tvl` routes to `defillama` alone (`providers.config.ts`), so the id is exact rather
    // than "something was asked".
    expect(asked).toStrictEqual(['defillama']);
    // And the probe's refusal is what ended the attempt — proof that the walk stopped AT the
    // limiter and not at a vendor, which is what keeps this case offline.
    expect((outcome as Error).message).toContain('limiter-wiring probe');
  });
});
