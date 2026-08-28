import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  assertValidAdapterRegistrations,
  type AdapterRegistration,
  type AdapterTier,
  type AdapterTrust,
} from '../src/adapters/types.js';
import { adapterRegistrations } from '../src/providers.config.js';

/**
 * Task 012-2 — `tier` and `trust` are DECLARED on every adapter registration, and a registration
 * that declares neither cannot reach a running process (ADR-002 D8 + the D9 slice, R-150/R-153/
 * R-154, AC-15).
 *
 * Two independent guarantees are under test, because they fail differently:
 *
 * 1. **Compile-time** (TC-UNIT-01/02) — the fields are required, so a literal without one does not
 *    build. Written as `@ts-expect-error`, which is load-bearing in BOTH directions: if the field
 *    ever stops being required, the directive becomes unused and `tsc` fails with TS2578. A test
 *    asserting requiredness any other way could not notice the field going optional.
 * 2. **Run-time** (TC-UNIT-03/04) — the same guarantee for values that arrive through a cast, a
 *    `filter()`ed array or a future config file, where the compiler has nothing to say.
 *
 * Plus TC-UNIT-05, which pins the OD-5 assignment table BY NAME, and TC-UNIT-06, a structural gate
 * over the source tree against the one drift the type system cannot express.
 */

// ---------------------------------------------------------------------------------------------
// A minimal valid registration. Deliberately NOT one of the real twelve: TC-UNIT-03 needs an id
// that could not be confused with a real one when it shows up in an error message.
// ---------------------------------------------------------------------------------------------
const PROBE: AdapterRegistration = {
  id: 'probe-adapter',
  hosts: ['probe.invalid'],
  rateLimit: { capacity: 1, refillPerSec: 1 },
  requiresEnv: [],
  tier: 'free',
  trust: 'authoritative',
  // task 015-12 — PROBE is `tier: 'free'` and the startup gate now requires every such
  // registration to declare a ceiling; 100 is an arbitrary valid value, deliberately distinct
  // from the real `blockscout` figure (625) so a test that leaks the wrong number is visible.
  dailyCallCeiling: 100,
};

describe('TC-UNIT-01/02 — `tier` and `trust` are REQUIRED fields of AdapterRegistration', () => {
  it('a registration literal with no `tier` does not compile (TC-UNIT-01)', () => {
    // @ts-expect-error TC-UNIT-01: `tier` is required — omitting it must be a compile error. If
    // this directive ever reports "unused", the field has gone optional and the guarantee is gone.
    const missingTier: AdapterRegistration = {
      id: 'probe-missing-tier',
      hosts: [],
      rateLimit: { capacity: 1, refillPerSec: 1 },
      requiresEnv: [],
      trust: 'authoritative',
    };
    expect(missingTier.id).toBe('probe-missing-tier');
  });

  it('a registration literal with no `trust` does not compile (TC-UNIT-02)', () => {
    // @ts-expect-error TC-UNIT-02: `trust` is required — omitting it must be a compile error. This
    // is the `zechub` failure ADR-002 D9 names: an absent rank silently defaulting to a high one.
    const missingTrust: AdapterRegistration = {
      id: 'probe-missing-trust',
      hosts: [],
      rateLimit: { capacity: 1, refillPerSec: 1 },
      requiresEnv: [],
      tier: 'free',
    };
    expect(missingTrust.id).toBe('probe-missing-trust');
  });
});

describe('TC-UNIT-03/04 — assertValidAdapterRegistrations()', () => {
  /**
   * The offending entry sits in the MIDDLE of three, and all three ids are DISTINCT.
   *
   * Both properties are load-bearing, and the first version of this test had neither. It spread
   * `PROBE` without overriding `id`, so the broken entry and the leading entry shared the id
   * `probe-adapter` — which made `expect(message).toContain('probe-adapter')` satisfiable by a
   * validator that always names `registrations[0].id` and never looks at the failing entry at all.
   * A mutant doing exactly that passed the whole file 16/16.
   *
   * So the ids differ, and the negative assertions are the real content: the message must name the
   * offender and must NOT name either neighbour.
   */
  const LEADING: AdapterRegistration = { ...PROBE, id: 'probe-leading' };
  const TRAILING: AdapterRegistration = { ...PROBE, id: 'probe-trailing' };

  it('throws NAMING the offending id and the undeclared field when `trust` is cast away (TC-UNIT-03)', () => {
    // Deleted at RUNTIME rather than omitted from a literal: the compiler would reject the literal
    // (that is TC-UNIT-02's job), and the point here is the input the compiler never sees.
    // The id deliberately does NOT contain the substring `trust`, or the field-name assertion
    // below would be satisfied by the id alone.
    const broken: AdapterRegistration = { ...PROBE, id: 'probe-undeclared' };
    delete (broken as Partial<AdapterRegistration>).trust;

    let thrown: unknown;
    try {
      assertValidAdapterRegistrations([LEADING, broken, TRAILING]);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    // The assertion the task asks for by name: the SUBSTRING with the id, not the bare fact of a
    // throw. "Invalid adapter registration" sends the reader to a twelve-entry table to guess.
    expect(message).toContain('probe-undeclared');
    expect(message).toContain("'trust'");
    // ...and it named the OFFENDER, not just some entry. This pair is what kills the
    // "always report registrations[0]" and "always report the last one" mutants.
    expect(message).not.toContain('probe-leading');
    expect(message).not.toContain('probe-trailing');
  });

  it('throws naming the offending id when `tier` is cast away (TC-UNIT-03, sibling field)', () => {
    // Same shape, same reason — and again an id free of the substring `tier`.
    const broken: AdapterRegistration = { ...PROBE, id: 'probe-unpriced' };
    delete (broken as Partial<AdapterRegistration>).tier;

    let thrown: unknown;
    try {
      assertValidAdapterRegistrations([LEADING, broken, TRAILING]);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain('probe-unpriced');
    expect(message).toContain("'tier'");
    expect(message).not.toContain('probe-leading');
    expect(message).not.toContain('probe-trailing');
  });

  it('rejects a value outside the declared union, not just a missing key', () => {
    // `as unknown as` is required, not stylistic: a direct cast is refused because `'trustworthy'`
    // does not overlap `AdapterTrust` at all — the union is doing its job, and this case exists for
    // the input that reaches the validator having bypassed it.
    const broken = {
      ...PROBE,
      id: 'probe-out-of-union',
      trust: 'trustworthy',
    } as unknown as AdapterRegistration;
    expect(() => {
      assertValidAdapterRegistrations([LEADING, broken, TRAILING]);
    }).toThrow(/probe-out-of-union/);
  });

  it('does NOT throw on the real adapterRegistrations (TC-UNIT-04)', () => {
    expect(() => {
      assertValidAdapterRegistrations(adapterRegistrations);
    }).not.toThrow();
    // Sign of work: the call above must actually have had something to walk.
    expect(adapterRegistrations.length).toBe(12);
  });

  it('takes the array as a PARAMETER — an empty array is valid, a broken one is not', () => {
    // The design constraint stated in the validator's own docstring: it must not read the module it
    // validates, or no test could hand it anything but the one real complete input. This case is
    // only expressible because the array is a parameter.
    expect(() => {
      assertValidAdapterRegistrations([]);
    }).not.toThrow();
  });
});

describe('TC-UNIT-05 — the OD-5 assignment table, pinned BY NAME', () => {
  // Every id is listed explicitly, and the assertion below compares the WHOLE map. A count
  // ("exactly two `paid`") would pass on a permutation that swapped two adapters' values, and
  // after OD-5 gave `community` a second holder a count would additionally be WRONG. A twelfth
  // registration added without a line here fails this test rather than slipping through.
  const EXPECTED_TIER: Readonly<Record<string, AdapterTier>> = {
    coingecko: 'free',
    dexscreener: 'free',
    defillama: 'free',
    dune: 'paid',
    blockscout: 'free',
    'rpc-evm': 'free',
    'rpc-solana': 'free',
    'dash-platform': 'free',
    'platform-explorer': 'free',
    'pg-history': 'free',
    nansen: 'paid',
    'blockchain-info': 'free',
  };

  const EXPECTED_TRUST: Readonly<Record<string, AdapterTrust>> = {
    coingecko: 'authoritative',
    dexscreener: 'authoritative',
    defillama: 'authoritative',
    dune: 'authoritative',
    blockscout: 'community', // ADR-002 D9, verbatim
    'rpc-evm': 'authoritative',
    'rpc-solana': 'authoritative',
    'dash-platform': 'authoritative',
    'platform-explorer': 'authoritative', // owner decision OD-5, 2026-08-03 (OQ-T012-2)
    'pg-history': 'community', // owner decision OD-5, 2026-08-03 (OQ-T012-3) — placeholder, T-016
    nansen: 'authoritative',
    'blockchain-info': 'authoritative',
  };

  it('assigns `tier` id-by-id exactly as the table says', () => {
    const actual = Object.fromEntries(adapterRegistrations.map((r) => [r.id, r.tier]));
    expect(actual).toEqual(EXPECTED_TIER);
  });

  it('assigns `trust` id-by-id exactly as the table says', () => {
    const actual = Object.fromEntries(adapterRegistrations.map((r) => [r.id, r.trust]));
    expect(actual).toEqual(EXPECTED_TRUST);
  });

  it('assigns `derived` to NO registration — it is a per-ROW rank, not a per-adapter one', () => {
    // `derived` exists on the scale because `pg-history` rows carry `source='derived'`. Applying it
    // to the ADAPTER would claim every row it serves is computed by us, which is false.
    expect(adapterRegistrations.filter((r) => r.trust === 'derived').map((r) => r.id)).toEqual([]);
  });

  it('names the two `paid` and the two `community` adapters, not their counts', () => {
    expect(
      adapterRegistrations
        .filter((r) => r.tier === 'paid')
        .map((r) => r.id)
        .sort(),
    ).toEqual(['dune', 'nansen']);
    expect(
      adapterRegistrations
        .filter((r) => r.trust === 'community')
        .map((r) => r.id)
        .sort(),
    ).toEqual(['blockscout', 'pg-history']);
  });
});

// ---------------------------------------------------------------------------------------------
// TC-UNIT-06 — structural gate. See the `describe` block below for what it asserts and why the
// value-level phrasing it replaces was unfalsifiable.
// ---------------------------------------------------------------------------------------------

/**
 * Blanks out comments and string/template contents, preserving byte offsets and line structure, so
 * that the scan below reads CODE only.
 *
 * Written as one scanner rather than a chain of regexes on purpose: a `.replace(/\/\/.*$/)` pass
 * blanks the tail of any line holding a `'https://...'` literal, which would hide a real
 * derivation sitting on that line — a false NEGATIVE, the failure mode a gate cannot afford.
 */
function blankNonCode(source: string): string {
  const out = source.split('');
  const blank = (from: number, to: number): void => {
    for (let i = from; i < to; i += 1) {
      if (out[i] !== '\n') out[i] = ' ';
    }
  };
  let i = 0;
  while (i < source.length) {
    const two = source.slice(i, i + 2);
    if (two === '//') {
      const end = source.indexOf('\n', i);
      blank(i, end === -1 ? source.length : end);
      i = end === -1 ? source.length : end;
    } else if (two === '/*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      blank(i, stop);
      i = stop;
    } else if (source[i] === "'" || source[i] === '"' || source[i] === '`') {
      const quote = source[i];
      // A quote opens a string only if it CLOSES on the same line (backticks may span lines).
      // **Ported from `policy.test.ts` by adversarial cycle 2, F-9** — the rule existed in ONE of
      // the three copies of this scanner, and the other two declared limits that did not mention
      // its absence. It is load-bearing: a regex such as `/case\s*(?:'|")/` — which
      // `tier-single-source.test.ts` really contains — otherwise opens a "string" that swallows the
      // rest of the file, blanking real code (false NEGATIVES, the failure a gate cannot afford)
      // and turning real comments into string content.
      const lineEnd = source.indexOf('\n', i + 1);
      const sameLine = quote === '`' ? source.length : lineEnd === -1 ? source.length : lineEnd;
      let j = i + 1;
      let closed = false;
      while (j < sameLine) {
        if (source[j] === '\\') {
          j += 2;
          continue;
        }
        if (source[j] === quote) {
          closed = true;
          break;
        }
        j += 1;
      }
      if (!closed) {
        // Not a string opener — a lone quote inside a regex, or an apostrophe in code. Step past it
        // rather than consuming the file.
        i += 1;
        continue;
      }
      // Keep the quotes, blank the contents — `from '...'` stays recognisable as an import.
      blank(i + 1, Math.min(j, source.length));
      i = Math.min(j + 1, source.length);
    } else {
      i += 1;
    }
  }
  return out.join('');
}

/** Escapes a binding for embedding in a `RegExp` — namespace bindings carry a literal `.`. */
const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Local binding names a file can call `costOf` through, in all three import forms.
 *
 * - **named** — `import { costOf }` / `import { costOf as price }`, read from the BLANKED code;
 * - **default** — `import costOf from './cost-of.js'` (the local name is arbitrary);
 * - **namespace** — `import * as prices from './cost-of.js'`, called as `prices.costOf(…)`.
 *
 * The last two carry no `costOf` NAME, so the MODULE has to identify them — and a module specifier
 * is string CONTENT, which `blankNonCode` erases. They are therefore matched on the raw source with
 * an `^import` anchor, the same anchoring this file's sibling scans use to keep prose out.
 * (Both forms were measured ESCAPING this gate in 012-3's review; see the limits table below.)
 */
function costOfBindings(code: string, source: string): string[] {
  const bindings: string[] = [];
  for (const match of code.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*['"`]/g)) {
    for (const specifier of (match[1] ?? '').split(',')) {
      const parts = specifier.trim().split(/\s+as\s+/);
      if (parts[0] === 'costOf') bindings.push((parts[1] ?? parts[0]).trim());
    }
  }
  for (const match of source.matchAll(
    /^[ \t]*import\s+(?:([A-Za-z_$][A-Za-z0-9_$]*)|\*\s+as\s+([A-Za-z_$][A-Za-z0-9_$]*))\s+from\s*['"]([^'"]*cost-of[^'"]*)['"]/gm,
  )) {
    if (match[1]) bindings.push(match[1]);
    if (match[2]) bindings.push(`${match[2]}.costOf`);
  }
  return bindings;
}

/** The statement `index` sits in — bounded by `;`, `{` or `}`, which is where a decision ends. */
function enclosingStatement(code: string, index: number): string {
  let start = index;
  while (start > 0 && !';{}'.includes(code[start - 1] ?? '')) start -= 1;
  let end = index;
  while (end < code.length && !';{}'.includes(code[end] ?? '')) end += 1;
  return code.slice(start, end);
}

/** `tier` / `kind` / `paid` as identifiers or camelCase parts — the paidness-decision vocabulary. */
const PAIDNESS = /(?:^|[^A-Za-z0-9_$])(tier|kind|paid)|[a-z0-9_$](Tier|Kind|Paid)/;

/**
 * Statements in `source` that both CALL an imported `costOf` (directly, or through a binding this
 * file assigned a `costOf` result to) and mention the paidness vocabulary — i.e. exactly the shape
 * of "derive whether this provider is paid from what it charges".
 *
 * **Recall is bounded, and the bound is declared** (added in task 012-3's review, which measured
 * three forms escaping the original — a gate whose limit is unstated reads as a proof).
 *
 * **Reached** (each has a positive control below):
 *
 * | Form                                                        | Note |
 * | ------------------------------------------------------------- | ---- |
 * | `import { costOf }` … `costOf(…)` in a paidness statement    | the original |
 * | `import { costOf as price }` … `price(…)`                     | alias |
 * | `const c = costOf(…)` then `c` used in a paidness statement    | two-step, same file |
 * | `import costOf from './cost-of.js'`                            | default import (012-3) |
 * | `import * as prices from './cost-of.js'` … `prices.costOf(…)` | namespace import (012-3) |
 *
 * **NOT reached — measured, not hypothesised:**
 *
 * | Escape                                                                 | Why |
 * | ------------------------------------------------------------------------ | --- |
 * | Derivation split across a FUNCTION boundary — `const c = costOf(…)` at module scope, `function isPaid() { return c > 0; }` below | Both the call site and the intermediate binding are audited by ENCLOSING STATEMENT; a use whose statement holds no paidness word is invisible. Following the value would need dataflow. |
 * | `costOf` reached through a re-export or an object property (`deps.costOf(…)` injected as a parameter) | No import statement names it in this file, so no binding is discovered. |
 * | Paidness vocabulary outside `tier`/`kind`/`paid`                        | Fixed vocabulary; widening it trades false positives on unrelated pricing code. |
 * | A price compared in another module entirely                             | Single-file scan by construction. |
 * | A quote that opens no string — a lone `'` in a regex, an apostrophe in code | `blankNonCode` treats a quote as an opener only when it CLOSES on the same line (backticks excepted). Ported from `policy.test.ts` by adversarial cycle 2, F-9: **before the port this row read as nothing at all**, and one such quote blanked the rest of the file, hiding every later `costOf(` call from the scan — a false NEGATIVE. The rule bounds the damage to the single quote; a string genuinely continued across lines with `\\` is still mis-lexed. |
 */
function paidnessDerivedFromCostOf(source: string): string[] {
  const code = blankNonCode(source);
  const bindings = costOfBindings(code, source);
  if (bindings.length === 0) return [];

  const offenders: string[] = [];
  const callSites: number[] = [];
  const indirect: string[] = [];

  for (const binding of bindings) {
    // Escaped: a namespace binding is `prices.costOf`, and an unescaped `.` would match any char.
    const callRe = new RegExp(`(?:^|[^A-Za-z0-9_$.])${escapeRegExp(binding)}\\s*\\(`, 'g');
    for (const match of code.matchAll(callRe)) {
      callSites.push(match.index);
      // Two-step form: `const price = costOf(...)` — remember `price` and audit it as well, or the
      // gate would be defeated by an intermediate variable.
      const statement = enclosingStatement(code, match.index);
      const assigned = /(?:const|let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*=/.exec(statement);
      if (assigned?.[1]) indirect.push(assigned[1]);
    }
  }

  for (const index of callSites) {
    const statement = enclosingStatement(code, index);
    if (PAIDNESS.test(statement)) offenders.push(statement.trim());
  }
  for (const name of indirect) {
    const useRe = new RegExp(`(?:^|[^A-Za-z0-9_$.])${name}(?![A-Za-z0-9_$])`, 'g');
    for (const match of code.matchAll(useRe)) {
      const statement = enclosingStatement(code, match.index);
      if (PAIDNESS.test(statement)) offenders.push(statement.trim());
    }
  }
  return [...new Set(offenders)];
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

function walkTs(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walkTs(full));
    else if (full.endsWith('.ts')) out.push(full);
  }
  return out;
}

function everyPackageSrcFile(): string[] {
  const packagesDir = path.join(repoRoot, 'packages');
  const out: string[] = [];
  for (const pkg of readdirSync(packagesDir)) {
    const srcDir = path.join(packagesDir, pkg, 'src');
    if (existsSync(srcDir)) out.push(...walkTs(srcDir));
  }
  return out;
}

describe('TC-UNIT-06 — no source file derives paidness from costOf() (R-150(c))', () => {
  /**
   * **Why this is structural and not a value assertion.** The obvious phrasing — "`tier` is not
   * derived from `costOf()`" — is untestable at the value level: `tier` is a required literal on
   * every registration and there is no code path from `costOf()` to it, so an assertion about the
   * values passes under EVERY possible implementation, including the wrong one. What can actually
   * regress is the source: someone writes `tier: costOf(...) > 0 ? 'paid' : 'free'` next year, and
   * every value-level test still passes because the resulting values happen to agree today. The
   * disagreement only appears when `blockchain-info` is switched off (its `costOf()` returns
   * `Infinity`) or when a nansen plan changes a price — i.e. in production, not in the suite.
   */
  it('no file under any package `src` both imports costOf and decides paidness from it', () => {
    const files = everyPackageSrcFile();
    // Sign of work FIRST: a walk that found nothing would report "no offenders" identically.
    expect(files.length).toBeGreaterThan(50);
    expect(files.some((f) => f.endsWith(path.join('nansen', 'budget-gate.ts')))).toBe(true);

    const offenders: string[] = [];
    for (const file of files) {
      for (const statement of paidnessDerivedFromCostOf(readFileSync(file, 'utf8'))) {
        offenders.push(`${path.relative(repoRoot, file)}: ${statement.replace(/\s+/g, ' ')}`);
      }
    }
    // Named, not counted — the failure this guards against is a gate that passes while seeing
    // nothing, and a bare count would repeat that mistake.
    expect(offenders).toEqual([]);
  });

  it('the gate DETECTS a derivation (it would be worthless if it could not)', () => {
    const direct = `
      import { costOf } from './cost-of.js';
      export function classify(cap: string): string {
        const tier = costOf(cap, {}).credits > 0 ? 'paid' : 'free';
        return tier;
      }
    `;
    expect(paidnessDerivedFromCostOf(direct)).not.toEqual([]);
  });

  it('the gate detects the ALIASED and the two-step forms too', () => {
    const aliased = `
      import { costOf as price } from './cost-of.js';
      const kind = price('x', {}).credits === 0 ? 'free' : 'paid';
    `;
    expect(paidnessDerivedFromCostOf(aliased)).not.toEqual([]);

    const twoStep = `
      import { costOf } from './cost-of.js';
      const charged = costOf('x', {}).credits;
      const isPaid = charged > 0;
    `;
    expect(paidnessDerivedFromCostOf(twoStep)).not.toEqual([]);
  });

  it('the gate detects the DEFAULT and NAMESPACE import forms (added 012-3)', () => {
    // Both were measured escaping the original gate: neither import statement contains the name
    // `costOf`, so no binding was discovered and the file was scanned as if it never priced
    // anything. One positive control per newly-reached row of the limits table.
    const defaultImport = `
      import costOf from './cost-of.js';
      const tier = costOf('x', {}).credits > 0 ? 'paid' : 'free';
    `;
    expect(paidnessDerivedFromCostOf(defaultImport), 'default import').not.toEqual([]);

    const namespaceImport = `
      import * as prices from './cost-of.js';
      const kind = prices.costOf('x', {}).credits > 0 ? 'paid' : 'free';
    `;
    expect(paidnessDerivedFromCostOf(namespaceImport), 'namespace import').not.toEqual([]);

    // ...and the module still has to be the pricing one: a default import of anything else is not
    // a costOf binding, or every `import x from 'y'` in the tree would become a call site.
    const unrelatedDefault = `
      import logger from './logger.js';
      const tier = logger('x').credits > 0 ? 'paid' : 'free';
    `;
    expect(paidnessDerivedFromCostOf(unrelatedDefault), 'unrelated default').toEqual([]);
  });

  it('the DECLARED LIMITS are real: these forms are NOT reached, and that is written down', () => {
    // Executable form of the "NOT reached" table in `paidnessDerivedFromCostOf`'s docstring. It
    // keeps the table from drifting away from the code: a future widening that closed one of these
    // fails HERE and forces the row to be moved into "Reached" with a control of its own.
    const acrossFunctionBoundary = `
      import { costOf } from './cost-of.js';
      const charged = costOf('x', {}).credits;
      function isPaidProvider() {
        return charged > 0;
      }
    `;
    expect(
      paidnessDerivedFromCostOf(acrossFunctionBoundary),
      'LIMIT: derivation split across a function boundary (no paidness word in the using statement)',
    ).toEqual([]);

    // Cycle 2, F-9 — the LEXER limit, and the control that shows why the rule is load-bearing. The
    // regex on line 2 contains a quote that opens nothing; without the same-line rule it swallows
    // the rest of the file and the real derivation on line 3 becomes invisible.
    const loneQuoteThenOffender =
      "import { costOf } from './cost-of.js';\nconst RE = /case\\s*(?:'|\")/;\n" +
      "const tier = costOf('x', {}).credits > 0 ? 'paid' : 'free';";
    expect(
      paidnessDerivedFromCostOf(loneQuoteThenOffender),
      'LIMIT/CONTROL: a quote that opens no string must not blank the rest of the file',
    ).not.toEqual([]);

    const injectedDependency = `
      const tier = deps.costOf('x', {}).credits > 0 ? 'paid' : 'free';
    `;
    expect(
      paidnessDerivedFromCostOf(injectedDependency),
      'LIMIT: costOf reached through an injected object rather than an import',
    ).toEqual([]);
  });

  it('the gate does NOT flag a file that merely PRICES with costOf', () => {
    // Without this control the gate would be indistinguishable from "no file may import costOf",
    // which is not the rule — pricing is exactly what costOf is for, and the two real importers
    // (`nansen/budget-gate.ts`, `nansen/index.ts`) do only that.
    const pricingOnly = `
      import { costOf } from './cost-of.js';
      const cost = costOf(cap, args);
      if (!Number.isFinite(cost)) throw new Error('unpriced capability');
      await budgetStore.checkAndReserve(provider, cost);
    `;
    expect(paidnessDerivedFromCostOf(pricingOnly)).toEqual([]);
  });

  it('the gate ignores comments and string contents (no false positive, no blind line)', () => {
    const commentedOnly = `
      import { costOf } from './cost-of.js';
      // const tier = costOf(cap, args) > 0 ? 'paid' : 'free';  <- prose about the rule, not code
      const cost = costOf(cap, args);
    `;
    expect(paidnessDerivedFromCostOf(commentedOnly)).toEqual([]);

    // A URL on the same line must not blank the code that follows it on the NEXT line.
    const urlThenDerivation = `
      import { costOf } from './cost-of.js';
      const host = 'https://api.example.com/v1';
      const tier = costOf(cap, args) > 0 ? 'paid' : 'free';
    `;
    expect(paidnessDerivedFromCostOf(urlThenDerivation)).not.toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// Task 015-12 — `dailyCallCeiling`: declared form on `AdapterRegistration`, ten `tier: 'free'`
// registrations carrying a value and a reason, and the startup gate that makes an undeclared or
// out-of-range value a process-start failure rather than a silent unlimited grant (ADR-003 D6,
// R-9/R-11, AC-33).
//
// **Naming note.** The task file numbers its eight test cases TC-UNIT-01..08 — the SAME id space
// this file already occupies, for the unrelated task 012-2/012-3 `describe` blocks above (which
// run from TC-UNIT-01 through TC-UNIT-06). Reusing those ids here would collide rather than
// extend them, so the cases below are named TC-DCC-01..08 (dailyCallCeiling), one-to-one with the
// task's own numbering — each `it` names its counterpart in a comment.
// ---------------------------------------------------------------------------------------------
describe('TC-DCC — task 015-12: `dailyCallCeiling` declared form + startup gate', () => {
  const FREE_IDS = [
    'blockscout',
    'coingecko',
    'dexscreener',
    'defillama',
    'rpc-evm',
    'rpc-solana',
    'dash-platform',
    'platform-explorer',
    'pg-history',
    'blockchain-info',
  ];

  it('TC-DCC-01 (task TC-UNIT-01): ten free registrations carry dailyCallCeiling, two paid do not', () => {
    const free = adapterRegistrations.filter((r) => r.tier === 'free');
    const paid = adapterRegistrations.filter((r) => r.tier === 'paid');

    expect(free.map((r) => r.id).sort()).toEqual([...FREE_IDS].sort());
    for (const r of free) {
      expect(r.dailyCallCeiling, `${r.id} (tier:'free') must declare dailyCallCeiling`).not.toBe(
        undefined,
      );
    }

    expect(paid.map((r) => r.id).sort()).toEqual(['dune', 'nansen']);
    for (const r of paid) {
      expect(r.dailyCallCeiling, `${r.id} (tier:'paid') must NOT declare dailyCallCeiling`).toBe(
        undefined,
      );
    }
  });

  it('TC-DCC-02 (task TC-UNIT-02): values pinned BY NAME, not by count', () => {
    // Same discipline as the OD-5 assignment table above (TC-UNIT-05): every id listed
    // explicitly, so a permutation or a silently-dropped entry fails here rather than passing on
    // a coincidental count.
    const EXPECTED_DAILY_CALL_CEILING: Readonly<Record<string, number | 'none'>> = {
      blockscout: 625,
      coingecko: 'none',
      dexscreener: 'none',
      defillama: 'none',
      'rpc-evm': 'none',
      'rpc-solana': 'none',
      'dash-platform': 'none',
      'platform-explorer': 'none',
      'pg-history': 'none',
      'blockchain-info': 'none',
    };
    const actual = Object.fromEntries(
      adapterRegistrations.filter((r) => r.tier === 'free').map((r) => [r.id, r.dailyCallCeiling]),
    );
    expect(actual).toEqual(EXPECTED_DAILY_CALL_CEILING);
  });

  it("TC-DCC-03 (task TC-UNIT-03): a tier:'free' registration with no dailyCallCeiling fails startup, naming the provider", () => {
    const broken: AdapterRegistration = { ...PROBE, id: 'probe-no-ceiling', tier: 'free' };
    // PROBE itself now carries a valid `dailyCallCeiling` (needed to keep it a minimal VALID
    // registration for every other test in this file) — deleted here at runtime, the same move
    // TC-UNIT-03 above makes for `trust`, so this case actually exercises the ABSENT-field path.
    delete (broken as Partial<AdapterRegistration>).dailyCallCeiling;
    let thrown: unknown;
    try {
      assertValidAdapterRegistrations([broken]);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    expect(message).toContain('probe-no-ceiling');
    expect(message).toContain('dailyCallCeiling');
  });

  it('TC-DCC-04 (task TC-UNIT-04): zero, negative and fractional ceilings are all rejected, naming provider and value', () => {
    const cases: Array<{ id: string; value: number }> = [
      { id: 'probe-zero-ceiling', value: 0 },
      { id: 'probe-negative-ceiling', value: -1 },
      { id: 'probe-fractional-ceiling', value: 1.5 },
    ];
    for (const { id, value } of cases) {
      const broken: AdapterRegistration = { ...PROBE, id, tier: 'free', dailyCallCeiling: value };
      let thrown: unknown;
      try {
        assertValidAdapterRegistrations([broken]);
      } catch (error) {
        thrown = error;
      }
      expect(thrown, `${id} (dailyCallCeiling=${value}) must throw`).toBeInstanceOf(Error);
      const message = (thrown as Error).message;
      expect(message, `${id}: must name the provider`).toContain(id);
      expect(message, `${id}: must name the presented value`).toContain(String(value));
    }
  });

  it("TC-DCC-05 (task TC-UNIT-05): the literal 'none' is NOT rejected by the range check", () => {
    const ok: AdapterRegistration = {
      ...PROBE,
      id: 'probe-none-ceiling',
      tier: 'free',
      dailyCallCeiling: 'none',
    };
    expect(() => assertValidAdapterRegistrations([ok])).not.toThrow();
  });

  it('TC-DCC-06 (task TC-UNIT-06): the real adapterRegistrations passes the startup gate', () => {
    // Same contract the pre-existing "does NOT throw on the real adapterRegistrations" test above
    // already exercises (TC-UNIT-03/04 describe block) — restated here because the task lists it
    // as its own acceptance case for this field specifically.
    expect(() => assertValidAdapterRegistrations(adapterRegistrations)).not.toThrow();
  });

  it('TC-DCC-07 (task TC-UNIT-07, updated by task 015-13): dailyCallCeiling is read only in its declaration, its ten literals and its first reader', () => {
    const IDENTIFIER = /\bdailyCallCeiling\b/g;
    const files = everyPackageSrcFile();
    expect(files.length).toBeGreaterThan(50); // sign of work — the walk found something

    const matchesByFile = new Map<string, number>();
    for (const file of files) {
      const count = (readFileSync(file, 'utf8').match(IDENTIFIER) ?? []).length;
      if (count > 0) matchesByFile.set(path.relative(repoRoot, file), count);
    }

    const typesFile = path.join('packages', 'core', 'src', 'adapters', 'types.ts');
    const configFile = path.join('packages', 'core', 'src', 'providers.config.ts');
    // Task 015-13's own `call-gate.ts` — the first READER of `dailyCallCeiling` (its docstring
    // names the field it looks up in `adapterRegistrations`), landing as the THIRD file exactly as
    // this test's previous-pass comment predicted. Updated here rather than left to bit-rot,
    // because 015-13 is the pairing task that comment named (task file's own "тест первого
    // прохода" note, `docs/tasks/task-015-13-call-gate-contract-stub.md` "Регрессионные тесты").
    const callGateFile = path.join(
      'packages',
      'core',
      'src',
      'adapters',
      'blockscout',
      'call-gate.ts',
    );

    // The FILE SET is the load-bearing assertion: exactly these three, no more and no fewer —
    // task 015-14 (the counter's own read-and-increment) and task 015-15 (the wiring call site)
    // are each expected to add readers of their own, updating this set again when they do.
    expect([...matchesByFile.keys()].sort()).toEqual([callGateFile, configFile, typesFile].sort());

    // `providers.config.ts` carries exactly ten literal `dailyCallCeiling:` assignments — one per
    // `tier: 'free'` registration — and nothing else in that file spells the identifier out.
    expect(matchesByFile.get(configFile)).toBe(10);
  });

  it('TC-DCC-08 (task TC-UNIT-08): blockscout refillPerSec and its "not measured" mark are untouched', () => {
    const source = readFileSync(
      path.join(repoRoot, 'packages', 'core', 'src', 'providers.config.ts'),
      'utf8',
    );
    expect(source).toContain('refillPerSec: 2');
    expect(source).toContain('NOT a measured ceiling');
  });
});
