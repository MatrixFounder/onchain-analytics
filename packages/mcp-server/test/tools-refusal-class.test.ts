import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { CapabilityDeadlineExceededError } from '@onchain-intel/core';
import { resolveCapability } from '../src/tools/resolve-capability.js';
import {
  OUTPUT_CONTRACT_REFUSAL_CLASS,
  contractViolation,
} from '../src/tools/contract-violation.js';
import { z } from 'zod';

/**
 * Task 014-30, `OD-014-30-11` — every refusal names the class that produced it.
 *
 * `request_trace.refusal_class` is `NOT NULL` on every refusal row by CHECK constraint, so a
 * producer that omits the class produces a row the engine rejects — at runtime, on the failure path,
 * which is the worst place to discover it. There are exactly two producers, and this file holds both
 * plus the gate that keeps a third from appearing silently.
 */

const TOOLS_DIR = path.resolve(__dirname, '../src/tools');

/** Code lines only: a `{ok: false, reason}` inside a docstring is prose about the shape. */
const codeOnly = (body: string): string =>
  body
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');

describe('the thrown class survives to the outcome', () => {
  const registryThrowing = (error: unknown): Parameters<typeof resolveCapability>[0] =>
    ({ resolve: () => Promise.reject(error) }) as unknown as Parameters<
      typeof resolveCapability
    >[0];

  it('records the name of the class the walk threw, not a classification of its text', async () => {
    // Two DIFFERENT names, because `IS NOT NULL` is not the property under test.
    // `transport/failure-classes.ts` carries byte-identical markers for two distinct classes, so any
    // implementation recovering the class from `reason` would collapse these into one value.
    //
    // One is a real exported class; the other is local and carries the SAME `.message` as the first,
    // so a test that passed by reading the message would fail here.
    const deadlineError = new CapabilityDeadlineExceededError({
      capability: 'token.price',
      chain: 'ethereum',
      tried: [],
    });
    class VendorRefusedError extends Error {
      override readonly name = 'VendorRefusedError';
    }
    const impostor = new VendorRefusedError(deadlineError.message);

    const deadline = await resolveCapability(
      registryThrowing(deadlineError),
      'token.price',
      'ethereum',
      {},
    );
    const vendor = await resolveCapability(
      registryThrowing(impostor),
      'token.price',
      'ethereum',
      {},
    );

    if (deadline.ok || vendor.ok) throw new Error('both calls were expected to refuse');
    expect(deadline.refusalClass).toBe('CapabilityDeadlineExceededError');
    expect(vendor.refusalClass).toBe('VendorRefusedError');
    // Same text, different class — the two rows stay distinguishable on the axis the ledger records.
    expect(deadline.reason).toBe(vendor.reason);
  });

  it('names a non-Error throw as such rather than leaving the column empty', async () => {
    // The column is NOT NULL, so "we could not tell" still has to be written as something. A row
    // saying `NonErrorThrow` is a different claim from a row that failed to record anything, and
    // only the first is distinguishable from a bug in this plumbing.
    const outcome = await resolveCapability(
      registryThrowing('a bare string'),
      'token.price',
      'ethereum',
      {},
    );
    expect(outcome.ok === false && outcome.refusalClass).toBe('NonErrorThrow');
  });
});

describe('an output-contract violation names its own class', () => {
  it('returns the reason and the declared constant together', () => {
    const error = z.object({ a: z.string() }).safeParse({ a: 1 });
    expect(error.success).toBe(false);
    const outcome = contractViolation('token.price', error.error!);

    expect(outcome.ok).toBe(false);
    expect(outcome.refusalClass).toBe(OUTPUT_CONTRACT_REFUSAL_CLASS);
    expect(outcome.reason).toContain('token.price');
  });

  it('is not an error class name, and says so by not being one', () => {
    // This refusal has no `Error` instance: a tool holds a `ZodError` about a PROVIDER's response
    // and branches. The constant is the name of the refusal, declared where the refusal is made.
    expect(OUTPUT_CONTRACT_REFUSAL_CLASS).toBe('OutputContractViolation');
  });
});

describe('gate: no tool module builds a refusal by hand', () => {
  it('every `ok: false` literal lives in one of the two declared producers', () => {
    // The defect this prevents produces a GREEN suite and a REJECTED row: a twentieth tool pastes
    // `{ ok: false, reason: … }`, every existing test passes, and the CHECK constraint fires in
    // production on the failure path. Three files may construct one — the pair constructor, the one
    // place a thrown instance is still in scope, and (task 014-32b) the stub-interval refusal.
    //
    // **The gate's subject is the missing CLASS, not the number of files.** `stub-refusal.ts` always
    // carries one, which is precisely what this gate asks for. What would be a real weakening is a
    // TOOL module building a refusal inline, and that is still forbidden.
    const ALLOWED = new Set(['contract-violation.ts', 'resolve-capability.ts', 'stub-refusal.ts']);
    const offenders = readdirSync(TOOLS_DIR)
      .filter((file) => file.endsWith('.ts') && !ALLOWED.has(file))
      .filter((file) => {
        const text = codeOnly(readFileSync(path.join(TOOLS_DIR, file), 'utf8'));
        // `ok: false;` is a TYPE member, not a construction — the local outcome unions declare it.
        return /\bok:\s*false\s*,/.test(text);
      });

    expect(
      offenders,
      'These modules construct a refusal directly. A refusal without its class is a row the ' +
        'request_trace CHECK constraint rejects; use `contractViolation()` or forward what ' +
        '`resolveCapability` returned.',
    ).toStrictEqual(['registry.ts']);
  });
});
