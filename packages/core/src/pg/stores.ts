import type { CacheStore } from '../adapters/cache-store.js';
import type { AdapterRegistration } from '../adapters/types.js';
import { createBudgetStore, type BudgetStore } from '../cache/budget-store.js';
import { createSqliteLimiterStore } from '../cache/limiter-store.js';
import type { LimiterStore } from '../net/limiter-store.js';
import { LruHotLayer } from '../cache/lru.js';
import { createCacheStore, TwoLevelStore } from '../cache/two-level-store.js';
import { PgBudgetStore } from './budget-store.js';
import { PgCacheStore } from './cache-store.js';
import { PgLimiterStore } from './limiter-store.js';
import { createStateClient, type StateClient } from './state-client.js';

/**
 * Where the process keeps its own state — the storage axis, as a plain two-value union.
 *
 * **Why this is not `DeploymentProfile` from `packages/mcp-server/src/profile.ts`.** That module
 * owns the profile (`local` | `network` | `network-sqlite`), and it resolves each one into a
 * transport AND a storage axis. `packages/core` must not depend on `mcp-server`: the dependency runs
 * the other way (`mcp-server` has `@onchain-intel/core` as a workspace dependency), and importing
 * the descriptor here would make this package able to name transports, principals and profiles —
 * things it is deliberately unable to name (`security.md` §7.5.1 keeps token handling out of
 * `core` for the same reason).
 *
 * So the axis arrives as a parameter of the simplest type that carries it. The union members are
 * spelled identically to `StorageKind`'s, so the caller writes
 * `createStateStores({ storage: resolveProfile(env).storage })` with no cast and no mapping table —
 * assignability does the work that an import would otherwise do, in the one direction that is
 * allowed.
 */
export type StorageAxis = 'sqlite' | 'postgres';

/**
 * **The `LimiterSlot` union was retired by task 014-18.** It existed because one axis had a store
 * whose operator was unwritten and the other had no store at all, and it spelled that absence out
 * so "no limiter" could not be read as "no limit" by accident. Both axes now have a limiter whose
 * operator runs, so the union's second arm had no producer left — and a discriminant nobody can
 * reach is a check that reads as a guarantee while guarding nothing.
 *
 * What replaced it is the interface itself: `StateStores.limiter` is a `LimiterStore`, the same
 * type `createThrottle` accepts, so wiring the axis into the limiter is an assignment rather than a
 * translation.
 */

/** The trio one axis resolves to. `cache` and `budget` satisfy the interfaces that already existed
 * (`adapters/cache-store.ts:25`, `cache/budget-store.ts:46`) — this factory changes neither. */
export interface StateStores {
  readonly cache: CacheStore;
  readonly budget: BudgetStore;
  /** The shared bucket store of this axis (task 014-18, R-7). Handed to `createThrottle` as its
   * `store` dependency — see `net/rate-limit.ts`. */
  readonly limiter: LimiterStore;
}

export interface CreateStateStoresOptions {
  /** Which axis to build. Typically `resolveProfile(env).storage` at the process entry point. */
  readonly storage: StorageAxis;
  /** Postgres axis only — the write-capable client. Omitted, one is constructed from
   * `ONCHAIN_STATE_PG_URL`. Injected by tests, and by any caller that wants one pool for all three
   * stores plus the engine repositories of task 014-03. */
  readonly client?: StateClient;
  /** Registrations to bootstrap into `providers` on either axis. Defaults to all twelve. */
  readonly providers?: AdapterRegistration[];
  /** SQLite axis only — the cache file, or `':memory:'`. */
  readonly dbPath?: string;
  /** Hot-layer bounds, applied on BOTH axes: the hot layer is memory and stays in process either
   * way (`system-architecture.md` §3.4.8). */
  readonly maxHotEntries?: number;
  readonly maxHotBytes?: number;
}

/**
 * Builds the three state stores of one storage axis (`system-architecture.md` §3.4.8, the
 * component table).
 *
 * **Why one factory rather than three.** The three stores of the Postgres axis must share ONE
 * client, and `PgBudgetStore`'s construction is what puts the twelve `providers` rows in place
 * before `cache_entries` or `provider_buckets` can reference them as a foreign key. Built
 * separately, that ordering would be a convention every call site has to remember; built here it is
 * a property of the axis.
 *
 * **Why an option belonging to the other axis is refused rather than ignored.** A `dbPath` handed to
 * the Postgres axis, or a `client` handed to the SQLite one, is a caller who believes something
 * about where their state lives that is not true — and the reading they would get instead is a
 * process that starts cleanly and keeps its ledger somewhere else. Nothing silently.
 *
 * **This factory is not wired into `packages/mcp-server/src/index.ts` by this task.** The HTTP
 * transport is task 014-09, and until it ships the `network` profile refuses to start
 * (`profile.ts`, `PreStartCheckFailed`), so a branch selecting the Postgres axis there would be
 * unreachable code guarded by a check that always fails.
 */
export function createStateStores(options: CreateStateStoresOptions): StateStores {
  if (options.storage === 'postgres') {
    if (options.dbPath !== undefined) {
      throw new Error(
        'pg/stores: dbPath belongs to the sqlite axis — the postgres axis keeps no local cache file',
      );
    }
    const client = options.client ?? createStateClient();
    // Constructed FIRST: its constructor starts the `providers` bootstrap, and the cache store is
    // handed that same promise so its first write cannot outrun the registry its foreign key
    // references. This ordering is the reason the three stores are built in one place.
    const budget = new PgBudgetStore({ client, providers: options.providers });
    return {
      cache: new TwoLevelStore(
        new PgCacheStore({ client, ready: budget.ready }),
        new LruHotLayer(options.maxHotEntries, options.maxHotBytes),
      ),
      budget,
      // The same `ready` barrier the cache store takes, and for the same reason: `provider_buckets`
      // references `providers`, and a bucket written before the bootstrap lands is a foreign-key
      // refusal that R-7.7 would read as a storage failure.
      limiter: new PgLimiterStore({ client, ready: budget.ready }),
    };
  }

  if (options.client !== undefined) {
    throw new Error(
      'pg/stores: a Postgres state client was supplied for the sqlite axis — one of the two is wrong',
    );
  }
  return {
    cache: createCacheStore({
      dbPath: options.dbPath,
      providers: options.providers,
      maxHotEntries: options.maxHotEntries,
      maxHotBytes: options.maxHotBytes,
    }),
    budget: createBudgetStore({ dbPath: options.dbPath, providers: options.providers }),
    limiter: createSqliteLimiterStore({
      dbPath: options.dbPath,
      providers: options.providers,
    }),
  };
}
