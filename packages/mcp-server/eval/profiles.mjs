/**
 * The storage axis of each deployment profile, mirrored for the eval (task 015-29).
 *
 * **Why a mirror and not the source.** `src/profile.ts` is TypeScript; `eval/` is plain `.mjs` with
 * no build step, and the runner itself executes under bare node (only the processes it SPAWNS get
 * `--import tsx`). It cannot import `PROFILES`.
 *
 * **Why the mirror is safe.** `packages/mcp-server/test/eval-storage-axis.test.ts` compares this
 * table with `PROFILES` key by key, so a profile added or re-axed in the source and forgotten here
 * fails the suite rather than sending a live case to read the wrong store.
 *
 * **Why the eval needs the axis at all.** A ledger reader hard-wired to `DATA_DIR/cache.sqlite3`
 * returns zero rows on the `network` profile — where cache and budget both live in Postgres — and
 * then asserts against that zero. The case would pass by reading nothing.
 */
export const PROFILE_STORAGE = Object.freeze({
  local: 'sqlite',
  network: 'postgres',
  'network-sqlite': 'sqlite',
});

/** The axis of one profile name, or `null` for a name this table does not know. */
export function storageOf(profileName) {
  return PROFILE_STORAGE[profileName] ?? null;
}

/**
 * The address a run's state actually went to — safe to record, unlike the DSN itself (D10).
 *
 * **Why the axis is a parameter and not just the DSN.** The runner inherits `ONCHAIN_STATE_PG_URL`
 * from the repo-root `.env`, so the key is set even on a run that never opens Postgres. Labelling
 * such a run with that address would claim it touched the engine's own container when its state
 * went to a temporary file — the same confusion the field exists to remove, only inverted.
 *
 * **Why it lives here and not in the runner.** A pure function of the two values can be asserted
 * for real (`test/eval-storage-axis.test.ts`) instead of grepped for, and the assertion that the
 * label carries no credentials is the one worth having.
 *
 * @param storage `'postgres' | 'sqlite'` — the axis the phase raised.
 * @param dsn     the configured state DSN, or `null`.
 * @returns a printable target, or `null` when the axis is Postgres and no DSN was named.
 */
export function stateTargetLabel(storage, dsn) {
  if (storage !== 'postgres') return 'sqlite (run-local DATA_DIR)';
  if (dsn === null || dsn === undefined || dsn === '') return null;
  try {
    const u = new URL(dsn);
    return `${u.hostname}:${u.port || '5432'}${u.pathname}`;
  } catch {
    return '(unparseable DSN)';
  }
}
