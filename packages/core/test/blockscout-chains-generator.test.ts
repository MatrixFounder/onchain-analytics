import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { generateBlockscoutChains } from '../scripts/gen-blockscout-chains.js';

/**
 * TASK-008 task 008-1 (R-77) — the coverage generator.
 *
 * These tests drive the generator over SYNTHETIC evidence rather than the committed file, so they
 * assert the rules instead of today's numbers. The one assertion made against the real evidence is
 * a relation (mainnets < all rows), which survives vendor churn; a literal count would be "fixed"
 * by editing the number on the next sync, at which point it checks nothing.
 */

const testDir = path.dirname(fileURLToPath(import.meta.url));
const REAL_EVIDENCE = path.join(
  testDir,
  '../../../docs/onchain-analytics/raw/blockscout-chains-2026-07-28.json',
);

let tmp: string | undefined;
afterEach(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  tmp = undefined;
});

/** Writes synthetic evidence + an output path inside a throwaway directory. */
function withEvidence(rows: unknown[]): { evidence: string; out: string } {
  tmp = mkdtempSync(path.join(tmpdir(), 'blockscout-gen-'));
  const evidence = path.join(tmp, 'evidence.json');
  writeFileSync(evidence, JSON.stringify({ data: rows }), 'utf8');
  return { evidence, out: path.join(tmp, 'chains.ts') };
}

const mainnet = (chain_id: string, name = `chain-${chain_id}`, ecosystem = 'Ethereum') => ({
  name,
  chain_id,
  is_testnet: false,
  ecosystem,
});

/** 25 filler mainnets, so a test about one specific row never trips MIN_PLAUSIBLE_MAINNETS. */
const filler = Array.from({ length: 30 }, (_, i) => mainnet(String(1000 + i)));

describe('gen-blockscout-chains (R-77)', () => {
  it('keys coverage on chain_id, NOT on the ecosystem field', () => {
    // The regression this guards: `ecosystem: "Solana"` is Neon — an EVM chain with a numeric id —
    // and `"Bitcoin/BCH"` is Rootstock. An implementation that grouped or filtered by `ecosystem`
    // would either drop these two real EVM mainnets or advertise svm/utxo support that does not
    // exist (the TASK-006 H-1 over-claim). Both belong in the output, on their ids alone.
    const { evidence, out } = withEvidence([
      ...filler,
      mainnet('245022934', 'Neon', 'Solana'),
      mainnet('30', 'Rootstock', 'Bitcoin/BCH'),
    ]);

    const ids = generateBlockscoutChains(evidence, out);

    expect(ids).toContain(245022934);
    expect(ids).toContain(30);
    // Nothing but ids survives into the artifact's DATA. Asserted over the exported array only —
    // the file's header comment names those ecosystems on purpose, to explain why they are not the
    // key, and a whole-file grep would fail on the explanation rather than on a defect.
    const emitted = readFileSync(out, 'utf8');
    // Anchored on `= [`, not the first `[` — the type annotation `readonly number[]` comes first.
    const body = emitted.slice(emitted.indexOf('= [') + 3, emitted.lastIndexOf(']'));
    const entries = body
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    expect(entries.length).toBeGreaterThan(0);
    for (const entry of entries) {
      expect(entry, `non-numeric entry in the emitted list: ${entry}`).toMatch(/^\d+,$/);
    }
  });

  it('drops testnets, and treats a MISSING is_testnet flag as "not a mainnet"', () => {
    const { evidence, out } = withEvidence([
      ...filler,
      { name: 'Some Testnet', chain_id: '11155111', is_testnet: true, ecosystem: 'Ethereum' },
      // A row where the vendor stopped sending the flag. Admitting it would silently promote an
      // unknown chain into production coverage — the expensive direction of being wrong.
      { name: 'Flagless', chain_id: '424242', ecosystem: 'Ethereum' },
    ]);

    const ids = generateBlockscoutChains(evidence, out);

    expect(ids).not.toContain(11155111);
    expect(ids).not.toContain(424242);
  });

  it('refuses a non-numeric chain_id instead of coercing or escaping it', () => {
    // Refuse-don't-guess: a changed identifier scheme means our request URLs would name some OTHER
    // chain while we label the answer with this one.
    const { evidence, out } = withEvidence([...filler, mainnet('mainnet-beta', 'Weird')]);

    expect(() => generateBlockscoutChains(evidence, out)).toThrow(/non-numeric chain_id/);
  });

  it('refuses to write a suspiciously narrow list', () => {
    const { evidence, out } = withEvidence([mainnet('1'), mainnet('10')]);
    expect(() => generateBlockscoutChains(evidence, out)).toThrow(/Refusing to write/);
  });

  it('refuses evidence with no data array', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'blockscout-gen-'));
    tmp = dir;
    const evidence = path.join(dir, 'evidence.json');
    writeFileSync(evidence, JSON.stringify({ oops: [] }), 'utf8');
    expect(() => generateBlockscoutChains(evidence, path.join(dir, 'chains.ts'))).toThrow(
      /no `data` array/,
    );
  });

  it('emits a deduplicated, numerically sorted list', () => {
    const { evidence, out } = withEvidence([
      ...filler,
      mainnet('100'),
      mainnet('100'),
      mainnet('9'),
    ]);

    const ids = generateBlockscoutChains(evidence, out);

    expect(ids).toEqual([...ids].sort((a, b) => a - b));
    expect(new Set(ids).size).toBe(ids.length);
    // Numeric sort, not lexicographic: '9' must not land after '100'.
    expect(ids.indexOf(9)).toBeLessThan(ids.indexOf(100));
  });

  it('over the REAL committed evidence, keeps strictly fewer chains than the vendor lists', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'blockscout-gen-'));
    tmp = dir;
    const out = path.join(dir, 'chains.ts');

    const ids = generateBlockscoutChains(REAL_EVIDENCE, out);
    const total = (JSON.parse(readFileSync(REAL_EVIDENCE, 'utf8')) as { data: unknown[] }).data
      .length;

    // A relation, not a count: testnets exist and must be dropped, so coverage is a strict subset.
    expect(ids.length).toBeGreaterThan(0);
    expect(ids.length).toBeLessThan(total);
    expect(ids).toContain(1); // ethereum mainnet — if this ever drops out, something is very wrong
  });
});
