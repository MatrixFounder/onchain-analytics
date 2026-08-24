import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * RF-11 — the format gate must refuse on the staged bytes, not on the working tree.
 *
 * `prettier --check .` lived only in CI, and between 2026-08-11 and 2026-08-24 it turned the build
 * red six times on six different files. `scripts/check-format-staged.mjs` moved the same check in
 * front of the commit; this file pins the two properties that would let it rot back into a
 * decoration: that it reads the INDEX, and that its skip list is the one CI uses.
 *
 * Everything runs against a scratch repository. Staging a deliberately broken file in THIS one to
 * observe the refusal would rewrite the developer's index mid-test — a gate proved by damaging the
 * thing it guards is not proved. That is what `--repo-root` is for, and its only use.
 */
const repoRoot = path.resolve(import.meta.dirname, '../../..');
const gate = path.join(repoRoot, 'scripts/check-format-staged.mjs');

let scratch: string;

/** Runs the gate against the scratch repo and returns what a hook would see. */
function runGate(): { status: number; stderr: string } {
  const r = spawnSync('node', [gate, `--repo-root=${scratch}`], {
    cwd: scratch,
    encoding: 'utf8',
  });
  return { status: r.status ?? -1, stderr: r.stderr ?? '' };
}

function git(...args: string[]): void {
  execFileSync('git', args, { cwd: scratch, stdio: 'pipe' });
}

/**
 * Empties the index so each case starts from "nothing is being committed". `read-tree --empty`
 * rather than `rm --cached`: the divergence case below leaves staged content that matches neither
 * the worktree nor HEAD, which is exactly what `git rm` refuses to discard without `-f`.
 */
function clearIndex(): void {
  execFileSync('git', ['read-tree', '--empty'], { cwd: scratch, stdio: 'pipe' });
}

const FORMATTED = 'const x = 1;\nexport default x;\n';
const UNFORMATTED = 'const  x   =    1\nexport   default x\n';

beforeAll(() => {
  scratch = mkdtempSync(path.join(os.tmpdir(), 'onchain-format-gate-'));
  git('init', '-q');
  // The scratch repo carries its own config and skip list, so the gate is exercised through the
  // same resolution path it uses in production rather than against hardcoded defaults.
  writeFileSync(path.join(scratch, '.prettierrc'), '{ "singleQuote": true, "printWidth": 100 }\n');
  writeFileSync(path.join(scratch, '.prettierignore'), 'generated/\n');
  mkdirSync(path.join(scratch, 'generated'), { recursive: true });
});

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

describe('check-format-staged', () => {
  it('passes when nothing is staged', () => {
    clearIndex();
    expect(runGate().status).toBe(0);
  });

  it('passes on staged content that is already formatted', () => {
    clearIndex();
    writeFileSync(path.join(scratch, 'clean.ts'), FORMATTED);
    git('add', 'clean.ts');
    expect(runGate().status).toBe(0);
  });

  it('refuses staged content that is not formatted, and names the file', () => {
    clearIndex();
    writeFileSync(path.join(scratch, 'bad.ts'), UNFORMATTED);
    git('add', 'bad.ts');
    const { status, stderr } = runGate();
    expect(status).toBe(1);
    // Naming it is the whole point: `prettier --check` over stdin reports `(stdin)`, which tells
    // an author nothing about which of their files to fix.
    expect(stderr).toContain('bad.ts');
    expect(stderr).toContain('pnpm format');
  });

  it('refuses when the INDEX is unformatted even though the working tree is clean', () => {
    // The property RF-2 established for provenance, applied to formatting: `git add -p` and a
    // later edit make these two differ routinely, and only one of them is being committed.
    clearIndex();
    const file = path.join(scratch, 'divergent.ts');
    writeFileSync(file, UNFORMATTED);
    git('add', 'divergent.ts');
    writeFileSync(file, FORMATTED); // desk is now spotless; the commit is not
    const { status, stderr } = runGate();
    expect(status).toBe(1);
    expect(stderr).toContain('divergent.ts');
  });

  it('passes when the unformatted file is in the working tree but NOT staged', () => {
    // The mirror case. A gate that read the desk would refuse here and train authors to bypass it.
    clearIndex();
    writeFileSync(path.join(scratch, 'clean.ts'), FORMATTED);
    git('add', 'clean.ts');
    writeFileSync(path.join(scratch, 'unstaged.ts'), UNFORMATTED);
    expect(runGate().status).toBe(0);
  });

  it('skips what .prettierignore skips', () => {
    // Scope has to match `prettier --check .` exactly. A gate stricter than CI fails green commits.
    clearIndex();
    writeFileSync(path.join(scratch, 'generated/out.ts'), UNFORMATTED);
    git('add', '-f', 'generated/out.ts');
    expect(runGate().status).toBe(0);
  });

  it('skips a file type Prettier has no parser for', () => {
    clearIndex();
    writeFileSync(path.join(scratch, 'run.sh'), 'echo    "hi"\n');
    git('add', 'run.sh');
    expect(runGate().status).toBe(0);
  });

  it('reports a staged file Prettier cannot parse as a failure, not as a pass', () => {
    // An unparseable file is a defect in what is being committed. Swallowing it would make the
    // gate report clean on content CI is about to reject.
    clearIndex();
    writeFileSync(path.join(scratch, 'broken.ts'), 'const x = (((;\n');
    git('add', 'broken.ts');
    const { status, stderr } = runGate();
    expect(status).toBe(1);
    expect(stderr).toContain('broken.ts');
  });
});
