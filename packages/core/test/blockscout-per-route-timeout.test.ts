import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { BLOCKSCOUT_TEST_ENV } from './helpers/blockscout-env.js';
import { isolatedThrottle } from './helpers/isolated-throttle.js';

/**
 * TC-UNIT-01/02 (task 014-42, L-12) — the hop ceiling is a property of the ROUTE, and this file is
 * the only thing that can say so.
 *
 * **What it pins and why nothing else could.** `blockscout` sends `timeoutMs` into `safeFetch`,
 * which turns it into an `AbortSignal.timeout` — a signal whose delay has no reader. So the number
 * is observable at exactly one boundary: the call into `safeFetch`. Everything downstream of it
 * expresses the ceiling only by taking that long to fail, and a suite that waited 60 s to learn a
 * constant would be deleted by the first person in a hurry.
 *
 * **Both directions are asserted, and the second is the one that rots.** The raise is easy to see in
 * a diff. What silently spreads is the raise leaking onto the routes that were deliberately left
 * fast: `gas.price` and `chain.transactions` measured 0.3–0.8 s, so a 60 s ceiling there would buy
 * nothing and would ABSORB a future vendor-wide slowdown into longer waits and green rows instead of
 * surfacing it as failures in the live gate. That reasoning lives in `HOLDERS_TIMEOUT_MS`'s
 * docstring; this is the part of it that a machine can check.
 *
 * `vi.mock` is file-global, so this suite gets its own file — the convention
 * `policy-fail-open.test.ts` established for the same reason. Mocking `safeFetch` here would make
 * every other blockscout suite stop exercising the real transport.
 */

/** Every `safeFetch` call this file provokes, in order — url and the options the adapter chose. */
const calls: { url: string; timeoutMs: number | undefined }[] = [];

vi.mock('../src/net/safe-fetch.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/net/safe-fetch.js')>();
  return {
    ...actual,
    safeFetch: (
      url: string,
      _init: unknown,
      _allowlist: unknown,
      _fetchImpl: unknown,
      options: { timeoutMs?: number },
    ) => {
      calls.push({ url, timeoutMs: options.timeoutMs });
      // Rejecting rather than resolving: the assertion is about what was REQUESTED, and a synthetic
      // body would then have to satisfy each route's normalizer, which is a different test's job.
      return Promise.reject(
        new Error('safeFetch: stopped by the mock, after recording the options'),
      );
    },
  };
});

const { createBlockscoutAdapter } = await import('../src/adapters/blockscout/index.js');
const { capabilityManifests } = await import('../src/capability-manifest.js');

/**
 * The committed probe output, read rather than restated.
 *
 * This is what makes the ceiling re-checkable instead of remembered: re-run
 * `scripts/probe-blockscout-holders-latency.ts`, commit the newer evidence file, and the assertion
 * below re-derives its verdict from the vendor's CURRENT behaviour. A literal here would keep
 * agreeing with itself while the vendor moved.
 */
const testDir = path.dirname(fileURLToPath(import.meta.url));
const evidence = JSON.parse(
  readFileSync(
    path.join(
      testDir,
      '../../../docs/onchain-analytics/raw/blockscout-holders-latency-2026-08-21.json',
    ),
    'utf8',
  ),
) as { slowestAnswerMs: number; readings: Record<string, string[]> };

/** The vendor's own default and the one route measured to need more. Kept as literals on purpose:
 * reading them from the module under test would let a bad edit move the expectation with the code. */
const DEFAULT_HOP_MS = 5_000;
const HOLDERS_HOP_MS = 60_000;

const WETH = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2';

async function timeoutFor(capability: string, args: Record<string, unknown>): Promise<number> {
  calls.length = 0;
  const adapter = createBlockscoutAdapter({
    env: BLOCKSCOUT_TEST_ENV,
    throttle: isolatedThrottle(),
  });
  // Any rejection: the adapter's WI-36 wrapper re-messages an unrecognised throw as "transport
  // failure from <host>", so matching the mock's own text would assert the wrapper's behaviour
  // instead of this file's subject.
  await expect(adapter.fetch(capability, args)).rejects.toThrow();
  expect(calls, `${capability} reached safeFetch exactly once`).toHaveLength(1);
  const chosen = calls[0]?.timeoutMs;
  expect(
    chosen,
    `${capability} sent no timeoutMs — the hop would fall back to safeFetch's 15 s default`,
  ).toBeTypeOf('number');
  return chosen as number;
}

describe('task 014-42 — the blockscout hop ceiling is per route', () => {
  it('TC-UNIT-01: token.holders asks for the measured 60 s, not the adapter default', async () => {
    // The number the 2026-08-21 probe produced: the slowest SUCCESSFUL holders answer was 45_831 ms
    // (base), so 5 s and 30 s both refuse a call the vendor was going to serve. See
    // `scripts/probe-blockscout-holders-latency.ts`.
    await expect(
      timeoutFor('token.holders', { chain: 'ethereum', tokenAddress: WETH }),
    ).resolves.toBe(HOLDERS_HOP_MS);
  });

  it('TC-UNIT-02: the other three routes keep 5 s — the raise did not spread', async () => {
    // Written as a table rather than three cases so that a FOURTH route added to this adapter shows
    // up here as an uncovered name rather than as silence.
    const others: [string, Record<string, unknown>][] = [
      ['gas.price', { chain: 'ethereum' }],
      ['chain.transactions', { chain: 'ethereum' }],
      // `tokenAddress`, never `address` — B-1 in the adapter records why the second name reaches
      // no code path, and hand-built args are exactly how that defect survived its unit tests.
      ['entity.labels', { chain: 'ethereum', tokenAddress: WETH, exhaustive: false }],
    ];
    for (const [capability, args] of others) {
      await expect(timeoutFor(capability, args), capability).resolves.toBe(DEFAULT_HOP_MS);
    }
  });

  it('TC-UNIT-03: the call deadline clears the slowest answer the vendor actually gave', () => {
    const manifest = capabilityManifests['token.holders'];
    expect(manifest, 'token.holders left the manifest').toBeDefined();

    // The hop ceiling above is bounded by this one — the deadline is ABSOLUTE and refuses first, so
    // a 60 s hop under a 15 s deadline would change nothing. Asserting them together is the point:
    // the pair is one decision, and either half alone is inert.
    expect(manifest?.deadlineMs).toBeGreaterThanOrEqual(HOLDERS_HOP_MS);

    // Against the MEASUREMENT, not against a number copied out of the source. 45_831 ms was a
    // successful answer, so a ceiling at or below it refuses a call the vendor was going to serve —
    // which is the failure L-12 spent ten days being.
    expect(
      manifest?.deadlineMs,
      `the deadline must exceed ${String(evidence.slowestAnswerMs)}ms, the slowest SUCCESSFUL ` +
        'holders answer in the committed probe — re-run the probe before moving this number down',
    ).toBeGreaterThan(evidence.slowestAnswerMs);

    // The evidence has to still say what licensed a per-CAPABILITY ceiling. If a later probe ever
    // reports `vendor-is-slow`, the control endpoint slowed too and this decision needs remaking:
    // a ceiling on one capability buys nothing when the whole adapter is behind.
    expect(
      evidence.readings['vendor-is-slow'],
      'the probe now reports the VENDOR as slow, not just this route — a per-capability ceiling ' +
        'is the wrong instrument for that, see HOLDERS_TIMEOUT_MS',
    ).toStrictEqual([]);
  });

  it('the gate is not vacuous — the two ceilings differ and the mock really intercepted', async () => {
    // Sign of work before the verdict. Two ways the cases above could pass while asserting
    // nothing: the constants set equal (then both expectations hold and the decision is undone),
    // or the mock silently not intercepting (then `calls` is empty and `timeoutFor` would have
    // thrown — so this re-drives one route rather than reading a counter the earlier cases reset).
    expect(HOLDERS_HOP_MS).toBeGreaterThan(DEFAULT_HOP_MS);
    await timeoutFor('gas.price', { chain: 'ethereum' });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain('mcp.blockscout.com');
  });
});
