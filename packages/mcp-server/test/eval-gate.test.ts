import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';

/**
 * The live gate's own verdicts (task 014-43, closing RF-10).
 *
 * **Why this file did not exist before, and why that was the defect.** `scripts/eval-gate.mjs`
 * decides whether a task may be called done, and its only exercise was running it against the real
 * providers — where the input cannot be chosen. So every claim about its behaviour was a claim
 * about what somebody had happened to observe: RF-9 and RF-10 were both found in production, on a
 * Tuesday, by a human reading a report that surprised them.
 *
 * **It drives the real script as a subprocess**, with `--from` for the matrix and the existing
 * `ONCHAIN_EVAL_ACK` seam for the configuration. Both are production entry points, so nothing here
 * is a reimplementation of the logic under test — the alternative, exporting the internals, would
 * have let the exported copy and the shipped `main()` diverge exactly the way RF-5 describes.
 *
 * `--dry-run` throughout: a test must not append to the evidence ledger.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const packageRoot = path.resolve(here, '..');
const GATE = path.join(packageRoot, 'scripts', 'eval-gate.mjs');

const workDir = mkdtempSync(path.join(tmpdir(), 'eval-gate-test-'));
afterAll(() => {
  rmSync(workDir, { recursive: true, force: true });
});

/** Fixed, so `reviewBy` arithmetic in the cases below is arithmetic and not a race with the clock. */
const RAN_AT = '2026-08-21T06:00:00.000Z';
const daysFromRun = (days: number): string =>
  new Date(Date.parse(RAN_AT) + days * 86_400_000).toISOString().slice(0, 10);

interface Row {
  chain: string;
  capability: string;
  verdict: string;
  problems?: string[];
}

let seq = 0;
function runGate(
  rows: Row[],
  acknowledged: Record<string, unknown>,
): { code: number; out: string } {
  seq += 1;
  const artifactPath = path.join(workDir, `artifact-${String(seq)}.json`);
  const ackPath = path.join(workDir, `ack-${String(seq)}.json`);
  writeFileSync(
    artifactPath,
    JSON.stringify({
      ranAt: RAN_AT,
      counts: { ok: rows.filter((r) => r.verdict === 'ok').length },
      results: rows,
    }),
  );
  writeFileSync(ackPath, JSON.stringify({ acknowledged }));

  try {
    const out = execFileSync(process.execPath, [GATE, '--from', artifactPath, '--dry-run'], {
      cwd: packageRoot,
      encoding: 'utf8',
      env: { ...process.env, ONCHAIN_EVAL_ACK: ackPath },
    });
    return { code: 0, out };
  } catch (error) {
    const e = error as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? -1, out: `${e.stdout ?? ''}${e.stderr ?? ''}` };
  }
}

const failing = (chain: string, capability = 'token.holders'): Row => ({
  chain,
  capability,
  verdict: 'error',
  problems: ['capability unavailable'],
});
// NOTE the call sites: `CHAINS.map((c) => passing(c))`, never `CHAINS.map(passing)`. `Array.map`
// passes the INDEX as the second argument, which lands in `capability` and silently builds rows
// keyed `ethereum/0`. It cost three red cases and one that passed for the wrong reason.
const passing = (chain: string, capability = 'token.holders'): Row => ({
  chain,
  capability,
  verdict: 'ok',
});

/** The five chains L-12 rotates across — the real shape, so the cases are not toy inputs. */
const CHAINS = ['ethereum', 'base', 'arbitrum', 'polygon', 'gnosis'];
const ROWS = CHAINS.map((c) => `${c}/token.holders`);

/** A well-formed entry; each case below breaks exactly one thing about it. */
const baseEntry = {
  issue: 'L-12',
  since: '2026-08-11',
  reviewBy: daysFromRun(30),
  rows: ROWS,
  maxFailing: 3,
  why: 'Measured: the vendor holders index is slow on three of the five chains it serves.',
};

describe('RF-10 — an intermittent failure is acknowledgeable', () => {
  it('TC-INT-01: the failing chain ROTATES within the bound and the gate passes both ways', () => {
    // The exact pair of runs that made RF-10 unfixable. Under the old per-row boolean, run A
    // reported `gnosis` as unfiled and run B reported `ethereum`'s entry as stale — so the gate
    // blocked on BOTH, and no edit to the file could satisfy both at once.
    const runA = runGate(
      CHAINS.map((c) => (c === 'gnosis' ? failing(c) : passing(c))),
      { 'L-12/holders': baseEntry },
    );
    expect(runA.code, runA.out).toBe(0);
    expect(runA.out).toContain('1 of 5 failing (bound 3)');

    const runB = runGate(
      CHAINS.map((c) => (c === 'ethereum' ? failing(c) : passing(c))),
      { 'L-12/holders': baseEntry },
    );
    expect(runB.code, runB.out).toBe(0);
    expect(runB.out).toContain('eval-gate: pass');
  });

  it('TC-INT-02: one more failing row than the bound BLOCKS — the fact grew past the measurement', () => {
    const result = runGate(
      CHAINS.map((c) => (c === 'gnosis' ? passing(c) : failing(c))),
      { 'L-12/holders': baseEntry },
    );
    expect(result.code, result.out).toBe(1);
    expect(result.out).toContain('4 of 5 failing, over the bound of 3');
  });

  it('TC-INT-03: a fully GREEN set does not block — that is the rotation, not a recovery', () => {
    // The half RF-10 warns about in the other direction: one green run is not evidence a filed
    // defect closed, so an entry whose rows all pass today survives to its `reviewBy` and says so.
    const result = runGate(
      CHAINS.map((c) => passing(c)),
      { 'L-12/holders': baseEntry },
    );
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain('0 of 5 failing (bound 3)');
  });
});

describe('what still blocks — the guards that keep an acknowledgement honest', () => {
  it('TC-INT-04: a failing row no entry covers still blocks; this is the signal', () => {
    const result = runGate([failing('solana', 'token.price'), ...CHAINS.map((c) => passing(c))], {
      'L-12/holders': baseEntry,
    });
    expect(result.code, result.out).toBe(1);
    expect(result.out).toContain('solana/token.price');
    expect(result.out).toContain('NEW failures (1)');
  });

  it('TC-INT-05: a named row that left the matrix blocks — coverage shrank (RF-5)', () => {
    const result = runGate(
      CHAINS.filter((c) => c !== 'polygon').map((c) => passing(c)),
      { 'L-12/holders': baseEntry },
    );
    expect(result.code, result.out).toBe(1);
    expect(result.out).toContain('which the eval matrix no longer contains');
    expect(result.out).toContain('polygon/token.holders');
  });

  it('TC-INT-06: a passed review date blocks and names the entry', () => {
    const result = runGate(
      CHAINS.map((c) => passing(c)),
      {
        'L-12/holders': { ...baseEntry, reviewBy: daysFromRun(-1) },
      },
    );
    expect(result.code, result.out).toBe(1);
    expect(result.out).toContain('review was due');
  });
});

describe('the file is a contract, and a malformed one is not a pass', () => {
  const cases: [string, Record<string, unknown>, string][] = [
    [
      // M6 applied to this file's own new vocabulary: without a ceiling, a far-future date is a
      // permanent exemption in the costume of a review.
      'a review date beyond the 90-day window',
      { ...baseEntry, reviewBy: daysFromRun(400) },
      'permanent exemption, not a review',
    ],
    [
      // A bound it cannot exceed accepts the total outage it exists to keep visible — RF-10's own
      // "do not widen it to: this capability may fail anywhere".
      'a bound equal to the set size',
      { ...baseEntry, maxFailing: ROWS.length },
      'accepts the total outage',
    ],
    [
      'an issue id that is in no ledger',
      { ...baseEntry, issue: 'L-9999' },
      'names no record in docs/KNOWN_ISSUES.md',
    ],
    ['no rows at all', { ...baseEntry, rows: [] }, 'an entry must name the rows it covers'],
    ['a reason too short to be one', { ...baseEntry, why: 'flaky' }, 'carries no usable reason'],
  ];

  for (const [name, entry, expected] of cases) {
    it(`TC-INT-07: blocks on ${name}`, () => {
      const result = runGate(
        CHAINS.map((c) => passing(c)),
        { 'L-12/holders': entry },
      );
      expect(result.code, result.out).toBe(1);
      expect(result.out).toContain('MALFORMED');
      expect(result.out).toContain(expected);
    });
  }

  it('TC-INT-08: two entries covering one row is ambiguous ownership, not a merge', () => {
    const result = runGate(
      CHAINS.map((c) => passing(c)),
      {
        'L-12/holders': baseEntry,
        'L-20/other': {
          ...baseEntry,
          issue: 'L-20',
          rows: ['gnosis/token.holders'],
          maxFailing: 1,
        },
      },
    );
    expect(result.code, result.out).toBe(1);
    expect(result.out).toContain('ownership is ambiguous');
  });
});

describe('RF-9 residue — "not tested" is neither failing nor passing', () => {
  it('TC-INT-09: a rate-limited row is reported as NOT TESTED, never counted as recovered', () => {
    // The old code rendered exactly this case as `now passes (rate-limited)`. Folding it into "not
    // failing" is the quieter version of the same error: an entry whose whole set is being
    // throttled would report `0 of N failing` and read as recovered while nothing was measured.
    const result = runGate(
      CHAINS.map((c) =>
        c === 'base'
          ? { chain: c, capability: 'token.holders', verdict: 'rate-limited' }
          : passing(c),
      ),
      { 'L-12/holders': baseEntry },
    );
    expect(result.code, result.out).toBe(0);
    expect(result.out).toContain('NOT TESTED');
    expect(result.out).toContain('base/token.holders');
    expect(result.out).not.toContain('now passes');
  });
});

describe('the gate is not vacuous', () => {
  it('reports a clean tree as clean, and a broken instrument as blocked', () => {
    // Sign of work before the verdict: every case above asserts a BLOCK or a specific tally, so a
    // gate that blocked unconditionally would pass most of them. This is the control that fails if
    // it does.
    const clean = runGate(
      CHAINS.map((c) => passing(c)),
      {},
    );
    expect(clean.code, clean.out).toBe(0);
    expect(clean.out).toContain('No failures and no acknowledgements');

    const broken = runGate(
      CHAINS.map((c) => passing(c)),
      { 'x/y': { issue: 'L-12' } },
    );
    expect(broken.code, broken.out).toBe(1);
  });
});
