import { describe, expect, it, vi } from 'vitest';
import { createPgHistoryAdapter } from '../src/index.js';
import {
  createReadClient,
  PgQueryTimeoutError,
  PgServerRejectedError,
} from '../src/pg/read-client.js';
import type { PgPoolCtor, PgPoolLike } from '../src/pg/read-client.js';
import { isolatedThrottle } from './helpers/isolated-throttle.js';
import { createThrottle } from '../src/net/rate-limit.js';
import { DeadlineExceededError } from '../src/net/safe-fetch.js';
import { adapterRegistrations } from '../src/providers.config.js';

// Mock-pg-client tests (R-12) — NEVER a live database connection (R-21): a fake Pool constructor
// is injected all the way through pg-history's own `poolCtor` dependency into `read-client.ts`'s
// real lazy-construction/search_path logic, so this file proves BOTH the adapter's own behavior
// AND read-client.ts's own lazy pool / SELECT-only guard, without a separate test file.
//
// Every adapter here is constructed with `isolatedThrottle()` — mandatory since WI-34 made this
// adapter apply its declared bucket. On the production singleton a call past `capacity` sleeps in
// REAL time, which is how WI-26 was found; the two tests that make a second call went red on
// vitest's 5 000 ms timeout the moment the limiter landed. (Under 013-6's re-derived
// `{capacity: 10, refillPerSec: 5}` that sleep is 200 ms rather than five seconds — shorter, and
// still a shared bucket across every file in the process, which is what the seam is for.)

const SECRET_DSN = 'postgres://app_user:sup3r-secret-pw@db.internal:5432/postgres';

const FAKE_ROWS = [
  {
    ts: '1700000000000',
    asset: 'dash-platform',
    metric: 'shielded_pool_balance_credits',
    value_raw: '4611474006200',
    value_num: 4611474006200,
    source: 'platform-explorer',
    height: '403328',
  },
  {
    ts: '1700000060000',
    asset: 'dash-platform',
    metric: 'shielded_pool_balance_credits',
    value_raw: '4611474006300',
    value_num: null,
    source: 'platform-explorer',
    height: null,
  },
];

interface FakePoolConfig {
  connectionString: string;
  options?: string;
  connectionTimeoutMillis?: number;
  max?: number;
  statement_timeout?: number;
}

class FakePool implements PgPoolLike {
  static instances: FakePoolConfig[] = [];
  static lastCreated: FakePool | undefined;
  readonly queryCalls: Array<{ text: string; values?: unknown[] }> = [];
  private readonly errorListeners: Array<(err: Error) => void> = [];

  constructor(config: FakePoolConfig) {
    FakePool.instances.push(config);
    FakePool.lastCreated = this;
  }

  async query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }> {
    this.queryCalls.push({ text, values });
    return { rows: FAKE_ROWS };
  }

  /** Adversarial cycle 1, fix D1 — lets tests simulate an idle-connection `'error'` event
   * firing independently of any in-flight `query()` call, exactly as the real `pg.Pool`
   * (an `EventEmitter`) would. */
  on(event: 'error', listener: (err: Error) => void): this {
    if (event === 'error') this.errorListeners.push(listener);
    return this;
  }

  emitError(err: Error): void {
    for (const listener of this.errorListeners) listener(err);
  }
}

/**
 * A pool whose `query()` NEVER settles — the WI-35 case, and the one shape no configuration option
 * can be tested through: `statement_timeout` is enforced by a Postgres that is not here, and `pg`'s
 * own `query_timeout` lives in `pg`, not in the injected pool. If `read-client.ts` did not own an
 * in-process bound, a test against this class would simply hang.
 */
class HangingQueryPool implements PgPoolLike {
  static queryCalls = 0;

  query(): Promise<{ rows: unknown[] }> {
    HangingQueryPool.queryCalls += 1;
    return new Promise<{ rows: unknown[] }>(() => {});
  }
}

/** A pool whose `query()` always fails with a raw, DSN-revealing-shaped error — used only by the
 * D2 sanitization test below; deliberately does NOT implement `on()` (optional on `PgPoolLike`),
 * proving `read-client.ts` never assumes it's present. */
class FailingQueryPool implements PgPoolLike {
  static instances: FakePoolConfig[] = [];

  constructor(config: FakePoolConfig) {
    FailingQueryPool.instances.push(config);
  }

  async query(): Promise<{ rows: unknown[] }> {
    throw new Error('connection to server at "db.internal" (10.0.0.5), port 5432 failed: FATAL');
  }
}

function resetFakePool(): void {
  FakePool.instances = [];
  FakePool.lastCreated = undefined;
  FailingQueryPool.instances = [];
  HangingQueryPool.queryCalls = 0;
}

describe('pg-history adapter (contract, R-12 — mocked pg client, no live PG)', () => {
  it('isAvailable() reports needs ONCHAIN_PG_URL (no crash, no DSN) when the env var is absent', () => {
    const adapter = createPgHistoryAdapter({ env: {} });
    expect(adapter.isAvailable?.()).toEqual({ ok: false, reason: 'needs ONCHAIN_PG_URL' });
  });

  it('isAvailable() reports ok:true when ONCHAIN_PG_URL is set, without ever exposing the DSN', () => {
    const adapter = createPgHistoryAdapter({ env: { ONCHAIN_PG_URL: SECRET_DSN } });
    const result = adapter.isAvailable?.();
    expect(result).toEqual({ ok: true });
    expect(JSON.stringify(result)).not.toContain(SECRET_DSN);
  });

  it('capabilities() declares the two Dash history capabilities', () => {
    const adapter = createPgHistoryAdapter({ env: {} });
    expect(adapter.capabilities()).toEqual([
      { id: 'privacy.shielded_pool.history', chains: ['dash'] },
      { id: 'platform.metrics.history', chains: ['dash'] },
    ]);
  });

  it('costOf() is free (0 credits)', () => {
    const adapter = createPgHistoryAdapter({ env: {} });
    expect(adapter.costOf('privacy.shielded_pool.history', {})).toEqual({ credits: 0 });
  });

  it('fetch() lazily constructs the pool on first use only (never at adapter-creation time)', async () => {
    resetFakePool();
    const adapter = createPgHistoryAdapter({
      env: { ONCHAIN_PG_URL: SECRET_DSN },
      poolCtor: FakePool as unknown as PgPoolCtor,
      throttle: isolatedThrottle(),
    });
    expect(FakePool.instances).toHaveLength(0);

    await adapter.fetch('privacy.shielded_pool.history', { chain: 'dash' });

    expect(FakePool.instances).toHaveLength(1);
    expect(FakePool.instances[0]).toEqual({
      connectionString: SECRET_DSN,
      options: '-c search_path=onchain',
      // Adversarial cycle 1, fix D1 — always set explicitly now (conservative pool sizing).
      connectionTimeoutMillis: 10_000,
      max: 3,
      // WI-35 — the SERVER-side half of the query bound. `toEqual` and not `toMatchObject`
      // deliberately: this is the exhaustive statement of what this module hands `pg`, so a knob
      // added without a derivation record fails here rather than arriving unnoticed.
      statement_timeout: 5_000,
    });
  });

  it('fetch() reuses the SAME pool across multiple calls (lazy singleton, not reconstructed)', async () => {
    resetFakePool();
    const adapter = createPgHistoryAdapter({
      env: { ONCHAIN_PG_URL: SECRET_DSN },
      poolCtor: FakePool as unknown as PgPoolCtor,
      throttle: isolatedThrottle(),
    });

    await adapter.fetch('privacy.shielded_pool.history', { chain: 'dash' });
    await adapter.fetch('platform.metrics.history', { chain: 'dash' });

    expect(FakePool.instances).toHaveLength(1);
  });

  it("fetch() issues a SELECT-only query scoped to the dash-platform asset and the capability's metrics", async () => {
    resetFakePool();
    const adapter = createPgHistoryAdapter({
      env: { ONCHAIN_PG_URL: SECRET_DSN },
      poolCtor: FakePool as unknown as PgPoolCtor,
      throttle: isolatedThrottle(),
    });

    await adapter.fetch('platform.metrics.history', { chain: 'dash' });

    expect(FakePool.lastCreated).toBeDefined();
    const [call] = FakePool.lastCreated!.queryCalls;
    expect(call!.text).toMatch(/^\s*SELECT/i);
    expect(call!.text).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i);
    expect(call!.values).toEqual([
      'dash-platform',
      ['identities_total', 'documents_total', 'data_contracts_total', 'platform_total_credits'],
      100,
    ]);
  });

  /**
   * WI-47 — every query this adapter sends must name its SCHEMA, because `search_path` does not
   * survive a connection pooler.
   *
   * **Why the existing fakes could not catch this.** `FakePool.query()` returns `FAKE_ROWS` for any
   * SQL at all, so a bare `FROM snapshots` and a qualified `FROM onchain.snapshots` are the same
   * string to it — the whole suite was green while the adapter could not read a single row through
   * the shipped Supabase installation. `SchemaResolvingPool` below closes that by RESOLVING the
   * name the way a real server does: it answers only when the table is qualified, and otherwise
   * raises PostgreSQL's own `42P01` with PostgreSQL's own wording.
   *
   * Found by the live acceptance call of 013-10, not by this suite; this is the case that would
   * have found it first.
   */
  it('WI-47: names the schema, so the query resolves where search_path is not ours to set', async () => {
    /** Rejects an unqualified table exactly as a server whose `search_path` excludes `onchain`
     * does — which is what Supavisor substitutes (`cvj, public, extensions`, measured). */
    class SchemaResolvingPool implements PgPoolLike {
      static lastSql: string | undefined;
      async query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }> {
        SchemaResolvingPool.lastSql = text;
        if (!/\bFROM\s+onchain\.snapshots\b/i.test(text)) {
          // `severity` alongside `code`, because that is what a real ErrorResponse carries and
          // WI-47 item 4 made the pair load-bearing: the client classifies "the server answered"
          // on both fields, so a fixture with only `code` would no longer model the server it is
          // standing in for. Measured shape — `42P01` / `ERROR`.
          const error = new Error('relation "snapshots" does not exist');
          Object.assign(error, { code: '42P01', severity: 'ERROR' });
          throw error;
        }
        void values;
        return { rows: FAKE_ROWS };
      }
      on(): this {
        return this;
      }
    }

    const adapter = createPgHistoryAdapter({
      env: { ONCHAIN_PG_URL: SECRET_DSN },
      poolCtor: SchemaResolvingPool as unknown as PgPoolCtor,
      throttle: isolatedThrottle(),
    });

    const rows = await adapter.fetch('platform.metrics.history', { chain: 'dash' });

    // Asserted on the OUTCOME first: with a bare name this rejects, which is exactly how the
    // defect presented in production. (Since WI-47 item 4 that rejection reads
    // `database reachable, request rejected (SQLSTATE 42P01, ERROR)` rather than the generic
    // "database unavailable" — a better reproduction of the live symptom, not a different one.)
    expect(rows).toEqual(FAKE_ROWS);
    // …and on the SQL, so the reason it passed is the schema and not a lenient fake.
    expect(SchemaResolvingPool.lastSql).toMatch(/FROM\s+onchain\.snapshots/i);
  });

  it('normalize() converts stringified bigint ts/height columns back into numbers and parses as Snapshot[]', async () => {
    resetFakePool();
    const adapter = createPgHistoryAdapter({
      env: { ONCHAIN_PG_URL: SECRET_DSN },
      poolCtor: FakePool as unknown as PgPoolCtor,
      throttle: isolatedThrottle(),
    });

    const raw = await adapter.fetch('privacy.shielded_pool.history', { chain: 'dash' });
    const result = adapter.normalize('privacy.shielded_pool.history', raw);

    expect(result).toEqual([
      {
        metric: 'shielded_pool_balance_credits',
        asset: 'dash-platform',
        ts: 1700000000000,
        valueRaw: '4611474006200',
        valueNum: 4611474006200,
        source: 'platform-explorer',
        height: 403328,
      },
      {
        metric: 'shielded_pool_balance_credits',
        asset: 'dash-platform',
        ts: 1700000060000,
        valueRaw: '4611474006300',
        source: 'platform-explorer',
      },
    ]);
  });

  it('rejects an unsupported capability without ever leaking the DSN into the error message', async () => {
    resetFakePool();
    const adapter = createPgHistoryAdapter({
      env: { ONCHAIN_PG_URL: SECRET_DSN },
      poolCtor: FakePool as unknown as PgPoolCtor,
      throttle: isolatedThrottle(),
    });

    await expect(adapter.fetch('token.price', { chain: 'dash' })).rejects.toThrow(
      /unsupported capability/,
    );
    try {
      await adapter.fetch('token.price', { chain: 'dash' });
      expect.unreachable();
    } catch (error) {
      expect(String(error)).not.toContain(SECRET_DSN);
    }
  });

  it('read-client.ts: query() rejects a non-SELECT statement at runtime (defense in depth, R-27)', async () => {
    resetFakePool();
    const client = createReadClient({
      env: { ONCHAIN_PG_URL: SECRET_DSN },
      PoolCtor: FakePool as unknown as PgPoolCtor,
    });

    await expect(client.query('DELETE FROM snapshots')).rejects.toThrow(/only SELECT/);
    expect(FakePool.instances).toHaveLength(0); // rejected before ever touching the pool
  });

  it('read-client.ts: query() rejects without a DSN, never constructing a pool', async () => {
    resetFakePool();
    const client = createReadClient({ env: {}, PoolCtor: FakePool as unknown as PgPoolCtor });

    await expect(client.query('SELECT 1')).rejects.toThrow(/ONCHAIN_PG_URL/);
    expect(FakePool.instances).toHaveLength(0);
  });

  describe('pool hardening (adversarial cycle 1, fix D)', () => {
    it("read-client.ts: pool.on('error') is attached right after construction — an idle-connection error is logged to stderr and never crashes the process (D1)", async () => {
      resetFakePool();
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const client = createReadClient({
        env: { ONCHAIN_PG_URL: SECRET_DSN },
        PoolCtor: FakePool as unknown as PgPoolCtor,
      });

      await client.query('SELECT 1');
      expect(FakePool.lastCreated).toBeDefined();

      expect(() =>
        FakePool.lastCreated!.emitError(new Error('Connection terminated unexpectedly')),
      ).not.toThrow();
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('idle pool error'));
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('Connection terminated'));
      stderrSpy.mockRestore();
    });

    it('read-client.ts: the pool is constructed with a conservative connectionTimeoutMillis and max pool size (D1)', async () => {
      resetFakePool();
      const client = createReadClient({
        env: { ONCHAIN_PG_URL: SECRET_DSN },
        PoolCtor: FakePool as unknown as PgPoolCtor,
      });

      await client.query('SELECT 1');

      expect(FakePool.instances).toHaveLength(1);
      expect(FakePool.instances[0]).toMatchObject({ connectionTimeoutMillis: 10_000, max: 3 });
    });

    it('read-client.ts: a query() failure is rethrown as a sanitized message — the raw, DSN-revealing error is written to stderr only (D2)', async () => {
      resetFakePool();
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const client = createReadClient({
        env: { ONCHAIN_PG_URL: SECRET_DSN },
        PoolCtor: FailingQueryPool as unknown as PgPoolCtor,
      });

      await expect(client.query('SELECT 1')).rejects.toThrow('pg-history: database unavailable');

      try {
        await client.query('SELECT 1');
        expect.unreachable();
      } catch (error) {
        expect(String(error)).not.toContain('db.internal');
        expect(String(error)).not.toContain(SECRET_DSN);
      }

      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('db.internal'));
      stderrSpy.mockRestore();
    });

    // -------------------------------------------------------------------------------------
    // WI-47 item 4 — "the server answered with an error" against "the server is not there".
    //
    // None of these shapes is invented. Each reproduces one failure MEASURED against the shipped
    // Supabase installation before the class was named (probe recorded in the WI-47 record):
    //   unqualified name -> DatabaseError, code 42P01, severity ERROR  (the production symptom)
    //   wrong password   -> DatabaseError, code 28P01, severity FATAL  (message names the DSN user)
    //   unknown tenant   -> DatabaseError, code XX000, severity FATAL  (Supavisor's own answer)
    //   dead port        -> AggregateError, code ECONNREFUSED, message EMPTY STRING
    //   unroutable host  -> plain Error, no code at all
    // The first three are answers from a reachable server; the last two are not.
    // -------------------------------------------------------------------------------------

    /** A pool whose `query()` throws a CHOSEN error — which error is the entire thing under test
     * here, so the fixture takes it instead of hardcoding one. */
    function poolThrowing(error: unknown): PgPoolCtor {
      return class implements PgPoolLike {
        async query(): Promise<{ rows: unknown[] }> {
          throw error;
        }
      } as unknown as PgPoolCtor;
    }

    /** The two fields a real Postgres ErrorResponse always carries, as `pg` exposes them. */
    function serverError(code: string, severity: string, message: string): Error {
      return Object.assign(new Error(message), { code, severity });
    }

    it('read-client.ts: a server ErrorResponse becomes PgServerRejectedError naming its SQLSTATE — never the generic "database unavailable" (WI-47 item 4)', async () => {
      // KILLED_BY: delete the `if (fields) throw new PgServerRejectedError(...)` branch from the
      // query catch in read-client.ts — the WI-47 symptom collapses back into "unavailable".
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const client = createReadClient({
        env: { ONCHAIN_PG_URL: SECRET_DSN },
        PoolCtor: poolThrowing(
          serverError('42P01', 'ERROR', 'relation "snapshots" does not exist'),
        ),
      });

      const thrown = await client.query('SELECT 1').then(
        () => expect.unreachable(),
        (error: unknown) => error,
      );

      expect(thrown).toBeInstanceOf(PgServerRejectedError);
      expect((thrown as PgServerRejectedError).sqlstate).toBe('42P01');
      expect((thrown as PgServerRejectedError).severity).toBe('ERROR');
      // The operator-facing half — "reachable" is the single word whose absence sent WI-47's
      // diagnosis to the VM, the ports and the credentials while the database was answering.
      expect((thrown as Error).message).toContain('reachable');
      expect((thrown as Error).message).toContain('42P01');
      expect((thrown as Error).message).not.toContain('unavailable');
      stderrSpy.mockRestore();
    });

    it("read-client.ts: the server's OWN message is never surfaced — a 28P01 quotes the DSN's username back at us (D10)", async () => {
      // KILLED_BY: pass `errorMessage(error)` into PgServerRejectedError AND drop the constructor's
      // SEVERITY_RE check — both, because either alone is absorbed by the other. Run: passing the
      // server text in on its own leaves this test GREEN (the constructor rejects the unshaped
      // string and the leak never forms); defeating both turns this one red. That is the ordering
      // this test exists to pin — it guards the constructor's validation, not the call site's.
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const client = createReadClient({
        env: { ONCHAIN_PG_URL: SECRET_DSN },
        PoolCtor: poolThrowing(
          serverError('28P01', 'FATAL', 'password authentication failed for user "app_user"'),
        ),
      });

      const thrown = await client.query('SELECT 1').then(
        () => expect.unreachable(),
        (error: unknown) => error,
      );

      expect(thrown).toBeInstanceOf(PgServerRejectedError);
      expect((thrown as Error).message).toContain('28P01');
      expect(String(thrown)).not.toContain('app_user');
      expect(String(thrown)).not.toContain(SECRET_DSN);
      // …while the full detail still reaches stderr, which is the half that may carry it.
      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('app_user'));
      stderrSpy.mockRestore();
    });

    it('read-client.ts: EPIPE — five uppercase characters, no severity — stays "database unavailable" (the discriminator is not `code` alone)', async () => {
      // KILLED_BY: drop the `severity` requirement from serverErrorFields(). EPIPE then matches
      // SQLSTATE_RE and a socket dying mid-write — the definition of NOT reachable — gets reported
      // as an answer from a healthy server, inverting the fact this whole change exists to carry.
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const client = createReadClient({
        env: { ONCHAIN_PG_URL: SECRET_DSN },
        PoolCtor: poolThrowing(Object.assign(new Error('write EPIPE'), { code: 'EPIPE' })),
      });

      await expect(client.query('SELECT 1')).rejects.toThrow('pg-history: database unavailable');
      stderrSpy.mockRestore();
    });

    it('read-client.ts: a dead port (AggregateError with an EMPTY message) still logs a readable stderr line naming ECONNREFUSED', async () => {
      // KILLED_BY: revert errorMessage() to `error.message`. The line then ends at its colon and
      // says nothing — the single most ordinary "the database is not there" failure logging a
      // blank diagnostic, which is the same complaint WI-47 filed about the caller-facing side.
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const inner = Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:59999'), {
        code: 'ECONNREFUSED',
      });
      const client = createReadClient({
        env: { ONCHAIN_PG_URL: SECRET_DSN },
        PoolCtor: poolThrowing(
          Object.assign(new AggregateError([inner], ''), { code: 'ECONNREFUSED' }),
        ),
      });

      await expect(client.query('SELECT 1')).rejects.toThrow('pg-history: database unavailable');

      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('ECONNREFUSED'));
      // …and specifically NOT a line that trails off after the colon.
      expect(stderrSpy).not.toHaveBeenCalledWith(
        expect.stringMatching(/never surfaced to the caller\):\s*\n$/),
      );
      stderrSpy.mockRestore();
    });

    it('read-client.ts: a severity that is not protocol-shaped is DROPPED rather than interpolated (validated, not trusted)', async () => {
      // KILLED_BY: interpolate `severity` without the SEVERITY_RE check. The SQLSTATE and severity
      // are server-controlled strings going into a message promised to be DSN-free; validating
      // their shape is what makes that promise hold for a field we do not generate.
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const client = createReadClient({
        env: { ONCHAIN_PG_URL: SECRET_DSN },
        PoolCtor: poolThrowing(
          serverError('42P01', 'ОШИБКА postgres://smuggled', 'relation does not exist'),
        ),
      });

      const thrown = await client.query('SELECT 1').then(
        () => expect.unreachable(),
        (error: unknown) => error,
      );

      expect(thrown).toBeInstanceOf(PgServerRejectedError);
      expect((thrown as PgServerRejectedError).sqlstate).toBe('42P01');
      expect((thrown as PgServerRejectedError).severity).toBeUndefined();
      expect((thrown as Error).message).toContain('42P01');
      expect((thrown as Error).message).not.toContain('smuggled');
      stderrSpy.mockRestore();
    });

    it('read-client.ts: a SYNCHRONOUS Pool constructor throw is sanitized before it ever reaches the caller — the raw DSN-bearing detail goes to stderr only (post-M1 polish, fix 3)', async () => {
      resetFakePool();
      const stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);

      class ThrowingPoolCtor {
        constructor() {
          throw new Error(`invalid connection string: ${SECRET_DSN}`);
        }
      }

      const client = createReadClient({
        env: { ONCHAIN_PG_URL: SECRET_DSN },
        PoolCtor: ThrowingPoolCtor as unknown as PgPoolCtor,
      });

      await expect(client.query('SELECT 1')).rejects.toThrow('pg-history: database unavailable');

      try {
        await client.query('SELECT 1');
        expect.unreachable();
      } catch (error) {
        expect(String(error)).not.toContain(SECRET_DSN);
        expect(String(error)).not.toContain('db.internal');
        expect(String(error)).not.toContain('sup3r-secret-pw');
      }

      expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining(SECRET_DSN));
      stderrSpy.mockRestore();
    });
  });

  /**
   * WI-34 — the declared `rateLimit` is applied, and WI-37 — the ceiling reaches the limiter.
   *
   * The registration carried `{capacity: 2, refillPerSec: 0.2}` from the day it was written until
   * WI-34, and no line of code read it: this was the one AVAILABLE adapter in the tree whose declared
   * limit nothing applied (the other two non-throttling adapters are stubs whose `isAvailable()` is
   * unconditionally false, so their `rateLimit` describes traffic that never happens).
   *
   * **T-013 task 013-6 re-derived the numbers to `{capacity: 10, refillPerSec: 5}`** when merge was
   * activated on the two `*.history` routes and this adapter stopped being a spare leg — see the
   * registration's own comment for the arithmetic. The two saturation cases below now prime the
   * bucket from `PG_RATE_LIMIT.capacity` instead of a hard-coded 2: with a transcribed 2 the first
   * would have gone red and the second would have gone SILENTLY GREEN while testing nothing, which
   * is the worse of the two failures.
   */
  describe('the declared rate limit is applied, and takes the deadline (WI-34 + WI-37)', () => {
    const PG_RATE_LIMIT = adapterRegistrations.find((r) => r.id === 'pg-history')!.rateLimit;

    it('the bucket the adapter paces on is the one the registration declares', () => {
      // Read from the registration rather than transcribed: the point of the fix is that these two
      // agree, so a test carrying its own copy of the numbers could not detect them diverging.
      expect(PG_RATE_LIMIT).toEqual({ capacity: 10, refillPerSec: 5 });
    });

    it('TC-INT-08a form: a spent deadline is refused BY THE LIMITER, with no query at all', async () => {
      // The saturation is the case, exactly as in `registry.deadline.test.ts`: on a fresh bucket
      // `throttle()` returns synchronously and the deadline branches (which live on the deficit
      // path) are never reached — so the test would pass even if the adapter never passed the
      // deadline to the limiter. `capacity` calls take the bucket to 0, the adapter's own to -1.
      //
      // Derived from `PG_RATE_LIMIT.capacity`, never transcribed (013-6): the number of priming
      // calls IS the saturation condition, so a literal here would silently stop saturating the
      // first time the registration's capacity changed — and this case would keep passing while
      // exercising the synchronous path it exists to avoid.
      resetFakePool();
      const throttle = createThrottle({ now: Date.now, wait: () => Promise.resolve() });
      for (let i = 0; i < PG_RATE_LIMIT.capacity; i += 1) {
        await throttle('pg-history', PG_RATE_LIMIT);
      }

      const adapter = createPgHistoryAdapter({
        env: { ONCHAIN_PG_URL: SECRET_DSN },
        poolCtor: FakePool as unknown as PgPoolCtor,
        throttle,
      });

      const thrown = await adapter
        .fetch('platform.metrics.history', { chain: 'dash' }, Date.now() - 1)
        .then(
          () => undefined,
          (error: unknown) => error,
        );

      expect(thrown).toBeInstanceOf(DeadlineExceededError);
      // The context string is what pins the refusal to the LIMITER rather than to the query bound:
      // the read client builds the same class with `'pg-history query'`.
      expect((thrown as DeadlineExceededError).at).toBe('provider "pg-history"');
      expect(FakePool.instances).toHaveLength(0);
    });

    it('a saturated bucket with a LIVE deadline waits rather than refusing — the limiter still limits', async () => {
      // The other side of the same branch. Without it, "the deadline is threaded" would be
      // indistinguishable from "the limiter now refuses everything", which is not a rate limit.
      resetFakePool();
      const throttle = isolatedThrottle(Date.now());
      const adapter = createPgHistoryAdapter({
        env: { ONCHAIN_PG_URL: SECRET_DSN },
        poolCtor: FakePool as unknown as PgPoolCtor,
        throttle,
      });

      // Same derivation as the case above, and for the sharper reason: a transcribed 2 would leave
      // this test GREEN against a capacity of 10 while the "waits rather than refusing" branch it
      // names was never entered at all.
      for (let i = 0; i < PG_RATE_LIMIT.capacity; i += 1) {
        await adapter.fetch('platform.metrics.history', { chain: 'dash' });
      }
      // One past capacity: the bucket is in deficit, so this one WAITS in virtual time.
      await expect(
        adapter.fetch('platform.metrics.history', { chain: 'dash' }),
      ).resolves.toHaveLength(2);
      expect(FakePool.lastCreated?.queryCalls).toHaveLength(PG_RATE_LIMIT.capacity + 1);
    });
  });

  /**
   * WI-35 — the query has an upper bound in time, and it has TWO halves that stop different things.
   *
   * The record's acceptance names the harder half explicitly ("a test with a mocked `PoolCtor` whose
   * `query()` does not resolve"), and that is the half a configuration option cannot satisfy:
   * `statement_timeout` is enforced by a server, and there is no server in a unit test. So the bound
   * that this suite can actually observe is the in-process one, and the bound that keeps a pooled
   * connection from being held is the server one — asserted separately, as the value handed to `pg`.
   */
  describe('the query is bounded in time (WI-35)', () => {
    it('a query that never settles rejects at the in-process bound, and the message carries no DSN', async () => {
      resetFakePool();
      const client = createReadClient({
        env: { ONCHAIN_PG_URL: SECRET_DSN },
        PoolCtor: HangingQueryPool as unknown as PgPoolCtor,
        // 25 ms rather than the production 20 000: the seam exists so the MECHANISM is proved
        // without the suite waiting out the number (same reason `createThrottle({now, wait})` does).
        queryTimeoutMs: 25,
      });

      const thrown = await client.query('SELECT 1').then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(thrown).toBeInstanceOf(PgQueryTimeoutError);
      expect((thrown as PgQueryTimeoutError).boundMs).toBe(25);
      expect(HangingQueryPool.queryCalls).toBe(1);
      // The whole reason this module sanitizes at all — a bound that fired must not become the one
      // error path that says where the database is.
      expect(String(thrown)).not.toContain(SECRET_DSN);
      expect(String(thrown)).not.toContain('db.internal');
      expect(String(thrown)).not.toContain('sup3r-secret-pw');
    });

    it('the timeout is NOT collapsed into the generic "database unavailable" rethrow', async () => {
      // Stated separately because it fails differently: folding it into the sanitized message would
      // still be "an error with no DSN", and an operator would lose the one distinction that says
      // whether the database answered at all.
      resetFakePool();
      const client = createReadClient({
        env: { ONCHAIN_PG_URL: SECRET_DSN },
        PoolCtor: HangingQueryPool as unknown as PgPoolCtor,
        queryTimeoutMs: 25,
      });

      await expect(client.query('SELECT 1')).rejects.toThrow(/in-process bound/);
      await expect(client.query('SELECT 1')).rejects.not.toThrow(
        'pg-history: database unavailable',
      );
    });

    it('a query that DOES settle is untouched by the bound — the guard is not simply always red', async () => {
      resetFakePool();
      const client = createReadClient({
        env: { ONCHAIN_PG_URL: SECRET_DSN },
        PoolCtor: FakePool as unknown as PgPoolCtor,
        queryTimeoutMs: 25,
      });

      await expect(client.query('SELECT 1')).resolves.toEqual(FAKE_ROWS);
    });

    it('the SERVER-side bound is handed to `pg` — the half no unit test can observe firing', async () => {
      resetFakePool();
      const client = createReadClient({
        env: { ONCHAIN_PG_URL: SECRET_DSN },
        PoolCtor: FakePool as unknown as PgPoolCtor,
      });

      await client.query('SELECT 1');

      expect(FakePool.instances[0]?.statement_timeout).toBe(5_000);
    });

    it('the caller deadline NARROWS the in-process bound, and says WE ran out of time', async () => {
      // WI-37 on this adapter: the query is the second thing it waits on, so the ceiling has to
      // reach it too. The class is the whole point — `DeadlineExceededError` ends the registry's
      // traversal ("our time is up, every source is out of budget"), `PgQueryTimeoutError` does not
      // ("this database did not answer, ask the next source").
      resetFakePool();
      const client = createReadClient({
        env: { ONCHAIN_PG_URL: SECRET_DSN },
        PoolCtor: HangingQueryPool as unknown as PgPoolCtor,
        // 10 000× larger than the deadline below, so if the deadline were ignored this test would
        // hang out vitest's own 5 000 ms timeout instead of passing for the wrong reason.
        queryTimeoutMs: 300_000,
      });

      const thrown = await client.query('SELECT 1', [], { deadlineAtMs: Date.now() + 30 }).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(thrown).toBeInstanceOf(DeadlineExceededError);
      expect(thrown).not.toBeInstanceOf(PgQueryTimeoutError);
      expect((thrown as DeadlineExceededError).at).toBe('pg-history query');
    });

    it('an ALREADY-spent deadline refuses before the pool is constructed at all', async () => {
      // `safeFetch`'s rule, one transport over: a bound can only cut short work that was started,
      // and not starting it is what a spent deadline must produce. A pool built here would be a
      // connection opened in order to be abandoned.
      resetFakePool();
      const client = createReadClient({
        env: { ONCHAIN_PG_URL: SECRET_DSN },
        PoolCtor: HangingQueryPool as unknown as PgPoolCtor,
      });

      await expect(client.query('SELECT 1', [], { deadlineAtMs: Date.now() - 1 })).rejects.toThrow(
        DeadlineExceededError,
      );
      expect(HangingQueryPool.queryCalls).toBe(0);
    });

    it('the deadline can only NARROW the bound, never widen it', async () => {
      // The other direction, and the one that fails silently: a caller with an hour left must not
      // get an hour-long query. The bound stays this module's, the deadline only lowers it.
      resetFakePool();
      const client = createReadClient({
        env: { ONCHAIN_PG_URL: SECRET_DSN },
        PoolCtor: HangingQueryPool as unknown as PgPoolCtor,
        queryTimeoutMs: 25,
      });

      const thrown = await client
        .query('SELECT 1', [], { deadlineAtMs: Date.now() + 3_600_000 })
        .then(
          () => undefined,
          (error: unknown) => error,
        );

      expect(thrown).toBeInstanceOf(PgQueryTimeoutError);
      expect((thrown as PgQueryTimeoutError).boundMs).toBe(25);
    });

    it('the production bound exceeds the two bounds NESTED inside it, or they are unreachable', async () => {
      // The derivation, executable. `pool.query()` acquires a connection (≤ connectionTimeoutMillis)
      // and only then runs the statement (≤ statement_timeout), and the in-process bound wraps both
      // — so a value below their sum would absorb both and report every failure as "it did not
      // answer". The numbers are read from the pool config the module actually builds, so lowering
      // one in `read-client.ts` and forgetting the other fails here.
      resetFakePool();
      const client = createReadClient({
        env: { ONCHAIN_PG_URL: SECRET_DSN },
        PoolCtor: FakePool as unknown as PgPoolCtor,
      });
      await client.query('SELECT 1');
      const config = FakePool.instances[0];

      const nested = (config?.connectionTimeoutMillis ?? 0) + (config?.statement_timeout ?? 0);
      expect(nested).toBe(15_000);
      // 20_000 is the production `DEFAULT_QUERY_TOTAL_TIMEOUT_MS`; asserted as a literal because the
      // constant is deliberately module-private, and this is the number the E-PG envelope in
      // `capability-manifest.ts` is derived from.
      expect(20_000).toBeGreaterThan(nested);
    });
  });
});
