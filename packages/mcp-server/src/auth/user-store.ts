import type { EngineStore } from '../engine/pg-engine-store.js';
import { ulid } from '../ulid.js';
import type { NewUser, Role, User, UserStatus } from './identity-types.js';

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

/* --------------------------------------------------------------------------------------------- *
 * Task 014-07 — the repository over the shared access mechanism.
 * --------------------------------------------------------------------------------------------- */

export interface UserStoreDeps {
  readonly engine: EngineStore;
  readonly now: () => number;
  readonly newId?: (nowMs: number) => string;
}

/** A row as the engine returns it — snake_case, exactly the column names. */
interface UserSqlRow {
  readonly id: string;
  readonly email: string;
  readonly display_name: string | null;
  readonly role: string;
  readonly status: string;
  readonly created_at: number | string;
  readonly updated_at: number | string;
}

/** `pg` hands back `BIGINT` as a string; the SQLite axis hands back a number. See `token-store.ts`. */
const epochMs = (value: number | string): number =>
  typeof value === 'number' ? value : Number(value);

const toUser = (row: UserSqlRow): User => ({
  id: row.id,
  email: row.email,
  displayName: row.display_name,
  role: row.role as Role,
  status: row.status as UserStatus,
  createdAt: epochMs(row.created_at),
  updatedAt: epochMs(row.updated_at),
});

const COLUMNS = 'id, email, display_name, role, status, created_at, updated_at';

export function createUserStore(deps: UserStoreDeps): UserStore {
  const { engine, now } = deps;
  const newId = deps.newId ?? ((nowMs: number): string => ulid(nowMs));

  return {
    async createUser(input: NewUser): Promise<User> {
      const createdAt = now();
      // `created_at` and `updated_at` are the same instant and are bound to the SAME parameter.
      // Reading the clock twice would let a row exist whose "last changed" precedes its own
      // creation by a millisecond, which is the kind of impossibility a later query has to work
      // around rather than report.
      const rows = await engine.query<UserSqlRow>(
        `INSERT INTO ${engine.qualify('users')} (${COLUMNS})
         VALUES ($1, $2, $3, $4, 'active', $5, $5)
         RETURNING ${COLUMNS}`,
        [
          newId(createdAt),
          // Lowercased HERE, by the writer, because neither engine folds case in a UNIQUE index by
          // default (§4.5.3): `A@x` and `a@x` would otherwise both be admitted, and the second of
          // them is a person nobody meant to create.
          input.email.toLowerCase(),
          input.displayName ?? null,
          input.role,
          createdAt,
        ],
      );
      const row = rows[0];
      if (row === undefined) throw new Error('INSERT ... RETURNING produced no row for users');
      return toUser(row);
    },

    async findUser(selector): Promise<User | null> {
      const byId = 'id' in selector;
      const rows = await engine.query<UserSqlRow>(
        `SELECT ${COLUMNS} FROM ${engine.qualify('users')} WHERE ${byId ? 'id' : 'email'} = $1`,
        [byId ? selector.id : selector.email.toLowerCase()],
      );
      const row = rows[0];
      return row === undefined ? null : toUser(row);
    },

    async listUsers(): Promise<readonly User[]> {
      // Ordered by the ULID, which sorts by creation time as text (§1.3) — so the listing is stable
      // across engines without an ORDER BY over a column either of them might collate differently.
      const rows = await engine.query<UserSqlRow>(
        `SELECT ${COLUMNS} FROM ${engine.qualify('users')} ORDER BY id`,
      );
      return rows.map(toUser);
    },
  };
}
