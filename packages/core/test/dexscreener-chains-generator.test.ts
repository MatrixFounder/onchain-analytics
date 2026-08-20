import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  candidatesOf,
  generateDexscreenerChains,
  type ProbeEvidence,
} from '../scripts/gen-dexscreener-chains.js';

/**
 * Task 014-32a — the DexScreener coverage generator (R-33).
 *
 * **Every case runs on SYNTHETIC evidence written into a temp directory.** The generator's two modes
 * are split precisely so this is possible: `--record` touches the network and is an operator's
 * action, while the emit mode is a pure function of a committed file. R-21 forbids the network in
 * CI, and a generator whose logic could only be exercised by probing a vendor would be a generator
 * nothing tests.
 *
 * **Size is never the reason a case fails, except in TC-UNIT-02.** Each fixture below carries 30
 * chains above the plausibility floor, the idiom `defillama-dex-chains-generator.test.ts` already
 * uses — otherwise a case about ambiguity or echoes could go green because the floor rejected the
 * evidence first, for a reason having nothing to do with what it claims to measure.
 */

interface Candidate {
  caip2: string;
  slug: string;
  candidate: string;
  status: number | null;
}

/** `n` chains that answered and echoed — the bulk that keeps every fixture above the floor. */
function filler(n: number): { candidates: Candidate[]; echoes: string[] } {
  const candidates: Candidate[] = [];
  const echoes: string[] = [];
  for (let i = 0; i < n; i += 1) {
    const slug = `filler-${String(i)}`;
    candidates.push({ caip2: `eip155:90${String(i)}`, slug, candidate: slug, status: 200 });
    echoes.push(slug);
  }
  return { candidates, echoes };
}

function evidenceOf(extra: Candidate[], extraEchoes: string[], fillerCount = 30): ProbeEvidence {
  const base = filler(fillerCount);
  return {
    recordedAt: '2026-08-20',
    probeAddress: '0x0000000000000000000000000000000000000000',
    echoQueries: [],
    observedChainIds: [...base.echoes, ...extraEchoes],
    candidates: [...base.candidates, ...extra],
  };
}

/** Writes the evidence to a temp file and emits beside it; returns both paths and the result. */
function emit(evidence: ProbeEvidence) {
  const dir = mkdtempSync(path.join(tmpdir(), 'dexscreener-gen-'));
  const evidencePath = path.join(dir, 'probe.json');
  const outPath = path.join(dir, 'chain-coverage.ts');
  writeFileSync(evidencePath, JSON.stringify(evidence), 'utf8');
  const result = generateDexscreenerChains(evidencePath, outPath);
  return { ...result, outPath, source: readFileSync(outPath, 'utf8') };
}

describe('TC-UNIT-01: evidence of 30 answering chains produces 30 chains in the module', () => {
  it('and the values are the ones the evidence carries, not a literal', () => {
    const { coverage, source } = emit(evidenceOf([], []));
    const verified = Object.values(coverage).filter((entry) => entry.status === 'verified');
    expect(verified).toHaveLength(30);
    // Read off the emitted SOURCE too: a generator that returned the right object and wrote the
    // wrong file would satisfy an assertion made only on the return value.
    expect(source).toContain("'eip155:900': { chainId: 'filler-0', status: 'verified' }");
    expect(source).toContain('DEXSCREENER_CHAIN_COVERAGE');
  });
});

describe('TC-UNIT-02: evidence below the plausibility floor is refused', () => {
  it('the generator throws and the module is not rewritten', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'dexscreener-gen-'));
    const evidencePath = path.join(dir, 'probe.json');
    const outPath = path.join(dir, 'chain-coverage.ts');
    writeFileSync(outPath, 'UNTOUCHED', 'utf8');
    writeFileSync(evidencePath, JSON.stringify(evidenceOf([], [], 5)), 'utf8');

    expect(() => generateDexscreenerChains(evidencePath, outPath)).toThrow(/only 5 verified/);
    // The refusal has to be a refusal to WRITE. A generator that threw after writing would leave a
    // near-empty catalogue on disk, and a near-empty catalogue narrows coverage to nothing — which
    // looks exactly like the task never having been done.
    expect(readFileSync(outPath, 'utf8')).toBe('UNTOUCHED');
  });
});

describe('TC-UNIT-03: an identifier outside the emittable class is refused, never escaped', () => {
  it('a quote in a chain id throws instead of closing the literal early', () => {
    const hostile = "evil', status: 'verified' }, 'x': { chainId: 'pwned";
    expect(() =>
      emit(
        evidenceOf(
          [{ caip2: 'eip155:1', slug: 'hostile', candidate: hostile, status: 200 }],
          [hostile],
        ),
      ),
    ).toThrow(/refusing to emit chain id/);
  });

  it('and the class is checked on the ECHOED candidate, which is the one that gets emitted', () => {
    // A routable candidate outside the class that was never echoed cannot reach the literal, so it
    // is reported rather than fatal — the report is what an operator acts on.
    const { coverage, curation } = emit(
      evidenceOf(
        [{ caip2: 'eip155:2', slug: 'spaced', candidate: 'shiden network', status: 200 }],
        [],
      ),
    );
    expect(coverage['eip155:2']).toStrictEqual({ chainId: null, status: 'unverified' });
    expect(curation.join('\n')).toContain('shiden network');
  });
});

describe('TC-UNIT-05: the value is the ANSWERING CANDIDATE, never the slug', () => {
  it('an alias that answered is what reaches the map', () => {
    // The defect this prevents: `normalize()` filters vendor rows by
    // `pair.chainId === chain.vendors['dexscreener']`, so a slug written where the vendor's own
    // identifier belongs drops every row and the capability answers an empty page. Measured
    // 2026-08-18: four chains answer 400 on their slug and 200 on their vendor id.
    const { coverage } = emit(
      evidenceOf(
        [
          { caip2: 'eip155:10', slug: 'op-mainnet', candidate: 'op-mainnet', status: 400 },
          { caip2: 'eip155:10', slug: 'op-mainnet', candidate: 'optimism', status: 200 },
        ],
        ['optimism'],
      ),
    );
    expect(coverage['eip155:10']).toStrictEqual({ chainId: 'optimism', status: 'verified' });
    expect(coverage['eip155:10']?.chainId).not.toBe('op-mainnet');
  });
});

describe('TC-UNIT-06: two answering candidates leave the column null and the row reported', () => {
  it('the generator refuses to choose', () => {
    const { coverage, curation } = emit(
      evidenceOf(
        [
          { caip2: 'eip155:5', slug: 'twofaced', candidate: 'twofaced', status: 200 },
          { caip2: 'eip155:5', slug: 'twofaced', candidate: 'twoface', status: 200 },
        ],
        ['twofaced', 'twoface'],
      ),
    );
    expect(coverage['eip155:5']).toStrictEqual({ chainId: null, status: 'unverified' });
    expect(curation.join('\n')).toMatch(/eip155:5: 2 candidates answered and echoed/);
  });
});

describe('TC-UNIT-07: a routable candidate with no echo is `unverified`', () => {
  it('status alone is not evidence of coverage', () => {
    // A `200` is returned by a segment holding data AND by one holding none, so status alone would
    // read an empty answer as coverage — the L-10 class, which this whole task is a correction of.
    const { coverage, curation } = emit(
      evidenceOf([{ caip2: 'eip155:7', slug: 'silent', candidate: 'silent', status: 200 }], []),
    );
    expect(coverage['eip155:7']).toStrictEqual({ chainId: null, status: 'unverified' });
    expect(curation.join('\n')).toContain('eip155:7: routable but never echoed');
  });

  it('and a candidate the vendor refused outright is `excluded`, which is a different claim', () => {
    const { coverage } = emit(
      evidenceOf([{ caip2: 'eip155:8', slug: 'refused', candidate: 'refused', status: 400 }], []),
    );
    expect(coverage['eip155:8']).toStrictEqual({ chainId: null, status: 'excluded' });
  });
});

describe('TC-UNIT-09: the curated override survives generation', () => {
  it('`hyperliquid-l1` carries `hyperevm`, and the second candidate is still reported', () => {
    const { coverage, curation } = emit(
      evidenceOf(
        [
          { caip2: 'eip155:999', slug: 'hyperliquid-l1', candidate: 'hyperevm', status: 200 },
          { caip2: 'eip155:999', slug: 'hyperliquid-l1', candidate: 'hyperliquid', status: 200 },
        ],
        ['hyperevm', 'hyperliquid'],
      ),
    );
    // The owner's decision supplies the value; it does NOT relax the refusal, so the ambiguity is
    // still named for whoever reads the report.
    expect(coverage['eip155:999']).toStrictEqual({ chainId: 'hyperevm', status: 'verified' });
    expect(curation.join('\n')).toContain('eip155:999');
  });

  it('a stale override — one no candidate echoed — is a hard failure, not a silent value', () => {
    expect(() =>
      emit(
        evidenceOf(
          [
            { caip2: 'eip155:999', slug: 'hyperliquid-l1', candidate: 'hyperliquid', status: 200 },
            { caip2: 'eip155:999', slug: 'hyperliquid-l1', candidate: 'other', status: 200 },
          ],
          ['hyperliquid', 'other'],
        ),
      ),
    ).toThrow(/override .* was not among the echoed candidates/);
  });
});

describe('the candidate rule is the slug plus every alias', () => {
  it('de-duplicated, so a row whose alias repeats its slug is probed once', () => {
    const rows = [
      { caip2: 'eip155:1', slug: 'ethereum', aliases: ['eth', 'ethereum'] },
      { caip2: 'eip155:2', slug: 'lonely' },
    ];
    expect(candidatesOf(rows).map((c) => c.candidate)).toStrictEqual(['ethereum', 'eth', 'lonely']);
  });
});
