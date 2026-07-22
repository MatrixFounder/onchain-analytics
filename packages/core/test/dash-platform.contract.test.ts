import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createDashPlatformAdapter, NotImplementedInM1Error } from '../src/index.js';

// Golden fixture-based normalization test (R-9, F-3, D11) — the fixture here is HAND-BUILT, not
// recorded live (there is no live gRPC transport for dash-platform in M1 — see the committed
// current-state.evidence.md, explicitly marked "HAND-BUILT, NOT RECORDED LIVE").

const testDir = path.dirname(fileURLToPath(import.meta.url));
const FIXED_NOW = 1_700_000_000_000;

interface DashPlatformFixture {
  getShieldedPoolState: { poolBalance: string; metadata: { height: number } };
  getTotalCreditsInPlatform: { credits: string; metadata: { height: number } };
  identitiesCount: number;
  dataContractsCount: number;
  documentsCount: number;
}

function loadFixture(): DashPlatformFixture {
  const raw = readFileSync(
    path.join(testDir, 'fixtures', 'dash-platform', 'current-state.json'),
    'utf8',
  );
  return JSON.parse(raw) as DashPlatformFixture;
}

describe('dash-platform adapter (contract, R-9, F-3 — interface + fixture-contract only)', () => {
  const adapter = createDashPlatformAdapter({ now: () => FIXED_NOW });

  it('normalizes privacy.shielded_pool from the hand-built getShieldedPoolState fixture fields', () => {
    const fixture = loadFixture();

    const result = adapter.normalize('privacy.shielded_pool', fixture);

    expect(result).toEqual({
      metric: 'shielded_pool_balance_credits',
      asset: 'dash-platform',
      ts: FIXED_NOW,
      valueRaw: fixture.getShieldedPoolState.poolBalance,
      valueNum: Number(fixture.getShieldedPoolState.poolBalance),
      source: 'dash-platform',
      height: fixture.getShieldedPoolState.metadata.height,
    });
  });

  it('normalizes platform.credits from the hand-built getTotalCreditsInPlatform fixture fields', () => {
    const fixture = loadFixture();

    const result = adapter.normalize('platform.credits', fixture);

    expect(result).toEqual({
      metric: 'platform_total_credits',
      asset: 'dash-platform',
      ts: FIXED_NOW,
      valueRaw: fixture.getTotalCreditsInPlatform.credits,
      valueNum: Number(fixture.getTotalCreditsInPlatform.credits),
      source: 'dash-platform',
      height: fixture.getTotalCreditsInPlatform.metadata.height,
    });
  });

  it.each([
    ['platform.identities', 'identities_total', 'identitiesCount'],
    ['platform.contracts', 'data_contracts_total', 'dataContractsCount'],
    ['platform.documents', 'documents_total', 'documentsCount'],
  ] as const)(
    "normalizes %s from the fixture's plain count field (metric %s)",
    (capability, metric, field) => {
      const fixture = loadFixture();

      const result = adapter.normalize(capability, fixture);

      expect(result).toEqual({
        metric,
        asset: 'dash-platform',
        ts: FIXED_NOW,
        valueRaw: String(fixture[field]),
        valueNum: fixture[field],
        source: 'dash-platform',
      });
    },
  );

  it('capabilities() declares privacy.shielded_pool and all four platform.* capabilities for dash', () => {
    const caps = adapter.capabilities();
    expect(caps.map((c) => c.id).sort()).toEqual(
      [
        'platform.contracts',
        'platform.credits',
        'platform.documents',
        'platform.identities',
        'privacy.shielded_pool',
      ].sort(),
    );
    for (const cap of caps) {
      expect(cap.chains).toEqual(['dash']);
    }
  });

  it('costOf() is free (0 credits)', () => {
    expect(adapter.costOf('privacy.shielded_pool', {})).toEqual({ credits: 0 });
  });

  it('isAvailable() is UNCONDITIONALLY false (F-3 — not "if the evonode is unreachable")', () => {
    expect(adapter.isAvailable?.()).toEqual({
      ok: false,
      reason: 'dash-platform live transport deferred — see backlog, use platform-explorer',
    });
  });

  it('fetch() (the HTTP/gRPC step) is an unreachable stub that throws NotImplementedInM1Error', async () => {
    await expect(adapter.fetch('privacy.shielded_pool', {})).rejects.toBeInstanceOf(
      NotImplementedInM1Error,
    );
  });
});
