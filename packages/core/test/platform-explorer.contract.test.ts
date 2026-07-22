import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createPlatformExplorerAdapter } from '../src/index.js';

// Golden fixture-based normalization tests (R-10/R-11, D11) — no network: all four fixtures were
// recorded ONCE live via `scripts/record-fixture.mjs platform-explorer dash` (2026-07-22, host
// platform-explorer.pshenmic.dev, all four calls HTTP 200 — see the committed .evidence.md files).

const testDir = path.dirname(fileURLToPath(import.meta.url));
const FIXED_NOW = 1_700_000_000_000;

function loadFixture(name: string): { chain: string; raw: Record<string, unknown> } {
  const raw = readFileSync(
    path.join(testDir, 'fixtures', 'platform-explorer', `${name}.json`),
    'utf8',
  );
  return JSON.parse(raw) as { chain: string; raw: Record<string, unknown> };
}

function loadHistoryFixture(name: string): {
  chain: string;
  raw: Array<{ timestamp: string; data: Record<string, unknown> }>;
} {
  const raw = readFileSync(
    path.join(testDir, 'fixtures', 'platform-explorer', `${name}.json`),
    'utf8',
  );
  return JSON.parse(raw) as {
    chain: string;
    raw: Array<{ timestamp: string; data: Record<string, unknown> }>;
  };
}

describe('platform-explorer adapter (contract, R-10/R-11)', () => {
  const adapter = createPlatformExplorerAdapter({ now: () => FIXED_NOW });

  it('normalizes the shielded-statistic fixture into a privacy.shielded_pool Snapshot', () => {
    const fixture = loadFixture('shielded-statistic');

    const result = adapter.normalize('privacy.shielded_pool', fixture);

    expect(result).toEqual({
      metric: 'shielded_pool_balance_credits',
      asset: 'dash-platform',
      ts: FIXED_NOW,
      valueRaw: fixture.raw['poolBalance'],
      valueNum: Number(fixture.raw['poolBalance']),
      source: 'platform-explorer',
    });
  });

  it.each([
    ['platform.identities', 'identities_total', 'identitiesCount'],
    ['platform.contracts', 'data_contracts_total', 'dataContractsCount'],
    ['platform.documents', 'documents_total', 'documentsCount'],
    ['platform.credits', 'platform_total_credits', 'totalCredits'],
  ] as const)(
    'normalizes the status fixture into a %s Snapshot (metric %s)',
    (capability, metric, field) => {
      const fixture = loadFixture('state');
      const api = fixture.raw['api'] as { block?: { height?: number } };

      const result = adapter.normalize(capability, fixture);

      expect(result).toEqual({
        metric,
        asset: 'dash-platform',
        ts: FIXED_NOW,
        valueRaw: String(fixture.raw[field]),
        valueNum: Number(fixture.raw[field]),
        source: 'platform-explorer',
        height: api.block?.height,
      });
    },
  );

  it('normalizes the shield-history fixture into a privacy.shielded_pool.history Snapshot[]', () => {
    const fixture = loadHistoryFixture('shield-history');

    const result = adapter.normalize('privacy.shielded_pool.history', fixture) as unknown[];

    expect(result).toHaveLength(fixture.raw.length);
    expect(result[0]).toEqual({
      metric: 'shielded_pool_shield_amount',
      asset: 'dash-platform',
      ts: Date.parse(fixture.raw[0]!.timestamp),
      valueRaw: String(fixture.raw[0]!.data['amount']),
      valueNum: Number(fixture.raw[0]!.data['amount']),
      source: 'platform-explorer',
      height: fixture.raw[0]!.data['blockHeight'],
    });
  });

  it('normalizes the identities-history fixture into a platform.metrics.history Snapshot[]', () => {
    const fixture = loadHistoryFixture('identities-history');

    const result = adapter.normalize('platform.metrics.history', fixture) as unknown[];

    expect(result).toHaveLength(fixture.raw.length);
    expect(result[0]).toEqual({
      metric: 'identities_total',
      asset: 'dash-platform',
      ts: Date.parse(fixture.raw[0]!.timestamp),
      valueRaw: String(fixture.raw[0]!.data['registeredIdentities']),
      valueNum: Number(fixture.raw[0]!.data['registeredIdentities']),
      source: 'platform-explorer',
    });
  });

  it('capabilities() declares all seven Dash capabilities for chain dash', () => {
    const caps = adapter.capabilities();
    expect(caps.map((c) => c.id).sort()).toEqual(
      [
        'platform.contracts',
        'platform.credits',
        'platform.documents',
        'platform.identities',
        'platform.metrics.history',
        'privacy.shielded_pool',
        'privacy.shielded_pool.history',
      ].sort(),
    );
    for (const cap of caps) {
      expect(cap.chains).toEqual(['dash']);
    }
  });

  it('costOf() is free (0 credits) and isAvailable() is always ok (keyless REST)', () => {
    expect(adapter.costOf('privacy.shielded_pool', {})).toEqual({ credits: 0 });
    expect(adapter.isAvailable?.()).toEqual({ ok: true });
  });

  it.each([
    ['privacy.shielded_pool', '/transactions/shielded/statistic'],
    ['platform.identities', '/status'],
    ['privacy.shielded_pool.history', '/transactions/shield/history'],
    ['platform.metrics.history', '/identities/history'],
  ] as const)('fetch() calls the documented %s endpoint (%s)', async (capability, expectedPath) => {
    const calls: string[] = [];
    const fakeFetchImpl: typeof fetch = async (url) => {
      calls.push(String(url));
      return new Response(JSON.stringify({}), { status: 200 });
    };
    const testAdapter = createPlatformExplorerAdapter({ fetchImpl: fakeFetchImpl });

    await testAdapter.fetch(capability, { chain: 'dash' });

    expect(calls).toEqual([`https://platform-explorer.pshenmic.dev${expectedPath}`]);
  });
});
