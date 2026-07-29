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

export { CapabilityRegistry } from './adapters/registry.js';
export type { CapabilityDescriptor, ProviderAdapter, CapabilityRoute } from './adapters/types.js';

export { routes, adapterRegistrations } from './providers.config.js';

export { safeFetch, assertAllowedHost } from './net/safe-fetch.js';
export { throttle } from './net/rate-limit.js';

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
export { getCacheStats } from './cache/stats.js';

// M2 (TASK-005, R-34/R-35, task 005-2) — the provider-agnostic credit-budget ledger, same
// "factory, not singleton" injection convention as `createCacheStore` above. `BudgetStore` itself
// (unlike `SqliteBudgetStore`) knows nothing about any specific provider.
export { type BudgetStore, createBudgetStore } from './cache/budget-store.js';
export { dayBucketMs } from './cache/day-bucket.js';
