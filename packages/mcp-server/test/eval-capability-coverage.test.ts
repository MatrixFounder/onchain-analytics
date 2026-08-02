import { describe, expect, it } from 'vitest';
// @ts-expect-error — the eval is plain .mjs by design (no build step, no SDK); only its data is read
import { CAPABILITY_EXCLUSIONS, CAPABILITY_TOOLS } from '../eval/capabilities.mjs';
import { toolSpecs } from '../src/tools/tool-specs.js';
import { ADD_A_TOOL as CHECKLIST } from './inventory-channels.js';

/**
 * RF-5 — the offline half of the fix.
 *
 * `pnpm eval` is deliberately NOT part of CI: it touches the network, it can be rate-limited, and a
 * flaky gate is a gate people disable. The consequence is that nothing noticed when
 * `dex.volume.history` shipped and the eval's capability list did not grow — the harness that exists
 * to catch silent drift was itself silently incomplete, and its report showed no row, no `no-probe`,
 * nothing at all. A green run read as "the free contour is verified".
 *
 * A run-time reporter alone cannot fix that: it only speaks when someone runs the eval, which by
 * construction is not on the path a new tool travels. This test is on that path, and it needs no
 * network — both sides are files in this repo.
 *
 * The tool side is DERIVED, not restated: a tool declaring a capability is picked up here the
 * moment it lands. Restating the list would reproduce the very defect (two hand-written lists
 * drifting apart) one directory over.
 *
 * **It used to derive by REGEX over the source files** — `/^const CAPABILITY = '…';$/m` across
 * `src/tools/*.ts` — which was a text heuristic about text. It read whatever matched a formatting
 * convention, so a tool writing the same constant differently would have vanished from the
 * comparison silently; the lower bound below would have caught a total failure and never a partial
 * one. Since TASK-011 the capability is a field on the tool's spec, so this reads the registry.
 */
function capabilitiesServedByTools(): Map<string, string> {
  const byCapability = new Map<string, string>();
  for (const spec of toolSpecs) {
    if (spec.capability !== null) byCapability.set(spec.capability, spec.name);
  }
  return byCapability;
}

describe('every capability an MCP tool serves has an eval case or a recorded reason (RF-5)', () => {
  const served = capabilitiesServedByTools();
  const accounted = new Set<string>([
    ...(CAPABILITY_TOOLS as { capability: string }[]).map((c) => c.capability),
    ...(CAPABILITY_EXCLUSIONS as Map<string, string>).keys(),
  ]);

  it('finds the tool→capability mapping at all', () => {
    // Guards the derivation itself: if the naming convention changes, this test would otherwise
    // pass by scanning nothing — green for the worst possible reason.
    expect(served.size).toBeGreaterThanOrEqual(9);
    expect([...served.keys()]).toContain('chain.tvl');
  });

  it('leaves no tool-served capability unexercised without a recorded reason', () => {
    const unaccounted = [...served]
      .filter(([capability]) => !accounted.has(capability))
      .map(([capability, file]) => `${capability} (${file})`)
      .sort();

    // Read a failure here as: a tool ships a capability the live eval never calls. Wire it into
    // CAPABILITY_TOOLS, or record why not in CAPABILITY_EXCLUSIONS. "Nobody got round to it" is the
    // one state this refuses, because that is exactly what shipped.
    //
    // WI-20: sibling inventories need the same edit and none references the others, so the list is
    // named here rather than discovered one failed gate at a time. **It is imported, not restated**
    // (adversarial cycle 4): the version written here had gone false in two of its three items —
    // `e2e.stdio.test.ts` and `smoke-dist.mjs -> expectedNames` are both derived since TASK-011 and
    // need no edit at all, so it sent the developer to hand-edit a derived assertion, which is the
    // duplication this task deletes. It also omitted the snapshot, the freshness test and the
    // documentation gate.
    expect(
      unaccounted,
      'Wire it into eval/capabilities.mjs (CAPABILITY_TOOLS or CAPABILITY_EXCLUSIONS).\n\n' +
        CHECKLIST,
    ).toEqual([]);
  });

  it('names dex.volume.history specifically — the capability that shipped untested', () => {
    // A named guard beside the general rule: the general rule would also pass if this capability
    // were quietly moved into the paid-exclusions map, and this one would not.
    expect(served.has('dex.volume.history')).toBe(true);
    expect((CAPABILITY_TOOLS as { capability: string }[]).map((c) => c.capability)).toContain(
      'dex.volume.history',
    );
  });

  it('wires every listed capability to a tool name and an argument builder', () => {
    for (const entry of CAPABILITY_TOOLS as {
      capability: string;
      tool: string;
      args: (chain: string, probe: Record<string, unknown>) => unknown;
    }[]) {
      expect(entry.tool, `${entry.capability} has no tool`).toMatch(/^onchain_/);
      // `args` returning null means "no probe curated for this chain" — a legal outcome reported as
      // `no-probe`. What must not happen is a builder that throws, which aborts the whole matrix.
      expect(() => entry.args('ethereum', {})).not.toThrow();
    }
  });
});
