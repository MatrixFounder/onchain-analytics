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
import { afterEach, describe, expect, it } from 'vitest';
import {
  AccessProfileUnavailableError,
  type AccessProfile,
  type AccessProfileReader,
} from '../src/auth/access-profile.js';
import {
  ClientCreditsExhaustedError,
  LedgerReadNotAuthoritativeError,
} from '../src/engine/billing-errors.js';
import {
  createBillingStore,
  createBillingStoreStub,
  createSqliteBillingStore,
  type BillingReserveResult,
} from '../src/engine/billing-store.js';
import { createEngineStore, type EngineStore } from '../src/engine/pg-engine-store.js';

/**
 * Task 015-07 — `BillingStore` on the Postgres axis, checked against a REAL engine mechanism (a real
 * `createStateClient` over a FAKE `pg.Pool`, R-21 — no live Postgres reaches CI). The interface and
 * the stub are task 015-04's (`billing-store-contract.test.ts`); the SQLite axis is task 015-06's
 * (`billing-store-sqlite.test.ts`), left untouched here.
 *
 * **How a Postgres statement is executed without Postgres.** The same technique
 * `packages/core/test/pg-store-parity.test.ts` already established for `BudgetStore`/`CacheStore`/
 * `LimiterStore`: `createStateClient` (the REAL Postgres write client, task 014-39) is constructed
 * over a fake `PgStatePoolCtor` that runs the SHIPPED statement text — schema-qualified, `$n`-bound,
 * `CAST(x AS t)`-cast — against a real in-memory `better-sqlite3` database, translated by the SAME
 * `toSqliteDialect` production uses for the `network-sqlite` profile. `CAST(x AS NUMERIC)` needs no
 * translation at all: it is the ANSI form (`pg/limiter-store.ts`'s own precedent, "`::` is
 * Postgres-only syntax, while `CAST(x AS t)` is standard and SQLite parses it"), so the statements
 * below run UNEDITED on both engines — this suite exercises the exact text `createBillingStore` sends,
 * including the runtime schema-qualification guard baked into `createStateClient` itself.
 *
 * **What this proves and what it cannot.** It proves the statements say what they must and compute
 * what they claim — including the `CAST(... AS NUMERIC)` subtraction past 2^53 (TC-UNIT-08), because
 * that arithmetic runs for real, on a real database, not a JS reimplementation of it. It cannot
 * observe the row lock a live Postgres would take on the `access_profiles` row across two concurrent
 * connections — that is TC-E2E ground, excluded from CI by R-21.
 */

const FAKE_DSN = 'postgres://engine_state:sup3r-secret-pw@db.internal:5432/postgres';

/** `pg`'s own int8 parser, imitated for the one INTEGER column this suite reads back directly
 * (`reserved_at`/`terminal_at` are never asserted on here, so this is a defensive no-op today — kept
 * for the same reason `pg-store-parity.test.ts`'s own `asPgRow` states: a fake that silently stayed a
 * JS number would let a future assertion pass here and misbehave in production). */
function asPgRow(row: unknown): unknown {
  if (typeof row !== 'object' || row === null) return row;
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      typeof value === 'number' && Number.isInteger(value) ? String(value) : value,
    ]),
  );
}

class BillingPgHarness {
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

const UNLIMITED_PROFILE: AccessProfile = {
  creditsMode: 'unlimited',
  creditsBalanceRaw: null,
  rateLimitMode: 'unlimited',
  rateLimitPerMin: null,
  toolAllowlistMode: 'all',
  toolAllowlist: null,
  routeDisclosureMode: 'full',
};

function meteredProfile(creditsBalanceRaw: string | null): AccessProfile {
  return { ...UNLIMITED_PROFILE, creditsMode: 'metered', creditsBalanceRaw };
}

/** A reader over a fixed in-memory map — the mode/balance FORMAT is this suite's own input, never
 * read from `harness.db` directly, mirroring `data-model.md` §4.6.1's own narrowing: "the MODE, not
 * the atomic write, goes through `AccessProfileReader`." */
function profileReaderOf(profiles: Readonly<Record<string, AccessProfile>>): AccessProfileReader {
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

function reserveInput(
  overrides: Partial<{
    principalId: string;
    accessProfileId: string | null;
    clientRequestId: string;
    tool: string;
    capability: string | null;
    priceRaw: string;
  }> = {},
): {
  principalId: string;
  accessProfileId: string | null;
  clientRequestId: string;
  tool: string;
  capability: string | null;
  priceRaw: string;
} {
  return {
    principalId: overrides.principalId ?? 'local',
    accessProfileId: overrides.accessProfileId ?? null,
    clientRequestId: overrides.clientRequestId ?? 'req-1',
    tool: overrides.tool ?? 'onchain_token_price',
    capability: overrides.capability ?? 'token.price',
    priceRaw: overrides.priceRaw ?? '1',
  };
}

function unwrapOk(result: BillingReserveResult): { rowId: string; existing: boolean } {
  if (!result.ok) throw new Error(`unreachable — reserve() refused: ${JSON.stringify(result)}`);
  return result.reservation;
}

function unwrapRefused(result: BillingReserveResult): { reason: string; refusalClass: string } {
  if (result.ok) throw new Error('unreachable — reserve() succeeded');
  return result;
}

let harness: BillingPgHarness | undefined;
afterEach(() => {
  harness?.close();
  harness = undefined;
});

describe('BillingStore on the Postgres axis (task 015-07)', () => {
  it('TC-UNIT-01: the unlimited branch is ONE operator, and a repeat writes no second row', async () => {
    harness = new BillingPgHarness();
    const store = createBillingStore(harness.engine(), profileReaderOf({}));
    const input = reserveInput();

    const first = unwrapOk(await store.reserve(input));
    const second = unwrapOk(await store.reserve(input));

    expect(first.existing).toBe(false);
    expect(second.existing).toBe(true);
    expect(second.rowId).toBe(first.rowId);
    expect(harness.rows('client_usage')).toHaveLength(1);
    // "One operator": the FIRST call's write is a single INSERT, never a transaction — no
    // BEGIN/COMMIT pair appears for it. (The second call adds one SELECT read-back, per the task's
    // own "Реализация читает её" — still no transaction wrapper.)
    expect(harness.statements.map((s) => s.text.trim().split('\n')[0])).not.toContain('BEGIN');
  });

  it('TC-UNIT-01b: unlimited also resolves through an actual profile lookup, not only accessProfileId=null', async () => {
    harness = new BillingPgHarness();
    const store = createBillingStore(harness.engine(), profileReaderOf({ ap1: UNLIMITED_PROFILE }));
    const result = unwrapOk(
      await store.reserve(
        reserveInput({ accessProfileId: 'ap1', clientRequestId: 'req-unlimited' }),
      ),
    );
    expect(result.existing).toBe(false);
    expect(harness.rows('client_usage')).toHaveLength(1);
  });

  it('TC-UNIT-02: metered with sufficient balance debits exactly the price and reserves the row', async () => {
    harness = new BillingPgHarness();
    harness.seedAccessProfile('ap1', 'metered', '100');
    const store = createBillingStore(
      harness.engine(),
      profileReaderOf({ ap1: meteredProfile('100') }),
    );

    const result = unwrapOk(
      await store.reserve(reserveInput({ accessProfileId: 'ap1', priceRaw: '1' })),
    );

    expect(harness.balanceOf('ap1')).toBe('99');
    const rows = harness.rows('client_usage');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.['state']).toBe('reserved');
    expect(rows[0]?.['id']).toBe(result.rowId);
  });

  it('TC-UNIT-03: metered with insufficient balance rolls back BOTH tables and refuses by class', async () => {
    harness = new BillingPgHarness();
    harness.seedAccessProfile('ap1', 'metered', '0');
    const store = createBillingStore(
      harness.engine(),
      profileReaderOf({ ap1: meteredProfile('0') }),
    );

    const refused = unwrapRefused(
      await store.reserve(reserveInput({ accessProfileId: 'ap1', priceRaw: '1' })),
    );

    expect(refused.refusalClass).toBe('ClientCreditsExhaustedError');
    // The mutant this catches: "вынос INSERT наружу транзакции" — an INSERT issued OUTSIDE the
    // transaction would survive the debit's rollback and leave exactly this row behind.
    expect(harness.rows('client_usage')).toHaveLength(0);
    expect(harness.balanceOf('ap1')).toBe('0');
  });

  it('TC-UNIT-04: a retry under metered does not debit a second time', async () => {
    harness = new BillingPgHarness();
    harness.seedAccessProfile('ap1', 'metered', '100');
    const store = createBillingStore(
      harness.engine(),
      profileReaderOf({ ap1: meteredProfile('100') }),
    );
    const input = reserveInput({
      accessProfileId: 'ap1',
      priceRaw: '1',
      clientRequestId: 'req-retry',
    });

    const first = unwrapOk(await store.reserve(input));
    const second = unwrapOk(await store.reserve(input));

    expect(first.existing).toBe(false);
    expect(second.existing).toBe(true);
    expect(second.rowId).toBe(first.rowId);
    // The mutant this catches: "перестановка дебета перед вставкой" — a debit-before-insert order
    // would not see the conflict and would spend twice, leaving 98 rather than 99.
    expect(harness.balanceOf('ap1')).toBe('99');
    expect(harness.rows('client_usage')).toHaveLength(1);
  });

  it('TC-UNIT-05: unlimited is never refused by balance, and the debit statement is never sent', async () => {
    harness = new BillingPgHarness();
    harness.seedAccessProfile('ap1', 'unlimited', null);
    const store = createBillingStore(harness.engine(), profileReaderOf({ ap1: UNLIMITED_PROFILE }));

    const result = unwrapOk(
      await store.reserve(reserveInput({ accessProfileId: 'ap1', priceRaw: '999999' })),
    );

    expect(result.existing).toBe(false);
    expect(
      harness.statements.some((s) => /UPDATE\s+onchain\.access_profiles/i.test(s.text)),
      'no debit statement was ever sent under unlimited',
    ).toBe(false);
  });

  it('TC-UNIT-06: an unparseable balance refuses before any operator is sent', async () => {
    harness = new BillingPgHarness();
    harness.seedAccessProfile('ap1', 'metered', 'NaN');
    const store = createBillingStore(
      harness.engine(),
      profileReaderOf({ ap1: meteredProfile('NaN') }),
    );
    const baseline = harness.statements.length;

    const refused = unwrapRefused(
      await store.reserve(reserveInput({ accessProfileId: 'ap1', priceRaw: '1' })),
    );

    // The mutant this catches ("снятие проверки разбора значения"): without the pre-transaction
    // parse, the reserve INSERT is sent before the debit's own WHERE clause has a chance to refuse —
    // this assertion is red the moment ANY statement reaches the engine.
    expect(harness.statements.length).toBe(baseline);
    expect(refused.refusalClass).toBe('BillingStoreUnavailableError');
    expect(refused.reason).toContain('ap1');
    expect(harness.rows('client_usage')).toHaveLength(0);
    expect(harness.balanceOf('ap1')).toBe('NaN');
  });

  it('TC-UNIT-07: a price outside unsigned decimal notation is refused before any operator is sent', async () => {
    harness = new BillingPgHarness();
    const store = createBillingStore(harness.engine(), profileReaderOf({}));
    const baseline = harness.statements.length;

    for (const badPrice of ['1.5', '-1']) {
      const refused = unwrapRefused(
        await store.reserve(
          reserveInput({ priceRaw: badPrice, clientRequestId: `req-${badPrice}` }),
        ),
      );
      expect(refused.refusalClass, badPrice).toBe('BillingStoreUnavailableError');
    }
    expect(harness.statements.length).toBe(baseline);
    expect(harness.rows('client_usage')).toHaveLength(0);
  });

  it('TC-UNIT-08: the debit is exact past the safe 2^53 integer boundary', async () => {
    harness = new BillingPgHarness();
    const bigBalance = '9007199254740993'; // 2^53 + 1
    harness.seedAccessProfile('ap1', 'metered', bigBalance);
    const store = createBillingStore(
      harness.engine(),
      profileReaderOf({ ap1: meteredProfile(bigBalance) }),
    );

    unwrapOk(await store.reserve(reserveInput({ accessProfileId: 'ap1', priceRaw: '1' })));

    // `Number('9007199254740993') === 9007199254740992` — the wrong answer float precision gives.
    // The correct one, preserved only by BigInt/`numeric`, is asserted here byte-for-byte.
    expect(harness.balanceOf('ap1')).toBe('9007199254740992');
  });

  it('TC-UNIT-09: sumSettled sums ONLY the Postgres-axis rows for the period', async () => {
    harness = new BillingPgHarness();
    const store = createBillingStore(harness.engine(), profileReaderOf({}));
    const sqliteStore = createSqliteBillingStore({ path: ':memory:' });

    const pgReservation = unwrapOk(
      await store.reserve(reserveInput({ priceRaw: '5', clientRequestId: 'req-pg' })),
    );
    await store.settle(pgReservation.rowId);

    const sqliteReservation = unwrapOk(
      await sqliteStore.reserve(reserveInput({ priceRaw: '7', clientRequestId: 'req-sqlite' })),
    );
    await sqliteStore.settle(sqliteReservation.rowId);

    const sum = await store.sumSettled(0, Date.now() + 86_400_000);
    expect(sum).toBe('5');
    await expect(sqliteStore.sumSettled(0, 1)).rejects.toBeInstanceOf(
      LedgerReadNotAuthoritativeError,
    );
  });

  it('TC-UNIT-10: settled revenue over a period is decoupled from what any one call actually cost the vendor', async () => {
    harness = new BillingPgHarness();
    const store = createBillingStore(harness.engine(), profileReaderOf({}));
    const from = 0;
    const to = Date.now() + 86_400_000;

    // Three CLIENT-facing calls in the period, each settled at the SAME flat price — one of them is,
    // architecturally, a cache hit that reached no vendor at all (`client_usage` carries no
    // `servedFrom` column and cannot distinguish the three; `sumSettled` sums client revenue, never
    // vendor spend — that is exactly R-1.1's "our spend / our revenue" split, data-model.md §4.6.1).
    for (const clientRequestId of ['req-vendor-1', 'req-vendor-2', 'req-cache-hit']) {
      const reservation = unwrapOk(
        await store.reserve(reserveInput({ priceRaw: '2', clientRequestId })),
      );
      await store.settle(reservation.rowId);
    }

    const settledSum = await store.sumSettled(from, to);
    // A stand-in for "what the vendor actually billed us this period" — two real vendor calls at 1
    // credit apiece, the third served from cache and costing nothing at the vendor.
    const vendorSpendThisPeriod = '2';
    expect(settledSum).toBe('6');
    expect(settledSum).not.toBe(vendorSpendThisPeriod);
  });

  it('TC-UNIT-11: every reference to client_usage/access_profiles goes through engine.qualify', async () => {
    harness = new BillingPgHarness();
    const engine = harness.engine();
    const qualifyCalls: string[] = [];
    const spiedEngine: EngineStore = {
      ...engine,
      qualify: (table) => {
        qualifyCalls.push(table);
        return engine.qualify(table);
      },
    };
    harness.seedAccessProfile('ap1', 'metered', '100');
    const store = createBillingStore(spiedEngine, profileReaderOf({ ap1: meteredProfile('100') }));

    unwrapOk(await store.reserve(reserveInput({ clientRequestId: 'req-unlimited' })));
    unwrapOk(
      await store.reserve(
        reserveInput({ accessProfileId: 'ap1', priceRaw: '1', clientRequestId: 'req-metered' }),
      ),
    );
    await store.sumSettled(0, 1);

    expect(qualifyCalls, 'engine.qualify was actually called, not bypassed by a literal').toContain(
      'client_usage',
    );
    expect(qualifyCalls).toContain('access_profiles');

    // And the resulting text is qualified everywhere a table clause appears — the gate
    // `schema-qualification.gate.test.ts` polices in production; reproduced here on the captured
    // texts so a literal that HAPPENED to already read "onchain.client_usage" (bypassing
    // `engine.qualify` while looking correct) still fails TC-UNIT-11 via the assertion above, and a
    // genuinely unqualified literal fails this one too.
    const clause = /\b(?:FROM|JOIN|INTO|UPDATE)\s+(?!onchain\.)(?:client_usage|access_profiles)\b/i;
    const offenders = harness.statements.filter((s) => clause.test(s.text));
    expect(offenders.map((s) => s.text)).toEqual([]);
  });

  it('settle() transitions reserved -> settled and fills terminal_at, once', async () => {
    harness = new BillingPgHarness();
    const store = createBillingStore(harness.engine(), profileReaderOf({}));
    const { rowId } = unwrapOk(await store.reserve(reserveInput()));

    await store.settle(rowId);
    const settledRow = harness.rows('client_usage')[0];
    expect(settledRow?.['state']).toBe('settled');
    expect(settledRow?.['terminal_at']).not.toBeNull();

    // Idempotent completion — first completer wins (system-architecture.md §3.5.3): a second settle
    // on an already-terminal row is a no-op, not an error.
    await expect(store.settle(rowId)).resolves.toBeUndefined();
    expect(harness.rows('client_usage')[0]?.['state']).toBe('settled');
  });

  it('refund() transitions reserved -> refunded and records the reason', async () => {
    harness = new BillingPgHarness();
    const store = createBillingStore(harness.engine(), profileReaderOf({}));
    const { rowId } = unwrapOk(await store.reserve(reserveInput()));

    await store.refund(rowId, 'ClientCreditsExhaustedError');

    const row = harness.rows('client_usage')[0];
    expect(row?.['state']).toBe('refunded');
    expect(row?.['refund_reason']).toBe('ClientCreditsExhaustedError');
    expect(row?.['terminal_at']).not.toBeNull();
  });

  it('a dead engine refuses reserve() with BillingStoreUnavailableError, as a value, never a throw', async () => {
    const dead: EngineStore = {
      isAvailable: () => ({ ok: true }),
      query: () => Promise.reject(new Error('pg/state-client: database unavailable')),
      transaction: () => Promise.reject(new Error('pg/state-client: database unavailable')),
      qualify: (table) => `onchain.${table}`,
    };
    const store = createBillingStore(dead, profileReaderOf({}));

    const refused = unwrapRefused(await store.reserve(reserveInput()));
    expect(refused.refusalClass).toBe('BillingStoreUnavailableError');
  });

  it('an unreachable AccessProfileReader refuses with BillingStoreUnavailableError', async () => {
    harness = new BillingPgHarness();
    const store = createBillingStore(harness.engine(), profileReaderOf({})); // 'ap1' not seeded

    const refused = unwrapRefused(await store.reserve(reserveInput({ accessProfileId: 'ap1' })));
    expect(refused.refusalClass).toBe('BillingStoreUnavailableError');
    expect(harness.rows('client_usage')).toHaveLength(0);
  });

  it('the stub of task 015-04 is untouched by this task — its own contract test needs no edit', () => {
    // Not a repeat of billing-store-contract.test.ts — a one-line proof that `createBillingStoreStub`
    // still exists beside `createBillingStore`, the same coexistence `createRequestTraceStoreStub`/
    // `createRequestTraceStore` already establish in `request-trace-store.ts`.
    expect(typeof createBillingStoreStub).toBe('function');
    expect(typeof ClientCreditsExhaustedError).toBe('function');
  });
});
