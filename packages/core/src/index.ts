// Public re-export surface of @onchain-intel/core (ARCHITECTURE.md §5.2). Consumers (currently
// packages/mcp-server, via a workspace:* dependency) import canonical types and the chain/address
// normalization module exclusively through this file — not through internal paths like
// `./types/token.js` or `./chain/address.js` directly.
export {
  ChainSchema,
  type Chain,
  TokenSchema,
  type Token,
  BalanceSchema,
  type Balance,
  WalletSchema,
  type Wallet,
  PoolSchema,
  type Pool,
  OhlcvSchema,
  type Ohlcv,
  SnapshotSchema,
  type Snapshot,
  SmartMoneyFlowSchema,
  type SmartMoneyFlow,
  EntityLabelSchema,
  type EntityLabel,
  TokenRiskScoreSchema,
  type TokenRiskScore,
  TokenHoldersSchema,
  type TokenHolders,
  ChainSupplySchema,
  type ChainSupply,
} from './types/index.js';

export { normalizeAddress, isValidAddress } from './chain/address.js';

// Chain registry (TASK-006, task 006-1, R-48/R-60) — the single source of truth about chains.
// A factory, never a module singleton (same convention as CapabilityRegistry/SqliteCacheStore,
// ARCHITECTURE.md §8), so consumers construct and inject their own instance.
export {
  loadChainRegistry,
  type ChainInfo,
  type ChainFamily,
  type ChainRegistry,
  type ChainRegistryDeps,
  type ChainListFilter,
} from './chain/registry.js';
export {
  UnknownChainError,
  ChainRegistryLoadError,
  CapabilityNotCoveredOnChainError,
} from './chain/errors.js';
export { createCoverage, type Coverage, type CoverageDeps } from './chain/coverage.js';
// TASK-006 (task 006-6, R-50): `chain` as accepted at the MCP tool boundary — an open string
// resolved against the registry, replacing the 7 duplicated `z.enum(['ethereum','solana'])`
// literals. See its docstring for why this is a SECOND schema rather than a widened `ChainSchema`.
export {
  ChainInputSchema,
  createChainInputSchema,
  canonicalizeChain,
} from './chain/input-schema.js';

export {
  CapabilityRegistry,
  MissingCapabilityManifestError,
  // task 012-6 — same reason as its sibling above: the process that constructs the real registry
  // lives in the OTHER package, so the error that stops start-up has to be nameable from there.
  UnregisteredPolicyClassError,
  // task 012-8 — the THIRD traversal outcome (ADR-002 D4). Exported because the layer that turns an
  // outcome into an `isError` tool response lives in `mcp-server`, and R-145's whole content is that
  // this one is DISTINGUISHABLE from `CapabilityUnavailableError`: a class that cannot be named
  // across the package boundary can only be told apart by parsing a message.
  CapabilityDeadlineExceededError,
  // task 014-30 — the per-request observation seam. `CapabilityResolver` is the narrow shape a tool
  // context holds instead of the class (which has private fields, so no structural wrapper is
  // assignable to it); `bindCallObserver` is what installs one request's sink. `deriveArgsHash`
  // deliberately stays OFF this list: the binder is what gives `mcp-server` the value, so the
  // hashing primitive never becomes public surface.
  bindCallObserver,
  type CapabilityResolver,
  type CapabilityCall,
  type CapabilityCallObserver,
  // The resolver's own return type. Exported WITH the interface rather than left inferrable: a
  // consumer that can name `CapabilityResolver` but not what it resolves to cannot write an explicit
  // annotation for a wrapper around it, which is the one thing the interface exists to make possible.
  type CapabilityResolution,
} from './adapters/registry.js';
// task 012-6 (ADR-002 D2) — the route answer policy as data. The TYPE is exported because
// `CapabilityRoute` (already on this surface) carries it; the class dictionary is NOT, because
// nothing outside this package resolves a descriptor and "a test wants it" is not a reason this
// file accepts for widening the public surface.
export type { PolicyDescriptor } from './adapters/policy.js';
// task 012-4 — the capability manifest (ADR-002 D3). Exported for the same reason
// `assertValidAdapterRegistrations` is: the process that constructs the real registry lives in the
// OTHER package, so the table it validates against and the error that stops start-up both have to
// be reachable from there.
export { capabilityManifests, type CapabilityManifest } from './capability-manifest.js';
export type {
  CapabilityDescriptor,
  ProviderAdapter,
  CapabilityRoute,
  AdapterRegistration,
  AdapterTier,
  AdapterTrust,
} from './adapters/types.js';
// task 012-2 — exported because the CALLER of this check is `mcp-server`'s process entry point:
// the whole point of the gate is that a registration missing `tier`/`trust` stops process start,
// and start happens in the other package. `AdapterRegistration` joins the surface for the same
// reason (it is this function's parameter type).
export { assertValidAdapterRegistrations } from './adapters/types.js';
// task 013-2 (T-013, R-162/R-163) — same reasoning as its sibling directly above: the caller is
// `mcp-server`'s process entry point, called immediately after `assertValidAdapterRegistrations`
// and before any store or registry is constructed. `CapabilityRoute`/`AdapterRegistration` (this
// function's parameters) are already on this surface.
export { assertMergeParticipantsAreFree } from './adapters/types.js';

export { routes, adapterRegistrations } from './providers.config.js';

export { safeFetch, assertAllowedHost } from './net/safe-fetch.js';
export { throttle } from './net/rate-limit.js';
// Task 014-17 — the bucket seam and its key. Exported because the limiter's store is injected from
// outside `core` on the Postgres axis (task 014-18) and because `scopedProviderId` is the one
// composition a splitting adapter is allowed to perform.
export {
  DEFAULT_SCOPE_KEY,
  SCOPE_SEPARATOR,
  createInProcessLimiterStore,
  limiterKeyOf,
  scopedProviderId,
  type LimiterKey,
  type LimiterTake,
  type LimiterStore,
} from './net/limiter-store.js';
// task 012-7 — the two NETWORK-layer deadline outcomes. Exported for the reason the classes are two
// and not one: the registry (012-8) tells them apart with `instanceof` — `DeadlineExceededError`
// ends the traversal, `DeadlineWouldExceedError` moves it to the next adapter.
//
// NARROWED by adversarial cycle 2 (F-7): this comment also claimed "mcp-server's tool layer reports
// the two as different facts". It does not, and nothing in the package ever did — `Deadline` appears
// **zero** times in `packages/mcp-server/src` (measured 2026-08-05), and `resolve-capability.ts`
// collapses every throw from `resolve()` into `error.message`. Both classes reach a tool caller as
// the text of `CapabilityDeadlineExceededError`'s message, which is a registry class and not one of
// these two. The export is still justified by the registry's own use and by the tests that construct
// them; a tool layer that acts on the distinction is a change nobody has made.
export { DeadlineExceededError } from './net/safe-fetch.js';
export { DeadlineWouldExceedError } from './net/rate-limit.js';

// The cache-TTL policy (WI-28). `.AGENTS.md` listed `ttlFor` among the symbols deliberately NOT
// re-exported "until a future task gives a concrete reason to widen the public surface" — this is
// that reason: five tables in three documents restate these seconds, and a gate that checks a
// restatement has to be able to reach the number it restates. `NEGATIVE_TTL_SECONDS` stays
// unexported: the first version of this line exported it too, on a justification ("both READMEs
// restate these seconds") that is false for it — no document states it and no gate reads it.
export { ttlFor } from './cache/ttl.js';

// Concrete live adapters (task 003-4, R-5/R-6/R-7) — factories, not module singletons (mirrors
// the CapabilityRegistry/CacheStore "factory, not singleton" principle, ARCHITECTURE.md §8), so
// mcp-server's bootstrap (003-6/003-7) constructs its own instances and injects them into the
// adapters Map CapabilityRegistry's constructor takes.
export { createCoingeckoAdapter, type CoingeckoAdapterDeps } from './adapters/coingecko/index.js';
export {
  createDexscreenerAdapter,
  type DexscreenerAdapterDeps,
} from './adapters/dexscreener/index.js';
export {
  createDefillamaAdapter,
  type DefillamaAdapterDeps,
  type DexVolumeResult,
} from './adapters/defillama/index.js';

// Batch B live/stub adapters (task 003-5, R-8..R-12) — same factory convention as batch A above.
export { createRpcEvmAdapter, type RpcEvmAdapterDeps } from './adapters/rpc-evm/index.js';
export { createRpcSolanaAdapter, type RpcSolanaAdapterDeps } from './adapters/rpc-solana/index.js';
export {
  createPlatformExplorerAdapter,
  type PlatformExplorerAdapterDeps,
} from './adapters/platform-explorer/index.js';
export {
  createDashPlatformAdapter,
  type DashPlatformAdapterDeps,
} from './adapters/dash-platform/index.js';
export { createDuneAdapter } from './adapters/dune/index.js';
// TASK-008 (R-73): free tier for token.holders + entity.labels, two hosts behind one adapter.
export {
  createBlockscoutAdapter,
  servesChain as blockscoutServesChain,
} from './adapters/blockscout/index.js';
// TASK-009 (R-81): free BTC supply. `bitcoinEmissionSat` / `bitcoinSubsidyAtHeightSat` are exported
// beside it because the live eval needs the SAME consensus arithmetic to grade the answer against an
// independent source — a second copy of the halving schedule in `eval/checks.mjs` would be two
// sources of one fact, and the one that drifts is always the copy.
export {
  createBlockchainInfoAdapter,
  type BlockchainInfoAdapterDeps,
  servesChain as blockchainInfoServesChain,
} from './adapters/blockchain-info/index.js';
export {
  bitcoinEmissionSat,
  bitcoinSubsidyAtHeightSat,
  BITCOIN_DECIMALS,
  SATOSHI_PER_BTC,
} from './chain/bitcoin-emission.js';
export { createPgHistoryAdapter, type PgHistoryAdapterDeps } from './adapters/pg-history/index.js';
export { NotImplementedInM1Error } from './adapters/not-implemented-error.js';

// M2 (TASK-005, R-29/R-30, task 005-1) — the tenth adapter, first PAID one. The only publicly
// exported factory for it (no separate raw-client export, interfaces.md §5.2).
export { createNansenAdapter, type NansenAdapterDeps } from './adapters/nansen/index.js';
// Q-2: the self-imposed daily-ceiling contract. `DAILY_CAP_OFF` is the disable sentinel EnvSchema
// validates against; `deriveDailyCap` is exported so the default is testable as a number.
// SEC-1: the velocity brake alongside it — same sentinel shape, same "derived default is testable
// as a number" reason for exporting the derivation.
export {
  DAILY_CAP_OFF,
  deriveDailyCap,
  MAX_CALLS_OFF,
  VELOCITY_OFF,
  VELOCITY_WINDOW_MS,
  deriveVelocityCap,
  velocityWindowMs,
  resolveMaxCalls,
  type DailyCreditCapConfig,
  type MaxCallsConfig,
  type VelocityCapConfig,
} from './adapters/nansen/budget-gate.js';

export { createCacheStore } from './cache/two-level-store.js';
export { getCacheStats, setCacheStatsDebug } from './cache/stats.js';

// The cache SEAM itself, not just the factory (adversarial cycle 3). `CapabilityRegistry`'s third
// constructor parameter is a `CacheStore`, so a consumer that wants anything other than the shipped
// two-level store — a test that needs a warm entry for ONE provider, for instance — could not name
// the type it was already required to pass. Types only: the implementations stay behind their
// factories, per the "factory, not singleton" rule above.
export type { CacheStore, CacheGetResult } from './adapters/cache-store.js';

// M2 (TASK-005, R-34/R-35, task 005-2) — the provider-agnostic credit-budget ledger, same
// "factory, not singleton" injection convention as `createCacheStore` above. `BudgetStore` itself
// (unlike `SqliteBudgetStore`) knows nothing about any specific provider.
export { type BudgetStore, createBudgetStore } from './cache/budget-store.js';
export { dayBucketMs } from './cache/day-bucket.js';
// Task 014-30: the per-call spend receipt. `mcp-server` consumes these to attribute a committed
// ledger write to one request; `reportVendorSpend` is exported so a future paid adapter uses the
// same never-throw wrapper rather than writing a second one.
export {
  reportVendorSpend,
  type VendorChargeRecord,
  type VendorCoalescedRecord,
  type VendorLedgerCoordinates,
  type VendorSpendRecord,
  type VendorSpendReporter,
} from './cache/vendor-spend.js';

// The SQLite declaration of every engine table (task 014-36), exported for task 014-07's tests.
//
// **Why a DDL string crosses the package boundary.** The identity repositories live in `mcp-server`
// (`security.md` §7.5.1), and R-21 forbids a live Postgres in `pnpm test` — so the only way to run
// their real statements against a real engine is the SQLite axis, whose declaration is this string.
// A second copy of it in `mcp-server` would be a second schema, agreeing with this one until the
// first column is added to one of them; `pg-store-parity.test.ts` already imports it for the same
// reason from inside this package.
//
// It stays DECLARATIVE data. Nothing in `mcp-server`'s `src` executes it — a runtime consumer there
// would be creating the engine's tables from the transport, which `deployment.md` §10.4.2 assigns to
// a migration run by an operator.
export { CACHE_DDL } from './cache/ddl.js';

// The SQLite axis of the engine's own state (task 014-12 gap closure). `security.md` §7.5.4 makes
// `network-sqlite` authenticate exactly as `network` does; this is the adapter that lets the
// identity repositories — written once, against `StateClient` — run on the axis with no schemas.
export { createSqliteStateClient, toSqliteDialect } from './sqlite/state-client.js';

// T-014 (task 014-39) — the storage axis, as one factory over the two engines. Exported for the
// same reason `createCacheStore`/`createBudgetStore` are: the process that picks the axis is
// `mcp-server`'s entry point, in the other package. The three concrete `Pg*` classes stay behind
// this factory ("factory, not singleton", ARCHITECTURE.md §8) — a caller that wants one of them
// alone would also be a caller deciding the DSN and the bootstrap order for itself, which is what
// the factory exists to hold.
//
// `LimiterOperatorNotImplementedError` is on the surface deliberately, and it is the only class
// here that is: task 014-19's degradation path has to tell "the store is unreachable" (degrade to
// the in-process bucket) from "this axis has no slot operator yet" (a defect, not an outage), and
// `instanceof` across the package boundary is the only way to tell them apart without parsing a
// message.
export {
  createStateStores,
  type StateStores,
  type StorageAxis,
  type LimiterSlot,
  type CreateStateStoresOptions,
} from './pg/stores.js';
export { LimiterOperatorNotImplementedError } from './pg/limiter-store.js';
// The write-capable client itself: the engine repositories of task 014-03 take THIS client, not the
// read-only one, and they live in `mcp-server`.
export {
  createStateClient,
  // The twelve engine tables, exported because `mcp-server`'s access mechanism qualifies names from
  // this list (task 014-03). One list, checked against the migration by a test in this package — a
  // second copy in `mcp-server` would drift on the thirteenth table and read as "the gate passed".
  STATE_TABLES,
  PgStateQueryTimeoutError,
  PgStateServerRejectedError,
  type StateClient,
  type StateClientDeps,
  type StateTransaction,
  type PgStatePoolLike,
  type PgStatePoolCtor,
  type PgStateConnectionLike,
} from './pg/state-client.js';
