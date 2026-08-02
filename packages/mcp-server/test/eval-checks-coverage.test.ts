import { describe, expect, it } from 'vitest';
// @ts-expect-error — the eval is plain .mjs by design (no build step, no SDK); only its data is read
import { checks } from '../eval/checks.mjs';
// @ts-expect-error — same
import { CAPABILITY_TOOLS } from '../eval/capabilities.mjs';
import { toolSpecs } from '../src/tools/tool-specs.js';

/**
 * `eval/checks.mjs` is keyed by tool name, and both directions of that keying are checked here
 * (TASK-011 R-118/R-126).
 *
 * **Why this file exists at all: an exclusion was justified by a claim that was not true.** The
 * documentation gate lists `eval/checks.mjs` among the files allowed to name many tools without
 * being a gated inventory, and the recorded reason said its key set was already asserted against
 * the registry by `eval-capability-coverage.test.ts`. It was not — that test imports
 * `CAPABILITY_TOOLS` and `CAPABILITY_EXCLUSIONS`, never `checks`, and nothing else in the repo
 * imported this module except `eval/run.mjs`. The exclusion was therefore resting on a sentence
 * rather than on a gate, which is precisely the failure mode TASK-011 exists to remove. Found by
 * the adversarial cycle, not by reading the file.
 *
 * **The two directions fail differently, and the quiet one is the dangerous one.**
 *
 * - *Tool without a check* is loud already: `grade()` returns `degraded` at run time, so a live
 *   eval reports it. Still asserted here, because `pnpm eval` is deliberately not in CI and a
 *   capability can ship between two runs of it — the same reasoning that produced RF-5.
 * - *Check without a tool* is silent everywhere. `grade()` is only ever called for tools the eval
 *   decided to invoke, so an entry left behind by a renamed or retired tool is reached by nothing
 *   at all: not the offline suite, not the live run. The AC-9 protocol did not surface it either,
 *   because the tool it removed (`onchain_token_risk`) is paid and has no check to orphan.
 */

const registeredNames = new Set(toolSpecs.map((spec) => spec.name));
const checkedNames = Object.keys(checks as Record<string, unknown>);

/**
 * Tools graded without being routed through a capability: `onchain_ping` and
 * `onchain_list_chains` answer without a provider, and the eval calls them directly rather than
 * through `CAPABILITY_TOOLS`. Derived from the registry (capability `null`) rather than listed, so
 * a third such tool is covered the day it lands.
 */
const serverLevelTools = toolSpecs.filter((spec) => spec.capability === null).map((s) => s.name);

describe('eval/checks.mjs is keyed on tools that exist (R-126)', () => {
  it('has no check for a tool the registry does not declare', () => {
    const orphans = checkedNames.filter((name) => !registeredNames.has(name));
    expect(
      orphans.sort(),
      'A check is keyed on a tool that no longer exists. Nothing else in the repository would ' +
        'ever say so: grade() is only called for tools the eval invokes, so an orphaned entry is ' +
        'unreachable at run time too. Remove it, or restore the tool.',
    ).toStrictEqual([]);
  });

  it('checks every tool the eval actually invokes', () => {
    const invoked = [
      ...(CAPABILITY_TOOLS as { tool: string }[]).map((entry) => entry.tool),
      ...serverLevelTools,
    ];
    const unchecked = [...new Set(invoked)].filter((name) => !checkedNames.includes(name));
    expect(
      unchecked.sort(),
      'The live eval calls these tools and has no check for them, so it cannot tell a good answer ' +
        'from an empty one. Add an entry to `checks` in eval/checks.mjs, or stop calling the tool.',
    ).toStrictEqual([]);
  });

  it('finds both sides at all, so the assertions above are not vacuous', () => {
    // Both imports are untyped `.mjs`; if either ever resolved to an empty object the two checks
    // above would pass by comparing nothing against nothing.
    expect(checkedNames.length).toBeGreaterThanOrEqual(9);
    expect((CAPABILITY_TOOLS as unknown[]).length).toBeGreaterThanOrEqual(8);
    expect(serverLevelTools.length).toBeGreaterThanOrEqual(2);
  });
});
