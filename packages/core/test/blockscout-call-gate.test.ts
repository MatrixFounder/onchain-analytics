import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createBlockscoutAdapter, type ProviderAdapter } from '../src/index.js';
import { CapabilityRegistry } from '../src/adapters/registry.js';
import { CapabilityUnavailableError } from '../src/adapters/registry.js';
import { routes } from '../src/providers.config.js';
import {
  ProviderCallCeilingExceededError,
  ProviderCallGateUnavailableError,
  type CallGate,
} from '../src/adapters/blockscout/call-gate.js';
import { RateLimitRejectedError, type Throttle } from '../src/net/rate-limit.js';
import { isolatedThrottle } from './helpers/isolated-throttle.js';
import { BLOCKSCOUT_TEST_ENV } from './helpers/blockscout-env.js';

/**
 * Task 015-15 (ADR-003 D6, R-9/R-11, `system-architecture.md` §3.5.4) — the daily call gate WIRED
 * into the adapter, beside `throttle()`, on all four routes. `call-gate-contract.test.ts`
 * (015-13/015-14) already proves the gate's own contract in isolation; this file proves the SEAM —
 * that `index.ts` actually calls it, once per network attempt, before the limiter, on every route,
 * with no per-route configuration.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const FIXED_NOW = 1_700_000_000_000;
const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const BINANCE = '0x28C6c06298d514Db089934071355E5743bf21d60';

/** A gate stub that admits every call and counts how many times it was asked. */
function admittingGate(): { gate: CallGate; calls: number[] } {
  const calls: number[] = [];
  return {
    calls,
    gate: {
      ensureCallBudget: async (now: () => number) => {
        calls.push(now());
      },
    },
  };
}

const emptyBodyFetch: typeof fetch = (async () =>
  new Response(JSON.stringify({}), { status: 200 })) as unknown as typeof fetch;

describe('TC-UNIT-01/02: the gate runs once per network attempt, on every route, with no route-level config', () => {
  it('TC-UNIT-01: one route call makes exactly one gate call', async () => {
    const { gate, calls } = admittingGate();
    const adapter = createBlockscoutAdapter({
      now: () => FIXED_NOW,
      env: BLOCKSCOUT_TEST_ENV,
      callGate: gate,
      throttle: isolatedThrottle(FIXED_NOW),
      fetchImpl: emptyBodyFetch,
    });

    await adapter.fetch('gas.price', { chain: 'ethereum' });

    expect(calls).toHaveLength(1);
  });

  it('TC-UNIT-02: four routes, four gate calls — nobody wired its own', async () => {
    const { gate, calls } = admittingGate();
    const adapter = createBlockscoutAdapter({
      now: () => FIXED_NOW,
      env: BLOCKSCOUT_TEST_ENV,
      callGate: gate,
      throttle: isolatedThrottle(FIXED_NOW),
      fetchImpl: emptyBodyFetch,
    });

    await adapter.fetch('gas.price', { chain: 'ethereum' });
    await adapter.fetch('chain.transactions', { chain: 'ethereum' });
    await adapter.fetch('token.holders', { chain: 'ethereum', tokenAddress: USDC });
    await adapter.fetch('entity.labels', { chain: 'ethereum', tokenAddress: BINANCE });

    expect(calls).toHaveLength(4);
  });
});

describe('TC-UNIT-03: the gate runs BEFORE throttle() — either guard may refuse first', () => {
  it('on an admitted call, the gate runs first, then throttle', async () => {
    const order: string[] = [];
    const gate: CallGate = {
      ensureCallBudget: async () => {
        order.push('gate');
      },
    };
    const throttleStub: Throttle = async () => {
      order.push('throttle');
    };
    const adapter = createBlockscoutAdapter({
      now: () => FIXED_NOW,
      env: BLOCKSCOUT_TEST_ENV,
      callGate: gate,
      throttle: throttleStub,
      fetchImpl: emptyBodyFetch,
    });

    await adapter.fetch('gas.price', { chain: 'ethereum' });

    expect(order).toEqual(['gate', 'throttle']);
  });

  it('when the gate refuses, throttle is never reached — refusing does not need a wait', async () => {
    const order: string[] = [];
    const gate: CallGate = {
      ensureCallBudget: async () => {
        order.push('gate');
        throw new ProviderCallCeilingExceededError(
          'daily calls spent for provider=blockscout: 625 of 625 calls already made today (day starts 1700000000000)',
        );
      },
    };
    const throttleStub: Throttle = async () => {
      order.push('throttle');
    };
    const adapter = createBlockscoutAdapter({
      now: () => FIXED_NOW,
      env: BLOCKSCOUT_TEST_ENV,
      callGate: gate,
      throttle: throttleStub,
      fetchImpl: emptyBodyFetch,
    });

    await expect(adapter.fetch('gas.price', { chain: 'ethereum' })).rejects.toThrow(
      ProviderCallCeilingExceededError,
    );
    expect(order).toEqual(['gate']);
  });
});

it('TC-UNIT-04: a bucket refusal survives even though the gate is healthy', async () => {
  const gate: CallGate = { ensureCallBudget: async () => undefined };
  const throttleStub: Throttle = async () => {
    throw new RateLimitRejectedError('blockscout', 'computed wait 900ms exceeds the 30000ms cap', {
      remaining: -1,
      ceiling: 5,
      refillPerSec: 2,
    });
  };
  const adapter = createBlockscoutAdapter({
    now: () => FIXED_NOW,
    env: BLOCKSCOUT_TEST_ENV,
    callGate: gate,
    throttle: throttleStub,
    fetchImpl: emptyBodyFetch,
  });

  await expect(adapter.fetch('gas.price', { chain: 'ethereum' })).rejects.toThrow(
    /throttle: rejected/,
  );
});

describe('TC-UNIT-05/06 (AC-24): ceiling exhaustion on a single-adapter route is a typed, distinguishable refusal', () => {
  const cases: readonly [string, Record<string, unknown>][] = [
    ['token.holders', { chain: 'ethereum', tokenAddress: USDC }],
    ['chain.transactions', { chain: 'ethereum' }],
  ];

  for (const [cap, args] of cases) {
    it(`${cap}: an exhausted ceiling ends the call, carrying the ceiling marker`, async () => {
      const gate: CallGate = {
        ensureCallBudget: async () => {
          throw new ProviderCallCeilingExceededError(
            'daily calls spent for provider=blockscout: 625 of 625 calls already made today ' +
              '(day starts 1700000000000)',
          );
        },
      };
      const adapter = createBlockscoutAdapter({
        now: () => FIXED_NOW,
        env: BLOCKSCOUT_TEST_ENV,
        callGate: gate,
        throttle: isolatedThrottle(FIXED_NOW),
        fetchImpl: emptyBodyFetch,
      });
      const registry = new CapabilityRegistry(
        [...routes],
        new Map<string, ProviderAdapter>([['blockscout', adapter]]),
      );

      const caught = await registry.resolve(cap, 'ethereum', args).then(
        () => undefined,
        (error: unknown) => error as CapabilityUnavailableError,
      );

      expect(caught, `${cap} must refuse, not answer`).toBeInstanceOf(CapabilityUnavailableError);
      expect(caught!.tried).toHaveLength(1);
      expect(caught!.tried[0]?.adapterId).toBe('blockscout');
      expect(caught!.tried[0]?.reason).toContain('daily call ceiling reached');
      expect(caught!.message).toContain('daily call ceiling reached');
    });
  }
});

describe('TC-UNIT-07 (AC-25): the two refusals are distinguishable BY VALUE once wired through the registry', () => {
  it('the four owner substrings partition across the two texts — fails if either text is swapped for the other', async () => {
    const ceilingGate: CallGate = {
      ensureCallBudget: async () => {
        throw new ProviderCallCeilingExceededError(
          'daily calls spent for provider=blockscout: 625 of 625 calls already made today ' +
            '(day starts 1700000000000)',
        );
      },
    };
    const ceilingAdapter = createBlockscoutAdapter({
      now: () => FIXED_NOW,
      env: BLOCKSCOUT_TEST_ENV,
      callGate: ceilingGate,
      throttle: isolatedThrottle(FIXED_NOW),
      fetchImpl: emptyBodyFetch,
    });
    const ceilingRegistry = new CapabilityRegistry(
      [...routes],
      new Map<string, ProviderAdapter>([['blockscout', ceilingAdapter]]),
    );
    const ceilingError = await ceilingRegistry
      .resolve('token.holders', 'ethereum', { chain: 'ethereum', tokenAddress: USDC })
      .then(
        () => undefined,
        (error: unknown) => error as CapabilityUnavailableError,
      );

    const okGate: CallGate = { ensureCallBudget: async () => undefined };
    const saturatingThrottle: Throttle = async () => {
      throw new RateLimitRejectedError(
        'blockscout',
        'computed wait 900ms exceeds the 30000ms cap',
        { remaining: -1, ceiling: 5, refillPerSec: 2 },
      );
    };
    const bucketAdapter = createBlockscoutAdapter({
      now: () => FIXED_NOW,
      env: BLOCKSCOUT_TEST_ENV,
      callGate: okGate,
      throttle: saturatingThrottle,
      fetchImpl: emptyBodyFetch,
    });
    const bucketRegistry = new CapabilityRegistry(
      [...routes],
      new Map<string, ProviderAdapter>([['blockscout', bucketAdapter]]),
    );
    const bucketError = await bucketRegistry
      .resolve('token.holders', 'ethereum', { chain: 'ethereum', tokenAddress: USDC })
      .then(
        () => undefined,
        (error: unknown) => error as CapabilityUnavailableError,
      );

    const ceilingText = ceilingError!.message;
    const bucketText = bucketError!.message;

    expect(ceilingText).toContain('daily call ceiling reached');
    expect(bucketText).not.toContain('daily call ceiling reached');
    expect(bucketText).toContain('throttle: rejected');
    expect(ceilingText).not.toContain('throttle: rejected');
    expect(ceilingText).not.toContain('rate limit');
    expect(ceilingText).not.toContain('bucket');
  });
});

it('TC-UNIT-08 (MINOR-6): the docstring names the moment of counting as ADMISSION, not confirmation', () => {
  const source = readFileSync(
    path.join(repoRoot, 'packages/core/src/adapters/blockscout/call-gate.ts'),
    'utf8',
  );
  // The moment named.
  expect(source).toMatch(/admission/i);
  // The consequence named: a throttle-rejected or network-aborted attempt is STILL counted.
  expect(source).toMatch(/throttle/);
  expect(source).toMatch(/(already )?counted (anyway|too)?/i);
});

it('re-confirms ProviderCallGateUnavailableError is a distinct class from ProviderCallCeilingExceededError (sanity for the seam above)', () => {
  const unavailable = new ProviderCallGateUnavailableError('ledger value is not a finite number');
  expect(unavailable).not.toBeInstanceOf(ProviderCallCeilingExceededError);
  expect(unavailable.message).not.toContain('daily call ceiling reached');
});
