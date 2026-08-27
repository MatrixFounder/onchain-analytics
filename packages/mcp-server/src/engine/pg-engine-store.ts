import { STATE_TABLES, type StateClient, type StateTransaction } from '@onchain-intel/core';

/**
 * The one way the five repositories of task 014-02 reach Postgres.
 *
 * **Why a shared mechanism rather than five connections.** Each repository would otherwise open its
 * own path to the database, and schema qualification — the property WI-47 showed is load-bearing —
 * would have to be verified in five places. One mechanism means one place to check and one place to
 * change when the pooler in front of the database changes again.
 *
 * **Why this lives in `mcp-server` and not in `core`.** `security.md` §7.5.1: the checks live beside
 * the transport that needs them, and the SQL naming the identity tables lives here too. `core` gains
 * no knowledge of tokens, roles or headers.
 *
 * **What this does NOT do: repository methods.** Task 014-02's table assigns each stub's replacement
 * to exactly one task — 014-07 for the token and user stores, 014-30 for the trace store, 014-27 for
 * diagnostics, and a table-backed supplier after T-014 for the access profile. Implementing any of
 * them here would give that file a second owner, and the two would diverge on the first change to
 * the shape they share.
 */

/** A table this mechanism will address. Anything else is a caller's mistake, not a query. */
export type EngineTable = (typeof STATE_TABLES)[number];

export class UnknownEngineTableError extends Error {
  constructor(readonly presented: string) {
    super(
      // The count is DERIVED, never a second literal beside `STATE_TABLES.join(', ')` — a list that
      // grows without its own count edited is exactly the N-5 finding (architecture review plan
      // round 2): this message named twelve tables and then listed thirteen, unnoticed, the moment
      // task 015-03 appended `client_usage` to `STATE_TABLES`. `STATE_TABLES.length` cannot drift
      // from the join beside it — both read the same array.
      `unknown engine table ${JSON.stringify(presented)} — the ${STATE_TABLES.length} tables of data-model.md §4.4/§4.6.1 are ${STATE_TABLES.join(', ')}`,
    );
    this.name = 'UnknownEngineTableError';
  }
}

/**
 * The schema-qualified name of an engine table.
 *
 * **Why a function and not a string template at each call site.** `search_path` is not a correctness
 * condition on this installation and cannot be made one: Supavisor answers with its own, discarding
 * the `-c search_path=onchain` the client sends (WI-47). A missing qualifier therefore produces
 * neither a privilege refusal nor a failing test — it produces an answer with no rows, which is
 * exactly what WI-47 cost: the database was reachable, 3039 rows were in place, and the reader read
 * none of them.
 *
 * **Why an unknown name throws rather than passing through.** A pass-through would qualify a typo
 * just as willingly as a table, and the statement would then fail at the database with a message
 * about a relation that does not exist — one round trip later, and further from the mistake.
 */
export function qualify(table: EngineTable): string {
  if (!(STATE_TABLES as readonly string[]).includes(table)) {
    throw new UnknownEngineTableError(String(table));
  }
  return `onchain.${table}`;
}

export interface EngineStore {
  /** True when the write client has a DSN and can be asked; false with the reason it cannot. */
  isAvailable(): { ok: true } | { ok: false; reason: string };
  /** One autocommit statement. */
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Several statements on one connection, rolled back on a throw. */
  transaction<T>(fn: (tx: StateTransaction) => Promise<T>): Promise<T>;
  /** The schema-qualified name of an engine table — the only way a repository should spell one. */
  qualify(table: EngineTable): string;
}

/**
 * Wraps the write client of task 014-39 in the surface the five repositories use.
 *
 * **Why a wrapper at all, when `StateClient` already has `query` and `transaction`.** Two reasons
 * that are not stylistic. It gives the repositories one import instead of a dependency on `core`'s
 * client construction, and it carries `qualify`, so a repository never spells a bare table name even
 * once. The client's own runtime guard refuses an unqualified reference; this makes the correct
 * spelling the convenient one, so the guard stays the second line of defence rather than the first.
 */
export function createEngineStore(client: StateClient): EngineStore {
  return {
    isAvailable: () => client.isAvailable(),
    query: (sql, params) => client.query(sql, params),
    transaction: (fn) => client.transaction(fn),
    qualify,
  };
}
