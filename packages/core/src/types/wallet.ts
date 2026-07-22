import { z } from 'zod';
import { ChainSchema } from './chain.js';

/**
 * Canonical `Balance` entity (ARCHITECTURE.md §3.2/§4.1) — one line item in a `Wallet`'s
 * `balances` array. M1 only ever populates `assetType: 'native'` (native ETH/SOL, via
 * `rpc-evm`/`rpc-solana`) — see ARCHITECTURE.md §3.2 "ERC-20/SPL-балансы" decision: `'token'` plus
 * `contractAddress` are reserved so M1.5/M2 can add ERC-20/SPL balances without a schema change,
 * only by populating additional array entries.
 *
 * `amountRaw` is the exact integer as a **string** (DB-SCHEMA-CONCEPT §1.7 convention): wei/
 * lamports exceed the safe 2^53 of a JS `number`/`REAL`. `amountNum` is a lossy projection for
 * display/comparison only — never the source of truth.
 */
export const BalanceSchema = z
  .object({
    assetType: z.enum(['native', 'token']),
    symbol: z.string(),
    decimals: z.number().int().nonnegative(),
    amountRaw: z.string(),
    amountNum: z.number().optional(),
    contractAddress: z.string().optional(),
  })
  .strict();
export type Balance = z.infer<typeof BalanceSchema>;

/**
 * Canonical `Wallet` entity (ARCHITECTURE.md §3.2/§4.1) — a wallet's balances on one chain.
 * `Wallet 1:N Balance` is an embedded array, not a separate table — M1 does not persist wallets
 * outside the cache.
 */
export const WalletSchema = z
  .object({
    chain: ChainSchema,
    address: z.string(),
    balances: z.array(BalanceSchema),
    source: z.string(),
    fetchedAt: z.number().int(),
  })
  .strict();
export type Wallet = z.infer<typeof WalletSchema>;
