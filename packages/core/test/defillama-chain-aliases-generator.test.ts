import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateDefillamaChainAliases } from '../scripts/gen-defillama-chain-aliases.js';
import { DEFILLAMA_CHAIN_ALIASES } from '../src/adapters/defillama/chain-aliases.js';

/**
 * Generator tests for the legacy→current chain-name map. Everything runs against SYNTHETIC evidence
 * in a temp directory — a generator test that depended on what the vendor served today would not be
 * a test — with one exception: the last case checks the COMMITTED module against its COMMITTED
 * evidence, which is a property of the repository rather than of the network.
 *
 * The join rule under test is narrow because two of the vendor's three identity columns are provably
 * unsafe on the recorded data, and the cases below encode those exact counterexamples rather than
 * describing them.
 */

let work: string;
let evidence: string;
let out: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'defillama-chain-aliases-'));
  evidence = join(work, 'evidence.json');
  out = join(work, 'chain-aliases.ts');
});
afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

interface Row {
  name: string;
  chainId?: number | null;
  gecko_id?: string | null;
  cmcId?: string | null;
}

/** `count` filler renames so a case never fails merely for being under MIN_PLAUSIBLE_ALIASES. */
function padding(count = 12): { legacy: Row[]; current: Row[] } {
  const legacy: Row[] = [];
  const current: Row[] = [];
  for (let i = 0; i < count; i += 1) {
    legacy.push({ name: `Old ${i}`, chainId: 9000 + i, gecko_id: `pad-${i}` });
    current.push({ name: `New ${i}`, chainId: 9000 + i, gecko_id: `pad-${i}` });
  }
  return { legacy, current };
}

function write(extra: { legacy?: Row[]; current?: Row[] } = {}): void {
  const base = padding();
  writeFileSync(
    evidence,
    JSON.stringify({
      legacy: [...base.legacy, ...(extra.legacy ?? [])],
      current: [...base.current, ...(extra.current ?? [])],
    }),
    'utf8',
  );
}

describe('gen-defillama-chain-aliases', () => {
  it('joins a rename on chainId, which is the case that matters in production', () => {
    write({
      legacy: [{ name: 'Binance', chainId: 56, gecko_id: 'binancecoin', cmcId: '1839' }],
      current: [{ name: 'BSC', chainId: 56, gecko_id: 'binancecoin', cmcId: '1839' }],
    });

    const aliases = generateDefillamaChainAliases(evidence, out);

    expect(aliases.get('Binance')).toBe('BSC');
    expect(readFileSync(out, 'utf8')).toContain("['Binance', 'BSC'],");
  });

  it('NEVER joins on cmcId — Terra and Flare share one, and would become a fake rename', () => {
    // Measured on the 2026-08-11 recording: cmcId 4172 appears on both `Terra` and `Flare`, and
    // 2137 on both `Electroneum` and `HeLa`. A join on it invents renames between unrelated chains,
    // which is worse than no alias at all: it would silently attribute one chain's TVL to another.
    write({
      legacy: [{ name: 'Terra', chainId: null, gecko_id: 'terra-luna', cmcId: '4172' }],
      current: [{ name: 'Flare', chainId: null, gecko_id: 'flare-networks', cmcId: '4172' }],
    });

    const aliases = generateDefillamaChainAliases(evidence, out);

    expect(aliases.has('Terra')).toBe(false);
  });

  it('joins on gecko_id only when it identifies ONE row on each side', () => {
    // `Bitcoincash` and `smartBCH` both carry `bitcoin-cash`; `IOTA` and `IOTA EVM` both carry
    // `iota`. An L1 and a sidechain sharing a coin id is not a rename.
    write({
      legacy: [
        { name: 'Bitcoincash', chainId: null, gecko_id: 'bitcoin-cash' },
        { name: 'smartBCH', chainId: 10000, gecko_id: 'bitcoin-cash' },
        { name: 'Lonely Old', chainId: null, gecko_id: 'lonely' },
      ],
      current: [
        { name: 'Bitcoincash', chainId: null, gecko_id: 'bitcoin-cash' },
        { name: 'smartBCH', chainId: 10000, gecko_id: 'bitcoin-cash' },
        { name: 'Lonely New', chainId: null, gecko_id: 'lonely' },
      ],
    });

    const aliases = generateDefillamaChainAliases(evidence, out);

    expect(aliases.has('Bitcoincash')).toBe(false);
    // The unique one still joins, so the guard narrows the rule rather than disabling it.
    expect(aliases.get('Lonely Old')).toBe('Lonely New');
  });

  it('refuses a many-to-one rename instead of merging two chains into one answer', () => {
    write({
      legacy: [
        { name: 'First Old', chainId: 4242, gecko_id: 'first' },
        { name: 'Second Old', chainId: 4242, gecko_id: 'second' },
      ],
      current: [{ name: 'Merged', chainId: 4242, gecko_id: 'merged' }],
    });

    expect(() => generateDefillamaChainAliases(evidence, out)).toThrow(/many-to-one rename/);
  });

  it('REFUSES to emit a vendor name that would break out of the source literal', () => {
    // Same doctrine as the DEX-chain generator: escaping makes drift safe and silent, refusing makes
    // it safe and visible — and this string lands in a COMMITTED src/ module.
    write({
      legacy: [{ name: "Evil' + process.exit(1) + '", chainId: 777, gecko_id: 'evil' }],
      current: [{ name: 'Fine', chainId: 777, gecko_id: 'evil' }],
    });

    expect(() => generateDefillamaChainAliases(evidence, out)).toThrow(/refusing to emit/i);
  });

  it('refuses a suspiciously small map rather than silently restoring the defect', () => {
    writeFileSync(
      evidence,
      JSON.stringify({
        legacy: [{ name: 'Only Old', chainId: 1, gecko_id: 'only' }],
        current: [{ name: 'Only New', chainId: 1, gecko_id: 'only' }],
      }),
      'utf8',
    );

    // An empty or near-empty map looks exactly like a successful run while restoring a defect that
    // makes 43 chains answer "not deployed".
    expect(() => generateDefillamaChainAliases(evidence, out)).toThrow(/refusing to emit only/i);
  });

  it('is deterministic: a re-run on the same input is byte-identical', () => {
    write({
      legacy: [
        { name: 'Zeta Old', chainId: 1, gecko_id: 'z' },
        { name: 'Alpha Old', chainId: 2, gecko_id: 'a' },
      ],
      current: [
        { name: 'Zeta New', chainId: 1, gecko_id: 'z' },
        { name: 'Alpha New', chainId: 2, gecko_id: 'a' },
      ],
    });
    generateDefillamaChainAliases(evidence, out);
    const first = readFileSync(out, 'utf8');
    generateDefillamaChainAliases(evidence, out);
    expect(readFileSync(out, 'utf8')).toBe(first);
  });

  it('the COMMITTED chain-aliases.ts is in sync with its committed evidence', () => {
    // Makes "do not edit by hand" enforceable rather than advisory.
    const regenerated = generateDefillamaChainAliases(
      '../../docs/onchain-analytics/raw/defillama-chain-name-vocabularies-2026-08-11.json',
      out,
    );
    expect([...DEFILLAMA_CHAIN_ALIASES]).toEqual(
      [...regenerated].sort((a, b) => (a[0] < b[0] ? -1 : 1)),
    );
    // The three that production actually depends on, named so a regeneration that quietly drops one
    // fails here rather than in a user's answer.
    expect(DEFILLAMA_CHAIN_ALIASES.get('Binance')).toBe('BSC');
    expect(DEFILLAMA_CHAIN_ALIASES.get('Optimism')).toBe('OP Mainnet');
    expect(DEFILLAMA_CHAIN_ALIASES.get('xDai')).toBe('Gnosis');
  });
});
