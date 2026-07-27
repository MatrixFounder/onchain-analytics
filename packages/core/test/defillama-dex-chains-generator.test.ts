import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateDefillamaDexChains } from '../scripts/gen-defillama-dex-chains.js';
import { DEFILLAMA_DEX_CHAINS } from '../src/adapters/defillama/dex-chains.js';

/**
 * TASK-007 task 007-2 (R-63, AC-5) — generator tests. Everything runs against synthetic evidence in
 * a temp directory: a generator test that depended on what the vendor served today would not be a
 * test. The one assertion that touches the COMMITTED artifact only checks that it is in sync with
 * its own committed evidence, which is a property of the repository, not of the network.
 */

let work: string;
let evidence: string;
let out: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'defillama-dex-chains-'));
  evidence = join(work, 'evidence.json');
  out = join(work, 'dex-chains.ts');
});
afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

function writeEvidence(allChains: unknown): void {
  writeFileSync(evidence, JSON.stringify({ allChains }), 'utf8');
}

/** 60 plausible names — above MIN_PLAUSIBLE_CHAINS, so size is never the reason a case fails. */
function plausibleNames(extra: string[] = []): string[] {
  return [...Array.from({ length: 60 }, (_, i) => `Chain ${i}`), ...extra];
}

describe('gen-defillama-dex-chains (task 007-2)', () => {
  it('is deterministic: a re-run on the same input is byte-identical', () => {
    writeEvidence(plausibleNames());
    generateDefillamaDexChains(evidence, out);
    const first = readFileSync(out, 'utf8');
    generateDefillamaDexChains(evidence, out);
    expect(readFileSync(out, 'utf8')).toBe(first);
  });

  it('sorts and de-duplicates, so reordering upstream produces no diff', () => {
    writeEvidence(plausibleNames(['Zebra', 'Alpha']));
    generateDefillamaDexChains(evidence, out);
    const first = readFileSync(out, 'utf8');
    // Same set, different order, plus a duplicate — the emitted file must not move.
    writeEvidence(['Alpha', ...plausibleNames(['Zebra']), 'Alpha']);
    generateDefillamaDexChains(evidence, out);
    expect(readFileSync(out, 'utf8')).toBe(first);
  });

  it('keeps names containing spaces — real vendor names have them', () => {
    writeEvidence(plausibleNames(['OP Mainnet', 'Hyperliquid L1']));
    const emitted = generateDefillamaDexChains(evidence, out);
    expect(emitted).toContain('OP Mainnet');
    expect(readFileSync(out, 'utf8')).toContain("'OP Mainnet',");
  });

  it.each([
    ['a quote', "Evil' + process.exit(1) + '"],
    ['a backslash', 'Back\\slash'],
    ['a newline', 'Two\nLines'],
    ['a leading space', ' Leading'],
  ])('REFUSES to emit a vendor name containing %s', (_label, name) => {
    writeEvidence(plausibleNames([name]));
    // Refusing rather than escaping is the decision under test: this string is interpolated into a
    // COMMITTED src/ module, and a silent escape would turn vendor drift into invisible source.
    expect(() => generateDefillamaDexChains(evidence, out)).toThrow(/refusing to emit/i);
  });

  it('refuses a suspiciously short list instead of emitting near-empty coverage', () => {
    writeEvidence(['Ethereum', 'Solana', 'Base']);
    expect(() => generateDefillamaDexChains(evidence, out)).toThrow(/Refusing to emit/i);
  });

  it('refuses evidence with no allChains array, or with non-string entries', () => {
    writeFileSync(evidence, JSON.stringify({ note: 'wrong shape' }), 'utf8');
    expect(() => generateDefillamaDexChains(evidence, out)).toThrow(/no 'allChains' array/);

    writeEvidence([...plausibleNames(), 42]);
    expect(() => generateDefillamaDexChains(evidence, out)).toThrow(/non-string entries/);
  });

  it('the COMMITTED dex-chains.ts is in sync with its committed evidence', () => {
    // Catches a hand-edit of the generated module — the file says "do not edit by hand", and this
    // is what makes that sentence enforceable rather than advisory.
    const regenerated = generateDefillamaDexChains(
      '../../docs/onchain-analytics/raw/defillama-dexs-allchains-2026-07-27.json',
      out,
    );
    expect([...DEFILLAMA_DEX_CHAINS]).toEqual(regenerated);
  });
});
