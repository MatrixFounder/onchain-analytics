import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// @ts-expect-error — the eval is plain .mjs by design (no build step, no SDK); only its data is read
import { CAPABILITY_EXCLUSIONS, CAPABILITY_TOOLS } from '../eval/capabilities.mjs';

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
 * The tool side is DERIVED, not restated: a new `src/tools/*.ts` with a `CAPABILITY` constant is
 * picked up here the moment it lands. Restating the list would reproduce the very defect (two
 * hand-written lists drifting apart) one directory over.
 */
const toolsDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../src/tools');

function capabilitiesServedByTools(): Map<string, string> {
  const byCapability = new Map<string, string>();
  for (const file of readdirSync(toolsDir).filter((f) => f.endsWith('.ts'))) {
    const source = readFileSync(path.join(toolsDir, file), 'utf8');
    const match = /^const CAPABILITY = '([^']+)';$/m.exec(source);
    if (match?.[1]) byCapability.set(match[1], file);
  }
  return byCapability;
}

describe('every capability an MCP tool serves has an eval case or a recorded reason (RF-5)', () => {
  const served = capabilitiesServedByTools();
  const accounted = new Set<string>([
    ...(CAPABILITY_TOOLS as { capability: string }[]).map((c) => c.capability),
    ...(CAPABILITY_EXCLUSIONS as Map<string, string>).keys(),
  ]);

  it('finds the tool→capability constants at all', () => {
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
    // WI-20: three sibling inventories need the same edit and none references the others, so the
    // list is repeated here rather than discovered one failed gate at a time.
    expect(
      unaccounted,
      'Wire it into eval/capabilities.mjs (CAPABILITY_TOOLS or CAPABILITY_EXCLUSIONS). A new TOOL ' +
        'also needs: test/e2e.stdio.test.ts, scripts/smoke-dist.mjs -> expectedNames (fires only ' +
        'after test AND build), and a named entry in docs/architectures/interfaces.md §5.',
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
