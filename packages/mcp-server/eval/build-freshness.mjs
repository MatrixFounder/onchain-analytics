// Is the compiled dependency the eval will actually load newer than its source? (task 015-30)
//
// WHY THIS EXISTS. The eval raises the server from SOURCE (`--import tsx src/index.ts`) but
// `@onchain-intel/core` resolves through its package `main` to `packages/core/dist/index.js`. So a
// change in `packages/core/src` is INVISIBLE to a live run until someone builds — and nothing said
// so. On 2026-09-01 that cost two full acceptance runs against real providers: the fix for L-29 was
// committed, the gate was run, and the gate faithfully re-measured the defect from the August build.
//
// WHY IT REFUSES RATHER THAN BUILDING. A verification instrument that repairs its own subject can no
// longer report on it: the run would then be measuring a tree that never existed on disk when the
// operator asked. Refusing names the missing step and leaves the decision where it belongs.
//
// WHY MTIME AND NOT A CONTENT HASH. The question is "is the build BEHIND", and mtime answers it
// without a build system. A checkout can reorder mtimes and produce a false alarm — which costs one
// `pnpm build` — while the failure this guards cost two live runs and a wrong conclusion.

import { readdirSync, statSync } from 'node:fs';
import path from 'node:path';

/** Newest mtime (epoch-ms) under `dir`, or `null` when the directory does not exist or is empty. */
export function newestMtimeMs(dir) {
  let newest = null;
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const nested = newestMtimeMs(full);
      if (nested !== null && (newest === null || nested > newest)) newest = nested;
      continue;
    }
    if (!entry.isFile()) continue;
    let stat;
    try {
      stat = statSync(full);
    } catch {
      continue;
    }
    const ms = stat.mtimeMs;
    if (newest === null || ms > newest) newest = ms;
  }
  return newest;
}

/**
 * Which of the given packages carry a `dist` older than their `src`, or no `dist` at all.
 *
 * @param packages `{ name, srcDir, distDir }[]`
 * @returns `{ name, reason }[]` — empty when every build is current.
 */
export function stalePackages(packages) {
  const stale = [];
  for (const pkg of packages) {
    const src = newestMtimeMs(pkg.srcDir);
    const dist = newestMtimeMs(pkg.distDir);
    if (src === null) continue; // no source to be behind of — not this check's business
    if (dist === null) {
      stale.push({ name: pkg.name, reason: 'it has no build at all' });
      continue;
    }
    if (dist < src) {
      const behindMs = src - dist;
      stale.push({
        name: pkg.name,
        reason: `its build is ${String(Math.round(behindMs / 60_000))} minute(s) older than its source`,
      });
    }
  }
  return stale;
}

/** The packages a live run loads in COMPILED form. `mcp-server` runs from source and is not one. */
export function compiledDependencies(repoRoot) {
  return [
    {
      name: '@onchain-intel/core',
      srcDir: path.join(repoRoot, 'packages', 'core', 'src'),
      distDir: path.join(repoRoot, 'packages', 'core', 'dist'),
    },
  ];
}

/** The operator-facing refusal, or `null` when nothing is stale. */
export function buildFreshnessRefusal(repoRoot) {
  const stale = stalePackages(compiledDependencies(repoRoot));
  if (stale.length === 0) return null;
  return (
    'the eval loads these packages from their BUILD, and the build is behind the source:\n' +
    stale.map((s) => `   · ${s.name} — ${s.reason}`).join('\n') +
    '\nRun `pnpm build` first. A live run against a stale build spends real provider calls to ' +
    'measure code that is not the code under test — which is how the L-29 fix was "verified" twice ' +
    'while the August build was still running.'
  );
}
