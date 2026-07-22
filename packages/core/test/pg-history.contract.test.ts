import { describe, expect, it } from 'vitest';
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

class FakePool implements PgPoolLike {
  static instances: Array<{ connectionString: string; options?: string }> = [];
  static lastCreated: FakePool | undefined;
  readonly queryCalls: Array<{ text: string; values?: unknown[] }> = [];

  constructor(config: { connectionString: string; options?: string }) {
    FakePool.instances.push(config);
    FakePool.lastCreated = this;
  }

  async query(text: string, values?: unknown[]): Promise<{ rows: unknown[] }> {
    this.queryCalls.push({ text, values });
    return { rows: FAKE_ROWS };
  }
}

function resetFakePool(): void {
  FakePool.instances = [];
  FakePool.lastCreated = undefined;
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
});
