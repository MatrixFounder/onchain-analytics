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

export { routes, adapterRegistrations } from './providers.config.js';

export { safeFetch, assertAllowedHost } from './net/safe-fetch.js';
export { throttle } from './net/rate-limit.js';
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
export { getCacheStats } from './cache/stats.js';

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
