import { describe, expect, it } from 'vitest';
// @ts-expect-error — the eval is plain .mjs by design (no build step, no SDK); only its data is read
import { CAPABILITY_CASES, CASES, TRANSPORT_CASES, validateCase } from '../eval/cases/index.mjs';
// @ts-expect-error — same
import { checks } from '../eval/checks.mjs';
// @ts-expect-error — same: the rate case exports its derivation so TC-UNIT-16 can check it offline
import { PLAN } from '../eval/cases/http-shared-limiter-rate.mjs';
import { adapterRegistrations } from '@onchain-intel/core';
import { toolSpecs } from '../src/tools/tool-specs.js';

/**
 * The third kind of eval case, offline (task 014-33).
 *
 * **What this file can and cannot prove.** The transport cases themselves need a raised HTTP
 * profile, which R-21 forbids in CI. What is provable offline is the SHAPE contract: that the
 * loader refuses an incomplete transport case, that the five files load, and that they stay out of
 * the capability axis and out of the per-tool check map. Those three are exactly what would break
 * silently if the third kind were wired wrongly — the fourth kind of failure, a case that loads and
 * asserts nothing, is the one `validate` exists to prevent.
 *
 * TC-UNIT-16 adds a fourth thing that IS provable offline: the arithmetic of
 * `http-shared-limiter-rate`, and its verdict on observations handed to it directly. A case whose
 * `check` is only ever exercised by a live run is a case nobody has seen fail.
 *
 * **Why the validator is called directly rather than a bad file being written to the directory.** A
 * file carrying an incomplete case, placed under `eval/cases/`, throws at import for EVERY consumer:
 * this suite, the runner, both coverage tests. The refusal has to be provable without making the
 * repository unloadable, so the function is exported and handed objects.
 */

interface LoadedCase {
  kind: string;
  file: string;
  label?: string;
  transport?: string;
}

describe('TC-UNIT-04 — an incomplete transport case does not load', () => {
  const complete = {
    kind: 'transport',
    transport: 'http',
    catches: 'a drift long enough to be a real sentence about what this case exists to catch',
    exercise: () => ({}),
    check: () => [],
  };

  const cases: [string, Record<string, unknown>, RegExp][] = [
    ['no check', { ...complete, check: undefined }, /case\.check must be a function/],
    ['no catches', { ...complete, catches: '' }, /case\.catches must say what vendor drift/],
    ['no transport', { ...complete, transport: '' }, /must name its transport/],
    ['no exercise', { ...complete, exercise: undefined }, /must carry an exercise\(ctx\) function/],
  ];

  for (const [name, broken, expected] of cases) {
    it(`refuses a transport case with ${name}`, () => {
      expect(() => validateCase('http-broken.mjs', { default: broken })).toThrowError(expected);
    });
  }

  it('accepts the complete one — otherwise the four cases above pass for the wrong reason', () => {
    const loaded = validateCase('http-example.mjs', { default: complete }) as LoadedCase;
    expect(loaded.kind).toBe('transport');
    // The label is DERIVED from the file name, so a transport row is nameable in
    // eval/acknowledged.json without a second source for its name.
    expect(loaded.label).toBe('transport:http-example');
  });
});

describe('TC-UNIT-05 — the transport files load and stay off the capability axis', () => {
  it('five transport cases are loaded, and every one names http', () => {
    const transport = TRANSPORT_CASES as LoadedCase[];
    expect(transport).toHaveLength(5);
    expect(transport.map((c) => c.file).sort()).toStrictEqual([
      'http-auth-rejected.mjs',
      'http-perimeter-rejected.mjs',
      'http-shared-limiter-rate.mjs',
      'http-shared-limiter.mjs',
      'http-success.mjs',
    ]);
    for (const c of transport) expect(c.transport).toBe('http');
  });

  it('none of them entered the capability axis', () => {
    // The axis the per-chain matrix walks. A transport case leaking into it would be called once
    // per selected chain, against a capability no registry declares.
    const capabilityFiles = (CAPABILITY_CASES as LoadedCase[]).map((c) => c.file);
    for (const c of TRANSPORT_CASES as LoadedCase[]) {
      expect(capabilityFiles).not.toContain(c.file);
    }
    // Sign of work before the verdict: an empty capability axis would satisfy the loop above.
    expect(capabilityFiles.length).toBeGreaterThan(10);
    expect((CASES as LoadedCase[]).length).toBe(
      capabilityFiles.length +
        (CASES as LoadedCase[]).filter((c) => c.kind === 'bootstrap').length +
        (TRANSPORT_CASES as LoadedCase[]).length,
    );
  });
});

describe('TC-UNIT-06 — transport cases add no keys to `checks`', () => {
  it('every key of `checks` is a registered tool name', () => {
    const registered = new Set(toolSpecs.map((spec) => spec.name));
    const keys = Object.keys(checks as Record<string, unknown>);
    expect(keys.length).toBeGreaterThan(10);
    for (const key of keys) {
      expect(registered, `checks has a key that is not a registered tool: ${key}`).toContain(key);
    }
  });

  it('no `checks` key carries a transport label', () => {
    // The specific way this would break: `indexByTool` keying a transport case by
    // `toolFor(undefined)` or by its label. Either lands a non-tool key in the map that `grade()`
    // and the coverage test both read.
    for (const key of Object.keys(checks as Record<string, unknown>)) {
      expect(key.startsWith('transport:')).toBe(false);
    }
  });
});

/**
 * TC-UNIT-16 — the rate case's arithmetic and its verdict, both offline (WI-63).
 *
 * **Why this is worth a suite of its own.** The case decides between two hypotheses — one shared
 * bucket, or one per session — from a single elapsed-time difference. Two things can make that
 * decision meaningless without any run failing: the probe size can stop separating the hypotheses
 * (a bucket tuned to refill faster), and the verdict can be evaluated against an arm that never
 * completed (a vendor outage read as a limiter defect). Both are asserted here, on values handed
 * in, because a live run is exactly where neither is reproducible on demand.
 */
describe('TC-UNIT-16 — the shared-limiter rate case decides between two hypotheses', () => {
  const registration = adapterRegistrations.find((r) => r.id === PLAN.provider);

  it('derives its numbers from providers.config, not from a copy of them', () => {
    // Re-derived here from the registration rather than compared against literals: a literal in
    // this file would be the second source of `{capacity, refillPerSec}` that WI-63 forbids.
    expect(registration).toBeDefined();
    const { capacity, refillPerSec } = registration!.rateLimit;
    expect(PLAN.capacity).toBe(capacity);
    expect(PLAN.refillPerSec).toBe(refillPerSec);
    expect(PLAN.controlCalls).toBe(capacity);
    expect(PLAN.fullRefillMs).toBe(Math.ceil((capacity / refillPerSec) * 1000));
    expect(PLAN.sharedFloorMs).toBe(Math.round(((PLAN.calls - capacity) / refillPerSec) * 1000));
    expect(PLAN.splitFloorMs).toBe(Math.round(((PLAN.calls / 2 - capacity) / refillPerSec) * 1000));
  });

  it('sizes the probe so the two hypotheses are actually separable', () => {
    // The three properties that make the verdict mean something: the control arm fits inside the
    // bucket, the per-session floor is above zero (so "no wait at all" is not the shared answer
    // too), and the gap between the hypotheses clears the noise bound.
    expect(PLAN.controlCalls).toBeLessThanOrEqual(PLAN.capacity);
    expect(PLAN.calls).toBeGreaterThan(2 * PLAN.capacity);
    expect(PLAN.calls % 2).toBe(0);
    expect(PLAN.splitFloorMs).toBeGreaterThan(0);
    expect(PLAN.gapMs).toBe(PLAN.sharedFloorMs - PLAN.splitFloorMs);
    expect(PLAN.gapMs).toBeGreaterThanOrEqual(PLAN.minSeparationMs);
  });

  const rateCase = (TRANSPORT_CASES as LoadedCase[]).find(
    (c) => c.file === 'http-shared-limiter-rate.mjs',
  ) as unknown as { check: (o: Record<string, unknown>) => string[] };

  /** A complete, healthy observation: every call answered, the wait on the shared-bucket side. */
  const shared = {
    sessionA: 'session-a',
    sessionB: 'session-b',
    calls: PLAN.calls,
    controlCalls: PLAN.controlCalls,
    controlMs: 400,
    measureMs: 400 + PLAN.sharedFloorMs,
    waitObservedMs: PLAN.sharedFloorMs,
    sharedFloorMs: PLAN.sharedFloorMs,
    splitFloorMs: PLAN.splitFloorMs,
    gapMs: PLAN.gapMs,
    controlAnswered: PLAN.controlCalls,
    answered: PLAN.calls,
    rpcErrors: [],
    toolErrors: [],
  };

  it('passes the shared-bucket observation — otherwise every case below passes vacuously', () => {
    expect(rateCase.check(shared)).toStrictEqual([]);
  });

  it('reports the per-session observation, naming both hypotheses', () => {
    const problems = rateCase.check({
      ...shared,
      measureMs: 400 + PLAN.splitFloorMs,
      waitObservedMs: PLAN.splitFloorMs,
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain(String(PLAN.sharedFloorMs));
    expect(problems[0]).toContain(String(PLAN.splitFloorMs));
    expect(problems[0]).toContain('per-session answer');
  });

  it('does NOT subtract the control arm — the false red of 2026-08-24', () => {
    // The observation that produced it, verbatim: the limiter had imposed its full 7000ms and the
    // RPC endpoint was slow for those few seconds, so `measure − control` read 2668ms and the case
    // reported a defect that did not exist. A one-sided bound is immune to it; this pins that.
    const problems = rateCase.check({ ...shared, measureMs: 7088, controlMs: 4420 });
    expect(problems).toStrictEqual([]);
  });

  it('reports a run it cannot decide, rather than passing it', () => {
    // The bound held, but vendor latency alone covers the gap between the hypotheses — so the
    // result is consistent with BOTH. "Cannot tell" must not read as "fine" (L-10).
    const problems = rateCase.check({
      ...shared,
      controlMs: PLAN.gapMs + 500,
      measureMs: PLAN.gapMs + 500 + PLAN.sharedFloorMs,
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('INCONCLUSIVE');
    expect(problems[0]).toContain(String(PLAN.gapMs));
  });

  it('withholds the timing verdict when an arm did not complete', () => {
    // A vendor outage makes the elapsed time small for a reason that has nothing to do with the
    // limiter. Asserting the timing anyway would file a vendor failure as a sharing defect.
    const problems = rateCase.check({
      ...shared,
      answered: PLAN.calls - 3,
      measureMs: 40,
      waitObservedMs: 0,
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('is not asserted');
  });

  it('refuses to measure when the bucket outgrew the probe ceiling', () => {
    const problems = rateCase.check({
      unmeasurable: '40 calls',
      capacity: 10,
      refillPerSec: 20,
      calls: 40,
    });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('40 calls');
    expect(problems[0]).toContain(String(PLAN.maxCalls));
  });

  it('reports two sessions sharing one id, which would measure one session twice', () => {
    const problems = rateCase.check({ ...shared, sessionB: 'session-a' });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('same id');
  });

  it('surfaces transport and tool errors rather than folding them into the timing', () => {
    const problems = rateCase.check({
      ...shared,
      rpcErrors: ['connection reset'],
      toolErrors: ['capability unavailable'],
      controlAnswered: 0,
      answered: 0,
    });
    expect(problems.some((p) => p.includes('connection reset'))).toBe(true);
    expect(problems.some((p) => p.includes('capability unavailable'))).toBe(true);
  });
});
