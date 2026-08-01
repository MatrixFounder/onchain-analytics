import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { toolSpecs } from '../src/tools/tool-specs.js';

/**
 * No file may carry a hand-written tool inventory without saying so (TASK-011, R-122/R-123/R-126).
 *
 * **The defect this closes.** On the day TASK-011 started, the tool list was restated in sixteen
 * files and three of them were wrong: both READMEs named eight tools of thirteen — stale since
 * TASK-006, through four shipped tasks — and `packages/mcp-server/.AGENTS.md` named twelve while
 * claiming a suite asserts five. None of it failed anything, because no gate looked at those files.
 *
 * **Membership is a declared list, never a threshold.** This is the trap the first design walked
 * into. `README.md` named exactly eight tools; had the criterion been "a file naming ≥8 must be
 * complete", then deleting one more name would drop it to seven, take it OUT of the gated set, and
 * turn the gate green on precisely the drift it exists to catch. So the threshold is used only to
 * DISCOVER files nobody has classified yet; completeness is demanded of the declared list.
 *
 * **Exclusions are path CLASSES plus a named registry, both in code.** A per-file list would fail
 * on the document that introduces the rule: `docs/TASK.md` names all thirteen while specifying
 * them, and tomorrow becomes `docs/tasks/task-011-*.md`. Rewriting history to match today's
 * inventory would be worse than no gate at all — the doctrine `docs-counts.test.ts` already states.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (relative: string): string => readFileSync(path.join(repoRoot, relative), 'utf8');

const TOOL_NAMES = toolSpecs.map((spec) => spec.name);

/**
 * A file is "carrying an inventory" once it names this many distinct tools. Derived from the
 * registry (60%), never written as a number, so it tracks a growing tool set on its own.
 */
const DISCOVERY_THRESHOLD = Math.ceil(TOOL_NAMES.length * 0.6);

/** Files that describe the current tool set and must therefore name ALL of it. */
const GATED_DOCUMENTS = [
  'README.md',
  'README.ru.md',
  'docs/ARCHITECTURE.md',
  'docs/architectures/interfaces.md',
  'docs/architectures/functional-architecture.md',
  'docs/onchain-analytics/ROADMAP.md',
  'packages/mcp-server/.AGENTS.md',
];

/**
 * Files that legitimately name many tools without being an inventory. Each needs a reason, because
 * "it was already like that" is how the sixteen accumulated.
 */
const EXCLUDED_FILES = new Map([
  [
    'packages/mcp-server/test/e2e.inprocess.test.ts',
    'call sites, not an inventory: each name appears with its own arguments and output schema',
  ],
  [
    'packages/mcp-server/test/m2-degradation.integration.test.ts',
    'call sites, not an inventory (see e2e.inprocess.test.ts)',
  ],
  [
    'packages/mcp-server/eval/checks.mjs',
    'a map keyed by tool name; its key set is asserted against the registry by eval-capability-coverage',
  ],
  [
    'packages/mcp-server/test/tools-list-contract.test.ts',
    'the frozen contract snapshot lives here on purpose — it is the one expectation NOT derived from the registry',
  ],
  [
    'packages/mcp-server/test/tool-inventory-docs.test.ts',
    'this gate itself: it names the tools it checks for',
  ],
  [
    'packages/mcp-server/test/fixtures/tools-list.snapshot.json',
    'the frozen contract snapshot — an inventory by design, and the deliberately NOT-derived one; ' +
      'guarded by tools-list-contract.test.ts',
  ],
  [
    'packages/mcp-server/tool-inventory.json',
    'generated FROM the registry; guarded by tool-inventory-in-sync.test.ts, which is a stronger ' +
      'check than completeness',
  ],
  [
    'docs/architectures/version-history.md',
    'a log of what past versions said; rewriting it to match today would be worse than no gate',
  ],
]);

/** Whole directories and slots that are snapshots of finished (or in-flight) work. */
const EXCLUDED_PATH_PATTERNS = [
  /^docs\/tasks\//,
  /^docs\/plans\//,
  /^docs\/reviews\//,
  /^docs\/issues\//,
  /^docs\/backlog\//,
  /^docs\/dune-query-discovery\//,
  /^docs\/onchain-analytics\/raw\//,
  /^docs\/TASK\.md$/,
  /^docs\/PLAN\.md$/,
  /^\.agent\//,
];

/**
 * Names of tools that do not exist yet but are written down as planned work. Without this, the
 * orphan check below would fail on the roadmap the moment it describes M3 — and "do not write down
 * what you plan to build" is not a rule this project wants.
 */
const PLANNED_TOOL_NAMES = new Map([
  ['onchain_watch_add', 'M3 watchlists (ROADMAP §M3, ADR-001 D7)'],
  ['onchain_watch_list', 'M3 watchlists (ROADMAP §M3, ADR-001 D7)'],
  ['onchain_watch_remove', 'M3 watchlists (ROADMAP §M3, ADR-001 D7)'],
]);

const SKIP_DIRECTORIES = new Set(['node_modules', 'dist', '.git', 'coverage', '.turbo']);

/**
 * Every file in the repository, as repo-relative paths.
 *
 * Symlinks are not followed. They point at the framework repositories this project references
 * rather than vendors (`.agentic-development`, the n8n skills), and one of them is currently
 * dangling — a walk that followed them would crash on someone else's broken link and, worse, would
 * start policing another repository's documents.
 */
function walk(directory: string, accumulator: string[] = []): string[] {
  for (const entry of readdirSync(path.join(repoRoot, directory || '.'), { withFileTypes: true })) {
    if (SKIP_DIRECTORIES.has(entry.name) || entry.isSymbolicLink()) continue;
    const relative = directory ? `${directory}/${entry.name}` : entry.name;
    if (entry.isDirectory()) walk(relative, accumulator);
    else if (entry.isFile()) accumulator.push(relative);
  }
  return accumulator;
}

/** Distinct registry tool names appearing in a file. */
function namedTools(content: string): string[] {
  return TOOL_NAMES.filter((name) => content.includes(name));
}

const isExcludedPath = (relative: string): boolean =>
  EXCLUDED_PATH_PATTERNS.some((pattern) => pattern.test(relative));

describe('every document that lists tools lists all of them (R-123)', () => {
  it.each(GATED_DOCUMENTS)('%s names every registered tool', (relative) => {
    const content = read(relative);
    const missing = TOOL_NAMES.filter((name) => !content.includes(name));
    expect(
      missing,
      `${relative} is a gated inventory and is missing: ${missing.join(', ')}. ` +
        'Add them, or move the file to EXCLUDED_FILES with a reason.',
    ).toStrictEqual([]);
  });

  it('discovers no unclassified file carrying an inventory', () => {
    const unclassified = walk('')
      .filter((relative) => !isExcludedPath(relative))
      .filter((relative) => !GATED_DOCUMENTS.includes(relative))
      .filter((relative) => !EXCLUDED_FILES.has(relative))
      .filter((relative) => {
        try {
          return (
            namedTools(readFileSync(path.join(repoRoot, relative), 'utf8')).length >=
            DISCOVERY_THRESHOLD
          );
        } catch {
          return false; // binary or unreadable — not an inventory
        }
      });

    expect(
      unclassified,
      `These files name ${DISCOVERY_THRESHOLD}+ tools and are neither gated nor excluded. ` +
        'Decide which: add to GATED_DOCUMENTS (and complete the list in them), or to ' +
        'EXCLUDED_FILES with the reason they are not an inventory.',
    ).toStrictEqual([]);
  });
});

describe('no document names a tool that does not exist (R-126)', () => {
  it.each(GATED_DOCUMENTS)('%s mentions only real or declared-planned tools', (relative) => {
    // The existing documentation gate iterates REGISTERED tools and checks they are named — so a
    // name left behind by a removed tool is invisible to it. This is the other direction.
    const mentioned = new Set([...read(relative).matchAll(/onchain_[a-z0-9_]+/g)].map((m) => m[0]));
    const orphans = [...mentioned].filter(
      (name) => !TOOL_NAMES.includes(name) && !PLANNED_TOOL_NAMES.has(name),
    );
    expect(
      orphans.sort(),
      `${relative} names tools that no longer exist: ${orphans.join(', ')}. ` +
        'Remove them, or declare them in PLANNED_TOOL_NAMES with the milestone that will add them.',
    ).toStrictEqual([]);
  });
});

describe('tool descriptions only cross-reference tools that exist (R-110)', () => {
  it('resolves every onchain_* name mentioned inside a published description', () => {
    // Eleven descriptions point the model at `onchain_list_chains`. Rename it without this gate and
    // all eleven keep advising a call that fails — and nothing anywhere would say so.
    const broken: string[] = [];
    for (const spec of toolSpecs) {
      for (const match of spec.description.matchAll(/onchain_[a-z0-9_]+/g)) {
        if (!TOOL_NAMES.includes(match[0])) broken.push(`${spec.name} -> ${match[0]}`);
      }
    }
    expect(
      broken,
      'A tool description advertises a tool that is not registered. Published descriptions are ' +
        'read by the model as instructions, so this is a broken contract, not a typo.',
    ).toStrictEqual([]);
  });

  it('actually finds cross-references, so the check above is not vacuous', () => {
    const references = toolSpecs.flatMap((spec) => [
      ...spec.description.matchAll(/onchain_[a-z0-9_]+/g),
    ]);
    expect(references.length).toBeGreaterThanOrEqual(9);
  });
});
