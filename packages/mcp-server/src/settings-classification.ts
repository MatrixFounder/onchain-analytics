import type { Env } from './env.js';

/**
 * Task 014-05 — every setting classified by WHERE it is allowed to live (R-29, `deployment.md`
 * §10.3.1).
 *
 * Three classes, and two different reasons for a setting to stay in `.env`.
 *
 * - **secret** — a credential, or a value that authorises a call. Canon D10 and the `ADR-002` D1
 *   invariant: keys and authorisation styles never enter a store that is editable without a release.
 * - **bootstrap** — a value the process needs before the settings store is reachable. By
 *   impossibility: the Postgres connection setting cannot be read from Postgres.
 * - **narrowing** — a value whose every admissible setting RESTRICTS what the engine does. May move
 *   to Postgres later (R-29.4), because a value that can only narrow cannot widen access when it is
 *   edited — the test of `ADR-002` §8.5.
 *
 * **Why the class matters more than it looks.** A widening setting in a store that is editable
 * without a release is a privilege-escalation path through a database write. The classification is
 * what makes "which settings may move" a decided question rather than a judgement call at the moment
 * somebody wants one to move.
 *
 * **Why three and not four.** §10.3.1 declares exactly `secret`, `bootstrap` and `narrowing`. A
 * fourth class in this registry would be a setting for which the gate knows no rule from the
 * architecture — and a rule the gate does not know is a rule nothing enforces.
 *
 * **Why this file and not `env.ts`.** The registry classifies the properties of `EnvSchema`, and a
 * mark written beside each field there would be a second copy of this table: two places to answer
 * one question, disagreeing the first time one of them is edited. The mark IS this record, and its
 * type makes an unclassified field a compile error rather than a review finding.
 */

export type SettingClass = 'secret' | 'bootstrap' | 'narrowing';

export const SETTING_CLASSES_DECLARED: readonly SettingClass[] = [
  'secret',
  'bootstrap',
  'narrowing',
];

/**
 * The three obligations of editing a setting without a release (R-29.5).
 *
 * They exist because a setting that can be changed while the process runs has no release to carry
 * its review, its record and its undo. They attach to the narrowing class ALONE — the other two
 * classes never move out of `.env`, so there is no edit-without-release for them to govern, and
 * declaring the obligations there would state a promise about a path that does not exist.
 */
export type Obligation = 'validateOnPublish' | 'changeLog' | 'rollback';

export const OBLIGATIONS_OF_EDITING_WITHOUT_A_RELEASE: readonly Obligation[] = [
  'validateOnPublish',
  'changeLog',
  'rollback',
];

export const OBLIGATIONS: Readonly<Record<SettingClass, readonly Obligation[]>> = Object.freeze({
  secret: [],
  bootstrap: [],
  narrowing: OBLIGATIONS_OF_EDITING_WITHOUT_A_RELEASE,
});

/**
 * Thrown when the registry itself is inconsistent — at module load, so it cannot be worked around.
 *
 * "The registry does not build" is the postcondition tasks 014-05's TC-UNIT-03 and TC-UNIT-05 ask
 * for, and this is what makes it literal rather than a phrase in a document.
 */
export class SettingsClassificationError extends Error {
  constructor(readonly defects: readonly string[]) {
    super(`settings classification is inconsistent:\n  ${defects.join('\n  ')}`);
    this.name = 'SettingsClassificationError';
  }
}

/**
 * Every key of `EnvSchema`, with the class `deployment.md` §10.3 gives it.
 *
 * **`Record<keyof Env, SettingClass>` is the enforcement.** A key added to the schema and not to
 * this table fails `tsc` with the key named; a key removed from the schema and left here fails the
 * same way. Neither can reach a review, which is where §7.3 says this kind of thing is caught least
 * reliably.
 *
 * **Perimeter keys are bootstrap, not narrowing** (R-29.3). Adding an `Origin` or a `Host` admits a
 * caller who was refused before the edit, so they fail the narrowing test — every admissible value
 * must only restrict — and they never move to an editable store.
 *
 * **Session keys are bootstrap** for the same test: they are transport construction parameters read
 * before the first session exists, and raising either widens what the process accepts. This is where
 * `system-architecture.md` §3.4.2 and `deployment.md` §10.3 disagreed; §10.3 is taken, and task
 * 014-40's notes record why.
 *
 * **The three Nansen brakes are narrowing** even though they are numbers an operator picks: each may
 * only lower the ceiling that is already in force (`effectiveCeilingFor`), never raise it above the
 * vendor's own remainder. That is the ADR-002 §8.5 test met exactly.
 */
export const SETTING_CLASSES: Readonly<Record<keyof Env, SettingClass>> = Object.freeze({
  LOG_LEVEL: 'narrowing',
  COINGECKO_API_KEY: 'secret',
  COINGECKO_PRO_API_KEY: 'secret',
  DUNE_API_KEY: 'secret',
  BLOCKSCOUT_PRO_API_KEY: 'secret',
  NANSEN_API_KEY: 'secret',
  ONCHAIN_PG_URL: 'bootstrap',
  DATA_DIR: 'bootstrap',
  NANSEN_DAILY_CREDIT_CAP: 'narrowing',
  NANSEN_VELOCITY_CREDITS_PER_MIN: 'narrowing',
  NANSEN_MAX_CALLS_PER_MIN: 'narrowing',
  NANSEN_BUDGET_WARN_RATIO: 'narrowing',
  ONCHAIN_PROFILE: 'bootstrap',
  ONCHAIN_STATE_PG_URL: 'bootstrap',
  ONCHAIN_HTTP_BIND: 'bootstrap',
  ONCHAIN_HTTP_PORT: 'bootstrap',
  ONCHAIN_HTTP_RESPONSE_TIMEOUT_MS: 'bootstrap',
  ONCHAIN_ALLOWED_HOSTS: 'bootstrap',
  ONCHAIN_ALLOWED_ORIGINS: 'bootstrap',
  ONCHAIN_TOKEN_HASH_SALT: 'secret',
  ONCHAIN_SESSION_MAX: 'bootstrap',
  ONCHAIN_SESSION_IDLE_MS: 'bootstrap',
});

/**
 * Whether a class may be read from a store that is editable without a release.
 *
 * One question, one answer, so the day a settings loader asks it there is nothing to re-derive:
 * `mayLiveInPostgres('secret')` is `false` because of D10, and `mayLiveInPostgres('bootstrap')` is
 * `false` because the connection setting cannot come from the connection.
 */
export function mayLiveInPostgres(settingClass: SettingClass): boolean {
  return settingClass === 'narrowing';
}

/**
 * The consistency rules over the registry itself, as a function so a test can feed it a wrong one.
 *
 * **Why the rules are checkable on an ARGUMENT rather than only on the real table.** A gate that can
 * only observe the correct state cannot be shown to detect the wrong one, and this project has
 * already recorded a mutation that "passed" because it never applied. Every rule below is exercised
 * on a deliberately broken registry in `settings-classification-gate.test.ts`.
 */
export function classificationDefects(
  classes: Readonly<Record<string, SettingClass>>,
  obligations: Readonly<Record<SettingClass, readonly Obligation[]>>,
): string[] {
  const defects: string[] = [];

  for (const [key, settingClass] of Object.entries(classes)) {
    if (!SETTING_CLASSES_DECLARED.includes(settingClass)) {
      defects.push(
        `${key}: class ${JSON.stringify(settingClass)} is not one of ${SETTING_CLASSES_DECLARED.join(', ')} (§10.3.1)`,
      );
    }
  }

  for (const settingClass of SETTING_CLASSES_DECLARED) {
    const declared = obligations[settingClass] ?? [];
    if (settingClass === 'narrowing') {
      const missing = OBLIGATIONS_OF_EDITING_WITHOUT_A_RELEASE.filter(
        (obligation) => !declared.includes(obligation),
      );
      if (missing.length > 0) {
        defects.push(
          `narrowing: the obligations of editing without a release are not all declared — missing ${missing.join(', ')} (R-29.5)`,
        );
      }
      continue;
    }
    if (declared.length > 0) {
      defects.push(
        `${settingClass}: declares ${declared.join(', ')}, but the obligations of editing without a release apply to the narrowing class alone (R-29.5). A ${settingClass} setting never leaves .env, so there is no edit-without-release for them to govern.`,
      );
    }
  }

  return defects;
}

/**
 * Builds the registry, throwing on any defect.
 *
 * Called immediately below with this module's own literals, so an inconsistent classification is a
 * module that does not load — not a test somebody may skip.
 */
export function buildSettingsRegistry(
  classes: Readonly<Record<string, SettingClass>>,
  obligations: Readonly<Record<SettingClass, readonly Obligation[]>> = OBLIGATIONS,
): Readonly<Record<string, SettingClass>> {
  const defects = classificationDefects(classes, obligations);
  if (defects.length > 0) throw new SettingsClassificationError(defects);
  return classes;
}

export const SETTINGS_REGISTRY = buildSettingsRegistry(SETTING_CLASSES);
