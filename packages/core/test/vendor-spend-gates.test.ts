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

/**
 * Task 015-14 (ADR-003 D6, R-9/R-11) — ONE narrow, named exemption from TC-GATE-01, and why it
 * cannot mask the defect that gate exists to catch.
 *
 * `blockscout/call-gate.ts`'s `ensureCallBudget` calls `checkAndReserve` with a LITERAL `cost: 0`
 * baked into its own body — not a caller-supplied value that could drift, and not "a new paid
 * adapter" in the sense the comment below already warned about (`blockscout` has no credit
 * dimension at all, ADR-003 D6). This call can therefore never move `usage.credits_used`, the
 * exact quantity R-27.3 reconciles `request_trace` against — the defect TC-GATE-01 guards against
 * ("a paid adapter spends credits and nothing reports it") cannot occur through this file, by
 * construction. A second call site, or `cost` stopping being a literal, puts the file back under
 * the rule this exemption narrows.
 *
 * **What this exemption does NOT close, stated so it is not mistaken for closed.** This call DOES
 * move `usage.calls_made` — task 015-14's OWN daily counter — on every admitted call, and NOTHING
 * reports that write today. `VendorChargeRecord.calls` (`cache/vendor-spend.ts`) documents its own
 * contribution as `usage_window.calls_made` specifically and carries no field for the DAILY
 * counter; `onVendorSpend` is threaded per-REQUEST from `mcp-server/src/tools/registry.ts` down
 * through an adapter's `fetch()`, a channel `ensureCallBudget`'s documented signature
 * (`system-architecture.md` §3.5.4: `ensureCallBudget(now: () => number): Promise<void>`) does not
 * reach, and adding a second parameter to reach it would touch TC-GATE-02's strict two-file
 * allowlist below (`kind: 'charge'`) as well. No task in the 015-12..015-19 sequence currently
 * wires this. Filed as a known issue rather than resolved here — narrowing this gate is a
 * documented decision, not the same as closing the gap it narrows around.
 *
 * **The exemption is keyed on the PROPERTY, not on the file name — measured 2026-08-28.** The
 * first edition of this exemption was a bare name set, and a name set exempts the file forever
 * rather than the argument that earned it. Proven by mutation: appending a SECOND
 * `checkAndReserve` call to `call-gate.ts` spending 500 credits, with `onVendorSpend` nowhere in
 * the file, left this gate green at 1699/1699. That is the L-10 class — a new legal negative
 * answer widening what the gate accepts — so the name below only NOMINATES a file, and
 * `everyReserveIsFreeOfCredits` decides whether it still qualifies on every run.
 */
const CREDIT_EXEMPT_WRITERS = new Set(['packages/core/src/adapters/blockscout/call-gate.ts']);

/**
 * Split the argument list that starts at `from` (just past a `(`), at TOP-LEVEL commas only.
 * Returns `null` when the list does not close — an unparsable call must not read as a compliant
 * one.
 */
function topLevelArgs(source: string, from: number): string[] | null {
  const args: string[] = [];
  let depth = 0;
  let start = from;
  let quote: string | null = null;
  for (let i = from; i < source.length; i += 1) {
    const ch = source[i];
    if (quote !== null) {
      if (ch === '\\') i += 1;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
    } else if (ch === '(' || ch === '[' || ch === '{') {
      depth += 1;
    } else if (ch === ')' && depth === 0) {
      args.push(source.slice(start, i));
      return args;
    } else if (ch === ')' || ch === ']' || ch === '}') {
      depth -= 1;
    } else if (ch === ',' && depth === 0) {
      args.push(source.slice(start, i));
      start = i + 1;
    }
  }
  return null;
}

/**
 * The property that earns the exemption: this file moves the credit dimension NOWHERE. Every
 * `checkAndReserve` call in it passes a literal `0` in the cost position (third argument), and it
 * calls `recordDelta` not at all. A file with no such call does not qualify either — an exemption
 * that holds vacuously would survive the call sites it was written for being deleted.
 */
function everyReserveIsFreeOfCredits(body: string): boolean {
  const source = codeLines(body).join('\n');
  if (/\.recordDelta\(/.test(source)) return false;
  const calls = [...source.matchAll(/\.checkAndReserve\s*\(/g)];
  if (calls.length === 0) return false;
  for (const call of calls) {
    const args = topLevelArgs(source, (call.index ?? 0) + call[0].length);
    if (args === null || args.length < 3) return false;
    if (args[2]?.trim() !== '0') return false;
  }
  return true;
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

    const silent = writers.filter((file) => {
      const body = readFileSync(path.join(repoRoot, file), 'utf8');
      // CODE lines, symmetric with how `writers` was collected above. Measured 2026-08-28: the
      // raw-text form this replaces let a comment satisfy the gate, and one file in the tree
      // (`blockscout/call-gate.ts`) passed on exactly that — a docstring naming `onVendorSpend`
      // while its code reports nothing. A thirteenth paid adapter could have done the same, which
      // is the one defect this gate exists to catch.
      if (codeLines(body).join('\n').includes('onVendorSpend')) return false;
      // Nominated AND still qualifying. Either half alone is not enough: the name without the
      // property exempts a file that later starts spending, the property without the name exempts
      // every future zero-cost caller without anyone deciding to.
      return !(CREDIT_EXEMPT_WRITERS.has(file) && everyReserveIsFreeOfCredits(body));
    });
    expect(
      silent,
      'these files move a vendor spend ledger and never mention the reporter. A committed write ' +
        'that nothing reports is spend that no request can be charged for, and the daily ' +
        'reconciliation of request_trace against usage (R-27.3) drifts by exactly that amount.',
    ).toStrictEqual([]);
  });

  it('the exemption withdraws itself the moment the exempted file spends a credit', () => {
    // The guard on the guard. `CREDIT_EXEMPT_WRITERS` names one file; this case pins the ONLY
    // property that lets the name have any effect, on synthetic sources, so it is covered without
    // mutating a real one. Every negative case below is a shape that a bare name set would have
    // passed — the shape measured green at 1699/1699 before this predicate existed.
    const free = `await deps.budgetStore.checkAndReserve(deps.provider, day, 0, Infinity, undefined, { ceiling });`;
    expect(everyReserveIsFreeOfCredits(free), 'a lone literal-zero cost qualifies').toBe(true);

    expect(
      everyReserveIsFreeOfCredits(`${free}\nawait store.checkAndReserve('p', d, 500, 1000);`),
      'a second call site spending 500 credits must withdraw the exemption',
    ).toBe(false);

    expect(
      everyReserveIsFreeOfCredits(`${free}\nawait store.checkAndReserve('p', d, cost, 1000);`),
      'a cost that stopped being a literal must withdraw the exemption',
    ).toBe(false);

    expect(
      everyReserveIsFreeOfCredits(`${free}\nawait store.recordDelta('p', d, 7);`),
      'recordDelta moves the same ledger and is not exempted by a zero-cost reservation',
    ).toBe(false);

    expect(
      everyReserveIsFreeOfCredits('const nothing = 1;'),
      'a file with no reservation at all must not qualify vacuously',
    ).toBe(false);

    expect(
      everyReserveIsFreeOfCredits('await store.checkAndReserve(p, d, 0, Infinity'),
      'an argument list that never closes must not read as compliant',
    ).toBe(false);

    // Commas inside a nested argument must not be mistaken for the top-level separators that
    // decide which argument is the cost.
    expect(
      everyReserveIsFreeOfCredits(
        `await store.checkAndReserve(idOf(a, b), bucket(x, y), 0, Infinity, undefined, { ceiling: 1 });`,
      ),
      'nested commas must not shift the cost position',
    ).toBe(true);
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
