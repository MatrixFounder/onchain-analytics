import { describe, expect, it } from 'vitest';
// @ts-expect-error — the eval is plain .mjs by design (no build step, no SDK); only its data is read
import { CAPABILITY_CASES, CASES, TRANSPORT_CASES, validateCase } from '../eval/cases/index.mjs';
// @ts-expect-error — same
import { checks } from '../eval/checks.mjs';
import { toolSpecs } from '../src/tools/tool-specs.js';

/**
 * The third kind of eval case, offline (task 014-33).
 *
 * **What this file can and cannot prove.** The transport cases themselves need a raised HTTP
 * profile, which R-21 forbids in CI. What is provable offline is the SHAPE contract: that the
 * loader refuses an incomplete transport case, that the four files load, and that they stay out of
 * the capability axis and out of the per-tool check map. Those three are exactly what would break
 * silently if the third kind were wired wrongly — the fourth kind of failure, a case that loads and
 * asserts nothing, is the one `validate` exists to prevent.
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
  it('four transport cases are loaded, and every one names http', () => {
    const transport = TRANSPORT_CASES as LoadedCase[];
    expect(transport).toHaveLength(4);
    expect(transport.map((c) => c.file).sort()).toStrictEqual([
      'http-auth-rejected.mjs',
      'http-perimeter-rejected.mjs',
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
