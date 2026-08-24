#!/usr/bin/env node
/**
 * Format gate on what is being COMMITTED (companion to verify-provenance.mjs --source=index).
 *
 * `prettier --check .` lives in CI and nowhere else, so nothing local ever ran the formatter over
 * a commit before it was pushed. Between 2026-08-11 and 2026-08-24 that turned CI red seven times
 * on six distinct files, always at the same step, always one file at a time:
 *
 *   31492283932  packages/core/test/fixtures/defillama/hacks-and-catalog.evidence.md
 *   32532666040  docs/architectures/system-architecture.md
 *   32555308228  docs/architectures/system-architecture.md
 *   32655083395  docs/architectures/system-architecture.md
 *   32749677135  packages/mcp-server/eval/cases/http-shared-limiter-rate.mjs
 *   32768932475  packages/mcp-server/eval/probes.json
 *   32775342129  packages/mcp-server/eval/probes.json
 *
 * Six different files is not six careless authors; it is a loop with no local end. The failures
 * also cost more than their own red: `format:check` is CI step two of eight, so every one of those
 * runs stopped before typecheck, test, build and smoke:dist — thirteen days in which a green tick
 * was unavailable and a red one carried no information about the code.
 *
 * --source=index, for the reason RF-2 already established for provenance: a clean working tree
 * says nothing about the staged content, and `git commit -p` / `git add -p` make the two differ
 * routinely. Reading the blob is what makes this a gate on the commit rather than on the desk.
 *
 * Scope is deliberately identical to the CI step it stands in for — the same `.prettierignore` at
 * the repo root (nested ignore files are not consulted by `prettier --check .` either) and the
 * same config resolution. A file this gate skips is a file CI skips.
 *
 * It reports and never rewrites. `--update` is part of no provenance gate for the same reason: a
 * check that silently fixes what it just declared wrong hands the author a commit they did not
 * read. Here it would also restage bytes under a `git add -p` the author chose deliberately.
 *
 * Usage:  node scripts/check-format-staged.mjs [--repo-root=<path>]
 * Exit:   0 clean · 1 staged content is unformatted · 2 the instrument itself is broken
 *
 * `--repo-root` exists for the regression test and for nothing else. The property worth pinning is
 * that this reads the INDEX and not the desk, and a test can only demonstrate that by staging a
 * file whose worktree copy is clean — which in this repository would rewrite the developer's own
 * index mid-run. The test therefore builds a scratch repository and points the gate at it. Without
 * the flag the answer is the repository this script is committed to, exactly as before.
 */
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import * as prettier from 'prettier';

const rootArg = process.argv.slice(2).find((a) => a.startsWith('--repo-root='));
const repoRoot = rootArg
  ? path.resolve(rootArg.slice('--repo-root='.length))
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// Absolute, and passed to Prettier absolute below: config and ignore resolution then follow the
// repository under test rather than whatever directory the hook happened to be invoked from.
const ignorePath = path.join(repoRoot, '.prettierignore');

function git(args) {
  return execFileSync('git', args, { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 });
}

let staged;
try {
  // ACMR, not ACM: a rename reports only its destination path, and that path is being committed.
  staged = git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'])
    .toString('utf8')
    .split('\0')
    .filter(Boolean);
} catch (err) {
  process.stderr.write(`check-format-staged: cannot read the index — ${err.message}\n`);
  process.exit(2);
}

if (staged.length === 0) process.exit(0);

const unformatted = [];
const unreadable = [];

for (const relPath of staged) {
  const absPath = path.join(repoRoot, relPath);
  let info;
  try {
    info = await prettier.getFileInfo(absPath, { ignorePath });
  } catch (err) {
    unreadable.push(`${relPath} — getFileInfo: ${err.message}`);
    continue;
  }
  // `ignored` mirrors .prettierignore; a null parser is a file type Prettier does not handle
  // (.sh, .py, binary). CI skips both, so this must skip both or it would fail on green code.
  if (info.ignored || !info.inferredParser) continue;

  let content;
  try {
    content = git(['show', `:${relPath}`]).toString('utf8');
  } catch (err) {
    unreadable.push(`${relPath} — git show: ${err.message}`);
    continue;
  }

  try {
    const config = await prettier.resolveConfig(absPath, { editorconfig: false });
    // filepath, not parser: it is what Prettier uses to pick the parser AND to resolve overrides,
    // and it is why the check below matches `prettier --check <file>` exactly.
    const ok = await prettier.check(content, { ...config, filepath: absPath });
    if (!ok) unformatted.push(relPath);
  } catch (err) {
    // A syntax error is a real defect in staged content, not a broken instrument — report it as a
    // failure with its message rather than letting a file Prettier cannot parse pass silently.
    unformatted.push(`${relPath} — ${String(err.message).split('\n')[0]}`);
  }
}

if (unreadable.length > 0) {
  process.stderr.write('check-format-staged: could not inspect staged content:\n');
  for (const line of unreadable) process.stderr.write(`  ${line}\n`);
  process.exit(2);
}

if (unformatted.length > 0) {
  process.stderr.write(
    `check-format-staged: ${unformatted.length} staged file(s) are not Prettier-formatted — ` +
      '`pnpm format:check` in CI will fail on exactly these:\n',
  );
  for (const line of unformatted) process.stderr.write(`  ${line}\n`);
  process.stderr.write(
    '\nFix and restage:\n  pnpm format\n  git add -u\n\n' +
      'Bypass deliberately with `git commit --no-verify` — CI still checks.\n',
  );
  process.exit(1);
}

process.exit(0);
