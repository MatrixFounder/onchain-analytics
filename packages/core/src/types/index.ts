// Barrel re-export for src/types/* (R-1/R-2, ARCHITECTURE.md §3.2). `src/index.ts` re-exports
// this module as the package's public surface (§5.2) — no consumer imports individual
// `types/<entity>.ts` files directly.
export { ChainSchema, type Chain } from './chain.js';
export { TokenSchema, type Token } from './token.js';
export { BalanceSchema, type Balance, WalletSchema, type Wallet } from './wallet.js';
export { PoolSchema, type Pool } from './pool.js';
export { OhlcvSchema, type Ohlcv } from './ohlcv.js';
export { SnapshotSchema, type Snapshot } from './snapshot.js';
// M2 (TASK-005, R-31/R-32/R-33) — three canonical types for the nansen adapter's capabilities:
export { SmartMoneyFlowSchema, type SmartMoneyFlow } from './smart-money-flow.js';
export { EntityLabelSchema, type EntityLabel } from './entity-label.js';
export { TokenRiskScoreSchema, type TokenRiskScore } from './token-risk-score.js';
// TASK-008 (R-74) — the canonical `token.holders` result. Added to this barrel when the MCP tool
// was written: the type shipped with the adapter but never reached the package's public surface,
// so the one consumer outside `packages/core` could not name the shape it receives. The comment at
// the top of this file states the rule the omission broke — no consumer imports
// `types/<entity>.ts` directly, which only works if the barrel is complete.
export { TokenHoldersSchema, type TokenHolders } from './token-holders.js';
// TASK-009 (R-83) — the canonical `chain.supply` result. Exported here in the SAME task that adds
// the type, not in a later one: the rule at the top of this file only holds if the barrel is
// complete, and TASK-008 already paid for discovering that the hard way.
export { ChainSupplySchema, type ChainSupply } from './chain-supply.js';
// WI-51 — network activity: what gas costs, and how much the chain is used.
export { GasPriceSchema, type GasPrice } from './chain-activity.js';
export { ChainTransactionsSchema, type ChainTransactions } from './chain-activity.js';
