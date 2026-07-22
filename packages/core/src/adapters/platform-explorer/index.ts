import { throttle } from '../../net/rate-limit.js';
import { safeFetch } from '../../net/safe-fetch.js';
import { adapterRegistrations } from '../../providers.config.js';
import { SnapshotSchema, type Snapshot } from '../../types/snapshot.js';
import type { Chain } from '../../types/chain.js';
import type { ProviderAdapter } from '../types.js';
import { DASH_METRIC, DASH_PLATFORM_ASSET } from '../dash-metrics.js';

const REGISTRATION = adapterRegistrations.find((r) => r.id === 'platform-explorer');
if (!REGISTRATION) {
  throw new Error(
    'platform-explorer: no matching entry in adapterRegistrations (providers.config.ts)',
  );
}
const HOSTS = REGISTRATION.hosts;
const RATE_LIMIT = REGISTRATION.rateLimit;
const BASE_URL = `https://${HOSTS[0]}`;

/**
 * capability -> REST path (confirmed by a live probe of `platform-explorer.pshenmic.dev`,
 * 2026-07-22, AND by reading `packages/api/src/routes.js` in the pshenmic/platform-explorer repo
 * at its `master` HEAD — not guessed): `/status` carries identities/data-contracts/documents/
 * credits counts together (one call answers all four `platform.*` capabilities);
 * `/transactions/shielded/statistic` carries the current shielded pool balance;
 * `/transactions/shield/history` and `/identities/history` are the two confirmed-live history
 * series endpoints used for this adapter's own history method (R-10) — see `dash-metrics.ts`'s
 * docstring for why `privacy.shielded_pool.history` uses the shield-amount series specifically.
 */
const ENDPOINT_BY_CAPABILITY: Record<string, string> = {
  'privacy.shielded_pool': '/transactions/shielded/statistic',
  'platform.identities': '/status',
  'platform.contracts': '/status',
  'platform.documents': '/status',
  'platform.credits': '/status',
  'privacy.shielded_pool.history': '/transactions/shield/history',
  'platform.metrics.history': '/identities/history',
};

/** Optional constructor dependencies (injectable, same DI convention as the other live adapters).
 * Keyless — no `env` dependency needed. */
export interface PlatformExplorerAdapterDeps {
  fetchImpl?: typeof fetch;
  now?: () => number;
}

/** This adapter's own private hand-off shape — `raw` is the untouched vendor JSON body;
 * `chain` is carried alongside it (always `'dash'` in M1, kept for shape symmetry with the other
 * adapters in this package). `normalize()` re-receives `cap` directly from `CapabilityRegistry`
 * (its own second call argument), so the envelope itself does not need to repeat it. */
interface PlatformExplorerFetchResult {
  chain: Chain;
  raw: unknown;
}

interface StatusResponse {
  identitiesCount?: unknown;
  dataContractsCount?: unknown;
  documentsCount?: unknown;
  totalCredits?: unknown;
  api?: { block?: { height?: unknown } };
}

interface ShieldedStatisticResponse {
  poolBalance?: unknown;
}

interface HistoryPoint {
  timestamp?: unknown;
  data?: Record<string, unknown> | undefined;
}

function extractFetchArgs(args: Record<string, unknown>): { chain: Chain } {
  const chain = args['chain'];
  if (chain !== 'dash') {
    throw new Error(
      `platform-explorer.fetch: invalid args ${JSON.stringify(args)} (expected {chain: 'dash'})`,
    );
  }
  return { chain };
}

function blockHeightOf(status: StatusResponse): number | undefined {
  const height = status.api?.block?.height;
  return typeof height === 'number' ? height : undefined;
}

/** Builds one canonical current-state `Snapshot` — `valueRaw` is always taken as-is from the
 * vendor field (platform-explorer already emits large counters like `totalCredits`/`poolBalance`
 * as JSON STRINGS, not numbers — confirmed live, 2026-07-22 — so no numeric parsing/re-stringifying
 * is needed or safe to add here). */
function snapshotFromCurrentState(params: {
  metric: string;
  valueRaw: unknown;
  height: number | undefined;
  now: () => number;
}): Snapshot {
  if (typeof params.valueRaw !== 'string' && typeof params.valueRaw !== 'number') {
    throw new Error(
      `platform-explorer.normalize: missing/invalid value for metric ${params.metric}`,
    );
  }
  const valueRaw = String(params.valueRaw);
  const valueNum = Number(valueRaw);
  const snapshot: Snapshot = {
    metric: params.metric,
    asset: DASH_PLATFORM_ASSET,
    ts: params.now(),
    valueRaw,
    source: 'platform-explorer',
    ...(Number.isFinite(valueNum) ? { valueNum } : {}),
    ...(params.height !== undefined ? { height: params.height } : {}),
  };
  return SnapshotSchema.parse(snapshot);
}

/** Builds the `Snapshot[]` for one of the two history capabilities — `points` is the raw
 * `[{timestamp, data}]` array platform-explorer's history endpoints return; `valueOf` extracts the
 * one field this capability's `metric` tracks from each point's own `data` object. */
function snapshotsFromHistory(params: {
  metric: string;
  points: unknown;
  valueOf: (data: Record<string, unknown>) => unknown;
  now: () => number;
}): Snapshot[] {
  if (!Array.isArray(params.points)) {
    throw new Error(`platform-explorer.normalize: expected a history array for ${params.metric}`);
  }
  return (params.points as HistoryPoint[]).map((point) => {
    const timestamp = point.timestamp;
    const data = point.data;
    const ts = typeof timestamp === 'string' ? Date.parse(timestamp) : NaN;
    const rawValue = data ? params.valueOf(data) : undefined;
    if (!Number.isFinite(ts) || (typeof rawValue !== 'string' && typeof rawValue !== 'number')) {
      throw new Error(
        `platform-explorer.normalize: malformed history point ${JSON.stringify(point)}`,
      );
    }
    const valueRaw = String(rawValue);
    const valueNum = Number(valueRaw);
    const blockHeight = data?.['blockHeight'];
    const snapshot: Snapshot = {
      metric: params.metric,
      asset: DASH_PLATFORM_ASSET,
      ts,
      valueRaw,
      source: 'platform-explorer',
      ...(Number.isFinite(valueNum) ? { valueNum } : {}),
      ...(typeof blockHeight === 'number' ? { height: blockHeight } : {}),
    };
    return SnapshotSchema.parse(snapshot);
  });
}

/**
 * `platform-explorer` adapter (ARCHITECTURE.md §3.2/§5.3, R-10/R-11) — REST, keyless, the ONLY
 * live Dash data source in M1 (`dash-platform`'s `isAvailable()` is unconditionally `false`, F-3).
 * Serves the same capability surface as `dash-platform` (so `CapabilityRegistry`'s fallback,
 * R-11, always lands here) plus its OWN history method (R-10) for the two `*.history`
 * capabilities, which no other M1 adapter besides `pg-history` serves.
 */
export function createPlatformExplorerAdapter(
  deps: PlatformExplorerAdapterDeps = {},
): ProviderAdapter {
  const fetchImpl = deps.fetchImpl ?? fetch;
  const now = deps.now ?? Date.now;

  return {
    id: 'platform-explorer',
    capabilities: () => [
      { id: 'privacy.shielded_pool', chains: ['dash'] },
      { id: 'platform.identities', chains: ['dash'] },
      { id: 'platform.contracts', chains: ['dash'] },
      { id: 'platform.documents', chains: ['dash'] },
      { id: 'platform.credits', chains: ['dash'] },
      { id: 'privacy.shielded_pool.history', chains: ['dash'] },
      { id: 'platform.metrics.history', chains: ['dash'] },
    ],
    costOf: () => ({ credits: 0 }),
    fetch: async (
      cap: string,
      args: Record<string, unknown>,
    ): Promise<PlatformExplorerFetchResult> => {
      const { chain } = extractFetchArgs(args);
      const path = ENDPOINT_BY_CAPABILITY[cap];
      if (!path) {
        throw new Error(`platform-explorer.fetch: unsupported capability ${cap}`);
      }
      const url = `${BASE_URL}${path}`;

      await throttle('platform-explorer', RATE_LIMIT);
      const response = await safeFetch(url, {}, HOSTS, fetchImpl);
      if (!response.ok) {
        throw new Error(`platform-explorer: HTTP ${response.status} for ${url}`);
      }
      const raw: unknown = await response.json();
      return { chain, raw };
    },
    normalize: (cap: string, rawResult: unknown): Snapshot | Snapshot[] => {
      const { raw } = rawResult as PlatformExplorerFetchResult;

      switch (cap) {
        case 'privacy.shielded_pool': {
          const body = raw as ShieldedStatisticResponse;
          return snapshotFromCurrentState({
            metric: DASH_METRIC.shieldedPoolBalanceCredits,
            valueRaw: body.poolBalance,
            height: undefined, // /transactions/shielded/statistic carries no block-height field
            now,
          });
        }
        case 'platform.identities': {
          const body = raw as StatusResponse;
          return snapshotFromCurrentState({
            metric: DASH_METRIC.identitiesTotal,
            valueRaw: body.identitiesCount,
            height: blockHeightOf(body),
            now,
          });
        }
        case 'platform.contracts': {
          const body = raw as StatusResponse;
          return snapshotFromCurrentState({
            metric: DASH_METRIC.dataContractsTotal,
            valueRaw: body.dataContractsCount,
            height: blockHeightOf(body),
            now,
          });
        }
        case 'platform.documents': {
          const body = raw as StatusResponse;
          return snapshotFromCurrentState({
            metric: DASH_METRIC.documentsTotal,
            valueRaw: body.documentsCount,
            height: blockHeightOf(body),
            now,
          });
        }
        case 'platform.credits': {
          const body = raw as StatusResponse;
          return snapshotFromCurrentState({
            metric: DASH_METRIC.platformTotalCredits,
            valueRaw: body.totalCredits,
            height: blockHeightOf(body),
            now,
          });
        }
        case 'privacy.shielded_pool.history': {
          return snapshotsFromHistory({
            metric: DASH_METRIC.shieldedPoolShieldAmount,
            points: raw,
            valueOf: (data) => data['amount'],
            now,
          });
        }
        case 'platform.metrics.history': {
          return snapshotsFromHistory({
            metric: DASH_METRIC.identitiesTotal,
            points: raw,
            valueOf: (data) => data['registeredIdentities'],
            now,
          });
        }
        default:
          throw new Error(`platform-explorer.normalize: unsupported capability ${cap}`);
      }
    },
    // Keyless REST — no env precondition to check.
    isAvailable: () => ({ ok: true }),
  };
}
