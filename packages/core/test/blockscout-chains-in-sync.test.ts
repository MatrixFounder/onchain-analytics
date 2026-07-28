import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { generateBlockscoutChains } from '../scripts/gen-blockscout-chains.js';
import { BLOCKSCOUT_CHAIN_IDS } from '../src/adapters/blockscout/chains.js';

/**
 * m-12 (adversarial cycle 1) — the committed artifact must still be what the generator produces
 * from the committed evidence.
 *
 * Without this, `chains.ts` is a hand-editable file that merely LOOKS generated: someone could add
 * or remove an id and every other test would stay green, because nothing compares the two. The
 * evidence is provenance-pinned and the generator is deterministic, so this is a cheap equality —
 * and it is the only thing standing between "generated" as a fact and "generated" as a comment.
 */
describe('blockscout chains.ts is in sync with the pinned evidence (m-12)', () => {
  let tmp: string | undefined;
  afterEach(() => {
    if (tmp) rmSync(tmp, { recursive: true, force: true });
    tmp = undefined;
  });

  it('regenerating from the committed evidence reproduces the committed ids exactly', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'blockscout-sync-'));
    tmp = dir;
    const out = path.join(dir, 'chains.ts');
    const testDir = path.dirname(fileURLToPath(import.meta.url));
    const evidence = path.join(
      testDir,
      '../../../docs/onchain-analytics/raw/blockscout-chains-2026-07-28.json',
    );

    const regenerated = generateBlockscoutChains(evidence, out);

    expect([...BLOCKSCOUT_CHAIN_IDS]).toEqual(regenerated);
    // And the artifact really is the generator's output, not just the same numbers in some order.
    expect(readFileSync(out, 'utf8')).toContain('BLOCKSCOUT_CHAIN_IDS');
  });
});
