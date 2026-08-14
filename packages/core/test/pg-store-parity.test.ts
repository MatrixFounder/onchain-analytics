import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CacheStore } from '../src/adapters/cache-store.js';
import { SqliteBudgetStore, type BudgetStore } from '../src/cache/budget-store.js';
import { CACHE_DDL } from '../src/cache/ddl.js';
import { SqliteCacheStore } from '../src/cache/sqlite-store.js';
import { adapterRegistrations } from '../src/providers.config.js';
import { PgBudgetStore } from '../src/pg/budget-store.js';
import { PgCacheStore } from '../src/pg/cache-store.js';
import { LimiterOperatorNotImplementedError, PgLimiterStore } from '../src/pg/limiter-store.js';
import {
  createStateClient,
  STATE_TABLES,
  type PgStateConnectionLike,
  type PgStatePoolCtor,
  type PgStatePoolLike,
  type StateClient,
} from '../src/pg/state-client.js';
import { createStateStores } from '../src/pg/stores.js';

/**
 * Task 014-39 — the Postgres axis measured against the SQLite axis, with no database anywhere.
 *
 * **How a Postgres statement is executed without Postgres.** `data-model.md` §4.2.4 declares that
 * the two dialects differ by exactly three substitutions — `MAX(x, y)` becomes `GREATEST(x, y)`,
 * `INTEGER` becomes `BIGINT`, every object name is schema-qualified — and that "the keys, the
 * columns and the arithmetic are identical". `toSqliteDialect` below REVERSES those substitutions
 * and runs the resulting statement on an in-memory `better-sqlite3`. So what these tests execute is
 * the shipped statement text, structure and all: the guarded `SELECT` source, the conflict branch's
 * own `WHERE`, the `$5 IS NULL` branch and the empty `RETURNING` that means refusal.
 *
 * **What that harness does NOT prove, said plainly rather than left to be assumed.** It cannot
 * observe the row lock the conditional upsert takes, which is the entire concurrency argument
 * (`system-architecture.md` §3.4.8), and it cannot tell `GREATEST` from `MAX`, because the
 * translation maps one to the other. The first is measured by TC-E2E-01/02 against a live Postgres,
 * excluded from CI by R-21. The second is measured HERE, by the dialect gate below, on the text.
 * Between the two, the claim that survives is: the statements say what they must, and they do what
 * they say on the arithmetic they share.
 *
 * **Why parity is also asserted absolutely and not only against SQLite.** Two implementations that
 * are wrong in the same way agree perfectly. The transcript comparison is therefore paired with a
 * block of expected numbers and expected refusal texts that neither axis produced.
 */

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const PG_SRC = resolve(dirname(fileURLToPath(import.meta.url)), '../src/pg');

/** A DSN shaped like a real one, so a leak of it into a message would be visible. Never connected
 * to: every pool below is a fake. */
const FAKE_DSN = 'postgres://engine_state:sup3r-secret-pw@db.internal:5432/postgres';

const PROVIDER = 'nansen';
/** A provider that is registered (so the foreign key resolves) and never written to. */
const QUIET_PROVIDER = 'dune';
const DAY = 1_770_000_000_000;
const WINDOW = 1_770_003_600_000;

/**
 * The three declared substitutions of §4.2.4, applied backwards, plus `$n` → `@pn`.
 *
 * The parameter rewrite is a binding detail, not a dialect one: Postgres numbers its parameters and
 * SQLite's anonymous `?` binds by order of appearance, which would silently misalign every
 * statement that names one parameter twice — and the canonical reservation names `$3`, `$4` and
 * `$5` two or three times each. `@pn` is SQLite's named form and preserves the numbering exactly.
 */
function toSqliteDialect(sql: string): string {
  return sql
    .replace(/\bonchain\./g, '')
    .replace(/\bGREATEST\s*\(/gi, 'MAX(')
    .replace(/\$(\d+)/g, '@p$1');
}

/**
 * An in-memory SQLite database wearing a `pg.Pool`'s interface.
 *
 * **Integer columns come back as STRINGS, on purpose.** `pg` parses `int8` to a string, because an
 * arbitrary `bigint` does not survive a JS number, and every counter column in migration 002 is
 * `BIGINT`. A fake that returned numbers would let a store forget to coerce and still pass every
 * test here, then return `'60'` from `getUsage()` in production, where the caller's
 * `used + cost > ceiling` becomes string concatenation. Imitating the parser is what makes that
 * omission fail a test.
 */
class PostgresDialectHarness {
  readonly db: Database.Database;
  readonly statements: { text: string; values: unknown[] }[] = [];
  readonly poolConfigs: { connectionString: string }[] = [];
  checkouts = 0;
  releases = 0;

  constructor() {
    this.db = new Database(':memory:');
    this.db.exec('PRAGMA foreign_keys = ON;');
    // The SQLite declaration of the same tables (`cache/ddl.ts`). Names and columns are identical to
    // migration 002's by §4.5.1's type map, which is what lets one harness serve the reversed
    // dialect. It is if anything STRICTER: `cache/ddl.ts` carries `CHECK (credits_used >= 0)` on
    // `usage`, which migration 002 does not — a statement that drove the counter negative would fail
    // here and merely be wrong there.
    this.db.exec(CACHE_DDL);
  }

  run(text: string, values: unknown[]): { rows: unknown[] } {
    this.statements.push({ text, values });
    const statement = this.db.prepare(toSqliteDialect(text));
    const bound =
      values.length === 0
        ? undefined
        : Object.fromEntries(values.map((value, index) => [`p${index + 1}`, value]));
    if (!statement.reader) {
      if (bound === undefined) statement.run();
      else statement.run(bound as never);
      return { rows: [] };
    }
    const rows = bound === undefined ? statement.all() : statement.all(bound as never);
    return { rows: rows.map((row) => asPgRow(row)) };
  }

  /** A `PgStatePoolCtor` over this harness — the same injection seam `read-client.ts` established
   * with `PgPoolCtor`, so no test opens a socket (R-21). */
  poolCtor(): PgStatePoolCtor {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const harness = this;
    return class FakePool implements PgStatePoolLike {
      constructor(config: { connectionString: string }) {
        harness.poolConfigs.push(config);
      }
      async query(text: string, values: unknown[] = []): Promise<{ rows: unknown[] }> {
        return harness.run(text, values);
      }
      async connect(): Promise<PgStateConnectionLike> {
        harness.checkouts += 1;
        return {
          query: async (text: string, values: unknown[] = []) => harness.run(text, values),
          release: () => {
            harness.releases += 1;
          },
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

  rows(table: string): unknown[] {
    return this.db.prepare(`SELECT * FROM ${table}`).all();
  }

  close(): void {
    this.db.close();
  }
}

/** `pg`'s int8 parser, imitated: every integer becomes a string, floats and text pass through. */
function asPgRow(row: unknown): unknown {
  if (typeof row !== 'object' || row === null) return row;
  return Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      typeof value === 'number' && Number.isInteger(value) ? String(value) : value,
    ]),
  );
}

// ════════════════════════════════════════════════════════════════════════════════════════════════
// The behavioural parity sequence (TC-E2E-03, run offline)
// ════════════════════════════════════════════════════════════════════════════════════════════════

interface TranscriptEntry {
  step: string;
  outcome: unknown;
  usage: number;
  windowUsage: number;
  windowCalls: number;
}

/**
 * One sequence of inputs, applied to whichever axis is handed in, recording the outcome AND all
 * three counters after every step. The three readings are what make a silent divergence visible:
 * two stores can return the same `{ok:true}` while writing different numbers.
 */
async function transcript(store: BudgetStore): Promise<TranscriptEntry[]> {
  const entries: TranscriptEntry[] = [];
  const record = async (step: string, outcome: unknown): Promise<void> => {
    entries.push({
      step,
      outcome,
      usage: await store.getUsage(PROVIDER, DAY),
      windowUsage: await store.getWindowUsage(PROVIDER, WINDOW),
      windowCalls: await store.getWindowCalls(PROVIDER, WINDOW),
    });
  };

  await record(
    'reserve 30 under a ceiling of 100',
    await store.checkAndReserve(PROVIDER, DAY, 30, 100),
  );
  await record('reserve 30 again', await store.checkAndReserve(PROVIDER, DAY, 30, 100));
  await record('reserve 50 over the ceiling', await store.checkAndReserve(PROVIDER, DAY, 50, 100));
  // The `off` ceiling — `+Infinity` — must be bound as SQL NULL, and both `$5 IS NULL` branches must
  // survive. A statement missing them refuses this step (`… <= NULL` is NULL, zero rows).
  await record(
    'reserve 1 with the ceiling off',
    await store.checkAndReserve(PROVIDER, DAY, 1, Number.POSITIVE_INFINITY),
  );
  await store.recordDelta(PROVIDER, DAY, -40, WINDOW);
  await record('reconcile -40 credits', 'recordDelta');
  const velocity = { windowStartMs: WINDOW, ceiling: 10, maxCalls: 2 } as const;
  await record(
    'reserve 5 within the window',
    await store.checkAndReserve(PROVIDER, DAY, 5, 100, velocity),
  );
  await record(
    'a zero-cost call, second of two',
    await store.checkAndReserve(PROVIDER, DAY, 0, 100, velocity),
  );
  // Q-3: a zero-cost call cannot be refused by a credit-denominated bound, under any cap.
  await record(
    'a zero-cost call past the call cap',
    await store.checkAndReserve(PROVIDER, DAY, 0, 100, velocity),
  );
  await record(
    'a call the window credit bound refuses',
    await store.checkAndReserve(PROVIDER, DAY, 8, 100, {
      windowStartMs: WINDOW,
      ceiling: 10,
      maxCalls: 5,
    }),
  );
  await store.recordDelta(PROVIDER, DAY, -3, WINDOW);
  await record('reconcile -3 into the window', 'recordDelta');
  await store.recordDelta(PROVIDER, DAY, -500, WINDOW);
  await record('refund more than was ever spent', 'recordDelta');
  entries.push({
    step: 'a provider with no rows at all',
    outcome: 'reads only',
    usage: await store.getUsage(QUIET_PROVIDER, DAY),
    windowUsage: await store.getWindowUsage(QUIET_PROVIDER, WINDOW),
    windowCalls: await store.getWindowCalls(QUIET_PROVIDER, WINDOW),
  });
  return entries;
}

describe('BudgetStore parity — the same inputs on both storage axes', () => {
  let harness: PostgresDialectHarness;
  let sqliteStore: SqliteBudgetStore;

  beforeEach(() => {
    harness = new PostgresDialectHarness();
    sqliteStore = new SqliteBudgetStore({ dbPath: ':memory:' });
  });

  afterEach(() => {
    sqliteStore.close();
    harness.close();
  });

  it('TC-E2E-03: the two axes produce the same outcomes and the same counters', async () => {
    const sqlite = await transcript(sqliteStore);
    const postgres = await transcript(new PgBudgetStore({ client: harness.client() }));
    expect(postgres).toEqual(sqlite);
  });

  it('TC-E2E-03b: and the shared transcript is the RIGHT one, not merely a shared one', async () => {
    // Two implementations that are wrong in the same way agree perfectly, so the numbers below are
    // stated independently of either axis.
    const entries = await transcript(new PgBudgetStore({ client: harness.client() }));
    const byStep = new Map(entries.map((entry) => [entry.step, entry]));

    expect(byStep.get('reserve 30 under a ceiling of 100')?.outcome).toEqual({ ok: true });
    expect(byStep.get('reserve 30 again')?.usage).toBe(60);
    expect(byStep.get('reserve 50 over the ceiling')?.outcome).toEqual({
      ok: false,
      reason: 'budget exceeded for provider=nansen: need 50, used 60, ceiling 100',
    });
    // TC-UNIT-03/TC-UNIT-05 in one reading: the refusal names cost, used and ceiling, and the
    // counter did not move.
    expect(byStep.get('reserve 50 over the ceiling')?.usage).toBe(60);
    expect(byStep.get('reserve 1 with the ceiling off')?.outcome).toEqual({ ok: true });
    expect(byStep.get('reserve 1 with the ceiling off')?.usage).toBe(61);
    expect(byStep.get('reconcile -40 credits')?.usage).toBe(21);
    expect(byStep.get('reserve 5 within the window')).toMatchObject({
      usage: 26,
      windowUsage: 5,
      windowCalls: 1,
    });
    expect(byStep.get('a zero-cost call, second of two')).toMatchObject({
      outcome: { ok: true },
      windowUsage: 5,
      windowCalls: 2,
    });
    expect(byStep.get('a zero-cost call past the call cap')?.outcome).toEqual({
      ok: false,
      reason:
        'call rate limit reached for provider=nansen: 2 of 2 calls already made in the current window ' +
        `(window starts ${WINDOW})`,
    });
    // TC-UNIT-04: the daily statement succeeded and the window statement returned zero rows, so the
    // whole transaction rolled back — `usage` is 26, the value it held before this step.
    expect(byStep.get('a call the window credit bound refuses')).toMatchObject({
      outcome: {
        ok: false,
        reason:
          'velocity limit reached for provider=nansen: need 8, used 5 of 10 in the current window ' +
          `(window starts ${WINDOW})`,
      },
      usage: 26,
      windowUsage: 5,
      windowCalls: 2,
    });
    // TC-UNIT-08: credits fall, the call count does not.
    expect(byStep.get('reconcile -3 into the window')).toMatchObject({
      usage: 23,
      windowUsage: 2,
      windowCalls: 2,
    });
    // TC-UNIT-09: a refund larger than the balance clamps at zero and never goes negative — the
    // `GREATEST(0, …)` obligation of §4.2.4. `calls_made` still does not move.
    expect(byStep.get('refund more than was ever spent')).toMatchObject({
      usage: 0,
      windowUsage: 0,
      windowCalls: 2,
    });
    // TC-UNIT-11.
    expect(byStep.get('a provider with no rows at all')).toMatchObject({
      usage: 0,
      windowUsage: 0,
      windowCalls: 0,
    });
  });

  it('TC-UNIT-02: an undecidable comparison refuses before any statement is sent', async () => {
    const store = new PgBudgetStore({ client: harness.client() });
    // Flush the construction-time bootstrap first, so the baseline counts only what it issued.
    expect(await store.getUsage(PROVIDER, DAY)).toBe(0);
    const baseline = harness.statements.length;

    const unpriced = await store.checkAndReserve(PROVIDER, DAY, Number.POSITIVE_INFINITY, 100);
    const undecidable = await store.checkAndReserve(PROVIDER, DAY, 5, Number.NaN);

    expect(unpriced.ok).toBe(false);
    expect(undecidable.ok).toBe(false);
    expect(harness.statements.length).toBe(baseline);
  });

  it('TC-UNIT-03: a refused reservation leaves both tables byte-for-byte unchanged', async () => {
    const store = new PgBudgetStore({ client: harness.client() });
    expect(await store.checkAndReserve(PROVIDER, DAY, 90, 100)).toEqual({ ok: true });
    const usageBefore = JSON.stringify(harness.rows('usage'));
    const windowBefore = JSON.stringify(harness.rows('usage_window'));

    const refused = await store.checkAndReserve(PROVIDER, DAY, 20, 100, {
      windowStartMs: WINDOW,
      ceiling: 1000,
    });

    expect(refused.ok).toBe(false);
    expect(JSON.stringify(harness.rows('usage'))).toBe(usageBefore);
    expect(JSON.stringify(harness.rows('usage_window'))).toBe(windowBefore);
  });

  it('TC-UNIT-07: recordDelta writes the refund and binds no ceiling', async () => {
    const store = new PgBudgetStore({ client: harness.client() });
    await store.checkAndReserve(PROVIDER, DAY, 60, 100);
    harness.statements.length = 0;

    await store.recordDelta(PROVIDER, DAY, -40, WINDOW);

    expect(await store.getUsage(PROVIDER, DAY)).toBe(20);
    const written = harness.statements.filter((s) => /INSERT INTO onchain\./.test(s.text));
    expect(written).toHaveLength(2);
    for (const statement of written) {
      // The ceiling is a `WHERE` on the reservation statements and appears in neither of these:
      // "Reconciliation is a second statement and carries no ceiling bound" (data-model.md:582).
      expect(statement.text).not.toMatch(/\bWHERE\b/i);
    }
  });

  it('TC-UNIT-10: the window prune runs inside the reservation transaction', async () => {
    const store = new PgBudgetStore({ client: harness.client() });
    // Flush the bootstrap before writing a row that references `providers` by foreign key.
    expect(await store.getUsage(PROVIDER, DAY)).toBe(0);
    const velocity = { windowStartMs: WINDOW, ceiling: 100, maxCalls: 10 } as const;
    const stale = WINDOW - 7_200_000;
    harness.db
      .prepare(
        `INSERT INTO usage_window (provider, window_start, credits_used, calls_made, updated_at)
         VALUES (?, ?, 0, 0, 0)`,
      )
      .run(PROVIDER, stale);

    // A reservation refused by the DAILY ceiling never reaches the prune — and even if it did, the
    // rollback would restore the row. Either way the stale row survives a refusal.
    const refused = await store.checkAndReserve(PROVIDER, DAY, 500, 100, velocity);
    expect(refused.ok).toBe(false);
    expect(harness.rows('usage_window')).toHaveLength(1);

    const accepted = await store.checkAndReserve(PROVIDER, DAY, 5, 100, velocity);
    expect(accepted).toEqual({ ok: true });
    const remaining = harness.rows('usage_window') as { window_start: number }[];
    expect(remaining.map((row) => row.window_start)).toEqual([WINDOW]);
  });

  it('TC-UNIT-01: construction upserts the twelve providers and issues no DDL', async () => {
    const store = new PgBudgetStore({ client: harness.client() });
    expect(await store.getUsage(PROVIDER, DAY)).toBe(0);

    const kinds = harness.statements.filter((s) => !['BEGIN', 'COMMIT'].includes(s.text));
    expect(kinds.every((s) => /^(INSERT INTO onchain\.providers|SELECT)/.test(s.text))).toBe(true);
    expect(kinds.some((s) => /CREATE|ALTER|DROP|GRANT/i.test(s.text))).toBe(false);
    expect(harness.rows('providers')).toHaveLength(12);
    // One transaction, one connection, released.
    expect(harness.checkouts).toBe(1);
    expect(harness.releases).toBe(1);
  });

  it('a storage failure fails CLOSED — it never answers ok', async () => {
    const client = harness.client();
    // A pool whose statements always reject: the "database unavailable" residue, i.e. nothing
    // answered. `§3.2 Fail-closed, never fail-open` — the paid call must not proceed, and on both
    // axes that arrives as a throw (better-sqlite3 throws too), never as `{ok:true}`.
    const dead: StateClient = {
      isAvailable: () => ({ ok: true }),
      query: () => Promise.reject(new Error('pg/state-client: database unavailable')),
      transaction: () => Promise.reject(new Error('pg/state-client: database unavailable')),
    };
    const store = new PgBudgetStore({ client: dead });
    await expect(store.checkAndReserve(PROVIDER, DAY, 1, 100)).rejects.toThrow(
      'database unavailable',
    );
    // And the healthy client is untouched by that store's failure.
    expect(client.isAvailable()).toEqual({ ok: true });
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// CacheStore parity
// ════════════════════════════════════════════════════════════════════════════════════════════════

describe('CacheStore parity — the same inputs on both storage axes', () => {
  let harness: PostgresDialectHarness;
  let dir: string;
  let sqliteStore: SqliteCacheStore;
  let pgStore: PgCacheStore;

  const CAPABILITY = 'token.price';
  const ARGS = 'a'.repeat(64);

  beforeEach(async () => {
    harness = new PostgresDialectHarness();
    dir = mkdtempSync(join(tmpdir(), 'onchain-pg-parity-'));
    sqliteStore = new SqliteCacheStore({
      dbPath: join(dir, 'cache.sqlite3'),
      providers: adapterRegistrations,
    });
    // `cache_entries.provider` is a foreign key; on the Postgres axis the budget store is what
    // bootstraps `providers`, and its `ready` promise is the barrier the cache store waits on —
    // exactly the wiring `pg/stores.ts` performs.
    const budget = new PgBudgetStore({ client: harness.client() });
    pgStore = new PgCacheStore({ client: harness.client(), ready: budget.ready });
    await budget.ready;
  });

  afterEach(() => {
    sqliteStore.close();
    harness.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('a stored value comes back on both axes, with an age', async () => {
    for (const store of [sqliteStore, pgStore] as CacheStore[]) {
      await store.set(PROVIDER, CAPABILITY, ARGS, { price: 1.5 }, 60);
      const hit = await store.get(PROVIDER, CAPABILITY, ARGS);
      expect(hit?.value).toEqual({ price: 1.5 });
      expect(hit?.ageMs).toBeGreaterThanOrEqual(0);
      expect(hit?.ageMs).toBeLessThan(1000);
    }
  });

  it('TC-E2E-05: an expired row is not served, and is deleted on the same read', async () => {
    const sqlitePath = join(dir, 'cache.sqlite3');
    for (const store of [sqliteStore, pgStore] as CacheStore[]) {
      await store.set(PROVIDER, CAPABILITY, ARGS, { price: 1.5 }, -1);
      expect(await store.get(PROVIDER, CAPABILITY, ARGS)).toBeUndefined();
    }
    expect(harness.rows('cache_entries')).toHaveLength(0);
    const inspector = new Database(sqlitePath, { readonly: true });
    try {
      expect(inspector.prepare('SELECT * FROM cache_entries').all()).toHaveLength(0);
    } finally {
      inspector.close();
    }
  });

  it('a rewritten key replaces the value on both axes rather than pinning the old one', async () => {
    for (const store of [sqliteStore, pgStore] as CacheStore[]) {
      await store.set(PROVIDER, CAPABILITY, ARGS, { price: 1 }, 60);
      await store.set(PROVIDER, CAPABILITY, ARGS, { price: 2 }, 60);
      expect((await store.get(PROVIDER, CAPABILITY, ARGS))?.value).toEqual({ price: 2 });
    }
    expect(harness.rows('cache_entries')).toHaveLength(1);
  });

  it('the counter-based sweep removes expired rows and runs no timer', async () => {
    const store = new PgCacheStore({ client: harness.client(), sweepEveryNWrites: 2 });
    await store.set(PROVIDER, CAPABILITY, 'b'.repeat(64), { v: 1 }, -1);
    expect(harness.rows('cache_entries')).toHaveLength(1);
    await store.set(PROVIDER, CAPABILITY, 'c'.repeat(64), { v: 2 }, 60);
    // The second write triggers the sweep: the expired row is gone, the live one stays.
    const rows = harness.rows('cache_entries') as { args_hash: string }[];
    expect(rows.map((row) => row.args_hash)).toEqual(['c'.repeat(64)]);
  });

  it('an int8 column arriving as a string is coerced, not concatenated', async () => {
    // The harness returns integers as strings, imitating `pg`'s int8 parser. If `created_at` were
    // used uncoerced, `ageMs` would be `NaN` and this assertion is what sees it.
    await pgStore.set(PROVIDER, CAPABILITY, ARGS, { price: 1 }, 60);
    const hit = await pgStore.get(PROVIDER, CAPABILITY, ARGS);
    expect(Number.isFinite(hit?.ageMs)).toBe(true);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// The dialect gate — on the text, where the harness cannot see (AC-46, §4.2.4 substitutions)
// ════════════════════════════════════════════════════════════════════════════════════════════════

/** Source with comments removed, so a forbidden form quoted in prose stays prose — the same rule
 * `pg-migration-static.test.ts` applies to the migration's `--` lines. */
function codeOf(file: string): string {
  return readFileSync(join(PG_SRC, file), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
}

/** Every SQL statement this package ships on the Postgres axis, extracted from the template
 * literals that hold them. */
function sqlLiterals(file: string): string[] {
  return [...codeOf(file).matchAll(/`([^`]*)`/g)]
    .map((match) => match[1] ?? '')
    .filter((literal) => /^\s*(INSERT|SELECT|DELETE|UPDATE)\b/i.test(literal));
}

const PG_MODULES = ['budget-store.ts', 'cache-store.ts', 'state-client.ts', 'limiter-store.ts'];

describe('the four dialect obligations of data-model.md §4.2.4, checked on the shipped text', () => {
  const everyStatement = PG_MODULES.flatMap((file) =>
    sqlLiterals(file).map((sql) => ({ file, sql })),
  );

  it('there are statements to check at all', () => {
    // A gate whose input is empty passes forever. This is the assertion that stops a rename of the
    // extraction pattern from turning every check below into a no-op.
    expect(everyStatement.length).toBeGreaterThanOrEqual(9);
  });

  it('substitution: GREATEST, never the two-argument MAX Postgres does not have', () => {
    for (const { file, sql } of everyStatement) {
      expect(
        sql,
        `${file}: MAX(x, y) is an aggregate in Postgres and has no two-argument form`,
      ).not.toMatch(/\bMAX\s*\(/i);
    }
    // The check can go red: this is the same clamp, written the SQLite way.
    expect('UPDATE onchain.usage SET credits_used = MAX(0, credits_used + $1)').toMatch(
      /\bMAX\s*\(/i,
    );
  });

  it('substitution: BIGINT, never INTEGER', () => {
    for (const { file, sql } of everyStatement) {
      expect(sql, `${file}`).not.toMatch(/\bINTEGER\b/i);
    }
    expect('SELECT CAST($1 AS INTEGER) FROM onchain.usage').toMatch(/\bINTEGER\b/i);
  });

  it('substitution: every object name is schema-qualified (R-30.1, AC-46)', async () => {
    // Checked by running each shipped statement through the client's OWN runtime guard, so the gate
    // and the guard cannot drift apart: one list of tables, one regex, two consumers.
    const guardOnly: PgStatePoolCtor = class implements PgStatePoolLike {
      async query(): Promise<{ rows: unknown[] }> {
        return { rows: [] };
      }
      async connect(): Promise<PgStateConnectionLike> {
        return { query: async () => ({ rows: [] }), release: () => {} };
      }
    };
    const client = createStateClient({
      env: { ONCHAIN_STATE_PG_URL: FAKE_DSN } as NodeJS.ProcessEnv,
      PoolCtor: guardOnly,
    });
    for (const { file, sql } of everyStatement) {
      await expect(client.query(sql, []), `${file}: ${sql.slice(0, 60)}`).resolves.toEqual([]);
    }
    // The same statement with its schema removed is refused — the mutant that proves the guard is
    // load-bearing rather than decorative.
    await expect(
      client.query('SELECT credits_used FROM usage WHERE provider = $1', []),
    ).rejects.toThrow(/schema-qualified/);
  });

  it('STATE_TABLES names exactly the tables migration 002 creates', () => {
    const migration = readFileSync(
      join(REPO_ROOT, 'sql/migrations/002_t014_network_profile.sql'),
      'utf8',
    );
    const created = [...migration.matchAll(/CREATE TABLE IF NOT EXISTS\s+onchain\.(\w+)/gi)]
      .map((match) => (match[1] ?? '').toLowerCase())
      .sort();
    expect([...STATE_TABLES].sort()).toEqual(created);
  });
});

describe('the two branches a paraphrase would drop, proven load-bearing on the shipped statement', () => {
  let harness: PostgresDialectHarness;

  beforeEach(() => {
    harness = new PostgresDialectHarness();
    harness.db
      .prepare(`INSERT INTO providers (id, kind, notes) VALUES (?, 'paid', NULL)`)
      .run(PROVIDER);
  });

  afterEach(() => harness.close());

  /** The canonical daily reservation, taken from the module rather than retyped here — a copy in
   * the test would be a second source of the one statement, and the copy is always the one that
   * drifts. */
  const dailyReservation = (): string => {
    const found = sqlLiterals('budget-store.ts').find((sql) =>
      /INSERT INTO onchain\.usage\s*\(/i.test(sql),
    );
    if (found === undefined) throw new Error('the daily reservation statement was not found');
    return found;
  };

  it('TC-E2E-04: with the `$5 IS NULL` branch, an unlimited ceiling reserves', () => {
    const rows = harness.run(dailyReservation(), [PROVIDER, DAY, 7, 1, null]).rows;
    expect(rows).toHaveLength(1);
  });

  it('TC-E2E-04 (mutant): without it, EVERY reservation under an unlimited ceiling is refused', () => {
    // `… <= NULL` is NULL, not false — the statement returns zero rows and the store reads that as
    // a refusal. This is the paraphrase `system-architecture.md` §3.4.8 warns about, executed.
    const mutant = dailyReservation().replace(/\$5 IS NULL OR /g, '');
    expect(harness.run(mutant, [PROVIDER, DAY, 7, 1, null]).rows).toHaveLength(0);
    expect(harness.rows('usage')).toHaveLength(0);
  });

  it('the repeated WHERE on the insert branch is what bounds the FIRST call of a day', () => {
    // With the guard present, a cost larger than the whole ceiling is refused on a fresh row.
    expect(harness.run(dailyReservation(), [PROVIDER, DAY, 500, 1, 100]).rows).toHaveLength(0);
    // Mutant: drop the source's own WHERE and the conflict branch's guard no longer covers the
    // fresh-row path, so the first call of a day reserves more than the ceiling allows.
    const mutant = dailyReservation().replace(/WHERE \(\$5 IS NULL OR \$3 <= \$5\)/, '');
    expect(harness.run(mutant, [PROVIDER, DAY, 500, 1, 100]).rows).toHaveLength(1);
    expect(harness.rows('usage')).toHaveLength(1);
  });

  it('calls_made is monotonic BECAUSE the reconciliation statement says so', async () => {
    const store = new PgBudgetStore({ client: harness.client(), providers: [] });
    await store.checkAndReserve(PROVIDER, DAY, 10, 100, {
      windowStartMs: WINDOW,
      ceiling: 100,
      maxCalls: 5,
    });
    expect(await store.getWindowCalls(PROVIDER, WINDOW)).toBe(1);

    await store.recordDelta(PROVIDER, DAY, -10, WINDOW);
    expect(await store.getWindowCalls(PROVIDER, WINDOW)).toBe(1);
    expect(await store.getWindowUsage(PROVIDER, WINDOW)).toBe(0);

    // Mutant: the same statement with the call count moved by the credit delta — the shape a
    // "symmetric" refactor would produce. It drops the count to zero, which is the path a run of
    // cheap-then-refunded calls would walk past the limit through.
    const reconciliation = sqlLiterals('budget-store.ts').find((sql) =>
      /INSERT INTO onchain\.usage_window[\s\S]*VALUES/i.test(sql),
    );
    expect(reconciliation).toBeDefined();
    const mutant = (reconciliation ?? '').replace(
      /calls_made\s+= onchain\.usage_window\.calls_made,/,
      'calls_made   = GREATEST(0, onchain.usage_window.calls_made + $3),',
    );
    expect(mutant).not.toBe(reconciliation);
    harness.run(mutant, [PROVIDER, WINDOW, -10, Date.now()]);
    const row = harness.rows('usage_window')[0] as { calls_made: number };
    expect(row.calls_made).toBe(0);
  });
});

// ════════════════════════════════════════════════════════════════════════════════════════════════
// The write client itself, and the axis factory
// ════════════════════════════════════════════════════════════════════════════════════════════════

describe('the state client is a SECOND client, and a guarded one', () => {
  let harness: PostgresDialectHarness;

  beforeEach(() => {
    harness = new PostgresDialectHarness();
  });
  afterEach(() => harness.close());

  it('reports its own DSN key, not the read client’s', () => {
    const unset = createStateClient({ env: {} as NodeJS.ProcessEnv, PoolCtor: harness.poolCtor() });
    expect(unset.isAvailable()).toEqual({ ok: false, reason: 'needs ONCHAIN_STATE_PG_URL' });
    // The read client's key must not satisfy the write client: two DSNs, two roles, two grants
    // (deployment.md §10.5.1).
    const readOnlyKeyOnly = createStateClient({
      env: { ONCHAIN_PG_URL: FAKE_DSN } as NodeJS.ProcessEnv,
      PoolCtor: harness.poolCtor(),
    });
    expect(readOnlyKeyOnly.isAvailable().ok).toBe(false);
  });

  it('refuses DDL and DCL — the server process never writes schema', async () => {
    const client = harness.client();
    for (const sql of [
      'CREATE TABLE onchain.usage (x BIGINT)',
      'ALTER TABLE onchain.usage ADD COLUMN x BIGINT',
      'DROP TABLE onchain.usage',
      'GRANT SELECT ON onchain.usage TO someone',
    ]) {
      await expect(client.query(sql, [])).rejects.toThrow(/no DDL or DCL/);
    }
    expect(harness.statements).toHaveLength(0);
  });

  it('runs a transaction on ONE checked-out connection and releases it on every path', async () => {
    const client = harness.client();
    await client.transaction(async (tx) => {
      await tx.query('SELECT credits_used FROM onchain.usage WHERE provider = $1', [PROVIDER]);
    });
    expect(harness.checkouts).toBe(1);
    expect(harness.releases).toBe(1);
    expect(harness.statements.map((s) => s.text)).toEqual([
      'BEGIN',
      'SELECT credits_used FROM onchain.usage WHERE provider = $1',
      'COMMIT',
    ]);

    await expect(
      client.transaction(async () => {
        throw new Error('the body decided otherwise');
      }),
    ).rejects.toThrow('the body decided otherwise');
    expect(harness.releases).toBe(2);
    expect(harness.statements.at(-1)?.text).toBe('ROLLBACK');
  });

  it('never lets the DSN reach a caller when the pool fails', async () => {
    const leaky: PgStatePoolCtor = class implements PgStatePoolLike {
      query(): Promise<{ rows: unknown[] }> {
        return Promise.reject(new Error(`connection to server at ${FAKE_DSN} failed`));
      }
      connect(): Promise<PgStateConnectionLike> {
        return Promise.reject(new Error(`connection to server at ${FAKE_DSN} failed`));
      }
    };
    const client = createStateClient({
      env: { ONCHAIN_STATE_PG_URL: FAKE_DSN } as NodeJS.ProcessEnv,
      PoolCtor: leaky,
    });
    await expect(client.query('SELECT 1 FROM onchain.usage', [])).rejects.toThrow(
      'pg/state-client: database unavailable',
    );
    await expect(client.query('SELECT 1 FROM onchain.usage', [])).rejects.not.toThrow(
      /sup3r-secret-pw/,
    );
  });

  it('tells "the server answered with an error" apart from "nothing answered"', async () => {
    const rejecting: PgStatePoolCtor = class implements PgStatePoolLike {
      query(): Promise<{ rows: unknown[] }> {
        return Promise.reject(
          Object.assign(new Error('relation "usage" does not exist'), {
            code: '42P01',
            severity: 'ERROR',
          }),
        );
      }
      connect(): Promise<PgStateConnectionLike> {
        return Promise.reject(new Error('not used'));
      }
    };
    const client = createStateClient({
      env: { ONCHAIN_STATE_PG_URL: FAKE_DSN } as NodeJS.ProcessEnv,
      PoolCtor: rejecting,
    });
    await expect(client.query('SELECT 1 FROM onchain.usage', [])).rejects.toThrow(
      /database reachable, request rejected \(SQLSTATE 42P01, ERROR\)/,
    );
  });
});

describe('the axis factory and the limiter slot', () => {
  let harness: PostgresDialectHarness;
  let dir: string;

  beforeEach(() => {
    harness = new PostgresDialectHarness();
    dir = mkdtempSync(join(tmpdir(), 'onchain-pg-axis-'));
  });
  afterEach(() => {
    harness.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('the postgres axis yields Pg implementations of the two interfaces that already existed', async () => {
    const stores = createStateStores({ storage: 'postgres', client: harness.client() });
    // TC-UNIT-06 in its runtime half: the compile-time half is the type annotations below, which
    // `pnpm typecheck` is what actually enforces.
    const cache: CacheStore = stores.cache;
    const budget: BudgetStore = stores.budget;
    await cache.set(PROVIDER, 'token.price', 'd'.repeat(64), { price: 3 }, 60);
    expect((await cache.get(PROVIDER, 'token.price', 'd'.repeat(64)))?.value).toEqual({ price: 3 });
    expect(await budget.getUsage(PROVIDER, DAY)).toBe(0);
    expect(stores.limiter.kind).toBe('store');
  });

  it('the sqlite axis yields the shipped implementations and names the missing limiter', () => {
    const stores = createStateStores({ storage: 'sqlite', dbPath: join(dir, 'cache.sqlite3') });
    expect(stores.limiter).toEqual({
      kind: 'absent',
      reason: 'SqliteLimiterStore is not written yet; the limiter still uses its in-process bucket',
      owner: 'task 014-18',
    });
  });

  it('an option belonging to the other axis is refused, never ignored', () => {
    expect(() =>
      createStateStores({ storage: 'postgres', client: harness.client(), dbPath: 'x' }),
    ).toThrow(/dbPath belongs to the sqlite axis/);
    expect(() => createStateStores({ storage: 'sqlite', client: harness.client() })).toThrow(
      /sqlite axis/,
    );
  });

  it('the limiter slot operator is task 014-18, and says so as a distinguishable class', () => {
    const limiter = new PgLimiterStore({ client: harness.client() });
    let thrown: unknown;
    try {
      void limiter.takeTokens(PROVIDER, '', 10, 1, Date.now(), 5);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(LimiterOperatorNotImplementedError);
    // R-7.7's fallback catches a store FAILURE; this must not be mistaken for one, or the process
    // would degrade silently and forever instead of naming an unwritten operator.
    expect((thrown as Error).message).toContain('task 014-18');
    expect(thrown).not.toBeInstanceOf(TypeError);
  });
});
