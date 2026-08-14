import type { CacheStore } from '../adapters/cache-store.js';
import type { AdapterRegistration } from '../adapters/types.js';
import { createBudgetStore, type BudgetStore } from '../cache/budget-store.js';
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
 * The limiter's place in the axis — a two-variant union, and a union rather than
 * `PgLimiterStore | undefined` on purpose.
 *
 * **Why an absence is spelled out instead of being left absent.** `undefined` at a call site reads
 * as "no limiter", and "no limiter" is one `if` away from "no limit" — the L-10 shape this project
 * has already paid for twice (a confident empty answer taken as a safe one). A consumer must
 * discriminate on `kind`, so the case where no limiter exists cannot be reached by accident, and
 * whoever reaches it is handed the id of the task that closes it.
 */
export type LimiterSlot =
  | {
      readonly kind: 'store';
      readonly store: PgLimiterStore;
      /** The slot operator (`takeTokens`) is not written yet; the store throws
       * `LimiterOperatorNotImplementedError` until this task lands it. */
      readonly operatorOwner: 'task 014-18';
    }
  | {
      readonly kind: 'absent';
      readonly reason: string;
      readonly owner: 'task 014-18';
    };

/** The trio one axis resolves to. `cache` and `budget` satisfy the interfaces that already existed
 * (`adapters/cache-store.ts:25`, `cache/budget-store.ts:46`) — this factory changes neither. */
export interface StateStores {
  readonly cache: CacheStore;
  readonly budget: BudgetStore;
  readonly limiter: LimiterSlot;
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
      limiter: {
        kind: 'store',
        store: new PgLimiterStore({ client }),
        operatorOwner: 'task 014-18',
      },
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
    limiter: {
      kind: 'absent',
      reason: 'SqliteLimiterStore is not written yet; the limiter still uses its in-process bucket',
      owner: 'task 014-18',
    },
  };
}
