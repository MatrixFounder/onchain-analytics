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
} from './types/index.js';

export { normalizeAddress, isValidAddress } from './chain/address.js';

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
export { createDefillamaAdapter, type DefillamaAdapterDeps } from './adapters/defillama/index.js';

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
export { createPgHistoryAdapter, type PgHistoryAdapterDeps } from './adapters/pg-history/index.js';
export { NotImplementedInM1Error } from './adapters/not-implemented-error.js';

export { createCacheStore } from './cache/two-level-store.js';
export { getCacheStats } from './cache/stats.js';
