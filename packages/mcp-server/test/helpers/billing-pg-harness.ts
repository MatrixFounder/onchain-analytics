import Database from 'better-sqlite3';
import {
  CACHE_DDL,
  createStateClient,
  toSqliteDialect,
  type PgStateConnectionLike,
  type PgStatePoolCtor,
  type PgStatePoolLike,
  type StateClient,
} from '@onchain-intel/core';
import {
  AccessProfileUnavailableError,
  type AccessProfile,
  type AccessProfileReader,
} from '../../src/auth/access-profile.js';
import { createEngineStore, type EngineStore } from '../../src/engine/pg-engine-store.js';

/**
 * Task 015-07's own harness — a real `createStateClient` over a FAKE `pg.Pool` that runs the
 * SHIPPED statement text (schema-qualified, `$n`-bound, `CAST(x AS t)`-cast) against a real
 * in-memory `better-sqlite3` database, translated by the SAME `toSqliteDialect` production uses for
 * the `network-sqlite` profile (R-21 — no live Postgres reaches CI).
 *
 * **Extracted here in task 015-10** so `reservation-lifecycle.test.ts` can exercise the SAME
 * mechanism `billing-store-pg.test.ts` already does, without a second, independently-maintained copy
 * of ~100 lines — the partial-application pattern CLAUDE.md's own memory already names as the
 * recurring defect. `billing-store-pg.test.ts` imports this file now; its own local copy is deleted,
 * not duplicated.
 */

const FAKE_DSN = 'postgres://engine_state:sup3r-secret-pw@db.internal:5432/postgres';

/** `pg`'s own int8 parser, imitated for the one INTEGER column a caller reads back directly — a
 * fake that silently stayed a JS number would let an assertion pass here and misbehave in
 * production (`packages/core/test/pg-store-parity.test.ts`'s own `asPgRow`). */
function asPgRow(row: unknown): unknown {
  if (typeof row !== 'object' || row === null) return row;
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      typeof value === 'number' && Number.isInteger(value) ? String(value) : value,
    ]),
  );
}

export class BillingPgHarness {
  readonly db: Database.Database;
  readonly statements: { readonly text: string; readonly values: readonly unknown[] }[] = [];

  constructor() {
    this.db = new Database(':memory:');
    this.db.exec('PRAGMA foreign_keys = ON;');
    this.db.exec(CACHE_DDL);
  }

  private run(text: string, values: unknown[]): { rows: unknown[] } {
    this.statements.push({ text, values });
    const statement = this.db.prepare(toSqliteDialect(text));
    const bound =
      values.length === 0 ? undefined : Object.fromEntries(values.map((v, i) => [`p${i + 1}`, v]));
    if (!statement.reader) {
      if (bound === undefined) statement.run();
      else statement.run(bound as never);
      return { rows: [] };
    }
    const rows = bound === undefined ? statement.all() : statement.all(bound as never);
    return { rows: rows.map((row) => asPgRow(row)) };
  }

  poolCtor(): PgStatePoolCtor {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const harness = this;
    return class FakePool implements PgStatePoolLike {
      async query(text: string, values: unknown[] = []): Promise<{ rows: unknown[] }> {
        return harness.run(text, values);
      }
      async connect(): Promise<PgStateConnectionLike> {
        return {
          query: async (text: string, values: unknown[] = []) => harness.run(text, values),
          release: () => {},
        };
      }
    };
  }

  client(): StateClient {
    return createStateClient({
      env: { ONCHAIN_STATE_PG_URL: FAKE_DSN } as NodeJS.ProcessEnv,
      PoolCtor: this.poolCtor(),
    });
  }

  engine(): EngineStore {
    return createEngineStore(this.client());
  }

  /** The seven `access_profiles` columns this table's own NOT NULL/CHECK set requires beyond the
   * three `AccessProfile` cares about — filled with inert values, mirroring migration 004's own
   * phase-0 seed row shape (`cache/ddl.ts`'s own INSERT below `CREATE TABLE client_usage`). */
  seedAccessProfile(
    id: string,
    creditsMode: 'unlimited' | 'metered',
    creditsBalanceRaw: string | null,
  ): void {
    this.db
      .prepare(
        `INSERT INTO access_profiles
           (id, name, status, credits_mode, credits_balance_raw, rate_limit_mode, rate_limit_per_min,
            tool_allowlist_mode, tool_allowlist_json, route_disclosure_mode, created_at, updated_at)
         VALUES (?, ?, 'active', ?, ?, 'unlimited', NULL, 'all', NULL, 'full', 0, 0)`,
      )
      .run(id, id, creditsMode, creditsBalanceRaw);
  }

  rows(table: string): Record<string, unknown>[] {
    return this.db.prepare(`SELECT * FROM ${table}`).all() as Record<string, unknown>[];
  }

  balanceOf(id: string): string | null {
    const row = this.db
      .prepare('SELECT credits_balance_raw FROM access_profiles WHERE id = ?')
      .get(id) as { credits_balance_raw: string | null } | undefined;
    return row?.credits_balance_raw ?? null;
  }

  close(): void {
    this.db.close();
  }
}

export const UNLIMITED_PROFILE: AccessProfile = {
  creditsMode: 'unlimited',
  creditsBalanceRaw: null,
  rateLimitMode: 'unlimited',
  rateLimitPerMin: null,
  toolAllowlistMode: 'all',
  toolAllowlist: null,
  routeDisclosureMode: 'full',
};

export function meteredProfile(creditsBalanceRaw: string | null): AccessProfile {
  return { ...UNLIMITED_PROFILE, creditsMode: 'metered', creditsBalanceRaw };
}

/** A reader over a fixed in-memory map — the mode/balance FORMAT is a caller's own input, never read
 * from `harness.db` directly, mirroring `data-model.md` §4.6.1's own narrowing: "the MODE, not the
 * atomic write, goes through `AccessProfileReader`." */
export function profileReaderOf(
  profiles: Readonly<Record<string, AccessProfile>>,
): AccessProfileReader {
  return {
    read(accessProfileId: string): Promise<AccessProfile> {
      const profile = profiles[accessProfileId];
      if (profile === undefined) {
        return Promise.reject(
          new AccessProfileUnavailableError(accessProfileId, 'not seeded in this test fixture'),
        );
      }
      return Promise.resolve(profile);
    },
  };
}
