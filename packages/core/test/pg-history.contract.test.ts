import { describe, expect, it, vi } from 'vitest';
import { createPgHistoryAdapter } from '../src/index.js';
import { createReadClient } from '../src/pg/read-client.js';
import type { PgPoolCtor, PgPoolLike } from '../src/pg/read-client.js';

// Mock-pg-client tests (R-12) — NEVER a live database connection (R-21): a fake Pool constructor
// is injected all the way through pg-history's own `poolCtor` dependency into `read-client.ts`'s
// real lazy-construction/search_path logic, so this file proves BOTH the adapter's own behavior
// AND read-client.ts's own lazy pool / SELECT-only guard, without a separate test file.

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
    });
  });

  it('fetch() reuses the SAME pool across multiple calls (lazy singleton, not reconstructed)', async () => {
    resetFakePool();
    const adapter = createPgHistoryAdapter({
      env: { ONCHAIN_PG_URL: SECRET_DSN },
      poolCtor: FakePool as unknown as PgPoolCtor,
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

  it('normalize() converts stringified bigint ts/height columns back into numbers and parses as Snapshot[]', async () => {
    resetFakePool();
    const adapter = createPgHistoryAdapter({
      env: { ONCHAIN_PG_URL: SECRET_DSN },
      poolCtor: FakePool as unknown as PgPoolCtor,
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
});
