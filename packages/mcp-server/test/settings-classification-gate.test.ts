import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { EnvSchema } from '../src/env.js';
import {
  OBLIGATIONS,
  OBLIGATIONS_OF_EDITING_WITHOUT_A_RELEASE,
  SETTING_CLASSES,
  SETTING_CLASSES_DECLARED,
  SettingsClassificationError,
  buildSettingsRegistry,
  classificationDefects,
  mayLiveInPostgres,
  type Obligation,
  type SettingClass,
} from '../src/settings-classification.js';

/**
 * Task 014-05 — the settings-classification gate (AC-44, `deployment.md` §10.2.1 item 2).
 *
 * Input: the properties of `EnvSchema` and the table of §10.3. Postcondition: every key carries
 * exactly one class, the class agrees with the document, and a key absent from the table fails the
 * step.
 *
 * **What this gate is for, in one sentence.** It decides which settings may EVER move into a store
 * that is editable without a release — and a widening setting in such a store is a
 * privilege-escalation path through a database write, not an untidy configuration.
 *
 * **Why the document is read rather than trusted.** §10.3's table is what a person edits when they
 * change their mind about a setting; the registry is what the code acts on. Two answers to one
 * question is the shape this repository keeps paying for, so the gate's job is to make them one.
 */

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

/**
 * The §10.3 table, parsed from the architecture document.
 *
 * **Scoped to §10.3 and not the whole file.** §10.3.1 carries a SECOND table whose first column is a
 * list of column names rather than an environment key (`credits_balance`, `rate_limit`, …) — those
 * are narrowing settings whose carrier is not `.env` at all. A whole-file scan would read them as
 * environment keys and demand `EnvSchema` declare them.
 */
function documentedClasses(): Map<string, SettingClass> {
  const deployment = readFileSync(path.join(repoRoot, 'docs/architectures/deployment.md'), 'utf8');
  const start = deployment.indexOf('### 10.3. Configuration');
  const end = deployment.indexOf('#### 10.3.1.');
  expect(start, 'the §10.3 heading moved — this gate would read the wrong section').toBeGreaterThan(
    0,
  );
  expect(end, 'the §10.3.1 heading moved').toBeGreaterThan(start);

  const section = deployment.slice(start, end);
  const rows = [
    ...section.matchAll(/^\|\s*`([A-Z][A-Z0-9_]*)`\s*\|\s*(secret|bootstrap|narrowing)\s*\|/gm),
  ];
  return new Map(rows.map((row) => [row[1] as string, row[2] as SettingClass]));
}

const documented = documentedClasses();
const schemaKeys = Object.keys(EnvSchema.shape).sort();

describe('AC-44 — every setting carries exactly one class, and the document agrees', () => {
  it('parses the §10.3 table at all', () => {
    // Vacuity guard: every assertion below is "these sets agree", and an empty parse agrees with
    // nothing while reporting nothing. Anchored on two keys from different milestones.
    expect(documented.get('LOG_LEVEL')).toBe('narrowing');
    expect(documented.get('ONCHAIN_TOKEN_HASH_SALT')).toBe('secret');
    expect(documented.size).toBeGreaterThanOrEqual(schemaKeys.length);
  });

  it('classifies every key of EnvSchema, and classifies nothing else', () => {
    // The type `Record<keyof Env, SettingClass>` already makes both directions a compile error. This
    // says the same thing at runtime, because a compile error names a type and this names a key.
    expect(Object.keys(SETTING_CLASSES).sort()).toStrictEqual(schemaKeys);
  });

  it('a key absent from the §10.3 table fails the step', () => {
    const absent = schemaKeys.filter((key) => !documented.has(key));
    expect(
      absent,
      'these keys are declared in EnvSchema and appear in no row of deployment.md §10.3. A setting ' +
        'whose class is undocumented has no rule the gate can apply: ' +
        absent.join(', '),
    ).toStrictEqual([]);
  });

  it('the class in the code is the class in the document, key by key', () => {
    const disagreements = schemaKeys
      .filter((key) => documented.get(key) !== SETTING_CLASSES[key as keyof typeof SETTING_CLASSES])
      .map(
        (key) =>
          `${key}: §10.3 says ${String(documented.get(key))}, the registry says ${String(SETTING_CLASSES[key as keyof typeof SETTING_CLASSES])}`,
      );
    expect(disagreements).toStrictEqual([]);
  });

  it('documents no class outside the three §10.3.1 declares', () => {
    for (const value of documented.values()) {
      expect(SETTING_CLASSES_DECLARED).toContain(value);
    }
  });
});

describe('what each class means for a store editable without a release', () => {
  it('TC-UNIT-01: a secret may not be read from Postgres', () => {
    expect(mayLiveInPostgres('secret')).toBe(false);
    // The registry-level statement of the same rule: declaring a vendor key narrowing is a defect,
    // not a preference. This is AC-44's first half, exercised on the rule rather than on the tree.
    const broken = { ...SETTING_CLASSES, NANSEN_API_KEY: 'narrowing' as SettingClass };
    const defects = disagreementsWithDocument(broken);
    expect(defects.join(' ')).toContain('NANSEN_API_KEY');
  });

  it('TC-UNIT-02: a bootstrap setting may not be read from Postgres', () => {
    expect(mayLiveInPostgres('bootstrap')).toBe(false);
    // The connection setting cannot be read from the connection. `ONCHAIN_PG_URL` is the plainest
    // case; `ONCHAIN_STATE_PG_URL` is the one T-014 adds, and both are bootstrap for that reason.
    const broken = { ...SETTING_CLASSES, ONCHAIN_PG_URL: 'narrowing' as SettingClass };
    expect(disagreementsWithDocument(broken).join(' ')).toContain('ONCHAIN_PG_URL');
  });

  it('only a narrowing setting may move (R-29.4)', () => {
    expect(mayLiveInPostgres('narrowing')).toBe(true);
    expect(SETTING_CLASSES_DECLARED.filter(mayLiveInPostgres)).toStrictEqual(['narrowing']);
  });

  it('the perimeter keys are bootstrap, and that is the whole of R-29.3', () => {
    // Adding an `Origin` or a `Host` ADMITS a caller who was refused before the edit, so they fail
    // the narrowing test — every admissible value must only restrict.
    expect(SETTING_CLASSES.ONCHAIN_ALLOWED_HOSTS).toBe('bootstrap');
    expect(SETTING_CLASSES.ONCHAIN_ALLOWED_ORIGINS).toBe('bootstrap');
    expect(SETTING_CLASSES.ONCHAIN_SESSION_MAX).toBe('bootstrap');
    expect(SETTING_CLASSES.ONCHAIN_SESSION_IDLE_MS).toBe('bootstrap');
  });

  it('T-014 adds no narrowing environment key', () => {
    // §10.3.1 states it, and this measures it: every narrowing key in the registry predates T-014.
    const T014_KEYS = schemaKeys.filter(
      (key) => key.startsWith('ONCHAIN_') && key !== 'ONCHAIN_PG_URL',
    );
    const narrowing = T014_KEYS.filter(
      (key) => SETTING_CLASSES[key as keyof typeof SETTING_CLASSES] === 'narrowing',
    );
    expect(
      narrowing,
      'a narrowing environment key would need a carrier named in §10.3.1, and T-014 declares none',
    ).toStrictEqual([]);
  });
});

describe('R-29.5 — the obligations of editing without a release, and where they attach', () => {
  it('TC-UNIT-04: all three are declared for narrowing and for neither other class', () => {
    expect([...OBLIGATIONS.narrowing].sort()).toStrictEqual(
      [...OBLIGATIONS_OF_EDITING_WITHOUT_A_RELEASE].sort(),
    );
    expect(OBLIGATIONS.secret).toStrictEqual([]);
    expect(OBLIGATIONS.bootstrap).toStrictEqual([]);
    expect(OBLIGATIONS_OF_EDITING_WITHOUT_A_RELEASE).toHaveLength(3);
  });

  it('TC-UNIT-05: an obligation attributed to a non-narrowing class fails the registry build', () => {
    const wrong: Record<SettingClass, readonly Obligation[]> = {
      ...OBLIGATIONS,
      bootstrap: ['changeLog'],
    };
    expect(() => buildSettingsRegistry(SETTING_CLASSES, wrong)).toThrow(
      SettingsClassificationError,
    );
    // And the refusal NAMES the class, because a message that says only "inconsistent" leaves the
    // reader to find which of three it was.
    expect(() => buildSettingsRegistry(SETTING_CLASSES, wrong)).toThrow(/bootstrap/);
  });

  it('a narrowing class missing an obligation fails the same way', () => {
    // The other direction: the promise is that all three hold, so declaring two is not "mostly".
    const thin: Record<SettingClass, readonly Obligation[]> = {
      ...OBLIGATIONS,
      narrowing: ['changeLog', 'rollback'],
    };
    expect(() => buildSettingsRegistry(SETTING_CLASSES, thin)).toThrow(/validateOnPublish/);
  });

  it('TC-UNIT-03: a class outside the three fails the registry build', () => {
    const invented = { ...SETTING_CLASSES, LOG_LEVEL: 'perimeter' as unknown as SettingClass };
    expect(() => buildSettingsRegistry(invented)).toThrow(SettingsClassificationError);
    expect(() => buildSettingsRegistry(invented)).toThrow(/LOG_LEVEL/);
  });

  it('the real registry builds — the checks above are not passing on a broken one', () => {
    expect(classificationDefects(SETTING_CLASSES, OBLIGATIONS)).toStrictEqual([]);
    expect(() => buildSettingsRegistry(SETTING_CLASSES)).not.toThrow();
  });
});

/**
 * The document comparison, over an arbitrary registry — the seam that lets the two AC-44 cases be
 * shown red without editing the source they check.
 */
function disagreementsWithDocument(classes: Readonly<Record<string, SettingClass>>): string[] {
  return Object.entries(classes)
    .filter(([key, settingClass]) => documented.has(key) && documented.get(key) !== settingClass)
    .map(
      ([key, settingClass]) =>
        `${key}: §10.3 says ${String(documented.get(key))}, given ${settingClass}`,
    );
}
