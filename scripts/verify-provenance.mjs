#!/usr/bin/env node
/**
 * Provenance verifier (RF-2).
 *
 * TASK-005 recorded a "golden test SHA" by hand, in a doc header, so that silent tuning of a
 * live-recorded assertion would be detectable. It was not: the recorded hash described a working
 * tree, an unlogged edit landed afterwards, and the commit shipped with a hash that matched
 * nothing. A chain whose whole purpose is to detect a silent edit had a window in which it could
 * not — and it could not because a human had to remember to re-run `shasum` and paste the result.
 *
 * This replaces the remembering with a gate. `docs/provenance.json` records `path -> sha256`; this
 * script recomputes and compares. Editing a listed file without updating the manifest turns the
 * gate red, and updating the manifest puts the change in the SAME diff a reviewer reads — which is
 * the property the hand-copied hash was supposed to have.
 *
 * Two sources, because they close different gaps:
 *   --source=worktree (default) — what `pnpm test` and every local gate sees. Catches the edit
 *                                 immediately, long before a commit.
 *   --source=index              — what is actually STAGED. This is the one the pre-commit hook
 *                                 uses: the working tree can differ from what is being committed,
 *                                 and that difference is exactly how the original break happened.
 *   --source=head               — what the last commit contains. For auditing after the fact.
 *
 * Usage:
 *   node scripts/verify-provenance.mjs [--source=worktree|index|head] [--update]
 *
 * `--update` rewrites the manifest from the current source. It is deliberately NOT part of any
 * gate: re-baselining must be a decision someone takes and a reviewer sees, never something a
 * failing check quietly performs for them.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifestPath = path.join(repoRoot, 'docs/provenance.json');

const args = process.argv.slice(2);
const source = (args.find((a) => a.startsWith('--source='))?.split('=')[1] ?? 'worktree').trim();
const update = args.includes('--update');

if (!['worktree', 'index', 'head'].includes(source)) {
  process.stderr.write(`verify-provenance: unknown --source=${source}\n`);
  process.exit(2);
}

/** Bytes of `relPath` as the chosen source sees them, or `null` when it does not have the file. */
function readFrom(relPath) {
  if (source === 'worktree') {
    const abs = path.join(repoRoot, relPath);
    return existsSync(abs) ? readFileSync(abs) : null;
  }
  // `git show :<path>` reads the INDEX; `HEAD:<path>` reads the last commit. Both give the exact
  // bytes git would store, which is the thing the recorded hash is supposed to describe.
  const spec = source === 'index' ? `:${relPath}` : `HEAD:${relPath}`;
  try {
    return execFileSync('git', ['show', spec], { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return null;
  }
}

const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

if (!existsSync(manifestPath)) {
  process.stderr.write(`verify-provenance: no manifest at docs/provenance.json\n`);
  process.exit(3);
}
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const entries = Object.entries(manifest.files ?? {});
if (entries.length === 0) {
  process.stderr.write('verify-provenance: manifest lists no files — that cannot be right\n');
  process.exit(3);
}

const drifted = [];
const missing = [];
const updated = {};

for (const [relPath, recorded] of entries) {
  const bytes = readFrom(relPath);
  if (bytes === null) {
    missing.push(relPath);
    continue;
  }
  const actual = sha256(bytes);
  updated[relPath] = { ...recorded, sha256: actual };
  if (actual !== recorded.sha256) drifted.push({ relPath, recorded: recorded.sha256, actual });
}

if (update) {
  writeFileSync(
    manifestPath,
    `${JSON.stringify({ ...manifest, files: updated }, null, 2)}\n`,
    'utf8',
  );
  process.stdout.write(
    `verify-provenance: manifest re-baselined from ${source} (${entries.length} files)\n`,
  );
  process.exit(0);
}

if (missing.length === 0 && drifted.length === 0) {
  process.stdout.write(`verify-provenance: ${entries.length} files match (source=${source})\n`);
  process.exit(0);
}

for (const relPath of missing) {
  process.stderr.write(`verify-provenance: MISSING from ${source} — ${relPath}\n`);
}
for (const { relPath, recorded, actual } of drifted) {
  process.stderr.write(
    `verify-provenance: DRIFT — ${relPath}\n` +
      `  recorded ${recorded}\n` +
      `  actual   ${actual}\n`,
  );
}
process.stderr.write(
  '\nA listed file changed without its recorded hash changing with it. That is the exact\n' +
    'condition RF-2 exists to catch: an edit to a live-recorded assertion that leaves no trace.\n' +
    'If the change is intended, re-baseline IN THE SAME COMMIT so a reviewer sees both halves:\n' +
    '  node scripts/verify-provenance.mjs --update\n',
);
process.exit(1);
