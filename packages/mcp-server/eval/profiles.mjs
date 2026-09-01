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
