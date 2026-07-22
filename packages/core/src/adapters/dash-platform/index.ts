import { SnapshotSchema, type Snapshot } from '../../types/snapshot.js';
import type { ProviderAdapter } from '../types.js';
import { NotImplementedInM1Error } from '../not-implemented-error.js';
import { DASH_METRIC, DASH_PLATFORM_ASSET } from '../dash-metrics.js';

/** Optional constructor dependencies (injectable, same DI convention as the rest of this
 * package). No HTTP step exists in M1 (F-3), so `now` is the only one this adapter needs. */
export interface DashPlatformAdapterDeps {
  now?: () => number;
}

/**
 * Hand-built fixture shape (`test/fixtures/dash-platform/current-state.json`) — NEVER recorded
 * live, since there is no live gRPC transport for `dash-platform` in M1 (F-3). Modeled on the two
 * DAPI RPC methods ARCHITECTURE.md §3.2's decision text names explicitly:
 * `getShieldedPoolState` (current shielded-pool balance + `metadata.height`) and
 * `getTotalCreditsInPlatform` (total Platform credits + `metadata.height`) — sourced from
 * `docs/onchain-analytics/raw/providers-addendum-2026-07-20.json`. `identitiesCount`/
 * `dataContractsCount`/`documentsCount` are NOT named RPCs in that addendum (only the two above
 * are) — they are included as plain top-level counters so the SAME one fixture can also
 * golden-test the other three `platform.*` capabilities, reusing the simple "count" shape
 * `platform-explorer`'s own `/status` endpoint already returns for the equivalent fields
 * (documented implementation choice, developer-guidelines §1.6 — this adapter's own HTTP step is
 * unreachable in M1 regardless, since `isAvailable()` is unconditionally `false`, so no real DAPI
 * wire shape is being contradicted by this simplification).
 */
interface DashPlatformFixture {
  getShieldedPoolState?: { poolBalance?: unknown; metadata?: { height?: unknown } };
  getTotalCreditsInPlatform?: { credits?: unknown; metadata?: { height?: unknown } };
  identitiesCount?: unknown;
  dataContractsCount?: unknown;
  documentsCount?: unknown;
}

function heightOf(metadata: { height?: unknown } | undefined): number | undefined {
  return typeof metadata?.height === 'number' ? metadata.height : undefined;
}

function snapshotFromCurrentValue(params: {
  metric: string;
  valueRaw: unknown;
  height: number | undefined;
  now: () => number;
}): Snapshot {
  if (typeof params.valueRaw !== 'string' && typeof params.valueRaw !== 'number') {
    throw new Error(`dash-platform.normalize: missing/invalid value for metric ${params.metric}`);
  }
  const valueRaw = String(params.valueRaw);
  const valueNum = Number(valueRaw);
  const snapshot: Snapshot = {
    metric: params.metric,
    asset: DASH_PLATFORM_ASSET,
    ts: params.now(),
    valueRaw,
    source: 'dash-platform',
    ...(Number.isFinite(valueNum) ? { valueNum } : {}),
    ...(params.height !== undefined ? { height: params.height } : {}),
  };
  return SnapshotSchema.parse(snapshot);
}

/**
 * `dash-platform` adapter (ARCHITECTURE.md §3.2/§11, R-9, F-3) — interface + fixture-contract
 * only in M1: `capabilities()` declares the full DAPI-native surface, `normalize()` is real and
 * golden-tested against the hand-built fixture above, the HTTP/gRPC step is a stub that throws
 * (unreachable in practice, since `isAvailable()` below is unconditionally `false`), and no
 * live gRPC transport package is imported anywhere in this module (that transport is a separate,
 * non-blocking backlog item, ARCHITECTURE.md §11).
 */
export function createDashPlatformAdapter(deps: DashPlatformAdapterDeps = {}): ProviderAdapter {
  const now = deps.now ?? Date.now;

  return {
    id: 'dash-platform',
    capabilities: () => [
      { id: 'privacy.shielded_pool', chains: ['dash'] },
      { id: 'platform.identities', chains: ['dash'] },
      { id: 'platform.contracts', chains: ['dash'] },
      { id: 'platform.documents', chains: ['dash'] },
      { id: 'platform.credits', chains: ['dash'] },
    ],
    costOf: () => ({ credits: 0 }),
    // Stub: unreachable through CapabilityRegistry in M1 (isAvailable() below always skips this
    // adapter first) — throws loudly rather than silently if ever called directly/out-of-band.
    fetch: async () => {
      throw new NotImplementedInM1Error('dash-platform', 'fetch');
    },
    normalize: (cap: string, raw: unknown): Snapshot => {
      const body = raw as DashPlatformFixture;
      switch (cap) {
        case 'privacy.shielded_pool': {
          const state = body.getShieldedPoolState;
          return snapshotFromCurrentValue({
            metric: DASH_METRIC.shieldedPoolBalanceCredits,
            valueRaw: state?.poolBalance,
            height: heightOf(state?.metadata),
            now,
          });
        }
        case 'platform.credits': {
          const credits = body.getTotalCreditsInPlatform;
          return snapshotFromCurrentValue({
            metric: DASH_METRIC.platformTotalCredits,
            valueRaw: credits?.credits,
            height: heightOf(credits?.metadata),
            now,
          });
        }
        case 'platform.identities':
          return snapshotFromCurrentValue({
            metric: DASH_METRIC.identitiesTotal,
            valueRaw: body.identitiesCount,
            height: undefined,
            now,
          });
        case 'platform.contracts':
          return snapshotFromCurrentValue({
            metric: DASH_METRIC.dataContractsTotal,
            valueRaw: body.dataContractsCount,
            height: undefined,
            now,
          });
        case 'platform.documents':
          return snapshotFromCurrentValue({
            metric: DASH_METRIC.documentsTotal,
            valueRaw: body.documentsCount,
            height: undefined,
            now,
          });
        default:
          throw new Error(`dash-platform.normalize: unsupported capability ${cap}`);
      }
    },
    // F-3 (ARCHITECTURE.md §3.2) — UNCONDITIONAL, not "if the evonode is unreachable": no live
    // transport exists for dash-platform in M1, so CapabilityRegistry always routes these five
    // capabilities to platform-explorer instead — a real, continuously-exercised fallback path
    // (R-11), not a simulated one. See registry.fallback.test.ts.
    isAvailable: () => ({
      ok: false,
      reason: 'dash-platform live transport deferred — see backlog, use platform-explorer',
    }),
  };
}
