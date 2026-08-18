import { readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  capabilityManifests,
  loadChainRegistry,
  type CapabilityResolution,
  type CapabilityResolver,
} from '@onchain-intel/core';
import {
  DeadlineMsInputSchema,
  resolveCapability,
  DeadlineWideningRefusedError,
} from '../src/tools/resolve-capability.js';
import { toolSpecs } from '../src/tools/tool-specs.js';

/**
 * Task 014-23 — a deadline arriving from the network may only NARROW (R-16, AC-12).
 *
 * **Why the wire value is a DURATION and the registry's is a moment.** `interfaces.md` §5.4.5:
 * accepting an absolute instant from a client would let a remote clock's skew set our spending
 * bound. The server converts from its own clock at admission, and this file measures that the
 * conversion happens here rather than being passed through.
 *
 * **Refused, not clamped, and the difference is the criterion.** The registry has always narrowed
 * silently (`Math.min(now + manifest.deadlineMs, requested ?? Infinity)`), which satisfies R-144 for
 * an in-process caller. AC-12 asks for something else: a widening value is REJECTED and the call is
 * NOT STARTED. Clamping would answer under a bound the caller is never told about — they ask for
 * 120 s, receive 15 s of work, and read the shorter answer as the vendor's.
 */

const CAPABILITY = 'chain.tvl';
const DECLARED_MS = capabilityManifests[CAPABILITY]?.deadlineMs;

/** Records every `resolve` it is handed, so "the call was not started" is an observation. */
function recordingResolver(): CapabilityResolver & { calls: (number | undefined)[] } {
  const chains = loadChainRegistry();
  const calls: (number | undefined)[] = [];
  return {
    calls,
    getChainRegistry: () => chains,
    getCoverage: () => {
      throw new Error('not used');
    },
    resolve: (_capability, _chain, _args, requestedDeadlineAtMs): Promise<CapabilityResolution> => {
      calls.push(requestedDeadlineAtMs);
      return Promise.resolve({
        result: {
          chain: 'ethereum',
          name: 'Ethereum',
          tvlUsd: 1,
          source: 'defillama',
          fetchedAt: 1,
        },
        source: 'defillama',
        cache: 'miss',
        attempted: ['defillama'],
      });
    },
  };
}

describe('the manifest number this task compares against is read, never written here', () => {
  it('`chain.tvl` declares a deadline', () => {
    // A test that hardcoded the ceiling would agree with itself after the manifest moved.
    expect(DECLARED_MS).toBeTypeOf('number');
    expect(DECLARED_MS).toBeGreaterThan(0);
  });
});

describe('TC-UNIT-01: a narrowing deadline is accepted and applied', () => {
  it('reaches the registry as an absolute moment computed from OUR clock', async () => {
    const registry = recordingResolver();
    const narrow = Math.floor((DECLARED_MS ?? 0) / 2);
    const before = Date.now();
    const outcome = await resolveCapability(registry, CAPABILITY, 'ethereum', {}, narrow);
    const after = Date.now();

    expect(outcome.ok).toBe(true);
    expect(registry.calls).toHaveLength(1);
    const passed = registry.calls[0];
    expect(passed).toBeTypeOf('number');
    // A moment, not the duration — and one this process could have produced. The window is the two
    // clock reads around the call, so a pass-through of the raw duration (a small number near the
    // epoch) cannot satisfy it.
    expect(passed).toBeGreaterThanOrEqual(before + narrow);
    expect(passed).toBeLessThanOrEqual(after + narrow);
  });

  it('and absence still means the capability’s own budget', async () => {
    const registry = recordingResolver();
    await resolveCapability(registry, CAPABILITY, 'ethereum', {});
    // `undefined`, not `now + declared`: the registry applies the manifest itself, and computing it
    // here as well would put the same ceiling in two places to drift apart.
    expect(registry.calls).toStrictEqual([undefined]);
  });
});

describe('TC-UNIT-02: a deadline equal to the declared one is accepted', () => {
  it('the boundary is “greater than”, not “greater than or equal”', async () => {
    const registry = recordingResolver();
    const outcome = await resolveCapability(registry, CAPABILITY, 'ethereum', {}, DECLARED_MS ?? 0);
    expect(outcome.ok).toBe(true);
    expect(registry.calls).toHaveLength(1);
  });
});

describe('TC-E2E-01 / AC-12: a widening deadline is refused, and the call is not started', () => {
  it('refuses one millisecond over, naming both numbers', async () => {
    const registry = recordingResolver();
    const outcome = await resolveCapability(
      registry,
      CAPABILITY,
      'ethereum',
      {},
      (DECLARED_MS ?? 0) + 1,
    );

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.refusalClass).toBe(DeadlineWideningRefusedError.name);
    // Both numbers, because the correction is otherwise a guess.
    expect(outcome.reason).toContain(String((DECLARED_MS ?? 0) + 1));
    expect(outcome.reason).toContain(String(DECLARED_MS));
    expect(outcome.reason).toContain(CAPABILITY);
    // AC-12's second half, and the half a clamp would fail: no adapter was entered, no cache slot
    // was read, and no credit could be reserved.
    expect(registry.calls, 'the call was started anyway').toStrictEqual([]);
  });

  it('a value the schema would never pass is refused by the schema, not by the boundary', () => {
    // The two halves of §5.4.5: the tool's zod schema validates the SHAPE, the boundary compares the
    // VALUE. A malformed number must not reach the comparison at all, because the registry reads a
    // malformed deadline as ABSENCE — i.e. as the full budget, which is more time than was asked
    // for and therefore the widening R-16.2 forbids, arrived at by omission.
    for (const bad of [
      0,
      -1,
      1.5,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.MAX_SAFE_INTEGER + 2,
    ]) {
      expect(DeadlineMsInputSchema.safeParse(bad).success, String(bad)).toBe(false);
    }
    expect(DeadlineMsInputSchema.safeParse(15_000).success).toBe(true);
    // Absent is legitimate: it means the capability's own budget.
    expect(DeadlineMsInputSchema.safeParse(undefined).success).toBe(true);
  });
});

describe('every tool that resolves a capability accepts the caller’s bound', () => {
  const toolsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/tools');

  it('derived from which modules call `resolveCapability`, never from a list here', () => {
    // The rule, stated once: a tool that reaches the registry can be bounded, and a tool that does
    // not has nothing to bound. `onchain_ping` resolves nothing; `onchain_list_chains` answers from
    // the compiled registry without leaving the process.
    const resolving = readdirSync(toolsDir)
      .filter((file) => file.endsWith('.ts') && file !== 'resolve-capability.ts')
      .filter((file) =>
        readFileSync(path.join(toolsDir, file), 'utf8').includes('await resolveCapability('),
      );
    expect(resolving.length).toBeGreaterThanOrEqual(18);

    const missing = resolving.filter(
      (file) => !readFileSync(path.join(toolsDir, file), 'utf8').includes('DeadlineMsInputSchema'),
    );
    expect(
      missing,
      'a tool reaches the registry with no way for the caller to bound it',
    ).toStrictEqual([]);
  });

  it('and the published schema is where a client actually sees it', () => {
    // The gate above reads source; this one reads the contract. A field declared in zod and lost in
    // rendering would satisfy the first and fail the second.
    const snapshot = JSON.parse(
      readFileSync(
        path.resolve(
          path.dirname(fileURLToPath(import.meta.url)),
          'fixtures/tools-list.snapshot.json',
        ),
        'utf8',
      ),
    ) as { name: string; inputSchema: { properties?: Record<string, unknown> } }[];

    const withoutDeadline = snapshot
      .filter((tool) => tool.name !== 'onchain_ping' && tool.name !== 'onchain_list_chains')
      .filter((tool) => tool.inputSchema.properties?.['deadlineMs'] === undefined)
      .map((tool) => tool.name);
    expect(withoutDeadline).toStrictEqual([]);
    expect(toolSpecs.length).toBe(snapshot.length);
  });
});
