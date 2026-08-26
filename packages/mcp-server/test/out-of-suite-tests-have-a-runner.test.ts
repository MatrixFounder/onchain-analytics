import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * A test excluded from the default suite must be named in some gate, or nobody runs it.
 *
 * **Why this exists.** Planning T-014 produced five tasks whose end-to-end tests need a live
 * Postgres. Each did the right thing locally: marked them integration and excluded them from CI,
 * because R-21 forbids network in CI. None of the five said where they run instead, and the
 * acceptance task's gates were `pnpm test`, the live gate and the static gates — none of which
 * touch an excluded test. AC-4, AC-5, AC-41, AC-46 and the grant postconditions would all have been
 * ticked green on tests no one was required to execute.
 *
 * The marking is what makes this invisible. It reads as diligence — the author noticed the test
 * needs a database and said so — while doing the one thing that removes the test from every run.
 * Four rounds of review found it once, by reading five files side by side; nothing else would have.
 *
 * This is the shape the project keeps paying for: a completeness claim with no run behind it (L-10,
 * L-13, L-14). The difference here is that the claim is checkable, so it stops being prose.
 *
 * **What this deliberately does NOT do.**
 *
 * It does not police closed milestones. Task files of past milestones use the same words for other
 * purposes — `task-003-8-integration-verify-ci-exit.md` is literally named for an integration step —
 * and rewriting history to satisfy a gate would be worse than no gate. Scope is the milestone
 * `docs/TASK.md` currently declares, so this keeps working on T-015 with no edit.
 *
 * It does not verify that the runner actually runs. It verifies that one is NAMED. A gate that
 * claimed more would need to execute the excluded set, which is the very thing R-21 forbids here.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const read = (relative: string): string => readFileSync(path.join(repoRoot, relative), 'utf8');

/**
 * Whether the declared milestone has reached planning yet.
 *
 * **The window this gate could not survive, found by walking into it (RF-13, 2026-08-25).** The
 * docstring above claims the scope follows `docs/TASK.md` and therefore "keeps working on T-015
 * with no edit". The first rotation it ever met refuted that. This file was written 2026-08-14,
 * inside T-014's development phase, where `docs/TASK.md` named TASK-014 and
 * `docs/tasks/task-014-*.md` already existed — so it had never once been read in the state the
 * pipeline passes through between milestones.
 *
 * Measured: the analysis phase of T-015 archived TASK-014, wrote a `docs/TASK.md` declaring
 * TASK-015, and this file went to `2 failed | 4 passed` with nothing wrong in either document.
 * Between analysis — where `docs/TASK.md` names a NEW milestone — and planning — where
 * `docs/tasks/task-<id>-<n>-*.md` first appear — the scope is legitimately empty, and two
 * assertions below read that emptiness as the hole they exist to close.
 *
 * `docs/PLAN.md` is the discriminator because it is the pipeline's own artifact and not a flag
 * invented for this gate: `skill-archive-task` rotates it in lockstep with `docs/TASK.md`, so it is
 * absent for exactly as long as the current milestone is unplanned. The emptiness check still runs
 * in both regimes — it now asserts the state it is actually in, rather than one of the two.
 */
const planned = existsSync(path.join(repoRoot, 'docs/PLAN.md'));

/**
 * The declaration this gate keys on: a paragraph saying these tests are integration ones and are
 * excluded from CI.
 *
 * All three parts are required together. `интеграционн` alone appears in prose across milestones;
 * `исключ` alone appears wherever something is scoped out; `CI` alone appears in every task that
 * mentions the pipeline. Only the conjunction names the act this gate is about — moving a test out
 * of the default run.
 */
const declaresExclusion = (paragraph: string): boolean =>
  /интеграционн/i.test(paragraph) && /исключ/i.test(paragraph) && /\bCI\b/.test(paragraph);

/**
 * The one sentence that declares who runs the excluded set.
 *
 * Keyed on a fixed phrase rather than inferred from verbs. The first draft of this gate guessed
 * intent from words like `прогон`, and misread a task's own marking — which says its tests are
 * excluded from `прогон CI` — as a declaration that it runs them. Prose does not distinguish the
 * two; a fixed sentence does. Same reason `documentation-standards` §4.3 puts gates on anchors
 * instead of headings.
 */
const RUNNER_DECLARATION = /Интеграционный набор прогоняется здесь:\s*([^\n]+)/;

const taskIdOf = (fileName: string): string | null =>
  /^task-(\d+)-(\d+)-/.exec(fileName)?.slice(1, 3).join('-') ?? null;

describe('tests excluded from the suite are named in a gate', () => {
  const milestone = /\|\s*ID\s*\|\s*TASK-(\d+)\s*\|/.exec(read('docs/TASK.md'))?.[1];

  it('reads the milestone id from the specification, so the scope follows the pipeline', () => {
    expect(milestone).toBeDefined();
  });

  const tasksDir = path.join(repoRoot, 'docs/tasks');
  const files = readdirSync(tasksDir)
    .filter((f) => f.startsWith(`task-${milestone}-`) && f.endsWith('.md'))
    .sort();

  it('finds the milestone task files at all — an empty scope would pass every assertion below', () => {
    if (planned) {
      expect(files.length).toBeGreaterThan(0);
      return;
    }
    expect(
      files,
      'the milestone is unplanned (no docs/PLAN.md), so it must own no task files either',
    ).toEqual([]);
  });

  /** Tasks that moved a test out of the default run, and the ids some gate claims to run. */
  const owners: string[] = [];
  const covered = new Set<string>();

  /** The file carrying the runner declaration is the gate, never an owner of excluded tests. */
  let runnerFile: string | null = null;

  for (const file of files) {
    const text = readFileSync(path.join(tasksDir, file), 'utf8');
    const declared = RUNNER_DECLARATION.exec(text);
    if (declared === null) continue;
    runnerFile = file;
    for (const m of declared[1]?.matchAll(/\b(\d+)-(\d+)\b/g) ?? []) {
      covered.add(`${m[1]}-${m[2]}`);
    }
  }

  for (const file of files) {
    if (file === runnerFile) continue;
    const own = taskIdOf(file);
    if (own === null) continue;
    const text = readFileSync(path.join(tasksDir, file), 'utf8');
    if (text.split(/\n\s*\n/).some(declaresExclusion)) owners.push(own);
  }

  it('every task that excluded a test from the suite is named in a gate that runs it', () => {
    const orphaned = [...new Set(owners)].filter((id) => !covered.has(id)).sort();
    expect(orphaned, `excluded tests with no runner: ${orphaned.join(', ')}`).toEqual([]);
  });

  it('no gate claims to run a set that no task excluded — the reverse drift', () => {
    const phantom = [...covered].filter((id) => !owners.includes(id)).sort();
    expect(phantom, `gate names tasks with no excluded tests: ${phantom.join(', ')}`).toEqual([]);
  });

  it('a runner is declared at all — without one every excluded test is orphaned', () => {
    if (planned) {
      expect(runnerFile).not.toBeNull();
      return;
    }
    expect(
      runnerFile,
      'the milestone is unplanned, so no task file exists to carry the declaration',
    ).toBeNull();
  });

  it('detects the defect it was written for — a marking with no runner behind it', () => {
    const marked = 'Тесты требуют живого Postgres, помечаются интеграционными и исключаются из CI.';
    expect(declaresExclusion(marked)).toBe(true);
    expect(RUNNER_DECLARATION.test(marked)).toBe(false);

    const declaration = 'Интеграционный набор прогоняется здесь: 014-03, 014-18.';
    const ids = [...(RUNNER_DECLARATION.exec(declaration)?.[1]?.matchAll(/\b\d+-\d+\b/g) ?? [])];
    expect(ids.map((m) => m[0])).toEqual(['014-03', '014-18']);
  });
});
