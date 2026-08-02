import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
 * Tools graded without being routed through a capability: `onchain_ping` and `onchain_list_chains`
 * answer without a provider, and the eval calls them directly rather than through
 * `CAPABILITY_TOOLS`.
 *
 * **This is a proxy for "invoked directly", not that set** (narrowed in adversarial cycle 2). The
 * real set is two `callTool(server, '…')` literals in `eval/run.mjs`, which this file does not
 * read. The two coincide today. A future capability-null tool the eval never calls — an
 * `onchain_watch_list` over local state, already named in the roadmap — would make the coverage
 * check below demand an entry for something nothing exercises. That fails loudly rather than
 * silently, so the proxy is deliberate; it is recorded here so the next reader does not mistake it
 * for a derivation.
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

/**
 * `eval/run.mjs` keys behaviour on tool names written as string literals, and no gate could see them
 * (adversarial cycle 2).
 *
 * The file names five tools — below the documentation gate's discovery threshold of eight — so it is
 * neither gated, nor excluded, nor discoverable: structurally invisible. Three of those literals
 * select behaviour rather than merely labelling it: the registry-vs-RPC `nativeSymbol` cross-check,
 * the `supplyVsConsensus` check that is the only probe in the project leaving the engine (TASK-009
 * R-89), and the CoinGecko-specific throttle. A tool rename is caught loudly elsewhere — but the
 * repair checklist that fires (`INVENTORY_CHANNELS` in `test/inventory-channels.ts`) does not name
 * this file, so the rename gets repaired everywhere a gate points and these branches quietly stop
 * matching. A cross-check that silently stops running reports nothing at all, which is strictly
 * worse than the `no-probe` row `run.mjs` already emits for a missing reference source.
 *
 * (This sentence used to say the checklist "names four places". It named five by then, and the
 * count moved again in cycle 4 — which is why the checklist is now one declaration with readers
 * instead of a number repeated in three docstrings.)
 */
describe('eval/run.mjs names only tools that exist (adversarial cycle 2)', () => {
  const runSource = readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '../eval/run.mjs'),
    'utf8',
  );
  /**
   * Names allowed to appear without being registered — planned or retired tools mentioned in prose.
   * The sibling documentation gate has `PLANNED_TOOL_NAMES` for exactly this, and `docs-counts.ts`
   * states the governing rule: a test that forces history to match today's inventory is worse than
   * no test. Empty today; it exists so that a historical note is a one-line declaration rather than
   * a deletion (cycle 3).
   */
  const ALLOWED_UNREGISTERED = new Map<string, string>();

  const mentioned = [...new Set([...runSource.matchAll(/onchain_[a-z0-9_]+/g)].map((m) => m[0]))];

  it('resolves every tool literal against the registry', () => {
    const orphans = mentioned.filter(
      (name) => !registeredNames.has(name) && !ALLOWED_UNREGISTERED.has(name),
    );
    expect(
      orphans.sort(),
      'eval/run.mjs names a tool that is not registered. If it is a live branch, nothing else ' +
        "would report it: the file is below the documentation gate's discovery threshold, and a " +
        'branch that stops matching produces no row, no warning and no failure — the cross-check ' +
        'simply never runs. If it is a historical or forward-looking note, declare it in ' +
        'ALLOWED_UNREGISTERED with the reason rather than deleting the note.',
    ).toStrictEqual([]);
  });

  it('actually finds literals, so the check above is not vacuous', () => {
    expect(mentioned.length).toBeGreaterThanOrEqual(5);
  });
});
