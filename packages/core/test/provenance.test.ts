import { describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

/**
 * RF-2 — the provenance chain must not be able to skip an edit silently.
 *
 * TASK-005 recorded a golden-test SHA by hand in a doc header so that silent tuning of a
 * live-recorded assertion would be detectable. It was not: the recorded hash described a working
 * tree, an unlogged edit landed after it, and the commit shipped matching nothing. The mechanism
 * failed for a structural reason, not a careless one — it required a human to remember to re-run
 * `shasum` and paste the result, and there is no way to test that a human remembered.
 *
 * This file is the half of the replacement that runs on EVERY `pnpm test`. The other half is
 * `.githooks/pre-commit`, which checks the staged blobs — the working tree and the index can
 * differ, and that difference is precisely how the original break happened.
 *
 * Living in `packages/core` because that is where the pinned files are and where the test suite
 * everyone runs lives; it reaches up to the repo root deliberately, the same way
 * `registry-generator.test.ts` reaches into `src/`.
 */
const repoRoot = path.resolve(import.meta.dirname, '../../..');
const manifestPath = path.join(repoRoot, 'docs/provenance.json');

interface Manifest {
  files: Record<string, { sha256: string; note?: string }>;
}

function loadManifest(): Manifest {
  return JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
}

const sha256 = (buf: Buffer): string => createHash('sha256').update(buf).digest('hex');

describe('provenance manifest', () => {
  it('exists and pins a non-empty set of files', () => {
    // A manifest that lists nothing would make every assertion below vacuously true — the failure
    // mode of a guard that looks green because it is switched off.
    expect(existsSync(manifestPath)).toBe(true);
    expect(Object.keys(loadManifest().files).length).toBeGreaterThan(0);
  });

  it('pins the golden test and every live-recorded Nansen fixture', () => {
    // Named explicitly rather than derived: the point of the manifest is that ADDING a
    // live-recorded artefact is also a decision someone makes, not something a glob does silently.
    const pinned = Object.keys(loadManifest().files);
    expect(pinned).toContain('packages/core/test/nansen.contract.test.ts');
    expect(
      pinned.filter((p) => p.startsWith('packages/core/test/fixtures/nansen/')).length,
    ).toBeGreaterThan(5);
  });

  it('every pinned file still hashes to its recorded value', () => {
    const failures: string[] = [];
    for (const [relPath, entry] of Object.entries(loadManifest().files)) {
      const abs = path.join(repoRoot, relPath);
      if (!existsSync(abs)) {
        failures.push(`${relPath}: pinned but missing from the working tree`);
        continue;
      }
      const actual = sha256(readFileSync(abs));
      if (actual !== entry.sha256) {
        failures.push(`${relPath}: recorded ${entry.sha256}, actual ${actual}`);
      }
    }
    // The message has to say what to DO, or the next person re-baselines by hand and re-creates
    // the very break this replaces.
    expect(
      failures,
      `A pinned file changed without its recorded hash changing with it — the exact condition ` +
        `RF-2 exists to catch. If intended, re-baseline IN THE SAME COMMIT:\n` +
        `  node scripts/verify-provenance.mjs --update\n\n${failures.join('\n')}`,
    ).toEqual([]);
  });

  it('the recorded hashes describe the COMMITTED blobs, not just the working tree', () => {
    // The original break lived exactly in that gap. Skipped rather than failed when a pinned file
    // has staged-but-uncommitted changes, which is a normal state mid-task — the pre-commit hook
    // is what covers that moment, and asserting here would fail every legitimate work-in-progress.
    const manifest = loadManifest();
    const mismatched: string[] = [];
    for (const [relPath, entry] of Object.entries(manifest.files)) {
      let committed: Buffer;
      try {
        committed = execFileSync('git', ['show', `HEAD:${relPath}`], {
          cwd: repoRoot,
          maxBuffer: 64 * 1024 * 1024,
        });
      } catch {
        continue; // not in HEAD yet (a newly pinned file) — the worktree check above still covers it
      }
      const worktree = readFileSync(path.join(repoRoot, relPath));
      if (Buffer.compare(committed, worktree) !== 0) continue; // uncommitted edit in flight
      if (sha256(committed) !== entry.sha256) {
        mismatched.push(`${relPath}: HEAD blob does not match the recorded hash`);
      }
    }
    expect(mismatched).toEqual([]);
  });
});
