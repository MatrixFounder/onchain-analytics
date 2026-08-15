import type { NewUser, User } from './identity-types.js';

/**
 * The `users` repository (`data-model.md` §4.5.3).
 *
 * Task 014-02 declared the address, task 014-06 declares the members, task 014-07 replaces the stub
 * with the repository over `engine/pg-engine-store.ts`.
 *
 * **Why `mcp-server` and not `core`.** `security.md` §7.5.1 keeps identity beside the transport that
 * needs it; `packages/core` receives no knowledge of tokens, roles or headers.
 *
 * **Why the members arrive before the implementation.** A `[STUB]` task ships the shape so the
 * tests that assert it can be written and be green — the form is the deliverable, and the logic
 * replaces the answers behind an interface nobody has to re-negotiate.
 */
export interface UserStore {
  /**
   * Creates a user. The store owns `id` (ULID, §1.3), `status` (`'active'`) and both timestamps.
   *
   * **`email` is lowercased before the insert** (§4.5.3). Neither engine folds case in a `UNIQUE`
   * index by default, so `A@x` and `a@x` would be admitted as two different people — and the second
   * of them would be a person nobody meant to create.
   */
  createUser(input: NewUser): Promise<User>;

  /**
   * Finds one user by id or by address — the only two reads §4.5.3 declares, which is why the table
   * carries no index beyond the two its keys create.
   *
   * **A union selector rather than two methods.** `findUserById` and `findUserByEmail` would be two
   * places to remember the lowercasing rule, and one of them would eventually not.
   */
  findUser(selector: { readonly id: string } | { readonly email: string }): Promise<User | null>;

  /** Every user, for the admin listing (R-15.4). No row is ever deleted, so this is the full set. */
  listUsers(): Promise<readonly User[]>;
}

/**
 * The stub: fixed answers, no database (`[STUB]`, task 014-06).
 *
 * `seed` is the seam a test uses to choose the population, the same injection pattern
 * `createAccessProfileStoreStub` takes. Task 014-07 replaces this with the repository; until then
 * nothing here may reach the startup path of the network profile, because a store that always agrees
 * is a check that never refuses.
 */
export function createUserStoreStub(seed: readonly User[] = []): UserStore {
  const rows = [...seed];
  return {
    createUser(input: NewUser): Promise<User> {
      const now = 0;
      const created: User = {
        id: `01JSTUBUSER${String(rows.length).padStart(3, '0')}`,
        email: input.email.toLowerCase(),
        displayName: input.displayName ?? null,
        role: input.role,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      };
      rows.push(created);
      return Promise.resolve(created);
    },
    findUser(selector): Promise<User | null> {
      const found =
        'id' in selector
          ? rows.find((row) => row.id === selector.id)
          : rows.find((row) => row.email === selector.email.toLowerCase());
      return Promise.resolve(found ?? null);
    },
    listUsers(): Promise<readonly User[]> {
      return Promise.resolve([...rows]);
    },
  };
}
