import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  policyClasses,
  type PolicyDescriptor,
  type PolicyPredicate,
} from '../src/adapters/policy.js';
import {
  CapabilityRegistry,
  MissingCapabilityManifestError,
  UnregisteredPolicyClassError,
} from '../src/adapters/registry.js';
import { createBlockscoutAdapter } from '../src/adapters/blockscout/index.js';
import { routes } from '../src/providers.config.js';
import { EntityLabelSchema } from '../src/types/entity-label.js';
import type { CapabilityManifest } from '../src/capability-manifest.js';
import type { CacheGetResult, CacheStore } from '../src/adapters/cache-store.js';
import type { CapabilityRoute, ProviderAdapter } from '../src/adapters/types.js';
import { isolatedThrottle } from './helpers/isolated-throttle.js';

/**
 * Task 012-6 — the route answer policy as a serialisable descriptor resolved against a dictionary
 * of classes (ADR-002 **D2**, R-133/R-134/R-135).
 *
 * Written in the task's phase order: every predicate case below was authored against STUB classes
 * (`any` → `true`, `someElementHasAny` → `false`) and watched fail, and the construction-time
 * validation cases were authored against a step 2 that validated nothing. What the file asserts is
 * therefore a mechanism, not a description of code that already existed.
 *
 * **The equivalence claim is bounded, and the boundary is the point** (TC-UNIT-03 / TC-UNIT-03a).
 * The descriptor reproduces the retired literal's verdict **on the TASK-008 fixture set**, not
 * unconditionally: on `{ name: '' }` the two deliberately disagree, and TC-UNIT-03a pins the new
 * verdict as the correct one so that the divergence is a recorded decision rather than a surprise
 * somebody later "fixes" by loosening the class.
 */

const testDir = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(testDir, '../../..');

/** Builds the predicate a descriptor names, failing loudly if the class is missing. */
function predicateFor(descriptor: PolicyDescriptor): PolicyPredicate {
  const build = policyClasses[descriptor.kind];
  if (build === undefined) throw new Error(`no policy class '${descriptor.kind}' is registered`);
  return build(descriptor);
}

/** The descriptor `providers.config.ts`'s one policy-carrying route declares. */
const ENTITY_LABELS_POLICY: PolicyDescriptor = {
  kind: 'someElementHasAny',
  fields: ['name', 'tags', 'labels'],
};

// =============================================================================================
// TC-UNIT-01 / TC-UNIT-02 — the two classes, in isolation
// =============================================================================================

describe('TC-UNIT-01 — `any` accepts every input there is', () => {
  const satisfying = predicateFor({ kind: 'any' });

  it.each<[string, unknown]>([
    ['an empty array', []],
    ['null', null],
    ['undefined', undefined],
    ['an object', { anything: 1 }],
    ['a string', 'x'],
    ['the empty string', ''],
    ['zero', 0],
    ['an array of contentless entries', [{ name: '', tags: [], labels: [] }]],
  ])('%s satisfies', (_label, value) => {
    expect(satisfying(value)).toBe(true);
  });
});

describe('TC-UNIT-02 — `someElementHasAny` wants CONTENT in a named field, not a length', () => {
  const satisfying = predicateFor(ENTITY_LABELS_POLICY);

  it.each<[string, unknown]>([
    ['a plain object', {}],
    ['a string', 'labels'],
    ['null', null],
    ['undefined', undefined],
    ['a number', 42],
  ])('rejects %s — the result is not an array', (_label, value) => {
    expect(satisfying(value)).toBe(false);
  });

  it('rejects the empty array', () => {
    expect(satisfying([])).toBe(false);
  });

  it.each<[string, unknown]>([
    ['every field empty', [{ name: '', tags: [], labels: [] }]],
    ['every field absent', [{}]],
    ['nulls', [{ name: null, tags: null, labels: null }]],
    ['undefineds', [{ name: undefined, tags: undefined, labels: undefined }]],
    ['two contentless entries', [{ tags: [] }, { labels: [] }]],
    ['non-object entries', [null, 'x', 7]],
  ])('rejects a non-empty array whose entries carry nothing: %s', (_label, value) => {
    // THIS is H-1. `array.length > 0` is true for every row here, and treating any of them as an
    // answer ends the route at the free source and shadows the paid one for the whole TTL.
    expect(satisfying(value)).toBe(false);
  });

  it.each<[string, unknown]>([
    ['name', [{ name: 'Binance 14', tags: [], labels: [] }]],
    ['tags', [{ name: '', tags: ['exchange'], labels: [] }]],
    ['labels', [{ name: '', tags: [], labels: ['Binance: Hot Wallet'] }]],
  ])('accepts an entry with a non-empty `%s`', (_label, value) => {
    expect(satisfying(value)).toBe(true);
  });

  it('accepts when the content is on the SECOND entry, not the first', () => {
    // Guards `.some(...)` against a mutation to "look at element 0" — which every single-element
    // case above would pass under.
    expect(satisfying([{ name: '', tags: [] }, { tags: ['exchange'] }])).toBe(true);
  });

  it('reads ITS OWN `fields`: a descriptor naming none accepts nothing', () => {
    const nothingIsRead = predicateFor({ kind: 'someElementHasAny', fields: [] });
    expect(nothingIsRead([{ name: 'Binance 14', tags: ['x'], labels: ['y'] }])).toBe(false);
  });

  it('reads ONLY its own fields: `fields: [labels]` ignores a populated `name`', () => {
    // The property the converted `blockscout-fallback.test.ts` case (TC-INT-07) depends on.
    const labelsOnly = predicateFor({ kind: 'someElementHasAny', fields: ['labels'] });
    expect(labelsOnly([{ name: 'Binance 14', tags: ['exchange'], labels: [] }])).toBe(false);
    expect(labelsOnly([{ name: '', tags: [], labels: ['Binance: Hot Wallet'] }])).toBe(true);
  });
});

// =============================================================================================
// TC-UNIT-03 / TC-UNIT-03a — equivalence ON THE TASK-008 FIXTURE SET, and the one divergence
// =============================================================================================

/**
 * `providers.config.ts`'s `entity.labels` predicate as it stood BEFORE task 012-6 — transcribed
 * here, never imported, because the file it came from is edited by this very task.
 *
 * Note `typeof label.name === 'string'`: it accepts `name: ''`. That is the divergence TC-UNIT-03a
 * pins, and the reason the equivalence below is claimed on a NAMED SET rather than in general.
 */
const RETIRED_LITERAL = (result: unknown): boolean =>
  Array.isArray(result) &&
  result.some((entry) => {
    if (entry === null || typeof entry !== 'object') return false;
    const label = entry as { name?: unknown; tags?: unknown; labels?: unknown };
    return (
      typeof label.name === 'string' ||
      (Array.isArray(label.tags) && label.tags.length > 0) ||
      (Array.isArray(label.labels) && label.labels.length > 0)
    );
  });

const BINANCE = '0x28C6c06298d514Db089934071355E5743bf21d60';

const fixture = (name: string): unknown =>
  JSON.parse(readFileSync(path.join(repoRoot, 'docs/onchain-analytics/raw', name), 'utf8'));

/**
 * Every Blockscout `entity.labels` body TASK-008 left behind — the two RECORDED responses plus the
 * synthetic shapes its own suite drives the adapter with. Each row names where it came from, so the
 * set can be audited rather than trusted.
 *
 * Run through the REAL adapter (`fetch` → `normalize`, sanitizer included) rather than hand-built
 * as `EntityLabel[]`: the predicate judges what the registry actually receives, and a hand-built
 * array would let this test agree with the code about a shape neither shares with production.
 */
const TASK_008_BODIES: [source: string, body: unknown][] = [
  [
    'raw/blockscout-labeled-2026-07-28.json (Binance hot wallet)',
    fixture('blockscout-labeled-2026-07-28.json'),
  ],
  [
    'raw/blockscout-addrinfo-2026-07-28.json (USDC)',
    fixture('blockscout-addrinfo-2026-07-28.json'),
  ],
  ['blockscout-fallback.test.ts NO_TAGS', { data: { metadata: null } }],
  ['blockscout.transport.test.ts empty tag array', { data: { metadata: { tags: [] } } }],
  ['blockscout-sanitize.test.ts malformed: {}', {}],
  ['blockscout-sanitize.test.ts malformed: data null', { data: null }],
  [
    'blockscout-sanitize.test.ts malformed: tags not an array',
    { data: { metadata: { tags: 'nope' } } },
  ],
  [
    'blockscout-sanitize.test.ts unusable tag entries',
    { data: { metadata: { tags: [{ tagType: 'name' }, { name: '', tagType: 'name' }, null, 7] } } },
  ],
];

/** One Blockscout answer, produced the way the registry produces it. */
async function blockscoutAnswer(body: unknown): Promise<unknown> {
  const adapter = createBlockscoutAdapter({
    now: () => 1_700_000_000_000,
    env: {},
    throttle: isolatedThrottle(1_700_000_000_000),
    fetchImpl: () => Promise.resolve(new Response(JSON.stringify(body), { status: 200 })),
  });
  const raw = await adapter.fetch('entity.labels', { chain: 'ethereum', tokenAddress: BINANCE });
  return adapter.normalize('entity.labels', raw);
}

describe('TC-UNIT-03 — same verdict as the retired literal ON THE TASK-008 FIXTURE SET', () => {
  /**
   * **"On this set", not "always".** The general claim is FALSE — see TC-UNIT-03a, which is the
   * input on which the two are designed to disagree. What is asserted here is that converting the
   * one live route changed no verdict on any Blockscout answer TASK-008 recorded or drove.
   */
  it('agrees on every recorded and synthetic Blockscout answer, verdict by verdict', async () => {
    const satisfying = predicateFor(ENTITY_LABELS_POLICY);
    const verdicts: { source: string; retired: boolean; descriptor: boolean }[] = [];
    for (const [source, body] of TASK_008_BODIES) {
      const answer = await blockscoutAnswer(body);
      verdicts.push({ source, retired: RETIRED_LITERAL(answer), descriptor: satisfying(answer) });
    }

    // Sign of work FIRST, and it is two claims, not one: the set really was walked, and it is not
    // degenerate. A set on which every verdict is `false` would be satisfied by a predicate that
    // returns `false` unconditionally — which is precisely the phase-1 stub.
    expect(verdicts).toHaveLength(8);
    expect(verdicts.filter((v) => v.descriptor).map((v) => v.source)).toStrictEqual([
      'raw/blockscout-labeled-2026-07-28.json (Binance hot wallet)',
      'raw/blockscout-addrinfo-2026-07-28.json (USDC)',
    ]);

    const disagreements = verdicts
      .filter((v) => v.retired !== v.descriptor)
      .map((v) => `${v.source}: retired=${String(v.retired)} descriptor=${String(v.descriptor)}`);
    expect(
      disagreements,
      'the descriptor changed a verdict on a TASK-008 fixture — R-133b/AC-2 allows exactly one ' +
        'divergence and it is not on this set (TC-UNIT-03a)',
    ).toStrictEqual([]);
  });
});

describe('TC-UNIT-03a — an empty `name` diverges, deliberately, and the NEW verdict is right', () => {
  /**
   * Med-3. The retired literal tested `typeof label.name === 'string'`, so an entry whose `name` is
   * the empty string SATISFIED it. `someElementHasAny` calls that entry contentless and keeps
   * walking.
   *
   * The input is representable, which is why this is a decision and not a thought experiment:
   * `EntityLabelSchema.name` is `z.string().max(256).optional()` with no `.min(1)`, so the parse
   * below succeeds. An empty `name` is exactly the contentless record H-1 is about — accepting it
   * would shadow the paid source for the whole TTL on the strength of a field carrying nothing.
   */
  it('the retired literal accepts it, the descriptor rejects it, and rejection is correct', () => {
    const emptyName = [
      EntityLabelSchema.parse({
        chain: 'ethereum',
        address: BINANCE,
        name: '',
        tags: [],
        labels: [],
        premiumRequested: false,
        source: 'nansen',
        fetchedAt: 0,
      }),
    ];
    // The schema accepted it — the input is real, not hypothetical.
    expect(emptyName[0]?.name).toBe('');

    expect(RETIRED_LITERAL(emptyName), 'the retired literal used to accept an empty name').toBe(
      true,
    );
    expect(
      predicateFor(ENTITY_LABELS_POLICY)(emptyName),
      'an empty `name` is a contentless record (H-1): treating it as an answer shadows the ' +
        'provider that would have known',
    ).toBe(false);
  });
});

// =============================================================================================
// The registry fixtures — a synthetic capability, its own manifest map, two adapters
// =============================================================================================

const MANIFESTS: Readonly<Record<string, CapabilityManifest>> = {
  'legacy.thing': { shape: 'set', ttlSeconds: 60, deadlineMs: 15_000, shareable: true },
};

/** An adapter that answers with whatever it is handed, and records that it was asked. */
function spyAdapter(id: string, answer: unknown): { adapter: ProviderAdapter; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    adapter: {
      id,
      capabilities: () => [{ id: 'legacy.thing' }],
      costOf: () => ({ credits: 0 }),
      fetch: (cap: string) => {
        calls.push(cap);
        return Promise.resolve({ raw: id });
      },
      normalize: () => answer,
      isAvailable: () => ({ ok: true }),
    },
  };
}

/**
 * Minimal real cache — a LOCAL copy of the one in `blockscout-fallback.test.ts`, deliberately not
 * extracted into a shared helper: that file belongs to a delivered task's radius (PLAN §0.4), and a
 * shared module would let an edit made for THIS file change ITS verdict. Twelve lines against
 * that coupling.
 */
class MemoryCacheStore implements CacheStore {
  private readonly entries = new Map<string, unknown>();
  private key(provider: string, capability: string, argsHash: string): string {
    return `${provider}|${capability}|${argsHash}`;
  }
  get(provider: string, capability: string, argsHash: string): Promise<CacheGetResult | undefined> {
    const value = this.entries.get(this.key(provider, capability, argsHash));
    return Promise.resolve(value === undefined ? undefined : { value, ageMs: 1 });
  }
  set(provider: string, capability: string, argsHash: string, value: unknown): Promise<void> {
    this.entries.set(this.key(provider, capability, argsHash), value);
    return Promise.resolve();
  }
}

// =============================================================================================
// TC-UNIT-04 — an absent descriptor IS `{ kind: 'any' }`
// =============================================================================================

describe('TC-UNIT-04 — an absent `policy` behaves exactly like a descriptor of kind `any`', () => {
  it('both accept an answer that `someElementHasAny` would reject, and neither pays', async () => {
    const outcomes: { source: string; paidCalls: string[] }[] = [];
    for (const policy of [undefined, { kind: 'any' } as const]) {
      const free = spyAdapter('free', []);
      const paid = spyAdapter('paid', [{ labels: ['something'] }]);
      const registry = new CapabilityRegistry(
        [
          {
            capability: 'legacy.thing',
            adapterIds: ['free', 'paid'],
            ...(policy ? { policy } : {}),
          },
        ],
        new Map([
          ['free', free.adapter],
          ['paid', paid.adapter],
        ]),
        undefined,
        null,
        MANIFESTS,
      );
      const { source } = await registry.resolve('legacy.thing', 'ethereum', {});
      outcomes.push({ source, paidCalls: paid.calls });
    }

    expect(outcomes).toStrictEqual([
      { source: 'free', paidCalls: [] },
      { source: 'free', paidCalls: [] },
    ]);
  });
});

// =============================================================================================
// TC-GATE-01 — the class is not NAMED after a container's length (AC-3, R-134c)
// =============================================================================================

/**
 * Splits a source file into a CODE view (comments and string CONTENTS blanked) and the list of its
 * string/template literal CONTENTS.
 *
 * A local copy of the scanner in `tier-single-source.test.ts` (task 012-3), which is itself a local
 * copy of `adapter-registrations.test.ts`'s (task 012-2), for the reason those two state: a shared
 * helper would mean an edit made for THIS gate silently changes the verdict of THOSE. One behaviour
 * is ADDED here rather than inherited — see `sameLine` below.
 *
 * **Why two views and not one.** The ban is on IDENTIFIERS, and the explanation of why the ban
 * exists must survive in PROSE (R-134c) — `src/adapters/policy.ts` and `src/adapters/types.ts` both
 * carry it in a docstring. A scan that read raw text could not tell those apart from an alias, and
 * "fixing" it would mean deleting the reason. Test TITLES are strings, not comments, so the string
 * view exists to keep them in scope.
 */
function views(source: string): { code: string; strings: string[] } {
  const out = source.split('');
  const strings: string[] = [];
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
      // A quote opens a string only if it CLOSES on the same line (backticks may span lines). The
      // added rule, and it is load-bearing: without it a regex such as `/case\s*(?:'|")/` — which
      // `tier-single-source.test.ts` really contains — opens a "string" that swallows the rest of
      // the file, blanking real code and turning real comments into string content.
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
        i += 1;
        continue;
      }
      strings.push(source.slice(i + 1, j));
      blank(i + 1, j);
      i = j + 1;
    } else {
      i += 1;
    }
  }
  return { code: out.join(''), strings };
}

/**
 * The banned name, normalized — separators dropped, case folded. `NON_EMPTY`, `nonempty`,
 * `isNonEmptyArray` and `NonEmptyPolicy` all reduce to something containing it.
 *
 * **Assembled from fragments, and every control below is too.** The alternative was to exempt this
 * file from the string view (there is precedent: `tier-single-source.test.ts` exempts `types.ts`
 * from its `.trust` gate) — but an exemption is a hole in the one file most likely to acquire an
 * alias while nobody looks. Assembling instead costs two `+` signs and lets the gate scan all 1xx
 * files under both views with no exemption at all. It also makes the "a name assembled at runtime
 * is out of reach" limit self-demonstrating: these controls ARE that form.
 */
const BANNED = 'non' + 'empty';
/** The same name in the casing a declaration would use — for the controls. */
const BANNED_CAMEL = 'non' + 'Empty';

const normalize = (identifier: string): string => identifier.replace(/[_$]/g, '').toLowerCase();

/**
 * Occurrences of the banned NAME in a file's code, and (separately) in its string literals.
 *
 * **Reached** — one positive control below per row:
 *
 * | Form                                                    | View   |
 * | --------------------------------------------------------- | ------ |
 * | `export const nonEmpty = …`                              | code   |
 * | `const nonEmpty = someElementHasAny` (alias)             | code   |
 * | `{ nonEmpty: () => … }` (dictionary key)                 | code   |
 * | `type NonEmptyPolicy` / `interface NonEmpty`             | code   |
 * | `const NON_EMPTY = …` / `nonempty` (separators, casing)  | code   |
 * | `it('nonEmpty …')` (a test title)                        | string |
 * | `{ 'nonEmpty': … }` (a quoted dictionary key)            | string |
 *
 * **NOT reached — measured, not hypothesised** (each asserted below):
 *
 * | Escape                                                              | Why |
 * | --------------------------------------------------------------------- | --- |
 * | The name inside a COMMENT                                            | Deliberate, and required: R-134c makes the explanation of the ban mandatory, and it lives in the docstrings of `policy.ts` and `types.ts`. A gate banning the token outright would make two instructions of the task mutually exclusive. |
 * | A name assembled at runtime — `'non' + 'Empty'`, a computed key      | Each fragment is a legal string; joining them is dataflow, which a text scan does not do. |
 * | A SYNONYM — `notEmpty`, `isNotEmpty`, `hasLength`, `lengthAboveZero` | The ban is on the NAME `nonEmpty`, not on every phrase that could mean it. `notEmpty` normalizes to `notempty`, which does not contain the token. Widening to synonyms would be a vocabulary guess, not a gate. |
 * | Anything outside `packages/<pkg>/src` and `packages/<pkg>/test`              | The declared scope (PLAN 012-6, task notes). `packages/mcp-server/eval/checks.mjs` holds an unrelated `nonEmpty(value, field)` helper of the eval harness, predating T-012 — it classifies nothing about routes and is out of scope by boundary, not by exemption. ADR-002's prose mentions the name as history for the same reason. |
 *
 * There is deliberately **no per-file exemption**: this file's own controls assemble the name from
 * fragments, so it is scanned under both views like every other.
 */
function bannedNameOccurrences(source: string): { code: string[]; strings: string[] } {
  const { code, strings } = views(source);
  const inCode = [
    ...new Set(
      (code.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? []).filter((identifier) =>
        normalize(identifier).includes(BANNED),
      ),
    ),
  ];
  const inStrings = [...new Set(strings.filter((text) => normalize(text).includes(BANNED)))];
  return { code: inCode, strings: inStrings };
}

function walkSources(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walkSources(full));
    else if (full.endsWith('.ts') || full.endsWith('.mjs')) out.push(full);
  }
  return out;
}

/** `packages/<pkg>/src` AND `packages/<pkg>/test` — the scope PLAN 012-6 declares for this gate. */
function scannedFiles(): string[] {
  const out: string[] = [];
  const packagesDir = path.join(repoRoot, 'packages');
  for (const pkg of readdirSync(packagesDir)) {
    for (const root of ['src', 'test']) {
      const dir = path.join(packagesDir, pkg, root);
      if (existsSync(dir)) out.push(...walkSources(dir));
    }
  }
  return out;
}

const rel = (file: string): string => path.relative(repoRoot, file);

describe('TC-GATE-01 — no policy class is named or aliased after a container being non-empty', () => {
  it('neither package declares such an identifier anywhere under `src` or `test`', () => {
    const files = scannedFiles();
    // Sign of work FIRST: a walk that found nothing would report "no offenders" identically.
    expect(files.length).toBeGreaterThan(100);
    expect(
      files.some((f) => rel(f) === path.join('packages', 'core', 'src', 'adapters', 'policy.ts')),
    ).toBe(true);
    // The file whose COMMENT carries the name (`tier-single-source.test.ts:288`) is in scope — that
    // is what makes "prose is allowed" a measurement rather than an assumption about the walk.
    expect(
      files.some(
        (f) => rel(f) === path.join('packages', 'core', 'test', 'tier-single-source.test.ts'),
      ),
    ).toBe(true);
    // ...and so is this file, which holds the controls. Nothing is exempt.
    expect(
      files.some((f) => rel(f) === path.join('packages', 'core', 'test', 'policy.test.ts')),
    ).toBe(true);

    const offenders: string[] = [];
    for (const file of files) {
      const found = bannedNameOccurrences(readFileSync(file, 'utf8'));
      for (const identifier of found.code) offenders.push(`${rel(file)}: identifier ${identifier}`);
      for (const text of found.strings) offenders.push(`${rel(file)}: string "${text}"`);
    }
    expect(
      offenders,
      'A literal "the array is not empty" reading reproduces H-1: Blockscout answers with a ' +
        'non-empty array of contentless entries, and a predicate named after length would accept ' +
        'it and shadow the paid source for the whole TTL. The explanation belongs in prose; the ' +
        'identifier does not exist.',
    ).toStrictEqual([]);
  });

  it('the gate DETECTS each reached form', () => {
    const declaration = `export const ${BANNED_CAMEL} = (r: unknown) => Array.isArray(r);`;
    expect(bannedNameOccurrences(declaration).code, 'export name').not.toStrictEqual([]);

    const alias = `const ${BANNED_CAMEL} = someElementHasAny;`;
    expect(bannedNameOccurrences(alias).code, 'alias').not.toStrictEqual([]);

    const dictionaryKey = `export const policyClasses = { ${BANNED_CAMEL}: () => () => true };`;
    expect(bannedNameOccurrences(dictionaryKey).code, 'dictionary key').not.toStrictEqual([]);

    // Assembled, never written out — see `BANNED`'s docstring for why no control spells the name.
    const pascal = BANNED_CAMEL.charAt(0).toUpperCase() + BANNED_CAMEL.slice(1);
    const typeName = `type ${pascal}Policy = { kind: 2 };`;
    expect(bannedNameOccurrences(typeName).code, 'type name').not.toStrictEqual([]);

    const screaming = `const ${BANNED.slice(0, 3).toUpperCase()}_${BANNED.slice(3).toUpperCase()} = 1;`;
    expect(bannedNameOccurrences(screaming).code, 'separators + casing').not.toStrictEqual([]);

    // The name EMBEDDED in a longer identifier, prefix and suffix at once. The docstring claims
    // `isNonEmptyArray` reduces to something containing the token; this is that claim, asserted —
    // the two controls above only cover a suffix (`…Policy`) and a bare name.
    const embedded = `const is${pascal}Array = (r: unknown[]) => r.length > 0;`;
    expect(bannedNameOccurrences(embedded).code, 'embedded in a longer name').not.toStrictEqual([]);

    const testTitle = `it('${BANNED_CAMEL} is the banned reading', () => {});`;
    expect(bannedNameOccurrences(testTitle).strings, 'test title').not.toStrictEqual([]);

    const quotedKey = `const classes = { '${BANNED_CAMEL}': build };`;
    expect(bannedNameOccurrences(quotedKey).strings, 'quoted key').not.toStrictEqual([]);
  });

  it('the DECLARED LIMITS are real: these forms are NOT reached, and that is written down', () => {
    // The one that MUST stay out of reach: R-134c requires the explanation to exist in prose.
    const prose = `// The class is deliberately not called ${BANNED_CAMEL}: see H-1.\nconst x = 1;`;
    expect(
      bannedNameOccurrences(prose),
      'LIMIT (required): the name in a COMMENT is the explanation the ban depends on',
    ).toStrictEqual({ code: [], strings: [] });

    const assembled = `const key = 'non' + 'Empty';\nconst classes = { [key]: build };`;
    expect(
      bannedNameOccurrences(assembled),
      'LIMIT: a name assembled at runtime — following it would need dataflow, not text',
    ).toStrictEqual({ code: [], strings: [] });

    const synonym = `const notEmpty = (r: unknown[]) => r.length > 0;`;
    expect(
      bannedNameOccurrences(synonym),
      'LIMIT: the ban is on the NAME, not on every synonym for it',
    ).toStrictEqual({ code: [], strings: [] });

    // Out of scope by BOUNDARY, and measured rather than assumed: the eval harness really does
    // declare a helper by that name, and it is not scanned.
    //
    // The pointer moved in TASK-013a: the helper lived in `eval/checks.mjs` while every per-tool
    // assertion sat in that one file. Splitting the assertions into `eval/cases/` made the helper
    // shared, so it moved to `eval/case-lib.mjs` — and this test failed on the move, which is the
    // mechanism working. The assertion below is what makes the exemption non-vacuous, so it must
    // keep pointing at a file that genuinely declares the banned name; if the helper moves again,
    // repoint it rather than deleting the check.
    const evalHelper = path.join(repoRoot, 'packages/mcp-server/eval/case-lib.mjs');
    expect(existsSync(evalHelper)).toBe(true);
    expect(
      bannedNameOccurrences(readFileSync(evalHelper, 'utf8')).code,
      'the eval helper exists and WOULD be flagged — it is out of the declared scope, not clean',
    ).not.toStrictEqual([]);
    expect(scannedFiles().some((f) => f === evalHelper)).toBe(false);
  });

  it('the two views are separated the way the ban requires', () => {
    // A single-view scanner is the failure this design exists to avoid: it would either flag the
    // mandatory explanation or miss the identifier. Asserted directly, on one input carrying both.
    const both = `// prose about ${BANNED_CAMEL} stays\nexport const ${BANNED_CAMEL} = () => true;`;
    const found = bannedNameOccurrences(both);
    expect(found.code).toStrictEqual([BANNED_CAMEL]);
    expect(found.strings).toStrictEqual([]);
  });

  it('the same-line rule keeps a regex from swallowing the file', () => {
    // Without it, the apostrophe inside this regex opens a "string" that runs to the end of the
    // source, hiding the declaration below it from the code view.
    const withRegex = `const hasCase = /case\\s*(?:'|")/.test(body);\nexport const ${BANNED_CAMEL} = 1;`;
    expect(bannedNameOccurrences(withRegex).code).toStrictEqual([BANNED_CAMEL]);
  });
});

// =============================================================================================
// TC-INT-01 / TC-INT-02 / TC-INT-03 — validation step 2, and its position after step 1
// =============================================================================================

/** A `kind` no class implements — the shape a cast, a JSON config or a hand edit can produce. */
const BOGUS_POLICY = { kind: 'bogus' } as unknown as PolicyDescriptor;

describe('TC-INT-01 — an unregistered `kind` fails CONSTRUCTION, before any resolve()', () => {
  const ROUTES: CapabilityRoute[] = [
    { capability: 'legacy.thing', adapterIds: ['free'], policy: BOGUS_POLICY },
  ];

  it('throws UnregisteredPolicyClassError naming both the capability and the kind', () => {
    let thrown: unknown;
    try {
      new CapabilityRegistry(
        ROUTES,
        new Map([['free', spyAdapter('free', []).adapter]]),
        undefined,
        null,
        MANIFESTS,
      );
      expect.unreachable('a route naming an unknown policy class must not build a registry');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(UnregisteredPolicyClassError);
    expect((thrown as UnregisteredPolicyClassError).capability).toBe('legacy.thing');
    expect((thrown as UnregisteredPolicyClassError).kind).toBe('bogus');
    // Both halves in the MESSAGE, not merely on the object: the message is what an operator reads.
    expect((thrown as Error).message).toContain('legacy.thing');
    expect((thrown as Error).message).toContain('bogus');
  });

  it('the failure is the CONSTRUCTOR, not a lazy check inside resolve()', () => {
    // A lazy implementation would let this expression produce an instance and only fail on a call
    // — which is UC-2's failure mode: weeks after the deploy, for one capability, in production.
    expect(
      () =>
        new CapabilityRegistry(
          ROUTES,
          new Map([['free', spyAdapter('free', []).adapter]]),
          undefined,
          null,
          MANIFESTS,
        ),
    ).toThrow(UnregisteredPolicyClassError);
  });
});

describe('TC-INT-02 — the step order is manifest FIRST, policy class second', () => {
  it('a route broken BOTH ways reports the missing manifest, not the unknown kind', () => {
    // What lets every other negative test break exactly one thing. Fed an empty manifest map, so
    // step 1 has something to fail on, and a bogus `kind`, so step 2 does too.
    let thrown: unknown;
    try {
      new CapabilityRegistry(
        [{ capability: 'legacy.thing', adapterIds: ['free'], policy: BOGUS_POLICY }],
        new Map([['free', spyAdapter('free', []).adapter]]),
        undefined,
        null,
        {},
      );
      expect.unreachable('a route with neither a manifest nor a known policy class must not build');
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(MissingCapabilityManifestError);
    expect(thrown).not.toBeInstanceOf(UnregisteredPolicyClassError);
  });

  it('the order holds when the BROKEN routes are in the other sequence', () => {
    // Two loops, not one: with a single loop the order would hold per ROUTE, so a table whose
    // policy-broken route comes first would report the policy error instead. This is the input on
    // which "two conditions in one loop" and "two loops" differ.
    expect(
      () =>
        new CapabilityRegistry(
          [
            { capability: 'legacy.thing', adapterIds: ['free'], policy: BOGUS_POLICY },
            { capability: 'unmanifested.thing', adapterIds: ['free'] },
          ],
          new Map([['free', spyAdapter('free', []).adapter]]),
          undefined,
          null,
          MANIFESTS,
        ),
    ).toThrow(MissingCapabilityManifestError);
  });
});

describe('TC-INT-03 — the real route table validates, and carries exactly one descriptor', () => {
  it('constructs without throwing', () => {
    expect(() => new CapabilityRegistry(routes, new Map())).not.toThrow();
    expect(routes).toHaveLength(27);
  });

  it('`entity.labels` is the only route with a policy, and it is the converted one', () => {
    // Named, not counted: a table with one policy on the WRONG route would pass a count.
    const carriers = routes
      .filter((route) => route.policy !== undefined)
      .map((route) => [route.capability, route.policy] as const);
    expect(carriers).toStrictEqual([['entity.labels', ENTITY_LABELS_POLICY]]);
  });

  it('every declared `kind` resolves against the class dictionary', () => {
    const kinds = [
      ...new Set(routes.flatMap((route) => (route.policy ? [route.policy.kind] : []))),
    ];
    expect(kinds).toStrictEqual(['someElementHasAny']);
    expect(Object.keys(policyClasses).sort()).toStrictEqual(['any', 'someElementHasAny']);
  });
});

// =============================================================================================
// TC-INT-05 — the resolved predicate judges CACHE HITS as well as fresh results
// =============================================================================================

describe('TC-INT-05 — the policy applies to a cache hit exactly as to a fresh answer', () => {
  it('a cached contentless answer does not win the second call either', async () => {
    // H-1's other half: a policy applied only to fresh results lets the shadowing come back through
    // the cache the moment the first empty answer is stored — and stored answers outlive the
    // deploy that fixed the code.
    const free = spyAdapter('free', [{ labels: [] }]);
    const paid = spyAdapter('paid', [{ labels: ['Binance: Hot Wallet'] }]);
    const registry = new CapabilityRegistry(
      [
        {
          capability: 'legacy.thing',
          adapterIds: ['free', 'paid'],
          policy: { kind: 'someElementHasAny', fields: ['labels'] },
        },
      ],
      new Map([
        ['free', free.adapter],
        ['paid', paid.adapter],
      ]),
      new MemoryCacheStore(),
      null,
      MANIFESTS,
    );

    const first = await registry.resolve('legacy.thing', 'ethereum', {});
    expect(first.source).toBe('paid');
    expect(first.cache).toBe('miss');

    const second = await registry.resolve('legacy.thing', 'ethereum', {});
    expect(second.source, 'a cached contentless answer terminated the route').toBe('paid');
    expect(second.cache, 'the paid answer came from cache, so nothing was re-fetched').toBe('hit');
    expect(paid.calls, 'the paid provider was asked twice for the same question').toStrictEqual([
      'legacy.thing',
    ]);
  });
});

// =============================================================================================
// TC-F8 — adversarial cycle 2, F-8: a `kind` spelled like an `Object.prototype` member
// =============================================================================================

/**
 * `policyClasses` is a plain object literal, so `policyClasses['constructor']` answers with `Object`
 * and `['toString']`/`['valueOf']`/`['hasOwnProperty']` with their prototype members. Validation
 * step 2 read that lookup with `=== undefined`, so such a `kind` RESOLVED:
 * `UnregisteredPolicyClassError` never fired, `build(descriptor)` became `Object({kind:'…'})` — a
 * truthy object — and the route's predicate then said "satisfying" about every answer it was ever
 * shown. That is H-1's shadowing (a contentless free answer ending the walk before the paid source)
 * re-enabled by a NAME, without one line of policy code being wrong.
 *
 * `kind` is exactly the field the class dictionary's own docstring says can arrive "from a cast, a
 * JSON-shaped config or a hand-edited table" — the three sources that can carry these strings.
 */
describe('TC-F8-INT — a prototype-named policy `kind` is UNREGISTERED, not resolved', () => {
  const PROTOTYPE_KINDS = ['constructor', 'toString', 'valueOf', 'hasOwnProperty'] as const;

  it.each(PROTOTYPE_KINDS)('%s fails construction like any other unknown kind', (kind) => {
    const descriptor = { kind } as unknown as PolicyDescriptor;
    let thrown: unknown;
    try {
      new CapabilityRegistry(
        [{ capability: 'legacy.thing', adapterIds: ['free'], policy: descriptor }],
        new Map([['free', spyAdapter('free', []).adapter]]),
        undefined,
        null,
        MANIFESTS,
      );
      expect.unreachable(`a route naming policy class '${kind}' must not build a registry`);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(UnregisteredPolicyClassError);
    expect((thrown as UnregisteredPolicyClassError).kind).toBe(kind);
  });

  it('the two REAL classes still resolve — the guard rejects inherited keys, not own ones', () => {
    // Sign of work: `Object.hasOwn` applied to the wrong operand would reject `any` and
    // `someElementHasAny` too, and this is the input that says so.
    for (const kind of Object.keys(policyClasses)) {
      expect(
        () =>
          new CapabilityRegistry(
            [
              {
                capability: 'legacy.thing',
                adapterIds: ['free'],
                policy: { kind, fields: ['name'] } as unknown as PolicyDescriptor,
              },
            ],
            new Map([['free', spyAdapter('free', []).adapter]]),
            undefined,
            null,
            MANIFESTS,
          ),
        kind,
      ).not.toThrow();
    }
    expect(Object.keys(policyClasses)).toStrictEqual(['any', 'someElementHasAny']);
  });
});
