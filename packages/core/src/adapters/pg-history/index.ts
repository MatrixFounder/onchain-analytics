import { createReadClient } from '../../pg/read-client.js';
import type { PgPoolCtor, ReadClient } from '../../pg/read-client.js';
import { SnapshotSchema, type Snapshot } from '../../types/snapshot.js';
import type { ProviderAdapter } from '../types.js';
import { DASH_METRIC, DASH_PLATFORM_ASSET } from '../dash-metrics.js';

const DEFAULT_HISTORY_LIMIT = 100;

/** Which `metrics` ids (see `dash-metrics.ts`) each history capability reads back from
 * `onchain.snapshots` — the SAME ids `platform-explorer`/`dash-platform` (and the pre-M0 n8n
 * snapshotter) write under, so `pg-history` reads the vocabulary those sources actually wrote,
 * not a separately-invented one. */
const METRICS_BY_CAPABILITY: Record<string, readonly string[]> = {
  'privacy.shielded_pool.history': [DASH_METRIC.shieldedPoolBalanceCredits],
  'platform.metrics.history': [
    DASH_METRIC.identitiesTotal,
    DASH_METRIC.documentsTotal,
    DASH_METRIC.dataContractsTotal,
    DASH_METRIC.platformTotalCredits,
  ],
};

/** Optional constructor dependencies (injectable, same DI convention as the rest of this
 * package). `readClient`/`poolCtor` exist purely so tests can exercise this adapter's own logic
 * (and, via `poolCtor`, `read-client.ts`'s lazy-pool/search_path logic) with a mocked pg client —
 * never a live database connection (R-21). */
export interface PgHistoryAdapterDeps {
  env?: NodeJS.ProcessEnv;
  readClient?: ReadClient;
  poolCtor?: PgPoolCtor;
}

/** One raw row shape as `pg` returns it — note `ts`/`height` commonly come back as STRINGS from a
 * real Postgres `BIGINT` column (node-postgres's own precision-preserving default for the `int8`
 * OID), not JS numbers; `normalize()` below converts both defensively. */
interface SnapshotRow {
  ts: unknown;
  asset: unknown;
  metric: unknown;
  value_raw: unknown;
  value_num: unknown;
  source: unknown;
  height: unknown;
}

function assertDashArgs(args: Record<string, unknown>): void {
  const chain = args['chain'];
  if (chain !== 'dash') {
    throw new Error(
      `pg-history.fetch: invalid args ${JSON.stringify(args)} (expected {chain: 'dash'})`,
    );
  }
}

function toFiniteNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

/**
 * `pg-history` adapter (ARCHITECTURE.md §3.2, R-12) — a normal `ProviderAdapter` over
 * `pg/read-client.ts` (NOT a separate side-channel, F-2): reads back `onchain.snapshots` rows the
 * n8n snapshotter already writes, serving the two `*.history` capabilities as the second-priority
 * source behind `platform-explorer` (`providers.config.ts` routes). SELECT-only (R-27, enforced
 * again at runtime by `read-client.ts`, not just by code review). `isAvailable()` delegates to the
 * read client's own DSN check and never includes the DSN value itself in the reported reason.
 */
export function createPgHistoryAdapter(deps: PgHistoryAdapterDeps = {}): ProviderAdapter {
  const env = deps.env ?? process.env;
  const readClient = deps.readClient ?? createReadClient({ env, PoolCtor: deps.poolCtor });

  return {
    id: 'pg-history',
    capabilities: () => [
      { id: 'privacy.shielded_pool.history', chains: ['dash'] },
      { id: 'platform.metrics.history', chains: ['dash'] },
    ],
    costOf: () => ({ credits: 0 }),
    fetch: async (cap: string, args: Record<string, unknown>): Promise<SnapshotRow[]> => {
      assertDashArgs(args);
      const metrics = METRICS_BY_CAPABILITY[cap];
      if (!metrics) {
        throw new Error(`pg-history.fetch: unsupported capability ${cap}`);
      }
      return readClient.query<SnapshotRow>(
        'SELECT ts, asset, metric, value_raw, value_num, source, height FROM snapshots ' +
          'WHERE asset = $1 AND metric = ANY($2) ORDER BY ts DESC LIMIT $3',
        [DASH_PLATFORM_ASSET, metrics, DEFAULT_HISTORY_LIMIT],
      );
    },
    normalize: (_cap: string, raw: unknown): Snapshot[] => {
      const rows = raw as SnapshotRow[];
      return rows.map((row) => {
        const ts = toFiniteNumber(row.ts);
        const valueNum = toFiniteNumber(row.value_num);
        const height = toFiniteNumber(row.height);
        if (
          ts === undefined ||
          typeof row.asset !== 'string' ||
          typeof row.metric !== 'string' ||
          typeof row.value_raw !== 'string' ||
          typeof row.source !== 'string'
        ) {
          throw new Error(`pg-history.normalize: malformed snapshot row ${JSON.stringify(row)}`);
        }
        const snapshot: Snapshot = {
          metric: row.metric,
          asset: row.asset,
          ts,
          valueRaw: row.value_raw,
          source: row.source,
          ...(valueNum !== undefined ? { valueNum } : {}),
          ...(height !== undefined ? { height } : {}),
        };
        return SnapshotSchema.parse(snapshot);
      });
    },
    isAvailable: () => readClient.isAvailable(),
  };
}
