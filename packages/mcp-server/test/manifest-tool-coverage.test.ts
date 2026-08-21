import { describe, expect, it } from 'vitest';
import { capabilityManifests } from '@onchain-intel/core';
import { toolSpecs } from '../src/tools/tool-specs.js';
// @ts-expect-error — the eval is plain .mjs by design (no build step, no SDK); only its data is read
import { CAPABILITY_KNOWN_GAPS } from '../eval/capabilities.mjs';

/**
 * AC-29 — the manifest and the tool set are reconciled by a gate, not by reading (task 014-32c).
 *
 * **The postcondition, stated once** (`interfaces.md` §5.1): every manifest capability is either
 * RESOLVED by a registered tool, or NAMED in a declared list with a reason. Nothing may be neither.
 *
 * **Why this gate exists at all.** `pool.info` was declared by the manifest and served by no tool
 * for the whole of M1 and M2 — that is L-15, and nothing in the repository could see it. The
 * capability inventory and the tool inventory were each internally consistent; what was missing was
 * anything that compared them.
 *
 * **Why a declared list rather than "every capability must have a tool".** Six capabilities
 * legitimately have none: five are Dash Platform point-in-time keys whose only live consumer is the
 * merged HISTORY tool, and one is a metadata key whose route is covered under a different id. A rule
 * that forbade the state would be satisfied by deleting the rows, which loses a decision; a rule
 * that requires a REASON keeps the decision and makes an accidental gap distinguishable from a
 * deliberate one — the distinction `CAPABILITY_KNOWN_GAPS`'s own docstring already draws.
 *
 * **One list, not two.** The list is `eval/capabilities.mjs`'s `CAPABILITY_KNOWN_GAPS`, which
 * `interfaces.md` §5.1 names and warns against duplicating. A second list here would be a second
 * place for the same fact, and the copy is always the one that drifts.
 */

/** Every capability some registered tool resolves — from BOTH fields, never just `capability`. */
function servedCapabilities(): Set<string> {
  const served = new Set<string>();
  for (const spec of toolSpecs) {
    // `servedCapabilities` when a tool serves several (the merged-history tool serves two), and
    // `capability` when it serves one. Reading only the second is the exact hole task 013-8 found
    // in `eval-capability-coverage`: the fourteenth tool's second capability was invisible.
    const capabilities =
      spec.servedCapabilities ?? (spec.capability === null ? [] : [spec.capability]);
    for (const capability of capabilities) served.add(capability);
  }
  return served;
}

describe('AC-29 — every manifest capability is served by a tool or declared with a reason', () => {
  it('TC-UNIT-01: nothing is neither served nor declared', () => {
    const served = servedCapabilities();
    const declared = new Set<string>(CAPABILITY_KNOWN_GAPS.keys());
    const orphans = Object.keys(capabilityManifests).filter(
      (capability) => !served.has(capability) && !declared.has(capability),
    );

    expect(
      orphans.sort(),
      'These manifest capabilities are advertised by the registry and resolved by no registered ' +
        'tool, with no recorded reason. That is L-15: an agent reads the catalogue, calls the ' +
        'capability, and there is nothing behind it. Ship a tool, or add a row to ' +
        'CAPABILITY_KNOWN_GAPS in eval/capabilities.mjs saying why there is none.',
    ).toStrictEqual([]);
  });

  it('the gate is not vacuous — both sides are non-empty and the manifest is the real one', () => {
    // Sign of work BEFORE the verdict: an empty manifest, or a `servedCapabilities` that found
    // nothing, would report "no orphans" identically to a healthy tree.
    expect(Object.keys(capabilityManifests).length).toBeGreaterThan(20);
    expect(servedCapabilities().size).toBeGreaterThan(10);
    expect(CAPABILITY_KNOWN_GAPS.size).toBeGreaterThan(0);
  });

  it('a declared row is not a way to hide a capability a tool DOES serve', () => {
    // The list's other failure direction, and the one that rots quietly: a capability gains a tool
    // and its "no tool serves it" row survives, so the document keeps stating something false and
    // nothing notices. `pool.info` is exactly that case — task 014-32b deleted its row when the
    // `ToolSpec` landed, and this keeps the next one from being forgotten.
    const served = servedCapabilities();
    const stale = [...CAPABILITY_KNOWN_GAPS.keys()].filter((capability: string) =>
      served.has(capability),
    );
    expect(
      stale.sort(),
      'These capabilities are declared as served by no tool, and a registered tool serves them. ' +
        'Delete the row: a reason that is no longer true is worse than no reason.',
    ).toStrictEqual([]);
  });

  it('every declared row names a real manifest capability, and gives a reason', () => {
    // A typo'd key excuses nothing and is indistinguishable from a correct entry; an empty reason
    // turns the list back into the bare allowlist this gate exists instead of.
    const unknown = [...CAPABILITY_KNOWN_GAPS.keys()].filter(
      (capability: string) => !(capability in capabilityManifests),
    );
    expect(unknown.sort(), 'a declared gap names no manifest capability').toStrictEqual([]);

    const reasonless = [...CAPABILITY_KNOWN_GAPS.entries()].filter(
      ([, reason]: [string, string]) => typeof reason !== 'string' || reason.trim().length < 20,
    );
    expect(
      reasonless.map(([capability]: [string, string]) => capability).sort(),
      'a declared gap carries no usable reason',
    ).toStrictEqual([]);
  });
});
