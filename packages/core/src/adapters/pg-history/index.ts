import { createReadClient } from '../../pg/read-client.js';
import type { ChainInfo } from '../../chain/registry-core.js';
import { throttle as productionThrottle, type Throttle } from '../../net/rate-limit.js';
import type { PgPoolCtor, ReadClient } from '../../pg/read-client.js';
import { adapterRegistrations } from '../../providers.config.js';
import { SnapshotSchema, type Snapshot } from '../../types/snapshot.js';
import type { ProviderAdapter } from '../types.js';
import { DASH_METRIC, DASH_PLATFORM_ASSET } from '../dash-metrics.js';

const REGISTRATION = adapterRegistrations.find((r) => r.id === 'pg-history');
if (!REGISTRATION) {
  throw new Error('pg-history: no matching entry in adapterRegistrations (providers.config.ts)');
}
/**
 * `{capacity: 10, refillPerSec: 5}` — declared in `providers.config.ts`, applied by nothing until
 * WI-34, and RE-DERIVED from the original `{capacity: 2, refillPerSec: 0.2}` by T-013 task 013-6.
 *
 * **Why a Postgres adapter paces at all.** Its `max: 3` pool bounds CONCURRENCY, which is a different
 * quantity from RATE: three connections can be re-borrowed as fast as queries complete, so the pool
 * puts no ceiling on queries per second. The declared bucket does.
 *
 * **Why the numbers changed.** The original pair was sized for a SPARE LEG: before merge, this
 * adapter was reached only when `platform-explorer` threw, which the route's default `{kind: 'any'}`
 * policy made almost never. Task 013-6 activated merge on both `*.history` routes, so every merged
 * cache-miss now takes a token from this one per-provider bucket — and one token per five seconds
 * worked out to roughly 12 merged calls per minute across both capabilities together, a ceiling the
 * 3 600 s TTL hides right up until an agent varies its arguments. The registration's own comment in
 * `providers.config.ts` carries the arithmetic and the reason this was re-derived rather than
 * documented as an intentional limit.
 *
 * **The point of the fix is not the pacing, it is the agreement.** A `rateLimit` in the registration
 * read as a control that existed; PLAN §0.2a derived the E-PG envelope through it, and it was the one
 * available adapter in the tree whose declared limit nothing applied.
 */
const RATE_LIMIT = REGISTRATION.rateLimit;

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
  /** WI-26's seam, owed by every adapter that calls the limiter — a test cannot isolate what the
   * adapter does not let it inject, and without this one this adapter's tests would share the
   * production bucket with every other file in the process. */
  throttle?: Throttle;
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
 *
 * **It paces and it takes the deadline (WI-34 + WI-37).** Both landed together because they are the
 * same sentence about this adapter: the registration's `rateLimit` is now applied rather than
 * declared, and the wait it can produce is exactly the wait the call ceiling has to be able to cut.
 * The two things this adapter waits on — the limiter and the query — both receive `deadlineAtMs`;
 * for the query that means the in-process bound in `read-client.ts` is narrowed to whatever is left,
 * because a Postgres statement cannot be recalled once sent, only stopped being waited for.
 */
export function createPgHistoryAdapter(deps: PgHistoryAdapterDeps = {}): ProviderAdapter {
  const env = deps.env ?? process.env;
  const readClient = deps.readClient ?? createReadClient({ env, PoolCtor: deps.poolCtor });
  const throttle = deps.throttle ?? productionThrottle;

  return {
    id: 'pg-history',
    // TASK-006 (R-54): Dash only. Unlike the vendor-backed adapters there is no registry column
    // to consult — this adapter speaks Dash Platform's own protocol and nothing else — so the
    // slug comparison IS the fact, not a duplicated list.
    chainSupport: (chain: ChainInfo): boolean => chain.slug === 'dash',
    capabilities: () => [
      { id: 'privacy.shielded_pool.history', chains: ['dash'] },
      { id: 'platform.metrics.history', chains: ['dash'] },
    ],
    costOf: () => ({ credits: 0 }),
    fetch: async (
      cap: string,
      args: Record<string, unknown>,
      deadlineAtMs?: number,
    ): Promise<SnapshotRow[]> => {
      assertDashArgs(args);
      const metrics = METRICS_BY_CAPABILITY[cap];
      if (!metrics) {
        throw new Error(`pg-history.fetch: unsupported capability ${cap}`);
      }
      // The limiter FIRST and the deadline with it (WI-34 + WI-37), in that order for the reason
      // `blockscout` states: refusing a wait we already know is longer than the time left is free,
      // discovering it afterwards costs the whole wait. Here the wait can be long — one query per
      // five seconds — so on a route whose ceiling is 30 000 ms this is where the ceiling earns its
      // keep. `weight` is 1 (one query, one upstream statement), passed explicitly because the
      // deadline is the fourth argument.
      await throttle('pg-history', RATE_LIMIT, 1, deadlineAtMs);
      // …and to the query, which is the other thing this adapter waits on. Spread conditionally so
      // a call with no deadline hands `read-client.ts` byte-for-byte the options object it built
      // before this change — the same construction `blockscout` uses for `safeFetch`.
      return readClient.query<SnapshotRow>(
        'SELECT ts, asset, metric, value_raw, value_num, source, height FROM snapshots ' +
          'WHERE asset = $1 AND metric = ANY($2) ORDER BY ts DESC LIMIT $3',
        [DASH_PLATFORM_ASSET, metrics, DEFAULT_HISTORY_LIMIT],
        deadlineAtMs === undefined ? {} : { deadlineAtMs },
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
