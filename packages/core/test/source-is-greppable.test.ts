import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * TASK-007, adversarial cycle 1 — no source file may contain a literal NUL byte.
 *
 * This is not style. `grep` and `ripgrep` classify a file containing a NUL as BINARY and skip it
 * **silently** unless `-a`/`--text` is passed. Two files in this repository contained one:
 *
 * - `chain/registry-core.ts` (since TASK-006) wrote its search-key separator as a raw byte;
 * - `adapters/defillama/index.ts` (this task, before the review) did the same for a cache key.
 *
 * The consequence was a gate reporting success for the wrong reason: TASK-007's own AC-8 audit —
 * "no loose zod schemas anywhere in src" — returned "zero hits" while never having looked at
 * `registry-core.ts`, which is the module that validates the per-chain SSRF allowlist and which
 * *did* contain a hit. Every future repo-wide text audit inherits the same blind spot, so the
 * invariant is enforced here rather than remembered.
 *
 * The fix in both cases was an escape (`'\\u0000'`), which is byte-identical at runtime and fully
 * visible to every text tool.
 */

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOTS = ['src', 'scripts', 'test'];
const TEXT_EXTENSIONS = new Set(['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs', '.json', '.md']);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if (TEXT_EXTENSIONS.has(path.extname(full))) {
      out.push(full);
    }
  }
  return out;
}

describe('source files stay visible to text tools', () => {
  it('no file under src/, scripts/ or test/ contains a literal NUL byte', () => {
    const offenders: string[] = [];
    for (const root of ROOTS) {
      for (const file of walk(path.join(packageRoot, root))) {
        if (readFileSync(file).includes(0)) {
          offenders.push(path.relative(packageRoot, file));
        }
      }
    }
    // Naming them matters: the failure mode this guards against is a gate that passes while
    // seeing nothing, so a count alone would repeat the original mistake.
    expect(offenders).toEqual([]);
  });

  it('the guard actually detects one (it would be worthless if it could not)', () => {
    // A guard whose positive case is never exercised is indistinguishable from a guard that
    // always passes — which is precisely the class of defect it was written to catch.
    // Built with `String.fromCharCode(0)` rather than a literal, so THIS file cannot become
    // the thing it forbids. It already did once: the guard's very first run failed on its
    // own positive-case literal.
    const withNul = Buffer.from(`a${String.fromCharCode(0)}b`, 'utf8');
    expect(withNul.includes(0)).toBe(true);
    expect(Buffer.from('plain text', 'utf8').includes(0)).toBe(false);
  });
});
