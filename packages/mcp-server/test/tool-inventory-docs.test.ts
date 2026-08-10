import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { toolSpecs } from '../src/tools/tool-specs.js';

/**
 * No file may carry a hand-written tool inventory without saying so (TASK-011, R-122/R-123/R-126).
 *
 * **The defect this closes.** On the day TASK-011 started, **seventeen** files named eight or more
 * of the thirteen tools (`docs/TASK.md` §1.1 — ADR-002 D7 had counted sixteen the day before; the
 * seventeenth was `docs/TASK.md` itself, which is why R-122 excludes a path CLASS and not a list of
 * names). Three of those places disagreed with the code, across **four** files (§1.2):
 *
 *   1. `README.md` and `README.ru.md` named eight tools of thirteen — stale since TASK-006, through
 *      four shipped tasks. This is the public face of the product.
 *   2. `packages/mcp-server/.AGENTS.md` named twelve, and claimed the stdio suite asserts five.
 *   3. `eval/checks.mjs` graded a tool it had no check for as `ok` — closed by
 *      `eval-checks-coverage.test.ts`, not by this file.
 *
 * None of it failed anything, because no gate looked at those files. (Numbers corrected in
 * adversarial cycle 2: this docstring had said "sixteen files", which was the ADR's figure attached
 * to the wrong day, and had dropped defect 3 — the one its sibling gate exists for.)
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
 * "it was already like that" is how the seventeen accumulated.
 */
const EXCLUDED_FILES = new Map([
  // **Two entries removed by T-013 task 013-8, and the MECHANISM matters more than the case.**
  // `e2e.inprocess.test.ts` and `m2-degradation.integration.test.ts` each name 8 tools. That was
  // `>= 8` against a 13-tool registry and is `< 9` against a 14-tool one — the threshold is
  // `ceil(TOOL_NAMES.length * 0.6)`, so it MOVES ON EVERY TOOL ADDED, and an exclusion that was
  // live yesterday becomes decoration today without anyone touching it.
  //
  // Both were genuinely "call sites, not an inventory", and that reason is still true; it is simply
  // no longer load-bearing, because the discovery check would not flag either file anyway. Keeping
  // them would buy a permanent exemption for files that might one day grow a hand-written list —
  // the exact drift this gate exists to catch — which is what the check below refuses.
  //
  // **The rule for the next tool: after registering it, re-measure `namedTools()` for every entry
  // here against the new threshold.** Being in this list is not a durable property of a file.
  //
  // **`e2e.inprocess.test.ts` came BACK in the same task, and that is the mechanism working, not a
  // reversal.** Removing its entry was correct at the moment it was measured: it named 8 of 14.
  // Then 013-8 corrected that file's own docstring — which had claimed no MCP tool was wired to a
  // history/DSN-gated capability, a sentence the fourteenth tool falsified — and naming the tool
  // there took it to 9, at which point the discovery check flagged it and the exclusion became
  // load-bearing again. Same file, same reason, different measurement; the entry is only ever as
  // good as the last count.
  [
    'packages/mcp-server/test/e2e.inprocess.test.ts',
    'call sites, not an inventory: each name appears with its own arguments and output schema',
  ],
  [
    'packages/mcp-server/eval/checks.mjs',
    'a map keyed by tool name. eval-checks-coverage.test.ts asserts every key is a registered ' +
      'tool, and that every tool the eval invokes (CAPABILITY_TOOLS + the capability-null tools) ' +
      'has one. Deliberately NOT a complete inventory: the three paid tools are never called',
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
    'packages/mcp-server/report.json',
    'the eval report (`ONCHAIN_EVAL_JSON=report.json pnpm eval`, documented in eval/run.mjs) — ' +
      'every result row carries a `tool` field, so a single-chain run already names ten. Listed ' +
      'rather than gitignored: this walk reads the filesystem and never consults git',
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
  // T-013 (ADR-002 D5/D6): the merged-series tool. DESIGNED in `docs/architectures/interfaces.md`
  // §5.1.6 and `docs/ARCHITECTURE.md`, not yet registered — which is exactly the state this Map
  // exists to express, and the state R-126's diagnostic points a reader at.
  //
  // It leaves this Map in the SAME commit that adds the `ToolSpec`, together with §5.1.6's
  // `// Capability:` anchors: an entry here says "documented, deliberately absent", and once the
  // spec is registered `TOOL_NAMES` covers the name, so a stale entry would be a second mechanism
  // claiming the same fact.
]);

/**
 * `DATA_DIR` is the important one and was missing: `.gitignore` reserves `/DATA_DIR/` at the repo
 * root and `resolveDataDir()` honours `DATA_DIR=./DATA_DIR`, so a developer who sets it had
 * `cache.sqlite3` (and its `-wal`) decoded into a JS string on every `pnpm test` — silently, since
 * `readFileSync(…, 'utf8')` does not throw on binary. The rest are ordinary build/venv output.
 */
const SKIP_DIRECTORIES = new Set([
  'node_modules',
  'dist',
  '.git',
  'coverage',
  '.turbo',
  'DATA_DIR',
  '.venv',
  'build',
  'out',
]);

/**
 * Files larger than this are not documents and are not read. A cap is required, not tidy: without
 * it a symlink to a huge file — or to `/dev/zero` — is read into memory until the process dies.
 */
const MAX_READABLE_BYTES = 4 * 1024 * 1024;

/**
 * Every file in the repository, as repo-relative paths.
 *
 * **Symlinked DIRECTORIES are not descended into.** They point at the framework repositories this
 * project references rather than vendors (`.agentic-development`, the n8n skills), one of them is
 * currently dangling, and following them would both crash on someone else's broken link and start
 * policing another repository's documents.
 *
 * **Symlinked FILES are still read**, and that is a correction: the first version skipped every
 * symlink, which left a hole an adversarial reviewer walked straight through — a link placed in
 * `docs/` pointing at an out-of-tree file naming all thirteen tools, invisible to this gate.
 *
 * A symlink is followed only when it resolves to a **regular file within the size cap**
 * (adversarial cycle 2). The first version of this correction asked "is it not a directory?", which
 * is true of a fifo, a socket and a character device: `readFileSync` on a writerless fifo blocks in
 * `open(2)` for ever — no vitest timeout covers a synchronous read — and `/dev/zero` grows a buffer
 * until the process dies. Git stores arbitrary symlink targets, so a branch can carry one.
 */
interface WalkResult {
  /** Files to scan for an inventory. */
  readonly files: string[];
  /** Regular files refused for size — asserted empty, never silently dropped. */
  readonly oversize: string[];
}

/**
 * Results are carried through the recursion rather than accumulated in a module-level array.
 * The first version of the oversize reporting used a shared `const oversizeSkipped: string[] = []`,
 * which two `walk('')` call sites would have appended to twice — a counter that double-counts is a
 * worse diagnostic than none (cycle 4, caught in review of the cycle-4 fix itself).
 */
function walk(directory: string, result: WalkResult = { files: [], oversize: [] }): WalkResult {
  for (const entry of readdirSync(path.join(repoRoot, directory || '.'), { withFileTypes: true })) {
    // **Skipped by name only when it IS a directory** (cycle 3). Testing the name before the type
    // meant a plain FILE called `build`, `out`, `dist`, `coverage` or `DATA_DIR` was skipped too —
    // `cp README.md docs/out` put a document naming all thirteen tools on disk, unclassified, with
    // the suite green. Refusing exactly that is this gate's whole purpose.
    if (entry.isDirectory() && SKIP_DIRECTORIES.has(entry.name)) continue;
    const relative = directory ? `${directory}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) {
      // Read it only if it resolves to a plain file; never descend, for the reason above. A symlink
      // refused for size is NOT reported: its target is arbitrary and out of tree, so the cap is
      // doing its job rather than hiding a document of ours.
      if (isReadableFile(relative)) result.files.push(relative);
      continue;
    }
    if (entry.isDirectory()) walk(relative, result);
    // The size cap binds regular files too, not only symlinks: `walk` used to push any `isFile()`
    // unconditionally, so the cap's own docstring ("files larger than this are not read") was false
    // for the ordinary case and a large committed export was decoded on every run (cycle 3).
    //
    // An over-cap file is RECORDED, not merely dropped (cycle 4). Silently omitting it from
    // discovery is the same failure shape as the `docs/out` hole this walk just closed — a document
    // invisible to the gate, only at a 4 MiB entry price — and this repository's rule is that
    // cleanup never happens without saying what it removed.
    else if (entry.isFile()) {
      if (isReadableFile(relative)) result.files.push(relative);
      else result.oversize.push(relative);
    }
  }
  return result;
}

/**
 * `true` only for a regular file no larger than the cap.
 *
 * Everything else is skipped: a directory (we do not descend symlinked ones), a fifo/socket/device
 * (reading one hangs or exhausts memory), an oversized file (not a document), and a link that
 * cannot be `stat`ed at all — dangling, or unreadable because of its parent's permissions. The
 * previous version returned the *opposite* of what its own JSDoc promised for a dangling link, and
 * three sentences describing this helper disagreed with each other; stating one rule here is the
 * fix for both the behaviour and the prose.
 */
function isReadableFile(relative: string): boolean {
  try {
    const stat = statSync(path.join(repoRoot, relative));
    return stat.isFile() && stat.size <= MAX_READABLE_BYTES;
  } catch {
    return false;
  }
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

  it('carries no exclusion that excludes nothing', () => {
    // **An exclusion nobody can falsify is not an exclusion.** Two entries were deleted because the
    // files they named never crossed the threshold at all. Both numbers are `namedTools()` — the
    // same metric this check prints — so they are reproducible today:
    //
    //   `test/tools-list-contract.test.ts`  → 0 registered tools named (the snapshot it guards
    //                                          lives in the fixture file, which has its own entry)
    //   `test/tool-inventory-docs.test.ts`  → 1 (`onchain_list_chains`, in prose. The file's other
    //                                          `onchain_*` tokens are three PLANNED names and three
    //                                          regex literals — none is a registered tool, which is
    //                                          why `namedTools()` counts one)
    //
    // …against a threshold of 8. Deleting both left the suite green, which is the definition of
    // decoration. Worse, they bought a permanent exemption: the day one of those files replaces its
    // derived `TOOL_NAMES` with a hand-written list — the exact drift this task removes — nothing
    // would notice.
    //
    // (Cycle 2's version of this comment said the second file named "five", counting the planned
    // names that `namedTools()` filters out. A justification stated in a metric, measured with a
    // different metric — corrected in cycle 3, which is the third consecutive cycle to find a false
    // number in the prose of a fix.)
    //
    // Cycle 1 found one entry justified by a false claim. This is the same class one level up: the
    // claim was unverifiable rather than false, so the fix is a gate rather than a rewrite.
    // A file that is not present, or is larger than the read cap, cannot be measured — and being
    // absent is legitimate here: the one such entry is `report.json`, which exists only after
    // `ONCHAIN_EVAL_JSON=… pnpm eval`. The residual is stated rather than hidden: a mistyped path is
    // indistinguishable from a not-yet-generated artifact, so this check binds only what is on disk
    // and readable.
    const idle: string[] = [];
    for (const [relative] of EXCLUDED_FILES) {
      if (!isReadableFile(relative)) continue;
      const named = namedTools(readFileSync(path.join(repoRoot, relative), 'utf8')).length;
      if (named < DISCOVERY_THRESHOLD) {
        idle.push(`${relative}: names ${named} tools, below the ${DISCOVERY_THRESHOLD} threshold`);
      }
    }
    expect(
      idle.sort(),
      'These EXCLUDED_FILES entries do not exclude anything — the discovery check would not have ' +
        'flagged these files anyway. Remove them: a dormant exemption is invisible until the file ' +
        'grows into a real inventory, and then it silently suppresses the gate.',
    ).toStrictEqual([]);
  });

  it('scanned every regular file — none was dropped for size without saying so', () => {
    expect(
      walk('').oversize,
      `These files exceed ${MAX_READABLE_BYTES} bytes and were NOT scanned for a tool inventory. ` +
        'The cap exists so a symlink cannot point the walk at /dev/zero; it is not a licence to ' +
        'skip a committed document. Either exclude the path deliberately (EXCLUDED_PATH_PATTERNS, ' +
        'with a reason) or raise the cap.',
    ).toStrictEqual([]);
  });

  it('discovers no unclassified file carrying an inventory', () => {
    const unclassified = walk('')
      .files.filter((relative) => !isExcludedPath(relative))
      .filter((relative) => !GATED_DOCUMENTS.includes(relative))
      .filter((relative) => !EXCLUDED_FILES.has(relative))
      .filter((relative) => {
        try {
          return (
            namedTools(readFileSync(path.join(repoRoot, relative), 'utf8')).length >=
            DISCOVERY_THRESHOLD
          );
        } catch {
          // Unreadable (EACCES, EISDIR, a race with a deletion). NOT "binary": `readFileSync` with
          // 'utf8' decodes a binary file lossily rather than throwing, so binaries are scanned —
          // harmlessly, since none of them contains eight tool names.
          return false;
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
