import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Task 014-30 — the two structural gates that keep the spend channel from silently losing coverage.
 *
 * Both are scanners over source text rather than behavioural tests, and each exists because the
 * defect it guards produces a GREEN suite: a thirteenth paid adapter that never reports, and a
 * second place that computes the amount. Neither would fail any test in this repository.
 */

const repoRoot = path.resolve(__dirname, '../../..');
const ROOTS = ['packages/core/src', 'packages/mcp-server/src'];

function sourcesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return sourcesUnder(full);
    return full.endsWith('.ts') ? [full] : [];
  });
}

/** Code lines only: a match inside a comment is prose about the rule, not an instance of it. */
function codeLines(body: string): string[] {
  return body
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'));
}

function filesMatching(pattern: RegExp): string[] {
  const hits: string[] = [];
  for (const root of ROOTS) {
    for (const file of sourcesUnder(path.join(repoRoot, root))) {
      if (codeLines(readFileSync(file, 'utf8')).some((line) => pattern.test(line))) {
        hits.push(path.relative(repoRoot, file));
      }
    }
  }
  return hits.sort();
}

describe('TC-GATE-01: every ledger write reports what it wrote', () => {
  it('a file that CALLS checkAndReserve or recordDelta also mentions onVendorSpend', () => {
    // The measurement WI-37 applies to `deadlineAtMs`, aimed at the other optional parameter. A new
    // paid adapter — ADR-003 D6 extends the call counter to any provider — would write to the
    // ledger and report nothing, and the whole suite would stay green: no existing case observes an
    // adapter that does not exist yet, and the daily reconciliation would simply drift.
    //
    // Call sites only, never declarations: the store implementations DECLARE these methods and must
    // not report, because a store that reported would be reporting its own argument back.
    const writers = filesMatching(/\.(checkAndReserve|recordDelta)\(/);
    expect(writers.length).toBeGreaterThan(0);

    const silent = writers.filter(
      (file) => !readFileSync(path.join(repoRoot, file), 'utf8').includes('onVendorSpend'),
    );
    expect(
      silent,
      'these files move a vendor spend ledger and never mention the reporter. A committed write ' +
        'that nothing reports is spend that no request can be charged for, and the daily ' +
        'reconciliation of request_trace against usage (R-27.3) drifts by exactly that amount.',
    ).toStrictEqual([]);
  });
});

describe('TC-GATE-02: the amount has one producer', () => {
  it('only the two ledger-writing modules construct a charge receipt', () => {
    // A `VendorChargeRecord` built anywhere else is a SECOND computation of "what did this request
    // spend" — the defect ADR-002 D8 and `budget-meta.ts` were both written to remove, in their own
    // domains. The two permitted files are the two that hold the arguments the store was called
    // with; anywhere else the number has to be re-derived, and the re-derivation disagrees with the
    // ledger on each of reconcile()'s three degrade branches.
    //
    // Construction, not declaration: the interface in `vendor-spend.ts` writes `kind: 'charge';`
    // with a semicolon, a literal writes it with a comma.
    const constructors = filesMatching(/kind: 'charge',/);
    expect(constructors).toStrictEqual([
      'packages/core/src/adapters/nansen/budget-gate.ts',
      'packages/core/src/adapters/nansen/reconcile.ts',
    ]);
  });

  it('only the adapter that coalesces constructs a coalesced receipt', () => {
    // Same rule, other arm. A `coalesced` receipt asserts "somebody else's vendor call served this
    // request", which only the module that performed the coalescing can know.
    expect(filesMatching(/kind: 'coalesced',/)).toStrictEqual([
      'packages/core/src/adapters/nansen/index.ts',
    ]);
  });
});
