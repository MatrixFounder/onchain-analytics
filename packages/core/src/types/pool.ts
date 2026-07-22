import { z } from 'zod';
import { ChainSchema } from './chain.js';

/**
 * Canonical `Pool` entity (ARCHITECTURE.md §3.2/§4.1) — a DEX trading pair, the shape returned by
 * `onchain_new_pairs` (M1 MCP tool, implemented in `packages/mcp-server`, not this package).
 */
export const PoolSchema = z
  .object({
    id: z.string(),
    chain: ChainSchema,
    dexId: z.string(),
    baseTokenSymbol: z.string(),
    quoteTokenSymbol: z.string(),
    pairAddress: z.string(),
    createdAt: z.number().int().optional(),
    liquidityUsd: z.number().nonnegative().optional(),
    volume24hUsd: z.number().nonnegative().optional(),
    source: z.string(),
    fetchedAt: z.number().int(),
  })
  .strict();
export type Pool = z.infer<typeof PoolSchema>;
