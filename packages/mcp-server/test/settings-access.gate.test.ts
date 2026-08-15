import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Task 014-04 — R-13.3a: no consumer reads a setting from where it is stored.
 *
 * Every consumer receives a profile value through `AccessProfileReader`, and a process setting
 * through `EnvSchema` (`security.md` §7.5.3a, `deployment.md` §10.3). Two rules, and the same reason
 * behind both: a settings value read in a second place is a second answer, and the two disagree the
 * first time one of them is edited.
 *
 * **Why a static check and not review.** §7.3 already names code review the weakest of its three
 * controls, and a direct read is a one-line change. This check runs inside `pnpm test`, which
 * §10.2 already has in the pipeline.
 *
 * **What it found on its first run.** Two direct `process.env` reads in `src/index.ts`, introduced
 * by task 014-38 five commits earlier, resolving the deployment profile from the RAW environment and
 * so skipping the schema for the two keys that decide the deployment. The gate's value is that class:
 * a correct-looking line, in a file nobody was reviewing for this, that no other test could see.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/** The input `security.md` §7.5.3a names, and both packages for the reason §10.2.1 gives. */
const SCANNED_PACKAGES = ['packages/core/src', 'packages/mcp-server/src'] as const;

const sourceFiles = (dir: string): string[] =>
  readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return full.endsWith('.ts') ? [full] : [];
  });

/**
 * The file's code, with comments removed.
 *
 * Not a convenience: of the twenty `process.env` occurrences measured across both packages on
 * 2026-08-13, TEN were in prose — including this project's own explanations of why the rule exists.
 * A check that read them would make the rule unstatable in the documents that state it.
 */
const codeOnly = (body: string): string =>
  body
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !line.trimStart().startsWith('//'))
    .join('\n');

interface Occurrence {
  readonly file: string;
  readonly line: number;
  readonly text: string;
}

const scan = (test: (line: string) => boolean): Occurrence[] => {
  const found: Occurrence[] = [];
  for (const root of SCANNED_PACKAGES) {
    for (const file of sourceFiles(path.join(repoRoot, root))) {
      const relative = path.relative(repoRoot, file);
      codeOnly(readFileSync(file, 'utf8'))
        .split('\n')
        .forEach((text, index) => {
          if (test(text)) found.push({ file: relative, line: index + 1, text: text.trim() });
        });
    }
  }
  return found;
};

const render = (found: readonly Occurrence[]): string[] =>
  found.map((o) => `${o.file}:${o.line} → ${o.text}`);

/* ------------------------------------------------------------------------------------------------
 * Rule 1 — `process.env` outside `env.ts` and outside the two injection forms.
 * ---------------------------------------------------------------------------------------------- */

/**
 * The two sanctioned forms, transcribed from the measurement table of §7.5.3a.
 *
 * Both are INJECTION with a fallback: the value arrives as a parameter and the process environment
 * is what the parameter defaults to. That is what makes every one of these call sites testable
 * without mutating the process, which is the property the rule is really protecting.
 *
 * A bare `process.env.KEY` matches neither, and neither does `resolveProfile(process.env)` — a
 * function CALL that hands the raw environment onward. That third form is what the gate caught.
 */
const INJECTION_FORMS: readonly { name: string; pattern: RegExp }[] = [
  { name: 'deps.env ?? process.env', pattern: /\?\?\s*process\.env\b/ },
  { name: 'a default parameter', pattern: /:\s*NodeJS\.ProcessEnv\s*=\s*process\.env\b/ },
];

/** `env.ts` is where the environment is parsed; the parse itself is the one read that must exist. */
const SCHEMA_FILE = 'packages/mcp-server/src/env.ts';

describe('R-13.3a rule 1 — the environment is injected, never read in place', () => {
  it('finds no direct process.env read outside env.ts and the two injection forms', () => {
    const offenders = scan(
      (line) =>
        /\bprocess\.env\b/.test(line) && !INJECTION_FORMS.some((form) => form.pattern.test(line)),
    ).filter((o) => o.file !== SCHEMA_FILE);
    expect(
      render(offenders),
      'a consumer reading the environment directly bypasses EnvSchema — its validation, its ' +
        'refusals and its "name the key, never the value" contract',
    ).toStrictEqual([]);
  });

  it('is not vacuous: the sanctioned forms are present and counted', () => {
    // If the patterns above ever stopped matching, the check would report an empty offender list
    // while reading nothing — the shape of a gate that passes because it looks at nothing.
    const injected = scan((line) => INJECTION_FORMS.some((form) => form.pattern.test(line)));
    expect(injected.length).toBeGreaterThanOrEqual(9);
    expect(render(injected).join('\n')).toContain('packages/core/src/cache/data-dir.ts');
  });

  it('TC-UNIT-07: a direct read introduced anywhere would be caught', () => {
    const isOffender = (line: string): boolean =>
      /\bprocess\.env\b/.test(line) && !INJECTION_FORMS.some((form) => form.pattern.test(line));
    expect(isOffender('const key = process.env.NANSEN_API_KEY;')).toBe(true);
    expect(isOffender('const profile = resolveProfile(process.env);')).toBe(true);
    expect(isOffender('const env = deps.env ?? process.env;')).toBe(false);
    expect(isOffender('export function f(env: NodeJS.ProcessEnv = process.env): void {}')).toBe(
      false,
    );
  });

  it('reads code, not prose — the rule must stay statable in the files that state it', () => {
    const commented = codeOnly(
      [
        '// a comment naming process.env.SECRET',
        '/** process.env in a docstring */',
        'const a = 1;',
      ].join('\n'),
    );
    expect(commented).not.toContain('process.env');
  });
});

/* ------------------------------------------------------------------------------------------------
 * Rule 2 — the seven profile field names, read outside the declaration, its suppliers and the
 * application points §7.5.3a names.
 * ---------------------------------------------------------------------------------------------- */

/**
 * The seven names, spelled here because this is the check that counts them.
 *
 * Deriving them from the interface at runtime is impossible — TypeScript types do not exist at
 * runtime — so the list is asserted against the declaration's own text below, which turns "I wrote
 * seven names" into a measurement.
 */
const PROFILE_FIELDS = [
  'creditsMode',
  'creditsBalanceRaw',
  'rateLimitMode',
  'rateLimitPerMin',
  'toolAllowlistMode',
  'toolAllowlist',
  'routeDisclosureMode',
] as const;

/**
 * Where a profile field may be read, and who owns each exemption.
 *
 * **Why the list carries an owner and a status rather than being a bare set of paths.** This is the
 * `PreStartCheck` pattern of `profile.ts`: an entry that exempts nothing yet must SAY so and name
 * the task that will make it real, because a suppression list nobody re-reads is where a gate goes
 * to die. The test below reports every entry that matches no file, so an exemption cannot outlive
 * the code it was written for, and an entry for code that has not landed cannot be mistaken for one
 * in force.
 */
interface Exemption {
  readonly file: string;
  readonly why: string;
  readonly owner: string;
  /** `false` while the file it names does not read a field yet — a stated gap, not a silent one. */
  readonly active: boolean;
}

const EXEMPTIONS: readonly Exemption[] = [
  {
    file: 'packages/mcp-server/src/auth/access-profile.ts',
    why: 'declares the seven fields',
    owner: 'task 014-04',
    active: true,
  },
  {
    file: 'packages/mcp-server/src/auth/default-access-profile.ts',
    why: 'the phase-0 supplier',
    owner: 'task 014-04',
    active: true,
  },
  {
    file: 'packages/mcp-server/src/auth/access-profile-store.ts',
    why: 'the table-backed supplier, for whose sake the reader is asynchronous',
    owner: 'task 014-02',
    active: true,
  },
  {
    file: 'packages/mcp-server/src/server.ts',
    why: 'the tool-registration loop applies `toolAllowlist` (§3.4.9) — one of the two named points',
    owner: 'task 014-04',
    active: true,
  },
  {
    file: 'packages/mcp-server/src/tools/registry.ts',
    // §7.5.3 names `toCallToolResult` as the point of application; the READ is one function above it,
    // in `defineTool`'s wrapper, because `toCallToolResult` is synchronous and
    // `AccessProfileReader.read` returns a promise. The value is passed down beside the principal.
    // The exemption is file-scoped, so the distinction does not move it — but it is stated here
    // rather than left for someone to rediscover from a doc sentence that cannot be implemented.
    why: '`toCallToolResult` applies `routeDisclosureMode` (§7.5.3) — the other named point',
    owner: 'task 014-16',
    active: true,
  },
  {
    file: 'packages/mcp-server/src/tools/meta-visibility.ts',
    // **Not a second reader, and the distinction is the whole point of the rule.** This module
    // never touches a supplier: it takes `routeDisclosureMode` as a parameter of `MetaView` and
    // applies it. `toCallToolResult` — the point §7.5.3 names — is two lines of delegation to it,
    // because one compiled visibility table cannot live inside the function that consults it. The
    // gate matches the field NAME textually, which is what makes it able to catch a real second
    // reader; this entry is what keeps that strictness from costing the split.
    why: 'applies `routeDisclosureMode` handed to it as a parameter; reads no supplier (§5.4.4)',
    owner: 'task 014-16',
    active: true,
  },
];

const EXEMPT_FILES = new Set(EXEMPTIONS.map((entry) => entry.file));

const fieldReads = (): Occurrence[] =>
  scan((line) =>
    PROFILE_FIELDS.some((field) => new RegExp(String.raw`\b${field}\b`).test(line)),
  ).filter((o) => !EXEMPT_FILES.has(o.file));

describe('R-13.3a rule 2 — one reader per setting', () => {
  it('the seven names are the seven the declaration carries', () => {
    // The list above is hand-written because types vanish at runtime. This is what keeps it honest:
    // an eighth field added to the interface without being added here would leave the gate blind to
    // it, and the failure would read as "no second reader found".
    const declaration = readFileSync(
      path.join(repoRoot, 'packages/mcp-server/src/auth/access-profile.ts'),
      'utf8',
    );
    const declared = [...declaration.matchAll(/^\s{2}readonly\s+(\w+)\s*[:?]/gm)].map(
      (m) => m[1] as string,
    );
    expect(declared.sort()).toStrictEqual([...PROFILE_FIELDS].sort());
  });

  it('finds no second reader of a profile field', () => {
    expect(
      render(fieldReads()),
      'a profile field read outside the reader, its suppliers and the two application points ' +
        '§7.5.3a names. Apply the value where the architecture places it, or add the file to ' +
        'EXEMPTIONS with the requirement that puts it there.',
    ).toStrictEqual([]);
  });

  it('TC-UNIT-08 / TC-UNIT-11: green at a named point, red in a third file', () => {
    const reads = (file: string, line: string): boolean =>
      PROFILE_FIELDS.some((field) => new RegExp(String.raw`\b${field}\b`).test(line)) &&
      !EXEMPT_FILES.has(file);
    // The two named application points.
    expect(
      reads('packages/mcp-server/src/server.ts', 'profile.toolAllowlistMode === ' + "'list'"),
      'the registration loop applies the tool list',
    ).toBe(false);
    expect(
      reads('packages/mcp-server/src/tools/registry.ts', 'if (profile.routeDisclosureMode ==='),
      '`toCallToolResult` applies route disclosure',
    ).toBe(false);
    // A third file reading the same field.
    expect(
      reads('packages/mcp-server/src/tools/ping.ts', 'const mode = profile.creditsMode;'),
    ).toBe(true);
    expect(reads('packages/core/src/cache/sqlite-store.ts', 'profile.toolAllowlist.length')).toBe(
      true,
    );
  });

  it('every exemption is in force or names the task that makes it so', () => {
    // An exemption whose file has no field read is either stale or early. Both are reportable
    // states, and the difference is exactly the `active` flag — set by hand, so it is a claim
    // somebody made rather than a fact nobody checked.
    const readsField = (file: string): boolean => {
      const full = path.join(repoRoot, file);
      const body = codeOnly(readFileSync(full, 'utf8'));
      return PROFILE_FIELDS.some((field) => new RegExp(String.raw`\b${field}\b`).test(body));
    };
    const wrong = EXEMPTIONS.filter((entry) => readsField(entry.file) !== entry.active).map(
      (entry) =>
        `${entry.file}: declared active=${entry.active}, measured=${readsField(entry.file)} ` +
        `(owner: ${entry.owner})`,
    );
    expect(
      wrong,
      'an exemption disagrees with the tree. An inactive one whose file now reads a field must be ' +
        'marked active; an active one that reads none is a suppression outliving its cause.',
    ).toStrictEqual([]);
  });

  it('names an owner and a reason for every exemption', () => {
    for (const entry of EXEMPTIONS) {
      expect(entry.why.length, entry.file).toBeGreaterThan(0);
      expect(entry.owner, entry.file).toMatch(/^task \d{3}-\d{2}$/);
      expect(statSync(path.join(repoRoot, entry.file)).isFile(), entry.file).toBe(true);
    }
  });
});
