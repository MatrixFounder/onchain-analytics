import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { SqliteBudgetStore } from '../src/cache/budget-store.js';
import { CACHE_DDL } from '../src/cache/ddl.js';
import { SqliteCacheStore } from '../src/cache/sqlite-store.js';
import type { AdapterRegistration, AdapterTier } from '../src/adapters/types.js';
import { adapterRegistrations } from '../src/providers.config.js';

/**
 * Task 012-3 — `AdapterRegistration.tier` is the ONE classification of paidness, and `trust` has no
 * consumer at all (R-151(e), R-155(d), AC-14/AC-16).
 *
 * 012-2 declared both fields. Declaring them changes nothing on its own: the four competing
 * classifications it was meant to replace were still in the tree, so the codebase had five. This
 * file holds the two structural gates that keep the count at one after 012-3 removes the others —
 * plus, below them, the unit cases proving that BOTH `bootstrapProviders` writers read that one
 * field rather than a list of their own.
 *
 * **Why structural and not value-level.** A value assertion ("nansen is paid") passes under every
 * implementation that happens to agree with the registration table today, including one that owns a
 * private id list. What can actually regress is the SOURCE: a second list appears next year and the
 * two agree until a thirteenth adapter, or a plan change, makes them disagree — in production, not
 * in the suite. So the gates read code, and the unit cases below feed the writers a registration
 * table that DISAGREES with any hardcoded list, which is what makes them able to tell the two
 * implementations apart.
 */

// ---------------------------------------------------------------------------------------------
// Source scanning
//
// `blankNonCode` is deliberately a LOCAL copy of the scanner in `adapter-registrations.test.ts`
// (task 012-2) rather than a shared helper both files import. That file belongs to an
// already-delivered task (PLAN §0.4 file-ownership table), and a shared helper would mean an edit
// made for THIS gate silently changes the verdict of THAT one. The copy is ~30 lines and has no
// dependencies; the coupling would cost more than it saves.
// ---------------------------------------------------------------------------------------------

/**
 * Blanks out comments and string/template CONTENTS (keeping the quotes, and preserving byte offsets
 * and line structure) so the scans below read CODE only.
 *
 * Keeping the quotes is load-bearing here: every detector below asks "is this compared against /
 * collected as a string LITERAL", and that question survives the contents being blanked — which is
 * exactly the point, because the gate must not depend on WHICH provider id is written there. The
 * first draft of R-151(e)'s gate banned the literal `'nansen'` outside an allow-list; it would have
 * fired on five correct occurrences (three route `adapterIds`, the registration's own `id`, and the
 * adapter-map key in `mcp-server/src/index.ts`), none of which classify anything.
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
      blank(i + 1, Math.min(j, source.length));
      i = Math.min(j + 1, source.length);
    } else {
      i += 1;
    }
  }
  return out.join('');
}

/** The statement `index` sits in — bounded by `;`, `{` or `}`, which is where a decision ends. */
function enclosingStatement(code: string, index: number): { text: string; start: number } {
  let start = index;
  while (start > 0 && !';{}'.includes(code[start - 1] ?? '')) start -= 1;
  let end = index;
  while (end < code.length && !';{}'.includes(code[end] ?? '')) end += 1;
  return { text: code.slice(start, end), start };
}

/** `PAID_PROVIDER_IDS` → `['paid','provider','ids']`; `providerId` → `['provider','id']`. */
function words(text: string): Set<string> {
  const out = new Set<string>();
  for (const identifier of text.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? []) {
    for (const part of identifier.split(/[_$]+|(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])/)) {
      if (part) out.add(part.toLowerCase());
    }
  }
  return out;
}

/** The vocabulary of a paidness DECISION — the value being decided. */
const PAIDNESS_WORDS = ['paid', 'tier', 'kind'];
/** The vocabulary of a provider IDENTITY — the key the decision would be made on. */
const ID_WORDS = ['id', 'ids', 'provider', 'providers', 'adapter', 'adapters'];

const hasAny = (bag: Set<string>, vocabulary: string[]): boolean =>
  vocabulary.some((word) => bag.has(word));

/** An array literal whose elements are ALL string literals — `['dune', 'nansen']` after blanking. */
const LITERAL_COLLECTION = /\[\s*(?:'[^']*'|"[^"]*")(?:\s*,\s*(?:'[^']*'|"[^"]*"))*\s*,?\s*\]/g;
/**
 * `SET.has(x)` / `ARRAY.includes(x)` / `ARRAY.indexOf(x)` — membership of `x` in a named collection.
 *
 * `indexOf`/`findIndex`/`lastIndexOf` were added in review round 1. The review's own probe listed
 * `PAID_IDS.indexOf(providerId) >= 0` as already covered; measuring it here said otherwise, because
 * the original alternation was `has|includes` only. Both the finding and the correction are the
 * same lesson: a form is covered when a control says so, not when a reader believes so.
 */
const MEMBERSHIP =
  /\.(has|includes|indexOf|lastIndexOf|findIndex)\(\s*([A-Za-z_$][A-Za-z0-9_$.]*)\s*\)/g;
/** `x === 'literal'` / `x !== 'literal'` — equality against a fixed string. */
const LITERAL_EQUALITY = /([A-Za-z_$][A-Za-z0-9_$.]*)\s*[!=]==\s*(?:'|")/g;
/** `switch (providerId) {` — the branch form of the same decision. */
const SWITCH_ON = /\bswitch\s*\(\s*([A-Za-z_$][A-Za-z0-9_$.]*)\s*\)\s*\{/g;
/** `TABLE[providerId]` — the lookup-table form; the table itself may be built any way at all. */
const INDEX_LOOKUP = /\[\s*([A-Za-z_$][A-Za-z0-9_$.]*)\s*\]/g;
/**
 * A collection method taking a CALLBACK rather than the value —
 * `['dune','nansen'].find((x) => x === id)`. Matched only immediately after a literal collection,
 * which is what keeps it off every other `.find()`/`.some()` in the tree.
 */
const COLLECTION_CALLBACK = /^\s*\.\s*(?:find|findIndex|some|filter|indexOf|includes|every)\s*\(/;

/**
 * Is this operand a provider IDENTITY rather than the rank itself?
 *
 * Only the last dotted segment is looked at, and it is split the same way any other identifier is:
 * `registration.id` → `id` ✓, `providerId` → `provider`/`id` ✓, `r.tier` → `tier` ✗. That last case
 * is the whole reason the operand is inspected at all — `r.tier === 'paid'` is the single-source
 * READ this task installs, and a detector blind to which side it is looking at would forbid it.
 */
const isIdOperand = (operand: string): boolean =>
  hasAny(words(operand.split('.').pop() ?? operand), ID_WORDS);

/** The `{…}` block opening at `braceIndex`, brace-matched — a `switch` body is not a statement. */
function enclosingBlock(code: string, braceIndex: number): string {
  let depth = 0;
  for (let i = braceIndex; i < code.length; i += 1) {
    if (code[i] === '{') depth += 1;
    else if (code[i] === '}') {
      depth -= 1;
      if (depth === 0) return code.slice(braceIndex, i + 1);
    }
  }
  return code.slice(braceIndex);
}

/**
 * Places in `source` that decide PAIDNESS from a provider ID — the shape R-151(e) forbids a second
 * copy of.
 *
 * **This is a recall-bounded scan, not a proof.** The first version of this docstring said "every
 * place … three forms, and each one alone is defeatable"; review measured the claim and found three
 * forms walking straight past it. The table below is the corrected statement: what the detectors
 * reach, and what they provably do not. A zero from a gate whose limit is undeclared reads as "no
 * second classification exists", which is a stronger sentence than the evidence supports.
 *
 * **Reached** (each has a positive control in the `describe` below — a detector without one can be
 * added dead):
 *
 * | Form                                                             | Detector |
 * | ---------------------------------------------------------------- | -------- |
 * | `const PAID_PROVIDER_IDS = new Set(['dune','nansen'])`           | 1 |
 * | `['dune','nansen'].find((x) => x === id)` / `.some` / `.indexOf` | 1b |
 * | `SET.has(id)` / `ARRAY.includes(id)` / `ARRAY.indexOf(id)`      | 2 |
 * | `registration.id === 'nansen'`                                    | 3 |
 * | `switch (providerId) { case 'nansen': … }`                        | 4 |
 * | `PAID_BY_ID[providerId]` (lookup table, at its USE site)          | 5 |
 *
 * **NOT reached — measured, not hypothesised:**
 *
 * | Escape                                                                        | Why |
 * | ------------------------------------------------------------------------------ | --- |
 * | Decision split across statements or a function boundary — `const hit = SET.has(id)` in one place, `hit ? 'paid' : 'free'` in another | Every detector requires the paidness vocabulary in the SAME statement (or switch body) as the id test. Following the value would need dataflow, not regexes. |
 * | The lookup TABLE's declaration — `const T: Record<string, boolean> = { nansen: true }` | Bare-identifier keys are not string literals, so detector 1 does not see a collection. Only the use site (detector 5) is covered; a table declared and never used decides nothing. |
 * | Vocabulary outside `paid`/`tier`/`kind` — e.g. `const costsMoney = …`         | The vocabulary is a fixed list. Widening it costs false positives on unrelated code; this is the deliberate trade. |
 * | An id list arriving at RUNTIME — env, JSON, a DB row                          | Not in the source at all. Nothing a source scan can do. |
 * | The whole class of `costOf`-derived paidness                                   | Out of scope by design: that is `adapter-registrations.test.ts`'s TC-UNIT-06, which has its own (also declared) limits. |
 * | A quote that opens no string — a lone `'` in a regex, an apostrophe in code                 | `blankNonCode` treats a quote as an opener only when it CLOSES on the same line (backticks excepted). Ported from `policy.test.ts` by adversarial cycle 2, F-9: **before the port this row read as nothing at all**, and a lone quote consumed the rest of the file — blanking real code into invisibility, which is a false NEGATIVE for every detector below. The rule bounds the damage to that one quote; a string genuinely spanning lines with `\\`-continuation is still mis-lexed. |
 *
 * Detectors 2, 3 and 5 read the whole enclosing statement; detector 1/1b read the text preceding the
 * literals; detector 4 reads the brace-matched switch body. **What this deliberately does NOT flag,
 * as opposed to cannot:** reading the field itself — `r.tier === 'paid'` compares a TIER, not an id,
 * which the left operand's last segment decides.
 */
function paidnessClassifiedById(source: string): string[] {
  const code = blankNonCode(source);
  const offenders: string[] = [];

  for (const match of code.matchAll(LITERAL_COLLECTION)) {
    const { text, start } = enclosingStatement(code, match.index);
    const before = words(code.slice(start, match.index));
    const trailer = code.slice(match.index + match[0].length, match.index + match[0].length + 24);
    // 1b: a literal collection immediately QUERIED — `['dune','nansen'].find((x) => x === id)`.
    // The id vocabulary is not required here, because the callback's parameter can be named
    // anything (`(x) => x === providerId`); being a fixed id list that something asks a question
    // of, inside a statement about paidness, is the whole signal.
    const queried = COLLECTION_CALLBACK.test(trailer);
    const paidnessNearby = queried
      ? hasAny(words(text), PAIDNESS_WORDS)
      : hasAny(before, PAIDNESS_WORDS) && hasAny(before, ID_WORDS);
    if (paidnessNearby) offenders.push(text.trim());
  }

  for (const match of code.matchAll(MEMBERSHIP)) {
    if (!isIdOperand(match[2] ?? '')) continue;
    const { text } = enclosingStatement(code, match.index);
    if (hasAny(words(text), PAIDNESS_WORDS)) offenders.push(text.trim());
  }

  for (const match of code.matchAll(LITERAL_EQUALITY)) {
    if (!isIdOperand(match[1] ?? '')) continue;
    const { text } = enclosingStatement(code, match.index);
    if (hasAny(words(text), PAIDNESS_WORDS)) offenders.push(text.trim());
  }

  for (const match of code.matchAll(SWITCH_ON)) {
    if (!isIdOperand(match[1] ?? '')) continue;
    // The switch BODY, brace-matched: `enclosingStatement` stops at the opening `{`, so every
    // `case 'nansen': return 'paid'` would sit outside the window the other detectors use.
    const bodyStart = match.index + match[0].length - 1;
    const blankedBody = enclosingBlock(code, bodyStart);
    // Two conditions, and the SECOND one reads the RAW source — the only place in this file that
    // does. A switch decides by RETURNING, so its paidness vocabulary lives in the returned string
    // VALUES (`return 'paid'`), which blanking erases; there is no code-level identifier left to
    // key on. Requiring literal `case '…'` labels as well is what keeps a legitimate dispatch by
    // id (`case 'nansen': return nansenNormalizer`) out unless it also talks about paidness.
    // Accepted cost, stated: a switch over an id whose body merely MENTIONS "paid" in a comment
    // would be flagged. There are no switches on an id-ish operand in either `src` today.
    const hasLiteralCase = /case\s*(?:'|")/.test(blankedBody);
    const rawBody = enclosingBlock(source, bodyStart);
    if (hasLiteralCase && hasAny(words(rawBody), PAIDNESS_WORDS)) offenders.push(`${match[0]}…}`);
  }

  for (const match of code.matchAll(INDEX_LOOKUP)) {
    if (!isIdOperand(match[1] ?? '')) continue;
    const { text } = enclosingStatement(code, match.index);
    if (hasAny(words(text), PAIDNESS_WORDS)) offenders.push(text.trim());
  }

  return [...new Set(offenders.map((statement) => statement.replace(/\s+/g, ' ')))];
}

/** Every `.trust` PROPERTY ACCESS in code — `trust: 'community'` literals are not one. */
function trustReads(source: string): string[] {
  const code = blankNonCode(source);
  return [...code.matchAll(/\.trust\b/g)].map((match) =>
    enclosingStatement(code, match.index).text.trim().replace(/\s+/g, ' '),
  );
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

/**
 * `packages/core/src` and `packages/mcp-server/src` — production code of both packages, and
 * **no `test` tree**.
 *
 * The boundary is stated here rather than inherited: the sibling `nonEmpty` gate scans `src` AND
 * `test`, and copying that would make the `.trust` gate below fail on the deliberate `.trust` reads
 * inside `adapter-registrations.test.ts` (012-2's own TC-UNIT-05 pins the rank table by name).
 * R-155(d) is about consumers in PRODUCTION code.
 */
function scannedSourceFiles(): string[] {
  const out: string[] = [];
  for (const pkg of ['core', 'mcp-server']) {
    const srcDir = path.join(repoRoot, 'packages', pkg, 'src');
    if (existsSync(srcDir)) out.push(...walkTs(srcDir));
  }
  return out;
}

const rel = (file: string): string => path.relative(repoRoot, file);

describe('TC-GATE-01 — paidness is classified in exactly one place: `registration.tier` (R-151(e))', () => {
  it('no production file classifies paidness from a provider id', () => {
    const files = scannedSourceFiles();
    // Sign of work FIRST: a walk that found nothing would report "no offenders" identically.
    expect(files.length).toBeGreaterThan(50);
    expect(files.some((f) => f.endsWith(path.join('src', 'cache', 'sqlite-store.ts')))).toBe(true);
    expect(files.some((f) => f.endsWith(path.join('src', 'tools', 'budget-meta.ts')))).toBe(true);

    const offenders: string[] = [];
    for (const file of files) {
      for (const statement of paidnessClassifiedById(readFileSync(file, 'utf8'))) {
        offenders.push(`${rel(file)}: ${statement}`);
      }
    }
    // Named, not counted — a gate that says "1 offender" cannot be acted on, and the file+statement
    // is what the reader needs to see (this task's own acceptance: "падение называет файл и строку").
    expect(
      offenders,
      'A second classification of paidness appeared. `AdapterRegistration.tier` (ADR-002 D8) is ' +
        'the only one: read it, do not rebuild it from provider ids.',
    ).toStrictEqual([]);
  });

  it('the gate DETECTS each REACHED form (a detector without a control can be added dead)', () => {
    // One control per row of the "Reached" table in `paidnessClassifiedById`'s docstring. The last
    // three were added in review round 1, which measured them ESCAPING the first version.
    const declaration = `const PAID_PROVIDER_IDS = new Set<string>(['dune', 'nansen']);`;
    expect(paidnessClassifiedById(declaration), 'detector 1: declaration').not.toStrictEqual([]);

    const membership = `kind: PAID_PROVIDER_IDS.has(registration.id) ? 'paid' : 'free',`;
    expect(paidnessClassifiedById(membership), 'detector 2: membership').not.toStrictEqual([]);

    const equality = `const kind = registration.id === 'nansen' ? 'paid' : 'free';`;
    expect(paidnessClassifiedById(equality), 'detector 3: equality').not.toStrictEqual([]);

    // The renamed-collection form: detector 1 misses it (the name says nothing), detector 2 does not.
    const renamed = `const tier = KNOWN.includes(providerId) ? 'paid' : 'free';`;
    expect(paidnessClassifiedById(renamed), 'detector 2: renamed collection').not.toStrictEqual([]);

    const callback = `const kind = ['dune', 'nansen'].find((x) => x === providerId) ? 'paid' : 'free';`;
    expect(paidnessClassifiedById(callback), 'detector 1b: queried literal').not.toStrictEqual([]);

    const switched = `switch (providerId) {\n  case 'nansen':\n    return 'paid';\n  default:\n    return 'free';\n}`;
    expect(paidnessClassifiedById(switched), 'detector 4: switch on an id').not.toStrictEqual([]);

    const lookup = `const kind = PAID_BY_ID[providerId] ? 'paid' : 'free';`;
    expect(paidnessClassifiedById(lookup), 'detector 5: lookup table use').not.toStrictEqual([]);

    const indexOf = `const tier = KNOWN_IDS.indexOf(providerId) >= 0 ? 'paid' : 'free';`;
    expect(paidnessClassifiedById(indexOf), 'detector 2: indexOf form').not.toStrictEqual([]);
  });

  it('the DECLARED LIMITS are real: these forms are NOT reached, and that is written down', () => {
    // Executable form of the "NOT reached" table. Asserting the limit rather than leaving it as
    // prose does two things: it stops the table drifting away from the code, and it turns any
    // future widening into a visible edit HERE — a new detector that silently closed one of these
    // would fail this test and force the table to be updated with it.
    const splitAcrossStatements = `const hit = KNOWN_IDS.has(providerId);\nconst kind = hit ? 'paid' : 'free';`;
    expect(
      paidnessClassifiedById(splitAcrossStatements),
      'LIMIT: paidness vocabulary in a different statement from the id test',
    ).toStrictEqual([]);

    const tableDeclaration = `const PAID_BY_ID: Record<string, boolean> = { nansen: true, dune: true };`;
    expect(
      paidnessClassifiedById(tableDeclaration),
      'LIMIT: a lookup table declared with bare-identifier keys (only its USE site is reached)',
    ).toStrictEqual([]);

    // Cycle 2, F-9 — the LEXER limit, and the reason the rule exists. The first line's `'` closes
    // nothing, so a scanner without the same-line rule swallows everything after it and the real
    // offender on line 2 disappears. With the rule, the offender is found.
    const loneQuoteThenOffender =
      "const RE = /case\\s*(?:'|\")/;\nconst kind = ['dune','nansen'].includes(providerId) ? 'paid' : 'free';";
    expect(
      paidnessClassifiedById(loneQuoteThenOffender),
      'LIMIT/CONTROL: a quote that opens no string must not blank the rest of the file',
    ).not.toStrictEqual([]);

    const otherVocabulary = `const costsMoney = ['dune', 'nansen'].includes(providerId);`;
    expect(
      paidnessClassifiedById(otherVocabulary),
      'LIMIT: paidness expressed outside the paid/tier/kind vocabulary',
    ).toStrictEqual([]);
  });

  it('the gate does NOT flag reading the field, naming a provider, or listing hosts', () => {
    // Without these controls the gate would be indistinguishable from "the string `'nansen'` may
    // not appear", which is the version that would have fired on five correct occurrences.
    const readsTheField = `return adapterRegistrations.some((r) => r.id === providerId && r.tier === 'paid');`;
    expect(paidnessClassifiedById(readsTheField)).toStrictEqual([]);

    const route = `{ capability: 'entity.labels', adapterIds: ['blockscout', 'nansen'] },`;
    expect(paidnessClassifiedById(route)).toStrictEqual([]);

    const registration = `{ id: 'nansen', hosts: ['api.nansen.ai'], tier: 'paid', trust: 'authoritative' }`;
    expect(paidnessClassifiedById(registration)).toStrictEqual([]);

    const adapterMapKey = `['nansen', createProductionNansenAdapter(env, budgetStore)],`;
    expect(paidnessClassifiedById(adapterMapKey)).toStrictEqual([]);
  });

  it('the gate reads code, not prose about code', () => {
    const commented = `// const PAID = new Set(['dune','nansen']); <- the rule, written down\nconst x = 1;`;
    expect(paidnessClassifiedById(commented)).toStrictEqual([]);
  });
});

describe('TC-GATE-02 — `.trust` has no consumer in production code (R-155(d))', () => {
  /**
   * **What this asserts, exactly.** No file under either package's `src` reads a `.trust` property,
   * with ONE file exempt: `adapters/types.ts`, home of `assertValidAdapterRegistrations()` — the
   * single reader T-012 allows.
   *
   * **And the expected offender set today is empty, including inside the exemption**, because that
   * validator walks `['tier','trust']` and reads `registration[field]`, not `registration.trust`.
   * So `\.trust\b` over both `src` trees currently matches nothing at all. That is not a weakness
   * of the gate and it is not asserted as "exactly one reader": the claim under test is that a
   * SECOND reader cannot appear unnoticed, which is what T-016 will have to argue for explicitly.
   * The controls below prove the detector fires on a real read, so the empty result above is a
   * measurement, not a blind spot.
   */
  const EXEMPT = path.join('packages', 'core', 'src', 'adapters', 'types.ts');

  it('no production file outside the declared validator reads `.trust`', () => {
    const files = scannedSourceFiles();
    expect(files.length).toBeGreaterThan(50);
    expect(files.some((f) => rel(f) === EXEMPT)).toBe(true);

    const offenders: string[] = [];
    for (const file of files) {
      if (rel(file) === EXEMPT) continue;
      for (const statement of trustReads(readFileSync(file, 'utf8'))) {
        offenders.push(`${rel(file)}: ${statement}`);
      }
    }
    expect(
      offenders,
      '`trust` is declare-only in T-012 (R-155): merge segmentation, community marking and the ' +
        'per-ROW `source → trust` dictionary are T-016. A consumer here means the rank was ' +
        'retrofitted to the code that uses it.',
    ).toStrictEqual([]);
  });

  it('the detector fires on a real read and ignores the twelve declarations', () => {
    expect(trustReads(`if (registration.trust === 'community') mark(result);`)).not.toStrictEqual(
      [],
    );
    expect(trustReads(`const rank = r.trust;`)).not.toStrictEqual([]);
    // The 12 registrations write the field as a literal key — never a read, so the gate is silent.
    expect(trustReads(`{ id: 'blockscout', tier: 'free', trust: 'community' }`)).toStrictEqual([]);
    // Prose and strings are not reads either.
    expect(
      trustReads(`// nothing reads registration.trust yet\nconst s = 'r.trust';`),
    ).toStrictEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// TC-UNIT-01/02/02a/03 — the two `bootstrapProviders` writers READ `registration.tier`
// ---------------------------------------------------------------------------------------------

/** A fresh temp directory + db path, and its cleanup — the pattern `budget-velocity.test.ts` uses. */
function tempDb(): { dbPath: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(tmpdir(), 'tier-single-source-'));
  return {
    dbPath: path.join(dir, 'cache.sqlite3'),
    cleanup: () => {
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/**
 * EVERY column of `providers`, as the file actually holds it, read on a connection of the test's
 * own — `{id: {kind, notes}}`.
 *
 * **All three columns, since adversarial cycle 2's F-3.** It selected `id, kind` while TC-UNIT-03
 * below called what it compared "byte-identical `providers` content", and the third column was
 * where the two writers actually differed: the cache store's conflict clause set
 * `notes = excluded.notes` (i.e. `NULL`) and the budget store's did not, so constructing a cache
 * store erased an operator's note and constructing a budget store preserved it. A helper that reads
 * two of three columns cannot fail on a disagreement in the third, and the assertion's own title
 * was the claim it was not making.
 */
function providerRows(dbPath: string): Record<string, { kind: string; notes: string | null }> {
  const db = new Database(dbPath, { readonly: true });
  try {
    const rows = db.prepare('SELECT id, kind, notes FROM providers ORDER BY id').all() as {
      id: string;
      kind: string;
      notes: string | null;
    }[];
    return Object.fromEntries(rows.map((row) => [row.id, { kind: row.kind, notes: row.notes }]));
  } finally {
    db.close();
  }
}

/** The `kind` projection of the above — for the cases whose subject is the tier alone. */
function providerKinds(dbPath: string): Record<string, string> {
  return Object.fromEntries(
    Object.entries(providerRows(dbPath)).map(([id, row]) => [id, row.kind]),
  );
}

/** Creates the tables on a brand-new file WITHOUT constructing either store — see TC-UNIT-02a.
 * `notes` is seedable because F-3's case is about a value neither store owns surviving both. */
function seedProviders(dbPath: string, rows: [id: string, kind: string, notes?: string][]): void {
  const db = new Database(dbPath);
  try {
    db.exec(CACHE_DDL);
    const insert = db.prepare('INSERT INTO providers (id, kind, notes) VALUES (?, ?, ?)');
    for (const [id, kind, notes] of rows) insert.run(id, kind, notes ?? null);
  } finally {
    db.close();
  }
}

const registration = (id: string, tier: AdapterTier): AdapterRegistration => ({
  id,
  hosts: [`${id}.invalid`],
  rateLimit: { capacity: 1, refillPerSec: 1 },
  requiresEnv: [],
  tier,
  trust: 'authoritative',
});

/**
 * A registration table that DISAGREES with the real world — and that is the entire mechanism.
 *
 * `nansen` is declared `free` here and `coingecko` `paid`, the opposite of `providers.config.ts`.
 * An implementation that consults a hardcoded id list (`PAID_PROVIDER_IDS` was literally
 * `new Set(['dune','nansen'])`) writes the OPPOSITE of this table, so every assertion below fails
 * on it. Fed the real twelve instead, the same assertions would pass under both implementations,
 * because the list and the table agree today — which is exactly how a test can be green while the
 * defect it was written for is untouched.
 */
const INVERTED: AdapterRegistration[] = [
  registration('nansen', 'free'),
  registration('coingecko', 'paid'),
  registration('probe-adapter', 'paid'),
];

const INVERTED_KINDS = { coingecko: 'paid', nansen: 'free', 'probe-adapter': 'paid' };

describe('TC-UNIT-01 — SqliteCacheStore.bootstrapProviders writes `registration.tier`', () => {
  it('writes the tier the REGISTRATION declares, even when it contradicts a hardcoded list', () => {
    const { dbPath, cleanup } = tempDb();
    try {
      const store = new SqliteCacheStore({ dbPath, providers: INVERTED });
      store.close();
      expect(providerKinds(dbPath)).toStrictEqual(INVERTED_KINDS);
    } finally {
      cleanup();
    }
  });

  it('classifies the real twelve: `paid` for dune/nansen, `free` for the other ten', () => {
    const { dbPath, cleanup } = tempDb();
    try {
      const store = new SqliteCacheStore({ dbPath, providers: adapterRegistrations });
      store.close();
      const kinds = providerKinds(dbPath);
      // The whole map, id by id — a count ("two paid") would pass on a permutation.
      expect(kinds).toStrictEqual(
        Object.fromEntries(adapterRegistrations.map((r) => [r.id, r.tier])),
      );
      expect(Object.keys(kinds)).toHaveLength(12);
      expect(
        Object.entries(kinds)
          .filter(([, kind]) => kind === 'paid')
          .map(([id]) => id)
          .sort(),
      ).toStrictEqual(['dune', 'nansen']);
    } finally {
      cleanup();
    }
  });
});

describe('TC-UNIT-02 — SqliteBudgetStore.bootstrapProviders writes the same field', () => {
  it('writes the declared tier, and leaves no row at the retired `unknown`', () => {
    const { dbPath, cleanup } = tempDb();
    try {
      const store = new SqliteBudgetStore({ dbPath, providers: INVERTED });
      store.close();
      const kinds = providerKinds(dbPath);
      expect(kinds).toStrictEqual(INVERTED_KINDS);
      expect(Object.values(kinds)).not.toContain('unknown');
    } finally {
      cleanup();
    }
  });
});

describe('TC-UNIT-02a — an EXISTING row migrates; the conflict clause is the thing under test', () => {
  /**
   * The seed is what makes this test able to fail. On a fresh database every insert takes the
   * VALUES branch, so `DO NOTHING` and `DO UPDATE` behave identically and TC-UNIT-02 above passes
   * under both — while every real installation, whose `providers` rows were written as `'unknown'`
   * before this task, would keep them forever.
   *
   * The tables are created by running `CACHE_DDL` on a connection of the test's own, NOT by
   * constructing a store first: `SqliteBudgetStore`'s constructor runs the DDL and `bootstrapProviders`
   * back to back, so by the time it returns the rows already exist with the NEW value and there is
   * nothing left to migrate (and a plain `INSERT` of the seed would then hit the `TEXT PRIMARY KEY`).
   */
  it('rewrites a pre-existing `unknown` row to the registration tier', () => {
    const { dbPath, cleanup } = tempDb();
    try {
      seedProviders(dbPath, [
        ['nansen', 'unknown'],
        ['coingecko', 'unknown'],
      ]);
      expect(providerKinds(dbPath)).toStrictEqual({ coingecko: 'unknown', nansen: 'unknown' });

      const store = new SqliteBudgetStore({ dbPath, providers: INVERTED });
      store.close();

      expect(providerKinds(dbPath)).toStrictEqual(INVERTED_KINDS);
    } finally {
      cleanup();
    }
  });
});

describe('TC-UNIT-03 — the two writers agree, on a fresh file and on an existing one', () => {
  /**
   * Before this task they could not: the cache store wrote `'free'`/`'paid'` from its own id list
   * and the budget store wrote the literal `'unknown'`, so which classification a `cache.sqlite3`
   * ended up holding depended on which store had opened it last (and, with `DO NOTHING`, on which
   * had opened it FIRST). Both now derive from one field of one registration, so disagreement is no
   * longer expressible — this test is what keeps that true.
   */
  it('produces byte-identical `providers` content from the same registrations', () => {
    const cacheDb = tempDb();
    const budgetDb = tempDb();
    try {
      new SqliteCacheStore({ dbPath: cacheDb.dbPath, providers: INVERTED }).close();
      new SqliteBudgetStore({ dbPath: budgetDb.dbPath, providers: INVERTED }).close();

      // ALL THREE columns (cycle 2, F-3) — the title says "content", so the comparison has to be
      // the content and not the two columns that were easy to agree on.
      const written = providerRows(cacheDb.dbPath);
      expect(written).toStrictEqual(providerRows(budgetDb.dbPath));
      // Sign of work: the agreement is about real content, not two empty tables.
      expect(providerKinds(cacheDb.dbPath)).toStrictEqual(INVERTED_KINDS);
    } finally {
      cacheDb.cleanup();
      budgetDb.cleanup();
    }
  });

  it('agrees on rows that ALREADY exist, in either construction order', () => {
    const cacheFirst = tempDb();
    const budgetFirst = tempDb();
    try {
      seedProviders(cacheFirst.dbPath, [
        ['nansen', 'unknown'],
        ['coingecko', 'unknown'],
      ]);
      seedProviders(budgetFirst.dbPath, [
        ['nansen', 'unknown'],
        ['coingecko', 'unknown'],
      ]);

      new SqliteCacheStore({ dbPath: cacheFirst.dbPath, providers: INVERTED }).close();
      new SqliteBudgetStore({ dbPath: cacheFirst.dbPath, providers: INVERTED }).close();

      new SqliteBudgetStore({ dbPath: budgetFirst.dbPath, providers: INVERTED }).close();
      new SqliteCacheStore({ dbPath: budgetFirst.dbPath, providers: INVERTED }).close();

      expect(providerKinds(cacheFirst.dbPath)).toStrictEqual(INVERTED_KINDS);
      expect(providerKinds(budgetFirst.dbPath)).toStrictEqual(INVERTED_KINDS);
      // Order-independence is about the whole row, not only the column both writers derive.
      expect(providerRows(cacheFirst.dbPath)).toStrictEqual(providerRows(budgetFirst.dbPath));
    } finally {
      cacheFirst.cleanup();
      budgetFirst.cleanup();
    }
  });

  /**
   * Adversarial cycle 2, F-3 — the column NEITHER writer owns.
   *
   * `providers.notes` is operator-facing free text: no code in this package produces a value for
   * it, both bootstraps insert `NULL`, and until this fix the cache store's conflict clause also
   * SET it back to that `NULL` on every construction while the budget store's left it alone. So the
   * two writers disagreed about the same file after all — what a `cache.sqlite3` held depended on
   * which store had opened it last — under a test suite whose own heading called the content
   * byte-identical, because its reader never selected the column they differed on.
   *
   * Both orders are exercised: a clause that clobbers is only visible when the clobbering writer
   * runs LAST, and one that does not must also not depend on running first.
   */
  it('preserves a `notes` value neither store writes — in either construction order', () => {
    const cacheLast = tempDb();
    const budgetLast = tempDb();
    const NOTE = 'operator: key rotated 2026-08-05, see runbook §4';
    try {
      for (const db of [cacheLast, budgetLast]) {
        seedProviders(db.dbPath, [
          ['nansen', 'unknown', NOTE],
          ['coingecko', 'unknown'],
        ]);
      }

      new SqliteBudgetStore({ dbPath: cacheLast.dbPath, providers: INVERTED }).close();
      new SqliteCacheStore({ dbPath: cacheLast.dbPath, providers: INVERTED }).close();

      new SqliteCacheStore({ dbPath: budgetLast.dbPath, providers: INVERTED }).close();
      new SqliteBudgetStore({ dbPath: budgetLast.dbPath, providers: INVERTED }).close();

      const expected = {
        coingecko: { kind: 'paid', notes: null },
        nansen: { kind: 'free', notes: NOTE },
        'probe-adapter': { kind: 'paid', notes: null },
      };
      expect(providerRows(cacheLast.dbPath), 'cache store constructed last').toStrictEqual(
        expected,
      );
      expect(providerRows(budgetLast.dbPath), 'budget store constructed last').toStrictEqual(
        expected,
      );
    } finally {
      cacheLast.cleanup();
      budgetLast.cleanup();
    }
  });
});
